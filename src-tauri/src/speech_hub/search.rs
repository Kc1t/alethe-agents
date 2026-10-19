//! Which API searches to run for a query, and how their merged results are filtered, ordered and
//! paged. Pure, so it is tested without the network.

use serde::Deserialize;

use super::detect::Family;
use super::hf::SearchHit;
use super::meta::ModelMeta;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Sort {
    Likes,
    Recent,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchQuery {
    /// `stt`, `tts`, or `None` for both.
    #[serde(rename = "use")]
    pub use_: Option<String>,
    pub query: String,
    /// BCP-47 tag; matched on its primary subtag.
    pub language: Option<String>,
    pub sort: Sort,
    pub offset: usize,
}

pub const PAGE: usize = 30;
const MIN_QUERY: usize = 2;
const TTS_TERMS: &[&str] = &["vits-", "kokoro", "kitten"];
const STT_TERMS: &[&str] = &["sherpa-onnx"];

#[derive(Clone, Debug)]
pub struct Candidate {
    pub hit: SearchHit,
    pub family: Family,
    pub meta: ModelMeta,
}

/// The API matches `search` against repo names only; an empty or one-letter query lists every
/// repo of the families for the use.
pub fn terms(query: &SearchQuery) -> Vec<String> {
    let text = query.query.trim();
    if text.chars().count() >= MIN_QUERY {
        return vec![text.to_string()];
    }
    let mut out: Vec<&str> = Vec::new();
    if query.use_.as_deref() != Some("stt") {
        out.extend(TTS_TERMS);
    }
    if query.use_.as_deref() != Some("tts") {
        out.extend(STT_TERMS);
    }
    out.into_iter().map(str::to_string).collect()
}

fn primary(tag: &str) -> String {
    tag.split(['-', '_'])
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
}

/// Many languages (Whisper's 99, a multilingual model) count as covering any language.
fn speaks(meta: &ModelMeta, language: &str) -> bool {
    let wanted = primary(language);
    meta.multilingual
        || meta.language_count.is_some_and(|count| count > 3)
        || meta.languages.iter().any(|tag| primary(tag) == wanted)
}

/// The page at `query.offset` and whether more follow.
pub fn rank(candidates: Vec<Candidate>, query: &SearchQuery) -> (Vec<Candidate>, bool) {
    let mut seen = std::collections::HashSet::new();
    let mut list: Vec<Candidate> = candidates
        .into_iter()
        .filter(|c| seen.insert(c.hit.repo.clone()))
        .filter(|c| {
            query
                .use_
                .as_deref()
                .is_none_or(|use_| c.family.use_name() == use_)
        })
        .filter(|c| {
            query
                .language
                .as_deref()
                .is_none_or(|language| speaks(&c.meta, language))
        })
        .collect();
    match query.sort {
        Sort::Likes => list.sort_by(|a, b| {
            (b.hit.likes, b.hit.downloads, &b.hit.last_modified).cmp(&(
                a.hit.likes,
                a.hit.downloads,
                &a.hit.last_modified,
            ))
        }),
        Sort::Recent => list.sort_by(|a, b| b.hit.last_modified.cmp(&a.hit.last_modified)),
    }
    let has_more = list.len() > query.offset + PAGE;
    let page = list.into_iter().skip(query.offset).take(PAGE).collect();
    (page, has_more)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::speech_hub::meta::describe;

    fn query(
        use_: Option<&str>,
        text: &str,
        language: Option<&str>,
        sort: Sort,
        offset: usize,
    ) -> SearchQuery {
        SearchQuery {
            use_: use_.map(str::to_string),
            query: text.into(),
            language: language.map(str::to_string),
            sort,
            offset,
        }
    }

    fn candidate(repo: &str, family: Family, likes: u64, modified: &str) -> Candidate {
        let name = repo.split_once('/').unwrap().1;
        Candidate {
            hit: SearchHit {
                repo: repo.into(),
                likes,
                downloads: 0,
                last_modified: Some(modified.into()),
                license: None,
            },
            family,
            meta: describe(family, name, None),
        }
    }

    #[test]
    fn short_queries_fall_back_to_family_terms() {
        assert_eq!(
            terms(&query(None, "kokoro", None, Sort::Likes, 0)),
            vec!["kokoro"]
        );
        assert_eq!(
            terms(&query(Some("tts"), " k ", None, Sort::Likes, 0)),
            vec!["vits-", "kokoro", "kitten"]
        );
        assert_eq!(
            terms(&query(Some("stt"), "", None, Sort::Likes, 0)),
            vec!["sherpa-onnx"]
        );
        assert_eq!(
            terms(&query(None, "", None, Sort::Likes, 0)),
            vec!["vits-", "kokoro", "kitten", "sherpa-onnx"]
        );
    }

    #[test]
    fn rank_filters_by_use_and_language_and_dedups() {
        let all = vec![
            candidate(
                "csukuangfj/vits-piper-pt_BR-faber-medium",
                Family::Vits,
                6,
                "2023-11-29",
            ),
            candidate(
                "csukuangfj/vits-piper-en_US-amy-low",
                Family::Vits,
                9,
                "2023-11-29",
            ),
            candidate(
                "csukuangfj/kokoro-multi-lang-v1_0",
                Family::Kokoro,
                3,
                "2026-09-08",
            ),
            candidate(
                "csukuangfj/sherpa-onnx-whisper-turbo",
                Family::Whisper,
                1,
                "2024-10-01",
            ),
            candidate(
                "csukuangfj/vits-piper-pt_BR-faber-medium",
                Family::Vits,
                6,
                "2023-11-29",
            ),
        ];
        let (page, more) = rank(
            all.clone(),
            &query(Some("tts"), "", Some("pt"), Sort::Likes, 0),
        );
        assert_eq!(
            page.iter().map(|c| c.hit.repo.as_str()).collect::<Vec<_>>(),
            vec![
                "csukuangfj/vits-piper-pt_BR-faber-medium",
                "csukuangfj/kokoro-multi-lang-v1_0"
            ]
        );
        assert!(!more);
        let (stt, _) = rank(
            all.clone(),
            &query(Some("stt"), "", Some("pt"), Sort::Likes, 0),
        );
        assert_eq!(stt.len(), 1, "Whisper's 99 languages include Portuguese");
        let (recent, _) = rank(all, &query(None, "", None, Sort::Recent, 0));
        assert_eq!(recent[0].hit.repo, "csukuangfj/kokoro-multi-lang-v1_0");
    }

    #[test]
    fn rank_pages_by_thirty() {
        let many: Vec<Candidate> = (0..45)
            .map(|i| {
                candidate(
                    &format!("csukuangfj/vits-piper-en_US-v{i}-low"),
                    Family::Vits,
                    100 - i,
                    "2023-01-01",
                )
            })
            .collect();
        let (first, more) = rank(many.clone(), &query(None, "", None, Sort::Likes, 0));
        assert_eq!((first.len(), more), (30, true));
        let (second, more) = rank(many, &query(None, "", None, Sort::Likes, 30));
        assert_eq!((second.len(), more), (15, false));
    }
}
