//! Explicitly configured, per-user AI connections. Secrets never enter the diary database.
//! Every HTTP request is initiated by an apply/import operation; loading or saving is offline.

use crate::models::CommandError;
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::Utc;
use reqwest::{blocking::Client, redirect::Policy, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;
use url::Url;
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

const CONFIG_VERSION: u32 = 1;
const CONFIG_MAX_BYTES: u64 = 1024 * 1024;
const MAX_PROFILES: usize = 32;
const MAX_KEY_BYTES: usize = 16 * 1024;
const MAX_REQUEST_BYTES: usize = 32 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const MAX_IMAGE_BASE64_BYTES: usize = 8 * 1024 * 1024;
const MAX_IMAGES: usize = 8;
#[cfg(windows)]
const DPAPI_ENTROPY: &[u8] = b"life-timeline/api-key/current-user/v1";
static CONFIG_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ApiProfile {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub model: String,
    pub has_key: bool,
    pub verified_at: Option<String>,
    pub supports_images: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ApiStatus {
    pub profiles: Vec<ApiProfile>,
    pub active_profile_id: Option<String>,
    pub usable: bool,
}

// Deliberately not Debug/Serialize: the deserialized key must never be returned or logged.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ApiSaveRequest {
    pub id: Option<String>,
    pub name: String,
    pub base_url: String,
    pub model: String,
    pub api_key: Option<String>,
}

impl Drop for ApiSaveRequest {
    fn drop(&mut self) {
        if let Some(key) = &mut self.api_key {
            key.zeroize();
        }
    }
}

pub(super) struct ApiImageInput {
    pub mime_type: String,
    pub base64: String,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredProfile {
    id: String,
    name: String,
    base_url: String,
    model: String,
    encrypted_key: Vec<u8>,
    verified_at: Option<String>,
    #[serde(default)]
    supports_images: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ApiStore {
    version: u32,
    revision: u64,
    profiles: Vec<StoredProfile>,
    active_profile_id: Option<String>,
}

impl Default for ApiStore {
    fn default() -> Self {
        Self {
            version: CONFIG_VERSION,
            revision: 0,
            profiles: Vec::new(),
            active_profile_id: None,
        }
    }
}

fn error(code: &str, message: &str) -> CommandError {
    CommandError {
        code: code.into(),
        message: message.into(),
    }
}

fn config_lock() -> Result<MutexGuard<'static, ()>, CommandError> {
    CONFIG_LOCK
        .lock()
        .map_err(|_| error("ai.api_state", "API 设置暂时不可用，请重新打开软件。"))
}

fn text_field(value: &str, maximum: usize, label: &str) -> Result<String, CommandError> {
    let value = value.trim();
    if value.is_empty() || value.len() > maximum || value.chars().any(char::is_control) {
        return Err(error("ai.api_validation", label));
    }
    Ok(value.into())
}

fn validated_base_url(value: &str) -> Result<String, CommandError> {
    let value = value.trim();
    let invalid = || {
        error(
            "ai.api_url",
            "请填写不含账号、查询参数或片段的 HTTPS API 地址；本机服务可使用 HTTP。",
        )
    };
    if value.len() > 2048
        || value
            .chars()
            .any(|ch| ch.is_control() || ch.is_whitespace())
    {
        return Err(invalid());
    }
    let mut url = Url::parse(value).map_err(|_| invalid())?;
    let authority = value
        .split_once("://")
        .map(|(_, rest)| rest.split('/').next().unwrap_or_default())
        .ok_or_else(invalid)?;
    if authority.contains('@')
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.host_str().is_none()
        || url.cannot_be_a_base()
        || value.contains('\\')
    {
        return Err(invalid());
    }
    let literal_localhost = if authority.starts_with('[') {
        authority
            .split_once(']')
            .is_some_and(|(host, _)| host == "[::1")
    } else {
        matches!(
            authority.split(':').next().unwrap_or_default(),
            "localhost" | "127.0.0.1"
        )
    };
    if url.scheme() != "https" && !(url.scheme() == "http" && literal_localhost) {
        return Err(invalid());
    }
    let path = url.path().trim_end_matches('/').to_owned();
    url.set_path(&path);
    Ok(url.to_string().trim_end_matches('/').to_string())
}

fn endpoint(base_url: &str) -> Result<Url, CommandError> {
    let base_url = validated_base_url(base_url)?;
    let mut url =
        Url::parse(&base_url).map_err(|_| error("ai.api_url", "API 地址无效，请重新保存。"))?;
    let path = url.path().trim_end_matches('/');
    let path = if path.ends_with("/chat/completions") {
        path.to_string()
    } else if path.is_empty() {
        "/v1/chat/completions".into()
    } else {
        format!("{path}/chat/completions")
    };
    url.set_path(&path);
    Ok(url)
}

fn read_store(root: &Path) -> Result<ApiStore, CommandError> {
    let path = root.join("api-profiles.json");
    let file = match File::open(&path) {
        Ok(file) => file,
        Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ApiStore::default())
        }
        Err(_) => return Err(error("ai.api_read", "无法读取本机 API 设置。")),
    };
    let metadata = file
        .metadata()
        .map_err(|_| error("ai.api_read", "无法读取本机 API 设置。"))?;
    if !metadata.is_file() || metadata.len() > CONFIG_MAX_BYTES {
        return Err(error(
            "ai.api_config",
            "本机 API 设置文件无效，未读取密钥。",
        ));
    }
    let mut bytes = Vec::new();
    file.take(CONFIG_MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| error("ai.api_read", "无法读取本机 API 设置。"))?;
    if bytes.len() as u64 > CONFIG_MAX_BYTES {
        return Err(error("ai.api_config", "本机 API 设置文件过大。"));
    }
    let store: ApiStore = serde_json::from_slice(&bytes)
        .map_err(|_| error("ai.api_config", "本机 API 设置文件格式无效。"))?;
    let mut ids = HashSet::new();
    if store.version != CONFIG_VERSION || store.profiles.len() > MAX_PROFILES {
        return Err(error("ai.api_config", "本机 API 设置版本或数量不受支持。"));
    }
    for profile in &store.profiles {
        if Uuid::parse_str(&profile.id).is_err()
            || !ids.insert(&profile.id)
            || profile.encrypted_key.is_empty()
            || profile.encrypted_key.len() > MAX_KEY_BYTES * 2
            || text_field(&profile.name, 128, "API 名称无效。").is_err()
            || text_field(&profile.model, 256, "模型名称无效。").is_err()
            || validated_base_url(&profile.base_url).is_err()
        {
            return Err(error("ai.api_config", "本机 API 设置内容无效。"));
        }
    }
    if store
        .active_profile_id
        .as_ref()
        .is_some_and(|id| !ids.contains(id))
    {
        return Err(error("ai.api_config", "已应用的 API 配置不存在。"));
    }
    Ok(store)
}

