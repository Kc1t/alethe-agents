use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Debug, Serialize)]
pub struct KimiUsageWindow {
    pub label: String,
    pub used_percent: f64,
    pub resets_at: String,
}

#[derive(Debug, Serialize)]
pub struct KimiUsage {
    pub status: String,
    pub windows: Vec<KimiUsageWindow>,
}

fn empty(status: &str) -> KimiUsage {
    KimiUsage {
        status: status.into(),
        windows: vec![],
    }
}

fn parse_usage(payload: &Value) -> KimiUsage {
    let windows = [
        "limit_5h",
        "limit_7d",
        "limit_month_total",
        "limit_month_code",
    ]
    .into_iter()
    .filter_map(|label| {
        let entry = &payload["usages"][label];
        let ratio = entry["used_ratio"]
            .as_f64()
            .or_else(|| entry["used_ratio"].as_str()?.parse::<f64>().ok())?;
        if !ratio.is_finite() || ratio < 0.0 {
            return None;
        }
        Some(KimiUsageWindow {
            label: label.into(),
            used_percent: ratio * 100.0,
            resets_at: entry["reset_time"].as_str().unwrap_or_default().into(),
        })
    })
    .collect::<Vec<_>>();
    KimiUsage {
        status: if windows.is_empty() {
            "unavailable"
        } else {
            "ready"
        }
        .into(),
        windows,
    }
}

