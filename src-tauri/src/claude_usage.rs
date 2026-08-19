use serde::Serialize;

fn http_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

#[derive(Debug, Serialize, Clone)]
pub struct UsageWindow {
    pub utilization: f64,
    pub resets_at: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct ClaudeUsage {
    pub five_hour: UsageWindow,
    pub seven_day: UsageWindow,
    pub seven_day_opus: UsageWindow,
}

fn read_credentials_file_with_retry(path: &std::path::Path) -> Option<String> {
    for attempt in 0..3 {
        if attempt > 0 {
            std::thread::sleep(std::time::Duration::from_millis(80));
        }
        let Ok(contents) = std::fs::read_to_string(path) else {
            continue;
        };
        let Ok(json) = serde_json::from_str::<serde_json::Value>(&contents) else {
            continue;
        };
        if let Some(tok) = json
            .get("claudeAiOauth")
            .and_then(|o| o.get("accessToken"))
            .and_then(|v| v.as_str())
        {
            if !tok.is_empty() {
                return Some(tok.to_string());
            }
        }
    }
    None
}

/// Try to find the Claude OAuth token.
fn discover_token() -> Option<String> {
    // 1. Env var
    if let Ok(tok) = std::env::var("CLAUDE_OAUTH_TOKEN") {
        if !tok.is_empty() {
            return Some(tok);
        }
    }

    // 2. ~/.claude/.credentials.json (where Claude Code actually stores it)
    if let Some(home) = dirs_next::home_dir() {
        let cred_path = home.join(".claude").join(".credentials.json");
        if let Some(tok) = read_credentials_file_with_retry(&cred_path) {
            return Some(tok);
        }
    }

    // 3. Keyring (Windows Credential Manager / macOS Keychain).
    //    No macOS o Claude Code grava a entrada com account = username local,

    let service = "Claude Code-credentials";
    let mut usernames: Vec<String> = Vec::new();
    if let Ok(user) = std::env::var("USER").or_else(|_| std::env::var("USERNAME")) {
        if !user.is_empty() {
            usernames.push(user);
        }
    }
    for u in ["default", "user", "claude", ""] {
        usernames.push(u.to_string());
    }
    for username in &usernames {
        if let Ok(entry) = keyring::Entry::new(service, username) {
            if let Ok(secret) = entry.get_password() {
                if secret.is_empty() {
                    continue;
                }
                return Some(extract_token_from_secret(&secret));
            }
        }
    }

    None
}

/// ({"claudeAiOauth":{"accessToken":...}}), como no macOS Keychain.
fn extract_token_from_secret(secret: &str) -> String {
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(secret) {
        if let Some(tok) = json
            .get("claudeAiOauth")
            .and_then(|o| o.get("accessToken"))
            .and_then(|v| v.as_str())
        {
            if !tok.is_empty() {
                return tok.to_string();
            }
        }
    }
    secret.to_string()
}

#[tauri::command]
pub async fn get_claude_usage() -> Result<ClaudeUsage, String> {
    let token = discover_token().ok_or_else(|| "no_token".to_string())?;

    let client = http_client();
    let resp = client
        .get("https://api.anthropic.com/api/oauth/usage")
        .header("Authorization", format!("Bearer {}", token))
        .header("anthropic-beta", "oauth-2025-04-20")
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("API returned {}", resp.status()));
    }

    let body: serde_json::Value = resp.json().await.map_err(|e| format!("json parse: {e}"))?;

    let parse_window = |key: &str| -> UsageWindow {
        let default = UsageWindow {
            utilization: 0.0,
            resets_at: String::new(),
        };
        let Some(obj) = body.get(key) else {
            return default;
        };
        if obj.is_null() {
            return default;
        }
        let utilization = obj
            .get("utilization")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        let resets_at = obj
            .get("resets_at")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        UsageWindow {
            utilization,
            resets_at,
        }
    };

    Ok(ClaudeUsage {
        five_hour: parse_window("five_hour"),
        seven_day: parse_window("seven_day"),
        seven_day_opus: parse_window("seven_day_opus"),
    })
}
