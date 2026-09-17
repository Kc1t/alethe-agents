//! Diagnostic probe for the single-instance D-Bus handoff (Linux only).
//!
//! `tauri-plugin-single-instance` exits the second process with status 0 without
//! printing anything: on `NameTaken` it fires `ExecuteCallback` at the current
//! owner, discards the result and calls `std::process::exit(0)`. The callback
//! runs in the *original* process, so a message logged there never reaches the
//! terminal that started the second process. When the owner is wedged and never
//! answers, the launch is indistinguishable from a broken install.
//!
//! This module runs before the Tauri builder and reports what the plugin is
//! about to do. It never claims the name and never answers the handoff — the
//! plugin stays the single authority over that.

use std::time::Duration;

use zbus::blocking::{connection, fdo::DBusProxy};
use zbus::names::BusName;

/// Matches the reply timeout the probe allows the existing instance. Local IPC
/// answers in single-digit milliseconds; anything past this is a wedged owner.
const HANDOFF_TIMEOUT: Duration = Duration::from_secs(1);

#[derive(Debug, PartialEq, Eq)]
pub enum ProbeOutcome {
    /// Nobody owns the name: this process is the first instance.
    NameFree,
    /// An instance owns the name and answered the handoff.
    HandoffAccepted { pid: Option<u32> },
    /// An instance owns the name but did not answer within the timeout.
    StaleOwner { pid: Option<u32> },
    /// The probe itself could not run (no session bus, malformed name).
    Inconclusive,
}

/// Mirrors the name the plugin registers. Keep in sync with
/// `tauri-plugin-single-instance`'s `platform_impl/linux.rs`: the `semver`
/// feature would append a version suffix here, and it is not enabled.
pub fn dbus_name(identifier: &str) -> String {
    format!("{identifier}.SingleInstance")
}

/// Mirrors the plugin's object path derivation: dots to slashes, dashes to
/// underscores, always rooted.
pub fn dbus_path(dbus_name: &str) -> String {
    let path = dbus_name.replace('.', "/").replace('-', "_");
    if path.starts_with('/') {
        path
    } else {
        format!("/{path}")
    }
}

/// Asks the bus who owns the name and, when someone does, whether they still
/// answer. Read-only: it does not request the name, so the plugin's own
/// registration a few milliseconds later is unaffected.
pub fn probe(identifier: &str) -> ProbeOutcome {
    let name = dbus_name(identifier);
    let path = dbus_path(&name);

    // The liveness check must not outlive a wedged owner, and `zbus` scopes the
    // method timeout to the connection rather than the call.
    let Ok(connection) = connection::Builder::session()
        .and_then(|builder| builder.method_timeout(HANDOFF_TIMEOUT).build())
    else {
        return ProbeOutcome::Inconclusive;
    };
    let Ok(proxy) = DBusProxy::new(&connection) else {
        return ProbeOutcome::Inconclusive;
    };
    let Ok(bus_name) = BusName::try_from(name.as_str()) else {
        return ProbeOutcome::Inconclusive;
    };

    match proxy.name_has_owner(bus_name.clone()) {
        Ok(false) => return ProbeOutcome::NameFree,
        Ok(true) => {}
        Err(_) => return ProbeOutcome::Inconclusive,
    }

    let pid = proxy.get_connection_unix_process_id(bus_name.clone()).ok();

    // `Peer.Ping` is answered by the D-Bus machinery of any responsive process
    // and has no side effects. Calling `ExecuteCallback` here would work too,
    // but it would focus the existing window a second time once the plugin
    // repeats the handoff.
    let answered = connection
        .call_method(
            Some(name.as_str()),
            path.as_str(),
            Some("org.freedesktop.DBus.Peer"),
            "Ping",
            &(),
        )
        .is_ok();

    if answered {
        return ProbeOutcome::HandoffAccepted { pid };
    }

    // The owner may simply have exited between the two calls, which is a normal
    // race rather than the wedged case: re-check before blaming a stale owner.
    match proxy.name_has_owner(bus_name) {
        Ok(false) => ProbeOutcome::NameFree,
        _ => ProbeOutcome::StaleOwner { pid },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_single_instance_subname() {
        assert_eq!(
            dbus_name("com.kc1t.alethe"),
            "com.kc1t.alethe.SingleInstance"
        );
        assert_eq!(
            dbus_name("com.kc1t.alethe.dev"),
            "com.kc1t.alethe.dev.SingleInstance"
        );
    }

    #[test]
    fn path_mirrors_plugin_derivation() {
        assert_eq!(
            dbus_path("com.kc1t.alethe.SingleInstance"),
            "/com/kc1t/alethe/SingleInstance"
        );
    }

    #[test]
    fn path_replaces_dashes_with_underscores() {
        assert_eq!(
            dbus_path("com.my-company.app.SingleInstance"),
            "/com/my_company/app/SingleInstance"
        );
    }

    #[test]
    fn path_is_always_rooted() {
        assert_eq!(dbus_path("a.b"), "/a/b");
        assert!(dbus_path(&dbus_name("com.kc1t.alethe")).starts_with('/'));
    }
}
