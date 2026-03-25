use crate::secret_store;
use chrono::{DateTime, Utc};
use reqwest::header::{ACCEPT, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::PathBuf;
use tauri::Manager;

const LICENSE_STATE_FILE: &str = "license-state.json";
const LICENSE_PROXY_TIMEOUT_SECS: u64 = 20;

#[derive(Clone, Serialize, Deserialize, Default)]
pub struct LicenseProxyConfig {
    pub provider: Option<String>,
    pub base_url: String,
    pub chat_path: Option<String>,
    pub models_path: Option<String>,
    pub validate_path: Option<String>,
    pub default_model: Option<String>,
    pub dialect: Option<String>,
}

#[derive(Clone, Serialize, Deserialize, Default)]
pub struct LicenseState {
    pub status: String,
    pub proxy_url: String,
    pub license_id: Option<String>,
    pub plan_name: Option<String>,
    pub customer_label: Option<String>,
    pub expires_at: Option<String>,
    pub activated_at: Option<String>,
    pub last_validated_at: Option<String>,
    pub last_error: Option<String>,
    pub proxy: Option<LicenseProxyConfig>,
    pub raw_features: Option<Value>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct LicenseStatus {
    pub has_license_key: bool,
    pub is_activated: bool,
    pub status: String,
    pub proxy_url: Option<String>,
    pub license_id: Option<String>,
    pub plan_name: Option<String>,
    pub customer_label: Option<String>,
    pub expires_at: Option<String>,
    pub activated_at: Option<String>,
    pub last_validated_at: Option<String>,
    pub last_error: Option<String>,
    pub proxy: Option<LicenseProxyConfig>,
}

#[derive(Clone, Deserialize)]
pub struct ActivateLicenseRequest {
    pub license_key: String,
    pub proxy_url: String,
}

#[derive(Clone, Serialize)]
pub struct LicenseActivationResult {
    pub status: LicenseStatus,
}

#[derive(Serialize)]
struct ActivateLicensePayload {
    license_key: String,
    app_version: String,
    platform: String,
    arch: String,
    device_name: String,
}

#[derive(Deserialize)]
struct ProxyActivationEnvelope {
    status: Option<String>,
    license_id: Option<String>,
    plan_name: Option<String>,
    customer_label: Option<String>,
    expires_at: Option<String>,
    access_token: Option<String>,
    proxy: Option<ProxyProxyConfig>,
    llm: Option<ProxyLlmConfig>,
    features: Option<Value>,
    message: Option<String>,
}

#[derive(Clone, Deserialize)]
struct ProxyProxyConfig {
    provider: Option<String>,
    base_url: Option<String>,
    chat_path: Option<String>,
    models_path: Option<String>,
    validate_path: Option<String>,
    default_model: Option<String>,
    dialect: Option<String>,
}

#[derive(Clone, Deserialize)]
struct ProxyLlmConfig {
    provider: Option<String>,
    base_url: Option<String>,
    default_model: Option<String>,
    dialect: Option<String>,
}

pub async fn activate_license(
    app: &tauri::AppHandle,
    request: ActivateLicenseRequest,
) -> Result<LicenseActivationResult, String> {
    let license_key = request.license_key.trim().to_string();
    if license_key.is_empty() {
        return Err("License key is required.".to_string());
    }

    let proxy_url = normalize_proxy_url(&request.proxy_url)?;
    let payload = ActivateLicensePayload {
        license_key: license_key.clone(),
        app_version: app.package_info().version.to_string(),
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        device_name: resolve_device_name(),
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(LICENSE_PROXY_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("Failed to initialize proxy client: {}", e))?;

    let response = client
        .post(proxy_url.clone())
        .header(CONTENT_TYPE, "application/json")
        .header(ACCEPT, "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Failed to contact license proxy: {}", e))?;

    let status_code = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("Failed to read proxy response: {}", e))?;

    if !status_code.is_success() {
        let message = extract_message_from_text(&body)
            .unwrap_or_else(|| format!("Proxy returned HTTP {}", status_code.as_u16()));
        persist_error_state(app, &proxy_url, &message)?;
        return Err(message);
    }

    let parsed: ProxyActivationEnvelope = serde_json::from_str(&body)
        .map_err(|e| format!("License proxy returned invalid JSON: {}", e))?;

    let normalized_status = parsed
        .status
        .as_deref()
        .map(normalize_status)
        .unwrap_or("active")
        .to_string();

    if normalized_status != "active" {
        let message = parsed
            .message
            .clone()
            .unwrap_or_else(|| "License is not active.".to_string());
        persist_error_state(app, &proxy_url, &message)?;
        return Err(message);
    }

    let access_token = parsed.access_token.unwrap_or_default();
    if access_token.trim().is_empty() {
        let message = "License proxy did not return an access token.".to_string();
        persist_error_state(app, &proxy_url, &message)?;
        return Err(message);
    }

    let proxy = merge_proxy_config(parsed.proxy, parsed.llm)
        .ok_or_else(|| "License proxy did not return LLM proxy configuration.".to_string())?;

    let now = Utc::now().to_rfc3339();
    let state = LicenseState {
        status: normalized_status.to_string(),
        proxy_url: proxy_url.clone(),
        license_id: parsed.license_id,
        plan_name: parsed.plan_name,
        customer_label: parsed.customer_label,
        expires_at: parsed.expires_at,
        activated_at: Some(now.clone()),
        last_validated_at: Some(now),
        last_error: None,
        proxy: Some(proxy),
        raw_features: parsed.features,
    };

    secret_store::set_license_key(&license_key)?;
    secret_store::set_license_access_token(&access_token)?;
    write_state(app, &state)?;

    Ok(LicenseActivationResult {
        status: build_status(app, Some(state))?,
    })
}

pub fn get_license_status(app: &tauri::AppHandle) -> Result<LicenseStatus, String> {
    build_status(app, read_state(app)?)
}

pub fn clear_license(app: &tauri::AppHandle) -> Result<LicenseStatus, String> {
    secret_store::delete_license_key()?;
    secret_store::delete_license_access_token()?;
    delete_state(app)?;
    build_status(app, None)
}

pub fn get_license_access_token() -> Result<Option<String>, String> {
    secret_store::get_license_access_token()
}

pub fn get_license_proxy_config(
    app: &tauri::AppHandle,
) -> Result<Option<LicenseProxyConfig>, String> {
    Ok(read_state(app)?.and_then(|state| state.proxy))
}

fn build_status(
    app: &tauri::AppHandle,
    existing_state: Option<LicenseState>,
) -> Result<LicenseStatus, String> {
    let has_license_key = secret_store::get_license_key()?.is_some();
    let state = match existing_state {
        Some(state) => Some(state),
        None => read_state(app)?,
    };

    let (
        status,
        proxy_url,
        license_id,
        plan_name,
        customer_label,
        expires_at,
        activated_at,
        last_validated_at,
        last_error,
        proxy,
    ) = if let Some(state) = state {
        (
            state.status,
            if state.proxy_url.trim().is_empty() {
                None
            } else {
                Some(state.proxy_url)
            },
            state.license_id,
            state.plan_name,
            state.customer_label,
            state.expires_at,
            state.activated_at,
            state.last_validated_at,
            state.last_error,
            state.proxy,
        )
    } else {
        (
            "inactive".to_string(),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
    };

    Ok(LicenseStatus {
        has_license_key,
        is_activated: status == "active" && proxy.is_some(),
        status,
        proxy_url,
        license_id,
        plan_name,
        customer_label,
        expires_at,
        activated_at,
        last_validated_at,
        last_error,
        proxy,
    })
}

fn merge_proxy_config(
    proxy: Option<ProxyProxyConfig>,
    llm: Option<ProxyLlmConfig>,
) -> Option<LicenseProxyConfig> {
    let mut base_url = String::new();
    let mut provider = None;
    let mut default_model = None;
    let mut dialect = None;
    let mut chat_path = None;
    let mut models_path = None;
    let mut validate_path = None;

    if let Some(proxy) = proxy {
        if let Some(value) = proxy.base_url {
            base_url = value;
        }
        provider = proxy.provider;
        default_model = proxy.default_model;
        dialect = proxy.dialect;
        chat_path = proxy.chat_path;
        models_path = proxy.models_path;
        validate_path = proxy.validate_path;
    }

    if let Some(llm) = llm {
        if base_url.trim().is_empty() {
            if let Some(value) = llm.base_url {
                base_url = value;
            }
        }
        if provider.is_none() {
            provider = llm.provider;
        }
        if default_model.is_none() {
            default_model = llm.default_model;
        }
        if dialect.is_none() {
            dialect = llm.dialect;
        }
    }

    let trimmed_base_url = base_url.trim().trim_end_matches('/').to_string();
    if trimmed_base_url.is_empty() {
        return None;
    }

    Some(LicenseProxyConfig {
        provider,
        base_url: trimmed_base_url,
        chat_path,
        models_path,
        validate_path,
        default_model,
        dialect,
    })
}

fn normalize_proxy_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("Proxy URL is required.".to_string());
    }
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Err("Proxy URL must start with http:// or https://".to_string());
    }
    Ok(trimmed.to_string())
}

