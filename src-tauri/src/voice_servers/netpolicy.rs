//! Which addresses a local voice server may have: loopback and private ranges only. Checked when a
//! server is saved and again before every request, and the request is pinned to the checked
//! addresses so DNS cannot change between check and connect.

use std::net::{IpAddr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use reqwest::Url;

use super::error::ServerErrorKind;

/// IPv4-mapped IPv6 (`::ffff:a.b.c.d`) is judged as the IPv4 address it carries.
fn canonical(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(ip, IpAddr::V4),
        IpAddr::V4(_) => ip,
    }
}

pub fn allowed_ip(ip: IpAddr) -> bool {
    match canonical(ip) {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            a == 127 || a == 10 || (a == 172 && (16..=31).contains(&b)) || (a == 192 && b == 168)
        }
        IpAddr::V6(v6) => {
            let head = v6.segments()[0];
            v6 == Ipv6Addr::LOCALHOST || head & 0xffc0 == 0xfe80 || head & 0xfe00 == 0xfc00
        }
    }
}

/// A server base URL: `http`/`https`, a host, no credentials, query or fragment. A path prefix is
/// kept for servers behind a reverse proxy.
pub fn parse_base(raw: &str) -> Result<Url, ServerErrorKind> {
    let url = Url::parse(raw.trim()).map_err(|_| ServerErrorKind::Policy)?;
    let valid = matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some_and(|host| !host.is_empty())
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none();
    if valid {
        Ok(url)
    } else {
        Err(ServerErrorKind::Policy)
    }
}

/// The base URL as stored: no trailing slash.
pub fn base_string(url: &Url) -> String {
    url.as_str().trim_end_matches('/').to_string()
}

/// `path` (starting with `/`) under the base URL.
pub fn endpoint(base: &Url, path: &str) -> String {
    format!("{}{path}", base_string(base))
}

/// Ok(true) when every address is loopback, Ok(false) when some are on the local network.
pub fn check_addrs(addrs: &[SocketAddr]) -> Result<bool, ServerErrorKind> {
    if addrs.is_empty() || !addrs.iter().all(|addr| allowed_ip(addr.ip())) {
        return Err(ServerErrorKind::Policy);
    }
    Ok(addrs.iter().all(|addr| canonical(addr.ip()).is_loopback()))
}

/// A checked base URL and the addresses requests must connect to.
#[derive(Clone, Debug)]
pub struct Target {
    pub url: Url,
    /// Host without IPv6 brackets.
    pub host: String,
    pub addrs: Vec<SocketAddr>,
    pub loopback: bool,
}

pub async fn resolve(url: &Url) -> Result<Target, ServerErrorKind> {
    let host = url
        .host_str()
        .ok_or(ServerErrorKind::Policy)?
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_string();
    let port = url.port_or_known_default().ok_or(ServerErrorKind::Policy)?;
    // A hung resolver must not stall a save or narration.
    let addrs: Vec<SocketAddr> = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::net::lookup_host((host.as_str(), port)),
    )
    .await
    .map_err(|_| ServerErrorKind::Timeout)?
    .map_err(|_| ServerErrorKind::Network)?
    .collect();
    let loopback = check_addrs(&addrs)?;
    Ok(Target {
        url: url.clone(),
        host,
        addrs,
        loopback,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(raw: &str) -> IpAddr {
        raw.parse().unwrap()
    }

    #[test]
    fn private_and_loopback_ranges_are_allowed() {
        for raw in [
            "127.0.0.1",
            "127.8.9.10",
            "10.0.0.1",
            "172.16.0.1",
            "172.31.255.254",
            "192.168.1.20",
            "::1",
            "fe80::1",
            "fd12:3456::1",
            "fc00::1",
            "::ffff:192.168.0.2",
        ] {
            assert!(allowed_ip(ip(raw)), "{raw}");
        }
    }

    #[test]
    fn everything_else_is_refused() {
        for raw in [
            "8.8.8.8",
            "172.15.0.1",
            "172.32.0.1",
            "169.254.169.254",
            "0.0.0.0",
            "::",
            "224.0.0.1",
            "2001:4860:4860::8888",
            "::ffff:8.8.8.8",
            "100.64.0.1",
        ] {
            assert!(!allowed_ip(ip(raw)), "{raw}");
        }
    }

    #[test]
    fn base_urls_are_plain_http_or_https_hosts() {
        assert!(parse_base("http://localhost:4123").is_ok());
        assert!(parse_base(" https://192.168.0.5:8080/api/ ").is_ok());
        for bad in [
            "ftp://localhost",
            "file:///etc/passwd",
            "http://user:pw@localhost",
            "http://localhost/?x=1",
            "http://localhost/#frag",
            "localhost:4123",
            "",
        ] {
            assert_eq!(parse_base(bad), Err(ServerErrorKind::Policy), "{bad}");
        }
    }

    #[test]
    fn base_string_and_endpoint_drop_the_trailing_slash() {
        let url = parse_base("http://localhost:4123/").unwrap();
        assert_eq!(base_string(&url), "http://localhost:4123");
        assert_eq!(endpoint(&url, "/v1/tts"), "http://localhost:4123/v1/tts");
        let prefixed = parse_base("http://10.0.0.2/tts/").unwrap();
        assert_eq!(
            endpoint(&prefixed, "/v1/audio/speech"),
            "http://10.0.0.2/tts/v1/audio/speech"
        );
    }

    #[test]
    fn mixed_resolution_is_refused() {
        let local: SocketAddr = "127.0.0.1:80".parse().unwrap();
        let public: SocketAddr = "93.184.216.34:80".parse().unwrap();
        assert_eq!(check_addrs(&[local, public]), Err(ServerErrorKind::Policy));
        assert_eq!(check_addrs(&[]), Err(ServerErrorKind::Policy));
        assert_eq!(check_addrs(&[local]), Ok(true));
        let lan: SocketAddr = "192.168.0.9:80".parse().unwrap();
        assert_eq!(check_addrs(&[local, lan]), Ok(false));
    }

    #[tokio::test]
    async fn ip_literals_resolve_without_dns() {
        let target = resolve(&parse_base("http://[::1]:4123").unwrap())
            .await
            .unwrap();
        assert_eq!(target.host, "::1");
        assert!(target.loopback);
        assert_eq!(
            resolve(&parse_base("http://8.8.8.8").unwrap()).await.err(),
            Some(ServerErrorKind::Policy)
        );
    }
}
