//! Local voice and speech models found on Hugging Face: search, resolve (exact files of a pinned
//! commit) and manifests of installed models.

pub mod detect;
pub mod hf;
pub mod installed;
pub mod meta;
pub mod search;

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::State;

use detect::{Family, Planned, RepoFile};
use hf::{RepoInfo, SearchHit};
use meta::{ModelMeta, PiperConfig};
use search::{Candidate, SearchQuery};

/// A model larger than this is not offered.
pub const MAX_MODEL_BYTES: u64 = 4 * 1024 * 1024 * 1024;
/// A file outside LFS larger than this is not offered (Kokoro's largest is 6 MB).
pub const MAX_SMALL_FILE_BYTES: u64 = 16 * 1024 * 1024;
const SEARCH_TTL: Duration = Duration::from_secs(600);
/// A search page can hold 500 repos, about 100 KB.
const MAX_SEARCH_BYTES: usize = 4 * 1024 * 1024;
/// A recursive tree of a voice is about 80 KB; Kokoro's is under 200 KB.
const MAX_TREE_BYTES: usize = 8 * 1024 * 1024;
const MAX_PIPER_CONFIG_BYTES: u64 = 1024 * 1024;
const MAX_TREE_PAGES: usize = 10;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HubModelInfo {
    pub repo: String,
    pub commit: Option<String>,
    pub family: Family,
    pub languages: Vec<String>,
    pub language_count: Option<u32>,
    pub multilingual: bool,
    pub speed: Option<u8>,
    pub accuracy: Option<u8>,
    pub voice_count: Option<u32>,
    pub license: Option<String>,
    pub last_modified: Option<String>,
    pub likes: u64,
    pub file_count: Option<u32>,
    pub total_bytes: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HubSearchResult {
    pub id: String,
    #[serde(rename = "use")]
    pub use_: &'static str,
    pub label: String,
    pub hub: HubModelInfo,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HubSearchPage {
    pub results: Vec<HubSearchResult>,
    pub has_more: bool,
}

#[derive(Clone, Debug)]
pub struct Resolved {
    pub info: RepoInfo,
    pub planned: Planned,
    pub meta: ModelMeta,
}

#[derive(Default)]
pub struct HubState {
    searches: Mutex<HashMap<String, (Instant, Vec<SearchHit>)>>,
    resolved: Mutex<HashMap<String, Resolved>>,
}

impl HubState {
    /// Drops a repo's cached resolution, e.g. after its files turned out to be gone.
    pub fn forget(&self, repo: &str) {
        self.resolved
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(repo);
    }
}

pub fn hub_id(repo: &str) -> String {
    format!("hf:{repo}")
}

/// Sizes come from untrusted JSON, so the sum saturates instead of wrapping.
pub(crate) fn total_size(files: &[RepoFile]) -> u64 {
    files.iter().fold(0u64, |acc, f| acc.saturating_add(f.size))
}

fn repo_name(repo: &str) -> &str {
    repo.split_once('/').map_or(repo, |(_, name)| name)
}

pub fn hub_info(
    hit: &SearchHit,
    commit: Option<&str>,
    family: Family,
    meta: &ModelMeta,
    files: Option<&[RepoFile]>,
) -> HubModelInfo {
    let voices = if !meta.voices.is_empty() { meta.voices.len() as u32 } else { meta.voice_count };
    HubModelInfo {
        repo: hit.repo.clone(),
        commit: commit.map(str::to_string),
        family,
        languages: meta.languages.clone(),
        language_count: meta.language_count,
        multilingual: meta.multilingual,
        speed: meta.speed,
        accuracy: meta.accuracy,
        voice_count: (family.is_tts() && voices > 0).then_some(voices),
        license: hit.license.clone(),
        last_modified: hit.last_modified.clone(),
        likes: hit.likes,
        file_count: files.map(|f| f.len() as u32),
        total_bytes: files.map(total_size),
    }
}

fn result_of(resolved: &Resolved) -> HubSearchResult {
    let family = resolved.planned.family;
    HubSearchResult {
        id: hub_id(&resolved.info.hit.repo),
        use_: family.use_name(),
        label: resolved.meta.label.clone(),
        hub: hub_info(&resolved.info.hit, Some(&resolved.info.commit), family, &resolved.meta, Some(&resolved.planned.files)),
    }
}

async fn fetch_hits(state: &HubState, client: &reqwest::Client, author: &str, term: &str) -> Result<Vec<SearchHit>, String> {
    let key = format!("{author}|{term}");
    if let Some((at, hits)) = state.searches.lock().unwrap_or_else(|e| e.into_inner()).get(&key) {
        if at.elapsed() < SEARCH_TTL {
            return Ok(hits.clone());
        }
    }
    let (body, _) = hf::get_text(client, &hf::search_url(author, term), MAX_SEARCH_BYTES).await?;
    let hits = hf::parse_search(&body)?;
    state
        .searches
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(key, (Instant::now(), hits.clone()));
    Ok(hits)
}

#[tauri::command]
pub async fn speech_hub_search(state: State<'_, HubState>, query: SearchQuery) -> Result<HubSearchPage, String> {
    let client = hf::client()?;
    let terms = search::terms(&query);
    let requests: Vec<(&str, String)> = hf::ALLOWED_AUTHORS
        .iter()
        .flat_map(|author| terms.iter().map(move |term| (*author, term.clone())))
        .collect();
    let replies = futures_util::future::join_all(
        requests.iter().map(|(author, term)| fetch_hits(&state, &client, author, term)),
    )
    .await;
    // A failure of every request is the error; a partial failure still lists what came back.
    let mut hits = Vec::new();
    let mut first_error = None;
    for reply in replies {
        match reply {
            Ok(list) => hits.extend(list),
            Err(error) => {
                first_error.get_or_insert(error);
            }
        }
    }
    if hits.is_empty() {
        if let Some(error) = first_error {
            return Err(error);
        }
    }
    let candidates = hits
        .into_iter()
        .filter_map(|hit| {
            let name = repo_name(&hit.repo).to_string();
            let family = detect::family_of(&name)?;
            Some(Candidate { meta: meta::describe(family, &name, None), hit, family })
        })
        .collect();
    let (page, has_more) = search::rank(candidates, &query);
    let resolved = state.resolved.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let results = page
        .into_iter()
        .map(|c| match resolved.get(&c.hit.repo) {
            Some(found) => result_of(found),
            None => HubSearchResult {
                id: hub_id(&c.hit.repo),
                use_: c.family.use_name(),
                label: c.meta.label.clone(),
                hub: hub_info(&c.hit, None, c.family, &c.meta, None),
            },
        })
        .collect();
    Ok(HubSearchPage { results, has_more })
}

async fn piper_config(client: &reqwest::Client, repo: &str, commit: &str, planned: &Planned) -> Option<PiperConfig> {
    let file = planned
        .files
        .iter()
        .find(|f| f.path.ends_with(".onnx.json") && f.size <= MAX_PIPER_CONFIG_BYTES)?;
    let (body, _) = hf::get_text(client, &hf::resolve_url(repo, commit, &file.path), MAX_PIPER_CONFIG_BYTES as usize).await.ok()?;
    serde_json::from_str(&body).ok()
}

/// The exact files of the repo's current commit, checked against the limits; cached per session.
pub async fn resolve(state: &HubState, repo: &str) -> Result<Resolved, String> {
    if !hf::valid_repo(repo) {
        return Err(hf::UNKNOWN_REPO.into());
    }
    if let Some(found) = state.resolved.lock().unwrap_or_else(|e| e.into_inner()).get(repo).cloned() {
        return Ok(found);
    }
    let client = hf::client()?;
    let (body, _) = hf::get_text(&client, &hf::model_url(repo), MAX_TREE_BYTES).await?;
    let info = hf::parse_model(&body)?;
    if info.hit.repo != repo {
        return Err(hf::UNKNOWN_REPO.into());
    }
    let mut files = Vec::new();
    let mut next = Some(hf::tree_url(repo, &info.commit));
    let mut pages = 0;
    while let Some(url) = next.take() {
        pages += 1;
        if pages > MAX_TREE_PAGES {
            return Err(hf::BAD_RESPONSE.into());
        }
        let (body, link) = hf::get_text(&client, &url, MAX_TREE_BYTES).await?;
        files.extend(hf::parse_tree(&body)?);
        next = hf::next_page(link.as_deref());
    }
    let name = repo_name(repo);
    let planned = detect::plan(name, &files).ok_or_else(|| hf::INCOMPATIBLE.to_string())?;
    let total = total_size(&planned.files);
    let oversized_small = planned.files.iter().any(|f| f.sha256.is_none() && f.size > MAX_SMALL_FILE_BYTES);
    if total > MAX_MODEL_BYTES || oversized_small {
        return Err(hf::TOO_LARGE.into());
    }
    if planned.files.iter().any(|f| f.sha256.is_none() && f.git_sha1.is_none()) {
        return Err(hf::BAD_RESPONSE.into());
    }
    let piper = if planned.family == Family::Vits { piper_config(&client, repo, &info.commit, &planned).await } else { None };
    let meta = meta::describe(planned.family, name, piper.as_ref());
    let resolved = Resolved { info, planned, meta };
    state
        .resolved
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(repo.to_string(), resolved.clone());
    Ok(resolved)
}

#[tauri::command]
pub async fn speech_hub_resolve(state: State<'_, HubState>, repo: String) -> Result<HubSearchResult, String> {
    resolve(&state, &repo).await.map(|resolved| result_of(&resolved))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(size: u64) -> RepoFile {
        RepoFile { path: "a".into(), size, sha256: None, git_sha1: None }
    }

    #[test]
    fn total_size_saturates_instead_of_wrapping() {
        let total = total_size(&[file(u64::MAX / 2 + 1), file(u64::MAX / 2 + 1)]);
        assert_eq!(total, u64::MAX);
        assert!(total > MAX_MODEL_BYTES);
    }
}
