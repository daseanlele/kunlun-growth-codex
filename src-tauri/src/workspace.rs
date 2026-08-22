use serde::Serialize;
use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
};
use tauri::{AppHandle, Emitter};

const MAX_FILES: usize = 5_000;
const MAX_FILE_BYTES: u64 = 1_048_576;
const MAX_DIFF_BYTES: usize = 2_097_152;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutput {
    pub id: String,
    pub stream: String,
    pub chunk: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExit {
    pub id: String,
    pub code: Option<i32>,
}

#[derive(Clone, Default)]
pub struct TerminalManager {
    processes: Arc<Mutex<HashMap<String, u32>>>,
    next_id: Arc<AtomicU64>,
}

impl TerminalManager {
    pub fn run(&self, app: AppHandle, cwd: String, command: String) -> Result<String, String> {
        let root = canonical_root(&cwd)?;
        let command = command.trim().to_string();
        if command.is_empty() || command.len() > 8_192 {
            return Err("Command must contain between 1 and 8192 characters".to_string());
        }
        let id = format!(
            "terminal-{}",
            self.next_id.fetch_add(1, Ordering::Relaxed) + 1
        );
        let mut child = shell_command(&command)
            .current_dir(root)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("Unable to start terminal command: {error}"))?;
        let pid = child.id();
        self.processes
            .lock()
            .map_err(|_| "Terminal state is unavailable".to_string())?
            .insert(id.clone(), pid);

        if let Some(stdout) = child.stdout.take() {
            stream_reader(app.clone(), id.clone(), "stdout", stdout);
        }
        if let Some(stderr) = child.stderr.take() {
            stream_reader(app.clone(), id.clone(), "stderr", stderr);
        }
        let processes = self.processes.clone();
        let exit_id = id.clone();
        thread::spawn(move || {
            let status = child.wait().ok();
            if let Ok(mut map) = processes.lock() {
                map.remove(&exit_id);
            }
            let _ = app.emit(
                "terminal-exit",
                TerminalExit {
                    id: exit_id,
                    code: status.and_then(|value| value.code()),
                },
            );
        });
        Ok(id)
    }

    pub fn stop(&self, id: &str) -> Result<(), String> {
        let pid = self
            .processes
            .lock()
            .map_err(|_| "Terminal state is unavailable".to_string())?
            .get(id)
            .copied()
            .ok_or_else(|| "Terminal command is not running".to_string())?;
        stop_process(pid)
    }
}

pub fn list_workspace(cwd: &str) -> Result<Vec<WorkspaceEntry>, String> {
    let root = canonical_root(cwd)?;
    let mut entries = Vec::new();
    walk(&root, &root, 0, &mut entries)?;
    entries.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
    Ok(entries)
}

