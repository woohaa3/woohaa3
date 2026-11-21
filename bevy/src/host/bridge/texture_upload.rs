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
    if !bridge::texture_scope_legacy_allowed() {
        return Err(BoundaryError::from_str(
            "Scoped canvas requires scoped texture",
        ));
    }
    crate::wake_canvas();
    let expected_len = if !content.is_empty() && rgba.is_empty() {
        (width as usize)
            .saturating_mul(height as usize)
            .saturating_mul(4)
    } else {
        rgba.len()
    };
    protocol::validate_texture(width, height, expected_len).map_err(BoundaryError::from_str)?;
    if content.len() > 4096 {
        return Err(BoundaryError::from_str(
            "Texture content identity too large",
        ));
    }
    bridge::texture_receipts::invalidate("node", id);
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
    if !bridge::texture_scope_legacy_allowed() {
        return Err(BoundaryError::from_str(
            "Scoped canvas requires scoped texture",
        ));
    }
    protocol::validate_texture(width, height, rgba.len()).map_err(BoundaryError::from_str)?;
    if content.len() > 4096 {
        return Err(BoundaryError::from_str(
            "Texture content identity too large",
        ));
    }
    bridge::texture_receipts::invalidate("node", id);
    bridge::queue_texture_owned(
        id,
        width,
        height,
        rgba,
        (!content.is_empty()).then_some(content),
    );
    Ok(())
}

/// 原节点的源像素细节；整批校验成功才入队，空 JSON 显式清理。
#[cfg(feature = "canvas-core")]
#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn set_image_focus_details(manifest: &str, rgba: &[u8]) -> Result<(), BoundaryError> {
    if !bridge::texture_scope_legacy_allowed() {
        return Err(BoundaryError::from_str(
            "Scoped canvas requires scoped texture",
        ));
    }
    crate::wake_canvas();
    if manifest.is_empty() {
        if !rgba.is_empty() {
            return Err(BoundaryError::from_str("Unexpected focus detail pixels"));
        }
        return bridge::queue_focus_details(None, &[]).map_err(BoundaryError::from_str);
    }
    if manifest.len() > 16384 {
        return Err(BoundaryError::from_str("Focus detail manifest too large"));
    }
    let frame: protocol::focus_details::FocusDetails =
        serde_json::from_str(manifest).map_err(|e| BoundaryError::from_str(&e.to_string()))?;
    bridge::queue_focus_details(Some(frame), rgba).map_err(BoundaryError::from_str)
}

/// 上传/更新一张模型自带 RGBA 纹理（点击值 id，latest-wins）。
///
/// `model3d::model_textures` 只消费 `modeltex:` 前缀的内容；其它 id 被忽略。
#[cfg(feature = "canvas-core")]
#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn set_model_media_texture(
    id: &str,
    width: u32,
    height: u32,
    rgba: &[u8],
) -> Result<(), BoundaryError> {
    if !bridge::texture_scope_legacy_allowed() {
        return Err(BoundaryError::from_str(
            "Scoped canvas requires scoped texture",
        ));
    }
    crate::wake_canvas();
    protocol::validate_texture(width, height, rgba.len()).map_err(BoundaryError::from_str)?;
    bridge::queue_model_texture(id, width, height, rgba);

    Ok(())
}

/// Native counterpart of the owned model-texture upload entry point.
#[cfg(all(feature = "canvas-core", not(feature = "wasm")))]
pub fn set_model_media_texture_owned(
    id: &str,
    width: u32,
    height: u32,
    rgba: Vec<u8>,
) -> Result<(), BoundaryError> {
    if !bridge::texture_scope_legacy_allowed() {
        return Err(BoundaryError::from_str(
            "Scoped canvas requires scoped texture",
        ));
    }
    protocol::validate_texture(width, height, rgba.len()).map_err(BoundaryError::from_str)?;
    bridge::queue_model_texture_owned(id, width, height, rgba);

    Ok(())
}

