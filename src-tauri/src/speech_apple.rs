//! Apple's on-device speech recognition, through the Swift bridge in `src-tauri/swift/AletheSpeech`.
//! Every call blocks and must run on a blocking worker thread, never the macOS main thread.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeLocale {
    pub id: String,
    pub name: String,
    pub installed: bool,
}

// Only the linked bridge constructs most variants and calls the parsers below; without it
// (Windows, Linux, a Mac without Swift) they are kept for the shared code and the tests.
#[cfg_attr(not(apple_speech_linked), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Authorization {
    NotDetermined,
    Denied,
    Restricted,
    Authorized,
    /// The running binary has no `NSSpeechRecognitionUsageDescription`; asking would crash it.
    MissingUsageDescription,
}

impl Authorization {
    #[cfg_attr(not(apple_speech_linked), allow(dead_code))]
    pub fn from_code(code: i32) -> Self {
        match code {
            0 => Self::NotDetermined,
            2 => Self::Restricted,
            3 => Self::Authorized,
            4 => Self::MissingUsageDescription,
            _ => Self::Denied,
        }
    }
}

pub trait AppleBridge: Send + Sync {
    fn authorization(&self) -> Authorization;
    fn request_authorization(&self) -> Authorization;
    fn locales(&self) -> Vec<NativeLocale>;
    fn install(&self, locale: &str) -> Result<(), String>;
    fn install_progress(&self, locale: &str) -> Option<f64>;
    fn transcribe(&self, samples: &[f32], sample_rate: u32, locale: &str)
        -> Result<String, String>;
}

pub fn native_status(
    auth: Authorization,
    locales: &[NativeLocale],
    locale: Option<&str>,
) -> &'static str {
    if matches!(
        auth,
        Authorization::Denied | Authorization::Restricted | Authorization::MissingUsageDescription
    ) {
        return "denied";
    }
    let Some(id) = locale.filter(|id| !id.is_empty()) else {
        return "needs-locale";
    };
    match locales.iter().find(|candidate| candidate.id == id) {
        None => "unavailable",
        Some(found) if !found.installed => "not-installed",
        Some(_) => "ready",
    }
}

#[cfg_attr(not(apple_speech_linked), allow(dead_code))]
pub fn parse_locales(json: &str) -> Vec<NativeLocale> {
    serde_json::from_str(json).unwrap_or_default()
}

#[cfg_attr(not(apple_speech_linked), allow(dead_code))]
#[derive(Deserialize)]
struct TranscribeResult {
    text: Option<String>,
    error: Option<String>,
}

#[cfg_attr(not(apple_speech_linked), allow(dead_code))]
pub fn parse_transcription(json: &str) -> Result<String, String> {
    let result: TranscribeResult =
        serde_json::from_str(json).map_err(|e| format!("apple speech: bad result: {e}"))?;
    match (result.text, result.error) {
        (_, Some(error)) => Err(error),
        (Some(text), None) => Ok(text.trim().to_string()),
        (None, None) => Err("apple speech: empty result".to_string()),
    }
}

#[cfg(apple_speech_linked)]
mod linked {
    use super::{parse_locales, parse_transcription, AppleBridge, Authorization, NativeLocale};
    use std::ffi::{CStr, CString};
    use std::os::raw::c_char;

    extern "C" {
        fn alethe_speech_supported() -> bool;
        fn alethe_speech_authorization_status() -> i32;
        fn alethe_speech_authorize() -> i32;
        fn alethe_speech_locales() -> *mut c_char;
        fn alethe_speech_install(locale: *const c_char) -> *mut c_char;
        fn alethe_speech_install_progress(locale: *const c_char) -> f64;
        fn alethe_speech_transcribe(
            samples: *const f32,
            count: isize,
            sample_rate: i32,
            locale: *const c_char,
        ) -> *mut c_char;
        fn alethe_speech_free(ptr: *mut c_char);
    }

    /// Copies and frees a string the bridge allocated; `None` for a null pointer.
    fn take(ptr: *mut c_char) -> Option<String> {
        if ptr.is_null() {
            return None;
        }
        // SAFETY: the bridge returns a NUL-terminated strdup'd buffer, freed exactly once here.
        let text = unsafe { CStr::from_ptr(ptr) }
            .to_string_lossy()
            .into_owned();
        unsafe { alethe_speech_free(ptr) };
        Some(text)
    }

    fn c_locale(locale: &str) -> Result<CString, String> {
        CString::new(locale).map_err(|_| "apple speech: invalid locale".to_string())
    }

    /// False on macOS 10.15/11, which lack the Swift concurrency runtime the bridge needs.
    pub fn supported() -> bool {
        // SAFETY: a plain availability check; it touches no state and starts no task.
        unsafe { alethe_speech_supported() }
    }

    pub struct Linked;

    impl AppleBridge for Linked {
        fn authorization(&self) -> Authorization {
            Authorization::from_code(unsafe { alethe_speech_authorization_status() })
        }

        fn request_authorization(&self) -> Authorization {
            Authorization::from_code(unsafe { alethe_speech_authorize() })
        }

