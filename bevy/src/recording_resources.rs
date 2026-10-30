//! 录制输入资源的有界接收
//! （change: 2026-10-17-add-native-offscreen-film-set-recording，任务 2.4 / design D3）。
//!
//! worker 从宿主的授权 reader 拿到的是**分块字节**，不是 URL、blob 或任意路径。本模块：
//! - 只接受连续偏移（乱序/重复/跳块都拒绝），每块 ≤1 MiB；
//! - 写入任务私有目录下的**固定文件名**（`resource-<n>.bin`），文件名由内部计数生成，
//!   绝不使用调用方给的字符串，因此不可能路径穿越；
//! - 边写边累计 SHA-256，收尾时与快照里的 checksum 比对，不符即删除；
//! - 单文件与合计超预算立即失败并清理；
//! - 取消时删除已写入的私有文件。
//!
//! 纯 std + 本 crate 的 sha256，可在无 GPU 环境完整测试。

use std::collections::BTreeMap;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

use crate::recording_encode::{EncodeFailure, EncodeStage, sha256_hex};

/// 单块上限（与协议常量一致）。
pub const MAX_CHUNK_BYTES: usize = 1024 * 1024;

/// 单文件上限（与媒体服务 256 MiB 上限一致）。
pub const MAX_RESOURCE_BYTES: u64 = 256 * 1024 * 1024;

/// 任务素材合计上限（design D3 的默认值）。
pub const MAX_TOTAL_RESOURCE_BYTES: u64 = 512 * 1024 * 1024;

/// 一个待接收的资源声明（来自冻结快照）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResourceDeclaration {
    pub resource_id: String,
    /// 期望的 64 位 hex sha256（与媒体 checksum 一致）。
    pub checksum: String,
    pub content_type: String,
    pub size_bytes: u64,
}

/// 接收失败的原因；都是稳定码，会进入任务诊断。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResourceFailure {
    pub code: &'static str,
    pub message: String,
}

impl ResourceFailure {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    /// 映射到 proto 阶段：素材接收属于 `RESOURCE_FETCH`。
    pub fn proto_stage(&self) -> &'static str {
        "RECORDING_ERROR_STAGE_RESOURCE_FETCH"
    }
}

/// 单次任务的所有输入资源。
pub struct ResourceReceiver {
    directory: PathBuf,
    declarations: BTreeMap<String, ResourceDeclaration>,
    written: BTreeMap<String, WrittenResource>,
    total_bytes: u64,
    max_total_bytes: u64,
    /// 资源 id → 私有文件序号；文件名永不来自外部字符串。
    order: Vec<String>,
    /// 正在接收中的资源。
    in_progress: BTreeMap<String, InProgress>,
    finished: bool,
}

/// 已写入完成的资源。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WrittenResource {
    pub resource_id: String,
    pub path: PathBuf,
    pub size_bytes: u64,
    pub checksum: String,
}

struct InProgress {
    writer: BufWriter<File>,
    path: PathBuf,
    expected_offset: u64,
    /// 流式摘要的输入缓冲（分块结束后一次性摘要；单文件 ≤256 MiB，仍在预算内）。
    bytes: Vec<u8>,
    declaration: ResourceDeclaration,
}

