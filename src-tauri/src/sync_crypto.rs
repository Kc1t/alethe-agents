//! Device key-agreement material (ADR-0003). Ed25519 (`sync_security.rs`) remains the device
//! *identity* and signature key; this module owns the separate X25519 key used only for
//! Diffie-Hellman agreement, the signed binding between the two keys, and session-key
//! derivation. Nothing here contacts a network service.

use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use hkdf::Hkdf;
use sha2::Sha256;
use x25519_dalek::{PublicKey as X25519PublicKey, StaticSecret as X25519StaticSecret};

pub const SESSION_KEY_LEN: usize = 32;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeviceKeyBinding {
    pub device_id: String,
    pub ed25519_public_key: Vec<u8>,
    pub x25519_public_key: Vec<u8>,
    pub bound_at_ms: u64,
    pub signature: Vec<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyBindingError {
    InvalidKeyLength,
    InvalidSignature,
}

impl std::fmt::Display for KeyBindingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let code = match self {
            KeyBindingError::InvalidKeyLength => "device_key_binding_invalid_length",
            KeyBindingError::InvalidSignature => "device_key_binding_invalid_signature",
        };
        write!(f, "{code}")
    }
}

fn binding_signable_bytes(
    device_id: &str,
    ed25519_public_key: &[u8],
    x25519_public_key: &[u8],
    bound_at_ms: u64,
) -> Vec<u8> {
    let mut buffer = Vec::with_capacity(device_id.len() + 64 + 8 + 8);
    buffer.extend_from_slice(&(device_id.len() as u32).to_le_bytes());
    buffer.extend_from_slice(device_id.as_bytes());
    buffer.extend_from_slice(ed25519_public_key);
    buffer.extend_from_slice(x25519_public_key);
    buffer.extend_from_slice(&bound_at_ms.to_le_bytes());
    buffer
}

/// Generates a new X25519 agreement keypair and signs the binding to the device's existing
/// Ed25519 identity. The returned `StaticSecret` bytes are the only new private material the
/// caller must persist (in the same credential-store entry as the Ed25519 private key, per
/// ADR-0003) — everything else is safe to store in the security document.
pub fn generate_bound_key_agreement(
    device_id: &str,
    identity_signing_key: &SigningKey,
    bound_at_ms: u64,
) -> (X25519StaticSecret, DeviceKeyBinding) {
    let agreement_secret = X25519StaticSecret::random_from_rng(rand_core::OsRng);
    let agreement_public = X25519PublicKey::from(&agreement_secret);
    let ed25519_public = identity_signing_key.verifying_key();
    let signable = binding_signable_bytes(
        device_id,
        ed25519_public.as_bytes(),
        agreement_public.as_bytes(),
        bound_at_ms,
    );
    let signature = identity_signing_key.sign(&signable);
    (
        agreement_secret,
        DeviceKeyBinding {
            device_id: device_id.to_string(),
            ed25519_public_key: ed25519_public.as_bytes().to_vec(),
            x25519_public_key: agreement_public.as_bytes().to_vec(),
            bound_at_ms,
            signature: signature.to_bytes().to_vec(),
        },
    )
}

/// Verifies that `binding` was genuinely signed by the Ed25519 device identity it claims,
/// proving the enclosed X25519 public key belongs to that device.
pub fn verify_key_binding(binding: &DeviceKeyBinding) -> Result<(), KeyBindingError> {
    let ed25519_bytes: [u8; 32] = binding
        .ed25519_public_key
        .as_slice()
        .try_into()
        .map_err(|_| KeyBindingError::InvalidKeyLength)?;
    let verifying_key =
        VerifyingKey::from_bytes(&ed25519_bytes).map_err(|_| KeyBindingError::InvalidKeyLength)?;
    let signature_bytes: [u8; 64] = binding
        .signature
        .as_slice()
        .try_into()
        .map_err(|_| KeyBindingError::InvalidSignature)?;
    let signature = Signature::from_bytes(&signature_bytes);
    let signable = binding_signable_bytes(
        &binding.device_id,
        &binding.ed25519_public_key,
        &binding.x25519_public_key,
        binding.bound_at_ms,
    );
    verifying_key
        .verify(&signable, &signature)
        .map_err(|_| KeyBindingError::InvalidSignature)
}

/// Directional session keys derived from a completed X25519 agreement. `send`/`receive` are
/// deliberately distinct keys (HKDF with different `info` context) so leaking one direction's
/// key never grants the ability to forge the other direction.
pub struct SessionKeys {
    pub send: [u8; SESSION_KEY_LEN],
    pub receive: [u8; SESSION_KEY_LEN],
}

