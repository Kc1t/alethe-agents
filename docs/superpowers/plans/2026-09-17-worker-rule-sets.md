# Worker rule sets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hand Alethe's own engineering rules to every worker it delegates to, as named sets the planner chooses from and the person edits.

**Architecture:** The orchestrator core owns the rule sets (three shipped as markdown assets, the person's list injected by the app the same way launchers are), composes a delimited block from General plus the named set, and prefixes it to a worker's first message. The planner learns the set names in its handshake briefing, names one when delegating, and can read a set on demand. The editor lives beside the message shortcuts in Preferences → Multiagent.

**Tech Stack:** Rust (Tauri 2), React 18 + TypeScript, Zustand, CSS Modules with theme tokens, Vitest + Testing Library, cargo test.

**Spec:** `docs/superpowers/specs/2026-09-17-worker-rule-sets-design.md`

## Global Constraints

- **Never commit, push or tag.** Leave work in the tree and `git add` what you touched. The owner commits. Never add co-author or tool-attribution trailers.
- **Never start, stop or restart the app** (`npm run app` / `tauri dev` / Vite).
- English for code, comments and docs. Comments explain non-obvious behaviour only.
- Every visible string goes through `t()` and exists in BOTH `src/lib/i18n/messages/en.ts` and `pt-BR.ts` — `npm run build` fails otherwise. The rule **assets** are prose, not message entries.
- CSS Modules with theme tokens from `src/styles/theme.css`; no hardcoded colors, no gradients.
- `orchestrator_core.rs` stays Tauri-free: it is compiled into `src-tauri/tests/orchestrator.rs` and the standalone MCP binary. Anything app-specific is injected, as `set_launcher` and `set_shell_host` already are.
- Reserved ids: `general`, `backend`, `frontend`. `general` always applies and cannot be deleted or renamed.
- `Preferences.workerRuleSets` is `RuleSet[] | null`; `null` means "use ours", an empty array means "the person removed them all". Never treat `[]` as "use ours".
- Test commands: `npm test`, `npm run build`, `cargo test --manifest-path src-tauri/Cargo.toml --lib`, `cargo test --manifest-path src-tauri/Cargo.toml --test orchestrator` (its two `Permission denied` worktree lines on Windows are pre-existing noise).

---

## File Structure

**Created**

- `src-tauri/assets/rules/general.md`, `backend.md`, `frontend.md` — the shipped rule texts, read with `include_str!`.
- `src-tauri/src/orchestrator_rules.rs` — the rule-set type, the shipped defaults, name folding, and block composition. Tauri-free, declared by `orchestrator_core`.
- `src/lib/workerRules.ts` (+ `.test.ts`) — the TypeScript mirror: `resolveRuleSets`, name folding, the editor's helpers.

**Modified**

- `src-tauri/src/orchestrator_core.rs` — module declaration, `Core::set_rule_sets` / `rule_sets`, the `alethe_delegate` arm, `Job.rules_name`, `snapshot`/`record`, `planner_instructions`, the `alethe_rules` tool, the first-turn prefix.
- `src-tauri/src/orchestrator.rs`, `src-tauri/src/lib.rs` — `orchestrator_set_rule_sets` and `orchestrator_default_rule_sets` commands.
- `src-tauri/tests/orchestrator.rs` — delegation, rejection, briefing and prefix tests.
- `src/lib/types.ts` — `RuleSet`, `Preferences.workerRuleSets`, the default.
- `src/lib/tauri/orchestrator.ts` — wrappers plus `OrchestratorJob.rules`.
- `src/App.tsx` — push the resolved sets into the core on hydrate and on change.
- `src/components/modals/preferences/MultiagentPage.tsx` (+ its module CSS) — the editor.
- `src/components/OrchestratorPane/index.tsx` — the run node shows the set.
- `src/lib/i18n/messages/en.ts`, `pt-BR.ts`, `docs/CHANGELOG.md`.

---

### Task 1: Rule sets in the core

**Files:**
- Create: `src-tauri/src/orchestrator_rules.rs`
- Create: `src-tauri/assets/rules/general.md`, `src-tauri/assets/rules/backend.md`, `src-tauri/assets/rules/frontend.md`
- Modify: `src-tauri/src/orchestrator_core.rs` (module declaration and re-export, near `mod shells` / `pub use shells::{...}`)

**Interfaces:**
- Consumes: nothing.
- Produces: `RuleSet { id: String, name: String, text: String }`; `default_rule_sets() -> Vec<RuleSet>`; `fold_name(&str) -> String`; `find_set<'a>(sets: &'a [RuleSet], name: &str) -> Option<&'a RuleSet>`; `rules_block(sets: &[RuleSet], named: Option<&str>) -> Result<String, String>`.

- [ ] **Step 1: Write the rule assets**

Create the three files with the exact text from the spec's §7 ("What ours say"), each starting with a `#` heading naming the set (`# General`, `# Backend`, `# Frontend`) and one `- ` bullet per rule. Copy them verbatim from the spec — they are the shipped product, not a paraphrase.

- [ ] **Step 2: Write the failing tests**

Create `src-tauri/src/orchestrator_rules.rs` with only this test module at the bottom (the rest of the file comes in step 4):

```rust
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
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib orchestrator_rules`
Expected: FAIL — the module is not declared and the items do not exist.

- [ ] **Step 4: Write the module**

At the top of `src-tauri/src/orchestrator_rules.rs`:

```rust
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

/// Lowercased and stripped of the Latin diacritics a person types in a set name, so `Banco de
/// Dados` is found by `banco de dados`. Deliberately small: this folds names, not text.
pub fn fold_name(value: &str) -> String {
    value
        .trim()
        .chars()
        .flat_map(|c| c.to_lowercase())
        .map(|c| match c {
            'á' | 'à' | 'â' | 'ã' | 'ä' => 'a',
            'é' | 'è' | 'ê' | 'ë' => 'e',
            'í' | 'ì' | 'î' | 'ï' => 'i',
            'ó' | 'ò' | 'ô' | 'õ' | 'ö' => 'o',
            'ú' | 'ù' | 'û' | 'ü' => 'u',
            'ç' => 'c',
            'ñ' => 'n',
            other => other,
        })
        .collect()
}

pub fn find_set<'a>(sets: &'a [RuleSet], name: &str) -> Option<&'a RuleSet> {
    let wanted = fold_name(name);
    sets.iter().find(|set| fold_name(&set.name) == wanted)
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
        let found = find_set(sets, name).ok_or_else(|| {
            let names: Vec<&str> = sets.iter().map(|set| set.name.as_str()).collect();
            format!(
                "unknown rule set {name:?}. Available: {}",
                if names.is_empty() { "none".to_string() } else { names.join(", ") }
            )
        })?;
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
```

In `src-tauri/src/orchestrator_core.rs`, beside the existing `mod shells;` / `pub use shells::{...}` lines, add:

```rust
#[path = "orchestrator_rules.rs"]
mod rules;
pub use rules::{default_rule_sets, find_set, fold_name, rules_block, RuleSet, GENERAL_ID};
```

Match the declaration style already used for `shells` in that file — read it first and copy the form exactly.

- [ ] **Step 5: Run the tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib orchestrator_rules`
Expected: PASS, 6 tests.

