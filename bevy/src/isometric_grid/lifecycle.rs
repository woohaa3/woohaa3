//! 等距网格的插件生命周期：配置、资源、相机与 viewport 同步
//! （change: refactor-bevy-reusable-components，任务 4.1/4.2 / design D2）。
//!
//! 插件通过 [`IsometricGridConfig`]/[`IsometricGridStyle`] 接收投影、间距、线宽、render layer
//! 与颜色；通过 [`IsometricGridView`] 接收 viewport/surface。插件拥有 mesh/material 实体与
//! 回收，不读取 Canvas `Scene`、`ThemeResource` 或 editor layer 常量。

use bevy::{
    asset::RenderAssetUsages,
    prelude::*,
    render::{
        mesh::Indices,
        render_resource::PrimitiveTopology,
    },
    camera::visibility::{NoFrustumCulling, RenderLayers},
};

use super::plan::{GRID_DEPTH, GRID_LINE_WIDTH, IsometricGridView, plan_grid};

/// 网格配置（render layer 与相机标记由宿主注入）。
#[derive(Resource, Clone, Debug)]
pub struct IsometricGridConfig {
    /// 网格可见的 render layer 集合。
    pub layers: RenderLayers,
    /// 网格标记组件所需的 layer（与相机 marker 协作）。
    pub line_width: f32,
    /// 网格相对相机的深度。
    pub depth: f32,
}

impl Default for IsometricGridConfig {
    fn default() -> Self {
        Self {
            layers: RenderLayers::layer(0),
            line_width: GRID_LINE_WIDTH,
            depth: GRID_DEPTH,
        }
    }
}

/// 网格颜色样式（由 adapter 从主题解析后注入，不在插件内读取 ThemeResource）。
#[derive(Resource, Clone, Copy, Debug)]
pub struct IsometricGridStyle {
    pub minor: Color,
    pub major: Color,
    /// 宿主用于识别“样式是否变化”的指纹。
    pub fingerprint: u64,
}

impl Default for IsometricGridStyle {
    fn default() -> Self {
        Self {
            minor: Color::srgb_u8(217, 225, 221),
            major: Color::srgb_u8(171, 189, 179),
            fingerprint: 0,
        }
    }
}

/// 网格实体标记。
#[derive(Component)]
pub struct IsometricGrid;

/// 网格材质句柄。
#[derive(Resource)]
pub struct IsometricGridAssets {
    pub minor: Handle<StandardMaterial>,
    pub major: Handle<StandardMaterial>,
}

/// 已生成网格实体的 slot 与签名。
#[derive(Resource, Default)]
pub struct IsometricGridState {
    minor: Option<(Entity, Handle<Mesh>)>,
    major: Option<(Entity, Handle<Mesh>)>,
    signature: String,
}

/// 网格视口/尺寸视图（宿主在 viewport/surface 变化时更新）。
#[derive(Component, Clone, Debug, Default)]
pub struct IsometricGridTarget {
    pub view: IsometricGridView,
    pub surface: Vec2,
    /// 宿主用于跳过未变化写入的签名。
    pub signature: String,
}

/// 当前样式指纹（避免重复写材质）。
#[derive(Resource, Default)]
pub struct GridStyleState {
    pub fingerprint: u64,
}

/// 网格系统集：宿主 adapter 可在 `Sync` 之前写入 config/style/target。
#[derive(SystemSet, Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum IsometricGridSet {
    /// 应用样式指纹变化（写材质颜色）。
    Style,
    /// 按 view/surface 重建网格线 mesh。
    View,
}

/// 可安装的等距网格模块。
pub struct IsometricGridPlugin;

impl Plugin for IsometricGridPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<IsometricGridConfig>()
            .init_resource::<IsometricGridStyle>()
            .init_resource::<IsometricGridState>()
            .init_resource::<GridStyleState>()
            .add_systems(Startup, setup_grid_assets)
            .add_systems(
                Update,
                (
                    sync_grid_style.in_set(IsometricGridSet::Style),
                    sync_grid_view.in_set(IsometricGridSet::View),
                )
                    .chain(),
            );
    }
}

fn setup_grid_assets(
    mut commands: Commands,
    mut materials: ResMut<Assets<StandardMaterial>>,
    style: Res<IsometricGridStyle>,
) {
    let minor = materials.add(grid_material(style.minor));
    let major = materials.add(grid_material(style.major));
    commands.insert_resource(IsometricGridAssets { minor, major });
}

/// 网格材质：unlit 直接输出 base_color（正对相机的平面若参与 PBR 会被高光打白）。
pub fn grid_material(color: Color) -> StandardMaterial {
    StandardMaterial {
        base_color: color,
        unlit: true,
        cull_mode: None,
        ..default()
    }
}

