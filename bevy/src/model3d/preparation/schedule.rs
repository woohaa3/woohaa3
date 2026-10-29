//! Native 片场准备调度：后台任务、有界队列、CPU 工作额度与阶段诊断
//! （change: 2026-10-18-prepare-native-film-sets-in-background，design D3/D4/D7）。
//!
//! 本模块只做**调度与记账**：不持有 `World`/`Commands`/`Assets`，不创建实体。
//! 真正的装配在 [`super::assembly`] 中按全局每帧预算推进。
//!
//! 记账口径（design D4）：`work.bytes` 只统计**新增**准备的 CPU 保活，包含
//! 排队（输入估算）、运行（输入估算）、完成待装配（输入估算 + 产物缓冲）三部分；
//! 共享 allocation 按 key 去重（同内容同档位只准备一次），运行中的取消必须等任务退出才释放。
//!
//! 关键约束：最多 [`MAX_RUNNING`] 个运行任务、[`MAX_QUEUED`] 个排队请求、
//! [`MAX_WORK_BYTES`] 新增 CPU 工作缓冲；宿主只做非阻塞 poll，从不 join，
//! 也不因额度满而回退宿主线程同步整场生成。

use std::collections::{BTreeMap, BTreeSet, HashSet, VecDeque};
use std::sync::Arc;

use bevy::platform::time::Instant;
use bevy::tasks::{AsyncComputeTaskPool, Task, TaskPoolBuilder, block_on, poll_once};

use crate::protocol::ModelSnapshot;

use super::super::batch_strategy::BatchStrategy;
use super::super::quality::Quality;
use super::prepared::{self, PrepareFailure, PreparedModel};

/// 同时运行的后台准备任务上限（design D4 初值）。
pub const MAX_RUNNING: usize = 2;
/// 排队请求上限（design D4 初值）。
pub const MAX_QUEUED: usize = 8;
/// 新增唯一 CPU 工作缓冲总额度（design D4 初值）。
pub const MAX_WORK_BYTES: usize = 128 * 1024 * 1024;
/// 诊断中保留的完成/失败摘要条数（有界，不逐帧输出日志）。
const MAX_REPORTED: usize = 16;

/// 执行模式：生产用真实任务池；`Inline` 供纯 CPU 回归确定性完成。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Mode {
    #[default]
    Async,
    Inline,
}

/// 准备身份中与实例无关的部分：内容 + 质量 + 批处理策略。
///
/// viewport 平移、完整场景 generation、播放时钟与实例 placement **不进入**该 key
/// （design D3），因此仅平移不会取消或重建任务。
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct PrepareKey {
    content: String,
    /// 共享资源表条目身份（内容替换产生新 `Arc`）。
    resource: usize,
    pub(super) quality: Quality,
    pub(super) batched: bool,
    pub(super) overview: bool,
    strategy: BatchStrategy,
}

impl PrepareKey {
    pub(crate) fn new(
        resource: &Arc<ModelSnapshot>,
        quality: Quality,
        batched: bool,
        strategy: BatchStrategy,
        overview: bool,
    ) -> Self {
        let content = if resource.signature.is_empty() {
            // 未准备/测试快照可能没有签名：退回操作数，仍保证同内容可复用。
            format!("unsig:{}", resource.ops.len())
        } else {
            resource.signature.clone()
        };
        Self {
            content,
            resource: Arc::as_ptr(resource) as *const () as usize,
            quality,
            batched,
            overview,
            strategy,
        }
    }

    /// 诊断摘要（不含完整几何）。
    pub(super) fn summary(&self) -> String {
        format!(
            "{}/{:?}/{}/{}",
            self.content,
            self.quality,
            self.batched,
            self.strategy.name()
        )
    }
}

/// 请求优先级：可见/High 消费者高于屏外预热；同级按队列年龄公平。
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Priority {
    /// 屏外预热（普通平移进入预加载范围）。
    Warm,
    /// 可见或显式高质量消费者（选中/聚焦/编辑/捕获/预览）。
    Visible,
}

/// 一个实例的最新准备需求。
#[derive(Clone)]
pub struct Demand {
    pub(super) node: String,
    pub(super) key: PrepareKey,
    pub(super) resource: Arc<ModelSnapshot>,
    pub(super) priority: Priority,
    /// 需求 token：内容/档位/优先级变化推进；发布前必须仍匹配。
    pub(super) token: u64,
}

