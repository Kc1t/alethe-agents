//! Pairing, session, and rate-limit state for LAN remote control.

use qrcode::{render::svg, QrCode};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use super::util::{local_ip, peer_ip, tailscale_ip, tokens_equal};
use super::{
    AUTH_FAILURE_LIMIT, AUTH_FAILURE_WINDOW, AUTH_LOCKOUT, DEFAULT_SESSION_EXPIRY_SECS,
    MESSAGE_RATE_LIMIT, MESSAGE_RATE_WINDOW, PAIRING_WINDOW_SECS,
};

#[derive(Clone, Serialize)]
pub struct RemoteDeviceInfo {
    pub id: usize,
    pub name: String,
    pub address: String,
    pub connected_at: u64,
    pub expires_at: u64,
    pub online: bool,
}

#[derive(Clone, Serialize)]
pub struct RemoteInfo {
    pub enabled: bool,
    pub connected_devices: usize,
    pub online_devices: usize,
    pub max_devices: usize,
    pub session_expiry_secs: u64,
    pub read_only: bool,
    pub allow_shell_input: bool,
    pub reach_mode: String,
    pub pairing_open: bool,
    pub pairing_expires_in: u64,
    pub devices: Vec<RemoteDeviceInfo>,
    pub pairing_url: Option<String>,
    pub qr_svg: Option<String>,
    pub http_url: Option<String>,
    pub ws_url: Option<String>,
}

/// Whether this machine has a usable Tailscale address right now, so the
/// frontend can grey out the "Tailscale" reach mode instead of letting the
/// user pick something that will fail closed.
#[derive(Clone, Serialize)]
pub struct TailscaleStatus {
    pub available: bool,
    pub ip: Option<String>,
}

struct RemoteSession {
    id: usize,
    token: String,
    name: String,
    address: String,
    connected_at: SystemTime,
    expires_at: Instant,
    expires_at_unix: u64,
    subscription: Option<String>,
    sender: Option<mpsc::Sender<String>>,
}

struct AuthFailures {
    count: u32,
    window_start: Instant,
    locked_until: Option<Instant>,
}

struct MessageRate {
    count: u32,
    window_start: Instant,
}

pub struct RemoteHub {
    pairing_token: Mutex<String>,
    pairing_until: Mutex<Option<Instant>>,
    host: Mutex<String>,
    running: AtomicBool,
    generation: AtomicU64,
    http_port: AtomicU16,
    ws_port: AtomicU16,
    next_session_id: AtomicUsize,
    max_devices: AtomicUsize,
    session_expiry_secs: AtomicU64,
    read_only: AtomicBool,
    allow_shell_input: AtomicBool,
    use_tailscale: AtomicBool,
    connections: AtomicUsize,
    sessions: Mutex<Vec<RemoteSession>>,
    failures: Mutex<HashMap<IpAddr, AuthFailures>>,
    message_rate: Mutex<HashMap<usize, MessageRate>>,
    qr_cache: Mutex<Option<(String, String)>>,
    last_active_unix: AtomicU64,
}

impl RemoteHub {
    pub(crate) fn new() -> Self {
        Self {
            pairing_token: Mutex::new(nanoid::nanoid!(32)),
            pairing_until: Mutex::new(None),
            host: Mutex::new(local_ip()),
            running: AtomicBool::new(false),
            generation: AtomicU64::new(0),
            http_port: AtomicU16::new(0),
            ws_port: AtomicU16::new(0),
            next_session_id: AtomicUsize::new(1),
            max_devices: AtomicUsize::new(1),
            session_expiry_secs: AtomicU64::new(DEFAULT_SESSION_EXPIRY_SECS),
            read_only: AtomicBool::new(false),
            allow_shell_input: AtomicBool::new(false),
            use_tailscale: AtomicBool::new(false),
            connections: AtomicUsize::new(0),
            sessions: Mutex::new(Vec::new()),
            failures: Mutex::new(HashMap::new()),
            message_rate: Mutex::new(HashMap::new()),
            qr_cache: Mutex::new(None),
            last_active_unix: AtomicU64::new(unix_now()),
        }
    }

