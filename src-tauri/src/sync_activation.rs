//! Optional collaboration service activation and provider configuration (Phase 10A). Implements
//! items 1–3 of `docs/adr/ADR-0002-optional-cloudflare-rendezvous.md`'s "Planned Phase 10
//! implementation": a provider-independent Core interface, local-only/managed/advanced settings
//! persistence, and the fail-closed connection state machine. No Cloudflare-specific code exists
//! here or anywhere in this codebase yet — that is Phase 10B's scope. Every test in this module
//! drives the state machine against a local, in-memory test double of `RendezvousProvider`; no
//! network call is ever made by this module.

use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

const ACTIVATION_SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ServiceMode {
    /// No rendezvous connection is ever attempted. The default for every new install.
    LocalOnly,
    /// The operator-managed default Alethe endpoint, chosen without the user providing any
    /// Cloudflare account, token, domain, or certificate.
    AletheManaged,
    /// A user-supplied, self-hosted, protocol-compatible endpoint.
    AdvancedCustom,
}

/// Only non-secret fields are ever persisted here. No token, credential, or private key belongs
/// in this struct — enforced by `only_non_secret_settings_are_persisted` below, which fails if a
/// new field is ever added without updating that test's exhaustive field list.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceSettings {
    pub mode: ServiceMode,
    /// Explicit opt-in, distinct from `mode`: a user can select `AdvancedCustom` and fill in an
    /// endpoint without yet enabling the connection, keeping activation a deliberate final step.
    pub enabled: bool,
    /// Only meaningful for `AdvancedCustom`; ignored for `LocalOnly`/`AletheManaged`.
    pub custom_endpoint: Option<String>,
    /// Set only after `validate_endpoint_at` succeeds; cleared whenever the mode or endpoint
    /// changes, so a stale validation can never be mistaken for a fresh one.
    pub validated_endpoint: Option<String>,
    pub compatible_protocol_min: Option<u32>,
    pub compatible_protocol_max: Option<u32>,
    pub updated_at_ms: u64,
}

