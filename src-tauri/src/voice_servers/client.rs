//! HTTP to a local voice server: its own client per request, pinned to the addresses the policy
//! checked, no proxy, no redirects, capped replies.

use std::net::IpAddr;
use std::time::Duration;

use super::adapter;
use super::error::{classify_status, ServerErrorKind};
use super::netpolicy::{self, Target};
use super::store::VoiceServer;
use crate::voice_providers::tts_cloud::{self, Pcm};

pub const SPEECH_TIMEOUT: Duration = Duration::from_secs(120);
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_SPEECH_BYTES: usize = 50 * 1024 * 1024;
const MAX_PROBE_BYTES: usize = 1024 * 1024;

fn client_for(target: &Target, timeout: Duration) -> Result<reqwest::Client, ServerErrorKind> {
    let mut builder = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy();
    if target.host.parse::<IpAddr>().is_err() {
        // Connect to the addresses the policy checked, not to a second DNS answer.
        builder = builder.resolve_to_addrs(&target.host, &target.addrs);
    }
    builder.build().map_err(|_| ServerErrorKind::Other)
}

fn transport_error(error: reqwest::Error) -> ServerErrorKind {
    if error.is_timeout() {
        ServerErrorKind::Timeout
    } else {
        ServerErrorKind::Network
    }
}