/// 单个共享内容的工作项（同 key 只准备一次，多实例共享产物）。
struct Job {
    key: PrepareKey,
    resource: Arc<ModelSnapshot>,
    priority: Priority,
    /// 入队顺序（同级 FIFO）。
    sequence: u64,
    /// 入队时刻（排队等待诊断）。
    queued_at: Instant,
    /// 输入规模预留额度。
    reserved: usize,
}

/// 后台任务返回的完成结果。
struct Finished {
    key: PrepareKey,
    /// 输入预留额度（完成后与产物缓冲一起继续保活）。
    reserved: usize,
    thread: String,
    elapsed_ms: f64,
    wait_ms: f64,
    result: Result<PreparedModel, PrepareFailure>,
}

/// 已完成、等待宿主装配的产物。多实例共享同一 `Arc`，不重复准备。
#[derive(Clone)]
pub struct Ready {
    pub(super) key: PrepareKey,
    pub(super) prepared: Arc<PreparedModel>,
    /// 该产物当前占用的 CPU 工作额度（输入预留 + 产物缓冲）。
    pub(super) reserved: usize,
    /// 完成它的后台线程 ID（线程边界验证与诊断）。
    #[cfg_attr(not(test), allow(dead_code))]
    pub(super) thread: String,
}

impl Ready {
    pub(super) fn bytes(&self) -> usize {
        self.reserved
    }
}

/// 准备阶段诊断（有界；不遍历几何、不逐帧写日志）。
#[derive(Default)]
pub struct PreparationWork {
    pub(super) queued: usize,
    pub(super) running: usize,
    pub(super) ready: usize,
    pub(super) assembling: usize,
    pub(super) published: u64,
    pub(super) cancelled: u64,
    pub(super) rejected: u64,
    pub(super) failed: u64,
    pub(super) cache_hits: u64,
    pub(super) stale_dropped: u64,
    pub(super) started: u64,
    /// 当前与峰值 CPU 工作缓冲字节（新增保活，不含既有 snapshot/共享缓存）。
    pub(super) bytes: usize,
    pub(super) peak_bytes: usize,
    pub(super) background_ms: f64,
    pub(super) background_max_ms: f64,
    pub(super) wait_ms: f64,
    pub(super) wait_max_ms: f64,
    pub(super) poll_ms: f64,
    pub(super) poll_max_ms: f64,
    /// 宿主实际装配与 deferred 命令应用（累计/最大）。
    pub(super) assemble_ms: f64,
    pub(super) assemble_max_ms: f64,
    pub(super) command_ms: f64,
    pub(super) command_max_ms: f64,
    /// 命令应用耗时的跨帧余量（不足 0.25 ms 的部分）。
    command_carry_ms: f64,
    /// 累积装配工作量（工作单元/新 mesh 字节）与单帧峰值。
    pub(super) units_total: u64,
    pub(super) units_max: u64,
    pub(super) new_mesh_bytes_total: u64,
    pub(super) new_mesh_bytes_max: u64,
    pub(super) oversize: u64,
    /// 单帧超出软预算的帧数（只允许单个不可抢占步骤或命令应用导致）。
    pub(super) budget_overshoot: u64,
    /// 最近完成/失败的摘要（有界）。
    pub(super) recent: VecDeque<serde_json::Value>,
    /// 真实后台线程 ID 集合（证明计算离开宿主线程）。
    pub(super) threads: BTreeSet<String>,
    /// 观测到的宿主线程 ID。
    pub(super) host_thread: Option<String>,
}

impl PreparationWork {
    fn record(&mut self, value: serde_json::Value) {
        if self.recent.len() >= MAX_REPORTED {
            self.recent.pop_front();
        }
        self.recent.push_back(value);
    }

    pub(super) fn account(&mut self, bytes: usize) {
        self.bytes = self.bytes.saturating_add(bytes);
        self.peak_bytes = self.peak_bytes.max(self.bytes);
    }

    pub(super) fn release(&mut self, bytes: usize) {
        self.bytes = self.bytes.saturating_sub(bytes);
    }

    pub(super) fn frame_units(&mut self, units: u64, new_mesh_bytes: u64, ms: f64) {
        self.units_total += units;
        self.units_max = self.units_max.max(units);
        if units > super::assembly::MAX_UNITS_PER_FRAME {
            // 单个不可抢占步骤（大批次/命令应用）允许跨过软阈值；记录以便校准初值。
            self.budget_overshoot += 1;
        }
        self.new_mesh_bytes_total += new_mesh_bytes;
        self.new_mesh_bytes_max = self.new_mesh_bytes_max.max(new_mesh_bytes);
        self.assemble_ms += ms;
        self.assemble_max_ms = self.assemble_max_ms.max(ms);
    }

