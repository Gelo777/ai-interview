use crate::audio;
use crate::capture_protection;
use crate::install_control;
use crate::license;
use crate::ocr;
use crate::secret_store;
use crate::stt::{SttConfig, SttEngine, SttStatus};
use crate::stt_runtime;
use crate::system_audio;
use crate::vosk_installer;
use crate::vosk_runtime;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::time::Duration;
use tauri::WebviewUrl;
use tauri::{Emitter, Manager};

const APP_STATE_DIR_NAME: &str = "state";
const NETWORK_CONNECT_TIMEOUT_SECS: u64 = 10;
const MODEL_INDEX_REQUEST_TIMEOUT_SECS: u64 = 4;
const MODEL_DOWNLOAD_REQUEST_TIMEOUT_SECS: u64 = 7_200;

fn app_window_url(app: &tauri::AppHandle) -> WebviewUrl {
    #[cfg(debug_assertions)]
    {
        if let Some(dev_url) = &app.config().build.dev_url {
            return WebviewUrl::External(dev_url.clone());
        }
    }

    WebviewUrl::App("index.html".into())
}

#[derive(Default)]
pub struct InterviewWindowLock {
    active: AtomicBool,
}

impl InterviewWindowLock {
    pub fn set_active(&self, active: bool) {
        self.active.store(active, AtomicOrdering::Relaxed);
    }

    pub fn is_active(&self) -> bool {
        self.active.load(AtomicOrdering::Relaxed)
    }
}

#[derive(Serialize)]
pub struct PlatformInfo {
    pub os: String,
    pub arch: String,
    pub capture_protection: String,
}

#[tauri::command]
pub fn get_platform_info() -> PlatformInfo {
    let os = std::env::consts::OS.to_string();
    let arch = std::env::consts::ARCH.to_string();

    let capture_protection = match os.as_str() {
        "macos" => "supported".to_string(),
        "windows" => "supported".to_string(),
        _ => "unknown".to_string(),
    };

    PlatformInfo {
        os,
        arch,
        capture_protection,
    }
}

