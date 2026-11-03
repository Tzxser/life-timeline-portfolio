//! Shared data transfer objects and validation for the Tauri boundary.
//!
//! These types deliberately mirror the R3 TypeScript records. Rich text remains a
//! JSON document; it is never flattened to HTML or Markdown by the desktop layer.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeSet;
use thiserror::Error;

pub const SCHEMA_VERSION: u32 = 1;
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const MAX_EVENT_JSON_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_TEXT_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("数据库错误: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("文件错误: {0}")]
    Io(#[from] std::io::Error),
    #[error("数据无效: {0}")]
    Invalid(String),
    #[error("数据冲突: {0}")]
    Conflict(String),
    #[error("不支持的数据版本: {0}")]
    UnsupportedVersion(String),
    #[error("路径被拒绝: {0}")]
    PathDenied(String),
    #[error("序列化错误: {0}")]
    Json(#[from] serde_json::Error),
    #[error("哈希错误: {0}")]
    Hash(String),
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub code: String,
    pub message: String,
}

impl From<StorageError> for CommandError {
    fn from(error: StorageError) -> Self {
        let code = match error {
            StorageError::Database(_) => "storage.database",
            StorageError::Io(_) => "storage.io",
            StorageError::Invalid(_) => "validation.invalid",
            StorageError::Conflict(_) => "storage.conflict",
            StorageError::UnsupportedVersion(_) => "storage.unsupported_version",
            StorageError::PathDenied(_) => "security.path_denied",
            StorageError::Json(_) => "validation.json",
            StorageError::Hash(_) => "storage.hash",
        };
        Self {
            code: code.to_string(),
            message: error.to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LifeEvent {
    pub id: String,
    pub title: String,
    #[serde(rename = "type", default = "default_event_type")]
    pub record_type: String,
    pub date: String,
    pub display_date: String,
    pub date_precision: String,
    pub stage_id: Option<String>,
    pub importance: i64,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub rich_content: Option<Value>,
    #[serde(default)]
    pub attachment_ids: Vec<String>,
}

fn default_event_type() -> String {
    "event".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LifeStage {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub stage_type: String,
    pub start_date: String,
    pub start_display: String,
    pub start_precision: String,
    pub end_date: Option<String>,
    pub end_display: Option<String>,
    pub end_precision: Option<String>,
    pub is_ongoing: bool,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentMeta {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub byte_size: u64,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_modified: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relative_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentRecord {
    #[serde(flatten)]
    pub meta: AttachmentMeta,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppMeta {
    pub schema_version: u32,
    pub app_version: String,
    pub initialized: bool,
    pub data_epoch: u64,
    pub database_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSnapshot {
    pub events: Vec<LifeEvent>,
    pub stages: Vec<LifeStage>,
    pub preferences: Value,
    pub attachments: Vec<AttachmentRecord>,
    pub meta: AppMeta,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveAck {
    pub id: String,
    pub revision: u64,
    pub updated_at: String,
}

/// Result returned by an all-or-nothing library replacement.  A restore is a
/// new data epoch as well as a new snapshot revision, so clients can discard
/// editor, gallery and attachment caches before hydrating the returned data.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreAck {
    pub revision: u64,
    pub data_epoch: u64,
    pub restored_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportAttachmentRequest {
    pub name: String,
    pub mime_type: String,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub last_modified: Option<i64>,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportAttachmentResponse {
    pub meta: AttachmentMeta,
    pub relative_path: String,
    pub asset_url: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentIdRequest {
    pub id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveAttachmentAsRequest {
    pub id: String,
    pub target_path: String,
}

pub fn validate_identifier(value: &str, field: &str) -> Result<(), StorageError> {
    if value.is_empty() || value.len() > 160 || value.chars().any(|c| c.is_control()) {
        return Err(StorageError::Invalid(format!("{field} 长度或字符不合法")));
    }
    Ok(())
}

fn validate_date(value: &str, field: &str) -> Result<(), StorageError> {
    if value.is_empty() || value.len() > 32 || value.chars().any(|c| c.is_control()) {
        return Err(StorageError::Invalid(format!("{field} 不合法")));
    }
    let pieces: Vec<&str> = value.split('-').collect();
    if !(pieces.len() == 1 || pieces.len() == 2 || pieces.len() == 3)
        || pieces
            .iter()
            .any(|part| part.is_empty() || part.parse::<u32>().is_err())
    {
        return Err(StorageError::Invalid(format!("{field} 必须是年月日形式")));
    }
    let year = pieces[0].parse::<u32>().unwrap_or_default();
    if !(1..=9999).contains(&year) {
        return Err(StorageError::Invalid(format!("{field} 年份超出范围")));
    }
    if let Some(month) = pieces
        .get(1)
        .map(|part| part.parse::<u32>().unwrap_or_default())
    {
        if !(1..=12).contains(&month) {
            return Err(StorageError::Invalid(format!("{field} 月份超出范围")));
        }
        if let Some(day) = pieces
            .get(2)
            .map(|part| part.parse::<u32>().unwrap_or_default())
        {
            let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
            let days = match month {
                2 if leap => 29,
                2 => 28,
                4 | 6 | 9 | 11 => 30,
                _ => 31,
            };
            if !(1..=days).contains(&day) {
                return Err(StorageError::Invalid(format!("{field} 日期超出范围")));
            }
        }
    }
    Ok(())
}

fn validate_date_precision(value: &str, field: &str) -> Result<(), StorageError> {
    const PRECISIONS: &[&str] = &["day", "month", "year", "approx", "stage", "unknown"];
    if !PRECISIONS.contains(&value) {
        return Err(StorageError::Invalid(format!("{field} 日期精度不支持")));
    }
    Ok(())
}

fn validate_rich_content(value: &Value) -> Result<(), StorageError> {
    let bytes = serde_json::to_vec(value)?.len();
    if bytes > MAX_EVENT_JSON_BYTES {
        return Err(StorageError::Invalid(
            "richContent 超过大小限制".to_string(),
        ));
    }
    fn walk(value: &Value, depth: usize) -> Result<(), StorageError> {
        if depth > 128 {
            return Err(StorageError::Invalid("richContent 嵌套过深".to_string()));
        }
        if value.get("type").and_then(Value::as_str) == Some("lifeSchedule") {
            crate::schedules::validate_card(&value["attrs"]["card"])?;
        }
        match value {
            Value::Array(values) => values.iter().try_for_each(|v| walk(v, depth + 1)),
            Value::Object(map) => map.values().try_for_each(|v| walk(v, depth + 1)),
            _ => Ok(()),
        }
    }
    if let Some(content) = value
        .get("doc")
        .and_then(|doc| doc.get("content"))
        .and_then(Value::as_array)
    {
        fn nested_schedule(value: &Value) -> bool {
            match value {
                Value::Object(map) => {
                    if map.get("type").and_then(Value::as_str) == Some("lifeSchedule") {
                        return true;
                    }
                    map.values().any(nested_schedule)
                }
                Value::Array(values) => values.iter().any(nested_schedule),
                _ => false,
            }
        }
        for node in content {
            if node.get("type").and_then(Value::as_str) != Some("lifeSchedule")
                && nested_schedule(node)
            {
                return Err(StorageError::Invalid(
                    "日程卡片只能放在日记正文的顶层。".to_string(),
                ));
            }
        }
    }
    walk(value, 0)
}

/// Collect attachment ids from lifeImage/lifeAttachment nodes and imageLink marks.
pub fn derive_attachment_ids(value: &Value) -> BTreeSet<String> {
    fn visit(value: &Value, ids: &mut BTreeSet<String>) {
        match value {
            Value::Array(items) => items.iter().for_each(|v| visit(v, ids)),
            Value::Object(map) => {
                if let Some(Value::String(id)) = map.get("attachmentId") {
                    ids.insert(id.clone());
                }
                if let Some(Value::String(id)) = map.get("imageId") {
                    ids.insert(id.clone());
                }
                map.values().for_each(|v| visit(v, ids));
            }
            _ => {}
        }
    }
    let mut ids = BTreeSet::new();
    visit(value, &mut ids);
    ids
}

pub fn validate_event(event: &LifeEvent) -> Result<BTreeSet<String>, StorageError> {
    validate_identifier(&event.id, "event.id")?;
    if event.title.len() > MAX_TEXT_BYTES
        || event.display_date.len() > MAX_TEXT_BYTES
        || event.summary.len() > MAX_TEXT_BYTES
        || event.content.len() > MAX_TEXT_BYTES
    {
        return Err(StorageError::Invalid("记录文字过长".to_string()));
    }
    if event.record_type != "event" && event.record_type != "daily" {
        return Err(StorageError::Invalid(
            "记录 type 只能是 event 或 daily".to_string(),
        ));
    }
    validate_date(&event.date, "event.date")?;
    validate_date_precision(&event.date_precision, "event.datePrecision")?;
    if event.record_type == "daily"
        && (event.date_precision != "day" || event.date.split('-').count() != 3)
    {
        return Err(StorageError::Invalid(
            "Daily 记录必须使用完整自然日".to_string(),
        ));
    }
    if !(1..=5).contains(&event.importance) {
        return Err(StorageError::Invalid("重要程度必须为 1 到 5".to_string()));
    }
    if let Some(stage_id) = &event.stage_id {
        validate_identifier(stage_id, "event.stageId")?;
    }
    let mut ids: BTreeSet<String> = event.attachment_ids.iter().cloned().collect();
    for id in &ids {
        validate_identifier(id, "event.attachmentIds")?;
    }
    if let Some(rich) = &event.rich_content {
        validate_rich_content(rich)?;
        ids.extend(derive_attachment_ids(rich));
    }
    for id in &ids {
        validate_identifier(id, "event.attachmentIds")?;
    }
    Ok(ids)
}

pub fn validate_stage(stage: &LifeStage) -> Result<(), StorageError> {
    validate_identifier(&stage.id, "stage.id")?;
    if stage.name.is_empty()
        || stage.name.len() > MAX_TEXT_BYTES
        || stage.start_display.len() > MAX_TEXT_BYTES
        || stage.end_display.as_deref().unwrap_or("").len() > MAX_TEXT_BYTES
        || stage.description.as_deref().unwrap_or("").len() > MAX_TEXT_BYTES
    {
        return Err(StorageError::Invalid("阶段文字长度不合法".to_string()));
    }
    if stage.stage_type != "range" && stage.stage_type != "ongoing" {
        return Err(StorageError::Invalid(
            "阶段 type 只能是 range 或 ongoing".to_string(),
        ));
    }
    validate_date_precision(&stage.start_precision, "stage.startPrecision")?;
    validate_date(&stage.start_date, "stage.startDate")?;
    if let Some(end) = &stage.end_date {
        validate_date(end, "stage.endDate")?;
        let Some(end_precision) = stage.end_precision.as_deref() else {
            return Err(StorageError::Invalid(
                "阶段结束日期缺少日期精度".to_string(),
            ));
        };
        validate_date_precision(end_precision, "stage.endPrecision")?;
    } else if stage.end_precision.is_some() {
        return Err(StorageError::Invalid(
            "没有结束日期时不能设置结束日期精度".to_string(),
        ));
    }
    if stage.is_ongoing && stage.end_date.is_some() {
        return Err(StorageError::Invalid(
            "ongoing 阶段不能同时设置结束日期".to_string(),
        ));
    }
    Ok(())
}

pub fn validate_preferences(preferences: &Value) -> Result<(), StorageError> {
    crate::schedules::validate_preferences(preferences)?;
    let bytes = serde_json::to_vec(preferences)?.len();
    if bytes > MAX_EVENT_JSON_BYTES {
        return Err(StorageError::Invalid("偏好设置超过大小限制".to_string()));
    }
    if !preferences.is_object() {
        return Err(StorageError::Invalid("偏好设置必须是对象".to_string()));
    }
    Ok(())
}

pub fn validate_import(req: &ImportAttachmentRequest) -> Result<(), StorageError> {
    if req.name.is_empty()
        || req.name.len() > 1024
        || req
            .name
            .chars()
            .any(|c| c.is_control() || c == '/' || c == '\\' || c == '\0')
    {
        return Err(StorageError::Invalid("附件名称不合法".to_string()));
    }
    if req.mime_type.len() > 256 || req.mime_type.chars().any(|c| c.is_control()) {
        return Err(StorageError::Invalid("附件 MIME 类型不合法".to_string()));
    }
    if let Some(kind) = &req.kind {
        if kind != "image" && kind != "file" {
            return Err(StorageError::Invalid("附件类型不合法".to_string()));
        }
        if kind == "image" && !req.mime_type.to_ascii_lowercase().starts_with("image/") {
            return Err(StorageError::Invalid(
                "图片附件的 MIME 类型不合法".to_string(),
            ));
        }
    }
    if req.bytes.is_empty() {
        return Err(StorageError::Invalid("不允许导入 0 字节附件".to_string()));
    }
    let image = req.mime_type.to_ascii_lowercase().starts_with("image/");
    let max = if image {
        10 * 1024 * 1024
    } else {
        50 * 1024 * 1024
    };
    if req.bytes.len() > max {
        return Err(StorageError::Invalid(format!(
            "附件超过 {} MiB 限制",
            max / (1024 * 1024)
        )));
    }
    // Validate each dimension independently.  A malformed caller can omit
    // the other dimension; that must not bypass the upper bound or allow a
    // zero-sized image into the native metadata store.
    if req
        .width
        .is_some_and(|value| !(1..=100_000).contains(&value))
        || req
            .height
            .is_some_and(|value| !(1..=100_000).contains(&value))
    {
        return Err(StorageError::Invalid("图片尺寸不合法".to_string()));
    }
    Ok(())
}

pub fn json_object() -> Value {
    Value::Object(Map::new())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rich_content_attachment_ids_are_derived() {
        let value = serde_json::json!({"type":"doc","content":[{"type":"lifeImage","attrs":{"attachmentId":"a"}},{"marks":[{"type":"imageLink","attrs":{"imageId":"b"}}]}]});
        let ids = derive_attachment_ids(&value);
        assert_eq!(ids.into_iter().collect::<Vec<_>>(), vec!["a", "b"]);
    }
    #[test]
    fn daily_and_event_types_are_checked() {
        let mut event = LifeEvent {
            id: "e".into(),
            title: "x".into(),
            record_type: "daily".into(),
            date: "2026-09-28".into(),
            display_date: "今天".into(),
            date_precision: "day".into(),
            stage_id: None,
            importance: 2,
            summary: String::new(),
            content: String::new(),
            rich_content: None,
            attachment_ids: vec![],
        };
        assert!(validate_event(&event).is_ok());
        event.record_type = "bad".into();
        assert!(validate_event(&event).is_err());
    }

    #[test]
    fn import_dimensions_are_bounded_independently() {
        let mut request = ImportAttachmentRequest {
            name: "photo.png".into(),
            mime_type: "image/png".into(),
            kind: Some("image".into()),
            last_modified: None,
            width: Some(100_001),
            height: None,
            bytes: vec![1],
        };
        assert!(validate_import(&request).is_err());
        request.width = Some(1);
        request.height = Some(0);
        assert!(validate_import(&request).is_err());
        request.height = Some(100_000);
        assert!(validate_import(&request).is_ok());
    }
}
