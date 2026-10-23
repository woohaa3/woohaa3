//! 矢量域核验入口（U08–U16，change: 2026-10-22-add-photocraft-vector-canvas-tools）。
//!
//! 实现放在 `inspect.rs`：该文件同时作为 crate 根部的 `vectors_inspect` 模块编译，
//! 由共享 `lib.rs` 引入 `path_bounded`（selections 与 vectors 共用同一份几何上界判断）。
//! 本文件只做装配，保证 `features::inspect_content` 仍按域取得唯一实现，不复制第二套检查。
use super::*;

pub(super) use crate::vectors_inspect::inspect;

/// 文档级矢量检查（工作路径、已存路径、裁切路径引用）。
///
/// 由共享 `lib.rs` 在 `inspect_layers(...)` 之后调用一次；实现仍在 `inspect.rs`，
/// 这里只做装配，不复制第二套检查。
pub(crate) fn inspect_document(document: &photocraft_doc::Document) -> Result<(), VerifyError> {
    crate::vectors_inspect::inspect_document(document)
}

/// **解码前**的矢量载荷累计预算（已存路径数、子路径数、锚点数）。
///
/// 由共享 `lib.rs` 在读到 `manifest.json` 之后、加载文档与像素之前调用一次，
/// 使敌意/损坏工程提前被拒，而不是先付出完整解码代价。
pub(crate) fn inspect_manifest_budget(manifest: &photocraft_format::Manifest) -> Result<(), VerifyError> {
    crate::vectors_inspect::inspect_manifest_budget(manifest)
}