    /// 记录本帧实际 deferred 命令应用：计时并按实测耗时折算装配工作单元
    /// （0.25 ms 一单元，余量跨帧累计，避免微小 flush 被向上取整成幽灵单元）。
    ///
    /// 这不是排队 `Commands` 的数量，而是**应用**它们的宿主工作；帧尾无界 drain 会在这里
    /// 暴露成高单元数，因此不能靠「只测排队」掩盖（design D5）。
    pub(super) fn record_commands(&mut self, ms: f64) -> u64 {
        self.command_ms += ms;
        self.command_max_ms = self.command_max_ms.max(ms);
        self.command_carry_ms += ms;
        let units = (self.command_carry_ms / 0.25).floor().max(0.0) as u64;
        self.command_carry_ms -= units as f64 * 0.25;
        if units > 0 {
            self.units_total += units;
        }
        units
    }

    pub(crate) fn diagnostics(&self) -> serde_json::Value {
        serde_json::json!({
            "scope": "native film-set CPU preparation; not GPU upload bytes, GPU time or FPS",
            "queued": self.queued,
            "running": self.running,
            "ready": self.ready,
            "assembling": self.assembling,
            "published": self.published,
            "cancelled": self.cancelled,
            "rejected": self.rejected,
            "failed": self.failed,
            "cacheHits": self.cache_hits,
            "staleDropped": self.stale_dropped,
            "started": self.started,
            "workBytes": self.bytes,
            "peakWorkBytes": self.peak_bytes,
            "maxRunning": MAX_RUNNING,
            "maxQueued": MAX_QUEUED,
            "maxWorkBytes": MAX_WORK_BYTES,
            "backgroundTotalMs": self.background_ms,
            "backgroundMaxMs": self.background_max_ms,
            "waitTotalMs": self.wait_ms,
            "waitMaxMs": self.wait_max_ms,
            "pollTotalMs": self.poll_ms,
            "pollMaxMs": self.poll_max_ms,
            "assembleTotalMs": self.assemble_ms,
            "assembleMaxMs": self.assemble_max_ms,
            "commandTotalMs": self.command_ms,
            "commandMaxMs": self.command_max_ms,
            "assemblyUnits": self.units_total,
            "assemblyUnitsMaxPerFrame": self.units_max,
            "newMeshBytes": self.new_mesh_bytes_total,
            "newMeshBytesMaxPerFrame": self.new_mesh_bytes_max,
            "oversizeResources": self.oversize,
            "budgetOvershootFrames": self.budget_overshoot,
            "hostThread": self.host_thread,
            "backgroundThreads": self.threads.iter().cloned().collect::<Vec<_>>(),
            "recent": self.recent.iter().cloned().collect::<Vec<_>>()
        })
    }
}

struct Running {
    key: PrepareKey,
    reserved: usize,
    task: Task<Finished>,
}

/// 全局后台准备调度器。
pub struct Scheduler {
    mode: Mode,
    demands: BTreeMap<String, Demand>,
    queued: Vec<Job>,
    running: Vec<Running>,
    ready: Vec<Ready>,
    /// 运行中被取消的 key（结果等任务退出才丢弃）。
    cancelled_running: HashSet<PrepareKey>,
    sequence: u64,
    token: u64,
    pub(crate) work: PreparationWork,
}

impl Default for Scheduler {
    fn default() -> Self {
        Self {
            // 单元测试默认不依赖真实线程池；需要线程边界时显式切回 `Async`。
            mode: if cfg!(test) {
                Mode::Inline
            } else {
                Mode::Async
            },
            demands: BTreeMap::new(),
            queued: Vec::new(),
            running: Vec::new(),
            ready: Vec::new(),
            cancelled_running: HashSet::new(),
            sequence: 0,
            token: 0,
            work: PreparationWork::default(),
        }
    }
}

impl Scheduler {
    /// 仅测试使用：切换到真实任务池以验证线程边界，或保持在 `Inline` 做确定性回归。
    #[cfg(test)]
    pub(super) fn set_mode(&mut self, mode: Mode) {
        self.mode = mode;
    }

    #[cfg(test)]
    pub(super) fn mode(&self) -> Mode {
        self.mode
    }

