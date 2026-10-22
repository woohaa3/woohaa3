//! 拍摄镜头卡片预览的纯调度与预算策略
//! （change: 2026-10-15-add-film-set-shooting-shot-previews，design D7）。
//!
//! 这里只做**可判定、可单测**的纯函数：尺寸分档、像素预算、串行采样选择与 LRU 淘汰顺序。
//! 不依赖 GPU、ECS、窗口或 wasm，因此可在任意 CI 容器回归调度与预算边界；
//! 真实纹理内容与帧率仍由具备真实 GPU 的人工验收采集，测试不得用估算值冒充。
//!
//! 常量是首版目视值（design D7）：最长边 1024、最多 16 张 Image、总像素 8,388,608。
//! 真实 GPU 验收后如需调整，必须同步记录常量、依据与边界回归。

use bevy::prelude::UVec2;

/// 单张卡片预览的最长边上限（design D7：首版最长边 1024）。
pub(super) const MAX_EDGE: f32 = 1024.0;
/// 尺寸分档步长：避免每个滚轮像素都重新分配纹理。
pub(super) const BUCKET: f32 = 64.0;
/// 同时保留的卡片预览 GPU Image 上限。
pub(super) const MAX_IMAGES: usize = 16;
/// 全部卡片预览 Image 的总像素预算（4 字节/像素）。
pub(super) const MAX_PIXELS: u64 = 8_388_608;
/// 可见 dirty 候选有界去重后的上限；超出的候选按队列年龄延后。
pub(super) const MAX_CANDIDATES: usize = 32;

/// 屏外卡片按需保持休眠；播放或显式捕捉需要 rig，与卡片是否可见无关。
pub(super) fn needs_rig(visible: bool, live: bool, capturing: bool) -> bool {
    visible || live || capturing
}

/// 缩放/尺寸输入停止变化 200ms 后才切换纹理档位。
pub(super) const RESIZE_SETTLE_SECONDS: f64 = 0.2;

#[derive(Default)]
pub(super) struct ResizeDebounce {
    input: Option<[u32; 4]>,
    changed_at: f64,
    pub(super) pending: bool,
}

impl ResizeDebounce {
    /// 输入包含内容框宽高、zoom、DPR；同档内的连续滚轮也会延后重建。
    pub(super) fn update(
        &mut self, input: [f32; 4], requested: UVec2, current: UVec2, now: f64,
    ) -> UVec2 {
        let input = input.map(f32::to_bits);
        if self.input != Some(input) {
            self.input = Some(input);
            self.changed_at = now;
        }
        self.pending = requested != current
            && now - self.changed_at + 1e-9 < RESIZE_SETTLE_SECONDS;
        if self.pending { current } else { requested }
    }
}

/// 由卡片内容区尺寸、画布缩放与设备像素比派生目标纹理尺寸。
///
/// 按最长边分档并统一 cap，保持宽高比；非法输入回退 1 像素档，绝不产生 0/NaN。
pub(super) fn target_size(width: f32, height: f32, zoom: f32, pixel_ratio: f32) -> UVec2 {
    let positive = |value: f32| {
        if value.is_finite() && value > 0.0 {
            value
        } else {
            1.0
        }
    };
    let width = positive(width);
    let height = positive(height);
    let edge = width.max(height);
    let scale = positive(zoom) * positive(pixel_ratio);
    let target_edge = ((edge * scale / BUCKET).ceil() * BUCKET).clamp(BUCKET, MAX_EDGE);
    UVec2::new(
        (width / edge * target_edge).ceil().clamp(1.0, MAX_EDGE) as u32,
        (height / edge * target_edge).ceil().clamp(1.0, MAX_EDGE) as u32,
    )
}

/// 把目标尺寸收缩到剩余像素预算内（保持比例）；预算不足 1 像素时返回 `None`。
pub(super) fn fit_pixels(size: UVec2, pixels: u64) -> Option<UVec2> {
    if pixels == 0 {
        return None;
    }
    let requested = size.x as u64 * size.y as u64;
    if requested <= pixels {
        return Some(size);
    }
    let scale = (pixels as f64 / requested as f64).sqrt();
    let mut result = UVec2::new(
        (size.x as f64 * scale).floor().max(1.0) as u32,
        (size.y as f64 * scale).floor().max(1.0) as u32,
    );
    // 极端宽高比下短边可能上取整到 1 像素；再收敛一次保证总像素不超预算。
    if result.x as u64 * result.y as u64 > pixels {
        if result.x >= result.y {
            result.x = (pixels / result.y.max(1) as u64).max(1) as u32;
        } else {
            result.y = (pixels / result.x.max(1) as u64).max(1) as u32;
        }
    }
    Some(result)
}

/// 一个待采样的可见 dirty 候选。
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Candidate {
    pub(super) id: String,
    /// 是否为当前活动动态卡片（活动目标优先）。
    pub(super) live: bool,
    /// 首次进入队列的 tick（年龄越小越优先排空）。
    pub(super) waiting_since: u64,
    /// 最近一次被采样/发布的 tick（LRU 用）。
    pub(super) last_touched: u64,
}

