//! Bounded CPU image preparation. No window, renderer, network or filesystem access.
use image::{DynamicImage, ImageDecoder, ImageReader, Rgba, RgbaImage};
use sqzer_core::codec::Decoder;
use std::io::Cursor;
use wasm_bindgen::prelude::*;

pub const MAX_COMPRESSED_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_SOURCE_PIXELS: u64 = 8192 * 8192;
/// Longest edge of a prepared variant. Must equal the top of the frontend residency tier
/// ladder (`THUMBNAIL_TIERS`, 4096) and the Bevy texture edge limit (`MAX_TEXTURE_EDGE`):
/// a card zoomed in far enough asks for the 4096 tier, and anything the decoder refuses or
/// clamps below that shows up as a visibly soft image next to the original.
pub const MAX_EDGE: u32 = 4096;
#[cfg(all(feature = "threads", target_arch = "wasm32"))]
pub use wasm_bindgen_rayon::init_thread_pool;

type Result<T> = std::result::Result<T, String>;
fn err(e: impl std::fmt::Display) -> String {
    format!("decode-failed: {e}")
}

pub fn validate_input(bytes: &[u8]) -> Result<()> {
    if bytes.is_empty() {
        return Err("empty-image".into());
    }
    if bytes.len() > MAX_COMPRESSED_BYTES {
        return Err("compressed-limit".into());
    }
    Ok(())
}

#[wasm_bindgen]
pub struct PreparedImage {
    pub width: u32,
    pub height: u32,
    pub source_width: u32,
    pub source_height: u32,
    pixels: Vec<u8>,
}
#[wasm_bindgen]
impl PreparedImage {
    /// Copy out of WASM linear memory, then transfer this owned result to the renderer.
    pub fn pixels(&self) -> Vec<u8> {
        self.pixels.clone()
    }
    /// Bounded pixel export in the prepared variant's coordinate space.
    pub fn region(
        &self,
        x: u32,
        y: u32,
        width: u32,
        height: u32,
    ) -> std::result::Result<Vec<u8>, JsValue> {
        self.read_region(x, y, width, height)
            .map_err(|e| JsValue::from_str(&e))
    }
    pub fn png(&self) -> std::result::Result<Vec<u8>, JsValue> {
        self.encode_png().map_err(|e| JsValue::from_str(&e))
    }
}
impl PreparedImage {
    pub fn into_pixels(self) -> Vec<u8> {
        self.pixels
    }
    pub fn read_region(&self, x: u32, y: u32, width: u32, height: u32) -> Result<Vec<u8>> {
        if width == 0
            || height == 0
            || width > 512
            || height > 512
            || x.checked_add(width).is_none_or(|v| v > self.width)
            || y.checked_add(height).is_none_or(|v| v > self.height)
        {
            return Err("pixel-region-limit".into());
        }
        let mut out = Vec::with_capacity((width * height * 4) as usize);
        for row in y..y + height {
            let start = ((row * self.width + x) * 4) as usize;
            out.extend_from_slice(&self.pixels[start..start + (width * 4) as usize]);
        }
        Ok(out)
    }
    pub fn encode_png(&self) -> Result<Vec<u8>> {
        use image::ImageEncoder;
        let mut out = Vec::new();
        image::codecs::png::PngEncoder::new(&mut out)
            .write_image(
                &self.pixels,
                self.width,
                self.height,
                image::ExtendedColorType::Rgba8,
            )
            .map_err(err)?;
        Ok(out)
    }
}

fn check_size(w: u32, h: u32) -> Result<()> {
    if w == 0 || h == 0 || w > 32768 || h > 32768 || u64::from(w) * u64::from(h) > MAX_SOURCE_PIXELS
    {
        return Err("source-pixel-limit".into());
    }
    Ok(())
}

