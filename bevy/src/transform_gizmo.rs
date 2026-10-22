//! 可复用 transform gizmo：表示与命中分离，宿主负责语义
//! （change: refactor-bevy-reusable-components，任务 5.1/5.2 / design D5）。
//!
//! 插件拥有可丢弃的 handle 实体、render layer、几何缓存与选择/hover 状态，只根据
//! [`TransformGizmoTarget`]、[`TransformGizmoMode`]、[`TransformGizmoStyle`] 生成/更新视觉。
//! 它**不**写 Canvas 状态、不提交命令：宿主 adapter 把命中 axis 解释为既有 edit 命令。
//!
//! 核心不依赖 canvas `protocol`、`bridge`、DOM 或 Y.Doc。

use bevy::prelude::*;
use bevy::camera::visibility::RenderLayers;

/// 编辑 gizmo 使用的默认独立 render layer（与 model3d editor layer 一致）。
pub const TRANSFORM_GIZMO_LAYER: usize = 1;

/// gizmo 模式：模型 placement（中心 + yaw 环）或焦点三轴。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TransformGizmoMode {
    /// 模型 placement：位移中心球 + 世界 Y 轴 yaw 环。
    Placement,
    /// 焦点三轴位移：X/Y/Z 三轴 + 中心球。
    FocusAxes,
}

/// gizmo 样式（颜色与尺寸由宿主注入；插件不读主题）。
#[derive(Clone, Debug, Resource)]
pub struct TransformGizmoStyle {
    pub accent: Color,
    pub axis_x: Color,
    pub axis_y: Color,
    pub axis_z: Color,
    pub center: Color,
    pub layers: RenderLayers,
}

impl Default for TransformGizmoStyle {
    fn default() -> Self {
        Self {
            accent: Color::srgb(0.09, 0.52, 0.42),
            axis_x: Color::srgb(0.90, 0.25, 0.25),
            axis_y: Color::srgb(0.30, 0.85, 0.35),
            axis_z: Color::srgb(0.30, 0.55, 0.95),
            center: Color::WHITE,
            layers: RenderLayers::layer(TRANSFORM_GIZMO_LAYER),
        }
    }
}

/// 一个 gizmo 目标：focus 与包围球半径。
#[derive(Component, Clone, Copy, Debug, PartialEq)]
pub struct TransformGizmoTarget {
    pub focus: Vec3,
    pub radius: f32,
}

/// 当前选中/可命中的 gizmo 目标集合（命令驱动）。
#[derive(Resource, Default)]
pub struct TransformGizmoSelection {
    /// 当前模式；`None` 表示不显示。
    pub mode: Option<TransformGizmoMode>,
    pub target: Option<TransformGizmoTarget>,
    /// 宿主用于跳过重建的签名（模式 + focus + radius）。
    pub signature: String,
    pub entities: Vec<Entity>,
}

/// 标记：该实体是 gizmo handle（供宿主在截图回退时隐藏 chrome）。
#[derive(Component)]
pub struct TransformGizmoHandle;

/// 可安装的 transform gizmo 插件。
pub struct TransformGizmoPlugin;

impl Plugin for TransformGizmoPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<TransformGizmoSelection>()
            .init_resource::<TransformGizmoStyle>()
            .add_systems(Update, sync_transform_gizmo);
    }
}

/// 命中的 axis（供宿主解释为 edit 命令）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GizmoAxis {
    X,
    Y,
    Z,
    Center,
    YawRing,
}

impl TransformGizmoSelection {
    /// 设置当前目标（等价命令入口）。
    pub fn set(&mut self, mode: Option<TransformGizmoMode>, target: Option<TransformGizmoTarget>) {
        self.mode = mode;
        self.target = target;
    }
}

fn signature(mode: Option<TransformGizmoMode>, target: Option<TransformGizmoTarget>) -> String {
    match (mode, target) {
        (Some(mode), Some(target)) => format!(
            "{mode:?}:{:.3}:{:.3}:{:.3}:{:.4}",
            target.focus.x, target.focus.y, target.focus.z, target.radius
        ),
        _ => "none".to_owned(),
    }
}

fn clear(commands: &mut Commands, selection: &mut TransformGizmoSelection) {
    for entity in selection.entities.drain(..) {
        commands.entity(entity).try_despawn();
    }
}

/// 根据当前 selection 生成/更新 gizmo 表示；签名不变则跳过。
pub(crate) fn sync_transform_gizmo(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    style: Res<TransformGizmoStyle>,
    mut selection: ResMut<TransformGizmoSelection>,
) {
    let next = signature(selection.mode, selection.target);
    if next == selection.signature {
        return;
    }
    selection.signature = next.clone();
    clear(&mut commands, &mut selection);
    let (Some(mode), Some(target)) = (selection.mode, selection.target) else {
        return;
    };
    let radius = if target.radius.is_finite() && target.radius > 1e-3 {
        target.radius
    } else {
        1.0
    };
    match mode {
        TransformGizmoMode::Placement => {
            spawn_center(&mut commands, &mut meshes, &mut materials, &style, &mut selection, target.focus, radius * 0.06, style.accent);
            spawn_ring(&mut commands, &mut meshes, &mut materials, &style, &mut selection, target.focus, radius);
        }
        TransformGizmoMode::FocusAxes => {
            spawn_axes(&mut commands, &mut meshes, &mut materials, &style, &mut selection, target.focus, radius);
        }
    }
}

