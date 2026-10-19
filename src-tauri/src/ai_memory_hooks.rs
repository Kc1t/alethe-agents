//! Merging ai-memory's lifecycle hooks into the settings file Alethe writes per terminal.
//!
//! Alethe owns that file, so this is the only place either side's hooks meet: the person's own
//! `settings.json` is never touched, the scope is one terminal, and stopping the integration simply
//! stops writing them.

use std::collections::HashSet;

use serde_json::{Map, Value};

/// Whether one hook entry runs ai-memory's capture (`ai-memory … hook --event …`), in either the
/// shell form (`command` holds the whole line) or the exec form (`command` plus `args`).
fn is_ai_memory_capture(hook: &Value) -> bool {
    let mut line = hook
        .get("command")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    for arg in hook
        .get("args")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Some(arg) = arg.as_str() {
            line.push(' ');
            line.push_str(arg);
        }
    }
    let words: Vec<&str> = line
        .split_whitespace()
        .map(|word| word.trim_matches(|c| c == '\'' || c == '"'))
        .collect();
    let runs_ai_memory = words.iter().any(|word| {
        let name = word.rsplit(['/', '\\']).next().unwrap_or(word);
        name == "ai-memory" || name == "ai-memory.exe"
    });
    runs_ai_memory && words.contains(&"hook") && words.contains(&"--event")
}

/// The events the person's own Claude Code settings already capture with ai-memory.
///
/// Claude Code runs the hooks of every settings source and collapses only those whose command text
/// is identical. ai-memory's own installer writes its hooks into `~/.claude/settings.json`, and the
/// copy Alethe adds reaches the same binary by another path, so both would run and every prompt and
/// tool call would be recorded twice. ai-memory does not drop the second one when both arrive at once.
pub fn events_already_captured(user_settings: &Value) -> HashSet<String> {
    let Some(hooks) = user_settings.get("hooks").and_then(Value::as_object) else {
        return HashSet::new();
    };
    hooks
        .iter()
        .filter(|(_, groups)| {
            groups.as_array().into_iter().flatten().any(|group| {
                group
                    .get("hooks")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .any(is_ai_memory_capture)
            })
        })
        .map(|(event, _)| event.clone())
        .collect()
}

/// ai-memory's hooks minus the events in `skip`. Anything that is not an object comes back as is,
/// for `merge_hooks` to refuse.
pub fn without_events(theirs: &Value, skip: &HashSet<String>) -> Value {
    match theirs.as_object() {
        Some(events) => Value::Object(
            events
                .iter()
                .filter(|(event, _)| !skip.contains(*event))
                .map(|(event, entries)| (event.clone(), entries.clone()))
                .collect(),
        ),
        None => theirs.clone(),
    }
}

