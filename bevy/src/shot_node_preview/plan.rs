//! 卡片预览目标派生与采样身份
//! （change: 2026-10-15-add-film-set-shooting-shot-previews，design D7）。
//!
//! 这里是**纯投影**：从 Render Scene + 宿主给出的共享包围球查找派生「哪些卡片要采什么画面」。
//! 不含 ECS、不读 GPU，因此可在无 GPU 的环境回归 dirty 边界（内容变→重采；改名/移卡片→不重采）。
//!
//! 采样身份（[`SampleIdentity`]）是就绪代数的事实源：源内容、镜头、时间、播放代数和目标尺寸
//! 档任一变化都必须重新采样，迟到结果不得覆盖新目标。

use bevy::prelude::*;

use crate::{
    model3d::shot_adapter::ModelBounds,
    protocol::{CompositeAssetPresentation, GraphNode, ModelReference, Scene, ShotPreviewPresentation},
    shot_camera::ShotCameraPose,
};

use crate::canvas_query::shot_preview as card_geometry;

/// 一次采样的完整身份：任一字段变化都必须重新采样，迟到结果不得覆盖新目标。
///
/// **不含逐帧播放时间**：活动动态卡片每帧都按同一 T 重新渲染到同一张 Image，像素新鲜度由
/// 「每帧触发 + 同一 Image」保证；若把逐帧时间放进身份，就绪检查永远追不上而变化，活动卡片
/// 会被永久钉在准备态。`playback` 只区分「同一源内容的哪一次播放会话」，重启播放必须重采。
#[derive(Clone, PartialEq, Eq, Debug)]
pub(crate) struct SampleIdentity {
    /// 源内容身份（共享 item 摆放/媒体帧/镜头构图/画幅/类型/质量）。
    pub(super) content: String,
    /// 目标纹理尺寸档（`[w, h]`；位置与滚动像素不进入）。
    pub(super) size: [u32; 2],
    /// 播放会话代数（活动卡片取自播放投影；封面恒为 0，重启播放必须重采）。
    pub(super) playback: u32,
}

/// 一个应存在的卡片预览目标。
pub(super) struct Target {
    pub(super) node_id: String,
    /// 归属源片场 canonical 节点 id（渲染层并集与包围球按它派生）。
    pub(super) owner: String,
    pub(super) clip_id: String,
    /// 是否为唯一活动动态播放目标（活动卡片按播放时钟推进，其余只取零点封面）。
    pub(super) live: bool,
    /// 采样相机姿态（活动：同一 T 的采样相机；封面：`coverCamera`）。
    pub(super) pose: ShotCameraPose,
    pub(super) bounds: ModelBounds,
    pub(super) aspect: f32,
    /// 内容身份（不含尺寸档、不含播放时钟）。
    pub(super) content: String,
    /// 本次采样时间（位模式；仅诊断/断言用，**不进入** [`SampleIdentity`]）。
    pub(super) time: u32,
    /// 播放会话代数（活动卡片取自播放投影；封面恒为 0）。
    pub(super) generation: u32,
    pub(super) visible: bool,
    /// 归属片场仍在 native 后台准备中（未发布完整表示）。
    ///
    /// 这种卡片不能采样：此时层并集里没有模型实体，采样结果会是清屏色，发布出去就是
    /// 「合法空场」的灰底。消费者改为等待，发布后表示身份变化会重新武装采样。
    pub(super) awaiting_root: bool,
}

/// 当前活动动态播放投影（同一 T 的采样相机）。
#[derive(Clone, Copy)]
pub(super) struct LiveSampling<'a> {
    pub(super) playback: &'a crate::protocol::AnimationPlayback,
    pub(super) camera: &'a crate::motion::CameraState,
}

/// 捕捉预览卡片时同时保留归属片场，覆盖首次请求尚未路由的窗口。
pub(crate) fn pin_capture_owners(scene: &Scene, pins: &mut std::collections::HashSet<String>) {
    let owners: Vec<String> = scene.nodes.iter()
        .filter(|node| pins.contains(&node.id))
        .filter_map(|node| node.shot_preview.as_ref())
        .map(|preview| preview.film_set_node_id.clone())
        .collect();
    pins.extend(owners);
}

