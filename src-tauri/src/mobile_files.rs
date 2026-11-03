//! Platform-independent guards for Android document staging. Android providers
//! may supply non-seekable file descriptors, so ZIPs are copied to a bounded,
//! app-private workspace before the existing archive validator sees them.
#![cfg(any(target_os = "android", test))]

use crate::{models::StorageError, security};
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

#[cfg(target_os = "android")]
pub const MAX_SELECTED_BYTES: u64 = 512 * 1024 * 1024;
pub const MAX_RETAINED_BYTES: u64 = 2 * 1024 * 1024 * 1024;
pub const MAX_RETAINED_BATCHES: usize = 32;

/// Resolve only the app root supplied by Android before applying normal path
/// protections. Android may expose this trusted root through system aliases.
/// Never use this helper to bless an archive path, selected file, or child
/// directory: links planted below the resolved root must still be rejected.
pub fn canonical_app_root(android_root: &Path) -> Result<PathBuf, StorageError> {
    if !android_root.is_absolute() {
        return Err(StorageError::PathDenied("手机资料库根目录无效。".into()));
    }
    let resolved = fs::canonicalize(android_root)?;
    if !fs::metadata(&resolved)?.is_dir() {
        return Err(StorageError::PathDenied("手机资料库根目录无效。".into()));
    }
    security::reject_symlink_components(&resolved)
        .map_err(|_| StorageError::PathDenied("手机资料库根目录无效。".into()))?;
    Ok(resolved)
}

pub fn safe_document_name(name: &str) -> Result<&str, StorageError> {
    if name.is_empty()
        || name.len() > 240
        || name.starts_with('.')
        || name.ends_with('.')
        || name.ends_with(' ')
        || name
            .chars()
            .any(|character| character.is_control() || "/\\:*?\"<>|".contains(character))
    {
        return Err(StorageError::PathDenied(
            "所选文件名称无效，请重命名后重试。".into(),
        ));
    }
    Ok(name)
}

fn checked_root(root: &Path) -> Result<PathBuf, StorageError> {
    let data_root = fs::canonicalize(root)?;
    let transfers = data_root.join("mobile-transfers");
    security::reject_symlink_components(&transfers)
        .map_err(|_| StorageError::PathDenied("手机文件暂存目录无效。".into()))?;
    fs::create_dir_all(&transfers)?;
    let resolved = fs::canonicalize(&transfers)?;
    if resolved.parent() != Some(data_root.as_path()) {
        return Err(StorageError::PathDenied("手机文件暂存目录越界。".into()));
    }
    Ok(resolved)
}

pub fn reset_transfer_directory(root: &Path) -> Result<(), StorageError> {
    let transfers = checked_root(root)?;
    for entry in fs::read_dir(&transfers)? {
        let entry = entry?;
        if entry.file_type()?.is_dir()
            && Uuid::parse_str(&entry.file_name().to_string_lossy()).is_ok()
        {
            let path = fs::canonicalize(entry.path())?;
            if path.parent() == Some(transfers.as_path()) {
                fs::remove_dir_all(path)?;
            }
        }
    }
    Ok(())
}

/// A batch owns only a UUID child of the checked private transfer directory.
/// Retain it only while a scanned ZIP still needs a subsequent confirmation.
pub struct TransferBatch {
    pub directory: PathBuf,
    keep: bool,
}

impl TransferBatch {
    pub fn new(root: &Path) -> Result<Self, StorageError> {
        let transfers = checked_root(root)?;
        let mut batches = 0usize;
        let mut bytes = 0u64;
        for entry in fs::read_dir(&transfers)? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            batches += 1;
            for file in fs::read_dir(entry.path())? {
                let file = file?;
                if file.file_type()?.is_file() {
                    bytes = bytes.saturating_add(file.metadata()?.len());
                }
            }
        }
        if batches >= MAX_RETAINED_BATCHES || bytes >= MAX_RETAINED_BYTES {
            return Err(StorageError::Invalid(
                "本次文件暂存已满，请完成导入后重新打开软件再试。".into(),
            ));
        }
        let directory = transfers.join(Uuid::new_v4().to_string());
        fs::create_dir(&directory)?;
        Ok(Self {
            directory,
            keep: false,
        })
    }

    pub fn preserve(&mut self) {
        self.keep = true;
    }
}