/// Adds ai-memory's hook entries to Alethe's hooks object.
///
/// Arrays for a shared event are concatenated rather than replaced, which is how Claude Code treats
/// hooks from several settings sources. All or nothing: a shape we do not recognise leaves `alethe`
/// exactly as it was.
pub fn merge_hooks(alethe: &mut Map<String, Value>, theirs: &Value) -> Result<(), String> {
    let theirs = theirs
        .as_object()
        .ok_or_else(|| "ai_memory_hooks_not_an_object".to_string())?;

    let mut additions: Vec<(String, Vec<Value>)> = Vec::new();
    for (event, entries) in theirs {
        let entries = entries
            .as_array()
            .ok_or_else(|| format!("ai_memory_hooks_event_not_an_array:{event}"))?;
        additions.push((event.clone(), entries.clone()));
    }

    for (event, entries) in additions {
        match alethe.get_mut(&event).and_then(Value::as_array_mut) {
            Some(existing) => existing.extend(entries),
            None => {
                alethe.insert(event, Value::Array(entries));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn alethe_side() -> serde_json::Map<String, serde_json::Value> {
        // What `agent_hooks_settings_path` already builds: http hooks back to Alethe's listener.
        let hook = json!([{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:9123/hook" }] }]);
        let mut hooks = serde_json::Map::new();
        hooks.insert("SessionStart".into(), hook.clone());
        hooks.insert("UserPromptSubmit".into(), hook);
        hooks
    }

    fn their_side() -> serde_json::Value {
        json!({
            "SessionStart": [{ "matcher": "", "hooks": [
                { "type": "command", "command": "ai-memory", "args": ["hook", "--event", "session-start"] }
            ]}],
            "Stop": [{ "matcher": "", "hooks": [
                { "type": "command", "command": "ai-memory", "args": ["hook", "--event", "stop"] }
            ]}]
        })
    }

    #[test]
    fn both_sides_survive_on_an_event_they_share() {
        // Verified against the real CLI before this was designed: hook arrays from two settings
        // sources both fire. Losing either side breaks capture or orchestration, silently.
        let mut alethe = alethe_side();
        merge_hooks(&mut alethe, &their_side()).expect("merges");

        let start = alethe.get("SessionStart").unwrap().as_array().unwrap();
        assert_eq!(start.len(), 2, "Alethe's entry and theirs: {start:?}");
        let rendered = serde_json::to_string(start).unwrap();
        assert!(rendered.contains("\"type\":\"http\""), "{rendered}");
        assert!(rendered.contains("session-start"), "{rendered}");
    }

    #[test]
    fn an_event_only_ai_memory_wants_is_added() {
        let mut alethe = alethe_side();
        merge_hooks(&mut alethe, &their_side()).unwrap();
        assert_eq!(alethe.get("Stop").unwrap().as_array().unwrap().len(), 1);
    }

    #[test]
    fn an_event_only_alethe_wants_is_untouched() {
        let mut alethe = alethe_side();
        merge_hooks(&mut alethe, &their_side()).unwrap();
        assert_eq!(alethe.get("UserPromptSubmit").unwrap().as_array().unwrap().len(), 1);
    }

    fn user_settings(command: serde_json::Value) -> serde_json::Value {
        json!({ "hooks": {
            "UserPromptSubmit": [{ "matcher": "", "hooks": [command] }],
            "Notification": [{ "hooks": [{ "type": "command", "command": "say done" }] }]
        }})
    }

    #[test]
    fn capture_the_person_installed_is_found_in_shell_and_exec_form() {
        // What `ai-memory install-hooks --apply` writes, with a quoted data dir that has spaces.
        let shell = user_settings(json!({ "type": "command", "command":
            "/opt/homebrew/bin/ai-memory --data-dir '/Users/x/Library/Application Support/ai-memory' hook --event user-prompt-submit --agent claude-code --server-url http://127.0.0.1:49374" }));
        let exec = user_settings(json!({ "type": "command", "command": "ai-memory",
            "args": ["hook", "--event", "user-prompt-submit"] }));
        let windows = user_settings(json!({ "type": "command", "command":
            "C:\\Tools\\ai-memory.exe hook --event user-prompt-submit" }));
        for settings in [shell, exec, windows] {
            let found = events_already_captured(&settings);
            assert_eq!(
                found,
                HashSet::from(["UserPromptSubmit".to_string()]),
                "{settings}"
            );
        }
    }

    #[test]
    fn other_hooks_and_other_ai_memory_commands_are_not_capture() {
        for command in [
            json!({ "type": "command", "command": "say hook --event" }),
            json!({ "type": "command", "command": "ai-memory status" }),
            json!({ "type": "command", "command": "my-ai-memory-wrapper hook --event stop" }),
            json!({ "type": "http", "url": "http://127.0.0.1:9123/hook" }),
        ] {
            assert!(
                events_already_captured(&user_settings(command.clone())).is_empty(),
                "{command}"
            );
        }
        assert!(events_already_captured(&json!({})).is_empty());
        assert!(events_already_captured(&json!({ "hooks": "nope" })).is_empty());
    }

    #[test]
    fn events_the_person_already_captures_are_left_out_of_the_merge() {
        let skip = HashSet::from(["SessionStart".to_string()]);
        let mut alethe = alethe_side();
        merge_hooks(&mut alethe, &without_events(&their_side(), &skip)).unwrap();
        assert_eq!(
            alethe
                .get("SessionStart")
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            1,
            "Alethe's own"
        );
        assert_eq!(
            alethe.get("Stop").unwrap().as_array().unwrap().len(),
            1,
            "still added"
        );
        // A shape we cannot read passes through, so `merge_hooks` still refuses it.
        assert!(merge_hooks(&mut alethe_side(), &without_events(&json!("nope"), &skip)).is_err());
    }

    #[test]
    fn an_unfamiliar_shape_is_refused_and_changes_nothing() {
        // Every terminal reads this file. A half-merged one breaks all of them, so a shape we do
        // not recognise must leave Alethe's own hooks exactly as they were.
        for bad in [json!("nope"), json!(["SessionStart"]), json!({ "SessionStart": 3 })] {
            let mut alethe = alethe_side();
            let before = serde_json::to_string(&alethe).unwrap();
            assert!(merge_hooks(&mut alethe, &bad).is_err(), "{bad:?}");
            assert_eq!(serde_json::to_string(&alethe).unwrap(), before, "left intact");
        }
    }
}
