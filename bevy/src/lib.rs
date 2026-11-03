//! Woohaa3 画布运行时（共享 Bevy core、WASM 与原生宿主 facade）。
//!
//! 本文件是唯一的画布 public facade（change: refactor-bevy-runtime-modules）：
//! 负责 JSON/ABI 转换；渲染由 `canvas2d` / `model3d` / `app` / `bridge` 拥有。
//!
//! WASM 边界单向：快照进、渲染状态出。Bevy 不维护业务操作、历史或持久化数据。
//!
//! change: enhance-model-scene-authoring-api —— `protocol` 与 `model3d` 的纯构建逻辑
//! （`model3d::scene`）可在 native-renderer 下复用；
//! 原生画布与浏览器通过 `canvas-core` 共用帧系统与 facade；WASM ABI 只在 `wasm` 下导出。

mod frame_samples;
#[cfg(feature = "canvas-core")]
mod runtime_health;

mod clock;
mod generation_progress;
pub mod protocol;
mod startup_trace;
pub mod theme;
mod theme_generated;

/// 动画节点独立播放会话/时钟（change: 2026-10-05-bind-model-animation-to-shots）。
pub mod animation_session;
/// 通用相机过渡状态机（change: refactor-bevy-reusable-components）。
pub mod camera_transition;
/// 画布节点 ECS 投影层与公共组件（change: 2026-10-28-migrate-canvas-rendering-to-bevy-ecs）。
/// 组件在全部 feature 下编译（3D 模块复用 owner/part marker）；投影与批处理只在 `canvas-core`。
/// 实体只活在当前 renderer 实例内：结构变化由唯一投影点处理，位置增量只更新组件，
/// renderer 重建整体丢弃实体层级。第三方扩展最小接入方式见 `canvas_ecs/README.md`。
mod canvas_ecs;
/// 2D 共享纯几何与 interaction 查询（change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm）。
/// 不依赖 Bevy/ECS/wasm，可在 native 下单独测试；`canvas2d` 渲染复用其布局与曲线函数。
mod canvas_query;
/// 画布级 3D 根逐像素深度的平局偏移：纯几何 + 线程本地已接受表
/// （change: 2026-10-27-order-canvas-layers-by-ground-anchor，design D1/D4）。
mod depth_order;
pub mod gizmo_layout;
/// 配置化等距网格（change: refactor-bevy-reusable-components）。
pub mod isometric_grid;
/// 动画节点运动 IR 求值器（change: 2026-10-05-bind-model-animation-to-shots）。
pub mod motion;
/// 独立目标轨道相机（change: refactor-bevy-reusable-components）。
pub mod orbit_camera;
/// 预览渲染层/槽的统一分配与回收
/// （change: 2026-10-23-scale-canvas-media-residency，design D6 / 任务 6.3）。
pub mod preview_layers;
/// 通用 transform 动画插件（change: refactor-bevy-reusable-components）。
pub mod transform_animation;
/// 可复用 transform gizmo（change: refactor-bevy-reusable-components）。
pub mod transform_gizmo;

#[cfg(feature = "canvas-core")]
mod app;
#[cfg(feature = "canvas-core")]
mod bridge;
#[cfg(feature = "canvas-core")]
mod canvas2d;
/// 页面内模型历史缩略图：同一 Bevy App 内一次性离屏渲染
/// （change: 2026-10-26-move-generation-history-to-ai-center，design D6）。
#[cfg(feature = "canvas-core")]
mod history_preview;
#[cfg(feature = "canvas-core")]
mod model_preview;
#[cfg(feature = "canvas-core")]
mod pick_index;
#[cfg(feature = "canvas-core")]
mod shot_capture_wire;

#[cfg(feature = "native-renderer")]
pub mod renderer_protocol;


// `model3d` 的网格/相机依赖 bevy_render；其纯场景构建在 native-renderer 下也可复用。
pub mod model3d;
/// 可复用 shot camera ECS 模块（change: add-reusable-bevy-shot-camera）。
pub mod shot_camera;

