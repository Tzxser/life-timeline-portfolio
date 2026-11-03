use super::*;
use crate::{attachment_service, scan_zip, ImportAttachmentRequest};
use std::sync::atomic::{AtomicBool, Ordering};

fn offered(version: &str) -> AvailableUpdate {
    AvailableUpdate {
        token: Uuid::new_v4().to_string(),
        version: version.into(),
        notes: "合成更新验收说明".into(),
        published_at: None,
    }
}

#[test]
fn release_source_requires_the_exact_https_origin_and_an_installer_path() {
    for accepted in [
        "https://life-timeline.xinciqq.top/downloads/life-timeline_0.2.0_x64-setup.exe",
        "https://life-timeline.xinciqq.top:443/downloads/0.2.0/setup.exe",
    ] {
        assert!(validate_download_url(&Url::parse(accepted).unwrap()).is_ok());
    }
    for denied in [
        "http://life-timeline.xinciqq.top/downloads/setup.exe",
        "https://life-timeline.xinciqq.top.evil.test/downloads/setup.exe",
        "https://evil.test/downloads/setup.exe",
        "https://life-timeline.xinciqq.top:8443/downloads/setup.exe",
        "https://user@life-timeline.xinciqq.top/downloads/setup.exe",
        "https://user:password@life-timeline.xinciqq.top/downloads/setup.exe",
        "https://life-timeline.xinciqq.top/other/setup.exe",
        "https://life-timeline.xinciqq.top/downloads/../setup.exe",
        "https://life-timeline.xinciqq.top/downloads/setup.exe?redirect=evil",
        "https://life-timeline.xinciqq.top/downloads/setup.exe#fragment",
        "https://life-timeline.xinciqq.top/downloads/setup.zip",
        "https://life-timeline.xinciqq.top/downloads/%2e%2e/setup.exe",
        "file:///C:/setup.exe",
    ] {
        assert!(
            validate_download_url(&Url::parse(denied).unwrap()).is_err(),
            "accepted {denied}"
        );
    }
}

#[test]
fn version_policy_denies_same_older_invalid_and_prerelease_updates() {
    assert!(strictly_newer("0.2.0", "0.2.1"));
    assert!(strictly_newer("0.2.0", "0.10.0"));
    for version in ["0.1.9", "0.2.0", "garbage", "0.2.1-beta.1", "0.2.0+build.2"] {
        assert!(!strictly_newer("0.2.0", version), "accepted {version}");
    }
}

#[test]
fn ignored_version_is_saved_locally_and_the_following_release_is_offered() {
    let root = tempfile::tempdir().unwrap();
    let preferences = UpdatePreferences {
        ignored_version: Some("0.2.1".into()),
        automatic_check: false,
        ..UpdatePreferences::default()
    };
    write_preferences(root.path(), &preferences).unwrap();
    let loaded = read_preferences(root.path()).unwrap();
    assert!(!loaded.automatic_check);
    assert_eq!(loaded.ignored_version.as_deref(), Some("0.2.1"));
    let skipped = available_info_result(&offered("0.2.1"), "0.2.0", &loaded, false);
    assert_eq!(skipped.status, "ignored");
    assert!(skipped.update.is_none());
    let manual = available_info_result(&offered("0.2.1"), "0.2.0", &loaded, true);
    assert_eq!(manual.status, "available");
    let next = available_info_result(&offered("0.2.2"), "0.2.0", &loaded, false);
    assert_eq!(next.status, "available");
    assert_eq!(next.update.unwrap().version, "0.2.2");
}