        fn locales(&self) -> Vec<NativeLocale> {
            take(unsafe { alethe_speech_locales() })
                .map(|json| parse_locales(&json))
                .unwrap_or_default()
        }

        fn install(&self, locale: &str) -> Result<(), String> {
            let id = c_locale(locale)?;
            match take(unsafe { alethe_speech_install(id.as_ptr()) }) {
                None => Ok(()),
                Some(reason) => Err(reason),
            }
        }

        fn install_progress(&self, locale: &str) -> Option<f64> {
            let id = c_locale(locale).ok()?;
            let fraction = unsafe { alethe_speech_install_progress(id.as_ptr()) };
            (fraction >= 0.0).then_some(fraction)
        }

        fn transcribe(
            &self,
            samples: &[f32],
            sample_rate: u32,
            locale: &str,
        ) -> Result<String, String> {
            if samples.is_empty() {
                return Ok(String::new());
            }
            let id = c_locale(locale)?;
            let json = take(unsafe {
                alethe_speech_transcribe(
                    samples.as_ptr(),
                    samples.len() as isize,
                    sample_rate as i32,
                    id.as_ptr(),
                )
            })
            .ok_or_else(|| "apple speech: no result".to_string())?;
            parse_transcription(&json)
        }
    }
}

pub fn bridge() -> Option<&'static dyn AppleBridge> {
    #[cfg(apple_speech_linked)]
    {
        static LINKED: linked::Linked = linked::Linked;
        static SUPPORTED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
        let bridge: &'static dyn AppleBridge = &LINKED;
        SUPPORTED.get_or_init(linked::supported).then_some(bridge)
    }
    #[cfg(not(apple_speech_linked))]
    {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn locale(id: &str, installed: bool) -> NativeLocale {
        NativeLocale {
            id: id.into(),
            name: id.into(),
            installed,
        }
    }

    #[test]
    fn authorization_codes_map_to_states() {
        assert_eq!(Authorization::from_code(0), Authorization::NotDetermined);
        assert_eq!(Authorization::from_code(1), Authorization::Denied);
        assert_eq!(Authorization::from_code(2), Authorization::Restricted);
        assert_eq!(Authorization::from_code(3), Authorization::Authorized);
        assert_eq!(
            Authorization::from_code(4),
            Authorization::MissingUsageDescription
        );
        assert_eq!(Authorization::from_code(99), Authorization::Denied);
    }

    #[test]
    fn status_follows_permission_then_locale() {
        let locales = [locale("pt-BR", true), locale("en-US", false)];
        assert_eq!(
            native_status(Authorization::Denied, &locales, Some("pt-BR")),
            "denied"
        );
        assert_eq!(
            native_status(Authorization::Restricted, &locales, Some("pt-BR")),
            "denied"
        );
        assert_eq!(
            native_status(
                Authorization::MissingUsageDescription,
                &locales,
                Some("pt-BR")
            ),
            "denied"
        );
        assert_eq!(
            native_status(Authorization::Authorized, &locales, None),
            "needs-locale"
        );
        assert_eq!(
            native_status(Authorization::Authorized, &locales, Some("")),
            "needs-locale"
        );
        assert_eq!(
            native_status(Authorization::Authorized, &locales, Some("fr-FR")),
            "unavailable"
        );
        assert_eq!(
            native_status(Authorization::Authorized, &locales, Some("en-US")),
            "not-installed"
        );
        assert_eq!(
            native_status(Authorization::Authorized, &locales, Some("pt-BR")),
            "ready"
        );
        // Permission is asked when capture starts, so an undecided one does not block readiness.
        assert_eq!(
            native_status(Authorization::NotDetermined, &locales, Some("pt-BR")),
            "ready"
        );
    }

    #[test]
    fn locales_parse_and_bad_json_is_empty() {
        assert_eq!(
            parse_locales(r#"[{"id":"pt-BR","installed":true,"name":"Português"}]"#),
            vec![NativeLocale {
                id: "pt-BR".into(),
                name: "Português".into(),
                installed: true
            }]
        );
        assert!(parse_locales("not json").is_empty());
    }

    #[test]
    fn transcription_results_parse() {
        assert_eq!(
            parse_transcription(r#"{"text":" oi "}"#),
            Ok("oi".to_string())
        );
        assert_eq!(
            parse_transcription(r#"{"error":"timeout"}"#),
            Err("timeout".to_string())
        );
        assert!(parse_transcription("garbage").is_err());
    }

    #[cfg(apple_speech_linked)]
    #[test]
    fn empty_audio_transcribes_to_empty_text_without_the_bridge() {
        let bridge = bridge().expect("linked");
        assert_eq!(bridge.transcribe(&[], 16_000, "en-US"), Ok(String::new()));
        assert!(bridge.transcribe(&[0.0], 16_000, "en\0US").is_err());
    }

    #[cfg(apple_speech_linked)]
    #[test]
    fn the_os_check_passes_on_the_test_host() {
        // Every supported CI and dev Mac runs macOS 12+; 10.15/11 would report false.
        assert!(linked::supported());
    }

    #[test]
    fn the_bridge_exists_only_when_linked() {
        assert_eq!(bridge().is_some(), cfg!(apple_speech_linked));
    }
}