- [ ] **Step 6: Stage**

```bash
git add src-tauri/src/orchestrator_rules.rs src-tauri/assets/rules src-tauri/src/orchestrator_core.rs
```

---

### Task 2: The core holds the person's sets

**Files:**
- Modify: `src-tauri/src/orchestrator_core.rs`

**Interfaces:**
- Consumes: `RuleSet`, `default_rule_sets` (Task 1).
- Produces: `Core::set_rule_sets(&self, sets: Vec<RuleSet>)` and `Core::rule_sets(&self) -> Vec<RuleSet>`, which returns the shipped defaults until the app injects something.

- [ ] **Step 1: Write the failing test**

In `src-tauri/tests/orchestrator.rs`:

```rust
#[test]
fn the_core_serves_the_shipped_rules_until_the_app_injects_its_own() {
    let core = Core::default();
    let names: Vec<String> = core.rule_sets().into_iter().map(|set| set.name).collect();
    assert_eq!(names, vec!["General", "Backend", "Frontend"]);

    core.set_rule_sets(vec![RuleSet {
        id: "general".into(),
        name: "Geral".into(),
        text: "minhas regras".into(),
    }]);
    let names: Vec<String> = core.rule_sets().into_iter().map(|set| set.name).collect();
    assert_eq!(names, vec!["Geral"], "the person's list replaces ours entirely");
}
```

Add `RuleSet` to that file's existing `use alethe_lib::orchestrator_core::{...}` import list (read the file's header to match how `Core` and `Launcher` are imported).

- [ ] **Step 2: Run it to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test orchestrator the_core_serves_the_shipped_rules`
Expected: FAIL — no method named `rule_sets`.

- [ ] **Step 3: Implement**

In `Core`, beside `launchers` and `fitness`, add the field:

```rust
    /// The person's sets, injected by the app. Empty until then, which means "use ours".
    rule_sets: Arc<Mutex<Vec<RuleSet>>>,
```

Initialise it in the same place the other `Arc<Mutex<...>>` fields are initialised (`Default`/`new`), then:

```rust
    pub fn set_rule_sets(&self, sets: Vec<RuleSet>) {
        *guard(&self.rule_sets) = sets;
    }

    /// Ours until the app says otherwise. An empty injected list is the person's choice to have
    /// none, and is honoured: only "never injected" falls back.
    pub fn rule_sets(&self) -> Vec<RuleSet> {
        let stored = guard(&self.rule_sets);
        if stored.is_empty() && !self.rules_injected.load(Ordering::SeqCst) {
            return default_rule_sets();
        }
        stored.clone()
    }
