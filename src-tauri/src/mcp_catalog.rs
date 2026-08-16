use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

const REGISTRY_URL: &str = "https://registry.modelcontextprotocol.io/v0/servers";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_CACHED_QUERIES: usize = 20;

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn client() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .user_agent(concat!("Alethe/", env!("CARGO_PKG_VERSION")))
            .build()
            .unwrap_or_default()
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpEnvHint {
    pub name: String,
    pub description: Option<String>,
    pub default: Option<String>,
    pub secret: bool,
    pub required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpInstallOption {
    /// `stdio`, `http` or `sse` — matches the transport kinds the adapters understand.
    pub kind: String,
    pub label: String,
    pub command: Option<String>,
    pub args: Vec<String>,
    pub url: Option<String>,
    pub env: Vec<McpEnvHint>,
    pub headers: Vec<McpEnvHint>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCatalogEntry {
    pub id: String,
    pub suggested_name: String,
    pub title: String,
    pub description: String,
    pub version: String,
    pub repository_url: Option<String>,
    pub installs: Vec<McpInstallOption>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpRegistryPage {
    pub entries: Vec<McpCatalogEntry>,
    pub next_cursor: Option<String>,
    /// Set when the network failed and this page came from the on-disk copy.
    pub stale_since: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedPage {
    fetched_at: u64,
    page: McpRegistryPage,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistryCache {
    #[serde(default)]
    queries: BTreeMap<String, CachedPage>,
}

fn cache_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    Some(
        crate::paths::profile_data_dir(app)
            .ok()?
            .join("mcp")
            .join("registry-cache.json"),
    )
}

fn read_cache(app: &tauri::AppHandle) -> RegistryCache {
    cache_path(app)
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn write_cache(app: &tauri::AppHandle, cache: &RegistryCache) {
    let Some(path) = cache_path(app) else {
        return;
    };
    if let Some(parent) = path.parent() {
        if fs::create_dir_all(parent).is_err() {
            return;
        }
    }
    if let Ok(raw) = serde_json::to_string(cache) {
        let _ = fs::write(path, raw);
    }
}

fn text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_string)
}

/// Registry ids look like `com.pulsemcp/playwright-stealth`; agents want a short,
/// filename-safe handle.
fn suggested_name(id: &str) -> String {
    let tail = id.rsplit(['/', '.']).next().unwrap_or(id);
    let cleaned: String = tail
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches('-').to_ascii_lowercase();
    if trimmed.is_empty() {
        "mcp-server".to_string()
    } else {
        trimmed
    }
}

fn env_hints(value: Option<&Value>) -> Vec<McpEnvHint> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let name = text(item, "name")?;
                    Some(McpEnvHint {
                        name,
                        description: text(item, "description"),
                        default: text(item, "default"),
                        secret: item
                            .get("isSecret")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                        required: item
                            .get("isRequired")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Registry arguments are either positional (`value`) or named (`name` plus optional `value`).
fn argument_values(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .flat_map(|item| {
                    let named = text(item, "name");
                    let literal = text(item, "value").or_else(|| text(item, "default"));
                    match (named, literal) {
                        (Some(name), Some(literal)) => vec![name, literal],
                        (Some(name), None) => vec![name],
                        (None, Some(literal)) => vec![literal],
                        (None, None) => Vec::new(),
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

fn runtime_for(registry_type: &str, hint: Option<&str>) -> Option<&'static str> {
    match hint {
        Some("npx") => Some("npx"),
        Some("uvx") => Some("uvx"),
        Some("docker") => Some("docker"),
        Some("dnx") => Some("dnx"),
        _ => match registry_type {
            "npm" => Some("npx"),
            "pypi" => Some("uvx"),
            "oci" => Some("docker"),
            "nuget" => Some("dnx"),
            _ => None,
        },
    }
}

fn package_install(package: &Value) -> Option<McpInstallOption> {
    let identifier = text(package, "identifier")?;
    let registry_type = text(package, "registryType").unwrap_or_default();
    let runtime = runtime_for(&registry_type, text(package, "runtimeHint").as_deref())?;

    let mut args = argument_values(package.get("runtimeArguments"));
    let version = text(package, "version");
    args.push(match (&registry_type[..], version.as_deref()) {
        ("npm", Some(version)) => format!("{identifier}@{version}"),
        _ => identifier.clone(),
    });
    args.extend(argument_values(package.get("packageArguments")));

    // A package declaring a remote transport has no URL here — its `remotes` entry covers it.
    let transport = package
        .get("transport")
        .and_then(|transport| text(transport, "type"))
        .unwrap_or_else(|| "stdio".to_string());
    if transport != "stdio" {
        return None;
    }

    Some(McpInstallOption {
        kind: "stdio".to_string(),
        label: format!("{runtime} {identifier}"),
        command: Some(runtime.to_string()),
        args,
        url: None,
        env: env_hints(package.get("environmentVariables")),
        headers: Vec::new(),
    })
}

fn remote_install(remote: &Value) -> Option<McpInstallOption> {
    let url = text(remote, "url")?;
    let declared = text(remote, "type").unwrap_or_default();
    let kind = if declared == "sse" { "sse" } else { "http" };
    Some(McpInstallOption {
        kind: kind.to_string(),
        label: url.clone(),
        command: None,
        args: Vec::new(),
        url: Some(url),
        env: Vec::new(),
        headers: env_hints(remote.get("headers")),
    })
}

fn entry_from(server: &Value, meta: Option<&Value>) -> Option<McpCatalogEntry> {
    let id = text(server, "name")?;
    let title = meta
        .and_then(|meta| meta.get("io.modelcontextprotocol.registry/publisher-provided"))
        .and_then(|provided| text(provided, "title"))
        .or_else(|| text(server, "title"))
        .unwrap_or_else(|| id.clone());

    let mut installs: Vec<McpInstallOption> = server
        .get("remotes")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(remote_install).collect())
        .unwrap_or_default();
    installs.extend(
        server
            .get("packages")
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(package_install).collect::<Vec<_>>())
            .unwrap_or_default(),
    );
    if installs.is_empty() {
        return None;
    }

    Some(McpCatalogEntry {
        suggested_name: suggested_name(&id),
        title,
        description: text(server, "description").unwrap_or_default(),
        version: text(server, "version").unwrap_or_default(),
        repository_url: server
            .get("repository")
            .and_then(|repository| text(repository, "url")),
        installs,
        id,
    })
}

fn page_from(body: &Value) -> McpRegistryPage {
    let entries = body
        .get("servers")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| entry_from(item.get("server")?, item.get("_meta")))
                .collect()
        })
        .unwrap_or_default();

    McpRegistryPage {
        entries,
        next_cursor: body
            .get("metadata")
            .and_then(|metadata| text(metadata, "nextCursor")),
        stale_since: None,
    }
}

async fn fetch_page(
    query: Option<String>,
    cursor: Option<String>,
    limit: Option<u32>,
) -> Result<McpRegistryPage, String> {
    let mut request = client()
        .get(REGISTRY_URL)
        .query(&[("version", "latest")])
        .query(&[("limit", limit.unwrap_or(30).clamp(1, 100).to_string())]);
    if let Some(query) = query.as_deref().map(str::trim).filter(|q| !q.is_empty()) {
        request = request.query(&[("search", query)]);
    }
    if let Some(cursor) = cursor.as_deref().filter(|c| !c.is_empty()) {
        request = request.query(&[("cursor", cursor)]);
    }

    let response = request
        .send()
        .await
        .map_err(|_| "registry_offline".to_string())?;
    if !response.status().is_success() {
        return Err(format!("registry_status:{}", response.status().as_u16()));
    }
    let body: Value = response
        .json()
        .await
        .map_err(|_| "registry_malformed".to_string())?;
    Ok(page_from(&body))
}

#[tauri::command]
pub async fn mcp_registry_search(
    app: tauri::AppHandle,
    query: Option<String>,
    cursor: Option<String>,
    limit: Option<u32>,
) -> Result<McpRegistryPage, String> {
    let key = query
        .as_deref()
        .map(str::trim)
        .unwrap_or_default()
        .to_ascii_lowercase();

    match fetch_page(query, cursor.clone(), limit).await {
        Ok(page) => {
            // Only the first page of a query is worth keeping for the offline case.
            if cursor.is_none() {
                let handle = app.clone();
                let cached = CachedPage {
                    fetched_at: crate::provider_common::now_ms(),
                    page: page.clone(),
                };
                let key = key.clone();
                let _ = tokio::task::spawn_blocking(move || {
                    let mut cache = read_cache(&handle);
                    cache.queries.insert(key, cached);
                    while cache.queries.len() > MAX_CACHED_QUERIES {
                        if let Some(oldest) = cache
                            .queries
                            .iter()
                            .min_by_key(|(_, entry)| entry.fetched_at)
                            .map(|(name, _)| name.clone())
                        {
                            cache.queries.remove(&oldest);
                        } else {
                            break;
                        }
                    }
                    write_cache(&handle, &cache);
                })
                .await;
            }
            Ok(page)
        }
        Err(error) => {
            if cursor.is_some() {
                return Err(error);
            }
            let handle = app.clone();
            let cached =
                tokio::task::spawn_blocking(move || read_cache(&handle).queries.get(&key).cloned())
                    .await
                    .map_err(|_| error.clone())?;
            match cached {
                Some(entry) => Ok(McpRegistryPage {
                    stale_since: Some(entry.fetched_at),
                    ..entry.page
                }),
                None => Err(error),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PACKAGE_SERVER: &str = r#"{
      "name": "com.pulsemcp/playwright-stealth",
      "description": "Browser automation using Playwright.",
      "version": "0.2.3",
      "repository": { "url": "https://github.com/pulsemcp/mcp-servers", "source": "github" },
      "packages": [
        {
          "registryType": "npm",
          "identifier": "playwright-stealth-mcp-server",
          "version": "0.2.3",
          "runtimeHint": "npx",
          "transport": { "type": "stdio" },
          "runtimeArguments": [ { "value": "-y", "type": "positional" } ],
          "environmentVariables": [
            { "name": "PROXY_PASSWORD", "description": "Proxy password.", "isSecret": true },
            { "name": "HEADLESS", "default": "true" }
          ]
        }
      ]
    }"#;

    const REMOTE_SERVER: &str = r#"{
      "name": "com.clauxel.guard/guard-mcp",
      "description": "Selector risk checks.",
      "version": "1.0.0",
      "remotes": [
        {
          "type": "streamable-http",
          "url": "https://guard.example.com/mcp",
          "headers": [ { "name": "Authorization", "description": "Bearer token." } ]
        }
      ]
    }"#;

    fn parse(raw: &str) -> McpCatalogEntry {
        let value: Value = serde_json::from_str(raw).expect("fixture");
        entry_from(&value, None).expect("entry")
    }

    #[test]
    fn an_npm_package_becomes_a_runnable_npx_command() {
        let entry = parse(PACKAGE_SERVER);
        assert_eq!(entry.suggested_name, "playwright-stealth");
        assert_eq!(entry.installs.len(), 1);

        let install = &entry.installs[0];
        assert_eq!(install.kind, "stdio");
        assert_eq!(install.command.as_deref(), Some("npx"));
        assert_eq!(
            install.args,
            vec![
                "-y".to_string(),
                "playwright-stealth-mcp-server@0.2.3".to_string()
            ]
        );
    }

    #[test]
    fn environment_hints_carry_the_secret_flag() {
        let install = &parse(PACKAGE_SERVER).installs[0];
        let secret = install
            .env
            .iter()
            .find(|hint| hint.name == "PROXY_PASSWORD")
            .expect("hint");
        assert!(secret.secret);

        let plain = install
            .env
            .iter()
            .find(|hint| hint.name == "HEADLESS")
            .expect("hint");
        assert!(!plain.secret);
        assert_eq!(plain.default.as_deref(), Some("true"));
    }

    #[test]
    fn a_remote_becomes_an_http_option_with_its_headers() {
        let entry = parse(REMOTE_SERVER);
        let install = &entry.installs[0];
        assert_eq!(install.kind, "http");
        assert_eq!(
            install.url.as_deref(),
            Some("https://guard.example.com/mcp")
        );
        assert_eq!(install.headers.len(), 1);
        assert_eq!(install.headers[0].name, "Authorization");
        assert!(install.command.is_none());
    }

    #[test]
    fn a_server_with_no_installable_option_is_dropped() {
        let value: Value =
            serde_json::from_str(r#"{"name":"x/y","version":"1"}"#).expect("fixture");
        assert!(entry_from(&value, None).is_none());
    }

    #[test]
    fn suggested_names_stay_filename_safe() {
        assert_eq!(
            suggested_name("com.pulsemcp/playwright-stealth"),
            "playwright-stealth"
        );
        assert_eq!(suggested_name("ac.inference.sh/mcp"), "mcp");
        assert_eq!(suggested_name("weird name!!"), "weird-name");
        assert_eq!(suggested_name("///"), "mcp-server");
    }

    #[test]
    fn a_page_keeps_its_cursor_and_skips_unusable_servers() {
        let body: Value = serde_json::from_str(&format!(
            r#"{{"servers":[{{"server":{PACKAGE_SERVER}}},{{"server":{{"name":"x/y"}}}}],
                "metadata":{{"nextCursor":"abc:1.0"}}}}"#
        ))
        .expect("fixture");
        let page = page_from(&body);
        assert_eq!(page.entries.len(), 1);
        assert_eq!(page.next_cursor.as_deref(), Some("abc:1.0"));
        assert!(page.stale_since.is_none());
    }
}
