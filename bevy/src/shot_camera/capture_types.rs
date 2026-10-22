//! Shot camera capture 类型（请求、结果、有界队列与 outbox）
//! （change: add-reusable-bevy-shot-camera，任务 4.1 / design D6）。

use std::collections::VecDeque;

use bevy::prelude::*;

use super::constants::{
    DEFAULT_MAX_CONCURRENT_CAPTURES, DEFAULT_MAX_QUEUED_CAPTURES, MAX_CAPTURE_DIMENSION,
};

/// capture 请求：以 `(camera, request_id, generation)` 唯一关联。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ShotCaptureRequest {
    pub camera: Entity,
    pub request_id: u64,
    pub width: u32,
    pub height: u32,
    pub generation: u64,
}

/// capture 排队结果（稳定可诊断状态）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShotCaptureEnqueue {
    /// 立即开始（在并发预算内）。
    Accepted,
    /// 进入有界队列。
    Queued,
    /// 队列与并发预算已满。
    Busy,
    /// 请求参数非法。
    Rejected,
}

/// capture 完成结果。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShotCaptureResult {
    pub camera: Entity,
    pub request_id: u64,
    pub generation: u64,
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

/// capture 失败码。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShotCaptureErrorCode {
    /// rig 已销毁。
    CameraGone,
    /// generation 过期。
    StaleGeneration,
    /// 显式取消。
    Cancelled,
    /// readback 失败。
    ReadbackFailed,
    /// 临时捕捉视图未能完成渲染准备。
    ReadinessTimeout,
    /// 已提交回读但未收到图像。
    ReadbackTimeout,
    /// 收到图像但像素无效或全透明。
    EmptyImage,
    /// 输出尺寸非法/超限。
    InvalidSize,
}

impl ShotCaptureErrorCode {
    pub fn code(&self) -> &'static str {
        match self {
            Self::CameraGone => "camera-gone",
            Self::StaleGeneration => "stale-generation",
            Self::Cancelled => "cancelled",
            Self::ReadbackFailed => "readback-failed",
            Self::ReadinessTimeout => "capture-readiness-timeout",
            Self::ReadbackTimeout => "capture-readback-timeout",
            Self::EmptyImage => "capture-empty-image",
            Self::InvalidSize => "invalid-size",
        }
    }
}

/// capture 失败事件。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ShotCaptureFailure {
    pub camera: Entity,
    pub request_id: u64,
    pub code: ShotCaptureErrorCode,
}

/// 有界 capture 队列与进行中作业表。
#[derive(Resource, Debug)]
pub struct ShotCaptureQueue {
    pub max_concurrent: usize,
    pub max_queued: usize,
    pub active: Vec<ShotCaptureRequest>,
    pub pending: VecDeque<ShotCaptureRequest>,
}

impl Default for ShotCaptureQueue {
    fn default() -> Self {
        Self {
            max_concurrent: DEFAULT_MAX_CONCURRENT_CAPTURES,
            max_queued: DEFAULT_MAX_QUEUED_CAPTURES,
            active: Vec::new(),
            pending: VecDeque::new(),
        }
    }
}

impl ShotCaptureQueue {
    /// 排入请求；达到并发/队列预算时返回 Busy，不取消无关请求。
    pub fn enqueue(&mut self, request: ShotCaptureRequest) -> ShotCaptureEnqueue {
        if request.width == 0
            || request.height == 0
            || request.width > MAX_CAPTURE_DIMENSION
            || request.height > MAX_CAPTURE_DIMENSION
        {
            return ShotCaptureEnqueue::Rejected;
        }
        // 幂等：同 camera+request_id+generation 已存在时不重复排队。
        if self.active.contains(&request) || self.pending.contains(&request) {
            return ShotCaptureEnqueue::Queued;
        }
        if self.active.len() < self.max_concurrent {
            self.active.push(request);
            ShotCaptureEnqueue::Accepted
        } else if self.pending.len() < self.max_queued {
            self.pending.push_back(request);
            ShotCaptureEnqueue::Queued
        } else {
            ShotCaptureEnqueue::Busy
        }
    }

    /// 完成一个进行中作业；若队列有等待项则以 FIFO 提升为 active。
    pub fn complete(&mut self, request: &ShotCaptureRequest) -> Option<ShotCaptureRequest> {
        if let Some(index) = self.active.iter().position(|entry| entry == request) {
            self.active.remove(index);
        }
        self.promote_next()
    }

    /// 将一个 active 作业直接移除（失败/取消），并提升下一个。
    pub fn remove_active(&mut self, request: &ShotCaptureRequest) -> Option<ShotCaptureRequest> {
        self.complete(request)
    }

