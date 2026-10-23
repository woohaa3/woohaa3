use bevy::prelude::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Lod {
    Full,
    Outline,
    Static,
    Hidden,
}

pub(super) fn size_lod(size: f32, previous: Option<Lod>) -> Lod {
    let full = if previous == Some(Lod::Full) {
        144.
    } else if previous.is_none() {
        160.
    } else {
        176.
    };
    let outline = if matches!(previous, Some(Lod::Full | Lod::Outline)) {
        57.6
    } else if previous.is_none() {
        64.
    } else {
        70.4
    };
    if size >= full {
        Lod::Full
    } else if size >= outline {
        Lod::Outline
    } else {
        Lod::Static
    }
}

pub(super) fn budget(lod: Lod, full: &mut usize, animated: &mut usize) -> Lod {
    match lod {
        Lod::Full if *full < 4 && *animated < 8 => {
            *full += 1;
            *animated += 1;
            Lod::Full
        }
        Lod::Full | Lod::Outline if *animated < 8 => {
            *animated += 1;
            Lod::Outline
        }
        Lod::Hidden => Lod::Hidden,
        _ => Lod::Static,
    }
}

/// Intersect the existing scope's overview rays with the owner's root ground plane.
/// This preserves rect overrides as well as skewed scopes, without using an AABB as a footprint.
pub(super) fn ground(vertices: [Vec2; 4], root_y: f32) -> [Vec3; 4] {
    let direction = crate::isometric_grid::canvas_camera_rotation() * Vec3::Z;
    vertices.map(|p| {
        let origin = crate::isometric_grid::canvas_point_to_world(p.x, p.y, 0.);
        origin + direction * ((root_y - origin.y) / direction.y)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn priority_budgets_and_hysteresis_are_bounded() {
        let (mut full, mut animated) = (0, 0);
        let levels: Vec<_> = (0..16)
            .map(|_| budget(Lod::Full, &mut full, &mut animated))
            .collect();
        assert_eq!(levels.iter().filter(|&&l| l == Lod::Full).count(), 4);
        assert_eq!(levels.iter().filter(|&&l| l == Lod::Outline).count(), 4);
        assert_eq!(levels.iter().filter(|&&l| l == Lod::Static).count(), 8);
        assert_eq!(size_lod(159., Some(Lod::Full)), Lod::Full);
        assert_eq!(size_lod(161., Some(Lod::Outline)), Lod::Outline);
        assert_eq!(size_lod(63., Some(Lod::Outline)), Lod::Outline);
        assert_eq!(size_lod(65., Some(Lod::Static)), Lod::Static);
    }
    #[test]
    fn scope_vertices_round_trip_without_aabb_inflation() {
        let vertices = [
            Vec2::new(2., 0.),
            Vec2::new(6., 2.),
            Vec2::new(4., 3.),
            Vec2::new(0., 1.),
        ];
        let view = crate::isometric_grid::IsometricGridView {
            x: 0.,
            y: 0.,
            zoom: 1.,
        };
        for (point, expected) in ground(vertices, 17.).into_iter().zip(vertices) {
            assert!((point.y - 17.).abs() < 1e-4);
            assert!(
                (crate::isometric_grid::screen_point_from_world(point, &view) - expected).length()
                    < 1e-4
            );
        }
    }
}
