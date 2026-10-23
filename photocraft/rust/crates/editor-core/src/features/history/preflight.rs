//! 逐步骤能力预检 + 前台队列的进程内存储
//! （change: 2026-10-22-add-photocraft-history-automation-workflows）。
//!
//! ## 为什么预检在域里
//!
//! 动作与脚本都可能是在更早的运行时录制/保存的：某个步骤的命令可能后来被关闭（能力门）或根本
//! 不存在。播放/执行前先一次性核对，能给出「第几步、哪个命令、为什么不可用」，而不是跑到一半
//! 才失败、留下半组结果（spec：「未知 ATN 步骤有报告而非静默跳过」）。
//!
//! ## 为什么队列不在 `Editor` 结构体里
//!
//! `Editor` 的字段属于共享装配文件（`editor.rs`），域不能扩展它。队列因此放在本域自己的
//! 进程内表里，以 `batch_begin` 返回的 id 索引：
//!
//! - wasm 只有一条线程，原生测试各自一条线程，`thread_local` 足够隔离；
//! - id 由进程内计数器分配，多个 `Editor` 不会互相覆盖；
//! - `finish`/`cancel` 会移除条目，未收尾的队列不会无限堆积（同时有数量上限）。
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{Value, json};

use super::automation::BatchQueue;

/// 同时存在的队列上限：超出的 `batch_begin` 被拒绝，而不是悄悄丢弃最旧的（那会丢用户结果）。
pub const MAX_LIVE_QUEUES: usize = 4;

thread_local! {
    static QUEUES: RefCell<HashMap<u64, BatchQueue>> = RefCell::new(HashMap::new());
}

static NEXT_QUEUE: AtomicU64 = AtomicU64::new(1);

/// 存入一个新队列，返回它的 id。
pub fn insert(queue: BatchQueue) -> std::result::Result<u64, String> {
    QUEUES.with(|queues| {
        let mut queues = queues.borrow_mut();
        if queues.len() >= MAX_LIVE_QUEUES {
            return Err(format!("同时最多保留 {MAX_LIVE_QUEUES} 个前台队列，请先完成或取消现有队列"));
        }
        let id = NEXT_QUEUE.fetch_add(1, Ordering::Relaxed);
        queues.insert(id, queue);
        Ok(id)
    })
}

/// 对队列执行一段操作；队列不存在时返回 `None`。
pub fn with<R>(id: u64, run: impl FnOnce(&mut BatchQueue) -> R) -> Option<R> {
    QUEUES.with(|queues| queues.borrow_mut().get_mut(&id).map(run))
}

/// 移除并返回队列。
pub fn take(id: u64) -> Option<BatchQueue> {
    QUEUES.with(|queues| queues.borrow_mut().remove(&id))
}

/// 当前进程/线程里的队列数（测试用）。
pub fn live() -> usize {
    QUEUES.with(|queues| queues.borrow().len())
}

/// 一条预检结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StepReport {
    pub step: usize,
    pub id: String,
    pub playable: bool,
    pub reason: Option<String>,
}

/// 逐步预检：命令是否仍在唯一命令门内、是否存在于运行时注册表。
pub fn preflight(steps: &[(String, Value)]) -> Vec<StepReport> {
    steps
        .iter()
        .enumerate()
        .map(|(step, (id, _))| {
            // 先看注册表（运行时是否认识），再看唯一命令门（当前是否开放）。两者都过了才能
            // 播放：只查能力会漏掉未登记的能力 id，只查注册表会放出被门关掉的命令。
            let reason = if photocraft_engine::commands::find(id).is_none() {
                Some(format!("运行时不认识 `{id}`"))
            } else if crate::capability::command_allowed(id) {
                None
            } else {
                Some(
                    crate::capability::disabled_reason(id)
                        .unwrap_or_else(|| format!("`{id}` 不在已交付命令门内")),
                )
            };
            StepReport { step, id: id.clone(), playable: reason.is_none(), reason }
        })
        .collect()
}

/// 预检并转成 JSON；任何一步不可播放时返回说明（含首个阻塞步骤）而不是执行半组。
pub fn confirm_steps(steps: &[(String, Value)]) -> std::result::Result<Value, String> {
    let reports = preflight(steps);
    let blocked: Vec<&StepReport> = reports.iter().filter(|report| !report.playable).collect();
    if let Some(first) = blocked.first() {
        return Err(format!(
            "第 {} 步 `{}` 不可执行：{}（共 {} 步不可执行）",
            first.step + 1,
            first.id,
            first.reason.as_deref().unwrap_or("未开放"),
            blocked.len()
        ));
    }
    Ok(json!({
        "steps": reports.iter().map(|report| json!({
            "step": report.step,
            "id": report.id,
            "playable": report.playable,
        })).collect::<Vec<_>>(),
        "playable": true,
    }))
}
