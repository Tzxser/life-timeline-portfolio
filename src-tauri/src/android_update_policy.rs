//! Pure Android update decisions, also compiled by host-side regression tests.
use crate::models::CommandError;
use semver::Version;

pub(super) fn release_is_newer(current: &str, announced: &str) -> Result<bool, CommandError> {
    let invalid = || CommandError {
        code: "update.version".into(),
        message: "更新版本号无效或不是正式版本，已停止更新。".into(),
    };
    if current.len() > 80 || announced.len() > 80 {
        return Err(invalid());
    }
    let current = Version::parse(current).map_err(|_| invalid())?;
    let announced = Version::parse(announced).map_err(|_| invalid())?;
    if !announced.pre.is_empty() {
        return Err(invalid());
    }
    // A valid equal/older release is a successful check with nothing to install.
    Ok(announced.cmp_precedence(&current).is_gt())
}

pub(super) fn require_newer_release(current: &str, announced: &str) -> Result<(), CommandError> {
    if release_is_newer(current, announced)? {
        Ok(())
    } else {
        Err(CommandError {
            code: "update.version".into(),
            message: "更新包不是更新的正式版本，已停止更新。".into(),
        })
    }
}

pub(super) fn recent_result_status(
    last_result: Option<&'static str>,
    last_check_succeeded: bool,
) -> &'static str {
    match last_result {
        Some("upToDate") => "upToDate",
        Some("offline") => "offline",
        None if !last_check_succeeded => "offline",
        _ => "throttled",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn equal_and_older_releases_are_successful_checks_without_an_update() {
        for (current, announced) in [
            ("0.2.14", "0.2.14"),
            ("0.2.15", "0.2.14"),
            ("0.2.14+local", "0.2.14"),
            ("0.2.14", "0.2.14+release"),
        ] {
            assert!(!release_is_newer(current, announced).unwrap());
        }
    }

    #[test]
    fn new_stable_releases_are_available_in_semver_order() {
        assert!(release_is_newer("0.2.9", "0.2.14").unwrap());
        assert!(release_is_newer("0.2.14", "0.3.0").unwrap());
        assert!(release_is_newer("0.3.0-beta.1", "0.3.0").unwrap());
    }

    #[test]
    fn malformed_or_prerelease_announcements_never_count_as_up_to_date() {
        for announced in ["", "0.2", "v0.2.14", "0.3.0-beta.1", "0.2.14\n"] {
            assert_eq!(
                release_is_newer("0.3.0", announced).unwrap_err().code,
                "update.version"
            );
        }
        assert!(release_is_newer("invalid", "0.2.14").is_err());
        assert!(release_is_newer("0.2.14", &"1".repeat(81)).is_err());
    }

    #[test]
    fn download_and_install_still_require_a_strictly_newer_release() {
        require_newer_release("0.2.13", "0.2.14").unwrap();
        for announced in ["0.2.14", "0.2.13", "0.3.0-beta.1"] {
            assert_eq!(
                require_newer_release("0.2.14", announced).unwrap_err().code,
                "update.version"
            );
        }
    }

    #[test]
    fn repeat_checks_keep_the_successful_up_to_date_result() {
        assert_eq!(recent_result_status(Some("upToDate"), true), "upToDate");
        // A restarted process has no in-memory release/token; do not invent one.
        assert_eq!(recent_result_status(None, true), "throttled");
        assert_eq!(recent_result_status(Some("available"), true), "throttled");
    }

    #[test]
    fn offline_result_and_persisted_failure_keep_the_short_retry_policy() {
        assert_eq!(recent_result_status(Some("offline"), false), "offline");
        assert_eq!(recent_result_status(None, false), "offline");
    }
}