fn write_store(root: &Path, store: &mut ApiStore) -> Result<(), CommandError> {
    store.revision = store
        .revision
        .checked_add(1)
        .ok_or_else(|| error("ai.api_config", "API 设置版本已达上限。"))?;
    let bytes = serde_json::to_vec_pretty(store)
        .map_err(|_| error("ai.api_write", "无法保存本机 API 设置。"))?;
    if bytes.len() as u64 > CONFIG_MAX_BYTES {
        return Err(error("ai.api_config", "API 设置数量或内容过多。"));
    }
    fs::create_dir_all(root).map_err(|_| error("ai.api_write", "无法保存本机 API 设置。"))?;
    let destination = root.join("api-profiles.json");
    let temporary = root.join(format!(".api-profiles-{}.tmp", Uuid::new_v4()));
    let operation = (|| -> std::io::Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        atomic_replace(&temporary, &destination)
    })();
    if operation.is_err() {
        let _ = fs::remove_file(&temporary);
        return Err(error(
            "ai.api_write",
            "无法保存本机 API 设置，原设置保持不变。",
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
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    // Both UTF-16 buffers remain alive until the synchronous Win32 call returns.
    let success = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if success == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn atomic_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(windows)]
fn protect(bytes: &[u8], decrypt: bool) -> Result<Zeroizing<Vec<u8>>, CommandError> {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_ptr().cast_mut(),
    };
    let entropy = CRYPT_INTEGER_BLOB {
        cbData: DPAPI_ENTROPY.len() as u32,
        pbData: DPAPI_ENTROPY.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: null_mut(),
    };
    // DPAPI defaults to the current Windows user; never use CRYPTPROTECT_LOCAL_MACHINE.
    // The input/entropy buffers stay alive, and UI is prohibited for background operations.
    let success = unsafe {
        if decrypt {
            CryptUnprotectData(
                &input,
                null_mut(),
                &entropy,
                null(),
                null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptProtectData(
                &input,
                null(),
                &entropy,
                null(),
                null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    if success == 0 || output.pbData.is_null() {
        return Err(error(
            "ai.api_key",
            "无法使用此 Windows 用户的加密密钥，请重新输入并保存 API 密钥。",
        ));
    }
    // DPAPI allocates with LocalAlloc. Copy into a zeroizing buffer, wipe, then LocalFree.
    let result = unsafe {
        let output_bytes = std::slice::from_raw_parts_mut(output.pbData, output.cbData as usize);
        let result = Zeroizing::new(output_bytes.to_vec());
        output_bytes.zeroize();
        LocalFree(output.pbData.cast());
        result
    };
    Ok(result)
}

#[cfg(target_os = "android")]
fn protect(bytes: &[u8], decrypt: bool) -> Result<Zeroizing<Vec<u8>>, CommandError> {
    crate::mobile::protect_api_key(bytes, decrypt)
}

#[cfg(not(any(windows, target_os = "android")))]
fn protect(_bytes: &[u8], _decrypt: bool) -> Result<Zeroizing<Vec<u8>>, CommandError> {
    Err(error(
        "ai.api_platform",
        "此版本仅支持 Windows 用户密钥加密，请在 Windows 桌面版管理 API。",
    ))
}

fn secret(profile: &StoredProfile) -> Result<Zeroizing<String>, CommandError> {
    let bytes = protect(&profile.encrypted_key, true)?;
    let text = std::str::from_utf8(&bytes)
        .map_err(|_| error("ai.api_key", "API 密钥不可用，请重新输入。"))?;
    validate_key(text)?;
    Ok(Zeroizing::new(text.to_string()))
}

fn validate_key(key: &str) -> Result<(), CommandError> {
    if key.is_empty()
        || key.len() > MAX_KEY_BYTES
        || !key.bytes().all(|byte| byte.is_ascii_graphic())
    {
        return Err(error(
            "ai.api_key",
            "请填写有效 API 密钥，不要包含空格或换行。",
        ));
    }
    Ok(())
}

fn public_profile(profile: &StoredProfile) -> ApiProfile {
    ApiProfile {
        id: profile.id.clone(),
        name: profile.name.clone(),
        base_url: profile.base_url.clone(),
        model: profile.model.clone(),
        has_key: !profile.encrypted_key.is_empty(),
        verified_at: profile.verified_at.clone(),
        supports_images: profile.supports_images,
    }
}

fn public_status(store: &ApiStore) -> ApiStatus {
    let usable = store.active_profile_id.as_ref().is_some_and(|id| {
        store.profiles.iter().any(|profile| {
            &profile.id == id && profile.verified_at.is_some() && secret(profile).is_ok()
        })
    });
    ApiStatus {
        profiles: store.profiles.iter().map(public_profile).collect(),
        active_profile_id: store.active_profile_id.clone(),
        usable,
    }
}

pub(super) fn status(root: &Path) -> Result<ApiStatus, CommandError> {
    let _guard = config_lock()?;
    read_store(root).map(|store| public_status(&store))
}

pub(super) fn save(root: &Path, request: &ApiSaveRequest) -> Result<ApiStatus, CommandError> {
    let name = text_field(&request.name, 128, "请输入不超过 128 字节的 API 名称。")?;
    let model = text_field(&request.model, 256, "请输入不超过 256 字节的模型名称。")?;
    let base_url = validated_base_url(&request.base_url)?;
    let key = request
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|key| !key.is_empty());
    if let Some(key) = key {
        validate_key(key)?;
    }
    let _guard = config_lock()?;
    let mut store = read_store(root)?;
    let existing = match &request.id {
        Some(id) => Some(
            store
                .profiles
                .iter()
                .position(|profile| &profile.id == id)
                .ok_or_else(|| error("ai.api_missing", "要修改的 API 配置不存在。"))?,
        ),
        None => None,
    };
    if existing.is_none() && store.profiles.len() >= MAX_PROFILES {
        return Err(error("ai.api_limit", "最多保存 32 个 API 配置。"));
    }
    let encrypted_key = match key {
        Some(key) => protect(key.as_bytes(), false)?.to_vec(),
        None => existing
            .map(|index| store.profiles[index].encrypted_key.clone())
            .ok_or_else(|| error("ai.api_key", "新建 API 配置时需要填写密钥。"))?,
    };
    if let Some(index) = existing {
        let profile = &mut store.profiles[index];
        let changed = profile.name != name
            || profile.model != model
            || profile.base_url != base_url
            || key.is_some();
        if changed {
            profile.name = name;
            profile.model = model;
            profile.base_url = base_url;
            profile.encrypted_key = encrypted_key;
            profile.verified_at = None;
            profile.supports_images = false;
            if store.active_profile_id.as_ref() == Some(&profile.id) {
                store.active_profile_id = None;
            }
            write_store(root, &mut store)?;
        }
    } else {
        store.profiles.push(StoredProfile {
            id: Uuid::new_v4().to_string(),
            name,
            model,
            base_url,
            encrypted_key,
            verified_at: None,
            supports_images: false,
        });
        write_store(root, &mut store)?;
    }
    Ok(public_status(&store))
}

pub(super) fn remove(root: &Path, profile_id: &str) -> Result<ApiStatus, CommandError> {
    let _guard = config_lock()?;
    let mut store = read_store(root)?;
    let index = store
        .profiles
        .iter()
        .position(|profile| profile.id == profile_id)
        .ok_or_else(|| error("ai.api_missing", "要删除的 API 配置不存在。"))?;
    store.profiles.remove(index);
    if store.active_profile_id.as_deref() == Some(profile_id) {
        store.active_profile_id = None;
    }
    write_store(root, &mut store)?;
    Ok(public_status(&store))
}

pub(super) fn apply(root: &Path, profile_id: &str) -> Result<ApiStatus, CommandError> {
    let (candidate, start_revision) = {
        let _guard = config_lock()?;
        let store = read_store(root)?;
        let profile = store
            .profiles
            .iter()
            .find(|profile| profile.id == profile_id)
            .cloned()
            .ok_or_else(|| error("ai.api_missing", "要应用的 API 配置不存在。"))?;
        (profile, store.revision)
    };
    let text_result = request_completion(
        &candidate,
        "This is a synthetic connectivity test. Reply with OK only.",
        "Synthetic test: 2 + 2 = 4. Reply OK.",
        &[],
        Duration::from_secs(15),
    );
    // A failed vision probe does not disqualify a valid text-only model. Validate something
    // visible only in the synthetic image: merely accepting image_url can also mean ignoring it.
    let supports_images = if text_result.is_ok() {
        request_completion(
            &candidate,
            "Inspect the synthetic image. Report its color, not a greeting or an acknowledgement.",
            "What is the main color of the plain square in this image? Reply with exactly one basic color word in English. Do not guess if you cannot see the image.",
            &[synthetic_probe_image()],
            Duration::from_secs(15),
        )
        .is_ok_and(|answer| {
            matches!(
                answer.trim().trim_matches(['\"', '\'', '.', '`']).to_ascii_lowercase().as_str(),
                "green" | "light green" | "pale green"
            )
        })
    } else {
        false
    };
    let _guard = config_lock()?;
    let mut store = read_store(root)?;
    // Network work happens outside the lock. Never apply a result to a changed configuration.
    if store.revision != start_revision {
        return Err(error(
            "ai.api_changed",
            "测试期间 API 设置已变化，请重新测试并应用。",
        ));
    }
    let profile = store
        .profiles
        .iter_mut()
        .find(|profile| profile.id == profile_id)
        .ok_or_else(|| error("ai.api_missing", "API 配置已被删除，请重新选择。"))?;
    if let Err(cause) = text_result {
        profile.verified_at = None;
        profile.supports_images = false;
        if store.active_profile_id.as_deref() == Some(profile_id) {
            store.active_profile_id = None;
        }
        write_store(root, &mut store)?;
        return Err(cause);
    }
    profile.verified_at = Some(Utc::now().to_rfc3339());
    profile.supports_images = supports_images;
    store.active_profile_id = Some(profile_id.into());
    write_store(root, &mut store)?;
    Ok(public_status(&store))
}

#[cfg(test)]
pub(super) fn complete(
    root: &Path,
    system: &str,
    user: &str,
    images: &[ApiImageInput],
) -> Result<String, CommandError> {
    complete_for_profile(root, None, system, user, images)
}

pub(super) fn active_profile(root: &Path) -> Result<ApiProfile, CommandError> {
    let _guard = config_lock()?;
    let store = read_store(root)?;
    let profile = store
        .active_profile_id
        .as_ref()
        .and_then(|id| store.profiles.iter().find(|profile| &profile.id == id))
        .filter(|profile| profile.verified_at.is_some())
        .ok_or_else(|| {
            error(
                "ai.api_unavailable",
                "请先在管理 API 中保存、测试并应用一个可用接口。",
            )
        })?;
    secret(profile)?;
    Ok(public_profile(profile))
}

/// Bind an import to the exact profile shown during its outbound-data confirmation.
/// A concurrent edit/apply must never silently send the next batch to a different service.
pub(super) fn complete_for_profile(
    root: &Path,
    expected_profile: Option<&ApiProfile>,
    system: &str,
    user: &str,
    images: &[ApiImageInput],
) -> Result<String, CommandError> {
    let profile = {
        let _guard = config_lock()?;
        let store = read_store(root)?;
        store
            .active_profile_id
            .as_ref()
            .and_then(|id| store.profiles.iter().find(|profile| &profile.id == id))
            .filter(|profile| profile.verified_at.is_some())
            .cloned()
            .ok_or_else(|| {
                error(
                    "ai.api_unavailable",
                    "请先在管理 API 中保存、测试并应用一个可用接口。",
                )
            })?
    };
    if expected_profile.is_some_and(|expected| expected != &public_profile(&profile)) {
        return Err(error(
            "ai.api_changed",
            "当前应用的 API 已变化，请重新确认发送范围后再处理。",
        ));
    }
    if !images.is_empty() && !profile.supports_images {
        return Err(error(
            "ai.api_images",
            "当前模型未通过识图测试，请选择支持图片的模型并重新应用。",
        ));
    }
    request_completion(&profile, system, user, images, Duration::from_secs(120))
}

fn synthetic_probe_image() -> ApiImageInput {
    // 64x64 plain green synthetic PNG; no user data or external image resource.
    ApiImageInput {
        mime_type: "image/png".into(),
        base64: "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAe0lEQVR4nO3PQQ0AIBDAsPOvgidq0IQIHg3JkgnoZp/1dcMFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjx2AeCVYfBF3S9TAAAAAElFTkSuQmCC".into(),
    }
}

fn request_body(
    profile: &StoredProfile,
    system: &str,
    user: &str,
    images: &[ApiImageInput],
) -> Result<Zeroizing<Vec<u8>>, CommandError> {
    if system.len().saturating_add(user.len()) > MAX_REQUEST_BYTES || images.len() > MAX_IMAGES {
        return Err(error(
            "ai.api_request_limit",
            "此次处理的文字或图片过多，请分批导入。",
        ));
    }
    let user_content = if images.is_empty() {
        Value::String(user.into())
    } else {
        let mut content = vec![json!({ "type": "text", "text": user })];
        for image in images {
            if !matches!(
                image.mime_type.as_str(),
                "image/png" | "image/jpeg" | "image/webp"
            ) || image.base64.is_empty()
                || image.base64.len() > MAX_IMAGE_BASE64_BYTES
                || STANDARD.decode(&image.base64).is_err()
            {
                return Err(error(
                    "ai.api_image",
                    "识图输入无效或过大，请使用较小的 PNG、JPEG 或 WebP 图片。",
                ));
            }
            content.push(json!({
                "type": "image_url",
                "image_url": { "url": format!("data:{};base64,{}", image.mime_type, image.base64) }
            }));
        }
        Value::Array(content)
    };
    let body = Zeroizing::new(
        serde_json::to_vec(&json!({
            "model": profile.model,
            "messages": [
                { "role": "system", "content": system },
                { "role": "user", "content": user_content }
            ],
            "stream": false
        }))
        .map_err(|_| error("ai.api_request", "无法准备 AI 请求。"))?,
    );
    if body.len() > MAX_REQUEST_BYTES {
        return Err(error(
            "ai.api_request_limit",
            "此次处理内容过多，请分批导入。",
        ));
    }
    Ok(body)
}

fn request_completion(
    profile: &StoredProfile,
    system: &str,
    user: &str,
    images: &[ApiImageInput],
    timeout: Duration,
) -> Result<String, CommandError> {
    #[cfg(target_os = "android")]
    crate::mobile::ensure_tls_ready()?;
    let endpoint = endpoint(&profile.base_url)?;
    let body = request_body(profile, system, user, images)?;
    let key = secret(profile)?;
    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut client = Client::builder()
        .tls_backend_rustls()
        .redirect(Policy::none())
        .retry(reqwest::retry::never())
        .connect_timeout(Duration::from_secs(15))
        .timeout(timeout);
    // Local synthetic tests/local models do not leave the machine via an environment proxy.
    // This affects this client only and never changes Windows or process proxy settings.
    if matches!(
        endpoint.host_str(),
        Some("localhost" | "127.0.0.1" | "[::1]")
    ) {
        client = client.no_proxy();
    }
    let response = client
        .build()
        .map_err(|_| error("ai.api_transport", "无法初始化安全连接。"))?
        .post(endpoint)
        .bearer_auth(key.as_str())
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::ACCEPT, "application/json")
        .body(body.to_vec())
        .send()
        .map_err(|cause| {
            if cause.is_timeout() {
                error(
                    "ai.api_timeout",
                    "AI 接口响应超时，尚未导入日记，请稍后重试。",
                )
            } else if cause.is_connect() {
                error(
                    "ai.api_connect",
                    "无法连接 AI 接口，请检查填写的地址及现有网络连接。",
                )
            } else {
                error("ai.api_transport", "AI 请求失败，尚未导入日记。")
            }
        })?;
    let response_status = response.status();
    if !response_status.is_success() {
        return Err(http_error(response_status));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(error(
            "ai.api_response_limit",
            "AI 返回内容过大，请缩小导入范围。",
        ));
    }
    let mut bytes = Zeroizing::new(Vec::new());
    response
        .take(MAX_RESPONSE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| error("ai.api_response", "读取 AI 回复失败，尚未导入日记。"))?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err(error(
            "ai.api_response_limit",
            "AI 返回内容过大，请缩小导入范围。",
        ));
    }
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| error("ai.api_response", "AI 接口没有返回兼容的 JSON 回复。"))?;
    let choice = value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first());
    if choice
        .and_then(|choice| choice.get("finish_reason"))
        .and_then(Value::as_str)
        == Some("length")
    {
        return Err(error(
            "ai.api_truncated",
            "AI 回复因长度限制被截断，请缩小导入范围后重试。",
        ));
    }
    let content = choice
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .filter(|content| !content.trim().is_empty())
        .ok_or_else(|| {
            error(
                "ai.api_response",
                "AI 没有返回有效文字，请检查模型是否支持 Chat Completions。",
            )
        })?;
    Ok(content.to_string())
}

