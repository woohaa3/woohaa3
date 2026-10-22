//! Native 画布实例的生命周期与有界调度（change: 2026-10-14-migrate-canvas-to-tauri-native-bevy，
//! design D2 / D9，任务 1.4 / 1.5）。
//!
//! 本模块是**与 Bevy 解耦的纯状态机**，可在无 GPU 的机器上完整测试：
//! - 显式分离 build / init（plugin ready）/ finish / cleanup / update / dispose；
//! - Tauri 侧只投递**可取消 tick**，同一实例最多一个未消费 tick；
//! - 零尺寸/最小化时停止 surface 提交，不做忙轮询；
//! - dispose 顺序：先失效 instanceId 与 pending tick，再停新请求，等待在途 GPU 提交受控释放，
//!   最后释放 App/view；
//! - 每页实例独占，一个实例的失败/销毁不影响另一个实例。
//!
//! 真实 Bevy `App` 通过 [`FrameBackend`] 适配（见 [`crate::native_canvas`]）；本模块自身
//! 不导入 Bevy/窗口类型，因此可以在 `--no-default-features` 下单独测试。

use std::collections::BTreeMap;
use std::fmt;

/// 实例身份。重建分配新 ID，不复用旧引用（design D3）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct InstanceId(u64);

impl InstanceId {
    /// 显式构造（测试与持久化记录用）。
    pub const fn from_raw(raw: u64) -> Self {
        Self(raw)
    }

    /// 原始值；用于日志与证据记录，不用于算术。
    pub const fn raw(self) -> u64 {
        self.0
    }
}

impl fmt::Display for InstanceId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "canvas-{}", self.0)
    }
}

/// 单调分配器：每实例一次，重建必得新 ID。
#[derive(Debug, Default)]
pub struct InstanceIdAllocator {
    next: u64,
}

impl InstanceIdAllocator {
    pub fn new() -> Self {
        Self::default()
    }

    /// 分配一个从未使用过的实例身份。
    pub fn allocate(&mut self) -> InstanceId {
        let id = InstanceId(self.next);
        self.next += 1;
        id
    }
}

/// 实例生命周期阶段。
///
/// `Built` 表示 App 已构造但 plugin 尚未 ready；`Ready` 才允许消费 tick；`Disposing` 期间
/// 拒绝新 tick 与新请求；`Disposed` 为终态。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LifecyclePhase {
    /// 已构造 App，等待 plugin ready / finish。
    Built,
    /// plugin finish/cleanup 完成，可投递 tick。
    Ready,
    /// 正在销毁：失效身份、等待在途释放。
    Disposing,
    /// 已销毁终态。
    Disposed,
}

impl LifecyclePhase {
    /// 是否接受新 tick。
    pub const fn accepts_ticks(self) -> bool {
        matches!(self, Self::Ready)
    }

    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::Disposed)
    }
}

/// dispose 的受控步骤；每一步完成后才进入下一步（design D2）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DisposeStep {
    /// 使 instanceId 与 pending tick 失效，拒绝迟到结果。
    InvalidateIdentity,
    /// 停止新请求/输入/capture（见 [`CanvasInstance::reject_new_work`]）。
    StopNewWork,
    /// 等待在途 GPU 提交受控释放。
    DrainInFlight,
    /// 释放 App 与 native view。
    ReleaseApp,
    /// 移除 view/关闭窗口（由宿主完成）。
    ReleasePlatform,
}

impl DisposeStep {
    /// 顺序执行的全部步骤。
    pub const ALL: [DisposeStep; 5] = [
        DisposeStep::InvalidateIdentity,
        DisposeStep::StopNewWork,
        DisposeStep::DrainInFlight,
        DisposeStep::ReleaseApp,
        DisposeStep::ReleasePlatform,
    ];
}

/// 一次待消费的 tick。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Tick {
    /// 目标实例。
    pub instance: InstanceId,
    /// 实例内单调递增的 tick 序号（用于日志与 sidecar 关联）。
    pub sequence: u64,
}

