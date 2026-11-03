//! Local-only phone/desktop diary transfer.
//!
//! The desktop side owns a short-lived HTTP listener on all local interfaces.
//! Each session accepts one ZIP upload or serves one frozen diary ZIP. Android
//! streams to or from that listener without a cloud service or a system proxy.

use crate::command_error;
use crate::models::CommandError;
use crate::AppState;
#[cfg(not(target_os = "android"))]
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
#[cfg(not(target_os = "android"))]
use std::io::{self, BufRead, BufReader, Seek, SeekFrom};
use std::io::{Read, Write};
#[cfg(not(target_os = "android"))]
use std::net::{IpAddr, Ipv4Addr, Shutdown, TcpListener, TcpStream, UdpSocket};
use std::path::Path;
use std::path::PathBuf;
#[cfg(not(target_os = "android"))]
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
#[cfg(not(target_os = "android"))]
use std::thread;
use std::time::Duration as StdDuration;
#[cfg(not(target_os = "android"))]
use std::time::Instant;
#[cfg(not(target_os = "android"))]
use tauri::Emitter;
use tauri::{AppHandle, Manager};
use uuid::Uuid;

pub(crate) const MAX_TRANSFER_BYTES: u64 = 512 * 1024 * 1024;
#[cfg(not(target_os = "android"))]
const SESSION_TTL_SECONDS: i64 = 10 * 60;
const ENDPOINT_PATH: &str = "/api/v1/phone-transfer";
#[cfg(not(target_os = "android"))]
const MAX_HEADER_COUNT: usize = 64;
#[cfg(not(target_os = "android"))]
const MAX_HEADER_BYTES: usize = 8192;
#[cfg(not(target_os = "android"))]
const READ_POLL_TIMEOUT: StdDuration = StdDuration::from_millis(250);
#[cfg(not(target_os = "android"))]
const READ_IDLE_TIMEOUT: StdDuration = StdDuration::from_secs(10);

fn error(code: &str, message: impl Into<String>) -> CommandError {
    CommandError {
        code: code.into(),
        message: message.into(),
    }
}

#[cfg(not(target_os = "android"))]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PhoneTransferStartResult {
    pub session_id: String,
    pub token: String,
    pub url: String,
    pub port: u16,
    pub expires_at: String,
    pub max_bytes: u64,
    pub direction: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub byte_size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diary_count: Option<usize>,
}

#[cfg(not(target_os = "android"))]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PhoneTransferOfferRequest {
    pub archive_path: Option<String>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
}

#[cfg(not(target_os = "android"))]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PhoneTransferSent {
    pub session_id: String,
    pub byte_size: u64,
    pub sha256: String,
}

#[cfg(not(target_os = "android"))]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PhoneTransferStatusResult {
    pub active: bool,
    pub session_id: Option<String>,
    pub url: Option<String>,
    pub expires_at: Option<String>,
    pub consumed: bool,
    pub max_bytes: u64,
    pub direction: Option<&'static str>,
}

#[cfg(not(target_os = "android"))]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PhoneTransferReceived {
    pub session_id: String,
    pub archive_path: String,
    pub byte_size: u64,
    pub sha256: String,
    pub received_at: String,
}

#[cfg(target_os = "android")]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PhoneTransferSendRequest {
    pub server_url: String,
    pub token: String,
    pub archive_path: String,
}

#[cfg(any(target_os = "android", test))]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PhoneTransferSendResult {
    pub archive_path: String,
    pub byte_size: u64,
    pub sha256: String,
}

#[cfg(any(target_os = "android", test))]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PhoneTransferReceiveRequest {
    pub server_url: String,
    pub token: String,
}

#[cfg(not(target_os = "android"))]
struct OfferedArchive {
    path: PathBuf,
    byte_size: u64,
    sha256: String,
    diary_count: usize,
}

#[cfg(not(target_os = "android"))]
impl OfferedArchive {
    fn cleanup(&self) {
        if crate::security::reject_symlink_components(&self.path).is_ok() {
            let _ = fs::remove_file(&self.path);
        }
    }
}

#[cfg(not(target_os = "android"))]
impl Drop for OfferedArchive {
    fn drop(&mut self) {
        self.cleanup();
    }
}

#[cfg(not(target_os = "android"))]
pub(crate) struct TransferStore {
    current: Mutex<Option<Arc<TransferSession>>>,
}

#[cfg(not(target_os = "android"))]
impl Default for TransferStore {
    fn default() -> Self {
        Self {
            current: Mutex::new(None),
        }
    }
}

#[cfg(not(target_os = "android"))]
struct TransferSession {
    session_id: String,
    token: String,
    expires_at: DateTime<Utc>,
    port: u16,
    consumed: AtomicBool,
    stopped: AtomicBool,
    // This lock also serializes cancellation with publishing a completed ZIP.
    connection: Mutex<Option<TcpStream>>,
    offer: Option<OfferedArchive>,
}

#[cfg(not(target_os = "android"))]
impl TransferSession {
    fn direction(&self) -> &'static str {
        if self.offer.is_some() {
            "send"
        } else {
            "receive"
        }
    }

    fn expired(&self) -> bool {
        Utc::now() >= self.expires_at
    }

    fn url(&self) -> String {
        format!("http://{}:{}{}", local_host(), self.port, ENDPOINT_PATH)
    }

    fn ensure_active(&self) -> io::Result<()> {
        if self.stopped.load(Ordering::SeqCst) || self.expired() {
            Err(io::Error::new(
                io::ErrorKind::ConnectionAborted,
                "手机连接已结束。",
            ))
        } else {
            Ok(())
        }
    }

    fn register_connection(&self, stream: &TcpStream) -> io::Result<()> {
        let mut connection = self
            .connection
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.ensure_active()?;
        *connection = Some(stream.try_clone()?);
        Ok(())
    }

    fn clear_connection(&self) {
        self.connection
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
    }

    fn stop(&self) {
        let mut connection = self
            .connection
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.stopped.store(true, Ordering::SeqCst);
        if let Some(stream) = connection.take() {
            // Wake an upload blocked in a read instead of waiting for its
            // timeout or allowing it to finish after the page has closed.
            let _ = stream.shutdown(Shutdown::Both);
        }
        if let Some(offer) = &self.offer {
            offer.cleanup();
        }
    }
}

#[cfg(not(target_os = "android"))]
fn local_host() -> String {
    // UDP connect only asks the OS for the route-selected local address; it
    // does not send a packet.  If route discovery is unavailable, localhost is
    // still a useful fallback for desktop tests and same-device use.
    let candidate = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))
        .and_then(|socket| {
            socket.connect((Ipv4Addr::new(192, 0, 2, 1), 80))?;
            socket.local_addr()
        })
        .ok()
        .map(|address| address.ip());
    match candidate {
        Some(IpAddr::V4(address)) if address.is_private() || address.is_loopback() => {
            address.to_string()
        }
        _ => "127.0.0.1".to_string(),
    }
}

#[cfg(not(target_os = "android"))]
pub(crate) fn start(
    app: &AppHandle,
    state: &AppState,
) -> Result<PhoneTransferStartResult, CommandError> {
    start_session(app, state, None)
}

#[cfg(not(target_os = "android"))]
fn start_session(
    app: &AppHandle,
    state: &AppState,
    offer: Option<OfferedArchive>,
) -> Result<PhoneTransferStartResult, CommandError> {
    let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0))
        .map_err(|cause| error("phone_transfer.bind", format!("无法开启手机连接: {cause}")))?;
    listener
        .set_nonblocking(true)
        .map_err(|cause| error("phone_transfer.bind", cause.to_string()))?;
    let port = listener
        .local_addr()
        .map_err(|cause| error("phone_transfer.bind", cause.to_string()))?
        .port();

    let mut current = state
        .phone_transfer
        .current
        .lock()
        .map_err(|_| error("phone_transfer.state", "手机连接状态不可用。"))?;
    if let Some(existing) = current.as_ref() {
        if !existing.expired() && !existing.stopped.load(Ordering::SeqCst) {
            return Err(error(
                "phone_transfer.active",
                "已有一个手机连接正在等待，请先结束它再新建。",
            ));
        }
        existing.stop();
    }

    let session = Arc::new(TransferSession {
        session_id: Uuid::new_v4().simple().to_string(),
        token: Uuid::new_v4().simple().to_string(),
        expires_at: Utc::now() + Duration::seconds(SESSION_TTL_SECONDS),
        port,
        consumed: AtomicBool::new(false),
        stopped: AtomicBool::new(false),
        connection: Mutex::new(None),
        offer,
    });
    *current = Some(session.clone());
    drop(current);

    let root = state.root.clone();
    let app = app.clone();
    let session_for_thread = session.clone();
    thread::Builder::new()
        .name("life-timeline-phone-transfer".to_string())
        .spawn(move || run_server(listener, root, app, session_for_thread))
        .map_err(|cause| {
            session.stop();
            error("phone_transfer.bind", cause.to_string())
        })?;

    Ok(PhoneTransferStartResult {
        session_id: session.session_id.clone(),
        token: session.token.clone(),
        url: session.url(),
        port,
        expires_at: session.expires_at.to_rfc3339(),
        max_bytes: MAX_TRANSFER_BYTES,
        direction: session.direction(),
        byte_size: session.offer.as_ref().map(|offer| offer.byte_size),
        sha256: session.offer.as_ref().map(|offer| offer.sha256.clone()),
        diary_count: session.offer.as_ref().map(|offer| offer.diary_count),
    })
}

