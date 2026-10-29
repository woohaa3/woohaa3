//! 共享批处理输出：`CanvasBatchWriter` 与 `SelectionOutlineBatch`
//! （change: 2026-10-28-migrate-canvas-rendering-to-bevy-ecs，design D3 / 任务 1.4、3.1）。
//!
//! 三类内置展示（Card/Group/FilmSet）以及第三方 producer 都写入同一个选择描边批次；批次只
//! 持有**一帧的 CPU 几何**，flush 时替换共享 mesh handle。没有选中实体时 producer 贡献空结果，
//! flush 用不可见兜底 mesh 清空上一帧描边。
//!
//! 只保留一个 `SelectionOutlineLayer` Resource 保存批次实体/mesh handle（共享批处理资产），
//! 不保存任何节点或 owner 映射。

use bevy::{camera::visibility::NoFrustumCulling, prelude::*};

use crate::canvas2d::CanvasMaterials;
use crate::canvas2d::geometry::Geometry;

/// 生产者可写入的批次接口。第三方系统只需取得该 writer 即可复用公共 flush 协议。
pub(crate) trait CanvasBatchWriter {
    fn writer(&mut self) -> &mut Geometry;
}

/// 一帧的持久选中描边几何（Card/Group/FilmSet/第三方共享）。
#[derive(Resource, Default)]
pub(crate) struct SelectionOutlineBatch {
    geometry: Geometry,
    active: bool,
}

impl SelectionOutlineBatch {
    /// 帧起点：清空上一帧几何。只有真正运行 selection producer 的帧才会开始新批次。
    pub(crate) fn begin(&mut self) {
        self.geometry = Geometry::default();
        self.active = false;
    }

    /// 是否本帧有 producer 写入过（诊断）。
    pub(crate) fn active(&self) -> bool {
        self.active
    }

    pub(crate) fn take(&mut self) -> Geometry {
        self.active = false;
        std::mem::take(&mut self.geometry)
    }
}

impl CanvasBatchWriter for SelectionOutlineBatch {
    fn writer(&mut self) -> &mut Geometry {
        self.active = true;
        &mut self.geometry
    }
}

/// 选择描边批次实体与 mesh handle（共享批处理资产，不是节点 owner 事实）。
#[derive(Resource, Default)]
pub(crate) struct SelectionOutlineLayer {
    entity: Option<Entity>,
    mesh: Option<Handle<Mesh>>,
}

impl SelectionOutlineLayer {
    /// 当前批次实体（诊断/回归断言）。
    #[cfg(test)]
    pub(crate) fn entity(&self) -> Option<Entity> {
        self.entity
    }

    /// 当前批次 mesh（回归测试读取几何用）。
    #[cfg(test)]
    pub(crate) fn mesh(&self) -> Option<&Handle<Mesh>> {
        self.mesh.as_ref()
    }
}

/// flush：替换共享 mesh；空几何时换成不可见兜底 mesh（清空上一帧选中描边）。
pub(crate) fn flush_selection_outlines(
    mut commands: Commands,
    mut batch: ResMut<SelectionOutlineBatch>,
    mut layer: ResMut<SelectionOutlineLayer>,
    materials: Res<CanvasMaterials>,
    mut meshes: ResMut<Assets<Mesh>>,
) {
    let handle = meshes.add(batch.take().build());
    if let Some(old) = layer.mesh.replace(handle.clone()) {
        meshes.remove(old.id());
    }
    match layer.entity {
        Some(entity) => {
            commands.entity(entity).insert(Mesh2d(handle));
        }
        None => {
            layer.entity = Some(
                commands
                    .spawn((
                        Mesh2d(handle),
                        MeshMaterial2d(materials.solid.clone()),
                        NoFrustumCulling,
                        Name::new("canvas-selection-outlines"),
                    ))
                    .id(),
            );
        }
    }
}
