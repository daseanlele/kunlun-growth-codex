use serde::{Deserialize, Serialize};
use std::fs;
use tauri::{AppHandle, Manager};

const KEYRING_SERVICE: &str = "cn.kunlungrowth.codex";
const KEYRING_USER: &str = "default-provider";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    #[serde(default = "default_profile_id")]
    pub id: String,
    #[serde(default = "default_provider_id")]
    pub provider_id: String,
    #[serde(default = "default_display_name")]
    pub display_name: String,
    pub protocol: String,
    #[serde(default = "default_adapter")]
    pub adapter: String,
    pub base_url: String,
    pub model: String,
    pub auth_method: String,
    #[serde(default)]
    pub auth_header: Option<String>,
    pub credential_ref: Option<String>,
}

impl Default for ProviderConfig {
    fn default() -> Self {
        Self {
            id: default_profile_id(),
            provider_id: default_provider_id(),
            display_name: default_display_name(),
            protocol: "openai".to_string(),
            adapter: default_adapter(),
            base_url: "https://api.openai.com/v1".to_string(),
            model: String::new(),
            auth_method: "api-key".to_string(),
            auth_header: None,
            credential_ref: None,
        }
    }
}

fn default_profile_id() -> String {
    "default".to_string()
}
fn default_provider_id() -> String {
    "openai".to_string()
}
fn default_display_name() -> String {
    "OpenAI".to_string()
}
fn default_adapter() -> String {
    "codex-responses".to_string()
}

fn config_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join("provider.json"))
}

fn profiles_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join("provider-profiles.json"))
}

pub fn load(app: &AppHandle) -> Result<ProviderConfig, String> {
    let path = config_path(app)?;
    if !path.exists() {
        return Ok(ProviderConfig::default());
    }
    let raw = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&raw).map_err(|error| error.to_string())
}

pub fn load_profiles(app: &AppHandle) -> Result<Vec<ProviderConfig>, String> {
    let path = profiles_path(app)?;
    if !path.exists() {
        return Ok(vec![load(app)?]);
    }
    let raw = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let mut profiles: Vec<ProviderConfig> =
        serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    if profiles.is_empty() {
        profiles.push(load(app)?);
    }
    Ok(profiles)
}

fn write_profiles(app: &AppHandle, profiles: &[ProviderConfig]) -> Result<(), String> {
    let serialized = serde_json::to_string_pretty(profiles).map_err(|error| error.to_string())?;
    fs::write(profiles_path(app)?, serialized).map_err(|error| error.to_string())
}

pub fn save(
    app: &AppHandle,
    mut config: ProviderConfig,
    api_key: Option<String>,
) -> Result<ProviderConfig, String> {
    if !config.base_url.starts_with("https://") {
        return Err("Production provider URLs must use HTTPS".to_string());
    }
    if !matches!(
        config.adapter.as_str(),
        "codex-responses" | "openai-chat" | "anthropic-messages"
    ) {
        return Err("Unsupported provider adapter".to_string());
    }
    if let Some(header) = config.auth_header.as_ref() {
        if header.trim().is_empty()
            || header.len() > 128
            || !header
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            return Err(
                "Authentication header must contain only letters, numbers, and hyphens".to_string(),
            );
        }
    }
    if config.id.trim().is_empty() {
        config.id = "default".to_string();
    }
    if let Some(secret) = api_key.filter(|value| !value.trim().is_empty()) {
        let keyring_user = format!("provider:{}", config.id);
        let entry = keyring::Entry::new(KEYRING_SERVICE, &keyring_user)
            .map_err(|error| error.to_string())?;
        entry
            .set_password(secret.trim())
            .map_err(|error| error.to_string())?;
        config.credential_ref = Some(format!("keyring://{KEYRING_SERVICE}/{keyring_user}"));
    }
    let mut profiles = load_profiles(app)?;
    if let Some(index) = profiles.iter().position(|item| item.id == config.id) {
        profiles[index] = config.clone();
    } else {
        profiles.push(config.clone());
    }
    write_profiles(app, &profiles)?;
    let serialized = serde_json::to_string_pretty(&config).map_err(|error| error.to_string())?;
    fs::write(config_path(app)?, serialized).map_err(|error| error.to_string())?;
    Ok(config)
}

pub fn activate_profile(app: &AppHandle, profile_id: &str) -> Result<ProviderConfig, String> {
    let profile = load_profiles(app)?
        .into_iter()
        .find(|item| item.id == profile_id)
        .ok_or_else(|| "Provider profile was not found".to_string())?;
    let serialized = serde_json::to_string_pretty(&profile).map_err(|error| error.to_string())?;
    fs::write(config_path(app)?, serialized).map_err(|error| error.to_string())?;
    Ok(profile)
}

pub fn read_api_key(provider: &ProviderConfig) -> Result<Option<String>, String> {
    let keyring_user = format!("provider:{}", provider.id);
    let entry =
        keyring::Entry::new(KEYRING_SERVICE, &keyring_user).map_err(|error| error.to_string())?;
    match entry.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) if provider.id == "default" => {
            let legacy = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
                .map_err(|error| error.to_string())?;
            match legacy.get_password() {
                Ok(secret) => Ok(Some(secret)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(error) => Err(error.to_string()),
            }
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

pub fn delete_api_key(profile_id: &str) -> Result<(), String> {
    let is_default = profile_id.trim().is_empty() || profile_id == "default";
    let user = if is_default {
        format!("provider:{}", default_profile_id())
    } else {
        format!("provider:{profile_id}")
    };
    let entry = keyring::Entry::new(KEYRING_SERVICE, &user).map_err(|error| error.to_string())?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(error) => return Err(error.to_string()),
    }

    // Older releases stored the default key under a shared username. Delete it too,
    // otherwise a deleted default profile could silently fall back to that credential.
    if is_default {
        let legacy = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
            .map_err(|error| error.to_string())?;
        match legacy.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(())
}