/// 由场景派生全部卡片预览目标；只取同时具备合格源片场包围球的预览节点。
///
/// `bounds_of` 由宿主注入（共享 `model_bounds_for_node`，避免本模块依赖 wasm-only 入口）；
/// `quality_of` 注入渲染质量身份（卡片 dirty key 的一部分，design D7）；
/// `live` 只认「`shot-node-preview` 模式且目标卡片匹配」的唯一活动镜头（design D6/D7）。
pub(super) fn targets(
    scene: &Scene,
    bounds_of: &dyn Fn(&str) -> Option<ModelBounds>,
    quality_of: &dyn Fn(&str) -> String,
    live: Option<LiveSampling<'_>>,
) -> Vec<Target> {
    targets_with_preparation(scene, bounds_of, quality_of, live, &|_| false)
}

/// 同 [`targets`]，额外注入「归属片场是否仍在准备中」。
pub(super) fn targets_with_preparation(
    scene: &Scene,
    bounds_of: &dyn Fn(&str) -> Option<ModelBounds>,
    quality_of: &dyn Fn(&str) -> String,
    live: Option<LiveSampling<'_>>,
    preparing_of: &dyn Fn(&str) -> bool,
) -> Vec<Target> {
    let hidden = card_geometry::focuses_isolate(scene);
    let viewport = [scene.viewport.x, scene.viewport.y, scene.viewport.zoom];
    let surface = scene
        .surface
        .as_ref()
        .map(|surface| Vec2::new(surface.width, surface.height))
        .unwrap_or(Vec2::ZERO);
    let mut result = Vec::new();
    for node in &scene.nodes {
        let Some(preview) = node.shot_preview.as_ref() else {
            continue;
        };
        let Some(owner) = scene.nodes.iter().find(|candidate| {
            candidate.id == preview.film_set_node_id && candidate.composite_asset.is_some()
        }) else {
            continue;
        };
        let is_live = live.is_some_and(|sampling| {
            preview.kind == "dynamic"
                && sampling.playback.node_id == owner.id
                && sampling.playback.target_preview_node_id.as_deref() == Some(node.id.as_str())
        });
        // 空片场（无模型/无媒体）也要有可辨识画面：退化为世界原点的退化包围球，而不是不画。
        let bounds = bounds_of(&owner.id).unwrap_or(ModelBounds {
            center: Vec3::ZERO,
            radius: 0.0,
        });
        let pose = if let (true, Some(sampling)) = (is_live, live) {
            let camera = sampling.camera;
            ShotCameraPose {
                azimuth: camera.azimuth,
                elevation: camera.elevation,
                distance: camera.distance,
                focus_offset: camera.focus_offset,
            }
        } else {
            ShotCameraPose {
                azimuth: preview.cover_camera.azimuth,
                elevation: preview.cover_camera.elevation,
                distance: preview.cover_camera.distance,
                focus_offset: Vec3::from_array(preview.cover_camera.focus_offset),
            }
        };
        result.push(Target {
            node_id: node.id.clone(),
            owner: owner.id.clone(),
            clip_id: preview.clip_id.clone(),
            live: is_live,
            pose,
            bounds,
            aspect: card_geometry::shot_preview_aspect(node),
            content: content_identity(
                owner,
                owner.composite_asset.as_ref(),
                owner.model.as_ref(),
                preview,
                &quality_of(&owner.id),
            ),
            time: if is_live {
                live.map(|sampling| sampling.playback.time.to_bits()).unwrap_or(0)
            } else {
                0
            },
            generation: if is_live {
                live.map(|sampling| sampling.playback.generation).unwrap_or(0)
            } else {
                0
            },
            visible: !hidden && card_geometry::visible_on_surface(node, viewport, surface),
            awaiting_root: preparing_of(&owner.id),
        });
    }
    result
}

