//! Hugging Face API access for the model search: fixed hosts, allowlisted authors, parsed JSON.

use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};

use super::detect::RepoFile;

/// The sherpa-onnx maintainers. Fixed here, not configurable from the UI.
pub const ALLOWED_AUTHORS: &[&str] = &["csukuangfj", "csukuangfj2", "k2-fsa"];

const BASE: &str = "https://huggingface.co";
const READ_TIMEOUT: Duration = Duration::from_secs(30);

/// Error codes the frontend maps to messages.
pub const OFFLINE: &str = "hub_offline";
pub const RATE_LIMITED: &str = "hub_rate_limited";
pub const UNAVAILABLE: &str = "hub_unavailable";
pub const BAD_RESPONSE: &str = "hub_bad_response";
pub const INCOMPATIBLE: &str = "hub_incompatible";
pub const TOO_LARGE: &str = "hub_too_large";
pub const GATED: &str = "hub_gated";
pub const UNKNOWN_REPO: &str = "hub_unknown_repo";

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub repo: String,
    pub likes: u64,
    pub downloads: u64,
    pub last_modified: Option<String>,
    pub license: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RepoInfo {
    pub hit: SearchHit,
    pub commit: String,
}

pub fn valid_repo(repo: &str) -> bool {
    let Some((author, name)) = repo.split_once('/') else {
        return false;
    };
    ALLOWED_AUTHORS.contains(&author)
        && !name.is_empty()
        && name.len() <= 96
        && !name.contains("..")
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

pub fn valid_commit(commit: &str) -> bool {
    commit.len() == 40 && commit.chars().all(|c| c.is_ascii_hexdigit())
}

pub fn allowed_host(host: &str) -> bool {
    host == "huggingface.co"
        || host.ends_with(".huggingface.co")
        || host == "hf.co"
        || host.ends_with(".hf.co")
}

/// HTTPS client that follows at most 5 redirects, all within Hugging Face hosts.
pub fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .read_timeout(READ_TIMEOUT)
        .connect_timeout(Duration::from_secs(15))
        .user_agent(concat!("Alethe/", env!("CARGO_PKG_VERSION")))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let allowed = attempt.url().scheme() == "https"
                && attempt.url().host_str().is_some_and(allowed_host);
            if attempt.previous().len() >= 5 {
                attempt.error("too many redirects")
            } else if allowed {
                attempt.follow()
            } else {
                attempt.error("redirect outside Hugging Face")
            }
        }))
        .build()
        .map_err(|e| format!("hub client: {e}"))
}

pub fn search_url(author: &str, term: &str) -> String {
    let params = [
        ("author", author),
        ("search", term),
        ("limit", "500"),
        ("sort", "likes"),
        ("direction", "-1"),
        ("expand[]", "likes"),
        ("expand[]", "downloads"),
        ("expand[]", "lastModified"),
        ("expand[]", "cardData"),
        ("expand[]", "gated"),
        ("expand[]", "private"),
    ];
    reqwest::Url::parse_with_params(&format!("{BASE}/api/models"), &params)
        .map(String::from)
        .unwrap_or_default()
}

pub fn model_url(repo: &str) -> String {
    format!("{BASE}/api/models/{repo}")
}

pub fn tree_url(repo: &str, commit: &str) -> String {
    format!("{BASE}/api/models/{repo}/tree/{commit}?recursive=true")
}

/// `path` passed `safe_path`, so its characters need no escaping in a URL path.
pub fn resolve_url(repo: &str, commit: &str, path: &str) -> String {
    format!("{BASE}/{repo}/resolve/{commit}/{path}")
}

#[derive(Deserialize)]
struct ApiModel {
    id: String,
    #[serde(default)]
    likes: u64,
    #[serde(default)]
    downloads: u64,
    #[serde(default, rename = "lastModified")]
    last_modified: Option<String>,
    #[serde(default, rename = "cardData")]
    card_data: Option<CardData>,
    /// `false`, or `"auto"` / `"manual"` for a gated repo.
    #[serde(default)]
    gated: serde_json::Value,
    #[serde(default)]
    private: bool,
    #[serde(default)]
    sha: Option<String>,
}

#[derive(Deserialize)]
struct CardData {
    #[serde(default)]
    license: Option<serde_json::Value>,
}

impl ApiModel {
    fn open(&self) -> bool {
        !self.private
            && matches!(
                self.gated,
                serde_json::Value::Null | serde_json::Value::Bool(false)
            )
    }

    fn hit(&self) -> SearchHit {
        let license = self
            .card_data
            .as_ref()
            .and_then(|c| c.license.as_ref())
            .and_then(|value| match value {
                serde_json::Value::String(s) => Some(s.clone()),
                serde_json::Value::Array(list) => {
                    list.iter().find_map(|v| v.as_str().map(str::to_string))
                }
                _ => None,
            });
        SearchHit {
            repo: self.id.clone(),
            likes: self.likes,
            downloads: self.downloads,
            last_modified: self.last_modified.clone(),
            license,
        }
    }
}

