use crate::config;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use thiserror::Error;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSnapshot {
    pub status: RuntimeStatus,
    pub pid: Option<u32>,
    pub binary: String,
    pub version: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeStatus {
    Stopped,
    Starting,
    Ready,
    Error,
}

#[derive(Debug, Error)]
pub enum RuntimeError {
    #[error("Codex runtime state is unavailable")]
    StatePoisoned,
    #[error("Codex App Server is already running")]
    AlreadyRunning,
    #[error("Codex App Server is not running")]
    NotRunning,
    #[error("Unable to locate the bundled Codex runtime")]
    BinaryMissing,
    #[error("Unable to start Codex App Server: {0}")]
    StartFailed(#[from] std::io::Error),
    #[error("App Server request timed out: {0}")]
    Timeout(String),
    #[error("App Server protocol error: {0}")]
    Protocol(String),
}

struct RuntimeState {
    child: Option<Child>,
    writer: Option<Arc<Mutex<ChildStdin>>>,
    status: RuntimeStatus,
    binary: String,
    version: Option<String>,
    last_error: Option<String>,
}

type PendingResponse = mpsc::Sender<Result<Value, String>>;

pub struct RuntimeManager {
    state: Mutex<RuntimeState>,
    pending: Mutex<HashMap<String, PendingResponse>>,
    next_id: AtomicU64,
}

impl Default for RuntimeManager {
    fn default() -> Self {
        Self {
            state: Mutex::new(RuntimeState {
                child: None,
                writer: None,
                status: RuntimeStatus::Stopped,
                binary: "codex".to_string(),
                version: None,
                last_error: None,
            }),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
        }
    }
}

impl RuntimeManager {
    pub fn snapshot(&self) -> RuntimeSnapshot {
        let Ok(mut state) = self.state.lock() else {
            return RuntimeSnapshot {
                status: RuntimeStatus::Error,
                pid: None,
                binary: "unknown".to_string(),
                version: None,
                last_error: Some("Runtime state lock was poisoned".to_string()),
            };
        };

        if let Some(child) = state.child.as_mut() {
            if let Ok(Some(exit)) = child.try_wait() {
                state.child = None;
                state.writer = None;
                if state.status != RuntimeStatus::Stopped {
                    state.status = RuntimeStatus::Error;
                    state.last_error = Some(format!("Codex exited with {exit}"));
                }
            }
        }

        RuntimeSnapshot {
            status: state.status,
            pid: state.child.as_ref().map(Child::id),
            binary: state.binary.clone(),
            version: state.version.clone(),
            last_error: state.last_error.clone(),
        }
    }

    pub fn start(&self, app: &AppHandle) -> Result<RuntimeSnapshot, RuntimeError> {
        {
            let mut state = self.state.lock().map_err(|_| RuntimeError::StatePoisoned)?;
            if state.child.is_some() {
                return Err(RuntimeError::AlreadyRunning);
            }
            state.status = RuntimeStatus::Starting;
            state.last_error = None;
        }

        let binary = resolve_binary(app).ok_or(RuntimeError::BinaryMissing)?;
        let provider = config::load(app).map_err(RuntimeError::Protocol)?;
        let mut command = Command::new(&binary);
        command.arg("app-server").arg("--stdio").arg("--strict-config");
        if let Ok(config_dir) = app.path().app_config_dir() {
            let codex_home = config_dir.join("codex-home");
            std::fs::create_dir_all(&codex_home)?;
            command.env("CODEX_HOME", codex_home);
        }
        apply_provider_config(&mut command, &provider)?;
        command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());

        let mut child = command.spawn()?;
        let stdin = child.stdin.take().ok_or_else(|| RuntimeError::Protocol("stdin unavailable".to_string()))?;
        let stdout = child.stdout.take().ok_or_else(|| RuntimeError::Protocol("stdout unavailable".to_string()))?;
        let stderr = child.stderr.take().ok_or_else(|| RuntimeError::Protocol("stderr unavailable".to_string()))?;

        {
            let mut state = self.state.lock().map_err(|_| RuntimeError::StatePoisoned)?;
            state.binary = binary.display().to_string();
            state.version = detect_version(&binary);
            state.writer = Some(Arc::new(Mutex::new(stdin)));
            state.child = Some(child);
        }

        spawn_stdout_reader(app.clone(), stdout);
        spawn_stderr_reader(app.clone(), stderr);

        let initialize = match self.request(
            "initialize",
            json!({
                "clientInfo": {
                    "name": "kunlun_growth_desktop",
                    "title": "昆仑增长桌面端",
                    "version": env!("CARGO_PKG_VERSION")
                },
                "capabilities": null
            }),
        ) {
            Ok(value) => value,
            Err(error) => {
                let _ = self.stop();
                return Err(error);
            }
        };
        if let Err(error) = self.send_notification("initialized", json!({})) {
            let _ = self.stop();
            return Err(error);
        }

        {
            let mut state = self.state.lock().map_err(|_| RuntimeError::StatePoisoned)?;
            state.status = RuntimeStatus::Ready;
        }
        let _ = app.emit("app-server-initialized", initialize);
        Ok(self.snapshot())
    }

    pub fn stop(&self) -> Result<RuntimeSnapshot, RuntimeError> {
        let mut state = self.state.lock().map_err(|_| RuntimeError::StatePoisoned)?;
        state.status = RuntimeStatus::Stopped;
        state.writer = None;
        if let Some(mut child) = state.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        drop(state);
        self.fail_pending("Codex App Server stopped");
        Ok(self.snapshot())
    }

    pub fn request(&self, method: &str, params: Value) -> Result<Value, RuntimeError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let key = id.to_string();
        let (sender, receiver) = mpsc::channel();
        self.pending
            .lock()
            .map_err(|_| RuntimeError::StatePoisoned)?
            .insert(key.clone(), sender);

        if let Err(error) = self.write_message(&json!({ "method": method, "id": id, "params": params })) {
            if let Ok(mut pending) = self.pending.lock() {
                pending.remove(&key);
            }
            return Err(error);
        }

        match receiver.recv_timeout(Duration::from_secs(30)) {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(error)) => Err(RuntimeError::Protocol(error)),
            Err(_) => {
                if let Ok(mut pending) = self.pending.lock() {
                    pending.remove(&key);
                }
                Err(RuntimeError::Timeout(method.to_string()))
            }
        }
    }

    pub fn respond(&self, id: Value, result: Value) -> Result<(), RuntimeError> {
        self.write_message(&json!({ "id": id, "result": result }))
    }

    fn send_notification(&self, method: &str, params: Value) -> Result<(), RuntimeError> {
        self.write_message(&json!({ "method": method, "params": params }))
    }

    fn write_message(&self, value: &Value) -> Result<(), RuntimeError> {
        let writer = self
            .state
            .lock()
            .map_err(|_| RuntimeError::StatePoisoned)?
            .writer
            .clone()
            .ok_or(RuntimeError::NotRunning)?;
        let mut guard = writer.lock().map_err(|_| RuntimeError::StatePoisoned)?;
        serde_json::to_writer(&mut *guard, value).map_err(|error| RuntimeError::Protocol(error.to_string()))?;
        guard.write_all(b"\n")?;
        guard.flush()?;
        Ok(())
    }

    fn accept_incoming(&self, message: &Value) -> bool {
        let Some(id) = message.get("id") else { return false };
        if message.get("method").is_some() { return false; }
        let key = match id {
            Value::String(value) => value.clone(),
            _ => id.to_string(),
        };
        let sender = self.pending.lock().ok().and_then(|mut pending| pending.remove(&key));
        if let Some(sender) = sender {
            let result = if let Some(error) = message.get("error") {
                Err(error.to_string())
            } else {
                Ok(message.get("result").cloned().unwrap_or(Value::Null))
            };
            let _ = sender.send(result);
            true
        } else {
            false
        }
    }

    fn fail_pending(&self, reason: &str) {
        if let Ok(mut pending) = self.pending.lock() {
            for (_, sender) in pending.drain() {
                let _ = sender.send(Err(reason.to_string()));
            }
        }
    }

    fn reader_closed(&self, app: &AppHandle) {
        if let Ok(mut state) = self.state.lock() {
            state.writer = None;
            if state.status != RuntimeStatus::Stopped {
                state.status = RuntimeStatus::Error;
                state.last_error = Some("Codex App Server connection closed".to_string());
            }
        }
        self.fail_pending("Codex App Server connection closed");
        let _ = app.emit("runtime-status", self.snapshot());
    }
}

