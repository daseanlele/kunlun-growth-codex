use crate::{
    config::{self, ProviderConfig},
    workspace,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

static NEXT_TURN_ID: AtomicU64 = AtomicU64::new(1);
static CANCELLATIONS: OnceLock<Mutex<HashMap<String, Arc<std::sync::atomic::AtomicBool>>>> =
    OnceLock::new();

fn cancellations() -> &'static Mutex<HashMap<String, Arc<std::sync::atomic::AtomicBool>>> {
    CANCELLATIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationMessage {
    pub role: String,
    pub content: String,
}

pub fn expand_workspace_references(cwd: &str, prompt: &str) -> Result<String, String> {
    let mut paths = Vec::new();
    for token in prompt.split_whitespace() {
        let Some(path) = token.strip_prefix('@') else {
            continue;
        };
        let path = path
            .trim_matches(|character: char| matches!(character, ',' | ';' | ':' | ')' | ']' | '}'));
        if path.is_empty()
            || (!path.contains('/') && !path.contains('\\') && !path.contains('.'))
            || paths.iter().any(|existing: &String| existing == path)
        {
            continue;
        }
        paths.push(path.to_string());
        if paths.len() == 5 {
            break;
        }
    }
    if paths.is_empty() {
        return Ok(prompt.to_string());
    }
    let mut expanded = prompt.to_string();
    for path in paths {
        let content = workspace::read_workspace_file(cwd, &path)
            .map_err(|error| format!("无法读取 @{}：{}", path, error))?;
        let preview: String = content.chars().take(24_000).collect();
        expanded.push_str(&format!("\n\n[工作区文件：{path}]\n{preview}\n[文件结束]"));
    }
    Ok(expanded)
}

pub fn start_turn(
    app: AppHandle,
    provider: ProviderConfig,
    thread_id: String,
    text: String,
    model_override: Option<String>,
    history: Vec<ConversationMessage>,
) -> Result<Value, String> {
    if text.trim().is_empty() {
        return Err("Message cannot be empty".to_string());
    }
    let model = model_override
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| provider.model.clone());
    if model.trim().is_empty() {
        return Err("A model ID is required for this provider".to_string());
    }
    let turn_id = format!("native-{}", NEXT_TURN_ID.fetch_add(1, Ordering::Relaxed));
    let cancellation = Arc::new(std::sync::atomic::AtomicBool::new(false));
    cancellations()
        .lock()
        .map_err(|_| "Native adapter cancellation state is unavailable".to_string())?
        .insert(turn_id.clone(), cancellation.clone());
    let response = json!({ "turn": { "id": turn_id, "status": "inProgress" } });
    let _ = app.emit(
        "app-server-notification",
        json!({
            "method": "turn/started",
            "params": { "threadId": thread_id, "turn": { "id": turn_id } }
        }),
    );

    std::thread::spawn(move || {
        let item_id = format!("{turn_id}-answer");
        let stream_app = app.clone();
        let stream_thread_id = thread_id.clone();
        let stream_turn_id = turn_id.clone();
        let stream_cancellation = cancellation.clone();
        let result = stream_completion(&provider, &model, &text, &history, move |delta| {
            if stream_cancellation.load(Ordering::Relaxed) {
                return;
            }
            let _ = stream_app.emit("app-server-notification", json!({
                "method": "item/agentMessage/delta",
                "params": { "threadId": stream_thread_id, "turnId": stream_turn_id, "itemId": item_id, "delta": delta }
            }));
        });
        let cancelled = cancellation.load(Ordering::Relaxed);
        match result {
            Ok(()) if !cancelled => {
                let _ = app.emit("app-server-notification", json!({
                    "method": "turn/completed",
                    "params": { "threadId": thread_id, "turn": { "id": turn_id, "status": "completed" } }
                }));
            }
            Ok(_) => {}
            Err(error) => {
                if !cancelled {
                    let _ = app.emit(
                        "app-server-notification",
                        json!({
                            "method": "runtime/error",
                            "params": { "threadId": thread_id, "turnId": turn_id, "message": error }
                        }),
                    );
                    let _ = app.emit("app-server-notification", json!({
                        "method": "turn/completed",
                        "params": { "threadId": thread_id, "turn": { "id": turn_id, "status": "failed" } }
                    }));
                }
            }
        }
        if let Ok(mut items) = cancellations().lock() {
            items.remove(&turn_id);
        }
    });
    Ok(response)
}

pub fn cancel_turn(app: AppHandle, thread_id: String, turn_id: String) -> Result<Value, String> {
    let cancellation = cancellations()
        .lock()
        .map_err(|_| "Native adapter cancellation state is unavailable".to_string())?
        .remove(&turn_id);
    if let Some(flag) = cancellation {
        flag.store(true, Ordering::Relaxed);
    }
    let _ = app.emit(
        "app-server-notification",
        json!({
            "method": "turn/completed",
            "params": { "threadId": thread_id, "turn": { "id": turn_id, "status": "interrupted" } }
        }),
    );
    Ok(json!({ "turn": { "id": turn_id, "status": "interrupted" } }))
}