/// 跨语言 golden 测试用的纯函数门面（change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm，任务 7.2）。
///
/// 只暴露与本 change 固定行为直接相关的纯派生：FNV-1a UTF-16、canonical signature、模型
/// AABB/extent 与 2D 点命中。这些项本身是 crate 内部实现，这里仅为集成测试提供稳定入口。
#[cfg(feature = "native-renderer")]
pub mod golden_api {
    use crate::protocol::{ModelSnapshot, fnv1a64_utf16 as fnv};

    /// Inspect the validated shared-world input through the production coordinate adapter.
    #[cfg(feature = "canvas-core")]
    pub fn shared_world_projection(json: &str) -> Result<([f64; 3], [f64; 4], f64), String> {
        let scene: crate::protocol::Scene = serde_json::from_str(json).map_err(|e| e.to_string())?;
        scene.validate().map_err(str::to_owned)?;
        let instance = scene.nodes.first().and_then(|node| node.shared_world_instance.as_ref()).ok_or("Missing instance")?;
        let t = &instance.transform;
        Ok((crate::protocol::world_to_renderer([t.position.u, t.position.v, t.position.h]),
            crate::protocol::world_rotation_to_renderer(t.rotation), t.scale))
    }

    /// FNV-1a 64-bit（16 位小写 hex），按 JS UTF-16 code unit 计算。
    pub fn fnv1a64_utf16(text: &str) -> String {
        fnv(text)
    }

    /// `sceneVersion:opsJson` 的兼容 signature。
    pub fn canonical_signature(scene_version: &str, ops_json: &str) -> String {
        crate::protocol::canonical_signature(scene_version, ops_json)
    }

    /// 从 ops JSON 派生模型局部 AABB（`[min, max]`）。
    pub fn derive_aabb_from_ops_json(ops_json: &str) -> Result<([f32; 3], [f32; 3]), String> {
        let model = snapshot_from_ops_json(ops_json)?;
        crate::model3d::derive_aabb(&model)
            .map(|aabb| (aabb.min, aabb.max))
            .ok_or_else(|| "empty model".to_owned())
    }

    /// 从 ops JSON 派生 extent。
    pub fn derive_extent_from_ops_json(ops_json: &str) -> Result<f32, String> {
        let model = snapshot_from_ops_json(ops_json)?;
        Ok(crate::model3d::derive_extent(&model))
    }
    fn snapshot_from_ops_json(ops_json: &str) -> Result<ModelSnapshot, String> {
        let ops = serde_json::from_str(ops_json).map_err(|error| error.to_string())?;
        Ok(ModelSnapshot::new(
            Some(crate::protocol::MODEL_SCENE_IR_V2.to_owned()),
            ops,
            "sig".to_owned(),
            1.0,
            Default::default(),
        ))
    }

    /// 2D 点命中 golden：接收 nodes JSON 与查询点，返回 `kind:nodeId[:side]`（无命中返回 None）。
    pub fn point_hit_kind(
        nodes_json: &str,
        x: f32,
        y: f32,
        zoom: f32,
    ) -> Result<Option<String>, String> {
        crate::canvas_query::interaction::point_hit_golden(nodes_json, x, y, zoom)
    }
}

#[cfg(feature = "wasm")]
use wasm_bindgen::prelude::*;

#[cfg(feature = "wasm")]
use wasm_bindgen::JsValue as BoundaryError;

#[cfg(all(feature = "canvas-core", not(feature = "wasm")))]
#[derive(Debug)]
pub struct BoundaryError(String);
#[cfg(all(feature = "canvas-core", not(feature = "wasm")))]
impl BoundaryError {
    pub fn from_str(message: &str) -> Self {
        Self(message.to_owned())
    }
}
#[cfg(all(feature = "canvas-core", not(feature = "wasm")))]
impl std::fmt::Display for BoundaryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

