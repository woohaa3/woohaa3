//! WASM 桥接状态：thread-local latest-value inbox 与状态 outbox
//! （change: refactor-bevy-runtime-modules，任务 2.3 / design D3；
//!  change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm 拆分模型资源表）。
//!
//! latest-wins 语义：
//! - scene inbox 任意时刻只保留最后一份已通过校验的 Scene；
//! - texture inbox 按 node ID 保留最后一次合法上传，不同 ID 可在同一帧合并；
//! - 非法输入不得覆盖已排队的合法值。
//!
//! 渲染模块不得直接读写这些 thread-local：跨帧数据由 `app` 通过 `take_input()` 一次性取走。
//! 不可变模型资源表见 [`assets`]。

mod assets;

use std::cell::{Cell, RefCell};
use std::collections::HashMap;

use crate::protocol::{NodePosition, ObserverUpdateRequest, Scene, Viewport};

pub(crate) use assets::{
    AssetRegistration, existing_model_metadata, lookup_model_asset, missing_model_asset,
    model_assets_snapshot, queue_model_snapshot, set_scene_asset_keys,
};

// 测试面：`bridge::tests` 通过 `super::*` 复用这些资源表 helper 与常量。
#[cfg(test)]
pub(crate) use assets::{
    MODEL_ASSET_MAX_BYTES, MODEL_ASSET_MAX_ENTRIES, clear_model_assets, model_asset_registered,
    queue_model_asset,
};
thread_local! {
    static FOCUS_DETAILS: RefCell<crate::protocol::focus_details::FocusDetailInbox> = const {RefCell::new(crate::protocol::focus_details::FocusDetailInbox::new())};
    static SCENE: RefCell<Option<Scene>> = const { RefCell::new(None) };
    static POSITIONS: RefCell<HashMap<String, NodePosition>> = RefCell::new(HashMap::new());
    /// 纯视口增量 inbox（change: 2026-10-10-optimize-canvas-interaction-hot-path，design D3）。
    /// 只携带 `{x,y,zoom}`，在 `set_viewport` 接受点写入；渲染侧 `ingest_bridge` 把它应用到
    /// 最近 full scene 的 viewport，不重建场景几何。latest-wins。
    static VIEWPORT: RefCell<Option<Viewport>> = const { RefCell::new(None) };
    static OBSERVER: RefCell<Option<ObserverUpdateRequest>> = const { RefCell::new(None) };
    static TEXTURES: RefCell<HashMap<String, (u32, u32, Vec<u8>)>> = RefCell::new(HashMap::new());
    /// 片场媒体平面纹理（键为全局唯一 `planeId`；change: 2026-10-08-make-film-set-model-only）。
    static FILM_SET_TEXTURES: RefCell<HashMap<String, (u32, u32, Vec<u8>)>> = RefCell::new(HashMap::new());
    static STARTED: Cell<bool> = const { Cell::new(false) };
    static READY: Cell<bool> = const { Cell::new(false) };
    static REVISION: Cell<u32> = const { Cell::new(0) };
    /// 待处理的截图请求（change: 2026-10-07-remove-residual-compatibility —— 直接 Shot Camera 边界）。
    static SHOT_CAPTURE_REQUEST: RefCell<Option<ShotCaptureBridgeRequest>> = const { RefCell::new(None) };
    /// 完成的截图结果，按 (requestId, generation) 匹配后由 JS 取走。
    static SHOT_CAPTURE_RESULT: RefCell<Option<ShotCaptureBridgeResult>> = const { RefCell::new(None) };
    /// shot camera 运行时诊断快照
    /// （change: add-reusable-bevy-shot-camera；JSON 字符串，宿主/Showcase 读取）。
    static SHOT_DIAGNOSTICS: RefCell<String> = RefCell::new(String::new());
    /// model asset prepared-and-register 派生次数（同一内容 identity 只派生一次）
    /// （change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm）。
    static MODEL_DERIVATIONS: Cell<u64> = const { Cell::new(0) };
    /// 命中去重的派生次数（同 key 幂等复用）。
    static MODEL_DERIVATION_HITS: Cell<u64> = const { Cell::new(0) };
    /// 实际发生的工作计数（change: 2026-10-10-optimize-canvas-interaction-hot-path，任务 1.2/3.x）：
    /// full scene 接受点重建 interaction 世界索引的次数（纯视口增量 MUST NOT 增加）。
    static WORK_SNAPSHOT_BUILDS: Cell<u64> = const { Cell::new(0) };
    /// full scene 接受点重建模型 picking 候选 AABB 的次数（纯视口复用，不增加）。
    static WORK_PICK_CANDIDATE_BUILDS: Cell<u64> = const { Cell::new(0) };
    /// 静态 2D mesh 重建次数（纯视口路径不增加）。
    static WORK_MESH_BUILDS: Cell<u64> = const { Cell::new(0) };
    static WORK_DECORATION_BUILDS: Cell<u64> = const { Cell::new(0) };
    static WORK_CONTAINER_BLOCK_BUILDS: Cell<u64> = const { Cell::new(0) };
    static WORK_EDGE_BLOCK_BUILDS: Cell<u64> = const { Cell::new(0) };
    static WORK_CARD_BLOCK_BUILDS: Cell<u64> = const { Cell::new(0) };
    /// 最近 full scene 的 surface（CSS 尺寸）；视口增量沿用该值
    /// （change: 2026-10-10-optimize-canvas-interaction-hot-path，design D3）。
    static LAST_SURFACE: RefCell<Option<[f32; 2]>> = const { RefCell::new(None) };
    /// Render stage wall + draw recording snapshot（JSON；model_preview 每个 sync 写入）。
    static RENDER_STAGE_DIAGNOSTICS: RefCell<String> = RefCell::new("{}".to_owned());
    /// 模型实例/唯一资源预算快照（JSON；scene3d 在表示变化后写入）。
    static MODEL_RENDER_DIAGNOSTICS: RefCell<String> = RefCell::new("{}".to_owned());
    /// 预览同步阶段延迟快照（JSON；变化时写入）。
    static PREVIEW_LATENCY_DIAGNOSTICS: RefCell<String> = RefCell::new("{}".to_owned());
    /// 预览队列/纹理预算 gauge（active/pending/bytes/visible/retained/live/deferred/ready）。
    static PREVIEW_DIAGNOSTICS: Cell<[u64; 8]> = const { Cell::new([0; 8]) };
    /// 拍摄镜头卡片预览的实际工作/预算 gauge
    /// （change: 2026-10-15-add-film-set-shooting-shot-previews，design D7）。
    ///
    /// 与 `PREVIEW_DIAGNOSTICS`（模型内嵌预览）分开：两者是不同消费者，混用会互相覆盖。
    static SHOT_PREVIEW_DIAGNOSTICS: Cell<[u64; 8]> = const { Cell::new([0; 8]) };
}

