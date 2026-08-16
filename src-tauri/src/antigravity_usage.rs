use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::cli_resolver;

const MODELS_URL: &str =
    "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels";

fn http_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct AntigravityQuotaBucket {
    pub label: String,
    pub models: Vec<String>,
    pub used_percent: f64,
    pub remaining_percent: f64,
    pub resets_at: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct AntigravityUsage {
    /// ready | no_cli | no_auth | unavailable
    pub status: String,
    pub cli_path: String,
    pub used_percent: f64,
    pub rate_limited: bool,
    pub buckets: Vec<AntigravityQuotaBucket>,
}

fn empty_usage(status: &str, cli_path: String) -> AntigravityUsage {
    AntigravityUsage {
        status: status.to_string(),
        cli_path,
        used_percent: 0.0,
        rate_limited: false,
        buckets: Vec::new(),
    }
}

fn parse_token_from_secret(secret: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(secret).ok()?;
    value
        .get("token")
        .and_then(|token| token.get("access_token"))
        .and_then(|token| token.as_str())
        .filter(|token| !token.is_empty())
        .map(str::to_owned)
}

fn extract_token_from_entry(entry: &keyring::Entry) -> Option<String> {
    if let Ok(secret_bytes) = entry.get_secret() {
        if let Ok(secret) = String::from_utf8(secret_bytes) {
            if let Some(token) = parse_token_from_secret(&secret) {
                return Some(token);
            }
        }
    }
    if let Ok(secret) = entry.get_password() {
        if let Some(token) = parse_token_from_secret(&secret) {
            return Some(token);
        }
    }
    None
}

/// O `agy` guarda o envelope OAuth no Credential Manager (Windows) usando o
/// target literal `gemini:antigravity`, enquanto no Linux (Secret Service) e
/// macOS (Keychain) grava com service `gemini` e username `antigravity` sem
/// target explícito. Testamos ambas as formas para compatibilidade cross-platform.
/// Apenas o access token é mantido em memória durante a requisição; nunca
/// persistimos nem registramos o segredo.
fn discover_access_token() -> Option<String> {
    // 1. Target literal `gemini:antigravity` (necessário no Windows Credential Manager)
    if let Ok(entry) =
        keyring::Entry::new_with_target("gemini:antigravity", "gemini", "antigravity")
    {
        if let Some(token) = extract_token_from_entry(&entry) {
            return Some(token);
        }
    }

    // 2. Entrada padrão service + user (Linux Secret Service / macOS Keychain)
    if let Ok(entry) = keyring::Entry::new("gemini", "antigravity") {
        if let Some(token) = extract_token_from_entry(&entry) {
            return Some(token);
        }
    }

    None
}

fn refresh_credential_with_agy(launcher: &std::path::Path) -> bool {
    let mut command = Command::new(launcher);
    command
        .arg("models")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    crate::git_control::hide_console(&mut command);
    let Ok(mut child) = command.spawn() else {
        return false;
    };
    let deadline = Instant::now() + Duration::from_secs(12);
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(_) => break,
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    false
}

enum FetchError {
    Unauthorized,
    Unavailable,
}

async fn fetch_models(token: &str) -> Result<serde_json::Value, FetchError> {
    let response = http_client()
        .post(MODELS_URL)
        .bearer_auth(token)
        .header("User-Agent", "alethe/1.2.5 antigravity-usage")
        .json(&serde_json::json!({}))
        .send()
        .await
        .map_err(|_| FetchError::Unavailable)?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err(FetchError::Unauthorized);
    }
    if !response.status().is_success() {
        return Err(FetchError::Unavailable);
    }
    response
        .json::<serde_json::Value>()
        .await
        .map_err(|_| FetchError::Unavailable)
}

fn bucket_label(models: &BTreeSet<String>) -> String {
    let all_match = |needle: &str| {
        models
            .iter()
            .all(|model| model.to_ascii_lowercase().contains(needle))
    };
    if all_match("gemini") {
        "Gemini".to_string()
    } else if all_match("claude") {
        "Claude".to_string()
    } else if all_match("gpt") {
        "GPT".to_string()
    } else {
        models
            .iter()
            .next()
            .cloned()
            .unwrap_or_else(|| "Other".to_string())
    }
}

