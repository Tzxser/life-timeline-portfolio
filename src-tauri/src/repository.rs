//! Single-writer SQLite repository for events, stages, preferences and
//! attachment metadata. The WebView never receives a generic SQL command.
#![allow(dead_code)]

use crate::migrations::{migrate, read_meta, write_meta};
use crate::models::{
    json_object, validate_event, validate_preferences, validate_stage, AppMeta, AppSnapshot,
    AttachmentMeta, AttachmentRecord, LifeEvent, LifeStage, RestoreAck, SaveAck, StorageError,
    APP_VERSION, SCHEMA_VERSION,
};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct RegisteredAttachment {
    pub id: String,
    pub sha256: String,
    pub name: String,
    pub mime_type: String,
    pub byte_size: u64,
    pub kind: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub last_modified: Option<i64>,
    pub relative_path: String,
    pub created_at: String,
}

pub struct Repository {
    connection: Connection,
    database_path: PathBuf,
}

impl Repository {
    pub fn open(data_root: &Path) -> Result<Self, StorageError> {
        std::fs::create_dir_all(data_root)?;
        let database_path = data_root.join("life-timeline.sqlite");
        let mut connection = Connection::open(&database_path)?;
        connection.execute_batch(
            "PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;",
        )?;
        migrate(&mut connection)?;
        if read_meta(&connection, "databaseId")?.is_none() {
            write_meta(&connection, "databaseId", &Uuid::new_v4().to_string())?;
        }
        Ok(Self {
            connection,
            database_path,
        })
    }

    pub fn database_path(&self) -> &Path {
        &self.database_path
    }

