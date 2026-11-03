//! Thin IPC boundary. Blocking file parsing, model requests and SQLite work
//! run outside the desktop event loop. No request containing a key is logged.
use super::*;
use crate::ai_api::{ApiProfile, ApiSaveRequest, ApiStatus};
use crate::ai_import::{
    AiCommitResult, AiEntryEdit, AiPreview, AiStatus, InspectResult, RollbackResult,
};
use crate::diary_transfer::{DiaryDecision, DiaryScanResult};

async fn native_work<T, F>(app: tauri::AppHandle, operation: F) -> Result<T, CommandError>
where
    T: Send + 'static,
    F: FnOnce(&AppState) -> Result<T, CommandError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        operation(&state)
    })
    .await
    .map_err(|_| CommandError {
        code: "ai.task_failed".into(),
        message: "本次操作未完成，请保留原文件后重新尝试。".into(),
    })?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ProfileRequest {
    profile_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct InspectRequest {
    paths: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SessionRequest {
    session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct AnalyzeRequest {
    session_id: String,
    expected_profile: ApiProfile,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct BuildRequest {
    session_id: String,
    entries: Vec<AiEntryEdit>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CommitRequest {
    session_id: String,
    scan_token: String,
    decisions: Vec<DiaryDecision>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct UndoRequest {
    undo_id: String,
}

#[tauri::command]
pub(super) async fn api_status(app: tauri::AppHandle) -> Result<ApiStatus, CommandError> {
    native_work(app, |state| ai_api::status(&state.root)).await
}

#[tauri::command]
pub(super) async fn api_save(
    app: tauri::AppHandle,
    request: ApiSaveRequest,
) -> Result<ApiStatus, CommandError> {
    native_work(app, move |state| ai_api::save(&state.root, &request)).await
}

#[tauri::command]
pub(super) async fn api_apply(
    app: tauri::AppHandle,
    request: ProfileRequest,
) -> Result<ApiStatus, CommandError> {
    native_work(app, move |state| {
        ai_api::apply(&state.root, &request.profile_id)
    })
    .await
}

#[tauri::command]
pub(super) async fn api_remove(
    app: tauri::AppHandle,
    request: ProfileRequest,
) -> Result<ApiStatus, CommandError> {
    native_work(app, move |state| {
        ai_api::remove(&state.root, &request.profile_id)
    })
    .await
}

#[tauri::command]
pub(super) async fn ai_import_inspect(
    app: tauri::AppHandle,
    request: InspectRequest,
) -> Result<InspectResult, CommandError> {
    #[cfg(target_os = "android")]
    let mobile_app = app.clone();
    native_work(app, move |state| {
        #[cfg(target_os = "android")]
        {
            let mut prepared = mobile::prepare_sources(&mobile_app, &state.root, request.paths)?;
            let result = ai_import::inspect(state, prepared.paths.clone())?;
            if matches!(result, InspectResult::Native { .. }) {
                prepared.preserve();
            }
            Ok(result)
        }
        #[cfg(not(target_os = "android"))]
        ai_import::inspect(state, request.paths)
    })
    .await
}

#[tauri::command]
pub(super) async fn ai_import_analyze(
    app: tauri::AppHandle,
    request: AnalyzeRequest,
) -> Result<AiPreview, CommandError> {
    native_work(app, move |state| {
        ai_import::analyze(state, &request.session_id, &request.expected_profile)
    })
    .await
}

#[tauri::command]
pub(super) async fn ai_import_build(
    app: tauri::AppHandle,
    request: BuildRequest,
) -> Result<DiaryScanResult, CommandError> {
    native_work(app, move |state| {
        ai_import::build_archive(state, &request.session_id, request.entries)
    })
    .await
}

#[tauri::command]
pub(super) async fn ai_import_commit(
    app: tauri::AppHandle,
    request: CommitRequest,
) -> Result<AiCommitResult, CommandError> {
    native_work(app, move |state| {
        ai_import::commit(
            state,
            &request.session_id,
            &request.scan_token,
            request.decisions,
        )
    })
    .await
}

#[tauri::command]
pub(super) async fn ai_import_status(app: tauri::AppHandle) -> Result<AiStatus, CommandError> {
    native_work(app, ai_import::status).await
}

#[tauri::command]
pub(super) async fn ai_import_discard(
    app: tauri::AppHandle,
    request: SessionRequest,
) -> Result<(), CommandError> {
    native_work(app, move |state| {
        ai_import::discard(state, &request.session_id)
    })
    .await
}

#[tauri::command]
pub(super) async fn ai_import_rollback(
    app: tauri::AppHandle,
    request: UndoRequest,
) -> Result<RollbackResult, CommandError> {
    native_work(app, move |state| {
        ai_import::rollback(state, &request.undo_id)
    })
    .await
}