/// 唤醒停帧的渲染循环：JS→WASM 的提交即使落在静止心跳（250 ms）间隙也必须立刻被处理。
#[cfg(feature = "canvas-core")]
#[inline]
fn wake_canvas() {
    #[cfg(feature = "wasm")]
    crate::app::wake();
}

#[cfg(feature = "canvas-core")]
mod texture_upload;
#[cfg(feature = "canvas-core")]
pub use texture_upload::{set_image_focus_details, set_model_media_texture, set_texture};
#[cfg(all(feature = "canvas-core", not(feature = "wasm")))]
pub use texture_upload::{set_model_media_texture_owned, set_texture_owned};

/// 提交一份完整渲染快照；通过校验后覆盖未消费的旧快照（latest-wins）。
///
/// v5 起节点只携带模型资源引用；v25 起引用只要求 **descriptor 已声明**：已声明但 payload
/// 未驻留是合法 cold/preparing 状态，未声明的 key 才在队列前拒绝整帧
/// （change: 2026-10-23-scale-canvas-media-residency，design D5）。
///
/// 返回接受该帧后新的 interaction generation；同一接受点同步发布 render scene 与
/// interaction snapshot（change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm，design D2/D3）。
#[cfg(feature = "canvas-core")]
#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn set_scene(json: &str) -> Result<u32, BoundaryError> {
    wake_canvas();
    if json.len() > protocol::MAX_SCENE_BYTES {
        return Err(BoundaryError::from_str("Scene payload too large"));
    }
    let scene: protocol::Scene =
        serde_json::from_str(json).map_err(|err| BoundaryError::from_str(&err.to_string()))?;
    scene.validate().map_err(BoundaryError::from_str)?;
    if let Some(missing) = bridge::missing_model_descriptor(&scene) {
        return Err(BoundaryError::from_str(&format!(
            "Unknown model resource {missing}"
        )));
    }
    // 接受点先结算 3D 根逐像素平局偏移：后续模型候选 AABB、徽章底座与根锚点都读同一份结果
    // （change: 2026-10-27-order-canvas-layers-by-ground-anchor，design D1/D3/D4）。
    depth_order::accept_scene(&scene);
    model3d::pick::remember_scene(&scene);
    // 接受点同步发布 2D interaction snapshot 与 render scene
    // （change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm，design D2/D3）。
    let generation = canvas_query::accept_scene(&scene);
    // 实际工作计数：完整场景接受点重建世界索引与模型候选 AABB（纯视口路径不增加）
    // （change: 2026-10-10-optimize-canvas-interaction-hot-path，任务 1.2/3.x）。
    bridge::note_world_snapshot_build();
    bridge::note_pick_candidate_build();
    // 同一接受点派生 3D 模型候选世界 AABB（普通画布 picking 复用）并发布，附带同 generation
    // 的 viewport/surface 相机快照（change: make-shot-framing-zoom-invariant，design D5）。
    canvas_query::model_pick::accept_models(
        pick_index::model_candidates(&scene),
        generation,
        model_pick_camera(&scene),
    );
    canvas_query::gizmo::accept_gizmo_scene(&scene);
    bridge::queue_scene(scene);
    Ok(generation)
}

/// 纯视口增量：复用最近 full scene 的世界几何，只更新 viewport/相机快照与 query generation
/// （change: 2026-10-10-optimize-canvas-interaction-hot-path，design D3）。
///
/// 请求携带 wire 版本、`baseSceneGeneration` 与 `{x,y,zoom}`；校验失败或 base/overview 不匹配时
/// 原子拒绝、不改变 scene/相机/generation，返回稳定错误字符串。成功返回新的 interaction generation。
#[cfg(feature = "canvas-core")]
#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn set_viewport(json: &str) -> Result<u32, BoundaryError> {
    wake_canvas();
    let request: protocol::ViewportUpdateRequest =
        serde_json::from_str(json).map_err(|err| BoundaryError::from_str(&err.to_string()))?;
    request.validate().map_err(BoundaryError::from_str)?;
    // 复用世界索引与模型候选；只推进 query generation 与同代相机快照。
    let generation = canvas_query::interaction::accept_viewport(
        request.base_scene_generation,
        request.viewport.clone(),
    )
    .map_err(BoundaryError::from_str)?;
    // 同代相机快照：surface 保持最近 full scene 的值（视口增量不改 surface）。
    let surface = bridge::current_scene_surface().unwrap_or([1.0, 1.0]);
    canvas_query::model_pick::accept_viewport_camera(
        [
            request.viewport.x,
            request.viewport.y,
            request.viewport.zoom,
        ],
        surface,
        generation,
    );
    bridge::queue_viewport(request.viewport);
    Ok(generation)
}

