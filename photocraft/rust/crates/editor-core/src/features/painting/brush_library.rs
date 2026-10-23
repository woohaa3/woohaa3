//! 笔刷预设库：默认预设、版本化存储、ABR 导入报告与真实内核笔迹预览
//! （change: 2026-10-22-complete-photocraft-webui-editing，P1a/P1b / design D4）。
//!
//! 三条边界：
//!
//! 1. **库是工具状态，不是文档内容**。预设的保存／改名／删除不进入文档修订、内容指纹或撤销
//!    栈，工程重开也不依赖用户库（已落笔的像素在工程内）。
//! 2. **原子发布**。批量导入（ABR、图片）先在候选库上完成全部检查与预算核算，成功后整批替换；
//!    任何一项失败都不发布半个库。
//! 3. **预览是真实内核**。笔迹预览走 `photocraft_paint::render_stroke`，与正式笔迹共用同一
//!    `BrushSettings`、同一固定 seed 和压力轨迹，不用 CSS 近似。
//!
//! 上限来自 `rust/project-limits.json`（Rust 常量在 `photocraft_project_verify::limits`）。

use std::collections::HashSet;

use photocraft_doc::{ColorMode, Document, Pattern, SampleType, Size};
use photocraft_engine::Session;
use photocraft_paint::{BrushPreset, BrushSettings, GrayTile, StrokePoint, TipShape};
use photocraft_project_verify::limits;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::error::{EditorError, Result};

/// 本机库快照容器签名（版本化；变更编码必须换签名）。
const SIGNATURE: &[u8; 8] = b"WHBR0001";
/// 库元数据（JSON）字节上限；预设的位图走工程容器，不进这里。
const MAX_METADATA_BYTES: usize = 1 << 20;
/// 本机库快照总字节上限（与 ABR 单文件预算同量级）。
pub const MAX_SNAPSHOT_BYTES: usize = limits::MAX_ABR_FILE_BYTES;

/// 预览用固定种子：同一预设每次都得到同一笔迹，供 UI 与 fixture 比对。
pub const PREVIEW_SEED: u64 = 0x5eed_1a2b_3c4d_5e6f;
/// 笔迹预览的最大边长（像素）；预览是 UI 缩略，不是文档内容。
pub const PREVIEW_SIDE: u32 = 96;
/// 一次预览最多渲染的采样点数（压力渐变 + 弧线）。
const PREVIEW_SAMPLES: u32 = 24;

/// 预设来源：区分程序性默认、用户保存、ABR 导入与图片采样。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PresetOrigin {
    /// 随包（程序性生成，无第三方资产）。
    Builtin,
    /// 用户在会话内保存／覆盖。
    User,
    /// 从 `.abr` 导入。
    Abr,
    /// 从图片定义采样笔尖。
    Image,
}

fn origin_name(origin: PresetOrigin) -> &'static str {
    match origin {
        PresetOrigin::Builtin => "builtin",
        PresetOrigin::User => "user",
        PresetOrigin::Abr => "abr",
        PresetOrigin::Image => "image",
    }
}

/// 一条库条目：元数据 + 完整笔刷（含位图）。
#[derive(Clone)]
struct Entry {
    meta: EntryMeta,
    brush: BrushSettings,
}

/// 库条目的持久化元数据；位图本体在工程容器里，按 `resource` 查。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EntryMeta {
    name: String,
    group: String,
    folder: Vec<String>,
    origin: PresetOrigin,
    /// 采样笔尖的内容摘要；程序性笔尖为空。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    resource: Option<String>,
    /// 生成该条目的来源说明（ABR 文件名、图片来源名）；用于损失报告与 UI 提示。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source: Option<String>,
}

/// ABR 导入报告：逐条列出可用与不支持项，供 UI 决定是否只导入子集。
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AbrReport {
    /// 文件版本（ABR v1/v2/v6…）。
    pub version: u16,
    /// 上游解析告警（截断、未知参数等）。
    pub warnings: Vec<String>,
    /// 可导入的预设数。
    pub supported: usize,
    /// 因笔尖超预算或动态未接通而被排除的预设名与原因。
    pub unsupported: Vec<String>,
    /// 候选可导入项的累计像素与解码字节（预算核算结果）。
    pub pixels: u64,
    pub decoded_bytes: u64,
}

/// 待用户确认的 ABR 导入（默认不发布）。
pub struct PendingAbr {
    pub report: AbrReport,
    presets: Vec<BrushPreset>,
    group: String,
}

impl PendingAbr {
    /// 报告（含不支持清单），UI 据此显示「仅导入可支持笔刷」选项。
    pub fn report(&self) -> Value {
        json!({ "group": self.group, "supported": self.report.supported, "unsupported": self.report.unsupported,
            "version": self.report.version, "warnings": self.report.warnings,
            "pixels": self.report.pixels, "decodedBytes": self.report.decoded_bytes })
    }

    /// 预检时使用的导入分组。
    pub fn group(&self) -> &str {
        &self.group
    }
}

fn error(message: impl std::fmt::Display) -> EditorError {
    EditorError::CommandFailed { id: "brush.library".into(), message: message.to_string() }
}

fn valid_name(name: &str) -> bool {
    !name.trim().is_empty() && !name.contains('\0') && name.encode_utf16().count() <= 255
}