impl ResourceReceiver {
    /// 为一次 attempt 创建接收器；目录必须是任务私有目录（`0700`，由 supervisor 建立）。
    pub fn new(
        directory: &Path,
        declarations: impl IntoIterator<Item = ResourceDeclaration>,
    ) -> Result<Self, ResourceFailure> {
        let mut map = BTreeMap::new();
        for declaration in declarations {
            if declaration.resource_id.trim().is_empty() {
                return Err(ResourceFailure::new(
                    "recording-resource-invalid",
                    "资源 id 不能为空",
                ));
            }
            if !is_sha256_hex(&declaration.checksum) {
                return Err(ResourceFailure::new(
                    "recording-resource-invalid",
                    format!(
                        "资源 {} 的 checksum 不是 64 位 hex",
                        declaration.resource_id
                    ),
                ));
            }
            if declaration.size_bytes == 0 || declaration.size_bytes > MAX_RESOURCE_BYTES {
                return Err(ResourceFailure::new(
                    "recording-resource-too-large",
                    format!("资源 {} 大小超出单文件预算", declaration.resource_id),
                ));
            }
            if !declaration.content_type.contains('/') {
                return Err(ResourceFailure::new(
                    "recording-resource-invalid",
                    format!("资源 {} 的 content type 非法", declaration.resource_id),
                ));
            }
            map.insert(declaration.resource_id.clone(), declaration);
        }
        let total: u64 = map.values().map(|declaration| declaration.size_bytes).sum();
        if total > MAX_TOTAL_RESOURCE_BYTES {
            return Err(ResourceFailure::new(
                "recording-resource-budget-exceeded",
                format!("素材合计 {total} 字节超过任务预算"),
            ));
        }
        std::fs::create_dir_all(directory).map_err(|error| {
            ResourceFailure::new("recording-resource-directory-failed", error.to_string())
        })?;
        Ok(Self {
            directory: directory.to_path_buf(),
            declarations: map,
            written: BTreeMap::new(),
            total_bytes: 0,
            max_total_bytes: MAX_TOTAL_RESOURCE_BYTES,
            order: Vec::new(),
            in_progress: BTreeMap::new(),
            finished: false,
        })
    }

    /// 覆盖合计预算（测试与更严格部署使用）。
    pub fn with_total_budget(mut self, bytes: u64) -> Self {
        self.max_total_bytes = bytes;
        self
    }

    /// 接收一块数据。
    ///
    /// 校验顺序：未知资源 → 已完成 → 块大小 → 偏移连续 → 单文件/合计预算 → 期望长度。
    pub fn accept_chunk(
        &mut self,
        resource_id: &str,
        offset: u64,
        data: &[u8],
        last: bool,
    ) -> Result<(), ResourceFailure> {
        if self.finished {
            return Err(ResourceFailure::new(
                "recording-resource-closed",
                "接收器已结束",
            ));
        }
        let declaration = self.declarations.get(resource_id).cloned().ok_or_else(|| {
            ResourceFailure::new(
                "recording-resource-unknown",
                format!("快照未声明资源 {resource_id}"),
            )
        })?;
        if data.len() > MAX_CHUNK_BYTES {
            return Err(ResourceFailure::new(
                "recording-resource-chunk-too-large",
                format!("分块 {} 字节超过 {MAX_CHUNK_BYTES} 上限", data.len()),
            ));
        }

        if self.written.contains_key(resource_id) {
            return Err(ResourceFailure::new(
                "recording-resource-duplicate",
                format!("资源 {resource_id} 已接收完成"),
            ));
        }

        let in_progress = self.in_progress.get_mut(resource_id);
        if in_progress.is_none() && offset != 0 {
            return Err(ResourceFailure::new(
                "recording-resource-out-of-order",
                format!("资源 {resource_id} 首块偏移必须为 0"),
            ));
        }
        if let Some(state) = in_progress {
            if offset != state.expected_offset {
                return Err(ResourceFailure::new(
                    "recording-resource-out-of-order",
                    format!(
                        "资源 {resource_id} 偏移乱序：期望 {}，收到 {offset}",
                        state.expected_offset
                    ),
                ));
            }
            let projected = state.bytes.len() as u64 + data.len() as u64;
            if projected > declaration.size_bytes {
                return Err(ResourceFailure::new(
                    "recording-resource-too-large",
                    format!("资源 {resource_id} 超过声明大小 {}", declaration.size_bytes),
                ));
            }
        } else {
            // 首块也要做单文件长度检查：声明比实际小时必须在写入前拒绝。
            if data.len() as u64 > declaration.size_bytes {
                return Err(ResourceFailure::new(
                    "recording-resource-too-large",
                    format!("资源 {resource_id} 超过声明大小 {}", declaration.size_bytes),
                ));
            }
            let projected_total = self.total_bytes + data.len() as u64;
            if projected_total > self.max_total_bytes {
                return Err(ResourceFailure::new(
                    "recording-resource-budget-exceeded",
                    "素材合计超过任务预算",
                ));
            }
            let index = self.order.len();
            self.order.push(resource_id.to_owned());
            // 文件名由内部序号生成，不使用 resource_id → 不可能路径穿越。
            let path = self.directory.join(format!("resource-{index}.bin"));
            let file = File::create(&path).map_err(|error| {
                ResourceFailure::new("recording-resource-write-failed", error.to_string())
            })?;
            self.in_progress.insert(
                resource_id.to_owned(),
                InProgress {
                    writer: BufWriter::new(file),
                    path,
                    expected_offset: 0,
                    bytes: Vec::new(),
                    declaration: declaration.clone(),
                },
            );
        }

        let state = self
            .in_progress
            .get_mut(resource_id)
            .expect("created above");
        state.writer.write_all(data).map_err(|error| {
            ResourceFailure::new("recording-resource-write-failed", error.to_string())
        })?;
        state.bytes.extend_from_slice(data);
        state.expected_offset += data.len() as u64;
        self.total_bytes += data.len() as u64;

        if last {
            self.finish_resource(resource_id)?;
        }
        Ok(())
    }

