//! Security helpers shared by the local archive and attachment services.
//!
//! The desktop process accepts paths from a file picker and archive member
//! names from an untrusted ZIP.  This module deliberately keeps all of the
//! checks independent from Tauri so they can be unit tested on every target.
//! In particular, `Path::is_absolute` alone is not sufficient on Unix when a
//! Windows archive (`C:\\foo`, `\\\\server\\share`) is imported.
#![allow(dead_code)]

use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};

use serde_json::Value;
use sha2::{Digest, Sha256};

/// Conservative limits for a backup archive.  They are intentionally bounded
/// before extraction so a small ZIP cannot allocate an unbounded amount of
/// memory or disk space.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ArchiveLimits {
    /// Maximum number of regular files and directories in one archive.
    pub max_entries: usize,
    /// Maximum uncompressed bytes in the whole archive.
    pub max_total_uncompressed: u64,
    /// Maximum uncompressed bytes for a single member.
    pub max_member_uncompressed: u64,
    /// Maximum JSON document size (`life.json` or `manifest.json`).
    pub max_json_bytes: u64,
    /// Maximum object/array nesting depth accepted in JSON.
    pub max_json_depth: usize,
    /// Maximum JSON values visited while validating an archive document.
    pub max_json_nodes: usize,
    /// Maximum compressed-to-uncompressed expansion ratio.
    pub max_compression_ratio: u64,
    /// Maximum UTF-8 path length, in bytes.
    pub max_path_length: usize,
    /// Maximum number of slash-separated path components.
    pub max_path_depth: usize,
    /// Maximum one path component length, in bytes.
    pub max_segment_length: usize,
    /// Maximum number of attachment files in one archive.
    pub max_attachments: usize,
}

impl Default for ArchiveLimits {
    fn default() -> Self {
        Self {
            max_entries: 10_000,
            max_total_uncompressed: 8 * 1024 * 1024 * 1024,
            max_member_uncompressed: 512 * 1024 * 1024,
            max_json_bytes: 128 * 1024 * 1024,
            max_json_depth: 64,
            max_json_nodes: 250_000,
            max_compression_ratio: 200,
            max_path_length: 1024,
            max_path_depth: 32,
            max_segment_length: 255,
            max_attachments: 100_000,
        }
    }
}

/// An error which is safe to show in a UI.  Do not include a complete user
/// path or archive member contents in messages.
#[derive(Debug)]
pub enum SecurityError {
    InvalidPath(String),
    InvalidArchive(String),
    LimitExceeded(String),
    Io(io::Error),
    Json(serde_json::Error),
}

impl std::fmt::Display for SecurityError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidPath(message)
            | Self::InvalidArchive(message)
            | Self::LimitExceeded(message) => f.write_str(message),
            Self::Io(error) => write!(f, "I/O error: {error}"),
            Self::Json(error) => write!(f, "JSON error: {error}"),
        }
    }
}

impl std::error::Error for SecurityError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Json(error) => Some(error),
            _ => None,
        }
    }
}

impl From<io::Error> for SecurityError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<serde_json::Error> for SecurityError {
    fn from(value: serde_json::Error) -> Self {
        Self::Json(value)
    }
}

/// Normalize and validate a member name from a ZIP archive.
///
/// The returned path always uses `/` separators and is relative.  Empty path
/// components are removed so `attachments//a` cannot bypass duplicate-entry
/// checks.  `..`, absolute paths, Windows drive/UNC paths, trailing spaces and
/// reserved DOS device names are rejected.
pub fn validate_archive_path(raw: &str, is_directory: bool) -> Result<String, SecurityError> {
    if raw.is_empty() {
        return Err(SecurityError::InvalidPath("空的归档路径".into()));
    }
    if raw.as_bytes().contains(&0) {
        return Err(SecurityError::InvalidPath("归档路径包含 NUL".into()));
    }
    if raw.len() > ArchiveLimits::default().max_path_length {
        return Err(SecurityError::LimitExceeded("归档路径过长".into()));
    }

    // ZIP names use '/', and accepting '\\' makes it too easy for a later
    // Windows API to turn a harmless-looking path back into traversal.
    if raw.contains('\\') {
        return Err(SecurityError::InvalidPath("归档路径不得包含反斜杠".into()));
    }
    if raw.starts_with('/') || raw.starts_with("//") || has_windows_drive_prefix(raw) {
        return Err(SecurityError::InvalidPath("归档路径必须是相对路径".into()));
    }
    if raw.contains(':') {
        return Err(SecurityError::InvalidPath(
            "归档路径不得包含盘符或 ADS 冒号".into(),
        ));
    }
    if raw.ends_with('/') {
        return Err(SecurityError::InvalidArchive(if is_directory {
            "归档不接受目录条目".into()
        } else {
            "归档文件路径不得以分隔符结尾".into()
        }));
    }

    let mut components = Vec::new();
    let parts = raw.split('/').collect::<Vec<_>>();
    if parts.len() > ArchiveLimits::default().max_path_depth {
        return Err(SecurityError::LimitExceeded("归档路径目录层级过深".into()));
    }
    for component in parts {
        if component.is_empty() {
            return Err(SecurityError::InvalidPath("归档路径包含空路径段".into()));
        }
        if component == ".." {
            return Err(SecurityError::InvalidPath("归档路径包含 ..".into()));
        }
        if component == "." {
            return Err(SecurityError::InvalidPath("归档路径包含 .".into()));
        }
        validate_windows_component(component)?;
        components.push(component);
    }
    if components.is_empty() {
        return Err(SecurityError::InvalidPath("归档路径无有效文件名".into()));
    }
    let normalized = components.join("/");
    if normalized.len() > ArchiveLimits::default().max_path_length {
        return Err(SecurityError::LimitExceeded("归档路径过长".into()));
    }
    Ok(normalized)
}

