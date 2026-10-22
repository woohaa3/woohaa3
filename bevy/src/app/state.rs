use std::collections::HashMap;

use bevy::prelude::*;

use crate::{model3d, protocol::Scene};

/// 当前场景（`protocol::Scene` 本身不依赖 Bevy，因此由 app 包装成 resource）。
#[derive(Resource, Default)]
pub(crate) struct CurrentScene(pub(crate) Scene);

/// 本帧 texture inbox 的一次性批次。
#[derive(Resource, Default)]
pub(crate) struct TextureBatch(pub(crate) HashMap<String, (u32, u32, Vec<u8>)>);

/// 片场媒体平面纹理 inbox 的一次性批次（键为全局唯一 `planeId`；
/// change: 2026-10-08-make-film-set-model-only）。
#[derive(Resource, Default)]
pub(crate) struct FilmSetTextureBatch(pub(crate) HashMap<String, (u32, u32, Vec<u8>)>);

/// 已注册不可变模型资源表的只读快照。
#[derive(Resource, Default)]
pub(crate) struct ModelAssetTable(pub(crate) model3d::ModelAssets);

/// 最近一次应用的画布 CSS 尺寸（逻辑像素，与 JS hit-test 空间一致）。
#[derive(Resource, Default)]
pub(crate) struct SurfaceState {
    pub(crate) size: Vec2,
}

/// 活动动画节点当前求值出的镜头姿态
/// （change: 2026-10-05-bind-model-animation-to-shots，任务 4.1）。
///
/// 由 `sync_models` 每帧写入；shot adapter / 聚焦相机据此渲染动画镜头。`None` 表示当前无活动
/// 动画节点。只承载浏览器本地运行时姿态，不进入 canonical 数据。
#[derive(Resource, Default)]
pub(crate) struct AnimationCameraState(pub(crate) Option<crate::motion::CameraState>);

/// 聚焦相机过渡桥接状态。
///
/// 过渡插值本体由通用 [`crate::camera_transition::CameraTransition`] 承担；本资源只保留
/// Canvas adapter 特有的状态（是否已初始化、聚焦模式），以及 focus 进入/退出的起点策略。
#[derive(Resource)]
pub(crate) struct FocusRig {
    pub(crate) initialized: bool,
    pub(crate) active: bool,
    /// 退出过渡结束前保留最后拍摄的模型，隔离其他模型。
    pub(crate) focus_node: Option<String>,
    pub(crate) transition: crate::camera_transition::CameraTransition,
    pub(super) projection_pivot: Vec3,
    pub(super) projection_blend: Option<crate::camera_transition::projection::FocusProjectionBlend>,
    /// 本帧携带的公共聚焦进度（design D6/D7）。
    ///
    /// 合法时三维相机按该进度求值，不消耗独立 `Time.delta`；缺失/不匹配则回退内部计时。
    pub(crate) transition_progress: Option<crate::protocol::FocusTransitionProgress>,
    /// 已接受的公共进度 runtime generation（旧代更小值被丢弃）。
    last_progress_generation: u32,
}

impl Default for FocusRig {
    fn default() -> Self {
        Self {
            initialized: false,
            active: false,
            focus_node: None,
            projection_blend: None,
            projection_pivot: Vec3::ZERO,
            transition: crate::camera_transition::CameraTransition::settled(
                Transform::IDENTITY,
                model3d::focus::FOCUS_TRANSITION_SECS,
            ),
            transition_progress: None,
            last_progress_generation: 0,
        }
    }
}

impl FocusRig {
    pub(crate) fn sync_focus_node(&mut self, node: Option<&str>) {
        if let Some(node) = node {
            self.focus_node = Some(node.to_owned());
        } else if !self.animating() {
            self.focus_node = None;
        }
    }

    /// 是否仍在过渡中（用于抑制每帧正交相机复位，避免打断退出动画）。
    pub(crate) fn animating(&self) -> bool {
        self.transition.animating()
    }

    /// 注入本帧公共进度；仅接受匹配当前聚焦节点、驱动三维 rig 且 generation 不倒退的进度。
    /// 返回是否采用公共进度。
    pub(crate) fn accept_transition_progress(
        &mut self,
        incoming: Option<&crate::protocol::FocusTransitionProgress>,
        node_id: Option<&str>,
    ) -> bool {
        let Some(progress) = incoming else {
            self.transition_progress = None;
            return false;
        };
        let matches = node_id.is_some_and(|id| progress.matches(id));
        if !matches
            || !progress.drives_model_rig()
            || progress.runtime_generation < self.last_progress_generation
        {
            return false;
        }
        self.last_progress_generation = progress.runtime_generation;
        self.transition_progress = Some(progress.clone());
        true
    }

