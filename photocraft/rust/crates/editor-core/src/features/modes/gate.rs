//! 按图像模式收紧**其他域**的写入命令（change: 2026-10-22-add-photocraft-image-mode-workflows，
//! 任务 4.4 / design D1c）。
//!
//! ## 为什么需要这一层
//!
//! 索引色与位图文档把颜色表/黑白两点存成**元数据**，像素仍是 8 位通道。共享命令门只看
//! 「命令是否已交付」，不看文档模式，因此任何写像素的命令都能落进去，写出该模式无法表达的
//! 颜色。实测记录（`verification.md`「跨域命令门的实测依据」，可由
//! `tests/features/modes/wasm-smoke.mjs` 的门禁步骤复现）：
//!
//! - 索引色文档上 `paint.stroke` 留下 **35 种颜色表之外的颜色**；
//! - 位图文档上 `paint.stroke` 留下 **35 个非黑白像素**；
//! - 两者**跨保存 → 重开逐像素保留**，文档模式却仍是 `Indexed`/`Bitmap`。
//!
//! 面板的 `modeToolAvailability` 只提示，不能拒绝；真正的限制必须在内核这一层，否则快捷键、
//! 命令面板与宿主脚本都能绕过界面提示。
//!
//! ## 判据是「写进去的东西该模式能不能表达」
//!
//! 不是「索引色禁止绘制」这种粗糙规则——那样会连掩版、选区与几何操作一起挡掉。实测确认：
//!
//! | 模式 | 能否表达任意写入 | 结论 |
//! | --- | --- | --- |
//! | 索引色 | 否：抗锯齿边缘本身就出表，且内核不量化 | 拒绝写颜色的命令 |
//! | 位图 | 否：只有黑白两点合法 | 拒绝写颜色的命令 |
//! | 灰度 | 是：上游把彩色收敛为灰阶（实测 `nonGray=0`） | 不拒 |
//! | 双色调 | 是：同样收敛为灰阶再由油墨映射（实测 `nonGray=0`） | 不拒 |
//! | RGB / 范围外颜色模型 | — | 不拒（本域不判定） |
//!
//! 掩版（`target: "mask"`）、通道目标、选区、图层结构、几何变换、读取类命令**永不拒绝**：
//! 它们不引入新的像素颜色。实测确认这三类在索引色/位图文档上仍然可用。
//!
//! ## 与面板矩阵的关系
//!
//! `packages/editor/src/features/modes/mode-data.ts` 的矩阵是**界面提示**（哪些工具建议别用），
//! 这里是**内核事实**（哪些命令会被拒绝）。两者共读
//! `packages/protocol/src/features/modes/gate-fixtures.json`，由两端测试逐项核对，因此不会
//! 出现「界面说可用、内核拒绝」或反向的错配。
//!
//! ## 覆盖范围
//!
//! 门禁挂在**所有写入口**，不只是 `Editor::execute`：
//!
//! - 命令分派（`editor::execute`）；
//! - 笔迹预览（`begin_stroke`，否则用户画完一笔才在提交时被拒）；
//! - 文字草稿（`begin_text`）与滤镜草稿（`begin_filter`）——它们走各自的 scratch 会话，
//!   不经命令分派。

use photocraft_doc::ColorMode;
use serde_json::Value;

use crate::error::{EditorError, Result};

/// 画面写入被拒绝的模式（与 `gate-fixtures.json::closedByMode` 的键一致）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Restriction {
    Indexed,
    Bitmap,
}

impl Restriction {
    fn of(mode: ColorMode) -> Option<Self> {
        match mode {
            ColorMode::Indexed => Some(Restriction::Indexed),
            ColorMode::Bitmap => Some(Restriction::Bitmap),
            _ => None,
        }
    }

    /// 用户可读的拒绝原因：说明为什么不能改，并给出可执行的下一步。
    fn reason(self, id: &str) -> String {
        match self {
            Restriction::Indexed => format!(
                "当前是索引色文档：{id} 会写入颜色表之外的颜色；请先转换为 RGB 再编辑"
            ),
            Restriction::Bitmap => format!(
                "当前是位图文档：{id} 会产生非黑白像素；请先转换为灰度或 RGB 再编辑"
            ),
        }
    }
}

/// 掩版/通道目标是灰阶表面，不引入 RGB 颜色。
fn targets_gray_surface(params: &Value) -> bool {
    match params.get("target") {
        Some(Value::String(target)) => matches!(target.as_str(), "mask" | "quickMask" | "channel"),
        // 通道目标可以是对象（如 `{"channel":"red"}`）；对象形式同样不是图层像素。
        Some(Value::Object(_)) => true,
        _ => params.get("channel").is_some(),
    }
}

/// 命令是否真的会写入像素颜色。
///
/// 只列**实测确认破坏不变量**的命令族；未列出的命令一律放行（图层结构、选区、几何、读取）。
/// 保守放行是刻意的：多拒绝会让索引色文档连蒙版、裁切和图层操作都做不了。
fn writes_colour(id: &str, params: &Value) -> bool {
    if id.starts_with("paint.") {
        // `paint.*` 是画笔族（stroke/pencil/cloneStamp/healingBrush/smudge/dodge/burn/…），
        // 掩版与通道目标除外。
        return !targets_gray_surface(params);
    }
    // 滤镜按定义重采样像素，必然产生新颜色。
    if id.starts_with("filter.") {
        return true;
    }
    // 调整（含新建调整层）在索引色/位图上实测会出表或产生非黑白像素。
    if id.starts_with("image.adjustments.") || id.starts_with("layer.newAdjustmentLayer.") {
        return true;
    }
    matches!(
        id,
        "type.create"
            | "type.edit"
            | "type.rasterize"
            | "type.setStyle"
            | "edit.fillForeground"
            | "edit.fillForegroundPreserve"
            | "edit.fillBackground"
            | "edit.fillBackgroundPreserve"
            | "path.fill"
            | "path.stroke"
            | "layer.rasterize.shape"
            | "layer.rasterize.vectorMask"
            | "shape.rasterize"
    )
}

/// 在共享命令门之后、真正执行之前调用。
///
/// `doc` 是**当前活动文档**；没有活动文档时由调用方先返回 `no-document`。
pub(crate) fn check(doc: &photocraft_doc::Document, id: &str, params: &Value) -> Result<()> {
    let Some(restriction) = Restriction::of(doc.mode) else { return Ok(()) };
    if !writes_colour(id, params) {
        return Ok(());
    }
    Err(EditorError::CommandFailed {
        id: id.into(),
        message: restriction.reason(id),
    })
}

/// 门禁判定的模式清单（协议 fixture 用它核对本模块覆盖的模式）。
#[cfg(test)]
pub(crate) const RESTRICTED_MODES: &[&str] = &["indexed", "bitmap"];

#[cfg(test)]
#[path = "tests_gate.rs"]
mod tests;

#[cfg(test)]
impl Restriction {
    /// 测试用来把内核的限制清单与 fixture 的键逐项对上。
    pub(crate) fn all() -> &'static [Restriction] {
        &[Restriction::Indexed, Restriction::Bitmap]
    }
    pub(crate) fn label(self) -> &'static str {
        match self {
            Restriction::Indexed => "indexed",
            Restriction::Bitmap => "bitmap",
        }
    }
}
