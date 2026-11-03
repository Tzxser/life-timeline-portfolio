//! Native diary-transfer contract tests, using real SQLite databases and ZIPs.
//!
//! Every fixture lives in its own temporary directory. No installed application,
//! personal diary database, release artifact or network resource is involved.

use super::*;
use crate::diary_transfer::*;
use crate::models::{AppSnapshot, AttachmentMeta};

struct Library {
    // Close SQLite before TempDir attempts to remove its files on Windows.
    state: AppState,
    _directory: tempfile::TempDir,
}

impl Library {
    fn new() -> Self {
        let directory = tempfile::Builder::new()
            .prefix("life-timeline-diary-transfer-")
            .tempdir()
            .expect("isolated test directory");
        let state =
            AppState::open(directory.path().to_path_buf()).expect("isolated SQLite library");
        Self {
            state,
            _directory: directory,
        }
    }

    fn snapshot(&self) -> AppSnapshot {
        self.state
            .repository
            .lock()
            .expect("repository lock")
            .load_snapshot()
            .expect("snapshot")
    }

    fn fingerprint(&self) -> (u64, Value) {
        let repository = self.state.repository.lock().expect("repository lock");
        (
            repository.snapshot_revision().expect("revision"),
            serde_json::to_value(repository.load_snapshot().expect("snapshot"))
                .expect("snapshot JSON"),
        )
    }

    fn save(&self, events: &[LifeEvent], stages: &[LifeStage], preferences: &Value) {
        let mut repository = self.state.repository.lock().expect("repository lock");
        let revision = repository.snapshot_revision().expect("revision") + 1;
        repository
            .save_snapshot(events, stages, preferences, revision)
            .expect("persist synthetic fixture");
    }

    fn export(&self, name: &str) -> PathBuf {
        let path = self.state.root.join(name);
        export_diaries(
            &self.state,
            DiaryExportRequest {
                destination_path: path.to_string_lossy().into_owned(),
                start_date: None,
                end_date: None,
                overwrite: false,
            },
        )
        .expect("export diary ZIP");
        path
    }
}

fn diary(id: &str, date: &str, text: &str) -> LifeEvent {
    LifeEvent {
        id: id.into(),
        title: format!("{date} 日记"),
        record_type: "daily".into(),
        date: date.into(),
        display_date: date.into(),
        date_precision: "day".into(),
        stage_id: None,
        importance: 3,
        summary: format!("{text} 摘要"),
        content: text.into(),
        rich_content: Some(rich(vec![paragraph(text)])),
        attachment_ids: Vec::new(),
    }
}

fn stage(id: &str, name: &str) -> LifeStage {
    LifeStage {
        id: id.into(),
        name: name.into(),
        stage_type: "ongoing".into(),
        start_date: "2026-01-01".into(),
        start_display: "2026-01-01".into(),
        start_precision: "day".into(),
        end_date: None,
        end_display: None,
        end_precision: None,
        is_ongoing: true,
        description: Some("合成测试阶段".into()),
    }
}

fn paragraph(text: &str) -> Value {
    json!({"type":"paragraph","content":[{"type":"text","text":text}]})
}

fn rich(content: Vec<Value>) -> Value {
    json!({"version":1,"format":"tiptap-json","doc":{"type":"doc","content":content}})
}

fn attachment(
    library: &Library,
    id: &str,
    name: &str,
    mime_type: &str,
    bytes: &[u8],
) -> AttachmentMeta {
    let hash = format!("{:x}", Sha256::digest(bytes));
    let relative = format!("attachments/{}/{hash}.bin", &hash[..2]);
    let physical = attachment_service::controlled_path(&library.state.root, &relative)
        .expect("controlled fixture path");
    fs::create_dir_all(physical.parent().expect("attachment parent")).expect("attachment bucket");
    fs::write(&physical, bytes).expect("physical attachment bytes");
    let image = mime_type.starts_with("image/");
    let record = RegisteredAttachment {
        id: id.into(),
        sha256: hash,
        name: name.into(),
        mime_type: mime_type.into(),
        byte_size: bytes.len() as u64,
        kind: if image { "image" } else { "file" }.into(),
        width: image.then_some(1),
        height: image.then_some(1),
        last_modified: Some(1_790_812_800_000),
        relative_path: relative,
        created_at: "2026-10-01T00:00:00Z".into(),
    };
    let mut repository = library.state.repository.lock().expect("repository lock");
    repository
        .register_attachment(&record)
        .expect("fixture attachment registration");
    repository
        .attachment(id)
        .expect("fixture metadata lookup")
        .expect("fixture metadata exists")
        .meta
}

fn image_node(meta: &AttachmentMeta, layout: &str, width: u32) -> Value {
    json!({
        "type":"lifeImage",
        "attrs":{
            "attachmentId":meta.id,"name":meta.name,"layout":layout,
            "width":width,"caption":"留在日记旁边的照片",
            "naturalWidth":meta.width,"naturalHeight":meta.height
        }
    })
}

fn file_node(meta: &AttachmentMeta) -> Value {
    json!({
        "type":"lifeAttachment",
        "attrs":{
            "attachmentId":meta.id,"name":meta.name,"mimeType":meta.mime_type,
            "byteSize":meta.byte_size,"note":"保留附件说明"
        }
    })
}

fn scan(library: &Library, archive: &Path) -> DiaryScanResult {
    scan_diaries(
        &library.state,
        DiaryScanRequest {
            archive_path: archive.to_string_lossy().into_owned(),
        },
    )
    .expect("scan valid diary ZIP")
}

fn decision(date: &str, action: DiaryAction) -> DiaryDecision {
    DiaryDecision {
        date: date.into(),
        action,
    }
}

fn apply(library: &Library, archive: &Path, decisions: Vec<DiaryDecision>) -> DiaryImportResult {
    let preview = scan(library, archive);
    import_diaries(
        &library.state,
        DiaryImportRequest {
            schedule_decisions: Vec::new(),
            archive_path: archive.to_string_lossy().into_owned(),
            scan_token: preview.scan_token,
            decisions,
        },
    )
    .expect("apply validated diary import")
}