    pub(crate) fn enabled(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    pub(crate) fn is_active(&self, generation: u64) -> bool {
        self.running.load(Ordering::SeqCst) && self.generation.load(Ordering::SeqCst) == generation
    }

    pub(crate) fn begin_run(&self) -> bool {
        self.running.swap(true, Ordering::SeqCst)
    }

    pub(crate) fn end_run(&self) {
        self.running.store(false, Ordering::SeqCst);
    }

    pub(crate) fn next_generation(&self) -> u64 {
        self.generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub(crate) fn set_http_port(&self, port: u16) {
        self.http_port.store(port, Ordering::SeqCst);
    }

    pub(crate) fn set_ws_port(&self, port: u16) {
        self.ws_port.store(port, Ordering::SeqCst);
    }

    pub(crate) fn clear_http_port_if_current(&self, generation: u64) {
        if self.generation.load(Ordering::SeqCst) == generation {
            self.http_port.store(0, Ordering::SeqCst);
        }
    }

    pub(crate) fn clear_ws_port_if_current(&self, generation: u64) {
        if self.generation.load(Ordering::SeqCst) == generation {
            self.ws_port.store(0, Ordering::SeqCst);
        }
    }

    pub(crate) fn reset_ports(&self) {
        self.http_port.store(0, Ordering::SeqCst);
        self.ws_port.store(0, Ordering::SeqCst);
    }

    pub(crate) fn http_port(&self) -> u16 {
        self.http_port.load(Ordering::SeqCst)
    }

    pub(crate) fn is_read_only(&self) -> bool {
        self.read_only.load(Ordering::Relaxed)
    }

    pub(crate) fn shell_input_allowed(&self) -> bool {
        self.allow_shell_input.load(Ordering::Relaxed)
    }

    pub(crate) fn set_max_devices(&self, value: usize) {
        self.max_devices.store(value, Ordering::Relaxed);
    }

    pub(crate) fn set_session_expiry(&self, secs: u64) {
        self.session_expiry_secs.store(secs, Ordering::Relaxed);
    }

    pub(crate) fn set_read_only(&self, value: bool) {
        self.read_only.store(value, Ordering::Relaxed);
    }

    pub(crate) fn set_allow_shell_input(&self, value: bool) {
        self.allow_shell_input.store(value, Ordering::Relaxed);
    }

    pub(crate) fn use_tailscale(&self) -> bool {
        self.use_tailscale.load(Ordering::Relaxed)
    }

    pub(crate) fn set_use_tailscale(&self, value: bool) {
        self.use_tailscale.store(value, Ordering::Relaxed);
    }

    pub(crate) fn try_acquire_connection(&self, max: usize) -> bool {
        let previous = self.connections.fetch_add(1, Ordering::SeqCst);
        if previous >= max {
            self.connections.fetch_sub(1, Ordering::SeqCst);
            return false;
        }
        true
    }

    pub(crate) fn release_connection(&self) {
        self.connections.fetch_sub(1, Ordering::SeqCst);
    }

    pub(crate) fn host(&self) -> String {
        self.host
            .lock()
            .map(|host| host.clone())
            .unwrap_or_else(|_| "127.0.0.1".into())
    }

    pub(crate) fn refresh_host(&self) {
        // Fail closed: when Tailscale is requested but not detected,
        // `tailscale_ip()` returns `None` and this resolves to an empty
        // string, which fails `IpAddr` parsing in `bind_listener` — the
        // listener then refuses to bind at all instead of silently falling
        // back to the LAN (or any wider) address.
        let ip = if self.use_tailscale.load(Ordering::Relaxed) {
            tailscale_ip().unwrap_or_default()
        } else {
            local_ip()
        };
        if let Ok(mut host) = self.host.lock() {
            *host = ip;
        }
        if let Ok(mut cache) = self.qr_cache.lock() {
            *cache = None;
        }
    }

    pub(crate) fn open_pairing_window(&self) {
        if let Ok(mut token) = self.pairing_token.lock() {
            *token = nanoid::nanoid!(32);
        }
        if let Ok(mut until) = self.pairing_until.lock() {
            *until = Some(Instant::now() + Duration::from_secs(PAIRING_WINDOW_SECS));
        }
        if let Ok(mut cache) = self.qr_cache.lock() {
            *cache = None;
        }
    }

    pub(crate) fn close_pairing_window(&self) {
        if let Ok(mut token) = self.pairing_token.lock() {
            *token = nanoid::nanoid!(32);
        }
        if let Ok(mut until) = self.pairing_until.lock() {
            *until = None;
        }
        if let Ok(mut cache) = self.qr_cache.lock() {
            *cache = None;
        }
    }

    pub(crate) fn pairing_remaining(&self) -> u64 {
        if !self.enabled() {
            return 0;
        }
        self.pairing_until
            .lock()
            .ok()
            .and_then(|until| *until)
            .map(|until| until.saturating_duration_since(Instant::now()).as_secs())
            .unwrap_or(0)
    }

    pub(crate) fn pairing_url(&self) -> Option<String> {
        if self.pairing_remaining() == 0 {
            return None;
        }
        let port = self.http_port.load(Ordering::SeqCst);
        let token = self.pairing_token.lock().ok()?.clone();
        (port != 0).then(|| format!("http://{}:{}/?pair={}", self.host(), port, token))
    }

    pub(crate) fn info(&self) -> RemoteInfo {
        self.prune_expired();
        let http_port = self.http_port.load(Ordering::SeqCst);
        let ws_port = self.ws_port.load(Ordering::SeqCst);
        let host = self.host();
        let pairing_url = self.pairing_url();
        let qr_svg = pairing_url.as_ref().and_then(|url| self.qr_svg(url));
        let devices: Vec<RemoteDeviceInfo> = self
            .sessions
            .lock()
            .map(|sessions| {
                sessions
                    .iter()
                    .map(|session| RemoteDeviceInfo {
                        id: session.id,
                        name: session.name.clone(),
                        address: session.address.clone(),
                        connected_at: session
                            .connected_at
                            .duration_since(UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_secs(),
                        expires_at: session.expires_at_unix,
                        online: session.sender.is_some(),
                    })
                    .collect()
            })
            .unwrap_or_default();
        RemoteInfo {
            enabled: self.enabled(),
            connected_devices: devices.len(),
            online_devices: devices.iter().filter(|device| device.online).count(),
            max_devices: self.max_devices.load(Ordering::Relaxed),
            session_expiry_secs: self.session_expiry_secs.load(Ordering::Relaxed),
            read_only: self.read_only.load(Ordering::Relaxed),
            allow_shell_input: self.allow_shell_input.load(Ordering::Relaxed),
            reach_mode: if self.use_tailscale() {
                "tailscale".into()
            } else {
                "lan".into()
            },
            pairing_open: pairing_url.is_some(),
            pairing_expires_in: self.pairing_remaining(),
            devices,
            pairing_url,
            qr_svg,
            http_url: (http_port != 0).then(|| format!("http://{host}:{http_port}")),
            ws_url: (ws_port != 0).then(|| format!("ws://{host}:{ws_port}")),
        }
    }

    fn qr_svg(&self, url: &str) -> Option<String> {
        let mut cache = self.qr_cache.lock().ok()?;
        if let Some((cached_url, svg)) = cache.as_ref() {
            if cached_url == url {
                return Some(svg.clone());
            }
        }
        let svg = QrCode::new(url.as_bytes())
            .ok()?
            .render::<svg::Color>()
            .min_dimensions(220, 220)
            .build();
        *cache = Some((url.to_string(), svg.clone()));
        Some(svg)
    }

    pub(crate) fn connected_device_count(&self) -> usize {
        if !self.enabled() {
            return 0;
        }
        self.prune_expired();
        self.sessions
            .lock()
            .map(|sessions| sessions.len())
            .unwrap_or(0)
    }

    fn prune_expired(&self) {
        let now = Instant::now();
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.retain(|session| session.expires_at > now);
        }
    }

    pub(crate) fn pair(
        &self,
        provided: &str,
        name: String,
        address: String,
    ) -> Result<(usize, String), &'static str> {
        if self.pairing_remaining() == 0 {
            return Err("Pairing window is closed");
        }
        let expected = self
            .pairing_token
            .lock()
            .map_err(|_| "Pairing unavailable")?
            .clone();
        if !tokens_equal(provided, &expected) {
            return Err("Invalid pairing token");
        }
        self.prune_expired();
        let mut sessions = self.sessions.lock().map_err(|_| "Pairing unavailable")?;
        if sessions.len() >= self.max_devices.load(Ordering::Relaxed) {
            return Err("Maximum remote devices reached");
        }
        let lifetime = self.session_expiry_secs.load(Ordering::Relaxed);
        let id = self.next_session_id.fetch_add(1, Ordering::Relaxed);
        let token = nanoid::nanoid!(40);
        let now = SystemTime::now();
        sessions.push(RemoteSession {
            id,
            token: token.clone(),
            name,
            address,
            connected_at: now,
            expires_at: Instant::now() + Duration::from_secs(lifetime),
            expires_at_unix: now.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
                + lifetime,
            subscription: None,
            sender: None,
        });
        drop(sessions);
        self.close_pairing_window();
        self.touch_activity();
        Ok((id, token))
    }

    /// Marks "a device is actually using this" — the idle auto-disable
    /// timer only starts counting once this stops being refreshed.
    pub(crate) fn touch_activity(&self) {
        self.last_active_unix.store(unix_now(), Ordering::Relaxed);
    }

    /// True once no device has been connected for `threshold_secs` straight
    /// (0 disables the check). Pure logic lives in `idle_expired` below so
    /// it's testable without spinning up real atomics/threads.
    pub(crate) fn is_idle(&self, threshold_secs: u64) -> bool {
        self.connected_device_count() == 0
            && idle_expired(
                unix_now(),
                self.last_active_unix.load(Ordering::Relaxed),
                threshold_secs,
            )
    }

    /// Per-session send throttle for `/api/message`, independent of the
    /// auth-failure rate limiter above: bounds how fast a *successfully*
    /// paired device can fire prompts, so a stolen/leaked session token
    /// can't hammer an agent or shell at machine speed.
    pub(crate) fn allow_message(&self, session_id: usize) -> bool {
        let Ok(mut rates) = self.message_rate.lock() else {
            return true;
        };
        let now = Instant::now();
        let entry = rates.entry(session_id).or_insert(MessageRate {
            count: 0,
            window_start: now,
        });
        if now.duration_since(entry.window_start) > MESSAGE_RATE_WINDOW {
            entry.count = 0;
            entry.window_start = now;
        }
        entry.count += 1;
        entry.count <= MESSAGE_RATE_LIMIT
    }

    pub(crate) fn session_id_for(&self, token: &str) -> Option<usize> {
        if token.is_empty() {
            return None;
        }
        self.prune_expired();
        let sessions = self.sessions.lock().ok()?;
        sessions
            .iter()
            .find(|session| tokens_equal(token, &session.token))
            .map(|session| session.id)
    }

    pub(crate) fn attach_sender(&self, id: usize, sender: mpsc::Sender<String>) {
        if let Ok(mut sessions) = self.sessions.lock() {
            if let Some(session) = sessions.iter_mut().find(|session| session.id == id) {
                session.sender = Some(sender);
            }
        }
    }

    pub(crate) fn detach_sender(&self, id: usize) {
        if let Ok(mut sessions) = self.sessions.lock() {
            if let Some(session) = sessions.iter_mut().find(|session| session.id == id) {
                session.sender = None;
                session.subscription = None;
            }
        }
    }

    pub(crate) fn set_subscription(&self, id: usize, pty_id: Option<String>) {
        if let Ok(mut sessions) = self.sessions.lock() {
            if let Some(session) = sessions.iter_mut().find(|session| session.id == id) {
                session.subscription = pty_id;
            }
        }
    }

    pub(crate) fn session_alive(&self, id: usize) -> bool {
        self.sessions
            .lock()
            .map(|sessions| {
                sessions
                    .iter()
                    .any(|session| session.id == id && session.expires_at > Instant::now())
            })
            .unwrap_or(false)
    }

    pub(crate) fn device_name(&self, id: usize) -> String {
        self.sessions
            .lock()
            .ok()
            .and_then(|sessions| {
                sessions
                    .iter()
                    .find(|session| session.id == id)
                    .map(|session| session.name.clone())
            })
            .unwrap_or_else(|| "Remote device".into())
    }

    pub(crate) fn rename_device(&self, id: usize, name: String) {
        if let Ok(mut sessions) = self.sessions.lock() {
            if let Some(session) = sessions.iter_mut().find(|session| session.id == id) {
                session.name = name;
            }
        }
    }

    pub(crate) fn publish<F>(&self, pty_id: &str, payload: F)
    where
        F: FnOnce() -> Value,
    {
        let mut sessions = match self.sessions.lock() {
            Ok(sessions) => sessions,
            Err(_) => return,
        };
        let now = Instant::now();
        let has_subscriber = sessions.iter().any(|session| {
            session.expires_at > now
                && session.sender.is_some()
                && session.subscription.as_deref() == Some(pty_id)
        });
        if !has_subscriber {
            return;
        }
        let message = payload().to_string();
        for session in sessions.iter_mut() {
            if session.expires_at <= now || session.subscription.as_deref() != Some(pty_id) {
                continue;
            }
            let delivered = session
                .sender
                .as_ref()
                .map(|sender| sender.send(message.clone()).is_ok())
                .unwrap_or(true);
            if !delivered {
                session.sender = None;
            }
        }
    }

    pub(crate) fn revoke_all(&self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.clear();
        }
    }

