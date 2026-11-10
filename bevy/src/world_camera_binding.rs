//! 共享世界镜头的**单实例绑定**渲染层路由：卡片预览、第一人称编辑预览与页面捕获三处共用。
//!
//! 共享世界里的每个实例都待在主画布层 0，主画布因此保持不变。未绑定镜头看专用世界内容层 11
//! （真实共享世界构图）；绑定镜头只看目标实例，所以目标模型根额外加入一条从共享
//! `preview_layers` 池租来的专用层，绑定相机只渲染该层。缺目标绝不退回全世界：相机渲染空层，
//! 捕获返回稳定失败码。
//!
//! 层租约按实例身份持有：同一实例被多个镜头绑定只占一条层，全部释放后归还池并把该层从
//! 活的模型根上摘掉，避免同层被下一个实例复用时把旧实例带进新镜头。容量与模型/镜头卡片
//! 预览共用同一上限（`preview_layers::CAPACITY`），池满返回明确不可用而不是增长层号。

use std::collections::{HashMap, HashSet};

use bevy::{camera::visibility::RenderLayers, prelude::*};

use crate::app::PreviewLayerPool;
use crate::model3d::ModelVisuals;
use crate::protocol::{GraphNode, Scene};

/// 拍摄用共享世界内容层：含世界几何，不含全局方向光与网格。
pub(crate) const WORLD_LAYER: usize = crate::preview_layers::WORLD_CAMERA_CONTENT_LAYER;

/// 当前持有绑定层租约的实例：`instanceId → layer`。
#[derive(Resource, Default)]
pub(crate) struct WorldCameraBinding {
    layers: HashMap<String, usize>,
}

/// 一帧内某个镜头的绑定解析结果。
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum BindingResolution {
    /// 未绑定：相机看整层世界内容 11（真实共享世界）。
    WholeWorld,
    /// 绑定到 `node_id` 实例，只渲染租来的 `layer`。
    Instance { node_id: String, layer: usize },
    /// 绑定了实例，但该 `instanceId` 在已接受场景里不存在。
    Missing,
    /// 目标存在，但共享预览层池已满，无法隔离。
    Unavailable,
}

impl BindingResolution {
    fn instance_layer(&self) -> Option<usize> {
        match self {
            Self::Instance { layer, .. } => Some(*layer),
            _ => None,
        }
    }
}

impl WorldCameraBinding {
    /// 测试核对当前活跃绑定层；不并入全局灯光。
    #[cfg(test)]
    fn layers(&self) -> impl Iterator<Item = usize> + '_ {
        self.layers.values().copied()
    }

    /// 当前是否持有某实例的绑定层。
    pub(crate) fn layer(&self, instance_id: &str) -> Option<usize> {
        self.layers.get(instance_id).copied()
    }

    fn acquire(&mut self, pool: &mut PreviewLayerPool, instance_id: &str) -> Option<usize> {
        if let Some(&layer) = self.layers.get(instance_id) {
            return Some(layer);
        }
        let owner = binding_owner(instance_id);
        let Some(slot) = pool.0.acquire(&owner) else {
            pool.0.note_exhausted();
            return None;
        };
        self.layers.insert(instance_id.to_owned(), slot.layer);
        Some(slot.layer)
    }

    /// 解析一台镜头的可选绑定；目标存在时取得（或复用）其绑定层。
    pub(crate) fn resolve(
        &mut self,
        scene: &Scene,
        pool: &mut PreviewLayerPool,
        bound_instance_id: Option<&str>,
    ) -> BindingResolution {
        let Some(instance_id) = bound_instance_id else {
            return BindingResolution::WholeWorld;
        };
        let Some(node) = node_for_instance(scene, instance_id) else {
            return BindingResolution::Missing;
        };
        match self.acquire(pool, instance_id) {
            Some(layer) => BindingResolution::Instance {
                node_id: node.id.clone(),
                layer,
            },
            None => BindingResolution::Unavailable,
        }
    }

    /// 归还本帧不再需要的绑定层，并把它从活的模型根上摘掉。`keep` 是仍需该绑定的实例集合
    /// （由所有世界镜头与在飞捕获共同给出）。
    pub(crate) fn retain(
        &mut self,
        scene: &Scene,
        models: &ModelVisuals,
        commands: &mut Commands,
        pool: &mut PreviewLayerPool,
        keep: &HashSet<String>,
    ) {
        let mut released = Vec::new();
        self.layers.retain(|instance_id, _| {
            if keep.contains(instance_id) {
                return true;
            }
            released.push(instance_id.clone());
            false
        });
        for instance_id in released {
            if let Some(node) = node_for_instance(scene, &instance_id) {
                crate::model3d::set_bound_instance_layer(models, commands, &node.id, None);
            }
            pool.0.release(&binding_owner(&instance_id));
        }
    }
}