/// 聚焦观察镜头增量：复用最近 full scene 的世界几何，只更新 `modelFocus` 与节点 `modelPreview`。
#[cfg(feature = "canvas-core")]
#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn set_observer(json: &str) -> Result<u32, BoundaryError> {
    wake_canvas();
    let request: protocol::ObserverUpdateRequest =
        serde_json::from_str(json).map_err(|err| BoundaryError::from_str(&err.to_string()))?;
    request.validate().map_err(BoundaryError::from_str)?;
    let generation =
        canvas_query::interaction::accept_observer(request.base_scene_generation, &request.node_id)
            .map_err(BoundaryError::from_str)?;
    canvas_query::gizmo::accept_gizmo_observer(&request);
    bridge::queue_observer(request);
    Ok(generation)
}

#[cfg(feature = "canvas-core")]
#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn observer_capability() -> String {
    protocol::CANVAS_OBSERVER_UPDATE_VERSION.to_owned()
}

/// Absolute position previews: validate all render/query geometry before publishing.
#[cfg(feature = "canvas-core")]
#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn set_positions(json: &str) -> Result<u32, BoundaryError> {
    wake_canvas();
    if json.len() > protocol::MAX_POSITION_UPDATE_BYTES {
        return Err(BoundaryError::from_str("Position payload too large"));
    }
    let request: protocol::PositionUpdateRequest =
        serde_json::from_str(json).map_err(|err| BoundaryError::from_str(&err.to_string()))?;
    let (generation, _) =
        canvas_query::interaction::accept_positions(&request).map_err(BoundaryError::from_str)?;
    bridge::queue_positions(request.positions, request.viewport);
    Ok(generation)
}

#[cfg(feature = "canvas-core")]
#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn position_capability() -> String {
    protocol::CANVAS_POSITION_UPDATE_VERSION.to_owned()
}

/// 最近一次完整场景接受的 base generation（供 Frontend 缓存 base 身份做增量引用）。
#[cfg(feature = "canvas-core")]
#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn base_scene_generation() -> u32 {
    canvas_query::interaction::base_generation()
}

/// 视口能力版本字符串；Frontend loader 据非空/匹配校验 WASM 视口能力
/// （change: 2026-10-10-optimize-canvas-interaction-hot-path，design D3）。
#[cfg(feature = "canvas-core")]
#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn viewport_capability() -> String {
    protocol::CANVAS_VIEWPORT_UPDATE_VERSION.to_owned()
}

/// 场景 wire 能力版本字符串；Frontend loader 据非空/匹配校验 WASM scene 能力，旧 WASM 明确
/// 拒绝而不是静默忽略新增字段（change: 2026-10-15-add-film-set-overview-lod，design D1）。
#[cfg(feature = "canvas-core")]
#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn scene_capability() -> String {
    protocol::CANVAS_RENDER_SCENE_VERSION.to_owned()
}

/// 实际工作计数快照（JSON）：interaction 世界索引 / 模型候选 AABB / 静态 2D mesh 重建次数
/// （change: 2026-10-10-optimize-canvas-interaction-hot-path，任务 1.2/3.x；
///  change: 2026-10-14-scope-film-set-object-picking-to-focus 增加内部对象准备四项累计量与
///  当前 owner/候选数快照）。
#[cfg(feature = "canvas-core")]
#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn canvas_work_diagnostics() -> String {
    bridge::work_diagnostics()
}

