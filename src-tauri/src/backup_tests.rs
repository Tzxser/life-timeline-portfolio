//! Integration-style tests for the local backup boundary.
//!
//! These tests deliberately exercise the same private functions used by the
//! Tauri commands.  They create a real SQLite-backed `AppState`, write real
//! ZIP archives and use temporary directories, so a passing test does not
//! merely prove that a fixture can be deserialized.

use super::*;
use std::thread;
use std::time::Duration;

fn temp_root(label: &str) -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix(&format!("life-timeline-{label}-"))
        .tempdir()
        .expect("temporary test directory")
}

fn empty_archive(state: &AppState, destination: &Path) {
    export_archive(state, destination, false).expect("export empty archive");
}

fn auto_backup_count(root: &Path) -> usize {
    fs::read_dir(root.join("backups"))
        .expect("backups directory")
        .filter_map(Result::ok)
        .filter(|entry| {
            entry.file_type().is_ok_and(|kind| kind.is_file())
                && entry.file_name().to_string_lossy().starts_with("auto-")
                && entry.path().extension().and_then(|value| value.to_str()) == Some("zip")
        })
        .count()
}

fn write_archive_entries(entries: &[(&str, &[u8])]) -> PathBuf {
    let path = std::env::temp_dir().join(format!("life-timeline-archive-{}.zip", Uuid::new_v4()));
    let file = File::create(&path).expect("archive file");
    let mut zip = ZipWriter::new(file);
    for (name, bytes) in entries {
        write_zip_file(&mut zip, name, bytes).expect("archive entry");
    }
    zip.finish().expect("finish archive");
    path
}

#[test]
fn export_and_scan_use_a_real_sqlite_library_and_attachment() {
    let root = temp_root("export-scan");
    let state = AppState::open(root.path().to_path_buf()).expect("open app state");
    let request = ImportAttachmentRequest {
        name: "note.txt".into(),
        mime_type: "text/plain".into(),
        kind: Some("file".into()),
        last_modified: None,
        width: None,
        height: None,
        bytes: b"local attachment".to_vec(),
    };
    {
        let mut repository = state.repository.lock().expect("repository lock");
        attachment_service::import(&mut repository, &state.root, &request)
            .expect("import attachment into SQLite and disk");
    }

    let destination = root.path().join("export.zip");
    let result = export_archive(&state, &destination, false).expect("export archive");
    assert_eq!(result.entries, 3, "life, manifest, and one physical blob");
    let (life, manifest, counts) = scan_zip(&destination).expect("scan exported archive");
    assert_eq!(counts.attachments, 1);
    assert_eq!(counts.events, 0);
    assert_eq!(counts.stages, 0);
    assert_eq!(life["databaseId"], manifest["databaseId"]);
    assert!(destination.is_file());
}

#[test]
fn scan_rejects_a_corrupted_archive_after_export() {
    let root = temp_root("corrupt-scan");
    let state = AppState::open(root.path().to_path_buf()).expect("open app state");
    let destination = root.path().join("export.zip");
    empty_archive(&state, &destination);
    let mut bytes = fs::read(&destination).expect("read archive");
    let last = bytes.last_mut().expect("non-empty ZIP");
    *last ^= 0x5a;
    fs::write(&destination, bytes).expect("corrupt archive");

    assert!(
        scan_zip(&destination).is_err(),
        "corrupt ZIP must be rejected"
    );
}

#[test]
fn daily_backup_retains_the_latest_fourteen_archives() {
    let root = temp_root("retention");
    let state = AppState::open(root.path().to_path_buf()).expect("open app state");
    let backups = root.path().join("backups");
    fs::create_dir_all(&backups).expect("backups directory");

    // Make fourteen complete historical archives, oldest first.  The short
    // delay gives filesystems with coarse timestamp precision enough signal
    // for the production retention sort.
    for index in 0..14 {
        let path = backups.join(format!("auto-202601{:02}.zip", index + 1));
        empty_archive(&state, &path);
        thread::sleep(Duration::from_millis(20));
    }
    let today = backups.join(format!("auto-{}.zip", Utc::now().format("%Y%m%d")));
    empty_archive(&state, &today);
    assert_eq!(auto_backup_count(root.path()), 15);

    run_daily_backup(&state).expect("daily retention");
    assert_eq!(auto_backup_count(root.path()), 14);
    assert!(today.is_file(), "the current valid backup must be retained");
    assert!(read_auto_backup_success(root.path()).is_some());
}