fn valid_group(group: &str) -> bool {
    group.encode_utf16().count() <= 255 && !group.contains('\0')
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// 位图内容摘要：采样笔尖的稳定身份，重命名不改它。
///
/// 摘要按 **8 位量化** 计算：本机库快照把笔尖存成 RGB/U8，因此摘要必须在量化后仍稳定，
/// 否则「保存前」与「恢复后」的同一笔尖会被算成不同资源。
fn tile_digest(tile: &GrayTile) -> String {
    let mut hash = Sha256::new();
    hash.update(b"woohaa-brush-tile-v1:");
    hash.update(tile.width.to_be_bytes());
    hash.update(tile.height.to_be_bytes());
    for y in 0..tile.height {
        for x in 0..tile.width {
            hash.update([(tile.get(x, y) * 255.0).round().clamp(0.0, 255.0) as u8]);
        }
    }
    hex(&hash.finalize())
}

/// 一个笔刷引用的位图预算：主笔尖。纹理与双重笔尖属非目标或独立资源。
fn brush_tip(brush: &BrushSettings) -> Option<&GrayTile> {
    brush.tip.bitmap()
}

/// 校验一个预设是否在预算内：单边、累计像素、累计解码字节。
///
/// 预算**在分配前**核算：调用方先把候选库全部条目过一遍，再决定是否发布。
fn check_preset(brush: &BrushSettings, pixels: &mut u64, decoded: &mut u64) -> Result<()> {
    if brush.dual_brush.enabled {
        return Err(error("双重笔刷不在本次范围"));
    }
    if brush.wet_edges {
        return Err(error("湿画笔刷不在本次范围"));
    }
    let Some(tile) = brush_tip(brush) else {
        return Ok(());
    };
    if !tile.is_valid() {
        return Err(error("笔刷位图尺寸与数据不一致"));
    }
    if tile.width > limits::MAX_BRUSH_TIP_SIDE || tile.height > limits::MAX_BRUSH_TIP_SIDE {
        return Err(error(format!(
            "笔尖 {}×{} 超过单边上限 {}",
            tile.width, tile.height, limits::MAX_BRUSH_TIP_SIDE
        )));
    }
    let area = u64::from(tile.width) * u64::from(tile.height);
    if !limits::charge_pixels(pixels, area) {
        return Err(error(format!(
            "库内采样笔尖累计超过 {} 像素",
            limits::MAX_BRUSH_RESOURCE_PIXELS
        )));
    }
    // 16 位采样在内存里是 2 字节／像素；解码累计按同一口径核算。
    if !limits::charge_bytes(decoded, area * 2, limits::MAX_BRUSH_DECODED_BYTES) {
        return Err(error(format!(
            "笔刷资源解码累计超过 {} 字节",
            limits::MAX_BRUSH_DECODED_BYTES
        )));
    }
    Ok(())
}

/// 程序性硬圆：无采样位图，纯 `Round` 笔尖。
fn hard_round(size: f32) -> BrushSettings {
    BrushSettings {
        size,
        hardness: 1.0,
        spacing: 0.08,
        pressure_size: true,
        shape_dynamics: photocraft_paint::brush::ShapeDynamics {
            enabled: true,
            size: photocraft_paint::brush::Dynamic::controlled(
                photocraft_paint::brush::Control::PenPressure,
            ),
            ..Default::default()
        },
        smoothing: photocraft_paint::brush::Smoothing { amount: 0.1, ..Default::default() },
        ..Default::default()
    }
}

/// 程序性软圆：`Round` 笔尖 + 低硬度，边缘由内核衰减曲线生成。
fn soft_round(size: f32) -> BrushSettings {
    BrushSettings {
        size,
        hardness: 0.15,
        spacing: 0.06,
        pressure_size: true,
        flow: 0.85,
        smoothing: photocraft_paint::brush::Smoothing { amount: 0.1, ..Default::default() },
        ..Default::default()
    }
}

#[derive(Clone, Copy)]
enum TipKind {
    /// 柔和圆点：中心满、边缘平滑降到 0。
    SoftDot,
    /// 硬边带缺口：验证「非圆形采样笔尖」的旋转与圆度作用。
    Notched,
}

/// 有来源的默认采样预设：由代码确定性生成的位图（不是第三方资产），
/// 用于验证「采样笔尖」通路而非冒充 Photoshop 笔刷。
fn generated_tip(width: u32, height: u32, kind: TipKind) -> GrayTile {
    GrayTile::from_fn(width, height, |x, y| {
        let cx = (f64::from(x) + 0.5) / f64::from(width) * 2.0 - 1.0;
        let cy = (f64::from(y) + 0.5) / f64::from(height) * 2.0 - 1.0;
        let r = (cx * cx + cy * cy).sqrt();
        match kind {
            TipKind::SoftDot => {
                let t = (1.0 - r).clamp(0.0, 1.0);
                (t * t * (3.0 - 2.0 * t)) as f32
            }
            TipKind::Notched => {
                let notched = if cx > 0.35 && cy.abs() < 0.45 { 0.0 } else { 1.0 };
                let edge = (1.0 - r).clamp(0.0, 1.0);
                (edge * notched) as f32
            }
        }
    })
}

fn sampled(brush: BrushSettings, tip: GrayTile) -> BrushSettings {
    BrushSettings { tip: TipShape::Sampled(tip), ..brush }
}

/// 随包默认预设：程序性硬圆／软圆 + 两个确定性采样笔尖。
///
/// 全部由代码生成，`origin` 标为 `builtin`，报告中不引用第三方资产。
fn builtin_presets() -> Vec<Entry> {
    let pressure = |brush: BrushSettings| BrushSettings {
        shape_dynamics: photocraft_paint::brush::ShapeDynamics {
            enabled: true,
            size: photocraft_paint::brush::Dynamic::controlled(
                photocraft_paint::brush::Control::PenPressure,
            ),
            ..Default::default()
        },
        ..brush
    };
    let transfer = |brush: BrushSettings| BrushSettings {
        transfer: photocraft_paint::brush::Transfer {
            enabled: true,
            opacity: photocraft_paint::brush::Dynamic::controlled(
                photocraft_paint::brush::Control::PenPressure,
            ),
            ..Default::default()
        },
        ..brush
    };
    let entries = [
        ("Hard Round", "round", pressure(hard_round(24.0))),
        ("Soft Round", "round", pressure(soft_round(48.0))),
        ("Soft Round Pressure", "round", transfer(soft_round(36.0))),
        (
            "Sampled Soft Dot",
            "sampled",
            sampled(pressure(hard_round(40.0)), generated_tip(64, 64, TipKind::SoftDot)),
        ),
        (
            "Sampled Notched",
            "sampled",
            sampled(pressure(hard_round(36.0)), generated_tip(64, 48, TipKind::Notched)),
        ),
    ];
    entries
        .into_iter()
        .map(|(name, group, brush)| Entry {
            meta: EntryMeta {
                name: name.into(),
                group: group.into(),
                folder: Vec::new(),
                origin: PresetOrigin::Builtin,
                resource: brush_tip(&brush).map(tile_digest),
                source: Some("programmatic".into()),
            },
            brush,
        })
        .collect()
}

/// 笔刷库：与文档分离的工具状态。
pub struct BrushLibrary {
    entries: Vec<Entry>,
}

impl Default for BrushLibrary {
    fn default() -> Self {
        Self { entries: builtin_presets() }
    }
}

impl Clone for BrushLibrary {
    fn clone(&self) -> Self {
        Self { entries: self.entries.clone() }
    }
}

impl BrushLibrary {
    /// 把库同步到会话预设表（不改当前笔刷参数）。
    pub fn install(&self, session: &mut Session) {
        session.tools.presets = self.presets();
        session.brush_presets_changed();
    }

    fn presets(&self) -> Vec<BrushPreset> {
        self.entries
            .iter()
            .map(|entry| BrushPreset {
                name: entry.meta.name.clone(),
                brush: entry.brush.clone(),
                builtin: entry.meta.origin == PresetOrigin::Builtin,
                group: entry.meta.group.clone(),
                folder: entry.meta.folder.clone(),
                captures: Default::default(),
            })
            .collect()
    }

    /// 库列表（不含位图，避免把 MB 级 base64 传给 UI）。
    pub fn list(&self, full: bool) -> Value {
        let presets: Vec<Value> = self
            .entries
            .iter()
            .map(|entry| {
                let mut value = json!({
                    "name": entry.meta.name,
                    "group": entry.meta.group,
                    "folder": entry.meta.folder,
                    "origin": origin_name(entry.meta.origin),
                    "sampled": entry.meta.resource.is_some(),
                });
                if full {
                    value["resource"] = json!(entry.meta.resource);
                    value["source"] = json!(entry.meta.source);
                }
                value
            })
            .collect();
        json!({ "presets": presets, "count": self.entries.len(), "groups": self.groups() })
    }

    /// 分组列表（按分组在库中的首次出现顺序，附带每组预设数）。
    ///
    /// 顺序必须稳定且可持久：分组本身是条目上的字段，`renameGroup`/`moveGroup` 的结果要靠
    /// 条目顺序存活到下一次快照，因此这里不能按名称重排。
    fn groups(&self) -> Value {
        json!(self
            .group_counts()
            .into_iter()
            .map(|(group, count)| json!({ "group": group, "count": count }))
            .collect::<Vec<_>>())
    }

    /// [`Self::groups`] 的公开入口：域内组管理命令返回最新分组表，避免界面再猜顺序。
    pub fn groups_json(&self) -> Value {
        self.groups()
    }

    /// 分组名 → 条目数的有序表（首次出现顺序）。
    fn group_counts(&self) -> Vec<(String, usize)> {
        let mut order: Vec<String> = Vec::new();
        let mut counts: std::collections::HashMap<&str, usize> = Default::default();
        for entry in &self.entries {
            if !counts.contains_key(entry.meta.group.as_str()) {
                order.push(entry.meta.group.clone());
            }
            *counts.entry(entry.meta.group.as_str()).or_default() += 1;
        }
        order
            .into_iter()
            .map(|group| {
                let count = counts.get(group.as_str()).copied().unwrap_or(0);
                (group, count)
            })
            .collect()
    }

    /// 一条预设的完整设置（含位图），用于「笔刷设置」面板与预览。
    pub fn get(&self, name: &str) -> Result<Value> {
        let entry = self
            .entries
            .iter()
            .find(|entry| entry.meta.name.eq_ignore_ascii_case(name))
            .ok_or_else(|| error(format!("没有名为 `{name}` 的笔刷预设")))?;
        Ok(json!({ "name": entry.meta.name, "group": entry.meta.group, "folder": entry.meta.folder,
            "origin": origin_name(entry.meta.origin), "brush": entry.brush }))
    }

    fn brush_of(&self, name: &str) -> Option<BrushSettings> {
        self.entries
            .iter()
            .find(|entry| entry.meta.name.eq_ignore_ascii_case(name))
            .map(|entry| entry.brush.clone())
    }

    /// 新增或覆盖一条预设；覆盖时保留原分组与来源，除非显式传入。
    pub fn save(
        &mut self,
        name: &str,
        group: Option<&str>,
        folder: Option<Vec<String>>,
        brush: BrushSettings,
        origin: PresetOrigin,
        source: Option<String>,
    ) -> Result<Value> {
        if !valid_name(name) {
            return Err(error("预设名称须为 1–255 个 UTF-16 单位"));
        }
        if let Some(group) = group {
            if !valid_group(group) {
                return Err(error("分组名称非法"));
            }
        }
        if let Some(folder) = &folder {
            if folder.len() > 32 || folder.iter().any(|part| !valid_group(part)) {
                return Err(error("子文件夹层级或名称非法"));
            }
        }
        let index = self
            .entries
            .iter()
            .position(|entry| entry.meta.name.eq_ignore_ascii_case(name));
        let mut candidate = self.clone();
        let resource = brush_tip(&brush).map(tile_digest);
        match index {
            Some(index) => {
                let entry = &mut candidate.entries[index];
                entry.brush = brush.clone();
                entry.meta.origin = origin;
                entry.meta.resource = resource;
                if let Some(source) = source.clone() {
                    entry.meta.source = Some(source);
                }
                if let Some(group) = group {
                    entry.meta.group = group.to_string();
                }
                if let Some(folder) = folder.clone() {
                    entry.meta.folder = folder;
                }
            }
            None => {
                if candidate.entries.len() >= limits::MAX_BRUSH_LIBRARY_PRESETS {
                    return Err(error(format!(
                        "笔刷库最多 {} 个预设",
                        limits::MAX_BRUSH_LIBRARY_PRESETS
                    )));
                }
                candidate.entries.push(Entry {
                    meta: EntryMeta {
                        name: name.to_string(),
                        group: group.unwrap_or("general").to_string(),
                        folder: folder.unwrap_or_default(),
                        origin,
                        resource,
                        source,
                    },
                    brush: brush.clone(),
                });
            }
        }
        // 整库预算复核后才发布。
        let mut pixels = 0u64;
        let mut decoded = 0u64;
        for entry in &candidate.entries {
            check_preset(&entry.brush, &mut pixels, &mut decoded)?;
        }
        *self = candidate;
        let meta = self
            .entries
            .iter()
            .find(|entry| entry.meta.name.eq_ignore_ascii_case(name))
            .map(|entry| entry.meta.clone())
            .ok_or_else(|| error("预设保存后丢失"))?;
        Ok(json!({ "name": meta.name, "group": meta.group, "origin": origin_name(meta.origin) }))
    }

    /// 改名：保留位图与分组；与现有名称冲突时拒绝。
    pub fn rename(&mut self, name: &str, new_name: &str) -> Result<Value> {
        if !valid_name(new_name) {
            return Err(error("新名称非法"));
        }
        if self
            .entries
            .iter()
            .any(|entry| entry.meta.name.eq_ignore_ascii_case(new_name) && !entry.meta.name.eq_ignore_ascii_case(name))
        {
            return Err(error("新名称已被其他预设占用"));
        }
        let entry = self
            .entries
            .iter_mut()
            .find(|entry| entry.meta.name.eq_ignore_ascii_case(name))
            .ok_or_else(|| error("预设不存在"))?;
        let previous = std::mem::replace(&mut entry.meta.name, new_name.to_string());
        Ok(json!({ "name": new_name, "previous": previous }))
    }

    /// 删除一条预设。
    pub fn delete(&mut self, name: &str) -> Result<Value> {
        let index = self
            .entries
            .iter()
            .position(|entry| entry.meta.name.eq_ignore_ascii_case(name))
            .ok_or_else(|| error("预设不存在"))?;
        let removed = self.entries.remove(index);
        Ok(json!({ "name": removed.meta.name, "removed": true }))
    }

    /// 移动预设到另一个分组／子文件夹。
    pub fn move_to(
        &mut self,
        name: &str,
        group: Option<&str>,
        folder: Option<Vec<String>>,
    ) -> Result<Value> {
        if let Some(group) = group {
            if !valid_group(group) {
                return Err(error("分组名称非法"));
            }
        }
        if let Some(folder) = &folder {
            if folder.len() > 32 || folder.iter().any(|part| !valid_group(part)) {
                return Err(error("子文件夹层级或名称非法"));
            }
        }
        let entry = self
            .entries
            .iter_mut()
            .find(|entry| entry.meta.name.eq_ignore_ascii_case(name))
            .ok_or_else(|| error("预设不存在"))?;
        if let Some(group) = group {
            entry.meta.group = group.to_string();
        }
        if let Some(folder) = folder {
            entry.meta.folder = folder;
        }
        let (group, folder) = (entry.meta.group.clone(), entry.meta.folder.clone());
        Ok(json!({ "name": name, "group": group, "folder": folder }))
    }

    /// 分组改名：整组条目一起改，返回受影响条目数。
    ///
    /// 与单条预设改名不同，目标组名可以与现有组合并（用户把两组并成一组是合法意图），
    /// 因此这里不因重名拒绝；空名与 NUL 仍拒绝。
    pub fn rename_group(&mut self, group: &str, new_name: &str) -> Result<usize> {
        if new_name.trim().is_empty() || !valid_group(new_name) {
            return Err(error("分组名称非法"));
        }
        if !self.entries.iter().any(|entry| entry.meta.group == group) {
            return Err(error(format!("没有名为 `{group}` 的笔刷分组")));
        }
        if group == new_name {
            return Ok(0);
        }
        let mut renamed = 0usize;
        let mut candidate = self.clone();
        for entry in &mut candidate.entries {
            if entry.meta.group == group {
                entry.meta.group = new_name.to_string();
                renamed += 1;
            }
        }
        *self = candidate;
        Ok(renamed)
    }

    /// 删除分组：`keepPresets` 为 true 时把条目移入 `general`，否则连条目一起删。
    ///
    /// 默认分组（`general`）受保护：删掉它会让界面失去「未分组」的落点。返回值是被移走或
    /// 删除的条目数；未知分组是错误而不是空操作。
    pub fn delete_group(&mut self, group: &str, keep_presets: bool) -> Result<usize> {
        const DEFAULT_GROUP: &str = "general";
        if group == DEFAULT_GROUP {
            return Err(error(format!("默认分组 `{DEFAULT_GROUP}` 不能删除")));
        }
        if !self.entries.iter().any(|entry| entry.meta.group == group) {
            return Err(error(format!("没有名为 `{group}` 的笔刷分组")));
        }
        let mut candidate = self.clone();
        let mut affected = 0usize;
        if keep_presets {
            for entry in &mut candidate.entries {
                if entry.meta.group == group {
                    entry.meta.group = DEFAULT_GROUP.to_string();
                    affected += 1;
                }
            }
        } else {
            affected = candidate.entries.iter().filter(|entry| entry.meta.group == group).count();
            candidate.entries.retain(|entry| entry.meta.group != group);
        }
        *self = candidate;
        Ok(affected)
    }

    /// 分组排序：把 `group` 的全部条目整体搬到第 `index` 条其它条目之前。
    ///
    /// 分组顺序由条目顺序决定（快照与界面读同一个序），因此「移动分组」= 把该组条目一起搬到
    /// 某个条目位置。索引超界钳到末尾；返回该组在结果中的分组序号。
    pub fn move_group(&mut self, group: &str, index: usize) -> Result<usize> {
        if !self.entries.iter().any(|entry| entry.meta.group == group) {
            return Err(error(format!("没有名为 `{group}` 的笔刷分组")));
        }
        let mut candidate = self.clone();
        let mut moving: Vec<Entry> = Vec::new();
        let mut rest: Vec<Entry> = Vec::with_capacity(candidate.entries.len());
        for entry in candidate.entries.drain(..) {
            if entry.meta.group == group {
                moving.push(entry);
            } else {
                rest.push(entry);
            }
        }
        let at = index.min(rest.len());
        rest.splice(at..at, moving);
        candidate.entries = rest;
        *self = candidate;
        Ok(self
            .group_counts()
            .iter()
            .position(|(name, _)| name == group)
            .unwrap_or(0))
    }

    /// 本机库快照：签名 + 元数据 JSON + 仅含位图的工程容器。
    ///
    /// 位图放在工程容器里（复用稀疏 tile 编码），元数据只存身份与分组，因此重命名不改位图
    /// 字节，快照也不会因为改名而膨胀。
    pub fn snapshot(&self) -> Result<Vec<u8>> {
        let mut document = Document::new(
            "WooHaa brush library",
            Size::new(1, 1),
            ColorMode::Rgb,
            SampleType::U8,
        );
        let mut resources: std::collections::BTreeMap<String, GrayTile> = Default::default();
        for entry in &self.entries {
            if let Some(tile) = brush_tip(&entry.brush) {
                resources.entry(tile_digest(tile)).or_insert_with(|| tile.clone());
            }
        }
        for (digest, tile) in &resources {
            document.patterns.push(Pattern {
                id: format!("woohaa-brush-{}", &digest[..32]),
                name: digest.clone(),
                width: tile.width,
                height: tile.height,
                surface: gray_surface(tile),
            });
        }
        if document.patterns.len() > limits::MAX_PATTERNS {
            return Err(error(format!(
                "笔刷位图种类超过 {} 种，无法打包本机库快照",
                limits::MAX_PATTERNS
            )));
        }
        let metadata = serde_json::to_vec(&self.persistable()).map_err(error)?;
        if metadata.len() > MAX_METADATA_BYTES {
            return Err(error("笔刷库元数据超限"));
        }
        let project =
            photocraft_format::save_to_bytes(&document, &Default::default()).map_err(error)?;
        let mut bytes = Vec::with_capacity(12 + metadata.len() + project.len());
        bytes.extend_from_slice(SIGNATURE);
        bytes.extend_from_slice(&(metadata.len() as u32).to_be_bytes());
        bytes.extend_from_slice(&metadata);
        bytes.extend_from_slice(&project);
        if bytes.len() > MAX_SNAPSHOT_BYTES {
            return Err(error(format!(
                "笔刷库快照不能超过 {} MiB",
                MAX_SNAPSHOT_BYTES / (1024 * 1024)
            )));
        }
        Ok(bytes)
    }

    /// 快照里保存的条目：程序性条目存完整参数；采样条目把 `tip` 换成占位（位图在容器里，
    /// 恢复时按 `resource` 重新挂上），因此快照只存一份位图字节。
    fn persistable(&self) -> Vec<(EntryMeta, BrushSettings)> {
        self.entries
            .iter()
            .map(|entry| {
                let mut brush = entry.brush.clone();
                if entry.meta.resource.is_some() {
                    brush.tip = TipShape::Round;
                }
                (entry.meta.clone(), brush)
            })
            .collect()
    }

    /// 恢复本机库快照；失败时不改变现有库。
    pub fn restore(&mut self, bytes: &[u8]) -> Result<Value> {
        let restored = parse_snapshot(bytes)?;
        *self = restored;
        Ok(json!({ "count": self.entries.len(), "groups": self.groups() }))
    }

    /// 真实内核笔迹预览：固定 seed + 压力梯度弧线，输出 RGBA8。
    ///
    /// 与正式绘画共用 `render_stroke`，所以「预览与实际笔迹一致」由同一份代码保证，
    /// 而不是两套近似实现。
    pub fn stroke_preview(&self, name: &str, side: u32) -> Result<(u32, u32, Vec<u8>)> {
        let brush = self
            .brush_of(name)
            .ok_or_else(|| error(format!("没有名为 `{name}` 的笔刷预设")))?;
        stroke_preview(&brush, side)
    }

    /// 用任意笔刷设置渲染预览（「笔刷设置」面板实时反映未保存的修改）。
    pub fn preview_brush(&self, brush: &BrushSettings, side: u32) -> Result<(u32, u32, Vec<u8>)> {
        stroke_preview(brush, side)
    }

    /// 从图片定义采样笔尖（P1b）：调用方已解码并给出灰度覆盖，这里只做预算与发布。
    pub fn import_tip(
        &mut self,
        session: &mut Session,
        name: &str,
        group: &str,
        tip: GrayTile,
        base: BrushSettings,
    ) -> Result<Value> {
        if !valid_name(name) || !valid_group(group) {
            return Err(error("笔尖名称或分组非法"));
        }
        // 图片笔尖永不覆盖同名预设：自动唯名（与上游 importImage 一致）。
        let mut taken: Vec<String> = self.entries.iter().map(|entry| entry.meta.name.clone()).collect();
        let name = unique_name(name, &mut taken);
        let brush = BrushSettings { tip: TipShape::Sampled(tip), ..base };
        let saved = self.save(
            &name,
            Some(group),
            None,
            brush.clone(),
            PresetOrigin::Image,
            Some("image".into()),
        )?;
        session.tools.presets = self.presets();
        session.tools.current_preset = Some(name.clone());
        session.tools.brush = brush;
        session.tools.brush_changed();
        session.brush_presets_changed();
        Ok(json!({ "name": name, "saved": saved }))
    }
}

/// 大小写不敏感的唯名：`name`、`name 2`、`name 3`…
fn unique_name(name: &str, taken: &mut Vec<String>) -> String {
    let free = |candidate: &str| !taken.iter().any(|taken| taken.eq_ignore_ascii_case(candidate));
    if free(name) {
        taken.push(name.to_string());
        return name.to_string();
    }
    for index in 2..10_000u32 {
        let candidate = format!("{name} {index}");
        if free(&candidate) {
            taken.push(candidate.clone());
            return candidate;
        }
    }
    name.to_string()
}

/// 灰度位图 → 工程图案表面（RGB/U8，三通道同值；alpha 不参与笔尖覆盖）。
fn gray_surface(tile: &GrayTile) -> photocraft_raster::Surface {
    let format = photocraft_color::PixelFormat::RGBA8;
    let mut surface = photocraft_raster::Surface::new(format);
    let mut bytes = Vec::with_capacity((tile.width * tile.height * 4) as usize);
    for y in 0..tile.height {
        for x in 0..tile.width {
            let value = (tile.get(x, y) * 255.0).round().clamp(0.0, 255.0) as u8;
            bytes.extend_from_slice(&[value, value, value, 255]);
        }
    }
    surface.write_interleaved(
        photocraft_geom::Rect::from_xywh(0, 0, tile.width, tile.height),
        &bytes,
    );
    surface
}

/// 工程图案表面 → 灰度位图。
fn surface_tile(surface: &photocraft_raster::Surface, width: u32, height: u32) -> Result<GrayTile> {
    if width == 0 || height == 0 || width > limits::MAX_BRUSH_TIP_SIDE || height > limits::MAX_BRUSH_TIP_SIDE {
        return Err(error("快照里的笔刷位图尺寸非法"));
    }
    let bytes = surface.to_interleaved(photocraft_geom::Rect::from_xywh(0, 0, width, height));
    let channels = surface.format().channels();
    if channels < 3 || bytes.len() != (width as usize) * (height as usize) * channels {
        return Err(error("快照里的笔刷位图格式不受支持"));
    }
    let mut values = Vec::with_capacity((width * height) as usize);
    for pixel in bytes.chunks_exact(channels) {
        values.push(f32::from(pixel[0]) / 255.0);
    }
    Ok(GrayTile::from_f32(width, height, &values))
}

fn parse_snapshot(bytes: &[u8]) -> Result<BrushLibrary> {
    if bytes.len() > MAX_SNAPSHOT_BYTES {
        return Err(error("笔刷库快照超限"));
    }
    if bytes.get(..8) != Some(SIGNATURE.as_slice()) {
        return Err(error("笔刷库快照格式无效"));
    }
    let length = bytes
        .get(8..12)
        .ok_or_else(|| error("笔刷库快照头不完整"))?;
    let length = u32::from_be_bytes(length.try_into().unwrap()) as usize;
    if length > MAX_METADATA_BYTES {
        return Err(error("笔刷库元数据超限"));
    }
    let end = 12 + length;
    let metadata = bytes.get(12..end).ok_or_else(|| error("笔刷库元数据不完整"))?;
    let stored: Vec<(EntryMeta, BrushSettings)> = serde_json::from_slice(metadata).map_err(error)?;
    if stored.len() > limits::MAX_BRUSH_LIBRARY_PRESETS {
        return Err(error("笔刷库条目超限"));
    }
    let document = photocraft_project_verify::load_pattern_library(&bytes[end..])
        .map_err(|failure| error(failure.message))?;
    if document.size != Size::new(1, 1) || !document.layers.is_empty() {
        return Err(error("笔刷库容器不能包含编辑图层"));
    }
    let mut entries = Vec::with_capacity(stored.len());
    let mut names = HashSet::new();
    let mut pixels = 0u64;
    let mut decoded = 0u64;
    for (meta, mut brush) in stored {
        if !valid_name(&meta.name) || !valid_group(&meta.group) || !names.insert(meta.name.to_lowercase()) {
            return Err(error("笔刷库条目名称非法或重复"));
        }
        if let Some(resource) = &meta.resource {
            let pattern = document
                .patterns
                .iter()
                .find(|pattern| &pattern.name == resource)
                .ok_or_else(|| error("笔刷库位图缺失"))?;
            brush.tip = TipShape::Sampled(surface_tile(&pattern.surface, pattern.width, pattern.height)?);
        } else if brush_tip(&brush).is_some() {
            // 程序性条目不应携带位图：避免内存与快照不一致。
            return Err(error("程序性预设不能携带采样位图"));
        }
        check_preset(&brush, &mut pixels, &mut decoded)?;
        entries.push(Entry { meta, brush });
    }
    Ok(BrushLibrary { entries })
}

/// ABR 导入预检：整批解析并分离可导入／不支持项，**不发布**。
///
/// 预算在候选上核算；任何记录超过单边或累计预算都会被排除并记入报告，而不是静默截断。
pub fn inspect_abr(bytes: &[u8], group: &str) -> Result<PendingAbr> {
    if bytes.is_empty() {
        return Err(error("ABR 文件为空"));
    }
    if bytes.len() > limits::MAX_ABR_FILE_BYTES {
        return Err(error(format!(
            "ABR 单文件不能超过 {} MiB",
            limits::MAX_ABR_FILE_BYTES / (1024 * 1024)
        )));
    }
    if !valid_group(group) {
        return Err(error("导入分组名称非法"));
    }
    let import = photocraft_io::abr_map::read_abr(bytes, group)
        .map_err(|message| error(format!("ABR 解析失败：{message}")))?;
    let mut report = AbrReport {
        version: import.version,
        warnings: import.warnings.clone(),
        ..Default::default()
    };
    let mut presets = Vec::new();
    let mut pixels = 0u64;
    let mut decoded = 0u64;
    for mut preset in import.presets {
        if presets.len() >= limits::MAX_ABR_PRESETS_PER_IMPORT {
            report.unsupported.push(format!(
                "{}（超过单次导入 {} 条上限）",
                preset.name, limits::MAX_ABR_PRESETS_PER_IMPORT
            ));
            continue;
        }
        match check_preset(&preset.brush, &mut pixels, &mut decoded) {
            Ok(()) => {
                preset.builtin = false;
                presets.push(preset);
            }
            Err(failure) => report
                .unsupported
                .push(format!("{}（{}）", preset.name, failure.message())),
        }
    }
    report.supported = presets.len();
    report.pixels = pixels;
    report.decoded_bytes = decoded;
    Ok(PendingAbr { report, presets, group: group.to_string() })
}

/// 确认发布一次 ABR 导入；`only_supported` 为 false 且存在不支持项时整批拒绝。
///
/// 发布是一次原子替换：候选库与候选会话预设都构造完成后才赋值。同一 `group` 的旧 ABR 条目
/// 被替换（与上游 `replace` 语义一致），因此重复导入同一文件不会堆积。
pub fn commit_abr(
    library: &mut BrushLibrary,
    session: &mut Session,
    pending: PendingAbr,
    group: &str,
    only_supported: bool,
) -> Result<Value> {
    if !pending.report.unsupported.is_empty() && !only_supported {
        return Err(error(format!(
            "ABR 含 {} 个未接通记录；请确认「仅导入可支持笔刷」或取消",
            pending.report.unsupported.len()
        )));
    }
    if pending.presets.is_empty() {
        return Err(error("ABR 里没有可导入的笔刷"));
    }
    let mut entries: Vec<Entry> = library
        .entries
        .iter()
        .filter(|entry| !(entry.meta.origin == PresetOrigin::Abr && entry.meta.group == group))
        .cloned()
        .collect();
    let replaced: Vec<String> = library
        .entries
        .iter()
        .filter(|entry| entry.meta.origin == PresetOrigin::Abr && entry.meta.group == group)
        .map(|entry| entry.meta.name.clone())
        .collect();
    let mut taken: Vec<String> = entries.iter().map(|entry| entry.meta.name.clone()).collect();
    let mut imported = Vec::new();
    let mut pixels = 0u64;
    let mut decoded = 0u64;
    for preset in pending.presets {
        if entries.len() >= limits::MAX_BRUSH_LIBRARY_PRESETS {
            return Err(error(format!(
                "笔刷库最多 {} 个预设",
                limits::MAX_BRUSH_LIBRARY_PRESETS
            )));
        }
        let name = unique_name(&preset.name, &mut taken);
        let brush = BrushSettings { tip: preset.brush.tip.clone(), ..preset.brush };
        check_preset(&brush, &mut pixels, &mut decoded)?;
        entries.push(Entry {
            meta: EntryMeta {
                name: name.clone(),
                group: group.to_string(),
                folder: preset.folder.clone(),
                origin: PresetOrigin::Abr,
                resource: brush_tip(&brush).map(tile_digest),
                source: Some("abr".into()),
            },
            brush,
        });
        imported.push(name);
    }
    let mut report = pending.report;
    report.supported = imported.len();
    report.pixels = pixels;
    report.decoded_bytes = decoded;
    // 全部通过后才发布。
    library.entries = entries;
    let presets = library.presets();
    session.tools.presets = presets.clone();
    // 被替换的预设如果正是当前预设，改名后的第一项接管；否则保持当前参数。
    if let Some(current) = session.tools.current_preset.clone() {
        if replaced.iter().any(|name| name.eq_ignore_ascii_case(&current))
            && !presets.iter().any(|preset| preset.name.eq_ignore_ascii_case(&current))
        {
            session.tools.current_preset = imported.first().cloned();
        }
    }
    session.brush_presets_changed();
    Ok(json!({ "group": group, "imported": imported, "count": imported.len(), "report": report }))
}

/// 从图片字节生成采样笔尖（P1b）。
///
/// 覆盖语义与上游 Define Brush Preset 一致：**暗像素作画**（亮度越低覆盖越高）乘以 alpha，
/// 裁剪到实际作画范围；上限是笔尖单边与总像素预算。透明或全白图片拒绝。
pub fn image_tip(name: &str, bytes: &[u8]) -> Result<GrayTile> {
    let decoded = photocraft_codecs::decode_with(
        bytes,
        &photocraft_codecs::DecodeOptions {
            limits: photocraft_codecs::Limits {
                max_width: limits::MAX_BRUSH_TIP_SIDE,
                max_height: limits::MAX_BRUSH_TIP_SIDE,
                max_pixels: u64::from(limits::MAX_BRUSH_TIP_SIDE) * u64::from(limits::MAX_BRUSH_TIP_SIDE),
                max_alloc: limits::MAX_BRUSH_DECODED_BYTES,
            },
            ..Default::default()
        },
    )
    .map_err(|failure| error(format!("无法解码笔尖图片：{failure}")))?;
    let width = decoded.width();
    let height = decoded.height();
    if width == 0 || height == 0 || width > limits::MAX_BRUSH_TIP_SIDE || height > limits::MAX_BRUSH_TIP_SIDE {
        return Err(error(format!(
            "笔尖图片须为 1–{} 像素单边",
            limits::MAX_BRUSH_TIP_SIDE
        )));
    }
    let mut coverage = Vec::with_capacity((width * height) as usize);
    let (mut x0, mut y0, mut x1, mut y1) = (width, height, 0u32, 0u32);
    let rgba = decoded.to_rgba8();
    for y in 0..height {
        for x in 0..width {
            let index = ((y * width + x) * 4) as usize;
            let pixel = &rgba[index..index + 4];
            let alpha = f32::from(pixel[3]) / 255.0;
            let luma = (0.2126 * f32::from(pixel[0]) + 0.7152 * f32::from(pixel[1]) + 0.0722 * f32::from(pixel[2])) / 255.0;
            let paint = ((1.0f32 - luma) * alpha).clamp(0.0, 1.0);
            if paint > 1e-4 {
                x0 = x0.min(x);
                y0 = y0.min(y);
                x1 = x1.max(x + 1);
                y1 = y1.max(y + 1);
            }
            coverage.push(paint);
        }
    }
    if x1 <= x0 || y1 <= y0 {
        return Err(error(format!("图片 `{name}` 没有可作画的像素（全白或全透明）")));
    }
    let (tw, th) = (x1 - x0, y1 - y0);
    let mut values = Vec::with_capacity((tw * th) as usize);
    for y in y0..y1 {
        for x in x0..x1 {
            values.push(coverage[(y * width + x) as usize]);
        }
    }
    Ok(GrayTile::from_f32(tw, th, &values))
}

/// 真实内核笔迹预览：固定 seed + 压力梯度弧线，输出 RGBA8。
///
/// 表面是 `PREVIEW_SIDE` 见方的透明画布；笔迹按预设尺寸缩放后落在中间。绘制走
/// `photocraft_paint::render_stroke`，与正式绘画同一实现。
pub fn stroke_preview(brush: &BrushSettings, side: u32) -> Result<(u32, u32, Vec<u8>)> {
    let side = side.clamp(16, 512);
    let scale = side as f32 / 128.0;
    let mut sample = brush.clone();
    // 预览按 128px 参考尺寸缩放笔尖，避免大笔尖在小缩略图里糊成一块。
    sample.size = (brush.size * scale).clamp(1.0, side as f32 * 0.6);
    sample.spacing = brush.spacing.clamp(0.01, 1.0);
    sample.color = [0.11, 0.11, 0.12, 1.0];
    sample.erase = false;
    sample.seed = PREVIEW_SEED;
    // 预览是普通绘制：即使预设带擦除或通道目标也只画覆盖。
    sample.mode = photocraft_doc::BlendMode::Normal;
    let format = photocraft_color::PixelFormat::RGBA8;
    let mut surface = photocraft_raster::Surface::new(format);
    let mut points = Vec::with_capacity(PREVIEW_SAMPLES as usize);
    for index in 0..PREVIEW_SAMPLES {
        let t = index as f64 / f64::from(PREVIEW_SAMPLES - 1);
        // 轻微正弦弧线：既覆盖直线采样，也覆盖方向变化带来的角度动态。
        let x = 0.12 + t * 0.76;
        let y = 0.5 + (t * std::f64::consts::PI).sin() * 0.18;
        points.push(StrokePoint::new(
            x * f64::from(side),
            y * f64::from(side),
            // 压力渐变：从 0.15 到 1.0，验证压感与最小值。
            0.15 + 0.85 * t as f32,
        ));
    }
    photocraft_paint::render_stroke(&mut surface, &sample, &points, None, false, 1.0);
    let image = surface.to_interleaved(photocraft_geom::Rect::from_xywh(0, 0, side, side));
    // 稀疏表面上未绘制的像素保持默认（透明）。
    Ok((side, side, image))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn session() -> Session {
        let mut session = Session::new();
        session.execute("file.new", json!({"width": 32, "height": 32})).unwrap();
        session
    }

    #[test]
    fn builtin_presets_are_programmatic_unique_and_grouped() {
        let library = BrushLibrary::default();
        let list = library.list(true);
        let presets = list["presets"].as_array().unwrap();
        assert!(presets.len() >= 5);
        let mut names: Vec<&str> = presets.iter().map(|p| p["name"].as_str().unwrap()).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), presets.len(), "默认预设名必须唯一");
        assert!(presets.iter().all(|p| p["origin"] == "builtin"));
        // 采样预设至少两个，且引用的是代码生成的位图（无第三方资产）。
        assert!(presets.iter().filter(|p| p["sampled"] == true).count() >= 2);
        assert!(presets.iter().all(|p| p["source"] == "programmatic"));
        assert!(library.get("Hard Round").unwrap()["brush"]["hardness"] == 1.0);
        assert!(library.get("Soft Round").unwrap()["brush"]["hardness"].as_f64().unwrap() < 0.5);
    }

    #[test]
    fn preview_uses_the_real_kernel_and_is_deterministic() {
        let library = BrushLibrary::default();
        let (w, h, first) = library.stroke_preview("Hard Round", 96).unwrap();
        assert_eq!((w, h), (96, 96));
        assert_eq!(first.len(), 96 * 96 * 4);
        // 真实内核绘制过：存在非透明像素。
        assert!(first.chunks_exact(4).any(|p| p[3] > 0));
        let (_, _, second) = library.stroke_preview("Hard Round", 96).unwrap();
        assert_eq!(first, second, "固定 seed 的预览必须可复现");
        // 采样笔尖与圆笔尖的覆盖不同（不是同一个近似）。
        let (_, _, sampled) = library.stroke_preview("Sampled Notched", 96).unwrap();
        assert_ne!(first, sampled);
        assert!(library.stroke_preview("no such brush", 96).is_err());
    }

    #[test]
    fn save_rename_delete_and_group_move_are_atomic() {
        let mut library = BrushLibrary::default();
        let brush = hard_round(12.0);
        library.save("我的笔", Some("自定义"), None, brush.clone(), PresetOrigin::User, None).unwrap();
        assert_eq!(library.get("我的笔").unwrap()["group"], "自定义");
        // 覆盖保留原分组，除非显式传入。
        library
            .save("我的笔", None, None, soft_round(20.0), PresetOrigin::User, None)
            .unwrap();
        assert_eq!(library.get("我的笔").unwrap()["group"], "自定义");
        assert!(library.get("我的笔").unwrap()["brush"]["hardness"].as_f64().unwrap() < 0.5);
        // 改名不影响位图身份。
        library.rename("我的笔", "改名后").unwrap();
        assert!(library.get("我的笔").is_err());
        assert_eq!(library.get("改名后").unwrap()["group"], "自定义");
        library.move_to("改名后", Some("另一组"), None).unwrap();
        assert_eq!(library.get("改名后").unwrap()["group"], "另一组");
        library.delete("改名后").unwrap();
        assert!(library.get("改名后").is_err());
        // 非法输入不改变库。
        let before = library.list(false);
        assert!(library.save("", None, None, brush.clone(), PresetOrigin::User, None).is_err());
        assert!(library.save("x", Some("y\0"), None, brush.clone(), PresetOrigin::User, None).is_err());
        assert!(library.rename("不存在", "x").is_err());
        assert_eq!(library.list(false), before);
    }

    #[test]
    fn snapshot_roundtrip_preserves_names_groups_and_sampled_bitmaps() {
        let mut library = BrushLibrary::default();
        library
            .save("自定义", Some("组"), Some(vec!["子".into()]), hard_round(40.0), PresetOrigin::User, None)
            .unwrap();
        let before = library.list(true);
        let bytes = library.snapshot().unwrap();
        assert_eq!(&bytes[..8], SIGNATURE);
        let mut restored = BrushLibrary::default();
        restored.restore(&bytes).unwrap();
        assert_eq!(restored.list(true), before);
        // 采样位图真的被恢复（摘要一致）。
        let original = library.get("Sampled Notched").unwrap();
        let copy = restored.get("Sampled Notched").unwrap();
        assert_eq!(tile_digest(brush_tip(&sample_brush(original)).unwrap()),
            tile_digest(brush_tip(&sample_brush(copy)).unwrap()));
        // 坏快照不改变现有库。
        let current = restored.list(true);
        for prefix in [0, 4, 11, 20, bytes.len() - 1] {
            assert!(restored.restore(&bytes[..prefix]).is_err());
            assert_eq!(restored.list(true), current);
        }
        assert!(restored.restore(&vec![0; MAX_SNAPSHOT_BYTES + 1]).is_err());
        assert_eq!(restored.list(true), current);
    }

    fn sample_brush(value: Value) -> BrushSettings {
        serde_json::from_value(value["brush"].clone()).unwrap()
    }

    #[test]
    fn budget_rejects_oversized_tip_before_publishing() {
        let mut library = BrushLibrary::default();
        let big = BrushSettings {
            tip: TipShape::Sampled(GrayTile::from_fn(2048, 8, |_, _| 1.0)),
            ..hard_round(20.0)
        };
        let before = library.list(false);
        assert!(library
            .save("太大", None, None, big, PresetOrigin::User, None)
            .is_err());
        assert_eq!(library.list(false), before);
        // 上限内的重复小位图累计仍受像素预算约束。
        let mut total = 0u64;
        let mut decoded = 0u64;
        let tile = GrayTile::from_fn(1024, 1024, |_, _| 1.0);
        let brush = BrushSettings { tip: TipShape::Sampled(tile), ..hard_round(20.0) };
        for _ in 0..16 {
            check_preset(&brush, &mut total, &mut decoded).unwrap();
        }
        assert!(check_preset(&brush, &mut total, &mut decoded).is_err());
    }

    #[test]
    fn abr_inspection_rejects_bad_files_and_reports_without_publishing() {
        let mut library = BrushLibrary::default();
        let mut session = session();
        library.install(&mut session);
        // 非 ABR 数据：整批拒绝，库不变。
        let before = library.list(false);
        assert!(inspect_abr(b"not an abr", "g").is_err());
        assert_eq!(library.list(false), before);
        // 超预算文件在解析前拒绝。
        assert!(inspect_abr(&vec![0; limits::MAX_ABR_FILE_BYTES + 1], "g").is_err());
        // 空分组名非法。
        assert!(inspect_abr(&vec![0; 8], "\0").is_err());
    }

    #[test]
    fn image_tip_import_publishes_one_preset_and_makes_it_current() {
        let mut library = BrushLibrary::default();
        let mut session = session();
        library.install(&mut session);
        let tip = generated_tip(48, 48, TipKind::SoftDot);
        let result = library
            .import_tip(&mut session, "图片笔尖", "采样", tip, hard_round(30.0))
            .unwrap();
        assert!(result["name"].is_string());
        assert_eq!(library.list(false)["count"], 6);
        assert_eq!(session.tools.current_preset.as_deref(), Some("图片笔尖"));
        assert!(matches!(session.tools.brush.tip, TipShape::Sampled(_)));
        // 同名再导入得到唯一名称，不覆盖。
        library
            .import_tip(
                &mut session,
                "图片笔尖",
                "采样",
                generated_tip(32, 32, TipKind::Notched),
                hard_round(20.0),
            )
            .unwrap();
        assert_eq!(library.list(false)["count"], 7);
    }
}
