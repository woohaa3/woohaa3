//! capture 离屏 Image 建立与像素读取（纯函数）
//! （change: add-reusable-bevy-shot-camera；change: 2026-10-15-add-film-set-shooting-shot-previews
//! 切到 WebGPU 后移除窗口裁剪）。

use bevy::prelude::*;

use super::constants::MAX_CAPTURE_DIMENSION;

/// 建立离屏 capture Image。
pub(crate) fn create_capture_image(
    images: &mut Assets<Image>,
    width: u32,
    height: u32,
) -> Handle<Image> {
    use bevy::render::render_resource::{Extent3d, TextureDimension, TextureFormat, TextureUsages};
    let mut image = Image::new_uninit(
        Extent3d {
            width: width.max(1),
            height: height.max(1),
            ..default()
        },
        TextureDimension::D2,
        TextureFormat::Rgba8UnormSrgb,
        bevy::asset::RenderAssetUsages::MAIN_WORLD | bevy::asset::RenderAssetUsages::RENDER_WORLD,
    );
    image.texture_descriptor.usage |= TextureUsages::COPY_SRC | TextureUsages::RENDER_ATTACHMENT;
    images.add(image)
}

/// 从 `ScreenshotCaptured` 的 Image 提取 RGBA；处理 BGRA 交换与行填充。
pub fn rgba_from_image(image: &Image, width: u32, height: u32) -> Option<Vec<u8>> {
    use bevy::render::render_resource::TextureFormat;
    if width == 0 || height == 0 || width > MAX_CAPTURE_DIMENSION || height > MAX_CAPTURE_DIMENSION
    {
        return None;
    }
    let expected = (width as usize) * (height as usize) * 4;
    let data = image.data.as_ref()?;
    if data.len() < expected {
        return None;
    }
    let mut rgba = data[..expected].to_vec();
    match image.texture_descriptor.format {
        TextureFormat::Rgba8Unorm | TextureFormat::Rgba8UnormSrgb => {}
        TextureFormat::Bgra8Unorm | TextureFormat::Bgra8UnormSrgb => {
            #[allow(clippy::chunks_exact_to_as_chunks)]
            for pixel in rgba.chunks_exact_mut(4) {
                pixel.swap(0, 2);
            }
        }
        _ => return None,
    }
    // Capture 相机强制不透明清屏；全透明表示拿到了尚未绘制的纹理。
    // 不以 RGB 黑色判断失败，合法的黑色镜头仍应允许导出。
    if rgba.chunks_exact(4).all(|pixel| pixel[3] == 0) {
        return None;
    }
    Some(rgba)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn image(pixel: [u8; 4]) -> Image {
        Image::new(
            bevy::render::render_resource::Extent3d {
                width: 1,
                height: 1,
                depth_or_array_layers: 1,
            },
            bevy::render::render_resource::TextureDimension::D2,
            pixel.to_vec(),
            bevy::render::render_resource::TextureFormat::Rgba8UnormSrgb,
            bevy::asset::RenderAssetUsages::MAIN_WORLD,
        )
    }
    #[test]
    fn rejects_unrendered_transparent_texture_but_accepts_opaque_black() {
        assert!(rgba_from_image(&image([0, 0, 0, 0]), 1, 1).is_none());
        assert_eq!(
            rgba_from_image(&image([0, 0, 0, 255]), 1, 1),
            Some(vec![0, 0, 0, 255])
        );
    }
}
