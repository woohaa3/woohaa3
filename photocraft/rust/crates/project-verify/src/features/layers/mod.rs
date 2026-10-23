use super::*;

pub(crate) mod fill_support;

pub(super) fn inspect(layer: &photocraft_doc::Layer, depth: usize, out: &mut LayerInspection, embedded_smart: bool) -> Option<Result<(), VerifyError>> {
    match &layer.content {
            LayerContent::Group(group) => Some((|| {

                // 画板是带裁切矩形与画板属性的组（U56）：结构与子层内容都要核验，不能整体拒绝，
                // 否则工程里一建画板就无法保存/校验。
                if group.artboard.is_some() {
                    out.kinds.insert("artboard".into());
                } else {
                    out.kinds.insert("group".into());
                }
                if !group.children.is_empty() {
                    inspect_layers(&group.children, depth + 1, out,embedded_smart)?;
                }

                #[allow(unreachable_code)]
                Ok(())
            })()),
            LayerContent::Fill(_) => Some((|| {
                // U57：纯色/渐变/图案填充层是可重编内容。逐参数与端点在这里检查；
                // 图案引用需要整文档资源，由 `fill_support::supported_document` 在
                // 文档级检查（见该函数的调用要求）。
                if !fill_support::shallow(layer) {
                    return Err(err(VerifyErrorCode::UnsupportedObject, "工程包含无效或超限的填充层"));
                }
                out.kinds.insert("fill".into());
                Ok(())
            })()),
        _ => None,
    }
}
