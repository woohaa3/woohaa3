//! Small dynamic mesh; time never participates in the static card cache key.
use super::{
    Visuals,
    geometry::Geometry,
    layout::{NODE_HISTORY_STRIP_DOT_RADIUS, history_strip_dot},
};
use crate::app::{CurrentScene, SurfaceState};
use bevy::{camera::visibility::NoFrustumCulling, prelude::*};
use std::collections::HashMap;

struct DotTarget {
    key: String,
    center: Vec2,
    z: f32,
    state: String,
    current: bool,
    selected: bool,
    scale: f32,
    target_scale: f32,
    tone: f32,
    target_tone: f32,
}

#[derive(Default)]
pub(crate) struct PulseLayer {
    entity: Option<Entity>,
    mesh: Option<Handle<Mesh>>,
    targets: Vec<DotTarget>,
    sampled_at: f32,
    hidden: bool,
}

impl PulseLayer {
    fn release(&mut self, commands: &mut Commands, meshes: &mut Assets<Mesh>) {
        if let Some(entity) = self.entity.take() {
            commands.entity(entity).despawn();
        }
        if let Some(mesh) = self.mesh.take() {
            meshes.remove(&mesh);
        }
    }
}

pub(crate) fn pulse(seconds: f32) -> f32 {
    0.5 - 0.5 * (seconds * std::f32::consts::TAU / 1.5).cos()
}

fn scale_towards(scale: f32, target: f32, elapsed: f32) -> f32 {
    let next = scale + (target - scale) * (1.0 - (-elapsed / 0.075).exp());
    if (target - next).abs() < 0.002 {
        target
    } else {
        next
    }
}