/// 接受点随候选一起发布的画布相机快照（viewport + surface）。
#[cfg(feature = "canvas-core")]
fn model_pick_camera(scene: &protocol::Scene) -> canvas_query::model_pick::ModelPickCamera {
    let surface = scene
        .surface
        .as_ref()
        .map(|surface| [surface.width, surface.height])
        .unwrap_or([1.0, 1.0]);
    canvas_query::model_pick::ModelPickCamera {
        viewport: [scene.viewport.x, scene.viewport.y, scene.viewport.zoom],
        surface,
        ordinary: scene.model_focus.is_none() && scene.image_focus.is_none()
            && scene.video_focus.is_none() && scene.focus_transition.is_none(),
        focus: scene.model_focus.as_ref().map(|focus| canvas_query::model_pick::ModelPickFocus {
            target: focus.target,
            yaw: focus.yaw,
            pitch: focus.pitch,
            distance: focus.distance,
            fov: focus.fov,
        }),
    }
}

/// 普通正交画布模型 picking：按 CSS 点返回最近 canonical 模型的 identity/bounds
/// （change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm，任务 5.2）。
#[cfg(feature = "canvas-core")]
#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn query_model_pick(json: &str) -> String {
    model3d::pick::refresh_shared_models(bridge::lookup_model_asset);
    canvas_query::model_pick::pick_query_json(json)
}

/// 模型编辑 gizmo（focus 三轴 / shot 镜头 / placement）命中与轴拖动约束
/// （change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm，任务 5.3）。
#[cfg(feature = "canvas-core")]
#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn query_gizmo_hit(json: &str) -> String {
    canvas_query::gizmo::gizmo_query_json(json)
}