    fn finish_resource(&mut self, resource_id: &str) -> Result<(), ResourceFailure> {
        let Some(mut state) = self.in_progress.remove(resource_id) else {
            return Err(ResourceFailure::new(
                "recording-resource-unknown",
                format!("资源 {resource_id} 没有在途数据"),
            ));
        };
        state.writer.flush().map_err(|error| {
            ResourceFailure::new("recording-resource-write-failed", error.to_string())
        })?;
        let size = state.bytes.len() as u64;
        if size != state.declaration.size_bytes {
            let _ = std::fs::remove_file(&state.path);
            return Err(ResourceFailure::new(
                "recording-resource-size-mismatch",
                format!(
                    "资源 {resource_id} 收到 {size} 字节，声明 {}",
                    state.declaration.size_bytes
                ),
            ));
        }
        let digest = sha256_hex(&state.bytes);
        if digest != state.declaration.checksum {
            let _ = std::fs::remove_file(&state.path);
            return Err(ResourceFailure::new(
                "recording-resource-checksum-mismatch",
                format!("资源 {resource_id} 内容与 checksum 不符"),
            ));
        }
        self.written.insert(
            resource_id.to_owned(),
            WrittenResource {
                resource_id: resource_id.to_owned(),
                path: state.path,
                size_bytes: size,
                checksum: digest,
            },
        );
        Ok(())
    }

    /// 全部资源是否都已收齐。
    pub fn is_complete(&self) -> bool {
        self.written.len() == self.declarations.len()
    }

    /// 已收齐的资源（按声明顺序）。
    pub fn resources(&self) -> Vec<WrittenResource> {
        self.order
            .iter()
            .filter_map(|id| self.written.get(id).cloned())
            .collect()
    }

    /// 结束接收：未收齐即失败（不返回部分结果）。
    pub fn finish(mut self) -> Result<Vec<WrittenResource>, ResourceFailure> {
        let missing: Vec<String> = self
            .declarations
            .keys()
            .filter(|id| !self.written.contains_key(*id))
            .cloned()
            .collect();
        if !missing.is_empty() {
            self.cleanup();
            return Err(ResourceFailure::new(
                "recording-resource-missing",
                format!("缺少素材分块：{}", missing.join(", ")),
            ));
        }
        self.finished = true;
        Ok(self.resources())
    }

