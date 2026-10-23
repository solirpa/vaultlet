fn main() {
    // On Windows the Common Controls v6 manifest (needed by the dialog plugin) is normally embedded
    // only into the app binary, so `cargo test` executables die with STATUS_ENTRYPOINT_NOT_FOUND.
    // Embed it through the linker instead, which covers every target including tests.
    let msvc = std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    if msvc {
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
        let windows = tauri_build::WindowsAttributes::new_without_app_manifest();
        tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows)).expect("tauri build");
    } else {
        tauri_build::build()
    }
}
