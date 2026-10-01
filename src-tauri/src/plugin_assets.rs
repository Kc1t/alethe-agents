//! RFC-012 — Plugin System, asset resolution.
//!
//! Resolution core behind the `alethe-plugin://<pluginId>/<path>` scheme. The
//! root is fixed per plugin — `<plugins_root>/<pluginId>/` — so there is no
//! configurable scope to widen.
//!
//! `request_path` is relative to the plugin directory and must carry no leading
//! separator: the scheme handler strips the URI's leading `/` before calling in.
//! Percent-encoding is decoded once before validation, so `%2e%2e` is caught by
//! the same rule as a literal `..`.


use std::path::{Path, PathBuf};

const INVALID_PLUGIN_ID: &str = "invalid_plugin_id";
const INVALID_ASSET_PATH: &str = "invalid_asset_path";
const ASSET_ESCAPES_PLUGIN_DIR: &str = "asset_escapes_plugin_dir";
const ASSET_NOT_FOUND: &str = "asset_not_found";

fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err(INVALID_PLUGIN_ID.to_string());
    }
    // A bare `.` or `..` passes the character check but is still a traversal.
    if id.chars().all(|c| c == '.') {
        return Err(INVALID_PLUGIN_ID.to_string());
    }
    Ok(())
}

/// Single pass only: a double-encoded `%252e` decodes to the literal text
/// `%2e`, which is then treated as a file name and never as a traversal.
fn percent_decode(raw: &str) -> Result<String, String> {
    if !raw.contains('%') {
        return Ok(raw.to_string());
    }
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'%' {
            out.push(bytes[i]);
            i += 1;
            continue;
        }
        if i + 2 >= bytes.len() {
            return Err(INVALID_ASSET_PATH.to_string());
        }
        let hi = (bytes[i + 1] as char)
            .to_digit(16)
            .ok_or_else(|| INVALID_ASSET_PATH.to_string())?;
        let lo = (bytes[i + 2] as char)
            .to_digit(16)
            .ok_or_else(|| INVALID_ASSET_PATH.to_string())?;
        out.push((hi * 16 + lo) as u8);
        i += 3;
    }
    String::from_utf8(out).map_err(|_| INVALID_ASSET_PATH.to_string())
}

fn validate_request_path(path: &str) -> Result<(), String> {
    if path.is_empty()
        || path.starts_with('/')
        || path.contains('\\')
        || path.contains(':')
        || path.contains("..")
        || path.chars().any(|c| c.is_control())
    {
        return Err(INVALID_ASSET_PATH.to_string());
    }
    for segment in path.split('/') {
        if segment.is_empty() || segment.chars().all(|c| c == '.') {
            return Err(INVALID_ASSET_PATH.to_string());
        }
    }
    Ok(())
}

/// Splits a request into the plugin id and the path inside that plugin.
///
/// Two URL shapes arrive. Most platforms use `alethe-plugin://<id>/<path>`, so
/// the host is the id. Windows and Android reach a custom scheme through
/// `http://<scheme>.localhost/...`, which Tauri normalizes to
/// `alethe-plugin://localhost/<id>/<path>` — there the host is the literal
/// string `localhost` and the id is the first path segment.
fn split_target(host: Option<&str>, path: &str) -> Option<(String, String)> {
    let path = path.trim_start_matches('/');
    let host = host?;
    if host.eq_ignore_ascii_case("localhost") || host.eq_ignore_ascii_case("alethe-plugin.localhost")
    {
        return match path.split_once('/') {
            Some((id, rest)) => Some((id.to_string(), rest.to_string())),
            None => Some((path.to_string(), String::new())),
        };
    }
    Some((host.to_string(), path.to_string()))
}

/// Serves `alethe-plugin://<pluginId>/<path>` out of the active profile's
/// plugins directory. Anything the resolver refuses becomes a 403/404 with an
/// empty body — never a filesystem error leaked to the page.
pub fn serve(
    app: &tauri::AppHandle,
    request: &tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let build = |status: u16, body: Vec<u8>, content_type: &str| {
        tauri::http::Response::builder()
            .status(status)
            .header(tauri::http::header::CONTENT_TYPE, content_type)
            // Plugin assets are local and per-plugin; nothing may embed them.
            .header("Cross-Origin-Resource-Policy", "same-origin")
            .header(tauri::http::header::CACHE_CONTROL, "no-store")
            .body(body)
            .unwrap_or_else(|_| tauri::http::Response::new(Vec::new()))
    };

    let uri = request.uri();
    let Some((plugin_id, request_path)) = split_target(uri.host(), uri.path()) else {
        return build(400, Vec::new(), "text/plain");
    };
    let (plugin_id, request_path) = (plugin_id.as_str(), request_path.as_str());

    let plugins_root = match crate::paths::profile_data_dir(app) {
        Ok(dir) => dir.join("plugins"),
        Err(_) => return build(500, Vec::new(), "text/plain"),
    };

    match resolve_plugin_asset(&plugins_root, plugin_id, request_path) {
        Ok(path) => {
            let content_type = asset_content_type(&path);
            match std::fs::read(&path) {
                Ok(bytes) => build(200, bytes, content_type),
                Err(_) => build(404, Vec::new(), "text/plain"),
            }
        }
        Err(reason) if reason == ASSET_ESCAPES_PLUGIN_DIR => {
            #[cfg(debug_assertions)]
            eprintln!("[plugin-assets] refused {plugin_id}/{request_path}: {reason}");
            build(403, Vec::new(), "text/plain")
        }
        Err(_reason) => {
            #[cfg(debug_assertions)]
            eprintln!("[plugin-assets] not served {plugin_id}/{request_path}: {_reason}");
            build(404, Vec::new(), "text/plain")
        }
    }
}

