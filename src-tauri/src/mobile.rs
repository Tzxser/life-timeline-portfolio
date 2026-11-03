//! Android-only IPC adapters. File-picker URIs are resolved by the official
//! Tauri filesystem plugin; the existing archive/SQLite rules remain intact.
use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use mobile_files::{safe_document_name, TransferBatch, MAX_SELECTED_BYTES};
use std::sync::OnceLock;
use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};
use zeroize::Zeroizing;

static MOBILE_APP: OnceLock<tauri::AppHandle> = OnceLock::new();
static TLS_READY: OnceLock<bool> = OnceLock::new();

pub fn initialize(app: tauri::AppHandle) -> Result<(), std::io::Error> {
    // Tauri/tao has installed a process-global Application context before this
    // setup callback. The platform verifier needs its own JNI globals; merely
    // linking reqwest does not initialize them on Android.
    TLS_READY.get_or_init(|| initialize_tls().is_ok());
    MOBILE_APP
        .set(app)
        .map_err(|_| std::io::Error::other("手机服务重复初始化。"))
}

fn initialize_tls() -> Result<(), jni::errors::Error> {
    use jni::{objects::JObject, refs::Cast, JavaVM};

    let context = ndk_context::android_context();
    // Safety: tao owns both references for the application process lifetime.
    // Borrow its global context and make a new local reference for this frame;
    // never take ownership of or delete tao's global reference.
    let vm = unsafe { JavaVM::from_raw(context.vm().cast()) };
    let raw_context = context.context().cast();
    vm.attach_current_thread(|env| {
        let borrowed = unsafe { Cast::<JObject>::from_raw_unchecked(&raw_context) };
        let local = env.new_local_ref(&*borrowed)?;
        rustls_platform_verifier::android::init_with_env(env, local)
    })
}

pub fn ensure_tls_ready() -> Result<(), CommandError> {
    if TLS_READY.get() == Some(&true) {
        Ok(())
    } else {
        Err(error(
            "ai.api_transport",
            "手机安全连接尚未准备好，请重新打开软件后重试。日记仍可离线使用。",
        ))
    }
}

fn error(code: &str, message: &str) -> CommandError {
    CommandError {
        code: code.into(),
        message: message.into(),
    }
}

pub fn protect_api_key(bytes: &[u8], decrypt: bool) -> Result<Zeroizing<Vec<u8>>, CommandError> {
    let app = MOBILE_APP
        .get()
        .ok_or_else(|| error("ai.api_platform", "手机密钥服务尚未准备好。"))?;
    let input = Zeroizing::new(STANDARD.encode(bytes));
    let output = Zeroizing::new(
        app.state::<tauri_plugin_life_mobile::MobileSecrets<tauri::Wry>>()
            .protect(&input, decrypt)
            .map_err(|_| {
                error(
                    "ai.api_key_unavailable",
                    "手机密钥保护不可用，请重新输入并保存 API 密钥。",
                )
            })?,
    );
    STANDARD
        .decode(output.as_bytes())
        .map(Zeroizing::new)
        .map_err(|_| error("ai.api_key_unavailable", "手机密钥保护返回了无效结果。"))
}

pub fn install_apk(
    app: &tauri::AppHandle,
    request: tauri_plugin_life_mobile::InstallApkRequest<'_>,
) -> Result<(), CommandError> {
    use tauri_plugin_life_mobile::InstallApkError;
    app.state::<tauri_plugin_life_mobile::MobileSecrets<tauri::Wry>>()
        .install_apk(request)
        .map_err(|failure| match failure {
            InstallApkError::PermissionRequired => error(
                "update.install_permission",
                "尚未允许 life-timeline 安装未知应用。你可以稍后重试，已下载的更新包会保留。",
            ),
            InstallApkError::SettingsUnavailable => error(
                "update.install_settings",
                "无法打开安装授权设置。请在系统设置中找到 life-timeline，允许安装未知应用后重试。",
            ),
            InstallApkError::PackageInvalid => error(
                "update.package_invalid",
                "更新包校验失败，已停止安装。请重新检查并下载更新。",
            ),
            InstallApkError::InstallerUnavailable => error(
                "update.installer_unavailable",
                "无法打开系统安装器。请从官方下载页下载 APK，使用系统文件管理器覆盖安装。",
            ),
            InstallApkError::InstallBlocked => error(
                "update.install_blocked",
                "系统阻止了安装界面。请检查本应用的安装授权或设备管理限制后重试。",
            ),
            InstallApkError::BridgeUnavailable => error(
                "update.install",
                "无法连接系统安装服务，请重新打开软件后重试。",
            ),
        })
}