/// 帧后端：真实 Bevy `App` 或无 GPU 测试替身。
///
/// 所有方法都在**同一线程**上串行调用（单一线程独占 App）；本 trait 不要求 `Send`。
pub trait FrameBackend {
    /// 构造 App/世界；不启动 OS 事件循环，不调用 `App::run()`。
    fn build(&mut self) -> Result<(), String>;
    /// 所有 plugin 是否 ready（对应 `App::plugins_state() == Ready`）。
    fn plugins_ready(&mut self) -> bool;
    /// 运行 plugin `finish`。
    fn finish_plugins(&mut self);
    /// 运行 plugin `cleanup`。
    fn cleanup_plugins(&mut self);
    /// 推进一帧（对应 `App::update()`）。
    fn update(&mut self);
    /// 在途的 GPU 提交/回读数量。
    fn in_flight(&self) -> u32;
    /// 受控排空一步；返回是否已排空。不得阻塞 OS loop 过久。
    fn drain_step(&mut self) -> bool;
    /// 释放 App 与它独占的资源。
    fn dispose(&mut self);
}

/// 单个 native 画布实例。
pub struct CanvasInstance {
    id: InstanceId,
    phase: LifecyclePhase,
    backend: Box<dyn FrameBackend>,
    /// 最多一个未消费 tick。
    pending: Option<Tick>,
    /// 已投递过的 tick 总数（日志）。
    issued: u64,
    /// 最近一次报告的视口尺寸（逻辑像素）。
    size: (u32, u32),
    /// 是否已请求关闭。
    close_requested: bool,
    /// 已完成的 dispose 步骤。
    dispose_cursor: usize,
    /// 原始 frame revision（renderer 确认用，非 GPU presented）。
    revision: u32,
}

impl fmt::Debug for CanvasInstance {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CanvasInstance")
            .field("id", &self.id)
            .field("phase", &self.phase)
            .field("pending", &self.pending)
            .field("size", &self.size)
            .finish_non_exhaustive()
    }
}

impl CanvasInstance {
    fn new(id: InstanceId, backend: Box<dyn FrameBackend>) -> Self {
        Self {
            id,
            phase: LifecyclePhase::Built,
            backend,
            pending: None,
            issued: 0,
            size: (0, 0),
            close_requested: false,
            dispose_cursor: 0,
            revision: 0,
        }
    }

    pub fn id(&self) -> InstanceId {
        self.id
    }

    pub fn phase(&self) -> LifecyclePhase {
        self.phase
    }

    pub fn revision(&self) -> u32 {
        self.revision
    }

    /// 当前是否有未消费 tick。
    pub fn has_pending_tick(&self) -> bool {
        self.pending.is_some()
    }

    /// 视口是否为零尺寸（停止 surface 提交）。
    pub fn is_zero_sized(&self) -> bool {
        self.size.0 == 0 || self.size.1 == 0
    }

    /// 令 plugin ready 并运行 finish/cleanup。幂等：已 Ready 后不再重复。
    pub fn initialize(&mut self) -> Result<(), String> {
        if self.phase != LifecyclePhase::Built {
            return Ok(());
        }
        if !self.backend.plugins_ready() {
            return Ok(());
        }
        self.backend.finish_plugins();
        self.backend.cleanup_plugins();
        self.phase = LifecyclePhase::Ready;
        Ok(())
    }

    /// 投递一次 tick。相同实例已有未消费 tick 时合并（返回 `false`），不排队第二份。
    ///
    /// 非 Ready 或已请求关闭的实例拒绝新 tick。
    pub fn request_tick(&mut self) -> bool {
        if self.phase != LifecyclePhase::Ready || self.close_requested {
            return false;
        }
        if self.pending.is_some() {
            return false;
        }
        self.issued += 1;
        self.pending = Some(Tick {
            instance: self.id,
            sequence: self.issued,
        });
        true
    }

    /// 取消尚未消费的 tick（宿主在窗口事件/关闭时调用）。返回是否确实取消了。
    pub fn cancel_pending_tick(&mut self) -> bool {
        self.pending.take().is_some()
    }

    /// 报告新的逻辑视口尺寸。零尺寸时未消费 tick 被取消（不提交 surface）。
    pub fn resize(&mut self, width: u32, height: u32) {
        self.size = (width, height);
        if self.is_zero_sized() {
            self.cancel_pending_tick();
        }
    }