/// 源内容身份：镜头构图/类型/画幅/时长 + 共享 item 摆放与媒体帧身份 + 模型引用 + 渲染质量。
///
/// **排除**卡片名称、卡片位置/尺寸与画布平移（design D7）：它们变化不重编译几何。
/// `BTreeMap`/排序化摆放、媒体与 itemRoots，避免 wire 的 HashMap 顺序造成假 dirty。
pub(super) fn content_identity(
    owner: &GraphNode,
    asset: Option<&CompositeAssetPresentation>,
    reference: Option<&ModelReference>,
    preview: &ShotPreviewPresentation,
    quality: &str,
) -> String {
    let placements = asset.map(|asset| {
        asset
            .item_placements
            .iter()
            .collect::<std::collections::BTreeMap<_, _>>()
    });
    let media: Vec<String> = asset
        .map(|asset| {
            asset
                .media
                .iter()
                .map(|plane| {
                    format!(
                        "{}:{}:{:?}:{:?}:{:?}:{:?}:{}",
                        plane.id, plane.kind, plane.x, plane.y, plane.z, plane.width, plane.height
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    let roots = asset.map(|asset| {
        let mut roots: Vec<_> = asset.item_roots.iter().collect();
        roots.sort();
        roots
    });
    format!(
        "owner={}:clip={}:kind={}:aspect={:?}:duration={:?}:cover={:?}:items={:?}:media={:?}:roots={:?}:model={}:sig={}:quality={}:content={:?}",
        owner.id,
        preview.clip_id,
        preview.kind,
        preview.aspect,
        preview.duration,
        preview.cover_camera,
        placements,
        media,
        roots,
        reference.map_or("", |reference| reference.resource_key.as_str()),
        reference.map_or("", |reference| reference.signature.as_str()),
        quality,
        asset.map(|asset| (asset.content_extent, asset.root_placement.as_ref())),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn preview_node(id: &str, x: f32) -> GraphNode {
        serde_json::from_str(&format!(
            r#"{{"id":"{id}","type":"film-set-shot-preview","x":{x},"y":0,"width":240,"height":167,
                "shotPreview":{{"filmSetNodeId":"film","clipId":"clip-1","kind":"dynamic","name":"镜头",
                "aspect":1.7777778,"duration":5,"state":"ready",
                "coverCamera":{{"azimuth":0.5,"elevation":0.7,"distance":8,"focusOffset":[0,1,0]}}}}}}"#
        ))
        .unwrap()
    }

    fn owner_node(x: f32, media_size: f32) -> GraphNode {
        serde_json::from_str(&format!(
            r#"{{"id":"film","type":"composite-asset","x":{x},"y":0,"width":400,"height":300,
                "compositeAsset":{{"x":0,"y":0,"width":400,"height":300,"contentExtent":2,
                "itemPlacements":{{"a":{{"offset":[0,0,0],"scale":1,"yaw":0}}}},
                "media":[{{"id":"film::video","kind":"video","x":0,"y":0.5,"z":0,"width":{media_size},"height":0.9,"yaw":0}}]}}}}"#
        ))
        .unwrap()
    }

    fn scene_of(owner: GraphNode, preview: GraphNode) -> Scene {
        Scene {
            nodes: vec![owner, preview],
            ..default()
        }
    }

    fn identity(scene: &Scene, quality: &str) -> String {
        let owner = &scene.nodes[0];
        let preview = scene.nodes[1].shot_preview.as_ref().unwrap();
        content_identity(
            owner,
            owner.composite_asset.as_ref(),
            owner.model.as_ref(),
            preview,
            quality,
        )
    }

    #[test]
    fn queued_offscreen_capture_pins_owner_before_routing() {
        let scene = scene_of(owner_node(0.0, 1.6), preview_node("shot-preview:x", 100000.0));
        let mut pins = std::collections::HashSet::from(["shot-preview:x".to_string()]);
        pin_capture_owners(&scene, &mut pins);
        assert!(pins.contains("film"));
        assert!(pins.contains("shot-preview:x"));
        let mut unrelated = std::collections::HashSet::from(["other".to_string()]);
        pin_capture_owners(&scene, &mut unrelated);
        assert!(!unrelated.contains("film"));
    }

    #[test]
    fn card_name_and_position_do_not_change_content_identity() {
        let base = scene_of(owner_node(0.0, 1.6), preview_node("shot-preview:x", 0.0));
        let moved = scene_of(owner_node(800.0, 1.6), preview_node("shot-preview:x", 500.0));
        assert_eq!(identity(&base, "high:1"), identity(&moved, "high:1"));
        // 画布平移不进入身份。
        let mut panned = scene_of(owner_node(0.0, 1.6), preview_node("shot-preview:x", 0.0));
        panned.viewport.x = -900.0;
        assert_eq!(identity(&base, "high:1"), identity(&panned, "high:1"));
        // 卡片名称变化（源镜头改名由 title/typeLabel 投影）不重编译几何身份。
        let mut renamed = scene_of(owner_node(0.0, 1.6), preview_node("shot-preview:x", 0.0));
        renamed.nodes[1].shot_preview.as_mut().unwrap().name = "新名字".to_owned();
        assert_eq!(identity(&base, "high:1"), identity(&renamed, "high:1"));
    }

    #[test]
    fn shared_item_media_and_quality_changes_are_dirty() {
        let base = scene_of(owner_node(0.0, 1.6), preview_node("shot-preview:x", 0.0));
        let wide_media = scene_of(owner_node(0.0, 2.4), preview_node("shot-preview:x", 0.0));
        assert_ne!(identity(&base, "high:1"), identity(&wide_media, "high:1"));
        assert_ne!(identity(&base, "high:1"), identity(&base, "overview:1"));
        // 镜头构图变化（封面相机）必须重采。
        let mut turned = scene_of(owner_node(0.0, 1.6), preview_node("shot-preview:x", 0.0));
        turned.nodes[1].shot_preview.as_mut().unwrap().cover_camera.azimuth = 1.2;
        assert_ne!(identity(&base, "high:1"), identity(&turned, "high:1"));
        // 共享 item 摆放变化必须重采。
        let mut moved_item = scene_of(owner_node(0.0, 1.6), preview_node("shot-preview:x", 0.0));
        moved_item.nodes[0]
            .composite_asset
            .as_mut()
            .unwrap()
            .item_placements
            .get_mut("a")
            .unwrap()
            .offset = crate::protocol::ModelOffset {
            x: 1.0,
            y: 0.0,
            z: 0.0,
        };
        assert_ne!(identity(&base, "high:1"), identity(&moved_item, "high:1"));
        // 归属源不同（同内容不同片场）不得互相复用。
        let mut other_owner = scene_of(owner_node(0.0, 1.6), preview_node("shot-preview:x", 0.0));
        other_owner.nodes[0].id = "film-2".to_owned();
        other_owner.nodes[1].shot_preview.as_mut().unwrap().film_set_node_id = "film-2".to_owned();
        assert_ne!(identity(&base, "high:1"), identity(&other_owner, "high:1"));
    }

    #[test]
    fn targets_skip_nodes_without_owner_or_presentation() {
        let bounds = |_: &str| None;
        let quality = |_: &str| String::new();
        let orphan = Scene {
            nodes: vec![preview_node("shot-preview:x", 0.0)],
            ..default()
        };
        assert!(targets(&orphan, &bounds, &quality, None).is_empty());
        let plain: Scene = Scene {
            nodes: vec![serde_json::from_str(r#"{"id":"n","type":"image","x":0,"y":0}"#).unwrap()],
            ..default()
        };
        assert!(targets(&plain, &bounds, &quality, None).is_empty());
    }

    #[test]
    fn targets_cover_pose_and_live_pose_come_from_their_owners() {
        let bounds = |_: &str| {
            Some(ModelBounds {
                center: Vec3::ZERO,
                radius: 4.0,
            })
        };
        let quality = |_: &str| "high:1".to_owned();
        let scene = scene_of(owner_node(0.0, 1.6), preview_node("shot-preview:x", 0.0));
        let covers = targets(&scene, &bounds, &quality, None);
        assert_eq!(covers.len(), 1);
        assert!(!covers[0].live, "无播放投影时只取零点封面");
        assert_eq!(covers[0].pose.azimuth, 0.5);
        assert_eq!(covers[0].time, 0);
        assert_eq!(covers[0].owner, "film");

        // 同一 T 的采样相机：活动动态卡片消费播放投影，而不是封面相机。
        let playback: crate::protocol::AnimationPlayback = serde_json::from_str(
            r#"{"clipId":"clip-1","nodeId":"film","version":"woohaa-motion-ir-v1","viewMode":"shot-node-preview",
                "targetPreviewNodeId":"shot-preview:x","time":2.5,"duration":5,"generation":7,
                "initialCamera":{"aspect":"16:9","azimuth":0,"elevation":0.785398,"distance":8,"focusOffset":[0,0,0]}}"#,
        )
        .unwrap();
        let camera = crate::motion::CameraState {
            azimuth: 1.1,
            elevation: 0.2,
            distance: 12.0,
            focus_offset: Vec3::new(1.0, 0.0, 0.0),
        };
        let live = targets(
            &scene,
            &bounds,
            &quality,
            Some(LiveSampling {
                playback: &playback,
                camera: &camera,
            }),
        );
        assert!(live[0].live);
        assert_eq!(live[0].pose.azimuth, 1.1);
        assert_eq!(live[0].time, 2.5f32.to_bits());
        assert_eq!(live[0].generation, 7);
        // 目标卡片不匹配时不进入活动态（唯一活动时钟）。
        let mismatched: crate::protocol::AnimationPlayback = serde_json::from_str(
            r#"{"clipId":"clip-1","nodeId":"film","version":"woohaa-motion-ir-v1","viewMode":"shot-node-preview",
                "targetPreviewNodeId":"shot-preview:other","time":2.5,"duration":5,"generation":7,
                "initialCamera":{"aspect":"16:9","azimuth":0,"elevation":0.785398,"distance":8,"focusOffset":[0,0,0]}}"#,
        )
        .unwrap();
        let covers = targets(
            &scene,
            &bounds,
            &quality,
            Some(LiveSampling {
                playback: &mismatched,
                camera: &camera,
            }),
        );
        assert!(!covers[0].live);
        assert_eq!(covers[0].pose.azimuth, 0.5);
        // 非动态卡片不进入活动态。
        let mut statics = scene_of(owner_node(0.0, 1.6), preview_node("shot-preview:x", 0.0));
        statics.nodes[1].shot_preview.as_mut().unwrap().kind = "static".to_owned();
        let live = targets(
            &statics,
            &bounds,
            &quality,
            Some(LiveSampling {
                playback: &playback,
                camera: &camera,
            }),
        );
        assert!(!live[0].live);
    }

    #[test]
    fn focused_scene_hides_all_cards_and_offscreen_cards_are_not_visible() {
        let bounds = |_: &str| None;
        let quality = |_: &str| String::new();
        let mut scene = scene_of(owner_node(0.0, 1.6), preview_node("shot-preview:x", 0.0));
        scene.surface = Some(serde_json::from_str(r#"{"width":1000,"height":700,"pixelRatio":1}"#).unwrap());
        assert!(targets(&scene, &bounds, &quality, None)[0].visible);
        // 屏外卡片不排连续帧（调用方据此不新建 render target）。
        scene.nodes[1].x = -100_000.0;
        assert!(!targets(&scene, &bounds, &quality, None)[0].visible);
        scene.nodes[1].x = 0.0;
        scene.model_focus = Some(serde_json::from_str(
            r#"{"nodeId":"film","target":[0,0,0],"yaw":0,"pitch":0,"distance":10,"fov":0.87}"#,
        )
        .unwrap());
        assert!(!targets(&scene, &bounds, &quality, None)[0].visible);
    }

    #[test]
    fn preparing_owner_target_waits_instead_of_sampling_a_blank_card() {
        let bounds = |_: &str| {
            Some(ModelBounds {
                center: Vec3::ZERO,
                radius: 4.0,
            })
        };
        let quality = |_: &str| "pending".to_owned();
        let scene = scene_of(owner_node(0.0, 1.6), preview_node("shot-preview:x", 0.0));
        let idle = targets(&scene, &bounds, &quality, None);
        assert!(!idle[0].awaiting_root);
        let preparing = targets_with_preparation(&scene, &bounds, &quality, None, &|_| true);
        assert!(
            preparing[0].awaiting_root,
            "归属片场准备中时卡片必须等待，而不是采样空场"
        );
        // 准备完成后恢复可采样。
        let ready = targets_with_preparation(&scene, &bounds, &quality, None, &|_| false);
        assert!(!ready[0].awaiting_root);
    }

    #[test]
    fn sample_identity_is_equality_by_content_size_and_playback_session() {
        let base = SampleIdentity {
            content: "c".to_owned(),
            size: [512, 288],
            playback: 1,
        };
        assert_eq!(base, base.clone());
        let mut playback = base.clone();
        playback.playback = 2;
        assert_ne!(base, playback);
        let mut size = base.clone();
        size.size = [640, 360];
        assert_ne!(base, size);
        let mut content = base.clone();
        content.content = "d".to_owned();
        assert_ne!(base, content);
        // 播放时钟不进身份：同一身份在任意 T 都相等，活动卡片每帧重画同一张 Image。
        let same = SampleIdentity {
            content: "c".to_owned(),
            size: [512, 288],
            playback: 1,
        };
        assert_eq!(base, same);
    }
}
