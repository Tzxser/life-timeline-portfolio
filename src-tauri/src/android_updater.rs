//! Android-only update service.
//!
//! Android does not use Tauri's Windows updater plugin.  This module fetches
//! the small, same-origin Android release manifest, verifies its identity and
//! hash, then hands the app-private APK to the Kotlin bridge.  The bridge
//! performs the package/signature checks and starts Android's confirmation
//! installer; no install is ever attempted silently.

use crate::android_update_policy::{recent_result_status, release_is_newer, require_newer_release};
use crate::models::CommandError;
use crate::{mobile, security, AppState};
use chrono::{DateTime, Utc};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager, State};
use url::Url;
use uuid::Uuid;

const RELEASE_HOST: &str = "life-timeline.xinciqq.top";
const RELEASE_ENDPOINT: &str = "https://life-timeline.xinciqq.top/downloads/android-latest.json";
const PACKAGE_NAME: &str = "com.tzxser.lifetimeline";
const PINNED_CERTIFICATE_SHA256: &str =
    "3a940b62ca98fb572bd8a1b8564ae1f71461c98a0c9747675f369ba46ed49ea8";
const SUPPORTED_ABI: &str = "arm64-v8a";
const AUTOMATIC_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const OFFLINE_INTERVAL: Duration = Duration::from_secs(60);
const MANUAL_INTERVAL: Duration = Duration::from_secs(10);
const TOKEN_LIFETIME: Duration = Duration::from_secs(60 * 60);
const METADATA_MAX_BYTES: usize = 32 * 1024;
const APK_MAX_BYTES: u64 = 1024 * 1024 * 1024;
const PROGRESS_EVENT: &str = "life-timeline://update-progress";