    /// 注册/更新实例需求；内容、档位或优先级变化推进 token 并作废旧 key。
    pub(crate) fn demand(
        &mut self,
        node: &str,
        key: PrepareKey,
        resource: Arc<ModelSnapshot>,
        priority: Priority,
    ) -> u64 {
        if let Some(existing) = self.demands.get(node)
            && existing.key == key
            && existing.priority == priority
            && Arc::ptr_eq(&existing.resource, &resource)
        {
            return existing.token;
        }
        if let Some(existing) = self.demands.get(node).cloned()
            && existing.key != key
            && !self
                .demands
                .values()
                .any(|other| other.node != node && other.key == existing.key)
        {
            self.drop_key(&existing.key);
        }
        self.token = self.token.wrapping_add(1);
        self.demands.insert(
            node.to_owned(),
            Demand {
                node: node.to_owned(),
                key,
                resource,
                priority,
                token: self.token,
            },
        );
        self.token
    }

    pub(super) fn demand_of(&self, node: &str) -> Option<&Demand> {
        self.demands.get(node)
    }

    pub(super) fn demands(&self) -> impl Iterator<Item = &Demand> {
        self.demands.values()
    }

    /// 当前排队数（回归断言）。
    #[cfg(test)]
    pub(super) fn queued_len(&self) -> usize {
        self.queued.len()
    }

    /// 当前运行任务数（回归断言）。
    #[cfg(test)]
    pub(super) fn running_len(&self) -> usize {
        self.running.len()
    }

    /// 运行中的请求是否全部为可见优先级（公平性回归）。
    #[cfg(test)]
    ///
    /// 运行槽只按优先级补位，因此「可见请求先占槽」等价于当前运行集合都来自可见需求；
    /// 这里用需求集合判定，避免为诊断额外保存一份运行优先级。
    pub(super) fn running_visible_only(&self) -> bool {
        self.running.iter().all(|running| {
            self.demands
                .values()
                .any(|demand| demand.key == running.key && demand.priority == Priority::Visible)
        })
    }

    /// 取消某实例需求（节点删除、失去 demand）。
    pub(crate) fn cancel(&mut self, node: &str) {
        let Some(demand) = self.demands.remove(node) else {
            return;
        };
        if !self.demands.values().any(|other| other.key == demand.key) {
            self.drop_key(&demand.key);
        }
    }

    /// 只保留给定实例；其余需求作废（renderer 生命周期切换）。
    pub(super) fn retain(&mut self, alive: impl Fn(&str) -> bool) {
        let stale: Vec<String> = self
            .demands
            .keys()
            .filter(|node| !alive(node))
            .cloned()
            .collect();
        for node in stale {
            self.cancel(&node);
        }
    }

    /// 丢弃全部需求、排队与待领取结果（renderer 销毁）。
    pub(crate) fn clear(&mut self) {
        self.demands.clear();
        let mut released = 0usize;
        for job in self.queued.drain(..) {
            released += job.reserved;
        }
        for ready in self.ready.drain(..) {
            released += ready.reserved;
        }
        self.work.release(released);
        for running in &self.running {
            self.cancelled_running.insert(running.key.clone());
        }
        self.work.queued = 0;
        self.work.ready = 0;
        self.work.running = self.running.len();
    }

    /// 是否既无需求也无在途工作（测试等待静止用）。
    #[cfg(test)]
    pub(crate) fn is_empty(&self) -> bool {
        self.demands.is_empty()
            && self.queued.is_empty()
            && self.running.is_empty()
            && self.ready.is_empty()
    }

    /// 该 key 的完成产物（共享：克隆 `Arc`，不消费）。
    pub(super) fn claim(&self, key: &PrepareKey) -> Option<Ready> {
        self.ready.iter().find(|ready| &ready.key == key).cloned()
    }

    /// 丢弃某 key 的排队工作；运行中任务标记取消（额度保留到任务退出）。
    ///
    /// 已完成产物交给 [`Self::gc`]：装配中的 staging 仍持有它的 `Arc`，过早释放记账会低估峰值。
    pub(super) fn drop_key(&mut self, key: &PrepareKey) {
        let mut released = 0usize;
        let mut cancelled = 0u64;
        self.queued.retain(|job| {
            if &job.key != key {
                return true;
            }
            released += job.reserved;
            cancelled += 1;
            false
        });
        if released > 0 {
            self.work.release(released);
            self.work.cancelled += cancelled;
        }
        if self.running.iter().any(|running| &running.key == key) {
            self.cancelled_running.insert(key.clone());
        }
        self.work.queued = self.queued.len();
    }