fn document_uri(raw: &str) -> Result<FilePath, CommandError> {
    let uri = url::Url::parse(raw)
        .map_err(|_| error("mobile.document", "请选择手机文件管理器中的文件。"))?;
    if uri.scheme() != "content"
        || uri.host_str().is_none()
        || !uri.username().is_empty()
        || uri.password().is_some()
        || uri.fragment().is_some()
        || raw.len() > 8192
        || raw.chars().any(char::is_control)
    {
        return Err(error("mobile.document", "手机文件地址无效，请重新选择。"));
    }
    Ok(FilePath::Url(uri))
}

pub struct PreparedFiles {
    pub paths: Vec<String>,
    batch: Option<TransferBatch>,
}

impl PreparedFiles {
    pub fn preserve(&mut self) {
        if let Some(batch) = &mut self.batch {
            batch.preserve();
        }
    }
}

/// Keep sibling names together so Markdown/HTML image references still find
/// attachments explicitly selected in the same operation. Android grants no
/// access to unselected siblings; complete source folders can be sent as ZIP.
pub fn prepare_sources(
    app: &tauri::AppHandle,
    root: &Path,
    paths: Vec<String>,
) -> Result<PreparedFiles, CommandError> {
    if paths.is_empty() || paths.len() > 256 {
        return Err(error("mobile.selection", "请选择 1 至 256 个文件。"));
    }
    if !paths.iter().any(|path| path.starts_with("content:")) {
        return Ok(PreparedFiles { paths, batch: None });
    }
    let batch = TransferBatch::new(root).map_err(command_error)?;
    let mut prepared = Vec::new();
    let mut selected = HashSet::new();
    let mut remaining = MAX_SELECTED_BYTES;
    for path in paths {
        if !selected.insert(path.clone()) {
            continue;
        }
        if !path.starts_with("content:") {
            prepared.push(path);
            continue;
        }
        let uri = document_uri(&path)?;
        let name = app.path().file_name(&path).ok_or_else(|| {
            error(
                "mobile.document_name",
                "无法读取所选文件的名称，请重新选择。",
            )
        })?;
        let name = safe_document_name(&name).map_err(command_error)?;
        let destination = batch.directory.join(name);
        if destination.exists() {
            return Err(error(
                "mobile.duplicate_name",
                "所选文件存在同名文件，请分别导入，或保留文件夹结构后压缩为 ZIP。",
            ));
        }
        let mut source = app
            .fs()
            .open(uri, OpenOptions::new().read(true).to_owned())
            .map_err(|_| {
                error(
                    "mobile.document_read",
                    "无法读取所选文件，请确认已下载到手机并允许本次访问。",
                )
            })?;
        let mut target = security::create_new_file(&destination)
            .map_err(|_| error("mobile.staging", "手机暂存空间不可用。"))?;
        let count = security::copy_limited(&mut source, &mut target, remaining).map_err(|_| {
            error(
                "mobile.document_size",
                "所选文件无法完整读取，或本次文件总大小超过 512 MB。请分批导入。",
            )
        })?;
        remaining = remaining.saturating_sub(count);
        target
            .sync_all()
            .map_err(|_| error("mobile.staging", "手机暂存文件保存失败，请检查剩余空间。"))?;
        prepared.push(destination.to_string_lossy().into_owned());
    }
    Ok(PreparedFiles {
        paths: prepared,
        batch: Some(batch),
    })
}

