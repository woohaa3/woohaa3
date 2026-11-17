//! 直接 Shot Camera 截图边界 adapter
//! （change: 2026-10-07-remove-residual-compatibility，design D5 / 任务 6.2–6.3）。
//!
//! WASM 边界不再接受调用方自带的相机参数；请求只携带稳定 identity（requestId + nodeId +
//! bridge generation）与输出尺寸。adapter 把请求路由到当前 rig 的 `shot_camera` capture 队列，
//! 由共享 rig 的当前 pose/lens 渲染，并携带 rig 派生代数与调用方 generation 回写结果。
//!
//! 迟到/不匹配 identity 的结果不发布；rig 销毁或切换时以稳定失败码结束。

use bevy::prelude::*;

use crate::bridge::{
    self, ShotCaptureBridgeOutcome, ShotCaptureBridgeRequest, ShotCaptureBridgeResult,
};
use crate::shot_camera::{ShotCaptureQueue, ShotCaptureResults};

use super::shot_adapter::ShotAdapterState;

/// capture camera 使用的 render layer（与主画布 3D 层分离，避免绘制 2D chrome）。
pub(crate) const CAPTURE_LAYER: usize = 7;

/// 截图输出默认尺寸（16:9）；实际尺寸由请求 width/height 决定。
pub(crate) const CAPTURE_WIDTH: u32 = 1280;
pub(crate) const CAPTURE_HEIGHT: u32 = 720;

/// 请求在 bridge slot 里等待路由的上限（秒）。
///
/// 前端轮询 20 秒后超时并主动取消；这里留出余量兜底"调用方直接消失/旧前端"的情况，
/// 避免请求永久留在 slot 里把归属片场 pin 在 High。
pub(crate) const CAPTURE_QUEUE_TIMEOUT_SECS: f64 = 30.0;

/// 已排队的请求映射：(rig, shot request_id) → bridge identity。
#[derive(Resource, Default)]
pub(crate) struct ShotCaptureRouting {
    pending: Vec<PendingShotCapture>,
}

impl ShotCaptureRouting {
    /// 正在排队/等待 readback 的截图节点。质量与 lazy demand 把其视为强制高质量消费者，
    /// 直到结果发布或失败，避免在 GPU ready/readback 前降档或回收（B1.6）。
    ///
    /// 同时覆盖仍在 bridge slot 中、尚未被 `route_capture_request` 取走的一帧窗口。
    pub(crate) fn pins(&self, _scene: &crate::protocol::Scene) -> std::collections::HashSet<String> {
        let mut pins: std::collections::HashSet<String> = self
            .pending
            .iter()
            .map(|p| p.bridge.node_id.clone())
            .collect();
        if let Some(node_id) = crate::bridge::queued_shot_capture_node() {
            pins.insert(node_id);
        }
        pins
    }
}

impl ShotCaptureRouting {
    /// 当前截图请求的（节点 id, 来源）：含仍在 bridge slot 里的一帧窗口与已路由的请求。
    ///
    /// 只进诊断快照，用于回答「哪个业务流程把根 pin 在 High」；去重后保持确定顺序。
    pub(crate) fn requests(&self) -> Vec<(String, String)> {
        let mut out: Vec<(String, String)> = Vec::new();
        let mut push = |node: &str, source: &str| {
            let entry = (node.to_owned(), source.to_owned());
            if !out.contains(&entry) {
                out.push(entry);
            }
        };
        for pending in &self.pending {
            push(&pending.bridge.node_id, &pending.bridge.source);
        }
        if let Some((node, source)) = crate::bridge::queued_shot_capture_details() {
            push(&node, &source);
        }
        out.sort();
        out
    }
}

struct PendingShotCapture {
    shot_request_id: u64,
    bridge: ShotCaptureBridgeRequest,
}