pub fn read_workspace_file(cwd: &str, relative_path: &str) -> Result<String, String> {
    let root = canonical_root(cwd)?;
    let path = resolve_inside(&root, relative_path)?;
    let metadata =
        fs::metadata(&path).map_err(|error| format!("Unable to read file metadata: {error}"))?;
    if !metadata.is_file() {
        return Err("Selected path is not a file".to_string());
    }
    if metadata.len() > MAX_FILE_BYTES {
        return Err("File exceeds the 1 MB preview limit".to_string());
    }
    let bytes = fs::read(path).map_err(|error| format!("Unable to read file: {error}"))?;
    if bytes.iter().take(8_192).any(|byte| *byte == 0) {
        return Err("Binary files cannot be previewed".to_string());
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

pub fn git_diff(cwd: &str) -> Result<String, String> {
    let root = canonical_root(cwd)?;
    let output = hidden_command("git")
        .args(["diff", "--no-ext-diff", "--no-color", "--unified=3", "--"])
        .current_dir(root)
        .output()
        .map_err(|error| format!("Unable to run git diff: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let mut bytes = output.stdout;
    if bytes.len() > MAX_DIFF_BYTES {
        bytes.truncate(MAX_DIFF_BYTES);
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn canonical_root(cwd: &str) -> Result<PathBuf, String> {
    if cwd.trim().is_empty() {
        return Err("A workspace must be selected".to_string());
    }
    let root =
        fs::canonicalize(cwd).map_err(|error| format!("Unable to open workspace: {error}"))?;
    if !root.is_dir() {
        return Err("Workspace path is not a directory".to_string());
    }
    Ok(root)
}

fn resolve_inside(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let candidate = root.join(relative_path);
    let resolved = fs::canonicalize(candidate)
        .map_err(|error| format!("Unable to resolve workspace path: {error}"))?;
    if !resolved.starts_with(root) {
        return Err("Path escapes the selected workspace".to_string());
    }
    Ok(resolved)
}

fn walk(
    root: &Path,
    directory: &Path,
    depth: usize,
    entries: &mut Vec<WorkspaceEntry>,
) -> Result<(), String> {
    if depth > 12 || entries.len() >= MAX_FILES {
        return Ok(());
    }
    let rows =
        fs::read_dir(directory).map_err(|error| format!("Unable to read workspace: {error}"))?;
    for row in rows.flatten() {
        if entries.len() >= MAX_FILES {
            break;
        }
        let path = row.path();
        let name = row.file_name().to_string_lossy().into_owned();
        if should_skip(&name) {
            continue;
        }
        let metadata = match row.metadata() {
            Ok(value) => value,
            Err(_) => continue,
        };
        let relative = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        entries.push(WorkspaceEntry {
            path: relative,
            name,
            is_dir: metadata.is_dir(),
            size: metadata.len(),
        });
        if metadata.is_dir() {
            walk(root, &path, depth + 1, entries)?;
        }
    }
    Ok(())
}

fn should_skip(name: &str) -> bool {
    matches!(
        name,
        ".git" | "node_modules" | "target" | "dist" | "build" | ".next" | ".idea" | ".vscode"
    )
}

fn stream_reader<R: Read + Send + 'static>(
    app: AppHandle,
    id: String,
    stream: &'static str,
    reader: R,
) {
    thread::spawn(move || {
        for line in BufReader::new(reader).lines().map_while(Result::ok) {
            let _ = app.emit(
                "terminal-output",
                TerminalOutput {
                    id: id.clone(),
                    stream: stream.to_string(),
                    chunk: format!("{line}\n"),
                },
            );
        }
    });
}

#[cfg(windows)]
fn hidden_command(program: &str) -> Command {
    use std::os::windows::process::CommandExt;
    let mut command = Command::new(program);
    command.creation_flags(0x08000000);
    command
}

#[cfg(not(windows))]
fn hidden_command(program: &str) -> Command {
    Command::new(program)
}

#[cfg(windows)]
fn shell_command(script: &str) -> Command {
    let mut command = hidden_command("powershell.exe");
    command.args([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        script,
    ]);
    command
}

#[cfg(not(windows))]
fn shell_command(script: &str) -> Command {
    let mut command = Command::new("sh");
    command.args(["-lc", script]);
    command
}

#[cfg(windows)]
fn stop_process(pid: u32) -> Result<(), String> {
    let output = hidden_command("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .output()
        .map_err(|error| error.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[cfg(not(windows))]
fn stop_process(pid: u32) -> Result<(), String> {
    let status = Command::new("kill")
        .arg(pid.to_string())
        .status()
        .map_err(|error| error.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("Unable to stop terminal command".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn skips_large_generated_directories() {
        assert!(should_skip("node_modules"));
        assert!(should_skip(".git"));
        assert!(!should_skip("src"));
    }

    #[test]
    fn lists_files_but_skips_generated_content() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("kunlun-workspace-{suffix}"));
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        fs::write(root.join("src/main.rs"), "fn main() {}").unwrap();
        fs::write(root.join("node_modules/pkg/index.js"), "ignored").unwrap();
        let rows = list_workspace(root.to_str().unwrap()).unwrap();
        assert!(rows.iter().any(|row| row.path == "src/main.rs"));
        assert!(!rows.iter().any(|row| row.path.contains("node_modules")));
        fs::remove_dir_all(root).unwrap();
    }
}