fn has_windows_drive_prefix(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

fn validate_windows_component(component: &str) -> Result<(), SecurityError> {
    if component.is_empty() {
        return Err(SecurityError::InvalidPath("归档路径有空文件名".into()));
    }
    if component.len() > ArchiveLimits::default().max_segment_length {
        return Err(SecurityError::LimitExceeded("归档路径组件过长".into()));
    }
    if component.ends_with(' ') || component.ends_with('.') || component.contains(':') {
        return Err(SecurityError::InvalidPath(
            "归档路径包含 Windows 非法名称".into(),
        ));
    }
    // Windows rejects control characters even when they are not separators.
    if component.chars().any(|character| character.is_control()) {
        return Err(SecurityError::InvalidPath("归档路径包含控制字符".into()));
    }
    let stem = component.split('.').next().unwrap_or(component);
    let upper = stem.to_ascii_uppercase();
    if matches!(
        upper.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "CLOCK$"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    ) {
        return Err(SecurityError::InvalidPath(
            "归档路径包含 Windows 设备名".into(),
        ));
    }
    Ok(())
}

/// Tracks canonical archive names.  Windows file systems are normally case
/// insensitive, so duplicate checks use a case-folded ASCII key as well as the
/// normalized spelling.
#[derive(Debug, Default)]
pub struct ArchivePathSet {
    names: HashSet<String>,
}

impl ArchivePathSet {
    pub fn insert(&mut self, raw: &str, is_directory: bool) -> Result<String, SecurityError> {
        let normalized = validate_archive_path(raw, is_directory)?;
        let key = normalized.to_ascii_lowercase();
        if !self.names.insert(key) {
            return Err(SecurityError::InvalidArchive(
                "归档包含重复或大小写冲突的路径".into(),
            ));
        }
        Ok(normalized)
    }

    pub fn len(&self) -> usize {
        self.names.len()
    }
}

/// Return true when the Unix mode in a ZIP member describes a symbolic link.
/// ZIPs created on Windows often omit this field; a missing mode is safe.
pub fn zip_member_is_symlink(unix_mode: Option<u32>) -> bool {
    unix_mode
        .map(|mode| mode & 0o170000 == 0o120000)
        .unwrap_or(false)
}

/// Ensure a path is an existing, non-symlink file or directory.  This is used
/// before writing into a user-selected data directory to avoid following a
/// reparse point planted between validation and extraction.
pub fn reject_symlink_components(path: &Path) -> Result<(), SecurityError> {
    let mut current = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => {
                current.push(prefix.as_os_str());
            }
            Component::RootDir => current.push(Path::new(std::path::MAIN_SEPARATOR_STR)),
            Component::CurDir => {}
            Component::ParentDir => {
                current.pop();
            }
            Component::Normal(name) => {
                current.push(name);
                match fs::symlink_metadata(&current) {
                    Ok(metadata) if metadata.file_type().is_symlink() => {
                        return Err(SecurityError::InvalidPath(
                            "数据目录包含符号链接或 reparse point".into(),
                        ))
                    }
                    Ok(_metadata) => {
                        // Windows junctions and other reparse points do not
                        // necessarily report as ordinary symlinks.  Reject
                        // them before extraction so a path cannot redirect a
                        // staging write outside the canonical root.
                        #[cfg(target_os = "windows")]
                        {
                            use std::os::windows::fs::MetadataExt;
                            const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
                            if _metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                                return Err(SecurityError::InvalidPath(
                                    "数据目录包含符号链接或 reparse point".into(),
                                ));
                            }
                        }
                    }
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                    Err(error) => return Err(SecurityError::Io(error)),
                }
            }
        }
    }
    Ok(())
}

