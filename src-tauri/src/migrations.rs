//! SQLite schema migrations. Migrations are idempotent and run inside a
//! transaction before the connection is exposed to any command.

use crate::models::{StorageError, SCHEMA_VERSION};
use rusqlite::{Connection, OptionalExtension, Transaction};

pub fn migrate(connection: &mut Connection) -> Result<(), StorageError> {
    connection.execute_batch("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;")?;
    let version: u32 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version > SCHEMA_VERSION {
        return Err(StorageError::UnsupportedVersion(format!(
            "数据库 schema {version} 高于应用支持的 {SCHEMA_VERSION}"
        )));
    }
    if version == 0 {
        let transaction = connection.transaction()?;
        create_v1(&transaction)?;
        transaction.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        transaction.commit()?;
    }
    // Future migrations must follow the same pattern: version checks, a single
    // transaction, and a user_version bump only after every statement succeeds.
    Ok(())
}

fn create_v1(tx: &Transaction<'_>) -> Result<(), StorageError> {
    tx.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY NOT NULL,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS stages (
            id TEXT PRIMARY KEY NOT NULL,
            name TEXT NOT NULL,
            stage_type TEXT NOT NULL CHECK(stage_type IN ('range', 'ongoing')),
            start_date TEXT NOT NULL,
            start_display TEXT NOT NULL,
            start_precision TEXT NOT NULL,
            end_date TEXT,
            end_display TEXT,
            end_precision TEXT,
            is_ongoing INTEGER NOT NULL CHECK(is_ongoing IN (0, 1)),
            description TEXT,
            sort_order INTEGER NOT NULL DEFAULT 0,
            revision INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS events (
            id TEXT PRIMARY KEY NOT NULL,
            record_type TEXT NOT NULL DEFAULT 'event' CHECK(record_type IN ('event', 'daily')),
            title TEXT NOT NULL,
            date TEXT NOT NULL,
            display_date TEXT NOT NULL,
            date_precision TEXT NOT NULL,
            stage_id TEXT REFERENCES stages(id) ON DELETE SET NULL,
            importance INTEGER NOT NULL CHECK(importance BETWEEN 1 AND 5),
            summary TEXT NOT NULL DEFAULT '',
            content TEXT NOT NULL DEFAULT '',
            rich_content TEXT,
            attachment_ids TEXT NOT NULL DEFAULT '[]',
            sort_order INTEGER NOT NULL DEFAULT 0,
            revision INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS events_daily_date_unique
          ON events(date) WHERE record_type = 'daily';
        CREATE INDEX IF NOT EXISTS events_date_order_idx
          ON events(date, sort_order, id);
        CREATE TABLE IF NOT EXISTS attachment_blobs (
            sha256 TEXT PRIMARY KEY NOT NULL,
            relative_path TEXT NOT NULL UNIQUE,
            byte_size INTEGER NOT NULL CHECK(byte_size > 0),
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS attachments (
            id TEXT PRIMARY KEY NOT NULL,
            sha256 TEXT NOT NULL REFERENCES attachment_blobs(sha256) ON DELETE RESTRICT,
            name TEXT NOT NULL,
            mime_type TEXT NOT NULL,
            byte_size INTEGER NOT NULL CHECK(byte_size > 0),
            kind TEXT NOT NULL CHECK(kind IN ('image', 'file')),
            width INTEGER,
            height INTEGER,
            last_modified INTEGER,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS attachments_sha_idx ON attachments(sha256);
        CREATE TABLE IF NOT EXISTS event_attachments (
            event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
            attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE RESTRICT,
            position INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(event_id, attachment_id)
        );
        CREATE INDEX IF NOT EXISTS event_attachments_attachment_idx ON event_attachments(attachment_id);
        CREATE TABLE IF NOT EXISTS preferences (
            key TEXT PRIMARY KEY NOT NULL,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        INSERT OR IGNORE INTO meta(key, value) VALUES
          ('schemaVersion', '1'),
          ('initialized', '0'),
          ('dataEpoch', '1'),
          ('snapshotRevision', '0');
        INSERT OR IGNORE INTO preferences(key, value, updated_at)
          VALUES ('settings', '{}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
        "#,
    )?;
    Ok(())
}

pub fn read_meta(connection: &Connection, key: &str) -> Result<Option<String>, StorageError> {
    Ok(connection
        .query_row("SELECT value FROM meta WHERE key = ?1", [key], |row| {
            row.get(0)
        })
        .optional()?)
}

pub fn write_meta(connection: &Connection, key: &str, value: &str) -> Result<(), StorageError> {
    connection.execute("INSERT INTO meta(key, value) VALUES(?1, ?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn creates_schema_in_memory() {
        let mut connection = Connection::open_in_memory().unwrap();
        migrate(&mut connection).unwrap();
        let version: u32 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, 1);
        assert_eq!(
            read_meta(&connection, "initialized").unwrap().as_deref(),
            Some("0")
        );
    }
}
