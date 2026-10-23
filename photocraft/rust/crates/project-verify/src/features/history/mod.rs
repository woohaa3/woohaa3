//! 历史/动作/数据驱动域的工程核验贡献
//! （change: 2026-10-22-add-photocraft-history-automation-workflows）。
//!
//! 本域**没有**逐图层的工程内容需要核验：
//!
//! - 历史状态与命名快照是**会话**数据，不进 `.pcraft`；打开工程时不还原别人的撤销栈；
//! - 动作、动作集与 ATN 属于会话/偏好，不是文档内容；
//! - 批处理队列是前台临时态，收尾即释放。
//!
//! 变量与数据集是**文档级** `doc.variables`（不是图层对象），因此走
//! [`inspect_document`]：逐图层钩子没有对应分支可写，硬塞进 `INSPECTORS` 只会得到
//! 「每层都检查一遍同一份文档级数据」的重复与错位。文档级钩子与
//! `smart_source::Scope::inspect_document` 同一形状，由 `lib.rs` 在图层检查之后调用。

use super::*;

/// 本域不认领任何图层内容类型：历史/动作/数据集都不以身图层形式持久化。
pub(super) fn inspect(
    _layer: &photocraft_doc::Layer,
    _depth: usize,
    _out: &mut LayerInspection,
    _embedded_smart: bool,
) -> Option<Result<(), VerifyError>> {
    None
}

/// 变量与数据集的数量上限（与内核预算 `features::history::data` 一致）。
const MAX_VARIABLES: usize = 256;
const MAX_DATA_SETS: usize = 1024;
const MAX_VALUES_PER_SET: usize = 512;

/// 文档级核验：变量必须绑定到存在且种类相容的图层，数据集必须落在预算内。
///
/// 上游 `image.variables.define` 只检查图层**存在**：把文字替换变量绑到像素层会「定义成功」，
/// 应用数据集时按图层内容跳过——工程里于是躺着一个永远不生效的变量。打开别人的工程时，
/// 核验器是唯一能拦住它的地方。
pub(super) fn inspect_document(
    document: &photocraft_doc::Document,
) -> Option<Result<(), VerifyError>> {
    let variables = &document.variables;
    if variables.is_empty() {
        return None;
    }
    if variables.defs.len() > MAX_VARIABLES {
        return Some(Err(err(
            VerifyErrorCode::InvalidManifest,
            format!("工程变量数量超过上限：{} > {MAX_VARIABLES}", variables.defs.len()),
        )));
    }
    if variables.data_sets.len() > MAX_DATA_SETS {
        return Some(Err(err(
            VerifyErrorCode::InvalidManifest,
            format!("工程数据集数量超过上限：{} > {MAX_DATA_SETS}", variables.data_sets.len()),
        )));
    }
    for (index, def) in variables.defs.iter().enumerate() {
        if def.name.trim().is_empty() {
            return Some(Err(err(VerifyErrorCode::InvalidManifest, "工程变量缺少名称")));
        }
        if variables.defs.iter().take(index).any(|other| other.name == def.name) {
            return Some(Err(err(
                VerifyErrorCode::InvalidManifest,
                format!("工程变量重名：`{}`", def.name),
            )));
        }
        let Some(layer) = document.layer(def.layer) else {
            return Some(Err(err(
                VerifyErrorCode::InvalidManifest,
                format!("变量 `{}` 指向不存在的图层", def.name),
            )));
        };
        let ok = match (&def.kind, &layer.content) {
            (photocraft_doc::variables::VarKind::Visibility, _) => true,
            (photocraft_doc::variables::VarKind::TextReplacement, LayerContent::Text(_)) => true,
            (photocraft_doc::variables::VarKind::PixelReplacement { .. }, LayerContent::Raster(_))
            | (photocraft_doc::variables::VarKind::PixelReplacement { .. }, LayerContent::Smart(_)) => true,
            _ => false,
        };
        if !ok {
            return Some(Err(err(
                VerifyErrorCode::UnsupportedObject,
                format!("变量 `{}` 的种类与其图层内容不相容", def.name),
            )));
        }
    }
    for set in &variables.data_sets {
        if set.name.trim().is_empty() {
            return Some(Err(err(VerifyErrorCode::InvalidManifest, "工程数据集缺少名称")));
        }
        if set.values.len() > MAX_VALUES_PER_SET {
            return Some(Err(err(
                VerifyErrorCode::InvalidManifest,
                format!(
                    "数据集 `{}` 的取值数量超过上限：{} > {MAX_VALUES_PER_SET}",
                    set.name,
                    set.values.len()
                ),
            )));
        }
        for value in &set.values {
            let Some(def) = variables.def(&value.variable) else {
                return Some(Err(err(
                    VerifyErrorCode::InvalidManifest,
                    format!("数据集 `{}` 引用了未定义的变量 `{}`", set.name, value.variable),
                )));
            };
            let matched = matches!(
                (&def.kind, &value.value),
                (photocraft_doc::variables::VarKind::Visibility, photocraft_doc::variables::Value::Visibility(_))
                    | (photocraft_doc::variables::VarKind::TextReplacement, photocraft_doc::variables::Value::Text(_))
                    | (photocraft_doc::variables::VarKind::PixelReplacement { .. }, photocraft_doc::variables::Value::Pixels(_))
            );
            if !matched {
                return Some(Err(err(
                    VerifyErrorCode::UnsupportedObject,
                    format!(
                        "数据集 `{}` 的变量 `{}` 取值种类与定义不相容",
                        set.name, value.variable
                    ),
                )));
            }
        }
    }
    Some(Ok(()))
}