```

Add the companion flag beside the field:

```rust
    /// Distinguishes "the app never spoke" from "the person removed them all".
    rules_injected: Arc<std::sync::atomic::AtomicBool>,
```

and set it in `set_rule_sets` with `self.rules_injected.store(true, Ordering::SeqCst)`. Import `std::sync::atomic::Ordering` if the file does not already.

- [ ] **Step 4: Run the test**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test orchestrator the_core_serves_the_shipped_rules`
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
git add src-tauri/src/orchestrator_core.rs src-tauri/tests/orchestrator.rs
```

---

### Task 3: Delegating with a rule set

**Files:**
- Modify: `src-tauri/src/orchestrator_core.rs` (the `"alethe_delegate"` arm around line 2205, the `Job` struct around line 180, `Job::snapshot` around line 223 and `Job::record` just below it, and the `alethe_delegate` entry in `tools()`)
- Modify: `src-tauri/tests/orchestrator.rs`

**Interfaces:**
- Consumes: `rules_block`, `find_set` (Task 1), `Core::rule_sets` (Task 2).
- Produces: `Job.rules_name: Option<String>`; the snapshot and record fields `"rules"`; `alethe_delegate`'s `rules` argument.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn a_delegated_job_records_the_rule_set_it_was_given() {
    let core = Core::default();
    core.set_launcher(silent_launcher());
    let dir = workspace("rules-name");
    call(
        &core,
        "alethe_delegate",
        json!({ "cwd": dir.to_string_lossy(), "tasks": ["one"], "rules": "backend" }),
    );

    let job = &core.snapshot()["jobs"][0];
    // Resolved, not as typed: the board shows the set that was actually used.
    assert_eq!(job["rules"], json!("Backend"), "{job}");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn delegating_without_a_rule_set_records_none() {
    let core = Core::default();
    core.set_launcher(silent_launcher());
    let dir = workspace("rules-none");
    call(&core, "alethe_delegate", json!({ "cwd": dir.to_string_lossy(), "tasks": ["one"] }));

    assert_eq!(core.snapshot()["jobs"][0]["rules"], json!(null));

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn an_unknown_rule_set_refuses_the_call_and_starts_no_worker() {
    let core = Core::default();
    core.set_launcher(silent_launcher());
    let dir = workspace("rules-unknown");
    let response = rpc(
        &core,
        7,
        "tools/call",
        json!({
            "name": "alethe_delegate",
            "arguments": { "cwd": dir.to_string_lossy(), "tasks": ["one"], "rules": "Backhand" }
        }),
    );

    let text = response["result"]["content"][0]["text"].as_str().unwrap_or_default();
    let is_error = response["result"]["isError"] == json!(true) || text.contains("unknown rule set");
    assert!(is_error, "the call must be refused: {response}");
    assert!(text.contains("Backend"), "the refusal lists what exists: {text}");
    assert_eq!(core.snapshot()["jobs"].as_array().map(Vec::len), Some(0), "no worker started");

    let _ = std::fs::remove_dir_all(&dir);
}
```

Check how the existing tests in that file assert a refused tool call (search for `isError`) and match their shape; keep the assertion above only if the file has no established helper for it.

- [ ] **Step 2: Run them to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test orchestrator rule_set`
Expected: FAIL — `rules` is ignored and the snapshot has no such field.

- [ ] **Step 3: Parse and validate the argument**

In the `"alethe_delegate"` arm, after `agent` is resolved and **before** any worktree is created (the batch is accepted whole or not at all, and a refusal must not leave worktrees behind):

```rust
            // Resolved here so the refusal happens before anything is created, and so the job
            // records the set's real name rather than whatever spelling the planner used.
            let sets = core.rule_sets();
            let rules_name = match arguments
                .get("rules")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                Some(name) => match find_set(&sets, name) {
                    Some(found) => Some(found.name.clone()),
                    None => {
                        let names: Vec<&str> = sets.iter().map(|set| set.name.as_str()).collect();
                        return Err(format!(
                            "unknown rule set {name:?}. Available: {}",
                            if names.is_empty() { "none".to_string() } else { names.join(", ") }
                        ));
                    }
                },
                None => None,
            };
```

- [ ] **Step 4: Carry it on the job**

Add to `struct Job`, beside `spec`:

```rust
    /// The rule set this job was delegated with, resolved to its real name. `None` means the
    /// general set only.
    rules_name: Option<String>,
```

Set it in the struct literal where jobs are created in that same arm (`spec: spec.clone(),` is its neighbour): `rules_name: rules_name.clone(),`.

Add to both `Job::snapshot` and `Job::record`, beside `"spec"`:

```rust
            "rules": self.rules_name,
```

- [ ] **Step 5: Declare the argument in the tool schema**

In `tools()`, inside `alethe_delegate`'s `properties`:

```rust
                    "rules": {
                        "type": "string",
                        "description": "Name of the rule set this work belongs to (for example Backend or Frontend). The general rules always apply; this adds the ones for the area. Omit it when none fits. An unknown name is refused with the list of valid ones."
                    },
