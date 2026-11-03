//! Offline preparation for assisted diary import. Nothing in this module can
//! contact a provider or mutate the user's library. Original source text and
//! media are retained locally; only explicit SourceImage previews are suitable
//! for an independently authorised vision request.

use crate::models::CommandError;
use crate::security;
use base64::Engine;
use chrono::NaiveDate;
use image::{ImageDecoder, ImageReader};
use pulldown_cmark::{html, Options, Parser};
use scraper::{ElementRef, Html, Node};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use uuid::Uuid;
use zip::ZipArchive;

const MAX_PATHS: usize = 256;
const MAX_ENTRIES: usize = 4096;
const MAX_TEXT_BYTES: u64 = 4 * 1024 * 1024;
const MAX_TOTAL_TEXT: usize = 16 * 1024 * 1024;
const MAX_RENDERED_BODY: usize = 48 * 1024 * 1024;
const MAX_MEDIA_BYTES: u64 = 50 * 1024 * 1024;
const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 512 * 1024 * 1024;
const MAX_IMAGES: usize = 24;
const MAX_BLOCKS: usize = 12_000;
const MAX_HTML_NODES: usize = 100_000;
const MAX_DEPTH: usize = 48;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PreparedSource {
    pub source_label: String,
    pub blocks: Vec<SourceBlock>,
    pub attachments: Vec<Value>,
    pub images: Vec<SourceImage>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SourceBlock {
    pub id: String,
    pub source_name: String,
    pub suggested_date: Option<String>,
    pub plain_text: String,
    pub nodes: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SourceImage {
    /// The matching SourceBlock id. It is a stable reference for OCR output.
    pub id: String,
    pub source_name: String,
    pub mime_type: String,
    pub base64: String,
    pub attachment_id: String,
}

fn error(code: &str, message: impl Into<String>) -> CommandError {
    CommandError {
        code: code.into(),
        message: message.into(),
    }
}

fn io_error(_: std::io::Error) -> CommandError {
    error(
        "ai.source_io",
        "无法读取所选来源或写入本次暂存目录，请确认文件仍存在且可访问。",
    )
}

fn security_error(_: security::SecurityError) -> CommandError {
    error(
        "ai.source_path",
        "来源包含不安全的路径、符号链接或超出限制的文件，未进行导入。",
    )
}

fn extension(name: &str) -> String {
    Path::new(name)
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn text_source(name: &str) -> bool {
    matches!(
        extension(name).as_str(),
        "md" | "markdown" | "txt" | "html" | "htm" | "json"
    )
}

fn image_source(name: &str) -> bool {
    matches!(
        extension(name).as_str(),
        "jpg" | "jpeg" | "png" | "webp" | "gif" | "bmp" | "tif" | "tiff"
    )
}

fn leaf_name(name: &str) -> String {
    name.rsplit('/').next().unwrap_or(name).to_owned()
}

// ZIP entry order is not a reliable page order, and a lexical sort puts page
// 10 before page 2. Compare digit runs without parsing an unbounded integer.
fn natural_source_order(left: &str, right: &str) -> std::cmp::Ordering {
    let mut a = left.as_bytes();
    let mut b = right.as_bytes();
    while !a.is_empty() && !b.is_empty() {
        if a[0].is_ascii_digit() && b[0].is_ascii_digit() {
            let a_end = a
                .iter()
                .position(|c| !c.is_ascii_digit())
                .unwrap_or(a.len());
            let b_end = b
                .iter()
                .position(|c| !c.is_ascii_digit())
                .unwrap_or(b.len());
            let a_number = &a[..a_end];
            let b_number = &b[..b_end];
            let a_significant =
                &a_number[a_number.iter().position(|c| *c != b'0').unwrap_or(a_end)..];
            let b_significant =
                &b_number[b_number.iter().position(|c| *c != b'0').unwrap_or(b_end)..];
            let order = a_significant
                .len()
                .cmp(&b_significant.len())
                .then_with(|| a_significant.cmp(b_significant))
                .then_with(|| a_end.cmp(&b_end));
            if !order.is_eq() {
                return order;
            }
            a = &a[a_end..];
            b = &b[b_end..];
        } else {
            let order = a[0].to_ascii_lowercase().cmp(&b[0].to_ascii_lowercase());
            if !order.is_eq() {
                return order;
            }
            a = &a[1..];
            b = &b[1..];
        }
    }
    a.len().cmp(&b.len()).then_with(|| left.cmp(right))
}

fn visible_source(name: &str) -> bool {
    !name
        .split('/')
        .any(|part| part.starts_with('.') || part == "__MACOSX")
}

fn bounded_read(reader: &mut impl Read, limit: u64) -> Result<Vec<u8>, CommandError> {
    let mut out = Vec::new();
    security::copy_limited(reader, &mut out, limit)
        .map_err(|_| error("ai.source_limit", "来源文件超过本次导入的大小限制。"))?;
    Ok(out)
}

struct ZipSource {
    archive: ZipArchive<File>,
    entries: HashMap<String, (String, usize)>,
}

enum SourceFiles {
    Local { root: PathBuf },
    Zip(Box<ZipSource>),
}

impl SourceFiles {
    fn zip(path: &Path) -> Result<Self, CommandError> {
        let mut archive = ZipArchive::new(File::open(path).map_err(io_error)?).map_err(|_| {
            error(
                "ai.source_zip",
                "无法读取这个 ZIP 文件，请确认文件完整且未加密。",
            )
        })?;
        if archive.len() > MAX_ENTRIES {
            return Err(error(
                "ai.source_limit",
                "ZIP 条目过多，请分批导入（每次最多 4096 个条目）。",
            ));
        }
        let mut entries = HashMap::new();
        let mut seen = HashSet::new();
        let mut total = 0_u64;
        for index in 0..archive.len() {
            let entry = archive
                .by_index(index)
                .map_err(|_| error("ai.source_zip", "ZIP 内有无法读取或加密的条目。"))?;
            if security::zip_member_is_symlink(entry.unix_mode()) {
                return Err(error("ai.source_path", "ZIP 中包含符号链接，未进行导入。"));
            }
            let name = if entry.is_dir() {
                entry.name().trim_end_matches('/')
            } else {
                entry.name()
            };
            let normalized =
                security::validate_archive_path(name, false).map_err(security_error)?;
            if !seen.insert(normalized.to_lowercase()) {
                return Err(error(
                    "ai.source_path",
                    "ZIP 中有重名或大小写冲突的路径，无法确定应导入哪一个文件。",
                ));
            }
            total = total
                .checked_add(entry.size())
                .ok_or_else(|| error("ai.source_limit", "ZIP 大小超限。"))?;
            if total > MAX_TOTAL_BYTES
                || entry.size() > MAX_MEDIA_BYTES
                || (entry.size() > 1024 * 1024
                    && entry.size() / entry.compressed_size().max(1) > 200)
            {
                return Err(error(
                    "ai.source_limit",
                    "ZIP 解压大小或压缩比例超过限制，请拆分后导入。",
                ));
            }
            if !entry.is_dir() {
                entries.insert(normalized.to_lowercase(), (normalized, index));
            }
        }
        Ok(Self::Zip(Box::new(ZipSource { archive, entries })))
    }

    fn names(&self) -> Vec<String> {
        match self {
            Self::Zip(source) => {
                let mut names: Vec<_> = source
                    .entries
                    .values()
                    .map(|(name, _)| name.clone())
                    .collect();
                names.sort_by(|left, right| natural_source_order(left, right));
                names
            }
            Self::Local { .. } => Vec::new(),
        }
    }

    fn read(&mut self, name: &str, limit: u64) -> Result<Vec<u8>, CommandError> {
        match self {
            Self::Local { root } => {
                let path = root.join(name.replace('/', std::path::MAIN_SEPARATOR_STR));
                security::reject_symlink_components(&path).map_err(security_error)?;
                let canonical = fs::canonicalize(&path).map_err(io_error)?;
                if !canonical.starts_with(&*root) || !canonical.is_file() {
                    return Err(error("ai.source_path", "引用的附件不在所选文件的目录内。"));
                }
                bounded_read(&mut File::open(canonical).map_err(io_error)?, limit)
            }
            Self::Zip(source) => {
                let index = source
                    .entries
                    .get(&name.to_lowercase())
                    .ok_or_else(|| {
                        error(
                            "ai.source_missing",
                            format!("找不到引用的文件：{}", leaf_name(name)),
                        )
                    })?
                    .1;
                let mut entry = source
                    .archive
                    .by_index(index)
                    .map_err(|_| error("ai.source_zip", "无法读取 ZIP 内的引用文件。"))?;
                bounded_read(&mut entry, limit)
            }
        }
    }

    fn exists(&self, name: &str) -> bool {
        match self {
            Self::Local { root } => root
                .join(name.replace('/', std::path::MAIN_SEPARATOR_STR))
                .is_file(),
            Self::Zip(source) => source.entries.contains_key(&name.to_lowercase()),
        }
    }

    fn resolve(&self, document: &str, raw: &str) -> Result<String, CommandError> {
        let reference = decode_local_reference(raw)?;
        let parent = document.rsplit_once('/').map_or("", |(parent, _)| parent);
        let combined = if parent.is_empty() {
            reference.clone()
        } else {
            format!("{parent}/{reference}")
        };
        let normalized = normalize_reference(&combined)?;
        if self.exists(&normalized) {
            return Ok(normalized);
        }
        // Obsidian commonly records just a basename even when attachments live
        // in a subdirectory. A unique match is safe; ambiguous matches fail.
        if !reference.contains('/') {
            let mut found = match self {
                Self::Zip(source) => source
                    .entries
                    .values()
                    .filter(|(name, _)| leaf_name(name).eq_ignore_ascii_case(&reference))
                    .map(|(name, _)| name.clone())
                    .collect::<Vec<_>>(),
                Self::Local { root } => {
                    let mut result = Vec::new();
                    let mut count = 0;
                    search_basename(root, root, &reference, 0, &mut count, &mut result)?;
                    result
                }
            };
            found.sort();
            found.dedup();
            if found.len() == 1 {
                return Ok(found.remove(0));
            }
            if found.len() > 1 {
                return Err(error(
                    "ai.source_ambiguous",
                    format!(
                        "附件 {} 有多个同名文件，请在原文中写明相对目录。",
                        leaf_name(&reference)
                    ),
                ));
            }
        }
        Err(error(
            "ai.source_missing",
            format!(
                "找不到引用的附件 {}。请连同附件目录一起选择或打包。",
                leaf_name(&reference)
            ),
        ))
    }
}

fn search_basename(
    root: &Path,
    current: &Path,
    name: &str,
    depth: usize,
    count: &mut usize,
    found: &mut Vec<String>,
) -> Result<(), CommandError> {
    if depth > 8 {
        return Err(error(
            "ai.source_limit",
            "附件目录层级过深，请将日记和附件放在单独目录或 ZIP 后导入。",
        ));
    }
    for entry in fs::read_dir(current).map_err(io_error)? {
        let entry = entry.map_err(io_error)?;
        *count += 1;
        if *count > MAX_ENTRIES {
            return Err(error(
                "ai.source_limit",
                "附件查找范围过大，请将日记和附件打包到单独 ZIP。",
            ));
        }
        let filename = entry.file_name().to_string_lossy().into_owned();
        if filename.starts_with('.') {
            continue;
        }
        let path = entry.path();
        security::reject_symlink_components(&path).map_err(security_error)?;
        if entry.file_type().map_err(io_error)?.is_dir() {
            search_basename(root, &path, name, depth + 1, count, found)?;
        } else if filename.eq_ignore_ascii_case(name) {
            found.push(
                path.strip_prefix(root)
                    .map_err(|_| error("ai.source_path", "附件路径不在来源目录内。"))?
                    .to_string_lossy()
                    .replace('\\', "/"),
            );
        }
    }
    Ok(())
}

fn normalize_reference(raw: &str) -> Result<String, CommandError> {
    if raw.starts_with('/') || raw.starts_with('\\') || raw.contains(':') || raw.contains('\\') {
        return Err(error(
            "ai.source_path",
            "附件引用必须使用来源目录内的相对路径。",
        ));
    }
    let mut parts = Vec::new();
    for part in raw.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return Err(error("ai.source_path", "附件引用越过了来源目录。"));
                }
            }
            _ => parts.push(part),
        }
    }
    security::validate_archive_path(&parts.join("/"), false).map_err(security_error)
}