fn members(path: &Path) -> Vec<(String, Vec<u8>)> {
    let mut zip = ZipArchive::new(File::open(path).expect("ZIP file")).expect("ZIP directory");
    (0..zip.len())
        .map(|index| {
            let mut member = zip.by_index(index).expect("ZIP member");
            let name = member.name().to_string();
            let mut bytes = Vec::new();
            member.read_to_end(&mut bytes).expect("ZIP member bytes");
            (name, bytes)
        })
        .collect()
}

fn write_members(path: &Path, members: &[(String, Vec<u8>)]) {
    let mut zip = ZipWriter::new(File::create(path).expect("rewrite fixture ZIP"));
    for (name, bytes) in members {
        write_zip_file(&mut zip, name, bytes).expect("write ZIP member");
    }
    zip.finish().expect("finish fixture ZIP");
}

fn read_json_member(path: &Path, name: &str) -> Value {
    let archive = members(path);
    let bytes = &archive
        .iter()
        .find(|(entry, _)| entry == name)
        .expect("JSON member exists")
        .1;
    serde_json::from_slice(bytes).expect("JSON member")
}

fn file_inventory(root: &Path) -> HashMap<PathBuf, (u64, String)> {
    fn collect(root: &Path, directory: &Path, inventory: &mut HashMap<PathBuf, (u64, String)>) {
        for entry in fs::read_dir(directory).expect("fixture directory") {
            let entry = entry.expect("fixture directory entry");
            let kind = entry.file_type().expect("fixture file type");
            if kind.is_dir() {
                collect(root, &entry.path(), inventory);
            } else {
                assert!(kind.is_file(), "test fixture should not contain links");
                inventory.insert(
                    entry.path().strip_prefix(root).unwrap().to_path_buf(),
                    sha256_file(&entry.path()).expect("fixture file hash"),
                );
            }
        }
    }
    let mut inventory = HashMap::new();
    collect(root, root, &mut inventory);
    inventory
}

/// Rebuild hashes and counts after a semantic mutation, so the scanner must
/// reject the actual invalid record instead of merely a stale ZIP digest.
fn rewrite_life(path: &Path, change: impl FnOnce(&mut Value)) {
    let mut archive = members(path);
    let mut life = read_json_member(path, "life.json");
    let mut manifest = read_json_member(path, "manifest.json");
    change(&mut life);
    let life_bytes = serde_json::to_vec_pretty(&life).expect("modified life JSON");
    archive
        .iter_mut()
        .find(|(name, _)| name == "life.json")
        .expect("life member")
        .1 = life_bytes;
    manifest["files"] = Value::Array(
        archive
            .iter()
            .filter(|(name, _)| name != "manifest.json")
            .map(|(name, bytes)| {
                json!({
                    "path":name,"byteSize":bytes.len(),
                    "sha256":format!("{:x}",Sha256::digest(bytes))
                })
            })
            .collect(),
    );
    for key in ["events", "stages", "attachments"] {
        manifest["counts"][key] = json!(life[key].as_array().expect("record array").len());
    }
    archive
        .iter_mut()
        .find(|(name, _)| name == "manifest.json")
        .expect("manifest member")
        .1 = serde_json::to_vec_pretty(&manifest).expect("modified manifest JSON");
    write_members(path, &archive);
}

fn attachment_normalized_document(event: &LifeEvent, snapshot: &AppSnapshot) -> Value {
    let ids: HashMap<&str, &str> = snapshot
        .attachments
        .iter()
        .map(|record| {
            (
                record.meta.id.as_str(),
                record.meta.sha256.as_deref().expect("attachment SHA"),
            )
        })
        .collect();
    fn visit(value: &mut Value, ids: &HashMap<&str, &str>) {
        match value {
            Value::Object(object) => {
                for (key, value) in object {
                    if key == "attachmentId" || key == "imageId" {
                        if let Some(id) = value.as_str() {
                            *value = json!(ids.get(id).expect("rich attachment is registered"));
                        }
                    } else {
                        visit(value, ids);
                    }
                }
            }
            Value::Array(values) => values.iter_mut().for_each(|value| visit(value, ids)),
            _ => {}
        }
    }
    let mut document = event.rich_content.clone().expect("rich diary document");
    visit(&mut document, &ids);
    document
}