```

- [ ] **Step 6: Run the tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test orchestrator`
Expected: `test result: ok`.

- [ ] **Step 7: Stage**

```bash
git add src-tauri/src/orchestrator_core.rs src-tauri/tests/orchestrator.rs
```

---

### Task 4: The rules reach the worker

**Files:**
- Modify: `src-tauri/src/orchestrator_core.rs` (the first-turn composition around line 1014, inside the function that starts a worker)
- Modify: `src-tauri/tests/orchestrator.rs`

**Interfaces:**
- Consumes: `rules_block` (Task 1), `Core::rule_sets` (Task 2), `Job.rules_name` (Task 3).
- Produces: nothing new; the worker's first message carries the block.

- [ ] **Step 1: Write the failing test**

The worker's first message is not observable from the tool surface, so test the composition through a helper rather than a process. Add to `orchestrator_core.rs`, next to the first-turn code:

```rust
/// The text a worker's first turn carries: its rules, then the task. Split out so the composition
/// is testable without starting a process.
fn first_turn_text(block: &str, spec: &str) -> String {
    if block.is_empty() {
        return spec.to_string();
    }
    format!("{block}<task>\n{spec}\n</task>")
}
```

and in that file's `#[cfg(test)] mod tests` (create one if the file has none):

```rust
    #[test]
    fn a_first_turn_carries_the_rules_then_the_task() {
        let text = first_turn_text("<alethe-rules>\nR\n</alethe-rules>\n\n", "do the thing");
        assert!(text.starts_with("<alethe-rules>"), "{text}");
        assert!(text.contains("<task>\ndo the thing\n</task>"), "{text}");
    }

    #[test]
    fn without_rules_the_first_turn_is_just_the_task() {
        assert_eq!(first_turn_text("", "do the thing"), "do the thing");
    }
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib first_turn`
Expected: FAIL — `first_turn_text` does not exist.

- [ ] **Step 3: Use it where the first turn is composed**

At the first-turn site (`let first_turn = job.inbox.pop_front().unwrap_or_else(|| job.spec.clone());`), replace with:

```rust
            // Work that arrived while the worker was down leads; otherwise this is its first turn.
            // Rules ride only on that first turn: a follow-up already has them in its conversation.
            let first_turn = match job.inbox.pop_front() {
                Some(queued) => queued,
                None => {
                    let block = rules_block(&sets, job.rules_name.as_deref()).unwrap_or_default();
                    first_turn_text(&block, &job.spec)
                }
            };
```

`sets` must be read **before** the `inner` lock is taken, since `Core::rule_sets` takes its own lock:

```rust
        let sets = self.rule_sets();
        {
            let mut inner = guard(&self.inner);
            // ... existing body
```

Read the surrounding function before editing: keep the existing lock scope exactly as it is and only hoist the `rule_sets()` call above it. Holding two of these locks at once is what deadlocks this file.

`rules_block` returning `Err` here is impossible (the name was resolved at delegation), and `unwrap_or_default` makes that explicit without a panic.

- [ ] **Step 4: Run the tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib first_turn` → PASS
Run: `cargo test --manifest-path src-tauri/Cargo.toml --test orchestrator` → `test result: ok`

- [ ] **Step 5: Stage**

```bash
git add src-tauri/src/orchestrator_core.rs src-tauri/tests/orchestrator.rs
```

---

### Task 5: The planner learns the sets and can read one

**Files:**
- Modify: `src-tauri/src/orchestrator_core.rs` (`planner_instructions`, `tools()`, `dispatch_tool`)
- Modify: `src-tauri/tests/orchestrator.rs`

**Interfaces:**
- Consumes: `Core::rule_sets` (Task 2).
- Produces: the `alethe_rules` tool.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn the_briefing_names_the_rule_sets_and_says_to_choose_one() {
    let core = Core::default();
    let initialized = rpc(&core, 1, "initialize", json!({}));
    let text = initialized["result"]["instructions"].as_str().expect("instructions");

    assert!(text.contains("General (always applied)"), "{text}");
    assert!(text.contains("Backend") && text.contains("Frontend"), "{text}");
    assert!(text.contains("name the set"), "it tells the planner to choose: {text}");
}

#[test]
fn the_rules_tool_lists_names_and_returns_one_set() {
    let core = Core::default();
    let listed = call(&core, "alethe_rules", json!({}));
    let names = listed["sets"].as_array().expect("names");
    assert!(names.iter().any(|value| value == "Frontend"), "{listed}");

    let one = rpc(
        &core,
        2,
        "tools/call",
        json!({ "name": "alethe_rules", "arguments": { "name": "frontend" } }),
    );
    let text = one["result"]["content"][0]["text"].as_str().expect("text");
    assert!(text.starts_with("# Frontend"), "plain markdown, not escaped JSON: {text}");
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test orchestrator rule`
Expected: FAIL — no such tool, and the briefing says nothing about sets.