fn spawn_stdout_reader(app: AppHandle, stdout: impl std::io::Read + Send + 'static) {
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if line.trim().is_empty() { continue; }
            match serde_json::from_str::<Value>(&line) {
                Ok(message) => {
                    let manager = app.state::<RuntimeManager>();
                    if manager.accept_incoming(&message) { continue; }
                    let event = if message.get("id").is_some() && message.get("method").is_some() {
                        "app-server-request"
                    } else {
                        "app-server-notification"
                    };
                    let _ = app.emit(event, message);
                }
                Err(error) => {
                    let _ = app.emit("runtime-log", json!({ "stream": "stdout", "message": format!("Invalid protocol line: {error}") }));
                }
            }
        }
        app.state::<RuntimeManager>().reader_closed(&app);
    });
}

fn spawn_stderr_reader(app: AppHandle, stderr: impl std::io::Read + Send + 'static) {
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let _ = app.emit("runtime-log", json!({ "stream": "stderr", "message": line }));
        }
    });
}

fn apply_provider_config(command: &mut Command, provider: &config::ProviderConfig) -> Result<(), RuntimeError> {
    let api_key = config::read_api_key().map_err(RuntimeError::Protocol)?;
    if let Some(secret) = api_key.as_ref() {
        command.env("KUNLUN_GROWTH_API_KEY", secret);
    }

    if !provider.model.trim().is_empty() {
        command.arg("-c").arg(format!("model={}", toml_string(&provider.model)));
    }

    let custom = provider.protocol != "openai" || provider.base_url != "https://api.openai.com/v1";
    if custom {
        command.arg("-c").arg("model_provider=\"enterprise\"");
        command.arg("-c").arg("model_providers.enterprise.name=\"Enterprise Provider\"");
        command.arg("-c").arg(format!("model_providers.enterprise.base_url={}", toml_string(&provider.base_url)));
        command.arg("-c").arg("model_providers.enterprise.wire_api=\"responses\"");
        if provider.protocol == "azure-openai" {
            command.arg("-c").arg("model_providers.enterprise.env_http_headers={\"api-key\"=\"KUNLUN_GROWTH_API_KEY\"}");
        } else {
            command.arg("-c").arg("model_providers.enterprise.env_key=\"KUNLUN_GROWTH_API_KEY\"");
        }
    } else if let Some(secret) = api_key {
        command.env("OPENAI_API_KEY", secret);
    }
    Ok(())
}

