//! Reads `projects.json` to mirror the desktop app's theme/icon/locale on the
//! remote client, and to pick which branded icon it serves.

use serde::Serialize;
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::paths::projects_file_path;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteAppearance {
    ui_theme: String,
    app_icon_theme: String,
    language: String,
    motion_preference: String,
    color_scheme: String,
}

pub(crate) fn projects_document(app: &AppHandle) -> Value {
    let Ok(path) = projects_file_path(app) else {
        return json!({});
    };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str::<Value>(&content).ok())
        .unwrap_or_else(|| json!({}))
}

pub(crate) fn remote_appearance(app: &AppHandle) -> Value {
    json!(appearance_from_document(&projects_document(app)))
}

fn appearance_from_document(document: &Value) -> RemoteAppearance {
    let preferences = document.get("preferences").unwrap_or(&Value::Null);
    let ui_theme = preferences
        .get("uiTheme")
        .and_then(Value::as_str)
        .filter(|theme| is_known_theme(theme))
        .unwrap_or("elite-indigo")
        .to_string();
    let app_icon_theme = preferences
        .get("appIconTheme")
        .and_then(Value::as_str)
        .filter(|theme| is_known_app_icon(theme))
        .unwrap_or("elite-indigo")
        .to_string();
    let language = match preferences.get("language").and_then(Value::as_str) {
        Some("pt-BR") => "pt-BR",
        _ => "en",
    }
    .to_string();
    let motion_preference = match preferences.get("motionPreference").and_then(Value::as_str) {
        Some("reduced") => "reduced",
        _ => "animated",
    }
    .to_string();
    let color_scheme = if is_light_theme(&ui_theme) {
        "light"
    } else {
        "dark"
    }
    .to_string();

    RemoteAppearance {
        ui_theme,
        app_icon_theme,
        language,
        motion_preference,
        color_scheme,
    }
}

fn is_known_theme(theme: &str) -> bool {
    matches!(
        theme,
        "elite-original"
            | "elite-pure-black"
            | "elite-indigo"
            | "elite-blush"
            | "dark"
            | "light"
            | "dracula"
            | "nord"
            | "gruvbox"
            | "solarized"
            | "tokyo-night"
            | "vscode"
            | "min-dark"
            | "min-light"
            | "dark-lemon"
            | "orca"
            | "ember"
            | "golden-premium"
    )
}

fn is_light_theme(theme: &str) -> bool {
    matches!(
        theme,
        "elite-original" | "elite-blush" | "light" | "min-light"
    )
}

fn is_known_app_icon(theme: &str) -> bool {
    matches!(
        theme,
        "elite-original" | "elite-pure-black" | "elite-indigo" | "elite-blush"
    )
}

pub(crate) fn selected_brand_icon(document: &Value) -> &'static [u8] {
    match appearance_from_document(document).app_icon_theme.as_str() {
        "elite-original" => include_bytes!("../../../src/assets/theme-icons/elite-original.png"),
        "elite-pure-black" => {
            include_bytes!("../../../src/assets/theme-icons/elite-pure-black.png")
        }
        "elite-blush" => include_bytes!("../../../src/assets/theme-icons/elite-blush.png"),
        _ => include_bytes!("../../../src/assets/theme-icons/elite-indigo.png"),
    }
}

#[cfg(test)]
mod tests {
    use super::{appearance_from_document, selected_brand_icon, RemoteAppearance};
    use serde_json::json;

    #[test]
    fn appearance_defaults_are_safe_and_branded() {
        assert_eq!(
            appearance_from_document(&json!({})),
            RemoteAppearance {
                ui_theme: "elite-indigo".into(),
                app_icon_theme: "elite-indigo".into(),
                language: "en".into(),
                motion_preference: "animated".into(),
                color_scheme: "dark".into(),
            }
        );
    }

    #[test]
    fn appearance_accepts_persisted_light_preferences() {
        assert_eq!(
            appearance_from_document(&json!({
                "preferences": {
                    "uiTheme": "elite-blush",
                    "appIconTheme": "elite-original",
                    "language": "pt-BR",
                    "motionPreference": "reduced"
                }
            })),
            RemoteAppearance {
                ui_theme: "elite-blush".into(),
                app_icon_theme: "elite-original".into(),
                language: "pt-BR".into(),
                motion_preference: "reduced".into(),
                color_scheme: "light".into(),
            }
        );
    }

    #[test]
    fn appearance_rejects_unknown_persisted_values() {
        let appearance = appearance_from_document(&json!({
            "preferences": {
                "uiTheme": "custom-script",
                "appIconTheme": "missing-icon",
                "language": "unknown",
                "motionPreference": "spin"
            }
        }));

        assert_eq!(appearance.ui_theme, "elite-indigo");
        assert_eq!(appearance.app_icon_theme, "elite-indigo");
        assert_eq!(appearance.language, "en");
        assert_eq!(appearance.motion_preference, "animated");
    }

    #[test]
    fn selected_brand_icon_uses_embedded_png_assets() {
        let icon = selected_brand_icon(&json!({
            "preferences": { "appIconTheme": "elite-blush" }
        }));

        assert_eq!(&icon[..8], b"\x89PNG\r\n\x1a\n");
        assert_ne!(
            icon,
            selected_brand_icon(&json!({
                "preferences": { "appIconTheme": "elite-indigo" }
            }))
        );
    }
}
