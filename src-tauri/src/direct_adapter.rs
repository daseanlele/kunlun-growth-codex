use crate::{
    config::{self, ProviderConfig},
    workspace,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

static NEXT_TURN_ID: AtomicU64 = AtomicU64::new(1);
static CANCELLATIONS: OnceLock<Mutex<HashMap<String, Arc<std::sync::atomic::AtomicBool>>>> =
    OnceLock::new();
static APPROVALS: OnceLock<Mutex<HashMap<String, mpsc::Sender<Value>>>> = OnceLock::new();

fn cancellations() -> &'static Mutex<HashMap<String, Arc<std::sync::atomic::AtomicBool>>> {
    CANCELLATIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn approvals() -> &'static Mutex<HashMap<String, mpsc::Sender<Value>>> {
    APPROVALS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn respond_to_approval(id: &Value, result: Value) -> bool {
    let Some(id) = id.as_str() else {
        return false;
    };
    let sender = approvals()
        .lock()
        .ok()
        .and_then(|mut items| items.remove(id));
    sender
        .map(|sender| sender.send(result).is_ok())
        .unwrap_or(false)
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Default)]
struct ToolCall {
    id: String,
    name: String,
    arguments: String,
}

#[derive(Debug, Default)]
struct StreamOutcome {
    tool_calls: Vec<ToolCall>,
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
    cwd: String,
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
        let mut messages = conversation_messages(&history, &text);
        let result = run_native_agent(
            &app,
            &provider,
            &model,
            &cwd,
            &thread_id,
            &turn_id,
            &mut messages,
            move |delta| {
                if stream_cancellation.load(Ordering::Relaxed) {
                    return;
                }
                let _ = stream_app.emit("app-server-notification", json!({
                "method": "item/agentMessage/delta",
                "params": { "threadId": stream_thread_id, "turnId": stream_turn_id, "itemId": item_id, "delta": delta }
            }));
            },
        );
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
        apply_api_key_header(
            client
                .get(format!(
                    "{}/v1/models",
                    provider.base_url.trim_end_matches('/')
                ))
                .header("anthropic-version", "2023-06-01"),
            provider,
            &secret,
            "x-api-key",
        )?
        .send()
        .map_err(|error| format!("Claude 模型目录请求失败：{error}"))?
    } else {
        apply_api_key_header(
            client.get(format!(
                "{}/models",
                provider.base_url.trim_end_matches('/')
            )),
            provider,
            &secret,
            "Authorization",
        )?
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

fn run_native_agent(
    app: &AppHandle,
    provider: &ProviderConfig,
    model: &str,
    cwd: &str,
    thread_id: &str,
    turn_id: &str,
    messages: &mut Vec<Value>,
    mut on_delta: impl FnMut(String),
) -> Result<(), String> {
    for _ in 0..8 {
        let outcome = stream_completion(provider, model, messages, |delta| on_delta(delta))?;
        if outcome.tool_calls.is_empty() {
            return Ok(());
        }
        if provider.adapter == "anthropic-messages" {
            let content = outcome.tool_calls.iter().map(|call| json!({ "type": "tool_use", "id": call.id, "name": call.name, "input": serde_json::from_str::<Value>(&call.arguments).unwrap_or(json!({})) })).collect::<Vec<_>>();
            messages.push(json!({ "role": "assistant", "content": content }));
        } else {
            let assistant_tool_calls = outcome.tool_calls.iter().map(|call| json!({ "id": call.id, "type": "function", "function": { "name": call.name, "arguments": call.arguments } })).collect::<Vec<_>>();
            messages.push(json!({ "role": "assistant", "tool_calls": assistant_tool_calls }));
        }
        let mut tool_results = Vec::new();
        for call in outcome.tool_calls {
            let description = if call.name == "write_workspace_file" {
                "等待用户批准后创建或写入工作区文件"
            } else {
                "只读工作区工具"
            };
            let _ = app.emit("app-server-notification", json!({
                "method": "native/toolCall",
                "params": { "threadId": thread_id, "turnId": turn_id, "item": { "id": format!("{turn_id}-{}", call.id), "name": call.name, "description": description, "status": "running" } }
            }));
            let output = execute_tool(app, cwd, thread_id, turn_id, &call);
            let _ = app.emit("app-server-notification", json!({
                "method": "native/toolCall",
                "params": { "threadId": thread_id, "turnId": turn_id, "item": { "id": format!("{turn_id}-{}", call.id), "name": call.name, "description": description, "status": "completed" } }
            }));
            if provider.adapter == "anthropic-messages" {
                tool_results.push(
                    json!({ "type": "tool_result", "tool_use_id": call.id, "content": output }),
                );
            } else {
                messages
                    .push(json!({ "role": "tool", "tool_call_id": call.id, "content": output }));
            }
        }
        if provider.adapter == "anthropic-messages" {
            messages.push(json!({ "role": "user", "content": tool_results }));
        }
    }
    Err("原生模型工具调用超过了 8 轮限制".to_string())
}

fn execute_tool(
    app: &AppHandle,
    cwd: &str,
    thread_id: &str,
    turn_id: &str,
    call: &ToolCall,
) -> String {
    if call.name == "write_workspace_file" {
        return execute_write_tool(app, cwd, thread_id, turn_id, &call.id, &call.arguments);
    }
    if call.name == "run_workspace_check" {
        return execute_check_tool(app, cwd, thread_id, turn_id, &call.id, &call.arguments);
    }
    let name = &call.name;
    let arguments = &call.arguments;
    let result = match name.as_str() {
        "list_workspace_files" => workspace::list_workspace(cwd).map(|entries| {
            entries
                .into_iter()
                .take(500)
                .map(|entry| {
                    format!(
                        "{}{}",
                        if entry.is_dir { "目录 " } else { "文件 " },
                        entry.path
                    )
                })
                .collect::<Vec<_>>()
                .join("\n")
        }),
        "read_workspace_file" => {
            let path = serde_json::from_str::<Value>(arguments)
                .ok()
                .and_then(|value| {
                    value
                        .get("path")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                });
            path.ok_or_else(|| "read_workspace_file 需要 path 参数".to_string())
                .and_then(|path| {
                    workspace::read_workspace_file(cwd, &path)
                        .map(|text| text.chars().take(48_000).collect())
                })
        }
        "read_git_diff" => workspace::git_diff(cwd).map(|diff| diff.chars().take(96_000).collect()),
        "search_workspace" => {
            let parsed = serde_json::from_str::<Value>(arguments).unwrap_or(Value::Null);
            parsed
                .get("query")
                .and_then(Value::as_str)
                .ok_or_else(|| "search_workspace 需要 query 参数".to_string())
                .and_then(|query| {
                    workspace::search_workspace(
                        cwd,
                        query,
                        parsed.get("path").and_then(Value::as_str),
                    )
                })
                .map(|output| output.chars().take(96_000).collect())
        }
        _ => Err(format!("不允许的只读工具：{name}")),
    };
    result.unwrap_or_else(|error| format!("工具执行失败：{error}"))
}

fn execute_check_tool(
    app: &AppHandle,
    cwd: &str,
    _thread_id: &str,
    turn_id: &str,
    call_id: &str,
    arguments: &str,
) -> String {
    let task = serde_json::from_str::<Value>(arguments)
        .ok()
        .and_then(|value| {
            value
                .get("task")
                .and_then(Value::as_str)
                .map(str::to_string)
        });
    let Some(task) = task else {
        return "run_workspace_check 需要 task 参数".to_string();
    };
    let approval_id = format!("native-approval-{turn_id}-{call_id}");
    let (sender, receiver) = mpsc::channel();
    if approvals()
        .lock()
        .map(|mut items| items.insert(approval_id.clone(), sender))
        .is_err()
    {
        return "无法创建命令审批".to_string();
    }
    let _ = app.emit("app-server-request", json!({ "id": approval_id, "method": "permissions/requestApproval", "params": { "reason": format!("原生模型请求运行受限工作区检查 {task}"), "requestedPermissions": { "runWorkspaceCheck": task }, "command": task, "cwd": cwd } }));
    let approved = receiver
        .recv_timeout(std::time::Duration::from_secs(300))
        .ok()
        .and_then(|result| result.get("permissions").cloned())
        .map(|permissions| permissions != json!({}))
        .unwrap_or(false);
    if let Ok(mut items) = approvals().lock() {
        items.remove(&approval_id);
    }
    if !approved {
        return "用户未批准运行工作区检查".to_string();
    }
    workspace::run_workspace_check(cwd, &task)
        .unwrap_or_else(|error| format!("检查执行失败：{error}"))
}

fn execute_write_tool(
    app: &AppHandle,
    cwd: &str,
    _thread_id: &str,
    turn_id: &str,
    call_id: &str,
    arguments: &str,
) -> String {
    let parsed = serde_json::from_str::<Value>(arguments).unwrap_or(Value::Null);
    let Some(path) = parsed.get("path").and_then(Value::as_str) else {
        return "write_workspace_file 需要 path 参数".to_string();
    };
    let Some(content) = parsed.get("content").and_then(Value::as_str) else {
        return "write_workspace_file 需要 content 参数".to_string();
    };
    let approval_id = format!("native-approval-{turn_id}-{call_id}");
    let (sender, receiver) = mpsc::channel();
    if approvals()
        .lock()
        .map(|mut items| items.insert(approval_id.clone(), sender))
        .is_err()
    {
        return "无法创建写入审批".to_string();
    }
    let _ = app.emit("app-server-request", json!({
        "id": approval_id,
        "method": "permissions/requestApproval",
        "params": { "reason": format!("原生模型请求创建或写入工作区文件 {path}"), "requestedPermissions": { "writeWorkspaceFile": path }, "cwd": cwd }
    }));
    let approved = receiver
        .recv_timeout(std::time::Duration::from_secs(300))
        .ok()
        .and_then(|result| result.get("permissions").cloned())
        .map(|permissions| permissions != json!({}))
        .unwrap_or(false);
    if let Ok(mut items) = approvals().lock() {
        items.remove(&approval_id);
    }
    if !approved {
        return "用户未批准写入文件".to_string();
    }
    workspace::write_workspace_file(cwd, path, content)
        .map(|_| format!("已写入 {path}"))
        .unwrap_or_else(|error| format!("工具执行失败：{error}"))
}

fn stream_completion(
    provider: &ProviderConfig,
    model: &str,
    messages: &[Value],
    on_delta: impl FnMut(String),
) -> Result<StreamOutcome, String> {
    let secret = config::read_api_key(provider)?
        .ok_or_else(|| format!("{} 尚未配置 API Key", provider.display_name))?;
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .map_err(|error| error.to_string())?;
    if provider.adapter == "anthropic-messages" {
        let url = format!("{}/v1/messages", provider.base_url.trim_end_matches('/'));
        let response = apply_api_key_header(
            client
            .post(url)
            .header("anthropic-version", "2023-06-01")
            .json(&json!({ "model": model, "max_tokens": 8192, "stream": true, "messages": messages, "tools": native_tools_anthropic() })), provider, &secret, "x-api-key")?
            .send()
            .map_err(|error| format!("Claude 请求失败：{error}"))?;
        return stream_sse_response(response, SseProtocol::Anthropic, on_delta);
    }
    let url = format!(
        "{}/chat/completions",
        provider.base_url.trim_end_matches('/')
    );
    let response = apply_api_key_header(
        client
        .post(url)
        .json(&json!({ "model": model, "messages": messages, "stream": true, "tools": native_tools_openai(), "tool_choice": "auto" })), provider, &secret, "Authorization")?
        .send()
        .map_err(|error| format!("模型请求失败：{error}"))?;
    stream_sse_response(response, SseProtocol::OpenAiChat, on_delta)
}

fn apply_api_key_header(
    request: reqwest::blocking::RequestBuilder,
    provider: &ProviderConfig,
    secret: &str,
    default_header: &str,
) -> Result<reqwest::blocking::RequestBuilder, String> {
    let header = provider
        .auth_header
        .as_deref()
        .unwrap_or(default_header)
        .trim();
    let name = reqwest::header::HeaderName::from_bytes(header.as_bytes())
        .map_err(|_| "Invalid authentication header name".to_string())?;
    let value = if header.eq_ignore_ascii_case("authorization") {
        format!("Bearer {secret}")
    } else {
        secret.to_string()
    };
    let value = reqwest::header::HeaderValue::from_str(&value)
        .map_err(|_| "Invalid API key for HTTP request header".to_string())?;
    Ok(request.header(name, value))
}

fn native_tools_openai() -> Vec<Value> {
    let mut tools = vec![
        json!({ "type": "function", "function": { "name": "list_workspace_files", "description": "列出用户已选择工作区的文件和目录。用于了解项目结构。", "parameters": { "type": "object", "properties": {}, "additionalProperties": false } } }),
        json!({ "type": "function", "function": { "name": "read_workspace_file", "description": "读取用户已选择工作区内的 UTF-8 文本文件。仅在需要具体内容时调用。", "parameters": { "type": "object", "properties": { "path": { "type": "string", "description": "相对于工作区根目录的路径" } }, "required": ["path"], "additionalProperties": false } } }),
        json!({ "type": "function", "function": { "name": "read_git_diff", "description": "读取当前工作区未提交的 Git diff。", "parameters": { "type": "object", "properties": {}, "additionalProperties": false } } }),
        json!({ "type": "function", "function": { "name": "search_workspace", "description": "在工作区内全文搜索文本并返回匹配行。可选 path 必须是工作区内的现有路径。", "parameters": { "type": "object", "properties": { "query": { "type": "string" }, "path": { "type": "string" } }, "required": ["query"], "additionalProperties": false } } }),
        json!({ "type": "function", "function": { "name": "run_workspace_check", "description": "请求运行一个受限且需用户批准的工作区检查。task 仅可为 git_status、git_diff_check、npm_test 或 cargo_test。", "parameters": { "type": "object", "properties": { "task": { "type": "string", "enum": ["git_status", "git_diff_check", "npm_test", "cargo_test"] } }, "required": ["task"], "additionalProperties": false } } }),
    ];
    tools.push(json!({ "type": "function", "function": { "name": "write_workspace_file", "description": "创建或覆盖工作区内的 UTF-8 文本文件。调用后必须等待用户在桌面端明确批准；不得删除或重命名文件。", "parameters": { "type": "object", "properties": { "path": { "type": "string", "description": "相对于工作区根目录的文件路径" }, "content": { "type": "string", "description": "写入后的完整文件内容" } }, "required": ["path", "content"], "additionalProperties": false } } }));
    tools
}

fn native_tools_anthropic() -> Vec<Value> {
    let mut tools = vec![
        json!({ "name": "list_workspace_files", "description": "列出用户已选择工作区的文件和目录。用于了解项目结构。", "input_schema": { "type": "object", "properties": {}, "additionalProperties": false } }),
        json!({ "name": "read_workspace_file", "description": "读取用户已选择工作区内的 UTF-8 文本文件。仅在需要具体内容时调用。", "input_schema": { "type": "object", "properties": { "path": { "type": "string", "description": "相对于工作区根目录的路径" } }, "required": ["path"], "additionalProperties": false } }),
        json!({ "name": "read_git_diff", "description": "读取当前工作区未提交的 Git diff。", "input_schema": { "type": "object", "properties": {}, "additionalProperties": false } }),
        json!({ "name": "search_workspace", "description": "在工作区内全文搜索文本并返回匹配行。可选 path 必须是工作区内的现有路径。", "input_schema": { "type": "object", "properties": { "query": { "type": "string" }, "path": { "type": "string" } }, "required": ["query"], "additionalProperties": false } }),
        json!({ "name": "run_workspace_check", "description": "请求运行一个受限且需用户批准的工作区检查。task 仅可为 git_status、git_diff_check、npm_test 或 cargo_test。", "input_schema": { "type": "object", "properties": { "task": { "type": "string", "enum": ["git_status", "git_diff_check", "npm_test", "cargo_test"] } }, "required": ["task"], "additionalProperties": false } }),
    ];
    tools.push(json!({ "name": "write_workspace_file", "description": "创建或覆盖工作区内的 UTF-8 文本文件。调用后必须等待用户在桌面端明确批准；不得删除或重命名文件。", "input_schema": { "type": "object", "properties": { "path": { "type": "string", "description": "相对于工作区根目录的文件路径" }, "content": { "type": "string", "description": "写入后的完整文件内容" } }, "required": ["path", "content"], "additionalProperties": false } }));
    tools
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
) -> Result<StreamOutcome, String> {
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
    let mut tool_calls: Vec<ToolCall> = Vec::new();
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
        match protocol {
            SseProtocol::OpenAiChat => collect_openai_tool_calls(&value, &mut tool_calls),
            SseProtocol::Anthropic => collect_anthropic_tool_calls(&value, &mut tool_calls),
        }
    }
    tool_calls.retain(|call| !call.id.is_empty() && !call.name.is_empty());
    if emitted || !tool_calls.is_empty() {
        Ok(StreamOutcome { tool_calls })
    } else {
        Err("模型服务没有返回文本内容或不支持流式输出".to_string())
    }
}

