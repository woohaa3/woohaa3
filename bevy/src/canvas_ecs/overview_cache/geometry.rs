//! Deterministic overview-camera and resolution math shared by WebGPU/WebGL/native paths.

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Bounds2d {
    pub(crate) min_x: f32,
    pub(crate) min_y: f32,
    pub(crate) max_x: f32,
    pub(crate) max_y: f32,
}
impl Bounds2d {
    pub(crate) fn valid(self) -> bool {
        [self.min_x, self.min_y, self.max_x, self.max_y]
            .iter()
            .all(|value| value.is_finite())
            && self.max_x > self.min_x
            && self.max_y > self.min_y
    }
    pub(crate) fn padded(self, margin: f32) -> Self {
        let margin = if margin.is_finite() {
            margin.max(0.)
        } else {
            0.
        };
        Self {
            min_x: self.min_x - margin,
            min_y: self.min_y - margin,
            max_x: self.max_x + margin,
            max_y: self.max_y + margin,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct OverviewCamera {
    pub(crate) center_x: f32,
    pub(crate) center_y: f32,
    pub(crate) half_width: f32,
    pub(crate) half_height: f32,
    pub(crate) aspect: f32,
}
pub(crate) fn camera_for_bounds(
    bounds: Bounds2d,
    aspect: f32,
    margin: f32,
) -> Option<OverviewCamera> {
    if !bounds.valid() || !aspect.is_finite() || aspect <= 0. {
        return None;
    }
    let padded = bounds.padded(margin);
    let width = padded.max_x - padded.min_x;
    let height = padded.max_y - padded.min_y;
    let target_width = (height * aspect).max(width);
    let target_height = (target_width / aspect).max(height);
    Some(OverviewCamera {
        center_x: (padded.min_x + padded.max_x) * 0.5,
        center_y: (padded.min_y + padded.max_y) * 0.5,
        half_width: target_width * 0.5,
        half_height: target_height * 0.5,
        aspect,
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum OverviewTier {
    T128,
    T256,
    T512,
    T1024,
    T2048,
}
impl OverviewTier {
    pub(crate) fn edge(self) -> u32 {
        match self {
            Self::T128 => 128,
            Self::T256 => 256,
            Self::T512 => 512,
            Self::T1024 => 1024,
            Self::T2048 => 2048,
        }
    }
}

pub(crate) fn tier_for_edge(edge: f32, previous: Option<OverviewTier>) -> Option<OverviewTier> {
    if !edge.is_finite() || edge <= 0. {
        return None;
    }
    let desired = if edge <= 128. {
        OverviewTier::T128
    } else if edge <= 256. {
        OverviewTier::T256
    } else if edge <= 512. {
        OverviewTier::T512
    } else if edge <= 1024. {
        OverviewTier::T1024
    } else if edge <= 2048. {
        OverviewTier::T2048
    } else {
        return None;
    };
    if let Some(previous) = previous {
        if desired.edge() < previous.edge() && edge > desired.edge() as f32 * 0.85 {
            return Some(previous);
        }
    }
    Some(desired)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn camera_contains_full_padded_bounds_and_preserves_aspect() {
        let camera = camera_for_bounds(
            Bounds2d {
                min_x: -10.,
                min_y: 0.,
                max_x: 30.,
                max_y: 20.,
            },
            2.,
            2.,
        )
        .unwrap();
        assert_eq!(camera.aspect, 2.);
        assert!(camera.center_x - camera.half_width <= -12.);
        assert!(camera.center_x + camera.half_width >= 32.);
        assert!(camera.center_y - camera.half_height <= -2.);
        assert!(camera.center_y + camera.half_height >= 22.);
    }
    #[test]
    fn tiers_keep_shrink_hysteresis_and_reject_quality_overflow() {
        assert_eq!(
            tier_for_edge(250., Some(OverviewTier::T512)),
            Some(OverviewTier::T512)
        );
        assert_eq!(
            tier_for_edge(200., Some(OverviewTier::T512)),
            Some(OverviewTier::T256)
        );
        assert_eq!(
            tier_for_edge(1000., Some(OverviewTier::T512)),
            Some(OverviewTier::T1024)
        );
        assert_eq!(tier_for_edge(1025., Some(OverviewTier::T1024)), Some(OverviewTier::T2048));
        assert_eq!(tier_for_edge(2049., Some(OverviewTier::T2048)), None);
    }
}