/// 合并准备与注册：Frontend 把已规范化的 Scene IR 一次性交给 Rust，Rust 在**同一次边界调用**中
/// 派生兼容 signature、局部 AABB 与 extent、注册不可变资源并返回轻量 metadata
/// （change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm，任务 6.3 / design D6）。
///
/// 同一内容 identity 只派生一次；非法/冲突 payload 被拒绝且不影响已注册资源与当前画面。
#[cfg(feature = "canvas-core")]
#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn prepare_and_register_model_resource(json: &str) -> Result<String, BoundaryError> {
    wake_canvas();
    if json.len() > protocol::MAX_SCENE_BYTES {
        return Err(BoundaryError::from_str("Model resource payload too large"));
    }
    let request: protocol::PreparedModelRequest =
        serde_json::from_str(json).map_err(|err| BoundaryError::from_str(&err.to_string()))?;
    // 1. 版本/边界防御校验。
    request.validate().map_err(BoundaryError::from_str)?;
    // 2. 兼容 signature（对 validator 逐字节规范 ops JSON 取 FNV-1a UTF-16 指纹）。
    let signature = request.signature();
    if signature.is_empty() || signature.len() > 256 {
        return Err(BoundaryError::from_str("Invalid model resource signature"));
    }
    // 迁移期一致性断言（仅诊断；不改变权威结果）。
    if let Some(expected) = request.expected_signature.as_deref()
        && expected != signature
    {
        return Err(BoundaryError::from_str("Model resource signature mismatch"));
    }
    let resource_key = format!("{}:{}", request.scene_version, signature);
    // 同一内容 identity 只派生一次：已声明的 descriptor 直接复用其 metadata。
    // 但 **payload** 可能已被预算淘汰（cold），此时仍需重新准备并注册重型内容
    // （change: 2026-10-23-scale-canvas-media-residency，design D5）。
    let existing = bridge::existing_model_metadata(&resource_key);
    if existing.is_some() && bridge::lookup_model_asset(&resource_key).is_some() {
        let (_signature, _scene_version, extent, aabb) = existing.expect("checked above");
        bridge::note_model_derivation_hit();
        let metadata = protocol::PreparedModelMetadata {
            resource_version: request.resource_version,
            resource_key,
            scene_version: request.scene_version,
            signature,
            extent,
            aabb,
        };
        return serde_json::to_string(&metadata)
            .map_err(|err| BoundaryError::from_str(&err.to_string()));
    }
    // 3. 一次层级/mesh 遍历得到 local AABB 与 extent，并写回注册快照
    //    （`model_unit` 以 `extent` 归一化模型尺寸，未写回会让模型巨大无比）。
    let snapshot = protocol::ModelSnapshot::new(
        Some(request.scene_version.clone()),
        request.ops.clone(),
        signature.clone(),
        request.expected_extent.unwrap_or(1.0),
        Default::default(),
    );
    let snapshot = model3d::prepare_snapshot(snapshot);
    let aabb = snapshot.aabb;
    let extent = snapshot.extent;
    bridge::note_model_derivation();
    // 4. 声明轻量 descriptor（幂等）；payload 注册前必须已有合法身份。
    let declared = bridge::declare_model_descriptor_dto(protocol::ModelDescriptorDto {
        resource_version: protocol::MODEL_DESCRIPTOR_VERSION.to_owned(),
        resource_key: resource_key.clone(),
        scene_version: Some(request.scene_version.clone()),
        signature: signature.clone(),
        extent,
        aabb,
    });
    if let Err(error) = declared {
        return Err(BoundaryError::from_str(error));
    }
    // 5. 注册重型 payload（含 local_aabb 与派生 extent），只在实际需求下驻留。
    match bridge::queue_model_snapshot(
        resource_key.clone(),
        signature.clone(),
        Some(request.scene_version.clone()),
        std::sync::Arc::new(snapshot),
    ) {
        bridge::AssetRegistration::Ok => {}
        bridge::AssetRegistration::Conflict => {
            return Err(BoundaryError::from_str("Model resource key conflict"));
        }
    }
    // 6. 返回轻量 metadata。
    let metadata = protocol::PreparedModelMetadata {
        resource_version: request.resource_version,
        resource_key,
        scene_version: request.scene_version,
        signature,
        extent,
        aabb,
    };
    serde_json::to_string(&metadata).map_err(|err| BoundaryError::from_str(&err.to_string()))
}

/// 声明一份轻量模型 descriptor：只登记内容身份与必要 bounds，**不**注册重型 payload
/// （change: 2026-10-23-scale-canvas-media-residency，design D5）。
///
/// 返回规范化后的 descriptor JSON。同 key 同内容幂等；同 key 不同内容返回稳定冲突错误，
/// 且不影响已声明身份与当前画面。
#[cfg(feature = "canvas-core")]
#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn declare_model_resource(json: &str) -> Result<String, BoundaryError> {
    wake_canvas();
    if json.len() > 64 * 1024 {
        return Err(BoundaryError::from_str(
            "Model descriptor payload too large",
        ));
    }
    let dto: protocol::ModelDescriptorDto =
        serde_json::from_str(json).map_err(|err| BoundaryError::from_str(&err.to_string()))?;
    let declared = bridge::declare_model_descriptor_dto(dto).map_err(BoundaryError::from_str)?;
    serde_json::to_string(&DeclaredModelDescriptor {
        resource_version: declared.resource_version,
        resource_key: declared.resource_key,
        scene_version: declared.scene_version,
        signature: declared.signature,
        extent: declared.extent,
        aabb: declared.aabb,
    })
    .map_err(|err| BoundaryError::from_str(&err.to_string()))
}

/// 声明结果回执（与 `ModelDescriptor` 同形，供调用方确认身份）。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DeclaredModelDescriptor {
    resource_version: String,
    resource_key: String,
    scene_version: Option<String>,
    signature: String,
    extent: f32,
    aabb: Option<protocol::ModelAabbDto>,
}