    /// 回收不再被任何实例需求或 staging 引用的完成产物。
    pub(super) fn gc(&mut self, assembling: impl Fn(&PrepareKey) -> bool) {
        let demanded: HashSet<PrepareKey> = self
            .demands
            .values()
            .map(|demand| demand.key.clone())
            .collect();
        let mut released = 0usize;
        let mut dropped = 0u64;
        self.ready.retain(|ready| {
            if demanded.contains(&ready.key) || assembling(&ready.key) {
                return true;
            }
            released += ready.bytes();
            dropped += 1;
            false
        });
        if dropped > 0 {
            self.work.release(released);
            self.work.stale_dropped += dropped;
        }
        self.work.ready = self.ready.len();
    }

    /// 非阻塞 poll + 补位运行任务。返回本帧完成数。
    pub(super) fn poll(&mut self) -> usize {
        let started = Instant::now();
        // 宿主线程 ID：诊断据此判断后台准备是否确实离开了装配线程。
        if self.work.host_thread.is_none() {
            self.work.host_thread = Some(
                std::thread::current()
                    .name()
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("{:?}", std::thread::current().id())),
            );
        }
        let mut completed = 0usize;
        let mut index = 0usize;
        while index < self.running.len() {
            // `poll_once` 立即返回：任务未完成时得到 `None`，绝不 join 未完成工作。
            let polled = block_on(poll_once(&mut self.running[index].task));
            let Some(finished) = polled else {
                index += 1;
                continue;
            };
            let running = self.running.remove(index);
            self.work.running = self.running.len();
            if self.cancelled_running.remove(&finished.key) {
                // 运行期间被取消：结果丢弃，运行额度到此释放。
                self.work.release(running.reserved);
                self.work.cancelled += 1;
            } else {
                self.absorb(finished);
            }
            completed += 1;
        }
        self.enqueue();
        self.promote();
        let elapsed = started.elapsed().as_secs_f64() * 1000.0;
        self.work.poll_ms += elapsed;
        self.work.poll_max_ms = self.work.poll_max_ms.max(elapsed);
        completed
    }

    /// 完成结果记账；产物缓冲继续占用额度直到不再被需要。
    fn absorb(&mut self, finished: Finished) {
        self.work.background_ms += finished.elapsed_ms;
        self.work.background_max_ms = self.work.background_max_ms.max(finished.elapsed_ms);
        self.work.wait_ms += finished.wait_ms;
        self.work.wait_max_ms = self.work.wait_max_ms.max(finished.wait_ms);
        self.work.threads.insert(finished.thread.clone());
        match finished.result {
            Ok(prepared) => {
                let prepared_bytes = prepared.bytes;
                self.work.account(prepared_bytes);
                let summary = prepared::summary(&prepared);
                self.work.record(serde_json::json!({
                    "event": "prepared",
                    "key": finished.key.summary(),
                    "thread": finished.thread,
                    "elapsedMs": finished.elapsed_ms,
                    "waitMs": finished.wait_ms,
                    "bytes": finished.reserved + prepared_bytes,
                    "summary": summary
                }));
                self.ready.push(Ready {
                    key: finished.key,
                    prepared: Arc::new(prepared),
                    // 产物缓冲与输入预留都继续计入额度，直到装配完成或回收。
                    reserved: finished.reserved + prepared_bytes,
                    thread: finished.thread,
                });
            }
            Err(reason) => {
                // 失败：输入预留随任务结束释放，不回退宿主线程同步生成。
                self.work.release(finished.reserved);
                self.work.failed += 1;
                self.work.record(serde_json::json!({
                    "event": "failed",
                    "key": finished.key.summary(),
                    "reason": reason.code(),
                    "elapsedMs": finished.elapsed_ms
                }));
            }
        }
    }

    /// 把合并后的需求加入排队（去重、额度预留、超限撤下预热）。
    fn enqueue(&mut self) {
        let active: HashSet<PrepareKey> = self
            .demands
            .values()
            .map(|demand| demand.key.clone())
            .collect();
        let mut released = 0usize;
        let mut dropped = 0u64;
        self.queued.retain(|job| {
            if active.contains(&job.key) {
                return true;
            }
            released += job.reserved;
            dropped += 1;
            false
        });
        if dropped > 0 {
            self.work.release(released);
            self.work.cancelled += dropped;
        }
        let busy: HashSet<PrepareKey> = self
            .running
            .iter()
            .map(|running| running.key.clone())
            .chain(self.ready.iter().map(|ready| ready.key.clone()))
            .chain(self.queued.iter().map(|job| job.key.clone()))
            .collect();
        let mut merged: BTreeMap<PrepareKey, (Priority, Arc<ModelSnapshot>)> = BTreeMap::new();
        for demand in self.demands.values() {
            if busy.contains(&demand.key) {
                continue;
            }
            let entry = merged
                .entry(demand.key.clone())
                .or_insert((demand.priority, demand.resource.clone()));
            entry.0 = entry.0.max(demand.priority);
        }
        for (key, (priority, resource)) in merged {
            let estimate = prepared::estimate(&resource);
            if self.work.bytes + estimate > MAX_WORK_BYTES && !self.evict_warm(estimate) {
                // 额度不足：保留可重试需求，不回退宿主线程同步整场创建。
                self.work.rejected += 1;
                continue;
            }
            if self.queued.len() >= MAX_QUEUED && !self.evict_lower(priority) {
                self.work.rejected += 1;
                continue;
            }
            self.sequence = self.sequence.wrapping_add(1);
            self.work.account(estimate);
            self.queued.push(Job {
                key,
                resource,
                priority,
                sequence: self.sequence,
                queued_at: Instant::now(),
                reserved: estimate,
            });
        }
        self.work.queued = self.queued.len();
    }

    /// 释放足够的最老预热额度（返回是否释放够）。
    fn evict_warm(&mut self, needed: usize) -> bool {
        let mut freed = 0usize;
        let mut cancelled = 0u64;
        while freed < needed {
            let Some(index) = self
                .queued
                .iter()
                .enumerate()
                .filter(|(_, job)| job.priority == Priority::Warm)
                .min_by_key(|(_, job)| job.sequence)
                .map(|(index, _)| index)
            else {
                break;
            };
            let job = self.queued.remove(index);
            freed += job.reserved;
            cancelled += 1;
        }
        if freed > 0 {
            self.work.release(freed);
            self.work.cancelled += cancelled;
        }
        freed >= needed
    }

    /// 队列满时撤下一个优先级不高于新请求的排队项。
    fn evict_lower(&mut self, priority: Priority) -> bool {
        let Some(index) = self
            .queued
            .iter()
            .enumerate()
            .filter(|(_, job)| job.priority <= priority)
            .min_by_key(|(_, job)| (job.priority, job.sequence))
            .map(|(index, _)| index)
        else {
            return false;
        };
        let job = self.queued.remove(index);
        self.work.release(job.reserved);
        self.work.cancelled += 1;
        true
    }

    /// 按优先级补位运行任务（同级 FIFO）。
    fn promote(&mut self) {
        while self.running.len() < MAX_RUNNING {
            let Some(index) = self
                .queued
                .iter()
                .enumerate()
                .max_by(|(_, a), (_, b)| {
                    a.priority
                        .cmp(&b.priority)
                        .then(b.sequence.cmp(&a.sequence))
                })
                .map(|(index, _)| index)
            else {
                break;
            };
            let job = self.queued.remove(index);
            let key = job.key.clone();
            let reserved = job.reserved;
            self.work.started += 1;
            match self.mode {
                Mode::Async => {
                    let pool = AsyncComputeTaskPool::get_or_init(|| {
                        TaskPoolBuilder::new()
                            .num_threads(MAX_RUNNING.max(2))
                            .build()
                    });
                    let task = pool.spawn(async move { finish(job) });
                    self.running.push(Running {
                        key,
                        reserved,
                        task,
                    });
                }
                Mode::Inline => {
                    // 无后台执行器：立即在同一线程完成（确定性回归）。
                    let finished = finish(job);
                    self.absorb(finished);
                }
            }
            self.work.running = self.running.len();
        }
        self.work.queued = self.queued.len();
    }
}

/// 后台执行：只读取不可变快照与产物，不接触 ECS/TLS/Assets。
fn finish(job: Job) -> Finished {
    let started = Instant::now();
    let thread = std::thread::current()
        .name()
        .map(str::to_owned)
        .unwrap_or_else(|| format!("{:?}", std::thread::current().id()));
    let wait_ms = job.queued_at.elapsed().as_secs_f64() * 1000.0;
    let result = prepared::prepare(
        &job.resource,
        job.key.quality,
        job.key.batched,
        job.key.strategy,
        job.key.overview,
    );
    Finished {
        key: job.key,
        reserved: job.reserved,
        thread,
        elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
        wait_ms,
        result,
    }
}