/// 路由 bridge 的截图请求到当前 rig 的 capture 队列。
///
/// 两条路由：
/// 1. **adapter rig**（片场聚焦预览 / 模型编辑器相机工具）：请求 node 必须等于当前 adapter node，
///    切换 rig 后旧请求不得落到新 rig。
/// 2. **拍摄预览卡片 rig**（镜头参考录制在**非聚焦**状态下使用）：请求 node 是预览节点 id，
///    卡片 rig 独占所属片场的渲染层与当前 T 的相机姿态。
///
/// 两条路由都走离屏 Image 回读（WebGPU / 原生 wgpu），成片保留请求尺寸。
/// 无 rig / node 不匹配 / 排队失败时立即以稳定失败码结束请求。
pub(crate) fn route_capture_request(
    mut routing: ResMut<ShotCaptureRouting>,
    adapter: Res<ShotAdapterState>,
    rigs: Query<&crate::shot_camera::ShotCameraDerived>,
    mut queue: ResMut<ShotCaptureQueue>,
    mut results: ResMut<ShotCaptureResults>,
    models: Res<super::ModelVisuals>,
    scene: Res<crate::app::CurrentScene>,
    time: Res<Time>,
) {
    // 排队超时还没被路由：按稳定失败码收尾并释放 pin（2026-10-28 卡住的截图 pin 修复）。
    if let Some(expired) =
        bridge::expire_queued_shot_capture(time.elapsed_secs_f64(), CAPTURE_QUEUE_TIMEOUT_SECS)
    {
        bridge::set_shot_capture_result(ShotCaptureBridgeResult {
            request_id: expired.request_id,
            rig_generation: 0,
            bridge_generation: expired.bridge_generation,
            outcome: ShotCaptureBridgeOutcome::Failed {
                code: "capture-queue-timeout".to_owned(),
            },
        });
    }
    let Some(request) = bridge::take_shot_capture_request() else {
        return;
    };
    let fail = |code: &str| {
        bridge::set_shot_capture_result(ShotCaptureBridgeResult {
            request_id: request.request_id,
            rig_generation: 0,
            bridge_generation: request.bridge_generation,
            outcome: ShotCaptureBridgeOutcome::Failed {
                code: code.to_owned(),
            },
        });
    };
    let adapter_rig = adapter
        .rig
        .filter(|_| adapter.node_id.as_deref() == Some(request.node_id.as_str()));
    let Some(route) = crate::shot_camera::resolve_capture_route(
        &request.node_id,
        (adapter_rig, adapter.node_id.as_deref()),
        None,
    ) else {
        fail("camera-gone");
        return;
    };
    let rig = route.rig();
    let Ok(derived) = rigs.get(rig) else {
        fail("camera-gone");
        return;
    };
    let rig_generation = derived.generation;
    let (shot_request_id, outcome) = crate::shot_camera::request_capture(
        &mut queue,
        &mut results,
        rig,
        request
            .width
            .clamp(1, crate::shot_camera::MAX_CAPTURE_DIMENSION),
        request
            .height
            .clamp(1, crate::shot_camera::MAX_CAPTURE_DIMENSION),
        rig_generation,
    );
    match outcome {
        crate::shot_camera::ShotCaptureEnqueue::Rejected => {
            fail("invalid-size");
            return;
        }
        crate::shot_camera::ShotCaptureEnqueue::Busy => {
            fail("busy");
            return;
        }
        crate::shot_camera::ShotCaptureEnqueue::Accepted
        | crate::shot_camera::ShotCaptureEnqueue::Queued => {}
    }
    let mut bridge_request = request;
    bridge_request.rig_generation = rig_generation;
    routing.pending.push(PendingShotCapture {
        shot_request_id,
        bridge: bridge_request,
    });
}


pub(crate) fn publish_capture_results(
    mut routing: ResMut<ShotCaptureRouting>,
    mut results: ResMut<ShotCaptureResults>,
) {
    for result in results.completed.drain(..) {
        if let Some(index) = routing
            .pending
            .iter()
            .position(|pending| pending.shot_request_id == result.request_id)
        {
            let pending = routing.pending.remove(index);
            bridge::set_shot_capture_result(ShotCaptureBridgeResult {
                request_id: pending.bridge.request_id,
                rig_generation: pending.bridge.rig_generation,
                bridge_generation: pending.bridge.bridge_generation,
                outcome: ShotCaptureBridgeOutcome::Ok {
                    rgba: result.rgba,
                    width: result.width,
                    height: result.height,
                },
            });
        }
    }
    for failure in results.failures.drain(..) {
        if let Some(index) = routing
            .pending
            .iter()
            .position(|pending| pending.shot_request_id == failure.request_id)
        {
            let pending = routing.pending.remove(index);
            bridge::set_shot_capture_result(ShotCaptureBridgeResult {
                request_id: pending.bridge.request_id,
                rig_generation: pending.bridge.rig_generation,
                bridge_generation: pending.bridge.bridge_generation,
                outcome: ShotCaptureBridgeOutcome::Failed {
                    code: failure.code.code().to_owned(),
                },
            });
        }
    }
}

/// 截图不再改主画面：离屏回读不覆盖窗口画面。保留为空系统，作为渲染顺序的锚点。
pub(crate) fn sync_capture_chrome() {}