impl Drop for TransferBatch {
    fn drop(&mut self) {
        if !self.keep && security::reject_symlink_components(&self.directory).is_ok() {
            let _ = fs::remove_dir_all(&self.directory);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn directory_alias(target: &Path, alias: &Path) {
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, alias).unwrap();
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // Junctions reproduce the same Windows path guard without
            // requiring the machine-wide developer/symlink privilege.
            let result = std::process::Command::new("cmd.exe")
                .args(["/d", "/c", "mklink", "/J"])
                .arg(alias)
                .arg(target)
                .creation_flags(0x08000000)
                .output()
                .unwrap();
            assert!(
                result.status.success(),
                "test directory alias creation failed"
            );
        }
    }

    #[test]
    fn trusted_android_root_alias_allows_real_automatic_backup() {
        let fixture = tempfile::tempdir().unwrap();
        let real_parent = fixture.path().join("data-data");
        let real_root = real_parent.join("com.example.synthetic");
        fs::create_dir_all(&real_root).unwrap();
        let alias_parent = fixture.path().join("android-user-0");
        directory_alias(&real_parent, &alias_parent);
        let android_root = alias_parent.join("com.example.synthetic");
        assert!(security::reject_symlink_components(&android_root).is_err());

        let root = canonical_app_root(&android_root).unwrap();
        assert_eq!(root, fs::canonicalize(&real_root).unwrap());
        let state = crate::AppState::open(root.clone()).unwrap();
        crate::run_daily_backup(&state).unwrap();
        let backups: Vec<_> = fs::read_dir(root.join("backups")).unwrap().collect();
        assert_eq!(backups.len(), 1);
        let archive = backups.into_iter().next().unwrap().unwrap().path();
        let (_, _, counts) = crate::scan_zip(&archive).unwrap();
        assert_eq!(counts.events, 0);
        assert!(crate::read_auto_backup_failure(&root).is_none());
    }

    #[test]
    fn canonical_android_root_does_not_allow_linked_child_directories() {
        let fixture = tempfile::tempdir().unwrap();
        let real_root = fixture.path().join("app-data");
        let outside = fixture.path().join("outside");
        fs::create_dir_all(&real_root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let root_alias = fixture.path().join("android-root-alias");
        directory_alias(&real_root, &root_alias);
        let root = canonical_app_root(&root_alias).unwrap();
        directory_alias(&outside, &root.join("mobile-transfers"));
        directory_alias(&outside, &root.join("attachments"));

        assert!(TransferBatch::new(&root).is_err());
        assert!(crate::attachments::controlled_path(&root, "attachments/escape.txt").is_err());
        assert!(security::create_new_file(&root.join("attachments/escape.txt")).is_err());
        assert!(!outside.join("escape.txt").exists());
    }

    #[test]
    fn provider_names_cannot_escape_private_staging() {
        for name in [
            "", ".", "..", "../key", "a/b", "a\\b", "C:secret", ".hidden", "x\0.jpg", "x\n.jpg",
            "a.", "a ",
        ] {
            assert!(
                safe_document_name(name).is_err(),
                "invalid provider name accepted"
            );
        }
        assert_eq!(
            safe_document_name("2026年10月2日 日记.jpg").unwrap(),
            "2026年10月2日 日记.jpg"
        );
        assert!(safe_document_name(&"x".repeat(241)).is_err());
    }

    #[test]
    fn failed_or_finished_batches_remove_only_their_files() {
        let root = tempfile::tempdir().unwrap();
        let untouched = root.path().join("diaries.sqlite");
        fs::write(&untouched, b"synthetic database").unwrap();
        let path;
        {
            let batch = TransferBatch::new(root.path()).unwrap();
            path = batch.directory.clone();
            fs::write(path.join("synthetic.zip"), b"synthetic archive").unwrap();
        }
        assert!(!path.exists());
        assert_eq!(fs::read(untouched).unwrap(), b"synthetic database");
    }

    #[test]
    fn confirmed_scan_survives_until_next_start_without_deleting_other_folders() {
        let root = tempfile::tempdir().unwrap();
        let retained;
        {
            let mut batch = TransferBatch::new(root.path()).unwrap();
            retained = batch.directory.clone();
            fs::write(retained.join("import.zip"), b"synthetic").unwrap();
            batch.preserve();
        }
        assert!(retained.is_dir());
        let other = root.path().join("mobile-transfers/user-chosen-folder");
        fs::create_dir(&other).unwrap();
        reset_transfer_directory(root.path()).unwrap();
        assert!(!retained.exists());
        assert!(other.exists());
    }

    #[test]
    fn abandoned_scans_are_bounded() {
        let root = tempfile::tempdir().unwrap();
        for _ in 0..MAX_RETAINED_BATCHES {
            TransferBatch::new(root.path()).unwrap().preserve();
        }
        assert!(TransferBatch::new(root.path()).is_err());
    }
}
