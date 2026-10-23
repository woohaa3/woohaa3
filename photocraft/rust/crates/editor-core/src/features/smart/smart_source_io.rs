//! 选中智能层的源导出与可用性：不依赖已打开的子文档会话。
//!
//! 「导出源」「替换源」「转回图层」都以**选中图层**和它自己的源为准；`smart_child.active`
//! 只表示当前打开的子会话，不能控制这些父层入口。这里的函数只读文档并返回字节，
//! 不产生历史，也不修改任何会话状态。
use crate::{EditorError, Result};
use photocraft_doc::{LayerContent, LayerId};
use photocraft_engine::Session;
use serde_json::{Value, json};

fn error(message: impl std::fmt::Display) -> EditorError {
    EditorError::CommandFailed {
        id: "layer.smartObjects.exportContents".into(),
        message: message.to_string(),
    }
}

/// 选中智能层的可用性投影。UI 用它决定按钮的可用与不可用原因，不据此推断能力已交付。
///
/// 只读：不修改文档、历史或子会话。每个不可用入口都必须带自己的原因，
/// UI 不允许「静默禁用」。
pub fn layer_state(
    session: &Session,
    layer: LayerId,
    child_layer: Option<LayerId>,
) -> Result<Value> {
    let state = session.active().ok_or(EditorError::NoDocument)?;
    let Some(target) = state.doc.layer(layer) else {
        return Ok(json!({
            "layer": layer.0,
            "smart": false,
            "canExport": false,
            "canReplace": false,
            "canConvertToLayers": false,
            "canEditContents": false,
            "childOpen": false,
            "exportReason": "目标图层不存在",
            "replaceReason": "目标图层不存在",
            "convertReason": "目标图层不存在",
            "editReason": "目标图层不存在",
            "reason": "目标图层不存在",
        }));
    };
    let LayerContent::Smart(smart) = &target.content else {
        return Ok(json!({
            "layer": layer.0,
            "smart": false,
            "canExport": false,
            "canReplace": false,
            "canConvertToLayers": false,
            "canEditContents": false,
            "childOpen": false,
            "exportReason": "请先选择智能对象图层",
            "replaceReason": "请先选择智能对象图层",
            "convertReason": "请先选择智能对象图层",
            "editReason": "请先选择智能对象图层",
            "reason": "请先选择智能对象图层",
        }));
    };
    let embedded = matches!(smart.source, photocraft_doc::SmartSource::Embedded { .. });
    let locked = state.doc.effective_locks(layer).all;
    let child_open = child_layer == Some(layer);
    let source_kind = match &smart.source {
        photocraft_doc::SmartSource::Embedded { file_name, bytes } => json!({
            "kind": "embedded",
            "fileName": file_name,
            "bytes": bytes.len(),
        }),
        photocraft_doc::SmartSource::Linked { path } => json!({
            "kind": "linked",
            "fileName": path.rsplit(['/', '\\']).next().unwrap_or(path),
        }),
    };
    // 外链与任意重链接是 NON_GOALS：入口关闭并说明，不读取外部文件。
    let linked_reason = "外链智能对象保持 NON_GOALS，仅支持嵌入源";
    let locked_reason = "图层或其父组已全部锁定，请先解锁";
    let export_reason = if embedded { "" } else { linked_reason };
    let replace_reason = if !embedded {
        linked_reason
    } else if locked {
        locked_reason
    } else {
        ""
    };
    let edit_reason = if !embedded {
        linked_reason
    } else if locked {
        locked_reason
    } else if child_open {
        "子文档已在编辑中"
    } else {
        ""
    };
    let convert_reason = crate::features::smart::unpack::convert_reason(smart, locked, child_open);
    let reason = if !embedded {
        linked_reason
    } else if !convert_reason.is_empty() {
        convert_reason.as_str()
    } else {
        edit_reason
    };
    Ok(json!({
        "layer": layer.0,
        "smart": true,
        "contentsId": smart.contents_id.0,
        "source": source_kind,
        "childOpen": child_open,
        "canExport": export_reason.is_empty(),
        "canReplace": replace_reason.is_empty(),
        "canEditContents": edit_reason.is_empty(),
        "canConvertToLayers": convert_reason.is_empty(),
        "exportReason": export_reason,
        "replaceReason": replace_reason,
        "convertReason": convert_reason,
        "editReason": edit_reason,
        "reason": reason,
    }))
}

/// 导出选中智能层的源字节（文件名 + 内容）。不要求已打开子文档，不产生历史。
///
/// 与「导出子工程」不同：后者导出的是子文档**基线**，用于冲突恢复；这里导出的是
/// 父层当前持有的源，替换/导出都以此为准。
pub fn export_source(session: &Session, layer: LayerId) -> Result<(String, Vec<u8>)> {
    let state = session.active().ok_or(EditorError::NoDocument)?;
    let target = state
        .doc
        .layer(layer)
        .ok_or_else(|| error("目标图层不存在"))?;
    let LayerContent::Smart(smart) = &target.content else {
        return Err(error("请先选择智能对象图层"));
    };
    match &smart.source {
        photocraft_doc::SmartSource::Embedded { file_name, bytes } => {
            Ok((file_name.clone(), bytes.as_ref().clone()))
        }
        photocraft_doc::SmartSource::Linked { .. } => {
            // 外链是 NON_GOAL：明确拒绝，不读取外部文件。
            Err(error("不支持外链智能对象的源导出"))
        }
    }
}
