//! 录制时间表：有理数采样时钟与末帧终点规则
//! （change: 2026-10-17-add-native-offscreen-film-set-recording，任务 3.3 / design D4）。
//!
//! 规则（与 `canvas-video-workflow` delta 一致）：
//! - N = ceil(D × F)；i ∈ 0..N-1，PTS = i / F，duration = min(1/F, D - i/F)；
//! - 第 i 帧**采样** T = i/F，最后一帧特殊处理为 T = D（呈现终点，不追加完整一帧）；
//! - 全部用整数有理数，不用浮点累加，避免长片段漂移；
//! - 渲染慢只推迟输出，不改变任何时间戳。
//!
//! 纯函数、无 Bevy 依赖：可在任何 feature 下编译与单测。

/// 有理数（分子/分母，分母恒为正）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rational {
    pub numer: u64,
    pub denom: u64,
}

impl Rational {
    /// 构造；分母为 0 时返回 `None`。
    ///
    /// 为保持常量语义不做约分：相等性判断一律走交叉相乘（见 [`Rational::eq_value`]），
    /// 测试与调用方不应依赖具体分子分母。
    pub const fn new(numer: u64, denom: u64) -> Option<Self> {
        if denom == 0 {
            return None;
        }
        Some(Self { numer, denom })
    }

    /// 按数值相等（交叉相乘），与是否约分无关。
    pub fn eq_value(self, other: Self) -> bool {
        (self.numer as u128) * (other.denom as u128) == (other.numer as u128) * (self.denom as u128)
    }

    /// 以 f64 表示（只用于传递给渲染器的秒数，不参与时间表计算）。
    pub fn as_seconds(self) -> f64 {
        self.numer as f64 / self.denom as f64
    }

    /// 向上取整的 `self * factor_numer / factor_denom`。
    pub fn ceil_scale(self, factor_numer: u64, factor_denom: u64) -> Option<u64> {
        if factor_denom == 0 {
            return None;
        }
        // (a/b) * (c/d) 向上取整 = ceil(a*c / (b*d))
        let numerator = (self.numer as u128).checked_mul(factor_numer as u128)?;
        let denominator = (self.denom as u128).checked_mul(factor_denom as u128)?;
        let result = numerator.div_ceil(denominator);
        u64::try_from(result).ok()
    }

    /// `self * factor_numer / factor_denom`，向下取整。
    pub fn floor_scale(self, factor_numer: u64, factor_denom: u64) -> Option<u64> {
        if factor_denom == 0 {
            return None;
        }
        let numerator = (self.numer as u128).checked_mul(factor_numer as u128)?;
        let denominator = (self.denom as u128).checked_mul(factor_denom as u128)?;
        u64::try_from(numerator / denominator).ok()
    }

    /// 是否严格小于 `other`（a/b < c/d ⇔ a*d < c*b，用 u128 防溢出）。
    pub fn lt(self, other: Self) -> bool {
        (self.numer as u128) * (other.denom as u128) < (other.numer as u128) * (self.denom as u128)
    }

    /// `self - other`；结果为负时返回 `None`。
    pub fn sub(self, other: Self) -> Option<Self> {
        let lhs = (self.numer as u128) * (other.denom as u128);
        let rhs = (other.numer as u128) * (self.denom as u128);
        if lhs < rhs {
            return None;
        }
        let numer = lhs - rhs;
        let denom = (self.denom as u128) * (other.denom as u128);
        let numer = u64::try_from(numer).ok()?;
        let denom = u64::try_from(denom).ok()?;
        let divisor = gcd(numer, denom);
        Some(Self {
            numer: numer / divisor,
            denom: denom / divisor,
        })
    }
}

fn gcd(a: u64, b: u64) -> u64 {
    let (mut a, mut b) = (a, b);
    while b != 0 {
        let t = a % b;
        a = b;
        b = t;
    }
    if a == 0 { 1 } else { a }
}

/// 一帧的时间表条目。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FrameSlot {
    /// 帧序号（0 起）。
    pub index: u32,
    /// 采样时刻（秒）：中间帧为 i/F，最后一帧为 D。
    pub sample: Rational,
    /// 该帧在成片里的呈现时长：min(1/F, D - i/F)。
    pub duration: Rational,
    /// 呈现时间戳 PTS：i/F。
    pub pts: Rational,
}

/// 时间表失败原因；都是**拒绝接受任务**的原因，不是运行时重试。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TimelineError {
    /// 时长必须为正且有限。
    ZeroDuration,
    /// 帧率必须为正且有限。
    ZeroFrameRate,
    /// 帧数超过上限（预算保护）。
    TooManyFrames,
}