/// 记录一次 prepared/register 派生。
pub(crate) fn note_model_derivation() {
    MODEL_DERIVATIONS.with(|cell| cell.set(cell.get() + 1));
}

/// 记录一次派生去重命中。
pub(crate) fn note_model_derivation_hit() {
    MODEL_DERIVATION_HITS.with(|cell| cell.set(cell.get() + 1));
}

// ── 实际工作计数（change: 2026-10-10-optimize-canvas-interaction-hot-path）─────────

/// Rust 接受点记录一次 interaction 世界索引重建。
pub(crate) fn note_world_snapshot_build() {
    WORK_SNAPSHOT_BUILDS.with(|cell| cell.set(cell.get() + 1));
}

/// Rust 接受点记录一次模型 picking 候选 AABB 重建。
pub(crate) fn note_pick_candidate_build() {
    WORK_PICK_CANDIDATE_BUILDS.with(|cell| cell.set(cell.get() + 1));
}

/// 渲染侧记录一次静态 2D mesh 重建。
pub(crate) fn note_mesh_build() {
    WORK_MESH_BUILDS.with(|cell| cell.set(cell.get() + 1));
}

pub(crate) fn note_card_block_builds(count: u64) {
    WORK_CARD_BLOCK_BUILDS.with(|cell| cell.set(cell.get() + count));
}

pub(crate) fn note_local_block_builds(decorations: u64, edges: u64) {
    WORK_DECORATION_BUILDS.with(|cell| cell.set(cell.get() + decorations));
    WORK_EDGE_BLOCK_BUILDS.with(|cell| cell.set(cell.get() + edges));
}

pub(crate) fn note_container_block_builds(count: u64) {
    WORK_CONTAINER_BLOCK_BUILDS.with(|cell| cell.set(cell.get() + count));
}