/// Drains application receipts. Applying assets is distinct from GPU presentation.
#[cfg(feature = "canvas-core")]
#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn poll_texture_receipts() -> String {
    bridge::texture_receipts::take()
}

/// Apply presentation-only resource flags without replacing the full scene/query snapshot.
#[cfg(feature = "canvas-core")]
#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn set_resource_states(json: &str) -> Result<u32, BoundaryError> {
    if json.len() > 1024 * 1024 {
        return Err(BoundaryError::from_str("Resource state payload too large"));
    }
    let request: protocol::ResourceStateRequest =
        serde_json::from_str(json).map_err(|e| BoundaryError::from_str(&e.to_string()))?;
    let generation = crate::canvas_query::interaction::accept_resource_states(&request)
        .map_err(BoundaryError::from_str)?;
    bridge::queue_resource_states(request.nodes);
    crate::wake_canvas();
    Ok(generation)
}

pub(crate) fn parse_canvas_scope(token: &str) -> Result<u64, BoundaryError> {
    if token.is_empty() || token.len() > 20 || !token.bytes().all(|b| b.is_ascii_digit()) {
        return Err(BoundaryError::from_str("Invalid canvas scope"));
    }
    let value = token
        .parse::<u64>()
        .map_err(|_| BoundaryError::from_str("Invalid canvas scope"))?;
    if value == 0 {
        return Err(BoundaryError::from_str("Invalid canvas scope"));
    }
    Ok(value)
}

#[cfg(feature = "canvas-core")]
#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn begin_canvas_scope(canvas_id: &str) -> Result<String, BoundaryError> {
    if canvas_id.is_empty() || canvas_id.len() > 4096 {
        return Err(BoundaryError::from_str("Invalid canvas id"));
    }
    let token = bridge::begin_texture_scope(canvas_id).map_err(BoundaryError::from_str)?;
    crate::wake_canvas();
    Ok(token.to_string())
}

#[cfg(feature = "canvas-core")]
#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn end_canvas_scope(token: &str) -> Result<(), BoundaryError> {
    let token = parse_canvas_scope(token)?;
    if !bridge::end_texture_scope(token) {
        return Err(BoundaryError::from_str("Stale canvas scope"));
    }
    crate::wake_canvas();
    Ok(())
}

/// 只读查询：该画布访问（token）是否仍是本渲染器当前的访问身份。
///
/// 原生文档编辑器（桌面合成）没有 CPU 帧回调，桌面壳在合成前用 `document_editor_canvas_access`
/// 查询同一份身份；这里不改作用域、不清任何队列、不唤醒画布。非法 token 返回错误，不是当前
/// 访问返回 `false`，因此过期结果与非法输入可被调用方区分。
#[cfg(feature = "canvas-core")]
#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn canvas_scope_current(token: &str) -> Result<bool, BoundaryError> {
    let token = parse_canvas_scope(token)?;
    Ok(bridge::texture_scope_matches_token(token))
}

fn validate_scoped_texture(
    token: &str,
    width: u32,
    height: u32,
    len: usize,
    content: &str,
) -> Result<u64, BoundaryError> {
    let token = parse_canvas_scope(token)?;
    if !bridge::texture_scope_matches_token(token) {
        return Err(BoundaryError::from_str("Stale canvas scope"));
    }
    let expected_len = if !content.is_empty() && len == 0 {
        (width as usize)
            .saturating_mul(height as usize)
            .saturating_mul(4)
    } else {
        len
    };
    protocol::validate_texture(width, height, expected_len).map_err(BoundaryError::from_str)?;
    if content.len() > 4096 {
        return Err(BoundaryError::from_str(
            "Texture content identity too large",
        ));
    }
    Ok(token)
}

#[cfg(feature = "canvas-core")]
#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn set_texture_scoped(
    token: &str,
    id: &str,
    width: u32,
    height: u32,
    rgba: &[u8],
    content: &str,
) -> Result<(), BoundaryError> {
    let token = validate_scoped_texture(token, width, height, rgba.len(), content)?;
    let texture = (
        width,
        height,
        rgba.to_vec(),
        (!content.is_empty()).then(|| content.to_owned()),
    );
    if !bridge::queue_scoped_texture(token, id, texture) {
        return Err(BoundaryError::from_str("Stale canvas scope"));
    }
    bridge::texture_receipts::invalidate_scoped(token, "node", id);
    crate::wake_canvas();
    Ok(())
}