fn shade(color: u32, tone: f32) -> u32 {
    let target = if tone >= 0.0 { 255.0 } else { 0.0 };
    let channel = |shift: u32| {
        let value = ((color >> shift) & 255) as f32;
        (value + (target - value) * tone.abs()).round() as u32
    };
    (channel(16) << 16) | (channel(8) << 8) | channel(0)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn sync(
    mut commands: Commands,
    time: Res<Time>,
    scene: Res<CurrentScene>,
    surface: Res<SurfaceState>,
    theme: Res<crate::theme::ThemeResource>,
    visuals: Res<Visuals>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut layer: Local<PulseLayer>,
) {
    let hidden = browser_hidden()
        || super::image_focus::has_presented_media_focus(&scene.0)
        || scene.0.model_focus.is_some()
        || scene.0.model_editor.is_some();
    let rebuild = scene.is_changed() || surface.is_changed() || hidden != layer.hidden;
    if rebuild {
        layer.hidden = hidden;
        let previous: HashMap<_, _> = std::mem::take(&mut layer.targets)
            .into_iter()
            .map(|dot| (dot.key, (dot.scale, dot.tone)))
            .collect();
        if !hidden {
            let view = &scene.0.viewport;
            for (index, node) in scene.0.nodes.iter().enumerate() {
                if !super::layout::has_history_strip(node) {
                    continue;
                }
                if scene
                    .0
                    .drag_attach
                    .as_ref()
                    .is_some_and(|attach| attach.node_id == node.id)
                {
                    continue;
                }
                let strip = node.history_strip.as_ref().unwrap();
                for (dot_index, dot) in strip.dots.iter().enumerate() {
                    if dot.selected.is_none() && dot.state != "running" {
                        continue;
                    }
                    let center = history_strip_dot(
                        node.x,
                        node.y,
                        node.width,
                        node.height,
                        dot_index,
                        strip.dots.len(),
                    );
                    let screen = center * view.zoom + Vec2::new(view.x, view.y);
                    if screen.x >= 0.
                        && screen.y >= 0.
                        && screen.x <= surface.size.x
                        && screen.y <= surface.size.y
                    {
                        let key = format!(
                            "{}:{}",
                            node.id,
                            dot.presentation_id
                                .as_deref()
                                .unwrap_or(&dot_index.to_string())
                        );
                        let target_scale = if dot.pressed {
                            0.78
                        } else if dot.hovered {
                            1.4
                        } else {
                            1.0
                        };
                        let target_tone = if dot.pressed {
                            -0.26
                        } else if dot.hovered {
                            0.22
                        } else {
                            0.0
                        };
                        let (scale, tone) = previous.get(&key).copied().unwrap_or((1.0, 0.0));
                        layer.targets.push(DotTarget {
                            key,
                            center,
                            z: 10.0 + index as f32 * 0.1 + 0.056,
                            state: dot.state.clone(),
                            current: dot.current,
                            selected: dot.selected == Some(true),
                            scale,
                            target_scale,
                            tone,
                            target_tone,
                        });
                    }
                }
            }
        }
    }
    if layer.targets.is_empty() {
        layer.release(&mut commands, &mut meshes);
        return;
    }
    let now = time.elapsed_secs();
    let changed = rebuild || theme.is_changed() || layer.mesh.is_none();
    let animating = layer.targets.iter().any(|dot| {
        dot.state == "running"
            || dot.state == "queued"
            || dot.scale != dot.target_scale
            || dot.tone != dot.target_tone
    });
    if !changed && (!animating || now - layer.sampled_at < 1. / 30.) {
        return;
    }
    let elapsed = (now - layer.sampled_at).clamp(0.0, 0.05);
    layer.sampled_at = now;
    let mut geometry = Geometry::default();
    let amount = pulse(now);
    let accent = theme.token_u32("statusWarningSoft");
    let background = theme.token_u32("canvasNodeContent");
    let mix = |shift: u32| {
        let a = ((accent >> shift) & 255_u32) as f32;
        let b = ((background >> shift) & 255_u32) as f32;
        (b + (a - b) * (0.45 + amount * 0.55)) as u32
    };
    let color = (mix(16) << 16) | (mix(8) << 8) | mix(0);
    for dot in &mut layer.targets {
        dot.scale = scale_towards(dot.scale, dot.target_scale, elapsed);
        dot.tone = scale_towards(dot.tone, dot.target_tone, elapsed);
        let radius = NODE_HISTORY_STRIP_DOT_RADIUS * dot.scale;
        if dot.current {
            geometry.ring(
                dot.center,
                radius + 1.8,
                1.0,
                dot.z,
                theme.token_u32("canvasProgressTrack"),
                18,
            );
        }
        if dot.selected {
            let ring_color = if dot.state == "running" || dot.state == "queued" {
                theme.token_u32("statusWarningSoft")
            } else {
                theme.token_u32("interactionAccent")
            };
            geometry.ring(
                dot.center,
                radius + 2.1,
                1.2,
                dot.z + 0.001,
                shade(ring_color, dot.tone),
                18,
            );
        }
        let fill = if dot.state == "running" || dot.state == "queued" {
            color
        } else {
            super::history_strip::dot_color(&theme, &dot.state)
        };
        geometry.circle(dot.center, radius, dot.z + 0.002, shade(fill, dot.tone), 18);
    }
    let mesh = meshes.add(geometry.build());
    if let Some(old) = layer.mesh.replace(mesh.clone()) {
        meshes.remove(&old);
    }
    if let Some(entity) = layer.entity {
        commands.entity(entity).insert(Mesh2d(mesh));
    } else {
        layer.entity = Some(
            commands
                .spawn((
                    Mesh2d(mesh),
                    // RGB breathing is fully opaque. Write each dot's vertex depth so
                    // later transparent image sprites cannot paint over its upper edge.
                    MeshMaterial2d(visuals.material.clone()),
                    NoFrustumCulling,
                ))
                .id(),
        );
    }
}

#[cfg(target_arch = "wasm32")]
fn browser_hidden() -> bool {
    use wasm_bindgen::JsValue;
    js_sys::Reflect::get(&js_sys::global(), &JsValue::from_str("document"))
        .and_then(|document| js_sys::Reflect::get(&document, &JsValue::from_str("hidden")))
        .ok()
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}
#[cfg(not(target_arch = "wasm32"))]
fn browser_hidden() -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn releases_entity_and_mesh_once_when_no_targets_remain() {
        let mut world = World::new();
        let mut meshes = Assets::<Mesh>::default();
        let mut geometry = Geometry::default();
        geometry.circle(Vec2::ZERO, 3., 10., 0xffffff, 14);
        let mesh = meshes.add(geometry.build());
        let entity = world.spawn_empty().id();
        let mut layer = PulseLayer {
            entity: Some(entity),
            mesh: Some(mesh.clone()),
            ..Default::default()
        };
        layer.release(&mut world.commands(), &mut meshes);
        world.flush();
        assert!(world.get_entity(entity).is_err());
        assert!(meshes.get(&mesh).is_none());
        layer.release(&mut world.commands(), &mut meshes);
        assert!(layer.entity.is_none() && layer.mesh.is_none());
    }
    #[test]
    fn smooth_bounded_period() {
        assert!(pulse(0.).abs() < 0.0001);
        assert!((pulse(0.75) - 1.).abs() < 0.0001);
        assert!((pulse(1.5) - pulse(0.)).abs() < 0.0001);
        for step in 0..1000 {
            assert!((0.0..=1.0).contains(&pulse(step as f32 / 100.)));
        }
    }
    #[test]
    fn hover_press_and_release_converge_smoothly() {
        let hover = scale_towards(1.0, 1.4, 1.0 / 30.0);
        assert!(hover > 1.0 && hover < 1.4);
        let pressed = scale_towards(hover, 0.78, 1.0 / 30.0);
        assert!(pressed < hover && pressed > 0.78);
        let mut released = pressed;
        for _ in 0..30 {
            released = scale_towards(released, 1.0, 1.0 / 30.0);
        }
        assert_eq!(released, 1.0);
    }
}
