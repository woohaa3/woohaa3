//! `(canvas_id, renderer_instance)`。换 epoch 时旧脏队列与实体索引作废。
//!
//! generation 只在同一 epoch 内单调增加。每次真实 renderer 启动推进实例号，
//! 不能饱和复用；旧异步结果对不上。

use std::sync::atomic::{AtomicU64, Ordering};

static RENDERER_INSTANCE: AtomicU64 = AtomicU64::new(1);

/// 当前渲染进程的实例号。测试可以构造另一个实例，不必真的重启进程。
pub(crate) fn renderer_instance() -> u64 {
    RENDERER_INSTANCE.load(Ordering::Relaxed)
}

/// 真实 renderer 启动时推进实例号。失败表示计数耗尽，不能饱和复用。
pub(crate) fn begin_renderer_instance() -> u64 {
    advance_instance(&RENDERER_INSTANCE)
}

fn advance_instance(counter: &AtomicU64) -> u64 {
    let previous = counter
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
            value.checked_add(1)
        })
        .expect("renderer instance exhausted");
    previous + 1
}

#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub(crate) struct RendererEpoch {
    pub(crate) canvas_id: String,
    pub(crate) instance: u64,
}

impl RendererEpoch {
    pub(crate) fn current(canvas_id: impl Into<String>) -> Self {
        Self {
            canvas_id: canvas_id.into(),
            instance: renderer_instance(),
        }
    }
}

#[test]
fn renderer_instance_advances_from_seven() {
    let counter = AtomicU64::new(7);
    assert_eq!(advance_instance(&counter), 8);
    assert_eq!(advance_instance(&counter), 9);
}

#[test]
#[should_panic(expected = "renderer instance exhausted")]
fn renderer_instance_exhausted_at_max() {
    let counter = AtomicU64::new(u64::MAX);
    advance_instance(&counter);
}
