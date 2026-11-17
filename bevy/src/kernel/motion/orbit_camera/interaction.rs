//! Orbit camera 的可选 Bevy pointer adapter（默认禁用）
//! （change: refactor-bevy-reusable-components，任务 3.3 / design D1）。
//!
//! 只有在宿主持有显式资源并 `enabled = true` 时才读取指针输入；禁用时不读取也不消费宿主
//! 输入。生产 Web 仍由 DOM 输入路由投递命令，不使用此 adapter。

use bevy::prelude::*;

use super::{OrbitCameraCommand, OrbitCameraCommands, OrbitCameraRig};

/// 可选 Bevy pointer adapter 配置。
///
/// 默认**禁用**：宿主（生产 Canvas）自行路由 DOM 输入并投递命令；只有普通 Bevy App 或
/// Showcase 才显式启用。禁用时不读取也不消费任何宿主输入。
#[cfg(feature = "canvas-core")]
#[derive(Resource, Default)]
pub struct OrbitCameraPointerAdapter {
    pub enabled: bool,
    active: Option<(Entity, PointerMode)>,
}

#[cfg(feature = "canvas-core")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PointerMode {
    Orbit,
    Pan,
}

/// 注册可选 pointer adapter（默认禁用）。
#[cfg(feature = "canvas-core")]
pub struct OrbitCameraInteractionPlugin;

#[cfg(feature = "canvas-core")]
impl Plugin for OrbitCameraInteractionPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<OrbitCameraPointerAdapter>()
            .init_resource::<OrbitCameraCommands>()
            .add_systems(
                Update,
                (orbit_pointer_begin, orbit_pointer_motion, orbit_pointer_end).chain(),
            );
    }
}

#[cfg(feature = "canvas-core")]
fn orbit_pointer_begin(
    mut adapter: ResMut<OrbitCameraPointerAdapter>,
    buttons: Res<ButtonInput<MouseButton>>,
    rigs: Query<Entity, With<OrbitCameraRig>>,
) {
    if !adapter.enabled {
        return;
    }
    let mode = if buttons.just_pressed(MouseButton::Right) {
        PointerMode::Orbit
    } else if buttons.just_pressed(MouseButton::Middle) {
        PointerMode::Pan
    } else {
        return;
    };
    if let Some(rig) = rigs.iter().next() {
        adapter.active = Some((rig, mode));
    }
}

#[cfg(feature = "canvas-core")]
fn orbit_pointer_motion(
    adapter: Res<OrbitCameraPointerAdapter>,
    motion: Res<bevy::input::mouse::AccumulatedMouseMotion>,
    mut commands: ResMut<OrbitCameraCommands>,
) {
    if !adapter.enabled {
        return;
    }
    let Some((rig, mode)) = adapter.active else {
        return;
    };
    let delta = motion.delta;
    if delta.length_squared() <= 0.0 {
        return;
    }
    let command = match mode {
        PointerMode::Orbit => OrbitCameraCommand::Orbit {
            delta_yaw: -delta.x * 0.01,
            delta_pitch: -delta.y * 0.01,
        },
        PointerMode::Pan => OrbitCameraCommand::Pan {
            delta: Vec3::new(-delta.x, delta.y, 0.0),
        },
    };
    commands.push(rig, command);
}

#[cfg(feature = "canvas-core")]
fn orbit_pointer_end(
    mut adapter: ResMut<OrbitCameraPointerAdapter>,
    buttons: Res<ButtonInput<MouseButton>>,
) {
    if !adapter.enabled {
        return;
    }
    if buttons.just_released(MouseButton::Right) || buttons.just_released(MouseButton::Middle) {
        adapter.active = None;
    }
}