    pub(crate) fn revoke_device(&self, id: usize) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.retain(|session| session.id != id);
        }
    }

    pub(crate) fn auth_blocked(&self, address: &str) -> bool {
        let Some(ip) = peer_ip(address) else {
            return false;
        };
        self.failures
            .lock()
            .map(|failures| {
                failures
                    .get(&ip)
                    .and_then(|entry| entry.locked_until)
                    .map(|until| until > Instant::now())
                    .unwrap_or(false)
            })
            .unwrap_or(false)
    }

    pub(crate) fn record_auth_failure(&self, address: &str) {
        let Some(ip) = peer_ip(address) else {
            return;
        };
        let Ok(mut failures) = self.failures.lock() else {
            return;
        };
        let now = Instant::now();
        let entry = failures.entry(ip).or_insert(AuthFailures {
            count: 0,
            window_start: now,
            locked_until: None,
        });
        if now.duration_since(entry.window_start) > AUTH_FAILURE_WINDOW {
            entry.count = 0;
            entry.window_start = now;
            entry.locked_until = None;
        }
        entry.count += 1;
        if entry.count >= AUTH_FAILURE_LIMIT {
            entry.locked_until = Some(now + AUTH_LOCKOUT);
            eprintln!("[remote] too many failed pairing attempts from {ip}, blocked for 5 minutes");
        }
    }

    pub(crate) fn clear_auth_failures(&self, address: &str) {
        if let Some(ip) = peer_ip(address) {
            if let Ok(mut failures) = self.failures.lock() {
                failures.remove(&ip);
            }
        }
    }
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn idle_expired(now_secs: u64, last_active_secs: u64, threshold_secs: u64) -> bool {
    threshold_secs > 0 && now_secs.saturating_sub(last_active_secs) >= threshold_secs
}

