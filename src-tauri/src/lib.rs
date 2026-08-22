mod config;
mod direct_adapter;
mod runtime;
mod workspace;

use config::ProviderConfig;
use runtime::{RuntimeManager, RuntimeSnapshot};
use serde_json::{json, Value};
use tauri::{AppHandle, State};
use workspace::{TerminalManager, WorkspaceEntry};

#[tauri::command]
fn runtime_status(manager: State<'_, RuntimeManager>) -> RuntimeSnapshot {
    manager.snapshot()
}

#[tauri::command]
fn start_runtime(
    app: AppHandle,
    manager: State<'_, RuntimeManager>,
    engine: String,
) -> Result<RuntimeSnapshot, String> {
    if engine != "codex" && engine != "deepseek-harness" {
        return Err("Unsupported runtime engine".to_string());
    }
    manager
        .start(&app, &engine)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn stop_runtime(manager: State<'_, RuntimeManager>) -> Result<RuntimeSnapshot, String> {
    manager.stop().map_err(|error| error.to_string())
}

#[tauri::command]
fn create_thread(
    app: AppHandle,
    manager: State<'_, RuntimeManager>,
    cwd: String,
    model: Option<String>,
    engine: String,
) -> Result<Value, String> {
    if manager.engine().map_err(|error| error.to_string())? != engine {
        return Err("Selected runtime is not active".to_string());
    }
    if engine == "deepseek-harness" {
        return manager
            .request("session/new", json!({ "cwd": cwd, "model": model }))
            .map_err(|error| error.to_string());
    }
    let configured_model = config::load(&app)
        .ok()
        .filter(|provider| provider.adapter == "codex-responses")
        .and(model);
    manager
        .request(
            "thread/start",
            json!({
                "cwd": cwd,
                "model": configured_model.filter(|value| !value.trim().is_empty()),
                "approvalPolicy": "unlessTrusted",
                "sandbox": "workspaceWrite",
                "serviceName": "kunlun_growth_desktop"
            }),
        )
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn list_threads(
    manager: State<'_, RuntimeManager>,
    engine: String,
    search_term: Option<String>,
    archived: Option<bool>,
    is_pinned: Option<bool>,
) -> Result<Value, String> {
    let (method, params) = if engine == "deepseek-harness" {
        ("session/list", json!({ "limit": 100 }))
    } else {
        (
            "thread/list",
            json!({ "limit": 100, "searchTerm": search_term, "archived": archived, "isPinned": is_pinned }),
        )
    };
    manager
        .request(method, params)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn read_thread(manager: State<'_, RuntimeManager>, thread_id: String) -> Result<Value, String> {
    let engine = manager.engine().map_err(|error| error.to_string())?;
    let (method, params) = if engine == "deepseek-harness" {
        ("session/load", json!({ "sessionId": thread_id }))
    } else {
        (
            "thread/read",
            json!({ "threadId": thread_id, "includeTurns": true }),
        )
    };
    manager
        .request(method, params)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn resume_thread(
    manager: State<'_, RuntimeManager>,
    thread_id: String,
    cwd: Option<String>,
    model: Option<String>,
) -> Result<Value, String> {
    if manager.engine().map_err(|error| error.to_string())? == "deepseek-harness" {
        return manager
            .request(
                "session/load",
                json!({ "sessionId": thread_id, "cwd": cwd, "model": model }),
            )
            .map_err(|error| error.to_string());
    }
    manager
        .request(
            "thread/resume",
            json!({ "threadId": thread_id, "cwd": cwd, "model": model }),
        )
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn list_models(manager: State<'_, RuntimeManager>) -> Result<Value, String> {
    manager
        .request(
            "model/list",
            json!({ "limit": 100, "includeHidden": false }),
        )
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn set_thread_name(
    manager: State<'_, RuntimeManager>,
    thread_id: String,
    name: String,
) -> Result<Value, String> {
    if name.trim().is_empty() {
        return Err("Thread name cannot be empty".to_string());
    }
    manager
        .request(
            "thread/name/set",
            json!({ "threadId": thread_id, "name": name.trim() }),
        )
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn archive_thread(manager: State<'_, RuntimeManager>, thread_id: String) -> Result<Value, String> {
    manager
        .request("thread/archive", json!({ "threadId": thread_id }))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn fork_thread(
    manager: State<'_, RuntimeManager>,
    thread_id: String,
    last_turn_id: Option<String>,
) -> Result<Value, String> {
    manager
        .request(
            "thread/fork",
            json!({ "threadId": thread_id, "lastTurnId": last_turn_id }),
        )
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn set_thread_pinned(
    manager: State<'_, RuntimeManager>,
    thread_id: String,
    is_pinned: bool,
) -> Result<Value, String> {
    manager
        .request(
            "thread/metadata/update",
            json!({ "threadId": thread_id, "isPinned": is_pinned }),
        )
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn set_thread_goal(
    manager: State<'_, RuntimeManager>,
    thread_id: String,
    objective: String,
) -> Result<Value, String> {
    let objective = objective.trim();
    if objective.is_empty() || objective.chars().count() > 4_000 {
        return Err("Goal must contain between 1 and 4000 characters".to_string());
    }
    manager
        .request(
            "thread/goal/set",
            json!({ "threadId": thread_id, "objective": objective, "status": "active" }),
        )
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_thread_goal(manager: State<'_, RuntimeManager>, thread_id: String) -> Result<Value, String> {
    manager
        .request("thread/goal/get", json!({ "threadId": thread_id }))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn start_review(
    manager: State<'_, RuntimeManager>,
    thread_id: String,
    delivery: String,
) -> Result<Value, String> {
    if delivery != "inline" && delivery != "detached" {
        return Err("Unsupported review delivery".to_string());
    }
    manager.request("review/start", json!({ "threadId": thread_id, "delivery": delivery, "target": { "type": "uncommittedChanges" } })).map_err(|error| error.to_string())
}

#[tauri::command]
fn start_turn(
    app: AppHandle,
    manager: State<'_, RuntimeManager>,
    thread_id: String,
    cwd: String,
    text: String,
    model: Option<String>,
    effort: Option<String>,
    image_paths: Option<Vec<String>>,
    skill_name: Option<String>,
    skill_path: Option<String>,
    history: Option<Vec<direct_adapter::ConversationMessage>>,
) -> Result<Value, String> {
    let provider = config::load(&app)?;
    if provider.adapter != "codex-responses" {
        let expanded_text = direct_adapter::expand_workspace_references(&cwd, &text)?;
        return direct_adapter::start_turn(
            app,
            provider,
            thread_id,
            cwd,
            expanded_text,
            model,
            history.unwrap_or_default(),
        );
    }
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
    let mut input = vec![json!({ "type": "text", "text": text })];
    for path in image_paths.unwrap_or_default() {
        if !path.trim().is_empty() {
            input.push(json!({ "type": "localImage", "path": path }));
        }
    }
    if let (Some(name), Some(path)) = (
        skill_name.filter(|value| !value.trim().is_empty()),
        skill_path.filter(|value| !value.trim().is_empty()),
    ) {
        input.push(json!({ "type": "skill", "name": name, "path": path }));
    }
    manager
        .request(
            "turn/start",
            json!({
                "threadId": thread_id,
                "input": input,
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
fn interrupt_turn(
    app: AppHandle,
    manager: State<'_, RuntimeManager>,
    thread_id: String,
    turn_id: String,
) -> Result<Value, String> {
    if config::load(&app)?.adapter != "codex-responses" {
        return direct_adapter::cancel_turn(app, thread_id, turn_id);
    }
    manager
        .request(
            "turn/interrupt",
            json!({ "threadId": thread_id, "turnId": turn_id }),
        )
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn steer_turn(
    manager: State<'_, RuntimeManager>,
    thread_id: String,
    turn_id: String,
    text: String,
) -> Result<Value, String> {
    if text.trim().is_empty() {
        return Err("Steering input cannot be empty".to_string());
    }
    manager.request("turn/steer", json!({ "threadId": thread_id, "expectedTurnId": turn_id, "input": [{ "type": "text", "text": text.trim() }] })).map_err(|error| error.to_string())
}

#[tauri::command]
fn respond_server_request(
    manager: State<'_, RuntimeManager>,
    id: Value,
    result: Value,
) -> Result<(), String> {
    if direct_adapter::respond_to_approval(&id, result.clone()) {
        return Ok(());
    }
    manager
        .respond(id, result)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn load_provider_config(app: AppHandle) -> Result<ProviderConfig, String> {
    config::load(&app)
}

#[tauri::command]
fn save_provider_config(
    app: AppHandle,
    config: ProviderConfig,
    api_key: Option<String>,
) -> Result<ProviderConfig, String> {
    config::save(&app, config, api_key)
}

#[tauri::command]
fn list_provider_profiles(app: AppHandle) -> Result<Vec<ProviderConfig>, String> {
    config::load_profiles(&app)
}

#[tauri::command]
fn activate_provider_profile(app: AppHandle, profile_id: String) -> Result<ProviderConfig, String> {
    config::activate_profile(&app, &profile_id)
}

#[tauri::command]
fn discover_provider_models(
    config: ProviderConfig,
    api_key: Option<String>,
) -> Result<Vec<String>, String> {
    direct_adapter::discover_models(&config, api_key)
}

#[tauri::command]
fn delete_provider_secret() -> Result<(), String> {
    config::delete_api_key()
}

#[tauri::command]
fn list_workspace_files(cwd: String) -> Result<Vec<WorkspaceEntry>, String> {
    workspace::list_workspace(&cwd)
}

#[tauri::command]
fn read_workspace_file(cwd: String, path: String) -> Result<String, String> {
    workspace::read_workspace_file(&cwd, &path)
}

#[tauri::command]
fn read_git_diff(cwd: String) -> Result<String, String> {
    workspace::git_diff(&cwd)
}

#[tauri::command]
fn run_terminal_command(
    app: AppHandle,
    terminals: State<'_, TerminalManager>,
    cwd: String,
    command: String,
) -> Result<String, String> {
    terminals.run(app, cwd, command)
}

#[tauri::command]
fn stop_terminal_command(terminals: State<'_, TerminalManager>, id: String) -> Result<(), String> {
    terminals.stop(&id)
}

#[tauri::command]
fn run_sandbox_terminal(
    manager: State<'_, RuntimeManager>,
    cwd: String,
    command: String,
    process_id: String,
    cols: u16,
    rows: u16,
) -> Result<Value, String> {
    if command.trim().is_empty() || process_id.trim().is_empty() {
        return Err("Command and process id are required".to_string());
    }
    #[cfg(windows)]
    let argv = json!([
        "powershell.exe",
        "-NoLogo",
        "-NoProfile",
        "-Command",
        command
    ]);
    #[cfg(not(windows))]
    let argv = json!(["sh", "-lc", command]);
    manager.request("command/exec", json!({
        "command": argv,
        "processId": process_id,
        "tty": true,
        "streamStdin": true,
        "streamStdoutStderr": true,
        "disableTimeout": true,
        "cwd": cwd,
        "size": { "cols": cols.max(40), "rows": rows.max(10) },
        "sandboxPolicy": { "type": "workspaceWrite", "writableRoots": [cwd], "networkAccess": false }
    })).map_err(|error| error.to_string())
}

#[tauri::command]
fn write_sandbox_terminal(
    manager: State<'_, RuntimeManager>,
    process_id: String,
    delta_base64: String,
) -> Result<Value, String> {
    manager
        .request(
            "command/exec/write",
            json!({ "processId": process_id, "deltaBase64": delta_base64, "closeStdin": false }),
        )
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn resize_sandbox_terminal(
    manager: State<'_, RuntimeManager>,
    process_id: String,
    cols: u16,
    rows: u16,
) -> Result<Value, String> {
    manager.request("command/exec/resize", json!({ "processId": process_id, "size": { "cols": cols.max(40), "rows": rows.max(10) } })).map_err(|error| error.to_string())
}

#[tauri::command]
fn stop_sandbox_terminal(
    manager: State<'_, RuntimeManager>,
    process_id: String,
) -> Result<Value, String> {
    manager
        .request("command/exec/terminate", json!({ "processId": process_id }))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn list_skills(manager: State<'_, RuntimeManager>, cwd: String) -> Result<Value, String> {
    manager
        .request(
            "skills/list",
            json!({ "cwds": [cwd], "forceReload": false }),
        )
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn set_skill_enabled(
    manager: State<'_, RuntimeManager>,
    path: String,
    enabled: bool,
) -> Result<Value, String> {
    if path.trim().is_empty() {
        return Err("Skill path cannot be empty".to_string());
    }
    manager
        .request(
            "skills/config/write",
            json!({ "path": path, "enabled": enabled }),
        )
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn list_mcp_servers(
    manager: State<'_, RuntimeManager>,
    thread_id: Option<String>,
) -> Result<Value, String> {
    manager.request("mcpServerStatus/list", json!({ "threadId": thread_id, "cursor": null, "limit": 100, "detail": "toolsAndAuthOnly" })).map_err(|error| error.to_string())
}

#[tauri::command]
fn read_account(manager: State<'_, RuntimeManager>) -> Result<Value, String> {
    manager
        .request("account/read", json!({ "refreshToken": false }))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn start_account_login(manager: State<'_, RuntimeManager>) -> Result<Value, String> {
    manager
        .request(
            "account/login/start",
            json!({
                "type": "chatgpt",
                "appBrand": "codex",
                "codexStreamlinedLogin": true,
                "useHostedLoginSuccessPage": true
            }),
        )
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn logout_account(manager: State<'_, RuntimeManager>) -> Result<Value, String> {
    manager
        .request("account/logout", json!({}))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn read_account_usage(manager: State<'_, RuntimeManager>) -> Result<Value, String> {
    manager
        .request("account/usage/read", json!({}))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn list_collaboration_modes(manager: State<'_, RuntimeManager>) -> Result<Value, String> {
    manager
        .request("collaborationMode/list", json!({}))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn read_effective_config(manager: State<'_, RuntimeManager>) -> Result<Value, String> {
    manager
        .request("config/read", json!({ "includeLayers": false }))
        .map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(RuntimeManager::default())
        .manage(TerminalManager::default())
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
            fork_thread,
            set_thread_pinned,
            set_thread_goal,
            get_thread_goal,
            start_review,
            start_turn,
            interrupt_turn,
            steer_turn,
            respond_server_request,
            load_provider_config,
            save_provider_config,
            list_provider_profiles,
            activate_provider_profile,
            discover_provider_models,
            delete_provider_secret,
            list_workspace_files,
            read_workspace_file,
            read_git_diff,
            run_terminal_command,
            stop_terminal_command,
            run_sandbox_terminal,
            write_sandbox_terminal,
            resize_sandbox_terminal,
            stop_sandbox_terminal,
            list_skills,
            set_skill_enabled,
            list_mcp_servers,
            read_account,
            start_account_login,
            logout_account,
            read_account_usage,
            list_collaboration_modes,
            read_effective_config
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Kunlun Growth");
}