fn decode_local_reference(raw: &str) -> Result<String, CommandError> {
    let raw = raw.split(['#', '?']).next().unwrap_or(raw);
    let mut bytes = Vec::with_capacity(raw.len());
    let data = raw.as_bytes();
    let mut index = 0;
    while index < data.len() {
        if data[index] == b'%' {
            if index + 2 >= data.len() {
                return Err(error("ai.source_path", "附件路径的 URL 编码无效。"));
            }
            let hex = std::str::from_utf8(&data[index + 1..index + 3])
                .map_err(|_| error("ai.source_path", "附件路径编码无效。"))?;
            bytes.push(
                u8::from_str_radix(hex, 16)
                    .map_err(|_| error("ai.source_path", "附件路径编码无效。"))?,
            );
            index += 3;
        } else {
            bytes.push(data[index]);
            index += 1;
        }
    }
    String::from_utf8(bytes).map_err(|_| error("ai.source_path", "附件路径不是有效的 UTF-8。"))
}

fn external_reference(raw: &str) -> bool {
    raw.starts_with("//")
        || raw.find(':').is_some_and(|index| {
            let scheme = raw[..index].to_ascii_lowercase();
            index > 1
                && scheme
                    .bytes()
                    .all(|v| v.is_ascii_alphanumeric() || matches!(v, b'+' | b'-' | b'.'))
                && (raw[index + 1..].starts_with("//")
                    || [
                        "http",
                        "https",
                        "ftp",
                        "mailto",
                        "tel",
                        "data",
                        "javascript",
                        "file",
                        "obsidian",
                    ]
                    .contains(&scheme.as_str()))
        })
}

struct Preparation<'a> {
    session: &'a Path,
    result: PreparedSource,
    attachment_keys: HashMap<String, String>,
    total_media: u64,
    total_text: usize,
    rendered_body: usize,
}

