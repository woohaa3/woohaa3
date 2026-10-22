//! 用户图案库与文档资源分离；资源身份不可变，库管理不进入文档历史。
use photocraft_doc::{ColorMode, Document, Pattern, SampleType, Size};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::error::{EditorError, Result};

const SIGNATURE: &[u8; 8] = b"WHPAT001";
const MAX_METADATA_BYTES: usize = 262_144;
pub const MAX_SNAPSHOT_BYTES: usize = 32 * 1024 * 1024;

fn error(message: impl std::fmt::Display) -> EditorError {
    EditorError::CommandFailed {
        id: "pattern.library".into(),
        message: message.to_string(),
    }
}
fn valid_key(key: &str) -> bool {
    !key.trim().is_empty() && !key.contains('\0') && key.encode_utf16().count() <= 200
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
fn origin(pattern: &Pattern) -> String {
    let mut hash = Sha256::new();
    hash.update(b"woohaa-pattern-origin-v1:");
    hash.update(
        serde_json::to_vec(&(&pattern.id, &pattern.name, pattern.width, pattern.height)).unwrap(),
    );
    hash.update(format!("{:?}", pattern.surface.format()).as_bytes());
    hash.update(pattern.surface.default_bytes());
    for (coord, tile) in pattern.surface.tiles() {
        hash.update(coord.tx.to_be_bytes());
        hash.update(coord.ty.to_be_bytes());
        hash.update(tile.bytes());
    }
    hex(&hash.finalize())
}
fn resource_id(origin: &str, name: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(b"woohaa-pattern-resource-v1:");
    hash.update(serde_json::to_vec(&(origin, name)).unwrap());
    format!("woohaa-pat-{}", hex(&hash.finalize()))
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct EntryMeta {
    key: String,
    source_name: String,
    origin: String,
    resource_id: String,
}
#[derive(Clone)]
struct Entry {
    meta: EntryMeta,
    pattern: Pattern,
}
#[derive(Clone, Default)]
pub(crate) struct PatternLibrary {
    entries: Vec<Entry>,
}
impl PatternLibrary {
    pub fn patterns(&self) -> Vec<Pattern> {
        self.entries
            .iter()
            .map(|entry| entry.pattern.clone())
            .collect()
    }
    pub fn list(&self) -> Value {
        json!(self.entries.iter().map(|entry| json!({"key":entry.meta.key,"id":entry.pattern.id,"name":entry.pattern.name,
            "width":entry.pattern.width,"height":entry.pattern.height})).collect::<Vec<_>>())
    }
    /// 所有检查在候选副本中完成，后项冲突不会发布前项。
    pub fn append(&mut self, incoming: Vec<Pattern>, protected: &[Pattern]) -> Result<()> {
        if incoming.is_empty() || !photocraft_project_verify::pattern_support::supported(&incoming)
        {
            return Err(error("载入的图案为空或超出工程资源限制"));
        }
        let mut next = self.clone();
        for mut pattern in incoming {
            if !valid_key(&pattern.id) || protected.iter().any(|preset| preset.id == pattern.id) {
                return Err(error("图案身份无效或与默认图案冲突"));
            }
            let fingerprint = origin(&pattern);
            if let Some(existing) = next
                .entries
                .iter()
                .find(|entry| entry.meta.key == pattern.id)
            {
                if existing.meta.origin == fingerprint {
                    continue;
                }
                return Err(error("同一图案身份对应不同内容，未载入任何图案"));
            }
            let key = pattern.id.clone();
            pattern.id = resource_id(&fingerprint, &pattern.name);
            let meta = EntryMeta {
                key,
                source_name: pattern.name.clone(),
                origin: fingerprint,
                resource_id: pattern.id.clone(),
            };
            next.entries.push(Entry { meta, pattern });
        }
        if !photocraft_project_verify::pattern_support::supported(&next.patterns()) {
            return Err(error(
                "用户图案库最多 64 项、单边 1024、累计 4,194,304 像素",
            ));
        }
        *self = next;
        Ok(())
    }
    pub fn rename(&mut self, key: &str, name: &str) -> Result<()> {
        let name = name.trim();
        if !valid_key(name) {
            return Err(error("图案名称须为 1–200 个 UTF-16 单位"));
        }
        let entry = self
            .entries
            .iter_mut()
            .find(|entry| entry.meta.key == key)
            .ok_or_else(|| error("用户图案不存在，默认图案不能改名"))?;
        entry.pattern.name = name.into();
        entry.pattern.id = resource_id(&entry.meta.origin, name);
        entry.meta.resource_id = entry.pattern.id.clone();
        Ok(())
    }
    pub fn remove(&mut self, key: &str) -> Result<()> {
        let index = self
            .entries
            .iter()
            .position(|entry| entry.meta.key == key)
            .ok_or_else(|| error("用户图案不存在，默认图案不能删除"))?;
        self.entries.remove(index);
        Ok(())
    }
    pub fn export_pat(&self, key: Option<&str>) -> Result<Vec<u8>> {
        let patterns = match key {
            Some(key) => vec![
                self.entries
                    .iter()
                    .find(|entry| entry.meta.key == key)
                    .ok_or_else(|| error("用户图案不存在"))?
                    .pattern
                    .clone(),
            ],
            None => self.patterns(),
        };
        if patterns.is_empty() {
            return Err(error("用户图案库为空"));
        }
        let bytes = photocraft_io::pattern_map::write_pat(&patterns).map_err(error)?;
        // 与导入边界一致，避免导出静默截断身份或写出不可重载文件。
        crate::pattern_presets::inspect(&bytes)?;
        Ok(bytes)
    }
    /// 本机库快照保留原生稀疏资源和稳定管理身份，不生成预览或有损转换。
    pub fn snapshot(&self) -> Result<Vec<u8>> {
        let metadata = serde_json::to_vec(
            &self
                .entries
                .iter()
                .map(|entry| &entry.meta)
                .collect::<Vec<_>>(),
        )
        .map_err(error)?;
        if metadata.len() > MAX_METADATA_BYTES {
            return Err(error("图案库元数据超限"));
        }
        let mut document = Document::new(
            "WooHaa pattern library",
            Size::new(1, 1),
            ColorMode::Rgb,
            SampleType::U8,
        );
        document.patterns = self.patterns();
        let project =
            photocraft_format::save_to_bytes(&document, &Default::default()).map_err(error)?;
        let mut bytes = Vec::with_capacity(12 + metadata.len() + project.len());
        bytes.extend_from_slice(SIGNATURE);
        bytes.extend_from_slice(&(metadata.len() as u32).to_be_bytes());
        bytes.extend_from_slice(&metadata);
        bytes.extend_from_slice(&project);
        if bytes.len() > MAX_SNAPSHOT_BYTES {
            return Err(error("本机图案库快照不能超过 32 MiB"));
        }
        Ok(bytes)
    }
    pub fn restore(&mut self, bytes: &[u8], protected: &[Pattern]) -> Result<()> {
        if bytes.len() > MAX_SNAPSHOT_BYTES || bytes.get(..8) != Some(SIGNATURE.as_slice()) {
            return Err(error("本机图案库格式无效或超限"));
        }
        let length = bytes
            .get(8..12)
            .ok_or_else(|| error("本机图案库头不完整"))?;
        let length = u32::from_be_bytes(length.try_into().unwrap()) as usize;
        if length > MAX_METADATA_BYTES {
            return Err(error("图案库元数据超限"));
        }
        let end = 12 + length;
        let metadata = bytes
            .get(12..end)
            .ok_or_else(|| error("图案库元数据不完整"))?;
        let entries: Vec<EntryMeta> = serde_json::from_slice(metadata).map_err(error)?;
        if entries.len() > photocraft_project_verify::limits::MAX_PATTERNS {
            return Err(error("图案库条目超限"));
        }
        let project = &bytes[end..];
        let doc = photocraft_project_verify::load_pattern_library(project)
            .map_err(|failure| error(failure.message))?;
        if !doc.layers.is_empty()
            || doc.size != Size::new(1, 1)
            || doc.patterns.len() != entries.len()
        {
            return Err(error("本机图案库不能包含编辑图层或缺失资源"));
        }
        let mut keys = std::collections::HashSet::new();
        let mut next = Vec::with_capacity(entries.len());
        for meta in entries {
            if !valid_key(&meta.key)
                || !valid_key(&meta.source_name)
                || !keys.insert(meta.key.clone())
                || protected.iter().any(|preset| preset.id == meta.key)
                || meta.origin.len() != 64
                || !meta.origin.bytes().all(|byte| byte.is_ascii_hexdigit())
            {
                return Err(error("本机图案库身份无效、重复或与默认图案冲突"));
            }
            let pattern = doc
                .patterns
                .iter()
                .find(|pattern| pattern.id == meta.resource_id)
                .ok_or_else(|| error("本机图案库资源缺失"))?;
            if resource_id(&meta.origin, &pattern.name) != pattern.id {
                return Err(error("本机图案库资源身份不匹配"));
            }
            let source = Pattern {
                id: meta.key.clone(),
                name: meta.source_name.clone(),
                ..pattern.clone()
            };
            if origin(&source) != meta.origin {
                return Err(error("本机图案库资源内容与身份不匹配"));
            }
            next.push(Entry {
                meta,
                pattern: pattern.clone(),
            });
        }
        if !photocraft_project_verify::pattern_support::supported(
            &next
                .iter()
                .map(|entry| entry.pattern.clone())
                .collect::<Vec<_>>(),
        ) {
            return Err(error("本机图案库资源超限"));
        }
        self.entries = next;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use photocraft_doc::Surface;
    fn pattern(id: &str) -> Pattern {
        Pattern {
            id: id.into(),
            name: format!("图案 {id}"),
            width: 16,
            height: 16,
            surface: Surface::new(
                Document::new("blank", Size::new(1, 1), ColorMode::Rgb, SampleType::U8)
                    .pixel_format(),
            ),
        }
    }
    #[test]
    fn append_rename_remove_preserve_independent_resource_snapshots() {
        let mut library = PatternLibrary::default();
        library.append(vec![pattern("one")], &[]).unwrap();
        let applied = library.patterns()[0].clone();
        let key = library.list()[0]["key"].as_str().unwrap().to_string();
        library.rename(&key, "新名字").unwrap();
        let renamed = library.patterns()[0].clone();
        assert_eq!(library.list()[0]["key"], key);
        assert_ne!(renamed.id, applied.id);
        assert_eq!(renamed.surface, applied.surface);
        assert_eq!(applied.name, "图案 one");
        library.append(vec![pattern("one")], &[]).unwrap();
        assert_eq!(library.list().as_array().unwrap().len(), 1);
        assert_eq!(library.patterns()[0].name, "新名字");
        library.rename(&key, "图案 one").unwrap();
        assert_eq!(library.patterns()[0], applied);
        library.remove(&key).unwrap();
        assert!(library.patterns().is_empty());
        assert_eq!(renamed.name, "新名字");
        assert!(library.rename("default", "name").is_err());
        assert!(library.remove("default").is_err());
    }
    #[test]
    fn batch_conflicts_capacity_and_bad_names_leave_library_unchanged() {
        let mut library = PatternLibrary::default();
        library.append(vec![pattern("one")], &[]).unwrap();
        let before = library.list();
        let mut conflict = pattern("one");
        conflict.name = "不同内容".into();
        assert!(library.append(vec![pattern("two"), conflict], &[]).is_err());
        assert_eq!(library.list(), before);
        assert!(
            library
                .append(vec![pattern("default")], &[pattern("default")])
                .is_err()
        );
        assert!(library.rename("one", " ").is_err());
        assert!(library.rename("one", &"😀".repeat(101)).is_err());
        assert_eq!(library.list(), before);
        library
            .append(
                (1..64).map(|id| pattern(&format!("extra-{id}"))).collect(),
                &[],
            )
            .unwrap();
        let full = library.list();
        assert!(library.append(vec![pattern("overflow")], &[]).is_err());
        assert_eq!(library.list(), full);
        let mut large = PatternLibrary::default();
        large
            .append(
                (0..4)
                    .map(|id| Pattern {
                        width: 1024,
                        height: 1024,
                        ..pattern(&id.to_string())
                    })
                    .collect(),
                &[],
            )
            .unwrap();
        let full = large.list();
        assert!(large.append(vec![pattern("overflow")], &[]).is_err());
        assert_eq!(large.list(), full);
    }
    #[test]
    fn snapshot_roundtrip_preserves_keys_names_and_blank_resources_without_previews() {
        let mut library = PatternLibrary::default();
        library
            .append(vec![pattern("one"), pattern("two")], &[])
            .unwrap();
        library.rename("one", "改名后").unwrap();
        let bytes = library.snapshot().unwrap();
        assert_eq!(&bytes[..8], SIGNATURE);
        let metadata_length = u32::from_be_bytes(bytes[8..12].try_into().unwrap()) as usize;
        // 专用库容器可读取；原有工程上传入口仍拒绝无图层容器。
        assert!(photocraft_project_verify::verify(&bytes[12 + metadata_length..]).is_err());
        let mut restored = PatternLibrary::default();
        restored.restore(&bytes, &[]).unwrap();
        assert_eq!(restored.list(), library.list());
        assert_eq!(restored.patterns(), library.patterns());
        restored.rename("one", "再改名").unwrap();
        assert_ne!(restored.patterns()[0].id, library.patterns()[0].id);
        let empty = PatternLibrary::default().snapshot().unwrap();
        restored.restore(&empty, &[]).unwrap();
        assert_eq!(restored.list(), json!([]));
    }
    #[test]
    fn invalid_snapshot_is_atomic_and_protects_builtin_keys() {
        let mut library = PatternLibrary::default();
        library.append(vec![pattern("one")], &[]).unwrap();
        let before = library.list();
        let bytes = library.snapshot().unwrap();
        for prefix in [0, 8, 11, 20, bytes.len() - 1] {
            assert!(library.restore(&bytes[..prefix], &[]).is_err());
            assert_eq!(library.list(), before);
        }
        assert!(library.restore(&bytes, &[pattern("one")]).is_err());
        assert_eq!(library.list(), before);
        let mut bad = bytes.clone();
        bad[8..12].copy_from_slice(&u32::MAX.to_be_bytes());
        assert!(library.restore(&bad, &[]).is_err());
        assert!(
            library
                .restore(&vec![0; MAX_SNAPSHOT_BYTES + 1], &[])
                .is_err()
        );
        assert_eq!(library.list(), before);
        let metadata_length = u32::from_be_bytes(bytes[8..12].try_into().unwrap()) as usize;
        let mut metadata: Value = serde_json::from_slice(&bytes[12..12 + metadata_length]).unwrap();
        metadata[0]["resourceId"] = json!("missing");
        let encoded = serde_json::to_vec(&metadata).unwrap();
        let mut bad = SIGNATURE.to_vec();
        bad.extend_from_slice(&(encoded.len() as u32).to_be_bytes());
        bad.extend_from_slice(&encoded);
        bad.extend_from_slice(&bytes[12 + metadata_length..]);
        assert!(library.restore(&bad, &[]).is_err());
        assert_eq!(library.list(), before);
        metadata[0]["resourceId"] = before[0]["id"].clone();
        metadata[0]["sourceName"] = json!("伪造来源名称");
        let encoded = serde_json::to_vec(&metadata).unwrap();
        let mut bad = SIGNATURE.to_vec();
        bad.extend_from_slice(&(encoded.len() as u32).to_be_bytes());
        bad.extend_from_slice(&encoded);
        bad.extend_from_slice(&bytes[12 + metadata_length..]);
        assert!(library.restore(&bad, &[]).is_err());
        assert_eq!(library.list(), before);
    }
}