#[test]
fn preferences_round_trip_replaces_the_file_and_never_creates_sqlite() {
    let root = tempfile::tempdir().unwrap();
    assert!(read_preferences(root.path()).unwrap().automatic_check);
    assert!(!root.path().join("updates").exists());
    let mut preferences = UpdatePreferences::default();
    write_preferences(root.path(), &preferences).unwrap();
    preferences.automatic_check = false;
    preferences.last_checked_at = Some(Utc::now().to_rfc3339());
    write_preferences(root.path(), &preferences).unwrap();
    assert!(!read_preferences(root.path()).unwrap().automatic_check);
    assert!(!root.path().join("life.sqlite").exists());
    assert_eq!(
        fs::read_dir(root.path().join("updates")).unwrap().count(),
        1
    );
}

#[test]
fn corrupt_update_preferences_fail_closed_without_resetting_user_choice() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("updates").join("preferences.json");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    for bad in [
        "{broken",
        r#"{"schemaVersion":9,"automaticCheck":false,"ignoredVersion":null,"lastCheckedAt":null}"#,
        r#"{"schemaVersion":1,"automaticCheck":false,"ignoredVersion":"wrong","lastCheckedAt":null}"#,
        r#"{"schemaVersion":1,"automaticCheck":false,"ignoredVersion":null,"lastCheckedAt":"yesterday"}"#,
    ] {
        fs::write(&path, bad).unwrap();
        assert!(read_preferences(root.path()).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), bad);
    }
    fs::write(&path, vec![b' '; SETTINGS_MAX_BYTES as usize + 1]).unwrap();
    assert!(read_preferences(root.path()).is_err());
}

#[test]
fn automatic_checks_are_rate_limited_across_process_restarts() {
    let root = tempfile::tempdir().unwrap();
    let now = Utc::now();
    let mut preferences = UpdatePreferences::default();
    assert!(!automatic_recent(&preferences, now));
    preferences.last_check_succeeded = true;
    preferences.last_checked_at = Some((now - chrono::Duration::minutes(30)).to_rfc3339());
    write_preferences(root.path(), &preferences).unwrap();
    assert!(automatic_recent(
        &read_preferences(root.path()).unwrap(),
        now
    ));
    preferences.last_checked_at = Some((now - chrono::Duration::hours(6)).to_rfc3339());
    assert!(!automatic_recent(&preferences, now));
    // A clock that was corrected backwards must not suppress updates forever.
    preferences.last_checked_at = Some((now + chrono::Duration::days(1)).to_rfc3339());
    assert!(!automatic_recent(&preferences, now));
    preferences.last_check_succeeded = false;
    preferences.last_checked_at = Some((now - chrono::Duration::seconds(59)).to_rfc3339());
    assert!(automatic_recent(&preferences, now));
    preferences.last_checked_at = Some((now - chrono::Duration::minutes(2)).to_rfc3339());
    assert!(!automatic_recent(&preferences, now));
}

#[test]
fn only_exact_unexpired_native_tokens_are_accepted() {
    let token = Uuid::new_v4().to_string();
    assert!(token_valid(&token, &token, Instant::now()));
    assert!(!token_valid(
        &token,
        &Uuid::new_v4().to_string(),
        Instant::now()
    ));
    assert!(!token_valid(
        "arbitrary-input",
        "arbitrary-input",
        Instant::now()
    ));
    assert!(!token_valid(
        &token,
        &token,
        Instant::now() - TOKEN_LIFETIME - Duration::from_secs(1)
    ));
}

#[test]
fn quick_restart_after_offline_check_keeps_the_short_retry_policy() {
    let preferences = UpdatePreferences {
        last_checked_at: Some((Utc::now() - chrono::Duration::seconds(30)).to_rfc3339()),
        last_check_succeeded: false,
        ..UpdatePreferences::default()
    };
    let fresh_runtime = UpdateRuntime::default();
    assert!(automatic_recent(&preferences, Utc::now()));
    assert_eq!(
        recent_result_status(&fresh_runtime, &preferences),
        "offline"
    );
    let successful = UpdatePreferences {
        last_check_succeeded: true,
        ..preferences
    };
    assert_eq!(
        recent_result_status(&fresh_runtime, &successful),
        "throttled"
    );
}