/// Lexically join an archive member to a staging root and verify that the
/// resulting path cannot escape it.  The root is canonicalized when it exists;
/// callers should create the staging root before invoking this function.
pub fn safe_join(root: &Path, relative: &str) -> Result<PathBuf, SecurityError> {
    let normalized = validate_archive_path(relative, false)?;
    reject_symlink_components(root)?;
    let root_abs = fs::canonicalize(root).map_err(SecurityError::Io)?;
    let target = root_abs.join(normalized.replace('/', std::path::MAIN_SEPARATOR_STR));
    // This is a lexical check.  Existing target components are separately
    // checked for symlinks by reject_symlink_components before writing.
    if !target.starts_with(&root_abs) {
        return Err(SecurityError::InvalidPath("归档路径越过数据目录".into()));
    }
    Ok(target)
}

/// Hash a byte slice using SHA-256 and return lower-case hexadecimal.
pub fn sha256_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// Stream a file hash without loading the file into memory.
pub fn sha256_file(path: &Path) -> Result<(u64, String), SecurityError> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    let mut size = 0_u64;
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        size = size
            .checked_add(read as u64)
            .ok_or_else(|| SecurityError::LimitExceeded("文件大小溢出".into()))?;
        hasher.update(&buffer[..read]);
    }
    Ok((size, format!("{:x}", hasher.finalize())))
}

/// Copy at most `max_bytes` from a stream and return the exact number copied.
/// The function performs one extra read after the limit so a forged ZIP header
/// cannot hide trailing bytes.
pub fn copy_limited<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    max_bytes: u64,
) -> Result<u64, SecurityError> {
    let mut buffer = vec![0_u8; 1024 * 1024];
    let mut copied = 0_u64;
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        let next = copied
            .checked_add(read as u64)
            .ok_or_else(|| SecurityError::LimitExceeded("文件大小溢出".into()))?;
        if next > max_bytes {
            return Err(SecurityError::LimitExceeded("归档文件超过大小限制".into()));
        }
        writer.write_all(&buffer[..read])?;
        copied = next;
    }
    Ok(copied)
}

/// Validate a JSON document's byte size and nesting depth before deserializing
/// a potentially large user-supplied archive.
pub fn validate_json_bytes(bytes: &[u8], limits: ArchiveLimits) -> Result<Value, SecurityError> {
    if bytes.len() as u64 > limits.max_json_bytes {
        return Err(SecurityError::LimitExceeded("JSON 文件超过大小限制".into()));
    }
    let value: Value = serde_json::from_slice(bytes)?;
    let (depth, nodes) = json_shape(&value, 0, limits.max_json_depth);
    if depth > limits.max_json_depth {
        return Err(SecurityError::LimitExceeded("JSON 嵌套层级过深".into()));
    }
    if nodes > limits.max_json_nodes {
        return Err(SecurityError::LimitExceeded("JSON 节点数量超过限制".into()));
    }
    Ok(value)
}

fn json_shape(value: &Value, depth: usize, depth_limit: usize) -> (usize, usize) {
    // Stop descending once the configured limit is crossed.  We only need to
    // report that the document is too deep; walking an attacker-controlled
    // thousand-level tree would otherwise risk overflowing the Rust stack
    // before the caller gets a chance to reject it.
    if depth > depth_limit {
        return (depth + 1, 1);
    }
    match value {
        Value::Array(items) => {
            let mut max_depth = depth + 1;
            let mut nodes: usize = 1;
            for item in items {
                let (child_depth, child_nodes) = json_shape(item, depth + 1, depth_limit);
                max_depth = max_depth.max(child_depth);
                nodes = nodes.saturating_add(child_nodes);
            }
            (max_depth, nodes)
        }
        Value::Object(items) => {
            let mut max_depth = depth + 1;
            let mut nodes: usize = 1;
            for item in items.values() {
                let (child_depth, child_nodes) = json_shape(item, depth + 1, depth_limit);
                max_depth = max_depth.max(child_depth);
                nodes = nodes.saturating_add(child_nodes);
            }
            (max_depth, nodes)
        }
        _ => (depth + 1, 1),
    }
}