impl Preparation<'_> {
    fn warn(&mut self, message: impl Into<String>) {
        let message = message.into();
        if !self.result.warnings.contains(&message) && self.result.warnings.len() < 100 {
            self.result.warnings.push(message);
        }
    }

    fn block(
        &mut self,
        source: &str,
        node: Value,
        date: Option<String>,
    ) -> Result<String, CommandError> {
        if self.result.blocks.len() >= MAX_BLOCKS {
            return Err(error("ai.source_limit", "正文段落过多，请分批导入。"));
        }
        let plain_text = node_text(&node);
        let rendered_bytes = serde_json::to_vec(&node)
            .map_err(|_| error("ai.source_content", "正文节点无法序列化。"))?
            .len();
        let next_size = self
            .rendered_body
            .saturating_add(rendered_bytes)
            .saturating_add(plain_text.len());
        if next_size > MAX_RENDERED_BODY {
            return Err(error(
                "ai.source_limit",
                "转换后的正文结构超过 48 MiB，请分批导入。",
            ));
        }
        self.rendered_body = next_size;
        let id = format!("block-{}", self.result.blocks.len() + 1);
        self.result.blocks.push(SourceBlock {
            id: id.clone(),
            // Local inputs supply a basename; ZIP inputs supply a validated
            // relative path. Preserve subfolders to distinguish two note.md
            // files without ever exposing the selected absolute disk path.
            source_name: source.to_owned(),
            suggested_date: date,
            plain_text,
            nodes: vec![node],
        });
        Ok(id)
    }

    fn decorate_block(
        &mut self,
        index: usize,
        node: Value,
        prepend: bool,
    ) -> Result<(), CommandError> {
        let text = node_text(&node);
        let rendered_bytes = serde_json::to_vec(&node)
            .map_err(|_| error("ai.source_content", "正文节点无法序列化。"))?
            .len();
        let next_size = self
            .rendered_body
            .saturating_add(rendered_bytes)
            .saturating_add(text.len())
            .saturating_add(1);
        if next_size > MAX_RENDERED_BODY {
            return Err(error(
                "ai.source_limit",
                "转换后的正文结构超过 48 MiB，请分批导入。",
            ));
        }
        let block = self
            .result
            .blocks
            .get_mut(index)
            .ok_or_else(|| error("ai.source_content", "日记正文分段不存在。"))?;
        if prepend {
            block.nodes.insert(0, node);
            if !text.is_empty() {
                block.plain_text = if block.plain_text.is_empty() {
                    text
                } else {
                    format!("{text}\n{}", block.plain_text)
                };
            }
        } else {
            block.nodes.push(node);
            if !text.is_empty() {
                if !block.plain_text.is_empty() {
                    block.plain_text.push('\n');
                }
                block.plain_text.push_str(&text);
            }
        }
        self.rendered_body = next_size;
        Ok(())
    }

    fn attach(
        &mut self,
        name: &str,
        bytes: &[u8],
        image_intent: bool,
    ) -> Result<Value, CommandError> {
        if bytes.is_empty() {
            return Err(error(
                "ai.source_empty_asset",
                format!("附件 {} 是空文件。", leaf_name(name)),
            ));
        }
        let ext = extension(name);
        if [
            "exe", "msi", "msp", "bat", "cmd", "com", "scr", "pif", "cpl", "ps1", "vbs", "vbe",
            "wsf", "wsh", "hta", "jar", "apk", "app",
        ]
        .contains(&ext.as_str())
        {
            return Err(error(
                "ai.source_executable",
                "来源引用了可执行文件，不能作为日记附件导入。",
            ));
        }
        let name = leaf_name(name);
        let sha = security::sha256_bytes(bytes);
        let key = format!("{sha}:{name}");
        if let Some(id) = self.attachment_keys.get(&key) {
            return self
                .result
                .attachments
                .iter()
                .find(|meta| meta["id"] == *id)
                .cloned()
                .ok_or_else(|| error("ai.source_internal", "附件索引无效。"));
        }
        if self.result.attachments.len() >= MAX_ENTRIES {
            return Err(error(
                "ai.source_limit",
                "一次导入最多包含 4096 个附件，请分批导入。",
            ));
        }
        self.total_media = self
            .total_media
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| error("ai.source_limit", "附件总大小超限。"))?;
        if self.total_media > MAX_TOTAL_BYTES {
            return Err(error(
                "ai.source_limit",
                "附件总大小超过 512 MiB，请分批导入。",
            ));
        }
        // WebView2 does not render TIFF images. Keep their originals as files;
        // standalone image sources also receive a separate visible JPEG preview.
        let image = image_intent && image_source(&name) && !matches!(ext.as_str(), "tif" | "tiff");
        let dimensions = if image {
            Some(image_dimensions(bytes)?)
        } else {
            None
        };
        if image_intent && ext == "svg" {
            self.warn("SVG 图片已保留为普通附件，不执行其中脚本，也不发送给 AI。可先转换为 PNG 以便显示。".to_owned());
        }
        let mime = mime_guess::from_path(&name)
            .first_or_octet_stream()
            .essence_str()
            .to_owned();
        let safe_ext =
            if !ext.is_empty() && ext.len() <= 12 && ext.bytes().all(|c| c.is_ascii_alphanumeric())
            {
                ext
            } else {
                "bin".into()
            };
        let relative = format!("attachments/{}/{sha}.{safe_ext}", &sha[..2]);
        let path = security::safe_join(self.session, &relative).map_err(security_error)?;
        security::reject_symlink_components(&path).map_err(security_error)?;
        fs::create_dir_all(
            path.parent()
                .ok_or_else(|| error("ai.source_path", "暂存附件路径无效。"))?,
        )
        .map_err(io_error)?;
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                file.write_all(bytes).map_err(io_error)?;
                file.sync_all().map_err(io_error)?;
            }
            Err(cause) if cause.kind() == std::io::ErrorKind::AlreadyExists => {
                let (size, hash) = security::sha256_file(&path).map_err(security_error)?;
                if size != bytes.len() as u64 || hash != sha {
                    return Err(error("ai.source_corrupt", "暂存附件校验失败。"));
                }
            }
            Err(cause) => return Err(io_error(cause)),
        }
        let id = format!("att-{}", Uuid::new_v4());
        let meta = json!({"id":id,"name":name,"mimeType":mime,"byteSize":bytes.len(),"kind":if image {"image"} else {"file"},"width":dimensions.map(|v|v.0),"height":dimensions.map(|v|v.1),"lastModified":null,"sha256":sha,"path":relative});
        self.attachment_keys.insert(key, id);
        self.result.attachments.push(meta.clone());
        Ok(meta)
    }

    fn document(&mut self, files: &mut SourceFiles, name: &str) -> Result<(), CommandError> {
        let bytes = files.read(name, MAX_TEXT_BYTES)?;
        let text = decode_text(&bytes)?;
        self.total_text += text.len();
        if self.total_text > MAX_TOTAL_TEXT {
            return Err(error(
                "ai.source_limit",
                "文字总量超过 16 MiB，请分批导入。",
            ));
        }
        match extension(name).as_str() {
            "json" => {
                let value = security::validate_json_bytes(
                    text.as_bytes(),
                    security::ArchiveLimits {
                        max_json_bytes: MAX_TEXT_BYTES,
                        max_json_depth: 48,
                        max_json_nodes: 100_000,
                        ..Default::default()
                    },
                )
                .map_err(|_| error("ai.source_json", "JSON 格式无效或嵌套过深。"))?;
                self.json_document(files, name, &value, None, 0)?;
            }
            "txt" => self.plain_document(name, &text, None)?,
            "html" | "htm" => self.html_document(files, name, &text, None)?,
            _ => self.markdown_document(files, name, &text, None)?,
        }
        Ok(())
    }

    fn plain_document(
        &mut self,
        name: &str,
        text: &str,
        date: Option<String>,
    ) -> Result<(), CommandError> {
        let mut current_date = date.or_else(|| filename_date(name));
        for section in text.replace("\r\n", "\n").split("\n\n") {
            if section.trim().is_empty() {
                continue;
            }
            let lines: Vec<_> = section.split('\n').collect();
            let mut start = 0;
            for (index, line) in lines.iter().enumerate() {
                if let Some(value) = date_heading(line.trim()) {
                    if index > start {
                        self.block(
                            name,
                            paragraph_text(&lines[start..index].join("\n")),
                            current_date.clone(),
                        )?;
                    }
                    start = index;
                    current_date = Some(value);
                }
            }
            // Split only at an explicit date header. All other lines retain
            // their original hard breaks, spaces and source order.
            self.block(
                name,
                paragraph_text(&lines[start..].join("\n")),
                current_date.clone(),
            )?;
        }
        Ok(())
    }

    fn markdown_document(
        &mut self,
        files: &mut SourceFiles,
        name: &str,
        text: &str,
        date: Option<String>,
    ) -> Result<(), CommandError> {
        let expanded = expand_obsidian(text);
        let parser = Parser::new_ext(
            &expanded,
            Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS,
        );
        let mut rendered = String::new();
        html::push_html(&mut rendered, parser);
        self.html_document(files, name, &rendered, date)
    }

    fn html_document(
        &mut self,
        files: &mut SourceFiles,
        name: &str,
        text: &str,
        date: Option<String>,
    ) -> Result<(), CommandError> {
        let document = Html::parse_fragment(text);
        if document.tree.nodes().count() > MAX_HTML_NODES {
            return Err(error("ai.source_limit", "HTML 节点过多，请拆分后导入。"));
        }
        let mut renderer = HtmlRenderer {
            preparation: self,
            files,
            name,
            date: date.or_else(|| filename_date(name)),
            nodes: Vec::new(),
            inline: Vec::new(),
        };
        renderer.children(document.root_element(), &[], 0)?;
        renderer.flush();
        for (node, date) in renderer.nodes {
            renderer.preparation.block(name, node, date)?;
        }
        Ok(())
    }

    fn json_document(
        &mut self,
        files: &mut SourceFiles,
        name: &str,
        value: &Value,
        inherited_date: Option<String>,
        depth: usize,
    ) -> Result<(), CommandError> {
        if depth > MAX_DEPTH {
            return Err(error("ai.source_limit", "JSON 嵌套过深。"));
        }
        if let Some(items) = value.as_array() {
            for item in items {
                self.json_document(files, name, item, inherited_date.clone(), depth + 1)?;
            }
            return Ok(());
        }
        if let Some(object) = value.as_object() {
            let explicit_date = ["date", "diaryDate", "entryDate"].iter().find_map(|key| {
                object
                    .get(*key)
                    .and_then(Value::as_str)
                    .and_then(suggested_date)
            });
            if explicit_date.is_none()
                && [
                    "createdAt",
                    "created",
                    "time",
                    "updatedAt",
                    "updated",
                    "timestamp",
                ]
                .iter()
                .any(|key| object.contains_key(*key))
            {
                self.warn("JSON 的创建、修改或导出时间已保留为原始信息，不直接当作日记发生日期；没有明确记录日期时，请在预览中补全。".to_owned());
            }
            let date = explicit_date.or(inherited_date.clone());
            let body_key = ["content", "text", "body", "markdown", "html"]
                .iter()
                .find(|key| object.get(**key).is_some_and(Value::is_string));
            if let Some(key) = body_key {
                let mut title = object
                    .get("title")
                    .and_then(Value::as_str)
                    .filter(|v| !v.is_empty())
                    .map(|title| json!({"type":"paragraph","content":[{"type":"text","text":title,"marks":[{"type":"bold"}]}]}));
                let first_body = self.result.blocks.len();
                let body = object[*key].as_str().unwrap_or_default();
                if *key == "html" {
                    self.html_document(files, name, body, date.clone())?;
                } else {
                    self.markdown_document(files, name, body, date.clone())?;
                }
                let extras: serde_json::Map<String, Value> = object
                    .iter()
                    .filter(|(k, _)| k.as_str() != *key && k.as_str() != "title")
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect();
                let mut trailing = if extras.is_empty() {
                    None
                } else {
                    self.warn(
                        "JSON 的额外字段作为原始文字保留在日记中；未将未知字段猜测为排版或附件。"
                            .to_owned(),
                    );
                    Some(paragraph_text(
                        &serde_json::to_string_pretty(&extras)
                            .map_err(|_| error("ai.source_json", "JSON 无法序列化。"))?,
                    ))
                };
                // Title and export metadata belong to this JSON record. Keep
                // them beside its original nodes, not as separately groupable
                // AI blocks that could become phantom undated diary entries.
                // Body blocks remain separate so real multi-day headings can
                // still be divided, with the body's own date hints unchanged.
                if first_body == self.result.blocks.len() {
                    if let Some(node) = title.take().or_else(|| trailing.take()) {
                        self.block(name, node, date)?;
                    }
                }
                if first_body < self.result.blocks.len() {
                    if let Some(title) = title {
                        self.decorate_block(first_body, title, true)?;
                    }
                    if let Some(trailing) = trailing {
                        self.decorate_block(self.result.blocks.len() - 1, trailing, false)?;
                    }
                }
                return Ok(());
            }
            if let Some((key, items)) = ["entries", "diaries", "notes", "journals", "items"]
                .iter()
                .find_map(|key| object.get(*key).filter(|v| v.is_array()).map(|v| (*key, v)))
            {
                self.json_document(files, name, items, date.clone(), depth + 1)?;
                let extras: serde_json::Map<String, Value> = object
                    .iter()
                    .filter(|(k, _)| k.as_str() != key)
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect();
                if !extras.is_empty() {
                    self.json_document(files, name, &Value::Object(extras), date, depth + 1)?;
                }
                return Ok(());
            }
        }
        self.warn(
            "部分 JSON 没有可识别的日记字段，已完整保留为可读文字，需在预览中检查。".to_owned(),
        );
        let text = if let Some(text) = value.as_str() {
            text.to_owned()
        } else {
            serde_json::to_string_pretty(value)
                .map_err(|_| error("ai.source_json", "JSON 无法读取。"))?
        };
        self.plain_document(name, &text, inherited_date)
    }

    fn standalone_image(
        &mut self,
        files: &mut SourceFiles,
        name: &str,
    ) -> Result<(), CommandError> {
        if self.result.images.len() >= MAX_IMAGES {
            return Err(error(
                "ai.source_limit",
                "一次最多识别 24 张图片，请分批选择。",
            ));
        }
        let bytes = files.read(name, MAX_IMAGE_BYTES)?;
        let meta = self.attach(name, &bytes, true)?;
        let preview = vision_preview(&bytes)?;
        let node = if meta["kind"] == "image" {
            media_node(&meta, "", "block", None)
        } else {
            let display = self.attach(&format!("{}.预览.jpg", leaf_name(name)), &preview, true)?;
            self.warn("TIFF 的原文件保留为附件，正文显示第一幅图的缩小预览，AI 识别使用同一预览；多页 TIFF 请先拆分为单张图片。".to_owned());
            media_node(
                &display,
                "TIFF 第一幅图预览，原文件见下方附件",
                "block",
                None,
            )
        };
        let id = self.block(name, node, filename_date(name))?;
        self.warn("照片和截图的拍摄时间不直接当作日记日期；明确以日记日期命名的文件仅作线索，请核对图片中的记录日期，无可靠日期时需手动补全。".to_owned());
        if meta["kind"] != "image" {
            if let Some(block) = self.result.blocks.last_mut() {
                block
                    .nodes
                    .push(media_node(&meta, "原始图片文件", "block", None));
                block
                    .plain_text
                    .push_str(&format!("\n[原文件：{}]", leaf_name(name)));
            }
        }
        self.result.images.push(SourceImage {
            id,
            source_name: name.to_owned(),
            mime_type: "image/jpeg".into(),
            base64: base64::engine::general_purpose::STANDARD.encode(preview),
            attachment_id: meta["id"].as_str().unwrap_or_default().to_owned(),
        });
        if extension(name) == "gif" {
            self.warn("GIF 的原文件完整保留；AI 识别使用第一帧预览。".to_owned());
        }
        Ok(())
    }
}

