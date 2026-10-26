//! 跨后端（WASM WebGL2/wgpu ↔ native wgpu）容差视觉比较
//! （change: enhance-model-scene-authoring-api，任务 9.3 / design D13）。
//!
//! 只比较**语义**指标，不以逐像素哈希相同作为通过条件：
//! - 前景包围框（framing）在容差比例内；
//! - 前景占比接近；
//! - 前景连通分量数量接近、最大分量占比均较高（主要肢体连通）；
//! - 主色（量化后）接近；
//! - 容差像素差（归一化 L1）低于阈值。
//!
//! 本模块不依赖 Bevy，输入是两张同尺寸 RGBA 缓冲区，可在无 GPU 的 CI 上单测比较逻辑；
//! 真实跨后端取图由带 GPU 的 CI/运维环境提供。
//!
//! change: 2026-10-09-refactor-large-source-files-and-remove-compatibility D02 —— 模块本身
//! 由父模块以 `#[cfg(test)]` 引入，故不再需要 `#![allow(dead_code)]`。

/// 容差阈值（可按平台收紧/放宽，但不允许「逐像素必须相同」）。
#[derive(Clone, Copy, Debug)]
pub(crate) struct ToleranceThresholds {
    /// 归一化 L1 像素差上限。
    pub(crate) max_mean_diff: f32,
    /// 前景包围框（宽/高/中心）相对偏差上限。
    pub(crate) max_bbox_relative_delta: f32,
    /// 前景占比允许的绝对偏差。
    pub(crate) max_coverage_delta: f32,
    /// 主色允许的量化距离（每通道）。
    pub(crate) max_color_distance: f32,
}

impl Default for ToleranceThresholds {
    fn default() -> Self {
        Self {
            max_mean_diff: 0.10,
            max_bbox_relative_delta: 0.12,
            max_coverage_delta: 0.05,
            max_color_distance: 0.18,
        }
    }
}

/// 单张图像的语义指标。
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct VisualMetrics {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) coverage: f32,
    pub(crate) bbox: Option<[f32; 4]>,
    pub(crate) components: u32,
    pub(crate) largest_share: f32,
    pub(crate) dominant: [f32; 3],
}

/// 一致性判定结果：`Ok(())` 或稳定的失败原因列表。
pub(crate) fn compare_visual(
    a: &[u8],
    b: &[u8],
    width: u32,
    height: u32,
    thresholds: ToleranceThresholds,
) -> Result<(), Vec<String>> {
    let expected = (width as usize) * (height as usize) * 4;
    if a.len() < expected || b.len() < expected {
        return Err(vec!["像素缓冲区尺寸不足".to_owned()]);
    }
    let mut failures = Vec::new();

    let mean_diff = mean_abs_diff(a, b, width, height);
    if mean_diff > thresholds.max_mean_diff {
        failures.push(format!("归一化像素差 {mean_diff:.3} 超过上限 {:.3}", thresholds.max_mean_diff));
    }

    let metrics_a = metrics(a, width, height);
    let metrics_b = metrics(b, width, height);

    if (metrics_a.coverage - metrics_b.coverage).abs() > thresholds.max_coverage_delta {
        failures.push(format!(
            "前景占比差异 {:.3} 超过上限 {:.3}",
            (metrics_a.coverage - metrics_b.coverage).abs(),
            thresholds.max_coverage_delta
        ));
    }

    match (metrics_a.bbox, metrics_b.bbox) {
        (Some(a_box), Some(b_box)) => {
            for index in 0..4 {
                let scale = ((a_box[index].abs() + b_box[index].abs()) / 2.0).max(1.0);
                let delta = (a_box[index] - b_box[index]).abs() / scale;
                if delta > thresholds.max_bbox_relative_delta {
                    failures.push(format!("包围框轴 {index} 相对偏差 {delta:.3} 超限"));
                }
            }
        }
        (None, None) => failures.push("两图均无前景".to_owned()),
        _ => failures.push("一图有前景、另一图没有".to_owned()),
    }

    if metrics_a.largest_share < 0.5 || metrics_b.largest_share < 0.5 {
        failures.push("主要肢体未连通（最大前景分量占比过低）".to_owned());
    }

    let color_distance = (0..3)
        .map(|index| (metrics_a.dominant[index] - metrics_b.dominant[index]).abs())
        .fold(0.0_f32, f32::max);
    if color_distance > thresholds.max_color_distance {
        failures.push(format!("主色差异 {color_distance:.3} 超限"));
    }

    if failures.is_empty() { Ok(()) } else { Err(failures) }
}