#[cfg(test)]
mod tests {
    use super::{idle_expired, RemoteHub};
    use std::cell::Cell;

    #[test]
    fn publish_does_not_build_payload_without_subscribers() {
        let hub = RemoteHub::new();
        let payload_built = Cell::new(false);

        hub.publish("pty-1", || {
            payload_built.set(true);
            serde_json::json!({ "type": "test" })
        });

        assert!(!payload_built.get());
    }

    #[test]
    fn inactive_hub_reports_no_connected_devices() {
        let hub = RemoteHub::new();

        assert_eq!(hub.connected_device_count(), 0);
    }

    #[test]
    fn pairing_is_closed_until_a_window_is_opened() {
        let hub = RemoteHub::new();

        assert_eq!(hub.pairing_remaining(), 0);
        assert!(hub.pairing_url().is_none());
        assert!(hub
            .pair("anything", "Phone".into(), "127.0.0.1:1".into())
            .is_err());
    }

    #[test]
    fn pairing_rejects_an_unknown_token_while_open() {
        let hub = RemoteHub::new();
        hub.running.store(true, std::sync::atomic::Ordering::SeqCst);
        hub.open_pairing_window();

        assert!(hub
            .pair("wrong-token", "Phone".into(), "127.0.0.1:1".into())
            .is_err());
    }