#[cfg(not(target_os = "android"))]
pub(crate) fn cancel(store: &TransferStore, session_id: Option<&str>) -> Result<(), CommandError> {
    let mut current = store
        .current
        .lock()
        .map_err(|_| error("phone_transfer.state", "手机连接状态不可用。"))?;
    // Compare and remove under the same lock. A delayed cleanup from an old
    // page must never stop a newer page's session. Omitting the ID preserves
    // the original cancel-current-session command for older callers.
    if session_id.is_some_and(|expected| {
        current
            .as_ref()
            .is_none_or(|session| session.session_id != expected)
    }) {
        return Ok(());
    }
    if let Some(session) = current.take() {
        session.stop();
    }
    Ok(())
}

#[cfg(not(target_os = "android"))]
pub(crate) fn status(state: &AppState) -> Result<PhoneTransferStatusResult, CommandError> {
    let mut current = state
        .phone_transfer
        .current
        .lock()
        .map_err(|_| error("phone_transfer.state", "手机连接状态不可用。"))?;
    if current
        .as_ref()
        .is_some_and(|session| session.expired() || session.stopped.load(Ordering::SeqCst))
    {
        if let Some(session) = current.take() {
            session.stop();
        }
    }
    let Some(session) = current.as_ref() else {
        return Ok(PhoneTransferStatusResult {
            active: false,
            session_id: None,
            url: None,
            expires_at: None,
            consumed: false,
            max_bytes: MAX_TRANSFER_BYTES,
            direction: None,
        });
    };
    Ok(PhoneTransferStatusResult {
        active: !session.expired() && !session.stopped.load(Ordering::SeqCst),
        session_id: Some(session.session_id.clone()),
        url: Some(session.url()),
        expires_at: Some(session.expires_at.to_rfc3339()),
        consumed: session.consumed.load(Ordering::SeqCst),
        max_bytes: MAX_TRANSFER_BYTES,
        direction: Some(session.direction()),
    })
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub(super) fn phone_transfer_start(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<PhoneTransferStartResult, CommandError> {
    start(&app, &state)
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub(super) async fn phone_transfer_offer(
    app: AppHandle,
    request: PhoneTransferOfferRequest,
) -> Result<PhoneTransferStartResult, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let offered = prepare_offer(&state, request)?;
        start_session(&app, &state, Some(offered))
    })
    .await
    .map_err(|cause| error("phone_transfer.worker", cause.to_string()))?
}

#[cfg(not(target_os = "android"))]
fn prepare_offer(
    state: &AppState,
    request: PhoneTransferOfferRequest,
) -> Result<OfferedArchive, CommandError> {
    let root = prepare_transfer_root(&state.root)?;
    let mut offered = OfferedArchive {
        path: root.join(format!("offered-{}.zip", Uuid::new_v4().simple())),
        byte_size: 0,
        sha256: String::new(),
        diary_count: 0,
    };
    if let Some(source) = request.archive_path {
        if request.start_date.is_some() || request.end_date.is_some() {
            return Err(error(
                "phone_transfer.selection",
                "已有日记包不能同时指定日期区间。",
            ));
        }
        let source = crate::validate_user_archive_path(&source)?;
        let (source_size, source_hash, _) = checked_diary_archive(&source)?;
        let input = File::open(&source).map_err(command_error)?;
        let mut output = crate::security::create_new_file(&offered.path)
            .map_err(|cause| error("phone_transfer.archive", cause.to_string()))?;
        let copied = io::copy(&mut input.take(MAX_TRANSFER_BYTES + 1), &mut output)
            .map_err(command_error)?;
        output.sync_all().map_err(command_error)?;
        drop(output);
        if copied != source_size || crate::sha256_file(&offered.path)?.1 != source_hash {
            return Err(error(
                "phone_transfer.archive_changed",
                "日记包在准备期间发生变化，请重新选择。",
            ));
        }
    } else {
        crate::diary_transfer::export_diaries(
            state,
            crate::diary_transfer::DiaryExportRequest {
                destination_path: offered.path.to_string_lossy().into_owned(),
                start_date: request.start_date,
                end_date: request.end_date,
                overwrite: false,
            },
        )?;
    }
    // Validate the independent snapshot, never serve the caller's path. This
    // rejects complete backups, arbitrary ZIPs and any preference/API payload.
    let (size, hash, diary_count) = checked_diary_archive(&offered.path)?;
    offered.byte_size = size;
    offered.sha256 = hash;
    offered.diary_count = diary_count;
    Ok(offered)
}

fn checked_diary_archive(path: &Path) -> Result<(u64, String, usize), CommandError> {
    crate::security::reject_symlink_components(path)
        .map_err(|cause| error("phone_transfer.archive", cause.to_string()))?;
    let metadata = fs::metadata(path).map_err(command_error)?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_TRANSFER_BYTES {
        return Err(error("phone_transfer.archive", "日记包为空或超过 512 MB。"));
    }
    let (size, hash) = crate::sha256_file(path)?;
    let (_, _, counts) = crate::scan_zip_inner(path, true)?;
    if crate::sha256_file(path)? != (size, hash.clone()) {
        return Err(error(
            "phone_transfer.archive_changed",
            "日记包在检查期间发生变化。",
        ));
    }
    Ok((size, hash, counts.events))
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub(super) fn phone_transfer_cancel(
    state: tauri::State<'_, AppState>,
    session_id: Option<String>,
) -> Result<(), CommandError> {
    cancel(&state.phone_transfer, session_id.as_deref())
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub(super) fn phone_transfer_status(
    state: tauri::State<'_, AppState>,
) -> Result<PhoneTransferStatusResult, CommandError> {
    status(&state)
}

#[cfg(not(target_os = "android"))]
fn run_server(listener: TcpListener, root: PathBuf, app: AppHandle, session: Arc<TransferSession>) {
    accept_connections(listener, &session, |stream| {
        handle_connection(stream, &root, &app, &session)
    });
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(mut current) = state.phone_transfer.current.lock() {
            if current
                .as_ref()
                .is_some_and(|candidate| Arc::ptr_eq(candidate, &session))
            {
                current.take();
            }
        }
    }
}

#[cfg(not(target_os = "android"))]
fn accept_connections(
    listener: TcpListener,
    session: &TransferSession,
    mut handle: impl FnMut(TcpStream),
) {
    while !session.stopped.load(Ordering::SeqCst) && !session.expired() {
        match listener.accept() {
            Ok((stream, _peer)) => {
                handle(stream);
                session.clear_connection();
                // A successful transfer consumes the token.  Close the
                // listener immediately rather than allowing another request.
                if session.consumed.load(Ordering::SeqCst) {
                    break;
                }
            }
            Err(cause) if cause.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(StdDuration::from_millis(100));
            }
            Err(_) => break,
        }
    }
    session.stop();
}

#[cfg(not(target_os = "android"))]
fn handle_connection(stream: TcpStream, root: &Path, app: &AppHandle, session: &TransferSession) {
    handle_connection_with_events(
        stream,
        root,
        session,
        |received| {
            let _ = app.emit("life-timeline://phone-transfer-received", &received);
        },
        |sent| {
            let _ = app.emit("life-timeline://phone-transfer-sent", &sent);
        },
    );
}

