use crate::install_control;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const GITHUB_RELEASES_API: &str =
    "https://api.github.com/repos/alphacep/vosk-api/releases?per_page=30";

#[derive(Debug, Clone, Serialize)]
pub struct VoskRuntimeVersion {
    pub version: String,
    pub tag: String,
    pub asset_name: String,
    pub download_url: String,
    pub published_at: String,
    pub is_latest_stable: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct VoskRuntimeInstallProgress {
    pub phase: String, // "downloading" | "extracting"
    pub bytes_downloaded: u64,
    pub content_length: Option<u64>,
    pub percent: f32,
}

#[derive(Debug, Clone, Serialize)]
pub struct VoskRuntimeInstallResult {
    pub version: String,
    pub tag: String,
    pub install_dir: String,
    pub files: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    published_at: Option<String>,
    assets: Vec<GitHubAsset>,
}

#[derive(Debug, Clone, Deserialize)]
struct GitHubAsset {
    name: String,
    browser_download_url: String,
}

pub async fn list_versions() -> Result<Vec<VoskRuntimeVersion>, String> {
    let client = reqwest::Client::builder()
        .user_agent("ai-interview-desktop/0.1")
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(25))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let releases = client
        .get(GITHUB_RELEASES_API)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch Vosk releases: {}", e))?
        .error_for_status()
        .map_err(|e| format!("Vosk releases request failed: {}", e))?
        .json::<Vec<GitHubRelease>>()
        .await
        .map_err(|e| format!("Failed to parse Vosk releases: {}", e))?;

    let mut versions = releases
        .into_iter()
        .filter(|release| !release.draft && !release.prerelease)
        .filter_map(|release| {
            let asset = release
                .assets
                .into_iter()
                .find(|a| asset_matches_platform(&a.name))?;
            let tag = release.tag_name;
            let version = normalize_tag(&tag);
            Some(VoskRuntimeVersion {
                version,
                tag,
                asset_name: asset.name,
                download_url: asset.browser_download_url,
                published_at: release.published_at.unwrap_or_default(),
                is_latest_stable: false,
            })
        })
        .collect::<Vec<_>>();

    versions.sort_by(|a, b| b.published_at.cmp(&a.published_at));
    if let Some(first) = versions.first_mut() {
        first.is_latest_stable = true;
    }

    Ok(versions)
}