    #[test]
    fn pairing_issues_a_session_token_and_closes_the_window() {
        let hub = RemoteHub::new();
        hub.running.store(true, std::sync::atomic::Ordering::SeqCst);
        hub.open_pairing_window();
        let token = hub.pairing_token.lock().expect("pairing token").clone();

        let (id, session_token) = hub
            .pair(&token, "Phone".into(), "127.0.0.1:1".into())
            .expect("pairing should succeed");

        assert_eq!(hub.session_id_for(&session_token), Some(id));
        assert_eq!(hub.pairing_remaining(), 0);
        assert!(hub.session_id_for("not-a-session").is_none());
    }

    #[test]
    fn pairing_honours_the_device_limit() {
        let hub = RemoteHub::new();
        hub.running.store(true, std::sync::atomic::Ordering::SeqCst);
        hub.open_pairing_window();
        let token = hub.pairing_token.lock().expect("pairing token").clone();
        hub.pair(&token, "Phone".into(), "127.0.0.1:1".into())
            .expect("first device pairs");

        hub.open_pairing_window();
        let token = hub.pairing_token.lock().expect("pairing token").clone();

        assert!(hub
            .pair(&token, "Tablet".into(), "127.0.0.1:2".into())
            .is_err());
    }

    #[test]
    fn revoking_a_device_invalidates_its_session_token() {
        let hub = RemoteHub::new();
        hub.running.store(true, std::sync::atomic::Ordering::SeqCst);
        hub.open_pairing_window();
        let token = hub.pairing_token.lock().expect("pairing token").clone();
        let (id, session_token) = hub
            .pair(&token, "Phone".into(), "127.0.0.1:1".into())
            .expect("pairing should succeed");

        hub.revoke_device(id);

        assert!(hub.session_id_for(&session_token).is_none());
    }

