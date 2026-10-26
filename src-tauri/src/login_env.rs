//! The user's login-shell environment, for a GUI launch on macOS.
//!
//! An app opened from Finder, the Dock or Spotlight inherits launchd's environment: PATH is
//! `/usr/bin:/bin:/usr/sbin:/sbin` and LANG is unset. Everything a user sets up in `~/.zprofile`
//! or `~/.zshrc` (Homebrew, nvm, `~/.local/bin`, pnpm, volta) is missing, so `which` cannot find
//! the agent CLIs, npm-installed CLIs fail on `#!/usr/bin/env node`, and zsh runs in the C locale.
//! Every child (PTYs, `Command::new`) copies this process's environment, so loading the login
//! shell's environment once, before any thread starts, fixes all of them at the same time.

/// Brackets the environment dump, so whatever the shell's rc files print around it is ignored.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const MARKER: &str = "__ALETHE_LOGIN_ENV__";

/// Variables that describe the throwaway shell itself, not the user's setup.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const SKIPPED: &[&str] = &["PWD", "OLDPWD", "SHLVL", "_", "ALETHE_RESOLVING_ENV"];

/// Loads the login shell's environment into this process and makes sure the locale is UTF-8.
///
/// Must run before any other thread starts: `set_var` is not thread-safe.
#[cfg(target_os = "macos")]
pub fn hydrate() {
    use std::io::IsTerminal;

    // Started from a terminal (`npm run app`, `open` from a shell is not one): the environment is
    // already the user's. `ALETHE_SKIP_LOGIN_ENV` is the escape hatch for a shell that hangs.
    let from_terminal = std::io::stdin().is_terminal();
    if !from_terminal && std::env::var_os("ALETHE_SKIP_LOGIN_ENV").is_none() {
        match read_login_env() {
            Ok(vars) => {
                for (key, value) in vars {
                    std::env::set_var(key, value);
                }
            }
            Err(error) => eprintln!("[login_env] kept the launchd environment: {error}"),
        }
    }
    if let Some(lang) = utf8_lang_fallback(
        |key| std::env::var(key).ok(),
        apple_locale().as_deref(),
        |locale| {
            std::path::Path::new("/usr/share/locale")
                .join(locale)
                .is_dir()
        },
    ) {
        std::env::set_var("LANG", lang);
    }
}

#[cfg(not(target_os = "macos"))]
pub fn hydrate() {}

#[cfg(target_os = "macos")]
fn read_login_env() -> Result<Vec<(String, String)>, String> {
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    let shell = std::env::var("SHELL")
        .ok()
        .filter(|shell| !shell.trim().is_empty())
        .unwrap_or_else(|| "/bin/zsh".to_string());
    // Interactive and login, so both `.zprofile` and `.zshrc` run: nvm's installer writes to
    // `.zshrc`, Homebrew's to `.zprofile`. `env -0` keeps values with newlines intact.
    let script = format!("printf '{MARKER}'; /usr/bin/env -0; printf '{MARKER}'");
    let mut child = Command::new(&shell)
        .args(["-ilc", &script])
        .env("ALETHE_RESOLVING_ENV", "1")
        // oh-my-zsh asks whether to update on an interactive start; stdin is null anyway.
        .env("DISABLE_AUTO_UPDATE", "true")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("could not start {shell}: {error}"))?;

    // Read on a thread: a shell that fills the pipe would otherwise block `try_wait` forever.
    let mut stdout = child.stdout.take().ok_or("no stdout")?;
    let reader = std::thread::spawn(move || {
        let mut buffer = Vec::new();
        let _ = std::io::Read::read_to_end(&mut stdout, &mut buffer);
        buffer
    });
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("{shell} took longer than 5s to start"));
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    let output = reader.join().map_err(|_| "reader thread panicked")?;
    let vars = parse_env_dump(&output);
    if vars.iter().any(|(key, _)| key == "PATH") {
        Ok(vars)
    } else {
        Err(format!("{shell} printed no environment"))
    }
}

/// The `KEY=value` pairs between the two markers of `env -0` output.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_env_dump(output: &[u8]) -> Vec<(String, String)> {
    let text = String::from_utf8_lossy(output);
    let Some(start) = text.find(MARKER) else {
        return Vec::new();
    };
    let body = &text[start + MARKER.len()..];
    let Some(end) = body.rfind(MARKER) else {
        return Vec::new();
    };
    body[..end]
        .split('\0')
        .filter_map(|entry| entry.split_once('='))
        .filter(|(key, _)| !key.is_empty() && !SKIPPED.contains(key))
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect()
}

