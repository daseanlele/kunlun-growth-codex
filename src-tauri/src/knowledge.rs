use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

const MAX_DOCUMENTS: usize = 5_000;
const MAX_DOCUMENT_BYTES: u64 = 1_048_576;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeDocument {
    pub id: String,
    pub source: String,
    pub path: String,
    pub title: String,
    pub updated_at_ms: u128,
    pub bytes: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeScan {
    pub source: String,
    pub root: String,
    pub documents: Vec<KnowledgeDocument>,
    pub skipped: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeHit {
    pub document: KnowledgeDocument,
    pub excerpt: String,
    pub line: usize,
}

pub fn scan_obsidian_vault(vault: &str) -> Result<KnowledgeScan, String> {
    let root = canonical_vault(vault)?;
    let mut documents = Vec::new();
    let mut skipped = 0;
    walk_vault(&root, &root, &mut documents, &mut skipped)?;
    documents.sort_by(|left, right| left.path.to_lowercase().cmp(&right.path.to_lowercase()));
    Ok(KnowledgeScan {
        source: "obsidian-local".to_string(),
        root: root.to_string_lossy().into_owned(),
        documents,
        skipped,
    })
}

pub fn search_obsidian_vault(vault: &str, query: &str) -> Result<Vec<KnowledgeHit>, String> {
    let query = query.trim();
    if query.is_empty() || query.chars().count() > 256 {
        return Err("知识库检索词必须包含 1 到 256 个字符".to_string());
    }
    let scan = scan_obsidian_vault(vault)?;
    let needle = query.to_lowercase();
    let root = PathBuf::from(&scan.root);
    let mut hits = Vec::new();
    for document in scan.documents {
        let path = root.join(&document.path);
        let content =
            fs::read_to_string(&path).map_err(|error| format!("无法读取知识文档：{error}"))?;
        for (index, line) in content.lines().enumerate() {
            if line.to_lowercase().contains(&needle) {
                hits.push(KnowledgeHit {
                    document: document.clone(),
                    excerpt: truncate(line, 500),
                    line: index + 1,
                });
                if hits.len() == 200 {
                    return Ok(hits);
                }
            }
        }
    }
    Ok(hits)
}

fn canonical_vault(vault: &str) -> Result<PathBuf, String> {
    if vault.trim().is_empty() {
        return Err("必须选择 Obsidian 知识库目录".to_string());
    }
    let root =
        fs::canonicalize(vault).map_err(|error| format!("无法打开 Obsidian 知识库：{error}"))?;
    if !root.is_dir() {
        return Err("Obsidian 知识库路径不是目录".to_string());
    }
    Ok(root)
}

fn walk_vault(
    root: &Path,
    directory: &Path,
    documents: &mut Vec<KnowledgeDocument>,
    skipped: &mut usize,
) -> Result<(), String> {
    if documents.len() >= MAX_DOCUMENTS {
        return Ok(());
    }
    let rows = fs::read_dir(directory).map_err(|error| format!("无法读取知识库目录：{error}"))?;
    for row in rows.flatten() {
        if documents.len() >= MAX_DOCUMENTS {
            break;
        }
        let file_type = match row.file_type() {
            Ok(value) => value,
            Err(_) => {
                *skipped += 1;
                continue;
            }
        };
        if file_type.is_symlink() {
            *skipped += 1;
            continue;
        }
        let path = row.path();
        let name = row.file_name().to_string_lossy().into_owned();
        if file_type.is_dir() {
            if matches!(
                name.as_str(),
                ".obsidian" | ".git" | "node_modules" | "attachments"
            ) {
                *skipped += 1;
                continue;
            }
            walk_vault(root, &path, documents, skipped)?;
            continue;
        }
        if !file_type.is_file()
            || !matches!(
                path.extension().and_then(|value| value.to_str()),
                Some("md" | "markdown" | "mdx")
            )
        {
            *skipped += 1;
            continue;
        }
        let metadata = match fs::metadata(&path) {
            Ok(value) if value.len() <= MAX_DOCUMENT_BYTES => value,
            _ => {
                *skipped += 1;
                continue;
            }
        };
        let relative = path
            .strip_prefix(root)
            .map_err(|_| "知识库路径越界".to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        let title = fs::read_to_string(&path)
            .ok()
            .and_then(|content| {
                content.lines().find_map(|line| {
                    line.strip_prefix("# ")
                        .map(str::trim)
                        .filter(|title| !title.is_empty())
                        .map(str::to_string)
                })
            })
            .unwrap_or_else(|| {
                path.file_stem()
                    .and_then(|value| value.to_str())
                    .unwrap_or("未命名笔记")
                    .to_string()
            });
        let updated_at_ms = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_millis())
            .unwrap_or(0);
        documents.push(KnowledgeDocument {
            id: format!("obsidian:{relative}"),
            source: "obsidian-local".to_string(),
            path: relative,
            title,
            updated_at_ms,
            bytes: metadata.len(),
        });
    }
    Ok(())
}

fn truncate(value: &str, limit: usize) -> String {
    if value.chars().count() <= limit {
        value.to_string()
    } else {
        format!("{}…", value.chars().take(limit).collect::<String>())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn vault() -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("kunlun-obsidian-{suffix}"))
    }

    #[test]
    fn indexes_markdown_but_not_obsidian_configuration() {
        let root = vault();
        fs::create_dir_all(root.join(".obsidian")).unwrap();
        fs::write(root.join("strategy.md"), "# 增长策略\n企业 AI 落地").unwrap();
        fs::write(root.join(".obsidian/settings.md"), "ignored").unwrap();
        fs::write(root.join("image.png"), "ignored").unwrap();
        let scan = scan_obsidian_vault(root.to_str().unwrap()).unwrap();
        assert_eq!(scan.documents.len(), 1);
        assert_eq!(scan.documents[0].title, "增长策略");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn searches_only_selected_vault_documents() {
        let root = vault();
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("notes.md"), "# 客户\n飞书和 Obsidian 汇聚知识").unwrap();
        let hits = search_obsidian_vault(root.to_str().unwrap(), "飞书").unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].document.path, "notes.md");
        fs::remove_dir_all(root).unwrap();
    }
}
