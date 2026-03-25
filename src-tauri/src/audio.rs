use cpal::traits::{DeviceTrait, HostTrait};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct AudioDeviceInfo {
    pub id: String,
    pub name: String,
    pub is_default: bool,
    pub is_input: bool,
    pub sample_rate: u32,
    pub channels: u16,
}

fn resolve_name_from_description(description: &cpal::DeviceDescription) -> Option<String> {
    let mut candidates: Vec<String> = Vec::new();

    for extended in description.extended() {
        let trimmed = extended.trim();
        if !trimmed.is_empty() {
            candidates.push(trimmed.to_string());
        }
    }

    if let Some(driver) = description.driver() {
        let trimmed = driver.trim();
        if !trimmed.is_empty() {
            candidates.push(trimmed.to_string());
        }
    }

    let base_name = description.name().trim();
    if !base_name.is_empty() {
        candidates.push(base_name.to_string());

        if let Some(manufacturer) = description.manufacturer() {
            let manufacturer = manufacturer.trim();
            if !manufacturer.is_empty() && !base_name.contains(manufacturer) {
                candidates.push(format!("{} ({})", base_name, manufacturer));
            }
        }
    }

    candidates
        .into_iter()
        .max_by_key(|candidate| candidate.chars().count())
}

pub fn resolve_device_name(device: &cpal::Device) -> String {
    if let Ok(description) = device.description() {
        if let Some(name) = resolve_name_from_description(&description) {
            return name;
        }
    }

    #[allow(deprecated)]
    if let Ok(name) = device.name() {
        let trimmed = name.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }

    if let Ok(id) = device.id() {
        return id.to_string();
    }

    "Unknown".to_string()
}

pub fn resolve_device_id(device: &cpal::Device) -> String {
    if let Ok(id) = device.id() {
        return id.to_string();
    }

    resolve_device_name(device)
}

fn normalize_device_selector(device_selector: Option<&str>) -> Option<&str> {
    device_selector.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

fn device_matches_selector(device: &cpal::Device, device_selector: &str) -> bool {
    resolve_device_id(device) == device_selector || resolve_device_name(device) == device_selector
}

pub fn find_input_device(device_selector: Option<&str>) -> Option<cpal::Device> {
    let host = cpal::default_host();
    match normalize_device_selector(device_selector) {
        Some(selector) => host
            .input_devices()
            .ok()?
            .find(|device| device_matches_selector(device, selector)),
        None => host.default_input_device(),
    }
}

pub fn find_output_device(device_selector: Option<&str>) -> Option<cpal::Device> {
    let host = cpal::default_host();
    match normalize_device_selector(device_selector) {
        Some(selector) => host
            .output_devices()
            .ok()?
            .find(|device| device_matches_selector(device, selector)),
        None => host.default_output_device(),
    }
}

pub fn resolve_input_device(device_selector: Option<&str>) -> Result<cpal::Device, String> {
    find_input_device(device_selector).ok_or_else(|| {
        match normalize_device_selector(device_selector) {
            Some(selector) => format!("Selected microphone device is not available: {}", selector),
            None => "Microphone input device is not available".to_string(),
        }
    })
}

pub fn resolve_output_device(device_selector: Option<&str>) -> Result<cpal::Device, String> {
    find_output_device(device_selector).ok_or_else(|| {
        match normalize_device_selector(device_selector) {
            Some(selector) => format!("Selected output device is not available: {}", selector),
            None => "Default output device is not available for loopback".to_string(),
        }
    })
}

pub fn list_input_devices() -> Vec<AudioDeviceInfo> {
    let host = cpal::default_host();
    let mut devices = Vec::new();
    let default_input_id = host
        .default_input_device()
        .map(|device| resolve_device_id(&device));

    if let Ok(input_devices) = host.input_devices() {
        for device in input_devices {
            if let Ok(config) = device.default_input_config() {
                let device_id = resolve_device_id(&device);
                devices.push(AudioDeviceInfo {
                    id: device_id.clone(),
                    name: resolve_device_name(&device),
                    is_default: default_input_id.as_deref() == Some(device_id.as_str()),
                    is_input: true,
                    sample_rate: config.sample_rate(),
                    channels: config.channels(),
                });
            }
        }
    }

    devices
}

pub fn list_output_devices() -> Vec<AudioDeviceInfo> {
    let host = cpal::default_host();
    let mut devices = Vec::new();
    let default_output_id = host
        .default_output_device()
        .map(|device| resolve_device_id(&device));

    if let Ok(output_devices) = host.output_devices() {
        for device in output_devices {
            if let Ok(config) = device.default_output_config() {
                let device_id = resolve_device_id(&device);
                devices.push(AudioDeviceInfo {
                    id: device_id.clone(),
                    name: resolve_device_name(&device),
                    is_default: default_output_id.as_deref() == Some(device_id.as_str()),
                    is_input: false,
                    sample_rate: config.sample_rate(),
                    channels: config.channels(),
                });
            }
        }
    }

    devices
}

pub fn has_input_device(device_selector: Option<&str>) -> bool {
    find_input_device(device_selector).is_some()
}

pub fn has_output_device(device_selector: Option<&str>) -> bool {
    find_output_device(device_selector).is_some()
}