- [ ] **Step 3: Extend the briefing**

In `planner_instructions`, after the block that lists the available workers, append:

```rust
    let sets = core.rule_sets();
    let rules = if sets.is_empty() {
        String::new()
    } else {
        let names: Vec<&str> = sets
            .iter()
            .filter(|set| set.id != GENERAL_ID)
            .map(|set| set.name.as_str())
            .collect();
        format!(
            "\nRule sets: General (always applied){}{}\n- When you delegate, name the set that \
             matches the work, in `rules`. Omit it and the worker gets the general rules only.\n- \
             Read a set with alethe_rules before writing code yourself.\n",
            if names.is_empty() { "" } else { ", " },
            names.join(", ")
        )
    };
```

and include `{rules}` in the returned `format!`, between the workers block and `PLANNER_WORKING`.

- [ ] **Step 4: Add the tool**

In `tools()`:

```rust
        {
            "name": "alethe_rules",
            "description": "The engineering rules Alethe applies here. Without a name it lists the sets; with one it returns that set's text. Read the set that matches before writing code yourself.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "Set name, for example Backend." }
                }
            }
        },
```

In `dispatch_tool`, beside the `"alethe_guide"` arm:

```rust
        "alethe_rules" => {
            let sets = core.rule_sets();
            match arguments
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                Some(name) => find_set(&sets, name)
                    .map(|found| Value::String(found.text.clone()))
                    .ok_or_else(|| {
                        let names: Vec<&str> = sets.iter().map(|set| set.name.as_str()).collect();
                        format!("unknown rule set {name:?}. Available: {}", names.join(", "))
                    }),
                None => Ok(json!({
                    "sets": sets.iter().map(|set| set.name.clone()).collect::<Vec<_>>()
                })),
            }
        }
```

The `tool_text` helper already turns a `Value::String` into plain text rather than an escaped JSON string — the same reason `alethe_guide` returns one.

- [ ] **Step 5: Run the tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test orchestrator` → `test result: ok`

- [ ] **Step 6: Stage**

```bash
git add src-tauri/src/orchestrator_core.rs src-tauri/tests/orchestrator.rs
```

---

### Task 6: Commands that carry the sets across

**Files:**
- Modify: `src-tauri/src/orchestrator.rs`, `src-tauri/src/lib.rs`
- Modify: `src/lib/tauri/orchestrator.ts`

**Interfaces:**
- Consumes: `Core::set_rule_sets`, `default_rule_sets`.
- Produces: commands `orchestrator_set_rule_sets { sets }` and `orchestrator_default_rule_sets`; TypeScript `orchestratorSetRuleSets(sets: RuleSet[]): Promise<void>` and `orchestratorDefaultRuleSets(): Promise<RuleSet[]>`; the TS type `RuleSet` re-exported from `src/lib/types.ts` (Task 7 defines it).

- [ ] **Step 1: Add the commands**

In `src-tauri/src/orchestrator.rs`, mirroring the shape of `orchestrator_set_agent_fitness`:

```rust
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleSetInput {
    pub id: String,
    pub name: String,
    pub text: String,
}

/// The person's sets, pushed from the frontend whenever they change. An empty list is a real
/// choice ("I removed them all") and is stored as such.
#[tauri::command]
pub fn orchestrator_set_rule_sets(
    state: tauri::State<'_, OrchestratorState>,
    sets: Vec<RuleSetInput>,
) {
    state.core.set_rule_sets(
        sets.into_iter()
            .map(|set| alethe_lib::orchestrator_core::RuleSet {
                id: set.id,
                name: set.name,
                text: set.text,
            })
            .collect(),
    );
}

/// What ships with Alethe, so the editor can show ours and restore one.
#[tauri::command]
pub fn orchestrator_default_rule_sets() -> Value {
    json!(alethe_lib::orchestrator_core::default_rule_sets()
        .into_iter()
        .map(|set| json!({ "id": set.id, "name": set.name, "text": set.text }))
        .collect::<Vec<_>>())
}
```

Use whatever path the file already uses to reach `orchestrator_core` items (read its imports; it may be `crate::orchestrator_core::...`). Register both in `src-tauri/src/lib.rs`'s `invoke_handler![...]`, beside `orchestrator_set_agent_fitness`.

- [ ] **Step 2: Add the wrappers**

In `src/lib/tauri/orchestrator.ts`:

```ts
import type { RuleSet } from '../types'

/** Pushed whenever the person's sets change; an empty list means they removed them all. */
export async function orchestratorSetRuleSets(sets: RuleSet[]): Promise<void> {
  return invoke<void>('orchestrator_set_rule_sets', { sets })
}