/// 实际工作计数快照（JSON）：供 Frontend 合并进帧诊断。
pub(crate) fn set_model_render_diagnostics(json: String) {
    MODEL_RENDER_DIAGNOSTICS.with(|v| *v.borrow_mut() = json);
}
pub(crate) fn set_render_stage_diagnostics(json: String) {
    RENDER_STAGE_DIAGNOSTICS.with(|v| *v.borrow_mut() = json);
}
pub(crate) fn set_preview_diagnostics(gauges: [u64; 8]) {
    PREVIEW_DIAGNOSTICS.with(|v| v.set(gauges));
}
/// 拍摄镜头卡片预览的实际工作/预算 gauge（与模型内嵌预览分开，避免互相覆盖）。
pub(crate) fn set_shot_preview_diagnostics(gauges: [u64; 8]) {
    SHOT_PREVIEW_DIAGNOSTICS.with(|v| v.set(gauges));
}
pub(crate) fn set_preview_latency_diagnostics(json: String) {
    PREVIEW_LATENCY_DIAGNOSTICS.with(|slot| *slot.borrow_mut() = json);
}
pub(crate) fn work_diagnostics() -> String {
    let latency = PREVIEW_LATENCY_DIAGNOSTICS.with(|slot| slot.borrow().clone());
    let render = RENDER_STAGE_DIAGNOSTICS.with(|v| v.borrow().clone());
    let model = MODEL_RENDER_DIAGNOSTICS.with(|v| v.borrow().clone());
    let preview = PREVIEW_DIAGNOSTICS.with(Cell::get);
    let shot_preview = SHOT_PREVIEW_DIAGNOSTICS.with(Cell::get);
    let film_set_items = crate::canvas_query::film_set_pick::diagnostics_json();
    format!(
        "{{\"snapshotBuilds\":{},\"pickCandidateBuilds\":{},\"meshBuilds\":{},\"cardBlockBuilds\":{},\"cardDecorationBuilds\":{},\"edgeBlockBuilds\":{},\"containerBlockBuilds\":{},\"filmSetItems\":{},\"models\":{},\"renderStages\":{},\"previewLatency\":{},\"previews\":{{\"active\":{},\"pending\":{},\"textureBytes\":{},\"visible\":{},\"retained\":{},\"live\":{},\"deferred\":{},\"ready\":{}}},\"shotPreviews\":{{\"active\":{},\"pending\":{},\"textureBytes\":{},\"visible\":{},\"retained\":{},\"live\":{},\"deferred\":{},\"ready\":{}}}}}",
        WORK_SNAPSHOT_BUILDS.with(Cell::get),
        WORK_PICK_CANDIDATE_BUILDS.with(Cell::get),
        WORK_MESH_BUILDS.with(Cell::get),
        WORK_CARD_BLOCK_BUILDS.with(Cell::get),
        WORK_DECORATION_BUILDS.with(Cell::get),
        WORK_EDGE_BLOCK_BUILDS.with(Cell::get),
        WORK_CONTAINER_BLOCK_BUILDS.with(Cell::get),
        film_set_items,
        model,
        render,
        latency,
        preview[0],
        preview[1],
        preview[2],
        preview[3],
        preview[4],
        preview[5],
        preview[6],
        preview[7],
        shot_preview[0],
        shot_preview[1],
        shot_preview[2],
        shot_preview[3],
        shot_preview[4],
        shot_preview[5],
        shot_preview[6],
        shot_preview[7]
    )
}

/// model asset 诊断快照（JSON）。
pub(crate) fn model_asset_diagnostics() -> String {
    format!(
        "{{\"derivations\":{},\"derivationHits\":{}}}",
        MODEL_DERIVATIONS.with(Cell::get),
        MODEL_DERIVATION_HITS.with(Cell::get)
    )
}

/// 写入 shot camera 诊断快照（JSON）。
pub(crate) fn set_shot_diagnostics(json: String) {
    SHOT_DIAGNOSTICS.with(|slot| *slot.borrow_mut() = json);
}

/// 读取 shot camera 诊断快照（JSON；尚未写入时返回空对象）。
pub(crate) fn shot_diagnostics() -> String {
    SHOT_DIAGNOSTICS.with(|slot| {
        let value = slot.borrow();
        if value.is_empty() {
            "{}".to_owned()
        } else {
            value.clone()
        }
    })
}