#[test]
fn install_callback_only_runs_after_a_verified_local_backup_with_original_attachment() {
    let root = tempfile::tempdir().unwrap();
    let state = AppState::open(root.path().to_path_buf()).unwrap();
    let request = ImportAttachmentRequest {
        name: "synthetic.txt".into(),
        mime_type: "text/plain".into(),
        kind: Some("file".into()),
        last_modified: None,
        width: None,
        height: None,
        bytes: b"synthetic original attachment".to_vec(),
    };
    {
        let mut repository = state.repository.lock().unwrap();
        attachment_service::import(&mut repository, root.path(), &request).unwrap();
    }
    write_preferences(root.path(), &UpdatePreferences::default()).unwrap();
    fs::write(
        root.path().join("api-profiles.json"),
        "SYNTHETIC-PRIVATE-API-SETTINGS",
    )
    .unwrap();
    let invoked = AtomicBool::new(false);
    with_install_backup(&state, "0.2.1", || {
        let backups = fs::read_dir(root.path().join("backups"))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(backups.len(), 1);
        let path = backups[0].path();
        assert!(path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("before-update-0.2.1-"));
        let (_, _, counts) = scan_zip(&path).unwrap();
        assert_eq!(counts.attachments, 1);
        let mut zip = zip::ZipArchive::new(File::open(&path).unwrap()).unwrap();
        for index in 0..zip.len() {
            let mut item = zip.by_index(index).unwrap();
            assert_ne!(item.name(), "api-profiles.json");
            assert!(!item.name().starts_with("updates/"));
            let mut content = String::new();
            item.read_to_string(&mut content).unwrap();
            assert!(!content.contains("SYNTHETIC-PRIVATE-API-SETTINGS"));
        }
        // The last callback cannot race a new queued database mutation.
        assert!(state.repository.try_lock().is_err());
        invoked.store(true, Ordering::SeqCst);
        Ok(())
    })
    .unwrap();
    assert!(invoked.load(Ordering::SeqCst));
    assert!(!state.allow_close.load(Ordering::SeqCst));
    assert_eq!(
        fs::read_to_string(root.path().join("api-profiles.json")).unwrap(),
        "SYNTHETIC-PRIVATE-API-SETTINGS"
    );
}

#[test]
fn failed_backup_does_not_launch_an_installer_or_allow_window_close() {
    let root = tempfile::tempdir().unwrap();
    let state = AppState::open(root.path().to_path_buf()).unwrap();
    // A regular file occupying the backup directory is a real filesystem error.
    fs::remove_dir(root.path().join("backups")).unwrap();
    fs::write(root.path().join("backups"), "synthetic blocker").unwrap();
    let invoked = AtomicBool::new(false);
    let result = with_install_backup(&state, "0.2.1", || {
        invoked.store(true, Ordering::SeqCst);
        Ok(())
    });
    assert_eq!(result.unwrap_err().code, "update.backup");
    assert!(!invoked.load(Ordering::SeqCst));
    assert!(!state.allow_close.load(Ordering::SeqCst));
    assert!(state.repository.lock().unwrap().load_snapshot().is_ok());
}

#[test]
fn failed_installer_launch_preserves_library_and_recovery_backup() {
    let root = tempfile::tempdir().unwrap();
    let state = AppState::open(root.path().to_path_buf()).unwrap();
    let before = state
        .repository
        .lock()
        .unwrap()
        .snapshot_revision()
        .unwrap();
    let result: Result<(), CommandError> = with_install_backup(&state, "0.2.1", || {
        Err(error("update.install", "synthetic launch failure"))
    });
    assert_eq!(result.unwrap_err().code, "update.install");
    assert!(!state.allow_close.load(Ordering::SeqCst));
    assert_eq!(
        state
            .repository
            .lock()
            .unwrap()
            .snapshot_revision()
            .unwrap(),
        before
    );
    let backup = fs::read_dir(root.path().join("backups"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    assert!(scan_zip(&backup).is_ok());
}