export async function orchestratorDefaultRuleSets(): Promise<RuleSet[]> {
  return invoke<RuleSet[]>('orchestrator_default_rule_sets')
}
```

Also add `rules: string | null` to `OrchestratorJob`, beside `runLabel`.

- [ ] **Step 3: Verify**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib` → `test result: ok`
Run: `npx tsc --noEmit` → exit 0 (`RuleSet` lands in Task 7; if you run this before that task, expect the missing-type error and nothing else).

- [ ] **Step 4: Stage**

```bash
git add src-tauri/src/orchestrator.rs src-tauri/src/lib.rs src/lib/tauri/orchestrator.ts
```

---

### Task 7: The TypeScript side of the data

**Files:**
- Modify: `src/lib/types.ts`
- Create: `src/lib/workerRules.ts`, `src/lib/workerRules.test.ts`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `orchestratorSetRuleSets`, `orchestratorDefaultRuleSets` (Task 6).
- Produces: `RuleSet = { id: string; name: string; text: string }` and `Preferences.workerRuleSets: RuleSet[] | null` in `types.ts`; `resolveRuleSets(stored, defaults)`, `foldName(value)`, `findRuleSet(sets, name)`, `isProtectedRuleSet(set)`, `GENERAL_RULE_ID` in `src/lib/workerRules.ts`.

- [ ] **Step 1: Write the failing tests**

`src/lib/workerRules.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { findRuleSet, foldName, GENERAL_RULE_ID, resolveRuleSets } from './workerRules'
import type { RuleSet } from './types'

const ours: RuleSet[] = [
  { id: GENERAL_RULE_ID, name: 'General', text: 'g' },
  { id: 'backend', name: 'Backend', text: 'b' },
]

describe('resolveRuleSets', () => {
  it('uses ours only when nothing was ever stored', () => {
    expect(resolveRuleSets(null, ours)).toEqual(ours)
    expect(resolveRuleSets(undefined, ours)).toEqual(ours)
  })

  it('honours an empty list as a deliberate choice', () => {
    // The shortcuts learned this the hard way: treating [] as "use ours" makes deleting the last
    // one resurrect everything.
    expect(resolveRuleSets([], ours)).toEqual([])
  })

  it('returns the stored list untouched', () => {
    const mine: RuleSet[] = [{ id: 'x', name: 'Mine', text: 'm' }]
    expect(resolveRuleSets(mine, ours)).toEqual(mine)
  })
})

describe('findRuleSet', () => {
  it('matches regardless of case and accents', () => {
    const sets: RuleSet[] = [{ id: 'db', name: 'Banco de Dados', text: 's' }]
    expect(findRuleSet(sets, 'banco de dados')?.id).toBe('db')
    expect(findRuleSet(sets, 'BANCO DE DADOS')?.id).toBe('db')
    expect(findRuleSet(sets, 'banco')).toBeUndefined()
  })

  it('folds the same way the core does', () => {
    expect(foldName('  Configuração ')).toBe('configuracao')
  })
})

describe('the general set is protected', () => {
  it('cannot be deleted or renamed, and every other set can', () => {
    // The planner is told "General always applies"; a renamed or missing General would make that
    // briefing a lie.
    expect(isProtectedRuleSet(ours[0])).toBe(true)
    expect(isProtectedRuleSet(ours[1])).toBe(false)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/lib/workerRules.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Add the types**

In `src/lib/types.ts`, beside the other orchestrator-facing types:

```ts
/** One named body of engineering rules handed to workers. `general` always applies. */
export type RuleSet = {
  id: string
  name: string
  text: string
}
```

In `Preferences`:

```ts
  /** null means "use Alethe's"; any array — empty included — is the person's own list. */
  workerRuleSets: RuleSet[] | null
```

and `workerRuleSets: null,` in `DEFAULT_PREFERENCES`. No migration is needed: `normalizePreferences` spreads `DEFAULT_PREFERENCES` under the stored object.

- [ ] **Step 4: Write the module**

`src/lib/workerRules.ts`:

```ts
import type { RuleSet } from './types'

export const GENERAL_RULE_ID = 'general'

/** Lowercased and stripped of diacritics, mirroring `fold_name` in the core. */
export function foldName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
}

export function findRuleSet(sets: readonly RuleSet[], name: string): RuleSet | undefined {
  const wanted = foldName(name)
  return sets.find((set) => foldName(set.name) === wanted)
}

export function resolveRuleSets(
  stored: RuleSet[] | null | undefined,
  defaults: RuleSet[],
): RuleSet[] {
  return stored == null ? defaults : stored
}