    /// 消费并推进一帧。返回是否实际执行了 `update`。
    ///
    /// 先尝试完成 plugin ready（对应 Bevy runner 的 `while plugins_state == Adding` 循环，
    /// design D2）：未 ready 时本帧只推进初始化，不执行 `update`。零尺寸、关闭中或未 Ready
    /// 时不执行；`update` 后 revision 递增（渲染确认由后端上报）。
    pub fn run_once(&mut self) -> bool {
        // 每次 tick 都尝试推进初始化，避免「创建时未 ready 就再也不会 ready」。
        let _ = self.initialize();
        let Some(tick) = self.pending.take() else {
            return false;
        };
        debug_assert_eq!(tick.instance, self.id);
        if self.phase != LifecyclePhase::Ready || self.close_requested || self.is_zero_sized() {
            return false;
        }
        self.backend.update();
        self.revision = self.revision.wrapping_add(1);
        true
    }

    /// 停止接受新请求/输入/capture（dispose 的 StopNewWork 步骤）。
    pub fn reject_new_work(&mut self) {
        self.close_requested = true;
    }

    /// 请求关闭：立即失效 pending tick 并进入 Disposing。
    pub fn request_close(&mut self) {
        self.close_requested = true;
        self.cancel_pending_tick();
        if self.phase == LifecyclePhase::Ready || self.phase == LifecyclePhase::Built {
            self.phase = LifecyclePhase::Disposing;
        }
    }

    /// 推进 dispose，直到等待在途释放或全部完成。
    ///
    /// `drain_budget` 限制单次调用最多执行的 drain 步数，避免冻结 OS loop。
    /// 返回下一步 `DisposeStep`；全部完成后返回最后一个步骤且 phase 为 `Disposed`。
    pub fn advance_dispose(&mut self, drain_budget: u32) -> Option<DisposeStep> {
        if self.phase == LifecyclePhase::Disposed {
            return None;
        }
        if self.phase != LifecyclePhase::Disposing {
            self.request_close();
        }
        let mut drained = 0;
        while self.dispose_cursor < DisposeStep::ALL.len() {
            let step = DisposeStep::ALL[self.dispose_cursor];
            match step {
                DisposeStep::InvalidateIdentity => {
                    // 身份失效：丢弃待消费 tick。
                    self.pending = None;
                }
                DisposeStep::StopNewWork => self.reject_new_work(),
                DisposeStep::DrainInFlight => {
                    if self.backend.in_flight() > 0 {
                        if drained >= drain_budget {
                            return Some(step);
                        }
                        drained += 1;
                        if !self.backend.drain_step() {
                            return Some(step);
                        }
                    }
                }
                DisposeStep::ReleaseApp => self.backend.dispose(),
                DisposeStep::ReleasePlatform => {}
            }
            self.dispose_cursor += 1;
        }
        self.phase = LifecyclePhase::Disposed;
        Some(DisposeStep::ReleasePlatform)
    }

    /// 是否仍持有在途 GPU 工作。
    pub fn in_flight(&self) -> u32 {
        self.backend.in_flight()
    }
}

/// 每页实例宿主：持有多个实例，保证调度有界且相互隔离。
///
/// 与 `design D9` 一致：切换页面不消耗故障恢复预算，销毁只影响自身。
#[derive(Default)]
pub struct CanvasRuntimeHost {
    ids: InstanceIdAllocator,
    instances: BTreeMap<InstanceId, CanvasInstance>,
    ticks_delivered: u64,
    ticks_coalesced: u64,
}

impl fmt::Debug for CanvasRuntimeHost {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CanvasRuntimeHost")
            .field("instances", &self.instances.keys().collect::<Vec<_>>())
            .field("ticks_delivered", &self.ticks_delivered)
            .field("ticks_coalesced", &self.ticks_coalesced)
            .finish()
    }
}

impl CanvasRuntimeHost {
    pub fn new() -> Self {
        Self::default()
    }