/// 相机渲染层：绑定实例只看该层，未绑定看整层世界内容 11，缺失/不可用渲染空层。
/// `editor_guide` 只在编辑取景加上 9 号辅助层，且**不会**带回世界层 0。
pub(crate) fn camera_layers(resolution: &BindingResolution, editor_guide: bool) -> RenderLayers {
    let mut layers = match resolution.instance_layer() {
        Some(layer) => RenderLayers::layer(layer),
        None => match resolution {
            BindingResolution::WholeWorld => RenderLayers::layer(WORLD_LAYER),
            _ => RenderLayers::none(),
        },
    };
    if editor_guide {
        layers = layers.with(crate::world_camera_preview::EDITOR_GUIDE_LAYER);
    }
    layers
}

/// 页面捕获的绑定层决策：与卡片/编辑预览同一绑定规则，但**绑定失败要明确报错**而不是渲染空层。
///
/// 返回捕获相机应渲染的层与需要保持隔离的实例；失败返回稳定失败码。目标存在但模型根尚未
/// spawn 时按 `capture-instance-not-ready` 明确等待，不退回全世界。
pub(crate) fn capture_layers(
    resolution: &BindingResolution,
    models: &ModelVisuals,
    bound_instance_id: Option<&str>,
) -> Result<(RenderLayers, Option<String>), &'static str> {
    match resolution {
        BindingResolution::WholeWorld => Ok((RenderLayers::layer(WORLD_LAYER), None)),
        BindingResolution::Instance { node_id, layer } => {
            if !models.has_root(node_id) {
                return Err("capture-instance-not-ready");
            }
            Ok((RenderLayers::layer(*layer), bound_instance_id.map(str::to_owned)))
        }
        BindingResolution::Missing => Err("capture-instance-not-found"),
        BindingResolution::Unavailable => Err("capture-binding-unavailable"),
    }
}

fn node_for_instance<'a>(scene: &'a Scene, instance_id: &str) -> Option<&'a GraphNode> {
    scene.nodes.iter().find(|node| {
        node.shared_world_instance
            .as_ref()
            .is_some_and(|instance| instance.instance_id == instance_id)
    })
}