pub(super) fn prepare(
    paths: &[String],
    session_dir: &Path,
) -> Result<PreparedSource, CommandError> {
    if paths.is_empty() || paths.len() > MAX_PATHS {
        return Err(error("ai.source_selection", "请选择 1 至 256 个来源文件。"));
    }
    security::reject_symlink_components(session_dir).map_err(security_error)?;
    fs::create_dir_all(session_dir).map_err(io_error)?;
    let session = fs::canonicalize(session_dir).map_err(io_error)?;
    let mut state = Preparation {
        session: &session,
        result: PreparedSource {
            source_label: String::new(),
            blocks: Vec::new(),
            attachments: Vec::new(),
            images: Vec::new(),
            warnings: Vec::new(),
        },
        attachment_keys: HashMap::new(),
        total_media: 0,
        total_text: 0,
        rendered_body: 0,
    };
    let mut sources = HashSet::new();
    let mut labels = Vec::new();
    for path in paths {
        let path = Path::new(path);
        security::reject_symlink_components(path).map_err(security_error)?;
        let canonical = fs::canonicalize(path).map_err(io_error)?;
        if !canonical.is_file() {
            return Err(error(
                "ai.source_selection",
                "请选择文件；文件夹可先压缩为 ZIP 后导入。",
            ));
        }
        if canonical.starts_with(&session) {
            return Err(error("ai.source_path", "不能把本次暂存目录作为导入来源。"));
        }
        if !sources.insert(canonical.clone()) {
            continue;
        }
        let name = canonical
            .file_name()
            .and_then(|v| v.to_str())
            .ok_or_else(|| error("ai.source_name", "来源文件名不是有效的 Unicode。"))?
            .to_owned();
        labels.push(name.clone());
        if extension(&name) == "zip" {
            let mut files = SourceFiles::zip(&canonical)?;
            let names = files.names();
            if names
                .iter()
                .any(|name| name.eq_ignore_ascii_case("manifest.json"))
                && names
                    .iter()
                    .any(|name| name.eq_ignore_ascii_case("life.json"))
            {
                return Err(error(
                    "ai.source_native_archive",
                    "这看起来是 life-timeline 导出文件，请返回普通日记导入页面直接导入。",
                ));
            }
            let mut count = 0;
            for source in names
                .iter()
                .filter(|name| visible_source(name) && text_source(name))
            {
                state.document(&mut files, source)?;
                count += 1;
            }
            for source in names
                .iter()
                .filter(|name| visible_source(name) && image_source(name))
            {
                let bytes = files.read(source, MAX_IMAGE_BYTES)?;
                let key = format!("{}:{}", security::sha256_bytes(&bytes), leaf_name(source));
                if !state.attachment_keys.contains_key(&key) {
                    state.standalone_image(&mut files, source)?;
                    count += 1;
                }
            }
            let unused = names
                .iter()
                .filter(|name| visible_source(name) && !text_source(name) && !image_source(name))
                .count();
            if unused > 0 {
                state.warn("ZIP 内除日记文字、图片以及正文引用的附件外，其他文件不参与识别。请在预览中核对附件数量。".to_owned());
            }
            if count == 0 {
                return Err(error("ai.source_unsupported", "ZIP 中没有可识别的 Markdown、文本、HTML、JSON 或图片日记。PDF、Word 等请先导出为文本或图片。"));
            }
        } else {
            let root = canonical
                .parent()
                .ok_or_else(|| error("ai.source_path", "来源文件目录无效。"))?
                .to_owned();
            let mut files = SourceFiles::Local { root };
            if text_source(&name) {
                state.document(&mut files, &name)?;
            } else if image_source(&name) {
                state.standalone_image(&mut files, &name)?;
            } else {
                return Err(error("ai.source_unsupported", format!("暂不支持直接识别 {}。可使用 Markdown、TXT、HTML、JSON、图片，或包含这些文件和附件的 ZIP；PDF/Word 请先导出为文字或图片。", name)));
            }
        }
    }
    if state.result.blocks.is_empty() {
        return Err(error("ai.source_empty", "这些文件中没有可导入的日记内容。"));
    }
    state.result.source_label = if labels.len() == 1 {
        labels.remove(0)
    } else {
        format!("{} 个来源文件", labels.len())
    };
    Ok(state.result)
}

