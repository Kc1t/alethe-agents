use std::path::PathBuf;

fn main() {
    // On macOS, link libghostty.a (the Ghostty engine) that `ghostty_bridge` uses to embed native
    // terminal surfaces. The binary is the prebuilt xcframework in src-tauri/vendor (see
    // fetch-ghostty.sh).
    //
    // All of this is macOS-only: on Windows/Linux the build is untouched and `ghostty_bridge`
    // compiles only its stubs.
    #[cfg(target_os = "macos")]
    link_libghostty();

    stage_remote_page_assets();

    tauri_build::build()
}

/// The remote-control web page serves xterm straight from `node_modules`, which only exists after
/// `npm install`. Copying the files into OUT_DIR keeps `cargo check`/`cargo test` working without
/// it (CI's Rust job never installs npm packages): a missing file becomes a stub that says so in
/// the browser console, plus a build warning. Release builds stop instead, so an installer never
/// ships a remote page without its terminal.
fn stage_remote_page_assets() {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let release = std::env::var("PROFILE").as_deref() == Ok("release");
    let mut missing = Vec::new();
    for (package_path, name) in [
        ("@xterm/xterm/lib/xterm.js", "xterm.js"),
        ("@xterm/xterm/css/xterm.css", "xterm.css"),
        (
            "@xterm/addon-unicode11/lib/addon-unicode11.js",
            "addon-unicode11.js",
        ),
    ] {
        let source = manifest_dir.join("../node_modules").join(package_path);
        println!("cargo:rerun-if-changed={}", source.display());
        let body = match std::fs::read(&source) {
            Ok(body) => body,
            Err(_) if release => panic!(
                "node_modules/{package_path} is missing: run `npm ci` in the repository root before building a release"
            ),
            Err(_) => {
                missing.push(package_path);
                stub_asset(name).into_bytes()
            }
        };
        std::fs::write(out_dir.join(name), body).expect("write remote page asset to OUT_DIR");
    }
    if !missing.is_empty() {
        println!(
            "cargo:warning=npm packages are missing ({}): run `npm install` in the repository root and rebuild, or the remote-control page will have no terminal",
            missing.join(", ")
        );
        // Files that show up later with an older mtime (a junction or a copied node_modules) would
        // not trigger a rerun by themselves, so point at a path that never exists: Cargo reruns
        // this script on every build while stubs are in place.
        println!(
            "cargo:rerun-if-changed={}",
            out_dir.join("remote-assets-stubbed").display()
        );
    }
}

fn stub_asset(name: &str) -> String {
    const HINT: &str = "Alethe was built without node_modules: run `npm install` and rebuild to enable the remote terminal.";
    if name.ends_with(".css") {
        format!("/* {HINT} */\n")
    } else {
        format!("console.error({HINT:?});\n")
    }
}

#[cfg(target_os = "macos")]
fn link_libghostty() {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let slice = manifest_dir
        .join("vendor")
        .join("GhosttyKit.xcframework")
        .join("macos-arm64_x86_64");
    let lib = slice.join("libghostty.a");

    // If the vendor files were not fetched yet (fetch-ghostty.sh did not run), warn clearly
    // instead of failing with an obscure linker error. The bridge still compiles; it only
    // returns an error at runtime if called.
    if !lib.is_file() {
        println!(
            "cargo:warning=libghostty.a is missing at {}. Run src-tauri/vendor/fetch-ghostty.sh before building with the native macOS terminal.",
            lib.display()
        );
        // Link directives are emitted only when the library exists, so builds that do not use
        // the native terminal keep working.
        return;
    }

    let headers = slice.join("Headers");

    // Compile the Objective-C shim (ghostty_shim.m). It includes the real ghostty.h, so the
    // include path points at the xcframework Headers. ARC is on for the NSPasteboard/NSString
    // uses. The object lands in the crate's static lib.
    cc::Build::new()
        .file("ghostty_shim/ghostty_shim.m")
        .include("ghostty_shim")
        .include(&headers)
        .flag("-fobjc-arc")
        .flag("-fmodules")
        .compile("alethe_ghostty_shim");
    println!("cargo:rerun-if-changed=ghostty_shim/ghostty_shim.m");
    println!("cargo:rerun-if-changed=ghostty_shim/ghostty_shim.h");

    println!("cargo:rustc-link-search=native={}", slice.display());
    println!("cargo:rustc-link-lib=static=ghostty");

    // Runtime dependencies of the engine (see GhosttyKit's Package.swift and Ghostty's GPU
    // rendering requirements on macOS).
    println!("cargo:rustc-link-lib=c++");
    println!("cargo:rustc-link-lib=framework=Carbon");
    println!("cargo:rustc-link-lib=framework=Metal");
    println!("cargo:rustc-link-lib=framework=MetalKit");
    println!("cargo:rustc-link-lib=framework=QuartzCore");
    println!("cargo:rustc-link-lib=framework=CoreVideo");
    println!("cargo:rustc-link-lib=framework=CoreText");
    println!("cargo:rustc-link-lib=framework=CoreGraphics");

    // Tell the code libghostty is available to link, so `ghostty_bridge` can switch to the real
    // FFI path (instead of the stub) through `#[cfg(ghostty_linked)]`.
    println!("cargo:rustc-cfg=ghostty_linked");
    println!("cargo:rustc-check-cfg=cfg(ghostty_linked)");

    println!("cargo:rerun-if-changed={}", lib.display());
}
