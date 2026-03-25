mod app_updates;
mod audio;
mod capture_protection;
mod commands;
mod install_control;
mod license;
mod ocr;
mod secret_store;
mod stt;
mod stt_runtime;
mod system_audio;
mod vosk_installer;
mod vosk_runtime;

use tauri::{Emitter, Manager};

fn app_window_url(app: &tauri::AppHandle) -> tauri::WebviewUrl {
    #[cfg(debug_assertions)]
    {
        if let Some(dev_url) = &app.config().build.dev_url {
            return tauri::WebviewUrl::External(dev_url.clone());
        }
    }

    tauri::WebviewUrl::App("index.html".into())
}

fn ensure_main_window_visible(app: &tauri::AppHandle) {
    if let Some(main_window) = app.get_webview_window("main") {
        let _ = main_window.set_skip_taskbar(false);
        let _ = main_window.show();
        let _ = main_window.unminimize();
        let _ = main_window.set_focus();
        return;
    }

    let url = app_window_url(app);

    if let Ok(main_window) = tauri::WebviewWindowBuilder::new(app, "main", url)
        .title("AI Interview")
        .inner_size(1100.0, 750.0)
        .min_inner_size(900.0, 600.0)
        .resizable(true)
        .fullscreen(false)
        .center()
        .decorations(true)
        .transparent(false)
        .build()
    {
        let _ = main_window.set_skip_taskbar(false);
        let _ = main_window.show();
        let _ = main_window.unminimize();
        let _ = main_window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(commands::InterviewWindowLock::default())
        .manage(app_updates::PendingUpdate::default())
        .setup(|app| {
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
            #[cfg(debug_assertions)]
            {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            let lock = window.state::<commands::InterviewWindowLock>();

            if window.label() == "overlay" {
                if matches!(event, tauri::WindowEvent::Destroyed) {
                    let app = window.app_handle();
                    let _ = stt_runtime::stop_global_session();
                    let _ = app.emit("interview_ended", ());
                    let should_restore_main = lock.is_active();
                    lock.set_active(false);
                    if should_restore_main {
                        ensure_main_window_visible(&app);
                    }
                }
                return;
            }

            if window.label() != "main" || !lock.is_active() {
                return;
            }

            let should_block = matches!(event, tauri::WindowEvent::Focused(true));

            if !should_block {
                return;
            }

            if let Some(overlay_window) = window.app_handle().get_webview_window("overlay") {
                let _ = overlay_window.show();
                let _ = overlay_window.unminimize();
                let _ = overlay_window.set_focus();
            }

            let _ = window.set_skip_taskbar(true);
            let _ = window.hide();
            let _ = window.minimize();
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_platform_info,
            commands::check_permissions,
            commands::list_audio_devices,
            commands::get_capture_protection,
            commands::get_system_audio_status,
            commands::set_capture_protection_for_window,
            commands::ocr_image,
            commands::get_secure_api_key,
            commands::set_secure_api_key,
            commands::get_license_status,
            commands::activate_license,
            commands::clear_license,
            app_updates::check_app_update,
            app_updates::install_app_update,
            commands::read_app_state,
            commands::write_app_state,
            commands::remove_app_state,
            commands::get_stt_status,
            commands::create_overlay_window,
            commands::close_main_window,
            commands::restore_main_window,
            commands::download_vosk_model,
            commands::list_vosk_models,
            commands::set_active_vosk_model,
            commands::switch_stt_model,
            commands::preload_stt_model,
            commands::remove_vosk_model,
            commands::ensure_default_stt_assets,
            commands::list_vosk_runtime_versions,
            commands::install_vosk_runtime,
            commands::cancel_vosk_install,
            commands::start_stt_session,
            commands::stop_stt_session,
            commands::is_stt_session_running,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
