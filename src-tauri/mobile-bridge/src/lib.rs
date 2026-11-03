use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, PluginHandle, TauriPlugin},
    Manager, Runtime,
};

pub struct MobileSecrets<R: Runtime>(PluginHandle<R>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallApkRequest<'a> {
    pub path: &'a str,
    pub package_name: &'a str,
    pub version_name: &'a str,
    pub version_code: u64,
    pub certificate_sha256: &'a str,
    pub sha256: &'a str,
    pub size: u64,
}

#[derive(Debug)]
pub enum InstallApkError {
    PermissionRequired,
    SettingsUnavailable,
    PackageInvalid,
    InstallerUnavailable,
    InstallBlocked,
    BridgeUnavailable,
}

#[derive(Serialize)]
struct SecretRequest<'a> {
    data: &'a str,
    decrypt: bool,
}

#[derive(Deserialize)]
struct SecretResponse {
    data: String,
}

impl<R: Runtime> MobileSecrets<R> {
    pub fn open_attachment(&self, path: &str, mime_type: &str) -> Result<(), String> {
        self.0
            .run_mobile_plugin::<serde_json::Value>(
                "openAttachment",
                serde_json::json!({"path": path, "mimeType": mime_type}),
            )
            .map(|_| ())
            .map_err(|_| "Android attachment viewer unavailable".to_string())
    }

    pub fn protect(&self, data: &str, decrypt: bool) -> Result<String, String> {
        self.0
            .run_mobile_plugin::<SecretResponse>("protectSecret", SecretRequest { data, decrypt })
            .map(|response| response.data)
            // Plugin errors must not include an API key or decrypted value.
            .map_err(|_| "Android Keystore operation failed".to_string())
    }

    /// Validate the downloaded package in Android's package manager and open
    /// the system's user-confirmed installer. The renderer never receives an
    /// APK path or a permission to install silently.
    pub fn install_apk(&self, request: InstallApkRequest<'_>) -> Result<(), InstallApkError> {
        self.0
            .run_mobile_plugin::<serde_json::Value>("installApk", request)
            .map(|_| ())
            .map_err(|failure| match failure {
                tauri::plugin::mobile::PluginInvokeError::InvokeRejected(response) => {
                    // Only stable, allowlisted codes cross the bridge. Never
                    // forward a platform exception, path or archive detail.
                    match response.code.as_deref() {
                        Some("install_permission") => InstallApkError::PermissionRequired,
                        Some("install_settings") => InstallApkError::SettingsUnavailable,
                        Some("package_invalid") => InstallApkError::PackageInvalid,
                        Some("installer_unavailable") => InstallApkError::InstallerUnavailable,
                        Some("install_blocked") => InstallApkError::InstallBlocked,
                        _ => InstallApkError::BridgeUnavailable,
                    }
                }
                _ => InstallApkError::BridgeUnavailable,
            })
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("life-mobile")
        .setup(|app, api| {
            let handle =
                api.register_android_plugin("com.tzxser.lifetimeline.mobile", "LifeMobilePlugin")?;
            app.manage(MobileSecrets(handle));
            Ok(())
        })
        .build()
}