fn toml_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

fn detect_version(binary: &Path) -> Option<String> {
    Command::new(binary)
        .arg("--version")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn resolve_binary(app: &AppHandle) -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("KUNLUN_GROWTH_CODEX_BINARY").map(PathBuf::from) {
        if path.is_file() { return Some(path); }
    }

    let executable = if cfg!(windows) { "codex.exe" } else { "codex" };
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join("runtime").join("bin").join(executable);
        if bundled.is_file() { return Some(bundled); }
    }

    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let (package, triple) = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => ("codex-win32-x64", "x86_64-pc-windows-msvc"),
        ("windows", "aarch64") => ("codex-win32-arm64", "aarch64-pc-windows-msvc"),
        ("macos", "x86_64") => ("codex-darwin-x64", "x86_64-apple-darwin"),
        ("macos", "aarch64") => ("codex-darwin-arm64", "aarch64-apple-darwin"),
        _ => return None,
    };
    let development = manifest
        .join("..")
        .join("node_modules")
        .join("@openai")
        .join(package)
        .join("vendor")
        .join(triple)
        .join("bin")
        .join(executable);
    development.is_file().then_some(development)
}

impl Drop for RuntimeManager {
    fn drop(&mut self) {
        if let Ok(state) = self.state.get_mut() {
            if let Some(mut child) = state.child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}