#[test]
fn diary_round_trip_keeps_rich_layout_media_and_destination_preferences() {
    let source = Library::new();
    let target = Library::new();
    // A one-pixel PNG plus opaque video/document payloads. Native transfer must
    // preserve bytes; playback and editor rendering are separate UI tests.
    let png = b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x04\x00\x00\x00\xb5\x1c\x0c\x02\x00\x00\x00\x0bIDAT\x78\xda\x63\xfc\xff\x1f\x00\x03\x03\x02\x00\xef\xa3\x8f\x5b\x00\x00\x00\x00IEND\xae\x42\x60\x82";
    let photo = attachment(&source, "photo", "春日.png", "image/png", png);
    let video = attachment(
        &source,
        "video",
        "片段.mp4",
        "video/mp4",
        b"synthetic video bytes",
    );
    let file = attachment(
        &source,
        "file",
        "随笔.pdf",
        "application/pdf",
        b"%PDF-1.4 synthetic",
    );
    let source_stage = stage("source-stage", "迁入阶段");
    let mut incoming = diary("source-daily", "2026-10-01", "照片与文字共同保存");
    incoming.stage_id = Some(source_stage.id.clone());
    incoming.rich_content = Some(rich(vec![
        json!({"type":"paragraph","content":[{"type":"text","text":"原来的标题","marks":[{"type":"bold"}]}]}),
        json!({"type":"paragraph","content":[{"type":"text","text":"关联右边的照片","marks":[{"type":"bold"},{"type":"imageLink","attrs":{"imageId":photo.id}}]}]}),
        image_node(&photo, "margin-right", 42),
        json!({"type":"bulletList","content":[{"type":"listItem","content":[paragraph("列表和顺序保留")]}]}),
        file_node(&video),
        file_node(&file),
    ]));
    source.save(
        &[incoming],
        &[source_stage],
        &json!({"privateSourceSetting":"never exported"}),
    );
    let mut local_event = diary("local-event", "2026-08-01", "本地人生节点");
    local_event.record_type = "event".into();
    let preferences = json!({"theme":"dark","eyeCareMinutes":75});
    target.save(std::slice::from_ref(&local_event), &[], &preferences);
    let before_source = source.snapshot();
    let archive = source.export("round-trip.zip");
    let life = read_json_member(&archive, "life.json");
    assert!(life
        .get("preferences")
        .is_none_or(|value| value.as_object().is_some_and(|map| map.is_empty())));
    assert!(!serde_json::to_string(&life)
        .unwrap()
        .contains("never exported"));
    let result = apply(&target, &archive, vec![]);
    assert_eq!(result.added, 1);
    assert_eq!(result.attachment_count, 3);
    let after = target.snapshot();
    let imported = after
        .events
        .iter()
        .find(|event| event.record_type == "daily")
        .expect("imported diary");
    assert_eq!(imported.title, before_source.events[0].title);
    assert_eq!(imported.content, before_source.events[0].content);
    assert_eq!(imported.summary, before_source.events[0].summary);
    assert_eq!(imported.importance, before_source.events[0].importance);
    assert_eq!(
        attachment_normalized_document(imported, &after),
        attachment_normalized_document(&before_source.events[0], &before_source)
    );
    assert_eq!(after.preferences, preferences);
    assert_eq!(
        serde_json::to_value(
            after
                .events
                .iter()
                .find(|event| event.id == local_event.id)
                .expect("local event")
        )
        .unwrap(),
        serde_json::to_value(local_event).unwrap()
    );
    assert!(after
        .stages
        .iter()
        .any(|item| Some(&item.id) == imported.stage_id.as_ref() && item.name == "迁入阶段"));
    for original in &before_source.attachments {
        let restored = after
            .attachments
            .iter()
            .find(|item| item.meta.name == original.meta.name)
            .expect("attachment metadata preserved");
        assert_eq!(restored.meta.sha256, original.meta.sha256);
        assert_eq!(restored.meta.mime_type, original.meta.mime_type);
        assert_eq!(restored.meta.byte_size, original.meta.byte_size);
        assert_eq!(restored.meta.width, original.meta.width);
        assert_eq!(restored.meta.height, original.meta.height);
        assert_eq!(
            fs::read(
                target
                    .state
                    .root
                    .join(restored.meta.relative_path.as_ref().unwrap())
            )
            .unwrap(),
            fs::read(
                source
                    .state
                    .root
                    .join(original.meta.relative_path.as_ref().unwrap())
            )
            .unwrap()
        );
    }
}