pub fn write_document(
    app: &tauri::AppHandle,
    source: &Path,
    target: &str,
) -> Result<(), CommandError> {
    let uri = document_uri(target)?;
    let source_size = fs::metadata(source).map_err(command_error)?.len();
    let mut source = File::open(source).map_err(command_error)?;
    let mut target = app
        .fs()
        .open(
            uri,
            OpenOptions::new().write(true).truncate(true).to_owned(),
        )
        .map_err(|_| {
            error(
                "mobile.document_write",
                "无法写入所选位置，请重新选择手机文件夹。",
            )
        })?;
    let count = std::io::copy(&mut source, &mut target).map_err(|_| {
        error(
            "mobile.document_write",
            "文件未能完整保存，请检查手机剩余空间后重新导出。",
        )
    })?;
    // Some Android document providers expose pipes and do not support fsync;
    // flushing/closing the owned descriptor is the provider's completion API.
    target
        .flush()
        .map_err(|_| error("mobile.document_write", "手机文件保存失败，请重新导出。"))?;
    if let Err(cause) = target.sync_all() {
        // Content providers are allowed to return a pipe (fsync -> EINVAL).
        // Real storage errors must still prevent a successful export result.
        if cause.raw_os_error() != Some(22) && cause.kind() != std::io::ErrorKind::Unsupported {
            return Err(error(
                "mobile.document_write",
                "手机文件写入失败，请检查剩余空间后重新导出。",
            ));
        }
    }
    if count != source_size {
        return Err(error(
            "mobile.document_write",
            "手机文件保存不完整，请重新导出。",
        ));
    }
    Ok(())
}

#[tauri::command]
pub(super) async fn backup_scan(
    app: tauri::AppHandle,
    request: BackupScanRequest,
) -> Result<BackupScanResult, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let mut prepared = prepare_sources(&app, &state.root, vec![request.archive_path])?;
        let result = super::backup_scan(
            BackupScanRequest {
                archive_path: prepared.paths[0].clone(),
            },
            state,
        )?;
        prepared.preserve();
        Ok(result)
    })
    .await
    .map_err(|_| error("mobile.task", "文件检查被中断，请重试。"))?
}

#[tauri::command]
pub(super) async fn backup_export(
    app: tauri::AppHandle,
    request: BackupExportRequest,
) -> Result<BackupExportResult, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        if !request.destination_path.starts_with("content:") {
            return super::backup_export(request, state);
        }
        document_uri(&request.destination_path)?;
        let batch = TransferBatch::new(&state.root).map_err(command_error)?;
        let source = batch.directory.join("life-timeline-backup.zip");
        let mut result = export_archive(&state, &source, false)?;
        write_document(&app, &source, &request.destination_path)?;
        result.archive_path = request.destination_path;
        Ok(result)
    })
    .await
    .map_err(|_| error("mobile.task", "备份导出被中断，请重试。"))?
}

#[tauri::command]
pub(super) async fn backup_restore(
    app: tauri::AppHandle,
    request: BackupRestoreRequest,
) -> Result<BackupRestoreResult, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        super::backup_restore(request, app.state::<AppState>())
    })
    .await
    .map_err(|_| error("mobile.task", "备份恢复被中断，请重试。"))?
}