fn mean_abs_diff(a: &[u8], b: &[u8], width: u32, height: u32) -> f32 {
    let pixels = (width as usize) * (height as usize);
    if pixels == 0 {
        return 0.0;
    }
    let mut total = 0u64;
    for index in 0..pixels {
        for channel in 0..3 {
            let offset = index * 4 + channel;
            total += (a[offset] as i32 - b[offset] as i32).unsigned_abs() as u64;
        }
    }
    total as f32 / (pixels as f32 * 3.0 * 255.0)
}

fn metrics(pixels: &[u8], width: u32, height: u32) -> VisualMetrics {
    let w = width as usize;
    let h = height as usize;
    let mut mask = vec![false; w * h];
    let mut counts: std::collections::HashMap<(u8, u8, u8), u32> = std::collections::HashMap::new();
    let mut coverage = 0u32;
    let (mut min_x, mut max_x, mut min_y, mut max_y) = (w, 0usize, h, 0usize);

    for y in 0..h {
        for x in 0..w {
            let offset = (y * w + x) * 4;
            let r = pixels[offset];
            let g = pixels[offset + 1];
            let b = pixels[offset + 2];
            let max = r.max(g).max(b);
            let min = r.min(g).min(b);
            if pixels[offset + 3] > 16 && max - min > 24 {
                mask[y * w + x] = true;
                coverage += 1;
                min_x = min_x.min(x);
                max_x = max_x.max(x);
                min_y = min_y.min(y);
                max_y = max_y.max(y);
                // 4x4x4 量化直方图求主色。
                let key = (r >> 6, g >> 6, b >> 6);
                *counts.entry(key).or_insert(0) += 1;
            }
        }
    }

    let (components, largest) = connected_components(&mask, w, h);
    let dominant = counts
        .iter()
        .max_by_key(|(_, count)| **count)
        .map(|(key, _)| key)
        .map(|(r, g, b)| {
            [
                (*r as f32 * 64.0 + 32.0) / 255.0,
                (*g as f32 * 64.0 + 32.0) / 255.0,
                (*b as f32 * 64.0 + 32.0) / 255.0,
            ]
        })
        .unwrap_or([0.0, 0.0, 0.0]);

    VisualMetrics {
        width,
        height,
        coverage: coverage as f32 / (w * h).max(1) as f32,
        bbox: if coverage == 0 {
            None
        } else {
            Some([
                min_x as f32 / w as f32,
                min_y as f32 / h as f32,
                max_x as f32 / w as f32,
                max_y as f32 / h as f32,
            ])
        },
        components,
        largest_share: if coverage == 0 { 0.0 } else { largest as f32 / coverage as f32 },
        dominant,
    }
}

fn connected_components(mask: &[bool], width: usize, height: usize) -> (u32, u32) {
    let mut visited = vec![false; mask.len()];
    let mut components = 0;
    let mut largest = 0;
    let mut stack: Vec<usize> = Vec::new();
    for start in 0..mask.len() {
        if !mask[start] || visited[start] {
            continue;
        }
        components += 1;
        let mut size = 0u32;
        stack.push(start);
        visited[start] = true;
        while let Some(current) = stack.pop() {
            size += 1;
            let x = current % width;
            let y = current / width;
            let push = |neighbor: usize, stack: &mut Vec<usize>, visited: &mut Vec<bool>| {
                if mask[neighbor] && !visited[neighbor] {
                    visited[neighbor] = true;
                    stack.push(neighbor);
                }
            };
            if x > 0 { push(current - 1, &mut stack, &mut visited); }
            if x < width - 1 { push(current + 1, &mut stack, &mut visited); }
            if y > 0 { push(current - width, &mut stack, &mut visited); }
            if y < height - 1 { push(current + width, &mut stack, &mut visited); }
        }
        largest = largest.max(size);
    }
    (components, largest)
}