/// Create a file without following an existing destination.  This is used for
/// archive extraction; replacing a path is never implicit.
pub fn create_new_file(path: &Path) -> Result<File, SecurityError> {
    reject_symlink_components(path.parent().unwrap_or_else(|| Path::new(".")))?;
    Ok(OpenOptions::new().write(true).create_new(true).open(path)?)
}

/// Publish a verified independent copy, without hard links or replacing an
/// existing destination. Android app storage may disallow hard links even
/// when both directories are writable. The source is only ever opened for
/// reading, and SQLite callers must register the blob only after this returns.
///
/// `on_created` runs only after create_new succeeds, before any bytes are
/// copied. It lets the caller track ownership for rollback/recovery even if
/// copying fails and immediate removal of the partial file also fails.
pub fn copy_new_file_verified(
    source: &Path,
    destination: &Path,
    expected_size: u64,
    expected_sha256: &str,
    on_created: impl FnOnce(),
) -> Result<(), SecurityError> {
    reject_symlink_components(source)?;
    let mut input =
        File::open(source).map_err(|cause| copy_operation_error("读取附件源文件", cause.into()))?;
    if !input.metadata()?.is_file() {
        return Err(SecurityError::InvalidPath("附件源必须是普通文件".into()));
    }
    copy_reader_to_new_verified(
        &mut input,
        destination,
        expected_size,
        expected_sha256,
        on_created,
        File::sync_all,
    )
}

fn copy_operation_error(operation: &str, cause: SecurityError) -> SecurityError {
    match cause {
        SecurityError::Io(cause) => SecurityError::Io(io::Error::new(
            cause.kind(),
            format!("{operation}: {cause}"),
        )),
        other => other,
    }
}