#[cfg(not(target_os = "android"))]
fn handle_connection_with_events(
    mut stream: TcpStream,
    root: &Path,
    session: &TransferSession,
    received_event: impl FnOnce(PhoneTransferReceived),
    sent_event: impl FnOnce(PhoneTransferSent),
) {
    if session.register_connection(&stream).is_err() {
        let _ = write_response(&mut stream, 410, "手机连接已结束，请重新生成连接码。");
        return;
    }
    let _ = stream.set_write_timeout(Some(StdDuration::from_secs(10)));
    let session_reader = match SessionReader::new(&mut stream, session) {
        Ok(reader) => reader,
        Err(_) => return,
    };
    let mut reader = BufReader::new(session_reader);
    let request = match read_request_head(&mut reader) {
        Ok(request) => request,
        Err((status, message)) => {
            let _ = write_response(&mut stream, status, message);
            return;
        }
    };
    let method = if session.offer.is_some() {
        "GET"
    } else {
        "POST"
    };
    if request.method != method || request.path != ENDPOINT_PATH {
        let _ = write_response(&mut stream, 404, "此连接地址不存在。");
        return;
    }
    if session.ensure_active().is_err() {
        let _ = write_response(&mut stream, 410, "手机连接已结束，请重新生成连接码。");
        return;
    }
    let Some(token) = request.headers.get("x-life-timeline-token") else {
        let _ = write_response(&mut stream, 401, "缺少一次性连接码。");
        return;
    };
    if validate_token(token).is_err()
        || !constant_time_eq(token.as_bytes(), session.token.as_bytes())
    {
        let _ = write_response(&mut stream, 403, "一次性连接码不正确。");
        return;
    }
    if session.offer.is_some() {
        if request.content_length.is_some_and(|length| length != 0)
            || request.headers.contains_key("transfer-encoding")
            || request.headers.contains_key("range")
        {
            let _ = write_response(&mut stream, 400, "日记下载不接受请求正文或分段请求。");
            return;
        }
        drop(reader);
        serve_offered_archive(&mut stream, session, sent_event);
        return;
    }
    let Some(content_length) = request.content_length else {
        let _ = write_response(&mut stream, 411, "需要提供文件大小。");
        return;
    };
    if content_length == 0 || content_length > MAX_TRANSFER_BYTES {
        let _ = write_response(&mut stream, 413, "日记压缩包超过本次连接允许的大小。");
        return;
    }
    if request
        .headers
        .get("transfer-encoding")
        .is_some_and(|value| !value.eq_ignore_ascii_case("identity"))
    {
        let _ = write_response(&mut stream, 400, "不支持分块上传。");
        return;
    }
    if request
        .headers
        .get("content-type")
        .is_none_or(|value| !value.eq_ignore_ascii_case("application/zip"))
    {
        let _ = write_response(&mut stream, 415, "请发送 ZIP 日记压缩包。");
        return;
    }

    // Consume the token before writing any bytes.  A malformed or interrupted
    // first attempt therefore cannot be used to race a second upload.
    if session.consumed.swap(true, Ordering::SeqCst) {
        let _ = write_response(&mut stream, 409, "这个连接码已经使用过了。");
        return;
    }
    let transfer_root = match prepare_transfer_root(root) {
        Ok(path) => path,
        Err(_) => {
            let _ = write_response(&mut stream, 500, "本地接收目录不可用。");
            return;
        }
    };
    let id = Uuid::new_v4().simple().to_string();
    let temporary = transfer_root.join(format!(".received-{id}.tmp"));
    let destination = transfer_root.join(format!("received-{id}.zip"));
    let mut output = match crate::security::create_new_file(&temporary) {
        Ok(file) => file,
        Err(_) => {
            let _ = write_response(&mut stream, 500, "无法创建本地接收文件。");
            return;
        }
    };
    let (size, sha256, prefix, complete) =
        match copy_request_body(&mut reader, &mut output, content_length, session) {
            Ok(result) => result,
            Err(_) => {
                drop(output);
                let _ = fs::remove_file(&temporary);
                let _ = write_response(&mut stream, 400, "日记压缩包上传不完整。");
                return;
            }
        };
    if output.sync_all().is_err() || !complete || !prefix.starts_with(b"PK") {
        drop(output);
        let _ = fs::remove_file(&temporary);
        let _ = write_response(&mut stream, 415, "收到的文件不是有效的 ZIP 压缩包。");
        return;
    }
    drop(output);
    let received = PhoneTransferReceived {
        session_id: session.session_id.clone(),
        archive_path: destination.to_string_lossy().into_owned(),
        byte_size: size,
        sha256: sha256.clone(),
        received_at: Utc::now().to_rfc3339(),
    };
    let body = format!("{{\"ok\":true,\"byteSize\":{size},\"sha256\":\"{sha256}\"}}");
    if let Err(cause) = publish_received_archive(session, &temporary, &destination, || {
        // Reply before the UI receives the completion event: its cleanup may
        // immediately cancel this session and shut down the socket.
        let _ = write_response(&mut stream, 201, &body);
        received_event(received);
    }) {
        let _ = fs::remove_file(&temporary);
        if cause.kind() == io::ErrorKind::ConnectionAborted {
            let _ = write_response(&mut stream, 410, "手机连接已结束，请重新生成连接码。");
        } else {
            let _ = write_response(&mut stream, 500, "本地接收文件保存失败。");
        }
    }
}

#[cfg(not(target_os = "android"))]
fn serve_offered_archive(
    stream: &mut TcpStream,
    session: &TransferSession,
    sent_event: impl FnOnce(PhoneTransferSent),
) {
    let Some(offer) = &session.offer else {
        return;
    };
    if session.consumed.swap(true, Ordering::SeqCst) {
        let _ = write_response(stream, 409, "这个连接码已经使用过了。");
        return;
    }
    let open_checked = || -> io::Result<File> {
        crate::security::reject_symlink_components(&offer.path)
            .map_err(|cause| io::Error::new(io::ErrorKind::PermissionDenied, cause.to_string()))?;
        let mut file = File::open(&offer.path)?;
        if file.metadata()?.len() != offer.byte_size {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "待传日记包已变化。",
            ));
        }
        let mut hasher = Sha256::new();
        let mut buffer = vec![0; 1024 * 1024];
        let mut checked = 0_u64;
        loop {
            session.ensure_active()?;
            let read = file.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            checked += read as u64;
            if checked > offer.byte_size {
                return Err(io::ErrorKind::InvalidData.into());
            }
            hasher.update(&buffer[..read]);
        }
        if checked != offer.byte_size || format!("{:x}", hasher.finalize()) != offer.sha256 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "待传日记包已变化。",
            ));
        }
        file.seek(SeekFrom::Start(0))?;
        Ok(file)
    };
    let mut file = match open_checked() {
        Ok(file) => file,
        Err(_) => {
            let _ = write_response(stream, 500, "待传日记包不可用，请重新生成连接。");
            offer.cleanup();
            return;
        }
    };
    let result = (|| -> io::Result<()> {
        stream.set_write_timeout(Some(READ_POLL_TIMEOUT))?;
        let header = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/zip\r\nContent-Length: {}\r\nX-Life-Timeline-SHA256: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
            offer.byte_size, offer.sha256
        );
        write_session_all(stream, header.as_bytes(), session)?;
        let mut remaining = offer.byte_size;
        let mut hasher = Sha256::new();
        let mut buffer = vec![0; 1024 * 1024];
        while remaining > 0 {
            session.ensure_active()?;
            let amount = remaining.min(buffer.len() as u64) as usize;
            let read = file.read(&mut buffer[..amount])?;
            if read == 0 {
                return Err(io::ErrorKind::UnexpectedEof.into());
            }
            write_session_all(stream, &buffer[..read], session)?;
            hasher.update(&buffer[..read]);
            remaining -= read as u64;
        }
        if format!("{:x}", hasher.finalize()) != offer.sha256 {
            return Err(io::ErrorKind::InvalidData.into());
        }
        let _connection = session
            .connection
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        session.ensure_active()?;
        stream.flush()?;
        sent_event(PhoneTransferSent {
            session_id: session.session_id.clone(),
            byte_size: offer.byte_size,
            sha256: offer.sha256.clone(),
        });
        Ok(())
    })();
    drop(file);
    offer.cleanup();
    if result.is_err() {
        let _ = stream.shutdown(Shutdown::Both);
    }
}

#[cfg(not(target_os = "android"))]
fn write_session_all(
    stream: &mut TcpStream,
    mut bytes: &[u8],
    session: &TransferSession,
) -> io::Result<()> {
    let mut deadline = Instant::now() + READ_IDLE_TIMEOUT;
    while !bytes.is_empty() {
        session.ensure_active()?;
        match stream.write(bytes) {
            Ok(0) => return Err(io::ErrorKind::WriteZero.into()),
            Ok(written) => {
                bytes = &bytes[written..];
                deadline = Instant::now() + READ_IDLE_TIMEOUT;
            }
            Err(cause)
                if matches!(
                    cause.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) && Instant::now() < deadline => {}
            Err(cause) => return Err(cause),
        }
    }
    session.ensure_active()
}

#[cfg(not(target_os = "android"))]
fn publish_received_archive(
    session: &TransferSession,
    temporary: &Path,
    destination: &Path,
    publish: impl FnOnce(),
) -> io::Result<()> {
    // A completion wins before cancellation, or cancellation wins and neither
    // the final archive nor its import event is published.
    let _connection = session
        .connection
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    session.ensure_active()?;
    fs::rename(temporary, destination)?;
    publish();
    Ok(())
}

#[cfg(not(target_os = "android"))]
struct RequestHead {
    method: String,
    path: String,
    headers: std::collections::HashMap<String, String>,
    content_length: Option<u64>,
}

#[cfg(not(target_os = "android"))]
struct SessionReader<'a> {
    stream: &'a mut TcpStream,
    session: &'a TransferSession,
}

#[cfg(not(target_os = "android"))]
impl<'a> SessionReader<'a> {
    fn new(stream: &'a mut TcpStream, session: &'a TransferSession) -> io::Result<Self> {
        // On Windows, shutdown on a duplicated socket does not reliably wake
        // a recv already pending on the original handle. Poll the session
        // while preserving the full inactivity allowance for slow senders.
        stream.set_read_timeout(Some(READ_POLL_TIMEOUT))?;
        Ok(Self { stream, session })
    }
}

#[cfg(not(target_os = "android"))]
impl Read for SessionReader<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let deadline = Instant::now() + READ_IDLE_TIMEOUT;
        loop {
            self.session.ensure_active()?;
            let result = self.stream.read(buffer);
            self.session.ensure_active()?;
            match result {
                Err(cause)
                    if matches!(
                        cause.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                    ) && Instant::now() < deadline => {}
                result => return result,
            }
        }
    }
}