/// Derives directional session keys for one side of a connection. `local_is_initiator` selects
/// which HKDF context is used for send vs. receive so both peers derive matching but opposite
/// keys without needing to exchange a role flag in-band.
pub fn derive_session_keys(
    local_secret: &X25519StaticSecret,
    remote_public: &X25519PublicKey,
    protocol_version: u32,
    local_device_id: &str,
    remote_device_id: &str,
    session_id: &str,
    local_is_initiator: bool,
) -> SessionKeys {
    let shared_secret = local_secret.diffie_hellman(remote_public);
    let hkdf = Hkdf::<Sha256>::new(None, shared_secret.as_bytes());

    let (initiator_id, responder_id) = if local_is_initiator {
        (local_device_id, remote_device_id)
    } else {
        (remote_device_id, local_device_id)
    };
    let initiator_to_responder_info = format!(
        "alethe-session-v1|{protocol_version}|{session_id}|{initiator_id}->{responder_id}"
    );
    let responder_to_initiator_info = format!(
        "alethe-session-v1|{protocol_version}|{session_id}|{responder_id}->{initiator_id}"
    );

    let mut initiator_to_responder = [0_u8; SESSION_KEY_LEN];
    hkdf.expand(initiator_to_responder_info.as_bytes(), &mut initiator_to_responder)
        .expect("32-byte okm is within HKDF-SHA256 output limits");
    let mut responder_to_initiator = [0_u8; SESSION_KEY_LEN];
    hkdf.expand(responder_to_initiator_info.as_bytes(), &mut responder_to_initiator)
        .expect("32-byte okm is within HKDF-SHA256 output limits");

    if local_is_initiator {
        SessionKeys {
            send: initiator_to_responder,
            receive: responder_to_initiator,
        }
    } else {
        SessionKeys {
            send: responder_to_initiator,
            receive: initiator_to_responder,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand_core::OsRng;

    #[test]
    fn binding_round_trips_and_verifies() {
        let identity = SigningKey::generate(&mut OsRng);
        let (_secret, binding) = generate_bound_key_agreement("dev_a", &identity, 1_000);
        assert!(verify_key_binding(&binding).is_ok());
    }

    #[test]
    fn binding_rejects_tampering_and_wrong_identity() {
        let identity = SigningKey::generate(&mut OsRng);
        let other_identity = SigningKey::generate(&mut OsRng);
        let (_secret, binding) = generate_bound_key_agreement("dev_a", &identity, 1_000);

        let mut tampered_key = binding.clone();
        let (_other_secret, other_binding) =
            generate_bound_key_agreement("dev_a", &other_identity, 1_000);
        tampered_key.x25519_public_key = other_binding.x25519_public_key.clone();
        assert_eq!(
            verify_key_binding(&tampered_key),
            Err(KeyBindingError::InvalidSignature)
        );

        let mut wrong_device = binding;
        wrong_device.device_id = "dev_b".to_string();
        assert_eq!(
            verify_key_binding(&wrong_device),
            Err(KeyBindingError::InvalidSignature)
        );
    }

    #[test]
    fn both_peers_derive_matching_opposite_session_keys() {
        let identity_a = SigningKey::generate(&mut OsRng);
        let identity_b = SigningKey::generate(&mut OsRng);
        let (secret_a, binding_a) = generate_bound_key_agreement("dev_a", &identity_a, 1_000);
        let (secret_b, binding_b) = generate_bound_key_agreement("dev_b", &identity_b, 1_000);

        let public_a =
            X25519PublicKey::from(<[u8; 32]>::try_from(binding_a.x25519_public_key.as_slice()).unwrap());
        let public_b =
            X25519PublicKey::from(<[u8; 32]>::try_from(binding_b.x25519_public_key.as_slice()).unwrap());

        let keys_a =
            derive_session_keys(&secret_a, &public_b, 1, "dev_a", "dev_b", "session-1", true);
        let keys_b =
            derive_session_keys(&secret_b, &public_a, 1, "dev_b", "dev_a", "session-1", false);

        assert_eq!(keys_a.send, keys_b.receive);
        assert_eq!(keys_a.receive, keys_b.send);
        assert_ne!(keys_a.send, keys_a.receive);
    }

    #[test]
    fn different_sessions_derive_unrelated_keys() {
        let identity_a = SigningKey::generate(&mut OsRng);
        let identity_b = SigningKey::generate(&mut OsRng);
        let (secret_a, _binding_a) = generate_bound_key_agreement("dev_a", &identity_a, 1_000);
        let (_secret_b, binding_b) = generate_bound_key_agreement("dev_b", &identity_b, 1_000);
        let public_b =
            X25519PublicKey::from(<[u8; 32]>::try_from(binding_b.x25519_public_key.as_slice()).unwrap());

        let session_1 =
            derive_session_keys(&secret_a, &public_b, 1, "dev_a", "dev_b", "session-1", true);
        let session_2 =
            derive_session_keys(&secret_a, &public_b, 1, "dev_a", "dev_b", "session-2", true);
        assert_ne!(session_1.send, session_2.send);
    }
}