/// Output is oriented, sRGB, straight-alpha RGBA8. Untagged images default to sRGB.
pub fn prepare(bytes: &[u8], max_edge: u32) -> Result<PreparedImage> {
    validate_input(bytes)?;
    if max_edge == 0 || max_edge > MAX_EDGE {
        return Err("variant-limit".into());
    }
    let avif = sqzer_codecs::avif::AvifDecoder;
    let (mut rgba, profile) = if avif.probe(bytes).is_some() {
        let (w, h) = avif.dimensions(bytes).ok_or("invalid-avif-header")?;
        check_size(w, h)?;
        let decoded = avif
            .decode(
                bytes,
                &sqzer_core::params::DecodeOpts {
                    max_pixels: MAX_SOURCE_PIXELS,
                    apply_orientation: true,
                },
            )
            .map_err(err)?;
        let decoded = decoded.to_u8(sqzer_core::codec::Format::Png).map_err(err)?;
        let profile = decoded.icc().map(Vec::from);
        let samples = decoded.samples().as_u8().ok_or("invalid-avif-samples")?;
        let mut out = Vec::with_capacity((decoded.width() * decoded.height() * 4) as usize);
        use sqzer_core::image::ColorType;
        let channels = match decoded.color() {
            ColorType::Gray => 1,
            ColorType::GrayAlpha => 2,
            ColorType::Rgb => 3,
            ColorType::Rgba => 4,
        };
        for p in samples.chunks_exact(channels) {
            match channels {
                1 => out.extend_from_slice(&[p[0], p[0], p[0], 255]),
                2 => out.extend_from_slice(&[p[0], p[0], p[0], p[1]]),
                3 => out.extend_from_slice(&[p[0], p[1], p[2], 255]),
                _ => out.extend_from_slice(p),
            }
        }
        (
            RgbaImage::from_raw(decoded.width(), decoded.height(), out).ok_or("invalid-pixels")?,
            profile,
        )
    } else {
        let mut reader = ImageReader::new(Cursor::new(bytes))
            .with_guessed_format()
            .map_err(err)?;
        let mut limits = image::Limits::default();
        limits.max_image_width = Some(32768);
        limits.max_image_height = Some(32768);
        limits.max_alloc = Some(MAX_SOURCE_PIXELS * 8);
        reader.limits(limits);
        let mut decoder = reader.into_decoder().map_err(err)?;
        let (w, h) = decoder.dimensions();
        check_size(w, h)?;
        let orientation = decoder.orientation().map_err(err)?;
        let profile = decoder.icc_profile().map_err(err)?;
        let mut decoded = DynamicImage::from_decoder(decoder).map_err(err)?;
        decoded.apply_orientation(orientation);
        (decoded.into_rgba8(), profile)
    };
    if let Some(profile) = profile {
        // Invalid or unsupported profiles fail explicitly; never silently label them sRGB.
        let source = moxcms::ColorProfile::new_from_slice(&profile).map_err(err)?;
        let transform = source
            .create_transform_8bit(
                moxcms::Layout::Rgba,
                &moxcms::ColorProfile::new_srgb(),
                moxcms::Layout::Rgba,
                moxcms::TransformOptions::default(),
            )
            .map_err(err)?;
        // Transform a row at a time rather than retaining a second full source image.
        let stride = rgba.width() as usize * 4;
        let mut row = vec![0; stride];
        for target in rgba.as_mut().chunks_exact_mut(stride) {
            row.copy_from_slice(target);
            transform.transform(&row, target).map_err(err)?;
        }
    }
    let (source_width, source_height) = rgba.dimensions();
    let scale = (max_edge as f64 / source_width.max(source_height) as f64).min(1.0);
    let width = ((source_width as f64 * scale).round() as u32).max(1);
    let height = ((source_height as f64 * scale).round() as u32).max(1);
    let pixels = if (width, height) == rgba.dimensions() {
        rgba.into_raw()
    } else {
        resize_alpha(&rgba, width, height).into_raw()
    };
    Ok(PreparedImage {
        width,
        height,
        source_width,
        source_height,
        pixels,
    })
}

