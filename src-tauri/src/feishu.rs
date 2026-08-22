use crate::{config, organization};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

const FEISHU_TOKEN_ENDPOINT: &str =
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal";

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeishuConnectorConfig {
    pub id: String,
    pub app_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeishuConnection {
    pub connector_id: String,
    pub expires_in_seconds: u64,
    pub auth_mode: String,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    code: i64,
    msg: String,
    tenant_access_token: Option<String>,
    expire: Option<u64>,
}

pub fn save_app_secret(config: &FeishuConnectorConfig, secret: &str) -> Result<(), String> {
    validate_config(config)?;
    config::save_connector_secret(&secret_reference(&config.id), secret)
}

pub fn verify_connection(
    app: &AppHandle,
    connector: &FeishuConnectorConfig,
) -> Result<FeishuConnection, String> {
    validate_config(connector)?;
    organization::require_connector(app, "kunlun.feishu.open")?;
    organization::require_domain(app, "open.feishu.cn")?;
    let secret = config::read_connector_secret(&secret_reference(&connector.id))?
        .ok_or_else(|| "飞书应用凭据尚未写入系统凭据库".to_string())?;
    let response = Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|_| "无法初始化飞书安全连接".to_string())?
        .post(FEISHU_TOKEN_ENDPOINT)
        .json(&serde_json::json!({ "app_id": connector.app_id, "app_secret": secret }))
        .send()
        .map_err(|_| "飞书认证请求失败，请检查网络、应用状态和租户授权".to_string())?;
    let status = response.status();
    let parsed: TokenResponse = response
        .json()
        .map_err(|_| "飞书认证响应格式无效".to_string())?;
    tenant_connection_from_response(connector, status.is_success(), parsed)
}

fn tenant_connection_from_response(
    connector: &FeishuConnectorConfig,
    http_success: bool,
    response: TokenResponse,
) -> Result<FeishuConnection, String> {
    if !http_success
        || response.code != 0
        || response
            .tenant_access_token
            .as_deref()
            .unwrap_or_default()
            .is_empty()
    {
        return Err(format!(
            "飞书认证失败（code={}，{}）",
            response.code,
            sanitize_message(&response.msg)
        ));
    }
    Ok(FeishuConnection {
        connector_id: connector.id.clone(),
        expires_in_seconds: response.expire.unwrap_or(0),
        auth_mode: "tenant_access_token".to_string(),
    })
}

fn validate_config(config: &FeishuConnectorConfig) -> Result<(), String> {
    if config.id.trim().is_empty()
        || config.id.len() > 80
        || !config
            .id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err("飞书连接器 id 格式无效".to_string());
    }
    if !config.app_id.starts_with("cli_")
        || config.app_id.len() > 128
        || !config
            .app_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    {
        return Err("飞书 App ID 格式无效".to_string());
    }
    Ok(())
}

fn secret_reference(id: &str) -> String {
    format!("connector:feishu:{id}:app-secret")
}

fn sanitize_message(message: &str) -> String {
    message
        .chars()
        .filter(|character| !character.is_control())
        .take(240)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connector() -> FeishuConnectorConfig {
        FeishuConnectorConfig {
            id: "customer-feishu".to_string(),
            app_id: "cli_123abc".to_string(),
        }
    }

    #[test]
    fn validates_minimal_enterprise_app_configuration() {
        assert!(validate_config(&connector()).is_ok());
        assert!(validate_config(&FeishuConnectorConfig {
            app_id: "not-an-app".to_string(),
            ..connector()
        })
        .is_err());
    }

    #[test]
    fn never_returns_the_tenant_token_to_the_caller() {
        let response = TokenResponse {
            code: 0,
            msg: "ok".to_string(),
            tenant_access_token: Some("t-sensitive".to_string()),
            expire: Some(7140),
        };
        let connection = tenant_connection_from_response(&connector(), true, response).unwrap();
        assert_eq!(connection.expires_in_seconds, 7140);
        assert!(!serde_json::to_string(&connection)
            .unwrap()
            .contains("t-sensitive"));
    }

    #[test]
    fn fails_closed_when_feishu_rejects_the_application() {
        let error = tenant_connection_from_response(
            &connector(),
            true,
            TokenResponse {
                code: 999,
                msg: "denied".to_string(),
                tenant_access_token: None,
                expire: None,
            },
        )
        .unwrap_err();
        assert!(error.contains("999"));
    }
}