pub fn discover_models(
    provider: &ProviderConfig,
    api_key: Option<String>,
) -> Result<Vec<String>, String> {
    let secret = api_key
        .filter(|key| !key.trim().is_empty())
        .map(|key| key.trim().to_string())
        .or(config::read_api_key(provider)?)
        .ok_or_else(|| format!("{} 尚未配置 API Key", provider.display_name))?;
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|error| error.to_string())?;
    let response = if provider.adapter == "anthropic-messages" {
        client
            .get(format!(
                "{}/v1/models",
                provider.base_url.trim_end_matches('/')
            ))
            .header("x-api-key", secret)
            .header("anthropic-version", "2023-06-01")
            .send()
            .map_err(|error| format!("Claude 模型目录请求失败：{error}"))?
    } else {
        client
            .get(format!(
                "{}/models",
                provider.base_url.trim_end_matches('/')
            ))
            .bearer_auth(secret)
            .send()
            .map_err(|error| format!("模型目录请求失败：{error}"))?
    };
    let status = response.status();
    let body = response.text().map_err(|error| error.to_string())?;
    let value: Value = serde_json::from_str(&body)
        .map_err(|_| format!("模型服务返回了无法解析的模型目录（HTTP {status}）"))?;
    if !status.is_success() {
        let message = value
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("未知服务错误");
        return Err(format!("模型目录返回 HTTP {status}：{message}"));
    }
    let mut models = value
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| item.get("id").and_then(Value::as_str))
        .map(str::to_string)
        .collect::<Vec<_>>();
    models.sort();
    models.dedup();
    if models.is_empty() {
        Err("模型服务没有返回可用模型".to_string())
    } else {
        Ok(models)
    }
}

fn stream_completion(
    provider: &ProviderConfig,
    model: &str,
    prompt: &str,
    history: &[ConversationMessage],
    on_delta: impl FnMut(String),
) -> Result<(), String> {
    let secret = config::read_api_key(provider)?
        .ok_or_else(|| format!("{} 尚未配置 API Key", provider.display_name))?;
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .map_err(|error| error.to_string())?;
    if provider.adapter == "anthropic-messages" {
        let url = format!("{}/v1/messages", provider.base_url.trim_end_matches('/'));
        let response = client
            .post(url)
            .header("x-api-key", secret)
            .header("anthropic-version", "2023-06-01")
            .json(&json!({ "model": model, "max_tokens": 8192, "stream": true, "messages": conversation_messages(history, prompt) }))
            .send()
            .map_err(|error| format!("Claude 请求失败：{error}"))?;
        return stream_sse_response(response, SseProtocol::Anthropic, on_delta);
    }
    let url = format!(
        "{}/chat/completions",
        provider.base_url.trim_end_matches('/')
    );
    let response = client
        .post(url)
        .bearer_auth(secret)
        .json(&json!({ "model": model, "messages": conversation_messages(history, prompt), "stream": true }))
        .send()
        .map_err(|error| format!("模型请求失败：{error}"))?;
    stream_sse_response(response, SseProtocol::OpenAiChat, on_delta)
}

fn conversation_messages(history: &[ConversationMessage], prompt: &str) -> Vec<Value> {
    history.iter().filter(|item| matches!(item.role.as_str(), "user" | "assistant") && !item.content.trim().is_empty())
        .rev().take(48).collect::<Vec<_>>().into_iter().rev()
        .map(|item| json!({ "role": item.role, "content": item.content.chars().take(16_000).collect::<String>() }))
        .chain(std::iter::once(json!({ "role": "user", "content": prompt }))).collect()
}

enum SseProtocol {
    Anthropic,
    OpenAiChat,
}

fn stream_sse_response(
    response: reqwest::blocking::Response,
    protocol: SseProtocol,
    mut on_delta: impl FnMut(String),
) -> Result<(), String> {
    let status = response.status();
    if !status.is_success() {
        let body = response.text().map_err(|error| error.to_string())?;
        let value: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
        let message = value
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("未知服务错误");
        return Err(format!("模型服务返回 HTTP {status}：{message}"));
    }
    let mut emitted = false;
    for line in BufReader::new(response).lines() {
        let line = line.map_err(|error| format!("模型流读取失败：{error}"))?;
        let Some(data) = line.strip_prefix("data: ") else {
            continue;
        };
        if data == "[DONE]" {
            break;
        }
        let value: Value = match serde_json::from_str(data) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let delta = match protocol {
            SseProtocol::Anthropic => value.pointer("/delta/text").and_then(Value::as_str),
            SseProtocol::OpenAiChat => value
                .pointer("/choices/0/delta/content")
                .and_then(Value::as_str),
        };
        if let Some(delta) = delta.filter(|value| !value.is_empty()) {
            emitted = true;
            on_delta(delta.to_string());
        }
    }
    if emitted {
        Ok(())
    } else {
        Err("模型服务没有返回文本内容或不支持流式输出".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retains_recent_history_in_chronological_order() {
        let history = vec![
            ConversationMessage {
                role: "user".to_string(),
                content: "first".to_string(),
            },
            ConversationMessage {
                role: "assistant".to_string(),
                content: "second".to_string(),
            },
        ];
        let messages = conversation_messages(&history, "third");
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0]["content"], "first");
        assert_eq!(messages[1]["content"], "second");
        assert_eq!(messages[2]["content"], "third");
    }

    #[test]
    fn expands_only_explicit_workspace_references() {
        let root =
            std::env::temp_dir().join(format!("kunlun-direct-adapter-{}", std::process::id()));
        std::fs::create_dir_all(&root).expect("create test workspace");
        std::fs::write(root.join("brief.md"), "trusted project brief").expect("write test file");
        let expanded = expand_workspace_references(
            root.to_str().expect("workspace path"),
            "review @brief.md please",
        )
        .expect("expand workspace reference");
        assert!(expanded.contains("trusted project brief"));
        assert!(expanded.contains("工作区文件：brief.md"));
        let _ = std::fs::remove_dir_all(root);
    }
}