/// 选出本帧唯一要推进的采样目标。
///
/// 活动目标优先（确定性按 id 排序，不依赖 HashMap 顺序）；否则排空等待最久的封面。
/// 返回 `None` 表示本帧无需任何采样。首版全局每帧至多一个拍摄取景采样任务。
pub(super) fn select(candidates: &[Candidate]) -> Option<&Candidate> {
    let oldest = |a: &&Candidate, b: &&Candidate| {
        (a.waiting_since, &a.id).cmp(&(b.waiting_since, &b.id))
    };
    candidates
        .iter()
        .filter(|candidate| candidate.live)
        .min_by(oldest)
        .or_else(|| candidates.iter().min_by(oldest))
}

/// 有界去重：候选超过上限时保留活动目标与最老的等待者，其余延后。
pub(super) fn bound_candidates(mut candidates: Vec<Candidate>) -> Vec<Candidate> {
    if candidates.len() <= MAX_CANDIDATES {
        return candidates;
    }
    candidates.sort_by(|a, b| {
        (!a.live, a.waiting_since, &a.id).cmp(&(!b.live, b.waiting_since, &b.id))
    });
    candidates.truncate(MAX_CANDIDATES);
    candidates
}

/// 卡片层是否需要重写：表示身份或层并集任一变化即为过期（纯判定，便于无 GPU 回归）。
///
/// 表示身份来自 `ModelVisuals::quality_identity`（质量变体 + 表示代数）。根重建（内容/批处理/
/// 聚焦策略变化）会重建根实体，新实体只带主画布层；每次重建都会推进表示代数，因此重建后必然
/// 判为过期并重新并入卡片层，卡片相机才不会看不到所属片场（失效规则与 `model_preview` 一致，
/// design D7）。
pub(super) fn owner_layers_stale(
    known: Option<&(String, Vec<usize>)>,
    identity: &str,
    layers: &[usize],
) -> bool {
    !known.is_some_and(|(known_identity, known_layers)| {
        known_identity.as_str() == identity && known_layers.as_slice() == layers
    })
}