/// 设置当前需求持有的模型 payload lease，并按预算淘汰无 lease 的重型 payload
/// （change: 2026-10-23-scale-canvas-media-residency，design D5）。
///
/// 入参是 `{"keys":["v2:..."]}`；返回
/// `{"retained":N,"evicted":M,"evictedKeys":[...],"residentKeys":[...],"descriptors":N,"cold":N}`。
/// lease 是 payload 存活的唯一依据：场景引用只保护轻量 descriptor。
#[cfg(feature = "canvas-core")]
#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn set_model_payload_leases(json: &str) -> Result<String, BoundaryError> {
    wake_canvas();
    if json.len() > 4 * 1024 * 1024 {
        return Err(BoundaryError::from_str("Model lease payload too large"));
    }
    let request: ModelPayloadLeaseRequest =
        serde_json::from_str(json).map_err(|err| BoundaryError::from_str(&err.to_string()))?;
    let keys: std::collections::HashSet<String> = request
        .keys
        .into_iter()
        .filter(|key| !key.is_empty() && key.len() <= 256)
        .collect();
    let (retained, evicted) = bridge::set_model_payload_leases(keys);
    let diagnostics: serde_json::Value =
        serde_json::from_str(&bridge::model_asset_diagnostics())
            .map_err(|err| BoundaryError::from_str(&err.to_string()))?;
    serde_json::to_string(&serde_json::json!({
        "retained": retained,
        "evicted": evicted.len(),
        // 被淘汰的 key 让前端同步清空自己的「已驻留」账本，避免把 cold 当成 ready。
        "evictedKeys": evicted,
        // 实际驻留集合：payload 也可能被其它注册调用顺带淘汰，前端据此对齐账本。
        "residentKeys": bridge::resident_payload_keys(),
        "descriptors": diagnostics.get("descriptors").cloned().unwrap_or(serde_json::Value::from(0)),
        "cold": diagnostics.get("cold").cloned().unwrap_or(serde_json::Value::from(0)),
    }))
    .map_err(|err| BoundaryError::from_str(&err.to_string()))
}

/// `set_model_payload_leases` 的 wire 请求。
#[derive(serde::Deserialize)]
struct ModelPayloadLeaseRequest {
    #[serde(default)]
    keys: Vec<String>,
}

/// 滚动 model asset 诊断计数（change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm；E2E/单测观察）。
#[cfg(feature = "canvas-core")]
#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn model_asset_diagnostics() -> String {
    bridge::model_asset_diagnostics()
}

/// 2D 点命中查询：只接收坐标、zoom、generation 与可选悬停边，返回小型语义结果
/// （change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm，任务 3.2）。
#[cfg(feature = "canvas-core")]
#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn query_point_hit(json: &str) -> String {
    canvas_query::interaction::point_query_json(json)
}

/// 2D 框选查询：返回与矩形相交的节点 id（change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm）。
#[cfg(feature = "canvas-core")]
#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn query_marquee(json: &str) -> String {
    canvas_query::interaction::marquee_query_json(json)
}

/// drag-touch probe 查询：返回方向候选节点（change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm）。
#[cfg(feature = "canvas-core")]
#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn query_probe(json: &str) -> String {
    canvas_query::interaction::probe_query_json(json)
}

/// 通用 drop target 查询：固定最上层实际节点（排除来源），只返回 identity
/// （change: 2026-10-12-align-film-set-scope-with-isometric-grid，design D5）。
#[cfg(feature = "canvas-core")]
#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn query_drop_target(json: &str) -> String {
    canvas_query::interaction::drop_target_query_json(json)
}

/// 最近一次已渲染的 2D revision。
#[cfg(feature = "canvas-core")]
#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn rendered_revision() -> u32 {
    bridge::revision()
}

/// 字体/相机是否就绪。
#[cfg(feature = "canvas-core")]
#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn is_ready() -> bool {
    bridge::ready()
}

/// shot camera 运行时诊断快照（JSON）：rig/preview/gizmo/capture 计数
/// （change: add-reusable-bevy-shot-camera，任务 6.2）。
#[cfg(feature = "canvas-core")]
#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn shot_diagnostics() -> String {
    bridge::shot_diagnostics()
}