pub async fn install_runtime(
    app: &AppHandle,
    requested_version: Option<String>,
) -> Result<VoskRuntimeInstallResult, String> {
    install_control::reset_cancel();
    let versions = list_versions().await?;
    if versions.is_empty() {
        return Err("No compatible Vosk runtime versions found for this platform.".to_string());
    }

    let requested = requested_version.map(|v| normalize_tag(v.trim()));
    let selected = if let Some(version) = requested {
        versions
            .iter()
            .find(|v| v.version == version || normalize_tag(&v.tag) == version)
            .cloned()
            .ok_or_else(|| format!("Requested Vosk version '{}' is not available.", version))?
    } else {
        versions[0].clone()
    };

    let runtime_base_dir = runtime_base_dir(app)?;
    let install_dir = runtime_base_dir.join(&selected.version);
    if install_dir.is_dir() {
        let existing_files = collect_existing_runtime_files(&install_dir)?;
        if !existing_files.is_empty() {
            fs::write(
                runtime_base_dir.join("current_version.txt"),
                selected.version.as_bytes(),
            )
            .map_err(|e| format!("Failed to store current runtime version: {}", e))?;
            cleanup_old_runtime_versions(&runtime_base_dir, &selected.version)?;
            return Ok(VoskRuntimeInstallResult {
                version: selected.version,
                tag: selected.tag,
                install_dir: install_dir.to_string_lossy().into_owned(),
                files: existing_files,
            });
        }
    }

    let client = reqwest::Client::builder()
        .user_agent("ai-interview-desktop/0.1")
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let response = client
        .get(&selected.download_url)
        .send()
        .await
        .map_err(|e| format!("Failed to download Vosk runtime: {}", e))?
        .error_for_status()
        .map_err(|e| format!("Vosk runtime download failed: {}", e))?;

    let total_size = response.content_length();
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    let mut downloaded = 0_u64;

    while let Some(chunk) = stream.next().await {
        if install_control::is_cancelled() {
            return Err("Vosk installation cancelled by user.".to_string());
        }
        let chunk = chunk.map_err(|e| format!("Failed to read Vosk runtime chunk: {}", e))?;
        downloaded += chunk.len() as u64;
        bytes.extend_from_slice(&chunk);

        let percent = total_size
            .map(|size| (downloaded as f32 / size as f32) * 90.0)
            .unwrap_or(0.0);
        let _ = app.emit(
            "vosk_runtime_install_progress",
            VoskRuntimeInstallProgress {
                phase: "downloading".to_string(),
                bytes_downloaded: downloaded,
                content_length: total_size,
                percent,
            },
        );
    }

    if install_dir.exists() {
        fs::remove_dir_all(&install_dir)
            .map_err(|e| format!("Failed to replace existing runtime install: {}", e))?;
    }
    fs::create_dir_all(&install_dir)
        .map_err(|e| format!("Failed to create runtime install directory: {}", e))?;

    let _ = app.emit(
        "vosk_runtime_install_progress",
        VoskRuntimeInstallProgress {
            phase: "extracting".to_string(),
            bytes_downloaded: downloaded,
            content_length: Some(downloaded),
            percent: 95.0,
        },
    );

    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|e| format!("Invalid zip archive: {}", e))?;
    let mut extracted_files: Vec<String> = Vec::new();

    for index in 0..archive.len() {
        if install_control::is_cancelled() {
            let _ = fs::remove_dir_all(&install_dir);
            return Err("Vosk installation cancelled by user.".to_string());
        }
        let mut file = archive
            .by_index(index)
            .map_err(|e| format!("Zip read error: {}", e))?;
        if file.is_dir() {
            continue;
        }

        let Some(filename) = Path::new(file.name()).file_name().and_then(|n| n.to_str()) else {
            continue;
        };

        if !should_extract_runtime_file(filename) {
            continue;
        }

        let out_path = install_dir.join(filename);
        let mut out_file = fs::File::create(&out_path)
            .map_err(|e| format!("Failed to create '{}': {}", out_path.display(), e))?;
        std::io::copy(&mut file, &mut out_file)
            .map_err(|e| format!("Failed to extract '{}': {}", out_path.display(), e))?;
        extracted_files.push(out_path.to_string_lossy().into_owned());
    }

    if extracted_files.is_empty() {
        return Err("Vosk runtime archive does not contain expected runtime files.".to_string());
    }

    fs::write(
        runtime_base_dir.join("current_version.txt"),
        selected.version.as_bytes(),
    )
    .map_err(|e| format!("Failed to store current runtime version: {}", e))?;

    cleanup_old_runtime_versions(&runtime_base_dir, &selected.version)?;

    let _ = app.emit(
        "vosk_runtime_install_progress",
        VoskRuntimeInstallProgress {
            phase: "extracting".to_string(),
            bytes_downloaded: downloaded,
            content_length: Some(downloaded),
            percent: 100.0,
        },
    );

    Ok(VoskRuntimeInstallResult {
        version: selected.version,
        tag: selected.tag,
        install_dir: install_dir.to_string_lossy().into_owned(),
        files: extracted_files,
    })
}

fn collect_existing_runtime_files(install_dir: &Path) -> Result<Vec<String>, String> {
    let mut files = Vec::new();
    let entries = fs::read_dir(install_dir).map_err(|e| {
        format!(
            "Failed to list existing runtime files in '{}': {}",
            install_dir.display(),
            e
        )
    })?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read runtime file entry: {}", e))?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(filename) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if should_extract_runtime_file(filename) {
            files.push(path.to_string_lossy().into_owned());
        }
    }

    files.sort();
    Ok(files)
}

fn runtime_base_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let base = app_data_dir
        .join("runtime")
        .join("vosk")
        .join(platform_dir_name());
    fs::create_dir_all(&base).map_err(|e| format!("Failed to create runtime directory: {}", e))?;
    Ok(base)
}

fn normalize_tag(tag: &str) -> String {
    tag.trim_start_matches('v').to_string()
}

fn asset_matches_platform(asset_name: &str) -> bool {
    #[cfg(target_os = "macos")]
    {
        asset_name.starts_with("vosk-osx-") && asset_name.ends_with(".zip")
    }

    #[cfg(target_os = "windows")]
    {
        asset_name.starts_with("vosk-win64-") && asset_name.ends_with(".zip")
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = asset_name;
        false
    }
}

fn should_extract_runtime_file(filename: &str) -> bool {
    #[cfg(target_os = "macos")]
    {
        filename.eq_ignore_ascii_case("libvosk.dylib")
    }

    #[cfg(target_os = "windows")]
    {
        filename.to_ascii_lowercase().ends_with(".dll")
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = filename;
        false
    }
}

fn platform_dir_name() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "macos"
    }

    #[cfg(target_os = "windows")]
    {
        "windows"
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        "unknown"
    }
}

fn cleanup_old_runtime_versions(base_dir: &Path, keep_version: &str) -> Result<(), String> {
    let entries = fs::read_dir(base_dir)
        .map_err(|e| format!("Failed to list runtime versions for cleanup: {}", e))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read runtime entry: {}", e))?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if name != keep_version {
            fs::remove_dir_all(&path).map_err(|e| {
                format!(
                    "Failed to remove outdated runtime version '{}': {}",
                    name, e
                )
            })?;
        }
    }
    Ok(())
}
