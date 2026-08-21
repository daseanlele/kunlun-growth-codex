mod config;
mod runtime;

use config::ProviderConfig;
use runtime::{RuntimeManager, RuntimeSnapshot};
use serde_json::{json, Value};
use tauri::{AppHandle, State};

#[tauri::command]
fn runtime_status(manager: State<'_, RuntimeManager>) -> RuntimeSnapshot {
    manager.snapshot()
}

#[tauri::command]
fn start_runtime(app: AppHandle, manager: State<'_, RuntimeManager>, engine: String) -> Result<RuntimeSnapshot, String> {
    if engine != "codex" && engine != "deepseek-harness" {
        return Err("Unsupported runtime engine".to_string());
    }
    manager.start(&app, &engine).map_err(|error| error.to_string())
}

#[tauri::command]
fn stop_runtime(manager: State<'_, RuntimeManager>) -> Result<RuntimeSnapshot, String> {
    manager.stop().map_err(|error| error.to_string())
}

#[tauri::command]
fn create_thread(manager: State<'_, RuntimeManager>, cwd: String, model: Option<String>, engine: String) -> Result<Value, String> {
    if manager.engine().map_err(|error| error.to_string())? != engine {
        return Err("Selected runtime is not active".to_string());
    }
    if engine == "deepseek-harness" {
        return manager
            .request("session/new", json!({ "cwd": cwd, "model": model }))
            .map_err(|error| error.to_string());
    }
    manager
        .request(
            "thread/start",
            json!({
                "cwd": cwd,
                "model": model.filter(|value| !value.trim().is_empty()),
                "approvalPolicy": "unlessTrusted",
                "sandbox": "workspaceWrite",
                "serviceName": "kunlun_growth_desktop"
            }),
        )
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn list_threads(manager: State<'_, RuntimeManager>, engine: String) -> Result<Value, String> {
    let method = if engine == "deepseek-harness" { "session/list" } else { "thread/list" };
    manager.request(method, json!({ "limit": 100 })).map_err(|error| error.to_string())
}

#[tauri::command]
fn read_thread(manager: State<'_, RuntimeManager>, thread_id: String) -> Result<Value, String> {
    let engine = manager.engine().map_err(|error| error.to_string())?;
    let (method, params) = if engine == "deepseek-harness" {
        ("session/load", json!({ "sessionId": thread_id }))
    } else {
        ("thread/read", json!({ "threadId": thread_id, "includeTurns": true }))
    };
    manager.request(method, params).map_err(|error| error.to_string())
}

#[tauri::command]
fn resume_thread(manager: State<'_, RuntimeManager>, thread_id: String, cwd: Option<String>, model: Option<String>) -> Result<Value, String> {
    if manager.engine().map_err(|error| error.to_string())? == "deepseek-harness" {
        return manager.request("session/load", json!({ "sessionId": thread_id, "cwd": cwd, "model": model })).map_err(|error| error.to_string());
    }
    manager.request("thread/resume", json!({ "threadId": thread_id, "cwd": cwd, "model": model })).map_err(|error| error.to_string())
}

#[tauri::command]
fn list_models(manager: State<'_, RuntimeManager>) -> Result<Value, String> {
    manager.request("model/list", json!({ "limit": 100, "includeHidden": false })).map_err(|error| error.to_string())
}

#[tauri::command]
fn set_thread_name(manager: State<'_, RuntimeManager>, thread_id: String, name: String) -> Result<Value, String> {
    if name.trim().is_empty() { return Err("Thread name cannot be empty".to_string()); }
    manager.request("thread/name/set", json!({ "threadId": thread_id, "name": name.trim() })).map_err(|error| error.to_string())
}

#[tauri::command]
fn archive_thread(manager: State<'_, RuntimeManager>, thread_id: String) -> Result<Value, String> {
    manager.request("thread/archive", json!({ "threadId": thread_id })).map_err(|error| error.to_string())
}

#[tauri::command]
fn start_turn(
    manager: State<'_, RuntimeManager>,
    thread_id: String,
    cwd: String,
    text: String,
    model: Option<String>,
    effort: Option<String>,
) -> Result<Value, String> {
    if manager.engine().map_err(|error| error.to_string())? == "deepseek-harness" {
        return manager
            .request(
                "session/prompt",
                json!({
                    "sessionId": thread_id,
                    "prompt": [{ "type": "text", "text": text }],
                    "cwd": cwd,
                    "model": model,
                    "effort": effort
                }),
            )
            .map_err(|error| error.to_string());
    }
    manager
        .request(
            "turn/start",
            json!({
                "threadId": thread_id,
                "input": [{ "type": "text", "text": text }],
                "cwd": cwd,
                "model": model.filter(|value| !value.trim().is_empty()),
                "effort": effort.filter(|value| !value.trim().is_empty()),
                "approvalPolicy": "unlessTrusted",
                "sandboxPolicy": {
                    "type": "workspaceWrite",
                    "writableRoots": [cwd],
                    "networkAccess": false
                }
            }),
        )
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn interrupt_turn(manager: State<'_, RuntimeManager>, thread_id: String, turn_id: String) -> Result<Value, String> {
    manager
        .request("turn/interrupt", json!({ "threadId": thread_id, "turnId": turn_id }))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn respond_server_request(manager: State<'_, RuntimeManager>, id: Value, result: Value) -> Result<(), String> {
    manager.respond(id, result).map_err(|error| error.to_string())
}

#[tauri::command]
fn load_provider_config(app: AppHandle) -> Result<ProviderConfig, String> {
    config::load(&app)
}

#[tauri::command]
fn save_provider_config(app: AppHandle, config: ProviderConfig, api_key: Option<String>) -> Result<ProviderConfig, String> {
    config::save(&app, config, api_key)
}

#[tauri::command]
fn delete_provider_secret() -> Result<(), String> {
    config::delete_api_key()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(RuntimeManager::default())
        .invoke_handler(tauri::generate_handler![
            runtime_status,
            start_runtime,
            stop_runtime,
            create_thread,
            list_threads,
            read_thread,
            resume_thread,
            list_models,
            set_thread_name,
            archive_thread,
            start_turn,
            interrupt_turn,
            respond_server_request,
            load_provider_config,
            save_provider_config,
            delete_provider_secret
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Kunlun Growth");
}