/** The general set is named in the planner's briefing as always applied: it stays, under that name. */
export function isProtectedRuleSet(set: RuleSet): boolean {
  return set.id === GENERAL_RULE_ID
}
```

- [ ] **Step 5: Push the sets into the core**

In `src/App.tsx`, beside the existing hydrate-dependent effects (the update check at ~line 490 is the model), add:

```tsx
  const storedRuleSets = useProjectsStore((state) => state.preferences.workerRuleSets)

  // The core composes the block at delegation time, so it needs the person's list — and a fresh one
  // whenever they edit it, not only at startup.
  useEffect(() => {
    if (!hydrated) return
    let cancelled = false
    void orchestratorDefaultRuleSets()
      .then((defaults) => {
        if (cancelled) return
        return orchestratorSetRuleSets(resolveRuleSets(storedRuleSets, defaults))
      })
      .catch((error) => console.error('[rules] could not publish the rule sets:', error))
    return () => {
      cancelled = true
    }
  }, [hydrated, storedRuleSets])
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/lib/workerRules.test.ts` → PASS
Run: `npm run build` → exit 0

- [ ] **Step 7: Stage**

```bash
git add src/lib/types.ts src/lib/workerRules.ts src/lib/workerRules.test.ts src/App.tsx
```

---

### Task 8: The editor

**Files:**
- Modify: `src/components/modals/preferences/MultiagentPage.tsx`, `MultiagentPage.module.css`
- Modify: `src/lib/i18n/messages/en.ts`, `pt-BR.ts`

**Interfaces:**
- Consumes: `resolveRuleSets`, `GENERAL_RULE_ID` (Task 7), `orchestratorDefaultRuleSets` (Task 6).
- Produces: a `SettingsSection` with id `worker-rules`.

- [ ] **Step 1: Load ours and the person's**

The message-shortcuts section immediately above is the template — read it and follow its shape (hoisted defaults, one `updateX(index, patch)` helper, `crypto.randomUUID()` ids, per-row restore, an empty state with "restore ours").

```tsx
  const storedRuleSets = useProjectsStore((state) => state.preferences.workerRuleSets)
  const [defaultRuleSets, setDefaultRuleSets] = useState<RuleSet[]>([])

  useEffect(() => {
    void orchestratorDefaultRuleSets()
      .then(setDefaultRuleSets)
      .catch(() => setDefaultRuleSets([]))
  }, [])

  const ruleSets = resolveRuleSets(storedRuleSets, defaultRuleSets)
  const saveRuleSets = (next: RuleSet[]) => setPreferences({ workerRuleSets: next })
  const updateRuleSet = (index: number, patch: Partial<RuleSet>) =>
    saveRuleSets(ruleSets.map((set, i) => (i === index ? { ...set, ...patch } : set)))
```

- [ ] **Step 2: Render the section**

```tsx
      <SettingsSection
        id="worker-rules"
        title={t('prefs.workerRules')}
        description={t('prefs.workerRulesDesc')}
      >
        <div className={multiagentStyles.ruleList}>
          {ruleSets.map((set, index) => {
            const isGeneral = isProtectedRuleSet(set)
            const ours = defaultRuleSets.find((entry) => entry.id === set.id)
            const duplicate = ruleSets.some(
              (other, i) => i !== index && foldName(other.name) === foldName(set.name),
            )
            return (
              <div key={set.id} className={multiagentStyles.ruleSet}>
                <input
                  className={controls.input}
                  value={set.name}
                  disabled={isGeneral}
                  aria-label={t('prefs.ruleSetName')}
                  aria-invalid={duplicate || undefined}
                  onChange={(event) => updateRuleSet(index, { name: event.target.value })}
                />
                {duplicate ? (
                  <span className={multiagentStyles.ruleWarn}>{t('prefs.ruleSetDuplicate')}</span>
                ) : null}
                <textarea
                  className={multiagentStyles.ruleText}
                  value={set.text}
                  rows={10}
                  aria-label={t('prefs.ruleSetText')}
                  onChange={(event) => updateRuleSet(index, { text: event.target.value })}
                />
                <div className={multiagentStyles.ruleFoot}>
                  <span className={multiagentStyles.ruleCount}>
                    {t('prefs.ruleSetSize', { count: set.text.length })}
                  </span>
                  {ours ? (
                    <button
                      type="button"
                      className={`${controls.btn} ${controls.btnSm}`}
                      onClick={() => updateRuleSet(index, { name: ours.name, text: ours.text })}
                    >
                      {t('prefs.shortcutRestore')}
                    </button>
                  ) : null}
                  {!isGeneral ? (
                    <button
                      type="button"
                      className={`${controls.btn} ${controls.btnSm} ${controls.btnSmDanger}`}
                      onClick={() => saveRuleSets(ruleSets.filter((_, i) => i !== index))}
                    >
                      {t('prefs.shortcutDelete')}
                    </button>
                  ) : null}
                </div>
              </div>
            )
          })}
        </div>
        {ruleSets.length === 0 ? (
          <p className={multiagentStyles.shortcutHint}>{t('prefs.ruleSetsEmpty')}</p>
        ) : null}
        <div className={multiagentStyles.ruleActions}>
          <button
            type="button"
            className={controls.btn}
            onClick={() =>
              saveRuleSets([
                ...ruleSets,
                { id: `custom-${crypto.randomUUID()}`, name: t('prefs.ruleSetNewName'), text: '' },
              ])
            }
          >
            {t('prefs.ruleSetAdd')}
          </button>
          <button
            type="button"
            className={controls.btn}
            onClick={() => setPreferences({ workerRuleSets: null })}
          >
            {t('prefs.ruleSetsRestoreAll')}
          </button>
        </div>
      </SettingsSection>
