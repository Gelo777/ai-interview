use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Update, UpdaterExt};

const PUBLIC_KEY: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/updater/publickey.pem"
));

fn updater_endpoint() -> Option<&'static str> {
    option_env!("TAURI_UPDATER_ENDPOINT")
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

pub struct PendingUpdate(pub Mutex<Option<Update>>);

impl Default for PendingUpdate {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateStatus {
    pub enabled: bool,
    pub endpoint: Option<String>,
    pub current_version: String,
    pub update_available: bool,
    pub version: Option<String>,
    pub body: Option<String>,
    pub date: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data")]
pub enum AppUpdateProgressEvent {
    #[serde(rename_all = "camelCase")]
    Started {
        content_length: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    Progress {
        chunk_length: usize,
    },
    Finished,
}

#[tauri::command]
pub async fn check_app_update(
    app: AppHandle,
    pending_update: State<'_, PendingUpdate>,
) -> Result<AppUpdateStatus, String> {
    let current_version = app.package_info().version.to_string();
    let Some(endpoint) = updater_endpoint() else {
        *pending_update
            .0
            .lock()
            .map_err(|_| "Не удалось открыть состояние обновлений".to_string())? = None;
        return Ok(AppUpdateStatus {
            enabled: false,
            endpoint: None,
            current_version,
            update_available: false,
            version: None,
            body: None,
            date: None,
            error: None,
        });
    };

    let update = app
        .updater_builder()
        .pubkey(PUBLIC_KEY)
        .endpoints(vec![endpoint.parse().map_err(|error| {
            format!("Некорректный URL канала обновлений: {error}")
        })?])
        .map_err(|error| format!("Не удалось настроить канал обновлений: {error}"))?
        .build()
        .map_err(|error| format!("Не удалось инициализировать обновления: {error}"))?
        .check()
        .await
        .map_err(|error| format!("Не удалось проверить обновления: {error}"))?;

    let mut pending = pending_update
        .0
        .lock()
        .map_err(|_| "Не удалось открыть состояние обновлений".to_string())?;
    *pending = update;

    let status = pending.as_ref().map_or(
        AppUpdateStatus {
            enabled: true,
            endpoint: Some(endpoint.to_string()),
            current_version,
            update_available: false,
            version: None,
            body: None,
            date: None,
            error: None,
        },
        |update| AppUpdateStatus {
            enabled: true,
            endpoint: Some(endpoint.to_string()),
            current_version: update.current_version.clone(),
            update_available: true,
            version: Some(update.version.clone()),
            body: update.body.clone(),
            date: update.date.as_ref().map(ToString::to_string),
            error: None,
        },
    );

    Ok(status)
}

#[tauri::command]
pub async fn install_app_update(
    app: AppHandle,
    pending_update: State<'_, PendingUpdate>,
) -> Result<(), String> {
    let update = pending_update
        .0
        .lock()
        .map_err(|_| "Не удалось открыть состояние обновлений".to_string())?
        .take()
        .ok_or_else(|| "Сначала нужно проверить наличие обновления".to_string())?;

    let app_for_chunks = app.clone();
    let app_for_finish = app.clone();
    let started = Arc::new(AtomicBool::new(false));
    let started_for_chunks = Arc::clone(&started);

    update
        .download_and_install(
            move |chunk_length, content_length| {
                if !started_for_chunks.swap(true, Ordering::SeqCst) {
                    let _ = app_for_chunks.emit(
                        "app_update_progress",
                        AppUpdateProgressEvent::Started { content_length },
                    );
                }
                let _ = app_for_chunks.emit(
                    "app_update_progress",
                    AppUpdateProgressEvent::Progress { chunk_length },
                );
            },
            move || {
                let _ =
                    app_for_finish.emit("app_update_progress", AppUpdateProgressEvent::Finished);
            },
        )
        .await
        .map_err(|error| format!("Не удалось установить обновление: {error}"))?;

    #[cfg(not(windows))]
    app.restart();

    Ok(())
}
