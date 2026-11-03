use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{Read, Seek, Write};
use std::path::{Path, PathBuf};
#[cfg(target_os = "windows")]
use std::process::Command;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use tauri::{Emitter, Manager, State, WindowEvent};
use uuid::Uuid;
use zip::{write::SimpleFileOptions, ZipArchive, ZipWriter};

mod ai_api;
mod ai_commands;
mod ai_import;
mod ai_import_sources;
#[cfg(any(target_os = "android", test))]
mod android_update_policy;
#[cfg(target_os = "android")]
mod android_updater;
mod attachments;
mod diary_transfer;
mod migrations;
#[cfg(target_os = "android")]
mod mobile;
mod mobile_files;
mod models;
mod phone_transfer;
mod repository;
mod schedules;
#[cfg(test)]
mod schedules_tests;
mod security;
#[cfg(desktop)]
mod updater;

use attachments as attachment_service;
use models::{
    AttachmentIdRequest, CommandError, ImportAttachmentRequest, LifeEvent, LifeStage,
    SaveAttachmentAsRequest, StorageError,
};
use repository::{RegisteredAttachment, Repository};

pub struct AppState {
    root: PathBuf,
    repository: Mutex<Repository>,
    allow_close: AtomicBool,
    scanned_backups: Mutex<HashMap<String, PathBuf>>,
    scanned_diaries: Mutex<HashMap<String, diary_transfer::ScannedDiary>>,
    #[cfg(not(target_os = "android"))]
    phone_transfer: phone_transfer::TransferStore,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RestoreRecoveryMarker {
    staging_path: String,
    materialized_paths: Vec<String>,
}

fn recovery_marker_path(root: &Path, restore_id: &str) -> PathBuf {
    root.join("recovery")
        .join(format!("restore-{restore_id}.json"))
}

fn auto_backup_failure_path(root: &Path) -> PathBuf {
    root.join("recovery").join("last-auto-backup-error.json")
}

fn auto_backup_success_path(root: &Path) -> PathBuf {
    root.join("recovery").join("last-auto-backup-success.json")
}

fn read_auto_backup_failure(root: &Path) -> Option<Value> {
    let path = auto_backup_failure_path(root);
    let bytes = fs::read(path).ok()?;
    if bytes.len() > 64 * 1024 {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}

fn record_auto_backup_failure(root: &Path, error: &CommandError) -> Result<(), std::io::Error> {
    let recovery = root.join("recovery");
    fs::create_dir_all(&recovery)?;
    let payload = json!({
        "code": &error.code,
        "message": &error.message,
        "at": Utc::now().to_rfc3339(),
    });
    let bytes = serde_json::to_vec(&payload).map_err(std::io::Error::other)?;
    let destination = auto_backup_failure_path(root);
    let temporary = destination.with_extension(format!("tmp-{}", Uuid::new_v4()));
    fs::write(&temporary, bytes)?;
    let _ = fs::remove_file(&destination);
    if let Err(error) = publish_file(&temporary, &destination) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    Ok(())
}

fn clear_auto_backup_failure(root: &Path) {
    let _ = fs::remove_file(auto_backup_failure_path(root));
}

fn record_auto_backup_success(root: &Path, at: &str) -> Result<(), std::io::Error> {
    let recovery = root.join("recovery");
    fs::create_dir_all(&recovery)?;
    let payload = json!({ "at": at });
    let bytes = serde_json::to_vec(&payload).map_err(std::io::Error::other)?;
    let destination = auto_backup_success_path(root);
    let temporary = destination.with_extension(format!("tmp-{}", Uuid::new_v4()));
    fs::write(&temporary, bytes)?;
    let _ = fs::remove_file(&destination);
    if let Err(error) = publish_file(&temporary, &destination) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    Ok(())
}

fn read_auto_backup_success(root: &Path) -> Option<String> {
    let bytes = fs::read(auto_backup_success_path(root)).ok()?;
    if bytes.len() > 16 * 1024 {
        return None;
    }
    serde_json::from_slice::<Value>(&bytes)
        .ok()?
        .get("at")?
        .as_str()
        .map(ToOwned::to_owned)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupStatusResult {
    status: String,
    checked_at: String,
    last_success_at: Option<String>,
    error: Option<String>,
}

fn current_backup_status(root: &Path) -> BackupStatusResult {
    let checked_at = Utc::now().to_rfc3339();
    let last_success_at = read_auto_backup_success(root);
    if let Some(failure) = read_auto_backup_failure(root) {
        return BackupStatusResult {
            status: "error".into(),
            checked_at,
            last_success_at,
            error: failure
                .get("message")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
                .or_else(|| Some("自动备份失败。".into())),
        };
    }
    BackupStatusResult {
        status: if last_success_at.is_some() {
            "success".into()
        } else {
            "running".into()
        },
        checked_at,
        last_success_at,
        error: None,
    }
}

fn write_recovery_marker(path: &Path, marker: &RestoreRecoveryMarker) -> Result<(), CommandError> {
    let bytes = serde_json::to_vec(marker).map_err(|error| CommandError {
        code: "backup.recovery".into(),
        message: error.to_string(),
    })?;
    let mut marker = File::create(path).map_err(|error| CommandError {
        code: "backup.recovery".into(),
        message: error.to_string(),
    })?;
    marker
        .write_all(&bytes)
        .and_then(|()| marker.sync_all())
        .map_err(|error| CommandError {
            code: "backup.recovery".into(),
            message: error.to_string(),
        })
}

/// Publish a completed file even on Windows file-system providers that report
/// a cross-device error for same-directory renames (for example redirected
/// AppData locations). The copy fallback only runs after the atomic rename
/// fails and removes the temporary source only after the destination exists.
fn publish_file(source: &Path, destination: &Path) -> Result<(), std::io::Error> {
    match fs::rename(source, destination) {
        Ok(()) => Ok(()),
        Err(error) if error.raw_os_error() == Some(17) => {
            fs::copy(source, destination)?;
            fs::remove_file(source)?;
            Ok(())
        }
        Err(error) => Err(error),
    }
}

fn cleanup_materialized_files(paths: &[PathBuf]) -> bool {
    let mut cleaned = true;
    for path in paths {
        if let Err(error) = fs::remove_file(path) {
            if error.kind() != std::io::ErrorKind::NotFound {
                cleaned = false;
            }
        }
    }
    cleaned
}

/// Clean up a restore that was interrupted before the SQLite replacement was
/// committed.  The marker is written before any staged attachment is moved
/// into the live tree.  Files still referenced by the current database are
/// retained, so a crash after the database transaction but before marker
/// deletion remains safe as well.
fn recover_pending_restores(root: &Path, repository: &Repository) -> Result<(), StorageError> {
    recover_pending_restores_with_remover(root, repository, |path, directory| {
        if directory {
            fs::remove_dir_all(path)
        } else {
            fs::remove_file(path)
        }
    })
}

fn recover_pending_restores_with_remover(
    root: &Path,
    repository: &Repository,
    mut remove: impl FnMut(&Path, bool) -> std::io::Result<()>,
) -> Result<(), StorageError> {
    let mut cleanup = |path: &Path, directory: bool| match remove(path, directory) {
        Ok(()) => true,
        Err(error) => error.kind() == std::io::ErrorKind::NotFound,
    };
    let recovery = root.join("recovery");
    fs::create_dir_all(&recovery)?;
    let referenced_paths: HashSet<String> = repository
        .list_attachments()?
        .into_iter()
        .filter_map(|record| record.meta.relative_path)
        .map(|path| path.to_ascii_lowercase())
        .collect();

    for entry in fs::read_dir(&recovery)?.filter_map(Result::ok) {
        let metadata = match entry.file_type() {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        let file_name = entry.file_name().to_string_lossy().to_string();
        if !metadata.is_file()
            || !file_name.starts_with("restore-")
            || entry.path().extension().and_then(|value| value.to_str()) != Some("json")
        {
            continue;
        }
        let marker_bytes = match fs::read(entry.path()) {
            Ok(bytes) if bytes.len() <= 8 * 1024 * 1024 => bytes,
            _ => continue,
        };
        let marker: RestoreRecoveryMarker = match serde_json::from_slice(&marker_bytes) {
            Ok(marker) => marker,
            Err(_) => continue,
        };

        let mut complete = true;
        for relative in marker.materialized_paths {
            let Ok(normalized) = security::validate_archive_path(&relative, false) else {
                complete = false;
                continue;
            };
            if !normalized.starts_with("attachments/") {
                complete = false;
                continue;
            }
            if referenced_paths.contains(&normalized.to_ascii_lowercase()) {
                continue;
            }
            let Ok(path) = attachment_service::controlled_path(root, &normalized) else {
                complete = false;
                continue;
            };
            // Do not use is_file(): a permission error would look like an
            // absent file and discard the only record needed for a retry.
            complete &= cleanup(&path, false);
        }

        let staging_path = security::validate_archive_path(&marker.staging_path, false)
            .ok()
            .filter(|relative| {
                relative
                    .strip_prefix("staging/restore-")
                    .is_some_and(|name| !name.is_empty() && !name.contains('/'))
            })
            .and_then(|relative| security::safe_join(root, &relative).ok())
            .filter(|path| security::reject_symlink_components(path).is_ok());
        complete &= match staging_path {
            Some(path) => cleanup(&path, true),
            None => false,
        };
        if complete {
            // If a file is busy or inaccessible, preserve the durable marker
            // so the next launch retries only these same controlled paths.
            cleanup(&entry.path(), false);
        }
    }

    // A process can terminate while it is still populating staging, before a
    // marker is durable.  Restore staging directories are disposable and are
    // therefore safe to remove on the next launch.
    let staging = root.join("staging");
    for entry in fs::read_dir(staging)?.filter_map(Result::ok) {
        let file_name = entry.file_name().to_string_lossy().to_string();
        if !file_name.starts_with("restore-") {
            continue;
        }
        if entry.file_type().is_ok_and(|metadata| metadata.is_dir()) {
            let path = entry.path();
            if security::reject_symlink_components(&path).is_ok() {
                cleanup(&path, true);
            }
        }
    }
    Ok(())
}

impl AppState {
    fn open(root: PathBuf) -> Result<Self, StorageError> {
        fs::create_dir_all(&root)?;
        #[cfg(target_os = "android")]
        let root = mobile_files::canonical_app_root(&root)?;
        attachment_service::prepare_directories(&root)?;
        #[cfg(target_os = "android")]
        mobile_files::reset_transfer_directory(&root)?;
        let repository = Repository::open(&root)?;
        recover_pending_restores(&root, &repository)?;
        Ok(Self {
            root: root.clone(),
            repository: Mutex::new(repository),
            allow_close: AtomicBool::new(false),
            scanned_backups: Mutex::new(HashMap::new()),
            scanned_diaries: Mutex::new(HashMap::new()),
            #[cfg(not(target_os = "android"))]
            phone_transfer: phone_transfer::TransferStore::default(),
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FrontendSnapshot {
    #[serde(default)]
    schema_version: u32,
    events: Vec<LifeEvent>,
    stages: Vec<LifeStage>,
    #[serde(default)]
    revision: u64,
    #[serde(default)]
    meta: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FrontendLoadResult {
    snapshot: Value,
    revision: u64,
}

fn lock_repo<'a>(
    state: &'a State<'_, AppState>,
) -> Result<std::sync::MutexGuard<'a, Repository>, CommandError> {
    state.repository.lock().map_err(|_| CommandError {
        code: "storage.lock".into(),
        message: "本地资料库锁定失败".into(),
    })
}

fn command_error<E: Into<StorageError>>(error: E) -> CommandError {
    let storage_error: StorageError = error.into();
    storage_error.into()
}

#[tauri::command]
fn load_snapshot(state: State<'_, AppState>) -> Result<FrontendLoadResult, CommandError> {
    let repo = lock_repo(&state)?;
    let snapshot = repo.load_snapshot().map_err(command_error)?;
    let revision = repo.snapshot_revision().map_err(command_error)?;
    let meta = json!({ "preferences": snapshot.preferences, "attachments": snapshot.attachments, "schemaVersion": snapshot.meta.schema_version, "appVersion": snapshot.meta.app_version, "dataEpoch": snapshot.meta.data_epoch, "databaseId": snapshot.meta.database_id, "backupError": read_auto_backup_failure(&state.root) });
    Ok(FrontendLoadResult {
        snapshot: json!({ "schemaVersion": 1, "events": snapshot.events, "stages": snapshot.stages, "revision": revision, "meta": meta }),
        revision,
    })
}

#[tauri::command]
fn save_snapshot(
    snapshot: Value,
    revision: u64,
    state: State<'_, AppState>,
) -> Result<Value, CommandError> {
    let request: FrontendSnapshot =
        serde_json::from_value(snapshot).map_err(|error| CommandError {
            code: "validation.snapshot".into(),
            message: format!("资料库快照格式无效: {error}"),
        })?;
    if request.schema_version != 0 && request.schema_version != 1 {
        return Err(CommandError {
            code: "validation.version".into(),
            message: "不支持的资料库版本".into(),
        });
    }
    let preferences = request
        .meta
        .get("preferences")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let mut repo = lock_repo(&state)?;
    if let Some(expected_epoch) = request.meta.get("dataEpoch").and_then(Value::as_u64) {
        if expected_epoch != repo.data_epoch().map_err(command_error)? {
            return Err(CommandError {
                code: "storage.stale_epoch".into(),
                message: "资料库已完成导入或恢复，请重新载入后继续编辑。".into(),
            });
        }
    }
    let ack = repo
        .save_snapshot(
            &request.events,
            &request.stages,
            &preferences,
            revision.max(request.revision),
        )
        .map_err(command_error)?;
    Ok(json!({ "revision": ack.revision }))
}

#[tauri::command]
fn load_preferences(state: State<'_, AppState>) -> Result<Value, CommandError> {
    let repo = lock_repo(&state)?;
    Ok(repo.load_snapshot().map_err(command_error)?.preferences)
}

#[tauri::command]
fn save_preferences(preferences: Value, state: State<'_, AppState>) -> Result<Value, CommandError> {
    let mut repo = lock_repo(&state)?;
    let existing = repo.load_snapshot().map_err(command_error)?.preferences;
    let merged = match (existing, preferences) {
        (Value::Object(mut current), Value::Object(next)) => {
            current.extend(next);
            Value::Object(current)
        }
        (_, next) => next,
    };
    let ack = repo.save_preferences(&merged).map_err(command_error)?;
    Ok(json!({ "saved": true, "updatedAt": ack.updated_at }))
}

#[tauri::command]
fn flush_persistence(state: State<'_, AppState>) -> Result<Value, CommandError> {
    let mut repo = lock_repo(&state)?;
    let checkpointed = repo.checkpoint_full().map_err(command_error)?;
    let revision = repo.snapshot_revision().map_err(command_error)?;
    Ok(
        json!({ "revision": revision, "flushed": true, "checkpointed": checkpointed, "at": Utc::now().to_rfc3339() }),
    )
}

#[tauri::command]
fn import_attachment(
    request: ImportAttachmentRequest,
    state: State<'_, AppState>,
) -> Result<models::ImportAttachmentResponse, CommandError> {
    let mut repo = lock_repo(&state)?;
    attachment_service::import(&mut repo, &state.root, &request).map_err(command_error)
}

#[tauri::command]
fn list_attachments(
    state: State<'_, AppState>,
) -> Result<Vec<models::AttachmentMeta>, CommandError> {
    let repo = lock_repo(&state)?;
    attachment_service::list(&repo, &state.root).map_err(command_error)
}

#[tauri::command]
fn attachment_path(
    request: AttachmentIdRequest,
    state: State<'_, AppState>,
) -> Result<Option<Value>, CommandError> {
    let repo = lock_repo(&state)?;
    Ok(attachment_service::url(&repo, &state.root, &request.id).map_err(command_error)?.map(|(asset_url, relative_path)| json!({ "assetUrl": asset_url, "relativePath": relative_path })))
}

#[cfg_attr(not(target_os = "android"), tauri::command)]
fn save_attachment_as(
    request: SaveAttachmentAsRequest,
    state: State<'_, AppState>,
) -> Result<Value, CommandError> {
    let repo = lock_repo(&state)?;
    let path = attachment_service::save_as(&repo, &state.root, &request).map_err(command_error)?;
    Ok(json!({ "ok": true, "path": path }))
}

#[tauri::command]
fn confirm_close(state: State<'_, AppState>, window: tauri::Window) -> Result<(), CommandError> {
    state.allow_close.store(true, Ordering::SeqCst);
    if let Err(error) = window.close() {
        state.allow_close.store(false, Ordering::SeqCst);
        return Err(CommandError {
            code: "window.close".into(),
            message: error.to_string(),
        });
    }
    Ok(())
}

#[tauri::command]
fn cancel_close(state: State<'_, AppState>) -> Result<(), CommandError> {
    state.allow_close.store(false, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
fn open_data_dir(state: State<'_, AppState>) -> Result<Value, CommandError> {
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer.exe")
            .arg(&state.root)
            .spawn()
            .map_err(|error| CommandError {
                code: "storage.open_data_dir".into(),
                message: error.to_string(),
            })?;
    }
    Ok(json!({ "path": state.root.to_string_lossy() }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupExportRequest {
    destination_path: String,
    #[serde(default)]
    overwrite: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupExportResult {
    archive_path: String,
    archive_format_version: u32,
    schema_version: u32,
    entries: usize,
    byte_size: u64,
    sha256: String,
    exported_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupScanRequest {
    archive_path: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupScanCounts {
    events: usize,
    stages: usize,
    attachments: usize,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupScanResult {
    scan_token: String,
    archive_path: String,
    manifest: Value,
    counts: BackupScanCounts,
    archive_byte_size: u64,
    archive_sha256: String,
    diagnostics: Vec<Value>,
    can_restore: bool,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupRestoreRequest {
    archive_path: String,
    scan_token: String,
    confirmation: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupRestoreResult {
    restored_at: String,
    previous_library_backup_path: String,
    revision: u64,
    counts: BackupScanCounts,
}

struct StagingGuard {
    path: PathBuf,
    preserve: bool,
}

impl Drop for StagingGuard {
    fn drop(&mut self) {
        if !self.preserve {
            if self.path.is_dir() {
                let _ = fs::remove_dir_all(&self.path);
            } else {
                let _ = fs::remove_file(&self.path);
            }
        }
    }
}

fn validate_user_archive_path(raw: &str) -> Result<PathBuf, CommandError> {
    if raw.is_empty() || raw.contains('\0') || raw.chars().any(|character| character.is_control()) {
        return Err(CommandError {
            code: "security.path_denied".into(),
            message: "备份路径无效".into(),
        });
    }
    // Device/extended-length paths and alternate data streams are not valid
    // backup destinations for this app.  They can bypass the normal file
    // picker semantics and make a path appear to be a regular .zip while
    // writing somewhere else.
    let windows_path = raw.replace('/', "\\");
    if windows_path.starts_with("\\\\?\\") || windows_path.starts_with("\\\\.\\") {
        return Err(CommandError {
            code: "security.path_denied".into(),
            message: "备份路径不支持 Windows 设备路径".into(),
        });
    }
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return Err(CommandError {
            code: "security.path_denied".into(),
            message: "备份路径必须是绝对路径".into(),
        });
    }
    if path
        .file_name()
        .and_then(|name| name.to_str())
        .is_none_or(|name| {
            name.is_empty() || name.contains(':') || name.ends_with('.') || name.ends_with(' ')
        })
    {
        return Err(CommandError {
            code: "security.path_denied".into(),
            message: "备份文件名无效".into(),
        });
    }
    security::reject_symlink_components(&path).map_err(|error| CommandError {
        code: "security.path_denied".into(),
        message: error.to_string(),
    })?;
    Ok(path)
}

fn sha256_file(path: &Path) -> Result<(u64, String), CommandError> {
    let mut file = File::open(path).map_err(|e| CommandError {
        code: "storage.io".into(),
        message: e.to_string(),
    })?;
    let mut hasher = Sha256::new();
    let mut bytes = 0u64;
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|e| CommandError {
            code: "storage.io".into(),
            message: e.to_string(),
        })?;
        if count == 0 {
            break;
        }
        bytes += count as u64;
        hasher.update(&buffer[..count]);
    }
    Ok((bytes, format!("{:x}", hasher.finalize())))
}

fn archive_document(repo: &Repository) -> Result<Value, CommandError> {
    let snapshot = repo.load_snapshot().map_err(command_error)?;
    let mut attachments = Vec::with_capacity(snapshot.attachments.len());
    for record in snapshot.attachments {
        let meta = record.meta;
        let relative_path = meta.relative_path.ok_or_else(|| CommandError {
            code: "backup.missing_attachment_path".into(),
            message: "附件缺少受控归档路径".into(),
        })?;
        attachments.push(json!({
            "id": meta.id,
            "name": meta.name,
            "mimeType": meta.mime_type,
            "byteSize": meta.byte_size,
            "kind": meta.kind,
            "width": meta.width,
            "height": meta.height,
            "lastModified": meta.last_modified,
            "sha256": meta.sha256,
            "path": relative_path,
        }));
    }
    Ok(
        json!({ "schemaVersion": 1, "databaseId": snapshot.meta.database_id, "exportedAt": Utc::now().to_rfc3339(), "stages": snapshot.stages, "events": snapshot.events, "attachments": attachments, "preferences": snapshot.preferences }),
    )
}

fn write_zip_file<W: Write + Seek>(
    zip: &mut ZipWriter<W>,
    name: &str,
    bytes: &[u8],
) -> Result<(), CommandError> {
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    zip.start_file(name, options).map_err(|e| CommandError {
        code: "backup.zip".into(),
        message: e.to_string(),
    })?;
    zip.write_all(bytes).map_err(|e| CommandError {
        code: "backup.io".into(),
        message: e.to_string(),
    })
}

fn read_zip_entry_limited<R: Read>(entry: &mut R, max_bytes: u64) -> Result<Vec<u8>, CommandError> {
    let mut bytes = Vec::new();
    security::copy_limited(entry, &mut bytes, max_bytes).map_err(|error| CommandError {
        code: "backup.too_large".into(),
        message: error.to_string(),
    })?;
    Ok(bytes)
}

fn export_archive(
    state: &AppState,
    destination: &Path,
    overwrite: bool,
) -> Result<BackupExportResult, CommandError> {
    let mut repo = state.repository.lock().map_err(|_| CommandError {
        code: "storage.lock".into(),
        message: "本地资料库锁定失败".into(),
    })?;
    repo.checkpoint_full().map_err(command_error)?;
    let life = archive_document(&repo)?;
    export_archive_document(&state.root, destination, overwrite, &life, false)
}

/// Write either a complete backup or a purpose-tagged diary document while
/// the caller holds the repository lock. Attachment bytes are always verified
/// against the selected document before publishing the completed ZIP.
fn export_archive_document(
    root: &Path,
    destination: &Path,
    overwrite: bool,
    life: &Value,
    diary: bool,
) -> Result<BackupExportResult, CommandError> {
    if destination.exists() && !overwrite {
        return Err(CommandError {
            code: "backup.exists".into(),
            message: "目标备份已存在".into(),
        });
    }
    security::reject_symlink_components(destination).map_err(|error| CommandError {
        code: "security.path_denied".into(),
        message: error.to_string(),
    })?;
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|e| CommandError {
            code: "backup.io".into(),
            message: e.to_string(),
        })?;
    }
    let life_bytes = serde_json::to_vec_pretty(life).map_err(|e| CommandError {
        code: "backup.json".into(),
        message: e.to_string(),
    })?;
    let mut files = vec![
        json!({ "path": "life.json", "sha256": format!("{:x}", Sha256::digest(&life_bytes)), "byteSize": life_bytes.len() }),
    ];
    // Multiple logical attachment IDs may point at the same content-addressed
    // blob.  Keep every logical record in life.json, but emit each physical
    // path only once because ZIP central directories must not contain
    // duplicate names.
    let mut physical_files = HashMap::<String, (String, u64)>::new();
    let exported_at = Utc::now().to_rfc3339();
    let temp = destination.with_extension(format!("tmp-{}", Uuid::new_v4()));
    let mut temp_guard = StagingGuard {
        path: temp.clone(),
        preserve: false,
    };
    let file = File::create(&temp).map_err(|e| CommandError {
        code: "backup.io".into(),
        message: e.to_string(),
    })?;
    let mut zip = ZipWriter::new(file);
    write_zip_file(&mut zip, "life.json", &life_bytes)?;
    if let Some(attachments) = life["attachments"].as_array() {
        for attachment in attachments {
            let Some(relative) = attachment.get("path").and_then(Value::as_str) else {
                continue;
            };
            let source =
                attachment_service::controlled_path(root, relative).map_err(command_error)?;
            let bytes = fs::read(&source).map_err(|e| CommandError {
                code: "backup.io".into(),
                message: e.to_string(),
            })?;
            // The SQLite metadata and the bytes on disk must agree before a
            // backup is considered usable.  Without this check an external
            // file change could produce an archive whose manifest hashes the
            // tampered bytes while life.json still advertises the old hash;
            // restore would then fail much later and the exported backup
            // would not be a recoverable snapshot.
            let actual_size = bytes.len() as u64;
            let actual_hash = format!("{:x}", Sha256::digest(&bytes));
            let expected_size = attachment
                .get("byteSize")
                .and_then(Value::as_u64)
                .ok_or_else(|| CommandError {
                    code: "backup.attachment_metadata".into(),
                    message: "附件元数据缺少有效大小".into(),
                })?;
            let expected_hash = attachment
                .get("sha256")
                .and_then(Value::as_str)
                .map(str::to_ascii_lowercase)
                .filter(|value| {
                    value.len() == 64
                        && value.chars().all(|character| character.is_ascii_hexdigit())
                })
                .ok_or_else(|| CommandError {
                    code: "backup.attachment_metadata".into(),
                    message: "附件元数据缺少有效 hash".into(),
                })?;
            let archive_path = relative.replace('\\', "/");
            let physical_key = archive_path.to_ascii_lowercase();
            if actual_size != expected_size || actual_hash != expected_hash {
                return Err(CommandError {
                    code: "backup.attachment_corrupt".into(),
                    message: "附件文件与本地元数据校验不一致".into(),
                });
            }
            if let Some((known_hash, known_size)) = physical_files.get(&physical_key) {
                if known_hash != &expected_hash || *known_size != expected_size {
                    return Err(CommandError {
                        code: "backup.attachment_conflict".into(),
                        message: "同一物理附件路径对应了不同 hash 或大小".into(),
                    });
                }
                continue;
            }
            physical_files.insert(physical_key, (actual_hash.clone(), actual_size));
            files.push(
                json!({ "path": archive_path, "sha256": actual_hash, "byteSize": actual_size }),
            );
            write_zip_file(&mut zip, &archive_path, &bytes)?;
        }
    }
    // The manifest is written after all attachment entries so its hash list is complete.
    let mut manifest = json!({ "archiveFormatVersion": if diary { 2 } else { 1 }, "appVersion": models::APP_VERSION, "schemaVersion": 1, "databaseId": life["databaseId"], "exportedAt": exported_at, "files": files, "counts": { "events": life["events"].as_array().map_or(0, |v| v.len()), "stages": life["stages"].as_array().map_or(0, |v| v.len()), "attachments": life["attachments"].as_array().map_or(0, |v| v.len()) } });
    if diary {
        manifest["purpose"] = json!("diary-transfer");
        manifest["diaryFormatVersion"] = json!(1);
        manifest["diaryRange"] = life["diaryRange"].clone();
    }
    let manifest_bytes = serde_json::to_vec_pretty(&manifest).map_err(|e| CommandError {
        code: "backup.json".into(),
        message: e.to_string(),
    })?;
    write_zip_file(&mut zip, "manifest.json", &manifest_bytes)?;
    let completed = zip.finish().map_err(|e| CommandError {
        code: "backup.zip".into(),
        message: e.to_string(),
    })?;
    completed.sync_all().map_err(command_error)?;
    drop(completed);
    // Re-open the completed temporary archive before publishing it.  This
    // catches malformed ZIP structure, missing manifest entries, and any
    // hash/size mismatch while the output is still disposable.
    if let Err(error) = scan_zip_inner(&temp, diary) {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }
    if destination.exists() {
        fs::remove_file(destination).map_err(|e| CommandError {
            code: "backup.io".into(),
            message: e.to_string(),
        })?;
    }
    publish_file(&temp, destination).map_err(|e| CommandError {
        code: "backup.io".into(),
        message: e.to_string(),
    })?;
    temp_guard.preserve = true;
    let (byte_size, sha256) = sha256_file(destination)?;
    let entries = 2 + physical_files.len();
    Ok(BackupExportResult {
        archive_path: destination.to_string_lossy().into_owned(),
        archive_format_version: if diary { 2 } else { 1 },
        schema_version: 1,
        entries,
        byte_size,
        sha256,
        exported_at,
    })
}

fn run_daily_backup(state: &AppState) -> Result<(), CommandError> {
    let result = (|| {
        let backups = state.root.join("backups");
        fs::create_dir_all(&backups).map_err(|error| CommandError {
            code: "backup.io".into(),
            message: error.to_string(),
        })?;
        let destination = backups.join(format!("auto-{}.zip", Utc::now().format("%Y%m%d")));
        if !destination.exists() {
            let _ = export_archive(state, &destination, false)?;
        } else {
            // An existing daily archive may have been truncated or corrupted
            // after it was written. Validate it before pruning older copies or
            // recording a successful automatic backup.
            let _ = scan_zip(&destination)?;
        }
        let mut candidates = fs::read_dir(&backups)
            .map_err(|error| CommandError {
                code: "backup.io".into(),
                message: error.to_string(),
            })?
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
            .filter(|entry| {
                entry.file_name().to_string_lossy().starts_with("auto-")
                    && entry.path().extension().and_then(|value| value.to_str()) == Some("zip")
            })
            .collect::<Vec<_>>();
        candidates.sort_by_key(|entry| {
            entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .ok()
        });
        while candidates.len() > 14 {
            if let Some(entry) = candidates.first() {
                fs::remove_file(entry.path()).map_err(|error| CommandError {
                    code: "backup.io".into(),
                    message: error.to_string(),
                })?;
            }
            candidates.remove(0);
        }
        Ok(())
    })();
    match &result {
        Ok(()) => {
            clear_auto_backup_failure(&state.root);
            let _ = record_auto_backup_success(&state.root, &Utc::now().to_rfc3339());
        }
        Err(error) => {
            let _ = record_auto_backup_failure(&state.root, error);
            eprintln!(
                "life-timeline automatic backup failed [{}]: {}",
                error.code, error.message
            );
        }
    }
    result
}

#[tauri::command]
fn backup_status(state: State<'_, AppState>) -> Result<BackupStatusResult, CommandError> {
    Ok(current_backup_status(&state.root))
}

#[tauri::command]
fn backup_flush(state: State<'_, AppState>) -> Result<Value, CommandError> {
    flush_persistence(state)
}

#[cfg_attr(not(target_os = "android"), tauri::command)]
fn backup_export(
    request: BackupExportRequest,
    state: State<'_, AppState>,
) -> Result<BackupExportResult, CommandError> {
    let destination = validate_user_archive_path(&request.destination_path)?;
    export_archive(&state, &destination, request.overwrite)
}

fn validate_backup_attachment_meta(meta: &models::AttachmentMeta) -> Result<(), CommandError> {
    models::validate_identifier(&meta.id, "attachment.id").map_err(command_error)?;
    if meta.name.is_empty()
        || meta.name.len() > 1024
        || meta
            .name
            .chars()
            .any(|value| value.is_control() || value == '/' || value == '\\' || value == '\0')
    {
        return Err(CommandError {
            code: "backup.attachment_metadata".into(),
            message: "附件名称不合法".into(),
        });
    }
    if meta.mime_type.len() > 256 || meta.mime_type.chars().any(|value| value.is_control()) {
        return Err(CommandError {
            code: "backup.attachment_metadata".into(),
            message: "附件 MIME 类型不合法".into(),
        });
    }
    if meta.kind != "image" && meta.kind != "file" {
        return Err(CommandError {
            code: "backup.attachment_metadata".into(),
            message: "附件类型不合法".into(),
        });
    }
    if meta.kind == "image" && !meta.mime_type.to_ascii_lowercase().starts_with("image/") {
        return Err(CommandError {
            code: "backup.attachment_metadata".into(),
            message: "图片附件的 MIME 类型不合法".into(),
        });
    }
    if meta.byte_size == 0 || meta.byte_size > i64::MAX as u64 {
        return Err(CommandError {
            code: "backup.attachment_metadata".into(),
            message: "附件大小不合法".into(),
        });
    }
    let sha256 = meta.sha256.as_deref().filter(|value| {
        let lowercase = value.to_ascii_lowercase();
        value.len() == 64
            && value.chars().all(|character| character.is_ascii_hexdigit())
            && lowercase.as_str() == *value
    });
    if sha256.is_none() {
        return Err(CommandError {
            code: "backup.attachment_metadata".into(),
            message: "附件 hash 不合法".into(),
        });
    }
    let relative_path = meta.relative_path.as_deref().ok_or_else(|| CommandError {
        code: "backup.attachment_metadata".into(),
        message: "附件缺少归档路径".into(),
    })?;
    let normalized =
        security::validate_archive_path(relative_path, false).map_err(|error| CommandError {
            code: "security.path_denied".into(),
            message: error.to_string(),
        })?;
    if !normalized.starts_with("attachments/") {
        return Err(CommandError {
            code: "backup.attachment_metadata".into(),
            message: "附件不在受控目录".into(),
        });
    }
    if meta.width == Some(0) || meta.height == Some(0) {
        return Err(CommandError {
            code: "backup.attachment_metadata".into(),
            message: "附件尺寸不合法".into(),
        });
    }
    Ok(())
}

/// Validate the typed life document before a scan is advertised as
/// restorable.  The repository repeats these checks during the transaction,
/// but doing them here gives the user diagnostics before confirmation and
/// prevents a malformed archive from being reported as `canRestore: true`.
fn validate_backup_document(life: &Value) -> Result<(), CommandError> {
    let stages: Vec<LifeStage> =
        serde_json::from_value(life["stages"].clone()).map_err(|error| CommandError {
            code: "backup.json".into(),
            message: format!("备份阶段格式无效: {error}"),
        })?;
    let events: Vec<LifeEvent> =
        serde_json::from_value(life["events"].clone()).map_err(|error| CommandError {
            code: "backup.json".into(),
            message: format!("备份记录格式无效: {error}"),
        })?;
    let attachments = life["attachments"].as_array().ok_or_else(|| CommandError {
        code: "backup.json".into(),
        message: "备份附件字段格式无效".into(),
    })?;

    let mut stage_ids = HashSet::with_capacity(stages.len());
    for stage in &stages {
        if stage.id == "stage-all" {
            return Err(CommandError {
                code: "backup.document".into(),
                message: "备份不能包含系统阶段 stage-all".into(),
            });
        }
        models::validate_stage(stage).map_err(command_error)?;
        if !stage_ids.insert(stage.id.as_str()) {
            return Err(CommandError {
                code: "backup.document".into(),
                message: format!("备份包含重复阶段 ID: {}", stage.id),
            });
        }
    }

    let mut attachment_ids = HashSet::with_capacity(attachments.len());
    for value in attachments {
        let mut meta_value = value.clone();
        if let Some(object) = meta_value.as_object_mut() {
            if let Some(path) = object.get("path").cloned() {
                if let Some(existing) = object.get("relativePath") {
                    if existing != &path {
                        return Err(CommandError {
                            code: "backup.attachment_metadata".into(),
                            message: "附件 path 与 relativePath 不一致".into(),
                        });
                    }
                } else {
                    object.insert("relativePath".into(), path);
                }
            }
        }
        let meta: models::AttachmentMeta =
            serde_json::from_value(meta_value).map_err(|error| CommandError {
                code: "backup.json".into(),
                message: format!("备份附件格式无效: {error}"),
            })?;
        validate_backup_attachment_meta(&meta)?;
        if !attachment_ids.insert(meta.id) {
            return Err(CommandError {
                code: "backup.document".into(),
                message: "备份包含重复附件 ID".into(),
            });
        }
    }

    let mut event_ids = HashSet::with_capacity(events.len());
    let mut daily_dates = HashSet::new();
    for event in &events {
        let references = models::validate_event(event).map_err(command_error)?;
        if !event_ids.insert(event.id.as_str()) {
            return Err(CommandError {
                code: "backup.document".into(),
                message: format!("备份包含重复记录 ID: {}", event.id),
            });
        }
        if event.record_type == "daily" && !daily_dates.insert(event.date.as_str()) {
            return Err(CommandError {
                code: "backup.document".into(),
                message: format!("同一天存在多篇 Daily 记录: {}", event.date),
            });
        }
        if let Some(stage_id) = &event.stage_id {
            if !stage_ids.contains(stage_id.as_str()) {
                return Err(CommandError {
                    code: "backup.document".into(),
                    message: format!("记录引用了未包含的阶段: {stage_id}"),
                });
            }
        }
        for attachment_id in references {
            if !attachment_ids.contains(&attachment_id) {
                return Err(CommandError {
                    code: "backup.document".into(),
                    message: format!("记录引用了未包含的附件: {attachment_id}"),
                });
            }
        }
    }
    Ok(())
}

fn scan_zip(path: &Path) -> Result<(Value, Value, BackupScanCounts), CommandError> {
    scan_zip_inner(path, false)
}

fn scan_zip_inner(
    path: &Path,
    diary: bool,
) -> Result<(Value, Value, BackupScanCounts), CommandError> {
    let file = File::open(path).map_err(|e| CommandError {
        code: "backup.io".into(),
        message: e.to_string(),
    })?;
    let mut archive = ZipArchive::new(file).map_err(|e| CommandError {
        code: "backup.zip".into(),
        message: e.to_string(),
    })?;
    let limits = security::ArchiveLimits::default();
    if archive.len() > limits.max_entries {
        return Err(CommandError {
            code: "backup.too_many_entries".into(),
            message: "备份条目数量超过限制".into(),
        });
    }
    let mut names = security::ArchivePathSet::default();
    let mut observed = HashMap::<String, (u64, String)>::new();
    let mut life = None;
    let mut manifest = None;
    let mut total_uncompressed = 0u64;
    let mut streamed_uncompressed = 0u64;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|e| CommandError {
            code: "backup.zip".into(),
            message: e.to_string(),
        })?;
        let name = entry.name().to_string();
        let normalized = names
            .insert(&name, entry.is_dir())
            .map_err(|e| CommandError {
                code: "security.path_denied".into(),
                message: e.to_string(),
            })?;
        if entry.is_dir() {
            return Err(CommandError {
                code: "backup.directory".into(),
                message: "备份不允许目录条目".into(),
            });
        }
        if security::zip_member_is_symlink(entry.unix_mode()) {
            return Err(CommandError {
                code: "backup.symlink".into(),
                message: "备份不允许符号链接条目".into(),
            });
        }
        let uncompressed = entry.size();
        let compressed = entry.compressed_size();
        total_uncompressed = total_uncompressed.saturating_add(uncompressed);
        if total_uncompressed > limits.max_total_uncompressed
            || uncompressed > limits.max_member_uncompressed
        {
            return Err(CommandError {
                code: "backup.too_large".into(),
                message: "备份解压后大小超过限制".into(),
            });
        }
        if (compressed == 0 && uncompressed > 0)
            || (compressed > 0 && uncompressed / compressed.max(1) > limits.max_compression_ratio)
        {
            return Err(CommandError {
                code: "backup.compression_bomb".into(),
                message: "备份压缩膨胀比超过限制".into(),
            });
        }
        if normalized == "life.json" {
            let bytes = read_zip_entry_limited(&mut entry, limits.max_json_bytes)?;
            streamed_uncompressed = streamed_uncompressed
                .checked_add(bytes.len() as u64)
                .ok_or_else(|| CommandError {
                    code: "backup.too_large".into(),
                    message: "备份解压后大小超过限制".into(),
                })?;
            if streamed_uncompressed > limits.max_total_uncompressed {
                return Err(CommandError {
                    code: "backup.too_large".into(),
                    message: "备份解压后大小超过限制".into(),
                });
            }
            observed.insert(
                normalized.to_ascii_lowercase(),
                (bytes.len() as u64, format!("{:x}", Sha256::digest(&bytes))),
            );
            life =
                Some(
                    security::validate_json_bytes(&bytes, limits).map_err(|e| CommandError {
                        code: "backup.json".into(),
                        message: e.to_string(),
                    })?,
                );
        } else if normalized == "manifest.json" {
            let bytes = read_zip_entry_limited(&mut entry, limits.max_json_bytes)?;
            streamed_uncompressed = streamed_uncompressed
                .checked_add(bytes.len() as u64)
                .ok_or_else(|| CommandError {
                    code: "backup.too_large".into(),
                    message: "备份解压后大小超过限制".into(),
                })?;
            if streamed_uncompressed > limits.max_total_uncompressed {
                return Err(CommandError {
                    code: "backup.too_large".into(),
                    message: "备份解压后大小超过限制".into(),
                });
            }
            observed.insert(
                normalized.to_ascii_lowercase(),
                (bytes.len() as u64, format!("{:x}", Sha256::digest(&bytes))),
            );
            manifest =
                Some(
                    security::validate_json_bytes(&bytes, limits).map_err(|e| CommandError {
                        code: "backup.json".into(),
                        message: e.to_string(),
                    })?,
                );
        } else if !normalized.starts_with("attachments/") {
            return Err(CommandError {
                code: "backup.unexpected_entry".into(),
                message: "备份含有不受支持的文件".into(),
            });
        } else {
            let mut hasher = Sha256::new();
            let mut bytes = 0u64;
            let mut buffer = vec![0u8; 1024 * 1024];
            loop {
                let count = entry.read(&mut buffer).map_err(|e| CommandError {
                    code: "backup.io".into(),
                    message: e.to_string(),
                })?;
                if count == 0 {
                    break;
                }
                bytes = bytes.saturating_add(count as u64);
                streamed_uncompressed = streamed_uncompressed
                    .checked_add(count as u64)
                    .ok_or_else(|| CommandError {
                        code: "backup.too_large".into(),
                        message: "备份解压后大小超过限制".into(),
                    })?;
                if bytes > limits.max_member_uncompressed
                    || streamed_uncompressed > limits.max_total_uncompressed
                {
                    return Err(CommandError {
                        code: "backup.too_large".into(),
                        message: "备份解压后大小超过限制".into(),
                    });
                }
                hasher.update(&buffer[..count]);
            }
            observed.insert(
                normalized.to_ascii_lowercase(),
                (bytes, format!("{:x}", hasher.finalize())),
            );
        }
    }
    let life = life.ok_or_else(|| CommandError {
        code: "backup.missing_life".into(),
        message: "备份缺少 life.json".into(),
    })?;
    let manifest = manifest.ok_or_else(|| CommandError {
        code: "backup.missing_manifest".into(),
        message: "备份缺少 manifest.json".into(),
    })?;
    if diary {
        if manifest["purpose"].as_str() != Some("diary-transfer")
            || life["purpose"].as_str() != Some("diary-transfer")
            || manifest["diaryFormatVersion"].as_u64() != Some(1)
            || life["diaryFormatVersion"].as_u64() != Some(1)
        {
            return Err(CommandError {
                code: "diary.unsupported_format".into(),
                message: "请选择由“导出日记”生成的日记 ZIP；此文件不是支持的日记格式。".into(),
            });
        }
    } else if !manifest["purpose"].is_null() || !life["purpose"].is_null() {
        return Err(CommandError {
            code: "backup.wrong_purpose".into(),
            message: "此文件是日记交换包，请使用加号菜单中的“导入日记”，不能替换整个资料库。"
                .into(),
        });
    }
    if manifest["archiveFormatVersion"].as_u64() != Some(if diary { 2 } else { 1 })
        || manifest["schemaVersion"].as_u64() != Some(1)
        || life["schemaVersion"].as_u64() != Some(1)
    {
        return Err(CommandError {
            code: "backup.unsupported_version".into(),
            message: "备份格式或资料库版本不受支持".into(),
        });
    }
    let life_database_id = life["databaseId"]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| CommandError {
            code: "backup.database_id".into(),
            message: "life.json 缺少有效 databaseId".into(),
        })?;
    let manifest_database_id = manifest["databaseId"]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| CommandError {
            code: "backup.database_id".into(),
            message: "manifest 缺少有效 databaseId".into(),
        })?;
    if life_database_id != manifest_database_id {
        return Err(CommandError {
            code: "backup.database_id".into(),
            message: "manifest 与 life.json 的 databaseId 不一致".into(),
        });
    }
    if !life["events"].is_array()
        || !life["stages"].is_array()
        || !life["attachments"].is_array()
        || !life["preferences"].is_object()
    {
        return Err(CommandError {
            code: "backup.json".into(),
            message: "life.json 缺少有效的记录、阶段、附件或偏好字段".into(),
        });
    }
    validate_backup_document(&life)?;
    if diary {
        diary_transfer::validate_document(&life, &manifest)?;
    }
    let mut listed = std::collections::HashSet::new();
    if let Some(files) = manifest["files"].as_array() {
        for file in files {
            let Some(file_path) = file["path"].as_str() else {
                return Err(CommandError {
                    code: "backup.manifest".into(),
                    message: "manifest 文件路径无效".into(),
                });
            };
            let normalized =
                security::validate_archive_path(file_path, false).map_err(|e| CommandError {
                    code: "security.path_denied".into(),
                    message: e.to_string(),
                })?;
            if normalized != "life.json" && !normalized.starts_with("attachments/") {
                return Err(CommandError {
                    code: "backup.manifest".into(),
                    message: "manifest 含有不受支持的文件".into(),
                });
            }
            if !listed.insert(normalized.to_ascii_lowercase()) {
                return Err(CommandError {
                    code: "backup.manifest".into(),
                    message: "manifest 含有重复文件".into(),
                });
            }
            if !file["sha256"].as_str().is_some_and(|value| {
                value.len() == 64 && value.chars().all(|character| character.is_ascii_hexdigit())
            }) || file["byteSize"].as_u64().is_none()
            {
                return Err(CommandError {
                    code: "backup.manifest".into(),
                    message: "manifest 文件校验字段无效".into(),
                });
            }
            let expected_hash = file["sha256"].as_str().unwrap().to_ascii_lowercase();
            let expected_size = file["byteSize"].as_u64().unwrap();
            let Some((actual_size, actual_hash)) = observed.get(&normalized.to_ascii_lowercase())
            else {
                return Err(CommandError {
                    code: "backup.manifest".into(),
                    message: "manifest 文件不在归档中".into(),
                });
            };
            if *actual_size != expected_size || actual_hash != &expected_hash {
                return Err(CommandError {
                    code: "backup.hash_mismatch".into(),
                    message: "备份文件 hash 或大小校验失败".into(),
                });
            }
        }
    } else {
        return Err(CommandError {
            code: "backup.manifest".into(),
            message: "manifest 缺少 files 数组".into(),
        });
    }
    if observed
        .keys()
        .any(|path| path != "manifest.json" && !listed.contains(path))
    {
        return Err(CommandError {
            code: "backup.manifest".into(),
            message: "归档包含未列入 manifest 的文件".into(),
        });
    }
    let counts = manifest["counts"].as_object().ok_or_else(|| CommandError {
        code: "backup.counts".into(),
        message: "manifest 缺少 counts 对象".into(),
    })?;
    for (key, actual) in [
        ("events", life["events"].as_array().map(|v| v.len())),
        ("stages", life["stages"].as_array().map(|v| v.len())),
        (
            "attachments",
            life["attachments"].as_array().map(|v| v.len()),
        ),
    ] {
        let expected = counts
            .get(key)
            .and_then(Value::as_u64)
            .ok_or_else(|| CommandError {
                code: "backup.counts".into(),
                message: "manifest counts 字段无效".into(),
            })?;
        if Some(expected as usize) != actual {
            return Err(CommandError {
                code: "backup.counts".into(),
                message: "manifest 数量与 life.json 不一致".into(),
            });
        }
    }
    if let Some(attachments) = life["attachments"].as_array() {
        if attachments.len() > limits.max_attachments {
            return Err(CommandError {
                code: "backup.too_many_attachments".into(),
                message: "备份附件数量超过限制".into(),
            });
        }
        let mut attachment_paths = HashMap::<String, (String, String, u64)>::new();
        for attachment in attachments {
            let Some(relative) = attachment["path"].as_str() else {
                return Err(CommandError {
                    code: "backup.missing_attachment_path".into(),
                    message: "备份附件缺少归档路径".into(),
                });
            };
            let normalized =
                security::validate_archive_path(relative, false).map_err(|e| CommandError {
                    code: "security.path_denied".into(),
                    message: e.to_string(),
                })?;
            if !normalized.starts_with("attachments/") {
                return Err(CommandError {
                    code: "backup.attachment_path".into(),
                    message: "附件不在受控目录".into(),
                });
            }
            let expected_hash = attachment["sha256"]
                .as_str()
                .map(str::to_ascii_lowercase)
                .filter(|value| {
                    value.len() == 64
                        && value.chars().all(|character| character.is_ascii_hexdigit())
                })
                .ok_or_else(|| CommandError {
                    code: "backup.attachment_hash".into(),
                    message: "备份附件 hash 无效".into(),
                })?;
            let expected_size = attachment["byteSize"]
                .as_u64()
                .ok_or_else(|| CommandError {
                    code: "backup.attachment_size".into(),
                    message: "备份附件大小无效".into(),
                })?;
            let attachment_key = normalized.to_ascii_lowercase();
            if let Some((known_path, known_hash, known_size)) =
                attachment_paths.get(&attachment_key)
            {
                if known_path != &normalized
                    || known_hash != &expected_hash
                    || *known_size != expected_size
                {
                    return Err(CommandError {
                        code: "backup.attachment_conflict".into(),
                        message: "同一物理附件路径对应了不同 hash 或大小".into(),
                    });
                }
            } else {
                attachment_paths.insert(
                    attachment_key.clone(),
                    (normalized.clone(), expected_hash.clone(), expected_size),
                );
            }
            let Some((actual_size, actual_hash)) = observed.get(&attachment_key) else {
                return Err(CommandError {
                    code: "backup.missing_attachment".into(),
                    message: "备份附件文件缺失".into(),
                });
            };
            if *actual_size != expected_size || actual_hash != &expected_hash {
                return Err(CommandError {
                    code: "backup.hash_mismatch".into(),
                    message: "附件内容与元数据校验不一致".into(),
                });
            }
        }
        if listed
            .iter()
            .any(|path| path.starts_with("attachments/") && !attachment_paths.contains_key(path))
        {
            return Err(CommandError {
                code: "backup.manifest".into(),
                message: "manifest 包含未在 life.json 中声明的附件".into(),
            });
        }
    }
    let counts = BackupScanCounts {
        events: life["events"].as_array().map_or(0, |v| v.len()),
        stages: life["stages"].as_array().map_or(0, |v| v.len()),
        attachments: life["attachments"].as_array().map_or(0, |v| v.len()),
    };
    Ok((life, manifest, counts))
}

#[cfg_attr(not(target_os = "android"), tauri::command)]
fn backup_scan(
    request: BackupScanRequest,
    state: State<'_, AppState>,
) -> Result<BackupScanResult, CommandError> {
    let path = validate_user_archive_path(&request.archive_path)?;
    let (bytes, hash) = sha256_file(&path)?;
    let (_life, manifest, counts) = scan_zip(&path)?;
    let token = hash.clone();
    state
        .scanned_backups
        .lock()
        .map_err(|_| CommandError {
            code: "storage.lock".into(),
            message: "备份扫描锁定失败".into(),
        })?
        .insert(token.clone(), path.clone());
    Ok(BackupScanResult {
        scan_token: token,
        archive_path: path.to_string_lossy().into_owned(),
        manifest,
        counts,
        archive_byte_size: bytes,
        archive_sha256: hash,
        diagnostics: vec![],
        can_restore: true,
    })
}

#[cfg_attr(not(target_os = "android"), tauri::command)]
fn backup_restore(
    request: BackupRestoreRequest,
    state: State<'_, AppState>,
) -> Result<BackupRestoreResult, CommandError> {
    if request.confirmation != "replace-current" {
        return Err(CommandError {
            code: "backup.confirmation".into(),
            message: "恢复资料库必须明确确认替换当前资料库".into(),
        });
    }
    let path = validate_user_archive_path(&request.archive_path)?;
    let (_bytes, hash) = sha256_file(&path)?;
    if hash != request.scan_token {
        return Err(CommandError {
            code: "backup.scan_token".into(),
            message: "备份扫描令牌已失效".into(),
        });
    }
    {
        let scanned = state.scanned_backups.lock().map_err(|_| CommandError {
            code: "storage.lock".into(),
            message: "备份扫描锁定失败".into(),
        })?;
        if scanned.get(&request.scan_token) != Some(&path) {
            return Err(CommandError {
                code: "backup.scan_token".into(),
                message: "备份必须先完成本次扫描".into(),
            });
        }
    }
    let (life, _manifest, counts) = scan_zip(&path)?;
    let events: Vec<LifeEvent> =
        serde_json::from_value(life["events"].clone()).map_err(|e| CommandError {
            code: "backup.json".into(),
            message: e.to_string(),
        })?;
    let stages: Vec<LifeStage> =
        serde_json::from_value(life["stages"].clone()).map_err(|e| CommandError {
            code: "backup.json".into(),
            message: e.to_string(),
        })?;
    let preferences = life["preferences"].clone();
    let previous = state.root.join("backups").join(format!(
        "pre-restore-{}.zip",
        Utc::now().format("%Y%m%d%H%M%S")
    ));
    let _ = export_archive(&state, &previous, false)?;
    // Materialize and hash-check every attachment in a fresh staging tree
    // before opening the database transaction. The old attachment tree is
    // untouched while validation or the SQLite replacement can still fail.
    let restore_id = Uuid::new_v4().to_string();
    let staging_root = state
        .root
        .join("staging")
        .join(format!("restore-{restore_id}"));
    security::reject_symlink_components(&state.root.join("staging")).map_err(|error| {
        CommandError {
            code: "security.path_denied".into(),
            message: error.to_string(),
        }
    })?;
    fs::create_dir_all(&staging_root).map_err(|e| CommandError {
        code: "backup.io".into(),
        message: e.to_string(),
    })?;
    let mut staging_guard = StagingGuard {
        path: staging_root.clone(),
        preserve: false,
    };
    let mut registered = Vec::<RegisteredAttachment>::new();
    let mut staged_metadata = HashMap::<String, (String, u64)>::new();
    if let Some(attachments) = life["attachments"].as_array() {
        let file = File::open(&path).map_err(|e| CommandError {
            code: "backup.io".into(),
            message: e.to_string(),
        })?;
        let mut archive = ZipArchive::new(file).map_err(|e| CommandError {
            code: "backup.zip".into(),
            message: e.to_string(),
        })?;
        for value in attachments {
            let mut meta_value = value.clone();
            if let Some(object) = meta_value.as_object_mut() {
                if !object.contains_key("relativePath") {
                    if let Some(path) = object.get("path").cloned() {
                        object.insert("relativePath".into(), path);
                    }
                }
            }
            let meta: models::AttachmentMeta =
                serde_json::from_value(meta_value).map_err(|e| CommandError {
                    code: "backup.json".into(),
                    message: e.to_string(),
                })?;
            let Some(relative_raw) = meta.relative_path.clone() else {
                return Err(CommandError {
                    code: "backup.missing_attachment_path".into(),
                    message: "备份附件缺少归档路径".into(),
                });
            };
            let relative = security::validate_archive_path(&relative_raw, false).map_err(|e| {
                CommandError {
                    code: "security.path_denied".into(),
                    message: e.to_string(),
                }
            })?;
            if !relative.starts_with("attachments/") {
                return Err(CommandError {
                    code: "backup.attachment_path".into(),
                    message: "附件不在受控目录".into(),
                });
            }
            let expected_hash = meta
                .sha256
                .clone()
                .ok_or_else(|| CommandError {
                    code: "backup.missing_attachment_hash".into(),
                    message: "备份附件缺少 hash".into(),
                })?
                .to_ascii_lowercase();
            if expected_hash.len() != 64
                || !expected_hash
                    .chars()
                    .all(|character| character.is_ascii_hexdigit())
            {
                return Err(CommandError {
                    code: "backup.attachment_hash".into(),
                    message: "备份附件 hash 无效".into(),
                });
            }
            let path_key = relative.to_ascii_lowercase();
            let should_stage =
                if let Some((known_hash, known_size)) = staged_metadata.get(&path_key) {
                    if known_hash != &expected_hash || *known_size != meta.byte_size {
                        return Err(CommandError {
                            code: "backup.attachment_conflict".into(),
                            message: "同一物理附件路径对应了不同 hash 或大小".into(),
                        });
                    }
                    false
                } else {
                    staged_metadata.insert(path_key, (expected_hash.clone(), meta.byte_size));
                    true
                };
            if should_stage {
                let mut entry = archive.by_name(&relative).map_err(|e| CommandError {
                    code: "backup.missing_attachment".into(),
                    message: e.to_string(),
                })?;
                let bytes = read_zip_entry_limited(
                    &mut entry,
                    security::ArchiveLimits::default().max_member_uncompressed,
                )?;
                let actual_hash = format!("{:x}", Sha256::digest(&bytes));
                if actual_hash != expected_hash || bytes.len() as u64 != meta.byte_size {
                    return Err(CommandError {
                        code: "backup.hash_mismatch".into(),
                        message: "附件内容与元数据校验不一致".into(),
                    });
                }
                let staged_target =
                    security::safe_join(&staging_root, &relative).map_err(|e| CommandError {
                        code: "security.path_denied".into(),
                        message: e.to_string(),
                    })?;
                if let Some(parent) = staged_target.parent() {
                    fs::create_dir_all(parent).map_err(|e| CommandError {
                        code: "backup.io".into(),
                        message: e.to_string(),
                    })?;
                }
                fs::write(&staged_target, &bytes).map_err(|e| CommandError {
                    code: "backup.io".into(),
                    message: e.to_string(),
                })?;
            }
            registered.push(RegisteredAttachment {
                id: meta.id,
                sha256: expected_hash,
                name: meta.name,
                mime_type: meta.mime_type,
                byte_size: meta.byte_size,
                kind: meta.kind,
                width: meta.width,
                height: meta.height,
                last_modified: meta.last_modified,
                relative_path: relative,
                created_at: Utc::now().to_rfc3339(),
            });
        }
    }
    // Record all paths that may be copied into the live tree before the first
    // write. On a process interruption the next launch can remove files
    // which are not referenced by the database that survived the crash.
    let marker_path = recovery_marker_path(&state.root, &restore_id);
    let mut planned_paths = HashSet::new();
    for attachment in &registered {
        let target = attachment_service::controlled_path(&state.root, &attachment.relative_path)
            .map_err(command_error)?;
        if !target.exists() {
            planned_paths.insert(attachment.relative_path.clone());
        }
    }
    write_recovery_marker(
        &marker_path,
        &RestoreRecoveryMarker {
            staging_path: format!("staging/restore-{restore_id}"),
            materialized_paths: planned_paths.into_iter().collect(),
        },
    )?;

    // Materialize validated files before the database transaction. If SQLite
    // rejects the replacement, only the newly-created content-addressed files
    // are removed and the previous database/files remain usable.
    let mut materialized = Vec::<PathBuf>::new();
    let mut materialized_paths = HashSet::new();
    let materialize_result: Result<(), CommandError> = (|| {
        for attachment in registered.iter() {
            if !materialized_paths.insert(attachment.relative_path.to_ascii_lowercase()) {
                continue;
            }
            let source = staging_root.join(
                attachment
                    .relative_path
                    .replace('/', std::path::MAIN_SEPARATOR_STR),
            );
            let target =
                attachment_service::controlled_path(&state.root, &attachment.relative_path)
                    .map_err(command_error)?;
            if target.exists() {
                let (size, hash) =
                    crate::security::sha256_file(&target).map_err(|error| CommandError {
                        code: "storage.hash".into(),
                        message: error.to_string(),
                    })?;
                if size != attachment.byte_size || hash != attachment.sha256 {
                    return Err(CommandError {
                        code: "backup.path_conflict".into(),
                        message: "受控附件路径已对应不同内容".into(),
                    });
                }
            } else {
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent).map_err(|e| CommandError {
                        code: "backup.io".into(),
                        message: e.to_string(),
                    })?;
                }
                security::copy_new_file_verified(
                    &source,
                    &target,
                    attachment.byte_size,
                    &attachment.sha256,
                    || materialized.push(target.clone()),
                )
                .map_err(|cause| CommandError {
                    code: "backup.attachment_publish".into(),
                    message: format!("保存恢复附件失败：{cause}"),
                })?;
            }
        }
        Ok(())
    })();
    if let Err(error) = materialize_result {
        if cleanup_materialized_files(&materialized) {
            let _ = fs::remove_file(&marker_path);
        }
        return Err(error);
    }
    let mut repo = match lock_repo(&state) {
        Ok(repo) => repo,
        Err(error) => {
            if cleanup_materialized_files(&materialized) {
                let _ = fs::remove_file(&marker_path);
            }
            return Err(error);
        }
    };
    let ack = match repo.restore_snapshot(&events, &stages, &preferences, registered.clone()) {
        Ok(ack) => ack,
        Err(error) => {
            drop(repo);
            if cleanup_materialized_files(&materialized) {
                let _ = fs::remove_file(&marker_path);
            }
            return Err(command_error(error));
        }
    };
    drop(repo);
    if fs::remove_dir_all(&staging_root).is_ok() {
        staging_guard.preserve = true;
    }
    let _ = fs::remove_file(&marker_path);
    if let Ok(mut scanned) = state.scanned_backups.lock() {
        scanned.remove(&request.scan_token);
    }
    Ok(BackupRestoreResult {
        restored_at: ack.restored_at,
        previous_library_backup_path: previous.to_string_lossy().into_owned(),
        revision: ack.revision,
        counts,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_dialog::init());
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(updater::UpdateState::default());
    #[cfg(target_os = "android")]
    let builder = builder
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_life_mobile::init())
        .manage(android_updater::AndroidUpdateState::default());
    builder
        .setup(|app| {
            #[cfg(target_os = "android")]
            mobile::initialize(app.handle().clone())?;
            let root = app.path().app_local_data_dir()?;
            app.manage(AppState::open(root)?);
            let handle = app.handle().clone();
            let _ = handle.emit(
                "life-timeline://backup-status",
                json!({ "status": "running", "checkedAt": Utc::now().to_rfc3339(), "lastSuccessAt": null, "error": null }),
            );
            tauri::async_runtime::spawn(async move {
                let state = handle.state::<AppState>();
                let _ = run_daily_backup(&state);
                let _ = handle.emit("life-timeline://backup-status", current_backup_status(&state.root));
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            #[cfg(desktop)]
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.app_handle().state::<updater::UpdateState>().is_installing() {
                    api.prevent_close();
                    return;
                }
                let state = window.app_handle().state::<AppState>();
                if state.allow_close.swap(false, Ordering::SeqCst) {
                    return;
                }
                api.prevent_close();
                let _ = window.emit("life-timeline://close-requested", ());
            }
            #[cfg(target_os = "android")]
            if matches!(event, WindowEvent::Suspended) {
                // Each save already commits SQLite with synchronous=FULL. A
                // background checkpoint additionally drains the WAL on pause.
                let handle = window.app_handle().clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let state = handle.state::<AppState>();
                    if let Ok(mut repo) = state.repository.lock() {
                        let _ = repo.checkpoint_full();
                    };
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            #[cfg(desktop)]
            updater::updater_status,
            #[cfg(desktop)]
            updater::updater_preferences,
            #[cfg(desktop)]
            updater::updater_check,
            #[cfg(desktop)]
            updater::updater_ignore,
            #[cfg(desktop)]
            updater::updater_download,
            #[cfg(desktop)]
            updater::updater_install,
            #[cfg(target_os = "android")]
            android_updater::android_updater_status,
            #[cfg(target_os = "android")]
            android_updater::android_updater_preferences,
            #[cfg(target_os = "android")]
            android_updater::android_updater_check,
            #[cfg(target_os = "android")]
            android_updater::android_updater_ignore,
            #[cfg(target_os = "android")]
            android_updater::android_updater_download,
            #[cfg(target_os = "android")]
            android_updater::android_updater_install,
            ai_commands::api_status,
            ai_commands::api_save,
            ai_commands::api_apply,
            schedules::schedule_ai_analyze,
            ai_commands::api_remove,
            ai_commands::ai_import_inspect,
            ai_commands::ai_import_analyze,
            ai_commands::ai_import_build,
            ai_commands::ai_import_commit,
            ai_commands::ai_import_status,
            ai_commands::ai_import_discard,
            ai_commands::ai_import_rollback,
            load_snapshot,
            save_snapshot,
            load_preferences,
            save_preferences,
            flush_persistence,
            import_attachment,
            list_attachments,
            attachment_path,
            #[cfg(not(target_os = "android"))]
            save_attachment_as,
            #[cfg(target_os = "android")]
            mobile::save_attachment_as,
            #[cfg(target_os = "android")]
            mobile::attachment_open,
            open_data_dir,
            confirm_close,
            cancel_close,
            backup_flush,
            #[cfg(not(target_os = "android"))]
            backup_export,
            #[cfg(target_os = "android")]
            mobile::backup_export,
            #[cfg(not(target_os = "android"))]
            backup_scan,
            #[cfg(target_os = "android")]
            mobile::backup_scan,
            #[cfg(not(target_os = "android"))]
            backup_restore,
            #[cfg(target_os = "android")]
            mobile::backup_restore,
            backup_status,
            diary_transfer::diary_export,
            diary_transfer::diary_scan,
            diary_transfer::diary_import,
            #[cfg(not(target_os = "android"))]
            phone_transfer::phone_transfer_start,
            #[cfg(not(target_os = "android"))]
            phone_transfer::phone_transfer_offer,
            #[cfg(not(target_os = "android"))]
            phone_transfer::phone_transfer_cancel,
            #[cfg(not(target_os = "android"))]
            phone_transfer::phone_transfer_status,
            #[cfg(target_os = "android")]
            phone_transfer::phone_transfer_send,
            #[cfg(target_os = "android")]
            phone_transfer::phone_transfer_receive
        ])
        .run(tauri::generate_context!())
        .expect("error while running life-timeline");
}

#[cfg(test)]
mod backup_tests;

#[cfg(test)]
mod diary_transfer_tests;

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_recovery_retries_failed_cleanup(fail_directory: bool) {
        let root = tempfile::tempdir().unwrap();
        let state = AppState::open(root.path().to_path_buf()).unwrap();
        let referenced = {
            let mut repository = state.repository.lock().unwrap();
            attachment_service::import(
                &mut repository,
                &state.root,
                &ImportAttachmentRequest {
                    name: "retained.txt".into(),
                    mime_type: "text/plain".into(),
                    kind: Some("file".into()),
                    last_modified: None,
                    width: None,
                    height: None,
                    bytes: b"synthetic referenced attachment".to_vec(),
                },
            )
            .unwrap()
            .relative_path
        };
        let orphan_relative = "attachments/ff/retry-orphan.bin";
        let orphan = attachment_service::controlled_path(&state.root, orphan_relative).unwrap();
        fs::create_dir_all(orphan.parent().unwrap()).unwrap();
        fs::write(&orphan, b"synthetic orphan").unwrap();
        let staging = state.root.join("staging/restore-retry-test");
        fs::create_dir_all(&staging).unwrap();
        fs::write(staging.join("partial"), b"synthetic partial").unwrap();
        let marker = recovery_marker_path(&state.root, "retry-test");
        write_recovery_marker(
            &marker,
            &RestoreRecoveryMarker {
                staging_path: "staging/restore-retry-test".into(),
                materialized_paths: vec![
                    referenced.clone(),
                    orphan_relative.into(),
                    "attachments/ff/already-removed.bin".into(),
                ],
            },
        )
        .unwrap();
        let failed_path = if fail_directory { &staging } else { &orphan };
        let mut failures = 0;
        {
            let repository = state.repository.lock().unwrap();
            recover_pending_restores_with_remover(&state.root, &repository, |path, directory| {
                if directory == fail_directory && path.file_name() == failed_path.file_name() {
                    failures += 1;
                    return Err(std::io::ErrorKind::PermissionDenied.into());
                }
                if directory {
                    fs::remove_dir_all(path)
                } else {
                    fs::remove_file(path)
                }
            })
            .unwrap();
        }
        assert!(failures > 0, "the intended deletion failure was exercised");
        assert!(
            marker.is_file(),
            "failed cleanup must keep its recovery marker"
        );
        assert!(failed_path.exists(), "failed cleanup must remain retryable");
        let kept = attachment_service::controlled_path(&state.root, &referenced).unwrap();
        assert_eq!(fs::read(&kept).unwrap(), b"synthetic referenced attachment");

        drop(state);
        let reopened = AppState::open(root.path().to_path_buf()).unwrap();
        assert!(
            !marker.exists(),
            "successful startup retry consumes the marker"
        );
        assert!(!orphan.exists());
        assert!(!staging.exists());
        assert_eq!(fs::read(kept).unwrap(), b"synthetic referenced attachment");
        assert_eq!(
            reopened
                .repository
                .lock()
                .unwrap()
                .list_attachments()
                .unwrap()
                .len(),
            1,
        );
    }

    #[test]
    fn recovery_retains_marker_after_attachment_delete_failure_and_retries_on_reopen() {
        assert_recovery_retries_failed_cleanup(false);
    }

    #[test]
    fn recovery_retains_marker_after_staging_delete_failure_and_retries_on_reopen() {
        assert_recovery_retries_failed_cleanup(true);
    }

    #[test]
    fn recovery_retains_invalid_marker_without_deleting_outside_its_restore_paths() {
        let root = tempfile::tempdir().unwrap();
        let state = AppState::open(root.path().to_path_buf()).unwrap();
        let unrelated_staging = state.root.join("staging/keep");
        fs::create_dir_all(&unrelated_staging).unwrap();
        let unrelated_backup = state.root.join("backups/keep.zip");
        fs::write(&unrelated_backup, b"synthetic retained backup").unwrap();
        let marker = recovery_marker_path(&state.root, "invalid-path-test");
        write_recovery_marker(
            &marker,
            &RestoreRecoveryMarker {
                staging_path: "staging/keep".into(),
                materialized_paths: vec!["../outside".into(), "backups/keep.zip".into()],
            },
        )
        .unwrap();
        let repository = state.repository.lock().unwrap();
        recover_pending_restores_with_remover(&state.root, &repository, |_, _| {
            panic!("invalid marker paths must never reach a deletion operation")
        })
        .unwrap();
        assert!(marker.is_file());
        assert!(unrelated_staging.is_dir());
        assert_eq!(
            fs::read(unrelated_backup).unwrap(),
            b"synthetic retained backup"
        );
    }

    fn test_archive_path() -> PathBuf {
        std::env::temp_dir().join(format!("life-timeline-backup-test-{}.zip", Uuid::new_v4()))
    }

    fn write_test_archive(life: &Value, files: &[(&str, &[u8])]) -> PathBuf {
        let path = test_archive_path();
        let file = File::create(&path).unwrap();
        let mut zip = ZipWriter::new(file);
        let life_bytes = serde_json::to_vec_pretty(life).unwrap();
        write_zip_file(&mut zip, "life.json", &life_bytes).unwrap();
        let mut listed = vec![json!({
            "path": "life.json",
            "sha256": format!("{:x}", Sha256::digest(&life_bytes)),
            "byteSize": life_bytes.len(),
        })];
        let mut written = HashSet::new();
        for &(relative, bytes) in files {
            if !written.insert(relative.to_ascii_lowercase()) {
                continue;
            }
            write_zip_file(&mut zip, relative, bytes).unwrap();
            listed.push(json!({
                "path": relative,
                "sha256": format!("{:x}", Sha256::digest(bytes)),
                "byteSize": bytes.len(),
            }));
        }
        let manifest = json!({
            "archiveFormatVersion": 1,
            "appVersion": models::APP_VERSION,
            "schemaVersion": 1,
            "databaseId": life["databaseId"],
            "exportedAt": "2026-09-29T00:00:00Z",
            "files": listed,
            "counts": {
                "events": life["events"].as_array().map_or(0, |items| items.len()),
                "stages": life["stages"].as_array().map_or(0, |items| items.len()),
                "attachments": life["attachments"].as_array().map_or(0, |items| items.len()),
            },
        });
        let manifest_bytes = serde_json::to_vec_pretty(&manifest).unwrap();
        write_zip_file(&mut zip, "manifest.json", &manifest_bytes).unwrap();
        zip.finish().unwrap();
        path
    }

    fn minimal_life(events: Value, stages: Value, attachments: Value) -> Value {
        json!({
            "schemaVersion": 1,
            "databaseId": "db-test",
            "exportedAt": "2026-09-29T00:00:00Z",
            "events": events,
            "stages": stages,
            "attachments": attachments,
            "preferences": {},
        })
    }

    fn daily_event(id: &str, date: &str) -> Value {
        json!({
            "id": id,
            "type": "daily",
            "title": "Daily",
            "date": date,
            "displayDate": date,
            "datePrecision": "day",
            "stageId": null,
            "importance": 3,
            "summary": "",
            "content": "",
            "attachmentIds": [],
        })
    }

    #[test]
    fn scan_accepts_shared_physical_attachment_path() {
        let bytes: &[u8] = b"same blob";
        let hash = format!("{:x}", Sha256::digest(bytes));
        let relative = "attachments/ab/shared.txt";
        let attachment = |id: &str| {
            json!({
                "id": id,
                "name": "shared.txt",
                "mimeType": "text/plain",
                "byteSize": bytes.len(),
                "kind": "file",
                "sha256": hash.clone(),
                "path": relative,
            })
        };
        let life = minimal_life(
            json!([]),
            json!([]),
            json!([attachment("att-1"), attachment("att-2")]),
        );
        let path = write_test_archive(&life, &[(relative, bytes)]);
        let (_life, _manifest, counts) = scan_zip(&path).unwrap();
        assert_eq!(
            counts.attachments, 2,
            "logical attachment IDs are preserved"
        );
        let _ = fs::remove_file(path);
    }

    #[test]
    fn scan_rejects_duplicate_daily_records_before_restore() {
        let life = minimal_life(
            json!([
                daily_event("daily-1", "2026-01-01"),
                daily_event("daily-2", "2026-01-01")
            ]),
            json!([]),
            json!([]),
        );
        let path = write_test_archive(&life, &[]);
        let error = scan_zip(&path).unwrap_err();
        assert_eq!(error.code, "backup.document");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn scan_rejects_missing_stage_and_attachment_references() {
        let missing_stage = json!({
            "id": "event-1",
            "type": "event",
            "title": "Event",
            "date": "2026-01-01",
            "displayDate": "2026-01-01",
            "datePrecision": "day",
            "stageId": "stage-missing",
            "importance": 3,
            "summary": "",
            "content": "",
            "attachmentIds": [],
        });
        let life = minimal_life(json!([missing_stage]), json!([]), json!([]));
        let path = write_test_archive(&life, &[]);
        let error = scan_zip(&path).unwrap_err();
        assert_eq!(error.code, "backup.document");
        let _ = fs::remove_file(path);

        let missing_attachment = json!({
            "id": "event-2",
            "type": "event",
            "title": "Event",
            "date": "2026-01-02",
            "displayDate": "2026-01-02",
            "datePrecision": "day",
            "stageId": null,
            "importance": 3,
            "summary": "",
            "content": "",
            "attachmentIds": ["att-missing"],
        });
        let life = minimal_life(json!([missing_attachment]), json!([]), json!([]));
        let path = write_test_archive(&life, &[]);
        let error = scan_zip(&path).unwrap_err();
        assert_eq!(error.code, "backup.document");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn export_deduplicates_shared_physical_attachment_entries() {
        let root =
            std::env::temp_dir().join(format!("life-timeline-export-test-{}", Uuid::new_v4()));
        let state = AppState::open(root.clone()).unwrap();
        let request = ImportAttachmentRequest {
            name: "shared.txt".into(),
            mime_type: "text/plain".into(),
            kind: Some("file".into()),
            last_modified: None,
            width: None,
            height: None,
            bytes: b"same blob".to_vec(),
        };
        {
            let mut repository = state.repository.lock().unwrap();
            let first = attachment_service::import(&mut repository, &state.root, &request).unwrap();
            let second =
                attachment_service::import(&mut repository, &state.root, &request).unwrap();
            assert_ne!(first.meta.id, second.meta.id);
            assert_eq!(first.relative_path, second.relative_path);
        }
        let destination = root.join("backup.zip");
        let result = export_archive(&state, &destination, false).unwrap();
        assert_eq!(
            result.entries, 3,
            "life.json, manifest, and one physical attachment"
        );
        let mut archive = ZipArchive::new(File::open(&destination).unwrap()).unwrap();
        let mut attachment_entries = 0;
        for index in 0..archive.len() {
            let entry = archive.by_index(index).unwrap();
            if entry.name().starts_with("attachments/") {
                attachment_entries += 1;
            }
        }
        assert_eq!(attachment_entries, 1);
        let _ = fs::remove_dir_all(root);
    }
}