fn error(code: &str, message: &str) -> CommandError {
    CommandError {
        code: code.into(),
        message: message.into(),
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReleaseMetadata {
    version: String,
    #[serde(rename = "publishedAt")]
    published_at: String,
    url: String,
    size: u64,
    sha256: String,
    notes: Vec<String>,
    abi: String,
    #[serde(rename = "minSdkVersion")]
    min_sdk_version: u32,
    #[serde(rename = "versionCode")]
    version_code: u64,
    #[serde(rename = "packageName")]
    package_name: String,
    #[serde(rename = "certificateSha256")]
    certificate_sha256: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdatePreferences {
    schema_version: u32,
    automatic_check: bool,
    ignored_version: Option<String>,
    last_checked_at: Option<String>,
    #[serde(default)]
    last_check_succeeded: bool,
}

impl Default for UpdatePreferences {
    fn default() -> Self {
        Self {
            schema_version: 1,
            automatic_check: true,
            ignored_version: None,
            last_checked_at: None,
            last_check_succeeded: false,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct UpdateStatus {
    current_version: String,
    automatic_check: bool,
    ignored_version: Option<String>,
    last_checked_at: Option<String>,
    busy: Option<&'static str>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AvailableUpdate {
    token: String,
    version: String,
    notes: String,
    published_at: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CheckResult {
    status: &'static str,
    current_version: String,
    update: Option<AvailableUpdate>,
    checked_at: Option<String>,
    ignored_version: Option<String>,
}

#[derive(Clone)]
struct PendingUpdate {
    info: AvailableUpdate,
    metadata: ReleaseMetadata,
    created: Instant,
}

#[derive(Clone)]
struct VerifiedDownload {
    token: String,
    metadata: ReleaseMetadata,
    path: PathBuf,
    created: Instant,
}

#[derive(Default)]
struct Runtime {
    busy: Option<(&'static str, Uuid)>,
    last_attempt: Option<Instant>,
    last_result: Option<&'static str>,
    pending: Option<PendingUpdate>,
    downloaded: Option<VerifiedDownload>,
}

#[derive(Default)]
pub(super) struct AndroidUpdateState {
    runtime: Mutex<Runtime>,
}

impl AndroidUpdateState {
    fn lock(&self) -> Result<MutexGuard<'_, Runtime>, CommandError> {
        self.runtime
            .lock()
            .map_err(|_| error("update.lock", "更新状态暂不可用，请重新打开软件后重试。"))
    }
}

struct BusyGuard {
    app: tauri::AppHandle,
    id: Uuid,
}

impl Drop for BusyGuard {
    fn drop(&mut self) {
        if let Ok(mut runtime) = self.app.state::<AndroidUpdateState>().runtime.lock() {
            if runtime.busy.is_some_and(|(_, id)| id == self.id) {
                runtime.busy = None;
            }
        }
    }
}

fn settings_path(root: &Path) -> Result<PathBuf, CommandError> {
    let path = root.join("updates").join("android-preferences.json");
    security::reject_symlink_components(&path)
        .map_err(|_| error("update.settings_path", "更新设置目录不可用。"))?;
    Ok(path)
}

fn read_preferences(root: &Path) -> Result<UpdatePreferences, CommandError> {
    let path = settings_path(root)?;
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(UpdatePreferences::default())
        }
        Err(_) => return Err(error("update.settings_read", "无法读取本机更新设置。")),
    };
    if bytes.len() > METADATA_MAX_BYTES {
        return Err(error(
            "update.settings_invalid",
            "本机更新设置无效，请检查本地数据目录。",
        ));
    }
    let preferences: UpdatePreferences = serde_json::from_slice(&bytes).map_err(|_| {
        error(
            "update.settings_invalid",
            "本机更新设置无效，请检查本地数据目录。",
        )
    })?;
    if preferences.schema_version != 1
        || preferences
            .ignored_version
            .as_ref()
            .is_some_and(|version| canonical_version(version).is_err())
        || preferences
            .last_checked_at
            .as_ref()
            .is_some_and(|at| DateTime::parse_from_rfc3339(at).is_err())
    {
        return Err(error(
            "update.settings_invalid",
            "本机更新设置无效，请检查本地数据目录。",
        ));
    }
    Ok(preferences)
}

fn write_preferences(root: &Path, preferences: &UpdatePreferences) -> Result<(), CommandError> {
    let destination = settings_path(root)?;
    let parent = destination.parent().expect("update settings have parent");
    fs::create_dir_all(parent).map_err(|_| {
        error(
            "update.settings_write",
            "无法保存更新设置，原设置保持不变。",
        )
    })?;
    let temporary = parent.join(format!(".android-preferences-{}.tmp", Uuid::new_v4()));
    let result = (|| -> std::io::Result<()> {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        file.write_all(&serde_json::to_vec_pretty(preferences).map_err(std::io::Error::other)?)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, &destination)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
        return Err(error(
            "update.settings_write",
            "无法保存更新设置，原设置保持不变。",
        ));
    }
    Ok(())
}

fn canonical_version(value: &str) -> Result<String, CommandError> {
    if value.len() > 80 {
        return Err(error("update.version", "更新版本号无效。"));
    }
    Version::parse(value.strip_prefix('v').unwrap_or(value))
        .map(|version| version.to_string())
        .map_err(|_| error("update.version", "更新版本号无效。"))
}

fn automatic_recent(preferences: &UpdatePreferences, now: DateTime<Utc>) -> bool {
    preferences
        .last_checked_at
        .as_ref()
        .and_then(|at| DateTime::parse_from_rfc3339(at).ok())
        .and_then(|at| now.signed_duration_since(at).to_std().ok())
        .is_some_and(|elapsed| {
            elapsed
                < if preferences.last_check_succeeded {
                    AUTOMATIC_INTERVAL
                } else {
                    OFFLINE_INTERVAL
                }
        })
}

fn update_status(
    current: String,
    preferences: UpdatePreferences,
    runtime: &Runtime,
) -> UpdateStatus {
    UpdateStatus {
        current_version: current,
        automatic_check: preferences.automatic_check,
        ignored_version: preferences.ignored_version,
        last_checked_at: preferences.last_checked_at,
        busy: runtime.busy.map(|(phase, _)| phase),
    }
}

fn check_result(
    status: &'static str,
    current: &str,
    preferences: &UpdatePreferences,
    update: Option<AvailableUpdate>,
) -> CheckResult {
    CheckResult {
        status,
        current_version: current.to_string(),
        update,
        checked_at: preferences.last_checked_at.clone(),
        ignored_version: preferences.ignored_version.clone(),
    }
}

fn available_result(
    pending: &PendingUpdate,
    current: &str,
    preferences: &UpdatePreferences,
    manual: bool,
) -> CheckResult {
    if !manual && preferences.ignored_version.as_deref() == Some(&pending.info.version) {
        check_result("ignored", current, preferences, None)
    } else {
        check_result(
            "available",
            current,
            preferences,
            Some(pending.info.clone()),
        )
    }
}

fn token_valid(expected: &str, actual: &str, created: Instant) -> bool {
    Uuid::parse_str(actual).is_ok() && expected == actual && created.elapsed() <= TOKEN_LIFETIME
}

fn digest_matches(digest: &[u8], expected: &str) -> bool {
    if expected.len() != digest.len() * 2 {
        return false;
    }
    expected
        .as_bytes()
        .chunks_exact(2)
        .zip(digest.iter())
        .all(|(pair, actual)| {
            let high = hex_nibble(pair[0]);
            let low = hex_nibble(pair[1]);
            high.zip(low)
                .is_some_and(|(high, low)| ((high << 4) | low) as u8 == *actual)
        })
}

fn hex_nibble(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn validate_metadata(metadata: &ReleaseMetadata, current: &str) -> Result<bool, CommandError> {
    let newer = release_is_newer(current, &metadata.version)?;
    if metadata.published_at.len() > 120
        || DateTime::parse_from_rfc3339(&metadata.published_at).is_err()
    {
        return Err(error("update.metadata", "更新说明格式无效，已停止更新。"));
    }
    if metadata.url.len() > 512
        || !metadata.url.starts_with("/downloads/")
        || !metadata.url.ends_with(".apk")
        || metadata.url.contains(['%', '?', '#'])
        || metadata.url.contains("..")
        || metadata.url.chars().any(char::is_control)
    {
        return Err(error(
            "update.untrusted_source",
            "更新包地址不在指定发布站点，已停止更新。",
        ));
    }
    if metadata.size == 0
        || metadata.size > APK_MAX_BYTES
        || metadata.sha256.len() != 64
        || !metadata.sha256.chars().all(|c| c.is_ascii_hexdigit())
    {
        return Err(error("update.metadata", "更新包校验信息无效，已停止更新。"));
    }
    if metadata.abi != SUPPORTED_ABI
        || metadata.min_sdk_version < 24
        || metadata.min_sdk_version > 99
        || metadata.version_code == 0
        || metadata.package_name != PACKAGE_NAME
        || !metadata
            .certificate_sha256
            .eq_ignore_ascii_case(PINNED_CERTIFICATE_SHA256)
        || metadata.notes.len() > 64
        || metadata
            .notes
            .iter()
            .any(|note| note.len() > 4000 || note.chars().any(char::is_control))
    {
        return Err(error("update.metadata", "更新包身份信息无效，已停止更新。"));
    }
    Ok(newer)
}

fn update_info(metadata: &ReleaseMetadata) -> AvailableUpdate {
    AvailableUpdate {
        token: Uuid::new_v4().to_string(),
        version: metadata.version.clone(),
        notes: metadata.notes.join("\n"),
        published_at: Some(metadata.published_at.clone()),
    }
}

fn http_client() -> Result<reqwest::Client, CommandError> {
    mobile::ensure_tls_ready()?;
    // reqwest is built with rustls-no-provider on mobile so the application
    // chooses the bundled ring provider explicitly. Without this initialization
    // the Android update path can stall or fail before a request is sent even
    // though the manifest contains INTERNET permission.
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .https_only(true)
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|_| error("update.config", "无法初始化安全更新连接。"))
}

async fn fetch_metadata() -> Result<ReleaseMetadata, CommandError> {
    let client = http_client()?;
    let response = client
        .get(RELEASE_ENDPOINT)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|_| {
            error(
                "update.unavailable",
                "暂时无法连接更新服务，请稍后再试。日记仍可正常离线使用。",
            )
        })?;
    if !response.status().is_success() {
        return Err(error(
            "update.unavailable",
            "暂时无法连接更新服务，请稍后再试。日记仍可正常离线使用。",
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length > METADATA_MAX_BYTES as u64)
    {
        return Err(error("update.metadata", "更新信息过大，已停止更新。"));
    }
    let mut response = response;
    let mut bytes = Vec::with_capacity(METADATA_MAX_BYTES.min(4096));
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| error("update.metadata", "更新信息读取失败，请稍后重试。"))?
    {
        if bytes.len().saturating_add(chunk.len()) > METADATA_MAX_BYTES {
            return Err(error("update.metadata", "更新信息过大，已停止更新。"));
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice::<ReleaseMetadata>(&bytes)
        .map_err(|_| error("update.metadata", "更新信息格式无效，已停止更新。"))
}

fn apk_cache_path(app: &tauri::AppHandle, token: &str) -> Result<PathBuf, CommandError> {
    let root = app
        .path()
        .app_cache_dir()
        .map_err(|_| error("update.cache", "手机更新暂存目录不可用。"))?;
    // Android exposes its private cache through OS-managed aliases. Resolve
    // only that trusted root, as we already do for data and shared attachments;
    // links beneath it must still be rejected before writing an APK.
    let root = crate::mobile_files::canonical_app_root(&root).map_err(|_| {
        error(
            "update.cache_root",
            "无法访问手机更新缓存，请重新打开软件后重试。",
        )
    })?;
    let path = root.join("android-updates").join(format!("{token}.apk"));
    security::reject_symlink_components(&path)
        .map_err(|_| error("update.cache_path", "手机更新缓存路径无效，已停止下载。"))?;
    Ok(path)
}

fn progress(
    app: &tauri::AppHandle,
    phase: &'static str,
    version: &str,
    downloaded: u64,
    total: Option<u64>,
) {
    let _ = app.emit(
        PROGRESS_EVENT,
        serde_json::json!({
            "phase": phase,
            "version": version,
            "downloadedBytes": downloaded,
            "totalBytes": total,
        }),
    );
}

async fn download_apk(
    app: &tauri::AppHandle,
    metadata: &ReleaseMetadata,
) -> Result<PathBuf, CommandError> {
    let url = format!("https://{RELEASE_HOST}{}", metadata.url);
    let parsed = Url::parse(&url)
        .map_err(|_| error("update.untrusted_source", "更新包地址无效，已停止更新。"))?;
    if parsed.scheme() != "https"
        || parsed.host_str() != Some(RELEASE_HOST)
        || parsed.port_or_known_default() != Some(443)
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(error(
            "update.untrusted_source",
            "更新包地址不在指定发布站点，已停止更新。",
        ));
    }
    let token = Uuid::new_v4().to_string();
    let destination = apk_cache_path(app, &token)?;
    let parent = destination.parent().expect("APK cache has parent");
    fs::create_dir_all(parent).map_err(|_| error("update.cache", "手机更新暂存目录不可用。"))?;
    let client = http_client()?;
    let response = client
        .get(parsed)
        // The tiny manifest and a complete APK cannot share a one-minute
        // total deadline. Keep stalled reads bounded, but allow a slow,
        // continuously progressing phone download to finish.
        .timeout(Duration::from_secs(20 * 60))
        .header("Accept", "application/vnd.android.package-archive")
        .send()
        .await
        .map_err(|_| {
            error(
                "update.download",
                "更新下载失败，日记没有改动。请稍后重试。",
            )
        })?;
    if !response.status().is_success() {
        return Err(error(
            "update.download",
            "更新下载失败，日记没有改动。请稍后重试。",
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length > APK_MAX_BYTES)
    {
        return Err(error("update.size", "更新安装包大小异常，已停止更新。"));
    }
    let partial = destination.with_extension("part");
    let result = async {
        let mut response = response;
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&partial)
            .map_err(|_| error("update.cache", "手机更新暂存空间不可用。"))?;
        let mut hasher = Sha256::new();
        let mut total = 0_u64;
        progress(
            app,
            "downloading",
            &metadata.version,
            0,
            Some(metadata.size),
        );
        while let Some(chunk) = response.chunk().await.map_err(|_| {
            error(
                "update.download",
                "更新下载中断，日记没有改动。请稍后重试。",
            )
        })? {
            total = total.saturating_add(chunk.len() as u64);
            if total > APK_MAX_BYTES || total > metadata.size {
                return Err(error("update.size", "更新安装包大小异常，已停止更新。"));
            }
            hasher.update(&chunk);
            file.write_all(&chunk)
                .map_err(|_| error("update.cache", "更新暂存空间写入失败。"))?;
            progress(
                app,
                "downloading",
                &metadata.version,
                total,
                Some(metadata.size),
            );
        }
        file.sync_all()
            .map_err(|_| error("update.cache", "更新暂存文件无法保存。"))?;
        if total != metadata.size || !digest_matches(&hasher.finalize(), &metadata.sha256) {
            return Err(error("update.verify", "更新包校验失败，已停止安装。"));
        }
        fs::rename(&partial, &destination)
            .map_err(|_| error("update.cache", "更新暂存文件无法完成。"))?;
        progress(app, "verifying", &metadata.version, total, Some(total));
        Ok::<_, CommandError>(destination.clone())
    }
    .await;
    if result.is_err() {
        let _ = fs::remove_file(&partial);
        let _ = fs::remove_file(&destination);
    }
    result
}

fn verify_cached_apk(
    app: &tauri::AppHandle,
    download: &VerifiedDownload,
) -> Result<(), CommandError> {
    let expected = apk_cache_path(app, "verified-cache")?;
    if download.path.parent() != expected.parent()
        || security::reject_symlink_components(&download.path).is_err()
    {
        return Err(error(
            "update.cache_path",
            "手机更新缓存路径无效，已停止安装。",
        ));
    }
    let (size, hash) = security::sha256_file(&download.path)
        .map_err(|_| error("update.not_verified", "更新缓存已不可用，请重新下载。"))?;
    if size != download.metadata.size || hash != download.metadata.sha256 {
        return Err(error(
            "update.package_invalid",
            "更新包校验失败，请重新下载。",
        ));
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PreferencesRequest {
    automatic_check: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CheckRequest {
    manual: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct IgnoreRequest {
    version: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct DownloadRequest {
    token: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct InstallRequest {
    download_token: String,
    frontend_flushed: bool,
}

#[tauri::command]
pub(super) fn android_updater_status(
    app: tauri::AppHandle,
    data: State<'_, AppState>,
    updates: State<'_, AndroidUpdateState>,
) -> Result<UpdateStatus, CommandError> {
    let runtime = updates.lock()?;
    Ok(update_status(
        app.package_info().version.to_string(),
        read_preferences(&data.root)?,
        &runtime,
    ))
}

#[tauri::command]
pub(super) fn android_updater_preferences(
    app: tauri::AppHandle,
    data: State<'_, AppState>,
    updates: State<'_, AndroidUpdateState>,
    request: PreferencesRequest,
) -> Result<UpdateStatus, CommandError> {
    let runtime = updates.lock()?;
    let mut preferences = read_preferences(&data.root)?;
    preferences.automatic_check = request.automatic_check;
    write_preferences(&data.root, &preferences)?;
    Ok(update_status(
        app.package_info().version.to_string(),
        preferences,
        &runtime,
    ))
}

#[tauri::command]
pub(super) fn android_updater_ignore(
    app: tauri::AppHandle,
    data: State<'_, AppState>,
    updates: State<'_, AndroidUpdateState>,
    request: IgnoreRequest,
) -> Result<UpdateStatus, CommandError> {
    let mut runtime = updates.lock()?;
    if runtime.busy.is_some() {
        return Err(error("update.busy", "正在处理更新，请稍后再试。"));
    }
    let version = canonical_version(&request.version)?;
    if !runtime
        .pending
        .as_ref()
        .is_some_and(|pending| pending.info.version == version)
    {
        return Err(error("update.stale", "更新信息已失效，请重新检查更新。"));
    }
    let mut preferences = read_preferences(&data.root)?;
    preferences.ignored_version = Some(version);
    write_preferences(&data.root, &preferences)?;
    runtime.downloaded = None;
    Ok(update_status(
        app.package_info().version.to_string(),
        preferences,
        &runtime,
    ))
}

#[tauri::command]
pub(super) async fn android_updater_check(
    app: tauri::AppHandle,
    data: State<'_, AppState>,
    updates: State<'_, AndroidUpdateState>,
    request: CheckRequest,
) -> Result<CheckResult, CommandError> {
    let current = app.package_info().version.to_string();
    let id = Uuid::new_v4();
    {
        let mut runtime = updates.lock()?;
        let mut preferences = read_preferences(&data.root)?;
        if runtime.busy.is_some() {
            return Ok(check_result("busy", &current, &preferences, None));
        }
        if !request.manual && !preferences.automatic_check {
            return Ok(check_result("disabled", &current, &preferences, None));
        }
        let recent = if request.manual {
            runtime
                .last_attempt
                .is_some_and(|attempt| attempt.elapsed() < MANUAL_INTERVAL)
        } else {
            automatic_recent(&preferences, Utc::now())
        };
        if recent {
            if let Some(pending) = runtime
                .pending
                .as_ref()
                .filter(|pending| pending.created.elapsed() <= TOKEN_LIFETIME)
            {
                return Ok(available_result(
                    pending,
                    &current,
                    &preferences,
                    request.manual,
                ));
            }
            return Ok(check_result(
                recent_result_status(runtime.last_result, preferences.last_check_succeeded),
                &current,
                &preferences,
                None,
            ));
        }
        preferences.last_checked_at = Some(Utc::now().to_rfc3339());
        preferences.last_check_succeeded = false;
        write_preferences(&data.root, &preferences)?;
        runtime.last_attempt = Some(Instant::now());
        runtime.pending = None;
        runtime.downloaded = None;
        runtime.last_result = None;
        runtime.busy = Some(("checking", id));
    }
    let _busy = BusyGuard {
        app: app.clone(),
        id,
    };
    let fetched = fetch_metadata().await.and_then(|metadata| {
        let newer = validate_metadata(&metadata, &current)?;
        Ok((metadata, newer))
    });
    let mut runtime = updates.lock()?;
    let mut preferences = read_preferences(&data.root)?;
    match fetched {
        Ok((metadata, newer)) => {
            preferences.last_check_succeeded = true;
            write_preferences(&data.root, &preferences)?;
            if !newer {
                runtime.last_result = Some("upToDate");
                return Ok(check_result("upToDate", &current, &preferences, None));
            }
            let pending = PendingUpdate {
                info: update_info(&metadata),
                metadata,
                created: Instant::now(),
            };
            let result = available_result(&pending, &current, &preferences, request.manual);
            runtime.pending = Some(pending);
            runtime.last_result = Some("available");
            Ok(result)
        }
        Err(_error) if !request.manual => {
            runtime.last_result = Some("offline");
            Ok(check_result("offline", &current, &preferences, None))
        }
        Err(error) => {
            runtime.last_result = Some("offline");
            Err(error)
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DownloadResult {
    download_token: String,
    version: String,
}

#[tauri::command]
pub(super) async fn android_updater_download(
    app: tauri::AppHandle,
    updates: State<'_, AndroidUpdateState>,
    request: DownloadRequest,
) -> Result<DownloadResult, CommandError> {
    let id = Uuid::new_v4();
    let (metadata, cached) = {
        let mut runtime = updates.lock()?;
        if runtime.busy.is_some() {
            return Err(error("update.busy", "正在处理更新，请稍后再试。"));
        }
        let pending = runtime
            .pending
            .as_ref()
            .filter(|pending| token_valid(&pending.info.token, &request.token, pending.created))
            .ok_or_else(|| error("update.stale", "更新信息已失效，请重新检查更新。"))?;
        let metadata = pending.metadata.clone();
        require_newer_release(&app.package_info().version.to_string(), &metadata.version)?;
        let cached = runtime
            .downloaded
            .as_ref()
            .filter(|download| {
                download.created.elapsed() <= TOKEN_LIFETIME
                    && download.metadata.version == metadata.version
                    && download.metadata.sha256 == metadata.sha256
                    && download.metadata.size == metadata.size
            })
            .cloned();
        runtime.busy = Some(("downloading", id));
        (metadata, cached)
    };
    let _busy = BusyGuard {
        app: app.clone(),
        id,
    };
    // A declined installation permission must not cost another full
    // download. Rehash the app-private file before reusing its opaque token.
    if let Some(cached) = cached.filter(|download| verify_cached_apk(&app, download).is_ok()) {
        progress(
            &app,
            "ready",
            &metadata.version,
            metadata.size,
            Some(metadata.size),
        );
        return Ok(DownloadResult {
            download_token: cached.token,
            version: metadata.version,
        });
    }
    updates.lock()?.downloaded = None;
    let path = download_apk(&app, &metadata).await?;
    let result = DownloadResult {
        download_token: Uuid::new_v4().to_string(),
        version: metadata.version.clone(),
    };
    updates.lock()?.downloaded = Some(VerifiedDownload {
        token: result.download_token.clone(),
        metadata,
        path,
        created: Instant::now(),
    });
    Ok(result)
}

#[tauri::command]
pub(super) async fn android_updater_install(
    app: tauri::AppHandle,
    updates: State<'_, AndroidUpdateState>,
    request: InstallRequest,
) -> Result<serde_json::Value, CommandError> {
    if !request.frontend_flushed {
        return Err(error("update.unsaved", "请先完成日记保存，再安装更新。"));
    }
    let id = Uuid::new_v4();
    let verified = {
        let mut runtime = updates.lock()?;
        if runtime.busy.is_some() {
            return Err(error("update.busy", "正在处理更新，请稍后再试。"));
        }
        let verified = runtime
            .downloaded
            .as_ref()
            .filter(|download| {
                token_valid(&download.token, &request.download_token, download.created)
            })
            .ok_or_else(|| {
                error(
                    "update.not_verified",
                    "没有已通过校验的更新，请重新检查并下载。",
                )
            })?
            .clone();
        require_newer_release(
            &app.package_info().version.to_string(),
            &verified.metadata.version,
        )?;
        runtime.busy = Some(("installing", id));
        verified
    };
    let guard = BusyGuard {
        app: app.clone(),
        id,
    };
    progress(
        &app,
        "installing",
        &verified.metadata.version,
        verified.metadata.size,
        Some(verified.metadata.size),
    );
    verify_cached_apk(&app, &verified)?;
    let path = verified.path.to_string_lossy();
    let result = mobile::install_apk(
        &app,
        tauri_plugin_life_mobile::InstallApkRequest {
            path: &path,
            package_name: &verified.metadata.package_name,
            version_name: &verified.metadata.version,
            version_code: verified.metadata.version_code,
            certificate_sha256: &verified.metadata.certificate_sha256,
            sha256: &verified.metadata.sha256,
            size: verified.metadata.size,
        },
    );
    if result.is_ok() {
        // The Android package installer reads the content URI after this
        // command returns, when the user confirms the install. Keep the
        // verified cache file alive; deleting it here can leave the system
        // confirmation screen with a broken URI. The cache is intentionally
        // retained until a later release-maintenance pass can prove that the
        // system installer no longer needs this URI.
        updates.lock()?.downloaded = None;
    }
    drop(guard);
    result.map(|()| serde_json::json!({ "installerOpened": true }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn metadata() -> ReleaseMetadata {
        ReleaseMetadata {
            version: "0.2.5".into(),
            published_at: "2026-10-05T00:00:00Z".into(),
            url: "/downloads/life-timeline_0.2.5_aarch64_release.apk".into(),
            size: 42,
            sha256: "a".repeat(64),
            notes: vec!["notes".into()],
            abi: SUPPORTED_ABI.into(),
            min_sdk_version: 24,
            version_code: 20006,
            package_name: PACKAGE_NAME.into(),
            certificate_sha256: PINNED_CERTIFICATE_SHA256.into(),
        }
    }

    #[test]
    fn metadata_accepts_pinned_same_origin_release() {
        assert!(validate_metadata(&metadata(), "0.2.4").unwrap());
        assert!(!validate_metadata(&metadata(), "0.2.5").unwrap());
        assert!(!validate_metadata(&metadata(), "0.2.6").unwrap());
    }

    #[test]
    fn metadata_rejects_untrusted_url_or_certificate() {
        let mut value = metadata();
        value.url = "https://evil.invalid/x.apk".into();
        for current in ["0.2.4", "0.2.5", "0.2.6"] {
            assert!(validate_metadata(&value, current).is_err());
        }
        let mut value = metadata();
        value.certificate_sha256 = "b".repeat(64);
        for current in ["0.2.4", "0.2.5", "0.2.6"] {
            assert!(validate_metadata(&value, current).is_err());
        }
    }

    #[test]
    fn metadata_requires_a_clean_stable_version() {
        let mut value = metadata();
        value.version = "0.3.0-beta.1".into();
        assert!(validate_metadata(&value, "0.2.4").is_err());
    }
}
