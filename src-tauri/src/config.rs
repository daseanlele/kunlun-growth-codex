use serde::{Deserialize, Serialize};
use std::fs;
use tauri::{AppHandle, Manager};

const KEYRING_SERVICE: &str = "cn.kunlungrowth.codex";
const KEYRING_USER: &str = "default-provider";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub protocol: String,
    pub base_url: String,
    pub model: String,
    pub auth_method: String,
    pub credential_ref: Option<String>,
}

impl Default for ProviderConfig {
    fn default() -> Self {
        Self {
            protocol: "openai".to_string(),
            base_url: "https://api.openai.com/v1".to_string(),
            model: String::new(),
            auth_method: "api-key".to_string(),
            credential_ref: None,
        }
    }
}

fn config_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join("provider.json"))
}

pub fn load(app: &AppHandle) -> Result<ProviderConfig, String> {
    let path = config_path(app)?;
    if !path.exists() {
        return Ok(ProviderConfig::default());
    }
    let raw = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&raw).map_err(|error| error.to_string())
}

pub fn save(
    app: &AppHandle,
    mut config: ProviderConfig,
    api_key: Option<String>,
) -> Result<ProviderConfig, String> {
    if !config.base_url.starts_with("https://") {
        return Err("Production provider URLs must use HTTPS".to_string());
    }
    if let Some(secret) = api_key.filter(|value| !value.trim().is_empty()) {
        let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
            .map_err(|error| error.to_string())?;
        entry
            .set_password(secret.trim())
            .map_err(|error| error.to_string())?;
        config.credential_ref = Some(format!("keyring://{KEYRING_SERVICE}/{KEYRING_USER}"));
    }
    let serialized = serde_json::to_string_pretty(&config).map_err(|error| error.to_string())?;
    fs::write(config_path(app)?, serialized).map_err(|error| error.to_string())?;
    Ok(config)
}

pub fn read_api_key() -> Result<Option<String>, String> {
    let entry =
        keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|error| error.to_string())?;
    match entry.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

pub fn delete_api_key() -> Result<(), String> {
    let entry =
        keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|error| error.to_string())?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}
