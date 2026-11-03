//! Real repository/ZIP coverage for schedule identity, conflicts and single undo.
use super::*;
use crate::diary_transfer::{
    export_diaries, import_diaries, scan_diaries, DiaryAction, DiaryDecision, DiaryExportRequest,
    DiaryImportRequest, DiaryScanRequest,
};
use crate::schedules::{ScheduleDecision, LIBRARY, UNDO};

fn source(id: &str, version: &str, location: &str) -> Value {
    json!({"id":id,"name":"合成学期","version":version,"updatedAt":"2026-10-16T00:00:00Z","device":"合成电脑","weekOne":"2026-08-31","startDate":"2026-08-31","endDate":"2027-01-03","entries":[{"id":"math","title":"合成数学","weekday":5,"weeks":[7,8],"time":"1-2节","location":location,"notes":""}]})
}
fn card(id: &str, location: &str) -> Value {
    let grid = json!({"columns":[{"id":"title","label":"事项"},{"id":"location","label":"地点"}],"rows":[{"id":"math@2026-10-16","cells":{"title":"合成数学","location":location}}],"merges":[]});
    json!({"type":"lifeSchedule","attrs":{"card":{"id":id,"sourceId":"term","sourceName":"合成学期","sourceVersion":"v1","startDate":"2026-10-16","endDate":"2026-10-16","view":"list","layout":"bottom","base":grid,"local":grid}}})
}
fn event(nodes: Vec<Value>) -> LifeEvent {
    serde_json::from_value(json!({"id":"daily","type":"daily","title":"合成日记","date":"2026-10-16","displayDate":"2026-10-16","datePrecision":"day","stageId":null,"importance":3,"content":"保留普通日记","richContent":{"version":1,"format":"tiptap-json","doc":{"type":"doc","content":nodes}},"attachmentIds":[]})).unwrap()
}
fn save(state: &AppState, entries: &[LifeEvent], prefs: &Value) {
    let mut repo = state.repository.lock().unwrap();
    let revision = repo.snapshot_revision().unwrap() + 1;
    repo.save_snapshot(entries, &[], prefs, revision).unwrap();
}
fn export(state: &AppState, name: &str) -> String {
    let path = state.root.join(name).to_string_lossy().into_owned();
    export_diaries(
        state,
        DiaryExportRequest {
            destination_path: path.clone(),
            start_date: None,
            end_date: None,
            overwrite: false,
        },
    )
    .unwrap();
    path
}
#[test]
fn schedules_zip_roundtrip_conflicts_and_single_undo_are_atomic() {
    let a_dir = tempfile::tempdir().unwrap();
    let b_dir = tempfile::tempdir().unwrap();
    let a = AppState::open(a_dir.path().to_path_buf()).unwrap();
    let b = AppState::open(b_dir.path().to_path_buf()).unwrap();
    let prose = json!({"type":"paragraph","content":[{"type":"text","text":"保留普通日记"}]});
    save(
        &a,
        &[event(vec![
            prose.clone(),
            card("one", "A101"),
            card("two", "A101"),
        ])],
        &json!({LIBRARY:[source("term","v1","A101"),source("unrelated","u1","X")],"localSetting":"not-exported"}),
    );
    let archive = export(&a, "schedule-first.zip");
    let scan = scan_diaries(
        &b,
        DiaryScanRequest {
            archive_path: archive.clone(),
        },
    )
    .unwrap();
    assert!(scan.schedule_conflicts.is_empty());
    import_diaries(
        &b,
        DiaryImportRequest {
            archive_path: archive,
            scan_token: scan.scan_token,
            decisions: vec![],
            schedule_decisions: vec![],
        },
    )
    .unwrap();
    let loaded = b.repository.lock().unwrap().load_snapshot().unwrap();
    assert_eq!(loaded.preferences[LIBRARY].as_array().unwrap().len(), 1);
    assert!(loaded.preferences.get("localSetting").is_none());
    assert_eq!(crate::schedules::cards(&loaded.events).len(), 2);
    assert_eq!(
        loaded.preferences[UNDO]["cardIds"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let mut changed = card("one", "A101");
    changed["attrs"]["card"]["local"]["rows"][0]["cells"]["location"] = json!("手机修改");
    save(
        &b,
        &[event(vec![prose.clone(), changed, card("two", "A101")])],
        &json!({LIBRARY:[source("term","phone-v2","B202")],UNDO:loaded.preferences[UNDO],"localSetting":"phone-only"}),
    );
    save(
        &a,
        &[event(vec![
            prose.clone(),
            card("one", "电脑修改"),
            card("two", "A101"),
        ])],
        &json!({LIBRARY:[source("term","pc-v2","C303")],"localSetting":"pc-only"}),
    );
    let archive = export(&b, "schedule-return.zip");
    let scan = scan_diaries(
        &a,
        DiaryScanRequest {
            archive_path: archive.clone(),
        },
    )
    .unwrap();
    assert_eq!(scan.schedule_conflicts.len(), 2);
    let before =
        serde_json::to_value(a.repository.lock().unwrap().load_snapshot().unwrap()).unwrap();
    let bad = import_diaries(
        &a,
        DiaryImportRequest {
            archive_path: archive.clone(),
            scan_token: scan.scan_token.clone(),
            decisions: vec![DiaryDecision {
                date: "2026-10-16".into(),
                action: DiaryAction::Merge,
            }],
            schedule_decisions: vec![],
        },
    );
    assert!(bad.is_err());
    assert_eq!(
        before,
        serde_json::to_value(a.repository.lock().unwrap().load_snapshot().unwrap()).unwrap()
    );
    let choices = scan
        .schedule_conflicts
        .iter()
        .map(|c| ScheduleDecision {
            id: c.id.clone(),
            side: "incoming".into(),
        })
        .collect();
    import_diaries(
        &a,
        DiaryImportRequest {
            archive_path: archive,
            scan_token: scan.scan_token,
            decisions: vec![DiaryDecision {
                date: "2026-10-16".into(),
                action: DiaryAction::Merge,
            }],
            schedule_decisions: choices,
        },
    )
    .unwrap();
    let imported = a.repository.lock().unwrap().load_snapshot().unwrap();
    assert_eq!(imported.preferences[LIBRARY][0]["version"], "phone-v2");
    assert_eq!(imported.preferences["localSetting"], "pc-only");
    let cards = crate::schedules::cards(&imported.events);
    assert_eq!(cards.len(), 2);
    assert_eq!(
        cards[0]["node"]["attrs"]["card"]["local"]["rows"][0]["cells"]["location"],
        "手机修改"
    );
    assert_eq!(imported.preferences[UNDO]["before"][0]["version"], "pc-v2");
    assert_eq!(
        imported.preferences[UNDO]["after"][0]["version"],
        "phone-v2"
    );
    assert!(imported.preferences[UNDO].get("previousUndo").is_none());
    // Re-importing identical material preserves the existing one-step undo.
    let repeated = export(&b, "same-again.zip");
    let scan = scan_diaries(
        &a,
        DiaryScanRequest {
            archive_path: repeated.clone(),
        },
    )
    .unwrap();
    assert!(scan.schedule_conflicts.is_empty());
    import_diaries(
        &a,
        DiaryImportRequest {
            archive_path: repeated,
            scan_token: scan.scan_token,
            decisions: vec![DiaryDecision {
                date: "2026-10-16".into(),
                action: DiaryAction::Merge,
            }],
            schedule_decisions: vec![],
        },
    )
    .unwrap();
    assert_eq!(
        a.repository
            .lock()
            .unwrap()
            .load_snapshot()
            .unwrap()
            .preferences[UNDO],
        imported.preferences[UNDO]
    );
}
#[test]
fn schedules_invalid_card_or_library_cannot_be_saved() {
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::open(dir.path().to_path_buf()).unwrap();
    let mut bad = card("one", "A101");
    bad["attrs"]["card"]["startDate"] = json!("2026-02-31");
    assert!(state
        .repository
        .lock()
        .unwrap()
        .save_snapshot(&[event(vec![bad])], &[], &json!({}), 1)
        .is_err());
    let mut bad = source("term", "v1", "A101");
    bad["entries"][0]["weekday"] = json!(9);
    assert!(state
        .repository
        .lock()
        .unwrap()
        .save_snapshot(&[], &[], &json!({LIBRARY:[bad]}), 1)
        .is_err());
    assert!(state
        .repository
        .lock()
        .unwrap()
        .load_snapshot()
        .unwrap()
        .events
        .is_empty());
}