fn decode_text(bytes: &[u8]) -> Result<String, CommandError> {
    if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
        if !(bytes.len() - 2).is_multiple_of(2) {
            return Err(error("ai.source_encoding", "UTF-16 文本字节不完整。"));
        }
        let little = bytes[0] == 0xff;
        let words: Vec<_> = bytes[2..]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| {
                if little {
                    u16::from_le_bytes(*pair)
                } else {
                    u16::from_be_bytes(*pair)
                }
            })
            .collect();
        return String::from_utf16(&words).map_err(|_| {
            error(
                "ai.source_encoding",
                "文本包含无效 UTF-16 字符，请先转存为 UTF-8。",
            )
        });
    }
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    let text = std::str::from_utf8(bytes).map_err(|_| {
        error(
            "ai.source_encoding",
            "文本不是 UTF-8/UTF-16 编码，请先转存为 UTF-8；未使用乱码替换正文。",
        )
    })?;
    if text.contains('\0') {
        return Err(error(
            "ai.source_encoding",
            "文件含有二进制 NUL 字节，不能作为文字日记读取。",
        ));
    }
    Ok(text.to_owned())
}

fn image_dimensions(bytes: &[u8]) -> Result<(u32, u32), CommandError> {
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err(error("ai.source_limit", "单张图片不得超过 20 MiB。"));
    }
    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(io_error)?;
    let (width, height) = reader
        .into_dimensions()
        .map_err(|_| error("ai.source_image", "图片格式损坏或不受支持。"))?;
    if width == 0
        || height == 0
        || width > 30_000
        || height > 30_000
        || u64::from(width) * u64::from(height) > 80_000_000
    {
        return Err(error(
            "ai.source_limit",
            "图片尺寸超过安全读取限制，请缩小后导入。",
        ));
    }
    Ok((width, height))
}

