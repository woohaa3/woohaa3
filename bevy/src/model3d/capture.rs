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
    /// 卡片 rig 截图额外 pin **归属片场**：临时离屏相机渲染的是该片场在该层上的模型与媒体，
    /// 片场若被降档/回收，成片就会缺内容（change: 2026-10-15，任务 8.4）。
    pub(crate) fn pins(&self, scene: &crate::protocol::Scene) -> std::collections::HashSet<String> {
        let mut pins: std::collections::HashSet<String> =
            self.pending.iter().map(|p| p.bridge.node_id.clone()).collect();
        pins.extend(self.pending.iter().filter_map(|p| p.pin_owner.clone()));
        if let Some(node_id) = crate::bridge::queued_shot_capture_node() {
            pins.insert(node_id);
        }
        // 首次请求尚未路由时也必须保留归属片场，否则屏外模型会先于 rig 创建被回收。
        crate::shot_node_preview::pin_capture_owners(scene, &mut pins);
        pins
    }
}

struct PendingShotCapture {
    shot_request_id: u64,
    bridge: ShotCaptureBridgeRequest,
    /// 卡片 rig 截图时一并 pin 的归属片场节点 id。
    pin_owner: Option<String>,
}

/// 路由 bridge 的截图请求到当前 rig 的 capture 队列。
///
/// 两条路由：
/// 1. **adapter rig**（片场聚焦预览 / 模型编辑器相机工具）：请求 node 必须等于当前 adapter node，
///    切换 rig 后旧请求不得落到新 rig。
/// 2. **拍摄预览卡片 rig**（镜头参考录制在**非聚焦**状态下使用）：请求 node 是预览节点 id，
///    卡片 rig 独占所属片场的渲染层与当前 T 的相机姿态。
///
/// 两条路由都走离屏 Image 回读（浏览器 WebGL2/wgpu / 原生 wgpu），成片保留请求尺寸。
/// 无 rig / node 不匹配 / 排队失败时立即以稳定失败码结束请求。
pub(crate) fn route_capture_request(
    mut routing: ResMut<ShotCaptureRouting>,
    adapter: Res<ShotAdapterState>,
    preview_cards: Res<crate::shot_node_preview::ShotPreviewCards>,
    rigs: Query<&crate::shot_camera::ShotCameraDerived>,
    mut queue: ResMut<ShotCaptureQueue>,
    mut results: ResMut<ShotCaptureResults>,
    models: Res<super::ModelVisuals>,
) {
    // Native 后台准备：目标片场仍处于 Pending（未发布完整表示）时，截图必须等待合法
    // High Published 根与既有 GPU readiness，而不是把半场/灰底当成结果。请求留在 bridge
    // slot 中由后续帧继续等待（既有 capture 超时与公平调度负责收尾），**不在**同步请求内
    // 强制创建或阻塞等后台任务。
    // 只对仍在创建中的片场等待；卡片预览 rig 的截图目标通常是预览节点本身，其归属片场
    // 由 `pin_owner` 保活，不在这里阻塞。
    if let Some(node) = bridge::queued_shot_capture_node()
        && capture_must_wait(&models, &node)
    {
        return;
    }
    let Some(request) = bridge::take_shot_capture_request() else {
        return;
    };
    let fail = |code: &str| {
        bridge::set_shot_capture_result(ShotCaptureBridgeResult {
            request_id: request.request_id,
            rig_generation: 0,
            bridge_generation: request.bridge_generation,
            outcome: ShotCaptureBridgeOutcome::Failed { code: code.to_owned() },
        });
    };
    let adapter_rig = adapter
        .rig
        .filter(|_| adapter.node_id.as_deref() == Some(request.node_id.as_str()));
    let preview_card = preview_cards.cards.get(&request.node_id);
    let Some(route) = crate::shot_camera::resolve_capture_route(
        &request.node_id,
        (adapter_rig, adapter.node_id.as_deref()),
        preview_card.map(|card| card.rig),
    ) else {
        fail("camera-gone");
        return;
    };
    let rig = route.rig();
    let pin_owner = preview_card.map(|card| card.owner.clone());
    let Ok(derived) = rigs.get(rig) else {
        fail("camera-gone");
        return;
    };
    let rig_generation = derived.generation;
    let (shot_request_id, outcome) = crate::shot_camera::request_capture(
        &mut queue,
        &mut results,
        rig,
        request.width.clamp(1, crate::shot_camera::MAX_CAPTURE_DIMENSION),
        request.height.clamp(1, crate::shot_camera::MAX_CAPTURE_DIMENSION),
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
        pin_owner,
    });
}

/// 目标片场仍在准备中时，截图必须等合法 High Published 根。
///
/// 纯判定（便于无 GPU 回归）：Pending 表示还没有可截的完整表示，不能把半场/灰底当成结果；
/// 准备失败或取消会变回 Absent，此时按既有失败码结束，不会无限等待。
fn capture_must_wait(models: &super::ModelVisuals, node: &str) -> bool {
    models.preparation_state(node) == super::preparation::RootState::Pending
}

/// 供回归断言：捕获等待规则与准备状态严格绑定（Pending 才等待）。
#[cfg(test)]
pub(crate) fn preparation_gate_waits(models: &super::ModelVisuals, node: &str) -> bool {
    capture_must_wait(models, node)
}

/// 把完成的 rig capture 结果写回 bridge；迟到结果只释放。
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

#[cfg(test)]
mod preparation_gate_tests {
    use super::*;

    #[test]
    fn capture_waits_only_while_the_root_is_pending() {
        let mut visuals = super::super::ModelVisuals::default();
        assert!(!capture_must_wait(&visuals, "film"));
        let snapshot = std::sync::Arc::new(crate::protocol::ModelSnapshot::default());
        let key = super::super::preparation::PrepareKey::new(
            &snapshot,
            super::super::quality::Quality::High,
            true,
            super::super::batch_strategy::BatchStrategy::Spatial,
            true,
        );
        visuals
            .preparation
            .demand("film", key, snapshot, super::super::preparation::Priority::Visible);
        assert!(
            capture_must_wait(&visuals, "film"),
            "准备中不得把半场当结果"
        );
        visuals.preparation.cancel("film");
        assert!(
            !capture_must_wait(&visuals, "film"),
            "失败/取消后必须明确结束等待"
        );
    }
}