fn binding_owner(instance_id: &str) -> String {
    format!("world-binding:{instance_id}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn instance_node(node_id: &str, instance_id: &str) -> serde_json::Value {
        serde_json::json!({
            "id": node_id,
            "type": "model3d",
            "x": 0.0,
            "y": 0.0,
            "width": 200.0,
            "height": 200.0,
            "sharedWorldInstance": {
                "kind": "world-instance",
                "version": "shared-world-v1",
                "instanceId": instance_id,
                "transform": {
                    "version": "shared-world-v1",
                    "position": { "u": 0.0, "v": 0.0, "h": 0.0 },
                    "rotation": [0.0, 0.0, 0.0, 1.0],
                    "scale": 1.0
                }
            }
        })
    }

    fn scene_with(instances: &[(&str, &str)]) -> Scene {
        let nodes = instances
            .iter()
            .map(|(node_id, instance_id)| {
                serde_json::from_value(instance_node(node_id, instance_id)).unwrap()
            })
            .collect();
        Scene {
            nodes,
            ..Scene::default()
        }
    }

    #[test]
    fn unbound_camera_keeps_the_whole_world() {
        let scene = scene_with(&[("a", "instance-a")]);
        let mut pool = PreviewLayerPool::default();
        let mut bindings = WorldCameraBinding::default();
        let resolution = bindings.resolve(&scene, &mut pool, None);
        assert_eq!(resolution, BindingResolution::WholeWorld);
        assert!(camera_layers(&resolution, false).intersects(&RenderLayers::layer(WORLD_LAYER)));
        assert!(!camera_layers(&resolution, false).intersects(&RenderLayers::layer(0)));
        assert!(bindings.layers().next().is_none());
    }

    #[test]
    fn bound_camera_only_sees_its_target_layer() {
        let scene = scene_with(&[("a", "instance-a"), ("b", "instance-b")]);
        let mut pool = PreviewLayerPool::default();
        let mut bindings = WorldCameraBinding::default();
        let resolution = bindings.resolve(&scene, &mut pool, Some("instance-a"));
        let BindingResolution::Instance { node_id, layer } = &resolution else {
            panic!("expected instance binding, got {resolution:?}");
        };
        assert_eq!(node_id, "a");
        let layers = camera_layers(&resolution, false);
        assert!(layers.intersects(&RenderLayers::layer(*layer)));
        assert!(
            !layers.intersects(&RenderLayers::layer(0)),
            "绑定相机不得再看到整层世界"
        );
        assert_eq!(bindings.layer("instance-a"), Some(*layer));
        assert_eq!(bindings.layer("instance-b"), None);
    }

    #[test]
    fn missing_target_renders_an_empty_layer_not_the_whole_world() {
        let scene = scene_with(&[("a", "instance-a")]);
        let mut pool = PreviewLayerPool::default();
        let mut bindings = WorldCameraBinding::default();
        let resolution = bindings.resolve(&scene, &mut pool, Some("gone"));
        assert_eq!(resolution, BindingResolution::Missing);
        let layers = camera_layers(&resolution, false);
        assert_eq!(layers.iter().count(), 0);
        assert!(!layers.intersects(&RenderLayers::layer(0)));
    }

    #[test]
    fn unavailable_binding_renders_an_empty_layer() {
        let scene = scene_with(&[("a", "instance-a")]);
        let mut pool = PreviewLayerPool::default();
        // 吃满池：绑定已无槽位。
        for index in 0..crate::preview_layers::CAPACITY {
            assert!(pool.0.acquire(&format!("card-{index}")).is_some());
        }
        let mut bindings = WorldCameraBinding::default();
        let resolution = bindings.resolve(&scene, &mut pool, Some("instance-a"));
        assert_eq!(resolution, BindingResolution::Unavailable);
        let layers = camera_layers(&resolution, false);
        assert_eq!(layers.iter().count(), 0);
    }

    #[test]
    fn multiple_cameras_are_independent_and_release_only_unused_layers() {
        let scene = scene_with(&[("a", "instance-a"), ("b", "instance-b")]);
        let mut pool = PreviewLayerPool::default();
        let mut bindings = WorldCameraBinding::default();
        let a = bindings.resolve(&scene, &mut pool, Some("instance-a"));
        let b = bindings.resolve(&scene, &mut pool, Some("instance-b"));
        let (BindingResolution::Instance { layer: la, .. }, BindingResolution::Instance { layer: lb, .. }) =
            (&a, &b)
        else {
            panic!("both instances must bind");
        };
        assert_ne!(la, lb, "两个实例必须拿到不同层");
        assert_eq!(pool.0.active(), 2);

        let mut keep = HashSet::new();
        keep.insert("instance-a".to_owned());
        // b 不再被任何镜头需要：只回收 b。
        let mut app = App::new();
        let mut commands = app.world_mut().commands();
        bindings.retain(
            &scene,
            &ModelVisuals::default(),
            &mut commands,
            &mut pool,
            &keep,
        );
        assert_eq!(bindings.layer("instance-a"), Some(*la));
        assert_eq!(bindings.layer("instance-b"), None);
        assert_eq!(pool.0.active(), 1);

        // 释放后的层可被下一实例复用，且代数更大。
        let reused = bindings.resolve(&scene, &mut pool, Some("instance-b"));
        let BindingResolution::Instance { layer, .. } = reused else {
            panic!("instance-b should rebind");
        };
        assert_eq!(layer, *lb, "最小空闲槽优先");
    }

    #[test]
    fn editor_guide_layer_never_reintroduces_the_world_layer() {
        let binding = BindingResolution::Instance {
            node_id: "a".to_owned(),
            layer: 40,
        };
        let layers = camera_layers(&binding, true);
        assert!(layers.intersects(&RenderLayers::layer(40)));
        assert!(layers.intersects(&RenderLayers::layer(
            crate::world_camera_preview::EDITOR_GUIDE_LAYER
        )));
        assert!(!layers.intersects(&RenderLayers::layer(0)));
    }

    #[test]
    fn capture_whole_world_uses_the_world_layer() {
        let (layers, hold) =
            capture_layers(&BindingResolution::WholeWorld, &ModelVisuals::default(), None)
                .expect("unbound capture");
        assert!(layers.intersects(&RenderLayers::layer(WORLD_LAYER)));
        assert_eq!(hold, None);
    }

    #[test]
    fn capture_bound_binding_failures_are_explicit() {
        let models = ModelVisuals::default();
        assert_eq!(
            capture_layers(&BindingResolution::Missing, &models, Some("gone")),
            Err("capture-instance-not-found")
        );
        assert_eq!(
            capture_layers(&BindingResolution::Unavailable, &models, Some("a")),
            Err("capture-binding-unavailable")
        );
        // 目标存在但模型根尚未 spawn：明确等待，不退回全世界。
        let resolution = BindingResolution::Instance {
            node_id: "a".to_owned(),
            layer: 40,
        };
        assert_eq!(
            capture_layers(&resolution, &models, Some("a")),
            Err("capture-instance-not-ready")
        );
    }
}
