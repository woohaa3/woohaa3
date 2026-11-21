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
#[cfg(all(feature = "native-canvas", not(feature = "wasm")))]
pub mod document_editor_textures;
#[cfg(all(feature = "native-canvas", not(feature = "wasm")))]
pub mod document_editor_visibility;
pub(crate) mod scoped_texture;
#[cfg(feature = "canvas-core")]
pub(crate) mod shot_capture_wire;
pub(crate) mod texture_receipts;
#[cfg(feature = "canvas-core")]
pub(crate) mod texture_upload;

use std::cell::{Cell, RefCell};
use std::collections::HashMap;

use crate::clock::Instant;
use crate::protocol::{NodeHover, NodePosition, ObserverUpdateRequest, Scene, Viewport};

pub(crate) use assets::{
    AssetRegistration, AssetRegistryStats, asset_registry_stats, declare_model_descriptor,
    declare_model_descriptor_dto, existing_model_metadata, lookup_model_asset,
    missing_model_descriptor, model_assets_snapshot, model_descriptor_declared,
    queue_model_snapshot, resident_payload_keys, set_model_payload_leases,
    set_scene_descriptor_keys,
};

// 测试面：`bridge::tests` 通过 `super::*` 复用这些资源表 helper 与常量。
#[cfg(test)]
pub(crate) use assets::{
    MODEL_ASSET_MAX_BYTES, MODEL_ASSET_MAX_ENTRIES, MODEL_DESCRIPTOR_MAX_ENTRIES,
    clear_model_assets, model_asset_registered, queue_model_asset,
};
thread_local! {
    static FOCUS_DETAILS: RefCell<crate::protocol::focus_details::FocusDetailInbox> = const {RefCell::new(crate::protocol::focus_details::FocusDetailInbox::new())};
    static SCENE: RefCell<Option<Scene>> = const { RefCell::new(None) };
    static RESOURCE_STATES: RefCell<HashMap<String, crate::protocol::NodeResourceState>> = RefCell::new(HashMap::new());
    static POSITIONS: RefCell<HashMap<String, NodePosition>> = RefCell::new(HashMap::new());
    /// 纯视口增量 inbox（change: 2026-10-10-optimize-canvas-interaction-hot-path，design D3）。
    /// 只携带 `{x,y,zoom}`，在 `set_viewport` 接受点写入；渲染侧 `ingest_bridge` 把它应用到
    /// 最近 full scene 的 viewport，不重建场景几何。latest-wins。
    static VIEWPORT: RefCell<Option<Viewport>> = const { RefCell::new(None) };
    static OBSERVER: RefCell<Option<ObserverUpdateRequest>> = const { RefCell::new(None) };
    static HOVER: RefCell<Option<Option<NodeHover>>> = const { RefCell::new(None) };
    static TEXTURES: RefCell<HashMap<String, (u32, u32, Vec<u8>, Option<String>)>> = RefCell::new(HashMap::new());
    static SCOPED_TEXTURES: RefCell<scoped_texture::ScopedTextureInbox> = RefCell::new(scoped_texture::ScopedTextureInbox::default());
    /// 片场媒体平面纹理（键为全局唯一 `planeId`；change: 2026-10-08-make-film-set-model-only）。
    static MODEL_TEXTURES: RefCell<HashMap<String, (u32, u32, Vec<u8>)>> = RefCell::new(HashMap::new());
    static STARTED: Cell<bool> = const { Cell::new(false) };
    static READY: Cell<bool> = const { Cell::new(false) };
    static REVISION: Cell<u32> = const { Cell::new(0) };
    /// 待处理的截图请求（change: 2026-10-07-remove-residual-compatibility —— 直接 Shot Camera 边界）。
    static SHOT_CAPTURE_REQUEST: RefCell<Option<ShotCaptureBridgeRequest>> = const { RefCell::new(None) };
    /// 排队时刻：必须是 `bevy::platform::time::Instant`（wasm 下走 `performance.now()`）。
    /// `std::time::Instant` 在 `wasm32-unknown-unknown` 上会 panic（time not implemented）。
    static SHOT_CAPTURE_ENQUEUED: Cell<Option<Instant>> = const { Cell::new(None) };
    /// 完成的截图结果，按 (requestId, generation) 匹配后由 JS 取走。
    static SHOT_CAPTURE_RESULT: RefCell<Option<ShotCaptureBridgeResult>> = const { RefCell::new(None) };
    /// 页面内历史缩略图请求（latest-wins 单槽；JS 串行发送）
    /// （change: 2026-10-26-move-generation-history-to-ai-center，design D6）。
    static HISTORY_THUMBNAIL_REQUEST: RefCell<Option<HistoryThumbnailRequest>> = const { RefCell::new(None) };
    /// 完成的历史缩略图结果，按 (requestId, generation) 匹配后由 JS 取走。
    static HISTORY_THUMBNAIL_RESULT: RefCell<Option<HistoryThumbnailResult>> = const { RefCell::new(None) };
    /// 页面内共享世界镜头捕获请求（latest-wins 单槽；JS 串行发送）。
    static WORLD_CAPTURE_REQUEST: RefCell<Option<WorldCaptureRequest>> = const { RefCell::new(None) };
    /// 完成的世界镜头捕获结果。取走时还要比对发起时冻结的画布访问，不能只看 request id。
    static WORLD_CAPTURE_RESULT: RefCell<Option<WorldCaptureResult>> = const { RefCell::new(None) };
    /// 当前画布访问。`note_canvas_visit` 遇到空 canvas id 不推进；渲染器入口另行推进未绑定序号。
    /// 序号只在本线程递增，耗尽则 panic，不能饱和后复用。
    ///
    /// 线程本地身份只覆盖 `app::start` 与 `build_native_canvas_app` 这两个正式单实例入口，
    /// 不声称解决全部异步类型的 epoch。
    ///
    /// native `multi_threaded` 下 `world_capture::sync` 没有 NonSend，截图回调与 host
    /// `poll_world_capture` 是否同一线程无法在本快照证明。身份随请求值传递；结果槽仍是
    /// TLS，跨线程投递未完成。
    static CANVAS_VISIT: RefCell<CanvasVisitSlot> = RefCell::new(CanvasVisitSlot::new());
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
    static WORK_EDGE_BLOCK_BUILDS: Cell<u64> = const { Cell::new(0) };
    static WORK_CARD_BLOCK_BUILDS: Cell<u64> = const { Cell::new(0) };
/// 最近 full scene 的 surface（CSS 尺寸）；视口增量沿用该值
    /// （change: 2026-10-10-optimize-canvas-interaction-hot-path，design D3）。
    static LAST_SURFACE: RefCell<Option<[f32; 2]>> = const { RefCell::new(None) };
    /// Render stage wall + draw recording snapshot（JSON；render_work 每帧写入）。
    static RENDER_STAGE_DIAGNOSTICS: RefCell<String> = RefCell::new("{}".to_owned());
    /// 模型实例/唯一资源预算快照（JSON；scene3d 在表示变化后写入）。
    static MODEL_RENDER_DIAGNOSTICS: RefCell<String> = RefCell::new("{}".to_owned());
    static MODEL_POSE_REQUESTED: Cell<bool> = const { Cell::new(false) };
    static MODEL_POSES: RefCell<String> = RefCell::new("{\"sequence\":0,\"focusNode\":null,\"models\":[]}".to_owned());
    static MODEL_POSE_SEQUENCE: Cell<u64> = const { Cell::new(0) };
    /// 帧节奏状态标签（`idle` / `dwell` / `active:<reasons>`；变化时写入）。
    ///
    /// 静止降频是否真的生效只能从运行侧读：前端看不到 winit 的更新间隔。
    static FRAME_PACING_DIAGNOSTICS: RefCell<String> = RefCell::new(String::new());
}