impl TimelineError {
    pub fn code(self) -> &'static str {
        match self {
            Self::ZeroDuration => "recording-invalid-duration",
            Self::ZeroFrameRate => "recording-invalid-frame-rate",
            Self::TooManyFrames => "recording-too-many-frames",
        }
    }
}

/// 单次录制允许的最大帧数（约 10 分钟 @30fps 的 20 倍，防预算攻击）。
pub const MAX_FRAMES: u64 = 36_000;

/// 生成完整时间表。
///
/// 违规（零时长、零帧率、超帧数）返回稳定错误码，调用方据此在**接受前**拒绝任务。
pub fn build_timeline(duration: Rational, fps: Rational) -> Result<Vec<FrameSlot>, TimelineError> {
    if duration.numer == 0 {
        return Err(TimelineError::ZeroDuration);
    }
    if fps.numer == 0 {
        return Err(TimelineError::ZeroFrameRate);
    }
    let total = duration
        .ceil_scale(fps.numer, fps.denom)
        .ok_or(TimelineError::TooManyFrames)?;
    if total == 0 {
        return Err(TimelineError::ZeroDuration);
    }
    if total > MAX_FRAMES {
        return Err(TimelineError::TooManyFrames);
    }
    let frame_duration = Rational { numer: 1, denom: 1 };
    // 1/F = denom/numer（fps = numer/denom）。
    let one_frame = Rational {
        numer: fps.denom,
        denom: fps.numer,
    };
    let mut slots = Vec::with_capacity(total as usize);
    for index in 0..total {
        // PTS = i/F = i * denom / numer
        let pts = Rational {
            numer: index.saturating_mul(fps.denom),
            denom: fps.numer,
        };
        let remaining = duration.sub(pts).unwrap_or(frame_duration);
        let duration_i = if one_frame.lt(remaining) {
            one_frame
        } else {
            remaining
        };
        let sample = if index + 1 == total { duration } else { pts };
        slots.push(FrameSlot {
            index: u32::try_from(index).expect("frame count is bounded by MAX_FRAMES"),
            sample,
            duration: duration_i,
            pts,
        });
    }
    Ok(slots)
}

/// 容器时间精度内成片总时长（各帧 duration 之和）是否与 D 一致。
///
/// 用整数交叉相乘比较，不做浮点近似。
pub fn timeline_total_duration(slots: &[FrameSlot]) -> Option<Rational> {
    let mut numer: u128 = 0;
    let mut denom: u128 = 1;
    for slot in slots {
        // numer/denom + slot.duration
        numer = numer * slot.duration.denom as u128 + (slot.duration.numer as u128) * denom;
        denom *= slot.duration.denom as u128;
        let divisor = gcd_u128(numer, denom);
        numer /= divisor;
        denom /= divisor;
        if numer > u64::MAX as u128 || denom > u64::MAX as u128 {
            return None;
        }
    }
    Some(Rational {
        numer: u64::try_from(numer).ok()?,
        denom: u64::try_from(denom).ok()?,
    })
}

