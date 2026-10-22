//! Pure preview scheduling and resolution policies, independent of GPU state.
use bevy::prelude::UVec2;

pub(super) const MAX_TEXTURE_BYTES: u64 = 128 * 1024 * 1024;

/// 卡片完全没有模型根时，最多连续占用调度槽的帧数。
///
/// 没有根就画不出内容；无限等待会让永远不出现的根长期占住两个调度槽，饿死其它卡片。
/// 根出现后表示身份变化会推进代数并重新武装，因此这里的有界等待仍可自愈。
pub(super) const AWAITING_ROOT_FRAMES: u64 = 30;

pub(super) fn fit_bytes(size: UVec2, bytes: u64) -> Option<UVec2> {
    let pixels = bytes / 4;
    if pixels == 0 { return None; }
    let requested = size.x as u64 * size.y as u64;
    if requested <= pixels { return Some(size); }
    let scale = (pixels as f64 / requested as f64).sqrt();
    let mut result = UVec2::new((size.x as f64 * scale).floor().max(1.) as u32,
        (size.y as f64 * scale).floor().max(1.) as u32);
    // Extreme aspect ratios can round their short axis up to one pixel.
    if result.x as u64 * result.y as u64 > pixels {
        if result.x >= result.y { result.x = (pixels / result.y as u64) as u32; }
        else { result.y = (pixels / result.x as u64) as u32; }
    }
    Some(result)
}

pub(super) fn retained_size(previous: UVec2, requested: UVec2, within_budget: bool) -> UVec2 {
    let old_edge = previous.max_element() as f32;
    let edge = requested.max_element() as f32;
    let old_aspect = previous.x as f32 / previous.y.max(1) as f32;
    let aspect = requested.x as f32 / requested.y.max(1) as f32;
    // Grow immediately, shrink after a 25% drop. Budget reductions and aspect
    // changes bypass hysteresis; lens framing never uses this retained size.
    if within_budget && edge <= old_edge && edge > old_edge * 0.75
        && (aspect / old_aspect - 1.0).abs() < 0.02 {
        previous
    } else { requested }
}

// Tuple: node id, static (rather than interactive), original queue age.
pub(super) fn select_views(pending: &[(String, bool, u64)], tick: u64) -> Vec<&str> {
    let mut live: Vec<_> = pending.iter().filter(|entry| !entry.1).collect();
    let mut static_views: Vec<_> = pending.iter().filter(|entry| entry.1).collect();
    static_views.sort_by(|a, b| (a.2, &a.0).cmp(&(b.2, &b.0)));
    live.sort_by(|a, b| a.0.cmp(&b.0));
    let mut selected = Vec::with_capacity(2);
    if !live.is_empty() {
        // Four consecutive frames permit upload/readiness settlement while
        // fairly sharing the interactive slot between hover and playback.
        let start = (tick / 4) as usize % live.len();
        let slots = if static_views.is_empty() { 2 } else { 1 };
        for offset in 0..slots.min(live.len()) {
            selected.push(live[(start + offset) % live.len()].0.as_str());
        }
    }
    selected.extend(static_views.iter().take(2 - selected.len()).map(|entry| entry.0.as_str()));
    selected
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn continuous_interaction_cannot_starve_static_work() {
        let queue = vec![("hover".into(), false, 0), ("playback".into(), false, 0),
            ("new".into(), true, 20), ("old".into(), true, 2)];
        let mut live = std::collections::HashSet::new();
        for tick in 0..16 {
            let selected = select_views(&queue, tick);
            assert_eq!(selected.len(), 2);
            assert_eq!(selected[1], "old");
            live.insert(selected[0]);
        }
        assert_eq!(live.len(), 2);
    }

    #[test]
    fn static_queue_is_oldest_first_and_live_only_uses_both_slots() {
        assert_eq!(select_views(&[("b".into(), true, 1), ("a".into(), true, 1),
            ("c".into(), true, 0)], 0), vec!["c", "a"]);
        assert_eq!(select_views(&[("a".into(), false, 0), ("b".into(), false, 0)], 0), vec!["a", "b"]);
        assert!(select_views(&[], 0).is_empty());
    }

    #[test]
    fn size_hysteresis_never_blocks_growth_budget_or_aspect_changes() {
        let old = UVec2::new(512, 256);
        assert_eq!(retained_size(old, UVec2::new(448, 224), true), old);
        assert_eq!(retained_size(old, UVec2::new(384, 192), true), UVec2::new(384, 192));
        assert_eq!(retained_size(old, UVec2::new(576, 288), true), UVec2::new(576, 288));
        assert_eq!(retained_size(old, UVec2::new(448, 224), false), UVec2::new(448, 224));
        assert_eq!(retained_size(old, UVec2::new(448, 448), true), UVec2::new(448, 448));
    }

    #[test]
    fn starved_root_waits_are_bounded_but_cover_normal_settling() {
        assert!(AWAITING_ROOT_FRAMES >= 8, "根正常出现前不能提前让出");
    }

    #[test]
    fn allocation_respects_remaining_bytes_including_extreme_aspects() {
        for size in [UVec2::new(2048, 2048), UVec2::new(2048, 1), UVec2::new(1, 2048)] {
            for bytes in [4, 8, 127, 4096, MAX_TEXTURE_BYTES] {
                let fit = fit_bytes(size, bytes).unwrap();
                assert!(fit.x > 0 && fit.y > 0);
                assert!(fit.x as u64 * fit.y as u64 * 4 <= bytes);
            }
        }
        assert!(fit_bytes(UVec2::ONE, 3).is_none());
    }
}
