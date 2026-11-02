//! Validated texture upload entry points; native bodies move, borrowed WASM pixels copy.

use crate::{BoundaryError, bridge, protocol};
#[cfg(feature = "wasm")]
use wasm_bindgen::prelude::*;

/// 上传/更新一张 RGBA 纹理；按 node ID 合并，latest-wins。
///
/// `content` 是稳定内容身份（`sourceKey`），Rust 侧按「内容 + 尺寸」共享同一 `Image`，
/// 避免 1000 个节点重复上传同一资产（change: 2026-10-23-scale-canvas-media-residency，
/// design D4 / 任务 4.4）。传空串表示没有稳定内容身份（独占纹理）。
#[cfg(feature = "canvas-core")]
#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn set_texture(
    id: &str,
    width: u32,
    height: u32,
    rgba: &[u8],
    content: &str,
) -> Result<(), BoundaryError> {
    crate::wake_canvas();
    protocol::validate_texture(width, height, rgba.len()).map_err(BoundaryError::from_str)?;
    if content.len() > 4096 {
        return Err(BoundaryError::from_str("Texture content identity too large"));
    }
    bridge::texture_receipts::invalidate("node",id);
    bridge::queue_texture(
        id,
        width,
        height,
        rgba,
        (!content.is_empty()).then_some(content),
    );
    Ok(())
}

/// Native upload boundary: validate before moving the HTTP body into the inbox.
/// The borrowed WASM entry point keeps its required copy out of WASM memory.
#[cfg(all(feature = "canvas-core", not(feature = "wasm")))]
pub fn set_texture_owned(
    id: &str,
    width: u32,
    height: u32,
    rgba: Vec<u8>,
    content: &str,
) -> Result<(), BoundaryError> {
    protocol::validate_texture(width, height, rgba.len()).map_err(BoundaryError::from_str)?;
    if content.len() > 4096 {
        return Err(BoundaryError::from_str("Texture content identity too large"));
    }
    bridge::texture_receipts::invalidate("node",id);
    bridge::queue_texture_owned(id, width, height, rgba, (!content.is_empty()).then_some(content));
    Ok(())
}

/// 原节点的源像素细节；整批校验成功才入队，空 JSON 显式清理。
#[cfg(feature = "canvas-core")]
#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn set_image_focus_details(manifest:&str,rgba:&[u8])->Result<(),BoundaryError> {
    crate::wake_canvas();
    if manifest.is_empty() {
        if !rgba.is_empty() {return Err(BoundaryError::from_str("Unexpected focus detail pixels"));}
        return bridge::queue_focus_details(None,&[]).map_err(BoundaryError::from_str);
    }
    if manifest.len()>16384 {return Err(BoundaryError::from_str("Focus detail manifest too large"));}
    let frame:protocol::focus_details::FocusDetails=serde_json::from_str(manifest).map_err(|e|BoundaryError::from_str(&e.to_string()))?;
    bridge::queue_focus_details(Some(frame),rgba).map_err(BoundaryError::from_str)
}

/// 上传/更新一张片场媒体平面 RGBA 纹理（键为全局唯一 `planeId`，latest-wins）
/// （change: 2026-10-08-make-film-set-model-only，design D5）。
#[cfg(feature = "canvas-core")]
#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn set_model_media_texture(
    id: &str,
    width: u32,
    height: u32,
    rgba: &[u8],
) -> Result<(), BoundaryError> {
    crate::wake_canvas();
    protocol::validate_texture(width, height, rgba.len()).map_err(BoundaryError::from_str)?;
    bridge::texture_receipts::invalidate("plane",id);
    bridge::queue_film_set_texture(id, width, height, rgba);
    Ok(())
}

/// Native counterpart of the borrowed media-plane upload entry point.
#[cfg(all(feature = "canvas-core", not(feature = "wasm")))]
pub fn set_model_media_texture_owned(
    id: &str,
    width: u32,
    height: u32,
    rgba: Vec<u8>,
) -> Result<(), BoundaryError> {
    protocol::validate_texture(width, height, rgba.len()).map_err(BoundaryError::from_str)?;
    bridge::texture_receipts::invalidate("plane",id);
    bridge::queue_film_set_texture_owned(id, width, height, rgba);
    Ok(())
}

/// Drains application receipts. Applying assets is distinct from GPU presentation.
#[cfg(feature = "canvas-core")]
#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn poll_texture_receipts() -> String { bridge::texture_receipts::take() }

/// Apply presentation-only resource flags without replacing the full scene/query snapshot.
#[cfg(feature = "canvas-core")]
#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn set_resource_states(json: &str) -> Result<u32, BoundaryError> {
    if json.len() > 1024 * 1024 { return Err(BoundaryError::from_str("Resource state payload too large")); }
    let request: protocol::ResourceStateRequest = serde_json::from_str(json).map_err(|e| BoundaryError::from_str(&e.to_string()))?;
    let generation = crate::canvas_query::interaction::accept_resource_states(&request).map_err(BoundaryError::from_str)?;
    bridge::queue_resource_states(request.nodes);
    crate::wake_canvas();
    Ok(generation)
}