pub fn parse_search(body: &str) -> Result<Vec<SearchHit>, String> {
    let models: Vec<ApiModel> = serde_json::from_str(body).map_err(|_| BAD_RESPONSE.to_string())?;
    Ok(models
        .iter()
        .filter(|m| m.open() && valid_repo(&m.id))
        .map(ApiModel::hit)
        .collect())
}

pub fn parse_model(body: &str) -> Result<RepoInfo, String> {
    let model: ApiModel = serde_json::from_str(body).map_err(|_| BAD_RESPONSE.to_string())?;
    if !model.open() {
        return Err(GATED.into());
    }
    let commit = model
        .sha
        .clone()
        .filter(|sha| valid_commit(sha))
        .ok_or_else(|| BAD_RESPONSE.to_string())?;
    if !valid_repo(&model.id) {
        return Err(UNKNOWN_REPO.into());
    }
    Ok(RepoInfo {
        hit: model.hit(),
        commit,
    })
}

#[derive(Deserialize)]
struct TreeEntry {
    #[serde(rename = "type")]
    kind: String,
    path: String,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    oid: Option<String>,
    #[serde(default)]
    lfs: Option<Lfs>,
}

#[derive(Deserialize)]
struct Lfs {
    oid: String,
}

/// Files only. An LFS file keeps its SHA-256; any other file its git blob SHA-1 (the `oid` of an
/// LFS file is the pointer's, so it is not kept). Unsafe paths stay in the list; the detector
/// decides whether they matter.
pub fn parse_tree(body: &str) -> Result<Vec<RepoFile>, String> {
    let entries: Vec<TreeEntry> =
        serde_json::from_str(body).map_err(|_| BAD_RESPONSE.to_string())?;
    Ok(entries
        .into_iter()
        .filter(|entry| entry.kind == "file")
        .map(|entry| match entry.lfs {
            Some(lfs) => RepoFile {
                path: entry.path,
                size: entry.size,
                sha256: Some(lfs.oid),
                git_sha1: None,
            },
            None => RepoFile {
                path: entry.path,
                size: entry.size,
                sha256: None,
                git_sha1: entry.oid,
            },
        })
        .collect())
}

/// The `rel="next"` URL of a `Link` header, when it stays on Hugging Face.
pub fn next_page(link: Option<&str>) -> Option<String> {
    link?.split(',').find_map(|part| {
        let (url, rel) = part.split_once(';')?;
        if !rel.contains("rel=\"next\"") {
            return None;
        }
        let url = url.trim().trim_start_matches('<').trim_end_matches('>');
        let parsed = reqwest::Url::parse(url).ok()?;
        (parsed.scheme() == "https" && parsed.host_str().is_some_and(allowed_host))
            .then(|| url.to_string())
    })
}

pub fn classify(status: u16) -> &'static str {
    match status {
        429 => RATE_LIMITED,
        401 | 403 => GATED,
        404 => UNKNOWN_REPO,
        500..=599 => UNAVAILABLE,
        _ => BAD_RESPONSE,
    }
}