    /// 从任务目录**已落地**的分块文件接收（宿主/资源流把私有文件写好之后调用）。
    ///
    /// 仍然逐块校验大小与 checksum，因此「文件已存在」不等于「可信」；路径由内部序号
    /// 生成，不使用快照里的字符串。
    pub fn adopt_existing_files(&mut self) -> Result<(), ResourceFailure> {
        // 文件名由**声明顺序**（BTreeMap 的稳定键序）决定，与 `accept_chunk` 的写入顺序一致；
        // 两处必须用同一规则，否则会读错文件。
        let ids: Vec<String> = self.declarations.keys().cloned().collect();
        // 先按声明顺序试 `resource-<i>.bin`；不匹配时扫描目录内所有 `resource-*.bin`，
        // 用 **checksum** 认领（文件名只是传输细节，内容才是身份）。
        let mut candidates: Vec<std::path::PathBuf> = std::fs::read_dir(&self.directory)
            .map(|entries| {
                entries
                    .flatten()
                    .map(|entry| entry.path())
                    .filter(|path| {
                        path.file_name()
                            .and_then(|name| name.to_str())
                            .map(|name| name.starts_with("resource-") && name.ends_with(".bin"))
                            .unwrap_or(false)
                    })
                    .collect()
            })
            .unwrap_or_default();
        candidates.sort();
        for (index, resource_id) in ids.iter().enumerate() {
            if self.written.contains_key(resource_id) {
                continue;
            }
            let declaration = self.declarations.get(resource_id).expect("declared");
            // 只有内容匹配才认领：文件名是传输细节，**checksum 才是身份**。
            // 先试声明下标对应的名字（常见路径），再扫描全部候选。
            let preferred = self.directory.join(format!("resource-{index}.bin"));
            let matches = |path: &std::path::Path| {
                std::fs::read(path)
                    .map(|bytes| sha256_hex(&bytes) == declaration.checksum)
                    .unwrap_or(false)
            };
            let path = if preferred.exists() && matches(&preferred) {
                preferred
            } else if let Some(path) = candidates.iter().find(|path| matches(path)) {
                path.clone()
            } else {
                continue;
            };
            let bytes = match std::fs::read(&path) {
                Ok(bytes) => bytes,
                Err(_) => continue,
            };
            if bytes.len() as u64 != declaration.size_bytes {
                let _ = std::fs::remove_file(&path);
                return Err(ResourceFailure::new(
                    "recording-resource-size-mismatch",
                    format!("资源 {resource_id} 文件长度与声明不符"),
                ));
            }
            let digest = sha256_hex(&bytes);
            if digest != declaration.checksum {
                let _ = std::fs::remove_file(&path);
                return Err(ResourceFailure::new(
                    "recording-resource-checksum-mismatch",
                    format!("资源 {resource_id} 文件内容与 checksum 不符"),
                ));
            }
            self.total_bytes = self.total_bytes.saturating_add(bytes.len() as u64);
            if self.total_bytes > self.max_total_bytes {
                return Err(ResourceFailure::new(
                    "recording-resource-budget-exceeded",
                    "素材合计超过任务预算",
                ));
            }
            self.order.push(resource_id.clone());
            self.written.insert(
                resource_id.clone(),
                WrittenResource {
                    resource_id: resource_id.clone(),
                    path,
                    size_bytes: bytes.len() as u64,
                    checksum: digest,
                },
            );
        }
        Ok(())
    }

    /// 取消：删除所有已写入的私有文件（幂等）。
    pub fn cancel(&mut self) {
        self.cleanup();
        self.finished = true;
    }

    fn cleanup(&mut self) {
        for state in self.in_progress.values() {
            let _ = std::fs::remove_file(&state.path);
        }
        self.in_progress.clear();
        for resource in self.written.values() {
            let _ = std::fs::remove_file(&resource.path);
        }
        self.written.clear();
        self.total_bytes = 0;
    }
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// 供诊断/测试：把 `ResourceFailure` 映射成 `EncodeFailure` 形状的失败（同阶段语义）。
pub fn as_encode_failure(failure: &ResourceFailure) -> EncodeFailure {
    EncodeFailure::new(EncodeStage::Mux, failure.code, failure.message.clone())
}

impl std::fmt::Debug for ResourceReceiver {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ResourceReceiver")
            .field("declarations", &self.declarations.len())
            .field("written", &self.written.len())
            .field("total_bytes", &self.total_bytes)
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::recording_encode::sha256_hex;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wo-resource-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("dir");
        dir
    }

