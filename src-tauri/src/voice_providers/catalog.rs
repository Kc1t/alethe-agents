use serde::Serialize;

use super::CloudProvider;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogModel {
    pub id: &'static str,
    pub label: &'static str,
    /// `stt` or `tts`.
    pub capability: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogVoice {
    pub id: &'static str,
    pub label: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCatalog {
    pub provider: CloudProvider,
    pub key_url: &'static str,
    pub models: &'static [CatalogModel],
    /// Empty when the voices come from the account (ElevenLabs).
    pub voices: &'static [CatalogVoice],
}

const fn m(id: &'static str, label: &'static str, capability: &'static str) -> CatalogModel {
    CatalogModel {
        id,
        label,
        capability,
    }
}

const fn v(id: &'static str, label: &'static str) -> CatalogVoice {
    CatalogVoice { id, label }
}

const OPENAI_VOICES: &[CatalogVoice] = &[
    v("alloy", "Alloy"),
    v("ash", "Ash"),
    v("ballad", "Ballad"),
    v("coral", "Coral"),
    v("echo", "Echo"),
    v("fable", "Fable"),
    v("nova", "Nova"),
    v("onyx", "Onyx"),
    v("sage", "Sage"),
    v("shimmer", "Shimmer"),
    v("verse", "Verse"),
];

const GEMINI_VOICES: &[CatalogVoice] = &[
    v("Kore", "Kore"),
    v("Puck", "Puck"),
    v("Charon", "Charon"),
    v("Fenrir", "Fenrir"),
    v("Aoede", "Aoede"),
    v("Leda", "Leda"),
    v("Orus", "Orus"),
    v("Zephyr", "Zephyr"),
];

static CATALOG: [ProviderCatalog; 4] = [
    ProviderCatalog {
        provider: CloudProvider::Openai,
        key_url: "https://platform.openai.com/api-keys",
        models: &[
            m("gpt-4o-transcribe", "GPT-4o Transcribe", "stt"),
            m("gpt-4o-mini-transcribe", "GPT-4o mini Transcribe", "stt"),
            m("whisper-1", "Whisper", "stt"),
            m("gpt-4o-mini-tts", "GPT-4o mini TTS", "tts"),
            m("tts-1", "TTS-1", "tts"),
        ],
        voices: OPENAI_VOICES,
    },
    ProviderCatalog {
        provider: CloudProvider::Elevenlabs,
        key_url: "https://elevenlabs.io/app/settings/api-keys",
        models: &[
            m("scribe_v2", "Scribe v2", "stt"),
            m("eleven_multilingual_v2", "Multilingual v2", "tts"),
            m("eleven_flash_v2_5", "Flash v2.5", "tts"),
        ],
        voices: &[],
    },
    ProviderCatalog {
        provider: CloudProvider::Gemini,
        key_url: "https://aistudio.google.com/apikey",
        models: &[
            m("gemini-2.5-flash", "Gemini 2.5 Flash", "stt"),
            m("gemini-3.8-flash-tts", "Gemini 3.8 Flash TTS", "tts"),
            m(
                "gemini-2.5-flash-preview-tts",
                "Gemini 2.5 Flash TTS",
                "tts",
            ),
            m(
                "gemini-3.1-flash-tts-preview",
                "Gemini 3.1 Flash TTS",
                "tts",
            ),
        ],
        voices: GEMINI_VOICES,
    },
    ProviderCatalog {
        provider: CloudProvider::Openrouter,
        key_url: "https://openrouter.ai/settings/keys",
        models: &[
            m(
                "openai/gpt-4o-mini-transcribe",
                "OpenAI GPT-4o mini Transcribe",
                "stt",
            ),
            m("openai/whisper-1", "OpenAI Whisper", "stt"),
            m(
                "google/gemini-3.8-flash-tts",
                "Google Gemini 3.8 Flash TTS",
                "tts",
            ),
        ],
        voices: GEMINI_VOICES,
    },
];

pub fn provider_catalog(provider: CloudProvider) -> &'static ProviderCatalog {
    CATALOG
        .iter()
        .find(|entry| entry.provider == provider)
        .expect("every provider has a catalog entry")
}

pub fn default_model(provider: CloudProvider, capability: &str) -> Option<&'static str> {
    provider_catalog(provider)
        .models
        .iter()
        .find(|model| model.capability == capability)
        .map(|model| model.id)
}

#[tauri::command]
pub fn voice_provider_catalog() -> Vec<&'static ProviderCatalog> {
    CATALOG.iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_provider_has_a_default_stt_and_tts_model() {
        for provider in CloudProvider::ALL {
            assert!(default_model(provider, "stt").is_some(), "{provider:?} stt");
            assert!(default_model(provider, "tts").is_some(), "{provider:?} tts");
            assert!(provider_catalog(provider).key_url.starts_with("https://"));
        }
    }
}