fn collect_openai_tool_calls(value: &Value, tool_calls: &mut Vec<ToolCall>) {
    for call in value
        .pointer("/choices/0/delta/tool_calls")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let index = call.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
        while tool_calls.len() <= index {
            tool_calls.push(ToolCall::default());
        }
        let current = &mut tool_calls[index];
        if let Some(id) = call.get("id").and_then(Value::as_str) {
            current.id = id.to_string();
        }
        if let Some(name) = call.pointer("/function/name").and_then(Value::as_str) {
            current.name.push_str(name);
        }
        if let Some(arguments) = call.pointer("/function/arguments").and_then(Value::as_str) {
            current.arguments.push_str(arguments);
        }
    }
}

fn collect_anthropic_tool_calls(value: &Value, tool_calls: &mut Vec<ToolCall>) {
    let index = value.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
    let is_start = value.pointer("/content_block/type").and_then(Value::as_str) == Some("tool_use");
    let partial = value.pointer("/delta/partial_json").and_then(Value::as_str);
    if !is_start && partial.is_none() {
        return;
    }
    while tool_calls.len() <= index {
        tool_calls.push(ToolCall::default());
    }
    let current = &mut tool_calls[index];
    if is_start {
        if let Some(id) = value.pointer("/content_block/id").and_then(Value::as_str) {
            current.id = id.to_string();
        }
        if let Some(name) = value.pointer("/content_block/name").and_then(Value::as_str) {
            current.name = name.to_string();
        }
        if let Some(input) = value
            .pointer("/content_block/input")
            .filter(|input| !input.is_null())
        {
            if input
                .as_object()
                .map(|object| !object.is_empty())
                .unwrap_or(true)
            {
                current.arguments = input.to_string();
            }
        }
    }
    if let Some(partial) = partial {
        current.arguments.push_str(partial);
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

    #[test]
    fn combines_fragmented_openai_tool_calls() {
        let mut calls = Vec::new();
        collect_openai_tool_calls(
            &json!({ "choices": [{ "delta": { "tool_calls": [{ "index": 0, "id": "call_1", "function": { "name": "read_workspace_", "arguments": "{\"pa" } }] } }] }),
            &mut calls,
        );
        collect_openai_tool_calls(
            &json!({ "choices": [{ "delta": { "tool_calls": [{ "index": 0, "function": { "name": "file", "arguments": "th\":\"src/main.rs\"}" } }] } }] }),
            &mut calls,
        );
        assert_eq!(calls[0].id, "call_1");
        assert_eq!(calls[0].name, "read_workspace_file");
        assert_eq!(calls[0].arguments, "{\"path\":\"src/main.rs\"}");
    }

    #[test]
    fn combines_anthropic_tool_use_input() {
        let mut calls = Vec::new();
        collect_anthropic_tool_calls(
            &json!({ "index": 0, "content_block": { "type": "tool_use", "id": "toolu_1", "name": "read_workspace_file", "input": {} } }),
            &mut calls,
        );
        collect_anthropic_tool_calls(
            &json!({ "index": 0, "delta": { "type": "input_json_delta", "partial_json": "{\"path\":\"README.md\"}" } }),
            &mut calls,
        );
        assert_eq!(calls[0].id, "toolu_1");
        assert_eq!(calls[0].name, "read_workspace_file");
        assert_eq!(calls[0].arguments, "{\"path\":\"README.md\"}");
    }
}
