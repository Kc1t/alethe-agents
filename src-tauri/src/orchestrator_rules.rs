//! The engineering rules Alethe hands to the workers it delegates to.
//!
//! Tauri-free like `orchestrator_core`, which declares this module: both compile inside the
//! orchestrator tests and the standalone MCP binary. The app injects the person's own sets.

/// One named body of rules. `name` is the identity the planner uses when delegating.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuleSet {
    pub id: String,
    pub name: String,
    pub text: String,
}

pub const GENERAL_ID: &str = "general";

const GENERAL: &str = include_str!("../assets/rules/general.md");
const BACKEND: &str = include_str!("../assets/rules/backend.md");
const FRONTEND: &str = include_str!("../assets/rules/frontend.md");

/// What ships with Alethe. The person edits these or replaces them entirely.
pub fn default_rule_sets() -> Vec<RuleSet> {
    vec![
        RuleSet { id: GENERAL_ID.into(), name: "General".into(), text: GENERAL.into() },
        RuleSet { id: "backend".into(), name: "Backend".into(), text: BACKEND.into() },
        RuleSet { id: "frontend".into(), name: "Frontend".into(), text: FRONTEND.into() },
    ]
}

/// Lowercased and stripped of the diacritics a person types in a set name, so `Banco de Dados` is
/// found by `banco de dados`. Deliberately small: this folds names, not text.
///
/// Combining marks are dropped first, so a decomposed name — pasted from a Mac, or typed with a
/// dead key — folds the same as its precomposed spelling. Without that the editor and this core
/// disagree about which names are duplicates: `src/lib/workerRules.ts` normalizes to NFD and drops
/// every mark, and a name the briefing listed would come back as "unknown rule set".
pub fn fold_name(value: &str) -> String {
    value
        .trim()
        .chars()
        .flat_map(|c| c.to_lowercase())
        .filter(|c| !matches!(c, '\u{0300}'..='\u{036f}'))
        .map(fold_char)
        .collect()
}

/// The precomposed Latin letters whose canonical decomposition is a base letter plus a combining
/// mark — the same set the TypeScript side folds by decomposing. Letters with no such
/// decomposition (`ø`, `đ`, `ł`, `æ`, `ß`) are left alone there, so they are left alone here too.
/// Lowercasing has already run, so only the lowercase halves of these ranges can arrive.
fn fold_char(c: char) -> char {
    match c {
        'à'..='å' | '\u{0101}' | '\u{0103}' | '\u{0105}' => 'a',
        'ç' | '\u{0107}'..='\u{010d}' => 'c',
        '\u{010f}' => 'd',
        'è'..='ë' | '\u{0113}'..='\u{011b}' => 'e',
        '\u{011d}'..='\u{0123}' => 'g',
        '\u{0125}' => 'h',
        'ì'..='ï' | '\u{0129}'..='\u{0130}' => 'i',
        '\u{0135}' => 'j',
        '\u{0137}' => 'k',
        '\u{013a}'..='\u{013e}' => 'l',
        'ñ' | '\u{0144}'..='\u{0148}' => 'n',
        'ò'..='ö' | '\u{014d}'..='\u{0151}' => 'o',
        '\u{0155}'..='\u{0159}' => 'r',
        '\u{015b}'..='\u{0161}' => 's',
        '\u{0163}' | '\u{0165}' => 't',
        'ù'..='ü' | '\u{0169}'..='\u{0173}' => 'u',
        '\u{0175}' => 'w',
        'ý' | 'ÿ' | '\u{0177}' => 'y',
        '\u{017a}'..='\u{017e}' => 'z',
        other => other,
    }
}

pub fn find_set<'a>(sets: &'a [RuleSet], name: &str) -> Option<&'a RuleSet> {
    let wanted = fold_name(name);
    sets.iter().find(|set| fold_name(&set.name) == wanted)
}

/// Wording shared by every call site that refuses an unknown rule-set name, so a planner sees the
/// same message whether the refusal came from delegating, from `rules_block`, or from `alethe_rules`.
pub fn unknown_set_error(sets: &[RuleSet], name: &str) -> String {
    let names: Vec<&str> = sets.iter().map(|set| set.name.as_str()).collect();
    format!(
        "unknown rule set {name:?}. Available: {}",
        if names.is_empty() { "none".to_string() } else { names.join(", ") }
    )
}

