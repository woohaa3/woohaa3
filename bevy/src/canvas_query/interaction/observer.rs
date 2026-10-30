//! 聚焦观察镜头增量接受点：推进 query generation，不重建世界索引。

use std::cell::RefCell;

use crate::protocol::Scene;

use super::{BASE_GENERATION, GENERATION, SNAPSHOT};

thread_local! {
    static FOCUS_NODE: RefCell<Option<String>> = const { RefCell::new(None) };
}

pub(super) fn note_accepted_scene(scene: &Scene) {
    FOCUS_NODE.with(|slot| {
        *slot.borrow_mut() = scene
            .model_focus
            .as_ref()
            .map(|focus| focus.node_id.clone());
    });
}

/// 接受一次聚焦观察镜头增量。拒绝时不改变 snapshot / generation / base。
pub(crate) fn accept_observer(base: u32, node_id: &str) -> Result<u32, &'static str> {
    let current_base = BASE_GENERATION.with(std::cell::Cell::get);
    if current_base == 0 {
        return Err("unavailable");
    }
    if base != current_base {
        return Err("stale-base");
    }
    let focused = FOCUS_NODE.with(|slot| slot.borrow().as_deref() == Some(node_id));
    if !focused {
        return Err("not-focused");
    }
    let has_snapshot = SNAPSHOT.with(|slot| slot.borrow().is_some());
    if !has_snapshot {
        return Err("unavailable");
    }
    let generation = GENERATION.with(|cell| {
        let next = cell.get().wrapping_add(1);
        cell.set(next);
        next
    });
    SNAPSHOT.with(|slot| {
        if let Some(snapshot) = slot.borrow_mut().as_mut() {
            snapshot.generation = generation;
        }
    });
    Ok(generation)
}
