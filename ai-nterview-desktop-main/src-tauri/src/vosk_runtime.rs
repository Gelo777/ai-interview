use libloading::Library;
use serde::Serialize;
use std::collections::HashSet;
use std::env;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;

#[derive(Debug, Clone, Serialize)]
pub struct VoskRuntimeProbe {
    pub available: bool,
    pub library_path: Option<String>,
    pub detail: String,
}

pub fn probe_runtime(app: &tauri::AppHandle) -> VoskRuntimeProbe {
    let lib_names = library_filenames();
    if lib_names.is_empty() {
        return VoskRuntimeProbe {
            available: false,
            library_path: None,
            detail: "Vosk runtime is only supported on macOS/Windows in this app.".to_string(),
        };
    }

    let mut seen = HashSet::new();
    let mut load_errors: Vec<String> = Vec::new();
    let mut checked_paths: Vec<PathBuf> = Vec::new();

    for candidate in candidate_library_paths(app, &lib_names) {
        if !seen.insert(candidate.clone()) {
            continue;
        }
        checked_paths.push(candidate.clone());

        if !candidate.exists() || !candidate.is_file() {
            continue;
        }

        // Safety: we only load and immediately drop the handle for smoke-check.
        ensure_runtime_dir_on_path(&candidate);
        match unsafe { Library::new(&candidate) } {
            Ok(lib) => {
                drop(lib);
                return VoskRuntimeProbe {
                    available: true,
                    library_path: Some(path_to_string(&candidate)),
                    detail: format!(
                        "Vosk runtime library loaded: {}",
                        path_to_string(&candidate)
                    ),
                };
            }
            Err(err) => {
                load_errors.push(format!("{} ({})", path_to_string(&candidate), err));
            }
        }
    }

    if !load_errors.is_empty() {
        return VoskRuntimeProbe {
            available: false,
            library_path: None,
            detail: format!(
                "Vosk runtime library found but failed to load. {}",
                load_errors.join("; ")
            ),
        };
    }

    let expected_names = lib_names.join(" or ");
    let checked = checked_paths
        .iter()
        .map(|p| path_to_string(p))
        .collect::<Vec<_>>()
        .join(", ");

    VoskRuntimeProbe {
        available: false,
        library_path: None,
        detail: format!(
            "Vosk runtime library ({}) not found. Checked: {}",
            expected_names, checked
        ),
    }
}

pub fn ensure_runtime_dir_on_path(library_path: &Path) {
    #[cfg(target_os = "windows")]
    {
        let Some(runtime_dir) = library_path.parent() else {
            return;
        };

        let Ok(current_path) = env::var_os("PATH").ok_or(()) else {
            env::set_var("PATH", runtime_dir.as_os_str());
            return;
        };

        let already_present = env::split_paths(&current_path).any(|entry| {
            entry
                .to_string_lossy()
                .eq_ignore_ascii_case(&runtime_dir.to_string_lossy())
        });
        if already_present {
            return;
        }

        let mut updated_entries = Vec::new();
        updated_entries.push(runtime_dir.to_path_buf());
        updated_entries.extend(env::split_paths(&current_path));

        if let Ok(joined) = env::join_paths(updated_entries) {
            env::set_var("PATH", joined);
        } else {
            let mut fallback = OsString::from(runtime_dir.as_os_str());
            fallback.push(";");
            fallback.push(current_path);
            env::set_var("PATH", fallback);
        }
    }

    #[cfg(not(target_os = "windows"))]
    let _ = library_path;
}

fn candidate_library_paths(app: &tauri::AppHandle, lib_names: &[&str]) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(path) = std::env::var("VOSK_LIB_PATH") {
        let path = PathBuf::from(path);
        if path.is_file() {
            candidates.push(path);
        } else if path.is_dir() {
            append_dir_candidates(&path, lib_names, &mut candidates);
        }
    }

    if let Ok(dir) = std::env::var("VOSK_LIB_DIR") {
        append_dir_candidates(&PathBuf::from(dir), lib_names, &mut candidates);
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        append_dir_candidates(&resource_dir, lib_names, &mut candidates);

        if let Some(platform_dir) = platform_resource_dir_name() {
            append_dir_candidates(
                &resource_dir.join("vosk").join(platform_dir),
                lib_names,
                &mut candidates,
            );
            append_dir_candidates(&resource_dir.join(platform_dir), lib_names, &mut candidates);
            append_dir_candidates(
                &resource_dir
                    .join("resources")
                    .join("vosk")
                    .join(platform_dir),
                lib_names,
                &mut candidates,
            );
        }
    }

    if let Ok(app_data_dir) = app.path().app_data_dir() {
        if let Some(platform_dir) = platform_resource_dir_name() {
            let runtime_base = app_data_dir.join("runtime").join("vosk").join(platform_dir);
            append_dir_candidates(&runtime_base, lib_names, &mut candidates);

            let current_version_file = runtime_base.join("current_version.txt");
            if let Ok(version) = fs::read_to_string(&current_version_file) {
                let version_dir = runtime_base.join(version.trim());
                append_dir_candidates(&version_dir, lib_names, &mut candidates);
            }

            if let Ok(entries) = fs::read_dir(&runtime_base) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_dir() {
                        append_dir_candidates(&path, lib_names, &mut candidates);
                    }
                }
            }
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            append_dir_candidates(exe_dir, lib_names, &mut candidates);

            if let Some(platform_dir) = platform_resource_dir_name() {
                append_dir_candidates(
                    &exe_dir.join("vosk").join(platform_dir),
                    lib_names,
                    &mut candidates,
                );
                append_dir_candidates(
                    &exe_dir.join("resources").join("vosk").join(platform_dir),
                    lib_names,
                    &mut candidates,
                );
            }
        }
    }

    candidates
}

fn append_dir_candidates(dir: &Path, lib_names: &[&str], out: &mut Vec<PathBuf>) {
    for lib_name in lib_names {
        out.push(dir.join(lib_name));
    }
}

fn platform_resource_dir_name() -> Option<&'static str> {
    #[cfg(target_os = "macos")]
    {
        Some("macos")
    }
    #[cfg(target_os = "windows")]
    {
        Some("windows")
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        None
    }
}

fn library_filenames() -> Vec<&'static str> {
    #[cfg(target_os = "macos")]
    {
        vec!["libvosk.dylib"]
    }
    #[cfg(target_os = "windows")]
    {
        vec!["vosk.dll", "libvosk.dll"]
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Vec::new()
    }
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