    /// 创建实例并立即尝试初始化（plugin ready 后进入 Ready）。
    pub fn create_instance(
        &mut self,
        backend: Box<dyn FrameBackend>,
    ) -> Result<InstanceId, String> {
        let id = self.ids.allocate();
        let mut instance = CanvasInstance::new(id, backend);
        instance.backend.build()?;
        instance.initialize()?;
        self.instances.insert(id, instance);
        Ok(id)
    }

    pub fn get(&self, id: InstanceId) -> Option<&CanvasInstance> {
        self.instances.get(&id)
    }

    pub fn get_mut(&mut self, id: InstanceId) -> Option<&mut CanvasInstance> {
        self.instances.get_mut(&id)
    }

    /// 活动实例数量（不含已销毁）。
    pub fn live_count(&self) -> usize {
        self.instances
            .values()
            .filter(|instance| !instance.phase().is_terminal())
            .count()
    }

    /// 投递 tick；记录合并次数以便观察背压（design D4）。
    pub fn request_tick(&mut self, id: InstanceId) -> bool {
        let Some(instance) = self.instances.get_mut(&id) else {
            return false;
        };
        if instance.request_tick() {
            self.ticks_delivered += 1;
            true
        } else if instance.phase().accepts_ticks() && !instance.close_requested {
            self.ticks_coalesced += 1;
            false
        } else {
            false
        }
    }

    /// 消费一个实例的 tick。
    pub fn run_once(&mut self, id: InstanceId) -> bool {
        self.instances
            .get_mut(&id)
            .map(CanvasInstance::run_once)
            .unwrap_or(false)
    }

    /// 报告视口尺寸。
    pub fn resize(&mut self, id: InstanceId, width: u32, height: u32) {
        if let Some(instance) = self.instances.get_mut(&id) {
            instance.resize(width, height);
        }
    }

    /// 请求关闭并推进 dispose；返回是否已完全销毁。
    pub fn close(&mut self, id: InstanceId, drain_budget: u32) -> bool {
        let Some(instance) = self.instances.get_mut(&id) else {
            return true;
        };
        instance.request_close();
        instance.advance_dispose(drain_budget);
        instance.phase().is_terminal()
    }

    /// 丢弃已销毁实例的槽位（释放后端已释放的 App）。
    pub fn reap(&mut self, id: InstanceId) {
        if self
            .instances
            .get(&id)
            .is_some_and(|instance| instance.phase().is_terminal())
        {
            self.instances.remove(&id);
        }
    }