    pub fn load_snapshot(&self) -> Result<AppSnapshot, StorageError> {
        let mut stage_stmt = self.connection.prepare(
            "SELECT id, name, stage_type, start_date, start_display, start_precision,
                    end_date, end_display, end_precision, is_ongoing, description
             FROM stages ORDER BY sort_order ASC, id ASC",
        )?;
        let stages = stage_stmt
            .query_map([], |row| {
                Ok(LifeStage {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    stage_type: row.get(2)?,
                    start_date: row.get(3)?,
                    start_display: row.get(4)?,
                    start_precision: row.get(5)?,
                    end_date: row.get(6)?,
                    end_display: row.get(7)?,
                    end_precision: row.get(8)?,
                    is_ongoing: row.get::<_, i64>(9)? != 0,
                    description: row.get(10)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        let mut event_stmt = self.connection.prepare(
            "SELECT id, record_type, title, date, display_date, date_precision,
                    stage_id, importance, summary, content, rich_content, attachment_ids
             FROM events ORDER BY date ASC, sort_order ASC, id ASC",
        )?;
        let events = event_stmt
            .query_map([], |row| {
                let rich_content: Option<String> = row.get(10)?;
                let attachment_ids: String = row.get(11)?;
                let rich_content = rich_content
                    .map(|value| serde_json::from_str::<Value>(&value))
                    .transpose()
                    .map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            10,
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })?;
                let attachment_ids =
                    serde_json::from_str::<Vec<String>>(&attachment_ids).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            11,
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })?;
                Ok(LifeEvent {
                    id: row.get(0)?,
                    record_type: row.get(1)?,
                    title: row.get(2)?,
                    date: row.get(3)?,
                    display_date: row.get(4)?,
                    date_precision: row.get(5)?,
                    stage_id: row.get(6)?,
                    importance: row.get(7)?,
                    summary: row.get(8)?,
                    content: row.get(9)?,
                    rich_content,
                    attachment_ids,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        let preferences = self
            .connection
            .query_row(
                "SELECT value FROM preferences WHERE key = 'settings'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .map(|value| serde_json::from_str(&value))
            .transpose()?
            .unwrap_or_else(json_object);

        let attachments = self.list_attachments()?;
        let initialized = read_meta(&self.connection, "initialized")?.as_deref() == Some("1");
        let data_epoch = read_meta(&self.connection, "dataEpoch")?
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(1);
        let database_id = read_meta(&self.connection, "databaseId")?
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "unknown".to_string());
        Ok(AppSnapshot {
            events,
            stages,
            preferences,
            attachments,
            meta: AppMeta {
                schema_version: SCHEMA_VERSION,
                app_version: APP_VERSION.to_string(),
                initialized,
                data_epoch,
                database_id,
            },
        })
    }

    pub fn snapshot_revision(&self) -> Result<u64, StorageError> {
        Ok(read_meta(&self.connection, "snapshotRevision")?
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0))
    }

    pub fn data_epoch(&self) -> Result<u64, StorageError> {
        Ok(read_meta(&self.connection, "dataEpoch")?
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(1))
    }

    /// Atomically replace the event/stage snapshot from the front-end save
    /// queue. A single monotonically increasing revision protects against a
    /// late ACK or an old queued snapshot replacing newer user input.
    pub fn save_snapshot(
        &mut self,
        events: &[LifeEvent],
        stages: &[LifeStage],
        preferences: &Value,
        requested_revision: u64,
    ) -> Result<SaveAck, StorageError> {
        validate_preferences(preferences)?;
        let revision = requested_revision.max(1);
        let current_revision = self.snapshot_revision()?;
        if revision < current_revision {
            return Err(StorageError::Conflict(format!(
                "旧资料库 revision {revision} 被拒绝，当前为 {current_revision}"
            )));
        }
        let now = Utc::now().to_rfc3339();
        let transaction = self.connection.transaction()?;

        // Validate the complete input before deleting anything in the current
        // transaction. Attachments are looked up in the same SQLite snapshot.
        let mut stage_ids: HashSet<&str> = HashSet::with_capacity(stages.len());
        for stage in stages {
            validate_stage(stage)?;
            if !stage_ids.insert(stage.id.as_str()) {
                return Err(StorageError::Conflict(format!(
                    "资料库快照包含重复阶段 ID: {}",
                    stage.id
                )));
            }
        }
        let mut validated_events = Vec::with_capacity(events.len());
        let mut event_ids: HashSet<&str> = HashSet::with_capacity(events.len());
        let mut daily_dates: HashSet<&str> = HashSet::new();
        for event in events {
            let attachment_ids = validate_event(event)?;
            if !event_ids.insert(event.id.as_str()) {
                return Err(StorageError::Conflict(format!(
                    "资料库快照包含重复记录 ID: {}",
                    event.id
                )));
            }
            if event.record_type == "daily" && !daily_dates.insert(event.date.as_str()) {
                return Err(StorageError::Conflict(format!(
                    "同一天存在多篇 Daily 记录: {}",
                    event.date
                )));
            }
            if let Some(stage_id) = &event.stage_id {
                if !stage_ids.contains(stage_id.as_str()) {
                    return Err(StorageError::Invalid(format!(
                        "资料库快照引用了未包含的阶段: {stage_id}"
                    )));
                }
            }
            for attachment_id in &attachment_ids {
                let exists: bool = transaction.query_row(
                    "SELECT EXISTS(SELECT 1 FROM attachments WHERE id = ?1)",
                    [attachment_id],
                    |row| row.get(0),
                )?;
                if !exists {
                    return Err(StorageError::Invalid(format!(
                        "引用的附件不存在: {attachment_id}"
                    )));
                }
            }
            validated_events.push(attachment_ids);
        }

        if revision == current_revision && current_revision != 0 {
            return Ok(SaveAck {
                id: "snapshot".to_string(),
                revision: current_revision,
                updated_at: now,
            });
        }

        let incoming_event_ids: HashSet<&str> =
            events.iter().map(|event| event.id.as_str()).collect();
        let existing_event_ids = collect_ids(&transaction, "events")?;
        for id in existing_event_ids
            .iter()
            .filter(|id| !incoming_event_ids.contains(id.as_str()))
        {
            transaction.execute("DELETE FROM events WHERE id = ?1", [id])?;
        }
        let incoming_stage_ids: HashSet<&str> =
            stages.iter().map(|stage| stage.id.as_str()).collect();
        let existing_stage_ids = collect_ids(&transaction, "stages")?;
        for id in existing_stage_ids
            .iter()
            .filter(|id| !incoming_stage_ids.contains(id.as_str()))
        {
            if id != "stage-all" {
                transaction.execute("DELETE FROM stages WHERE id = ?1", [id])?;
            }
        }
        for (index, stage) in stages.iter().enumerate() {
            upsert_stage_tx(&transaction, stage, revision, index as i64, &now)?;
        }
        for (index, event) in events.iter().enumerate() {
            upsert_event_tx(
                &transaction,
                event,
                &validated_events[index],
                revision,
                index as i64,
                &now,
            )?;
        }
        transaction.execute(
            "INSERT INTO preferences(key, value, updated_at) VALUES ('settings', ?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
            params![serde_json::to_string(preferences)?, now],
        )?;
        write_meta(&transaction, "initialized", "1")?;
        write_meta(&transaction, "snapshotRevision", &revision.to_string())?;
        transaction.commit()?;
        Ok(SaveAck {
            id: "snapshot".to_string(),
            revision,
            updated_at: now,
        })
    }

    /// Replace the complete local library in one SQLite transaction.
    ///
    /// The caller must have copied and hash-checked attachment files into the
    /// controlled attachments directory before calling this method.  This
    /// method only changes database state; if validation or any SQL statement
    /// fails, SQLite rolls back and the previous library remains intact.
    pub fn restore_snapshot(
        &mut self,
        events: &[LifeEvent],
        stages: &[LifeStage],
        preferences: &Value,
        attachments: Vec<RegisteredAttachment>,
    ) -> Result<RestoreAck, StorageError> {
        validate_preferences(preferences)?;

        // Validate IDs and cross-record references before opening the write
        // transaction.  This also catches duplicate Daily dates explicitly,
        // instead of relying on SQLite's partial unique index after a delete.
        let mut stage_ids = HashSet::with_capacity(stages.len());
        for stage in stages {
            validate_stage(stage)?;
            if !stage_ids.insert(stage.id.clone()) {
                return Err(StorageError::Conflict(format!(
                    "恢复资料库包含重复阶段 ID: {}",
                    stage.id
                )));
            }
        }

        let mut attachment_ids = HashSet::with_capacity(attachments.len());
        let mut blobs: HashMap<String, (String, u64)> = HashMap::new();
        let mut paths: HashMap<String, String> = HashMap::new();
        for attachment in &attachments {
            validate_registered_attachment(attachment)?;
            if !attachment_ids.insert(attachment.id.clone()) {
                return Err(StorageError::Conflict(format!(
                    "恢复资料库包含重复附件 ID: {}",
                    attachment.id
                )));
            }
            if let Some((path, byte_size)) = blobs.get(&attachment.sha256) {
                if path != &attachment.relative_path || *byte_size != attachment.byte_size {
                    return Err(StorageError::Conflict(format!(
                        "同一附件 hash 对应了不同文件: {}",
                        attachment.sha256
                    )));
                }
            } else {
                blobs.insert(
                    attachment.sha256.clone(),
                    (attachment.relative_path.clone(), attachment.byte_size),
                );
            }
            if let Some(existing_sha) =
                paths.insert(attachment.relative_path.clone(), attachment.sha256.clone())
            {
                if existing_sha != attachment.sha256 {
                    return Err(StorageError::Conflict(format!(
                        "附件路径对应多个 hash: {}",
                        attachment.relative_path
                    )));
                }
            }
        }

        let mut event_ids = HashSet::with_capacity(events.len());
        let mut daily_dates = HashSet::new();
        let mut validated_events = Vec::with_capacity(events.len());
        for event in events {
            let references = validate_event(event)?;
            if !event_ids.insert(event.id.clone()) {
                return Err(StorageError::Conflict(format!(
                    "恢复资料库包含重复记录 ID: {}",
                    event.id
                )));
            }
            if event.record_type == "daily" && !daily_dates.insert(event.date.clone()) {
                return Err(StorageError::Conflict(format!(
                    "同一天存在多篇 Daily 记录: {}",
                    event.date
                )));
            }
            if let Some(stage_id) = &event.stage_id {
                if !stage_ids.contains(stage_id) {
                    return Err(StorageError::Invalid(format!(
                        "记录引用了未包含的阶段: {stage_id}"
                    )));
                }
            }
            for attachment_id in &references {
                if !attachment_ids.contains(attachment_id) {
                    return Err(StorageError::Invalid(format!(
                        "记录引用了未包含的附件: {attachment_id}"
                    )));
                }
            }
            validated_events.push(references);
        }

        let now = Utc::now().to_rfc3339();
        let transaction = self.connection.transaction()?;
        let current_epoch = read_meta_tx(&transaction, "dataEpoch")?
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(1);
        let current_revision = read_meta_tx(&transaction, "snapshotRevision")?
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0);
        let data_epoch = current_epoch
            .checked_add(1)
            .ok_or_else(|| StorageError::Conflict("资料库 epoch 已达到上限".to_string()))?;
        let revision = current_revision
            .checked_add(1)
            .ok_or_else(|| StorageError::Conflict("资料库 revision 已达到上限".to_string()))?;

        // Delete in foreign-key order.  No old row or old blob survives a
        // successful full restore, while a failure rolls the entire sequence
        // back as one unit.
        transaction.execute("DELETE FROM event_attachments", [])?;
        transaction.execute("DELETE FROM events", [])?;
        transaction.execute("DELETE FROM stages", [])?;
        transaction.execute("DELETE FROM attachments", [])?;
        transaction.execute("DELETE FROM attachment_blobs", [])?;

        for attachment in &attachments {
            transaction.execute(
                "INSERT OR IGNORE INTO attachment_blobs(sha256, relative_path, byte_size, created_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![attachment.sha256, attachment.relative_path, attachment.byte_size as i64, attachment.created_at],
            )?;
        }
        for attachment in &attachments {
            transaction.execute(
                "INSERT INTO attachments(
                    id, sha256, name, mime_type, byte_size, kind, width, height, last_modified, created_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    attachment.id, attachment.sha256, attachment.name, attachment.mime_type,
                    attachment.byte_size as i64, attachment.kind,
                    attachment.width.map(|value| value as i64), attachment.height.map(|value| value as i64),
                    attachment.last_modified, attachment.created_at,
                ],
            )?;
        }
        for (index, stage) in stages.iter().enumerate() {
            upsert_stage_tx(&transaction, stage, revision, index as i64, &now)?;
        }
        for (index, event) in events.iter().enumerate() {
            upsert_event_tx(
                &transaction,
                event,
                &validated_events[index],
                revision,
                index as i64,
                &now,
            )?;
        }
        transaction.execute(
            "INSERT INTO preferences(key, value, updated_at) VALUES ('settings', ?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
            params![serde_json::to_string(preferences)?, now],
        )?;
        write_meta(&transaction, "initialized", "1")?;
        write_meta(&transaction, "dataEpoch", &data_epoch.to_string())?;
        write_meta(&transaction, "snapshotRevision", &revision.to_string())?;
        transaction.commit()?;
        Ok(RestoreAck {
            revision,
            data_epoch,
            restored_at: now,
        })
    }

    pub fn save_event(
        &mut self,
        event: &LifeEvent,
        requested_revision: u64,
    ) -> Result<SaveAck, StorageError> {
        let attachment_ids = validate_event(event)?;
        if let Some(stage_id) = &event.stage_id {
            let exists: bool = self.connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM stages WHERE id = ?1)",
                [stage_id],
                |row| row.get(0),
            )?;
            if !exists {
                return Err(StorageError::Invalid(format!(
                    "引用的阶段不存在: {stage_id}"
                )));
            }
        }
        for attachment_id in &attachment_ids {
            let exists: bool = self.connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM attachments WHERE id = ?1)",
                [attachment_id],
                |row| row.get(0),
            )?;
            if !exists {
                return Err(StorageError::Invalid(format!(
                    "引用的附件不存在: {attachment_id}"
                )));
            }
        }
        let revision = requested_revision.max(1);
        let now = Utc::now().to_rfc3339();
        let transaction = self.connection.transaction()?;
        let existing: Option<(u64, i64, String)> = transaction
            .query_row(
                "SELECT revision, sort_order, created_at FROM events WHERE id = ?1",
                [&event.id],
                |row| Ok((row.get::<_, i64>(0)? as u64, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let had_existing = existing.is_some();
        let (current_revision, sort_order, created_at) =
            existing.unwrap_or((0, next_sort_order(&transaction, "events")?, now.clone()));
        if had_existing && revision < current_revision {
            return Err(StorageError::Conflict(format!(
                "记录 {} 的旧 revision {} 被拒绝，当前为 {}",
                event.id, revision, current_revision
            )));
        }
        if had_existing && revision == current_revision {
            return Ok(SaveAck {
                id: event.id.clone(),
                revision: current_revision,
                updated_at: now,
            });
        }
        let rich_content = event
            .rich_content
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let attachment_json =
            serde_json::to_string(&attachment_ids.iter().cloned().collect::<Vec<_>>())?;
        transaction
            .execute(
                "INSERT INTO events(
                id, record_type, title, date, display_date, date_precision, stage_id,
                importance, summary, content, rich_content, attachment_ids, sort_order,
                revision, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
             ON CONFLICT(id) DO UPDATE SET
                record_type=excluded.record_type, title=excluded.title, date=excluded.date,
                display_date=excluded.display_date, date_precision=excluded.date_precision,
                stage_id=excluded.stage_id, importance=excluded.importance,
                summary=excluded.summary, content=excluded.content,
                rich_content=excluded.rich_content, attachment_ids=excluded.attachment_ids,
                revision=excluded.revision, updated_at=excluded.updated_at",
                params![
                    event.id,
                    event.record_type,
                    event.title,
                    event.date,
                    event.display_date,
                    event.date_precision,
                    event.stage_id,
                    event.importance,
                    event.summary,
                    event.content,
                    rich_content,
                    attachment_json,
                    sort_order,
                    revision as i64,
                    created_at,
                    now,
                ],
            )
            .map_err(|error| {
                if let rusqlite::Error::SqliteFailure(_, Some(message)) = &error {
                    if message.to_ascii_lowercase().contains("events.date")
                        || message.to_ascii_lowercase().contains("unique")
                    {
                        return StorageError::Conflict("同一天已经存在一篇 Daily 记录".to_string());
                    }
                }
                StorageError::Database(error)
            })?;
        transaction.execute(
            "DELETE FROM event_attachments WHERE event_id = ?1",
            [&event.id],
        )?;
        for (position, attachment_id) in attachment_ids.iter().enumerate() {
            transaction.execute(
                "INSERT INTO event_attachments(event_id, attachment_id, position) VALUES (?1, ?2, ?3)",
                params![event.id, attachment_id, position as i64],
            )?;
        }
        write_meta(&transaction, "initialized", "1")?;
        transaction.commit()?;
        Ok(SaveAck {
            id: event.id.clone(),
            revision,
            updated_at: now,
        })
    }

    pub fn delete_event(&mut self, id: &str) -> Result<bool, StorageError> {
        crate::models::validate_identifier(id, "event.id")?;
        let transaction = self.connection.transaction()?;
        let changed = transaction.execute("DELETE FROM events WHERE id = ?1", [id])? > 0;
        transaction.commit()?;
        Ok(changed)
    }

    pub fn save_stage(
        &mut self,
        stage: &LifeStage,
        requested_revision: u64,
    ) -> Result<SaveAck, StorageError> {
        validate_stage(stage)?;
        let revision = requested_revision.max(1);
        let now = Utc::now().to_rfc3339();
        let transaction = self.connection.transaction()?;
        let existing: Option<(u64, i64, String)> = transaction
            .query_row(
                "SELECT revision, sort_order, created_at FROM stages WHERE id = ?1",
                [&stage.id],
                |row| Ok((row.get::<_, i64>(0)? as u64, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let had_existing = existing.is_some();
        let (current_revision, sort_order, created_at) =
            existing.unwrap_or((0, next_sort_order(&transaction, "stages")?, now.clone()));
        if had_existing && revision < current_revision {
            return Err(StorageError::Conflict(format!(
                "阶段 {} 的旧 revision 被拒绝",
                stage.id
            )));
        }
        if had_existing && revision == current_revision {
            return Ok(SaveAck {
                id: stage.id.clone(),
                revision: current_revision,
                updated_at: now,
            });
        }
        transaction.execute(
            "INSERT INTO stages(
                id, name, stage_type, start_date, start_display, start_precision,
                end_date, end_display, end_precision, is_ongoing, description,
                sort_order, revision, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
             ON CONFLICT(id) DO UPDATE SET
                name=excluded.name, stage_type=excluded.stage_type,
                start_date=excluded.start_date, start_display=excluded.start_display,
                start_precision=excluded.start_precision, end_date=excluded.end_date,
                end_display=excluded.end_display, end_precision=excluded.end_precision,
                is_ongoing=excluded.is_ongoing, description=excluded.description,
                revision=excluded.revision, updated_at=excluded.updated_at",
            params![
                stage.id,
                stage.name,
                stage.stage_type,
                stage.start_date,
                stage.start_display,
                stage.start_precision,
                stage.end_date,
                stage.end_display,
                stage.end_precision,
                stage.is_ongoing as i64,
                stage.description,
                sort_order,
                revision as i64,
                created_at,
                now,
            ],
        )?;
        write_meta(&transaction, "initialized", "1")?;
        transaction.commit()?;
        Ok(SaveAck {
            id: stage.id.clone(),
            revision,
            updated_at: now,
        })
    }

    pub fn delete_stage(&mut self, id: &str) -> Result<bool, StorageError> {
        crate::models::validate_identifier(id, "stage.id")?;
        if id == "stage-all" {
            return Err(StorageError::Invalid("系统阶段不能删除".to_string()));
        }
        let transaction = self.connection.transaction()?;
        let changed = transaction.execute("DELETE FROM stages WHERE id = ?1", [id])? > 0;
        transaction.commit()?;
        Ok(changed)
    }

    pub fn save_preferences(&mut self, preferences: &Value) -> Result<SaveAck, StorageError> {
        validate_preferences(preferences)?;
        let now = Utc::now().to_rfc3339();
        let serialized = serde_json::to_string(preferences)?;
        self.connection.execute(
            "INSERT INTO preferences(key, value, updated_at) VALUES ('settings', ?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
            params![serialized, now],
        )?;
        Ok(SaveAck {
            id: "settings".to_string(),
            revision: 1,
            updated_at: now,
        })
    }

    pub fn list_attachments(&self) -> Result<Vec<AttachmentRecord>, StorageError> {
        let mut statement = self.connection.prepare(
            "SELECT a.id, a.name, a.mime_type, a.byte_size, a.kind, a.width, a.height,
                    a.last_modified, a.sha256, b.relative_path, a.created_at
             FROM attachments a JOIN attachment_blobs b ON b.sha256 = a.sha256
             ORDER BY a.created_at ASC, a.id ASC",
        )?;
        let result = statement
            .query_map([], |row| {
                Ok(AttachmentRecord {
                    meta: AttachmentMeta {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        mime_type: row.get(2)?,
                        byte_size: row.get::<_, i64>(3)? as u64,
                        kind: row.get(4)?,
                        width: row.get::<_, Option<i64>>(5)?.map(|v| v as u32),
                        height: row.get::<_, Option<i64>>(6)?.map(|v| v as u32),
                        last_modified: row.get(7)?,
                        sha256: row.get(8)?,
                        relative_path: row.get(9)?,
                        asset_url: None,
                    },
                    created_at: row.get(10)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(result)
    }

    pub fn attachment(&self, id: &str) -> Result<Option<AttachmentRecord>, StorageError> {
        Ok(self
            .list_attachments()?
            .into_iter()
            .find(|attachment| attachment.meta.id == id))
    }

    pub fn register_attachment(
        &mut self,
        attachment: &RegisteredAttachment,
    ) -> Result<(), StorageError> {
        validate_registered_attachment(attachment)?;
        let transaction = self.connection.transaction()?;
        let existing_blob: Option<(String, i64)> = transaction
            .query_row(
                "SELECT relative_path, byte_size FROM attachment_blobs WHERE sha256 = ?1",
                [&attachment.sha256],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((relative_path, byte_size)) = existing_blob {
            if relative_path != attachment.relative_path || byte_size != attachment.byte_size as i64
            {
                return Err(StorageError::Conflict(
                    "附件 hash 已对应其他路径或大小".to_string(),
                ));
            }
        }
        let existing_attachment: Option<String> = transaction
            .query_row(
                "SELECT sha256 FROM attachments WHERE id = ?1",
                [&attachment.id],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(existing_sha) = existing_attachment {
            if existing_sha != attachment.sha256 {
                return Err(StorageError::Conflict("附件 ID 已对应其他内容".to_string()));
            }
        }
        transaction.execute(
            "INSERT OR IGNORE INTO attachment_blobs(sha256, relative_path, byte_size, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![attachment.sha256, attachment.relative_path, attachment.byte_size as i64, attachment.created_at],
        )?;
        transaction.execute(
            "INSERT INTO attachments(id, sha256, name, mime_type, byte_size, kind, width, height, last_modified, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(id) DO UPDATE SET sha256=excluded.sha256, name=excluded.name,
               mime_type=excluded.mime_type, byte_size=excluded.byte_size, kind=excluded.kind,
               width=excluded.width, height=excluded.height, last_modified=excluded.last_modified",
            params![
                attachment.id, attachment.sha256, attachment.name, attachment.mime_type,
                attachment.byte_size as i64, attachment.kind, attachment.width.map(|v| v as i64),
                attachment.height.map(|v| v as i64), attachment.last_modified, attachment.created_at,
            ],
        )?;
        write_meta(&transaction, "initialized", "1")?;
        transaction.commit()?;
        Ok(())
    }

    pub fn attachment_bytes_path(
        &self,
        id: &str,
    ) -> Result<Option<(AttachmentMeta, String)>, StorageError> {
        let attachment = self.attachment(id)?;
        Ok(attachment.map(|record| {
            (
                record.meta.clone(),
                record.meta.relative_path.unwrap_or_default(),
            )
        }))
    }

    pub fn flush(&mut self) -> Result<bool, StorageError> {
        self.connection
            .execute_batch("PRAGMA wal_checkpoint(PASSIVE);")?;
        Ok(true)
    }

    pub fn checkpoint_full(&mut self) -> Result<bool, StorageError> {
        self.connection
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
        Ok(true)
    }
}

fn read_meta_tx(transaction: &Transaction<'_>, key: &str) -> Result<Option<String>, StorageError> {
    Ok(transaction
        .query_row("SELECT value FROM meta WHERE key = ?1", [key], |row| {
            row.get(0)
        })
        .optional()?)
}

fn validate_registered_attachment(attachment: &RegisteredAttachment) -> Result<(), StorageError> {
    crate::models::validate_identifier(&attachment.id, "attachment.id")?;
    if attachment.name.is_empty()
        || attachment.name.len() > 1024
        || attachment
            .name
            .chars()
            .any(|value| value.is_control() || value == '/' || value == '\\' || value == '\0')
    {
        return Err(StorageError::Invalid("附件名称不合法".to_string()));
    }
    if attachment.mime_type.len() > 256
        || attachment.mime_type.chars().any(|value| value.is_control())
    {
        return Err(StorageError::Invalid("附件 MIME 类型不合法".to_string()));
    }
    if attachment.kind != "image" && attachment.kind != "file" {
        return Err(StorageError::Invalid("附件类型不合法".to_string()));
    }
    if attachment.kind == "image"
        && !attachment
            .mime_type
            .to_ascii_lowercase()
            .starts_with("image/")
    {
        return Err(StorageError::Invalid(
            "图片附件的 MIME 类型不合法".to_string(),
        ));
    }
    if attachment.byte_size == 0 || attachment.byte_size > i64::MAX as u64 {
        return Err(StorageError::Invalid("附件大小不合法".to_string()));
    }
    if attachment.sha256.len() != 64
        || attachment.sha256 != attachment.sha256.to_ascii_lowercase()
        || !attachment
            .sha256
            .chars()
            .all(|value| value.is_ascii_hexdigit())
    {
        return Err(StorageError::Invalid("附件 hash 不合法".to_string()));
    }
    if attachment.relative_path.is_empty()
        || !attachment.relative_path.starts_with("attachments/")
        || attachment.relative_path.contains('\\')
        || attachment.relative_path.contains(':')
        || attachment
            .relative_path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(StorageError::PathDenied(
            "附件相对路径不在受控目录内".to_string(),
        ));
    }
    crate::security::validate_archive_path(&attachment.relative_path, false)
        .map_err(|error| StorageError::PathDenied(error.to_string()))?;
    if attachment.created_at.is_empty()
        || attachment
            .created_at
            .chars()
            .any(|value| value.is_control())
    {
        return Err(StorageError::Invalid("附件创建时间不合法".to_string()));
    }
    if attachment
        .width
        .is_some_and(|value| !(1..=100_000).contains(&value))
        || attachment
            .height
            .is_some_and(|value| !(1..=100_000).contains(&value))
    {
        return Err(StorageError::Invalid("附件尺寸不合法".to_string()));
    }
    Ok(())
}

fn next_sort_order(transaction: &Transaction<'_>, table: &str) -> Result<i64, StorageError> {
    // The table name is selected internally and never comes from IPC.
    let query = match table {
        "events" => "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM events",
        "stages" => "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM stages",
        _ => return Err(StorageError::Invalid("内部排序表名错误".to_string())),
    };
    Ok(transaction.query_row(query, [], |row| row.get(0))?)
}

fn collect_ids(transaction: &Transaction<'_>, table: &str) -> Result<Vec<String>, StorageError> {
    let query = match table {
        "events" => "SELECT id FROM events",
        "stages" => "SELECT id FROM stages",
        _ => return Err(StorageError::Invalid("内部 ID 表名错误".to_string())),
    };
    let mut statement = transaction.prepare(query)?;
    let rows = statement.query_map([], |row| row.get(0))?;
    Ok(rows.collect::<Result<Vec<String>, _>>()?)
}

fn upsert_stage_tx(
    transaction: &Transaction<'_>,
    stage: &LifeStage,
    revision: u64,
    sort_order: i64,
    now: &str,
) -> Result<(), StorageError> {
    let created_at: String = transaction
        .query_row(
            "SELECT created_at FROM stages WHERE id = ?1",
            [&stage.id],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or_else(|| now.to_string());
    transaction.execute(
        "INSERT INTO stages(
            id, name, stage_type, start_date, start_display, start_precision,
            end_date, end_display, end_precision, is_ongoing, description,
            sort_order, revision, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
         ON CONFLICT(id) DO UPDATE SET
            name=excluded.name, stage_type=excluded.stage_type,
            start_date=excluded.start_date, start_display=excluded.start_display,
            start_precision=excluded.start_precision, end_date=excluded.end_date,
            end_display=excluded.end_display, end_precision=excluded.end_precision,
            is_ongoing=excluded.is_ongoing, description=excluded.description,
            sort_order=excluded.sort_order, revision=excluded.revision, updated_at=excluded.updated_at",
        params![
            stage.id, stage.name, stage.stage_type, stage.start_date,
            stage.start_display, stage.start_precision, stage.end_date,
            stage.end_display, stage.end_precision, stage.is_ongoing as i64,
            stage.description, sort_order, revision as i64, created_at, now,
        ],
    )?;
    Ok(())
}

fn upsert_event_tx(
    transaction: &Transaction<'_>,
    event: &LifeEvent,
    attachment_ids: &std::collections::BTreeSet<String>,
    revision: u64,
    sort_order: i64,
    now: &str,
) -> Result<(), StorageError> {
    let created_at: String = transaction
        .query_row(
            "SELECT created_at FROM events WHERE id = ?1",
            [&event.id],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or_else(|| now.to_string());
    let rich_content = event
        .rich_content
        .as_ref()
        .map(serde_json::to_string)
        .transpose()?;
    let attachment_json =
        serde_json::to_string(&attachment_ids.iter().cloned().collect::<Vec<_>>())?;
    transaction.execute(
        "INSERT INTO events(
            id, record_type, title, date, display_date, date_precision, stage_id,
            importance, summary, content, rich_content, attachment_ids, sort_order,
            revision, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
         ON CONFLICT(id) DO UPDATE SET
            record_type=excluded.record_type, title=excluded.title, date=excluded.date,
            display_date=excluded.display_date, date_precision=excluded.date_precision,
            stage_id=excluded.stage_id, importance=excluded.importance,
            summary=excluded.summary, content=excluded.content,
            rich_content=excluded.rich_content, attachment_ids=excluded.attachment_ids,
            sort_order=excluded.sort_order, revision=excluded.revision, updated_at=excluded.updated_at",
        params![
            event.id, event.record_type, event.title, event.date, event.display_date,
            event.date_precision, event.stage_id, event.importance, event.summary,
            event.content, rich_content, attachment_json, sort_order, revision as i64,
            created_at, now,
        ],
    ).map_err(|error| {
        if let rusqlite::Error::SqliteFailure(_, Some(message)) = &error {
            if message.to_ascii_lowercase().contains("unique") {
                return StorageError::Conflict("同一天已经存在一篇 Daily 记录".to_string());
            }
        }
        StorageError::Database(error)
    })?;
    transaction.execute(
        "DELETE FROM event_attachments WHERE event_id = ?1",
        [&event.id],
    )?;
    for (position, attachment_id) in attachment_ids.iter().enumerate() {
        transaction.execute(
            "INSERT INTO event_attachments(event_id, attachment_id, position) VALUES (?1, ?2, ?3)",
            params![event.id, attachment_id, position as i64],
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    fn test_stage(id: &str) -> LifeStage {
        LifeStage {
            id: id.to_string(),
            name: "测试阶段".to_string(),
            stage_type: "ongoing".to_string(),
            start_date: "2024-01-01".to_string(),
            start_display: "2024-01-01".to_string(),
            start_precision: "day".to_string(),
            end_date: None,
            end_display: None,
            end_precision: None,
            is_ongoing: true,
            description: Some("用于持久化测试".to_string()),
        }
    }

    fn test_event(id: &str, date: &str, stage_id: Option<&str>) -> LifeEvent {
        LifeEvent {
            id: id.to_string(),
            title: "测试记录".to_string(),
            record_type: "event".to_string(),
            date: date.to_string(),
            display_date: date.to_string(),
            date_precision: "day".to_string(),
            stage_id: stage_id.map(str::to_string),
            importance: 3,
            summary: "摘要".to_string(),
            content: "正文".to_string(),
            rich_content: None,
            attachment_ids: Vec::new(),
        }
    }

    #[test]
    fn repository_starts_empty_without_mock_data() {
        let directory = TempDir::new().unwrap();
        let repository = Repository::open(directory.path()).unwrap();
        let snapshot = repository.load_snapshot().unwrap();
        assert!(snapshot.events.is_empty());
        assert!(snapshot.stages.is_empty());
        assert!(!snapshot.meta.initialized);
    }

    #[test]
    fn snapshot_survives_close_and_reopen() {
        let directory = TempDir::new().unwrap();
        let stage = test_stage("stage-test");
        let event = test_event("event-test", "2024-01-02", Some("stage-test"));

        {
            let mut repository = Repository::open(directory.path()).unwrap();
            let ack = repository
                .save_snapshot(
                    std::slice::from_ref(&event),
                    std::slice::from_ref(&stage),
                    &json!({"theme": "dark", "displayMode": "timeline"}),
                    1,
                )
                .unwrap();
            assert_eq!(ack.revision, 1);
            repository.checkpoint_full().unwrap();
        }

        let repository = Repository::open(directory.path()).unwrap();
        let snapshot = repository.load_snapshot().unwrap();
        assert_eq!(repository.snapshot_revision().unwrap(), 1);
        assert_eq!(snapshot.events.len(), 1);
        assert_eq!(snapshot.events[0].id, "event-test");
        assert_eq!(snapshot.stages[0].id, "stage-test");
        assert_eq!(snapshot.preferences["theme"], "dark");
        assert!(snapshot.meta.initialized);
    }

    #[test]
    fn invalid_snapshot_does_not_replace_existing_data() {
        let directory = TempDir::new().unwrap();
        let stage = test_stage("stage-existing");
        let original = test_event("event-existing", "2024-01-03", Some("stage-existing"));
        let mut repository = Repository::open(directory.path()).unwrap();
        repository
            .save_snapshot(
                std::slice::from_ref(&original),
                std::slice::from_ref(&stage),
                &json!({"theme": "light"}),
                1,
            )
            .unwrap();

        // This fails during complete pre-transaction validation.  The old
        // rows and their preferences must remain intact after the failed
        // request; callers may safely retry with corrected editor data.
        let invalid = test_event("event-new", "2024-01-04", Some("missing-stage"));
        assert!(repository
            .save_snapshot(
                std::slice::from_ref(&invalid),
                std::slice::from_ref(&stage),
                &json!({"theme": "dark"}),
                2,
            )
            .is_err());

        let snapshot = repository.load_snapshot().unwrap();
        assert_eq!(snapshot.events.len(), 1);
        assert_eq!(snapshot.events[0].id, original.id);
        assert_eq!(snapshot.preferences["theme"], "light");
        assert_eq!(repository.snapshot_revision().unwrap(), 1);
    }

    #[test]
    fn sqlite_failure_during_restore_rolls_back_deleted_rows() {
        let directory = TempDir::new().unwrap();
        let original_stage = test_stage("stage-before-restore");
        let original_event = test_event(
            "event-before-restore",
            "2024-01-03",
            Some("stage-before-restore"),
        );
        let replacement_stage = test_stage("stage-after-restore");
        let replacement_event = test_event(
            "event-after-restore",
            "2024-01-04",
            Some("stage-after-restore"),
        );
        let mut repository = Repository::open(directory.path()).unwrap();
        repository
            .save_snapshot(
                std::slice::from_ref(&original_event),
                std::slice::from_ref(&original_stage),
                &json!({"theme": "light"}),
                1,
            )
            .unwrap();

        // Force a real SQL error after restore_snapshot has deleted the old
        // rows.  SQLite must roll the entire transaction back, including the
        // deletes, instead of leaving a half-restored library.
        repository
            .connection
            .execute_batch(
                "CREATE TRIGGER test_restore_abort BEFORE INSERT ON stages
                 BEGIN SELECT RAISE(ABORT, 'intentional restore test failure'); END;",
            )
            .unwrap();
        assert!(repository
            .restore_snapshot(
                std::slice::from_ref(&replacement_event),
                std::slice::from_ref(&replacement_stage),
                &json!({"theme": "dark"}),
                Vec::new(),
            )
            .is_err());

        let snapshot = repository.load_snapshot().unwrap();
        assert_eq!(snapshot.events.len(), 1);
        assert_eq!(snapshot.events[0].id, original_event.id);
        assert_eq!(snapshot.stages[0].id, original_stage.id);
        assert_eq!(snapshot.preferences["theme"], "light");
        assert_eq!(repository.snapshot_revision().unwrap(), 1);
    }
}