/// 记录一次 prepared/register 派生。
pub(crate) fn note_model_derivation() {
    MODEL_DERIVATIONS.with(|cell| cell.set(cell.get() + 1));
}

/// 记录一次派生去重命中。
pub(crate) fn note_model_derivation_hit() {
    MODEL_DERIVATION_HITS.with(|cell| cell.set(cell.get() + 1));
}

/// 记录本次被预算淘汰的 cold payload 数（诊断；淘汰本身已由资源表累计）。
#[allow(dead_code)]
pub(crate) fn note_model_payload_evictions(_count: u64) {
    // 计数在 `assets::evict_payloads` 内累加，避免两条路径各记一次。
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

/// 实际工作计数快照（JSON）：供 Frontend 合并进帧诊断。
pub(crate) fn set_model_render_diagnostics(json: String) {
    MODEL_RENDER_DIAGNOSTICS.with(|v| *v.borrow_mut() = json);
}
pub(crate) fn take_model_pose_request() -> bool {
    MODEL_POSE_REQUESTED.with(|v| v.replace(false))
}
pub(crate) fn set_model_poses(models: serde_json::Value, focus_node: Option<&str>) {
    let sequence = MODEL_POSE_SEQUENCE.with(|v| {
        let next = v.get().saturating_add(1);
        v.set(next);
        next
    });
    MODEL_POSES.with(|v| {
        *v.borrow_mut() =
            serde_json::json!({"sequence": sequence, "focusNode": focus_node, "models": models})
                .to_string()
    });
}
pub(crate) fn set_render_stage_diagnostics(json: String) {
    RENDER_STAGE_DIAGNOSTICS.with(|v| *v.borrow_mut() = json);
}
/// 记录帧节奏标签（只在翻转时调用，避免每帧格式化）。
pub(crate) fn set_frame_pacing_diagnostics(label: String) {
    FRAME_PACING_DIAGNOSTICS.with(|slot| *slot.borrow_mut() = label);
}

pub(crate) fn work_diagnostics() -> String {
    MODEL_POSE_REQUESTED.with(|v| v.set(true));
    let poses = MODEL_POSES.with(|v| v.borrow().clone());
    let render = RENDER_STAGE_DIAGNOSTICS.with(|v| v.borrow().clone());
    let model = MODEL_RENDER_DIAGNOSTICS.with(|v| v.borrow().clone());
    // 3D 根按可见地面顺序做整对象分离；这里只报告接受点结算到的根/重叠簇规模，
    // 同一根内部的遮挡仍交给深度缓冲（change: 2026-10-27-order-canvas-layers-by-ground-anchor，design D3/D4）。
    let depth = crate::depth_order::diagnostics();
    let pacing = FRAME_PACING_DIAGNOSTICS.with(|v| v.borrow().clone());
    format!(
        "{{\"snapshotBuilds\":{},\"pickCandidateBuilds\":{},\"meshBuilds\":{},\"cardBlockBuilds\":{},\"cardDecorationBuilds\":{},\"edgeBlockBuilds\":{},\"models\":{},\"modelPoses\":{},\"renderStages\":{},\"depthOrder\":{{\"roots\":{},\"clusters\":{},\"compressedClusters\":{}}},\"pacing\":\"{}\"}}",
        WORK_SNAPSHOT_BUILDS.with(Cell::get),
        WORK_PICK_CANDIDATE_BUILDS.with(Cell::get),
        WORK_MESH_BUILDS.with(Cell::get),
        WORK_CARD_BLOCK_BUILDS.with(Cell::get),
        WORK_DECORATION_BUILDS.with(Cell::get),
        WORK_EDGE_BLOCK_BUILDS.with(Cell::get),
        model,
        poses,
        render,
        depth.roots,
        depth.clusters,
        depth.compressed_clusters,
        pacing
    )
}

/// model asset 诊断快照（JSON）：descriptor/payload 分离后的计数。
pub(crate) fn model_asset_diagnostics() -> String {
    let stats = asset_registry_stats();
    format!(
        "{{\"derivations\":{},\"derivationHits\":{},\"descriptors\":{},\"payloads\":{},\"payloadBytes\":{},\"leased\":{},\"cold\":{},\"payloadEvictions\":{}}}",
        MODEL_DERIVATIONS.with(Cell::get),
        MODEL_DERIVATION_HITS.with(Cell::get),
        stats.descriptors,
        stats.payloads,
        stats.payload_bytes,
        stats.leased,
        stats.cold,
        stats.payload_evictions
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
    /// 请求来源标签（诊断用；缺省为空串）。
    pub(crate) source: String,
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
    SHOT_CAPTURE_ENQUEUED.with(|slot| slot.set(Some(Instant::now())));
    SHOT_CAPTURE_REQUEST.with(|slot| *slot.borrow_mut() = Some(request));
}

/// 一次性取走截图请求。
pub(crate) fn take_shot_capture_request() -> Option<ShotCaptureBridgeRequest> {
    let request = SHOT_CAPTURE_REQUEST.with(|slot| slot.borrow_mut().take());
    if request.is_some() {
        SHOT_CAPTURE_ENQUEUED.with(|slot| slot.set(None));
    }
    request
}

/// 仍在 bridge slot 中、尚未被 `route_capture_request` 取走的截图节点。
///
/// 质量 pin 需要覆盖“已排队但尚未进入 routing.pending”的这一帧窗口，避免高质量截图
/// 在 GPU ready/readback 前被降档或回收（B1.6）。
pub(crate) fn queued_shot_capture_node() -> Option<String> {
    SHOT_CAPTURE_REQUEST.with(|slot| slot.borrow().as_ref().map(|r| r.node_id.clone()))
}

/// 仍在 bridge slot 中的截图请求的（节点 id, 来源标签）：诊断用。
pub(crate) fn queued_shot_capture_details() -> Option<(String, String)> {
    SHOT_CAPTURE_REQUEST.with(|slot| {
        slot.borrow()
            .as_ref()
            .map(|r| (r.node_id.clone(), r.source.clone()))
    })
}

/// 排队超过 `timeout` 秒仍未被路由的请求：取走并按超时收尾，释放它 pin 住的片场。
///
/// 用排队时刻的单调时钟计时（`now` 仅为调用方语义对齐，不参与计算）：请求可能在
/// 前端已经放弃轮询之后仍留在 slot 里，不清理会让归属片场永久停在 High
/// （2026-10-28 卡住的截图 pin 修复）。
pub(crate) fn expire_queued_shot_capture(
    _now: f64,
    timeout: f64,
) -> Option<ShotCaptureBridgeRequest> {
    let queued = SHOT_CAPTURE_ENQUEUED.with(|slot| slot.get())?;
    if queued.elapsed().as_secs_f64() < timeout {
        return None;
    }
    SHOT_CAPTURE_ENQUEUED.with(|slot| slot.set(None));
    SHOT_CAPTURE_REQUEST.with(|slot| slot.borrow_mut().take())
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

/// 页面内历史缩略图请求：服务端权威脚本派生出的 Scene IR + 输出尺寸 + 稳定 identity
/// （change: 2026-10-26-move-generation-history-to-ai-center，design D6）。
pub(crate) struct HistoryThumbnailRequest {
    pub(crate) request_id: u64,
    pub(crate) generation: u64,
    pub(crate) snapshot: std::sync::Arc<crate::protocol::ModelSnapshot>,
    pub(crate) width: u32,
    pub(crate) height: u32,
}

/// 历史缩略图完成结果。
pub(crate) struct HistoryThumbnailResult {
    pub(crate) request_id: u64,
    pub(crate) generation: u64,
    pub(crate) outcome: HistoryThumbnailOutcome,
}

/// 成功（RGBA + 尺寸）或失败（稳定 code）。
pub(crate) enum HistoryThumbnailOutcome {
    Ok {
        rgba: Vec<u8>,
        width: u32,
        height: u32,
    },
    Failed {
        code: String,
    },
}

/// 排队一次历史缩略图请求（latest-wins；调用方串行发送）。
pub(crate) fn queue_history_thumbnail_request(request: HistoryThumbnailRequest) {
    HISTORY_THUMBNAIL_REQUEST.with(|slot| *slot.borrow_mut() = Some(request));
}

/// 一次性取走历史缩略图请求。
pub(crate) fn take_history_thumbnail_request() -> Option<HistoryThumbnailRequest> {
    HISTORY_THUMBNAIL_REQUEST.with(|slot| slot.borrow_mut().take())
}

/// 发布完成的历史缩略图结果（latest-wins）。
pub(crate) fn set_history_thumbnail_result(result: HistoryThumbnailResult) {
    HISTORY_THUMBNAIL_RESULT.with(|slot| *slot.borrow_mut() = Some(result));
}

/// 取走匹配 (request_id, generation) 的结果；不匹配则保留（迟到结果不影响新请求）。
pub(crate) fn take_history_thumbnail_result(
    request_id: u64,
    generation: u64,
) -> Option<HistoryThumbnailResult> {
    HISTORY_THUMBNAIL_RESULT.with(|slot| {
        let mut guard = slot.borrow_mut();
        match guard.as_ref() {
            Some(result) if result.request_id == request_id && result.generation == generation => {
                guard.take()
            }
            _ => None,
        }
    })
}

/// 发起世界捕获时冻结的画布访问。未绑定是空 `canvas_id`，不是 `seq == 0`。
///
/// 同一 canvas id 再次进入（A→B→A）必须是新序号，不能只比较 id 字符串。
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CanvasVisit {
    pub(crate) canvas_id: String,
    pub(crate) seq: u64,
}

impl CanvasVisit {
    pub(crate) fn unbound() -> Self {
        Self {
            canvas_id: String::new(),
            seq: 0,
        }
    }

    pub(crate) fn is_bound(&self) -> bool {
        !self.canvas_id.is_empty()
    }
}

struct CanvasVisitSlot {
    current: CanvasVisit,
    next_seq: u64,
}

impl CanvasVisitSlot {
    const fn new() -> Self {
        Self {
            current: CanvasVisit {
                canvas_id: String::new(),
                seq: 0,
            },
            next_seq: 0,
        }
    }
}

/// 同线程开始一次新的渲染器画布访问：推进未绑定序号，并清掉旧捕获。
///
/// `next_seq` 用 `checked_add` 推进，耗尽则 panic，避免饱和后悄然复用身份。
/// 当前访问换成空 canvas id 与新序号，因此同一 canvas id 不能沿用旧访问。
/// 必须先释放 `CANVAS_VISIT` 借用，再调用 [`discard_world_capture_not_current`]。
/// 上述 RefCell 借用结束后使 scoped texture inbox 失效；不重置 token 计数。
///
/// 仅供 native 主线程的 `build_native_canvas_app` 与 wasm 主线程的 `app::start`
/// 这两个正式单实例入口调用。线程本地实现不覆盖其他入口，也不声称解决全部异步类型的 epoch。
pub(crate) fn begin_canvas_renderer() {
    CANVAS_VISIT.with(|slot| {
        let mut slot = slot.borrow_mut();
        let next_seq = slot
            .next_seq
            .checked_add(1)
            .expect("canvas visit sequence exhausted");
        slot.next_seq = next_seq;
        slot.current = CanvasVisit {
            canvas_id: String::new(),
            seq: next_seq,
        };
    });
    discard_world_capture_not_current();
    SCOPED_TEXTURES.with(|slot| slot.borrow_mut().invalidate());
    texture_receipts::reset_renderer();
}

/// 非空 canvas id 且与当前访问不同时推进序号。空 id 保持原访问（与 epoch 的空身份语义一致）。
///
/// 访问真正切换后，丢掉不属于新访问的捕获请求和结果。不改写它们的访问身份，
/// 也不清掉已经属于新访问的请求。
fn note_canvas_visit(canvas_id: &str) {
    if canvas_id.is_empty() {
        return;
    }
    let changed = CANVAS_VISIT.with(|slot| {
        let mut slot = slot.borrow_mut();
        if slot.current.is_bound() && slot.current.canvas_id == canvas_id {
            return false;
        }
        slot.next_seq = slot
            .next_seq
            .checked_add(1)
            .expect("canvas visit sequence exhausted");
        let seq = slot.next_seq;
        slot.current = CanvasVisit {
            canvas_id: canvas_id.to_owned(),
            seq,
        };
        true
    });
    if changed {
        discard_world_capture_not_current();
    }
}

fn current_canvas_visit() -> CanvasVisit {
    CANVAS_VISIT.with(|slot| slot.borrow().current.clone())
}

/// 页面内共享世界镜头捕获请求：镜头身份（由 `CurrentScene` 解析出姿态/投影）+ 输出尺寸 +
/// 稳定 identity。页面已持有世界内容，本模块不接收实例脚本或纹理。
///
/// `canvas_visit` 由 [`queue_world_capture_request`] 在发起时冻结，调用方传入的值会被覆盖。
pub(crate) struct WorldCaptureRequest {
    pub(crate) request_id: u64,
    pub(crate) generation: u64,
    pub(crate) camera_id: String,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) canvas_visit: CanvasVisit,
}

/// 世界镜头捕获完成结果。访问身份来自发起时的请求，不是结果到达时的当前画布。
pub(crate) struct WorldCaptureResult {
    pub(crate) request_id: u64,
    pub(crate) generation: u64,
    pub(crate) canvas_visit: CanvasVisit,
    pub(crate) outcome: WorldCaptureOutcome,
}

/// 成功（RGBA + 尺寸）或失败（稳定 code）。
pub(crate) enum WorldCaptureOutcome {
    Ok {
        rgba: Vec<u8>,
        width: u32,
        height: u32,
    },
    Failed {
        code: String,
    },
}

/// 排队一次世界镜头捕获请求（latest-wins；调用方串行发送）。
///
/// 画布访问在这里冻结。之后切画布不得改写已经排队的请求。
pub(crate) fn queue_world_capture_request(mut request: WorldCaptureRequest) {
    request.canvas_visit = current_canvas_visit();
    WORLD_CAPTURE_REQUEST.with(|slot| *slot.borrow_mut() = Some(request));
}

/// 一次性取走仍属于当前画布访问的世界镜头捕获请求。
///
/// 不匹配的旧请求在这里丢弃，不返回，也不把当前访问贴上去。未绑定不是通配：
/// 空 canvas id 也要序号相同，`seq == 0` 不表示可以沿用旧访问。
pub(crate) fn take_world_capture_request() -> Option<WorldCaptureRequest> {
    WORLD_CAPTURE_REQUEST.with(|slot| {
        let mut guard = slot.borrow_mut();
        if guard.as_ref().is_some_and(world_capture_request_current) {
            guard.take()
        } else {
            *guard = None;
            None
        }
    })
}

/// 发布完成的世界镜头捕获结果。
///
/// 不读取当前画布 token 来改写结果：身份必须已经冻在结果上。对当前访问不可见的
/// 结果直接丢掉，避免大像素留在单槽里，也不覆盖已经可见的完成结果。双方都未绑定
/// 只有完整身份相同才仍按 latest-wins，不能把 `seq == 0` 当成未绑定通配。
pub(crate) fn set_world_capture_result(result: WorldCaptureResult) {
    if !world_capture_visible(&result) {
        return;
    }
    WORLD_CAPTURE_RESULT.with(|slot| {
        let mut guard = slot.borrow_mut();
        if let Some(existing) = guard.as_ref() {
            if !incoming_world_capture_may_replace(existing, &result) {
                return;
            }
        }
        *guard = Some(result);
    });
}

fn incoming_world_capture_may_replace(
    existing: &WorldCaptureResult,
    incoming: &WorldCaptureResult,
) -> bool {
    match (
        existing.canvas_visit.is_bound(),
        incoming.canvas_visit.is_bound(),
    ) {
        (false, false) => true,
        (true, false) => false,
        (true, true) => incoming.canvas_visit.seq >= existing.canvas_visit.seq,
        (false, true) => true,
    }
}

/// 取走匹配 (request_id, generation) 且对当前画布可见的结果。
///
/// 身份不匹配的结果在这里丢弃，释放像素，不返回。同一访问上 id 不匹配则保留。
/// 可见性比较完整身份（含序号）；双方都未绑定也不退回忽略序号的匹配。
pub(crate) fn take_world_capture_result(
    request_id: u64,
    generation: u64,
) -> Option<WorldCaptureResult> {
    WORLD_CAPTURE_RESULT.with(|slot| {
        let mut guard = slot.borrow_mut();
        if guard
            .as_ref()
            .is_some_and(|result| !world_capture_visible(result))
        {
            *guard = None;
            return None;
        }
        let matches = guard.as_ref().is_some_and(|result| {
            result.request_id == request_id && result.generation == generation
        });
        if matches { guard.take() } else { None }
    })
}

/// 冻结访问是否仍是当前访问。只比较完整身份，包括双方尚未绑定时的序号。
fn canvas_visit_is_current(visit: &CanvasVisit) -> bool {
    *visit == current_canvas_visit()
}

/// 在途捕获作业的冻结访问是否仍是当前画布。不改写访问，不读写结果槽。
pub(crate) fn world_capture_visit_is_current(visit: &CanvasVisit) -> bool {
    canvas_visit_is_current(visit)
}

fn world_capture_request_current(request: &WorldCaptureRequest) -> bool {
    canvas_visit_is_current(&request.canvas_visit)
}

fn world_capture_visible(result: &WorldCaptureResult) -> bool {
    canvas_visit_is_current(&result.canvas_visit)
}

/// 访问切换后的显式丢弃：旧请求不执行，旧结果不留像素。匹配当前访问的不动。
fn discard_world_capture_not_current() {
    WORLD_CAPTURE_REQUEST.with(|slot| {
        let mut guard = slot.borrow_mut();
        if guard
            .as_ref()
            .is_some_and(|request| !world_capture_request_current(request))
        {
            *guard = None;
        }
    });
    WORLD_CAPTURE_RESULT.with(|slot| {
        let mut guard = slot.borrow_mut();
        if guard
            .as_ref()
            .is_some_and(|result| !world_capture_visible(result))
        {
            *guard = None;
        }
    });
}

/// 测试隔离：画布访问与世界捕获槽都是 TLS，单线程跑测试时必须能回到未绑定。
/// 进程级画布访问/回执状态（`CANVAS_VISIT`、`SCOPED_TEXTURES`、`texture_receipts`）是全局单例，
/// 多个测试并行改它会在 `begin` 与读取之间被别的测试 `begin_canvas_renderer` 清掉。测试里凡是
/// 跨这两步的用例都握着这把锁，串行执行即可，不改生产语义。
#[cfg(test)]
pub(crate) fn test_global_state_guard() -> std::sync::MutexGuard<'static, ()> {
    static GUARD: std::sync::Mutex<()> = std::sync::Mutex::new(());
    GUARD
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
pub(crate) fn reset_world_capture_identity_for_test() {
    CANVAS_VISIT.with(|slot| *slot.borrow_mut() = CanvasVisitSlot::new());
    WORLD_CAPTURE_REQUEST.with(|slot| *slot.borrow_mut() = None);
    WORLD_CAPTURE_RESULT.with(|slot| *slot.borrow_mut() = None);
}

/// 结果槽里仍挂着的成功像素字节数。失败结果与空槽记 0。
#[cfg(test)]
pub(crate) fn world_capture_result_retained_pixels() -> usize {
    WORLD_CAPTURE_RESULT.with(|slot| match slot.borrow().as_ref() {
        Some(result) => match &result.outcome {
            WorldCaptureOutcome::Ok { rgba, .. } => rgba.len(),
            WorldCaptureOutcome::Failed { .. } => 0,
        },
        None => 0,
    })
}

/// 一帧输入：最新 scene 与按 key 合并的纹理批次。
pub(crate) struct FrameInput {
    pub(crate) focus_details: Option<Option<crate::protocol::focus_details::FocusDetailUpload>>,
    pub(crate) scene: Option<Scene>,
    pub(crate) positions: HashMap<String, NodePosition>,
    pub(crate) resource_states: HashMap<String, crate::protocol::NodeResourceState>,
    /// 纯视口增量（change: 2026-10-10-optimize-canvas-interaction-hot-path）：应用到最近
    /// full scene 的 viewport；与 scene 同在 latest-wins inbox，取最新值。
    pub(crate) viewport: Option<Viewport>,
    pub(crate) observer: Option<ObserverUpdateRequest>,
    pub(crate) hover: Option<Option<NodeHover>>,
    /// nodeId → (宽, 高, RGBA, 内容身份)。内容身份用于 Rust 侧按内容共享 GPU 纹理
    /// （change: 2026-10-23-scale-canvas-media-residency，design D4 / 任务 4.4）。
    pub(crate) textures: HashMap<String, (u32, u32, Vec<u8>, Option<String>)>,
    pub(crate) texture_scope: Option<u64>,
    pub(crate) model_textures: HashMap<String, (u32, u32, Vec<u8>)>,
}

/// 覆盖排队中的 scene（latest-wins）。调用方必须已通过 `Scene::validate`。
pub(crate) fn queue_scene(scene: Scene) {
    note_canvas_visit(&scene.canvas_id);
    // 记录本帧引用的 descriptor key：轻量声明不得被逐出（payload 另由 lease 保护）。
    let keys: std::collections::HashSet<String> = scene
        .nodes
        .iter()
        .filter_map(|node| node.model.as_ref().map(|r| r.resource_key.clone()))
        .collect();
    set_scene_descriptor_keys(keys);
    // 记录 surface 供视口增量沿用（视口增量不改 surface）。
    if let Some(surface) = &scene.surface {
        LAST_SURFACE.with(|slot| *slot.borrow_mut() = Some([surface.width, surface.height]));
    }
    // full scene 携带完整 viewport：清掉尚未消费的视口增量，避免迟到增量在 full 之后被应用
    // （统一 latest-wins 顺序；change: 2026-10-10-optimize-canvas-interaction-hot-path，design D3）。
    VIEWPORT.with(|slot| *slot.borrow_mut() = None);
    OBSERVER.with(|slot| *slot.borrow_mut() = None);
    HOVER.with(|slot| *slot.borrow_mut() = None);
    POSITIONS.with(|slot| slot.borrow_mut().clear());
    RESOURCE_STATES.with(|slot| slot.borrow_mut().clear());
    SCENE.with(|slot| *slot.borrow_mut() = Some(scene));
}

pub(crate) fn queue_resource_states(nodes: Vec<crate::protocol::NodeResourceState>) {
    RESOURCE_STATES.with(|slot| {
        let mut slot = slot.borrow_mut();
        for node in nodes {
            slot.insert(node.id.clone(), node);
        }
    });
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

pub(crate) fn queue_hover(hover: Option<NodeHover>) {
    HOVER.with(|slot| *slot.borrow_mut() = Some(hover));
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
///
/// `content` 是稳定内容身份（同资产同档位共享同一 GPU 纹理）；`None` 表示独占纹理
/// （例如上传中的本地幽灵预览）。内容身份**不含** nodeId。
pub(crate) fn queue_texture(id: &str, width: u32, height: u32, rgba: &[u8], content: Option<&str>) {
    queue_texture_owned(id, width, height, rgba.to_vec(), content);
}

/// Native requests already own their bytes; move them into the inbox.
pub(crate) fn queue_texture_owned(
    id: &str,
    width: u32,
    height: u32,
    rgba: Vec<u8>,
    content: Option<&str>,
) {
    TEXTURES.with(|textures| {
        textures.borrow_mut().insert(
            id.to_owned(),
            (width, height, rgba, content.map(str::to_owned)),
        );
    });
}

/// 记录一次合法片场媒体平面纹理上传（键为全局唯一 `planeId`；latest-wins）。
pub(crate) fn queue_model_texture(id: &str, width: u32, height: u32, rgba: &[u8]) {
    queue_model_texture_owned(id, width, height, rgba.to_vec());
}

pub(crate) fn queue_model_texture_owned(id: &str, width: u32, height: u32, rgba: Vec<u8>) {
    MODEL_TEXTURES.with(|textures| {
        textures
            .borrow_mut()
            .insert(id.to_owned(), (width, height, rgba));
    });
}

/// 开始一次内部纹理 scope。`begin` 失败时不清理 `SCENE` / `TEXTURES`。
///
/// 只影响调用本函数的 scoped 路径；未 begin 的旧调用方仍走 legacy inbox。
pub(crate) fn begin_texture_scope(canvas_id: &str) -> Result<u64, &'static str> {
    let token = SCOPED_TEXTURES.with(|slot| slot.borrow_mut().begin(canvas_id))?;
    texture_receipts::begin_scope(token);
    SCENE.with(|slot| *slot.borrow_mut() = None);
    TEXTURES.with(|slot| slot.borrow_mut().clear());
    MODEL_TEXTURES.with(|slot| slot.borrow_mut().clear());
    FOCUS_DETAILS
        .with(|slot| *slot.borrow_mut() = crate::protocol::focus_details::FocusDetailInbox::new());
    Ok(token)
}

pub(crate) fn texture_scope_legacy_allowed() -> bool {
    SCOPED_TEXTURES.with(|slot| slot.borrow().legacy_allowed())
}

pub(crate) fn texture_scope_matches_scene(token: u64, canvas_id: &str) -> bool {
    SCOPED_TEXTURES.with(|slot| slot.borrow().matches_scene(token, canvas_id))
}

pub(crate) fn texture_scope_matches_token(token: u64) -> bool {
    SCOPED_TEXTURES.with(|slot| slot.borrow().matches_token(token))
}

pub(crate) fn end_texture_scope(token: u64) -> bool {
    let ended = SCOPED_TEXTURES.with(|slot| slot.borrow_mut().end(token));
    if !ended {
        return false;
    }
    texture_receipts::end_scope(token);
    SCENE.with(|slot| *slot.borrow_mut() = None);
    TEXTURES.with(|slot| slot.borrow_mut().clear());
    MODEL_TEXTURES.with(|slot| slot.borrow_mut().clear());
    FOCUS_DETAILS
        .with(|slot| *slot.borrow_mut() = crate::protocol::focus_details::FocusDetailInbox::new());
    true
}

pub(crate) fn queue_scoped_texture(token: u64, id: &str, texture: scoped_texture::Texture) -> bool {
    SCOPED_TEXTURES.with(|slot| slot.borrow_mut().queue(token, id.to_owned(), texture))
}

pub(crate) fn queue_scoped_model_texture(
    token: u64,
    id: &str,
    texture: (u32, u32, Vec<u8>),
) -> bool {
    SCOPED_TEXTURES.with(|slot| slot.borrow_mut().queue_model(token, id.to_owned(), texture))
}

pub(crate) fn queue_scoped_focus_details(
    token: u64,
    frame: Option<crate::protocol::focus_details::FocusDetails>,
    bytes: &[u8],
) -> Result<(), &'static str> {
    SCOPED_TEXTURES.with(|slot| slot.borrow_mut().queue_focus(token, frame, bytes))
}

/// token 与 `scene.canvas_id` 不匹配时直接返回，不调用 [`queue_scene`]。
pub(crate) fn queue_scoped_scene(token: u64, scene: Scene) -> bool {
    let accepted = SCOPED_TEXTURES.with(|slot| slot.borrow_mut().scene(token, &scene.canvas_id));
    if !accepted {
        return false;
    }
    queue_scene(scene);
    true
}

/// 一次性取走本帧 scene 与纹理批次（drain）。
pub(crate) fn take_input() -> FrameInput {
    let scene = SCENE.with(|slot| slot.borrow_mut().take());
    let positions = POSITIONS.with(|slot| std::mem::take(&mut *slot.borrow_mut()));
    let viewport = VIEWPORT.with(|slot| slot.borrow_mut().take());
    let observer = OBSERVER.with(|slot| slot.borrow_mut().take());
    let hover = HOVER.with(|slot| slot.borrow_mut().take());
    let (legacy_allowed, drain_scope, scoped, scoped_model, scoped_focus) =
        SCOPED_TEXTURES.with(|slot| {
            let mut inbox = slot.borrow_mut();
            let legacy_allowed = inbox.legacy_allowed();
            let drain_scope = inbox.drain_scope();
            let scoped = inbox.drain();
            let scoped_model = inbox.drain_model();
            let scoped_focus = inbox.drain_focus();
            (
                legacy_allowed,
                drain_scope,
                scoped,
                scoped_model,
                scoped_focus,
            )
        });
    let mut textures = TEXTURES.with(|textures| std::mem::take(&mut *textures.borrow_mut()));
    if !legacy_allowed {
        textures.clear();
    }
    textures.extend(scoped);
    let model_textures =
        MODEL_TEXTURES.with(|textures| std::mem::take(&mut *textures.borrow_mut()));
    let legacy_focus = FOCUS_DETAILS.with(|slot| slot.borrow_mut().take());
    let model_textures = if legacy_allowed {
        model_textures
    } else {
        scoped_model
    };
    let focus_details = if legacy_allowed {
        legacy_focus
    } else {
        scoped_focus
    };
    FrameInput {
        focus_details,
        scene,
        resource_states: RESOURCE_STATES.with(|slot| std::mem::take(&mut *slot.borrow_mut())),
        positions,
        viewport,
        observer,
        hover,
        textures,
        texture_scope: drain_scope,
        model_textures,
    }
}

pub(crate) fn queue_focus_details(
    frame: Option<crate::protocol::focus_details::FocusDetails>,
    bytes: &[u8],
) -> Result<(), &'static str> {
    FOCUS_DETAILS.with(|slot| slot.borrow_mut().queue(frame, bytes))
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
