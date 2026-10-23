use super::*;

pub(super) fn inspect(layer: &photocraft_doc::Layer, _depth: usize, out: &mut LayerInspection, _embedded_smart: bool) -> Option<Result<(), VerifyError>> {
    match &layer.content {
            LayerContent::Raster(_) => Some((|| {

                out.kinds.insert("raster".into());

                #[allow(unreachable_code)]
                Ok(())
            })()),
        _ => None,
    }
}