pub fn resolve_plugin_asset(
    plugins_root: &Path,
    plugin_id: &str,
    request_path: &str,
) -> Result<PathBuf, String> {
    validate_id(plugin_id)?;
    let decoded = percent_decode(request_path)?;
    validate_request_path(&decoded)?;

    // Canonicalizing both sides is what defeats a symlink inside the plugin
    // directory whose target lives somewhere else on disk.
    let base = plugins_root
        .join(plugin_id)
        .canonicalize()
        .map_err(|_| ASSET_NOT_FOUND.to_string())?;
    let resolved = base
        .join(&decoded)
        .canonicalize()
        .map_err(|_| ASSET_NOT_FOUND.to_string())?;

    if !resolved.starts_with(&base) {
        return Err(ASSET_ESCAPES_PLUGIN_DIR.to_string());
    }
    if !resolved.is_file() {
        return Err(ASSET_NOT_FOUND.to_string());
    }
    Ok(resolved)
}

/// Extension only — never sniffed from content, so a `.txt` holding script
/// text is still served as an inert octet-stream.
pub fn asset_content_type(path: &Path) -> &'static str {
    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    match extension.as_str() {
        "js" | "mjs" => "text/javascript",
        "css" => "text/css",
        "json" => "application/json",
        "html" => "text/html",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn fixture(tag: &str) -> (PathBuf, PathBuf) {
        let root =
            std::env::temp_dir().join(format!("alethe-plugin-assets-{tag}-{}", nanoid::nanoid!(8)));
        let plugins = root.join("plugins");
        let dir = plugins.join("demo");
        fs::create_dir_all(dir.join("nested")).unwrap();
        fs::write(dir.join("main.js"), "export default 1;").unwrap();
        fs::write(dir.join("nested").join("styles.css"), "body{}").unwrap();
        fs::write(root.join("secret.txt"), "top secret").unwrap();
        (root, plugins)
    }

    #[cfg(windows)]
    fn link_dir(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::windows::fs::symlink_dir(target, link)
    }

    #[cfg(windows)]
    fn link_file(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::windows::fs::symlink_file(target, link)
    }

    #[cfg(unix)]
    fn link_dir(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }

    #[cfg(unix)]
    fn link_file(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }

    #[test]
    fn resolves_a_regular_file_inside_the_plugin_directory() {
        let (root, plugins) = fixture("ok");

        let entry = resolve_plugin_asset(&plugins, "demo", "main.js").unwrap();
        assert!(entry.ends_with("main.js"));
        assert_eq!(fs::read_to_string(&entry).unwrap(), "export default 1;");

        let styles = resolve_plugin_asset(&plugins, "demo", "nested/styles.css").unwrap();
        assert!(styles.is_file());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_an_invalid_plugin_id() {
        let (root, plugins) = fixture("id");

        for id in [
            "",
            "..",
            ".",
            "../demo",
            "de mo",
            "demo/nested",
            "demo\\nested",
            "C:",
        ] {
            assert_eq!(
                resolve_plugin_asset(&plugins, id, "main.js").unwrap_err(),
                INVALID_PLUGIN_ID,
                "id {id:?}"
            );
        }

        // Dots are allowed inside a namespaced id: this one fails on disk, not on the id.
        assert_eq!(
            resolve_plugin_asset(&plugins, "alethe.git-control", "main.js").unwrap_err(),
            ASSET_NOT_FOUND
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_traversal_absolute_and_windows_style_request_paths() {
        let (root, plugins) = fixture("paths");

        for path in [
            "..",
            "../secret.txt",
            "nested/../../secret.txt",
            "/main.js",
            "/etc/passwd",
            "C:/Windows/win.ini",
            "C:\\Windows\\win.ini",
            "nested\\styles.css",
            "\\\\server\\share\\x.js",
            "",
            ".",
            "./main.js",
            "nested//styles.css",
            "main.js\u{0}",
        ] {
            assert_eq!(
                resolve_plugin_asset(&plugins, "demo", path).unwrap_err(),
                INVALID_ASSET_PATH,
                "path {path:?}"
            );
        }

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_percent_encoded_traversal_but_decodes_a_legitimate_name() {
        let (root, plugins) = fixture("percent");
        fs::write(plugins.join("demo").join("my file.js"), "ok").unwrap();

        for path in [
            "%2e%2e/secret.txt",
            "%2E%2E/secret.txt",
            "..%2fsecret.txt",
            "%2e%2e%2Fsecret.txt",
            "%2fetc%2fpasswd",
            "nested%5cstyles.css",
            "main%3astream.js",
            "%zz",
            "%2",
        ] {
            assert_eq!(
                resolve_plugin_asset(&plugins, "demo", path).unwrap_err(),
                INVALID_ASSET_PATH,
                "path {path:?}"
            );
        }

        let decoded = resolve_plugin_asset(&plugins, "demo", "my%20file.js").unwrap();
        assert!(decoded.ends_with("my file.js"));

        // Double encoding decodes once and then reads as a plain, missing file name.
        assert_eq!(
            resolve_plugin_asset(&plugins, "demo", "%252e%252e").unwrap_err(),
            ASSET_NOT_FOUND
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_a_symlink_that_escapes_the_plugin_directory() {
        let (root, plugins) = fixture("symlink");
        let outside = root.join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.js"), "stolen").unwrap();

        let dir_link = link_dir(&outside, &plugins.join("demo").join("escape"));
        let file_link = link_file(
            &outside.join("secret.js"),
            &plugins.join("demo").join("escape.js"),
        );

        match (dir_link, file_link) {
            (Ok(()), Ok(())) => {
                assert_eq!(
                    resolve_plugin_asset(&plugins, "demo", "escape/secret.js").unwrap_err(),
                    ASSET_ESCAPES_PLUGIN_DIR
                );
                assert_eq!(
                    resolve_plugin_asset(&plugins, "demo", "escape.js").unwrap_err(),
                    ASSET_ESCAPES_PLUGIN_DIR
                );
            }
            (dir_result, file_result) => {
                println!(
                    "skipping symlink assertions: this machine refused to create one \
                     (dir: {dir_result:?}, file: {file_result:?}). On Windows this needs \
                     Developer Mode or elevation."
                );
            }
        }

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_a_directory_a_missing_file_and_an_unknown_plugin() {
        let (root, plugins) = fixture("missing");

        assert_eq!(
            resolve_plugin_asset(&plugins, "demo", "nested").unwrap_err(),
            ASSET_NOT_FOUND
        );
        assert_eq!(
            resolve_plugin_asset(&plugins, "demo", "ghost.js").unwrap_err(),
            ASSET_NOT_FOUND
        );
        assert_eq!(
            resolve_plugin_asset(&plugins, "ghost", "main.js").unwrap_err(),
            ASSET_NOT_FOUND
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn splits_both_url_shapes_into_a_plugin_id_and_a_path() {
        // Windows and Android: Tauri rewrites the .localhost form to this.
        assert_eq!(
            split_target(Some("localhost"), "/example.notes/main.js"),
            Some(("example.notes".to_string(), "main.js".to_string()))
        );
        assert_eq!(
            split_target(Some("alethe-plugin.localhost"), "/example.notes/a/b.css"),
            Some(("example.notes".to_string(), "a/b.css".to_string()))
        );
        // Everywhere else: the host is the plugin id.
        assert_eq!(
            split_target(Some("example.notes"), "/main.js"),
            Some(("example.notes".to_string(), "main.js".to_string()))
        );
        // An id with no path is not a file, and is refused downstream.
        assert_eq!(
            split_target(Some("localhost"), "/example.notes"),
            Some(("example.notes".to_string(), String::new()))
        );
        assert_eq!(split_target(None, "/example.notes/main.js"), None);
    }

    #[test]
    fn maps_extensions_to_a_fixed_content_type() {
        for (name, expected) in [
            ("main.js", "text/javascript"),
            ("main.mjs", "text/javascript"),
            ("main.JS", "text/javascript"),
            ("styles.css", "text/css"),
            ("plugin.json", "application/json"),
            ("panel.html", "text/html"),
            ("icon.svg", "image/svg+xml"),
            ("icon.png", "image/png"),
            ("shot.jpg", "image/jpeg"),
            ("shot.jpeg", "image/jpeg"),
            ("shot.webp", "image/webp"),
            ("font.woff2", "font/woff2"),
            ("LICENSE", "application/octet-stream"),
            ("archive.tar.gz", "application/octet-stream"),
            ("payload.wasm", "application/octet-stream"),
            ("main.js.txt", "application/octet-stream"),
        ] {
            assert_eq!(
                asset_content_type(&Path::new("plugin").join(name)),
                expected,
                "name {name:?}"
            );
        }
    }
}