fn copy_reader_to_new_verified(
    input: &mut impl Read,
    destination: &Path,
    expected_size: u64,
    expected_sha256: &str,
    on_created: impl FnOnce(),
    synchronize: impl FnOnce(&File) -> io::Result<()>,
) -> Result<(), SecurityError> {
    let mut output = create_new_file(destination)
        .map_err(|cause| copy_operation_error("创建附件副本", cause))?;
    on_created();
    let result = (|| {
        let size = copy_limited(input, &mut output, expected_size)
            .map_err(|cause| copy_operation_error("复制附件", cause))?;
        if size != expected_size {
            return Err(SecurityError::InvalidArchive("附件副本大小校验失败".into()));
        }
        synchronize(&output).map_err(|cause| copy_operation_error("同步附件副本", cause.into()))?;
        let (size, hash) = sha256_file(destination)
            .map_err(|cause| copy_operation_error("校验附件副本", cause))?;
        if size != expected_size || hash != expected_sha256 {
            return Err(SecurityError::InvalidArchive(
                "附件副本 hash 校验失败".into(),
            ));
        }
        Ok(())
    })();
    // Close our handle before cleanup on Windows. A create_new error returns
    // above and must never enter this cleanup or call the ownership callback.
    drop(output);
    if result.is_err() {
        let _ = fs::remove_file(destination);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verified_copy_has_independent_bytes_and_never_changes_the_source() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.bin");
        let destination = directory.path().join("published.bin");
        let original = b"private synthetic attachment bytes";
        fs::write(&source, original).unwrap();
        let mut created = false;
        copy_new_file_verified(
            &source,
            &destination,
            original.len() as u64,
            &sha256_bytes(original),
            || created = true,
        )
        .unwrap();
        assert!(created);
        assert_eq!(fs::read(&source).unwrap(), original);
        assert_eq!(
            sha256_file(&destination).unwrap(),
            (original.len() as u64, sha256_bytes(original))
        );
        // A hard link would silently alter the published blob here.
        fs::write(&source, b"changed source after publication").unwrap();
        assert_eq!(fs::read(&destination).unwrap(), original);
        fs::remove_file(&source).unwrap();
        assert_eq!(fs::read(&destination).unwrap(), original);
    }

    #[test]
    fn verified_copy_does_not_overwrite_or_clean_an_existing_target() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.bin");
        let destination = directory.path().join("existing.bin");
        fs::write(&source, b"new bytes").unwrap();
        fs::write(&destination, b"must survive unchanged").unwrap();
        let mut created = false;
        let result = copy_new_file_verified(
            &source,
            &destination,
            9,
            &sha256_bytes(b"new bytes"),
            || created = true,
        );
        assert!(result.is_err());
        assert!(
            !created,
            "create_new failure does not grant cleanup ownership"
        );
        assert_eq!(fs::read(&destination).unwrap(), b"must survive unchanged");
        assert_eq!(fs::read(&source).unwrap(), b"new bytes");
    }

    #[test]
    fn verified_copy_removes_only_its_partial_file_after_a_read_failure() {
        struct PartialThenDenied(bool);
        impl Read for PartialThenDenied {
            fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
                if self.0 {
                    return Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        "synthetic read denial",
                    ));
                }
                self.0 = true;
                output[..4].copy_from_slice(b"part");
                Ok(4)
            }
        }
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("partial.bin");
        let unrelated = directory.path().join("unrelated.bin");
        fs::write(&unrelated, b"keep").unwrap();
        let mut created = false;
        let error = copy_reader_to_new_verified(
            &mut PartialThenDenied(false),
            &destination,
            8,
            &sha256_bytes(b"partmore"),
            || created = true,
            File::sync_all,
        )
        .unwrap_err();
        assert!(
            created,
            "rollback must know this target was created before failure"
        );
        assert!(error.to_string().contains("复制附件"));
        assert!(!destination.exists());
        assert_eq!(fs::read(unrelated).unwrap(), b"keep");
    }

    #[test]
    fn verified_copy_cleans_failed_size_and_hash_checks() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.bin");
        fs::write(&source, b"bytes").unwrap();
        for (name, expected_size, expected_hash) in [
            ("too-short", 6, sha256_bytes(b"bytes")),
            ("too-long", 4, sha256_bytes(b"byte")),
            ("wrong-hash", 5, sha256_bytes(b"other")),
        ] {
            let destination = directory.path().join(name);
            let mut created = false;
            assert!(copy_new_file_verified(
                &source,
                &destination,
                expected_size,
                &expected_hash,
                || created = true,
            )
            .is_err());
            assert!(created);
            assert!(
                !destination.exists(),
                "failed verification must remove its own copy"
            );
            assert_eq!(fs::read(&source).unwrap(), b"bytes");
        }
    }

    #[test]
    fn verified_copy_sync_failure_is_not_reported_as_success() {
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("unsynced.bin");
        let mut created = false;
        let error = copy_reader_to_new_verified(
            &mut io::Cursor::new(b"bytes"),
            &destination,
            5,
            &sha256_bytes(b"bytes"),
            || created = true,
            |_| {
                Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "synthetic sync denial",
                ))
            },
        )
        .unwrap_err();
        assert!(created);
        assert!(error.to_string().contains("同步附件副本"));
        assert!(!destination.exists());
    }

    #[cfg(unix)]
    #[test]
    fn verified_copy_rejects_symbolic_source_and_destination() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.bin");
        let source_link = directory.path().join("source-link.bin");
        let destination = directory.path().join("destination.bin");
        fs::write(&source, b"source").unwrap();
        symlink(&source, &source_link).unwrap();
        assert!(copy_new_file_verified(
            &source_link,
            &destination,
            6,
            &sha256_bytes(b"source"),
            || {}
        )
        .is_err());
        assert!(!destination.exists());
        symlink(&source, &destination).unwrap();
        assert!(
            copy_new_file_verified(&source, &destination, 6, &sha256_bytes(b"source"), || {})
                .is_err()
        );
        assert!(fs::symlink_metadata(&destination)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read(&source).unwrap(), b"source");
    }

    #[test]
    fn rejects_unix_and_windows_traversal() {
        for value in [
            "../secret",
            "a/../../secret",
            "/etc/passwd",
            "C:/secret",
            "C:\\secret",
            "\\\\server\\share\\x",
            "a\\..\\secret",
        ] {
            assert!(validate_archive_path(value, false).is_err(), "{value}");
        }
    }

    #[test]
    fn rejects_device_names_and_invalid_windows_forms() {
        for value in ["CON", "con.txt", "NUL", "Lpt9.log", "foo.", "foo ", "a:b"] {
            assert!(validate_archive_path(value, false).is_err(), "{value}");
        }
        assert!(validate_archive_path("照片/你好.png", false).is_ok());
    }

    #[test]
    fn detects_case_collisions() {
        let mut paths = ArchivePathSet::default();
        paths.insert("attachments/A.png", false).unwrap();
        assert!(paths.insert("attachments/a.PNG", false).is_err());
    }

    #[test]
    fn validates_json_depth() {
        let limits = ArchiveLimits {
            max_json_depth: 2,
            ..ArchiveLimits::default()
        };
        assert!(validate_json_bytes(br#"{"a":{"b":1}}"#, limits).is_err());
        assert!(validate_json_bytes(br#"{"a":1}"#, limits).is_ok());
    }

    #[test]
    fn hashes_bytes() {
        assert_eq!(
            sha256_bytes(b"life-timeline"),
            "292d6e81652342f8bdab0c6810a24986b7705c7adf243a7a791050fbf6c2e2ca"
        );
    }
}