#[derive(Serialize)]
pub struct PermissionCheck {
    pub microphone: String,
    pub system_audio: String,
    pub screen_capture: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct AudioDeviceSelectionRequest {
    pub microphone_device_id: Option<String>,
    pub system_audio_device_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct StartSttSessionRequest {
    pub microphone_device_id: Option<String>,
    pub system_audio_device_id: Option<String>,
}

fn normalize_optional_device_id(value: Option<String>) -> Option<String> {
    value.and_then(|raw| {
        let trimmed = raw.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

#[tauri::command]
pub fn check_permissions(request: Option<AudioDeviceSelectionRequest>) -> PermissionCheck {
    let request = request.unwrap_or_default();
    let has_mic = audio::has_input_device(request.microphone_device_id.as_deref());
    let has_output = audio::has_output_device(request.system_audio_device_id.as_deref());

    PermissionCheck {
        microphone: if has_mic {
            "granted".to_string()
        } else {
            "denied".to_string()
        },
        system_audio: if has_output {
            "granted".to_string()
        } else {
            "denied".to_string()
        },
        screen_capture: "granted".to_string(),
    }
}

#[tauri::command]
pub fn list_audio_devices() -> Vec<audio::AudioDeviceInfo> {
    let mut devices = audio::list_input_devices();
    devices.extend(audio::list_output_devices());
    devices
}

#[tauri::command]
pub fn get_capture_protection() -> capture_protection::CaptureProtectionStatus {
    capture_protection::get_capture_protection_status()
}

#[tauri::command]
pub fn get_system_audio_status(
    request: Option<AudioDeviceSelectionRequest>,
) -> system_audio::SystemAudioStatus {
    let request = request.unwrap_or_default();
    system_audio::get_system_audio_status(request.system_audio_device_id.as_deref())
}

/// Runs platform-native OCR on a base64-encoded image (PNG/JPEG). Returns recognized text.
#[tauri::command]
pub fn ocr_image(image_base64: String, language_hint: Option<String>) -> Result<String, String> {
    ocr::ocr_image_base64(image_base64, language_hint)
}

#[tauri::command]
pub fn get_secure_api_key() -> Result<Option<String>, String> {
    secret_store::get_api_key()
}

#[tauri::command]
pub fn set_secure_api_key(api_key: String) -> Result<(), String> {
    secret_store::set_api_key(&api_key)
}

#[tauri::command]
pub fn get_license_status(app: tauri::AppHandle) -> Result<license::LicenseStatus, String> {
    license::get_license_status(&app)
}

#[tauri::command]
pub async fn activate_license(
    app: tauri::AppHandle,
    request: license::ActivateLicenseRequest,
) -> Result<license::LicenseActivationResult, String> {
    license::activate_license(&app, request).await
}

#[tauri::command]
pub fn clear_license(app: tauri::AppHandle) -> Result<license::LicenseStatus, String> {
    license::clear_license(&app)
}

#[tauri::command]
pub fn read_app_state(app: tauri::AppHandle, key: String) -> Result<Option<String>, String> {
    let path = app_state_file_path(&app, &key)?;
    if !path.exists() {
        return Ok(None);
    }
    std::fs::read_to_string(path)
        .map(Some)
        .map_err(|e| format!("Failed to read app state: {}", e))
}

#[tauri::command]
pub fn write_app_state(app: tauri::AppHandle, key: String, value: String) -> Result<(), String> {
    let path = app_state_file_path(&app, &key)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create app state directory: {}", e))?;
    }
    std::fs::write(path, value).map_err(|e| format!("Failed to write app state: {}", e))
}

#[tauri::command]
pub fn remove_app_state(app: tauri::AppHandle, key: String) -> Result<(), String> {
    let path = app_state_file_path(&app, &key)?;
    if !path.exists() {
        return Ok(());
    }
    std::fs::remove_file(path).map_err(|e| format!("Failed to remove app state: {}", e))
}

/// Applies or removes capture protection on a window (by label). Call after creating the overlay window if settings.protectOverlay is true.
#[tauri::command]
pub fn set_capture_protection_for_window(
    app: tauri::AppHandle,
    window_label: String,
    enabled: bool,
) -> Result<(), String> {
    let window = app
        .get_webview_window(&window_label)
        .ok_or_else(|| format!("Window '{}' not found", window_label))?;

    #[cfg(target_os = "macos")]
    {
        let ptr = window.ns_window().map_err(|e| e.to_string())?;
        capture_protection::set_capture_protection_macos(ptr, enabled)?;
    }

    #[cfg(target_os = "windows")]
    {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?;
        capture_protection::set_capture_protection_windows(hwnd.0 as isize, enabled)?;
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let _ = (enabled, window);

    Ok(())
}

#[tauri::command]
pub fn get_stt_status(app: tauri::AppHandle) -> SttStatus {
    let runtime_probe = vosk_runtime::probe_runtime(&app);
    let model_path = resolve_stt_model_path(&app).and_then(|p| p.to_str().map(String::from));

    let config = SttConfig {
        model_path: model_path.clone().unwrap_or_default(),
        runtime_library_path: runtime_probe.library_path.clone(),
        ..SttConfig::default()
    };
    let engine = SttEngine::new(config);
    let mut status = engine.get_status();

    status.runtime_library_loaded = runtime_probe.available;
    status.runtime_library_path = runtime_probe.library_path.clone();
    status.available = status.model_path.is_some() && runtime_probe.available;

    if runtime_probe.available {
        if status.model_path.is_some() {
            status.detail = "Vosk runtime and model found. Ready to start.".to_string();
        } else {
            status.detail = format!("{} {}", runtime_probe.detail, status.detail);
        }
    } else if status.model_path.is_some() {
        status.detail = format!(
            "{} Model path: {}",
            runtime_probe.detail,
            status.model_path.clone().unwrap_or_default()
        );
    } else {
        status.detail = format!("{} {}", runtime_probe.detail, status.detail);
    }

    status.detail = friendly_stt_detail(&status.detail);
    status
}

#[tauri::command]
pub fn start_stt_session(
    app: tauri::AppHandle,
    request: Option<StartSttSessionRequest>,
) -> Result<(), String> {
    let request = request.unwrap_or_default();
    let config = resolve_stt_config(&app)?;
    stt_runtime::start_global_session(
        app,
        stt_runtime::SttRuntimeConfig {
            model_path: PathBuf::from(config.model_path),
            runtime_library_path: PathBuf::from(
                config
                    .runtime_library_path
                    .ok_or_else(|| "Vosk runtime library path is missing".to_string())?,
            ),
            microphone_device_id: normalize_optional_device_id(request.microphone_device_id),
            system_audio_device_id: normalize_optional_device_id(request.system_audio_device_id),
        },
    )
}

#[tauri::command]
pub fn stop_stt_session() -> Result<(), String> {
    stt_runtime::stop_global_session()
}

#[tauri::command]
pub fn is_stt_session_running() -> bool {
    stt_runtime::is_global_session_running()
}

#[tauri::command]
pub async fn list_vosk_runtime_versions() -> Result<Vec<vosk_installer::VoskRuntimeVersion>, String>
{
    vosk_installer::list_versions().await
}

#[tauri::command]
pub async fn install_vosk_runtime(
    app: tauri::AppHandle,
    version: Option<String>,
) -> Result<vosk_installer::VoskRuntimeInstallResult, String> {
    vosk_installer::install_runtime(&app, version).await
}

#[tauri::command]
pub fn cancel_vosk_install() -> Result<(), String> {
    install_control::request_cancel();
    Ok(())
}

fn resolve_stt_config(app: &tauri::AppHandle) -> Result<SttConfig, String> {
    let runtime_probe = vosk_runtime::probe_runtime(app);
    if !runtime_probe.available {
        return Err(runtime_probe.detail);
    }

    let model_path = resolve_stt_model_path(app)
        .and_then(|p: PathBuf| p.to_str().map(String::from))
        .ok_or_else(|| "Vosk model is not installed. Download a model first.".to_string())?;

    Ok(SttConfig {
        model_path,
        runtime_library_path: runtime_probe.library_path,
        ..SttConfig::default()
    })
}

fn app_state_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let state_dir = app_data_dir.join(APP_STATE_DIR_NAME);
    std::fs::create_dir_all(&state_dir)
        .map_err(|e| format!("Failed to create app state directory: {}", e))?;
    Ok(state_dir)
}

fn sanitize_app_state_key(key: &str) -> String {
    let mut sanitized = String::new();
    for ch in key.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            sanitized.push(ch);
        } else {
            sanitized.push('_');
        }
    }

    let trimmed = sanitized.trim_matches('_');
    let base = if trimmed.is_empty() { "state" } else { trimmed };
    format!("{}.json", base)
}

fn app_state_file_path(app: &tauri::AppHandle, key: &str) -> Result<PathBuf, String> {
    let state_dir = app_state_dir(app)?;
    Ok(state_dir.join(sanitize_app_state_key(key)))
}

fn friendly_stt_detail(detail: &str) -> String {
    let normalized = detail.replace('\n', " ").replace('\r', " ");
    let lowered = normalized.to_ascii_lowercase();

    if lowered.contains("runtime library and model are missing")
        || (lowered.contains("runtime") && lowered.contains("model") && lowered.contains("missing"))
    {
        return "Vosk runtime and language model are missing. Install latest stable runtime, then install language models in Language settings.".to_string();
    }
    if lowered.contains("failed to load") {
        return "Vosk runtime was found, but failed to load. Reinstall latest stable runtime in Language settings.".to_string();
    }
    if (lowered.contains("model") && lowered.contains("missing"))
        || (lowered.contains("model") && lowered.contains("not found"))
        || lowered.contains("download a model")
    {
        return "Vosk language model is not available. Install the model in Language settings."
            .to_string();
    }
    if (lowered.contains("runtime") || lowered.contains("libvosk"))
        && (lowered.contains("not found")
            || lowered.contains("missing")
            || lowered.contains("unloadable"))
    {
        return "Vosk runtime is not available. Install latest stable runtime in Language settings.".to_string();
    }
    normalized
        .split(';')
        .next()
        .unwrap_or(&normalized)
        .split("Checked:")
        .next()
        .unwrap_or(&normalized)
        .trim()
        .to_string()
}

/// Creates the overlay window (always-on-top with system window controls). Must be async on Windows to avoid deadlock.
#[tauri::command]
pub async fn create_overlay_window(
    app: tauri::AppHandle,
    lock: tauri::State<'_, InterviewWindowLock>,
) -> Result<(), String> {
    lock.set_active(true);

    if let Some(existing_overlay) = app.get_webview_window("overlay") {
        let _ = existing_overlay.unminimize();
        let _ = existing_overlay.show();
        let _ = existing_overlay.set_focus();
        if let Some(main_window) = app.get_webview_window("main") {
            let _ = main_window.set_skip_taskbar(true);
            let _ = main_window.minimize();
            let _ = main_window.hide();
        }
        return Ok(());
    }

    let url = app_window_url(&app);

    let _window = tauri::WebviewWindowBuilder::new(&app, "overlay", url)
        .title("AI Interview — Overlay")
        .inner_size(800.0, 600.0)
        .min_inner_size(400.0, 300.0)
        .transparent(false)
        .decorations(true)
        .always_on_top(true)
        .resizable(true)
        .center()
        .build()
        .map_err(|e: tauri::Error| e.to_string())?;

    if let Some(main_window) = app.get_webview_window("main") {
        let _ = main_window.set_skip_taskbar(true);
        let _ = main_window.minimize();
        let _ = main_window.hide();
    }

    Ok(())
}

#[tauri::command]
pub async fn close_main_window(
    app: tauri::AppHandle,
    lock: tauri::State<'_, InterviewWindowLock>,
) -> Result<(), String> {
    lock.set_active(true);
    if let Some(main_window) = app.get_webview_window("main") {
        let _ = main_window.set_skip_taskbar(true);
        let _ = main_window.minimize();
        let _ = main_window.hide();
    }

    Ok(())
}

#[tauri::command]
pub async fn restore_main_window(
    app: tauri::AppHandle,
    lock: tauri::State<'_, InterviewWindowLock>,
) -> Result<(), String> {
    lock.set_active(false);
    if let Some(main_window) = app.get_webview_window("main") {
        let _ = main_window.set_skip_taskbar(false);
        let _ = main_window.show();
        let _ = main_window.unminimize();
        let _ = main_window.set_focus();
        return Ok(());
    }

    let url = app_window_url(&app);

    let main_window = tauri::WebviewWindowBuilder::new(&app, "main", url)
        .title("AI Interview")
        .inner_size(1100.0, 750.0)
        .min_inner_size(900.0, 600.0)
        .resizable(true)
        .fullscreen(false)
        .center()
        .decorations(true)
        .transparent(false)
        .build()
        .map_err(|e: tauri::Error| format!("Failed to create main window: {}", e))?;

    let _ = main_window.set_skip_taskbar(false);
    let _ = main_window.show();
    let _ = main_window.unminimize();
    let _ = main_window.set_focus();

    Ok(())
}

const ACTIVE_MODEL_FILE: &str = "active_model.txt";
const MODEL_INDEX_CACHE_FILE: &str = "model-index-cache.json";
const VOSK_MODEL_INDEX_URL: &str = "https://alphacephei.com/vosk/models/model-list.json";

#[derive(Copy, Clone, Eq, PartialEq)]
enum VoskModelVariant {
    Small,
    Large,
}

impl VoskModelVariant {
    fn as_str(self) -> &'static str {
        match self {
            Self::Small => "small",
            Self::Large => "large",
        }
    }

    fn from_remote_type(model_type: &str, model_id: &str) -> Self {
        if model_type.eq_ignore_ascii_case("small") || model_id.contains("-small-") {
            Self::Small
        } else {
            Self::Large
        }
    }

    fn sort_rank(self) -> u8 {
        match self {
            Self::Small => 0,
            Self::Large => 1,
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(untagged)]
enum BoolOrString {
    Bool(bool),
    String(String),
}

impl BoolOrString {
    fn as_bool(&self) -> bool {
        match self {
            Self::Bool(value) => *value,
            Self::String(value) => value.trim().eq_ignore_ascii_case("true"),
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
struct VoskModelIndexEntry {
    lang: String,
    #[serde(default)]
    lang_text: String,
    name: String,
    #[serde(default)]
    obsolete: Option<BoolOrString>,
    size: u64,
    #[serde(rename = "type")]
    model_type: String,
    url: String,
    #[serde(default)]
    version: String,
}

#[derive(Clone)]
struct VoskModelCatalogEntry {
    id: String,
    name: String,
    language: String,
    variant: VoskModelVariant,
    size_mb: u32,
    download_url: String,
    family_key: String,
    default_baseline: bool,
}

const FALLBACK_MODEL_CATALOG: &[(&str, &str, &str, VoskModelVariant, u32, &str)] = &[
    (
        "vosk-model-small-en-us-0.15",
        "English (Small, US)",
        "en-US",
        VoskModelVariant::Small,
        40,
        "https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip",
    ),
    (
        "vosk-model-en-us-0.22",
        "English (Large, US)",
        "en-US",
        VoskModelVariant::Large,
        1800,
        "https://alphacephei.com/vosk/models/vosk-model-en-us-0.22.zip",
    ),
    (
        "vosk-model-small-ru-0.22",
        "Russian (Small)",
        "ru-RU",
        VoskModelVariant::Small,
        91,
        "https://alphacephei.com/vosk/models/vosk-model-small-ru-0.22.zip",
    ),
    (
        "vosk-model-ru-0.42",
        "Russian (Large)",
        "ru-RU",
        VoskModelVariant::Large,
        1800,
        "https://alphacephei.com/vosk/models/vosk-model-ru-0.42.zip",
    ),
];

struct VoskCatalogData {
    latest_by_family: Vec<VoskModelCatalogEntry>,
    id_to_family: HashMap<String, String>,
}

#[derive(Clone, Serialize)]
pub struct VoskModelOption {
    pub id: String,
    pub name: String,
    pub language: String,
    pub variant: String,
    pub size_mb: u32,
    pub download_url: String,
    pub installed: bool,
    pub active: bool,
    pub update_available: bool,
    pub installed_versions: Vec<String>,
    pub default_baseline: bool,
}

fn installed_model_ids(base_dir: &Path) -> Vec<String> {
    let mut models = std::fs::read_dir(base_dir)
        .ok()
        .into_iter()
        .flat_map(|entries| entries.flatten())
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .filter_map(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .map(String::from)
        })
        .collect::<Vec<_>>();
    models.sort();
    models
}

fn normalize_catalog_language(raw: &str) -> String {
    match raw.trim().to_ascii_lowercase().as_str() {
        "en" | "en-us" => "en-US".to_string(),
        "ru" | "ru-ru" => "ru-RU".to_string(),
        "es" | "es-es" => "es-ES".to_string(),
        "de" | "de-de" => "de-DE".to_string(),
        "fr" | "fr-fr" => "fr-FR".to_string(),
        "it" | "it-it" => "it-IT".to_string(),
        "pt" | "pt-br" => "pt-BR".to_string(),
        "cn" | "zh" | "zh-cn" => "zh-CN".to_string(),
        "ja" | "ja-jp" => "ja-JP".to_string(),
        "ko" | "ko-kr" => "ko-KR".to_string(),
        value if value.contains('-') => {
            let mut parts = value.split('-');
            let head = parts.next().unwrap_or(value);
            let tail = parts.next().unwrap_or_default();
            format!(
                "{}-{}",
                head.to_ascii_lowercase(),
                tail.to_ascii_uppercase()
            )
        }
        value => value.to_string(),
    }
}

fn normalize_primary_language(language: &str) -> String {
    match language.trim() {
        "ru" => "ru-RU".to_string(),
        "en" => "en-US".to_string(),
        "es" => "es-ES".to_string(),
        "de" => "de-DE".to_string(),
        "fr" => "fr-FR".to_string(),
        "it" => "it-IT".to_string(),
        "pt" => "pt-BR".to_string(),
        "zh" => "zh-CN".to_string(),
        "ja" => "ja-JP".to_string(),
        "ko" => "ko-KR".to_string(),
        value if !value.is_empty() => normalize_catalog_language(value),
        _ => "en-US".to_string(),
    }
}

fn is_default_baseline_language(language: &str) -> bool {
    matches!(
        language,
        "en-US"
            | "ru-RU"
            | "es-ES"
            | "de-DE"
            | "fr-FR"
            | "it-IT"
            | "pt-BR"
            | "zh-CN"
            | "ja-JP"
            | "ko-KR"
    )
}

fn natural_cmp(left: &str, right: &str) -> Ordering {
    let left_bytes = left.as_bytes();
    let right_bytes = right.as_bytes();
    let mut i = 0usize;
    let mut j = 0usize;

    while i < left_bytes.len() && j < right_bytes.len() {
        let left_is_digit = left_bytes[i].is_ascii_digit();
        let right_is_digit = right_bytes[j].is_ascii_digit();

        if left_is_digit && right_is_digit {
            let left_start = i;
            while i < left_bytes.len() && left_bytes[i].is_ascii_digit() {
                i += 1;
            }
            let right_start = j;
            while j < right_bytes.len() && right_bytes[j].is_ascii_digit() {
                j += 1;
            }

            let left_chunk = &left[left_start..i];
            let right_chunk = &right[right_start..j];
            let left_trimmed = left_chunk.trim_start_matches('0');
            let right_trimmed = right_chunk.trim_start_matches('0');
            let left_norm = if left_trimmed.is_empty() {
                "0"
            } else {
                left_trimmed
            };
            let right_norm = if right_trimmed.is_empty() {
                "0"
            } else {
                right_trimmed
            };

            match left_norm.len().cmp(&right_norm.len()) {
                Ordering::Equal => match left_norm.cmp(right_norm) {
                    Ordering::Equal => {}
                    non_eq => return non_eq,
                },
                non_eq => return non_eq,
            }
        } else {
            let left_char = (left_bytes[i] as char).to_ascii_lowercase();
            let right_char = (right_bytes[j] as char).to_ascii_lowercase();
            match left_char.cmp(&right_char) {
                Ordering::Equal => {
                    i += 1;
                    j += 1;
                }
                non_eq => return non_eq,
            }
        }
    }

    left_bytes.len().cmp(&right_bytes.len())
}

fn should_replace_catalog_candidate(
    current_obsolete: bool,
    current_version: &str,
    current_id: &str,
    next_obsolete: bool,
    next_version: &str,
    next_id: &str,
) -> bool {
    if current_obsolete != next_obsolete {
        return !next_obsolete;
    }
    match natural_cmp(next_version, current_version) {
        Ordering::Greater => true,
        Ordering::Less => false,
        Ordering::Equal => natural_cmp(next_id, current_id).is_gt(),
    }
}

fn model_entry_from_index(
    raw: VoskModelIndexEntry,
) -> Option<(VoskModelCatalogEntry, bool, String)> {
    let id = raw.name.trim().to_string();
    if id.is_empty() || raw.url.trim().is_empty() {
        return None;
    }

    let variant = VoskModelVariant::from_remote_type(&raw.model_type, &id);
    let language = normalize_catalog_language(&raw.lang);
    let family_key = format!("{}|{}", language, variant.as_str());
    let size_mb = ((raw.size as f64) / (1024.0 * 1024.0)).ceil() as u32;
    let obsolete = raw.obsolete.as_ref().is_some_and(BoolOrString::as_bool);
    let version = if raw.version.trim().is_empty() {
        id.clone()
    } else {
        raw.version.trim().to_string()
    };
    let name = if raw.lang_text.trim().is_empty() {
        id.clone()
    } else {
        format!(
            "{} ({})",
            raw.lang_text.trim(),
            if variant == VoskModelVariant::Small {
                "Small"
            } else {
                "Large"
            }
        )
    };

    Some((
        VoskModelCatalogEntry {
            id,
            name,
            language: language.clone(),
            variant,
            size_mb,
            download_url: raw.url.trim().to_string(),
            family_key,
            default_baseline: variant == VoskModelVariant::Small
                && is_default_baseline_language(&language),
        },
        obsolete,
        version,
    ))
}

fn build_catalog_from_index(entries: Vec<VoskModelIndexEntry>) -> VoskCatalogData {
    let mut latest_by_family: HashMap<String, (VoskModelCatalogEntry, bool, String)> =
        HashMap::new();
    let mut id_to_family: HashMap<String, String> = HashMap::new();

    for raw in entries {
        let Some((entry, obsolete, version)) = model_entry_from_index(raw) else {
            continue;
        };
        id_to_family.insert(entry.id.clone(), entry.family_key.clone());

        if let Some((current, current_obsolete, current_version)) =
            latest_by_family.get(&entry.family_key)
        {
            if should_replace_catalog_candidate(
                *current_obsolete,
                current_version,
                &current.id,
                obsolete,
                &version,
                &entry.id,
            ) {
                latest_by_family.insert(entry.family_key.clone(), (entry, obsolete, version));
            }
            continue;
        }

        latest_by_family.insert(entry.family_key.clone(), (entry, obsolete, version));
    }

    let mut latest_by_family = latest_by_family
        .into_values()
        .map(|(entry, _, _)| entry)
        .collect::<Vec<_>>();
    latest_by_family.sort_by(|a, b| {
        a.language
            .cmp(&b.language)
            .then_with(|| a.variant.sort_rank().cmp(&b.variant.sort_rank()))
            .then_with(|| a.name.cmp(&b.name))
    });

    VoskCatalogData {
        latest_by_family,
        id_to_family,
    }
}

fn fallback_catalog() -> VoskCatalogData {
    let mut latest_by_family = Vec::new();
    let mut id_to_family = HashMap::new();

    for (id, name, language, variant, size_mb, download_url) in FALLBACK_MODEL_CATALOG {
        let family_key = format!("{}|{}", language, variant.as_str());
        latest_by_family.push(VoskModelCatalogEntry {
            id: (*id).to_string(),
            name: (*name).to_string(),
            language: (*language).to_string(),
            variant: *variant,
            size_mb: *size_mb,
            download_url: (*download_url).to_string(),
            family_key: family_key.clone(),
            default_baseline: *variant == VoskModelVariant::Small
                && is_default_baseline_language(language),
        });
        id_to_family.insert((*id).to_string(), family_key);
    }

    VoskCatalogData {
        latest_by_family,
        id_to_family,
    }
}

fn model_index_cache_path(base_dir: &Path) -> PathBuf {
    base_dir.join(MODEL_INDEX_CACHE_FILE)
}

fn read_cached_model_index(base_dir: &Path) -> Result<Vec<VoskModelIndexEntry>, String> {
    let cache_path = model_index_cache_path(base_dir);
    let content = std::fs::read_to_string(&cache_path).map_err(|e| {
        format!(
            "Failed to read cached model index '{}': {}",
            cache_path.display(),
            e
        )
    })?;
    serde_json::from_str::<Vec<VoskModelIndexEntry>>(&content)
        .map_err(|e| format!("Failed to parse cached model index: {}", e))
}

fn write_cached_model_index(
    base_dir: &Path,
    entries: &[VoskModelIndexEntry],
) -> Result<(), String> {
    let cache_path = model_index_cache_path(base_dir);
    let payload = serde_json::to_vec(entries)
        .map_err(|e| format!("Failed to serialize model index cache: {}", e))?;
    std::fs::write(&cache_path, payload).map_err(|e| {
        format!(
            "Failed to write model index cache '{}': {}",
            cache_path.display(),
            e
        )
    })
}

async fn fetch_remote_model_index() -> Result<Vec<VoskModelIndexEntry>, String> {
    let client = reqwest::Client::builder()
        .user_agent("ai-interview-desktop/0.1")
        .connect_timeout(Duration::from_secs(NETWORK_CONNECT_TIMEOUT_SECS))
        .timeout(Duration::from_secs(MODEL_INDEX_REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("Failed to build HTTP client for model index: {}", e))?;
    client
        .get(VOSK_MODEL_INDEX_URL)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch Vosk model index: {}", e))?
        .error_for_status()
        .map_err(|e| format!("Vosk model index request failed: {}", e))?
        .json::<Vec<VoskModelIndexEntry>>()
        .await
        .map_err(|e| format!("Failed to parse Vosk model index: {}", e))
}

async fn load_vosk_catalog(app: &tauri::AppHandle) -> Result<VoskCatalogData, String> {
    let base_dir = models_base_dir(app)?;

    if let Ok(cached) = read_cached_model_index(&base_dir) {
        let catalog = build_catalog_from_index(cached);
        if !catalog.latest_by_family.is_empty() {
            return Ok(catalog);
        }
    }

    if let Ok(remote) = fetch_remote_model_index().await {
        let _ = write_cached_model_index(&base_dir, &remote);
        let catalog = build_catalog_from_index(remote);
        if !catalog.latest_by_family.is_empty() {
            return Ok(catalog);
        }
    }

    Ok(fallback_catalog())
}

fn default_small_model_for_language<'a>(
    catalog: &'a [VoskModelCatalogEntry],
    language: &str,
) -> Option<&'a VoskModelCatalogEntry> {
    catalog
        .iter()
        .find(|entry| entry.language == language && entry.variant == VoskModelVariant::Small)
}

#[tauri::command]
pub async fn list_vosk_models(app: tauri::AppHandle) -> Result<Vec<VoskModelOption>, String> {
    let base_dir = models_base_dir(&app)?;
    let active_model_id = read_active_model_id(&base_dir);
    let installed_ids = installed_model_ids(&base_dir);
    let catalog = load_vosk_catalog(&app).await?;

    let mut installed_by_family: HashMap<String, Vec<String>> = HashMap::new();
    for installed_id in installed_ids {
        if let Some(family_key) = catalog.id_to_family.get(&installed_id) {
            installed_by_family
                .entry(family_key.clone())
                .or_default()
                .push(installed_id);
        }
    }

    Ok(catalog
        .latest_by_family
        .iter()
        .map(|entry| {
            let mut installed_versions = installed_by_family
                .get(&entry.family_key)
                .cloned()
                .unwrap_or_default();
            installed_versions.sort();

            let installed = installed_versions
                .iter()
                .any(|version| version == &entry.id);
            let active = active_model_id
                .as_ref()
                .is_some_and(|active_id| installed_versions.iter().any(|id| id == active_id));
            let update_available = !installed_versions.is_empty() && !installed;

            VoskModelOption {
                id: entry.id.clone(),
                name: entry.name.clone(),
                language: entry.language.clone(),
                variant: entry.variant.as_str().to_string(),
                size_mb: entry.size_mb,
                download_url: entry.download_url.clone(),
                installed,
                active,
                update_available,
                installed_versions,
                default_baseline: entry.default_baseline,
            }
        })
        .collect())
}

#[tauri::command]
pub fn set_active_vosk_model(app: tauri::AppHandle, model_id: String) -> Result<(), String> {
    let base_dir = models_base_dir(&app)?;
    let model_dir = base_dir.join(model_id.trim());
    if !model_dir.is_dir() {
        return Err(format!(
            "Model '{}' is not installed. Download it first.",
            model_id
        ));
    }

    write_active_model_id(&base_dir, model_id.trim())
}

#[tauri::command]
pub fn switch_stt_model(app: tauri::AppHandle, model_id: String) -> Result<(), String> {
    let base_dir = models_base_dir(&app)?;
    let normalized = model_id.trim();
    let model_dir = base_dir.join(normalized);
    if !model_dir.is_dir() {
        return Err(format!(
            "Model '{}' is not installed. Download it first.",
            normalized
        ));
    }

    write_active_model_id(&base_dir, normalized)?;

    if stt_runtime::is_global_session_running() {
        stt_runtime::switch_global_model(model_dir)?;
    }

    Ok(())
}

#[tauri::command]
pub fn preload_stt_model(app: tauri::AppHandle, model_id: String) -> Result<(), String> {
    let base_dir = models_base_dir(&app)?;
    let normalized = model_id.trim();
    let model_dir = base_dir.join(normalized);
    if !model_dir.is_dir() {
        return Err(format!(
            "Model '{}' is not installed. Download it first.",
            normalized
        ));
    }

    if stt_runtime::is_global_session_running() {
        stt_runtime::preload_global_model(model_dir)?;
    }

    Ok(())
}

#[tauri::command]
pub fn remove_vosk_model(app: tauri::AppHandle, model_id: String) -> Result<(), String> {
    let base_dir = models_base_dir(&app)?;
    let target_dir = base_dir.join(model_id.trim());
    if !target_dir.is_dir() {
        return Err(format!("Model '{}' is not installed.", model_id.trim()));
    }
    std::fs::remove_dir_all(&target_dir).map_err(|e| format!("Failed to remove model: {}", e))?;

    if read_active_model_id(&base_dir).as_deref() == Some(model_id.trim()) {
        let remaining = installed_model_ids(&base_dir);
        if let Some(next_model) = remaining.first() {
            write_active_model_id(&base_dir, next_model)?;
        } else {
            clear_active_model_id(&base_dir)?;
        }
    }

    Ok(())
}

#[derive(Clone, serde::Serialize)]
pub struct VoskModelDownloadProgress {
    pub bytes_downloaded: u64,
    pub content_length: Option<u64>,
    pub percent: f32,
    pub phase: String, // "downloading" | "extracting"
}

/// Downloads a Vosk model zip from URL, extracts to app_data/models/vosk/<model_id>, emits progress.
#[tauri::command]
pub async fn download_vosk_model(
    app: tauri::AppHandle,
    url: String,
    model_id: String,
    cleanup_model_ids: Option<Vec<String>>,
) -> Result<String, String> {
    install_control::reset_cancel();
    let cleanup_model_ids = cleanup_model_ids.unwrap_or_default();
    download_vosk_model_internal(&app, &url, &model_id, true, &cleanup_model_ids).await
}

#[tauri::command]
pub async fn ensure_default_stt_assets(
    app: tauri::AppHandle,
    primary_language: String,
) -> Result<(), String> {
    let normalized_language = normalize_primary_language(&primary_language);
    let catalog = load_vosk_catalog(&app).await?;

    if let Err(err) = vosk_installer::install_runtime(&app, None).await {
        let runtime_probe = vosk_runtime::probe_runtime(&app);
        if !runtime_probe.available {
            return Err(err);
        }
    }

    let mut baseline = vec!["en-US".to_string()];
    if normalized_language != "en-US" {
        baseline.push(normalized_language.clone());
    }

    let base_dir = models_base_dir(&app)?;

    for language in baseline {
        if let Some(default_small) =
            default_small_model_for_language(&catalog.latest_by_family, &language)
        {
            let installed_ids = installed_model_ids(&base_dir);
            let installed_versions = installed_ids
                .iter()
                .filter(|id| catalog.id_to_family.get(*id) == Some(&default_small.family_key))
                .cloned()
                .collect::<Vec<_>>();
            let has_latest = installed_versions.iter().any(|id| id == &default_small.id);
            if !has_latest {
                let cleanup_model_ids = installed_versions
                    .into_iter()
                    .filter(|id| id != &default_small.id)
                    .collect::<Vec<_>>();
                download_vosk_model_internal(
                    &app,
                    &default_small.download_url,
                    &default_small.id,
                    false,
                    &cleanup_model_ids,
                )
                .await?;
            }
        }
    }

    if let Some(default_primary) =
        default_small_model_for_language(&catalog.latest_by_family, &normalized_language)
    {
        let _ = set_active_vosk_model(app.clone(), default_primary.id.to_string());
    }

    Ok(())
}

async fn download_vosk_model_internal(
    app: &tauri::AppHandle,
    url: &str,
    model_id: &str,
    emit_progress: bool,
    cleanup_model_ids: &[String],
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .user_agent("ai-interview-desktop/0.1")
        .connect_timeout(Duration::from_secs(NETWORK_CONNECT_TIMEOUT_SECS))
        .timeout(Duration::from_secs(MODEL_DOWNLOAD_REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("Failed to build HTTP client for model download: {}", e))?;
    let res = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Failed to download Vosk model: {}", e))?
        .error_for_status()
        .map_err(|e| format!("Vosk model download failed: {}", e))?;

    let total_size = res.content_length();
    let mut stream = res.bytes_stream();
    let mut bytes: Vec<u8> = Vec::new();
    let mut downloaded: u64 = 0;

    while let Some(chunk) = stream.next().await {
        if install_control::is_cancelled() {
            return Err("Vosk installation cancelled by user.".to_string());
        }
        let chunk = chunk.map_err(|e: reqwest::Error| e.to_string())?;
        downloaded += chunk.len() as u64;
        bytes.extend_from_slice(&chunk);

        let percent = total_size
            .map(|t| (downloaded as f32 / t as f32) * 100.0)
            .unwrap_or(0.0);
        if emit_progress {
            let _ = app.emit(
                "vosk_model_download_progress",
                VoskModelDownloadProgress {
                    bytes_downloaded: downloaded,
                    content_length: total_size,
                    percent,
                    phase: "downloading".to_string(),
                },
            );
        }
    }

    let models_dir = models_base_dir(app)?;

    if emit_progress {
        let _ = app.emit(
            "vosk_model_download_progress",
            VoskModelDownloadProgress {
                bytes_downloaded: downloaded,
                content_length: Some(downloaded),
                percent: 90.0,
                phase: "extracting".to_string(),
            },
        );
    }

    let extract_dir = models_dir.join(format!(".{}.partial", model_id));
    if extract_dir.exists() {
        std::fs::remove_dir_all(&extract_dir).map_err(|e| e.to_string())?;
    }
    std::fs::create_dir_all(&extract_dir).map_err(|e| e.to_string())?;

    let cursor = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| e.to_string())?;

    for i in 0..archive.len() {
        if install_control::is_cancelled() {
            let _ = std::fs::remove_dir_all(&extract_dir);
            return Err("Vosk installation cancelled by user.".to_string());
        }
        let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = file.name().replace('\\', "/");
        if name.contains("..") {
            continue;
        }
        let out_path = extract_dir.join(&name);
        if out_path.strip_prefix(&extract_dir).is_err() {
            continue;
        }
        if file.is_dir() {
            std::fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
        } else {
            if let Some(p) = out_path.parent() {
                std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
            }
            let mut out = std::fs::File::create(&out_path).map_err(|e| e.to_string())?;
            std::io::copy(&mut file, &mut out).map_err(|e| e.to_string())?;
        }
    }

    normalize_extracted_model_layout(&extract_dir)?;

    let target_dir = models_dir.join(model_id);
    if target_dir.exists() {
        std::fs::remove_dir_all(&target_dir).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&extract_dir, &target_dir).map_err(|e| e.to_string())?;

    if emit_progress {
        let _ = app.emit(
            "vosk_model_download_progress",
            VoskModelDownloadProgress {
                bytes_downloaded: downloaded,
                content_length: Some(downloaded),
                percent: 100.0,
                phase: "extracting".to_string(),
            },
        );
    }

    cleanup_selected_models(&models_dir, cleanup_model_ids, model_id)?;

    if read_active_model_id(&models_dir)
        .as_ref()
        .is_some_and(|active| cleanup_model_ids.iter().any(|id| id == active))
    {
        let _ = write_active_model_id(&models_dir, model_id);
    }

    if read_active_model_id(&models_dir).is_none() {
        let _ = write_active_model_id(&models_dir, model_id);
    }

    target_dir
        .to_str()
        .ok_or_else(|| "Invalid path".to_string())
        .map(String::from)
}

fn models_base_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let models_dir = app_data.join("models").join("vosk");
    std::fs::create_dir_all(&models_dir).map_err(|e| e.to_string())?;
    seed_bundled_models_if_needed(app, &models_dir)?;
    Ok(models_dir)
}

fn seed_bundled_models_if_needed(app: &tauri::AppHandle, models_dir: &Path) -> Result<(), String> {
    let bundled_dir = bundled_models_dir(app);
    let Some(bundled_dir) = bundled_dir else {
        return Ok(());
    };

    copy_dir_contents(&bundled_dir, models_dir)?;

    if read_active_model_id(models_dir).is_none() {
        let bundled_active = bundled_dir.join(ACTIVE_MODEL_FILE);
        if bundled_active.is_file() {
            let active_model = std::fs::read_to_string(&bundled_active)
                .map_err(|e| format!("Failed to read bundled active model marker: {}", e))?;
            let trimmed = active_model.trim();
            if !trimmed.is_empty() {
                let _ = write_active_model_id(models_dir, trimmed);
            }
        }
    }

    Ok(())
}

fn bundled_models_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    let resource_dir = app.path().resource_dir().ok()?;
    let candidates = [
        resource_dir.join("models").join("vosk"),
        resource_dir.join("resources").join("models").join("vosk"),
    ];

    candidates.into_iter().find(|path| path.is_dir())
}

fn copy_dir_contents(source: &Path, destination: &Path) -> Result<(), String> {
    std::fs::create_dir_all(destination)
        .map_err(|e| format!("Failed to create destination directory: {}", e))?;

    for entry in std::fs::read_dir(source)
        .map_err(|e| format!("Failed to read bundled assets directory: {}", e))?
    {
        let entry = entry.map_err(|e| format!("Failed to read bundled asset entry: {}", e))?;
        let source_path = entry.path();
        let target_path = destination.join(entry.file_name());

        if source_path.is_dir() {
            copy_dir_recursive(&source_path, &target_path)?;
            continue;
        }

        if !target_path.exists() {
            std::fs::copy(&source_path, &target_path).map_err(|e| {
                format!(
                    "Failed to copy bundled asset '{}' to '{}': {}",
                    source_path.display(),
                    target_path.display(),
                    e
                )
            })?;
        }
    }

    Ok(())
}

fn copy_dir_recursive(source: &Path, destination: &Path) -> Result<(), String> {
    std::fs::create_dir_all(destination)
        .map_err(|e| format!("Failed to create bundled asset directory: {}", e))?;

    for entry in std::fs::read_dir(source).map_err(|e| {
        format!(
            "Failed to read bundled asset directory '{}': {}",
            source.display(),
            e
        )
    })? {
        let entry = entry.map_err(|e| format!("Failed to read bundled asset entry: {}", e))?;
        let source_path = entry.path();
        let target_path = destination.join(entry.file_name());

        if source_path.is_dir() {
            copy_dir_recursive(&source_path, &target_path)?;
        } else if !target_path.exists() {
            std::fs::copy(&source_path, &target_path).map_err(|e| {
                format!(
                    "Failed to copy bundled file '{}' to '{}': {}",
                    source_path.display(),
                    target_path.display(),
                    e
                )
            })?;
        }
    }

    Ok(())
}

fn active_model_marker_path(base_dir: &Path) -> PathBuf {
    base_dir.join(ACTIVE_MODEL_FILE)
}

fn read_active_model_id(base_dir: &Path) -> Option<String> {
    std::fs::read_to_string(active_model_marker_path(base_dir))
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn write_active_model_id(base_dir: &Path, model_id: &str) -> Result<(), String> {
    std::fs::write(active_model_marker_path(base_dir), model_id)
        .map_err(|e| format!("Failed to set active Vosk model: {}", e))
}

fn clear_active_model_id(base_dir: &Path) -> Result<(), String> {
    let marker = active_model_marker_path(base_dir);
    if marker.exists() {
        std::fs::remove_file(marker).map_err(|e| format!("Failed to clear active model: {}", e))?;
    }
    Ok(())
}

fn resolve_stt_model_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    let base_dir = models_base_dir(app).ok()?;

    if let Some(active_model_id) = read_active_model_id(&base_dir) {
        let active_path = base_dir.join(active_model_id.trim());
        if active_path.is_dir() {
            return Some(active_path);
        }
    }

    let mut dirs = std::fs::read_dir(&base_dir)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect::<Vec<_>>();
    dirs.sort();
    dirs.into_iter().next()
}

fn normalize_extracted_model_layout(extract_dir: &Path) -> Result<(), String> {
    let mut root_dirs = Vec::new();
    let mut root_files = 0usize;

    for entry in std::fs::read_dir(extract_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            root_dirs.push(path);
        } else if path.is_file() {
            root_files += 1;
        }
    }

    if root_files == 0 && root_dirs.len() == 1 {
        let nested_root = &root_dirs[0];
        let nested_entries = std::fs::read_dir(nested_root).map_err(|e| e.to_string())?;
        for nested in nested_entries {
            let nested = nested.map_err(|e| e.to_string())?;
            let source = nested.path();
            let target = extract_dir.join(nested.file_name());
            std::fs::rename(source, target).map_err(|e| e.to_string())?;
        }
        std::fs::remove_dir_all(nested_root).map_err(|e| e.to_string())?;
    }

    Ok(())
}

fn cleanup_selected_models(
    models_dir: &Path,
    model_ids: &[String],
    keep_model_id: &str,
) -> Result<(), String> {
    for model_id in model_ids {
        if model_id == keep_model_id {
            continue;
        }
        let target_dir = models_dir.join(model_id);
        if target_dir.is_dir() {
            std::fs::remove_dir_all(&target_dir)
                .map_err(|e| format!("Failed to remove old model '{}': {}", model_id, e))?;
        }
    }
    Ok(())
}