async fn read_capped(
    mut response: reqwest::Response,
    cap: usize,
) -> Result<Vec<u8>, ServerErrorKind> {
    if response
        .content_length()
        .is_some_and(|length| length as usize > cap)
    {
        return Err(ServerErrorKind::BadAudio);
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(transport_error)? {
        if body.len() + chunk.len() > cap {
            return Err(ServerErrorKind::BadAudio);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

async fn send(
    request: reqwest::RequestBuilder,
    key: Option<&str>,
    cap: usize,
) -> Result<Vec<u8>, ServerErrorKind> {
    let request = match key {
        Some(key) => request.bearer_auth(key),
        None => request,
    };
    let response = request.send().await.map_err(transport_error)?;
    let status = response.status();
    if !status.is_success() {
        return Err(classify_status(status.as_u16()));
    }
    read_capped(response, cap).await
}

async fn get(
    target: &Target,
    path: &str,
    key: Option<&str>,
    timeout: Duration,
    cap: usize,
) -> Result<Vec<u8>, ServerErrorKind> {
    let client = client_for(target, timeout)?;
    send(client.get(netpolicy::endpoint(&target.url, path)), key, cap).await
}

async fn target_of(server: &VoiceServer) -> Result<Target, ServerErrorKind> {
    netpolicy::resolve(&netpolicy::parse_base(&server.base_url)?).await
}

/// One chunk of speech, decoded.
pub async fn synthesize(
    server: &VoiceServer,
    key: Option<&str>,
    voice: Option<&str>,
    text: &str,
    rate: f32,
) -> Result<Pcm, ServerErrorKind> {
    let target = target_of(server).await?;
    let request = adapter::speech_request(server.kind, server.model.as_deref(), voice, text, rate);
    let client = client_for(&target, SPEECH_TIMEOUT)?;
    let body = send(
        client
            .post(netpolicy::endpoint(&target.url, request.path))
            .json(&request.body),
        key,
        MAX_SPEECH_BYTES,
    )
    .await?;
    tts_cloud::decode_audio(&body).map_err(|_| ServerErrorKind::BadAudio)
}

/// The voice ids the server lists, from the first known path that answers with any.
pub async fn voices(
    server: &VoiceServer,
    key: Option<&str>,
) -> Result<Vec<String>, ServerErrorKind> {
    let target = target_of(server).await?;
    for path in adapter::voice_paths(server.kind) {
        match get(&target, path, key, PROBE_TIMEOUT, MAX_PROBE_BYTES).await {
            Ok(body) => {
                let found = adapter::parse_voices(&body);
                if !found.is_empty() {
                    return Ok(found);
                }
            }
            Err(
                ServerErrorKind::BadRequest | ServerErrorKind::Other | ServerErrorKind::BadAudio,
            ) => {}
            Err(kind) => return Err(kind),
        }
    }
    Ok(Vec::new())
}

/// Ok when one of the kind's health paths answers 2xx; a server that answers only 404s is of
/// another kind.
pub async fn health(server: &VoiceServer, key: Option<&str>) -> Result<(), ServerErrorKind> {
    let target = target_of(server).await?;
    for path in adapter::health_paths(server.kind) {
        match get(&target, path, key, PROBE_TIMEOUT, MAX_PROBE_BYTES).await {
            Ok(_) => return Ok(()),
            Err(ServerErrorKind::BadRequest) => {}
            Err(kind) => return Err(kind),
        }
    }
    Err(ServerErrorKind::BadRequest)
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;
    use crate::voice_servers::adapter::ServerKind;
    use crate::voice_servers::id::ServerId;

    type Route = (
        &'static str,
        u16,
        Vec<(&'static str, &'static str)>,
        Vec<u8>,
    );
    type Seen = std::sync::mpsc::Receiver<(String, Option<String>, String)>;

    /// Serves `routes` (path -> (status, headers, body)) on 127.0.0.1 for `count` requests, and
    /// returns the base URL and a channel with what each request carried.
    fn fake(routes: Vec<Route>, count: usize) -> (String, Seen) {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            for mut request in server.incoming_requests().take(count) {
                let mut body = String::new();
                let _ = request.as_reader().read_to_string(&mut body);
                let auth = request
                    .headers()
                    .iter()
                    .find(|h| h.field.equiv("Authorization"))
                    .map(|h| h.value.to_string());
                let path = request.url().to_string();
                let _ = tx.send((path.clone(), auth, body));
                let (status, headers, reply) = routes
                    .iter()
                    .find(|(route, ..)| *route == path)
                    .map(|(_, status, headers, body)| (*status, headers.clone(), body.clone()))
                    .unwrap_or((404, Vec::new(), Vec::new()));
                let mut response = tiny_http::Response::from_data(reply).with_status_code(status);
                for (name, value) in headers {
                    response.add_header(tiny_http::Header::from_bytes(name, value).unwrap());
                }
                let _ = request.respond(response);
            }
        });
        (format!("http://127.0.0.1:{port}"), rx)
    }

    fn server(kind: ServerKind, base_url: &str) -> VoiceServer {
        VoiceServer {
            id: ServerId::new(),
            name: "test".into(),
            kind,
            base_url: base_url.into(),
            model: None,
            has_key: false,
        }
    }

    #[tokio::test]
    async fn speech_is_posted_and_wav_is_decoded() {
        let wav = crate::voice_servers::adapter::tests::tiny_wav(22_050, &[0, 1000, -1000, 0]);
        let (base, seen) = fake(
            vec![("/v1/tts", 200, vec![("Content-Type", "audio/wav")], wav)],
            1,
        );
        let pcm = synthesize(
            &server(ServerKind::Fish, &base),
            Some("k"),
            Some("narrador"),
            "Olá",
            1.0,
        )
        .await
        .unwrap();
        assert_eq!(pcm.sample_rate, 22_050);
        let (path, auth, body) = seen.recv().unwrap();
        assert_eq!(path, "/v1/tts");
        assert_eq!(auth.as_deref(), Some("Bearer k"));
        let body: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(body["reference_id"], "narrador");
    }

    #[tokio::test]
    async fn rejected_key_reads_as_auth() {
        let (base, _) = fake(vec![("/v1/audio/speech", 401, vec![], Vec::new())], 1);
        let error = synthesize(&server(ServerKind::Openai, &base), None, None, "x", 1.0)
            .await
            .unwrap_err();
        assert_eq!(error, ServerErrorKind::Auth);
    }

    #[tokio::test]
    async fn redirect_is_not_followed() {
        let (base, seen) = fake(
            vec![(
                "/v1/audio/speech",
                302,
                vec![("Location", "http://127.0.0.1:9/evil")],
                Vec::new(),
            )],
            1,
        );
        let error = synthesize(&server(ServerKind::Openai, &base), None, None, "x", 1.0)
            .await
            .unwrap_err();
        assert_eq!(error, ServerErrorKind::Other);
        assert_eq!(seen.recv().unwrap().0, "/v1/audio/speech");
        assert!(seen.try_recv().is_err());
    }

    #[tokio::test]
    async fn hostname_requests_use_the_pinned_addresses() {
        let (base, seen) = fake(
            vec![("/voices", 200, vec![], br#"{"voices":["a"]}"#.to_vec())],
            1,
        );
        let port: u16 = base.rsplit(':').next().unwrap().parse().unwrap();
        // `.invalid` never resolves, so a reply proves the pinned address was used.
        let target = Target {
            url: reqwest::Url::parse(&format!("http://voice.invalid:{port}")).unwrap(),
            host: "voice.invalid".into(),
            addrs: vec![std::net::SocketAddr::from(([127, 0, 0, 1], port))],
            loopback: true,
        };
        get(&target, "/voices", None, PROBE_TIMEOUT, 1024)
            .await
            .unwrap();
        assert_eq!(seen.recv().unwrap().0, "/voices");
    }

    #[tokio::test]
    async fn oversized_reply_is_bad_audio() {
        let (base, _) = fake(vec![("/voices", 200, vec![], vec![b' '; 64])], 1);
        let target = netpolicy::resolve(&netpolicy::parse_base(&base).unwrap())
            .await
            .unwrap();
        let error = get(&target, "/voices", None, PROBE_TIMEOUT, 16)
            .await
            .unwrap_err();
        assert_eq!(error, ServerErrorKind::BadAudio);
    }

    #[tokio::test]
    async fn voices_fall_through_to_the_next_known_path() {
        let (base, _) = fake(
            vec![(
                "/voices",
                200,
                vec![],
                br#"{"voices":[{"name":"pt-ref"}]}"#.to_vec(),
            )],
            2,
        );
        let voices = voices(&server(ServerKind::Openai, &base), None)
            .await
            .unwrap();
        assert_eq!(voices, ["pt-ref"]);
    }

    #[tokio::test]
    async fn health_of_the_wrong_kind_is_bad_request() {
        let (base, _) = fake(Vec::new(), 1);
        assert_eq!(
            health(&server(ServerKind::Fish, &base), None).await,
            Err(ServerErrorKind::BadRequest)
        );
    }

    #[tokio::test]
    async fn public_ip_literal_is_refused_without_connecting() {
        let error = synthesize(
            &server(ServerKind::Openai, "http://8.8.8.8"),
            None,
            None,
            "x",
            1.0,
        )
        .await
        .unwrap_err();
        assert_eq!(error, ServerErrorKind::Policy);
    }

    #[tokio::test]
    async fn closed_port_is_network() {
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let error = synthesize(
            &server(ServerKind::Openai, &format!("http://127.0.0.1:{port}")),
            None,
            None,
            "x",
            1.0,
        )
        .await
        .unwrap_err();
        assert_eq!(error, ServerErrorKind::Network);
    }

    #[test]
    fn client_ignores_proxy_env() {
        // `no_proxy()` is what keeps a system proxy from carrying narration out; this guards the
        // builder against a refactor that drops it.
        assert!(include_str!("client.rs").contains(".no_proxy()"));
    }
}