    fn declaration(id: &str, bytes: &[u8]) -> ResourceDeclaration {
        ResourceDeclaration {
            resource_id: id.into(),
            checksum: sha256_hex(bytes),
            content_type: "video/mp4".into(),
            size_bytes: bytes.len() as u64,
        }
    }

    #[test]
    fn receives_a_resource_in_contiguous_chunks() {
        let dir = temp_dir("contiguous");
        let bytes = vec![7u8; 2_500];
        let mut receiver =
            ResourceReceiver::new(&dir, [declaration("clip:video", &bytes)]).expect("new");
        receiver
            .accept_chunk("clip:video", 0, &bytes[..1_024], false)
            .expect("chunk 1");
        receiver
            .accept_chunk("clip:video", 1_024, &bytes[1_024..2_048], false)
            .expect("chunk 2");
        receiver
            .accept_chunk("clip:video", 2_048, &bytes[2_048..], true)
            .expect("chunk 3");
        let resources = receiver.finish().expect("complete");
        assert_eq!(resources.len(), 1);
        assert_eq!(resources[0].size_bytes, 2_500);
        assert_eq!(std::fs::read(&resources[0].path).expect("read"), bytes);
        // 私有文件在任务目录内。
        assert!(resources[0].path.starts_with(&dir));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_out_of_order_and_duplicate_chunks() {
        let dir = temp_dir("order");
        let bytes = vec![1u8; 64];
        let mut receiver = ResourceReceiver::new(&dir, [declaration("r", &bytes)]).expect("new");

        let error = receiver
            .accept_chunk("r", 32, &bytes[32..], false)
            .expect_err("first offset");
        assert_eq!(error.code, "recording-resource-out-of-order");

        receiver
            .accept_chunk("r", 0, &bytes[..16], false)
            .expect("first");
        let error = receiver
            .accept_chunk("r", 32, &bytes[32..], false)
            .expect_err("gap");
        assert_eq!(error.code, "recording-resource-out-of-order");
        // 重复发送同一块也不接受。
        let error = receiver
            .accept_chunk("r", 0, &bytes[..16], false)
            .expect_err("duplicate offset");
        assert_eq!(error.code, "recording-resource-out-of-order");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_unknown_resource_and_oversized_chunk() {
        let dir = temp_dir("unknown");
        let bytes = vec![2u8; 8];
        let mut receiver = ResourceReceiver::new(&dir, [declaration("r", &bytes)]).expect("new");
        let error = receiver
            .accept_chunk("other", 0, &bytes, true)
            .expect_err("unknown");
        assert_eq!(error.code, "recording-resource-unknown");

        let big = vec![0u8; MAX_CHUNK_BYTES + 1];
        let error = receiver
            .accept_chunk("r", 0, &big, false)
            .expect_err("oversized chunk");
        assert_eq!(error.code, "recording-resource-chunk-too-large");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_checksum_mismatch_and_deletes_the_file() {
        let dir = temp_dir("checksum");
        let bytes = vec![3u8; 128];
        let mut bad = declaration("r", &bytes);
        bad.checksum = "0".repeat(64);
        let mut receiver = ResourceReceiver::new(&dir, [bad]).expect("new");
        let error = receiver
            .accept_chunk("r", 0, &bytes, true)
            .expect_err("checksum");
        assert_eq!(error.code, "recording-resource-checksum-mismatch");
        // 失败后不应留下私有源文件。
        let leftovers: Vec<_> = std::fs::read_dir(&dir).expect("dir").flatten().collect();
        assert!(leftovers.is_empty(), "校验失败必须删除私有文件");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_size_mismatch() {
        let dir = temp_dir("size");
        let bytes = vec![4u8; 64];
        let mut smaller = declaration("r", &bytes);
        smaller.size_bytes = 32;
        let mut receiver = ResourceReceiver::new(&dir, [smaller]).expect("new");
        // 声明比实际小：超预算在写入前拒绝。
        let error = receiver
            .accept_chunk("r", 0, &bytes, true)
            .expect_err("too large");
        assert_eq!(error.code, "recording-resource-too-large");

        // 声明比实际大：收尾时长度不符，删除私有文件。
        let mut larger = declaration("r", &bytes);
        larger.size_bytes = 128;
        let mut receiver = ResourceReceiver::new(&dir, [larger]).expect("new");
        let error = receiver
            .accept_chunk("r", 0, &bytes, true)
            .expect_err("short");
        assert_eq!(error.code, "recording-resource-size-mismatch");
        let leftovers: Vec<_> = std::fs::read_dir(&dir).expect("dir").flatten().collect();
        assert!(leftovers.is_empty(), "长度不符时必须删除私有文件");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn enforces_declaration_and_total_budgets() {
        let dir = temp_dir("budget");
        let mut huge = declaration("r", &[5u8; 8]);
        huge.size_bytes = MAX_RESOURCE_BYTES + 1;
        let error = ResourceReceiver::new(&dir, [huge]).expect_err("per file");
        assert_eq!(error.code, "recording-resource-too-large");

        let a = declaration("a", &[6u8; 8]);
        let b = declaration("b", &[7u8; 8]);
        let error = ResourceReceiver::new(&dir, [a, b])
            .expect("new")
            .with_total_budget(4)
            .accept_chunk("a", 0, &[6u8; 8], true)
            .expect_err("total budget");
        assert_eq!(error.code, "recording-resource-budget-exceeded");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_resource_fails_finish_and_cleans_up() {
        let dir = temp_dir("missing");
        let a = declaration("a", &[8u8; 8]);
        let b = declaration("b", &[9u8; 8]);
        let mut receiver = ResourceReceiver::new(&dir, [a, b]).expect("new");
        receiver.accept_chunk("a", 0, &[8u8; 8], true).expect("a");
        let error = receiver.finish().expect_err("missing b");
        assert_eq!(error.code, "recording-resource-missing");
        let leftovers: Vec<_> = std::fs::read_dir(&dir).expect("dir").flatten().collect();
        assert!(leftovers.is_empty(), "未收齐时必须清理已写入文件");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn cancel_removes_private_files() {
        let dir = temp_dir("cancel");
        let bytes = vec![10u8; 32];
        let mut receiver = ResourceReceiver::new(&dir, [declaration("r", &bytes)]).expect("new");
        receiver
            .accept_chunk("r", 0, &bytes[..16], false)
            .expect("part");
        receiver.cancel();
        let leftovers: Vec<_> = std::fs::read_dir(&dir).expect("dir").flatten().collect();
        assert!(leftovers.is_empty());
        // 取消后不再接受数据。
        assert_eq!(
            receiver
                .accept_chunk("r", 16, &bytes[16..], true)
                .expect_err("closed")
                .code,
            "recording-resource-closed"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn filenames_never_come_from_caller_strings() {
        let dir = temp_dir("injection");
        // 恶意 resource id：内部序号命名，因此不会创建到目录外。
        let bytes = vec![11u8; 8];
        let mut receiver =
            ResourceReceiver::new(&dir, [declaration("../../etc/passwd", &bytes)]).expect("new");
        receiver
            .accept_chunk("../../etc/passwd", 0, &bytes, true)
            .expect("received");
        let resources = receiver.finish().expect("complete");
        assert!(resources[0].path.starts_with(&dir));
        assert_eq!(
            resources[0].path.file_name().and_then(|name| name.to_str()),
            Some("resource-0.bin")
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn declarations_are_validated_up_front() {
        let dir = temp_dir("declarations");
        let mut invalid = declaration("r", &[12u8; 8]);
        invalid.checksum = "xyz".into();
        assert_eq!(
            ResourceReceiver::new(&dir, [invalid])
                .expect_err("checksum")
                .code,
            "recording-resource-invalid"
        );
        let mut no_type = declaration("r", &[13u8; 8]);
        no_type.content_type = "video".into();
        assert_eq!(
            ResourceReceiver::new(&dir, [no_type])
                .expect_err("content type")
                .code,
            "recording-resource-invalid"
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}
