use super::*;

pub(super) fn inspect(layer: &photocraft_doc::Layer, _depth: usize, out: &mut LayerInspection, _embedded_smart: bool) -> Option<Result<(), VerifyError>> {
    match &layer.content {
            LayerContent::Adjustment(adjustment) => Some((|| {

                out.kinds.insert("adjustment".into());
                inspect_adjustment(adjustment)?;

                #[allow(unreachable_code)]
                Ok(())
            })()),
        _ => None,
    }
}
