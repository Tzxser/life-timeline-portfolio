//! Content-addressed attachment storage. The browser only receives logical IDs
//! and an asset URL under the scoped `attachments/` directory; it never gets a
//! command that can read an arbitrary path.

use crate::models::{
    validate_import, AttachmentMeta, ImportAttachmentRequest, ImportAttachmentResponse,
    SaveAttachmentAsRequest, StorageError,
};
use crate::repository::{RegisteredAttachment, Repository};
use crate::security::{sha256_bytes, sha256_file};
use chrono::Utc;
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub const ATTACHMENTS_DIR: &str = "attachments";

/// Keep this list in sync with the renderer intake guard.  The native side
/// repeats the check because IPC callers are not trusted and a MIME type is
/// not a safe indication that a file cannot be executed by Windows.
const BLOCKED_EXTENSIONS: &[&str] = &[
    "exe", "msi", "msp", "bat", "cmd", "com", "scr", "pif", "cpl", "ps1", "vbs", "vbe", "wsf",
    "wsh", "hta", "jar", "apk", "app",
];

pub fn prepare_directories(data_root: &Path) -> Result<(), StorageError> {
    for directory in [
        ATTACHMENTS_DIR,
        "thumbnails",
        "staging",
        "backups",
        "recovery",
    ] {
        fs::create_dir_all(data_root.join(directory))?;
    }
    Ok(())
}

pub fn import(
    repository: &mut Repository,
    data_root: &Path,
    request: &ImportAttachmentRequest,
) -> Result<ImportAttachmentResponse, StorageError> {
    validate_import(request)?;
    if let Some(extension) = file_extension(&request.name) {
        if BLOCKED_EXTENSIONS.contains(&extension.as_str()) {
            return Err(StorageError::Invalid(
                "出于安全考虑，可执行程序不能作为附件添加".into(),
            ));
        }
    }
    prepare_directories(data_root)?;
    let sha256 = sha256_bytes(&request.bytes);
    // A SHA can already have a registered physical path (for example, the
    // same bytes imported once as `photo.jpg` and later as `photo.png`). Reuse
    // that path instead of creating a second file that the SQLite blob row
    // would never reference.
    let existing_relative_path = repository
        .list_attachments()?
        .into_iter()
        .find(|record| record.meta.sha256.as_deref() == Some(sha256.as_str()))
        .and_then(|record| record.meta.relative_path);
    let relative_path = existing_relative_path.unwrap_or_else(|| {
        let extension = controlled_extension(&request.name, &request.mime_type);
        format!("{ATTACHMENTS_DIR}/{}/{sha256}.{extension}", &sha256[..2])
    });
    let destination = controlled_path(data_root, &relative_path)?;
    let mut created_file = false;
    if !destination.exists() {
        let parent = destination
            .parent()
            .ok_or_else(|| StorageError::PathDenied("附件目标目录无效".into()))?;
        fs::create_dir_all(parent)?;
        let staging_name = format!(".import-{}-{}", std::process::id(), Uuid::new_v4());
        let staging = data_root.join("staging").join(staging_name);
        fs::write(&staging, &request.bytes)?;
        // Rename within the same volume gives the reader either the complete
        // file or no file. A pre-existing content-addressed file is reused.
        match fs::rename(&staging, &destination) {
            Ok(()) => {
                created_file = true;
            }
            Err(_error) if destination.exists() => {
                let _ = fs::remove_file(&staging);
            }
            Err(error) => {
                let _ = fs::remove_file(&staging);
                return Err(StorageError::Io(error));
            }
        }
    } else {
        let (size, existing_hash) =
            sha256_file(&destination).map_err(|error| StorageError::Invalid(error.to_string()))?;
        if size != request.bytes.len() as u64 || existing_hash != sha256 {
            return Err(StorageError::Invalid(
                "附件 hash 路径对应的文件校验失败".into(),
            ));
        }
    }
    let id = format!("att-{}", Uuid::new_v4());
    let kind = request.kind.as_deref().unwrap_or_else(|| {
        if request.mime_type.to_ascii_lowercase().starts_with("image/") {
            "image"
        } else {
            "file"
        }
    });
    let created_at = Utc::now().to_rfc3339();
    let asset_url = match asset_url(data_root, &relative_path) {
        Ok(url) => url,
        Err(error) => {
            if created_file {
                let _ = fs::remove_file(&destination);
            }
            return Err(error);
        }
    };
    let registration = repository.register_attachment(&RegisteredAttachment {
        id: id.clone(),
        sha256: sha256.clone(),
        name: request.name.clone(),
        mime_type: request.mime_type.clone(),
        byte_size: request.bytes.len() as u64,
        kind: kind.to_string(),
        width: request.width,
        height: request.height,
        last_modified: request.last_modified,
        relative_path: relative_path.clone(),
        created_at,
    });
    if let Err(error) = registration {
        // Keep failed SQLite writes from leaving an unreferenced file behind.
        // A pre-existing content-addressed file is shared by other rows and
        // must remain in place.
        if created_file {
            let _ = fs::remove_file(&destination);
        }
        return Err(error);
    }
    let meta = AttachmentMeta {
        id,
        name: request.name.clone(),
        mime_type: request.mime_type.clone(),
        byte_size: request.bytes.len() as u64,
        kind: kind.to_string(),
        width: request.width,
        height: request.height,
        last_modified: request.last_modified,
        sha256: Some(sha256),
        relative_path: Some(relative_path.clone()),
        asset_url: Some(asset_url.clone()),
    };
    Ok(ImportAttachmentResponse {
        meta,
        relative_path,
        asset_url,
    })
}

