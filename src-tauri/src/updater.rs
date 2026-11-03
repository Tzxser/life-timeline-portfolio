//! A deliberately narrow boundary around Tauri's signed Windows updater.
//! The renderer receives opaque, expiring tokens rather than download URLs,
//! installer paths, public keys or configurable request headers. Update settings
//! live outside SQLite and are never included in diary exports or backups.
use crate::models::CommandError;
use crate::{archive_document, command_error, export_archive_document, security, AppState};
use chrono::{DateTime, Utc};
use semver::Version;
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use url::Url;
use uuid::Uuid;

const RELEASE_HOST: &str = "life-timeline.xinciqq.top";
const RELEASE_ENDPOINT: &str = "https://life-timeline.xinciqq.top/updates/latest.json";
const AUTOMATIC_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const OFFLINE_INTERVAL: Duration = Duration::from_secs(60);
const MANUAL_INTERVAL: Duration = Duration::from_secs(10);
const TOKEN_LIFETIME: Duration = Duration::from_secs(60 * 60);
const SETTINGS_MAX_BYTES: u64 = 16 * 1024;
const INSTALLER_MAX_BYTES: usize = 1024 * 1024 * 1024;
const PROGRESS_EVENT: &str = "life-timeline://update-progress";

fn error(code: &str, message: &str) -> CommandError {
    CommandError {
        code: code.into(),
        message: message.into(),
    }
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
    update: Update,
    created: Instant,
}

#[derive(Clone)]
struct VerifiedDownload {
    token: String,
    update: Update,
    bytes: Arc<Vec<u8>>,
    created: Instant,
}

#[derive(Default)]
struct UpdateRuntime {
    busy: Option<(&'static str, Uuid)>,
    last_attempt: Option<Instant>,
    last_result: Option<&'static str>,
    pending: Option<PendingUpdate>,
    downloaded: Option<VerifiedDownload>,
}

#[derive(Default)]
pub(super) struct UpdateState {
    runtime: Mutex<UpdateRuntime>,
}

impl UpdateState {
    fn lock(&self) -> Result<MutexGuard<'_, UpdateRuntime>, CommandError> {
        self.runtime
            .lock()
            .map_err(|_| error("update.lock", "更新状态暂不可用，请重新打开软件后重试。"))
    }

    pub(super) fn is_installing(&self) -> bool {
        self.runtime
            .lock()
            .map(|runtime| runtime.busy.is_some_and(|(phase, _)| phase == "installing"))
            .unwrap_or(false)
    }
}

/// Also clears busy after any early error, cancelled task or panic unwind.
struct BusyGuard {
    app: tauri::AppHandle,
    id: Uuid,
}

impl Drop for BusyGuard {
    fn drop(&mut self) {
        let state = self.app.state::<UpdateState>();
        if let Ok(mut runtime) = state.runtime.lock() {
            if runtime.busy.is_some_and(|(_, id)| id == self.id) {
                runtime.busy = None;
            }
        };
    }
}

fn settings_path(root: &Path) -> Result<PathBuf, CommandError> {
    let path = root.join("updates").join("preferences.json");
    security::reject_symlink_components(&path)
        .map_err(|_| error("update.settings_path", "更新设置目录不可用。"))?;
    Ok(path)
}