fn http_error(status: StatusCode) -> CommandError {
    match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
            error("ai.api_auth", "API 认证或权限不足，请检查密钥及模型权限。")
        }
        StatusCode::TOO_MANY_REQUESTS => error(
            "ai.api_rate_limit",
            "API 请求受限，请检查余额或速率限制后重试。",
        ),
        _ if status.is_redirection() => error(
            "ai.api_redirect",
            "接口要求跳转，为避免转发密钥已停止请求；请填写服务商的最终 API 地址。",
        ),
        _ => error(
            "ai.api_http",
            &format!(
                "AI 接口返回 HTTP {}，请检查模型与接口设置。",
                status.as_u16()
            ),
        ),
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::thread::{self, JoinHandle};
    use std::time::Instant;
    use tempfile::TempDir;

    const SYNTHETIC_KEY: &str = "synthetic-local-test-key-not-a-real-credential";

    struct Reply {
        status: u16,
        body: String,
        location: Option<String>,
    }

    impl Reply {
        fn ok(content: &str) -> Self {
            Self {
                status: 200,
                body: json!({"choices":[{"message":{"content": content},"finish_reason":"stop"}]})
                    .to_string(),
                location: None,
            }
        }

        fn failure(status: u16, body: &str) -> Self {
            Self {
                status,
                body: body.into(),
                location: None,
            }
        }
    }

    #[derive(Debug)]
    struct RecordedRequest {
        path: String,
        correct_synthetic_auth: bool,
        body: Value,
    }

    fn server(replies: Vec<Reply>) -> (String, JoinHandle<Vec<RecordedRequest>>) {
        server_with_callback(replies, |_| {})
    }

    fn server_with_callback(
        replies: Vec<Reply>,
        on_request: impl Fn(usize) + Send + 'static,
    ) -> (String, JoinHandle<Vec<RecordedRequest>>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind synthetic local HTTP server");
        listener.set_nonblocking(true).unwrap();
        let address = format!("http://{}/v1", listener.local_addr().unwrap());
        let worker = thread::spawn(move || {
            let mut recorded = Vec::new();
            for (index, reply) in replies.into_iter().enumerate() {
                let deadline = Instant::now() + Duration::from_secs(10);
                let mut stream = loop {
                    match listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(cause) if cause.kind() == std::io::ErrorKind::WouldBlock => {
                            if Instant::now() >= deadline {
                                return recorded;
                            }
                            thread::sleep(Duration::from_millis(5));
                        }
                        Err(_) => return recorded,
                    }
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut reader = BufReader::new(&stream);
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                let path = line.split_whitespace().nth(1).unwrap().to_string();
                let mut content_length = 0;
                let mut correct_synthetic_auth = false;
                loop {
                    line.clear();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" {
                        break;
                    }
                    if let Some((name, value)) = line.split_once(':') {
                        if name.eq_ignore_ascii_case("content-length") {
                            content_length = value.trim().parse::<usize>().unwrap();
                        }
                        if name.eq_ignore_ascii_case("authorization") {
                            correct_synthetic_auth =
                                value.trim() == format!("Bearer {SYNTHETIC_KEY}");
                        }
                    }
                }
                assert!(content_length < MAX_REQUEST_BYTES);
                let mut bytes = vec![0u8; content_length];
                reader.read_exact(&mut bytes).unwrap();
                recorded.push(RecordedRequest {
                    path,
                    correct_synthetic_auth,
                    body: serde_json::from_slice(&bytes).unwrap(),
                });
                drop(reader);
                on_request(index);
                let location = reply
                    .location
                    .map(|value| format!("Location: {value}\r\n"))
                    .unwrap_or_default();
                let header = format!("HTTP/1.1 {} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{}\r\n", reply.status, reply.body.len(), location);
                let _ = stream.write_all(header.as_bytes());
                let _ = stream.write_all(reply.body.as_bytes());
            }
            recorded
        });
        (address, worker)
    }

    fn request(base_url: &str) -> ApiSaveRequest {
        ApiSaveRequest {
            id: None,
            name: "本地合成测试".into(),
            base_url: base_url.into(),
            model: "synthetic-model".into(),
            api_key: Some(SYNTHETIC_KEY.into()),
        }
    }

    fn saved(root: &Path, base_url: &str) -> String {
        save(root, &request(base_url)).unwrap().profiles[0]
            .id
            .clone()
    }

    #[test]
    fn endpoints_accept_https_and_literal_loopback_without_unsafe_url_parts() {
        assert_eq!(
            endpoint("https://example.test").unwrap().as_str(),
            "https://example.test/v1/chat/completions"
        );
        assert_eq!(
            endpoint("https://example.test/v1/").unwrap().as_str(),
            "https://example.test/v1/chat/completions"
        );
        assert_eq!(
            endpoint("https://example.test/api/chat/completions")
                .unwrap()
                .as_str(),
            "https://example.test/api/chat/completions"
        );
        for valid in [
            "http://localhost:1111/v1",
            "http://127.0.0.1:1111/v1",
            "http://[::1]:1111/v1",
        ] {
            assert!(
                endpoint(valid).is_ok(),
                "valid literal loopback URL rejected"
            );
        }
        for invalid in [
            "http://example.test/v1",
            "ftp://example.test/v1",
            "https://user:password@example.test/v1",
            "https://@example.test/v1",
            "https://example.test/v1?secret=redacted",
            "https://example.test/v1#fragment",
            "http://127.1/v1",
            "http://2130706433/v1",
            "http://localhost.example.test/v1",
            "http://[::2]/v1",
            "https://example.test\\@evil.test/v1",
            "https://example.test/a\nb",
            "file:///private.txt",
        ] {
            assert!(endpoint(invalid).is_err(), "unsafe URL accepted");
        }
    }

    #[test]
    fn saving_is_offline_dpapi_encrypted_and_public_status_never_exposes_key() {
        let root = TempDir::new().unwrap();
        assert!(status(root.path()).unwrap().profiles.is_empty());
        let result = save(root.path(), &request("https://never-contacted.invalid/v1")).unwrap();
        assert!(!result.usable);
        assert!(result.profiles[0].has_key);
        assert_eq!(result.active_profile_id, None);
        let bytes = fs::read(root.path().join("api-profiles.json")).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains(SYNTHETIC_KEY));
        let public = serde_json::to_string(&result).unwrap();
        assert!(!public.contains(SYNTHETIC_KEY));
        assert!(!public.contains("encryptedKey"));
        assert!(!public.contains("apiKey"));
        let stored = read_store(root.path()).unwrap();
        assert_eq!(secret(&stored.profiles[0]).unwrap().as_str(), SYNTHETIC_KEY);
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
        assert_eq!(
            complete(root.path(), "synthetic", "synthetic", &[])
                .unwrap_err()
                .code,
            "ai.api_unavailable"
        );
    }

    #[test]
    fn invalid_or_missing_key_is_rejected_without_saving_config() {
        let root = TempDir::new().unwrap();
        for key in [
            None,
            Some(""),
            Some("contains spaces"),
            Some("line\r\ninjection"),
        ] {
            let mut input = request("https://never-contacted.invalid");
            input.api_key = key.map(str::to_string);
            assert!(save(root.path(), &input).is_err());
        }
        assert!(!root.path().join("api-profiles.json").exists());
    }

    #[test]
    fn apply_probes_only_synthetic_data_then_multimodal_completions_use_applied_model() {
        let root = TempDir::new().unwrap();
        let (address, worker) = server(vec![
            Reply::ok("OK"),
            Reply::ok("green"),
            Reply::ok("合成回复"),
        ]);
        let id = saved(root.path(), &address);
        let applied = apply(root.path(), &id).unwrap();
        assert!(applied.usable);
        assert!(applied.profiles[0].supports_images);
        assert!(applied.profiles[0].verified_at.is_some());
        let profile = active_profile(root.path()).unwrap();
        let result = complete_for_profile(
            root.path(),
            Some(&profile),
            "Synthetic system",
            "Synthetic image request",
            &[synthetic_probe_image()],
        )
        .unwrap();
        assert_eq!(result, "合成回复");
        let records = worker.join().unwrap();
        assert_eq!(records.len(), 3);
        for record in &records {
            assert_eq!(record.path, "/v1/chat/completions");
            assert!(record.correct_synthetic_auth);
            assert_eq!(record.body["model"], "synthetic-model");
            assert_eq!(record.body["stream"], false);
        }
        assert!(records[0].body["messages"][1]["content"]
            .as_str()
            .unwrap()
            .contains("Synthetic test"));
        assert_eq!(
            records[1].body["messages"][1]["content"][1]["type"],
            "image_url"
        );
        assert!(
            records[1].body["messages"][1]["content"][1]["image_url"]["url"]
                .as_str()
                .unwrap()
                .starts_with("data:image/png;base64,")
        );
        let image =
            image::load_from_memory(&STANDARD.decode(synthetic_probe_image().base64).unwrap())
                .unwrap();
        assert_eq!((image.width(), image.height()), (64, 64));
    }

    #[test]
    fn text_model_remains_usable_after_vision_probe_rejection() {
        let root = TempDir::new().unwrap();
        let (address, worker) = server(vec![
            Reply::ok("OK"),
            Reply::failure(400, "synthetic image unsupported"),
        ]);
        let id = saved(root.path(), &address);
        let applied = apply(root.path(), &id).unwrap();
        assert!(applied.usable);
        assert!(!applied.profiles[0].supports_images);
        assert_eq!(
            complete(
                root.path(),
                "synthetic",
                "synthetic",
                &[synthetic_probe_image()]
            )
            .unwrap_err()
            .code,
            "ai.api_images"
        );
        assert_eq!(worker.join().unwrap().len(), 2);
    }

    #[test]
    fn endpoint_that_ignores_image_is_not_advertised_as_vision_capable() {
        let root = TempDir::new().unwrap();
        let (address, worker) = server(vec![Reply::ok("OK"), Reply::ok("OK")]);
        let id = saved(root.path(), &address);
        let applied = apply(root.path(), &id).unwrap();
        assert!(applied.usable);
        assert!(!applied.profiles[0].supports_images);
        assert_eq!(worker.join().unwrap().len(), 2);
    }

    #[test]
    fn unchanged_save_keeps_verification_but_edits_disable_active_profile() {
        let root = TempDir::new().unwrap();
        let (address, worker) = server(vec![Reply::ok("OK"), Reply::ok("OK")]);
        let id = saved(root.path(), &address);
        let applied = apply(root.path(), &id).unwrap();
        let mut edit = request(&address);
        edit.id = Some(id.clone());
        edit.api_key = Some(" ".into());
        let unchanged = save(root.path(), &edit).unwrap();
        assert!(unchanged.usable);
        assert_eq!(
            unchanged.profiles[0].verified_at,
            applied.profiles[0].verified_at
        );
        edit.model = "synthetic-other-model".into();
        let changed = save(root.path(), &edit).unwrap();
        assert!(!changed.usable);
        assert_eq!(changed.active_profile_id, None);
        assert_eq!(changed.profiles[0].verified_at, None);
        assert!(!changed.profiles[0].supports_images);
        assert_eq!(
            secret(&read_store(root.path()).unwrap().profiles[0])
                .unwrap()
                .as_str(),
            SYNTHETIC_KEY
        );
        assert_eq!(worker.join().unwrap().len(), 2);
    }

    #[test]
    fn authentication_error_is_sanitized_and_cannot_activate_profile() {
        let root = TempDir::new().unwrap();
        let (address, worker) = server(vec![Reply::failure(
            401,
            &format!("upstream leaked {SYNTHETIC_KEY} https://sensitive.invalid/path"),
        )]);
        let id = saved(root.path(), &address);
        let cause = apply(root.path(), &id).unwrap_err();
        assert_eq!(cause.code, "ai.api_auth");
        let serialized = serde_json::to_string(&cause).unwrap();
        assert!(!serialized.contains(SYNTHETIC_KEY));
        assert!(!serialized.contains("sensitive.invalid"));
        assert!(!status(root.path()).unwrap().usable);
        assert_eq!(worker.join().unwrap().len(), 1);
    }

    #[test]
    fn redirects_are_not_followed_and_never_reveal_destination_or_body() {
        let root = TempDir::new().unwrap();
        let target = TcpListener::bind("127.0.0.1:0").unwrap();
        target.set_nonblocking(true).unwrap();
        let mut reply = Reply::failure(307, SYNTHETIC_KEY);
        reply.location = Some(format!(
            "http://{}/stolen-key",
            target.local_addr().unwrap()
        ));
        let (address, worker) = server(vec![reply]);
        let id = saved(root.path(), &address);
        let cause = apply(root.path(), &id).unwrap_err();
        assert_eq!(cause.code, "ai.api_redirect");
        assert!(!cause.message.contains(SYNTHETIC_KEY));
        assert!(!cause.message.contains("stolen-key"));
        assert!(target.accept().is_err());
        assert_eq!(worker.join().unwrap().len(), 1);
    }

    #[test]
    fn changed_configuration_while_testing_is_never_applied() {
        let root = TempDir::new().unwrap();
        let (arrived_sender, arrived_receiver) = mpsc::channel();
        let (release_sender, release_receiver) = mpsc::channel();
        let release_receiver = Mutex::new(release_receiver);
        let (address, worker) =
            server_with_callback(vec![Reply::ok("OK"), Reply::ok("OK")], move |index| {
                if index == 0 {
                    arrived_sender.send(()).unwrap();
                    release_receiver
                        .lock()
                        .unwrap()
                        .recv_timeout(Duration::from_secs(5))
                        .unwrap();
                }
            });
        let id = saved(root.path(), &address);
        let task_root = root.path().to_path_buf();
        let task_id = id.clone();
        let applying = thread::spawn(move || apply(&task_root, &task_id));
        arrived_receiver
            .recv_timeout(Duration::from_secs(5))
            .unwrap();
        let mut edit = request(&address);
        edit.id = Some(id);
        edit.api_key = None;
        edit.model = "edited-during-test".into();
        save(root.path(), &edit).unwrap();
        release_sender.send(()).unwrap();
        assert_eq!(applying.join().unwrap().unwrap_err().code, "ai.api_changed");
        assert!(!status(root.path()).unwrap().usable);
        assert_eq!(worker.join().unwrap().len(), 2);
    }

    #[test]
    fn request_and_response_bounds_reject_unsupported_images_and_truncated_json() {
        let root = TempDir::new().unwrap();
        let id = saved(root.path(), "http://127.0.0.1:1");
        let store = read_store(root.path()).unwrap();
        let profile = store
            .profiles
            .iter()
            .find(|profile| profile.id == id)
            .unwrap();
        assert_eq!(
            request_body(
                profile,
                "",
                "",
                &[ApiImageInput {
                    mime_type: "text/html".into(),
                    base64: "SGk=".into()
                }]
            )
            .unwrap_err()
            .code,
            "ai.api_image"
        );
        assert_eq!(
            request_body(
                profile,
                "",
                "",
                &[ApiImageInput {
                    mime_type: "image/png".into(),
                    base64: "malformed%%%".into()
                }]
            )
            .unwrap_err()
            .code,
            "ai.api_image"
        );
        let (address, worker) = server(vec![Reply::failure(200, "not json"), Reply::failure(200, "{\"choices\":[{\"message\":{\"content\":\"cut off\"},\"finish_reason\":\"length\"}]}")]);
        let mut wire_profile = profile.clone();
        wire_profile.base_url = address;
        assert_eq!(
            request_completion(
                &wire_profile,
                "synthetic",
                "synthetic",
                &[],
                Duration::from_secs(5)
            )
            .unwrap_err()
            .code,
            "ai.api_response"
        );
        assert_eq!(
            request_completion(
                &wire_profile,
                "synthetic",
                "synthetic",
                &[],
                Duration::from_secs(5)
            )
            .unwrap_err()
            .code,
            "ai.api_truncated"
        );
        assert_eq!(worker.join().unwrap().len(), 2);
    }

    #[test]
    fn oversized_response_and_image_count_stop_before_processing() {
        let root = TempDir::new().unwrap();
        let (address, worker) = server(vec![Reply::failure(
            200,
            &"x".repeat(MAX_RESPONSE_BYTES + 1),
        )]);
        saved(root.path(), &address);
        let store = read_store(root.path()).unwrap();
        let profile = &store.profiles[0];
        let images: Vec<_> = (0..MAX_IMAGES + 1)
            .map(|_| synthetic_probe_image())
            .collect();
        assert_eq!(
            request_body(profile, "synthetic", "synthetic", &images)
                .unwrap_err()
                .code,
            "ai.api_request_limit"
        );
        assert_eq!(
            request_completion(
                profile,
                "synthetic",
                "synthetic",
                &[],
                Duration::from_secs(5)
            )
            .unwrap_err()
            .code,
            "ai.api_response_limit"
        );
        assert_eq!(worker.join().unwrap().len(), 1);
    }

    #[test]
    fn deleting_active_profile_preserves_other_profiles_and_diary_files() {
        let root = TempDir::new().unwrap();
        fs::write(root.path().join("life.sqlite"), "synthetic diary marker").unwrap();
        let (address, worker) = server(vec![Reply::ok("OK"), Reply::ok("OK")]);
        let id = saved(root.path(), &address);
        apply(root.path(), &id).unwrap();
        let second = save(root.path(), &request("https://never-contacted.invalid/v1")).unwrap();
        assert_eq!(second.profiles.len(), 2);
        let result = remove(root.path(), &id).unwrap();
        assert_eq!(result.profiles.len(), 1);
        assert!(!result.usable);
        assert_eq!(result.active_profile_id, None);
        assert_eq!(
            fs::read_to_string(root.path().join("life.sqlite")).unwrap(),
            "synthetic diary marker"
        );
        assert_eq!(worker.join().unwrap().len(), 2);
    }

    #[test]
    fn bound_completion_rejects_a_different_applied_profile_without_network() {
        let root = TempDir::new().unwrap();
        let (address, worker) = server(vec![Reply::ok("OK"), Reply::ok("OK")]);
        let id = saved(root.path(), &address);
        apply(root.path(), &id).unwrap();
        let mut expected = active_profile(root.path()).unwrap();
        expected.model = "a-different-approved-model".into();
        assert_eq!(
            complete_for_profile(root.path(), Some(&expected), "synthetic", "synthetic", &[])
                .unwrap_err()
                .code,
            "ai.api_changed"
        );
        assert_eq!(worker.join().unwrap().len(), 2);
    }

    #[test]
    fn corrupt_ciphertext_cannot_be_reported_as_usable() {
        let root = TempDir::new().unwrap();
        let id = saved(root.path(), "https://never-contacted.invalid");
        let mut store = read_store(root.path()).unwrap();
        store.profiles[0].encrypted_key = vec![1, 2, 3, 4];
        store.profiles[0].verified_at = Some(Utc::now().to_rfc3339());
        store.active_profile_id = Some(id);
        write_store(root.path(), &mut store).unwrap();
        assert!(!status(root.path()).unwrap().usable);
        assert_eq!(active_profile(root.path()).unwrap_err().code, "ai.api_key");
    }
}