/// 直接 Shot Camera 截图请求（change: 2026-10-07-remove-residual-compatibility，design D5）。
///
/// 携带稳定 identity：`request_id`（排队时分配）、`rig_generation`（当前 rig 派生代数）、
/// `bridge_generation`（调用方作用域 gen）。结果只有在三者与当前 rig 一致时才发布。
#[derive(Clone, Debug)]
pub(crate) struct ShotCaptureBridgeRequest {
    /// 调用方分配并用于匹配结果的稳定 request id。
    pub(crate) request_id: u64,
    /// 当前 rig 派生代数（generation identity）。
    pub(crate) rig_generation: u64,
    /// 调用方作用域 generation（迟到结果丢弃）。
    pub(crate) bridge_generation: u64,
    /// 目标 rig entity（仅运行时系统读取；跨边界由 node_id → rig 解析）。
    pub(crate) node_id: String,
    pub(crate) width: u32,
    pub(crate) height: u32,
}

/// 截图结果 outbox 条目。
#[derive(Clone, Debug)]
pub(crate) struct ShotCaptureBridgeResult {
    pub(crate) request_id: u64,
    /// 当前 rig 派生代数：随结果保留以完整记录 identity；结果匹配以 requestId + bridgeGeneration 为准。
    #[allow(dead_code)]
    pub(crate) rig_generation: u64,
    pub(crate) bridge_generation: u64,
    /// 成功帧像素；失败为空。
    pub(crate) outcome: ShotCaptureBridgeOutcome,
}

/// 成功（RGBA + 尺寸）或失败（稳定 code）。
#[derive(Clone, Debug)]
pub(crate) enum ShotCaptureBridgeOutcome {
    Ok {
        rgba: Vec<u8>,
        width: u32,
        height: u32,
    },
    Failed {
        code: String,
    },
}

/// 排队一次截图请求（latest-wins）。
pub(crate) fn queue_shot_capture(request: ShotCaptureBridgeRequest) {
    SHOT_CAPTURE_REQUEST.with(|slot| *slot.borrow_mut() = Some(request));
}

/// 一次性取走截图请求。
pub(crate) fn take_shot_capture_request() -> Option<ShotCaptureBridgeRequest> {
    SHOT_CAPTURE_REQUEST.with(|slot| slot.borrow_mut().take())
}

/// 仍在 bridge slot 中、尚未被 `route_capture_request` 取走的截图节点。
///
/// 质量 pin 需要覆盖“已排队但尚未进入 routing.pending”的这一帧窗口，避免高质量截图
/// 在 GPU ready/readback 前被降档或回收（B1.6）。
pub(crate) fn queued_shot_capture_node() -> Option<String> {
    SHOT_CAPTURE_REQUEST.with(|slot| slot.borrow().as_ref().map(|r| r.node_id.clone()))
}

/// 发布完成的截图结果（latest-wins）。
pub(crate) fn set_shot_capture_result(result: ShotCaptureBridgeResult) {
    SHOT_CAPTURE_RESULT.with(|slot| *slot.borrow_mut() = Some(result));
}

/// 取走匹配 (request_id, bridge_generation) 的结果；不匹配则保留（迟到结果不影响新请求）。
pub(crate) fn take_shot_capture_result(
    request_id: u64,
    bridge_generation: u64,
) -> Option<ShotCaptureBridgeResult> {
    SHOT_CAPTURE_RESULT.with(|slot| {
        let mut guard = slot.borrow_mut();
        match guard.as_ref() {
            Some(result)
                if result.request_id == request_id
                    && result.bridge_generation == bridge_generation =>
            {
                guard.take()
            }
            _ => None,
        }
    })
}

/// 一帧输入：最新 scene 与按 key 合并的纹理批次。
pub(crate) struct FrameInput {
    pub(crate) focus_details: Option<Option<crate::protocol::focus_details::FocusDetailUpload>>,
    pub(crate) scene: Option<Scene>,
    pub(crate) positions: HashMap<String, NodePosition>,
    /// 纯视口增量（change: 2026-10-10-optimize-canvas-interaction-hot-path）：应用到最近
    /// full scene 的 viewport；与 scene 同在 latest-wins inbox，取最新值。
    pub(crate) viewport: Option<Viewport>,
    pub(crate) observer: Option<ObserverUpdateRequest>,
    pub(crate) textures: HashMap<String, (u32, u32, Vec<u8>)>,
    pub(crate) film_set_textures: HashMap<String, (u32, u32, Vec<u8>)>,
}

