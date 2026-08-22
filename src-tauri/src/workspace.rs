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
const MAX_SEARCH_BYTES: usize = 262_144;
const MAX_COMMAND_BYTES: usize = 262_144;

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

/// Creates or replaces a non-binary UTF-8 file inside the selected workspace.
/// Callers are responsible for obtaining an explicit user approval before invoking this.
pub fn write_workspace_file(cwd: &str, relative_path: &str, content: &str) -> Result<(), String> {
    if content.len() > MAX_FILE_BYTES as usize {
        return Err("File content exceeds the 1 MB write limit".to_string());
    }
    let root = canonical_root(cwd)?;
    let path = resolve_write_path(&root, relative_path)?;
    if path.exists() {
        let metadata = fs::metadata(&path)
            .map_err(|error| format!("Unable to read file metadata: {error}"))?;
        if !metadata.is_file() {
            return Err("Selected path is not a file".to_string());
        }
        let existing = fs::read(&path).map_err(|error| format!("Unable to read file: {error}"))?;
        if existing.iter().take(8_192).any(|byte| *byte == 0) {
            return Err("Binary files cannot be overwritten".to_string());
        }
    }
    let temporary = path.with_extension(format!(
        "{}.kunlun-tmp",
        path.extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or("write")
    ));
    fs::write(&temporary, content)
        .map_err(|error| format!("Unable to stage file write: {error}"))?;
    fs::rename(&temporary, &path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        format!("Unable to replace file: {error}")
    })
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

pub fn search_workspace(
    cwd: &str,
    query: &str,
    relative_path: Option<&str>,
) -> Result<String, String> {
    let root = canonical_root(cwd)?;
    let query = query.trim();
    if query.is_empty() || query.chars().count() > 256 {
        return Err("Search query must contain between 1 and 256 characters".to_string());
    }
    let prefix = relative_path
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(|path| {
            let resolved = resolve_inside(&root, path)?;
            let relative = resolved
                .strip_prefix(&root)
                .map_err(|_| "Path escapes the selected workspace".to_string())?;
            Ok::<_, String>(relative.to_string_lossy().replace('\\', "/"))
        })
        .transpose()?;
    let mut output = String::new();
    for entry in list_workspace(cwd)? {
        if entry.is_dir
            || prefix
                .as_ref()
                .is_some_and(|prefix| !entry.path.starts_with(prefix))
        {
            continue;
        }
        let Ok(content) = read_workspace_file(cwd, &entry.path) else {
            continue;
        };
        for (index, line) in content.lines().enumerate() {
            if line.contains(query) {
                output.push_str(&format!("{}:{}:{}\n", entry.path, index + 1, line));
                if output.len() >= MAX_SEARCH_BYTES {
                    return Ok(output);
                }
            }
        }
    }
    Ok(output)
}

pub fn run_workspace_check(cwd: &str, task: &str) -> Result<String, String> {
    let root = canonical_root(cwd)?;
    let (program, args): (&str, &[&str]) = match task {
        "git_status" => ("git", &["status", "--short"]),
        "git_diff_check" => ("git", &["diff", "--check"]),
        "npm_test" => ("npm", &["test", "--", "--run"]),
        "cargo_test" => ("cargo", &["test"]),
        _ => return Err("Unsupported workspace check".to_string()),
    };
    let program = if cfg!(windows) && program == "npm" {
        "npm.cmd"
    } else {
        program
    };
    let output = hidden_command(program)
        .args(args)
        .current_dir(root)
        .output()
        .map_err(|error| format!("Unable to run workspace check: {error}"))?;
    let mut bytes = [output.stdout, output.stderr].concat();
    if bytes.len() > MAX_COMMAND_BYTES {
        bytes.truncate(MAX_COMMAND_BYTES);
    }
    let text = String::from_utf8_lossy(&bytes).into_owned();
    if output.status.success() {
        Ok(text)
    } else {
        Err(if text.trim().is_empty() {
            format!("{task} exited with {:?}", output.status.code())
        } else {
            text
        })
    }
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

fn resolve_write_path(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    use std::path::Component;
    let relative = Path::new(relative_path);
    if relative_path.trim().is_empty() || relative.is_absolute() {
        return Err("Write path must be a non-empty relative path".to_string());
    }
    if relative
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("Write path must not contain parent-directory traversal".to_string());
    }
    let candidate = root.join(relative);
    let parent = candidate
        .parent()
        .ok_or_else(|| "Write path has no parent directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Unable to create parent directories: {error}"))?;
    let parent = fs::canonicalize(parent)
        .map_err(|error| format!("Unable to resolve parent directory: {error}"))?;
    if !parent.starts_with(root) {
        return Err("Path escapes the selected workspace".to_string());
    }
    let path = parent.join(
        candidate
            .file_name()
            .ok_or_else(|| "Write path has no file name".to_string())?,
    );
    if path.exists() {
        let resolved = fs::canonicalize(&path)
            .map_err(|error| format!("Unable to resolve workspace path: {error}"))?;
        if !resolved.starts_with(root) {
            return Err("Path escapes the selected workspace".to_string());
        }
        Ok(resolved)
    } else {
        Ok(path)
    }
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

    #[test]
    fn writes_text_files_inside_workspace_and_rejects_escaping_paths() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("kunlun-write-{suffix}"));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("note.txt"), "before").unwrap();
        write_workspace_file(root.to_str().unwrap(), "note.txt", "after").unwrap();
        assert_eq!(fs::read_to_string(root.join("note.txt")).unwrap(), "after");
        write_workspace_file(root.to_str().unwrap(), "new/note.txt", "new content").unwrap();
        assert_eq!(
            fs::read_to_string(root.join("new/note.txt")).unwrap(),
            "new content"
        );
        assert!(write_workspace_file(root.to_str().unwrap(), "../outside.txt", "no").is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn searches_text_within_workspace() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("kunlun-search-{suffix}"));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("note.txt"), "alpha\nbeta marker\n").unwrap();
        let output = search_workspace(root.to_str().unwrap(), "marker", None).unwrap();
        assert!(output.contains("note.txt") && output.contains("beta marker"));
        assert!(search_workspace(root.to_str().unwrap(), "", None).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