/// 单张图自身的基本健康检查（空白/NaN-类输出属于失败）。
pub(crate) fn assert_renderable(pixels: &[u8], width: u32, height: u32) -> Result<(), Vec<String>> {
    let metrics = metrics(pixels, width, height);
    let mut failures = Vec::new();
    if metrics.coverage < 0.001 {
        failures.push("前景占比过低（可能为空白输出）".to_owned());
    }
    if metrics.largest_share < 0.5 {
        failures.push("主要肢体未连通".to_owned());
    }
    if failures.is_empty() { Ok(()) } else { Err(failures) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(width: u32, height: u32, rgba: [u8; 4]) -> Vec<u8> {
        let mut bytes = Vec::with_capacity((width * height * 4) as usize);
        for _ in 0..(width * height) {
            bytes.extend_from_slice(&rgba);
        }
        bytes
    }

    /// 在深色背景上画一个连通的有色矩形。
    fn with_rect(width: u32, height: u32, rect: (u32, u32, u32, u32), color: [u8; 4]) -> Vec<u8> {
        let mut bytes = solid(width, height, [10, 10, 10, 255]);
        for y in rect.1..rect.3 {
            for x in rect.0..rect.2 {
                let offset = ((y * width + x) * 4) as usize;
                bytes[offset..offset + 4].copy_from_slice(&color);
            }
        }
        bytes
    }

    #[test]
    fn identical_images_pass() {
        let image = with_rect(64, 64, (16, 16, 48, 48), [200, 60, 30, 255]);
        assert!(compare_visual(&image, &image, 64, 64, ToleranceThresholds::default()).is_ok());
    }

    #[test]
    fn minor_antialiasing_differences_pass() {
        let a = with_rect(64, 64, (16, 16, 48, 48), [200, 60, 30, 255]);
        let mut b = a.clone();
        for index in (0..b.len()).step_by(4) {
            b[index] = b[index].saturating_sub(2);
        }
        assert!(compare_visual(&a, &b, 64, 64, ToleranceThresholds::default()).is_ok());
    }

    #[test]
    fn shifted_model_within_tolerance_passes() {
        let a = with_rect(64, 64, (16, 16, 48, 48), [200, 60, 30, 255]);
        let b = with_rect(64, 64, (18, 17, 50, 49), [200, 60, 30, 255]);
        assert!(compare_visual(&a, &b, 64, 64, ToleranceThresholds::default()).is_ok());
    }

    #[test]
    fn blank_output_fails() {
        let a = with_rect(64, 64, (16, 16, 48, 48), [200, 60, 30, 255]);
        let blank = solid(64, 64, [0, 0, 0, 0]);
        assert!(compare_visual(&a, &blank, 64, 64, ToleranceThresholds::default()).is_err());
        assert!(assert_renderable(&blank, 64, 64).is_err());
    }

    #[test]
    fn disconnected_limbs_fail() {
        let mut a = solid(64, 64, [10, 10, 10, 255]);
        // 三个互不相连的等大色块：任何单个分量都只占前景的 1/3。
        for (y0, x0) in [(8u32, 8u32), (8, 40), (40, 24)] {
            for y in y0..y0 + 8 {
                for x in x0..x0 + 8 {
                    let o = ((y * 64 + x) * 4) as usize;
                    a[o..o + 4].copy_from_slice(&[200, 60, 30, 255]);
                }
            }
        }
        assert!(assert_renderable(&a, 64, 64).is_err());
    }

    #[test]
    fn large_color_drift_fails() {
        let a = with_rect(64, 64, (16, 16, 48, 48), [200, 60, 30, 255]);
        let b = with_rect(64, 64, (16, 16, 48, 48), [30, 60, 200, 255]);
        assert!(compare_visual(&a, &b, 64, 64, ToleranceThresholds::default()).is_err());
    }
}
