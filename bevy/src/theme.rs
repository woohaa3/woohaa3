//! Bevy 侧主题资源（change: unify-application-theme-tokens，任务 4.1 / design D5）。
//!
//! `ThemeResource` 持有当前 `protocol::Theme`，把规范 hex 转成 Bevy `Color` / `u32`，
//! 供 2D canvas chrome 与 3D grid/material 读取。fingerprint 用于检测「仅主题变化」
//! 的更新：即使 canvas revision 未变，同一 render commit 内也要重建相关 mesh/材质。

use bevy::prelude::*;

use crate::protocol::{Theme, parse_theme_hex};

/// 当前主题资源。缺省为 generated 默认主题（scene 未携带 theme 时的兼容行为）。
#[derive(Resource, Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct ThemeResource(pub(crate) Theme);

#[cfg_attr(not(feature = "canvas-core"), allow(dead_code))]
impl ThemeResource {
    pub(crate) fn fingerprint(&self) -> &str {
        &self.0.fingerprint
    }

    /// token → `0xRRGGBB`（2D 几何用；忽略 alpha，canvas chrome token 均为不透明）。
    pub(crate) fn token_u32(&self, name: &str) -> u32 {
        let (r, g, b, _) = resolve_hex(self.0.token(name));
        ((r as u32) << 16) | ((g as u32) << 8) | b as u32
    }

    /// token → sRGB `Color`（保留 alpha；字体/材质用）。
    pub(crate) fn token_color(&self, name: &str) -> Color {
        let (r, g, b, a) = resolve_hex(self.0.token(name));
        Color::srgba_u8(r, g, b, a)
    }

    /// 画布背景清屏色。
    ///
    /// WebGPU 的 canvas 合成被 wgpu 强制为 `Opaque`（surface capabilities 只提供 Opaque），
    /// 透明清屏会呈现为黑，因此引擎必须自绘不透明背景。取 `webBackdrop` 与页面
    /// `--app-web-backdrop` 同源。
    pub(crate) fn backdrop_color(&self) -> Color {
        self.token_color("webBackdrop")
    }

    /// 节点类别 → `(强调色 u32, 浅底色 u32, 中文分类名)`（design D5 node-kind palette）。
    pub(crate) fn node_palette(&self, kind: &str) -> (u32, u32, &'static str) {
        match kind {
            "text" => (
                self.token_u32("nodeTextForeground"),
                self.token_u32("nodeTextTint"),
                "文本",
            ),
            "image" => (
                self.token_u32("nodeImageForeground"),
                self.token_u32("nodeImageTint"),
                "图片",
            ),
            "model" => (
                self.token_u32("nodeModelForeground"),
                self.token_u32("nodeModelTint"),
                "3D 模型",
            ),
            "audio" => (
                self.token_u32("nodeAudioForeground"),
                self.token_u32("nodeAudioTint"),
                "音频",
            ),
            "video" => (
                self.token_u32("nodeVideoForeground"),
                self.token_u32("nodeVideoTint"),
                "视频",
            ),
            _ => (
                self.token_u32("nodeDefaultForeground"),
                self.token_u32("nodeDefaultTint"),
                "节点",
            ),
        }
    }
}