fn gcd_u128(a: u128, b: u128) -> u128 {
    let (mut a, mut b) = (a, b);
    while b != 0 {
        let t = a % b;
        a = b;
        b = t;
    }
    if a == 0 { 1 } else { a }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rational(numer: u64, denom: u64) -> Rational {
        Rational::new(numer, denom).expect("valid rational")
    }

    fn total_duration_matches(slots: &[FrameSlot], expected: Rational) {
        let total = timeline_total_duration(slots).expect("total duration");
        assert_eq!(
            (total.numer as u128) * (expected.denom as u128),
            (expected.numer as u128) * (total.denom as u128),
            "成片总时长 {total:?} 应等于 {expected:?}"
        );
    }

    #[test]
    fn integer_duration_produces_exact_frames() {
        // D = 2s, F = 30 → 60 帧，每帧 1/30。
        let slots = build_timeline(rational(2, 1), rational(30, 1)).expect("timeline");
        assert_eq!(slots.len(), 60);
        assert!(slots[0].pts.eq_value(rational(0, 1)));
        assert!(slots[0].duration.eq_value(rational(1, 30)));
        assert!(slots[59].pts.eq_value(rational(59, 30)));
        // 最后一帧采样终点 D，而不是 pts。
        assert!(slots[59].sample.eq_value(rational(2, 1)));
        total_duration_matches(&slots, rational(2, 1));
    }

    #[test]
    fn non_integer_duration_holds_fractional_last_frame() {
        // D = 1.05s, F = 30 → N = ceil(31.5) = 32 帧。
        let slots = build_timeline(rational(105, 100), rational(30, 1)).expect("timeline");
        assert_eq!(slots.len(), 32);
        // 第 31 帧（最后一帧）：PTS = 31/30 ≈ 1.0333，duration = 1.05 - 1.0333 = 0.01666 = 1/60。
        let last = slots[31];
        assert!(last.pts.eq_value(rational(31, 30)));
        assert!(last.duration.eq_value(rational(1, 60)));
        assert!(last.sample.eq_value(rational(105, 100)));
        total_duration_matches(&slots, rational(105, 100));
    }

    #[test]
    fn clip_shorter_than_one_frame_samples_the_end_point() {
        // D = 0.02s, F = 30 → N = 1，采样 T = D，时长 = D。
        let slots = build_timeline(rational(2, 100), rational(30, 1)).expect("timeline");
        assert_eq!(slots.len(), 1);
        assert!(slots[0].sample.eq_value(rational(2, 100)));
        assert!(slots[0].duration.eq_value(rational(2, 100)));
        assert!(slots[0].pts.eq_value(rational(0, 1)));
        total_duration_matches(&slots, rational(2, 100));
    }

    #[test]
    fn exactly_one_frame_is_not_double_counted() {
        // D = 1/30 → N = 1，不追加第二帧。
        let slots = build_timeline(rational(1, 30), rational(30, 1)).expect("timeline");
        assert_eq!(slots.len(), 1);
        assert!(slots[0].sample.eq_value(rational(1, 30)));
        assert!(slots[0].duration.eq_value(rational(1, 30)));
    }

    #[test]
    fn zero_and_invalid_inputs_are_rejected() {
        assert_eq!(
            build_timeline(rational(0, 1), rational(30, 1)).unwrap_err(),
            TimelineError::ZeroDuration
        );
        assert_eq!(
            build_timeline(rational(1, 1), rational(0, 1)).unwrap_err(),
            TimelineError::ZeroFrameRate
        );
        assert_eq!(
            TimelineError::ZeroDuration.code(),
            "recording-invalid-duration"
        );
        assert_eq!(
            TimelineError::ZeroFrameRate.code(),
            "recording-invalid-frame-rate"
        );
    }

    #[test]
    fn non_integer_frame_rate_is_exact() {
        // F = 30000/1001 (29.97), D = 1s → N = ceil(29.97) = 30。
        let slots = build_timeline(rational(1, 1), rational(30_000, 1_001)).expect("timeline");
        assert_eq!(slots.len(), 30);
        assert!(slots[0].pts.eq_value(rational(0, 1)));
        assert!(slots[1].pts.eq_value(rational(1_001, 30_000)));
        assert!(slots[29].sample.eq_value(rational(1, 1)));
        total_duration_matches(&slots, rational(1, 1));
    }

    #[test]
    fn long_timeline_does_not_accumulate_float_error() {
        // 10 分钟 @30fps：3600 秒 → 108000 帧超过 MAX_FRAMES，被预算拒绝而不是悄悄截断。
        let error = build_timeline(rational(3_600, 1), rational(30, 1)).unwrap_err();
        assert_eq!(error, TimelineError::TooManyFrames);

        // 20 分钟以内的合法长度：总时长仍精确等于 D。
        let slots = build_timeline(rational(600, 1), rational(30, 1)).expect("timeline");
        assert_eq!(slots.len(), 18_000);
        total_duration_matches(&slots, rational(600, 1));
    }

    #[test]
    fn paused_playback_does_not_change_frame_times() {
        // 「暂停」只影响生产节流，不改变时间表：同一输入必须得到同一时间表。
        let first = build_timeline(rational(3, 2), rational(24, 1)).expect("timeline");
        let second = build_timeline(rational(3, 2), rational(24, 1)).expect("timeline");
        assert_eq!(first, second);
        assert_eq!(first.len(), 36);
        total_duration_matches(&first, rational(3, 2));
    }

    #[test]
    fn rational_arithmetic_helpers_are_safe() {
        assert_eq!(Rational::new(1, 0), None);
        assert!(rational(1, 3).lt(rational(1, 2)));
        assert!(!rational(1, 2).lt(rational(1, 3)));
        assert!(
            rational(1, 2)
                .sub(rational(1, 3))
                .expect("diff")
                .eq_value(rational(1, 6))
        );
        assert_eq!(rational(1, 3).sub(rational(1, 2)), None);
        assert_eq!(rational(3, 2).ceil_scale(30, 1), Some(45));
        assert_eq!(rational(3, 2).floor_scale(30, 1), Some(45));
        assert_eq!(rational(1, 1).ceil_scale(0, 0), None);
    }
}