pub fn list(
    repository: &Repository,
    data_root: &Path,
) -> Result<Vec<AttachmentMeta>, StorageError> {
    repository
        .list_attachments()?
        .into_iter()
        .map(|record| -> Result<AttachmentMeta, StorageError> {
            let mut meta = record.meta;
            if let Some(path) = &meta.relative_path {
                // `list` is called from the native command boundary; returning an
                // error for a missing/corrupt file is safer than handing the UI a
                // URL which could point at a different file after a path swap.
                meta.asset_url = Some(asset_url(data_root, path)?);
            }
            Ok(meta)
        })
        .collect::<Result<Vec<_>, StorageError>>()
}

pub fn url(
    repository: &Repository,
    data_root: &Path,
    id: &str,
) -> Result<Option<(String, String)>, StorageError> {
    let Some(record) = repository.attachment(id)? else {
        return Ok(None);
    };
    let relative = record
        .meta
        .relative_path
        .clone()
        .ok_or_else(|| StorageError::Invalid("附件缺少受控相对路径".into()))?;
    Ok(Some((asset_url(data_root, &relative)?, relative)))
}

pub fn save_as(
    repository: &Repository,
    data_root: &Path,
    request: &SaveAttachmentAsRequest,
) -> Result<String, StorageError> {
    let Some(record) = repository.attachment(&request.id)? else {
        return Err(StorageError::Invalid("附件不存在".into()));
    };
    let relative = record
        .meta
        .relative_path
        .clone()
        .ok_or_else(|| StorageError::Invalid("附件缺少受控相对路径".into()))?;
    let source = controlled_path(data_root, &relative)?;
    let target = PathBuf::from(&request.target_path);
    if !target.is_absolute()
        || target.file_name().is_none()
        || target
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("")
            .is_empty()
    {
        return Err(StorageError::PathDenied(
            "另存路径必须是用户选择的绝对文件路径".into(),
        ));
    }
    if target.exists() && target.is_dir() {
        return Err(StorageError::PathDenied("另存目标不能是目录".into()));
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::copy(&source, &target)?;
    let (size, hash) =
        sha256_file(&target).map_err(|error| StorageError::Invalid(error.to_string()))?;
    if size != record.meta.byte_size || record.meta.sha256.as_deref() != Some(hash.as_str()) {
        return Err(StorageError::Invalid("另存文件校验失败".into()));
    }
    Ok(target.to_string_lossy().into_owned())
}

pub fn controlled_path(data_root: &Path, relative: &str) -> Result<PathBuf, StorageError> {
    if relative.is_empty()
        || relative.contains('\\')
        || relative.contains('\0')
        || relative
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(StorageError::PathDenied("附件路径不是受控相对路径".into()));
    }
    if !relative.starts_with("attachments/") && !relative.starts_with("thumbnails/") {
        return Err(StorageError::PathDenied("资产目录不在允许范围内".into()));
    }
    let root = data_root.canonicalize().map_err(StorageError::Io)?;
    let candidate = root.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
    reject_reparse_components(&root, &candidate)?;
    if candidate.exists() {
        let canonical = candidate.canonicalize().map_err(StorageError::Io)?;
        if !canonical.starts_with(&root) {
            return Err(StorageError::PathDenied("资产路径越过数据目录".into()));
        }
        return Ok(canonical);
    }
    // The hash bucket directory may not exist on first import or restore.
    // Canonicalize the nearest existing ancestor so validation remains strict
    // without requiring callers to create an untrusted path first.
    let mut ancestor = candidate.parent();
    while let Some(parent) = ancestor {
        if parent.exists() {
            let parent_canonical = parent.canonicalize().map_err(StorageError::Io)?;
            if !parent_canonical.starts_with(&root) {
                return Err(StorageError::PathDenied("资产路径越过数据目录".into()));
            }
            break;
        }
        ancestor = parent.parent();
    }
    Ok(candidate)
}