#[cfg(target_os = "macos")]
fn apple_locale() -> Option<String> {
    let output = std::process::Command::new("/usr/bin/defaults")
        .args(["read", "-g", "AppleLocale"])
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// The `LANG` to set when no locale variable already asks for UTF-8, or `None` to leave it alone.
/// `apple_locale` is the system setting (`pt_BR`, `en_US@rg=brzzzz`); `exists` reports whether
/// `<locale>.UTF-8` is installed.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn utf8_lang_fallback(
    var: impl Fn(&str) -> Option<String>,
    apple_locale: Option<&str>,
    exists: impl Fn(&str) -> bool,
) -> Option<String> {
    let is_utf8 = |value: &str| {
        let lower = value.to_ascii_lowercase();
        lower.contains("utf-8") || lower.contains("utf8")
    };
    // LC_ALL wins over LC_CTYPE, which wins over LANG: only the first one set counts.
    let effective = ["LC_ALL", "LC_CTYPE", "LANG"]
        .iter()
        .find_map(|key| var(key).filter(|value| !value.is_empty()));
    if effective.as_deref().is_some_and(is_utf8) {
        return None;
    }
    let candidate = apple_locale
        .map(|locale| locale.split('@').next().unwrap_or(locale).trim())
        .filter(|locale| !locale.is_empty())
        .map(|locale| format!("{locale}.UTF-8"))
        .filter(|locale| exists(locale));
    Some(candidate.unwrap_or_else(|| "en_US.UTF-8".to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dump(entries: &[&str]) -> Vec<u8> {
        let mut out = b"Last login: today\n".to_vec();
        out.extend_from_slice(MARKER.as_bytes());
        for entry in entries {
            out.extend_from_slice(entry.as_bytes());
            out.push(0);
        }
        out.extend_from_slice(MARKER.as_bytes());
        out.extend_from_slice(b"\nbye\n");
        out
    }

    #[test]
    fn parses_the_dump_between_markers_and_drops_shell_state() {
        let vars = parse_env_dump(&dump(&[
            "PATH=/opt/homebrew/bin:/usr/bin",
            "MULTI=line one\nline two",
            "PWD=/tmp",
            "SHLVL=2",
            "EQUALS=a=b",
        ]));
        assert_eq!(
            vars,
            vec![
                ("PATH".to_string(), "/opt/homebrew/bin:/usr/bin".to_string()),
                ("MULTI".to_string(), "line one\nline two".to_string()),
                ("EQUALS".to_string(), "a=b".to_string()),
            ]
        );
    }

    #[test]
    fn a_dump_without_both_markers_yields_nothing() {
        assert!(parse_env_dump(b"PATH=/usr/bin\0").is_empty());
        let mut half = MARKER.as_bytes().to_vec();
        half.extend_from_slice(b"PATH=/usr/bin\0");
        assert!(parse_env_dump(&half).is_empty());
    }

    #[test]
    fn keeps_a_utf8_locale_that_is_already_set() {
        let var = |key: &str| (key == "LANG").then(|| "pt_BR.UTF-8".to_string());
        assert_eq!(utf8_lang_fallback(var, Some("en_US"), |_| true), None);
    }

    #[test]
    fn lc_all_overrides_a_utf8_lang() {
        let var = |key: &str| match key {
            "LC_ALL" => Some("C".to_string()),
            "LANG" => Some("en_US.UTF-8".to_string()),
            _ => None,
        };
        assert_eq!(
            utf8_lang_fallback(var, Some("pt_BR"), |_| true),
            Some("pt_BR.UTF-8".to_string())
        );
    }

    #[test]
    fn uses_the_system_locale_without_its_region_override() {
        assert_eq!(
            utf8_lang_fallback(|_| None, Some("en_US@rg=brzzzz"), |l| l == "en_US.UTF-8"),
            Some("en_US.UTF-8".to_string())
        );
    }

    #[test]
    fn falls_back_to_en_us_when_the_system_locale_is_not_installed() {
        assert_eq!(
            utf8_lang_fallback(|_| None, Some("xx_YY"), |_| false),
            Some("en_US.UTF-8".to_string())
        );
        assert_eq!(
            utf8_lang_fallback(|_| None, None, |_| true),
            Some("en_US.UTF-8".to_string())
        );
    }
}