impl ServiceSettings {
    fn local_only(now_ms: u64) -> Self {
        ServiceSettings {
            mode: ServiceMode::LocalOnly,
            enabled: false,
            custom_endpoint: None,
            validated_endpoint: None,
            compatible_protocol_min: None,
            compatible_protocol_max: None,
            updated_at_ms: now_ms,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActivationState {
    Disabled,
    IdentityRequired,
    Ready,
    Connecting,
    Online,
    Retrying,
    DirectOnly,
    NeedsAttention,
}

/// A feature that needs rendezvous to work, used to decide whether to contextually offer
/// activation. Listed exhaustively so a new remote-requiring feature must be added here
/// deliberately rather than silently bypassing the "never connect unless offered" rule.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActivationTrigger {
    ShareProjectRemotely,
    OpenRemoteInvitation,
    EnableCrossDeviceDiscovery,
    OpenCollaborationFeature,
    /// A purely local action (e.g. viewing local projects) — included so tests can prove this
    /// never triggers an activation offer, not just that the other variants do.
    LocalOnlyAction,
}

impl ActivationTrigger {
    fn requires_rendezvous(self) -> bool {
        !matches!(self, ActivationTrigger::LocalOnlyAction)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActivationError {
    Io,
    InvalidEndpoint,
    ProtocolIncompatible,
}

impl std::fmt::Display for ActivationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let code = match self {
            ActivationError::Io => "activation_io_error",
            ActivationError::InvalidEndpoint => "activation_invalid_endpoint",
            ActivationError::ProtocolIncompatible => "activation_protocol_incompatible",
        };
        write!(f, "{code}")
    }
}

fn settings_path(data_root: &Path) -> PathBuf {
    data_root.join("sync").join("activation.json")
}

#[derive(Serialize, Deserialize)]
struct SettingsDocument {
    schema_version: u32,
    settings: ServiceSettings,
}

pub fn load_settings_at(data_root: &Path, now_ms: u64) -> Result<ServiceSettings, ActivationError> {
    let path = settings_path(data_root);
    if !path.exists() {
        return Ok(ServiceSettings::local_only(now_ms));
    }
    let bytes = fs::read(&path).map_err(|_| ActivationError::Io)?;
    let document: SettingsDocument =
        serde_json::from_slice(&bytes).map_err(|_| ActivationError::Io)?;
    if document.schema_version != ACTIVATION_SCHEMA_VERSION {
        return Err(ActivationError::Io);
    }
    Ok(document.settings)
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> Result<(), ActivationError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(ActivationError::Io)
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> Result<(), ActivationError> {
    fs::rename(source, destination).map_err(|_| ActivationError::Io)
}

fn save_settings_at(data_root: &Path, settings: &ServiceSettings) -> Result<(), ActivationError> {
    let path = settings_path(data_root);
    let parent = path.parent().ok_or(ActivationError::Io)?;
    fs::create_dir_all(parent).map_err(|_| ActivationError::Io)?;
    let temporary = parent.join(format!(".activation-{}.tmp", nanoid::nanoid!(12)));
    let document = SettingsDocument {
        schema_version: ACTIVATION_SCHEMA_VERSION,
        settings: settings.clone(),
    };
    let bytes = serde_json::to_vec_pretty(&document).map_err(|_| ActivationError::Io)?;
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|_| ActivationError::Io)?;
    if file
        .write_all(&bytes)
        .and_then(|_| file.sync_all())
        .is_err()
    {
        let _ = fs::remove_file(&temporary);
        return Err(ActivationError::Io);
    }
    replace_file(&temporary, &path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        error
    })
}

/// Switches mode and/or the advanced custom endpoint. Always clears `validated_endpoint` and
/// `enabled`, so a mode/endpoint change can never silently keep a stale validated/connected
/// status from a previous configuration.
pub fn set_mode_at(
    data_root: &Path,
    mode: ServiceMode,
    custom_endpoint: Option<String>,
    now_ms: u64,
) -> Result<ServiceSettings, ActivationError> {
    let settings = ServiceSettings {
        mode,
        enabled: false,
        custom_endpoint: if mode == ServiceMode::AdvancedCustom {
            custom_endpoint
        } else {
            None
        },
        validated_endpoint: None,
        compatible_protocol_min: None,
        compatible_protocol_max: None,
        updated_at_ms: now_ms,
    };
    save_settings_at(data_root, &settings)?;
    Ok(settings)
}

/// Explicit final opt-in step. Requires a mode other than `LocalOnly` and, for `AdvancedCustom`,
/// a `validated_endpoint` already set by a prior successful `validate_endpoint_at` call — an
/// unvalidated custom endpoint can never be enabled.
pub fn enable_service_at(
    data_root: &Path,
    now_ms: u64,
) -> Result<ServiceSettings, ActivationError> {
    let mut settings = load_settings_at(data_root, now_ms)?;
    if settings.mode == ServiceMode::AdvancedCustom && settings.validated_endpoint.is_none() {
        return Err(ActivationError::InvalidEndpoint);
    }
    settings.enabled = settings.mode != ServiceMode::LocalOnly;
    settings.updated_at_ms = now_ms;
    save_settings_at(data_root, &settings)?;
    Ok(settings)
}

pub fn disable_service_at(
    data_root: &Path,
    now_ms: u64,
) -> Result<ServiceSettings, ActivationError> {
    let mut settings = load_settings_at(data_root, now_ms)?;
    settings.enabled = false;
    settings.updated_at_ms = now_ms;
    save_settings_at(data_root, &settings)?;
    Ok(settings)
}

/// Endpoint scheme/TLS/protocol-version/health/identity checking, kept behind a trait so this
/// phase can prove the state machine's behavior without any real network code — exactly the
/// "mechanism proven, live wiring deferred" pattern used in every phase since Phase 4. A real
/// implementation (HTTPS scheme check, certificate validation, a versioned handshake against the
/// configured endpoint) is Phase 10B's job, once a real provider exists to validate against.
pub trait EndpointValidator {
    fn validate(&self, endpoint: &str) -> Result<(u32, u32), ActivationError>;
}

pub fn validate_endpoint_at(
    data_root: &Path,
    endpoint: &str,
    validator: &dyn EndpointValidator,
    now_ms: u64,
) -> Result<ServiceSettings, ActivationError> {
    let mut settings = load_settings_at(data_root, now_ms)?;
    if settings.mode != ServiceMode::AdvancedCustom {
        return Err(ActivationError::InvalidEndpoint);
    }
    let (min, max) = validator.validate(endpoint)?;
    settings.custom_endpoint = Some(endpoint.to_string());
    settings.validated_endpoint = Some(endpoint.to_string());
    settings.compatible_protocol_min = Some(min);
    settings.compatible_protocol_max = Some(max);
    settings.updated_at_ms = now_ms;
    save_settings_at(data_root, &settings)?;
    Ok(settings)
}

/// Whether a live rendezvous connection currently exists for the enabled service, as reported by
/// a `RendezvousProvider`. Phase 10A never runs a real connection loop; this is fed by test
/// doubles today and will be fed by the Phase 10B Cloudflare adapter in the future.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LiveConnectionStatus {
    NoAttemptYet,
    Connecting,
    Online,
    RetryingAfterTransientFailure,
    /// Rendezvous is unavailable, but an already-established authenticated peer session (Phase 4)
    /// continues to work.
    DirectSessionOnly,
    /// A non-transient provider/protocol failure (e.g. incompatible version, suspended account).
    ProviderFailure,
}