#[test]
fn diary_export_range_is_inclusive_and_omits_events_unused_stages_and_orphan_files() {
    let source = Library::new();
    let chosen = attachment(
        &source,
        "chosen",
        "selected.txt",
        "text/plain",
        b"selected attachment",
    );
    let orphan = attachment(
        &source,
        "orphan",
        "private.txt",
        "text/plain",
        b"unreferenced attachment",
    );
    let mut entries: Vec<_> = [
        "2026-09-30",
        "2026-10-01",
        "2026-10-02",
        "2026-10-03",
        "2026-10-04",
    ]
    .iter()
    .enumerate()
    .map(|(index, date)| diary(&format!("daily-{index}"), date, "日期范围测试"))
    .collect();
    entries[1].rich_content = Some(rich(vec![file_node(&chosen)]));
    let mut milestone = diary("milestone", "2026-10-02", "人生节点不属于日记包");
    milestone.record_type = "event".into();
    milestone.attachment_ids = vec![orphan.id.clone()];
    entries.push(milestone);
    source.save(
        &entries,
        &[stage("unreferenced-stage", "不属于导出范围")],
        &json!({"theme":"dark"}),
    );
    let path = source.state.root.join("range.zip");
    let result = export_diaries(
        &source.state,
        DiaryExportRequest {
            destination_path: path.to_string_lossy().into_owned(),
            start_date: Some("2026-10-01".into()),
            end_date: Some("2026-10-03".into()),
            overwrite: false,
        },
    )
    .expect("date-range export");
    assert_eq!(result.diary_count, 3);
    assert_eq!(result.attachment_count, 1);
    let (life, _, counts) = scan_zip_inner(&path, true).expect("valid diary archive structure");
    let dates: Vec<_> = life["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|event| event["date"].as_str().unwrap())
        .collect();
    assert_eq!(dates, ["2026-10-01", "2026-10-02", "2026-10-03"]);
    assert_eq!(counts.events, 3);
    assert_eq!(counts.stages, 0);
    assert_eq!(counts.attachments, 1);
    assert!(life["events"]
        .as_array()
        .unwrap()
        .iter()
        .all(|event| event["type"] == "daily"));
    assert_eq!(life["attachments"][0]["id"], chosen.id);
    assert!(!members(&path)
        .iter()
        .any(|(name, _)| Some(name) == orphan.relative_path.as_ref()));
    assert!(export_diaries(
        &source.state,
        DiaryExportRequest {
            destination_path: source
                .state
                .root
                .join("invalid-range.zip")
                .to_string_lossy()
                .into_owned(),
            start_date: Some("2026-10-03".into()),
            end_date: Some("2026-10-01".into()),
            overwrite: false,
        }
    )
    .is_err());
}

#[test]
fn diary_import_remaps_colliding_event_stage_and_attachment_ids_without_changing_local_records() {
    let source = Library::new();
    let target = Library::new();
    let incoming_photo = attachment(
        &source,
        "same-attachment",
        "incoming.png",
        "image/png",
        b"new photo bytes",
    );
    let local_photo = attachment(
        &target,
        "same-attachment",
        "local.png",
        "image/png",
        b"original local photo",
    );
    let incoming_stage = stage("same-stage", "来源阶段");
    let local_stage = stage("same-stage", "本地阶段");
    let mut incoming = diary("same-event", "2026-10-01", "来源日记");
    incoming.stage_id = Some(incoming_stage.id.clone());
    incoming.rich_content = Some(rich(vec![
        image_node(&incoming_photo, "wrap-left", 37),
        json!({"type":"paragraph","content":[{"type":"text","text":"定位图片","marks":[{"type":"imageLink","attrs":{"imageId":incoming_photo.id}}]}]}),
    ]));
    let mut local = diary("same-event", "2026-01-01", "本地人生节点");
    local.record_type = "event".into();
    local.stage_id = Some(local_stage.id.clone());
    local.rich_content = Some(rich(vec![image_node(&local_photo, "block", 80)]));
    source.save(&[incoming], &[incoming_stage], &json!({}));
    target.save(
        &[local],
        &[local_stage],
        &json!({"localPreference":"retained"}),
    );
    let source_before = source.snapshot();
    let target_before = target.snapshot();
    let archive = source.export("collision.zip");
    assert_eq!(apply(&target, &archive, vec![]).added, 1);
    let after = target.snapshot();
    let imported = after
        .events
        .iter()
        .find(|event| event.record_type == "daily")
        .unwrap();
    assert_ne!(imported.id, "same-event");
    assert_ne!(imported.stage_id.as_deref(), Some("same-stage"));
    assert!(after
        .stages
        .iter()
        .any(|item| item.name == "来源阶段" && Some(&item.id) == imported.stage_id.as_ref()));
    assert_eq!(
        attachment_normalized_document(imported, &after),
        attachment_normalized_document(&source_before.events[0], &source_before)
    );
    assert!(
        !models::derive_attachment_ids(imported.rich_content.as_ref().unwrap())
            .contains("same-attachment")
    );
    assert_eq!(
        serde_json::to_value(
            after
                .events
                .iter()
                .find(|event| event.id == "same-event")
                .unwrap()
        )
        .unwrap(),
        serde_json::to_value(&target_before.events[0]).unwrap()
    );
    assert_eq!(
        serde_json::to_value(
            after
                .stages
                .iter()
                .find(|item| item.id == "same-stage")
                .unwrap()
        )
        .unwrap(),
        serde_json::to_value(&target_before.stages[0]).unwrap()
    );
    assert_eq!(after.preferences, target_before.preferences);
    let preserved = after
        .attachments
        .iter()
        .find(|item| item.meta.id == "same-attachment")
        .unwrap();
    assert_eq!(preserved.meta.sha256, local_photo.sha256);
    assert_eq!(
        fs::read(
            target
                .state
                .root
                .join(preserved.meta.relative_path.as_ref().unwrap())
        )
        .unwrap(),
        b"original local photo"
    );
}

#[test]
fn diary_conflicts_require_explicit_decisions_before_any_database_mutation() {
    let source = Library::new();
    let target = Library::new();
    source.save(
        &[
            diary("incoming", "2026-10-01", "冲突日记"),
            diary("new-date", "2026-10-02", "新的日记"),
        ],
        &[],
        &json!({}),
    );
    target.save(
        &[diary("local", "2026-10-01", "已有正文")],
        &[],
        &json!({"theme":"light"}),
    );
    let archive = source.export("needs-decisions.zip");
    let before = target.fingerprint();
    let preview = scan(&target, &archive);
    assert!(import_diaries(
        &target.state,
        DiaryImportRequest {
            schedule_decisions: Vec::new(),
            archive_path: archive.to_string_lossy().into_owned(),
            scan_token: preview.scan_token,
            decisions: vec![],
        }
    )
    .is_err());
    assert_eq!(
        target.fingerprint(),
        before,
        "a new-date row must not be partially imported before conflict resolution"
    );
    for decisions in [
        vec![
            decision("2026-10-01", DiaryAction::Merge),
            decision("2026-10-01", DiaryAction::Replace),
        ],
        vec![
            decision("2026-10-01", DiaryAction::Merge),
            decision("2025-01-01", DiaryAction::Skip),
        ],
    ] {
        let preview = scan(&target, &archive);
        assert!(
            import_diaries(
                &target.state,
                DiaryImportRequest {
                    schedule_decisions: Vec::new(),
                    archive_path: archive.to_string_lossy().into_owned(),
                    scan_token: preview.scan_token,
                    decisions,
                }
            )
            .is_err(),
            "ambiguous or unrelated decisions must be rejected"
        );
        assert_eq!(target.fingerprint(), before);
    }
}

#[test]
fn diary_merge_preserves_local_identity_and_puts_local_content_before_incoming_content() {
    let source = Library::new();
    let target = Library::new();
    let incoming_stage = stage("incoming-stage", "来源阶段");
    let local_stage = stage("local-stage", "本地阶段");
    let mut incoming = diary("incoming", "2026-10-01", "INCOMING unique block");
    incoming.stage_id = Some(incoming_stage.id.clone());
    let mut local = diary("local-identity", "2026-10-01", "LOCAL original block");
    local.title = "我自己起的名字".into();
    local.stage_id = Some(local_stage.id.clone());
    source.save(&[incoming], &[incoming_stage], &json!({}));
    target.save(
        std::slice::from_ref(&local),
        &[local_stage],
        &json!({"theme":"dark"}),
    );
    let before = target.fingerprint();
    let archive = source.export("merge.zip");
    let result = apply(
        &target,
        &archive,
        vec![decision("2026-10-01", DiaryAction::Merge)],
    );
    assert_eq!(result.merged, 1);
    assert_eq!(result.added, 0);
    assert!(result.revision > before.0);
    let after = target.snapshot();
    assert_eq!(after.events.len(), 1);
    let merged = &after.events[0];
    assert_eq!(merged.id, local.id);
    assert_eq!(merged.title, local.title);
    assert_eq!(merged.stage_id, local.stage_id);
    assert!(
        merged.content.find("LOCAL original block").unwrap()
            < merged.content.find("INCOMING unique block").unwrap()
    );
    let document = serde_json::to_string(merged.rich_content.as_ref().unwrap()).unwrap();
    assert!(
        document.find("LOCAL original block").unwrap()
            < document.find("INCOMING unique block").unwrap()
    );
    let result_json = serde_json::to_value(result).unwrap();
    let backup = PathBuf::from(
        result_json["previousLibraryBackupPath"]
            .as_str()
            .expect("automatic pre-import backup"),
    );
    assert!(backup.is_file());
    let (previous, _, _) =
        scan_zip(&backup).expect("pre-import backup remains a complete restorable archive");
    assert_eq!(previous["events"][0]["content"], local.content);
    assert_eq!(previous["events"][0]["title"], local.title);
    assert_eq!(previous["preferences"], json!({"theme":"dark"}));
    let once = serde_json::to_value(&after.events).unwrap();
    apply(
        &target,
        &archive,
        vec![decision("2026-10-01", DiaryAction::Merge)],
    );
    assert_eq!(
        serde_json::to_value(target.snapshot().events).unwrap(),
        once,
        "repeating the same merge must not append its source paragraphs again"
    );
}

#[test]
fn diary_replace_keeps_the_local_record_id_and_uses_the_incoming_document() {
    let source = Library::new();
    let target = Library::new();
    let photo = attachment(
        &source,
        "replacement-photo",
        "替换.png",
        "image/png",
        b"replacement picture",
    );
    let mut incoming = diary("incoming-id", "2026-10-01", "新的正文");
    incoming.title = "来源的标题".into();
    incoming.importance = 5;
    incoming.rich_content = Some(rich(vec![
        paragraph("新的正文"),
        image_node(&photo, "margin-left", 63),
    ]));
    source.save(&[incoming], &[], &json!({"theme":"light"}));
    target.save(
        &[diary("keep-local-id", "2026-10-01", "被替换的正文")],
        &[],
        &json!({"theme":"dark"}),
    );
    let original = source.snapshot();
    let archive = source.export("replace.zip");
    let result = apply(
        &target,
        &archive,
        vec![decision("2026-10-01", DiaryAction::Replace)],
    );
    assert_eq!(result.replaced, 1);
    let after = target.snapshot();
    assert_eq!(after.events.len(), 1);
    assert_eq!(after.events[0].id, "keep-local-id");
    assert_eq!(after.events[0].title, original.events[0].title);
    assert_eq!(after.events[0].content, original.events[0].content);
    assert_eq!(after.events[0].importance, original.events[0].importance);
    assert_eq!(
        attachment_normalized_document(&after.events[0], &after),
        attachment_normalized_document(&original.events[0], &original)
    );
    assert_eq!(after.preferences, json!({"theme":"dark"}));
}

#[test]
fn diary_skip_and_identical_reimport_do_not_duplicate_documents_or_attachment_rows() {
    let source = Library::new();
    let target = Library::new();
    let photo = attachment(
        &source,
        "photo",
        "photo.png",
        "image/png",
        b"same image bytes",
    );
    let mut incoming = diary("same-id", "2026-10-01", "同一份日记");
    incoming.rich_content = Some(rich(vec![
        paragraph("同一份日记"),
        image_node(&photo, "wrap-right", 35),
    ]));
    source.save(&[incoming], &[], &json!({}));
    let archive = source.export("repeat.zip");
    apply(&target, &archive, vec![]);
    let original = target.fingerprint();
    let skipped = apply(
        &target,
        &archive,
        vec![decision("2026-10-01", DiaryAction::Skip)],
    );
    assert_eq!(skipped.skipped, 1);
    assert_eq!(target.fingerprint(), original);
    apply(
        &target,
        &archive,
        vec![decision("2026-10-01", DiaryAction::Merge)],
    );
    assert_eq!(
        target.fingerprint(),
        original,
        "an identical diary is a no-op, including attachment metadata and revision"
    );
    assert_eq!(target.snapshot().attachments.len(), 1);
}

#[test]
fn diary_mixed_resolutions_apply_together_and_copy_only_attachments_for_selected_days() {
    let source = Library::new();
    let target = Library::new();
    let selected = attachment(
        &source,
        "selected",
        "chosen.txt",
        "text/plain",
        b"included bytes",
    );
    let excluded = attachment(
        &source,
        "skipped",
        "skip-only.txt",
        "text/plain",
        b"skipped private bytes",
    );
    let mut incoming: Vec<_> = (1..=4)
        .map(|day| {
            diary(
                &format!("incoming-{day}"),
                &format!("2026-10-{day:02}"),
                &format!("INCOMING {day}"),
            )
        })
        .collect();
    incoming[0].rich_content = Some(rich(vec![paragraph("INCOMING 1"), file_node(&selected)]));
    incoming[3].rich_content = Some(rich(vec![paragraph("INCOMING 4"), file_node(&selected)]));
    incoming[2].rich_content = Some(rich(vec![paragraph("INCOMING 3"), file_node(&excluded)]));
    incoming[2].stage_id = Some("skipped-stage".into());
    source.save(
        &incoming,
        &[stage("skipped-stage", "跳过日记的阶段")],
        &json!({}),
    );
    let mut local: Vec<_> = (1..=3)
        .map(|day| {
            diary(
                &format!("local-{day}"),
                &format!("2026-10-{day:02}"),
                &format!("LOCAL {day}"),
            )
        })
        .collect();
    let mut event = diary("life-node", "2026-10-01", "人生节点单独保留");
    event.record_type = "event".into();
    local.push(event.clone());
    let preferences = json!({"theme":"dark","splash":false});
    target.save(&local, &[], &preferences);
    let before = target.snapshot();
    let archive = source.export("mixed.zip");
    let preview = scan(&target, &archive);
    assert_eq!(preview.diary_count, 4);
    assert_eq!(preview.new_count, 1);
    assert_eq!(preview.conflicts.len(), 3);
    let result = import_diaries(
        &target.state,
        DiaryImportRequest {
            schedule_decisions: Vec::new(),
            archive_path: archive.to_string_lossy().into_owned(),
            scan_token: preview.scan_token,
            decisions: vec![
                decision("2026-10-01", DiaryAction::Merge),
                decision("2026-10-02", DiaryAction::Replace),
                decision("2026-10-03", DiaryAction::Skip),
            ],
        },
    )
    .expect("one import with mixed user choices");
    assert_eq!(
        (result.added, result.merged, result.replaced, result.skipped),
        (1, 1, 1, 1)
    );
    assert_eq!(
        result.attachment_count, 1,
        "one shared attachment used by two imported days is registered once"
    );
    let after = target.snapshot();
    assert_eq!(after.events.len(), 5);
    assert_eq!(after.attachments.len(), 1);
    assert_eq!(after.attachments[0].meta.sha256, selected.sha256);
    assert!(
        after.stages.is_empty(),
        "skipped incoming stages must not be copied"
    );
    let merged = after
        .events
        .iter()
        .find(|entry| entry.id == "local-1")
        .unwrap();
    assert!(merged.content.contains("LOCAL 1"));
    assert!(merged.content.contains("INCOMING 1"));
    let replaced = after
        .events
        .iter()
        .find(|entry| entry.id == "local-2")
        .unwrap();
    assert_eq!(replaced.content, "INCOMING 2");
    let skipped = after
        .events
        .iter()
        .find(|entry| entry.id == "local-3")
        .unwrap();
    assert_eq!(
        serde_json::to_value(skipped).unwrap(),
        serde_json::to_value(
            before
                .events
                .iter()
                .find(|entry| entry.id == "local-3")
                .unwrap()
        )
        .unwrap()
    );
    assert_eq!(
        serde_json::to_value(
            after
                .events
                .iter()
                .find(|entry| entry.id == "life-node")
                .unwrap()
        )
        .unwrap(),
        serde_json::to_value(&event).unwrap()
    );
    assert_eq!(after.preferences, preferences);
    let added = after
        .events
        .iter()
        .find(|entry| entry.record_type == "daily" && entry.date == "2026-10-04")
        .unwrap();
    assert_eq!(added.content, "INCOMING 4");
    assert_eq!(
        models::derive_attachment_ids(added.rich_content.as_ref().unwrap()),
        models::derive_attachment_ids(merged.rich_content.as_ref().unwrap())
    );
    let backup = result
        .previous_library_backup_path
        .expect("one pre-import backup");
    let (backup_life, _, backup_counts) =
        scan_zip(Path::new(&backup)).expect("valid pre-import backup");
    assert_eq!(backup_counts.events, 4);
    assert_eq!(backup_life["preferences"], preferences);
    assert!(backup_life["events"]
        .as_array()
        .unwrap()
        .iter()
        .all(
            |entry| entry["content"].as_str().unwrap().starts_with("LOCAL")
                || entry["id"] == "life-node"
        ));
}

#[test]
fn diary_scan_rejects_zip_slip_and_modified_attachment_bytes_without_touching_the_target() {
    let source = Library::new();
    let target = Library::new();
    let photo = attachment(
        &source,
        "photo",
        "photo.png",
        "image/png",
        b"archive picture bytes",
    );
    let mut incoming = diary("incoming", "2026-10-01", "校验测试");
    incoming.rich_content = Some(rich(vec![image_node(&photo, "block", 100)]));
    source.save(&[incoming], &[], &json!({}));
    let archive = source.export("valid.zip");
    let before = target.fingerprint();
    let escape_name = format!("diary-test-escape-{}.txt", Uuid::new_v4());
    for malicious in [false, true] {
        let bad = source.state.root.join(if malicious {
            "zip-slip.zip"
        } else {
            "bad-hash.zip"
        });
        let mut contents = members(&archive);
        if malicious {
            contents.push((
                format!("../{escape_name}"),
                b"must never be extracted".to_vec(),
            ));
        } else {
            contents
                .iter_mut()
                .find(|(name, _)| name.starts_with("attachments/"))
                .unwrap()
                .1[0] ^= 0x7f;
        }
        write_members(&bad, &contents);
        assert!(scan_diaries(
            &target.state,
            DiaryScanRequest {
                archive_path: bad.to_string_lossy().into_owned()
            }
        )
        .is_err());
        assert_eq!(target.fingerprint(), before);
    }
    assert!(!source
        .state
        .root
        .parent()
        .unwrap()
        .join(escape_name)
        .exists());
}

#[test]
fn diary_scan_rejects_unknown_rich_nodes_marks_and_duplicate_natural_days_after_hash_validation() {
    let source = Library::new();
    let target = Library::new();
    source.save(
        &[diary("incoming", "2026-10-01", "结构校验")],
        &[],
        &json!({}),
    );
    let archive = source.export("valid-structure.zip");
    let before = target.fingerprint();
    for case in ["unknown-node", "unknown-mark", "duplicate-day"] {
        let path = source.state.root.join(format!("{case}.zip"));
        fs::copy(&archive, &path).unwrap();
        rewrite_life(&path, |life| match case {
            "unknown-node" => {
                life["events"][0]["richContent"] = rich(vec![
                    json!({"type":"futureUnsafeNode","attrs":{"html":"<script>never render</script>"}}),
                ])
            }
            "unknown-mark" => {
                life["events"][0]["richContent"] = rich(vec![
                    json!({"type":"paragraph","content":[{"type":"text","text":"x","marks":[{"type":"unrecognizedMark"}]}]}),
                ])
            }
            _ => {
                let mut duplicate = life["events"][0].clone();
                duplicate["id"] = json!("second-id-same-date");
                life["events"].as_array_mut().unwrap().push(duplicate);
            }
        });
        assert!(
            scan_diaries(
                &target.state,
                DiaryScanRequest {
                    archive_path: path.to_string_lossy().into_owned()
                }
            )
            .is_err(),
            "invalid diary structure was accepted: {case}"
        );
        assert_eq!(target.fingerprint(), before);
    }
}

#[test]
fn diary_scan_tokens_reject_changed_archives_changed_libraries_and_other_libraries() {
    let source = Library::new();
    source.save(
        &[diary("incoming", "2026-10-01", "扫描后的校验")],
        &[],
        &json!({}),
    );
    let archive = source.export("token-source.zip");
    for case in ["archive", "database", "different-library"] {
        let target = Library::new();
        let other = Library::new();
        let copied = source.state.root.join(format!("token-{case}.zip"));
        fs::copy(&archive, &copied).unwrap();
        let preview = scan(&target, &copied);
        if case == "archive" {
            rewrite_life(&copied, |life| {
                life["events"][0]["title"] = json!("扫描后被改变的标题")
            });
        } else if case == "database" {
            target.save(
                &[diary(
                    "local-added-after-scan",
                    "2026-09-30",
                    "扫描后新写的日记",
                )],
                &[],
                &json!({}),
            );
        }
        let destination = if case == "different-library" {
            &other
        } else {
            &target
        };
        let before = destination.fingerprint();
        assert!(
            import_diaries(
                &destination.state,
                DiaryImportRequest {
                    schedule_decisions: Vec::new(),
                    archive_path: copied.to_string_lossy().into_owned(),
                    scan_token: preview.scan_token,
                    decisions: vec![],
                }
            )
            .is_err(),
            "stale or foreign scan token must be rejected: {case}"
        );
        assert_eq!(destination.fingerprint(), before);
    }
}

#[test]
fn diary_zip_cannot_be_used_as_a_complete_library_backup_by_current_or_old_readers() {
    let source = Library::new();
    source.save(
        &[diary("daily", "2026-10-01", "局部日记包")],
        &[],
        &json!({"localSetting":"not shared"}),
    );
    let archive = source.export("diaries-only.zip");
    let manifest = read_json_member(&archive, "manifest.json");
    assert_eq!(manifest["archiveFormatVersion"], 2);
    assert_eq!(manifest["purpose"], "diary-transfer");
    assert_eq!(manifest["diaryFormatVersion"], 1);
    assert!(scan_zip_inner(&archive, true).is_ok());
    assert!(
        scan_zip(&archive).is_err(),
        "full-library restore must not accept a subset diary archive"
    );
    // Previously shipped backup scanners only accepted archiveFormatVersion 1.
    // The incompatible marker makes old installed builds fail closed as well.
    assert_ne!(manifest["archiveFormatVersion"].as_u64(), Some(1));
}

#[test]
fn diary_import_rejects_a_corrupted_existing_blob_without_replacing_local_bytes_or_rows() {
    let source = Library::new();
    let target = Library::new();
    let original = b"shared expected picture bytes";
    let incoming_photo = attachment(
        &source,
        "incoming-photo",
        "source.png",
        "image/png",
        original,
    );
    let existing_photo = attachment(&target, "local-photo", "local.png", "image/png", original);
    let mut incoming = diary("incoming", "2026-10-01", "需要已有附件的导入");
    incoming.rich_content = Some(rich(vec![image_node(&incoming_photo, "margin-left", 50)]));
    source.save(&[incoming], &[], &json!({}));
    let mut local = diary("local", "2026-09-30", "现有日记保持不变");
    local.rich_content = Some(rich(vec![image_node(&existing_photo, "block", 100)]));
    target.save(&[local], &[], &json!({"theme":"dark"}));
    let archive = source.export("shared-blob.zip");
    let preview = scan(&target, &archive);
    let physical = target
        .state
        .root
        .join(existing_photo.relative_path.as_ref().unwrap());
    fs::write(&physical, b"locally corrupted bytes").unwrap();
    let before = target.fingerprint();
    assert!(import_diaries(
        &target.state,
        DiaryImportRequest {
            schedule_decisions: Vec::new(),
            archive_path: archive.to_string_lossy().into_owned(),
            scan_token: preview.scan_token,
            decisions: vec![],
        }
    )
    .is_err());
    assert_eq!(target.fingerprint(), before);
    assert_eq!(fs::read(&physical).unwrap(), b"locally corrupted bytes");
}

#[test]
fn diary_sql_transaction_failure_rolls_back_rows_cleans_published_blobs_and_retains_backup() {
    let source = Library::new();
    let target = Library::new();
    let incoming_photo = attachment(
        &source,
        "incoming-photo",
        "incoming.png",
        "image/png",
        b"new blob must be cleaned after SQL abort",
    );
    let original_photo = attachment(
        &target,
        "original-photo",
        "original.png",
        "image/png",
        b"original blob must survive rollback",
    );
    let incoming_file = attachment(
        &source,
        "incoming-file",
        "incoming.txt",
        "text/plain",
        b"second newly copied attachment must also roll back",
    );
    let incoming_stage = stage("triggered-incoming-stage", "触发事务失败的来源阶段");
    let local_stage = stage("original-stage", "原有阶段");
    let mut incoming = diary("incoming", "2026-10-02", "这一篇不能部分写入");
    incoming.stage_id = Some(incoming_stage.id.clone());
    incoming.rich_content = Some(rich(vec![
        image_node(&incoming_photo, "margin-left", 50),
        file_node(&incoming_file),
    ]));
    let mut original = diary("original", "2026-10-01", "原来的正文必须保留");
    original.stage_id = Some(local_stage.id.clone());
    original.rich_content = Some(rich(vec![image_node(&original_photo, "margin-right", 45)]));
    source.save(&[incoming], &[incoming_stage], &json!({}));
    target.save(&[original], &[local_stage], &json!({"theme":"dark"}));
    let archive = source.export("sql-abort.zip");
    let original_source_files = file_inventory(&source.state.root.join("attachments"));
    let original_archive_hash = sha256_file(&archive).unwrap();
    let preview = scan(&target, &archive);
    let before = target.fingerprint();
    let original_files = file_inventory(&target.state.root.join("attachments"));
    let new_blob = target
        .state
        .root
        .join(incoming_photo.relative_path.as_ref().unwrap());
    assert!(!new_blob.exists());

    // Use an independent real SQLite connection, rather than a mocked
    // repository error. The unique ABORT message proves import reached its
    // restore transaction, which starts after physical blob publication.
    let database_path = target
        .state
        .repository
        .lock()
        .expect("repository lock")
        .database_path()
        .to_path_buf();
    let injector =
        rusqlite::Connection::open(database_path).expect("independent SQLite connection");
    injector
        .execute_batch(
            "CREATE TRIGGER fail_diary_stage_insert
             BEFORE INSERT ON stages
             WHEN NEW.id = 'triggered-incoming-stage'
             BEGIN
               SELECT RAISE(ABORT, 'diary-transfer injected SQL abort');
             END;",
        )
        .expect("install deterministic transaction failure");
    drop(injector);

    let failure = import_diaries(
        &target.state,
        DiaryImportRequest {
            schedule_decisions: Vec::new(),
            archive_path: archive.to_string_lossy().into_owned(),
            scan_token: preview.scan_token,
            decisions: vec![],
        },
    )
    .expect_err("the real SQLite trigger must abort the import transaction");
    assert_eq!(failure.code, "storage.database");
    assert!(failure
        .message
        .contains("diary-transfer injected SQL abort"));
    assert_eq!(
        target.fingerprint(),
        before,
        "all rows, revision and data epoch must roll back"
    );
    assert!(
        !new_blob.exists(),
        "a newly published, unreferenced blob must be removed"
    );
    assert!(
        !target
            .state
            .root
            .join(incoming_file.relative_path.as_ref().unwrap())
            .exists(),
        "rollback must remove both independently copied attachments"
    );
    assert_eq!(
        file_inventory(&source.state.root.join("attachments")),
        original_source_files
    );
    assert_eq!(sha256_file(&archive).unwrap(), original_archive_hash);
    assert_eq!(
        file_inventory(&target.state.root.join("attachments")),
        original_files
    );
    assert_eq!(
        fs::read(
            target
                .state
                .root
                .join(original_photo.relative_path.as_ref().unwrap())
        )
        .unwrap(),
        b"original blob must survive rollback"
    );
    assert!(
        fs::read_dir(target.state.root.join("staging"))
            .unwrap()
            .next()
            .is_none(),
        "failed import must leave no staging copy"
    );
    assert!(
        fs::read_dir(target.state.root.join("recovery"))
            .unwrap()
            .next()
            .is_none(),
        "successful rollback cleanup must consume its recovery marker"
    );
    let backups: Vec<_> = fs::read_dir(target.state.root.join("backups"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("pre-diary-import-")
        })
        .collect();
    assert_eq!(
        backups.len(),
        1,
        "the pre-import backup is retained after a failed transaction"
    );
    let (previous, _, counts) =
        scan_zip(&backups[0]).expect("rollback backup can be restored normally");
    assert_eq!(counts.events, 1);
    assert_eq!(counts.stages, 1);
    assert_eq!(counts.attachments, 1);
    assert_eq!(previous["events"], before.1["events"]);
    assert_eq!(previous["stages"], before.1["stages"]);
    assert_eq!(previous["preferences"], before.1["preferences"]);
}

#[test]
fn diary_scan_fingerprint_rejects_preference_and_attachment_writes_without_a_revision_bump() {
    let source = Library::new();
    source.save(
        &[diary("incoming", "2026-10-02", "不能使用过期预览导入")],
        &[],
        &json!({}),
    );
    let archive = source.export("non-revision-writes.zip");
    for change in ["preferences", "attachments"] {
        let target = Library::new();
        target.save(
            &[diary("local", "2026-10-01", "扫描时已有的正文")],
            &[],
            &json!({"theme":"light"}),
        );
        let before_scan = target.fingerprint();
        let preview = scan(&target, &archive);
        if change == "preferences" {
            target
                .state
                .repository
                .lock()
                .unwrap()
                .save_preferences(&json!({"theme":"dark"}))
                .expect("native preference-only write");
        } else {
            attachment(
                &target,
                "added-after-scan",
                "new.txt",
                "text/plain",
                b"new attachment registered after scan",
            );
        }
        let after_change = target.fingerprint();
        assert_eq!(
            after_change.0, before_scan.0,
            "fixture must leave snapshotRevision unchanged: {change}"
        );
        assert_ne!(
            after_change.1, before_scan.1,
            "fixture must change the stored snapshot: {change}"
        );
        let attachment_files = file_inventory(&target.state.root.join("attachments"));
        let backup_files = file_inventory(&target.state.root.join("backups"));
        let failure = import_diaries(
            &target.state,
            DiaryImportRequest {
                schedule_decisions: Vec::new(),
                archive_path: archive.to_string_lossy().into_owned(),
                scan_token: preview.scan_token,
                decisions: vec![],
            },
        )
        .expect_err("snapshot fingerprint must reject non-revision writes");
        assert_eq!(
            failure.code, "diary.scan_stale",
            "the content fingerprint must reject this preview: {change}"
        );
        assert_eq!(
            target.fingerprint(),
            after_change,
            "the newer local write must be preserved: {change}"
        );
        assert_eq!(
            file_inventory(&target.state.root.join("attachments")),
            attachment_files
        );
        assert_eq!(
            file_inventory(&target.state.root.join("backups")),
            backup_files,
            "stale previews must be rejected before making a restore backup"
        );
        assert!(fs::read_dir(target.state.root.join("staging"))
            .unwrap()
            .next()
            .is_none());
    }
}