/// Return the URL accepted by Tauri's asset protocol for a validated absolute
/// path. Windows uses the `http://asset.localhost/` form; Unix keeps the
/// `asset://localhost/` form. The complete path is encoded as one component,
/// matching `@tauri-apps/api`'s `convertFileSrc` implementation.
pub fn asset_url(data_root: &Path, relative: &str) -> Result<String, StorageError> {
    let path = controlled_path(data_root, relative)?;
    if !path.is_file() {
        return Err(StorageError::Invalid("附件文件不存在或不是普通文件".into()));
    }
    let absolute = path.to_string_lossy();
    let encoded = percent_encode_bytes(absolute.as_bytes());
    #[cfg(any(target_os = "windows", target_os = "android"))]
    {
        Ok(format!("http://asset.localhost/{encoded}"))
    }
    #[cfg(not(any(target_os = "windows", target_os = "android")))]
    {
        Ok(format!("asset://localhost/{encoded}"))
    }
}

fn percent_encode_bytes(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|byte| match *byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (*byte as char).to_string()
            }
            _ => format!("%{:02X}", *byte),
        })
        .collect()
}

fn file_extension(name: &str) -> Option<String> {
    Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
}

/// Reject symlink/junction/reparse-point components even when their resolved
/// target would happen to remain below the data root. This keeps the native
/// attachment tree a regular-file store and avoids time-of-check surprises on
/// Windows.
fn reject_reparse_components(root: &Path, candidate: &Path) -> Result<(), StorageError> {
    let relative = candidate
        .strip_prefix(root)
        .map_err(|_| StorageError::PathDenied("资产路径越过数据目录".into()))?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component.as_os_str());
        if !current.exists() {
            continue;
        }
        let metadata = fs::symlink_metadata(&current)?;
        if metadata.file_type().is_symlink() {
            return Err(StorageError::PathDenied("附件路径包含符号链接".into()));
        }
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::fs::MetadataExt;
            const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
            if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                return Err(StorageError::PathDenied(
                    "附件路径包含 Windows 重解析点".into(),
                ));
            }
        }
    }
    Ok(())
}