#[cfg(not(target_os = "android"))]
fn read_header_line(
    reader: &mut impl BufRead,
    line: &mut String,
    remaining: &mut usize,
) -> Result<(), (u16, &'static str)> {
    line.clear();
    // Bound the allocation while reading, including peers that never send a
    // newline. One extra byte distinguishes an oversized line from a line
    // exactly at the limit; the budget covers the request line and all headers.
    let read = reader
        .take((*remaining + 1) as u64)
        .read_line(line)
        .map_err(|_| (400, "请求头无效。"))?;
    if read > *remaining {
        return Err((431, "请求头过大。"));
    }
    *remaining -= read;
    if read == 0 || !line.ends_with('\n') {
        return Err((400, "请求头无效。"));
    }
    Ok(())
}

#[cfg(not(target_os = "android"))]
fn read_request_head(reader: &mut impl BufRead) -> Result<RequestHead, (u16, &'static str)> {
    let mut remaining = MAX_HEADER_BYTES;
    let mut line = String::new();
    read_header_line(reader, &mut line, &mut remaining)?;
    let mut parts = line.trim_end_matches(['\r', '\n']).split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let path = parts.next().unwrap_or_default().to_string();
    let version = parts.next().unwrap_or_default();
    if method.is_empty() || path.len() > 2048 || version != "HTTP/1.1" || parts.next().is_some() {
        return Err((400, "请求头无效。"));
    }
    let mut headers = std::collections::HashMap::new();
    for _ in 0..MAX_HEADER_COUNT {
        read_header_line(reader, &mut line, &mut remaining)?;
        if line == "\r\n" || line == "\n" {
            let content_length = headers
                .get("content-length")
                .and_then(|value: &String| value.parse::<u64>().ok());
            if headers.contains_key("content-length") && content_length.is_none() {
                return Err((400, "文件大小无效。"));
            }
            return Ok(RequestHead {
                method,
                path,
                headers,
                content_length,
            });
        }
        let Some((name, value)) = line.trim_end_matches(['\r', '\n']).split_once(':') else {
            return Err((400, "请求头无效。"));
        };
        let name = name.trim().to_ascii_lowercase();
        let value = value.trim().to_string();
        if name.is_empty() || name.len() > 128 || headers.contains_key(&name) {
            return Err((400, "请求头无效。"));
        }
        headers.insert(name, value);
    }
    Err((431, "请求头过大。"))
}

#[cfg(not(target_os = "android"))]
fn copy_request_body(
    reader: &mut impl Read,
    output: &mut File,
    expected: u64,
    session: &TransferSession,
) -> io::Result<(u64, String, Vec<u8>, bool)> {
    let mut remaining = expected;
    let mut hasher = Sha256::new();
    let mut prefix = Vec::with_capacity(4);
    let mut buffer = vec![0_u8; 1024 * 1024];
    let mut copied = 0_u64;
    while remaining > 0 {
        session.ensure_active()?;
        let amount = remaining.min(buffer.len() as u64) as usize;
        let read = reader.read(&mut buffer[..amount])?;
        session.ensure_active()?;
        if read == 0 {
            return Ok((copied, format!("{:x}", hasher.finalize()), prefix, false));
        }
        output.write_all(&buffer[..read])?;
        hasher.update(&buffer[..read]);
        if prefix.len() < 4 {
            prefix.extend_from_slice(&buffer[..read.min(4 - prefix.len())]);
        }
        copied += read as u64;
        remaining -= read as u64;
    }
    Ok((
        copied,
        format!("{:x}", hasher.finalize()),
        prefix,
        copied == expected,
    ))
}

fn prepare_transfer_root(root: &Path) -> Result<PathBuf, CommandError> {
    crate::security::reject_symlink_components(root)
        .map_err(|cause| error("phone_transfer.path", cause.to_string()))?;
    let directory = root.join("local-transfers");
    fs::create_dir_all(&directory).map_err(command_error)?;
    crate::security::reject_symlink_components(&directory)
        .map_err(|cause| error("phone_transfer.path", cause.to_string()))?;
    let canonical = fs::canonicalize(directory).map_err(command_error)?;
    #[cfg(windows)]
    let canonical = {
        use std::path::{Component, Prefix};

        // canonicalize adds a Windows device prefix even for an ordinary
        // local directory. Only normalize this app-controlled, link-checked
        // path; user-supplied device paths remain rejected by diary_scan.
        let mut components = canonical.components();
        let drive = match components.next() {
            Some(Component::Prefix(prefix)) => match prefix.kind() {
                Prefix::VerbatimDisk(drive) | Prefix::Disk(drive) => drive,
                _ => return Err(error("phone_transfer.path", "接收目录必须位于本地磁盘。")),
            },
            _ => return Err(error("phone_transfer.path", "接收目录必须是本地绝对路径。")),
        };
        let mut ordinary = PathBuf::from(format!("{}:\\", char::from(drive)));
        for component in components {
            match component {
                Component::RootDir => {}
                Component::Normal(name) => ordinary.push(name),
                _ => return Err(error("phone_transfer.path", "接收目录路径无效。")),
            }
        }
        crate::security::reject_symlink_components(&ordinary)
            .map_err(|cause| error("phone_transfer.path", cause.to_string()))?;
        // Removing verbatim semantics must not resolve to another directory
        // (for example a Windows name with trailing spaces or dots).
        if fs::canonicalize(&ordinary).map_err(command_error)? != canonical {
            return Err(error(
                "phone_transfer.path",
                "接收目录规范化后位置发生变化。",
            ));
        }
        ordinary
    };
    Ok(canonical)
}

#[cfg(not(target_os = "android"))]
fn write_response(stream: &mut TcpStream, status: u16, body: &str) -> io::Result<()> {
    let reason = match status {
        201 => "Created",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        409 => "Conflict",
        410 => "Gone",
        411 => "Length Required",
        413 => "Payload Too Large",
        415 => "Unsupported Media Type",
        431 => "Request Header Fields Too Large",
        _ => "Internal Server Error",
    };
    let bytes = body.as_bytes();
    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        bytes.len(),
        body
    )?;
    stream.flush()
}

#[cfg(not(target_os = "android"))]
fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (a, b)| difference | (a ^ b))
        == 0
}

#[cfg(target_os = "android")]
#[tauri::command]
pub(super) async fn phone_transfer_receive(
    app: AppHandle,
    request: PhoneTransferReceiveRequest,
) -> Result<PhoneTransferSendResult, CommandError> {
    let root = app.state::<AppState>().root.clone();
    tauri::async_runtime::spawn_blocking(move || receive_archive(&root, request))
        .await
        .map_err(|cause| error("phone_transfer.worker", cause.to_string()))?
}

#[cfg(any(target_os = "android", test))]
fn receive_archive(
    root: &Path,
    request: PhoneTransferReceiveRequest,
) -> Result<PhoneTransferSendResult, CommandError> {
    let endpoint = validate_private_endpoint(&request.server_url)?;
    validate_token(&request.token)?;
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(StdDuration::from_secs(10))
        .timeout(StdDuration::from_secs(10 * 60))
        .build()
        .map_err(|cause| error("phone_transfer.network", cause.to_string()))?;
    let mut response = client
        .get(endpoint)
        .header("X-Life-Timeline-Token", &request.token)
        .send()
        .map_err(|cause| {
            error(
                "phone_transfer.network",
                format!("手机未能连接电脑: {cause}"),
            )
        })?;
    if response.status().as_u16() != 200 {
        let message = match response.status().as_u16() {
            401 | 403 => "连接码不正确，请重新核对。",
            404 | 405 => "请在电脑选择发送到手机，并使用对应的连接地址。",
            409 | 410 => "此连接已使用或已结束，请在电脑重新生成。",
            _ => "电脑未能提供日记包，请重新生成连接。",
        };
        return Err(error("phone_transfer.rejected", message));
    }
    let headers = response.headers();
    let single_header = |name: &str| -> Option<&str> {
        let mut values = headers.get_all(name).iter();
        let first = values.next()?.to_str().ok()?;
        if values.next().is_some() {
            None
        } else {
            Some(first)
        }
    };
    let expected = single_header("content-length").and_then(|text| text.parse::<u64>().ok());
    let expected_sha = single_header("x-life-timeline-sha256").unwrap_or_default();
    if single_header("content-type")
        .is_none_or(|value| !value.eq_ignore_ascii_case("application/zip"))
        || headers.contains_key("transfer-encoding")
        || headers
            .get("content-encoding")
            .is_some_and(|value| value.as_bytes() != b"identity")
        || expected.is_none_or(|size| size == 0 || size > MAX_TRANSFER_BYTES)
        || expected_sha.len() != 64
        || !expected_sha.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(error(
            "phone_transfer.response",
            "电脑返回的日记包信息无效或超过 512 MB。",
        ));
    }
    let expected_sha = expected_sha.to_ascii_lowercase();
    receive_response_body(root, &mut response, expected.unwrap(), &expected_sha)
}