#[test]
fn daily_backup_rejects_a_corrupt_current_archive_before_pruning() {
    let root = temp_root("retention-corrupt");
    let state = AppState::open(root.path().to_path_buf()).expect("open app state");
    let backups = root.path().join("backups");
    fs::create_dir_all(&backups).expect("backups directory");
    for index in 0..14 {
        let path = backups.join(format!("auto-202601{:02}.zip", index + 1));
        fs::write(path, b"historical placeholder").expect("historical archive");
    }
    let today = backups.join(format!("auto-{}.zip", Utc::now().format("%Y%m%d")));
    fs::write(&today, b"not a ZIP archive").expect("corrupt current archive");
    assert_eq!(auto_backup_count(root.path()), 15);

    let error = run_daily_backup(&state).expect_err("corrupt current archive must fail");
    assert_eq!(error.code, "backup.zip");
    assert_eq!(
        auto_backup_count(root.path()),
        15,
        "failure must not prune history"
    );
    assert!(read_auto_backup_failure(root.path()).is_some());
}

#[test]
fn recovery_marker_removes_only_orphaned_materialized_attachment() {
    let root = temp_root("recovery");
    let state = AppState::open(root.path().to_path_buf()).expect("open app state");
    let request = ImportAttachmentRequest {
        name: "kept.txt".into(),
        mime_type: "text/plain".into(),
        kind: Some("file".into()),
        last_modified: None,
        width: None,
        height: None,
        bytes: b"referenced".to_vec(),
    };
    let referenced = {
        let mut repository = state.repository.lock().expect("repository lock");
        attachment_service::import(&mut repository, &state.root, &request)
            .expect("import referenced attachment")
            .relative_path
    };

    let orphan_relative = "attachments/ff/recovery-orphan.bin";
    let orphan = attachment_service::controlled_path(&state.root, orphan_relative)
        .expect("controlled orphan path");
    fs::create_dir_all(orphan.parent().expect("orphan parent")).expect("orphan directory");
    fs::write(&orphan, b"orphan").expect("orphan file");
    let staging = state.root.join("staging/restore-recovery-test");
    fs::create_dir_all(&staging).expect("staging directory");
    fs::write(staging.join("partial"), b"partial").expect("staging file");

    let marker_path = recovery_marker_path(&state.root, "recovery-test");
    write_recovery_marker(
        &marker_path,
        &RestoreRecoveryMarker {
            staging_path: "staging/restore-recovery-test".into(),
            materialized_paths: vec![referenced.clone(), orphan_relative.into()],
        },
    )
    .expect("recovery marker");
    {
        let repository = state.repository.lock().expect("repository lock");
        recover_pending_restores(&state.root, &repository).expect("recover pending restore");
    }

    let kept = attachment_service::controlled_path(&state.root, &referenced)
        .expect("controlled referenced path");
    assert!(
        kept.is_file(),
        "referenced attachment must survive recovery"
    );
    assert!(
        !orphan.exists(),
        "unreferenced materialized file must be removed"
    );
    assert!(!staging.exists(), "staging tree must be removed");
    assert!(!marker_path.exists(), "marker must be consumed");
}

#[test]
fn empty_library_export_is_a_valid_zero_record_backup() {
    let root = temp_root("empty-export");
    let state = AppState::open(root.path().to_path_buf()).expect("open app state");
    let destination = root.path().join("empty.zip");
    let result = export_archive(&state, &destination, false).expect("empty export");
    assert_eq!(result.entries, 2);
    let (_life, _manifest, counts) = scan_zip(&destination).expect("scan empty export");
    assert_eq!(counts.events, 0);
    assert_eq!(counts.stages, 0);
    assert_eq!(counts.attachments, 0);
}

#[test]
fn malicious_archive_paths_are_rejected_before_json_processing() {
    let path = write_archive_entries(&[("../escape.txt", b"blocked")]);
    let error = scan_zip(&path).expect_err("Zip Slip member must be rejected");
    assert_eq!(error.code, "security.path_denied");
    let _ = fs::remove_file(path);

    for value in [
        "relative.zip",
        // A drive-relative path is not an absolute picker result.  A normal
        // `C:\Users\...` path is a valid local backup destination and must
        // remain accepted by `validate_user_archive_path`.
        r"C:Users\Public\backup.zip",
        r"\\?\\C:\\backup.zip",
        r"\\.\\PIPE\\backup.zip",
    ] {
        assert!(
            validate_user_archive_path(value).is_err(),
            "unsafe destination must be rejected: {value}"
        );
    }
}