/// 解析失败回退中性灰（防御；entry 一般已通过边界校验）。
fn resolve_hex(value: &str) -> (u8, u8, u8, u8) {
    parse_theme_hex(value).unwrap_or((204, 204, 204, 255))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_theme_has_generated_fingerprint() {
        let resource = ThemeResource::default();
        assert_eq!(
            resource.fingerprint(),
            crate::theme_generated::APP_THEME_DEFAULT_FINGERPRINT
        );
    }

    #[test]
    fn token_conversions_match_canonical_defaults() {
        let resource = ThemeResource::default();
        // #16846c
        assert_eq!(resource.token_u32("interactionAccent"), 0x16846c);
        assert_eq!(
            resource.token_color("interactionAccent"),
            Color::srgba_u8(0x16, 0x84, 0x6c, 255)
        );
    }

    /// WebGPU 下 canvas 合成被强制为 `Opaque`，透明清屏会呈现为黑；背景必须由引擎自绘，
    /// 因此清屏色取自 `webBackdrop`（与页面 `--app-web-backdrop` 同源），并跟随主题。
    #[test]
    fn backdrop_color_follows_web_backdrop_token() {
        assert_eq!(
            ThemeResource::default().backdrop_color(),
            Color::srgba_u8(0xf8, 0xfa, 0xf9, 255)
        );
        let mut next = ThemeResource::default().0.clone();
        next.tokens
            .insert("webBackdrop".to_owned(), "#010203".to_owned());
        assert_eq!(
            ThemeResource(next).backdrop_color(),
            Color::srgba_u8(1, 2, 3, 255)
        );
    }

    #[test]
    fn node_palette_reads_theme_tokens() {
        let resource = ThemeResource::default();
        assert_eq!(resource.node_palette("text").0, 0x3b7299);
        assert_eq!(resource.node_palette("image").0, 0xa45378);
        assert_eq!(resource.node_palette("unknown").0, 0x526b5e);
        assert_eq!(resource.node_palette("text").2, "文本");
    }

    /// change: unify-application-theme-tokens，任务 5.4 —— theme-only 更新覆盖各 chrome role。
    #[test]
    fn theme_only_change_updates_every_chrome_role() {
        let base = ThemeResource::default();
        let mut next = base.0.clone();
        next.fingerprint = "sentinel".to_owned();
        for (name, hex) in [
            ("canvasNodeSurface", "#010101"),
            ("canvasNodeBorderSelected", "#020202"),
            ("canvasEdgeDefault", "#030303"),
            ("canvasEdgeSelected", "#040404"),
            ("canvasProgressFill", "#050505"),
            ("canvasPortDefault", "#060606"),
            ("nodeTextForeground", "#070707"),
            ("nodeImageForeground", "#080808"),
            ("gridMinor", "#090909"),
            ("gridMajor", "#0a0a0a"),
        ] {
            next.tokens.insert(name.to_owned(), hex.to_owned());
        }
        let sentinel = ThemeResource(next);

        // node surface / border-selected / edge / progress / port / node kinds 均发生更新。
        assert_ne!(
            sentinel.token_u32("canvasNodeSurface"),
            base.token_u32("canvasNodeSurface")
        );
        assert_ne!(
            sentinel.token_u32("canvasNodeBorderSelected"),
            base.token_u32("canvasNodeBorderSelected")
        );
        assert_ne!(
            sentinel.token_u32("canvasEdgeDefault"),
            base.token_u32("canvasEdgeDefault")
        );
        assert_ne!(
            sentinel.token_u32("canvasEdgeSelected"),
            base.token_u32("canvasEdgeSelected")
        );
        assert_ne!(
            sentinel.token_u32("canvasProgressFill"),
            base.token_u32("canvasProgressFill")
        );
        assert_ne!(
            sentinel.token_u32("canvasPortDefault"),
            base.token_u32("canvasPortDefault")
        );
        assert_ne!(sentinel.node_palette("text").0, base.node_palette("text").0);
        assert_ne!(
            sentinel.node_palette("image").0,
            base.node_palette("image").0
        );
        assert_ne!(sentinel.token_u32("gridMinor"), base.token_u32("gridMinor"));
        assert_ne!(sentinel.token_u32("gridMajor"), base.token_u32("gridMajor"));
    }

    /// change: unify-application-theme-tokens，任务 4.5 / 5.4 —— authored 内容色不随主题变化。
    #[test]
    fn authored_model_colors_are_independent_of_theme() {
        // 主题模块不解析模型 authored color；模型颜色解析保持独立（见 model3d::scene::materials）。
        let base = ThemeResource::default();
        let mut next = base.0.clone();
        next.fingerprint = "sentinel".to_owned();
        next.tokens
            .insert("canvasNodeSurface".to_owned(), "#010101".to_owned());
        let sentinel = ThemeResource(next);
        // 主题 token 变了，但主题并不承载 baseColor/emissive；模型色解析仍只读 Scene IR。
        assert_ne!(sentinel.fingerprint(), base.fingerprint());
    }
}
