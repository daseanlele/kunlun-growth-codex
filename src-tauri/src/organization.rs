use serde::{Deserialize, Serialize};
use std::fs;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizationPreset {
    pub schema_version: u8,
    pub id: String,
    pub display_name: String,
    pub approved_connectors: Vec<String>,
    #[serde(default)]
    pub allowed_domains: Vec<String>,
    #[serde(default)]
    pub locked_features: Vec<String>,
}

impl Default for OrganizationPreset {
    fn default() -> Self {
        Self {
            schema_version: 1,
            id: "local".to_string(),
            display_name: "本地开发组织".to_string(),
            approved_connectors: vec![
                "kunlun.obsidian.local".to_string(),
                "kunlun.feishu.open".to_string(),
            ],
            allowed_domains: vec!["open.feishu.cn".to_string()],
            locked_features: vec![],
        }
    }
}

pub fn load(app: &AppHandle) -> Result<OrganizationPreset, String> {
    let path = preset_path(app)?;
    if !path.exists() {
        return Ok(OrganizationPreset::default());
    }
    let raw = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let preset: OrganizationPreset =
        serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    validate(&preset)?;
    Ok(preset)
}

pub fn save(app: &AppHandle, preset: OrganizationPreset) -> Result<OrganizationPreset, String> {
    validate(&preset)?;
    let serialized = serde_json::to_string_pretty(&preset).map_err(|error| error.to_string())?;
    fs::write(preset_path(app)?, serialized).map_err(|error| error.to_string())?;
    Ok(preset)
}

pub fn require_connector(app: &AppHandle, connector_id: &str) -> Result<(), String> {
    let preset = load(app)?;
    if preset
        .approved_connectors
        .iter()
        .any(|item| item == connector_id)
    {
        Ok(())
    } else {
        Err(format!("组织策略未批准连接器 {connector_id}"))
    }
}

pub fn require_domain(app: &AppHandle, domain: &str) -> Result<(), String> {
    let preset = load(app)?;
    if preset
        .allowed_domains
        .iter()
        .any(|item| item.eq_ignore_ascii_case(domain))
    {
        Ok(())
    } else {
        Err(format!("组织策略未批准访问域名 {domain}"))
    }
}

fn preset_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join("organization-preset.json"))
}

fn validate(preset: &OrganizationPreset) -> Result<(), String> {
    if preset.schema_version != 1 {
        return Err("不支持的组织预置版本".to_string());
    }
    if !valid_id(&preset.id) || preset.display_name.trim().is_empty() {
        return Err("组织预置 ID 或名称无效".to_string());
    }
    if preset
        .approved_connectors
        .iter()
        .any(|item| !valid_id(item))
    {
        return Err("组织预置包含无效连接器 ID".to_string());
    }
    if preset.approved_connectors.len()
        != preset
            .approved_connectors
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len()
    {
        return Err("组织预置连接器重复".to_string());
    }
    if preset
        .allowed_domains
        .iter()
        .any(|item| !valid_domain(item))
    {
        return Err("组织预置包含无效域名".to_string());
    }
    Ok(())
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn valid_domain(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 253
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.'))
        && !value.starts_with('.')
        && !value.ends_with('.')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_preset_approves_first_party_connectors() {
        let preset = OrganizationPreset::default();
        assert!(preset
            .approved_connectors
            .contains(&"kunlun.obsidian.local".to_string()));
        assert!(preset
            .approved_connectors
            .contains(&"kunlun.feishu.open".to_string()));
    }

    #[test]
    fn rejects_unsafe_or_duplicate_policy_entries() {
        let mut preset = OrganizationPreset::default();
        preset.allowed_domains = vec!["open.feishu.cn/evil".to_string()];
        assert!(validate(&preset).is_err());
        preset.allowed_domains = vec![];
        preset
            .approved_connectors
            .push("kunlun.obsidian.local".to_string());
        assert!(validate(&preset).is_err());
    }
}