    /// 取得当前聚焦相机姿态：有公共进度时按其映射 `elapsed`（不消耗独立 delta），否则内部步进。
    pub(crate) fn advance(&mut self, delta_secs: f32) -> Transform {
        if let Some(progress) = &self.transition_progress {
            let raw = progress.progress.clamp(0.0, 1.0);
            self.transition.elapsed = self.transition.duration * raw;
            return crate::camera_transition::evaluate_transition(
                self.transition.from,
                self.transition.target,
                self.transition.elapsed,
                self.transition.duration,
            );
        }
        self.transition.step(delta_secs)
    }
}

/// 显式帧标记，避免用不透明 run condition 猜测前置系统是否运行。
#[derive(Resource, Default)]
pub(crate) struct FrameFlags {
    pub(crate) film_set_media_changed: bool,
    pub(crate) scene_received: bool,
    pub(crate) positions_received: bool,
    pub(crate) surface_changed: bool,
    pub(crate) theme_changed: bool,
    pub(crate) changed: bool,
    /// 相机/网格是否需要跟随视口（内容变化或纯视口增量）；纯视口不重建静态几何
    /// （change: 2026-10-10-optimize-canvas-interaction-hot-path，design D3/D4）。
    pub(crate) camera_changed: bool,
    /// 本帧是否只应用了纯视口增量（未重建世界几何）；供渲染系统跳过静态几何重建
    /// （change: 2026-10-10-optimize-canvas-interaction-hot-path，design D3/D4）。
    pub(crate) viewport_only: bool,
    pub(crate) observer_changed: bool,
    /// 本帧是否重建了静态 2D mesh（由 `canvas2d::render` 置位，app 层据此上报实际工作计数）。
    pub(crate) mesh_rebuilt: bool,
    /// Actual ordinary-card blocks rebuilt; unchanged blocks retain GPU handles.
    pub(crate) card_blocks_rebuilt: u64,
    pub(crate) card_decorations_rebuilt: u64,
    pub(crate) edge_blocks_rebuilt: u64,
    pub(crate) container_blocks_rebuilt: u64,
    pub(crate) canvas_committed: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exit_keeps_selected_model_until_transition_finishes() {
        let mut rig = FocusRig::default();
        rig.sync_focus_node(Some("model-a"));
        rig.transition.elapsed = 0.0;
        rig.sync_focus_node(None);
        assert_eq!(rig.focus_node.as_deref(), Some("model-a"));
        rig.transition.elapsed = rig.transition.duration;
        rig.sync_focus_node(None);
        assert_eq!(rig.focus_node, None);
    }

    #[test]
    fn selecting_another_model_during_exit_replaces_isolation() {
        let mut rig = FocusRig::default();
        rig.sync_focus_node(Some("model-a"));
        rig.transition.elapsed = 0.0;
        rig.sync_focus_node(None);
        rig.sync_focus_node(Some("model-b"));
        assert_eq!(rig.focus_node.as_deref(), Some("model-b"));
    }

    fn progress(generation: u32, kind: &str, value: f32) -> crate::protocol::FocusTransitionProgress {
        crate::protocol::FocusTransitionProgress {
            version: crate::protocol::FOCUS_TRANSITION_VERSION.to_string(),
            node_id: "m1".to_string(),
            kind: kind.to_string(),
            progress: value,
            runtime_generation: generation,
            transition_id: 1,
        }
    }

    #[test]
    fn public_progress_maps_elapsed_without_consuming_delta() {
        // design D6/D7：携带公共进度时按进度求值，不叠加独立 delta。
        let mut rig = FocusRig::default();
        rig.transition.from = Transform::from_xyz(0.0, 0.0, 0.0);
        rig.transition.target = Transform::from_xyz(100.0, 0.0, 0.0);
        rig.transition.duration = 1.0;
        rig.transition.elapsed = 0.0;
        assert!(rig.accept_transition_progress(Some(&progress(1, "model", 0.5)), Some("m1")));
        // 两次推进相同的公共进度得到同一姿态（时间源是进度，而非 delta）。
        let first = rig.advance(0.25);
        let second = rig.advance(0.25);
        assert!(first.translation.abs_diff_eq(second.translation, 1e-6));
        assert!((rig.transition.elapsed - 0.5).abs() < 1e-6);
    }

    #[test]
    fn stale_generation_progress_is_ignored() {
        let mut rig = FocusRig::default();
        assert!(rig.accept_transition_progress(Some(&progress(5, "model", 0.5)), Some("m1")));
        // 旧代（更小 generation）被丢弃。
        assert!(!rig.accept_transition_progress(Some(&progress(4, "model", 0.5)), Some("m1")));
        // 不匹配节点 / 非三维 kind 也不采用。
        assert!(!rig.accept_transition_progress(Some(&progress(6, "model", 0.5)), Some("m2")));
        assert!(!rig.accept_transition_progress(Some(&progress(6, "image", 0.5)), Some("m1")));
        // 缺失进度回退内部计时。
        assert!(!rig.accept_transition_progress(None, Some("m1")));
    }
}