    /// 诊断快照（JSON 片段，不进入权威文档）。
    pub fn diagnostics(&self) -> String {
        let live = self.live_count();
        let pending = self
            .instances
            .values()
            .filter(|instance| instance.has_pending_tick())
            .count();
        format!(
            "{{\"liveInstances\":{live},\"pendingTicks\":{pending},\"ticksDelivered\":{},\"ticksCoalesced\":{}}}",
            self.ticks_delivered, self.ticks_coalesced
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::rc::Rc;

    /// 记录调用顺序的测试替身；不依赖 GPU 或窗口。
    struct FakeBackend {
        ready_flag: Rc<Cell<bool>>,
        build_error: Option<String>,
        log: Rc<RefCell<Vec<String>>>,
        in_flight: u32,
        /// 每次 drain_step 释放的在途数量。
        drain_per_step: u32,
    }

    impl FakeBackend {
        fn new(log: Rc<RefCell<Vec<String>>>) -> Self {
            Self {
                ready_flag: Rc::new(Cell::new(true)),
                build_error: None,
                log,
                in_flight: 0,
                drain_per_step: 1,
            }
        }

        fn note(&self, event: &str) {
            self.log.borrow_mut().push(event.to_owned());
        }
    }

    impl FrameBackend for FakeBackend {
        fn build(&mut self) -> Result<(), String> {
            self.note("build");
            match &self.build_error {
                Some(error) => Err(error.clone()),
                None => Ok(()),
            }
        }

        fn plugins_ready(&mut self) -> bool {
            self.ready_flag.get()
        }

        fn finish_plugins(&mut self) {
            self.note("finish");
        }

        fn cleanup_plugins(&mut self) {
            self.note("cleanup");
        }

        fn update(&mut self) {
            self.note("update");
        }

        fn in_flight(&self) -> u32 {
            self.in_flight
        }

        fn drain_step(&mut self) -> bool {
            self.note("drain");
            self.in_flight = self.in_flight.saturating_sub(self.drain_per_step);
            self.in_flight == 0
        }

        fn dispose(&mut self) {
            self.note("dispose");
        }
    }

    fn host_with_backend() -> (CanvasRuntimeHost, InstanceId, Rc<RefCell<Vec<String>>>) {
        let log = Rc::new(RefCell::new(Vec::new()));
        let mut host = CanvasRuntimeHost::new();
        let id = host
            .create_instance(Box::new(FakeBackend::new(log.clone())))
            .expect("build");
        (host, id, log)
    }

    #[test]
    fn initialize_runs_finish_and_cleanup_then_becomes_ready() {
        let (host, id, log) = host_with_backend();
        assert_eq!(host.get(id).unwrap().phase(), LifecyclePhase::Ready);
        let events = log.borrow().clone();
        assert_eq!(events, vec!["build", "finish", "cleanup"]);
    }

    #[test]
    fn build_failure_is_reported_without_inserting_instance() {
        let log = Rc::new(RefCell::new(Vec::new()));
        let mut backend = FakeBackend::new(log.clone());
        backend.build_error = Some("no adapter".to_owned());
        let mut host = CanvasRuntimeHost::new();
        let error = host.create_instance(Box::new(backend)).unwrap_err();
        assert_eq!(error, "no adapter");
        assert_eq!(host.live_count(), 0);
    }

    #[test]
    fn pending_tick_is_bounded_to_one_per_instance() {
        let (mut host, id, _) = host_with_backend();
        host.resize(id, 800, 600);
        assert!(host.request_tick(id));
        assert!(
            !host.request_tick(id),
            "同一实例第二次 tick 必须被合并而不是排队"
        );
        assert!(host.get(id).unwrap().has_pending_tick());
        assert_eq!(host.diagnostics().contains("\"pendingTicks\":1"), true);
        assert!(host.run_once(id));
        // 消费后可再次投递。
        assert!(host.request_tick(id));
    }

    #[test]
    fn zero_size_suppresses_update_and_cancels_pending_tick() {
        let (mut host, id, log) = host_with_backend();
        host.resize(id, 800, 600);
        assert!(host.request_tick(id));
        host.resize(id, 0, 600);
        assert!(
            !host.get(id).unwrap().has_pending_tick(),
            "零尺寸必须取消未消费 tick"
        );
        assert!(!host.run_once(id), "零尺寸不得提交 surface");
        assert_eq!(host.get(id).unwrap().revision(), 0);
        assert!(!log.borrow().iter().any(|event| event == "update"));
        // 恢复尺寸后重新可提交。
        host.resize(id, 800, 600);
        assert!(host.request_tick(id));
        assert!(host.run_once(id));
        assert_eq!(host.get(id).unwrap().revision(), 1);
    }

    #[test]
    fn close_rejects_new_ticks_and_invalidates_pending() {
        let (mut host, id, _) = host_with_backend();
        host.resize(id, 640, 480);
        assert!(host.request_tick(id));
        assert!(host.close(id, 8));
        assert_eq!(host.get(id).unwrap().phase(), LifecyclePhase::Disposed);
        assert!(!host.get(id).unwrap().has_pending_tick());
        assert!(!host.request_tick(id), "已销毁实例拒绝新 tick");
        assert!(!host.run_once(id));
    }

    #[test]
    fn dispose_waits_for_in_flight_before_releasing_app() {
        let log = Rc::new(RefCell::new(Vec::new()));
        let mut backend = FakeBackend::new(log.clone());
        backend.in_flight = 3;
        let mut host = CanvasRuntimeHost::new();
        let id = host.create_instance(Box::new(backend)).unwrap();
        // 预算 1：一次调用最多 drain 一步，不能在 App 释放前完成。
        host.get_mut(id).unwrap().request_close();
        let step = host.get_mut(id).unwrap().advance_dispose(1);
        assert_eq!(step, Some(DisposeStep::DrainInFlight));
        assert!(!host.get(id).unwrap().phase().is_terminal());
        assert!(!log.borrow().iter().any(|event| event == "dispose"));
        // 继续推进直到在途排空。
        let mut guard = 0;
        while !host.close(id, 1) && guard < 16 {
            guard += 1;
        }
        assert!(host.get(id).unwrap().phase().is_terminal());
        let events = log.borrow().clone();
        let dispose_at = events.iter().position(|event| event == "dispose").unwrap();
        let last_drain = events.iter().rposition(|event| event == "drain").unwrap();
        assert!(last_drain < dispose_at, "必须在释放 App 前排空在途提交");
    }

    #[test]
    fn two_instances_are_isolated_on_resize_and_dispose() {
        let (mut host, first, _log_a) = host_with_backend();
        let log_b = Rc::new(RefCell::new(Vec::new()));
        let second = host
            .create_instance(Box::new(FakeBackend::new(log_b.clone())))
            .unwrap();
        assert_ne!(first, second);
        host.resize(first, 100, 100);
        host.resize(second, 200, 200);
        host.request_tick(first);
        host.request_tick(second);
        assert!(host.close(first, 4));
        // 销毁第一个实例不影响第二个的 tick 与 revision。
        assert!(host.get(second).unwrap().has_pending_tick());
        assert!(host.run_once(second));
        assert_eq!(host.get(second).unwrap().revision(), 1);
        assert_eq!(host.get(first).unwrap().phase(), LifecyclePhase::Disposed);
        // 第二个实例仍可用。
        assert!(host.request_tick(second));
    }

    #[test]
    fn rebuild_allocates_new_identity_and_old_slot_is_reaped() {
        let (mut host, first, _) = host_with_backend();
        assert!(host.close(first, 8));
        host.reap(first);
        let log = Rc::new(RefCell::new(Vec::new()));
        let second = host
            .create_instance(Box::new(FakeBackend::new(log)))
            .unwrap();
        assert_ne!(first, second, "重建必须分配新 instanceId");
        assert!(second.raw() > first.raw());
        assert_eq!(host.live_count(), 1);
    }

    #[test]
    fn not_ready_backend_defers_initialization() {
        let log = Rc::new(RefCell::new(Vec::new()));
        let mut backend = FakeBackend::new(log.clone());
        backend.ready_flag.set(false);
        let mut host = CanvasRuntimeHost::new();
        let id = host.create_instance(Box::new(backend)).unwrap();
        assert_eq!(host.get(id).unwrap().phase(), LifecyclePhase::Built);
        assert!(!host.request_tick(id), "未 ready 不得消费 tick");
        assert!(!log.borrow().iter().any(|event| event == "finish"));
    }

    #[test]
    fn tick_re_attempts_initialization_until_ready() {
        // 模拟 Bevy runner 的「plugin 仍在 Adding」阶段：后端稍后才 ready。
        let log = Rc::new(RefCell::new(Vec::new()));
        let mut backend = FakeBackend::new(log.clone());
        let ready = backend.ready_flag.clone();
        backend.ready_flag.set(false);
        let mut host = CanvasRuntimeHost::new();
        let id = host.create_instance(Box::new(backend)).unwrap();
        host.resize(id, 640, 480);
        assert_eq!(host.get(id).unwrap().phase(), LifecyclePhase::Built);
        // 后端转 ready 后，下一次 run_once 推进初始化。
        ready.set(true);
        assert!(!host.run_once(id), "初始化帧不执行 update");
        assert_eq!(host.get(id).unwrap().phase(), LifecyclePhase::Ready);
        assert!(host.request_tick(id));
        assert!(host.run_once(id));
        assert_eq!(host.get(id).unwrap().revision(), 1);
    }

    #[test]
    fn resource_free_host_has_no_instances() {
        let host = CanvasRuntimeHost::new();
        assert_eq!(host.live_count(), 0);
        assert!(host.get(InstanceId::from_raw(0)).is_none());
    }

    #[test]
    fn allocator_never_reuses_identity() {
        let mut allocator = InstanceIdAllocator::new();
        let a = allocator.allocate();
        let b = allocator.allocate();
        assert_ne!(a, b);
        assert!(b.raw() > a.raw());
    }
}