fn home() -> Option<PathBuf> {
    std::env::var_os("KIMI_CODE_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs_next::home_dir().map(|p| p.join(".kimi-code")))
}

fn trusted_base(base: &str) -> bool {
    matches!(
        base.trim_end_matches('/'),
        "https://api.kimi.com/coding/v1" | "https://api.kimi.ai/coding/v1"
    )
}

#[tauri::command]
pub async fn get_kimi_usage() -> Result<KimiUsage, String> {
    // Serialize token renewal and never expose credentials to the webview.
    static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = LOCK.lock().await;
    let Some(home) = home() else {
        return Ok(empty("no_auth"));
    };
    let config = tokio::fs::read_to_string(home.join("config.toml"))
        .await
        .unwrap_or_default();
    let Ok(config) = config.parse::<toml_edit::DocumentMut>() else {
        return Ok(empty("no_auth"));
    };
    let Some(provider) = config
        .get("providers")
        .and_then(|v| v.get("managed:kimi-code"))
    else {
        return Ok(empty("no_auth"));
    };
    let base = provider
        .get("base_url")
        .and_then(toml_edit::Item::as_str)
        .unwrap_or("https://api.kimi.com/coding/v1");
    if !trusted_base(base) {
        return Ok(empty("unavailable"));
    }
    let oauth = provider.get("oauth");
    let key = oauth
        .and_then(|v| v.get("key"))
        .and_then(toml_edit::Item::as_str)
        .unwrap_or("oauth/kimi-code");
    let name = key.strip_prefix("oauth/").unwrap_or(key);
    if name.is_empty()
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Ok(empty("no_auth"));
    }
    let path = home.join("credentials").join(format!("{name}.json"));
    let original = tokio::fs::read_to_string(&path).await.unwrap_or_default();
    let credentials = serde_json::from_str::<Value>(&original).ok();
    let mut token = credentials
        .as_ref()
        .and_then(|v| v["access_token"].as_str())
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
        .or_else(|| {
            provider
                .get("api_key")
                .and_then(toml_edit::Item::as_str)
                .filter(|v| !v.is_empty())
                .map(str::to_owned)
        })
        .or_else(|| std::env::var("KIMI_API_KEY").ok().filter(|v| !v.is_empty()));
    if token.is_none() {
        return Ok(empty("no_auth"));
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Kimi HTTP client unavailable")?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    if let Some(mut credentials) = credentials {
        if credentials["expires_at"]
            .as_u64()
            .is_some_and(|expiry| expiry <= now + 60)
        {
            let host = oauth
                .and_then(|v| v.get("oauth_host"))
                .and_then(toml_edit::Item::as_str)
                .unwrap_or(if base.contains("kimi.ai") {
                    "https://auth.kimi.ai"
                } else {
                    "https://auth.kimi.com"
                });
            if !matches!(
                host.trim_end_matches('/'),
                "https://auth.kimi.ai" | "https://auth.kimi.com"
            ) {
                return Ok(empty("no_auth"));
            }
            let Some(refresh) = credentials["refresh_token"].as_str() else {
                return Ok(empty("no_auth"));
            };
            let response = client
                .post(format!("{}/api/oauth/token", host.trim_end_matches('/')))
                .form(&[
                    ("client_id", "17e5f671-d194-4dfb-9706-5516cb48c098"),
                    ("grant_type", "refresh_token"),
                    ("refresh_token", refresh),
                ])
                .send()
                .await
                .map_err(|_| "Kimi token renewal request failed")?;
            if !response.status().is_success() {
                return Ok(empty("no_auth"));
            }
            let renewed: Value = response
                .json()
                .await
                .map_err(|_| "Invalid Kimi token renewal response")?;
            let Some(access) = renewed["access_token"].as_str().filter(|v| !v.is_empty()) else {
                return Ok(empty("no_auth"));
            };
            token = Some(access.into());
            credentials["access_token"] = renewed["access_token"].clone();
            if renewed["refresh_token"].as_str().is_some() {
                credentials["refresh_token"] = renewed["refresh_token"].clone();
            }
            credentials["expires_at"] =
                Value::from(now + renewed["expires_in"].as_u64().unwrap_or(900));
            // Preserve a concurrent CLI renewal rather than overwriting its newer credentials.
            if tokio::fs::read_to_string(&path).await.ok().as_deref() == Some(original.as_str()) {
                let temporary = path.with_extension(format!("alethe-{}.tmp", std::process::id()));
                let bytes = serde_json::to_vec(&credentials)
                    .map_err(|_| "Kimi credential serialization failed")?;
                #[cfg(unix)]
                {
                    use std::io::Write;
                    use std::os::unix::fs::OpenOptionsExt;
                    let mut file = std::fs::OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .mode(0o600)
                        .open(&temporary)
                        .map_err(|_| "Kimi credential update failed")?;
                    file.write_all(&bytes)
                        .map_err(|_| "Kimi credential update failed")?;
                }
                #[cfg(not(unix))]
                tokio::fs::write(&temporary, bytes)
                    .await
                    .map_err(|_| "Kimi credential update failed")?;
                tokio::fs::rename(&temporary, &path)
                    .await
                    .map_err(|_| "Kimi credential replacement failed")?;
            }
        }
    }
    let response = client
        .get(format!("{}/usages", base.trim_end_matches('/')))
        .bearer_auth(token.unwrap_or_default())
        .send()
        .await
        .map_err(|_| "Kimi usage request failed")?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Ok(empty("no_auth"));
    }
    if !response.status().is_success() {
        return Ok(empty("unavailable"));
    }
    let payload: Value = response
        .json()
        .await
        .map_err(|_| "Invalid Kimi usage response")?;
    Ok(parse_usage(&payload))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    #[ignore = "Requires an existing Kimi login and network access"]
    async fn reads_live_account_quota() {
        let usage = get_kimi_usage().await.expect("Kimi usage request succeeds");
        assert_eq!(usage.status, "ready");
        assert!(!usage.windows.is_empty());
        assert!(usage
            .windows
            .iter()
            .all(|window| window.used_percent.is_finite()));
    }
    #[test]
    fn parses_live_quota_ratios_and_reset_times() {
        let usage = parse_usage(&serde_json::json!({"usages": {
            "limit_5h": {"used_ratio": 0.25, "reset_time": "2026-09-27T00:00:00Z"},
            "limit_7d": {"used_ratio": "0.75"},
            "limit_month_code": {"used_ratio": 1.2}
        }}));
        assert_eq!(usage.status, "ready");
        assert_eq!(usage.windows.len(), 3);
        assert_eq!(usage.windows[0].used_percent, 25.0);
        assert_eq!(usage.windows[1].used_percent, 75.0);
        assert_eq!(usage.windows[2].used_percent, 120.0);
    }
    #[test]
    fn missing_quota_is_unavailable_instead_of_zero() {
        assert_eq!(parse_usage(&serde_json::json!({})).status, "unavailable");
        assert!(!trusted_base("https://example.com/coding/v1"));
    }
}