fn vision_preview(bytes: &[u8]) -> Result<Vec<u8>, CommandError> {
    image_dimensions(bytes)?;
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(io_error)?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(30_000);
    limits.max_image_height = Some(30_000);
    limits.max_alloc = Some(384 * 1024 * 1024);
    reader.limits(limits);
    let mut decoder = reader
        .into_decoder()
        .map_err(|_| error("ai.source_image", "图片无法解码，未发送给 AI。"))?;
    let orientation = decoder
        .orientation()
        .map_err(|_| error("ai.source_image", "图片方向信息损坏，请重新保存后导入。"))?;
    let mut decoded = image::DynamicImage::from_decoder(decoder)
        .map_err(|_| error("ai.source_image", "图片无法解码，未发送给 AI。"))?;
    decoded.apply_orientation(orientation);
    let resized = if decoded.width() > 1600 || decoded.height() > 1600 {
        decoded.thumbnail(1600, 1600)
    } else {
        decoded
    };
    let rgba = resized.to_rgba8();
    let mut preview = image::RgbImage::new(rgba.width(), rgba.height());
    // A transparent screenshot must not acquire a black background when
    // converting to the provider-compatible JPEG preview.
    for (x, y, pixel) in rgba.enumerate_pixels() {
        let alpha = u16::from(pixel[3]);
        let channels = [0, 1, 2].map(|channel| {
            ((u16::from(pixel[channel]) * alpha + 255 * (255 - alpha) + 127) / 255) as u8
        });
        preview.put_pixel(x, y, image::Rgb(channels));
    }
    let mut bytes = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 85)
        .encode_image(&preview)
        .map_err(|_| error("ai.source_image", "图片识别预览生成失败。"))?;
    if bytes.len() > 2 * 1024 * 1024 {
        return Err(error(
            "ai.source_limit",
            "图片识别预览过大，请拆分或缩小图片。",
        ));
    }
    Ok(bytes)
}

fn decode_inline_image(source: &str) -> Result<(&'static str, Vec<u8>), CommandError> {
    let (header, encoded) = source
        .split_once(',')
        .ok_or_else(|| error("ai.source_inline_image", "内嵌图片格式不完整。"))?;
    let extension = match header.to_ascii_lowercase().as_str() {
        "data:image/png;base64" => "png",
        "data:image/jpeg;base64" | "data:image/jpg;base64" => "jpg",
        "data:image/webp;base64" => "webp",
        "data:image/gif;base64" => "gif",
        "data:image/bmp;base64" => "bmp",
        _ => {
            return Err(error(
                "ai.source_inline_image",
                "暂不支持这个内嵌媒体格式，请先保存为本地图片并使用相对文件引用。",
            ))
        }
    };
    if encoded.len() > (MAX_IMAGE_BYTES as usize).div_ceil(3) * 4 {
        return Err(error("ai.source_limit", "内嵌图片超过 20 MiB。"));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| error("ai.source_inline_image", "内嵌图片的 base64 数据无效。"))?;
    image_dimensions(&bytes)?;
    Ok((extension, bytes))
}

fn paragraph_text(text: &str) -> Value {
    let mut content = Vec::new();
    for (index, line) in text.split('\n').enumerate() {
        if index > 0 {
            content.push(json!({"type":"hardBreak"}));
        }
        if !line.is_empty() {
            content.push(json!({"type":"text","text":line}));
        }
    }
    json!({"type":"paragraph","content":content})
}

fn node_text(node: &Value) -> String {
    if let Some(text) = node["text"].as_str() {
        return text.to_owned();
    }
    if node["type"] == "hardBreak" {
        return "\n".into();
    }
    if node["type"] == "lifeImage" || node["type"] == "lifeAttachment" {
        return format!(
            "[{}：{}]",
            if node["type"] == "lifeImage" {
                "原图片"
            } else {
                "附件"
            },
            node["attrs"]["name"].as_str().unwrap_or("文件")
        );
    }
    node["content"]
        .as_array()
        .map(|nodes| {
            nodes
                .iter()
                .map(node_text)
                .collect::<Vec<_>>()
                .join(if node["type"] == "paragraph" {
                    ""
                } else {
                    "\n"
                })
        })
        .unwrap_or_default()
}

fn suggested_date(text: &str) -> Option<String> {
    let chars: Vec<char> = text.chars().collect();
    for start in 0..chars.len() {
        if !chars[start].is_ascii_digit() || (start > 0 && chars[start - 1].is_ascii_digit()) {
            continue;
        }
        let tail: String = chars[start..].iter().take(16).collect();
        let parts: Vec<_> = tail.split(|c: char| !c.is_ascii_digit()).collect();
        if parts.len() < 3
            || parts[0].len() != 4
            || !(1..=2).contains(&parts[1].len())
            || !(1..=2).contains(&parts[2].len())
        {
            continue;
        }
        let year = parts[0].parse::<i32>().ok()?;
        let month = parts[1].parse::<u32>().ok()?;
        let day = parts[2].parse::<u32>().ok()?;
        if year > 0 {
            if let Some(date) = NaiveDate::from_ymd_opt(year, month, day) {
                return Some(date.format("%Y-%m-%d").to_string());
            }
        }
    }
    None
}

fn date_heading(text: &str) -> Option<String> {
    let text = text.trim();
    if text.is_empty() || text.contains(['\n', '\r']) || text.chars().count() > 60 {
        return None;
    }
    let punctuation = |c: char| {
        c.is_whitespace()
            || matches!(
                c,
                ':' | '：'
                    | '-'
                    | '—'
                    | '_'
                    | '·'
                    | '|'
                    | '｜'
                    | '('
                    | ')'
                    | '（'
                    | '）'
                    | '['
                    | ']'
                    | '【'
                    | '】'
            )
    };
    let mut label = text;
    for prefix in ["日期", "日记", "日誌", "日記", "Diary", "diary"] {
        if let Some(rest) = label.strip_prefix(prefix) {
            label = rest.trim_start_matches(punctuation);
            break;
        }
    }
    let (date, mut rest) = leading_calendar_date(label)?;
    // Only recognizable diary-header suffixes may follow the date. A short
    // recollection mentioning a historical date is still original body text,
    // not evidence that the surrounding diary happened on that day.
    loop {
        rest = rest.trim_start_matches(punctuation);
        if rest.is_empty() {
            return Some(date);
        }
        let suffix = [
            "星期一",
            "星期二",
            "星期三",
            "星期四",
            "星期五",
            "星期六",
            "星期日",
            "星期天",
            "礼拜一",
            "礼拜二",
            "礼拜三",
            "礼拜四",
            "礼拜五",
            "礼拜六",
            "礼拜日",
            "礼拜天",
            "周一",
            "周二",
            "周三",
            "周四",
            "周五",
            "周六",
            "周日",
            "周天",
            "日记",
            "日誌",
            "日記",
            "Diary",
            "diary",
            "天气",
            "多云",
            "小雨",
            "中雨",
            "大雨",
            "小雪",
            "大雪",
            "晴",
            "阴",
            "雨",
            "雪",
        ]
        .iter()
        .find(|suffix| rest.starts_with(**suffix))?;
        rest = &rest[suffix.len()..];
    }
}