#[cfg(any(target_os = "android", test))]
fn receive_response_body(
    root: &Path,
    reader: &mut impl Read,
    expected: u64,
    expected_sha: &str,
) -> Result<PhoneTransferSendResult, CommandError> {
    if expected == 0 || expected > MAX_TRANSFER_BYTES {
        return Err(error("phone_transfer.response", "日记包大小无效。"));
    }
    let directory = prepare_transfer_root(root)?;
    let id = Uuid::new_v4().simple().to_string();
    let temporary = directory.join(format!(".received-{id}.tmp"));
    let destination = directory.join(format!("received-{id}.zip"));
    let result = (|| -> Result<PhoneTransferSendResult, CommandError> {
        let mut output = crate::security::create_new_file(&temporary)
            .map_err(|cause| error("phone_transfer.archive", cause.to_string()))?;
        let mut hasher = Sha256::new();
        let mut received = 0_u64;
        let mut buffer = vec![0; 64 * 1024];
        // Read at most one byte beyond the declared length, including test
        // and future transports that do not enforce HTTP Content-Length.
        let mut limited = reader.take(expected + 1);
        loop {
            let read = limited.read(&mut buffer).map_err(command_error)?;
            if read == 0 {
                break;
            }
            received += read as u64;
            if received > expected {
                return Err(error(
                    "phone_transfer.length",
                    "日记包长度与电脑提供的信息不一致。",
                ));
            }
            output.write_all(&buffer[..read]).map_err(command_error)?;
            hasher.update(&buffer[..read]);
        }
        let sha256 = format!("{:x}", hasher.finalize());
        if received != expected || sha256 != expected_sha {
            return Err(error(
                "phone_transfer.integrity",
                "日记包传输不完整或校验失败，请重新发送。",
            ));
        }
        output.sync_all().map_err(command_error)?;
        drop(output);
        checked_diary_archive(&temporary)?;
        fs::rename(&temporary, &destination).map_err(command_error)?;
        Ok(PhoneTransferSendResult {
            archive_path: destination.to_string_lossy().into_owned(),
            byte_size: received,
            sha256,
        })
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
        let _ = fs::remove_file(&destination);
    }
    result
}

#[cfg(target_os = "android")]
#[tauri::command]
pub(super) async fn phone_transfer_send(
    app: AppHandle,
    request: PhoneTransferSendRequest,
) -> Result<PhoneTransferSendResult, CommandError> {
    tauri::async_runtime::spawn_blocking(move || send_archive(&app, request))
        .await
        .map_err(|cause| error("phone_transfer.worker", cause.to_string()))?
}

#[cfg(target_os = "android")]
fn send_archive(
    app: &AppHandle,
    request: PhoneTransferSendRequest,
) -> Result<PhoneTransferSendResult, CommandError> {
    let endpoint = validate_private_endpoint(&request.server_url)?;
    validate_token(&request.token)?;
    if !request.archive_path.starts_with("content:")
        && !PathBuf::from(&request.archive_path).is_absolute()
    {
        return Err(error(
            "phone_transfer.archive",
            "手机压缩包路径必须来自文件选择器。",
        ));
    }
    let state = app.state::<AppState>();
    let requested_archive_path = request.archive_path.clone();
    let prepared = crate::mobile::prepare_sources(app, &state.root, vec![request.archive_path])?;
    let path = PathBuf::from(&prepared.paths[0]);
    let path = fs::canonicalize(&path).map_err(|_| {
        error(
            "phone_transfer.archive",
            "手机压缩包路径无效，请重新选择 ZIP 文件。",
        )
    })?;
    crate::security::reject_symlink_components(&path)
        .map_err(|cause| error("phone_transfer.archive", cause.to_string()))?;
    let metadata = fs::metadata(&path)
        .map_err(|_| error("phone_transfer.archive", "无法读取手机上的 ZIP 文件。"))?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_TRANSFER_BYTES {
        return Err(error(
            "phone_transfer.archive",
            "ZIP 文件为空或超过 512 MB。",
        ));
    }
    let (size, sha256) = crate::security::sha256_file(&path)
        .map_err(|cause| error("phone_transfer.archive", cause.to_string()))?;
    let file = File::open(&path)
        .map_err(|_| error("phone_transfer.archive", "无法打开手机上的 ZIP 文件。"))?;
    let mut signature = [0_u8; 2];
    let mut signature_file = File::open(&path)
        .map_err(|_| error("phone_transfer.archive", "无法读取手机上的 ZIP 文件。"))?;
    std::io::Read::read_exact(&mut signature_file, &mut signature)
        .map_err(|_| error("phone_transfer.archive", "ZIP 文件内容不完整。"))?;
    if signature != *b"PK" {
        return Err(error(
            "phone_transfer.archive",
            "请选择由 life-timeline 导出的 ZIP 日记包。",
        ));
    }
    // reqwest is built with `rustls-no-provider` so the desktop AI client can
    // select its provider explicitly. Install the same ring provider before
    // constructing the blocking client, even though the handoff itself is
    // plain HTTP, because reqwest initializes its TLS connector eagerly.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(StdDuration::from_secs(10 * 60))
        .build()
        .map_err(|cause| error("phone_transfer.network", cause.to_string()))?;
    let response = client
        .post(endpoint)
        .header("X-Life-Timeline-Token", &request.token)
        .header("Content-Type", "application/zip")
        .header("Content-Length", size)
        .body(reqwest::blocking::Body::sized(file, size))
        .send()
        .map_err(|cause| {
            error(
                "phone_transfer.network",
                format!("手机未能连接电脑: {cause}"),
            )
        })?;
    let status = response.status();
    if !status.is_success() {
        let message = match status.as_u16() {
            401 | 403 => "连接码不正确或已失效，请在电脑上重新生成。",
            409 => "这个连接码已经使用过了。",
            410 => "电脑上的连接已过期，请重新生成。",
            413 => "日记压缩包超过电脑允许的大小。",
            _ => "电脑未能接收日记压缩包。",
        };
        return Err(error("phone_transfer.rejected", message));
    }
    Ok(PhoneTransferSendResult {
        archive_path: requested_archive_path,
        byte_size: size,
        sha256,
    })
}

fn validate_token(token: &str) -> Result<(), CommandError> {
    if token.len() != 32 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(error(
            "phone_transfer.token",
            "连接码格式无效，请重新生成。",
        ));
    }
    Ok(())
}