fn parse_usage(body: &serde_json::Value, cli_path: String) -> Result<AntigravityUsage, String> {
    let models = body
        .get("models")
        .and_then(|models| models.as_object())
        .ok_or_else(|| "models_missing".to_string())?;

    let mut grouped: BTreeMap<(u64, String), BTreeSet<String>> = BTreeMap::new();
    for (model_id, model) in models {
        let Some(quota) = model.get("quotaInfo") else {
            continue;
        };
        let Some(remaining) = quota.get("remainingFraction").and_then(|v| v.as_f64()) else {
            continue;
        };
        let display_name = model
            .get("displayName")
            .and_then(|v| v.as_str())
            .filter(|name| !name.trim().is_empty())
            .unwrap_or(model_id)
            .trim()
            .to_string();
        let reset = quota
            .get("resetTime")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let normalized = remaining.clamp(0.0, 1.0);
        let fraction_key = (normalized * 1_000_000.0).round() as u64;
        grouped
            .entry((fraction_key, reset))
            .or_default()
            .insert(display_name);
    }

    let mut buckets = grouped
        .into_iter()
        .map(|((fraction_key, resets_at), models)| {
            let remaining_percent = fraction_key as f64 / 10_000.0;
            AntigravityQuotaBucket {
                label: bucket_label(&models),
                models: models.into_iter().collect(),
                used_percent: (100.0 - remaining_percent).clamp(0.0, 100.0),
                remaining_percent,
                resets_at,
            }
        })
        .collect::<Vec<_>>();
    buckets.sort_by(|a, b| {
        b.used_percent
            .total_cmp(&a.used_percent)
            .then_with(|| a.label.cmp(&b.label))
    });

    if buckets.is_empty() {
        return Err("quota_missing".to_string());
    }

    let used_percent = buckets
        .iter()
        .map(|bucket| bucket.used_percent)
        .fold(0.0, f64::max);

    Ok(AntigravityUsage {
        status: "ready".to_string(),
        cli_path,
        used_percent,
        rate_limited: used_percent >= 99.9,
        buckets,
    })
}

#[tauri::command]
pub async fn get_antigravity_usage() -> Result<AntigravityUsage, String> {
    let Some(launcher) = cli_resolver::find_windows_cli_launcher("agy") else {
        return Ok(empty_usage("no_cli", String::new()));
    };
    let cli_path = launcher.to_string_lossy().to_string();
    let Some(mut token) = discover_access_token() else {
        return Ok(empty_usage("no_auth", cli_path));
    };

    let body = match fetch_models(&token).await {
        Ok(body) => body,
        Err(FetchError::Unauthorized) => {
            let refresh_launcher = launcher.clone();
            let refreshed =
                tokio::task::spawn_blocking(move || refresh_credential_with_agy(&refresh_launcher))
                    .await
                    .unwrap_or(false);
            if !refreshed {
                return Ok(empty_usage("no_auth", cli_path));
            }
            let Some(fresh_token) = discover_access_token() else {
                return Ok(empty_usage("no_auth", cli_path));
            };
            token = fresh_token;
            match fetch_models(&token).await {
                Ok(body) => body,
                Err(FetchError::Unauthorized) => return Ok(empty_usage("no_auth", cli_path)),
                Err(FetchError::Unavailable) => return Ok(empty_usage("unavailable", cli_path)),
            }
        }
        Err(FetchError::Unavailable) => return Ok(empty_usage("unavailable", cli_path)),
    };
    Ok(parse_usage(&body, cli_path)
        .unwrap_or_else(|_| empty_usage("unavailable", launcher.to_string_lossy().to_string())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn groups_models_by_real_quota_bucket_and_picks_most_used() {
        let body = serde_json::json!({
            "models": {
                "gemini-high": {
                    "displayName": "Gemini High",
                    "quotaInfo": { "remainingFraction": 0.25, "resetTime": "2026-07-26T01:00:00Z" }
                },
                "gemini-low": {
                    "displayName": "Gemini Low",
                    "quotaInfo": { "remainingFraction": 0.25, "resetTime": "2026-07-26T01:00:00Z" }
                },
                "claude": {
                    "displayName": "Claude Sonnet",
                    "quotaInfo": { "remainingFraction": 0.8, "resetTime": "2026-07-26T02:00:00Z" }
                }
            }
        });
        let usage = parse_usage(&body, "agy.exe".to_string()).unwrap();

        assert_eq!(usage.buckets.len(), 2);
        assert_eq!(usage.buckets[0].label, "Gemini");
        assert_eq!(usage.buckets[0].models, vec!["Gemini High", "Gemini Low"]);
        assert_eq!(usage.used_percent, 75.0);
        assert!(!usage.rate_limited);
    }

    #[test]
    fn treats_nearly_empty_bucket_as_rate_limited() {
        let body = serde_json::json!({
            "models": {
                "gemini": {
                    "displayName": "Gemini",
                    "quotaInfo": { "remainingFraction": 0.0005, "resetTime": "soon" }
                }
            }
        });
        let usage = parse_usage(&body, "agy.exe".to_string()).unwrap();
        assert_eq!(usage.used_percent, 99.95);
        assert!(usage.rate_limited);
    }

    #[test]
    fn parses_access_token_from_secret_json() {
        let secret = r#"{"token":{"access_token":"ya29.sample-token-123","token_type":"Bearer"},"auth_method":"consumer"}"#;
        assert_eq!(
            parse_token_from_secret(secret),
            Some("ya29.sample-token-123".to_string())
        );
    }

    #[test]
    fn rejects_invalid_secret_json() {
        assert_eq!(parse_token_from_secret("not-json"), None);
        assert_eq!(parse_token_from_secret(r#"{"token":{}}"#), None);
        assert_eq!(
            parse_token_from_secret(r#"{"token":{"access_token":""}}"#),
            None
        );
    }

    #[test]
    fn live_token_discovery_returns_option() {
        // Doesn't panic in headless/any environment; returns Some if credentials exist in keyring.
        let token = discover_access_token();
        if let Some(tok) = token {
            assert!(!tok.is_empty());
        }
    }
}
