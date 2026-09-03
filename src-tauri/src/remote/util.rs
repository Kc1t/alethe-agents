//! Small, dependency-free helpers shared by the HTTP/WebSocket layers and
//! the session hub: constant-time token comparison, LAN address discovery,
//! and request string parsing.

use std::net::{IpAddr, TcpListener, UdpSocket};

pub(crate) fn bind_listener(host: &str, start: u16, end: u16) -> Option<TcpListener> {
    let ip = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<IpAddr>()
        .ok()?;
    (start..=end).find_map(|port| TcpListener::bind((ip, port)).ok())
}

pub(crate) fn peer_ip(address: &str) -> Option<IpAddr> {
    address
        .parse::<std::net::SocketAddr>()
        .ok()
        .map(|addr| addr.ip())
}

pub(crate) fn tokens_equal(provided: &str, expected: &str) -> bool {
    let mut difference = provided.len() ^ expected.len();
    for index in 0..provided.len().max(expected.len()) {
        difference |= usize::from(
            provided.as_bytes().get(index).copied().unwrap_or_default()
                ^ expected.as_bytes().get(index).copied().unwrap_or_default(),
        );
    }
    difference == 0
}

pub(crate) fn sanitize_remote_message(input: &str) -> String {
    input
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect()
}

pub(crate) fn query_value(target: &str, key: &str) -> Option<String> {
    target.split('?').nth(1)?.split('&').find_map(|part| {
        let (candidate, value) = part.split_once('=')?;
        (candidate == key).then(|| percent_decode(value))
    })
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' if index + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or("");
                match u8::from_str_radix(hex, 16) {
                    Ok(byte) => {
                        decoded.push(byte);
                        index += 3;
                    }
                    Err(_) => {
                        decoded.push(bytes[index]);
                        index += 1;
                    }
                }
            }
            b'+' => {
                decoded.push(b' ');
                index += 1;
            }
            byte => {
                decoded.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

pub(crate) fn local_ip() -> String {
    UdpSocket::bind("0.0.0.0:0")
        .and_then(|socket| {
            socket.connect("8.8.8.8:80")?;
            socket.local_addr()
        })
        .map(|addr| match addr.ip() {
            IpAddr::V4(ip) => ip.to_string(),
            IpAddr::V6(ip) => format!("[{ip}]"),
        })
        .unwrap_or_else(|_| "127.0.0.1".into())
}

/// Tailscale hands out addresses only from the CGNAT range 100.64.0.0/10.
/// Used to reject anything the CLI might print that isn't actually a tailnet
/// address, so a misbehaving `tailscale` binary can never widen the bind.
fn is_tailscale_range(ip: &str) -> bool {
    ip.parse::<std::net::Ipv4Addr>()
        .map(|addr| {
            let octets = addr.octets();
            octets[0] == 100 && (64..=127).contains(&octets[1])
        })
        .unwrap_or(false)
}

/// Resolves this machine's Tailscale address by shelling out to the
/// Tailscale CLI, if it's installed and the daemon is up. Returns `None`
/// (never a guess) when Tailscale isn't available — callers must fail
/// closed rather than fall back to a broader bind.
pub(crate) fn tailscale_ip() -> Option<String> {
    let exe = which::which("tailscale").ok().or_else(|| {
        let default = std::path::PathBuf::from(r"C:\Program Files\Tailscale\tailscale.exe");
        default.exists().then_some(default)
    })?;
    let mut command = std::process::Command::new(exe);
    command.args(["ip", "-4"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let ip = String::from_utf8_lossy(&output.stdout).trim().to_string();
    is_tailscale_range(&ip).then_some(ip)
}

#[cfg(test)]
mod tests {
    use super::{is_tailscale_range, percent_decode};

    #[test]
    fn percent_encoded_query_values_are_decoded() {
        assert_eq!(percent_decode("a%2Fb+c"), "a/b c");
    }

    #[test]
    fn tailscale_range_accepts_only_cgnat_addresses() {
        assert!(is_tailscale_range("100.64.0.1"));
        assert!(is_tailscale_range("100.127.255.255"));
        assert!(!is_tailscale_range("100.63.255.255"));
        assert!(!is_tailscale_range("100.128.0.0"));
        assert!(!is_tailscale_range("192.168.1.1"));
        assert!(!is_tailscale_range("not-an-ip"));
        assert!(!is_tailscale_range(""));
    }
}
