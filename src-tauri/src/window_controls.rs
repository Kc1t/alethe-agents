//! Desktop window-control layout (minimize / maximize / close).
//!
//! On Linux/GNOME, `org.gnome.desktop.wm.preferences button-layout` decides which
//! side the buttons sit on (e.g. Pop!_OS / Ubuntu often use the left). Windows
//! keeps the classic right-hand order; macOS mirrors traffic-light order on the left.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WindowControlSide {
    Left,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WindowControlButton {
    Close,
    Minimize,
    Maximize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowControlsLayout {
    pub side: WindowControlSide,
    pub buttons: Vec<WindowControlButton>,
    /// Where the layout came from: `gnome`, `macos`, `windows`, or `linux-default`.
    pub source: String,
}

fn default_windows() -> WindowControlsLayout {
    WindowControlsLayout {
        side: WindowControlSide::Right,
        buttons: vec![
            WindowControlButton::Minimize,
            WindowControlButton::Maximize,
            WindowControlButton::Close,
        ],
        source: "windows".into(),
    }
}

fn default_macos() -> WindowControlsLayout {
    WindowControlsLayout {
        side: WindowControlSide::Left,
        buttons: vec![
            WindowControlButton::Close,
            WindowControlButton::Minimize,
            WindowControlButton::Maximize,
        ],
        source: "macos".into(),
    }
}

fn default_linux() -> WindowControlsLayout {
    // Ubuntu/Pop-style default when gsettings is unavailable.
    WindowControlsLayout {
        side: WindowControlSide::Left,
        buttons: vec![
            WindowControlButton::Close,
            WindowControlButton::Minimize,
            WindowControlButton::Maximize,
        ],
        source: "linux-default".into(),
    }
}

fn parse_button(token: &str) -> Option<WindowControlButton> {
    match token.trim().to_ascii_lowercase().as_str() {
        "close" => Some(WindowControlButton::Close),
        "minimize" | "min" => Some(WindowControlButton::Minimize),
        "maximize" | "max" => Some(WindowControlButton::Maximize),
        _ => None,
    }
}

fn parse_side(tokens: &str) -> Vec<WindowControlButton> {
    tokens
        .split(',')
        .filter_map(parse_button)
        .collect::<Vec<_>>()
}

/// Parse GNOME `button-layout` values such as `close,minimize,maximize:appmenu`.
pub fn parse_gnome_button_layout(raw: &str) -> Option<WindowControlsLayout> {
    let trimmed = raw.trim().trim_matches('\'').trim_matches('"').trim();
    if trimmed.is_empty() {
        return None;
    }

    let (left_raw, right_raw) = match trimmed.split_once(':') {
        Some((left, right)) => (left, right),
        None => (trimmed, ""),
    };

    let left = parse_side(left_raw);
    let right = parse_side(right_raw);

    let (side, buttons) = if !left.is_empty() {
        (WindowControlSide::Left, left)
    } else if !right.is_empty() {
        (WindowControlSide::Right, right)
    } else {
        return None;
    };

    Some(WindowControlsLayout {
        side,
        buttons,
        source: "gnome".into(),
    })
}

#[cfg(target_os = "linux")]
fn read_gnome_button_layout() -> Option<WindowControlsLayout> {
    let output = std::process::Command::new("gsettings")
        .args([
            "get",
            "org.gnome.desktop.wm.preferences",
            "button-layout",
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let raw = String::from_utf8_lossy(&output.stdout);
    parse_gnome_button_layout(&raw)
}

#[tauri::command]
pub fn desktop_window_controls() -> WindowControlsLayout {
    #[cfg(target_os = "windows")]
    {
        return default_windows();
    }

    #[cfg(target_os = "macos")]
    {
        return default_macos();
    }

    #[cfg(target_os = "linux")]
    {
        if let Some(layout) = read_gnome_button_layout() {
            return layout;
        }
        return default_linux();
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        default_windows()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_pop_os_left_layout() {
        let layout = parse_gnome_button_layout("'close,minimize,maximize:appmenu'").unwrap();
        assert_eq!(layout.side, WindowControlSide::Left);
        assert_eq!(
            layout.buttons,
            vec![
                WindowControlButton::Close,
                WindowControlButton::Minimize,
                WindowControlButton::Maximize,
            ]
        );
        assert_eq!(layout.source, "gnome");
    }

    #[test]
    fn parses_windows_like_right_layout() {
        let layout = parse_gnome_button_layout("appmenu:minimize,maximize,close").unwrap();
        assert_eq!(layout.side, WindowControlSide::Right);
        assert_eq!(
            layout.buttons,
            vec![
                WindowControlButton::Minimize,
                WindowControlButton::Maximize,
                WindowControlButton::Close,
            ]
        );
    }

    #[test]
    fn ignores_unknown_tokens() {
        let layout = parse_gnome_button_layout("spacer,close,appmenu:").unwrap();
        assert_eq!(layout.side, WindowControlSide::Left);
        assert_eq!(layout.buttons, vec![WindowControlButton::Close]);
    }

    #[test]
    fn empty_or_junk_returns_none() {
        assert!(parse_gnome_button_layout("").is_none());
        assert!(parse_gnome_button_layout("appmenu:spacer").is_none());
    }
}