```

- [ ] **Step 3: Add the locale strings**

`en.ts` (and the pt-BR counterparts):

```ts
  'prefs.workerRules': 'Rules for delegated work',
  'prefs.workerRulesDesc':
    'What Alethe tells the agents it delegates to. The general set goes with every task; the lead agent names the set that matches the work. A repository’s own conventions always win over these.',
  'prefs.ruleSetName': 'Set name',
  'prefs.ruleSetText': 'Rules',
  'prefs.ruleSetSize': '{count} characters, sent with every task of this set',
  'prefs.ruleSetDuplicate': 'Another set already uses this name.',
  'prefs.ruleSetAdd': 'Add set',
  'prefs.ruleSetNewName': 'New set',
  'prefs.ruleSetsEmpty': 'No rules are sent with delegated work.',
  'prefs.ruleSetsRestoreAll': 'Restore Alethe’s sets',
```

- [ ] **Step 4: Style it**

Add to `MultiagentPage.module.css`, tokens only, mirroring the shortcut classes already there: `.ruleList` (column, gap 10px), `.ruleSet` (border `1px solid var(--border)`, radius 8px, padding 10px, background `var(--bg-elevated)`), `.ruleText` (`resize: vertical`, `font-family: var(--font-mono)`, `font-size: 12px`), `.ruleFoot` (row, gap 6px, `align-items: center`), `.ruleCount` and `.ruleWarn` (`color: var(--fg-muted)` / `var(--status-offline)`, `font-size: 11px`), `.ruleActions` (row, gap 6px).

- [ ] **Step 5: Verify**

Run: `npm run build` → exit 0
Run: `npm test` → PASS

- [ ] **Step 6: Stage**

```bash
git add src/components/modals/preferences src/lib/i18n/messages
```

---

### Task 9: The board shows the set, changelog, whole-suite pass

**Files:**
- Modify: `src/components/OrchestratorPane/index.tsx` (`RunNode`)
- Modify: `src/lib/i18n/messages/en.ts`, `pt-BR.ts`, `docs/CHANGELOG.md`

**Interfaces:**
- Consumes: `OrchestratorJob.rules` (Task 6).

- [ ] **Step 1: Show it on the run node**

`RunNode` receives an `OrchestratorRun`; its jobs carry `rules`. In `src/lib/orchestratorRuns.ts`, where `groupRuns` builds each run, carry the set through the same way `label` is derived:

```ts
    const ruled = runJobs.find((job) => (job.rules ?? '').trim().length > 0)
```

and add `rules: ruled?.rules ?? null` to the returned `OrchestratorRun`, with the field added to that type. In `RunNode`'s `runFoot`, beside the worker count:

```tsx
          {run.rules ? <span title={t('orchestrator.runRulesTitle')}>{run.rules}</span> : null}
```

Add `'orchestrator.runRulesTitle': 'Rule set this run was delegated with'` to both locales.

- [ ] **Step 2: Write the changelog entry**

Under `## [Unreleased]` → `### Added`:

```markdown
- **Alethe now hands its own engineering rules to the agents it delegates to.** Every delegated task
  carries a general set — verify before you report, write the failing test first, record an
  architecture decision in the same change, never weaken shared CI to make your change pass — and the
  lead agent names the set that matches the work, so a frontend worker gets frontend rules instead of
  database ones. Alethe ships General, Backend and Frontend, written to hold in any language or
  framework; a repository's own conventions always win over them. Edit them, add your own — "Banco de
  Dados", "Pesquisa" — or remove them entirely in Preferences → Multiagent, and the board shows which
  set each run was delegated with.
```

- [ ] **Step 3: Run everything**

```powershell
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo test --manifest-path src-tauri/Cargo.toml --test orchestrator
```

All four must pass.

- [ ] **Step 4: Stage**

```bash
git add src/components/OrchestratorPane src/lib/orchestratorRuns.ts src/lib/i18n/messages docs/CHANGELOG.md
```

---

## Manual verification (owner, after the tasks)

Not a task for an implementer — the app must not be started by one.

1. Preferences → Multiagent shows General, Backend and Frontend with our text and a character count.
2. Edit General, add a set named "Banco de Dados", reopen Preferences: both persisted.
3. Ask the planner to delegate something with `rules: "Banco de Dados"`; the worker's transcript opens with the rules block and the board's run shows the set.
4. Ask it to delegate with a misspelled set name: the call is refused and names the valid sets.
5. Delete every set, delegate again: the worker gets no rules block and nothing breaks.
6. Press "Restore Alethe's sets": ours come back.
