use super::*;

pub(super) fn inspect(_layer: &photocraft_doc::Layer, _depth: usize, _out: &mut LayerInspection, _embedded_smart: bool) -> Option<Result<(), VerifyError>> {
    None
}