/// 覆盖排队中的 scene（latest-wins）。调用方必须已通过 `Scene::validate`。
pub(crate) fn queue_scene(scene: Scene) {
    // 记录本帧引用的资源 key：资源淘汰不得逐出当前待渲染场景仍引用的资源。
    let keys: std::collections::HashSet<String> = scene
        .nodes
        .iter()
        .filter_map(|node| node.model.as_ref().map(|r| r.resource_key.clone()))
        .collect();
    set_scene_asset_keys(keys);
    // 记录 surface 供视口增量沿用（视口增量不改 surface）。
    if let Some(surface) = &scene.surface {
        LAST_SURFACE.with(|slot| *slot.borrow_mut() = Some([surface.width, surface.height]));
    }
    // full scene 携带完整 viewport：清掉尚未消费的视口增量，避免迟到增量在 full 之后被应用
    // （统一 latest-wins 顺序；change: 2026-10-10-optimize-canvas-interaction-hot-path，design D3）。
    VIEWPORT.with(|slot| *slot.borrow_mut() = None);
    OBSERVER.with(|slot| *slot.borrow_mut() = None);
    POSITIONS.with(|slot| slot.borrow_mut().clear());
    SCENE.with(|slot| *slot.borrow_mut() = Some(scene));
}

/// 最近 full scene 的 surface（CSS 尺寸）；无则 `None`。
pub(crate) fn current_scene_surface() -> Option<[f32; 2]> {
    LAST_SURFACE.with(|slot| *slot.borrow())
}

/// 覆盖排队中的纯视口增量（latest-wins）。调用方必须已通过版本/有限值/zoom 校验。
pub(crate) fn queue_viewport(viewport: Viewport) {
    VIEWPORT.with(|slot| *slot.borrow_mut() = Some(viewport));
}

pub(crate) fn queue_observer(update: ObserverUpdateRequest) {
    OBSERVER.with(|slot| *slot.borrow_mut() = Some(update));
}

/// Only accepted updates enter this inbox. Multiple batches retain all node IDs
/// and the latest absolute position per node; a later full scene clears them.
pub(crate) fn queue_positions(positions: Vec<NodePosition>, viewport: Option<Viewport>) {
    POSITIONS.with(|slot| {
        let mut slot = slot.borrow_mut();
        for p in positions {
            slot.insert(p.id.clone(), p);
        }
    });
    if let Some(viewport) = viewport {
        queue_viewport(viewport);
    }
}

/// 记录一次合法纹理上传；同一 ID 覆盖，不同 ID 合并。
pub(crate) fn queue_texture(id: &str, width: u32, height: u32, rgba: &[u8]) {
    TEXTURES.with(|textures| {
        textures
            .borrow_mut()
            .insert(id.to_owned(), (width, height, rgba.to_vec()));
    });
}

/// 记录一次合法片场媒体平面纹理上传（键为全局唯一 `planeId`；latest-wins）。
pub(crate) fn queue_film_set_texture(id: &str, width: u32, height: u32, rgba: &[u8]) {
    FILM_SET_TEXTURES.with(|textures| {
        textures
            .borrow_mut()
            .insert(id.to_owned(), (width, height, rgba.to_vec()));
    });
}

/// 一次性取走本帧 scene 与纹理批次（drain）。
pub(crate) fn take_input() -> FrameInput {
    let scene = SCENE.with(|slot| slot.borrow_mut().take());
    let positions = POSITIONS.with(|slot| std::mem::take(&mut *slot.borrow_mut()));
    let viewport = VIEWPORT.with(|slot| slot.borrow_mut().take());
    let observer = OBSERVER.with(|slot| slot.borrow_mut().take());
    let textures = TEXTURES.with(|textures| std::mem::take(&mut *textures.borrow_mut()));
    let film_set_textures =
        FILM_SET_TEXTURES.with(|textures| std::mem::take(&mut *textures.borrow_mut()));
    FrameInput {
        focus_details: FOCUS_DETAILS.with(|slot|slot.borrow_mut().take()),
        scene,
        positions,
        viewport,
        observer,
        textures,
        film_set_textures,
    }
}

pub(crate) fn queue_focus_details(frame:Option<crate::protocol::focus_details::FocusDetails>,bytes:&[u8])->Result<(),&'static str> {
    FOCUS_DETAILS.with(|slot|slot.borrow_mut().queue(frame,bytes))
}

/// `start` 幂等闸门：首次返回 `false`，后续返回 `true`。
pub(crate) fn mark_started() -> bool {
    STARTED.with(|started| started.replace(true))
}

pub(crate) fn set_ready(ready: bool) {
    READY.with(|slot| slot.set(ready));
}

pub(crate) fn ready() -> bool {
    READY.with(Cell::get)
}

pub(crate) fn set_revision(revision: u32) {
    REVISION.with(|slot| slot.set(revision));
}

pub(crate) fn revision() -> u32 {
    REVISION.with(Cell::get)
}

#[cfg(test)]
mod tests;