fn unlit(materials: &mut Assets<StandardMaterial>, color: Color) -> Handle<StandardMaterial> {
    materials.add(StandardMaterial {
        base_color: color,
        unlit: true,
        alpha_mode: AlphaMode::Blend,
        ..default()
    })
}

#[allow(clippy::too_many_arguments)]
fn spawn_center(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    materials: &mut Assets<StandardMaterial>,
    style: &TransformGizmoStyle,
    selection: &mut TransformGizmoSelection,
    focus: Vec3,
    radius: f32,
    color: Color,
) {
    let mesh = meshes.add(Sphere::new(radius.max(0.005)).mesh().build());
    selection.entities.push(
        commands
            .spawn((
                TransformGizmoHandle,
                Mesh3d(mesh),
                MeshMaterial3d(unlit(materials, color)),
                Transform::from_translation(focus),
                Visibility::Inherited,
                style.layers.clone(),
            ))
            .id(),
    );
}

#[allow(clippy::too_many_arguments)]
fn spawn_ring(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    materials: &mut Assets<StandardMaterial>,
    style: &TransformGizmoStyle,
    selection: &mut TransformGizmoSelection,
    focus: Vec3,
    radius: f32,
) {
    let ring_radius = radius * 1.15;
    let tube = (radius * 0.01).max(0.005);
    let mesh = meshes.add(Torus::new(ring_radius, ring_radius + tube * 2.0).mesh().build());
    selection.entities.push(
        commands
            .spawn((
                TransformGizmoHandle,
                Mesh3d(mesh),
                MeshMaterial3d(unlit(materials, style.accent)),
                Transform::from_translation(focus),
                Visibility::Inherited,
                style.layers.clone(),
            ))
            .id(),
    );
}

#[allow(clippy::too_many_arguments)]
fn spawn_axes(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    materials: &mut Assets<StandardMaterial>,
    style: &TransformGizmoStyle,
    selection: &mut TransformGizmoSelection,
    focus: Vec3,
    radius: f32,
) {
    let length = radius * 1.15;
    let tube = (radius * 0.006).max(0.003);
    spawn_center(commands, meshes, materials, style, selection, focus, tube * 1.6, style.center);
    let shaft = meshes.add(Cuboid::new(tube * 2.0, tube * 2.0, length).mesh().build());
    let axes: [(Vec3, Color); 3] = [
        (Vec3::X, style.axis_x),
        (Vec3::Y, style.axis_y),
        (Vec3::Z, style.axis_z),
    ];
    for (axis, color) in axes {
        let rotation = Quat::from_rotation_arc(Vec3::Z, axis);
        selection.entities.push(
            commands
                .spawn((
                    TransformGizmoHandle,
                    Mesh3d(shaft.clone()),
                    MeshMaterial3d(unlit(materials, color)),
                    Transform {
                        translation: focus + axis * (length * 0.5),
                        rotation,
                        scale: Vec3::ONE,
                    },
                    Visibility::Inherited,
                    style.layers.clone(),
                ))
                .id(),
        );
    }
}

/// 焦点三轴 gizmo 的世界几何（与 Web `focusGizmoGeometry` 约定一致：轴长 `radius*1.15`）。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FocusAxesGeometry {
    pub origin: Vec3,
    pub axis_length: f32,
}

impl FocusAxesGeometry {
    pub fn new(focus: Vec3, radius: f32) -> Self {
        let radius = if radius.is_finite() && radius > 1e-3 {
            radius
        } else {
            1.0
        };
        Self {
            origin: focus,
            axis_length: radius * 1.15,
        }
    }

    pub fn axis_endpoint(&self, axis: GizmoAxis) -> Option<Vec3> {
        let dir = match axis {
            GizmoAxis::X => Vec3::X,
            GizmoAxis::Y => Vec3::Y,
            GizmoAxis::Z => Vec3::Z,
            _ => return None,
        };
        Some(self.origin + dir * self.axis_length)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signature_tracks_mode_and_target() {
        assert_eq!(signature(None, None), "none");
        let a = signature(
            Some(TransformGizmoMode::Placement),
            Some(TransformGizmoTarget {
                focus: Vec3::ZERO,
                radius: 2.0,
            }),
        );
        let b = signature(
            Some(TransformGizmoMode::FocusAxes),
            Some(TransformGizmoTarget {
                focus: Vec3::ZERO,
                radius: 2.0,
            }),
        );
        assert_ne!(a, b);
        assert_ne!(a, "none");
    }

    #[test]
    fn focus_geometry_endpoints_match_axis_length() {
        let geometry = FocusAxesGeometry::new(Vec3::new(1.0, 1.0, 1.0), 2.0);
        let end = geometry.axis_endpoint(GizmoAxis::X).expect("x");
        assert!((end.x - (1.0 + 2.0 * 1.15)).abs() < 1e-5);
        assert!(geometry.axis_endpoint(GizmoAxis::Center).is_none());
    }

    #[test]
    fn focus_geometry_falls_back_for_invalid_radius() {
        let geometry = FocusAxesGeometry::new(Vec3::ZERO, f32::NAN);
        assert!((geometry.axis_length - 1.15).abs() < 1e-5);
    }
}
