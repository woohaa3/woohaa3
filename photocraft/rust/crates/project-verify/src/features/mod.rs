//! One inspection pass and one cumulative budget across every domain and nested document.
use super::*;
pub(crate) mod files;
pub(crate) mod io;
pub(crate) mod vectors;
pub(crate) mod selections;
pub(crate) mod channels;
pub(crate) mod painting;
pub(crate) mod retouch;
pub(crate) mod adjustments;
pub(crate) mod modes;
pub(crate) mod filters;
pub(crate) mod composition;
pub(crate) mod layers;
pub(crate) mod smart;
pub(crate) mod r#type;
pub(crate) mod views;
pub(crate) mod customization;
pub(crate) mod history;
pub(crate) mod animation;

type Inspect = fn(&photocraft_doc::Layer, usize, &mut LayerInspection, bool) -> Option<Result<(), VerifyError>>;
const INSPECTORS: &[Inspect] = &[
    files::inspect,
    io::inspect,
    vectors::inspect,
    selections::inspect,
    channels::inspect,
    // 视频层的内容类型仍是 `Raster`，因此必须**先**于 painting 判定：否则 `painting::inspect`
    // 会把带帧栈的视频层当作普通栅格认领，帧数/帧率/累计像素规则永远不执行
    // （change: 2026-10-22-add-photocraft-animation-workflows，B3）。
    // `animation::inspect` 对没有 `layer.video` 的图层返回 `None`，普通栅格仍落到 painting。
    animation::inspect,
    painting::inspect,
    retouch::inspect,
    adjustments::inspect,
    modes::inspect,
    filters::inspect,
    composition::inspect,
    layers::inspect,
    smart::inspect,
    r#type::inspect,
    views::inspect,
    customization::inspect,
    history::inspect,
];

/// 文档级核验钩子：`fn(&Document) -> Option<…>`。
///
/// 有些持久内容不属于任何一个图层——变量/数据集绑定在文档上（`doc.variables`）。把它塞进
/// 逐图层的 [`INSPECTORS`] 只会让同一份文档级数据被每层各检查一遍，还可能因为没有图层而
/// 完全跳过（图案库容器）。与 [`smart_source::Scope::inspect_document`] 同一形状。
type InspectDocument = fn(&photocraft_doc::Document) -> Option<Result<(), VerifyError>>;
const DOCUMENT_INSPECTORS: &[InspectDocument] = &[history::inspect_document];

/// 对整份文档跑一遍文档级检查（在图层检查之后调用）。
pub(super) fn inspect_document(document: &photocraft_doc::Document) -> Result<(), VerifyError> {
    for inspect in DOCUMENT_INSPECTORS {
        if let Some(result) = inspect(document) { return result; }
    }
    Ok(())
}
pub(super) fn inspect_content(layer: &photocraft_doc::Layer, depth: usize, out: &mut LayerInspection, embedded_smart: bool) -> Result<(), VerifyError> {
    for inspect in INSPECTORS {
        if let Some(result) = inspect(layer, depth, out, embedded_smart) { return result; }
    }
    Err(err(VerifyErrorCode::UnsupportedObject, "工程包含未开放的对象类型"))
}
