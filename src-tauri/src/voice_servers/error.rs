use std::fmt;

use serde::Serialize;

/// Why a local voice server could not be used. Codes only: no URL, body or text.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ServerErrorKind {
    Policy,
    Network,
    Timeout,
    Auth,
    BadRequest,
    BadAudio,
    Missing,
    Other,
}

impl ServerErrorKind {
    pub fn code(self) -> &'static str {
        match self {
            Self::Policy => "policy",
            Self::Network => "network",
            Self::Timeout => "timeout",
            Self::Auth => "auth",
            Self::BadRequest => "badRequest",
            Self::BadAudio => "badAudio",
            Self::Missing => "missing",
            Self::Other => "other",
        }
    }
}

impl fmt::Display for ServerErrorKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "voice_server_{}", self.code())
    }
}

pub fn classify_status(status: u16) -> ServerErrorKind {
    match status {
        401 | 403 => ServerErrorKind::Auth,
        400 | 404 | 422 => ServerErrorKind::BadRequest,
        408 | 504 => ServerErrorKind::Timeout,
        _ => ServerErrorKind::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statuses_map_to_kinds() {
        assert_eq!(classify_status(401), ServerErrorKind::Auth);
        assert_eq!(classify_status(403), ServerErrorKind::Auth);
        assert_eq!(classify_status(404), ServerErrorKind::BadRequest);
        assert_eq!(classify_status(422), ServerErrorKind::BadRequest);
        assert_eq!(classify_status(504), ServerErrorKind::Timeout);
        assert_eq!(classify_status(500), ServerErrorKind::Other);
        assert_eq!(classify_status(302), ServerErrorKind::Other);
    }

    #[test]
    fn display_is_a_code() {
        assert_eq!(
            ServerErrorKind::BadRequest.to_string(),
            "voice_server_badRequest"
        );
    }
}