#[tauri::command]
pub(super) async fn attachment_open(
    app: tauri::AppHandle,
    request: AttachmentIdRequest,
) -> Result<Value, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let record = lock_repo(&state)?
            .attachment(&request.id)
            .map_err(command_error)?
            .ok_or_else(|| error("attachment.missing", "附件不存在。"))?;
        let relative = record
            .meta
            .relative_path
            .as_deref()
            .ok_or_else(|| error("attachment.path", "附件缺少本地文件。"))?;
        let source =
            attachment_service::controlled_path(&state.root, relative).map_err(command_error)?;
        let (size, hash) = sha256_file(&source)?;
        if size != record.meta.byte_size || record.meta.sha256.as_deref() != Some(hash.as_str()) {
            return Err(error("attachment.hash", "附件校验失败，请恢复备份后重试。"));
        }
        let name = safe_document_name(&record.meta.name).map_err(command_error)?;
        let cache = app
            .path()
            .app_cache_dir()
            .map_err(|_| error("mobile.cache", "手机缓存目录不可用。"))?;
        // Resolve the OS-provided cache alias before checking our own children,
        // just as AppState does for the Android data directory.
        let cache =
            fs::canonicalize(cache).map_err(|_| error("mobile.cache", "手机缓存目录不可用。"))?;
        let root = cache.join("shared-attachments");
        security::reject_symlink_components(&root)
            .map_err(|_| error("mobile.cache", "附件缓存目录无效。"))?;
        fs::create_dir_all(&root).map_err(command_error)?;
        let root = fs::canonicalize(root).map_err(command_error)?;
        let target = root.join(&hash).join(name);
        security::reject_symlink_components(&target)
            .map_err(|_| error("mobile.cache", "附件缓存路径无效。"))?;
        if !target.exists() {
            let mut total = 0u64;
            let mut files = 0usize;
            for directory in fs::read_dir(&root).map_err(command_error)? {
                let directory = directory.map_err(command_error)?;
                if !directory.file_type().map_err(command_error)?.is_dir() {
                    continue;
                }
                for file in fs::read_dir(directory.path()).map_err(command_error)? {
                    let file = file.map_err(command_error)?;
                    if file.file_type().map_err(command_error)?.is_file() {
                        total = total.saturating_add(file.metadata().map_err(command_error)?.len());
                        files += 1;
                    }
                }
            }
            if files >= 128 || total.saturating_add(size) > MAX_SELECTED_BYTES {
                return Err(error(
                    "mobile.cache_full",
                    "附件查看缓存已满，请先保存附件到手机后打开，或在系统设置中清理本应用缓存。",
                ));
            }
            fs::create_dir_all(target.parent().unwrap()).map_err(command_error)?;
            let temporary = target.with_extension(format!("tmp-{}", Uuid::new_v4()));
            let _temporary_guard = StagingGuard {
                path: temporary.clone(),
                preserve: false,
            };
            fs::copy(&source, &temporary).map_err(command_error)?;
            let (copied_size, copied_hash) = sha256_file(&temporary)?;
            if copied_size != size || copied_hash != hash {
                return Err(error("attachment.hash", "附件缓存校验失败。"));
            }
            fs::rename(temporary, &target).map_err(command_error)?;
        } else if sha256_file(&target)?.1 != hash {
            return Err(error(
                "attachment.hash",
                "附件缓存校验失败，请清理本应用缓存后重试。",
            ));
        }
        app.state::<tauri_plugin_life_mobile::MobileSecrets<tauri::Wry>>()
            .open_attachment(&target.to_string_lossy(), &record.meta.mime_type)
            .map_err(|_| {
                error(
                    "attachment.viewer",
                    "手机未能打开这个附件，请安装能查看此文件的应用，或使用“保存附件”。",
                )
            })?;
        Ok(json!({ "ok": true }))
    })
    .await
    .map_err(|_| error("mobile.task", "附件打开被中断，请重试。"))?
}

#[tauri::command]
pub(super) async fn save_attachment_as(
    app: tauri::AppHandle,
    request: SaveAttachmentAsRequest,
) -> Result<Value, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        if !request.target_path.starts_with("content:") {
            return super::save_attachment_as(request, state);
        }
        let record = lock_repo(&state)?
            .attachment(&request.id)
            .map_err(command_error)?
            .ok_or_else(|| error("attachment.missing", "附件不存在。"))?;
        let relative = record
            .meta
            .relative_path
            .as_deref()
            .ok_or_else(|| error("attachment.path", "附件缺少本地文件。"))?;
        let source =
            attachment_service::controlled_path(&state.root, relative).map_err(command_error)?;
        let (size, hash) = sha256_file(&source)?;
        if size != record.meta.byte_size || record.meta.sha256.as_deref() != Some(&hash) {
            return Err(error("attachment.hash", "附件校验失败，请恢复备份后重试。"));
        }
        write_document(&app, &source, &request.target_path)?;
        Ok(json!({ "ok": true, "path": request.target_path }))
    })
    .await
    .map_err(|_| error("mobile.task", "附件导出被中断，请重试。"))?
}