    #[test]
    fn repeated_failures_lock_an_address_out() {
        let hub = RemoteHub::new();
        let address = "192.168.0.44:5100";

        for _ in 0..super::AUTH_FAILURE_LIMIT {
            hub.record_auth_failure(address);
        }

        assert!(hub.auth_blocked(address));
        hub.clear_auth_failures(address);
        assert!(!hub.auth_blocked(address));
    }

    #[test]
    fn qr_svg_is_cached_by_pairing_url() {
        let hub = RemoteHub::new();
        let url = "http://127.0.0.1:9340/?pair=test";

        let first = hub.qr_svg(url).expect("QR code should render");
        let second = hub.qr_svg(url).expect("cached QR code should exist");

        assert_eq!(first, second);
        assert_eq!(
            hub.qr_cache.lock().expect("cache lock").as_ref().unwrap().0,
            url
        );
    }

    #[test]
    fn tailscale_mode_without_a_detected_ip_fails_closed_to_an_unbindable_host() {
        let hub = RemoteHub::new();
        hub.set_use_tailscale(true);

        hub.refresh_host();

        // No real Tailscale install in CI, so detection returns `None` and
        // `host()` must resolve to something `bind_listener` cannot parse —
        // never the LAN address or `0.0.0.0`.
        assert!(hub.host().parse::<std::net::IpAddr>().is_err());
    }

    #[test]
    fn lan_mode_still_resolves_a_real_bindable_host() {
        let hub = RemoteHub::new();

        hub.refresh_host();

        assert!(hub.host().parse::<std::net::IpAddr>().is_ok());
    }

    #[test]
    fn message_rate_limit_blocks_a_burst_past_the_cap() {
        let hub = RemoteHub::new();

        let mut allowed = 0;
        for _ in 0..(super::MESSAGE_RATE_LIMIT + 5) {
            if hub.allow_message(1) {
                allowed += 1;
            }
        }

        assert_eq!(allowed, super::MESSAGE_RATE_LIMIT);
    }

    #[test]
    fn message_rate_limit_is_tracked_per_session() {
        let hub = RemoteHub::new();

        for _ in 0..super::MESSAGE_RATE_LIMIT {
            assert!(hub.allow_message(1));
        }
        assert!(!hub.allow_message(1));

        assert!(hub.allow_message(2));
    }

    #[test]
    fn idle_expired_only_trips_past_a_positive_threshold() {
        assert!(!idle_expired(100, 100, 0));
        assert!(!idle_expired(100, 99, 10));
        assert!(idle_expired(110, 100, 10));
        assert!(idle_expired(200, 100, 10));
    }

    #[test]
    fn hub_is_idle_only_once_the_threshold_elapses_with_nobody_connected() {
        let hub = RemoteHub::new();

        assert!(!hub.is_idle(0));
        assert!(!hub.is_idle(3600));
    }
}