fn read_preferences(root: &Path) -> Result<UpdatePreferences, CommandError> {
    let path = settings_path(root)?;
    let file = match File::open(&path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(UpdatePreferences::default())
        }
        Err(_) => return Err(error("update.settings_read", "无法读取本机更新设置。")),
    };
    let mut bytes = Vec::new();
    file.take(SETTINGS_MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| error("update.settings_read", "无法读取本机更新设置。"))?;
    if bytes.len() as u64 > SETTINGS_MAX_BYTES {
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
    let temporary = parent.join(format!(".preferences-{}.tmp", Uuid::new_v4()));
    let bytes = serde_json::to_vec_pretty(preferences)
        .map_err(|_| error("update.settings_write", "无法保存更新设置。"))?;
    let result = (|| -> std::io::Result<()> {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        atomic_replace(&temporary, &destination)
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

#[cfg(windows)]
fn atomic_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let from: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    // The two NUL-terminated UTF-16 buffers outlive this synchronous Win32 call.
    if unsafe {
        MoveFileExW(
            from.as_ptr(),
            to.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn atomic_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

fn canonical_version(value: &str) -> Result<String, CommandError> {
    if value.len() > 80 {
        return Err(error("update.version", "更新版本号无效。"));
    }
    Version::parse(value.strip_prefix('v').unwrap_or(value))
        .map(|version| version.to_string())
        .map_err(|_| error("update.version", "更新版本号无效。"))
}

fn strictly_newer(current: &str, announced: &str) -> bool {
    match (Version::parse(current), Version::parse(announced)) {
        (Ok(current), Ok(announced)) => {
            announced.cmp_precedence(&current).is_gt() && announced.pre.is_empty()
        }
        _ => false,
    }
}

fn validate_download_url(url: &Url) -> Result<(), CommandError> {
    if url.scheme() != "https"
        || url.host_str() != Some(RELEASE_HOST)
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.path().starts_with("/downloads/")
        || !url.path().ends_with(".exe")
        || url.path().contains('%')
    {
        return Err(error(
            "update.untrusted_source",
            "更新包地址不在指定发布站点，已停止更新。",
        ));
    }
    Ok(())
}

fn validate_release(update: &Update, current: &str) -> Result<(), CommandError> {
    if !strictly_newer(current, &update.version) || update.current_version != current {
        return Err(error(
            "update.version",
            "更新版本无效或不是更新的正式版本。",
        ));
    }
    validate_download_url(&update.download_url)?;
    if update.signature.trim().is_empty() || update.signature.len() > 16 * 1024 {
        return Err(error(
            "update.signature",
            "更新包缺少有效签名，已停止更新。",
        ));
    }
    Ok(())
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

fn recent_result_status(runtime: &UpdateRuntime, preferences: &UpdatePreferences) -> &'static str {
    match runtime.last_result {
        Some("upToDate") => "upToDate",
        Some("offline") => "offline",
        // Preserve the one-minute retry policy after an offline process was
        // restarted before its cooldown elapsed. Calling this throttled would
        // cause the renderer to assume a successful six-hour check instead.
        None if !preferences.last_check_succeeded => "offline",
        _ => "throttled",
    }
}

fn update_status(
    current: String,
    preferences: UpdatePreferences,
    runtime: &UpdateRuntime,
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
        current_version: current.into(),
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
    available_info_result(&pending.info, current, preferences, manual)
}

fn available_info_result(
    info: &AvailableUpdate,
    current: &str,
    preferences: &UpdatePreferences,
    manual: bool,
) -> CheckResult {
    if !manual && preferences.ignored_version.as_deref() == Some(&info.version) {
        check_result("ignored", current, preferences, None)
    } else {
        check_result("available", current, preferences, Some(info.clone()))
    }
}

fn token_valid(expected: &str, actual: &str, created: Instant) -> bool {
    Uuid::parse_str(actual).is_ok() && expected == actual && created.elapsed() <= TOKEN_LIFETIME
}

fn configured_updater(
    app: &tauri::AppHandle,
) -> Result<tauri_plugin_updater::Updater, CommandError> {
    // Do not accept insecure test switches even in a debug build. A test fixture
    // should mock these commands or exercise the pure validators below.
    let config = app
        .config()
        .plugins
        .0
        .get("updater")
        .ok_or_else(|| error("update.config", "此版本尚未配置发布签名。"))?;
    let parsed: tauri_plugin_updater::Config = serde_json::from_value(config.clone())
        .map_err(|_| error("update.config", "发布签名配置无效。"))?;
    if parsed.pubkey.trim().is_empty()
        || parsed.dangerous_insecure_transport_protocol
        || parsed.dangerous_accept_invalid_certs
        || parsed.dangerous_accept_invalid_hostnames
        || !parsed.require_signed_version
        || parsed.allow_downgrades
    {
        return Err(error("update.config", "发布签名或安全更新配置无效。"));
    }
    let endpoint =
        Url::parse(RELEASE_ENDPOINT).map_err(|_| error("update.config", "发布地址配置无效。"))?;
    app.updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|_| error("update.config", "发布地址配置无效。"))?
        .version_comparator(|current, release| {
            release.version.cmp_precedence(&current).is_gt() && release.version.pre.is_empty()
        })
        .timeout(Duration::from_secs(15))
        // A no-redirect policy also rejects a same-origin response that would
        // later redirect elsewhere. No proxy or machine network setting changes.
        .configure_client(|client| {
            client
                .redirect(reqwest::redirect::Policy::none())
                .https_only(true)
                .connect_timeout(Duration::from_secs(10))
                .read_timeout(Duration::from_secs(30))
        })
        // Tauri's default hook calls cleanup_before_exit *before* ShellExecute.
        // Leave the window usable if launching the verified installer fails.
        // The repository is already checkpointed and backed up at this point.
        .on_before_exit(|| {})
        .build()
        .map_err(|_| error("update.config", "无法初始化安全更新。"))
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
pub(super) fn updater_status(
    app: tauri::AppHandle,
    data: State<'_, AppState>,
    updates: State<'_, UpdateState>,
) -> Result<UpdateStatus, CommandError> {
    let runtime = updates.lock()?;
    Ok(update_status(
        app.package_info().version.to_string(),
        read_preferences(&data.root)?,
        &runtime,
    ))
}

#[tauri::command]
pub(super) fn updater_preferences(
    app: tauri::AppHandle,
    data: State<'_, AppState>,
    updates: State<'_, UpdateState>,
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
pub(super) fn updater_ignore(
    app: tauri::AppHandle,
    data: State<'_, AppState>,
    updates: State<'_, UpdateState>,
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
pub(super) async fn updater_check(
    app: tauri::AppHandle,
    request: CheckRequest,
) -> Result<CheckResult, CommandError> {
    let current = app.package_info().version.to_string();
    let id = Uuid::new_v4();
    {
        let data = app.state::<AppState>();
        let updates = app.state::<UpdateState>();
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
                .is_some_and(|at| at.elapsed() < MANUAL_INTERVAL)
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
            let cached = recent_result_status(&runtime, &preferences);
            return Ok(check_result(cached, &current, &preferences, None));
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
    let checked = configured_updater(&app)?.check().await;
    let data = app.state::<AppState>();
    let updates = app.state::<UpdateState>();
    let mut runtime = updates.lock()?;
    let mut preferences = read_preferences(&data.root)?;
    match checked {
        Ok(Some(mut update)) => {
            validate_release(&update, &current)?;
            preferences.last_check_succeeded = true;
            write_preferences(&data.root, &preferences)?;
            update.timeout = Some(Duration::from_secs(15 * 60));
            let published_at = update
                .raw_json
                .get("pub_date")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned);
            let pending = PendingUpdate {
                info: AvailableUpdate {
                    token: Uuid::new_v4().to_string(),
                    version: update.version.clone(),
                    notes: update
                        .body
                        .as_deref()
                        .unwrap_or("")
                        .chars()
                        .take(12_000)
                        .collect(),
                    published_at,
                },
                update,
                created: Instant::now(),
            };
            let result = available_result(&pending, &current, &preferences, request.manual);
            runtime.pending = Some(pending);
            runtime.last_result = Some("available");
            Ok(result)
        }
        Ok(None) => {
            preferences.last_check_succeeded = true;
            write_preferences(&data.root, &preferences)?;
            runtime.last_result = Some("upToDate");
            Ok(check_result("upToDate", &current, &preferences, None))
        }
        // Automatic checks remain quiet for offline, TLS and server failures;
        // no raw response bodies or URLs are reflected into user-facing errors.
        Err(_) if !request.manual => {
            runtime.last_result = Some("offline");
            Ok(check_result("offline", &current, &preferences, None))
        }
        Err(_) => {
            runtime.last_result = Some("offline");
            Err(error(
                "update.unavailable",
                "暂时无法连接更新服务，请稍后再试。日记仍可正常离线使用。",
            ))
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateProgress {
    phase: &'static str,
    version: String,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
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
        UpdateProgress {
            phase,
            version: version.into(),
            downloaded_bytes: downloaded,
            total_bytes: total,
        },
    );
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DownloadResult {
    download_token: String,
    version: String,
}

#[tauri::command]
pub(super) async fn updater_download(
    app: tauri::AppHandle,
    request: DownloadRequest,
) -> Result<DownloadResult, CommandError> {
    let id = Uuid::new_v4();
    let update = {
        let updates = app.state::<UpdateState>();
        let mut runtime = updates.lock()?;
        if runtime.busy.is_some() {
            return Err(error("update.busy", "正在处理更新，请稍后再试。"));
        }
        let pending = runtime
            .pending
            .as_ref()
            .filter(|pending| token_valid(&pending.info.token, &request.token, pending.created))
            .ok_or_else(|| error("update.stale", "更新信息已失效，请重新检查更新。"))?;
        validate_release(&pending.update, &app.package_info().version.to_string())?;
        let update = pending.update.clone();
        runtime.downloaded = None;
        runtime.busy = Some(("downloading", id));
        update
    };
    let _busy = BusyGuard {
        app: app.clone(),
        id,
    };
    let mut downloaded = 0_u64;
    let mut last_emit = Instant::now();
    progress(&app, "downloading", &update.version, 0, None);
    // Only the official verifier's returned bytes can enter VerifiedDownload.
    // Its verification includes the signed version as required in configuration.
    let bytes = update
        .download(
            |chunk, total| {
                downloaded = downloaded.saturating_add(chunk as u64);
                if last_emit.elapsed() >= Duration::from_millis(120) {
                    progress(&app, "downloading", &update.version, downloaded, total);
                    last_emit = Instant::now();
                }
            },
            || {
                progress(&app, "verifying", &update.version, 0, None);
            },
        )
        .await
        .map_err(|_| {
            error(
                "update.download",
                "更新下载或签名校验失败。软件没有关闭，请稍后重新检查更新。",
            )
        })?;
    if bytes.is_empty() || bytes.len() > INSTALLER_MAX_BYTES {
        return Err(error("update.size", "更新安装包大小异常，已停止更新。"));
    }
    let result = DownloadResult {
        download_token: Uuid::new_v4().to_string(),
        version: update.version.clone(),
    };
    let updates = app.state::<UpdateState>();
    updates.lock()?.downloaded = Some(VerifiedDownload {
        token: result.download_token.clone(),
        update,
        bytes: Arc::new(bytes),
        created: Instant::now(),
    });
    progress(&app, "ready", &result.version, downloaded, Some(downloaded));
    Ok(result)
}

/// The database lock stays held through the final checkpoint, creation and
/// verification of the recovery ZIP, and installer launch. Failed backups never
/// reach the launch callback. No private settings or API keys enter the ZIP.
fn with_install_backup<T>(
    state: &AppState,
    version: &str,
    install: impl FnOnce() -> Result<T, CommandError>,
) -> Result<T, CommandError> {
    let version = canonical_version(version)?;
    let mut repository = state
        .repository
        .lock()
        .map_err(|_| error("update.backup", "更新前无法锁定日记资料库，已取消安装。"))?;
    repository.checkpoint_full().map_err(command_error)?;
    let life = archive_document(&repository)?;
    let destination = state.root.join("backups").join(format!(
        "before-update-{}-{}-{}.zip",
        version,
        Utc::now().format("%Y%m%dT%H%M%SZ"),
        Uuid::new_v4()
    ));
    export_archive_document(&state.root, &destination, false, &life, false).map_err(|_| {
        error(
            "update.backup",
            "更新前备份未成功，已取消安装。请检查可用磁盘空间与附件后重试。",
        )
    })?;
    install()
}

#[tauri::command]
pub(super) async fn updater_install(
    app: tauri::AppHandle,
    request: InstallRequest,
) -> Result<serde_json::Value, CommandError> {
    if !request.frontend_flushed {
        return Err(error("update.unsaved", "请先完成日记保存，再安装更新。"));
    }
    if !cfg!(windows) {
        return Err(error("update.platform", "此更新安装功能仅适用于 Windows。"));
    }
    let id = Uuid::new_v4();
    let verified = {
        let updates = app.state::<UpdateState>();
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
                    "没有已通过签名校验的更新，请重新检查并下载。",
                )
            })?
            .clone();
        validate_release(&verified.update, &app.package_info().version.to_string())?;
        runtime.busy = Some(("installing", id));
        verified
    };
    let guard = BusyGuard {
        app: app.clone(),
        id,
    };
    tauri::async_runtime::spawn_blocking(move || {
        let _busy = guard;
        let data = app.state::<AppState>();
        let version = &verified.update.version;
        progress(
            &app,
            "backingUp",
            version,
            verified.bytes.len() as u64,
            Some(verified.bytes.len() as u64),
        );
        with_install_backup(&data, version, || {
            progress(
                &app,
                "installing",
                version,
                verified.bytes.len() as u64,
                Some(verified.bytes.len() as u64),
            );
            verified
                .update
                .install(verified.bytes.as_slice())
                .map_err(|_| {
                    error(
                        "update.install",
                        "无法启动更新安装程序，日记窗口已保留。请稍后重试，或从下载页面手动安装。",
                    )
                })?;
            Ok(serde_json::json!({ "installed": true }))
        })
    })
    .await
    .map_err(|_| {
        error(
            "update.install",
            "更新安装未完成，软件没有主动退出。请保留日记并稍后重试。",
        )
    })?
}

#[cfg(test)]
#[path = "updater_tests.rs"]
mod tests;