pub trait IdentityOracle {
    fn has_verified_identity(&self) -> bool;
}

pub struct SecurityBackedIdentityOracle<'a> {
    pub data_root: &'a Path,
}

impl IdentityOracle for SecurityBackedIdentityOracle<'_> {
    fn has_verified_identity(&self) -> bool {
        let Ok(document) = crate::sync_security::load_at(self.data_root) else {
            return false;
        };
        document
            .devices
            .iter()
            .any(|device| device.trust == crate::sync_security::DeviceTrust::Trusted)
    }
}

/// Pure function computing the current `ActivationState` from persisted settings, verified
/// identity, and (once a connection exists) live provider status. Never performs I/O or a network
/// call itself — every input is supplied by the caller, which is what makes the full lifecycle
/// testable without a real provider.
pub fn resolve_activation_state(
    settings: &ServiceSettings,
    identity: &dyn IdentityOracle,
    live_status: LiveConnectionStatus,
) -> ActivationState {
    if settings.mode == ServiceMode::LocalOnly || !settings.enabled {
        return ActivationState::Disabled;
    }
    if settings.mode == ServiceMode::AdvancedCustom && settings.validated_endpoint.is_none() {
        return ActivationState::NeedsAttention;
    }
    if !identity.has_verified_identity() {
        return ActivationState::IdentityRequired;
    }
    match live_status {
        LiveConnectionStatus::NoAttemptYet => ActivationState::Ready,
        LiveConnectionStatus::Connecting => ActivationState::Connecting,
        LiveConnectionStatus::Online => ActivationState::Online,
        LiveConnectionStatus::RetryingAfterTransientFailure => ActivationState::Retrying,
        LiveConnectionStatus::DirectSessionOnly => ActivationState::DirectOnly,
        LiveConnectionStatus::ProviderFailure => ActivationState::NeedsAttention,
    }
}

/// Whether the UI should contextually offer enabling the service. Only ever true when the
/// feature actually requires rendezvous and the service is not already enabled — never offered
/// for purely local actions, and never offered again once already enabled.
pub fn should_offer_activation(settings: &ServiceSettings, trigger: ActivationTrigger) -> bool {
    trigger.requires_rendezvous() && !settings.enabled
}

/// The provider-independent Core interface from ADR-0002 item 1. No implementation exists in
/// this codebase yet outside test doubles — the Cloudflare adapter (Phase 10B) will be the first
/// real implementation, kept entirely behind this trait so no Cloudflare SDK type ever needs to
/// leak into security, invitation, sync, task, or chat code.
pub trait RendezvousProvider {
    fn check_compatibility(&self) -> Result<(u32, u32), ActivationError>;
    fn connect(&self) -> Result<(), ActivationError>;
    fn authenticate_device(&self) -> Result<(), ActivationError>;
    fn status(&self) -> LiveConnectionStatus;
    fn close(&self);
}