/// The body (at most `max_bytes`) and the `Link` header of a GET.
pub async fn get_text(
    client: &reqwest::Client,
    url: &str,
    max_bytes: usize,
) -> Result<(String, Option<String>), String> {
    let response = client.get(url).send().await.map_err(|e| {
        if e.is_connect() || e.is_timeout() {
            OFFLINE.to_string()
        } else {
            UNAVAILABLE.to_string()
        }
    })?;
    let status = response.status();
    if !status.is_success() {
        return Err(classify(status.as_u16()).into());
    }
    let link = response
        .headers()
        .get(reqwest::header::LINK)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| OFFLINE.to_string())?;
        if body.len() + chunk.len() > max_bytes {
            return Err(BAD_RESPONSE.into());
        }
        body.extend_from_slice(&chunk);
    }
    let text = String::from_utf8(body).map_err(|_| BAD_RESPONSE.to_string())?;
    Ok((text, link))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SEARCH: &str = include_str!("testdata/search-kokoro.json");
    const MODEL: &str = include_str!("testdata/model-faber.json");
    const TREE: &str = include_str!("testdata/tree-faber.json");

    #[test]
    fn only_allowlisted_repos_are_valid() {
        assert!(valid_repo("csukuangfj/vits-piper-pt_BR-faber-medium"));
        assert!(valid_repo("k2-fsa/sherpa-onnx-whisper-turbo"));
        for bad in [
            "someone/vits-piper-x",
            "csukuangfj",
            "csukuangfj/",
            "csukuangfj/../x",
            "csukuangfj/a/b",
            "csukuangfj/a b",
            "csukuangfj/..",
        ] {
            assert!(!valid_repo(bad), "{bad}");
        }
    }

    #[test]
    fn only_hugging_face_hosts_are_allowed() {
        for host in [
            "huggingface.co",
            "cdn-lfs.huggingface.co",
            "us.aws.cdn.hf.co",
            "cas-bridge.xethub.hf.co",
            "hf.co",
        ] {
            assert!(allowed_host(host), "{host}");
        }
        for host in [
            "evil.com",
            "huggingface.co.evil.com",
            "hf.com",
            "xhf.co",
            "github.com",
        ] {
            assert!(!allowed_host(host), "{host}");
        }
    }

    #[test]
    fn search_results_parse_with_stats() {
        let hits = parse_search(SEARCH).unwrap();
        let kokoro = hits
            .iter()
            .find(|h| h.repo == "csukuangfj/kokoro-multi-lang-v1_0")
            .expect("kokoro v1.0 in fixture");
        assert!(kokoro.last_modified.is_some());
        assert!(hits.iter().all(|h| valid_repo(&h.repo)));
    }

    #[test]
    fn gated_private_and_foreign_results_are_dropped() {
        let body = r#"[
            {"id":"csukuangfj/a","likes":1,"downloads":0,"gated":false,"private":false},
            {"id":"csukuangfj/b","gated":"auto","private":false},
            {"id":"csukuangfj/c","gated":false,"private":true},
            {"id":"other/d","gated":false,"private":false},
            {"id":"csukuangfj/e","cardData":{"license":["apache-2.0"]}}
        ]"#;
        let hits = parse_search(body).unwrap();
        assert_eq!(
            hits.iter().map(|h| h.repo.as_str()).collect::<Vec<_>>(),
            vec!["csukuangfj/a", "csukuangfj/e"]
        );
        assert_eq!(hits[1].license.as_deref(), Some("apache-2.0"));
    }

    #[test]
    fn model_info_carries_the_commit() {
        let info = parse_model(MODEL).unwrap();
        assert!(valid_commit(&info.commit));
        assert_eq!(info.hit.repo, "csukuangfj/vits-piper-pt_BR-faber-medium");
        assert_eq!(
            parse_model(r#"{"id":"csukuangfj/a","sha":"x"}"#).unwrap_err(),
            BAD_RESPONSE
        );
        assert_eq!(
            parse_model(&format!(
                r#"{{"id":"csukuangfj/a","sha":"{}","gated":"manual"}}"#,
                "a".repeat(40)
            ))
            .unwrap_err(),
            GATED
        );
    }

    #[test]
    fn tree_entries_become_files_with_checksums() {
        let files = parse_tree(TREE).unwrap();
        let onnx = files
            .iter()
            .find(|f| f.path == "pt_BR-faber-medium.onnx")
            .unwrap();
        assert_eq!(onnx.sha256.as_deref().map(str::len), Some(64));
        assert!(
            onnx.git_sha1.is_none(),
            "an LFS file is checked by SHA-256 only"
        );
        let tokens = files.iter().find(|f| f.path == "tokens.txt").unwrap();
        assert!(tokens.sha256.is_none());
        assert_eq!(tokens.git_sha1.as_deref().map(str::len), Some(40));
        assert!(
            files.iter().all(|f| f.path != "espeak-ng-data"),
            "directories are not files"
        );
    }

    #[test]
    fn next_page_follows_only_hugging_face_links() {
        let link = r#"<https://huggingface.co/api/models/a/b/tree/main?cursor=xyz>; rel="next""#;
        assert_eq!(
            next_page(Some(link)).as_deref(),
            Some("https://huggingface.co/api/models/a/b/tree/main?cursor=xyz")
        );
        assert_eq!(next_page(Some(r#"<https://evil.com/x>; rel="next""#)), None);
        assert_eq!(
            next_page(Some(r#"<https://huggingface.co/x>; rel="prev""#)),
            None
        );
        assert_eq!(next_page(None), None);
    }

    #[test]
    fn statuses_map_to_error_codes() {
        assert_eq!(classify(429), RATE_LIMITED);
        assert_eq!(classify(401), GATED);
        assert_eq!(classify(404), UNKNOWN_REPO);
        assert_eq!(classify(503), UNAVAILABLE);
        assert_eq!(classify(418), BAD_RESPONSE);
    }

    #[test]
    fn urls_are_built_from_validated_parts() {
        let commit = "a".repeat(40);
        assert_eq!(
            resolve_url("csukuangfj/x", &commit, "espeak-ng-data/voices/!v/Alex"),
            format!("https://huggingface.co/csukuangfj/x/resolve/{commit}/espeak-ng-data/voices/!v/Alex")
        );
        assert!(
            search_url("csukuangfj", "pt br").contains("search=pt+br")
                || search_url("csukuangfj", "pt br").contains("search=pt%20br")
        );
        assert!(search_url("csukuangfj", "x").starts_with("https://huggingface.co/api/models?"));
    }
}