fn leading_calendar_date(text: &str) -> Option<(String, &str)> {
    fn component(text: &str, minimum: usize, maximum: usize) -> Option<(u32, &str)> {
        let end = text.bytes().take_while(u8::is_ascii_digit).count();
        if !(minimum..=maximum).contains(&end) {
            return None;
        }
        Some((text[..end].parse().ok()?, text[end..].trim_start()))
    }
    let (year, rest) = component(text, 4, 4)?;
    let separator = rest.chars().next()?;
    if !matches!(separator, '-' | '/' | '.' | '年') {
        return None;
    }
    let (month, rest) = component(rest.strip_prefix(separator)?.trim_start(), 1, 2)?;
    let month_separator = if separator == '年' { '月' } else { separator };
    let (day, rest) = component(rest.strip_prefix(month_separator)?.trim_start(), 1, 2)?;
    let rest = if separator == '年' {
        rest.strip_prefix('日')
            .or_else(|| rest.strip_prefix('号'))?
    } else {
        rest
    };
    if year == 0 {
        return None;
    }
    let date = NaiveDate::from_ymd_opt(year as i32, month, day)?;
    Some((date.format("%Y-%m-%d").to_string(), rest))
}

fn filename_date(name: &str) -> Option<String> {
    // Camera/screenshot names, parent folders and export timestamps are not
    // diary dates. Only an explicit date/diary-date basename is a weak hint;
    // an actual date heading in the document replaces it during preparation.
    let stem = Path::new(name).file_stem()?.to_str()?;
    date_heading(stem)
}

