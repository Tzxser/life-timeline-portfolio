//! Portable diary exchange. Unlike a full backup, this archive deliberately
//! excludes preferences and unrelated life events, and can only be applied
//! after every conflicting natural day has an explicit resolution.

use super::*;
use crate::models::{AppSnapshot, AttachmentMeta};
use chrono::NaiveDate;
use std::collections::BTreeSet;

const PURPOSE: &str = "diary-transfer";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct DiaryExportRequest {
    pub destination_path: String,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    #[serde(default)]
    pub overwrite: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DiaryExportResult {
    pub archive_path: String,
    pub diary_count: usize,
    pub attachment_count: usize,
    pub byte_size: u64,
    pub sha256: String,
    pub exported_at: String,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct DiaryScanRequest {
    pub archive_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DiarySummary {
    pub id: String,
    pub title: String,
    pub character_count: usize,
    pub attachment_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DiaryConflict {
    pub date: String,
    pub local: DiarySummary,
    pub incoming: DiarySummary,
    pub identical: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DiaryPreview {
    pub id: String,
    pub date: String,
    pub title: String,
    pub attachment_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DiaryScanResult {
    pub schedule_conflicts: Vec<crate::schedules::ScheduleConflict>,
    pub scan_token: String,
    pub archive_path: String,
    pub archive_sha256: String,
    pub diary_count: usize,
    pub attachment_count: usize,
    pub new_count: usize,
    pub conflicts: Vec<DiaryConflict>,
    pub diaries: Vec<DiaryPreview>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub can_import: bool,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(super) enum DiaryAction {
    Merge,
    Replace,
    Skip,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct DiaryDecision {
    pub date: String,
    pub action: DiaryAction,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct DiaryImportRequest {
    #[serde(default)]
    pub schedule_decisions: Vec<crate::schedules::ScheduleDecision>,
    pub archive_path: String,
    pub scan_token: String,
    pub decisions: Vec<DiaryDecision>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DiaryImportResult {
    pub added: usize,
    pub merged: usize,
    pub replaced: usize,
    pub skipped: usize,
    pub attachment_count: usize,
    pub previous_library_backup_path: Option<String>,
    pub revision: u64,
}

#[derive(Clone)]
pub(super) struct ScannedDiary {
    path: PathBuf,
    hash: String,
    database_id: String,
    revision: u64,
    data_epoch: u64,
    snapshot_hash: String,
}

fn error(code: &str, message: impl Into<String>) -> CommandError {
    CommandError {
        code: code.into(),
        message: message.into(),
    }
}

fn security_error(cause: security::SecurityError) -> CommandError {
    error("security.path_denied", cause.to_string())
}

fn json_error(cause: serde_json::Error) -> CommandError {
    error("diary.json", cause.to_string())
}

fn repo_lock(state: &AppState) -> Result<std::sync::MutexGuard<'_, Repository>, CommandError> {
    state
        .repository
        .lock()
        .map_err(|_| error("storage.lock", "本地资料库锁定失败"))
}

fn check_date(value: &str) -> Result<(), CommandError> {
    if value.len() != 10
        || value.as_bytes()[4] != b'-'
        || value.as_bytes()[7] != b'-'
        || !value
            .bytes()
            .enumerate()
            .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit())
        || !NaiveDate::parse_from_str(value, "%Y-%m-%d")
            .is_ok_and(|date| date.format("%Y-%m-%d").to_string() == value)
        || value.starts_with("0000")
    {
        return Err(error("diary.date", "日期必须是有效的 YYYY-MM-DD 自然日。"));
    }
    Ok(())
}

fn check_range(start: Option<&str>, end: Option<&str>) -> Result<(), CommandError> {
    match (start, end) {
        (None, None) => Ok(()),
        (Some(start), Some(end)) => {
            check_date(start)?;
            check_date(end)?;
            if start > end {
                return Err(error("diary.date_range", "开始日期不能晚于结束日期。"));
            }
            Ok(())
        }
        _ => Err(error("diary.date_range", "请同时填写开始日期和结束日期。")),
    }
}

fn refs(event: &LifeEvent) -> Result<BTreeSet<String>, CommandError> {
    models::validate_event(event).map_err(command_error)
}

/// Reject shapes this editor cannot render rather than importing them and
/// silently dropping content on the first editing transaction. Supported
/// node attributes are retained verbatim; no HTML/Markdown conversion occurs.
fn validate_rich(rich: &Value) -> Result<(), CommandError> {
    let invalid = || {
        error(
            "diary.rich_content",
            "日记包含当前版本不支持的正文格式，请在导出电脑使用兼容版本重新导出。",
        )
    };
    let object = rich.as_object().ok_or_else(invalid)?;
    if object
        .keys()
        .any(|key| !["version", "format", "doc"].contains(&key.as_str()))
        || rich["version"].as_u64() != Some(1)
        || rich["format"].as_str() != Some("tiptap-json")
        || rich["doc"]["type"].as_str() != Some("doc")
    {
        return Err(invalid());
    }
    fn node(value: &Value, parent: Option<&str>, depth: usize) -> Result<(), CommandError> {
        let invalid = || {
            error(
                "diary.rich_content",
                "日记包含不支持或损坏的正文节点，未进行导入。",
            )
        };
        if depth > 60 {
            return Err(invalid());
        }
        let object = value.as_object().ok_or_else(invalid)?;
        if object
            .keys()
            .any(|key| !["type", "attrs", "content", "marks", "text"].contains(&key.as_str()))
        {
            return Err(invalid());
        }
        let kind = value["type"].as_str().ok_or_else(invalid)?;
        let blocks = [
            "paragraph",
            "bulletList",
            "orderedList",
            "lifeImage",
            "lifeAttachment",
            "lifeSchedule",
        ];
        let correct_parent = match kind {
            "doc" => parent.is_none(),
            "text" | "hardBreak" => parent == Some("paragraph"),
            "listItem" => matches!(parent, Some("bulletList" | "orderedList")),
            "lifeSchedule" => parent == Some("doc"),
            _ if blocks.contains(&kind) => matches!(parent, Some("doc" | "listItem")),
            _ => false,
        };
        if !correct_parent {
            return Err(invalid());
        }
        let attrs = value.get("attrs").filter(|value| !value.is_null());
        if kind == "lifeSchedule"
            && !attrs
                .and_then(|value| value.get("card"))
                .is_some_and(|card| crate::schedules::validate_card(card).is_ok())
        {
            return Err(invalid());
        }
        let permitted: &[&str] = match kind {
            "lifeImage" => &[
                "attachmentId",
                "name",
                "caption",
                "width",
                "naturalWidth",
                "naturalHeight",
                "layout",
            ],
            "lifeAttachment" => &["attachmentId", "name", "mimeType", "byteSize", "note"],
            "lifeSchedule" => &["card"],
            "orderedList" => &["start", "type"],
            _ => &[],
        };
        if let Some(attrs) = attrs {
            let attrs = attrs.as_object().ok_or_else(invalid)?;
            if attrs.keys().any(|key| !permitted.contains(&key.as_str())) {
                return Err(invalid());
            }
            for (key, item) in attrs {
                if item.is_null() {
                    continue;
                }
                let valid = match key.as_str() {
                    "card" => crate::schedules::validate_card(item).is_ok(),
                    "width" => item
                        .as_f64()
                        .is_some_and(|v| v.is_finite() && v > 0.0 && v <= 100.0),
                    "naturalWidth" | "naturalHeight" => {
                        item.as_u64().is_some_and(|v| (1..=100_000).contains(&v))
                    }
                    "byteSize" => item.as_u64().is_some_and(|v| v > 0),
                    "start" => item.as_i64().is_some(),
                    "layout" => item.as_str().is_some_and(|v| {
                        [
                            "block",
                            "wrap-left",
                            "wrap-right",
                            "margin-left",
                            "margin-right",
                        ]
                        .contains(&v)
                    }),
                    _ => item.is_string(),
                };
                if !valid {
                    return Err(invalid());
                }
            }
        }
        if matches!(kind, "lifeImage" | "lifeAttachment")
            && !value["attrs"]["attachmentId"]
                .as_str()
                .is_some_and(|id| !id.is_empty())
        {
            return Err(invalid());
        }
        if kind == "text" {
            if !value["text"].as_str().is_some_and(|text| !text.is_empty()) {
                return Err(invalid());
            }
        } else if value.get("text").is_some() {
            return Err(invalid());
        }
        if let Some(marks) = value.get("marks") {
            let marks = marks.as_array().ok_or_else(invalid)?;
            if !matches!(kind, "text" | "hardBreak") && !marks.is_empty() {
                return Err(invalid());
            }
            for mark in marks {
                let mark_object = mark.as_object().ok_or_else(invalid)?;
                if mark_object
                    .keys()
                    .any(|key| !["type", "attrs"].contains(&key.as_str()))
                {
                    return Err(invalid());
                }
                let mark_type = mark["type"].as_str().ok_or_else(invalid)?;
                if !["bold", "italic", "imageLink"].contains(&mark_type) {
                    return Err(invalid());
                }
                if let Some(attrs) = mark.get("attrs").filter(|v| !v.is_null()) {
                    let attrs = attrs.as_object().ok_or_else(invalid)?;
                    if attrs
                        .keys()
                        .any(|key| mark_type != "imageLink" || key != "imageId")
                    {
                        return Err(invalid());
                    }
                }
                if mark_type == "imageLink"
                    && !mark["attrs"]["imageId"]
                        .as_str()
                        .is_some_and(|id| !id.is_empty())
                {
                    return Err(invalid());
                }
            }
        }
        let children = value
            .get("content")
            .map(|content| content.as_array().ok_or_else(invalid))
            .transpose()?;
        if matches!(kind, "text" | "hardBreak" | "lifeImage" | "lifeAttachment")
            && children.is_some()
        {
            return Err(invalid());
        }
        if matches!(kind, "bulletList" | "orderedList" | "listItem")
            && children.is_none_or(|children| children.is_empty())
        {
            return Err(invalid());
        }
        if kind == "listItem"
            && children
                .and_then(|children| children.first())
                .is_none_or(|child| child["type"] != "paragraph")
        {
            return Err(invalid());
        }
        if let Some(children) = children {
            for child in children {
                node(child, Some(kind), depth + 1)?;
            }
        }
        Ok(())
    }
    node(&rich["doc"], None, 0)?;
    fn collect(value: &Value, images: &mut HashSet<String>, links: &mut HashSet<String>) {
        if value["type"] == "lifeImage" {
            if let Some(id) = value["attrs"]["attachmentId"].as_str() {
                images.insert(id.into());
            }
        }
        if let Some(marks) = value["marks"].as_array() {
            for mark in marks {
                if mark["type"] == "imageLink" {
                    if let Some(id) = mark["attrs"]["imageId"].as_str() {
                        links.insert(id.into());
                    }
                }
            }
        }
        if let Some(children) = value["content"].as_array() {
            for child in children {
                collect(child, images, links);
            }
        }
    }
    let mut images = HashSet::new();
    let mut links = HashSet::new();
    collect(&rich["doc"], &mut images, &mut links);
    if !links.is_subset(&images) {
        return Err(error(
            "diary.image_link",
            "日记中的图片关联缺少对应图片节点。",
        ));
    }
    Ok(())
}

pub(super) fn validate_document(life: &Value, manifest: &Value) -> Result<(), CommandError> {
    let events: Vec<LifeEvent> =
        serde_json::from_value(life["events"].clone()).map_err(json_error)?;
    if events.is_empty() {
        return Err(error("diary.empty", "此文件中没有可导入的日记。"));
    }
    if life["preferences"] != json!({}) {
        return Err(error("diary.preferences", "日记交换包不能包含软件设置。"));
    }
    crate::schedules::incoming_sources(life).map_err(command_error)?;
    let range = &life["diaryRange"];
    if !range.is_object() || range != &manifest["diaryRange"] {
        return Err(error("diary.date_range", "日记包日期范围声明不一致。"));
    }
    for key in ["startDate", "endDate"] {
        if !range[key].is_null() && !range[key].is_string() {
            return Err(error("diary.date_range", "日记包日期范围格式错误。"));
        }
    }
    let start = range["startDate"].as_str();
    let end = range["endDate"].as_str();
    check_range(start, end)?;
    let mut required_attachments = BTreeSet::new();
    let mut required_stages = BTreeSet::new();
    for event in &events {
        if event.record_type != "daily" || event.date_precision != "day" {
            return Err(error("diary.not_daily", "日记交换包中包含非日记记录。"));
        }
        check_date(&event.date)?;
        if start.is_some_and(|start| event.date.as_str() < start)
            || end.is_some_and(|end| event.date.as_str() > end)
        {
            return Err(error("diary.date_range", "日记超出了文件声明的日期范围。"));
        }
        if let Some(rich) = &event.rich_content {
            validate_rich(rich)?;
        }
        required_attachments.extend(refs(event)?);
        if let Some(stage_id) = &event.stage_id {
            required_stages.insert(stage_id.clone());
        }
    }
    let attachments = life["attachments"]
        .as_array()
        .ok_or_else(|| error("diary.json", "附件列表无效。"))?;
    for meta in attachments {
        let id = meta["id"]
            .as_str()
            .ok_or_else(|| error("diary.json", "附件ID无效。"))?;
        if !required_attachments.contains(id) {
            return Err(error(
                "diary.unreferenced",
                "日记包包含未被选中日记引用的附件。",
            ));
        }
        for key in ["width", "height"] {
            if !meta[key].is_null()
                && !meta[key]
                    .as_u64()
                    .is_some_and(|n| (1..=100_000).contains(&n))
            {
                return Err(error("diary.attachment_metadata", "附件尺寸不合法。"));
            }
        }
    }
    let stages = life["stages"]
        .as_array()
        .ok_or_else(|| error("diary.json", "阶段列表无效。"))?;
    for stage in stages {
        let id = stage["id"]
            .as_str()
            .ok_or_else(|| error("diary.json", "阶段ID无效。"))?;
        if !required_stages.contains(id) {
            return Err(error(
                "diary.unreferenced",
                "日记包包含未被选中日记引用的阶段。",
            ));
        }
    }
    Ok(())
}

pub(super) fn export_diaries(
    state: &AppState,
    request: DiaryExportRequest,
) -> Result<DiaryExportResult, CommandError> {
    check_range(request.start_date.as_deref(), request.end_date.as_deref())?;
    let destination = validate_user_archive_path(&request.destination_path)?;
    // The file picker must not be used to overwrite a registered attachment.
    security::reject_symlink_components(&destination).map_err(security_error)?;
    if let Some(existing_parent) = destination
        .ancestors()
        .skip(1)
        .find(|ancestor| ancestor.exists())
    {
        let existing_parent = fs::canonicalize(existing_parent)
            .map_err(command_error)?
            .to_string_lossy()
            .replace('\\', "/")
            .to_ascii_lowercase();
        for protected in ["attachments", "staging", "recovery"] {
            let protected = fs::canonicalize(state.root.join(protected))
                .map_err(command_error)?
                .to_string_lossy()
                .replace('\\', "/")
                .to_ascii_lowercase();
            if existing_parent == protected || existing_parent.starts_with(&format!("{protected}/"))
            {
                return Err(error(
                    "security.path_denied",
                    "请将导出的日记保存到资料库受控目录之外。",
                ));
            }
        }
    }
    let mut repo = repo_lock(state)?;
    repo.checkpoint_full().map_err(command_error)?;
    let mut life = archive_document(&repo)?;
    let mut events: Vec<LifeEvent> =
        serde_json::from_value(life["events"].clone()).map_err(json_error)?;
    events.retain(|event| {
        event.record_type == "daily"
            && request
                .start_date
                .as_ref()
                .is_none_or(|start| &event.date >= start)
            && request
                .end_date
                .as_ref()
                .is_none_or(|end| &event.date <= end)
    });
    if events.is_empty() {
        return Err(error("diary.empty_range", "所选日期范围内没有日记。"));
    }
    let mut attachment_ids = BTreeSet::new();
    let mut stage_ids = HashSet::new();
    for event in &events {
        attachment_ids.extend(refs(event)?);
        if let Some(stage) = &event.stage_id {
            stage_ids.insert(stage.clone());
        }
    }
    let attachments: Vec<Value> = life["attachments"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|value| {
            value["id"]
                .as_str()
                .is_some_and(|id| attachment_ids.contains(id))
        })
        .cloned()
        .collect();
    let stages: Vec<Value> = life["stages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|value| {
            value["id"]
                .as_str()
                .is_some_and(|id| stage_ids.contains(id))
        })
        .cloned()
        .collect();
    let diary_count = events.len();
    let attachment_count = attachments.len();
    life["events"] = serde_json::to_value(&events).map_err(json_error)?;
    life["stages"] = json!(stages);
    life["attachments"] = json!(attachments);
    life["schedules"] =
        crate::schedules::export_sources(&life["preferences"], &events).map_err(command_error)?;
    life["preferences"] = json!({});
    life["purpose"] = json!(PURPOSE);
    life["diaryFormatVersion"] = json!(1);
    life["diaryRange"] = json!({"startDate": request.start_date, "endDate": request.end_date});
    let result =
        export_archive_document(&state.root, &destination, request.overwrite, &life, true)?;
    Ok(DiaryExportResult {
        archive_path: result.archive_path,
        diary_count,
        attachment_count,
        byte_size: result.byte_size,
        sha256: result.sha256,
        exported_at: result.exported_at,
        start_date: request.start_date,
        end_date: request.end_date,
    })
}

fn snapshot_hash(snapshot: &AppSnapshot) -> Result<String, CommandError> {
    Ok(security::sha256_bytes(
        &serde_json::to_vec(snapshot).map_err(json_error)?,
    ))
}

fn attachment_metas(life: &Value) -> Result<Vec<AttachmentMeta>, CommandError> {
    life["attachments"]
        .as_array()
        .ok_or_else(|| error("diary.json", "附件列表无效。"))?
        .iter()
        .map(|value| {
            let mut value = value.clone();
            value["relativePath"] = value["path"].clone();
            serde_json::from_value(value).map_err(json_error)
        })
        .collect()
}

fn summary(event: &LifeEvent) -> Result<DiarySummary, CommandError> {
    Ok(DiarySummary {
        id: event.id.clone(),
        title: event.title.clone(),
        character_count: event.content.chars().count(),
        attachment_count: refs(event)?.len(),
    })
}

fn remap_rich(value: &mut Value, map: &HashMap<String, String>) {
    match value {
        Value::Object(object) => {
            for key in ["attachmentId", "imageId"] {
                if let Some(id) = object.get(key).and_then(Value::as_str) {
                    if let Some(mapped) = map.get(id) {
                        object.insert(key.into(), json!(mapped));
                    }
                }
            }
            for value in object.values_mut() {
                remap_rich(value, map);
            }
        }
        Value::Array(items) => items.iter_mut().for_each(|value| remap_rich(value, map)),
        _ => {}
    }
}

fn comparable_event(
    event: &LifeEvent,
    attachments: &[AttachmentMeta],
    stages: &[LifeStage],
) -> Result<Value, CommandError> {
    let mut item = serde_json::to_value(event).map_err(json_error)?;
    item.as_object_mut().unwrap().remove("id");
    let map = logical_attachment_map(attachments)?;
    if let Some(rich) = item.get_mut("richContent") {
        remap_rich(rich, &map);
    }
    item["attachmentIds"] = json!(refs(event)?
        .iter()
        .map(|id| map.get(id).cloned().unwrap_or_else(|| id.clone()))
        .collect::<BTreeSet<_>>());
    if let Some(stage) = event
        .stage_id
        .as_ref()
        .and_then(|id| stages.iter().find(|stage| &stage.id == id))
    {
        let mut stage = serde_json::to_value(stage).map_err(json_error)?;
        stage.as_object_mut().unwrap().remove("id");
        item["stageId"] = stage;
    }
    Ok(item)
}

fn logical_attachment_map(
    attachments: &[AttachmentMeta],
) -> Result<HashMap<String, String>, CommandError> {
    attachments.iter().map(|meta| {
        let value = json!({"name":meta.name,"mimeType":meta.mime_type,"byteSize":meta.byte_size,"kind":meta.kind,"width":meta.width,"height":meta.height,"lastModified":meta.last_modified,"sha256":meta.sha256});
        Ok((meta.id.clone(), security::sha256_bytes(&serde_json::to_vec(&value).map_err(json_error)?)))
    }).collect()
}

fn identical(
    local: &LifeEvent,
    incoming: &LifeEvent,
    snapshot: &AppSnapshot,
    incoming_attachments: &[AttachmentMeta],
    incoming_stages: &[LifeStage],
) -> Result<bool, CommandError> {
    let local_attachments: Vec<AttachmentMeta> = snapshot
        .attachments
        .iter()
        .map(|record| record.meta.clone())
        .collect();
    Ok(
        comparable_event(local, &local_attachments, &snapshot.stages)?
            == comparable_event(incoming, incoming_attachments, incoming_stages)?,
    )
}

/// Recognize the exact block previously appended by this importer, without
/// relying on database-specific attachment IDs. Deleting or editing that
/// block intentionally makes it importable again; no invisible history is
/// allowed to prevent the user recovering a removed passage.
fn already_merged(
    local: &LifeEvent,
    incoming: &LifeEvent,
    snapshot: &AppSnapshot,
    incoming_attachments: &[AttachmentMeta],
) -> Result<bool, CommandError> {
    let local_attachments: Vec<_> = snapshot
        .attachments
        .iter()
        .map(|record| record.meta.clone())
        .collect();
    let local_map = logical_attachment_map(&local_attachments)?;
    let incoming_map = logical_attachment_map(incoming_attachments)?;
    let mut local_doc = local
        .rich_content
        .as_ref()
        .map(|rich| rich["doc"].clone())
        .unwrap_or_else(|| plain_doc(&local.content));
    let mut incoming_doc = incoming
        .rich_content
        .as_ref()
        .map(|rich| rich["doc"].clone())
        .unwrap_or_else(|| plain_doc(&incoming.content));
    remap_rich(&mut local_doc, &local_map);
    remap_rich(&mut incoming_doc, &incoming_map);
    let separator = format!("—— 导入日记：{} ——", incoming.title);
    let mut block = vec![
        json!({"type":"paragraph"}),
        json!({"type":"paragraph","content":[{"type":"text","text":separator,"marks":[{"type":"bold"}]}]}),
    ];
    block.extend(
        incoming_doc["content"]
            .as_array()
            .cloned()
            .unwrap_or_default(),
    );
    let local_ids: HashSet<_> = refs(local)?
        .iter()
        .filter_map(|id| local_map.get(id).cloned())
        .collect();
    let incoming_ids: HashSet<_> = refs(incoming)?
        .iter()
        .filter_map(|id| incoming_map.get(id).cloned())
        .collect();
    Ok(incoming_ids.is_subset(&local_ids)
        && local_doc["content"]
            .as_array()
            .is_some_and(|content| content.windows(block.len()).any(|window| window == block)))
}

pub(super) fn scan_diaries(
    state: &AppState,
    request: DiaryScanRequest,
) -> Result<DiaryScanResult, CommandError> {
    let path = validate_user_archive_path(&request.archive_path)?;
    security::reject_symlink_components(&path).map_err(security_error)?;
    let (_, hash) = sha256_file(&path)?;
    let (life, _, counts) = scan_zip_inner(&path, true)?;
    if sha256_file(&path)?.1 != hash {
        return Err(error(
            "diary.archive_changed",
            "文件在检查期间发生了变化，请重新选择。",
        ));
    }
    let mut incoming: Vec<LifeEvent> =
        serde_json::from_value(life["events"].clone()).map_err(json_error)?;
    incoming.sort_by(|a, b| a.date.cmp(&b.date));
    let incoming_attachments = attachment_metas(&life)?;
    let incoming_stages: Vec<LifeStage> =
        serde_json::from_value(life["stages"].clone()).map_err(json_error)?;
    let repo = repo_lock(state)?;
    let snapshot = repo.load_snapshot().map_err(command_error)?;
    let revision = repo.snapshot_revision().map_err(command_error)?;
    let local: HashMap<&str, &LifeEvent> = snapshot
        .events
        .iter()
        .filter(|event| event.record_type == "daily")
        .map(|event| (event.date.as_str(), event))
        .collect();
    let mut conflicts = Vec::new();
    let mut diaries = Vec::new();
    for event in &incoming {
        if let Some(existing) = local.get(event.date.as_str()) {
            conflicts.push(DiaryConflict {
                date: event.date.clone(),
                local: summary(existing)?,
                incoming: summary(event)?,
                identical: identical(
                    existing,
                    event,
                    &snapshot,
                    &incoming_attachments,
                    &incoming_stages,
                )?,
            });
        }
        diaries.push(DiaryPreview {
            id: event.id.clone(),
            date: event.date.clone(),
            title: event.title.clone(),
            attachment_count: refs(event)?.len(),
        });
    }
    let scan_token = Uuid::new_v4().to_string();
    let scanned = ScannedDiary {
        path: path.clone(),
        hash: hash.clone(),
        database_id: snapshot.meta.database_id.clone(),
        revision,
        data_epoch: snapshot.meta.data_epoch,
        snapshot_hash: snapshot_hash(&snapshot)?,
    };
    let mut scans = state
        .scanned_diaries
        .lock()
        .map_err(|_| error("storage.lock", "日记扫描锁定失败"))?;
    // Scan tokens are session-local and bounded even if a caller repeatedly
    // opens files without following through with an import.
    if scans.len() >= 8 {
        if let Some(oldest) = scans.keys().next().cloned() {
            scans.remove(&oldest);
        }
    }
    scans.insert(scan_token.clone(), scanned);
    Ok(DiaryScanResult {
        schedule_conflicts: crate::schedules::conflicts(&snapshot, &life).map_err(command_error)?,
        scan_token,
        archive_path: path.to_string_lossy().into_owned(),
        archive_sha256: hash,
        diary_count: counts.events,
        attachment_count: counts.attachments,
        new_count: incoming.len() - conflicts.len(),
        conflicts,
        diaries,
        start_date: incoming.first().map(|event| event.date.clone()),
        end_date: incoming.last().map(|event| event.date.clone()),
        can_import: true,
        warnings: vec![],
    })
}

fn check_scanned(
    scanned: &ScannedDiary,
    snapshot: &AppSnapshot,
    revision: u64,
) -> Result<(), CommandError> {
    if scanned.database_id != snapshot.meta.database_id
        || scanned.revision != revision
        || scanned.data_epoch != snapshot.meta.data_epoch
        || scanned.snapshot_hash != snapshot_hash(snapshot)?
    {
        return Err(error(
            "diary.scan_stale",
            "本机日记或设置已改变，请重新检查文件后再确认导入。",
        ));
    }
    Ok(())
}

fn fresh_id(preferred: &str, prefix: &str, used: &mut HashSet<String>) -> String {
    if used.insert(preferred.into()) {
        return preferred.into();
    }
    loop {
        let id = format!("{prefix}-{}", Uuid::new_v4());
        if used.insert(id.clone()) {
            return id;
        }
    }
}

fn registered(
    meta: AttachmentMeta,
    created_at: String,
) -> Result<RegisteredAttachment, CommandError> {
    Ok(RegisteredAttachment {
        id: meta.id,
        sha256: meta
            .sha256
            .ok_or_else(|| error("diary.attachment_metadata", "附件缺少hash。"))?,
        name: meta.name,
        mime_type: meta.mime_type,
        byte_size: meta.byte_size,
        kind: meta.kind,
        width: meta.width,
        height: meta.height,
        last_modified: meta.last_modified,
        relative_path: meta
            .relative_path
            .ok_or_else(|| error("diary.attachment_metadata", "附件缺少受控路径。"))?,
        created_at,
    })
}

fn plain_doc(text: &str) -> Value {
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    json!({"type":"doc", "content": text.split('\n').map(|line| {
        if line.is_empty() { json!({"type":"paragraph"}) }
        else { json!({"type":"paragraph","content":[{"type":"text","text":line}]}) }
    }).collect::<Vec<_>>()})
}

fn merged_event(local: &LifeEvent, incoming: &LifeEvent) -> Result<LifeEvent, CommandError> {
    let mut result = local.clone();
    let mut local_doc = local
        .rich_content
        .as_ref()
        .map(|rich| rich["doc"].clone())
        .unwrap_or_else(|| plain_doc(&local.content));
    let incoming_doc = incoming
        .rich_content
        .as_ref()
        .map(|rich| rich["doc"].clone())
        .unwrap_or_else(|| plain_doc(&incoming.content));
    if local_doc.get("content").is_none() {
        local_doc["content"] = json!([]);
    }
    let content = local_doc["content"]
        .as_array_mut()
        .ok_or_else(|| error("diary.rich_content", "本地正文格式无法安全合并。"))?;
    let separator = format!("—— 导入日记：{} ——", incoming.title);
    content.push(json!({"type":"paragraph"}));
    content.push(json!({"type":"paragraph", "content":[{"type":"text","text":separator,"marks":[{"type":"bold"}]}]}));
    content.extend(
        incoming_doc["content"]
            .as_array()
            .cloned()
            .unwrap_or_default(),
    );
    result.rich_content = Some(json!({"version":1,"format":"tiptap-json","doc":local_doc}));
    result.content = format!("{}\n\n{}\n{}", local.content, separator, incoming.content);
    let mut attachments = refs(local)?;
    attachments.extend(refs(incoming)?);
    result.attachment_ids = attachments.into_iter().collect();
    models::validate_event(&result).map_err(command_error)?;
    Ok(result)
}

struct ImportPlan {
    events: Vec<LifeEvent>,
    stages: Vec<LifeStage>,
    attachments: Vec<RegisteredAttachment>,
    // ZIP source name and the remapped physical/logical target metadata.
    to_stage: Vec<(String, RegisteredAttachment)>,
    result: DiaryImportResult,
}

fn plan_import(
    snapshot: &AppSnapshot,
    life: &Value,
    decisions: &[DiaryDecision],
    revision: u64,
) -> Result<ImportPlan, CommandError> {
    let incoming: Vec<LifeEvent> =
        serde_json::from_value(life["events"].clone()).map_err(json_error)?;
    let incoming_stages: Vec<LifeStage> =
        serde_json::from_value(life["stages"].clone()).map_err(json_error)?;
    let incoming_attachments = attachment_metas(life)?;
    let local: HashMap<&str, &LifeEvent> = snapshot
        .events
        .iter()
        .filter(|event| event.record_type == "daily")
        .map(|event| (event.date.as_str(), event))
        .collect();
    let conflict_dates: HashSet<&str> = incoming
        .iter()
        .filter(|event| local.contains_key(event.date.as_str()))
        .map(|event| event.date.as_str())
        .collect();
    let mut resolved = HashMap::new();
    for decision in decisions {
        if !conflict_dates.contains(decision.date.as_str())
            || resolved
                .insert(decision.date.as_str(), decision.action)
                .is_some()
        {
            return Err(error(
                "diary.decisions",
                "冲突处理包含重复或不存在的日期，请重新检查。",
            ));
        }
    }
    if resolved.len() != conflict_dates.len() {
        return Err(error(
            "diary.decisions",
            "请为每一个日期冲突选择合并、覆盖或跳过。",
        ));
    }
    let mut result = DiaryImportResult {
        added: 0,
        merged: 0,
        replaced: 0,
        skipped: 0,
        attachment_count: 0,
        previous_library_backup_path: None,
        revision,
    };
    let mut selected = Vec::new();
    for event in incoming {
        let action = resolved.get(event.date.as_str()).copied();
        let unchanged = match local.get(event.date.as_str()) {
            Some(existing) if action != Some(DiaryAction::Skip) => {
                identical(
                    existing,
                    &event,
                    snapshot,
                    &incoming_attachments,
                    &incoming_stages,
                )? || (action == Some(DiaryAction::Merge)
                    && already_merged(existing, &event, snapshot, &incoming_attachments)?)
            }
            _ => false,
        };
        if action == Some(DiaryAction::Skip) || unchanged {
            result.skipped += 1;
        } else {
            selected.push((event, action));
        }
    }
    let mut required_attachments = BTreeSet::new();
    let mut required_stages = HashSet::new();
    for (event, action) in &selected {
        required_attachments.extend(refs(event)?);
        if *action != Some(DiaryAction::Merge) {
            if let Some(stage) = &event.stage_id {
                required_stages.insert(stage.clone());
            }
        }
    }
    let mut events = snapshot.events.clone();
    let mut stages = snapshot.stages.clone();
    let mut attachments = snapshot
        .attachments
        .iter()
        .map(|record| registered(record.meta.clone(), record.created_at.clone()))
        .collect::<Result<Vec<_>, _>>()?;
    let mut used_event_ids: HashSet<String> = events.iter().map(|event| event.id.clone()).collect();
    let mut used_stage_ids: HashSet<String> = stages.iter().map(|stage| stage.id.clone()).collect();
    used_stage_ids.insert("stage-all".into());
    let mut used_attachment_ids: HashSet<String> =
        attachments.iter().map(|meta| meta.id.clone()).collect();
    let mut stage_map = HashMap::new();
    for mut stage in incoming_stages {
        if !required_stages.contains(&stage.id) {
            continue;
        }
        let original_id = stage.id.clone();
        let matching = stages.iter().find(|existing| {
            existing.id == stage.id
                && serde_json::to_value(existing).ok() == serde_json::to_value(&stage).ok()
        });
        if let Some(matching) = matching {
            stage_map.insert(original_id, matching.id.clone());
        } else {
            stage.id = fresh_id(&stage.id, "stage", &mut used_stage_ids);
            stage_map.insert(original_id, stage.id.clone());
            stages.push(stage);
        }
    }
    let mut known_blobs: HashMap<String, (String, u64)> = attachments
        .iter()
        .map(|meta| {
            (
                meta.sha256.clone(),
                (meta.relative_path.clone(), meta.byte_size),
            )
        })
        .collect();
    let mut attachment_map = HashMap::new();
    let mut to_stage = Vec::new();
    for mut meta in incoming_attachments {
        if !required_attachments.contains(&meta.id) {
            continue;
        }
        let original_id = meta.id.clone();
        let source_path = meta
            .relative_path
            .clone()
            .ok_or_else(|| error("diary.attachment_metadata", "附件缺少路径。"))?;
        let sha = meta
            .sha256
            .clone()
            .ok_or_else(|| error("diary.attachment_metadata", "附件缺少hash。"))?;
        meta.id = fresh_id(&meta.id, "att", &mut used_attachment_ids);
        let relative_path = match known_blobs.get(&sha) {
            Some((path, size)) if *size == meta.byte_size => path.clone(),
            Some(_) => {
                return Err(error(
                    "diary.attachment_conflict",
                    "相同附件hash的大小不一致。",
                ))
            }
            None => {
                // Ignore a foreign machine's disk paths; derive a canonical
                // content path while keeping the original name in metadata.
                let extension = Path::new(&source_path)
                    .extension()
                    .and_then(|value| value.to_str())
                    .filter(|value| {
                        !value.is_empty()
                            && value.len() <= 12
                            && value.chars().all(|c| c.is_ascii_alphanumeric())
                    })
                    .unwrap_or("bin");
                let path = format!("attachments/{}/{sha}.{extension}", &sha[..2]);
                known_blobs.insert(sha.clone(), (path.clone(), meta.byte_size));
                path
            }
        };
        meta.relative_path = Some(relative_path);
        meta.asset_url = None;
        attachment_map.insert(original_id, meta.id.clone());
        let registration = registered(meta, Utc::now().to_rfc3339())?;
        to_stage.push((source_path, registration.clone()));
        attachments.push(registration);
    }
    result.attachment_count = to_stage.len();
    for (mut event, action) in selected {
        if let Some(rich) = &mut event.rich_content {
            remap_rich(rich, &attachment_map);
        }
        event.attachment_ids = event
            .attachment_ids
            .iter()
            .map(|id| {
                attachment_map
                    .get(id)
                    .cloned()
                    .unwrap_or_else(|| id.clone())
            })
            .collect();
        event.stage_id = event
            .stage_id
            .as_ref()
            .and_then(|id| stage_map.get(id).cloned());
        if let Some(existing) = local.get(event.date.as_str()) {
            let replacement = match action {
                Some(DiaryAction::Merge) => {
                    if let Some(rich) = &existing.rich_content {
                        validate_rich(rich)?;
                    }
                    result.merged += 1;
                    merged_event(existing, &event)?
                }
                Some(DiaryAction::Replace) => {
                    result.replaced += 1;
                    event.id = existing.id.clone();
                    event
                }
                _ => return Err(error("diary.decisions", "缺少冲突决定。")),
            };
            let position = events
                .iter()
                .position(|event| event.id == existing.id)
                .unwrap();
            events[position] = replacement;
        } else {
            event.id = fresh_id(&event.id, "daily", &mut used_event_ids);
            result.added += 1;
            events.push(event);
        }
    }
    Ok(ImportPlan {
        events,
        stages,
        attachments,
        to_stage,
        result,
    })
}

pub(super) fn import_diaries(
    state: &AppState,
    request: DiaryImportRequest,
) -> Result<DiaryImportResult, CommandError> {
    import_diaries_observed(state, request, |_, _| {})
}

/// Call the observer while still holding the repository writer lock after a
/// successful mutation. AI imports use this boundary to persist a rollback
/// fingerprint that cannot accidentally include a later unrelated autosave.
/// Observers handle their own I/O errors; the SQLite commit already succeeded.
pub(super) fn import_diaries_observed(
    state: &AppState,
    request: DiaryImportRequest,
    mut on_committed: impl FnMut(&Repository, &DiaryImportResult),
) -> Result<DiaryImportResult, CommandError> {
    let path = validate_user_archive_path(&request.archive_path)?;
    security::reject_symlink_components(&path).map_err(security_error)?;
    let scanned = state
        .scanned_diaries
        .lock()
        .map_err(|_| error("storage.lock", "日记扫描锁定失败"))?
        .get(&request.scan_token)
        .cloned()
        .ok_or_else(|| error("diary.scan_stale", "请先检查日记文件，再确认导入。"))?;
    if path != scanned.path || sha256_file(&path)?.1 != scanned.hash {
        return Err(error(
            "diary.archive_changed",
            "日记文件在预览后发生变化，请重新检查。",
        ));
    }
    let restore_id = Uuid::new_v4().to_string();
    let staging_root = state
        .root
        .join("staging")
        .join(format!("restore-{restore_id}"));
    security::reject_symlink_components(&staging_root).map_err(security_error)?;
    fs::create_dir_all(&staging_root).map_err(command_error)?;
    let _staging_guard = StagingGuard {
        path: staging_root.clone(),
        preserve: false,
    };
    // Work only from a private immutable copy after this point. Hashing the
    // copied file binds both the parsed JSON and every extracted byte to the
    // same scan token even if the user replaces the source ZIP meanwhile.
    let staged_zip = staging_root.join("source.zip");
    let mut source = File::open(&path).map_err(command_error)?;
    let mut copied = security::create_new_file(&staged_zip).map_err(security_error)?;
    security::copy_limited(
        &mut source,
        &mut copied,
        security::ArchiveLimits::default().max_total_uncompressed + 256 * 1024 * 1024,
    )
    .map_err(security_error)?;
    copied.sync_all().map_err(command_error)?;
    drop(copied);
    drop(source);
    if sha256_file(&staged_zip)?.1 != scanned.hash {
        return Err(error(
            "diary.archive_changed",
            "日记文件复制期间发生变化，请重新检查。",
        ));
    }
    let (life, _, _) = scan_zip_inner(&staged_zip, true)?;
    let (snapshot, mut plan) = {
        let repo = repo_lock(state)?;
        let snapshot = repo.load_snapshot().map_err(command_error)?;
        let revision = repo.snapshot_revision().map_err(command_error)?;
        check_scanned(&scanned, &snapshot, revision)?;
        let plan = plan_import(&snapshot, &life, &request.decisions, revision)?;
        (snapshot, plan)
    };
    let (schedule_preferences, schedules_changed) = crate::schedules::apply_transfer(
        &snapshot,
        &life,
        &mut plan.events,
        &request.schedule_decisions,
    )
    .map_err(command_error)?;
    if plan.result.added + plan.result.merged + plan.result.replaced == 0 && !schedules_changed {
        if let Ok(mut scans) = state.scanned_diaries.lock() {
            scans.remove(&request.scan_token);
        }
        return Ok(plan.result);
    }
    let previous = state.root.join("backups").join(format!(
        "pre-diary-import-{}-{restore_id}.zip",
        Utc::now().format("%Y%m%d%H%M%S")
    ));
    export_archive(state, &previous, false)?;
    plan.result.previous_library_backup_path = Some(previous.to_string_lossy().into_owned());
    // Hold the single writer lock from the final stale check through blob
    // publication and the SQLite transaction. Other save/import operations
    // cannot interleave and resurrect an old snapshot.
    let mut repo = repo_lock(state)?;
    check_scanned(
        &scanned,
        &repo.load_snapshot().map_err(command_error)?,
        repo.snapshot_revision().map_err(command_error)?,
    )?;
    let mut archive = ZipArchive::new(File::open(&staged_zip).map_err(command_error)?)
        .map_err(|cause| error("diary.zip", cause.to_string()))?;
    let mut staged = HashMap::<String, (PathBuf, RegisteredAttachment)>::new();
    for (source_path, meta) in &plan.to_stage {
        if staged.contains_key(&meta.relative_path) {
            continue;
        }
        let staged_target =
            security::safe_join(&staging_root, &meta.relative_path).map_err(security_error)?;
        if let Some(parent) = staged_target.parent() {
            fs::create_dir_all(parent).map_err(command_error)?;
        }
        let mut target = security::create_new_file(&staged_target).map_err(security_error)?;
        let mut entry = archive
            .by_name(source_path)
            .map_err(|cause| error("diary.missing_attachment", cause.to_string()))?;
        security::copy_limited(&mut entry, &mut target, meta.byte_size).map_err(security_error)?;
        target.sync_all().map_err(command_error)?;
        drop(target);
        if sha256_file(&staged_target)? != (meta.byte_size, meta.sha256.clone()) {
            return Err(error(
                "diary.hash_mismatch",
                "附件校验失败，未导入任何日记。",
            ));
        }
        staged.insert(meta.relative_path.clone(), (staged_target, meta.clone()));
    }
    drop(archive);
    let marker_path = recovery_marker_path(&state.root, &restore_id);
    let mut planned = Vec::new();
    for (_, meta) in staged.values() {
        let destination = attachment_service::controlled_path(&state.root, &meta.relative_path)
            .map_err(command_error)?;
        if !destination.exists() {
            planned.push(meta.relative_path.clone());
        }
    }
    write_recovery_marker(
        &marker_path,
        &RestoreRecoveryMarker {
            staging_path: format!("staging/restore-{restore_id}"),
            materialized_paths: planned,
        },
    )?;
    let mut materialized = Vec::new();
    let result = (|| {
        for (source, meta) in staged.values() {
            let destination = attachment_service::controlled_path(&state.root, &meta.relative_path)
                .map_err(command_error)?;
            if destination.exists() {
                if sha256_file(&destination)? != (meta.byte_size, meta.sha256.clone()) {
                    return Err(error(
                        "diary.path_conflict",
                        "本机附件路径已对应其他内容，未覆盖原文件。",
                    ));
                }
            } else {
                if let Some(parent) = destination.parent() {
                    fs::create_dir_all(parent).map_err(command_error)?;
                }
                security::reject_symlink_components(&destination).map_err(security_error)?;
                // Android storage can reject hard links. Create a private
                // verified copy and track ownership before the first write;
                // a failed copy must never delete a pre-existing target.
                security::copy_new_file_verified(
                    source,
                    &destination,
                    meta.byte_size,
                    &meta.sha256,
                    || materialized.push(destination.clone()),
                )
                .map_err(|cause| {
                    error(
                        "diary.attachment_publish",
                        format!("保存导入附件失败：{cause}"),
                    )
                })?;
            }
        }
        repo.restore_snapshot(
            &plan.events,
            &plan.stages,
            &schedule_preferences,
            plan.attachments,
        )
        .map_err(command_error)
    })();
    match result {
        Ok(ack) => {
            plan.result.revision = ack.revision;
            on_committed(&repo, &plan.result);
            let _ = fs::remove_file(&marker_path);
            if let Ok(mut scans) = state.scanned_diaries.lock() {
                scans.clear();
            }
            Ok(plan.result)
        }
        Err(cause) => {
            if cleanup_materialized_files(&materialized) {
                let _ = fs::remove_file(&marker_path);
            }
            Err(cause)
        }
    }
}

#[tauri::command]
pub(super) async fn diary_export(
    request: DiaryExportRequest,
    app: tauri::AppHandle,
) -> Result<DiaryExportResult, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        #[cfg(target_os = "android")]
        if request.destination_path.starts_with("content:") {
            let batch = mobile_files::TransferBatch::new(&state.root).map_err(command_error)?;
            let source = batch.directory.join("life-timeline-diaries.zip");
            let target = request.destination_path.clone();
            let mut result = export_diaries(
                &state,
                DiaryExportRequest {
                    destination_path: source.to_string_lossy().into_owned(),
                    start_date: request.start_date,
                    end_date: request.end_date,
                    overwrite: false,
                },
            )?;
            mobile::write_document(&app, &source, &target)?;
            result.archive_path = target;
            return Ok(result);
        }
        export_diaries(&state, request)
    })
    .await
    .map_err(|cause| error("diary.worker", cause.to_string()))?
}

#[tauri::command]
pub(super) async fn diary_scan(
    request: DiaryScanRequest,
    app: tauri::AppHandle,
) -> Result<DiaryScanResult, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        #[cfg(target_os = "android")]
        {
            let mut prepared =
                mobile::prepare_sources(&app, &state.root, vec![request.archive_path])?;
            let result = scan_diaries(
                &state,
                DiaryScanRequest {
                    archive_path: prepared.paths[0].clone(),
                },
            )?;
            prepared.preserve();
            Ok(result)
        }
        #[cfg(not(target_os = "android"))]
        scan_diaries(&state, request)
    })
    .await
    .map_err(|cause| error("diary.worker", cause.to_string()))?
}

#[tauri::command]
pub(super) async fn diary_import(
    request: DiaryImportRequest,
    app: tauri::AppHandle,
) -> Result<DiaryImportResult, CommandError> {
    tauri::async_runtime::spawn_blocking(move || import_diaries(&app.state::<AppState>(), request))
        .await
        .map_err(|cause| error("diary.worker", cause.to_string()))?
}
