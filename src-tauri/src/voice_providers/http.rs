use std::fmt;
use std::sync::OnceLock;
use std::time::Duration;

use serde::Serialize;

use super::CloudProvider;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CloudErrorKind {
    Network,
    Auth,
    Quota,
    BadAudio,
    Timeout,
    Other,
}

impl CloudErrorKind {
    fn code(self) -> &'static str {
        match self {
            Self::Network => "network",
            Self::Auth => "auth",
            Self::Quota => "quota",
            Self::BadAudio => "badAudio",
            Self::Timeout => "timeout",
            Self::Other => "other",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CloudError {
    pub kind: CloudErrorKind,
    pub status: Option<u16>,
}

impl CloudError {
    pub fn of(kind: CloudErrorKind) -> Self {
        Self { kind, status: None }
    }
}

impl fmt::Display for CloudError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.status {
            Some(status) => write!(f, "voice_cloud_{} (HTTP {status})", self.kind.code()),
            None => write!(f, "voice_cloud_{}", self.kind.code()),
        }
    }
}

pub fn classify_status(status: u16, audio_request: bool) -> CloudErrorKind {
    match status {
        401 | 403 => CloudErrorKind::Auth,
        402 | 429 => CloudErrorKind::Quota,
        408 | 504 => CloudErrorKind::Timeout,
        400 | 413 | 415 | 422 if audio_request => CloudErrorKind::BadAudio,
        _ => CloudErrorKind::Other,
    }
}

pub enum HttpMethod {
    Get,
    Post,
}

pub enum FormPart {
    Text {
        name: &'static str,
        value: String,
    },
    File {
        name: &'static str,
        filename: &'static str,
        mime: &'static str,
        bytes: Vec<u8>,
    },
}

pub enum HttpBody {
    Empty,
    Json(serde_json::Value),
    Multipart(Vec<FormPart>),
}

pub struct HttpRequest {
    pub method: HttpMethod,
    pub url: String,
    pub headers: Vec<(&'static str, String)>,
    pub body: HttpBody,
    /// The body carries audio, so a 4xx on it reads as bad audio rather than "other".
    pub audio: bool,
}

pub fn auth_headers(provider: CloudProvider, key: &str) -> Vec<(&'static str, String)> {
    match provider {
        CloudProvider::Openai => vec![("Authorization", format!("Bearer {key}"))],
        CloudProvider::Elevenlabs => vec![("xi-api-key", key.to_string())],
        CloudProvider::Gemini => vec![("x-goog-api-key", key.to_string())],
        CloudProvider::Openrouter => vec![
            ("Authorization", format!("Bearer {key}")),
            ("X-Title", "Alethe".to_string()),
        ],
    }
}

pub fn test_request(provider: CloudProvider, key: &str) -> HttpRequest {
    let url = match provider {
        CloudProvider::Openai => "https://api.openai.com/v1/models",
        CloudProvider::Elevenlabs => "https://api.elevenlabs.io/v1/models",
        CloudProvider::Gemini => "https://generativelanguage.googleapis.com/v1beta/models",
        CloudProvider::Openrouter => "https://openrouter.ai/api/v1/key",
    };
    HttpRequest {
        method: HttpMethod::Get,
        url: url.to_string(),
        headers: auth_headers(provider, key),
        body: HttpBody::Empty,
        audio: false,
    }
}

/// Provider keys travel in custom headers (`xi-api-key`, `x-goog-api-key`) that reqwest would
/// forward on a cross-host redirect, so redirects are never followed and plain HTTP is refused.
fn build_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .https_only(true)
        .build()
        .expect("reqwest client")
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(build_client)
}

/// An id interpolated into a URL path: letters, digits and `._:-` only, never a dot segment.
pub fn safe_path_id(id: &str) -> Result<&str, CloudError> {
    let valid = !id.is_empty()
        && !id.contains("..")
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'));
    if valid {
        Ok(id)
    } else {
        Err(CloudError::of(CloudErrorKind::Other))
    }
}

/// A 2xx reply: its body and its `Content-Type`, when the provider sent one.
pub struct Reply {
    pub body: Vec<u8>,
    pub content_type: Option<String>,
}

/// Sends the request and returns the body of a 2xx reply. Errors carry no body text: provider
/// error bodies can echo request content.
pub async fn send(request: HttpRequest, timeout: Duration) -> Result<Vec<u8>, CloudError> {
    send_reply(request, timeout).await.map(|reply| reply.body)
}