    /// 取消某 rig 的全部请求（active + pending）。
    pub fn cancel_camera(&mut self, camera: Entity) -> Vec<ShotCaptureRequest> {
        let mut removed: Vec<ShotCaptureRequest> = Vec::new();
        let mut kept = VecDeque::new();
        while let Some(request) = self.pending.pop_front() {
            if request.camera == camera {
                removed.push(request);
            } else {
                kept.push_back(request);
            }
        }
        self.pending = kept;
        let (cancelled, kept): (Vec<_>, Vec<_>) = self
            .active
            .drain(..)
            .partition(|request| request.camera == camera);
        self.active = kept;
        removed.extend(cancelled);
        // 提升等待项以补足并发槽位。
        while self.active.len() < self.max_concurrent {
            match self.promote_next() {
                Some(_) => {}
                None => break,
            }
        }
        removed
    }

    fn promote_next(&mut self) -> Option<ShotCaptureRequest> {
        if self.active.len() >= self.max_concurrent {
            return None;
        }
        let next = self.pending.pop_front()?;
        self.active.push(next);
        Some(next)
    }

    /// 当前 active + pending 请求总数。
    pub fn len(&self) -> usize {
        self.active.len() + self.pending.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// capture 完成 outbox（由系统写入，宿主/兼容 adapter 取走）。
#[derive(Resource, Default)]
pub struct ShotCaptureResults {    pub completed: Vec<ShotCaptureResult>,
    pub failures: Vec<ShotCaptureFailure>,
    /// 全局单调 request id 生成器。
    pub next_request_id: u64,
}

/// 截图请求的路由目标（纯决策；装配在 `model3d::capture::route_capture_request`）。
///
/// change: 2026-10-15-add-film-set-shooting-shot-previews，任务 8.4。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CaptureRoute {
    /// adapter rig（片场聚焦预览 / 模型编辑器相机工具）。
    Adapter(Entity),
    /// 拍摄预览卡片 rig（非聚焦的镜头参考录制用）。
    PreviewCard(Entity),
}

impl CaptureRoute {
    /// 命中的 rig entity。
    pub fn rig(self) -> Entity {
        match self {
            Self::Adapter(rig) | Self::PreviewCard(rig) => rig,
        }
    }
}

/// 决定一次截图请求落到哪个 rig。
///
/// 优先级：
/// 1. 请求 node 等于当前 **adapter** node → adapter rig（切换 rig 后旧请求不得落到新 rig）；
/// 2. 否则请求 node 命中的**拍摄预览卡片** rig（非聚焦的镜头参考录制用）；
/// 3. 都没有 → `None`，调用方立即以 `camera-gone` 结束请求。
pub fn resolve_capture_route(
    request_node_id: &str,
    adapter: (Option<Entity>, Option<&str>),
    preview_card_rig: Option<Entity>,
) -> Option<CaptureRoute> {
    let (adapter_rig, adapter_node_id) = adapter;
    if let (Some(rig), Some(node_id)) = (adapter_rig, adapter_node_id) {
        if node_id == request_node_id {
            return Some(CaptureRoute::Adapter(rig));
        }
    }
    preview_card_rig.map(CaptureRoute::PreviewCard)
}

impl ShotCaptureResults {
    pub fn next_request_id(&mut self) -> u64 {
        self.next_request_id = self.next_request_id.wrapping_add(1);
        self.next_request_id
    }

    pub fn push_result(&mut self, result: ShotCaptureResult) {
        self.completed.push(result);
    }

    pub fn push_failure(&mut self, failure: ShotCaptureFailure) {
        self.failures.push(failure);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_route_prefers_matching_adapter_then_falls_back_to_preview_card() {
        let mut world = World::default();
        let adapter = world.spawn_empty().id();
        let card = world.spawn_empty().id();
        // 请求 node 命中 adapter：走 adapter rig（不落到卡片）。
        assert_eq!(
            resolve_capture_route("film-1", (Some(adapter), Some("film-1")), Some(card)),
            Some(CaptureRoute::Adapter(adapter))
        );
        // 请求 node 是预览节点：adapter 不匹配（切换 rig 后旧请求不得落到新 rig），落到卡片 rig。
        assert_eq!(
            resolve_capture_route("preview-1", (Some(adapter), Some("film-1")), Some(card)),
            Some(CaptureRoute::PreviewCard(card))
        );
        // 卡片 rig 不存在（屏外被淘汰）→ 无路由，调用方立即以 camera-gone 结束请求。
        assert_eq!(resolve_capture_route("preview-1", (Some(adapter), Some("film-1")), None), None);
        // adapter 只有 node id 没有 rig 时同样不误用。
        assert_eq!(resolve_capture_route("film-1", (None, Some("film-1")), None), None);
    }

    #[test]
    fn preview_card_routes_expose_their_rig() {
        let mut world = World::default();
        let card = world.spawn_empty().id();
        assert_eq!(CaptureRoute::PreviewCard(card).rig(), card);
        assert_eq!(CaptureRoute::Adapter(card).rig(), card);
    }
}
