use std::path::PathBuf;

fn main() {
    // No macOS, linkamos o libghostty.a (engine do Ghostty) que o módulo
    // `ghostty_bridge` usa para embutir surfaces de terminal nativas. O binário
    // é o xcframework pré-buildado em src-tauri/vendor (ver fetch-ghostty.sh).
    //
    // Tudo isto é macOS-only: em Windows/Linux o build segue intocado e o
    // `ghostty_bridge` compila apenas seus stubs.
    #[cfg(target_os = "macos")]
    link_libghostty();

    tauri_build::build()
}

#[cfg(target_os = "macos")]
fn link_libghostty() {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let slice = manifest_dir
        .join("vendor")
        .join("GhosttyKit.xcframework")
        .join("macos-arm64_x86_64");
    let lib = slice.join("libghostty.a");

    // Se o vendor ainda não foi baixado (fetch-ghostty.sh não rodou), avisamos
    // de forma clara em vez de explodir num erro de linker obscuro. O bridge
    // continua compilando — só vai retornar erro em runtime se chamado.
    if !lib.is_file() {
        println!(
            "cargo:warning=libghostty.a ausente em {}. Rode src-tauri/vendor/fetch-ghostty.sh antes de buildar com o terminal nativo do macOS.",
            lib.display()
        );
        // Mesmo ausente, definimos a cfg para o código condicional saber que a
        // intenção era linkar — mas só emitimos as diretivas de link se existir,
        // pra não quebrar builds que não usam a feature.
        return;
    }

    let headers = slice.join("Headers");

    // Compila o shim Objective-C (ghostty_shim.m). Ele inclui o ghostty.h real,
    // então o include path aponta pros Headers do xcframework. ARC ligado pros
    // usos de NSPasteboard/NSString. O .o entra na mesma static lib do crate.
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

    // Dependências de runtime da engine (ver Package.swift do GhosttyKit +
    // requisitos de render GPU do Ghostty no macOS).
    println!("cargo:rustc-link-lib=c++");
    println!("cargo:rustc-link-lib=framework=Carbon");
    println!("cargo:rustc-link-lib=framework=Metal");
    println!("cargo:rustc-link-lib=framework=MetalKit");
    println!("cargo:rustc-link-lib=framework=QuartzCore");
    println!("cargo:rustc-link-lib=framework=CoreVideo");
    println!("cargo:rustc-link-lib=framework=CoreText");
    println!("cargo:rustc-link-lib=framework=CoreGraphics");

    // Sinaliza ao código que o libghostty está disponível para link, de modo
    // que `ghostty_bridge` possa ativar o caminho FFI real (em vez do stub) via
    // `#[cfg(ghostty_linked)]`.
    println!("cargo:rustc-cfg=ghostty_linked");
    println!("cargo:rustc-check-cfg=cfg(ghostty_linked)");

    println!("cargo:rerun-if-changed={}", lib.display());
}
