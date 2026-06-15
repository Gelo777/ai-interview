use serde::Serialize;
use std::process::Command;

#[derive(Clone, Serialize)]
pub struct DeviceIdentity {
    pub fingerprint: String,
    pub name: String,
}

pub fn resolve() -> DeviceIdentity {
    let name = resolve_device_name();
    let seed = platform_machine_seed().unwrap_or_else(|| fallback_machine_seed(&name));

    DeviceIdentity {
        fingerprint: hash_seed(&seed),
        name,
    }
}

fn resolve_device_name() -> String {
    std::env::var("COMPUTERNAME")
        .ok()
        .or_else(|| std::env::var("HOSTNAME").ok())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "unknown-device".to_string())
}

#[cfg(target_os = "windows")]
fn platform_machine_seed() -> Option<String> {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let output = Command::new("reg")
        .args([
            "query",
            r"HKLM\SOFTWARE\Microsoft\Cryptography",
            "/v",
            "MachineGuid",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        let parts = line.split_whitespace().collect::<Vec<_>>();
        if parts.len() >= 3 && parts[0].eq_ignore_ascii_case("MachineGuid") {
            return parts
                .last()
                .map(|value| format!("windows-machine-guid:{}", value));
        }
    }

    None
}

#[cfg(not(target_os = "windows"))]
fn platform_machine_seed() -> Option<String> {
    None
}

fn fallback_machine_seed(device_name: &str) -> String {
    let user = std::env::var("USERNAME")
        .ok()
        .or_else(|| std::env::var("USER").ok())
        .unwrap_or_default();
    let domain = std::env::var("USERDOMAIN").ok().unwrap_or_default();

    format!(
        "fallback:{}:{}:{}:{}:{}",
        std::env::consts::OS,
        std::env::consts::ARCH,
        domain,
        user,
        device_name
    )
}

fn hash_seed(seed: &str) -> String {
    // FNV-1a 128-bit keeps the raw machine id out of API traffic without
    // introducing another native dependency into the Tauri bundle.
    const FNV_OFFSET: u128 = 0x6c62272e07bb014262b821756295c58d;
    const FNV_PRIME: u128 = 0x0000000001000000000000000000013b;

    let mut hash = FNV_OFFSET;
    for byte in seed.as_bytes() {
        hash ^= *byte as u128;
        hash = hash.wrapping_mul(FNV_PRIME);
    }

    format!("aidev1-{hash:032x}")
}
