//! 纯视口增量 wire 协议（change: 2026-10-10-optimize-canvas-interaction-hot-path，design D3）。
//!
//! 普通 overview 仅 pan/zoom 变化时用**固定大小**的 `set_viewport` 请求替代完整 `set_scene`：
//! 请求携带明确 wire 版本、最近 full scene 的 `baseSceneGeneration` 与 `{x,y,zoom}`，返回新的
//! interaction generation。本模块只做边界级防御校验（版本/有限值/共享 zoom 区间），base 匹配、
//! overview 门禁与快照状态在 `canvas_query` 接受点原子判断。
//!
//! 本模块只依赖 `serde` 与标准库，不导入 Bevy / wasm_bindgen（与 `protocol` 其他 DTO 一致）。

use serde::Deserialize;

use super::Viewport;

/// 视口增量 wire 版本；与 contracts `CANVAS_VIEWPORT_UPDATE_VERSION` 一致，结构变化必须升版本。
pub(crate) const CANVAS_VIEWPORT_UPDATE_VERSION: &str = "woohaa-canvas-viewport-v1";

/// zoom 允许区间；与 contracts `WOOHAA3_CANVAS_MIN_ZOOM` / `MAX_ZOOM` 及 `Scene::validate` 一致。
const MIN_ZOOM: f32 = 0.1;
const MAX_ZOOM: f32 = 12.0;

/// 固定大小视口增量请求（`set_viewport` JSON 输入）。
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ViewportUpdateRequest {
    /// wire 版本；与 `CANVAS_VIEWPORT_UPDATE_VERSION` 不一致时原子拒绝。
    pub(crate) version: String,
    /// 最近 full scene 的 generation（base 身份）。与当前 full generation 不一致时拒绝。
    pub(crate) base_scene_generation: u32,
    /// 新 viewport（世界坐标平移 + zoom）。
    pub(crate) viewport: Viewport,
}

impl ViewportUpdateRequest {
    /// 边界校验：版本一致、有限值、共享 zoom 区间。错误文案稳定。
    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        if self.version != CANVAS_VIEWPORT_UPDATE_VERSION {
            return Err("Unsupported viewport update version");
        }
        validate_viewport(&self.viewport)
    }
}

pub(super) fn validate_viewport(viewport: &Viewport) -> Result<(), &'static str> {
    if ![viewport.x, viewport.y, viewport.zoom]
        .iter()
        .all(|value| value.is_finite())
    {
        return Err("Invalid viewport values");
    }
    if !(MIN_ZOOM..=MAX_ZOOM).contains(&viewport.zoom) {
        return Err("Invalid viewport zoom");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(version: &str, zoom: f32) -> ViewportUpdateRequest {
        ViewportUpdateRequest {
            version: version.to_owned(),
            base_scene_generation: 1,
            viewport: Viewport {
                x: 0.0,
                y: 0.0,
                zoom,
            },
        }
    }

    #[test]
    fn accepts_matching_version_and_finite_zoom() {
        assert!(
            request(CANVAS_VIEWPORT_UPDATE_VERSION, 1.0)
                .validate()
                .is_ok()
        );
        assert!(
            request(CANVAS_VIEWPORT_UPDATE_VERSION, MAX_ZOOM)
                .validate()
                .is_ok()
        );
        assert!(
            request(CANVAS_VIEWPORT_UPDATE_VERSION, MIN_ZOOM)
                .validate()
                .is_ok()
        );
    }

    #[test]
    fn rejects_wrong_version() {
        assert_eq!(
            request("woohaa-canvas-viewport-v0", 1.0).validate(),
            Err("Unsupported viewport update version")
        );
    }

    #[test]
    fn rejects_non_finite_and_out_of_range_zoom() {
        assert_eq!(
            request(CANVAS_VIEWPORT_UPDATE_VERSION, f32::NAN).validate(),
            Err("Invalid viewport values")
        );
        assert_eq!(
            request(CANVAS_VIEWPORT_UPDATE_VERSION, 0.0).validate(),
            Err("Invalid viewport zoom")
        );
        assert_eq!(
            request(CANVAS_VIEWPORT_UPDATE_VERSION, 99.0).validate(),
            Err("Invalid viewport zoom")
        );
    }
}
