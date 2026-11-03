fn main() {
    // There are deliberately no renderer-facing commands. Only the native
    // application may request encryption/decryption through this plugin.
    tauri_plugin::Builder::new(&[])
        .android_path("android")
        .build();
}
