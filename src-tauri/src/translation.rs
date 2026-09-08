//! Optional machine translation for text the app displays but did not author — today, commit
//! messages written in a language other than the one the UI is set to.
//!
//! Two deliberate properties, because this is the only feature in the app that sends repository
//! content to a third party:
//!
//! - **Nothing is translated implicitly.** The frontend detects the language locally and offline
//!   (`src/lib/detectLanguage.ts`) and only offers a button; a request leaves the machine when the
//!   user clicks it, having been told where the text goes.
//! - **The key lives in the OS keyring**, never in `projects.json` or any other plaintext app
//!   file, on its own keyring service separate from the keys Alethe generates for itself.

use serde::Deserialize;

const TRANSLATION_SERVICE: &str = "com.kc1t.alethe.translation";
const TRANSLATION_KEY_ENTRY: &str = "deepl-api-key";

/// DeepL routes free-tier keys to a different host than paid ones, and marks free keys with this
/// suffix — so the right endpoint can be picked from the key itself rather than asking the user
/// which plan they are on.
const FREE_KEY_SUFFIX: &str = ":fx";
const API_HOST_FREE: &str = "https://api-free.deepl.com/v2/translate";
const API_HOST_PRO: &str = "https://api.deepl.com/v2/translate";

/// Guards against sending something unbounded to a paid API by accident. Commit messages are
/// nowhere near this; anything that is has almost certainly been passed in by mistake.
const MAX_TRANSLATION_CHARS: usize = 20_000;

fn key_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(TRANSLATION_SERVICE, TRANSLATION_KEY_ENTRY)
        .map_err(|_| "translation_credential_store_unavailable".to_string())
}

fn load_key() -> Result<Option<String>, String> {
    match key_entry()?.get_secret() {
        Ok(secret) => String::from_utf8(secret)
            .map(Some)
            .map_err(|_| "translation_key_decode_failed".to_string()),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("translation_credential_store_unavailable".to_string()),
    }
}

/// Maps an app locale onto a DeepL target language. DeepL wants a regional code for Portuguese
/// (`PT-BR` vs `PT-PT`) and rejects a bare `PT`.
fn target_language_for(locale: &str) -> Result<&'static str, String> {
    match locale {
        "pt-BR" => Ok("PT-BR"),
        "en" => Ok("EN-US"),
        _ => Err(format!("translation_unsupported_locale:{locale}")),
    }
}

#[derive(Deserialize)]
struct DeepLResponse {
    translations: Vec<DeepLTranslation>,
}

#[derive(Deserialize)]
struct DeepLTranslation {
    text: String,
    /// What DeepL itself detected the source language to be — returned to the caller so the UI can
    /// say what it translated from rather than repeating the local guess.
    detected_source_language: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationResult {
    pub text: String,
    pub detected_source_language: Option<String>,
}

/// True when a key is stored. Never returns the key itself — the frontend only needs to know
/// whether to offer the feature.
#[tauri::command]
pub fn translation_has_api_key() -> Result<bool, String> {
    Ok(load_key()?.is_some())
}

#[tauri::command]
pub async fn translation_set_api_key(key: String) -> Result<(), String> {
    let key = key.trim().to_string();
    if key.is_empty() {
        return Err("translation_key_empty".to_string());
    }
    // Verify before storing: a typo'd key saved silently would only surface later, as a confusing
    // failure at the moment the user actually asked for a translation.
    translate_with_key(&key, "ok", "EN-US").await?;
    key_entry()?
        .set_secret(key.as_bytes())
        .map_err(|_| "translation_credential_store_unavailable".to_string())
}

#[tauri::command]
pub fn translation_clear_api_key() -> Result<(), String> {
    match key_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("translation_credential_store_unavailable".to_string()),
    }
}

async fn translate_with_key(
    key: &str,
    text: &str,
    target_language: &str,
) -> Result<TranslationResult, String> {
    let endpoint = if key.ends_with(FREE_KEY_SUFFIX) {
        API_HOST_FREE
    } else {
        API_HOST_PRO
    };
    let response = reqwest::Client::new()
        .post(endpoint)
        .header("Authorization", format!("DeepL-Auth-Key {key}"))
        .form(&[("text", text), ("target_lang", target_language)])
        .send()
        .await
        .map_err(|error| format!("translation_request_failed:{error}"))?;

    let status = response.status();
    if !status.is_success() {
        // The body can carry the key in an echoed request under some error shapes, so only the
        // status code is surfaced.
        return Err(format!("translation_http_error:{}", status.as_u16()));
    }

    let parsed: DeepLResponse = response
        .json()
        .await
        .map_err(|error| format!("translation_decode_failed:{error}"))?;
    let first = parsed
        .translations
        .into_iter()
        .next()
        .ok_or_else(|| "translation_empty_response".to_string())?;
    Ok(TranslationResult {
        text: first.text,
        detected_source_language: first.detected_source_language,
    })
}

/// Translates one piece of text into the app's current locale.
///
/// Only ever called from an explicit user action — see the module docs. The text leaves the
/// machine on this call.
#[tauri::command]
pub async fn translation_translate(text: String, locale: String) -> Result<TranslationResult, String> {
    if text.trim().is_empty() {
        return Err("translation_text_empty".to_string());
    }
    if text.len() > MAX_TRANSLATION_CHARS {
        return Err("translation_text_too_long".to_string());
    }
    let target_language = target_language_for(&locale)?;
    let key = load_key()?.ok_or_else(|| "translation_key_missing".to_string())?;
    translate_with_key(&key, &text, target_language).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn free_and_pro_keys_select_different_endpoints() {
        // DeepL rejects a free key on the pro host and vice versa, so this is picked from the key
        // rather than asked of the user.
        assert!("abc-123:fx".ends_with(FREE_KEY_SUFFIX));
        assert!(!"abc-123".ends_with(FREE_KEY_SUFFIX));
    }

    #[test]
    fn locales_map_to_regional_target_languages() {
        // A bare "PT" is rejected by DeepL — it wants PT-BR or PT-PT.
        assert_eq!(target_language_for("pt-BR").unwrap(), "PT-BR");
        assert_eq!(target_language_for("en").unwrap(), "EN-US");
        assert!(target_language_for("fr").is_err());
    }
}