fn controlled_extension(name: &str, mime_type: &str) -> String {
    if let Some(extension) = Path::new(name).extension().and_then(|value| value.to_str()) {
        let extension = extension.to_ascii_lowercase();
        if extension.len() <= 16
            && extension
                .chars()
                .all(|character| character.is_ascii_alphanumeric())
        {
            return extension;
        }
    }
    mime_guess::get_mime_extensions_str(mime_type)
        .and_then(|extensions| extensions.first().copied())
        .unwrap_or("bin")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn import_request(name: &str, mime_type: &str, bytes: Vec<u8>) -> ImportAttachmentRequest {
        ImportAttachmentRequest {
            name: name.to_string(),
            mime_type: mime_type.to_string(),
            kind: None,
            last_modified: None,
            width: None,
            height: None,
            bytes,
        }
    }
    #[test]
    fn asset_url_encodes_the_absolute_path() {
        let root =
            std::env::temp_dir().join(format!("life-timeline-attachment-test-{}", Uuid::new_v4()));
        let path = root.join("attachments").join("ab").join("x y.jpg");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"x").unwrap();
        let url = asset_url(&root, "attachments/ab/x y.jpg").unwrap();
        assert!(url.contains("%20"));
        assert!(!url.contains("attachments/ab/x y.jpg"));
        let _ = fs::remove_dir_all(root);
    }
    #[test]
    fn extension_is_controlled() {
        assert_eq!(controlled_extension("a.jpg", "image/jpeg"), "jpg");
        assert_eq!(controlled_extension("a.??", "image/png"), "png");
    }

    #[test]
    fn blocked_extensions_are_rejected_case_insensitively() {
        assert!(BLOCKED_EXTENSIONS.contains(&file_extension("payload.PS1").unwrap().as_str()));
        assert!(!BLOCKED_EXTENSIONS.contains(&file_extension("photo.JPG").unwrap().as_str()));
    }

    #[test]
    fn import_creates_a_private_copy_and_reuses_content_addressed_blob() {
        let directory = TempDir::new().unwrap();
        let root = directory.path();
        prepare_directories(root).unwrap();
        let mut repository = Repository::open(root).unwrap();
        let bytes = b"attachment bytes that are copied locally".to_vec();

        let mut first_request = import_request("first.txt", "text/plain", bytes.clone());
        let first = import(&mut repository, root, &first_request).unwrap();
        let physical_path = root.join(&first.relative_path);
        assert!(physical_path.is_file());
        assert_eq!(fs::read(&physical_path).unwrap(), bytes);

        // Mutating the caller-owned buffer after import cannot mutate the
        // native copy on disk.
        first_request.bytes[0] = b'X';
        assert_eq!(
            fs::read(&physical_path).unwrap(),
            b"attachment bytes that are copied locally"
        );

        let second = import(
            &mut repository,
            root,
            &import_request("same-content.md", "text/markdown", bytes),
        )
        .unwrap();
        assert_ne!(first.meta.id, second.meta.id);
        assert_eq!(first.relative_path, second.relative_path);
        assert_eq!(repository.list_attachments().unwrap().len(), 2);
        let blob_files = fs::read_dir(root.join(ATTACHMENTS_DIR))
            .unwrap()
            .flat_map(|bucket| fs::read_dir(bucket.unwrap().path()).unwrap())
            .count();
        assert_eq!(blob_files, 1);
        assert!(fs::read_dir(root.join("staging")).unwrap().next().is_none());
    }

    #[test]
    fn corrupted_existing_blob_is_rejected_without_replacing_it() {
        let directory = TempDir::new().unwrap();
        let root = directory.path();
        prepare_directories(root).unwrap();
        let mut repository = Repository::open(root).unwrap();
        let request = import_request("note.txt", "text/plain", b"original".to_vec());
        let response = import(&mut repository, root, &request).unwrap();
        let physical_path = root.join(response.relative_path);
        fs::write(&physical_path, b"tampered").unwrap();

        let error = import(&mut repository, root, &request).unwrap_err();
        assert!(error.to_string().contains("校验失败"));
        assert_eq!(fs::read(&physical_path).unwrap(), b"tampered");
        assert_eq!(repository.list_attachments().unwrap().len(), 1);
    }

    #[test]
    fn controlled_paths_reject_traversal_and_unapproved_roots() {
        let directory = TempDir::new().unwrap();
        let root = directory.path();
        fs::create_dir_all(root.join(ATTACHMENTS_DIR)).unwrap();
        for relative in [
            "attachments/../outside.txt",
            "attachments\\outside.txt",
            "backups/secret.zip",
            "attachments//empty-component",
        ] {
            assert!(controlled_path(root, relative).is_err(), "{relative}");
        }
        assert!(asset_url(root, "attachments/missing.txt").is_err());
    }

    #[test]
    fn save_as_copies_and_rehashes_attachment() {
        let directory = TempDir::new().unwrap();
        let root = directory.path().join("data");
        let output = directory.path().join("exports").join("saved.txt");
        fs::create_dir_all(&root).unwrap();
        prepare_directories(&root).unwrap();
        let mut repository = Repository::open(&root).unwrap();
        let response = import(
            &mut repository,
            &root,
            &import_request("note.txt", "text/plain", b"save me".to_vec()),
        )
        .unwrap();
        let saved = save_as(
            &repository,
            &root,
            &SaveAttachmentAsRequest {
                id: response.meta.id,
                target_path: output.to_string_lossy().into_owned(),
            },
        )
        .unwrap();
        assert_eq!(PathBuf::from(saved), output);
        assert_eq!(fs::read(output).unwrap(), b"save me");
    }
}