/// Linear-light premultiplied filtering avoids dark or coloured transparent fringes.
fn resize_alpha(source: &RgbaImage, w: u32, h: u32) -> RgbaImage {
    let linear = |c: u8| {
        let v = c as f32 / 255.;
        if v <= 0.04045 {
            v / 12.92
        } else {
            ((v + 0.055) / 1.055).powf(2.4)
        }
    };
    let linear_values: [f32; 256] = std::array::from_fn(|i| linear(i as u8));
    let encode = |v: f32| {
        let v = v.clamp(0., 1.);
        let v = if v <= 0.0031308 {
            v * 12.92
        } else {
            1.055 * v.powf(1. / 2.4) - 0.055
        };
        (v * 255.).round() as u8
    };
    // Area integration only allocates the bounded destination, even for a 64 MP source.
    // Intermediates are premultiplied linear samples, never straight-alpha RGB averages.
    let sx = source.width() as f64 / w as f64;
    let sy = source.height() as f64 / h as f64;
    let pixel = |x: u32, y: u32| {
        let (left, right, top, bottom) = (
            x as f64 * sx,
            (x + 1) as f64 * sx,
            y as f64 * sy,
            (y + 1) as f64 * sy,
        );
        let mut sum = [0f64; 4];
        for iy in top.floor() as u32..(bottom.ceil() as u32).min(source.height()) {
            let wy = (bottom.min((iy + 1) as f64) - top.max(iy as f64)).max(0.);
            for ix in left.floor() as u32..(right.ceil() as u32).min(source.width()) {
                let weight = wy * (right.min((ix + 1) as f64) - left.max(ix as f64)).max(0.);
                let p = source.get_pixel(ix, iy);
                let a = p[3] as f64 / 255.;
                for c in 0..3 {
                    sum[c] += linear_values[p[c] as usize] as f64 * a * weight;
                }
                sum[3] += a * weight;
            }
        }
        if sum[3] <= 0. {
            Rgba([0, 0, 0, 0])
        } else {
            Rgba([
                encode((sum[0] / sum[3]) as f32),
                encode((sum[1] / sum[3]) as f32),
                encode((sum[2] / sum[3]) as f32),
                (sum[3] / (sx * sy) * 255.).round().clamp(0., 255.) as u8,
            ])
        }
    };
    #[cfg(feature = "threads")]
    {
        use rayon::prelude::*;
        let mut out = RgbaImage::new(w, h);
        out.as_mut()
            .par_chunks_exact_mut(4)
            .enumerate()
            .for_each(|(i, target)| {
                target.copy_from_slice(&pixel(i as u32 % w, i as u32 / w).0);
            });
        out
    }
    #[cfg(not(feature = "threads"))]
    {
        RgbaImage::from_fn(w, h, pixel)
    }
}

#[wasm_bindgen]
pub fn prepare_image(bytes: &[u8], max_edge: u32) -> std::result::Result<PreparedImage, JsValue> {
    prepare(bytes, max_edge).map_err(|e| JsValue::from_str(&e))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn png(pixels: Vec<u8>, w: u32, h: u32) -> Vec<u8> {
        PreparedImage {
            width: w,
            height: h,
            source_width: w,
            source_height: h,
            pixels,
        }
        .encode_png()
        .unwrap()
    }
    #[test]
    fn keeps_alpha_and_aspect() {
        let p = prepare(&png(vec![255, 0, 0, 128].repeat(8), 4, 2), 2).unwrap();
        assert_eq!(
            (p.width, p.height, p.source_width, p.source_height),
            (2, 1, 4, 2)
        );
        assert_eq!(&p.pixels[..4], &[255, 0, 0, 128]);
    }
    #[test]
    fn transparent_colour_does_not_bleed() {
        let p = prepare(&png(vec![255, 0, 0, 255, 0, 0, 255, 0], 2, 1), 1).unwrap();
        assert_eq!(&p.pixels[..3], &[255, 0, 0]);
        assert!((127..=128).contains(&p.pixels[3]));
    }
    #[test]
    fn rejects_bad_content_and_variant() {
        assert!(prepare(b"not an image", 128).is_err());
        // One past the ceiling is refused; the ceiling itself is covered below.
        assert!(prepare(&png(vec![0; 4], 1, 1), MAX_EDGE + 1).is_err());
        assert!(prepare(&png(vec![0; 4], 1, 1), 0).is_err());
        assert!(check_size(32768, 32768).is_err());
    }
    /// The residency tier ladder tops out at 4096 so a texture can follow the on-screen size
    /// of a zoomed-in card. The decoder has to be able to produce that edge, otherwise the
    /// 4096 tier silently degrades to a smaller texture and the card renders blurry.
    #[test]
    fn ceiling_matches_the_top_residency_tier() {
        assert_eq!(MAX_EDGE, 4096);
    }
    #[test]
    fn downscales_to_the_full_ceiling_not_to_the_old_2048() {
        let wide = png(vec![200, 100, 50, 255].repeat(4200 * 2), 4200, 2);
        let at_ceiling = prepare(&wide, 4096).unwrap();
        assert_eq!((at_ceiling.width, at_ceiling.source_width), (4096, 4200));
        // A smaller request still yields the smaller variant (no accidental upscaling to the ceiling).
        let at_old_limit = prepare(&wide, 2048).unwrap();
        assert_eq!(at_old_limit.width, 2048);
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub mod jobs;
