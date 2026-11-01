//! Keeps the AppImage runtime environment out of processes Alethe starts for the user.
//!
//! The AppImage launchers (AppImageKit's `AppRun` and linuxdeploy's GTK hook) point
//! `LD_LIBRARY_PATH`, `PATH`, `PYTHONHOME`, `GTK_*` and friends into the squashfs mount. Alethe
//! itself needs them (WebKit's helper processes load the bundled libraries), so they cannot be
//! cleared at startup. Every child inherits them, though: system `curl` then resolves the
//! bundled `libnghttp2` and fails on a missing symbol, and `python` looks for its stdlib inside
//! the mount. The launchers append the values the user had, so dropping only the entries under
//! `$APPDIR` restores the original environment.

use portable_pty::CommandBuilder;
use std::process::Command;
use std::sync::OnceLock;

/// Set by the GTK hook with no path in them, overwriting whatever the user had.
const HOOK_ONLY_VARS: [&str; 2] = ["GDK_BACKEND", "GTK_THEME"];
/// Describe the AppImage itself and mean nothing to a child.
const APPIMAGE_VARS: [&str; 4] = ["APPDIR", "APPIMAGE", "ARGV0", "OWD"];

/// `Some(value)` sets the variable, `None` removes it.
type Override = (String, Option<String>);

/// Applies the overrides to a terminal before it spawns.
pub fn scrub_pty(builder: &mut CommandBuilder) {
    for (key, value) in overrides() {
        match value {
            Some(value) => builder.env(key, value),
            None => builder.env_remove(key),
        }
    }
}

/// Applies the overrides to a helper the user sees, such as the browser `xdg-open` launches.
pub fn scrub_command(command: &mut Command) -> &mut Command {
    for (key, value) in overrides() {
        match value {
            Some(value) => command.env(key, value),
            None => command.env_remove(key),
        };
    }
    command
}

fn overrides() -> &'static [Override] {
    static OVERRIDES: OnceLock<Vec<Override>> = OnceLock::new();
    OVERRIDES.get_or_init(|| {
        if !cfg!(target_os = "linux") || std::env::var_os("APPIMAGE").is_none() {
            return Vec::new();
        }
        let Ok(appdir) = std::env::var("APPDIR") else {
            return Vec::new();
        };
        let vars = std::env::vars_os()
            .filter_map(|(key, value)| Some((key.into_string().ok()?, value.into_string().ok()?)));
        compute_overrides(&appdir, vars)
    })
}

fn compute_overrides(appdir: &str, vars: impl Iterator<Item = (String, String)>) -> Vec<Override> {
    let appdir = appdir.trim_end_matches('/');
    if appdir.is_empty() {
        return Vec::new();
    }
    let under_appdir = |entry: &str| {
        entry
            .strip_prefix(appdir)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
    };
    let mut overrides = Vec::new();
    for (key, value) in vars {
        if HOOK_ONLY_VARS.contains(&key.as_str()) || APPIMAGE_VARS.contains(&key.as_str()) {
            overrides.push((key, None));
            continue;
        }
        if !value.split(':').any(|entry| under_appdir(entry)) {
            continue;
        }
        // Empty entries come from the launchers appending an unset original; in PATH or
        // LD_LIBRARY_PATH they would mean the current directory.
        let kept: Vec<&str> = value
            .split(':')
            .filter(|entry| !entry.is_empty() && !under_appdir(entry))
            .collect();
        let restored = (!kept.is_empty()).then(|| kept.join(":"));
        overrides.push((key, restored));
    }
    overrides
}

#[cfg(test)]
mod tests {
    use super::*;

    const APPDIR: &str = "/tmp/.mount_aletheX";

    fn run(vars: &[(&str, &str)]) -> Vec<Override> {
        let mut out = compute_overrides(
            APPDIR,
            vars.iter().map(|(k, v)| (k.to_string(), v.to_string())),
        );
        out.sort();
        out
    }

    #[test]
    fn keeps_the_user_entries_of_path_lists() {
        let out = run(&[
            (
                "PATH",
                "/tmp/.mount_aletheX/usr/bin/:/tmp/.mount_aletheX/bin/:/usr/bin:/bin",
            ),
            (
                "LD_LIBRARY_PATH",
                "/tmp/.mount_aletheX/usr/lib/:/opt/cuda/lib64:",
            ),
        ]);
        assert_eq!(
            out,
            vec![
                ("LD_LIBRARY_PATH".into(), Some("/opt/cuda/lib64".into())),
                ("PATH".into(), Some("/usr/bin:/bin".into())),
            ]
        );
    }

    #[test]
    fn removes_variables_left_with_only_bundle_entries() {
        let out = run(&[
            ("PYTHONHOME", "/tmp/.mount_aletheX/usr/"),
            (
                "PERLLIB",
                "/tmp/.mount_aletheX/usr/share/perl5/:/tmp/.mount_aletheX/usr/lib/perl5/:",
            ),
            ("GTK_PATH", "/tmp/.mount_aletheX//usr/lib/gtk-3.0"),
        ]);
        assert_eq!(
            out,
            vec![
                ("GTK_PATH".into(), None),
                ("PERLLIB".into(), None),
                ("PYTHONHOME".into(), None),
            ]
        );
    }

    #[test]
    fn removes_hook_and_appimage_variables() {
        let out = run(&[
            ("GDK_BACKEND", "x11"),
            ("GTK_THEME", "Adwaita:dark"),
            ("APPDIR", APPDIR),
            ("APPIMAGE", "/home/u/AppImages/alethe.appimage"),
        ]);
        assert!(out.iter().all(|(_, value)| value.is_none()));
        assert_eq!(out.len(), 4);
    }

    #[test]
    fn leaves_unrelated_and_lookalike_values_alone() {
        let out = run(&[
            ("HOME", "/home/u"),
            ("PATH", "/usr/bin:/tmp/.mount_aletheXY/bin"),
        ]);
        assert!(out.is_empty());
    }

    #[test]
    fn does_nothing_without_an_appdir() {
        let out = compute_overrides(
            "/",
            [("PATH".to_string(), "/usr/bin".to_string())].into_iter(),
        );
        assert!(out.is_empty());
    }
}