#[tauri::command]
pub fn sync_get_activation_settings(app: tauri::AppHandle) -> Result<ServiceSettings, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    load_settings_at(&data_root, crate::provider_common::now_ms()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sync_set_activation_mode(
    app: tauri::AppHandle,
    mode: ServiceMode,
    custom_endpoint: Option<String>,
) -> Result<ServiceSettings, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    set_mode_at(
        &data_root,
        mode,
        custom_endpoint,
        crate::provider_common::now_ms(),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sync_enable_activation(app: tauri::AppHandle) -> Result<ServiceSettings, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    enable_service_at(&data_root, crate::provider_common::now_ms()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sync_disable_activation(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, std::sync::Arc<crate::sync_rendezvous::RendezvousRuntime>>,
) -> Result<ServiceSettings, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    let settings = disable_service_at(&data_root, crate::provider_common::now_ms())
        .map_err(|e| e.to_string())?;
    crate::sync_rendezvous::disconnect_at(&runtime);
    Ok(settings)
}

#[tauri::command]
pub fn sync_resolve_activation_state(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, std::sync::Arc<crate::sync_rendezvous::RendezvousRuntime>>,
) -> Result<ActivationState, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    let settings = load_settings_at(&data_root, crate::provider_common::now_ms())
        .map_err(|e| e.to_string())?;
    let identity = SecurityBackedIdentityOracle {
        data_root: &data_root,
    };
    Ok(resolve_activation_state(
        &settings,
        &identity,
        runtime.status(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct AlwaysVerified;
    impl IdentityOracle for AlwaysVerified {
        fn has_verified_identity(&self) -> bool {
            true
        }
    }

    struct NeverVerified;
    impl IdentityOracle for NeverVerified {
        fn has_verified_identity(&self) -> bool {
            false
        }
    }

    struct AcceptingValidator;
    impl EndpointValidator for AcceptingValidator {
        fn validate(&self, endpoint: &str) -> Result<(u32, u32), ActivationError> {
            if endpoint.starts_with("https://") {
                Ok((1, 1))
            } else {
                Err(ActivationError::InvalidEndpoint)
            }
        }
    }

    fn temp_root(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("alethe-activation-{name}-{}", nanoid::nanoid!(8)));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn local_only_never_attempts_a_connection() {
        let root = temp_root("local-only");
        let settings = load_settings_at(&root, 1_000).unwrap();
        assert_eq!(settings.mode, ServiceMode::LocalOnly);
        assert!(!settings.enabled);
        let state = resolve_activation_state(
            &settings,
            &AlwaysVerified,
            LiveConnectionStatus::NoAttemptYet,
        );
        assert_eq!(state, ActivationState::Disabled);
        assert!(should_offer_activation(
            &settings,
            ActivationTrigger::ShareProjectRemotely
        ));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn contextual_activation_is_never_offered_for_local_only_actions_or_once_enabled() {
        let root = temp_root("contextual");
        let local_only = load_settings_at(&root, 1_000).unwrap();
        assert!(!should_offer_activation(
            &local_only,
            ActivationTrigger::LocalOnlyAction
        ));

        set_mode_at(&root, ServiceMode::AletheManaged, None, 2_000).unwrap();
        enable_service_at(&root, 3_000).unwrap();
        let enabled = load_settings_at(&root, 3_000).unwrap();
        assert!(!should_offer_activation(
            &enabled,
            ActivationTrigger::ShareProjectRemotely
        ));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn enabling_without_verified_identity_is_identity_required() {
        let root = temp_root("identity-required");
        set_mode_at(&root, ServiceMode::AletheManaged, None, 1_000).unwrap();
        let settings = enable_service_at(&root, 2_000).unwrap();
        assert!(settings.enabled);
        let state = resolve_activation_state(
            &settings,
            &NeverVerified,
            LiveConnectionStatus::NoAttemptYet,
        );
        assert_eq!(state, ActivationState::IdentityRequired);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn enabling_with_identity_and_no_connection_attempt_yet_is_ready() {
        let root = temp_root("ready");
        set_mode_at(&root, ServiceMode::AletheManaged, None, 1_000).unwrap();
        let settings = enable_service_at(&root, 2_000).unwrap();
        let state = resolve_activation_state(
            &settings,
            &AlwaysVerified,
            LiveConnectionStatus::NoAttemptYet,
        );
        assert_eq!(state, ActivationState::Ready);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn advanced_mode_requires_a_validated_custom_endpoint_before_enabling() {
        let root = temp_root("advanced-unvalidated");
        set_mode_at(
            &root,
            ServiceMode::AdvancedCustom,
            Some("https://relay.example".to_string()),
            1_000,
        )
        .unwrap();
        let result = enable_service_at(&root, 2_000);
        assert_eq!(result.unwrap_err(), ActivationError::InvalidEndpoint);

        validate_endpoint_at(&root, "https://relay.example", &AcceptingValidator, 3_000).unwrap();
        let settings = enable_service_at(&root, 4_000).unwrap();
        assert!(settings.enabled);
        assert_eq!(
            settings.validated_endpoint.as_deref(),
            Some("https://relay.example")
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_validation_never_silently_falls_back_to_ready() {
        let root = temp_root("failed-validation");
        set_mode_at(
            &root,
            ServiceMode::AdvancedCustom,
            Some("ftp://relay.example".to_string()),
            1_000,
        )
        .unwrap();
        let result = validate_endpoint_at(&root, "ftp://relay.example", &AcceptingValidator, 2_000);
        assert_eq!(result.unwrap_err(), ActivationError::InvalidEndpoint);

        // enable_service_at must still refuse — the failed validation never set validated_endpoint.
        let enable_result = enable_service_at(&root, 3_000);
        assert_eq!(enable_result.unwrap_err(), ActivationError::InvalidEndpoint);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn changing_endpoint_clears_the_previous_validation() {
        let root = temp_root("revalidate");
        set_mode_at(
            &root,
            ServiceMode::AdvancedCustom,
            Some("https://relay-one.example".to_string()),
            1_000,
        )
        .unwrap();
        validate_endpoint_at(
            &root,
            "https://relay-one.example",
            &AcceptingValidator,
            2_000,
        )
        .unwrap();
        // Switching the endpoint (re-running set_mode_at) must clear the earlier validation.
        let settings = set_mode_at(
            &root,
            ServiceMode::AdvancedCustom,
            Some("https://relay-two.example".to_string()),
            3_000,
        )
        .unwrap();
        assert!(settings.validated_endpoint.is_none());
        assert_eq!(
            enable_service_at(&root, 4_000).unwrap_err(),
            ActivationError::InvalidEndpoint
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn full_lifecycle_via_a_scripted_provider_status() {
        let root = temp_root("lifecycle");
        set_mode_at(&root, ServiceMode::AletheManaged, None, 1_000).unwrap();
        let settings = enable_service_at(&root, 2_000).unwrap();

        assert_eq!(
            resolve_activation_state(&settings, &AlwaysVerified, LiveConnectionStatus::Connecting),
            ActivationState::Connecting
        );
        assert_eq!(
            resolve_activation_state(&settings, &AlwaysVerified, LiveConnectionStatus::Online),
            ActivationState::Online
        );
        assert_eq!(
            resolve_activation_state(
                &settings,
                &AlwaysVerified,
                LiveConnectionStatus::RetryingAfterTransientFailure
            ),
            ActivationState::Retrying
        );
        assert_eq!(
            resolve_activation_state(
                &settings,
                &AlwaysVerified,
                LiveConnectionStatus::DirectSessionOnly
            ),
            ActivationState::DirectOnly
        );
        assert_eq!(
            resolve_activation_state(
                &settings,
                &AlwaysVerified,
                LiveConnectionStatus::ProviderFailure
            ),
            ActivationState::NeedsAttention
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn only_non_secret_settings_fields_exist_on_the_persisted_struct() {
        // Exhaustive destructure: if a field is ever added to `ServiceSettings` without updating
        // this test, compilation fails here rather than silently persisting a new field that
        // might carry a secret.
        let settings = ServiceSettings::local_only(1_000);
        let ServiceSettings {
            mode: _,
            enabled: _,
            custom_endpoint: _,
            validated_endpoint: _,
            compatible_protocol_min: _,
            compatible_protocol_max: _,
            updated_at_ms: _,
        } = settings;
    }

    #[test]
    fn disabling_the_service_returns_to_disabled_regardless_of_prior_validation() {
        let root = temp_root("disable");
        set_mode_at(&root, ServiceMode::AletheManaged, None, 1_000).unwrap();
        enable_service_at(&root, 2_000).unwrap();
        let settings = disable_service_at(&root, 3_000).unwrap();
        assert!(!settings.enabled);
        let state =
            resolve_activation_state(&settings, &AlwaysVerified, LiveConnectionStatus::Online);
        assert_eq!(state, ActivationState::Disabled);
        fs::remove_dir_all(root).unwrap();
    }
}