const PRECEDENCE: &str = "These are Alethe's working rules for this task. If this repository states something different (CLAUDE.md, AGENTS.md, CONTRIBUTING.md), the repository wins.";

/// The block prefixed to a worker's first message: the general set, then the named one if there is
/// one. An unknown name is refused rather than silently ignored — a worker running with the wrong
/// rules is worse than a call the planner can retry.
pub fn rules_block(sets: &[RuleSet], named: Option<&str>) -> Result<String, String> {
    let mut chosen: Vec<&RuleSet> = Vec::new();
    if let Some(general) = sets.iter().find(|set| set.id == GENERAL_ID) {
        chosen.push(general);
    }
    if let Some(name) = named.map(str::trim).filter(|name| !name.is_empty()) {
        let found = find_set(sets, name).ok_or_else(|| unknown_set_error(sets, name))?;
        if found.id != GENERAL_ID {
            chosen.push(found);
        }
    }
    if chosen.is_empty() {
        return Ok(String::new());
    }
    let body = chosen
        .iter()
        .map(|set| set.text.trim())
        .collect::<Vec<_>>()
        .join("\n\n");
    Ok(format!("<alethe-rules>\n{PRECEDENCE}\n\n{body}\n</alethe-rules>\n\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sets() -> Vec<RuleSet> {
        vec![
            RuleSet { id: "general".into(), name: "General".into(), text: "always".into() },
            RuleSet { id: "db".into(), name: "Banco de Dados".into(), text: "sql".into() },
        ]
    }

    #[test]
    fn a_name_matches_regardless_of_case_and_accents() {
        // An agent typing a set name is one keystroke from a failed call.
        assert_eq!(find_set(&sets(), "banco de dados").map(|s| s.id.as_str()), Some("db"));
        assert_eq!(find_set(&sets(), "BANCO DE DADOS").map(|s| s.id.as_str()), Some("db"));
        assert_eq!(find_set(&sets(), "Banco de Dados").map(|s| s.id.as_str()), Some("db"));
        assert_eq!(find_set(&sets(), "banco"), None);
    }

    #[test]
    fn a_decomposed_name_folds_like_its_precomposed_spelling() {
        // The editor normalizes to NFD and drops the marks; a name pasted from a system that
        // stores it decomposed must not read as a different set here.
        assert_eq!(fold_name("Sessão"), fold_name("Sessa\u{0303}o"));
        assert_eq!(fold_name("Sessão"), "sessao");
        // Diacritics the old table never listed, precomposed and decomposed alike.
        assert_eq!(fold_name("Åland"), "aland");
        assert_eq!(fold_name("A\u{030a}land"), "aland");
        assert_eq!(fold_name("Čeština"), "cestina");

        let with_marks = vec![RuleSet {
            id: "db".into(),
            name: "Sessa\u{0303}o".into(),
            text: "sql".into(),
        }];
        assert_eq!(find_set(&with_marks, "sessão").map(|s| s.id.as_str()), Some("db"));
    }

    #[test]
    fn the_block_carries_general_alone_when_nothing_is_named() {
        let block = rules_block(&sets(), None).expect("a block");
        assert!(block.contains("always"), "{block}");
        assert!(!block.contains("sql"), "{block}");
        assert!(block.contains("the repository wins"), "precedence is stated: {block}");
    }

    #[test]
    fn the_block_carries_general_and_the_named_set() {
        let block = rules_block(&sets(), Some("banco de dados")).expect("a block");
        assert!(block.contains("always") && block.contains("sql"), "{block}");
    }

    #[test]
    fn an_unknown_name_is_refused_and_lists_what_exists() {
        let error = rules_block(&sets(), Some("Backend")).expect_err("refusal");
        assert!(error.contains("General") && error.contains("Banco de Dados"), "{error}");
    }

    #[test]
    fn without_a_general_set_the_block_is_whatever_was_named() {
        let only_db = vec![RuleSet { id: "db".into(), name: "DB".into(), text: "sql".into() }];
        let block = rules_block(&only_db, Some("DB")).expect("a block");
        assert!(block.contains("sql"), "{block}");
    }

    #[test]
    fn the_shipped_sets_are_general_backend_and_frontend_with_content() {
        let defaults = default_rule_sets();
        let ids: Vec<&str> = defaults.iter().map(|set| set.id.as_str()).collect();
        assert_eq!(ids, vec!["general", "backend", "frontend"]);
        assert!(defaults.iter().all(|set| set.text.len() > 200), "assets are loaded, not empty");
    }
}