#[cfg(all(feature = "canvas-core", not(feature = "wasm")))]
pub fn set_texture_scoped_owned(
    token: &str,
    id: &str,
    width: u32,
    height: u32,
    rgba: Vec<u8>,
    content: &str,
) -> Result<(), BoundaryError> {
    let token = validate_scoped_texture(token, width, height, rgba.len(), content)?;
    let texture = (
        width,
        height,
        rgba,
        (!content.is_empty()).then(|| content.to_owned()),
    );
    if !bridge::queue_scoped_texture(token, id, texture) {
        return Err(BoundaryError::from_str("Stale canvas scope"));
    }
    bridge::texture_receipts::invalidate_scoped(token, "node", id);
    crate::wake_canvas();
    Ok(())
}

#[cfg(feature = "canvas-core")]
#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn poll_texture_receipts_scoped(token: &str) -> Result<String, BoundaryError> {
    let token = parse_canvas_scope(token)?;
    if !bridge::texture_scope_matches_token(token) {
        return Err(BoundaryError::from_str("Stale canvas scope"));
    }
    Ok(bridge::texture_receipts::take_scoped(token))
}

fn validate_scoped_model(
    token: &str,
    width: u32,
    height: u32,
    len: usize,
) -> Result<u64, BoundaryError> {
    let token = parse_canvas_scope(token)?;
    if !bridge::texture_scope_matches_token(token) {
        return Err(BoundaryError::from_str("Stale canvas scope"));
    }
    protocol::validate_texture(width, height, len).map_err(BoundaryError::from_str)?;
    Ok(token)
}

#[cfg(feature = "canvas-core")]
#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn set_model_media_texture_scoped(
    token: &str,
    id: &str,
    width: u32,
    height: u32,
    rgba: &[u8],
) -> Result<(), BoundaryError> {
    let token = validate_scoped_model(token, width, height, rgba.len())?;
    if !bridge::queue_scoped_model_texture(token, id, (width, height, rgba.to_vec())) {
        return Err(BoundaryError::from_str("Stale canvas scope"));
    }
    crate::wake_canvas();
    Ok(())
}

#[cfg(all(feature = "canvas-core", not(feature = "wasm")))]
pub fn set_model_media_texture_scoped_owned(
    token: &str,
    id: &str,
    width: u32,
    height: u32,
    rgba: Vec<u8>,
) -> Result<(), BoundaryError> {
    let token = validate_scoped_model(token, width, height, rgba.len())?;
    if !bridge::queue_scoped_model_texture(token, id, (width, height, rgba)) {
        return Err(BoundaryError::from_str("Stale canvas scope"));
    }
    crate::wake_canvas();
    Ok(())
}

#[cfg(feature = "canvas-core")]
#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn set_image_focus_details_scoped(
    token: &str,
    manifest: &str,
    rgba: &[u8],
) -> Result<(), BoundaryError> {
    let token = parse_canvas_scope(token)?;
    if !bridge::texture_scope_matches_token(token) {
        return Err(BoundaryError::from_str("Stale canvas scope"));
    }
    let frame = if manifest.is_empty() {
        if !rgba.is_empty() {
            return Err(BoundaryError::from_str("Unexpected focus detail pixels"));
        }
        None
    } else {
        if manifest.len() > 16384 {
            return Err(BoundaryError::from_str("Focus detail manifest too large"));
        }
        Some(
            serde_json::from_str(manifest)
                .map_err(|error| BoundaryError::from_str(&error.to_string()))?,
        )
    };
    bridge::queue_scoped_focus_details(token, frame, rgba).map_err(BoundaryError::from_str)?;
    crate::wake_canvas();
    Ok(())
}