/// [`send`], keeping the reply's `Content-Type` (an audio format can be told only from it).
pub async fn send_reply(request: HttpRequest, timeout: Duration) -> Result<Reply, CloudError> {
    let mut builder = match request.method {
        HttpMethod::Get => client().get(&request.url),
        HttpMethod::Post => client().post(&request.url),
    }
    .timeout(timeout);
    for (name, value) in request.headers {
        builder = builder.header(name, value);
    }
    builder = match request.body {
        HttpBody::Empty => builder,
        HttpBody::Json(value) => builder.json(&value),
        HttpBody::Multipart(parts) => {
            let mut form = reqwest::multipart::Form::new();
            for part in parts {
                form = match part {
                    FormPart::Text { name, value } => form.text(name, value),
                    FormPart::File {
                        name,
                        filename,
                        mime,
                        bytes,
                    } => form.part(
                        name,
                        reqwest::multipart::Part::bytes(bytes)
                            .file_name(filename)
                            .mime_str(mime)
                            .map_err(|_| CloudError::of(CloudErrorKind::Other))?,
                    ),
                };
            }
            builder.multipart(form)
        }
    };
    let response = builder.send().await.map_err(|error| {
        CloudError::of(if error.is_timeout() {
            CloudErrorKind::Timeout
        } else {
            CloudErrorKind::Network
        })
    })?;
    let status = response.status().as_u16();
    if !response.status().is_success() {
        return Err(CloudError {
            kind: classify_status(status, request.audio),
            status: Some(status),
        });
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let body = response
        .bytes()
        .await
        .map(|bytes| bytes.to_vec())
        .map_err(|_| CloudError::of(CloudErrorKind::Network))?;
    Ok(Reply { body, content_type })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statuses_map_to_error_classes() {
        assert_eq!(classify_status(401, false), CloudErrorKind::Auth);
        assert_eq!(classify_status(403, true), CloudErrorKind::Auth);
        assert_eq!(classify_status(429, false), CloudErrorKind::Quota);
        assert_eq!(classify_status(402, false), CloudErrorKind::Quota);
        assert_eq!(classify_status(400, true), CloudErrorKind::BadAudio);
        assert_eq!(classify_status(400, false), CloudErrorKind::Other);
        assert_eq!(classify_status(504, false), CloudErrorKind::Timeout);
        assert_eq!(classify_status(500, true), CloudErrorKind::Other);
    }

    #[test]
    fn error_text_carries_class_and_status_only() {
        let error = CloudError {
            kind: CloudErrorKind::Auth,
            status: Some(401),
        };
        assert_eq!(error.to_string(), "voice_cloud_auth (HTTP 401)");
        let network = CloudError {
            kind: CloudErrorKind::Network,
            status: None,
        };
        assert_eq!(network.to_string(), "voice_cloud_network");
    }

    #[test]
    fn each_provider_authenticates_its_own_way() {
        assert_eq!(
            auth_headers(CloudProvider::Openai, "k")[0],
            ("Authorization", "Bearer k".into())
        );
        assert_eq!(
            auth_headers(CloudProvider::Elevenlabs, "k")[0],
            ("xi-api-key", "k".into())
        );
        assert_eq!(
            auth_headers(CloudProvider::Gemini, "k")[0],
            ("x-goog-api-key", "k".into())
        );
        assert_eq!(
            auth_headers(CloudProvider::Openrouter, "k")[0],
            ("Authorization", "Bearer k".into())
        );
    }

    #[tokio::test]
    async fn plain_http_is_refused_before_any_connection() {
        let error = build_client()
            .get("http://127.0.0.1:9/")
            .send()
            .await
            .unwrap_err();
        assert!(error.is_builder(), "{error:?}");
    }

    #[test]
    fn path_ids_reject_separators_and_dot_segments() {
        for bad in ["a/b", "../x", "..", "v 1", "v?x=1", "v#x", "", "ü"] {
            assert!(safe_path_id(bad).is_err(), "{bad:?}");
        }
        assert_eq!(
            safe_path_id("gemini-2.5-flash").unwrap(),
            "gemini-2.5-flash"
        );
    }

    #[test]
    fn test_requests_hit_a_cheap_authenticated_endpoint() {
        let urls: Vec<String> = CloudProvider::ALL
            .iter()
            .map(|p| test_request(*p, "k").url)
            .collect();
        assert_eq!(
            urls,
            vec![
                "https://api.openai.com/v1/models",
                "https://api.elevenlabs.io/v1/models",
                "https://generativelanguage.googleapis.com/v1beta/models",
                "https://openrouter.ai/api/v1/key",
            ]
        );
        assert!(CloudProvider::ALL
            .iter()
            .all(|p| matches!(test_request(*p, "k").method, HttpMethod::Get)));
    }
}