/// 指纹变化时原地更新已有网格材质颜色（不重建 entity）。
pub(crate) fn sync_grid_style(
    mut materials: ResMut<Assets<StandardMaterial>>,
    assets: Option<Res<IsometricGridAssets>>,
    style: Res<IsometricGridStyle>,
    mut state: ResMut<GridStyleState>,
) {
    let Some(assets) = assets else {
        return;
    };
    if state.fingerprint == style.fingerprint {
        return;
    }
    state.fingerprint = style.fingerprint;
    if let Some(mut material) = materials.get_mut(&assets.minor) {
        material.base_color = style.minor;
    }
    if let Some(mut material) = materials.get_mut(&assets.major) {
        material.base_color = style.major;
    }
}

pub(crate) fn sync_grid_view(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    config: Res<IsometricGridConfig>,
    assets: Option<Res<IsometricGridAssets>>,
    mut state: ResMut<IsometricGridState>,
    targets: Query<&IsometricGridTarget>,
) {
    let Some(assets) = assets else {
        return;
    };
    let Some(target) = targets.iter().next() else {
        return;
    };
    let size = target.surface;
    if !(size.x > 0.0 && size.y > 0.0) {
        return;
    }
    let view = target.view;
    let signature = format!(
        "{:.3}:{:.3}:{:.3}:{:.2}:{:.2}",
        view.x, view.y, view.zoom, size.x, size.y
    );
    if signature == state.signature {
        return;
    }
    state.signature = signature;

    let plan = plan_grid(&view, size);
    let minor = build_lines_mesh(&plan.minor, config.line_width, &view, config.depth);
    let major = build_lines_mesh(&plan.major, config.line_width, &view, config.depth);
    replace_mesh(
        &mut commands,
        &mut meshes,
        &mut state.minor,
        assets.minor.clone(),
        minor,
        config.layers.clone(),
    );
    replace_mesh(
        &mut commands,
        &mut meshes,
        &mut state.major,
        assets.major.clone(),
        major,
        config.layers.clone(),
    );
}

/// 把一批屏幕坐标线段（CSS，y 向下）按当前 viewport 逆投影为位于给定深度的世界几何。
///
/// 线段已含 viewport（planner 输出 `screen = canvas × zoom + pan`），这里用**同一** view 的相机
/// 逆投影成世界顶点，viewport 只作用一次（change: make-shot-framing-zoom-invariant，design D6）。
/// 线宽为固定 CSS 像素，屏幕空间的法线经同一逆投影自动得到 `width/zoom` 世界宽度。
fn build_lines_mesh(lines: &[(Vec2, Vec2)], width: f32, view: &IsometricGridView, depth: f32) -> Mesh {
    let mut positions: Vec<[f32; 3]> = Vec::with_capacity(lines.len() * 4);
    let mut indices: Vec<u32> = Vec::with_capacity(lines.len() * 6);
    for (a, b) in lines {
        let normal = (b - a).normalize_or_zero().perp() * width * 0.5;
        let base = positions.len() as u32;
        for point in [*a + normal, *a - normal, *b - normal, *b + normal] {
            positions.push(
                super::plan::screen_point_to_world(point, depth, view).to_array(),
            );
        }
        indices.extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
    }
    if positions.is_empty() {
        let fallback = super::plan::screen_point_to_world(Vec2::ZERO, depth - 1.0, view);
        positions = vec![
            fallback.to_array(),
            (fallback + Vec3::X * 0.001).to_array(),
            (fallback + Vec3::Y * 0.001).to_array(),
        ];
        indices = vec![0, 1, 2];
    }
    let len = positions.len();
    Mesh::new(
        PrimitiveTopology::TriangleList,
        RenderAssetUsages::default(),
    )
    .with_inserted_attribute(Mesh::ATTRIBUTE_POSITION, positions)
    .with_inserted_attribute(Mesh::ATTRIBUTE_NORMAL, vec![[0.0, 0.0, 1.0]; len])
    .with_inserted_attribute(Mesh::ATTRIBUTE_UV_0, vec![[0.0, 0.0]; len])
    .with_inserted_indices(Indices::U32(indices))
}

fn replace_mesh(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    slot: &mut Option<(Entity, Handle<Mesh>)>,
    material: Handle<StandardMaterial>,
    mesh: Mesh,
    layers: RenderLayers,
) {
    let handle = meshes.add(mesh);
    match slot {
        Some((entity, old)) => {
            let old = std::mem::replace(old, handle.clone());
            meshes.remove(&old);
            if let Ok(mut entity_commands) = commands.get_entity(*entity) {
                entity_commands.insert(Mesh3d(handle));
            }
        }
        None => {
            // 网格 mesh 覆盖整个画布，且 Aabb 只在首次 spawn 时计算（Bevy 不会在 Mesh3d
            // handle 变化时重算）。平移/缩放后 Aabb 会与实际几何脱节并被 frustum culling
            // 整体剔除，因此关闭 culling。
            let entity = commands
                .spawn((
                    IsometricGrid,
                    Mesh3d(handle.clone()),
                    MeshMaterial3d(material),
                    NoFrustumCulling,
                    layers,
                ))
                .id();
            *slot = Some((entity, handle));
        }
    }
}
