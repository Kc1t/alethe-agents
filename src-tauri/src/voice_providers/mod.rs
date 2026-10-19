//! Cloud speech providers. Keys stay in the OS keychain and every request is built here, in
//! Rust, so the webview never sees a key and the CSP needs no new `connect-src` entries.

pub mod catalog;
pub mod http;
pub mod keys;
pub mod openrouter;
pub mod stt_cloud;
pub mod tts_cloud;

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CloudProvider {
    Openai,
    Elevenlabs,
    Gemini,
    Openrouter,
}

impl CloudProvider {
    pub const ALL: [CloudProvider; 4] = [
        CloudProvider::Openai,
        CloudProvider::Elevenlabs,
        CloudProvider::Gemini,
        CloudProvider::Openrouter,
    ];

    pub fn id(self) -> &'static str {
        match self {
            Self::Openai => "openai",
            Self::Elevenlabs => "elevenlabs",
            Self::Gemini => "gemini",
            Self::Openrouter => "openrouter",
        }
    }
}
