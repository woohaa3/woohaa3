use super::*;

pub(super) fn inspect(layer: &photocraft_doc::Layer, _depth: usize, out: &mut LayerInspection, embedded_smart: bool) -> Option<Result<(), VerifyError>> {
    match &layer.content {
            LayerContent::Smart(smart) => Some((|| {

                // 嵌入源由 `smart_source` 递归核验；外链源在那边拒绝。
                if !embedded_smart {return Err(err(VerifyErrorCode::UnsupportedObject, "工程包含智能对象"));}
                if out.manual_budget > limits::MAX_LAYERS {
                    return Err(err(VerifyErrorCode::TooManyLayers, "智能对象源树累计层数超限"));
                }
                out.kinds.insert("smart".into());
                let _ = smart;

                #[allow(unreachable_code)]
                Ok(())
            })()),
        _ => None,
    }
}