/// 请求一次镜头截图（change: 2026-10-07-remove-residual-compatibility，design D5 / 任务 6.2–6.3）。
///
/// 请求只携带稳定 identity（requestId + nodeId + 作用域 generation）与输出尺寸；相机
/// pose/lens 由当前 rig 提供。完成后用 `poll_shot_capture` 取回匹配 identity 的结果。
#[cfg(feature = "canvas-core")]
#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn request_shot_capture(json: &str) -> Result<(), BoundaryError> {
    wake_canvas();
    shot_capture_wire::request(json)
}

/// 轮询截图结果：返回匹配 (requestId, generation) 的帧（无则返回空 Uint8Array）。
///
/// 返回布局：`[u32 LE width][u32 LE height][u32 LE status][payload...]`。
/// `status == 0`：成功，payload 为 RGBA，width/height 为帧尺寸。
/// `status == 1`：失败，payload 为 UTF-8 失败码，width/height 为 0。
/// 结果不匹配 identity 时返回空数组，迟到结果不污染新请求。
#[cfg(feature = "canvas-core")]
#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn poll_shot_capture(request_id: f64, generation: f64) -> Vec<u8> {
    shot_capture_wire::poll(request_id, generation)
}

/// 请求一次页面内模型历史缩略图（change: 2026-10-26-move-generation-history-to-ai-center，D6）。
///
/// 入参是服务端权威脚本派生并校验过的 V2 Scene IR 与稳定 identity：
/// `{requestId, generation, sceneVersion, ops, width, height}`。渲染在**既有** Bevy App 内
/// 一次性完成，不新建 App/context；完成后用 `poll_history_thumbnail` 取回。
#[cfg(feature = "canvas-core")]
#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn request_history_thumbnail(json: &str) -> Result<(), BoundaryError> {
    wake_canvas();
    history_preview::wire::request(json)
}

/// 轮询历史缩略图结果：返回匹配 (requestId, generation) 的帧（无则空数组）。
///
/// 帧布局与截图一致：`[u32 LE width][u32 LE height][u32 LE status][payload...]`；
/// `status == 0` 成功（RGBA），`status == 1` 失败（UTF-8 失败码）。
#[cfg(feature = "canvas-core")]
#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn poll_history_thumbnail(request_id: f64, generation: f64) -> Vec<u8> {
    history_preview::wire::poll(request_id, generation)
}

/// 启动 Bevy App（幂等）。
/// 浏览器入口：初始化并进入 winit 事件循环。
///
/// 原生宿主**不**调用它——它有自己的 OS loop，只使用 `build_native_canvas_app` + 显式 tick。
/// 开关静止降频（默认开启）：关闭后画布恢复 120 FPS 连续更新。
///
/// 策略按「是否需要连续帧」在 120 FPS 与静止心跳之间切换，MUST 可关闭以便对照排查。
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn set_idle_frame_pacing(enabled: bool) {
    crate::app::set_idle_frame_pacing(enabled);
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn start() {
    if bridge::mark_started() {
        return;
    }
    console_error_panic_hook::set_once();
    app::start();
}

#[cfg(feature = "native-canvas")]
pub use app::build_native_canvas_app;

/// Native window fallback uses exactly the same default as the canvas clear.
#[cfg(feature = "native-canvas")]
pub fn native_startup_background() -> [u8; 4] {
    use bevy::color::ColorToPacked;
    theme::ThemeResource::default()
        .backdrop_color()
        .to_srgba()
        .to_u8_array()
}

/// Avoid exposing an uninitialized native surface before its first scene.
#[cfg(feature = "native-canvas")]
pub fn native_frame_ready() -> bool {
    bridge::ready() && runtime_health::has_rendered_scene()
}

#[cfg(feature = "canvas-core")]
pub use runtime_health::{
    benchmark_frames, benchmark_media, runtime_health, seed_runtime_generation,
};
