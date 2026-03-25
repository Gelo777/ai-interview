const SERVICE_NAME: &str = "com.ai-interview.app";
const ACCOUNT_NAME: &str = "gemini_api_key";
const LICENSE_KEY_ACCOUNT_NAME: &str = "license_key";
const LICENSE_ACCESS_TOKEN_ACCOUNT_NAME: &str = "license_access_token";

fn get_secret(account_name: &str) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(SERVICE_NAME, account_name)
        .map_err(|e| format!("Failed to initialize secure key entry: {}", e))?;

    match entry.get_password() {
        Ok(password) => {
            let trimmed = password.trim().to_string();
            if trimmed.is_empty() {
                Ok(None)
            } else {
                Ok(Some(trimmed))
            }
        }
        Err(err) => {
            let message = err.to_string().to_lowercase();
            if message.contains("no entry")
                || message.contains("not found")
                || message.contains("no matching")
            {
                Ok(None)
            } else {
                Err(format!(
                    "Failed to read secret from secure storage: {}",
                    err
                ))
            }
        }
    }
}

fn set_secret(account_name: &str, value: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE_NAME, account_name)
        .map_err(|e| format!("Failed to initialize secure key entry: {}", e))?;

    entry
        .set_password(value.trim())
        .map_err(|e| format!("Failed to write secret to secure storage: {}", e))
}

fn delete_secret(account_name: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE_NAME, account_name)
        .map_err(|e| format!("Failed to initialize secure key entry: {}", e))?;

    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(err) => {
            let message = err.to_string().to_lowercase();
            if message.contains("no entry")
                || message.contains("not found")
                || message.contains("no matching")
            {
                Ok(())
            } else {
                Err(format!(
                    "Failed to delete secret from secure storage: {}",
                    err
                ))
            }
        }
    }
}

pub fn get_api_key() -> Result<Option<String>, String> {
    get_secret(ACCOUNT_NAME)
}

pub fn set_api_key(api_key: &str) -> Result<(), String> {
    set_secret(ACCOUNT_NAME, api_key)
}

pub fn get_license_key() -> Result<Option<String>, String> {
    get_secret(LICENSE_KEY_ACCOUNT_NAME)
}

pub fn set_license_key(license_key: &str) -> Result<(), String> {
    set_secret(LICENSE_KEY_ACCOUNT_NAME, license_key)
}

pub fn delete_license_key() -> Result<(), String> {
    delete_secret(LICENSE_KEY_ACCOUNT_NAME)
}

pub fn get_license_access_token() -> Result<Option<String>, String> {
    get_secret(LICENSE_ACCESS_TOKEN_ACCOUNT_NAME)
}

pub fn set_license_access_token(token: &str) -> Result<(), String> {
    set_secret(LICENSE_ACCESS_TOKEN_ACCOUNT_NAME, token)
}

pub fn delete_license_access_token() -> Result<(), String> {
    delete_secret(LICENSE_ACCESS_TOKEN_ACCOUNT_NAME)
}