fn escape_html(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn expand_obsidian(text: &str) -> String {
    // Embeds become ordinary HTML media references for the same local resolver.
    // This is deliberately not a recursive wiki transclusion engine.
    let mut out = String::new();
    let mut rest = text;
    while let Some(start) = rest.find("![[") {
        out.push_str(&rest[..start]);
        let Some(end) = rest[start + 3..].find("]]") else {
            out.push_str(&rest[start..]);
            return out;
        };
        let inside = &rest[start + 3..start + 3 + end];
        let (name, width) = inside.split_once('|').unwrap_or((inside, ""));
        let width = width
            .split('x')
            .next()
            .unwrap_or("")
            .parse::<u32>()
            .ok()
            .filter(|v| *v > 0 && *v <= 30_000);
        out.push_str(&format!(
            "<img src=\"{}\" alt=\"{}\"{}>",
            escape_html(name),
            escape_html(name),
            width.map_or(String::new(), |v| format!(" width=\"{v}\""))
        ));
        rest = &rest[start + 3 + end + 2..];
    }
    out.push_str(rest);
    out
}

fn media_node(meta: &Value, caption: &str, layout: &str, width: Option<f64>) -> Value {
    if meta["kind"] == "image" {
        json!({"type":"lifeImage","attrs":{"attachmentId":meta["id"],"name":meta["name"],"caption":caption,"layout":layout,"width":width,"naturalWidth":meta["width"],"naturalHeight":meta["height"]}})
    } else {
        json!({"type":"lifeAttachment","attrs":{"attachmentId":meta["id"],"name":meta["name"],"mimeType":meta["mimeType"],"byteSize":meta["byteSize"],"note":caption}})
    }
}

struct HtmlRenderer<'a, 'b> {
    preparation: &'a mut Preparation<'b>,
    files: &'a mut SourceFiles,
    name: &'a str,
    date: Option<String>,
    nodes: Vec<(Value, Option<String>)>,
    inline: Vec<Value>,
}

impl HtmlRenderer<'_, '_> {
    fn flush(&mut self) {
        if !self.inline.is_empty() {
            let content = std::mem::take(&mut self.inline);
            if content.iter().any(|node| {
                node["type"] != "text"
                    || node["text"].as_str().is_some_and(|v| !v.trim().is_empty())
            }) {
                self.nodes.push((
                    json!({"type":"paragraph","content":content}),
                    self.date.clone(),
                ));
            }
        }
    }

    fn text(&mut self, text: &str, marks: &[Value]) {
        if text.is_empty() {
            return;
        }
        let mut node = json!({"type":"text","text":text});
        if !marks.is_empty() {
            node["marks"] = json!(marks);
        }
        self.inline.push(node);
    }

    fn children(
        &mut self,
        element: ElementRef<'_>,
        marks: &[Value],
        depth: usize,
    ) -> Result<(), CommandError> {
        if depth > MAX_DEPTH {
            return Err(error("ai.source_limit", "HTML 层级过深，未进行导入。"));
        }
        for child in element.children() {
            match child.value() {
                Node::Text(text) => self.text(text, marks),
                Node::Element(_) => {
                    if let Some(child) = ElementRef::wrap(child) {
                        self.element(child, marks, depth + 1)?;
                    }
                }
                _ => {}
            }
        }
        Ok(())
    }

    fn element(
        &mut self,
        element: ElementRef<'_>,
        marks: &[Value],
        depth: usize,
    ) -> Result<(), CommandError> {
        let tag = element.value().name();
        match tag {
            "script" | "style" | "iframe" | "object" | "embed" | "noscript" | "template"
            | "svg" => {
                self.preparation
                    .warn("已移除 HTML 的脚本、样式或可执行嵌入；不会执行外部内容。".to_owned());
            }
            "head" | "meta" | "link" | "base" => {}
            "br" => self.inline.push(json!({"type":"hardBreak"})),
            "b" | "strong" | "i" | "em" => {
                let mark = if tag == "b" || tag == "strong" {
                    "bold"
                } else {
                    "italic"
                };
                let mut marks = marks.to_vec();
                if !marks.iter().any(|v| v["type"] == mark) {
                    marks.push(json!({"type":mark}));
                }
                self.children(element, &marks, depth)?;
            }
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                self.flush();
                if let Some(date) = date_heading(&element.text().collect::<String>()) {
                    self.date = Some(date);
                }
                let mut marks = marks.to_vec();
                if !marks.iter().any(|v| v["type"] == "bold") {
                    marks.push(json!({"type":"bold"}));
                }
                self.children(element, &marks, depth)?;
                self.flush();
                self.preparation.warn(
                    "原标题层级已保留为加粗段落；日记编辑器不支持原始 HTML 标题样式。".to_owned(),
                );
            }
            "ul" | "ol" => self.list(element, marks, depth)?,
            "img" => self.media(element, true)?,
            "video" | "audio" => {
                if element.attr("src").is_some() {
                    self.media(element, false)?;
                } else {
                    let mut source_found = false;
                    for child in element.children().filter_map(ElementRef::wrap) {
                        if child.value().name() == "source" && child.attr("src").is_some() {
                            self.media(child, false)?;
                            source_found = true;
                        }
                    }
                    if !source_found {
                        self.preparation
                            .warn("有音视频标签缺少本地文件地址，已保留其文字说明。".to_owned());
                        self.children(element, marks, depth)?;
                    }
                }
            }
            "a" => {
                self.children(element, marks, depth)?;
                if let Some(href) = element
                    .attr("href")
                    .filter(|v| !v.is_empty() && !v.starts_with('#'))
                {
                    if external_reference(href) {
                        self.text(&format!(" ({href})"), &[]);
                        self.preparation
                            .warn("外部链接仅作为文字保留；未下载或访问外部地址。".to_owned());
                    } else {
                        let resolved = self.files.resolve(self.name, href)?;
                        let bytes = self.files.read(&resolved, MAX_MEDIA_BYTES)?;
                        let meta =
                            self.preparation
                                .attach(&resolved, &bytes, image_source(&resolved))?;
                        self.flush();
                        self.nodes
                            .push((media_node(&meta, "", "block", None), self.date.clone()));
                    }
                }
            }
            "p" | "div" | "article" | "section" | "header" | "footer" | "main" | "figure"
            | "figcaption" | "pre" | "blockquote" | "table" | "tr" | "hr" => {
                self.flush();
                if matches!(tag, "pre" | "blockquote" | "table" | "hr") {
                    self.preparation.warn(
                        "代码块、引言、表格和分隔线按可读段落保留；原始复杂排版需在预览中核对。"
                            .to_owned(),
                    );
                }
                if tag == "hr" {
                    self.text("——", &[]);
                } else {
                    self.children(element, marks, depth)?;
                }
                self.flush();
            }
            "td" | "th" => {
                self.children(element, marks, depth)?;
                self.text("\t", &[]);
            }
            "input" if element.attr("type") == Some("checkbox") => self.text(
                if element.attr("checked").is_some() {
                    "☑ "
                } else {
                    "☐ "
                },
                &[],
            ),
            "s" | "del" | "u" | "code" => {
                self.preparation
                    .warn("下划线、删除线和行内代码样式转为普通文字，内容保留。".to_owned());
                self.children(element, marks, depth)?;
            }
            _ => self.children(element, marks, depth)?,
        }
        Ok(())
    }

    fn list(
        &mut self,
        element: ElementRef<'_>,
        marks: &[Value],
        depth: usize,
    ) -> Result<(), CommandError> {
        self.flush();
        let mut items = Vec::new();
        for child in element.children().filter_map(ElementRef::wrap) {
            if child.value().name() != "li" {
                continue;
            }
            let saved = std::mem::take(&mut self.nodes);
            self.children(child, marks, depth + 1)?;
            self.flush();
            let mut content: Vec<Value> = std::mem::replace(&mut self.nodes, saved)
                .into_iter()
                .map(|(node, _)| node)
                .collect();
            if content
                .first()
                .is_none_or(|node| node["type"] != "paragraph")
            {
                content.insert(0, paragraph_text(""));
            }
            items.push(json!({"type":"listItem","content":content}));
        }
        if !items.is_empty() {
            let mut node = json!({"type":if element.value().name()=="ol" {"orderedList"} else {"bulletList"},"content":items});
            if element.value().name() == "ol" {
                node["attrs"] = json!({"start":element.attr("start").and_then(|v|v.parse::<i64>().ok()).unwrap_or(1)});
            }
            self.nodes.push((node, self.date.clone()));
        }
        Ok(())
    }

    fn media(&mut self, element: ElementRef<'_>, image_intent: bool) -> Result<(), CommandError> {
        let Some(src) = element.attr("src").filter(|v| !v.is_empty()) else {
            self.preparation
                .warn("有图片标签缺少文件地址，无法提取图片。".to_owned());
            return Ok(());
        };
        let inline_media = if src.starts_with("data:") {
            Some(decode_inline_image(src)?)
        } else {
            None
        };
        if inline_media.is_none() && external_reference(src) {
            self.text(&format!("[外部媒体：{src}]"), &[]);
            self.preparation.warn(
                "外部图片或音视频仅保留地址；未联网下载，需提供本地原文件才能随日记导入。"
                    .to_owned(),
            );
            return Ok(());
        }
        let (resolved, bytes) = if let Some((extension, bytes)) = inline_media {
            (
                format!(
                    "嵌入图片-{}.{}",
                    self.preparation.result.attachments.len() + 1,
                    extension
                ),
                bytes,
            )
        } else {
            let resolved = self.files.resolve(self.name, src)?;
            let bytes = self.files.read(
                &resolved,
                if image_source(&resolved) {
                    MAX_IMAGE_BYTES
                } else {
                    MAX_MEDIA_BYTES
                },
            )?;
            (resolved, bytes)
        };
        let meta = self.preparation.attach(&resolved, &bytes, image_intent)?;
        if matches!(extension(&resolved).as_str(), "tif" | "tiff") {
            self.preparation.warn(
                "正文中的 TIFF 图片原件作为附件保留；当前编辑器无法直接显示 TIFF。".to_owned(),
            );
        }
        let parent = element.parent().and_then(ElementRef::wrap);
        let attr = |name| {
            element
                .attr(name)
                .or_else(|| parent.and_then(|parent| parent.attr(name)))
        };
        let explicit = attr("data-layout");
        let style = attr("style")
            .unwrap_or("")
            .replace(' ', "")
            .to_ascii_lowercase();
        let layout = match explicit {
            Some(
                value @ ("block" | "wrap-left" | "wrap-right" | "margin-left" | "margin-right"),
            ) => value,
            _ if style.contains("float:left") || attr("align") == Some("left") => "wrap-left",
            _ if style.contains("float:right") || attr("align") == Some("right") => "wrap-right",
            _ => "block",
        };
        let width = attr("data-width")
            .and_then(|v| v.parse::<f64>().ok())
            .or_else(|| {
                style.split(';').find_map(|part| {
                    part.strip_prefix("width:")
                        .and_then(|v| v.strip_suffix('%'))
                        .and_then(|v| v.parse::<f64>().ok())
                })
            })
            .or_else(|| {
                attr("width")
                    .and_then(|v| v.parse::<f64>().ok())
                    .map(|px| px / 672.0 * 100.0)
            })
            .filter(|v| v.is_finite() && *v > 0.0)
            .map(|v| v.min(100.0));
        let caption = attr("data-caption")
            .or_else(|| element.attr("alt"))
            .unwrap_or("");
        if element.attr("width").is_some() {
            self.preparation
                .warn("图片像素宽度按正文宽度换算为比例；原图文件完整保留。".to_owned());
        }
        self.flush();
        self.nodes
            .push((media_node(&meta, caption, layout, width), self.date.clone()));
        Ok(())
    }
}

#[cfg(test)]
#[path = "ai_import_sources_tests.rs"]
mod tests;