#[cfg(any(target_os = "android", test))]
fn validate_private_endpoint(raw: &str) -> Result<url::Url, CommandError> {
    if raw.len() > 2048 || raw.chars().any(char::is_control) {
        return Err(error("phone_transfer.url", "电脑连接地址无效。"));
    }
    let parsed =
        url::Url::parse(raw).map_err(|_| error("phone_transfer.url", "电脑连接地址无效。"))?;
    if parsed.scheme() != "http"
        || parsed.port().is_none()
        || parsed.port() == Some(0)
        || parsed.username() != ""
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || parsed.path() != ENDPOINT_PATH
    {
        return Err(error(
            "phone_transfer.url",
            "只允许连接同一局域网中的 life-timeline。",
        ));
    }
    let host = parsed
        .host()
        .ok_or_else(|| error("phone_transfer.url", "电脑连接地址缺少 IP 地址。"))?;
    let allowed = match host {
        url::Host::Ipv4(address) => {
            address.is_private() || address.is_loopback() || address.is_link_local()
        }
        url::Host::Ipv6(address) => {
            address.is_loopback()
                || address.is_unicast_link_local()
                || (address.segments()[0] & 0xfe00) == 0xfc00
        }
        url::Host::Domain(name) => name.eq_ignore_ascii_case("localhost"),
    };
    if !allowed {
        return Err(error(
            "phone_transfer.url",
            "只允许连接同一局域网中的 life-timeline。",
        ));
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(not(target_os = "android"))]
    #[test]
    fn constant_time_compare_rejects_different_lengths_and_values() {
        assert!(constant_time_eq(b"abcd", b"abcd"));
        assert!(!constant_time_eq(b"abcd", b"abce"));
        assert!(!constant_time_eq(b"abcd", b"abc"));
    }

    #[test]
    fn private_endpoint_rejects_public_hosts_and_non_http_urls() {
        assert!(
            validate_private_endpoint("https://192.168.1.5:1234/api/v1/phone-transfer").is_err()
        );
        assert!(
            validate_private_endpoint("http://example.com:1234/api/v1/phone-transfer").is_err()
        );
        assert!(validate_private_endpoint("http://8.8.8.8:1234/api/v1/phone-transfer").is_err());
        assert!(validate_private_endpoint("http://192.168.1.5:1234/other").is_err());
        assert!(validate_private_endpoint("http://192.168.1.5/api/v1/phone-transfer").is_err());
        assert!(validate_private_endpoint("http://192.168.1.5:0/api/v1/phone-transfer").is_err());
        assert!(
            validate_private_endpoint("http://user@192.168.1.5:1234/api/v1/phone-transfer")
                .is_err()
        );
        assert!(validate_private_endpoint(
            "http://192.168.1.5:1234/api/v1/phone-transfer?token=ignored"
        )
        .is_err());
        assert!(validate_private_endpoint("http://192.168.1.5:1234/api/v1/phone-transfer").is_ok());
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn transfer_root_stays_below_application_root() {
        let root = tempfile::tempdir().unwrap();
        let path = prepare_transfer_root(root.path()).unwrap();
        assert!(path
            .canonicalize()
            .unwrap()
            .starts_with(root.path().canonicalize().unwrap()));
        assert_eq!(
            path.file_name().and_then(|value| value.to_str()),
            Some("local-transfers")
        );
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn received_archive_path_is_accepted_by_real_diary_scan() {
        use crate::diary_transfer::{
            export_diaries, scan_diaries, DiaryExportRequest, DiaryScanRequest,
        };

        let source_directory = tempfile::tempdir().unwrap();
        let target_directory = tempfile::tempdir().unwrap();
        let source = AppState::open(source_directory.path().to_path_buf()).unwrap();
        let target = AppState::open(target_directory.path().to_path_buf()).unwrap();
        let diary = crate::models::LifeEvent {
            id: "phone-path-fixture".into(),
            title: "2026-10-03 日记".into(),
            record_type: "daily".into(),
            date: "2026-10-03".into(),
            display_date: "2026-10-03".into(),
            date_precision: "day".into(),
            stage_id: None,
            importance: 3,
            summary: "Synthetic phone transfer path regression".into(),
            content: "Synthetic phone transfer path regression".into(),
            rich_content: None,
            attachment_ids: Vec::new(),
        };
        source
            .repository
            .lock()
            .unwrap()
            .save_snapshot(&[diary], &[], &serde_json::json!({}), 1)
            .unwrap();
        let exported = export_diaries(
            &source,
            DiaryExportRequest {
                destination_path: source_directory
                    .path()
                    .join("phone-export.zip")
                    .to_string_lossy()
                    .into_owned(),
                start_date: None,
                end_date: None,
                overwrite: false,
            },
        )
        .unwrap();
        let transfer_root = prepare_transfer_root(&target.root).unwrap();
        let temporary = transfer_root.join(".received-fixture.tmp");
        let destination = transfer_root.join("received-fixture.zip");
        fs::copy(&exported.archive_path, &temporary).unwrap();
        let session = test_session("received-path-fixture");
        publish_received_archive(&session, &temporary, &destination, || {}).unwrap();
        let received = PhoneTransferReceived {
            session_id: session.session_id.clone(),
            archive_path: destination.to_string_lossy().into_owned(),
            byte_size: exported.byte_size,
            sha256: exported.sha256,
            received_at: Utc::now().to_rfc3339(),
        };
        #[cfg(windows)]
        {
            assert!(!received.archive_path.starts_with("\\\\?\\"));
            // The broad IPC validator must continue rejecting callers that
            // explicitly supply a device path, even to this same real ZIP.
            let device_path = fs::canonicalize(&destination).unwrap();
            assert!(crate::validate_user_archive_path(&device_path.to_string_lossy()).is_err());
        }
        let scanned = scan_diaries(
            &target,
            DiaryScanRequest {
                archive_path: received.archive_path,
            },
        )
        .unwrap();
        assert!(scanned.can_import);
        assert_eq!(scanned.diary_count, 1);
        assert_eq!(scanned.new_count, 1);
        assert_eq!(scanned.archive_sha256, received.sha256);
        assert_eq!(scanned.diaries[0].id, "phone-path-fixture");
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn request_line_without_newline_is_rejected_before_reading_unbounded_input() {
        let mut request = io::Cursor::new(vec![b'A'; MAX_HEADER_BYTES * 128]);
        let error = read_request_head(&mut request).err().unwrap();
        assert_eq!(error.0, 431);
        assert_eq!(request.position(), (MAX_HEADER_BYTES + 1) as u64);
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn header_without_newline_is_rejected_before_reading_unbounded_input() {
        let mut bytes = b"POST /api/v1/phone-transfer HTTP/1.1\r\nX-Padding: ".to_vec();
        bytes.extend(vec![b'A'; MAX_HEADER_BYTES * 128]);
        let mut request = io::Cursor::new(bytes);
        let error = read_request_head(&mut request).err().unwrap();
        assert_eq!(error.0, 431);
        assert_eq!(request.position(), (MAX_HEADER_BYTES + 1) as u64);
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn header_budget_limits_the_combined_size_of_short_header_lines() {
        let mut bytes = b"POST /api/v1/phone-transfer HTTP/1.1\r\n".to_vec();
        for index in 0..32 {
            bytes.extend(format!("X-Padding-{index}: {}\r\n", "A".repeat(512)).as_bytes());
        }
        bytes.extend(b"\r\n");
        let mut request = io::Cursor::new(bytes);
        let error = read_request_head(&mut request).err().unwrap();
        assert_eq!(error.0, 431);
        assert_eq!(request.position(), (MAX_HEADER_BYTES + 1) as u64);
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn bounded_headers_parse_valid_upload_without_consuming_its_body() {
        let head = b"POST /api/v1/phone-transfer HTTP/1.1\r\nContent-Type: application/zip\r\nContent-Length: 4\r\nX-Life-Timeline-Token: synthetic-token\r\n\r\n";
        let mut bytes = head.to_vec();
        bytes.extend(b"PK\x03\x04");
        let mut request = io::Cursor::new(bytes);
        let parsed = read_request_head(&mut request).unwrap();
        assert_eq!(parsed.method, "POST");
        assert_eq!(parsed.path, ENDPOINT_PATH);
        assert_eq!(parsed.content_length, Some(4));
        assert_eq!(parsed.headers["content-type"], "application/zip");
        assert_eq!(parsed.headers["x-life-timeline-token"], "synthetic-token");
        assert_eq!(request.position(), head.len() as u64);
        let mut body = Vec::new();
        request.read_to_end(&mut body).unwrap();
        assert_eq!(body, b"PK\x03\x04");
    }

    #[cfg(not(target_os = "android"))]
    fn test_session(session_id: &str) -> Arc<TransferSession> {
        Arc::new(TransferSession {
            session_id: session_id.into(),
            token: "0123456789abcdef0123456789abcdef".into(),
            expires_at: Utc::now() + Duration::seconds(60),
            port: 0,
            consumed: AtomicBool::new(false),
            stopped: AtomicBool::new(false),
            connection: Mutex::new(None),
            offer: None,
        })
    }

    #[cfg(not(target_os = "android"))]
    fn phone_fixture(root: &Path) -> AppState {
        let state = AppState::open(root.to_path_buf()).unwrap();
        let events: Vec<crate::models::LifeEvent> = ["2026-10-01", "2026-10-02"]
            .iter()
            .map(|date| {
                serde_json::from_value(serde_json::json!({
                    "id": format!("synthetic-{date}"), "title": format!("{date} 日记"),
                    "type":"daily", "date":date, "displayDate":date, "datePrecision":"day",
                    "importance":3, "summary":"合成测试", "content":"合成日记，仅用于互联回归",
                    "attachmentIds":[]
                }))
                .unwrap()
            })
            .collect();
        state
            .repository
            .lock()
            .unwrap()
            .save_snapshot(
                &events,
                &[],
                &serde_json::json!({"syntheticPrivateSetting":"must-stay-local"}),
                1,
            )
            .unwrap();
        let snapshot = state.repository.lock().unwrap().load_snapshot().unwrap();
        assert_eq!(snapshot.events.len(), 2);
        assert!(snapshot
            .events
            .iter()
            .all(|event| event.record_type == "daily"));
        state
    }

    #[cfg(not(target_os = "android"))]
    fn full_offer(state: &AppState) -> OfferedArchive {
        prepare_offer(
            state,
            PhoneTransferOfferRequest {
                archive_path: None,
                start_date: None,
                end_date: None,
            },
        )
        .unwrap()
    }

    #[cfg(not(target_os = "android"))]
    fn offered_session(offer: OfferedArchive) -> Arc<TransferSession> {
        let mut session = test_session("offered-session");
        Arc::get_mut(&mut session).unwrap().offer = Some(offer);
        session
    }

    #[cfg(not(target_os = "android"))]
    fn read_framed_test_response(source: impl Read) -> io::Result<Vec<u8>> {
        let mut reader = BufReader::new(source);
        let mut response = Vec::new();
        loop {
            let start = response.len();
            if reader.read_until(b'\n', &mut response)? == 0 {
                return Err(io::ErrorKind::UnexpectedEof.into());
            }
            if response.len() > MAX_HEADER_BYTES {
                return Err(io::ErrorKind::InvalidData.into());
            }
            if &response[start..] == b"\r\n" {
                break;
            }
        }
        let header = std::str::from_utf8(&response)
            .map_err(|_| io::Error::from(io::ErrorKind::InvalidData))?;
        let length = header
            .lines()
            .filter_map(|line| line.split_once(':'))
            .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
            .and_then(|(_, value)| value.trim().parse::<usize>().ok())
            .filter(|length| *length as u64 <= MAX_TRANSFER_BYTES)
            .ok_or(io::ErrorKind::InvalidData)?;
        let body_start = response.len();
        response.resize(body_start + length, 0);
        // HTTP completeness is defined by Content-Length, not TCP EOF.
        // Windows may reset a just-closed loopback socket after delivering
        // its complete response; a reset before these bytes still fails.
        reader.read_exact(&mut response[body_start..])?;
        Ok(response)
    }

    #[cfg(not(target_os = "android"))]
    fn raw_offer_request(
        session: &Arc<TransferSession>,
        method: &str,
        token: Option<&str>,
    ) -> (Vec<u8>, bool) {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let mut client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        client
            .set_read_timeout(Some(StdDuration::from_secs(5)))
            .unwrap();
        let receiver = session.clone();
        let worker = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut sent = false;
            handle_connection_with_events(
                stream,
                Path::new("unused"),
                &receiver,
                |_| panic!("wrong-direction request must not publish an upload"),
                |_| sent = true,
            );
            receiver.clear_connection();
            sent
        });
        let token = token
            .map(|token| format!("X-Life-Timeline-Token: {token}\r\n"))
            .unwrap_or_default();
        write!(
            client,
            "{method} {ENDPOINT_PATH} HTTP/1.1\r\nHost: localhost\r\n{token}\r\n"
        )
        .unwrap();
        let response = read_framed_test_response(client).unwrap();
        (response, worker.join().unwrap())
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn framed_response_requires_complete_headers_and_body_before_socket_reset() {
        struct ResetAfterBytes<'a>(io::Cursor<&'a [u8]>);
        impl Read for ResetAfterBytes<'_> {
            fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
                match self.0.read(bytes)? {
                    0 => Err(io::ErrorKind::ConnectionReset.into()),
                    amount => Ok(amount),
                }
            }
        }
        let complete = b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: 8\r\n\r\nrejected";
        assert_eq!(
            read_framed_test_response(ResetAfterBytes(io::Cursor::new(complete))).unwrap(),
            complete,
        );
        for truncated in [
            &complete[..complete.len() - 1],
            b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: 8\r\n",
        ] {
            assert_eq!(
                read_framed_test_response(ResetAfterBytes(io::Cursor::new(truncated)))
                    .unwrap_err()
                    .kind(),
                io::ErrorKind::ConnectionReset,
            );
        }
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn streamed_get_to_android_receiver_remains_pending_until_real_diary_import() {
        let source_root = tempfile::tempdir().unwrap();
        let target_root = tempfile::tempdir().unwrap();
        let source = phone_fixture(source_root.path());
        let target = AppState::open(target_root.path().to_path_buf()).unwrap();
        let offer = prepare_offer(
            &source,
            PhoneTransferOfferRequest {
                archive_path: None,
                start_date: Some("2026-10-02".into()),
                end_date: Some("2026-10-02".into()),
            },
        )
        .unwrap();
        assert_eq!(offer.diary_count, 1);
        let frozen = offer.path.clone();
        let (life, _, _) = crate::scan_zip_inner(&frozen, true).unwrap();
        assert_eq!(life["preferences"], serde_json::json!({}));
        let expected_hash = offer.sha256.clone();
        let session = offered_session(offer);
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let address = format!("http://{}{}", listener.local_addr().unwrap(), ENDPOINT_PATH);
        let receiving_session = session.clone();
        let worker = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut sent = None;
            handle_connection_with_events(
                stream,
                Path::new("unused"),
                &receiving_session,
                |_| panic!("GET cannot receive an upload"),
                |event| sent = Some(event),
            );
            receiving_session.clear_connection();
            receiving_session.stop();
            sent.unwrap()
        });
        let received = receive_archive(
            &target.root,
            PhoneTransferReceiveRequest {
                server_url: address,
                token: session.token.clone(),
            },
        )
        .unwrap();
        let sent = worker.join().unwrap();
        assert_eq!(received.sha256, expected_hash);
        assert_eq!(sent.sha256, received.sha256);
        assert_eq!(sent.byte_size, received.byte_size);
        assert!(!frozen.exists());
        assert!(target
            .repository
            .lock()
            .unwrap()
            .load_snapshot()
            .unwrap()
            .events
            .is_empty());
        let scan = crate::diary_transfer::scan_diaries(
            &target,
            crate::diary_transfer::DiaryScanRequest {
                archive_path: received.archive_path.clone(),
            },
        )
        .unwrap();
        assert_eq!(scan.diary_count, 1);
        assert_eq!(scan.diaries[0].date, "2026-10-02");
        let imported = crate::diary_transfer::import_diaries(
            &target,
            crate::diary_transfer::DiaryImportRequest {
                schedule_decisions: Vec::new(),
                archive_path: received.archive_path,
                scan_token: scan.scan_token,
                decisions: vec![],
            },
        )
        .unwrap();
        assert_eq!(imported.added, 1);
        assert_eq!(
            source
                .repository
                .lock()
                .unwrap()
                .load_snapshot()
                .unwrap()
                .events
                .len(),
            2
        );
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn selected_archive_is_frozen_and_get_rejects_wrong_direction_tokens_and_replays() {
        let root = tempfile::tempdir().unwrap();
        let state = phone_fixture(root.path());
        let original = full_offer(&state);
        let bytes = fs::read(&original.path).unwrap();
        let copied = prepare_offer(
            &state,
            PhoneTransferOfferRequest {
                archive_path: Some(original.path.to_string_lossy().into_owned()),
                start_date: None,
                end_date: None,
            },
        )
        .unwrap();
        let frozen = copied.path.clone();
        fs::write(&original.path, b"changed original").unwrap();
        fs::remove_file(&original.path).unwrap();
        let session = offered_session(copied);
        for (method, token, expected) in [
            ("POST", Some(session.token.as_str()), "HTTP/1.1 404"),
            ("GET", None, "HTTP/1.1 401"),
            (
                "GET",
                Some("ffffffffffffffffffffffffffffffff"),
                "HTTP/1.1 403",
            ),
        ] {
            let (response, sent) = raw_offer_request(&session, method, token);
            assert!(response.starts_with(expected.as_bytes()));
            assert!(!sent);
            assert!(!session.consumed.load(Ordering::SeqCst));
            assert!(frozen.exists());
        }
        let (response, sent) = raw_offer_request(&session, "GET", Some(&session.token));
        assert!(response.starts_with(b"HTTP/1.1 200"));
        let body_start = response
            .windows(4)
            .position(|bytes| bytes == b"\r\n\r\n")
            .unwrap()
            + 4;
        assert_eq!(&response[body_start..], bytes.as_slice());
        assert!(sent);
        assert!(!frozen.exists());
        let (response, sent) = raw_offer_request(&session, "GET", Some(&session.token));
        assert!(response.starts_with(b"HTTP/1.1 409"));
        assert!(!sent);
        let upload = test_session("upload-direction");
        let (response, _) = raw_offer_request(&upload, "GET", Some(&upload.token));
        assert!(response.starts_with(b"HTTP/1.1 404"));
        assert!(!upload.consumed.load(Ordering::SeqCst));
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn offer_rejects_full_backups_arbitrary_files_and_detects_frozen_copy_tampering() {
        let root = tempfile::tempdir().unwrap();
        let state = phone_fixture(root.path());
        let backup = root.path().join("full-backup.zip");
        crate::export_archive(&state, &backup, false).unwrap();
        let arbitrary = root.path().join("api-fixture.json");
        fs::write(&arbitrary, b"{\"synthetic\":\"not a diary\"}").unwrap();
        for path in [backup, arbitrary] {
            assert!(prepare_offer(
                &state,
                PhoneTransferOfferRequest {
                    archive_path: Some(path.to_string_lossy().into_owned()),
                    start_date: None,
                    end_date: None,
                }
            )
            .is_err());
        }
        assert_eq!(
            fs::read_dir(prepare_transfer_root(&state.root).unwrap())
                .unwrap()
                .count(),
            0
        );
        let offer = full_offer(&state);
        let frozen = offer.path.clone();
        let mut bytes = fs::read(&frozen).unwrap();
        bytes[0] ^= 1;
        fs::write(&frozen, bytes).unwrap();
        let session = offered_session(offer);
        let (response, sent) = raw_offer_request(&session, "GET", Some(&session.token));
        assert!(response.starts_with(b"HTTP/1.1 500"));
        assert!(response.ends_with("待传日记包不可用，请重新生成连接。".as_bytes()));
        assert!(!sent);
        assert!(!frozen.exists());
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn cancelling_or_expiring_an_offer_deletes_only_its_private_copy() {
        let root = tempfile::tempdir().unwrap();
        let state = phone_fixture(root.path());
        let unrelated = root.path().join("keep.txt");
        fs::write(&unrelated, b"keep synthetic unrelated file").unwrap();
        let first = offered_session(full_offer(&state));
        let first_path = first.offer.as_ref().unwrap().path.clone();
        *state.phone_transfer.current.lock().unwrap() = Some(first.clone());
        cancel(&state.phone_transfer, Some(&first.session_id)).unwrap();
        assert!(!first_path.exists());
        let mut expired = offered_session(full_offer(&state));
        let expired_path = expired.offer.as_ref().unwrap().path.clone();
        Arc::get_mut(&mut expired).unwrap().expires_at = Utc::now() - Duration::seconds(1);
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        accept_connections(listener, &expired, |_| {
            panic!("expired session must not accept")
        });
        assert!(!expired_path.exists());
        assert!(unrelated.exists());
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn android_download_core_rejects_hash_length_and_non_diary_zip_and_cleans_files() {
        let root = tempfile::tempdir().unwrap();
        let state = phone_fixture(root.path());
        let valid = full_offer(&state);
        let bytes = fs::read(&valid.path).unwrap();
        let target = tempfile::tempdir().unwrap();
        for (data, length, hash) in [
            (bytes.clone(), bytes.len() as u64, "0".repeat(64)),
            (
                bytes[..bytes.len() - 1].to_vec(),
                bytes.len() as u64,
                valid.sha256.clone(),
            ),
            (bytes.clone(), bytes.len() as u64 - 1, valid.sha256.clone()),
            (
                b"PK\x03\x04not-a-diary".to_vec(),
                15,
                format!("{:x}", Sha256::digest(b"PK\x03\x04not-a-diary")),
            ),
        ] {
            assert!(receive_response_body(
                target.path(),
                &mut io::Cursor::new(data),
                length,
                &hash
            )
            .is_err());
            assert_eq!(
                fs::read_dir(prepare_transfer_root(target.path()).unwrap())
                    .unwrap()
                    .count(),
                0
            );
        }
        let backup = root.path().join("full-backup.zip");
        crate::export_archive(&state, &backup, false).unwrap();
        let backup_bytes = fs::read(backup).unwrap();
        let hash = format!("{:x}", Sha256::digest(&backup_bytes));
        assert!(receive_response_body(
            target.path(),
            &mut io::Cursor::new(&backup_bytes),
            backup_bytes.len() as u64,
            &hash
        )
        .is_err());
        assert_eq!(
            fs::read_dir(prepare_transfer_root(target.path()).unwrap())
                .unwrap()
                .count(),
            0
        );
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn android_download_rejects_invalid_response_headers_and_redirects() {
        let target = tempfile::tempdir().unwrap();
        for header in [
            "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/api/v1/phone-transfer\r\nContent-Length: 0\r\n",
            "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 0\r\n",
            "HTTP/1.1 200 OK\r\nContent-Type: application/zip\r\nContent-Length: 536870913\r\n",
            "HTTP/1.1 200 OK\r\nContent-Type: application/zip\r\nX-Life-Timeline-SHA256: invalid\r\nContent-Length: 4\r\n",
        ] {
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
            let address = format!("http://{}{}", listener.local_addr().unwrap(), ENDPOINT_PATH);
            let worker = thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                stream.set_read_timeout(Some(StdDuration::from_secs(2))).unwrap();
                let mut reader = BufReader::new(&mut stream);
                read_request_head(&mut reader).unwrap();
                write!(stream, "{header}Connection: close\r\n\r\n").unwrap();
            });
            let result = receive_archive(target.path(), PhoneTransferReceiveRequest {
                server_url: address, token: "0123456789abcdef0123456789abcdef".into(),
            });
            assert!(result.is_err());
            if header.starts_with("HTTP/1.1 302") {
                // A followed redirect would become a network error instead.
                assert_eq!(result.err().unwrap().code, "phone_transfer.rejected");
            }
            worker.join().unwrap();
            assert!(!target.path().join("local-transfers").exists());
        }
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn delayed_cancel_cannot_stop_a_newer_session() {
        let store = TransferStore::default();
        let old_session = test_session("old-page");
        *store.current.lock().unwrap() = Some(old_session.clone());
        cancel(&store, Some("old-page")).unwrap();
        assert!(old_session.stopped.load(Ordering::SeqCst));

        let new_session = test_session("new-page");
        *store.current.lock().unwrap() = Some(new_session.clone());
        cancel(&store, Some("old-page")).unwrap();
        assert!(!new_session.stopped.load(Ordering::SeqCst));
        assert!(Arc::ptr_eq(
            store.current.lock().unwrap().as_ref().unwrap(),
            &new_session
        ));

        cancel(&store, Some("new-page")).unwrap();
        assert!(new_session.stopped.load(Ordering::SeqCst));
        assert!(store.current.lock().unwrap().is_none());
        // Repeated cleanup, including an already empty store, is harmless.
        cancel(&store, Some("new-page")).unwrap();
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn unscoped_cancel_preserves_legacy_cancel_current_semantics() {
        let store = TransferStore::default();
        let session = test_session("legacy-caller");
        *store.current.lock().unwrap() = Some(session.clone());
        cancel(&store, None).unwrap();
        assert!(session.stopped.load(Ordering::SeqCst));
        assert!(store.current.lock().unwrap().is_none());
        cancel(&store, None).unwrap();
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn cancel_interrupts_a_partially_received_upload() {
        struct WaitingReader<R> {
            stream: R,
            reads: usize,
            waiting: std::sync::mpsc::Sender<()>,
        }
        impl<R: Read> Read for WaitingReader<R> {
            fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
                if self.reads == 1 {
                    self.waiting.send(()).unwrap();
                }
                self.reads += 1;
                self.stream.read(buffer)
            }
        }

        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let mut client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (server, _) = listener.accept().unwrap();
        let store = TransferStore::default();
        let session = test_session("partial-upload");
        session.register_connection(&server).unwrap();
        *store.current.lock().unwrap() = Some(session.clone());
        let (waiting_tx, waiting_rx) = std::sync::mpsc::channel();
        let (result_tx, result_rx) = std::sync::mpsc::channel();
        let root = tempfile::tempdir().unwrap();
        let temporary = root.path().join("partial.tmp");
        let mut output = File::create(&temporary).unwrap();
        let receiving_session = session.clone();
        let worker = thread::spawn(move || {
            let mut server = server;
            let session_reader = SessionReader::new(&mut server, &receiving_session).unwrap();
            let mut reader = WaitingReader {
                stream: session_reader,
                reads: 0,
                waiting: waiting_tx,
            };
            let result = copy_request_body(&mut reader, &mut output, 64, &receiving_session);
            drop(output);
            result_tx.send(result.is_err()).unwrap();
        });
        client.write_all(b"PK\x03\x04partial").unwrap();
        waiting_rx.recv_timeout(StdDuration::from_secs(2)).unwrap();
        cancel(&store, Some("partial-upload")).unwrap();
        // Cancellation interrupts the pending read well before the normal
        // ten-second idle timeout. A partial body must never be complete.
        assert!(result_rx.recv_timeout(StdDuration::from_secs(2)).unwrap());
        worker.join().unwrap();
        let destination = root.path().join("received.zip");
        let mut published = false;
        assert!(
            publish_received_archive(&session, &temporary, &destination, || {
                published = true;
            })
            .is_err()
        );
        assert!(!published);
        assert!(!destination.exists());
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn polling_reader_keeps_waiting_for_data_while_session_is_active() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let mut client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (mut server, _) = listener.accept().unwrap();
        let session = test_session("slow-active-upload");
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let worker = thread::spawn(move || {
            let mut reader = SessionReader::new(&mut server, &session).unwrap();
            ready_tx.send(()).unwrap();
            let mut bytes = [0_u8; 4];
            reader.read_exact(&mut bytes).unwrap();
            bytes
        });
        ready_rx.recv_timeout(StdDuration::from_secs(2)).unwrap();
        thread::sleep(READ_POLL_TIMEOUT + StdDuration::from_millis(100));
        client.write_all(b"PK\x03\x04").unwrap();
        assert_eq!(worker.join().unwrap(), *b"PK\x03\x04");
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn cancelled_session_aborts_bounded_header_reading() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let _client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (mut server, _) = listener.accept().unwrap();
        let session = test_session("cancelled-header");
        session.stop();
        let (result_tx, result_rx) = std::sync::mpsc::channel();
        let worker = thread::spawn(move || {
            let reader = SessionReader::new(&mut server, &session).unwrap();
            let mut reader = BufReader::new(reader);
            // read_line retries Interrupted internally. A cancelled session
            // must instead return a terminal error through the bounded reader.
            let rejected = read_request_head(&mut reader).is_err();
            let _ = result_tx.send(rejected);
        });
        assert!(result_rx.recv_timeout(StdDuration::from_secs(2)).unwrap());
        worker.join().unwrap();
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn cancel_before_publication_keeps_archive_and_import_event_unpublished() {
        let session = test_session("completed-body");
        let root = tempfile::tempdir().unwrap();
        let temporary = root.path().join("received.tmp");
        let destination = root.path().join("received.zip");
        fs::write(&temporary, b"PK\x03\x04synthetic-archive").unwrap();
        session.stop();
        let mut published = false;
        let result = publish_received_archive(&session, &temporary, &destination, || {
            published = true;
        });
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::ConnectionAborted);
        assert!(!published);
        assert!(temporary.exists());
        assert!(!destination.exists());
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn active_session_can_finish_and_publish_the_received_archive() {
        let session = test_session("successful-upload");
        let root = tempfile::tempdir().unwrap();
        let temporary = root.path().join("received.tmp");
        let destination = root.path().join("received.zip");
        let contents = b"PK\x03\x04synthetic-archive";
        let mut reader = io::Cursor::new(contents);
        let mut output = File::create(&temporary).unwrap();
        let (size, sha256, prefix, complete) =
            copy_request_body(&mut reader, &mut output, contents.len() as u64, &session).unwrap();
        drop(output);
        assert_eq!(size, contents.len() as u64);
        assert_eq!(sha256, format!("{:x}", Sha256::digest(contents)));
        assert_eq!(prefix, b"PK\x03\x04");
        assert!(complete);
        let mut published = false;
        publish_received_archive(&session, &temporary, &destination, || {
            published = true;
        })
        .unwrap();
        assert!(published);
        assert!(!temporary.exists());
        assert_eq!(fs::read(destination).unwrap(), contents);
    }
}