fn normalize_status(raw: &str) -> &str {
    match raw.trim().to_ascii_lowercase().as_str() {
        "active" | "ok" | "licensed" => "active",
        "inactive" | "disabled" => "inactive",
        "expired" => "expired",
        "revoked" => "revoked",
        _ => "inactive",
    }
}

fn resolve_device_name() -> String {
    std::env::var("COMPUTERNAME")
        .ok()
        .or_else(|| std::env::var("HOSTNAME").ok())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "unknown-device".to_string())
}

fn extract_message_from_text(body: &str) -> Option<String> {
    let parsed = serde_json::from_str::<Value>(body).ok()?;
    extract_message_from_json(&parsed)
}

fn extract_message_from_json(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Object(map) => extract_message_from_map(map),
        _ => None,
    }
}

fn extract_message_from_map(map: &Map<String, Value>) -> Option<String> {
    for key in ["message", "error", "detail"] {
        if let Some(Value::String(text)) = map.get(key) {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn persist_error_state(
    app: &tauri::AppHandle,
    proxy_url: &str,
    message: &str,
) -> Result<(), String> {
    let previous = read_state(app)?.unwrap_or_default();
    let next_state = LicenseState {
        status: "inactive".to_string(),
        proxy_url: proxy_url.to_string(),
        license_id: previous.license_id,
        plan_name: previous.plan_name,
        customer_label: previous.customer_label,
        expires_at: previous.expires_at,
        activated_at: previous.activated_at,
        last_validated_at: Some(Utc::now().to_rfc3339()),
        last_error: Some(message.to_string()),
        proxy: previous.proxy,
        raw_features: previous.raw_features,
    };
    write_state(app, &next_state)
}

fn state_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&app_data_dir)
        .map_err(|e| format!("Failed to create app data directory: {}", e))?;
    Ok(app_data_dir.join(LICENSE_STATE_FILE))
}

fn read_state(app: &tauri::AppHandle) -> Result<Option<LicenseState>, String> {
    let path = state_file_path(app)?;
    if !path.exists() {
        return Ok(None);
    }

    let raw = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read license state: {}", e))?;
    let state = serde_json::from_str::<LicenseState>(&raw)
        .map_err(|e| format!("Failed to parse license state: {}", e))?;
    Ok(Some(normalize_state(state)))
}

fn write_state(app: &tauri::AppHandle, state: &LicenseState) -> Result<(), String> {
    let path = state_file_path(app)?;
    let json = serde_json::to_string_pretty(state)
        .map_err(|e| format!("Failed to serialize license state: {}", e))?;
    std::fs::write(path, json).map_err(|e| format!("Failed to write license state: {}", e))
}

fn delete_state(app: &tauri::AppHandle) -> Result<(), String> {
    let path = state_file_path(app)?;
    if !path.exists() {
        return Ok(());
    }
    std::fs::remove_file(path).map_err(|e| format!("Failed to delete license state: {}", e))
}

fn normalize_state(mut state: LicenseState) -> LicenseState {
    state.status = normalize_status(&state.status).to_string();
    state.proxy_url = state.proxy_url.trim().trim_end_matches('/').to_string();
    if let Some(proxy) = state.proxy.as_mut() {
        proxy.base_url = proxy.base_url.trim().trim_end_matches('/').to_string();
    }

    for value in [
        &mut state.expires_at,
        &mut state.activated_at,
        &mut state.last_validated_at,
    ] {
        if let Some(current) = value.clone() {
            *value = normalize_datetime(&current);
        }
    }

    state
}

fn normalize_datetime(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(parsed) = DateTime::parse_from_rfc3339(trimmed) {
        return Some(parsed.with_timezone(&Utc).to_rfc3339());
    }
    Some(trimmed.to_string())
}
