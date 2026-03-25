use std::env;
use std::fs;
use std::path::{Path, PathBuf};

fn main() {
    println!("cargo:rerun-if-env-changed=VOSK_LIB_DIR");
    println!("cargo:rerun-if-env-changed=CARGO_TARGET_DIR");

    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".into()));

    if let Some(staged_dir) = stage_vosk_runtime_libs(&manifest_dir, &target_os) {
        println!("cargo:rustc-link-search=native={}", staged_dir.display());

        if let Ok(source_dir) = env::var("VOSK_LIB_DIR") {
            let source_dir = PathBuf::from(source_dir);
            if source_dir.exists() {
                // Keep source dir on linker path as well (e.g. when import libs stay there).
                println!("cargo:rustc-link-search=native={}", source_dir.display());
            }
        }

        if target_os == "macos" {
            // In dev the binary runs from target/<profile>; in packaged apps from Contents/MacOS.
            println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path");
            println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Resources");
        }

        copy_runtime_libs_to_target_output(&manifest_dir, &staged_dir, &target_os);
    }

    tauri_build::build()
}

fn stage_vosk_runtime_libs(manifest_dir: &Path, target_os: &str) -> Option<PathBuf> {
    let staged_dir = manifest_dir.join("resources").join("vosk").join(target_os);
    let _ = fs::create_dir_all(&staged_dir);

    if let Ok(source_dir_raw) = env::var("VOSK_LIB_DIR") {
        let source_dir = PathBuf::from(source_dir_raw);
        copy_platform_runtime_libs(&source_dir, &staged_dir, target_os);
    }

    let runtime_files = list_runtime_files(&staged_dir, target_os);
    if runtime_files.is_empty() {
        None
    } else {
        for file in runtime_files {
            println!("cargo:rerun-if-changed={}", file.display());
        }
        Some(staged_dir)
    }
}

fn copy_platform_runtime_libs(source_dir: &Path, staged_dir: &Path, target_os: &str) {
    if !source_dir.exists() {
        return;
    }

    let wanted_ext = match target_os {
        "windows" => "dll",
        "macos" => "dylib",
        _ => return,
    };

    let Ok(entries) = fs::read_dir(source_dir) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let ext = path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case(wanted_ext))
            .unwrap_or(false);
        if !ext {
            continue;
        }
        if let Some(name) = path.file_name() {
            let _ = fs::copy(&path, staged_dir.join(name));
        }
    }
}

fn list_runtime_files(dir: &Path, target_os: &str) -> Vec<PathBuf> {
    let wanted_ext = match target_os {
        "windows" => "dll",
        "macos" => "dylib",
        _ => return Vec::new(),
    };

    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };

    entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .map(|ext| ext.eq_ignore_ascii_case(wanted_ext))
                    .unwrap_or(false)
        })
        .collect()
}

fn copy_runtime_libs_to_target_output(manifest_dir: &Path, staged_dir: &Path, target_os: &str) {
    let runtime_files = list_runtime_files(staged_dir, target_os);
    if runtime_files.is_empty() {
        return;
    }

    let profile = env::var("PROFILE").unwrap_or_else(|_| "debug".into());
    let target_triple = env::var("TARGET").unwrap_or_default();

    let target_base = env::var("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| manifest_dir.join("target"));

    let candidate_dirs = [
        target_base.join(&profile),
        target_base.join(&target_triple).join(&profile),
    ];

    for out_dir in candidate_dirs {
        if fs::create_dir_all(&out_dir).is_err() {
            continue;
        }
        for runtime_file in &runtime_files {
            if let Some(name) = runtime_file.file_name() {
                let _ = fs::copy(runtime_file, out_dir.join(name));
            }
        }
    }
}