/// 在给定总像素与数量下需要淘汰的卡片数量（按 LRU 顺序，优先淘汰非活动）。
///
/// 输入为 `(id, live, last_touched, pixels)`；返回要回收的 id 列表，顺序为「最先回收」。
/// 单张卡片的像素已按 `fit_pixels` 收敛，因此淘汰到剩余预算为止。绝不淘汰活动目标，
/// 除非只剩活动目标（此时保留最后一个，避免采不到任何画面）。
pub(super) fn evictions(entries: &[(String, bool, u64, u64)], max_images: usize, max_pixels: u64) -> Vec<String> {
    // 只淘汰非活动目标；活动目标始终保留（宁可暂时超预算，也不丢活动画面）。
    let mut order: Vec<&(String, bool, u64, u64)> =
        entries.iter().filter(|entry| !entry.1).collect();
    order.sort_by(|a, b| (a.2, &a.0).cmp(&(b.2, &b.0)));
    let mut count = entries.len();
    let mut pixels = entries.iter().map(|entry| entry.3).sum::<u64>();
    let mut evicted = Vec::new();
    for entry in order {
        if count <= max_images && pixels <= max_pixels {
            break;
        }
        count -= 1;
        pixels = pixels.saturating_sub(entry.3);
        evicted.push(entry.0.clone());
    }
    evicted
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(id: &str, live: bool, waiting_since: u64) -> Candidate {
        Candidate {
            id: id.to_owned(),
            live,
            waiting_since,
            last_touched: 0,
        }
    }

    #[test]
    fn resize_waits_for_quiet_input_even_inside_same_bucket() {
        let mut debounce = ResizeDebounce::default();
        let old = UVec2::new(256, 144);
        let new = UVec2::new(512, 288);
        assert_eq!(debounce.update([208., 117., 2., 1.], new, old, 0.), old);
        assert_eq!(debounce.update([208., 117., 2.01, 1.], new, old, 0.15), old);
        assert_eq!(debounce.update([208., 117., 2.01, 1.], new, old, 0.34), old);
        assert!(debounce.pending);
        assert_eq!(debounce.update([208., 117., 2.01, 1.], new, old, 0.35), new);
        assert!(!debounce.pending);
        // 回到当前档位直接取消待调整任务。
        assert_eq!(debounce.update([208., 117., 1., 1.], old, old, 0.36), old);
        assert!(!debounce.pending);
    }

    #[test]
    fn target_size_buckets_and_caps_longest_edge() {
        // DPR/zoom 放大后仍保留比例并按最长边 cap。
        let size = target_size(240.0, 135.0, 2.0, 2.0);
        assert!(size.x <= 1024 && size.y <= 1024);
        assert!((size.x as f32 / size.y as f32 - 240.0 / 135.0).abs() < 0.05);
        // 相邻缩放落在同一档，避免每像素重分配。
        assert_eq!(
            target_size(240.0, 135.0, 1.0, 1.0),
            target_size(240.0, 135.0, 1.02, 1.0)
        );
        // 非法输入不产生 0/NaN。
        for value in [0.0, -1.0, f32::NAN, f32::INFINITY] {
            let size = target_size(value, value, value, value);
            assert!(size.x > 0 && size.y > 0 && size.x <= 1024 && size.y <= 1024);
        }
    }

    #[test]
    fn fit_pixels_respects_budget_including_extreme_aspects() {
        for size in [UVec2::new(1024, 1024), UVec2::new(1024, 1), UVec2::new(1, 1024)] {
            for pixels in [1u64, 4, 1000, MAX_PIXELS] {
                let fit = fit_pixels(size, pixels).unwrap();
                assert!(fit.x > 0 && fit.y > 0);
                assert!(fit.x as u64 * fit.y as u64 <= pixels);
            }
        }
        assert!(fit_pixels(UVec2::ONE, 0).is_none());
    }

    #[test]
    fn selection_prefers_active_then_oldest_cover() {
        let queue = vec![
            candidate("new", false, 20),
            candidate("old", false, 2),
            candidate("play", true, 0),
        ];
        assert_eq!(select(&queue).unwrap().id, "play");
        let covers = vec![candidate("new", false, 20), candidate("old", false, 2)];
        assert_eq!(select(&covers).unwrap().id, "old");
        assert!(select(&[]).is_none());
        // 同年龄按 id 稳定，不依赖 HashMap 顺序。
        let tied = vec![candidate("b", false, 1), candidate("a", false, 1)];
        assert_eq!(select(&tied).unwrap().id, "a");
    }

    #[test]
    fn candidate_queue_is_bounded_and_keeps_live_and_oldest() {
        let mut queue: Vec<Candidate> = (0..MAX_CANDIDATES as u64 + 5)
            .map(|index| candidate(&format!("c{index}"), false, index))
            .collect();
        queue.push(candidate("live", true, 999));
        let bounded = bound_candidates(queue);
        assert_eq!(bounded.len(), MAX_CANDIDATES);
        assert!(bounded.iter().any(|entry| entry.id == "live"));
        assert!(bounded.iter().any(|entry| entry.id == "c0"));
        assert!(!bounded.iter().any(|entry| entry.id == "c36"));
    }

    #[test]
    fn card_layers_are_rewritten_after_root_rebuild() {
        let layers = vec![40usize];
        // 首次下发：无缓存即过期。
        assert!(owner_layers_stale(None, "Medium:1", &layers));
        // 表示身份与层并集都未变：跳过重复写入。
        assert!(!owner_layers_stale(
            Some(&("Medium:1".to_owned(), layers.clone())),
            "Medium:1",
            &layers
        ));
        // 根重建（表示代数推进）：必须重写，否则卡片相机看不到所属片场、采样画面变空白。
        assert!(owner_layers_stale(
            Some(&("Medium:1".to_owned(), layers.clone())),
            "Medium:2",
            &layers
        ));
        // 层并集变化（新增/移除卡片）：重写。
        assert!(owner_layers_stale(
            Some(&("Medium:1".to_owned(), layers.clone())),
            "Medium:1",
            &[40usize, 41]
        ));
    }

    #[test]
    fn eviction_drops_oldest_inactive_first_and_keeps_active() {
        let entries: Vec<(String, bool, u64, u64)> = (0..MAX_IMAGES)
            .map(|index| (format!("c{index}"), false, index as u64, 200_000))
            .collect();
        // 数量与像素都未超预算：不淘汰。
        assert!(evictions(&entries, MAX_IMAGES, MAX_PIXELS).is_empty());
        // 超出总像素：从最老的开始回收，直到进入预算。
        let evicted = evictions(&entries, MAX_IMAGES, 200_000 * 4);
        assert_eq!(evicted.len(), MAX_IMAGES - 4);
        assert_eq!(evicted[0], "c0");
        // 活动目标不被回收。
        let mut with_live = entries.clone();
        with_live[0].1 = true;
        let evicted = evictions(&with_live, 1, 200_000);
        assert!(!evicted.contains(&"c0".to_owned()));
    }
}


#[cfg(test)]
mod capture_demand_tests {
    use super::*;
    #[test]
    fn offscreen_capture_and_playback_require_rigs_but_idle_cards_do_not() {
        assert!(!needs_rig(false, false, false));
        assert!(needs_rig(true, false, false));
        assert!(needs_rig(false, true, false));
        assert!(needs_rig(false, false, true));
    }

    #[test]
    fn pinned_offscreen_capture_survives_budget_eviction() {
        let entries = vec![
            ("capture".into(), true, 0, 100),
            ("idle".into(), false, 1, 100),
        ];
        assert_eq!(evictions(&entries, 1, 100), vec!["idle".to_string()]);
    }
}
