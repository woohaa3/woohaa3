//! 2D 画布可丢弃 interaction index 与粗粒度查询
//! （change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm，任务 2.3-2.5 / design D2/D3）。
//!
//! 在 `set_scene` 接受一份合法 `Scene` 的同一调用点构建/替换快照：节点画布几何、端口、
//! 控件矩形与预采样边折线全部由 `curve` / `layout` 的共享纯函数派生，因此绘制与命中共用
//! 同一事实源。快照只含可重建的派生几何，不含命令、Yjs、任务或持久化事实。
//!
//! 查询入口只接收数值坐标、zoom、模式与少量 identity，返回小型语义结果，绝不接收 scene JSON。
//! `unavailable`（尚未接受任何合法场景）与 `stale`（generation 不匹配）是稳定结果，Frontend
//! 不得回退到已删除的 TS 几何实现。

mod observer;
mod positions;
mod results;
mod snapshot;
mod spatial;
pub(crate) use positions::PositionDelta;

use std::cell::{Cell, RefCell};

use bevy::prelude::*;

use crate::protocol::Scene;

pub(crate) use observer::accept_observer;
#[cfg(test)]
pub(crate) use results::PointHit;
pub(crate) use results::{
    DropTargetQueryResult, MarqueeQueryResult, PointQueryResult, ProbeQueryResult,
    ScopeGeometryQueryResult,
};
use snapshot::InteractionSnapshot;

thread_local! {
    /// 最近一次合法场景的 interaction snapshot（latest-wins，仅合法场景替换）。
    static SNAPSHOT: RefCell<Option<InteractionSnapshot>> = const { RefCell::new(None) };
    /// interaction generation 计数器；WASM 重启后从 0 重新开始。
    static GENERATION: Cell<u32> = const { Cell::new(0) };
    /// 最近一次**完整场景**接受的 generation（base 身份）；纯视口增量不改动它
    /// （change: 2026-10-10-optimize-canvas-interaction-hot-path，design D3）。
    static BASE_GENERATION: Cell<u32> = const { Cell::new(0) };
}

/// Seed only a fresh realm, so old query generations cannot match a replacement.
pub(crate) fn seed_generation(previous: u32) {
    if current_generation() == 0 {
        GENERATION.with(|cell| cell.set(previous));
    }
}

/// 接受一份合法场景：原子替换 snapshot 并返回新的 interaction generation。
pub(crate) fn accept_scene(scene: &Scene) -> u32 {
    let generation = GENERATION.with(|cell| {
        let next = cell.get().wrapping_add(1);
        cell.set(next);
        next
    });
    BASE_GENERATION.with(|cell| cell.set(generation));
    let mut snapshot = snapshot::build_snapshot(scene, generation);
    snapshot::apply_selection(&mut snapshot, &scene.selection.nodes);
    SNAPSHOT.with(|slot| *slot.borrow_mut() = Some(snapshot));
    observer::note_accepted_scene(scene);
    generation
}

/// 最近一次完整场景接受的 base generation（供 Frontend/诊断；0 表示尚未接受任何场景）。
pub(crate) fn base_generation() -> u32 {
    BASE_GENERATION.with(Cell::get)
}

/// Internal position accept point. The WASM/render bridge is wired separately
/// so this cannot publish query-only positions through an external capability.
pub(crate) fn accept_positions(
    request: &crate::protocol::PositionUpdateRequest,
) -> Result<(u32, Vec<PositionDelta>), &'static str> {
    request.validate()?;
    let base = base_generation();
    if base == 0 {
        return Err("unavailable");
    }
    if request.base_scene_generation != base {
        return Err("stale-base");
    }
    SNAPSHOT.with(|slot| {
        let mut slot = slot.borrow_mut();
        let snapshot = slot.as_mut().ok_or("unavailable")?;
        if !snapshot.overview {
            return Err("not-overview");
        }
        let plan = positions::plan(snapshot, &request.positions)?;
        // 候选先按基线平移；任一步失败都在改动 snapshot/深度表之前返回，保持原子拒绝。
        let mut models = super::model_pick::plan_positions(&plan.deltas)?;
        // 位置是相对最近完整场景的绝对预览：每次从基线平移根表，再结算逐像素深度
        // （change: 2026-10-27-order-canvas-layers-by-ground-anchor，design D3）。
        crate::depth_order::apply_deltas(
            plan.deltas
                .iter()
                .map(|delta| (delta.id.as_str(), delta.dx, delta.dy)),
        );
        super::model_pick::retune_depth(&mut models);
        // 内部对象候选只在片场聚焦存在，overview 位置增量没有需要同步的交集：
        // 不再平移/维护内部候选或其基线（change: 2026-10-14-scope-film-set-object-picking-to-focus，
        // design D3）。普通模型候选、2D snapshot、viewport 与 generation 仍走原有原子提交。
        let generation = GENERATION.with(|cell| {
            let next = cell.get().wrapping_add(1);
            cell.set(next);
            next
        });
        snapshot.generation = generation;
        let deltas = positions::commit(snapshot, plan);
        if request.viewport.is_some() {
            snapshot::refresh_node_actions(snapshot, request.viewport.as_ref());
        }
        super::model_pick::commit_positions(models, generation, request.viewport.as_ref());
        Ok((generation, deltas))
    })
}

/// 接受一次纯视口增量：复用世界几何，重算屏幕固定横条并推进 query generation。
///
/// 原子拒绝（返回稳定错误字符串）：base 不存在/不匹配、当前非 overview、snapshot 缺失。
/// 拒绝时不改变 snapshot、generation 或 base（change: 2026-10-10-optimize-canvas-interaction-hot-path，
/// design D3）。
pub(crate) fn accept_viewport(
    base: u32,
    viewport: crate::protocol::Viewport,
) -> Result<u32, &'static str> {
    let current_base = BASE_GENERATION.with(Cell::get);
    if current_base == 0 {
        return Err("unavailable");
    }
    if base != current_base {
        return Err("stale-base");
    }
    let overview = SNAPSHOT.with(|slot| {
        slot.borrow()
            .as_ref()
            .is_some_and(|snapshot| snapshot.overview)
    });
    if !overview {
        return Err("not-overview");
    }
    let generation = GENERATION.with(|cell| {
        let next = cell.get().wrapping_add(1);
        cell.set(next);
        next
    });
    // 复用世界几何：仅更新 snapshot 的 query generation（节点/边/order 不变）。
    SNAPSHOT.with(|slot| {
        if let Some(snapshot) = slot.borrow_mut().as_mut() {
            snapshot.generation = generation;
            snapshot::refresh_node_actions(snapshot, Some(&viewport));
        }
    });
    Ok(generation)
}

pub(crate) fn current_generation() -> u32 {
    GENERATION.with(Cell::get)
}

/// 取当前快照；generation 不匹配返回 `stale`，无快照返回 `unavailable`。
fn with_snapshot<T>(expected: u32, f: impl FnOnce(&InteractionSnapshot) -> T) -> Result<T, String> {
    SNAPSHOT.with(|slot| match slot.borrow().as_ref() {
        None => Err("unavailable".to_owned()),
        Some(snapshot) if snapshot.generation != expected => Err("stale".to_owned()),
        Some(snapshot) => Ok(f(snapshot)),
    })
}

/// 点命中查询：单点、zoom 与可选 hovered edge，返回小型语义结果。
pub(crate) fn point_query(
    expected: u32,
    x: f32,
    y: f32,
    zoom: f32,
    hovered_edge: Option<&str>,
) -> PointQueryResult {
    match with_snapshot(expected, |snapshot| {
        snapshot.point_hit(Vec2::new(x, y), zoom, hovered_edge)
    }) {
        Err(reason) => PointQueryResult {
            available: false,
            reason: Some(reason),
            generation: current_generation(),
            hit: None,
        },
        Ok(hit) => PointQueryResult {
            available: true,
            reason: None,
            generation: expected,
            hit,
        },
    }
}

/// 框选查询：矩形（世界坐标，允许负宽高）相交的节点，保持当前发射顺序。
pub(crate) fn marquee_query(
    expected: u32,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
) -> MarqueeQueryResult {
    match with_snapshot(expected, |snapshot| snapshot.marquee(x, y, width, height)) {
        Err(reason) => MarqueeQueryResult {
            available: false,
            reason: Some(reason),
            generation: current_generation(),
            node_ids: Vec::new(),
        },
        Ok(node_ids) => MarqueeQueryResult {
            available: true,
            reason: None,
            generation: expected,
            node_ids,
        },
    }
}

/// drag-touch probe 查询：给定拖动节点与方向，返回该方向的候选连接目标。
pub(crate) fn probe_query(expected: u32, source_id: &str, direction: &str) -> ProbeQueryResult {
    match with_snapshot(expected, |snapshot| snapshot.probe(source_id, direction)) {
        Err(reason) => ProbeQueryResult {
            available: false,
            reason: Some(reason),
            generation: current_generation(),
            candidates: Vec::new(),
        },
        Ok(candidates) => ProbeQueryResult {
            available: true,
            reason: None,
            generation: expected,
            candidates,
        },
    }
}

/// 通用 drop target 查询：按既有顺序固定最上层实际节点（排除来源），只返回 identity。
///
/// 查询不可用/过期时 `available=false`，调用方 MUST NOT 回退 TS 矩形几何或提交移动
/// （change: 2026-10-12-align-film-set-scope-with-isometric-grid，design D5）。
pub(crate) fn drop_target_query(
    expected: u32,
    x: f32,
    y: f32,
    excluded: &[String],
) -> DropTargetQueryResult {
    match with_snapshot(expected, |snapshot| {
        snapshot.drop_target(Vec2::new(x, y), excluded)
    }) {
        Err(reason) => DropTargetQueryResult {
            available: false,
            reason: Some(reason),
            generation: current_generation(),
            target_node_id: None,
        },
        Ok(target_node_id) => DropTargetQueryResult {
            available: true,
            reason: None,
            generation: expected,
            target_node_id,
        },
    }
}

/// 复合资产范围几何读取：返回当前 accepted snapshot 中所有复合资产的轻量几何。
pub(crate) fn scope_geometry_query(expected: u32) -> ScopeGeometryQueryResult {
    match with_snapshot(expected, |snapshot| snapshot.scope_entries()) {
        Err(reason) => ScopeGeometryQueryResult {
            available: false,
            reason: Some(reason),
            generation: current_generation(),
            scopes: Vec::new(),
        },
        Ok(scopes) => ScopeGeometryQueryResult {
            available: true,
            reason: None,
            generation: expected,
            scopes,
        },
    }
}

// ── JSON 边界入口（WASM facade 调用）────────────────────────────────────────

/// 点查询请求（只接收固定大小坐标与 identity，绝不接收 scene）。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PointRequest {
    generation: u32,
    x: f32,
    y: f32,
    zoom: f32,
    #[serde(default)]
    hovered_edge: Option<String>,
}

/// 框选查询请求。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct MarqueeRequest {
    generation: u32,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
}

/// probe 查询请求。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProbeRequest {
    generation: u32,
    source: String,
    direction: String,
}

/// 通用 drop target 查询请求（只传坐标、generation 与来源排除列表）。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DropTargetRequest {
    generation: u32,
    x: f32,
    y: f32,
    #[serde(default)]
    excluded: Vec<String>,
}

/// 复合资产范围几何查询请求。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScopeGeometryRequest {
    generation: u32,
}

fn to_json<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "{}".to_owned())
}

/// JSON 入口：点命中查询；解析失败返回稳定 unavailable 结果。
pub(crate) fn point_query_json(json: &str) -> String {
    let result = match serde_json::from_str::<PointRequest>(json) {
        Ok(request) => point_query(
            request.generation,
            request.x,
            request.y,
            request.zoom,
            request.hovered_edge.as_deref(),
        ),
        Err(_) => PointQueryResult {
            available: false,
            reason: Some("unavailable".to_owned()),
            generation: current_generation(),
            hit: None,
        },
    };
    to_json(&result)
}

/// JSON 入口：框选查询。
pub(crate) fn marquee_query_json(json: &str) -> String {
    let result = match serde_json::from_str::<MarqueeRequest>(json) {
        Ok(request) => marquee_query(
            request.generation,
            request.x,
            request.y,
            request.width,
            request.height,
        ),
        Err(_) => MarqueeQueryResult {
            available: false,
            reason: Some("unavailable".to_owned()),
            generation: current_generation(),
            node_ids: Vec::new(),
        },
    };
    to_json(&result)
}

/// JSON 入口：drag-touch probe 查询。
pub(crate) fn probe_query_json(json: &str) -> String {
    let result = match serde_json::from_str::<ProbeRequest>(json) {
        Ok(request) => probe_query(request.generation, &request.source, &request.direction),
        Err(_) => ProbeQueryResult {
            available: false,
            reason: Some("unavailable".to_owned()),
            generation: current_generation(),
            candidates: Vec::new(),
        },
    };
    to_json(&result)
}

/// JSON 入口：通用 drop target 查询；解析失败返回稳定 unavailable 结果。
pub(crate) fn drop_target_query_json(json: &str) -> String {
    let result = match serde_json::from_str::<DropTargetRequest>(json) {
        Ok(request) => {
            drop_target_query(request.generation, request.x, request.y, &request.excluded)
        }
        Err(_) => DropTargetQueryResult {
            available: false,
            reason: Some("unavailable".to_owned()),
            generation: current_generation(),
            target_node_id: None,
        },
    };
    to_json(&result)
}

/// JSON 入口：复合资产范围几何查询；解析失败返回稳定 unavailable 结果。
pub(crate) fn scope_geometry_query_json(json: &str) -> String {
    let result = match serde_json::from_str::<ScopeGeometryRequest>(json) {
        Ok(request) => scope_geometry_query(request.generation),
        Err(_) => ScopeGeometryQueryResult {
            available: false,
            reason: Some("unavailable".to_owned()),
            generation: current_generation(),
            scopes: Vec::new(),
        },
    };
    to_json(&result)
}

/// 清空快照（测试 / 运行时代际重放前）。generation 继续单调，不重置。
#[cfg(test)]
pub(crate) fn clear_snapshot() {
    SNAPSHOT.with(|slot| *slot.borrow_mut() = None);
}

/// 跨语言 golden：由 nodes JSON 构造最小场景并返回点命中（`kind:nodeId[:side]`）。
///
/// 只用于 `native-renderer` 的集成测试门面；生产命中走 `point_query_json`。
/// `nodes_json` 为 `GraphNode` 数组 JSON。
#[cfg(feature = "native-renderer")]
pub(crate) fn point_hit_golden(
    nodes_json: &str,
    x: f32,
    y: f32,
    zoom: f32,
) -> Result<Option<String>, String> {
    let nodes: Vec<crate::protocol::GraphNode> =
        serde_json::from_str(nodes_json).map_err(|error| error.to_string())?;
    let scene = Scene {
        version: crate::protocol::CANVAS_RENDER_SCENE_VERSION.to_owned(),
        nodes,
        ..Scene::default()
    };
    let generation = accept_scene(&scene);
    let hit = point_query(generation, x, y, zoom, None).hit;
    Ok(hit.map(|hit| match hit {
        results::PointHit::AggregateHandle { direction } => format!("aggregate-handle:{direction}"),
        results::PointHit::Node { node_id } => format!("node:{node_id}"),
        results::PointHit::ModelPreview { node_id } => format!("model-preview:{node_id}"),
        results::PointHit::FilmScope { node_id } => format!("film-scope:{node_id}"),
        results::PointHit::ShotPreview { node_id } => format!("shot-preview:{node_id}"),
        results::PointHit::History { node_id } => format!("history:{node_id}"),
        results::PointHit::Port { node_id, side } => format!("port:{node_id}:{side}"),
        results::PointHit::Resize { node_id, handle } => match handle {
            Some(handle) => format!("resize:{node_id}:{handle}"),
            None => format!("resize:{node_id}"),
        },
        results::PointHit::Edge { edge_id } => format!("edge:{edge_id}"),
        results::PointHit::EdgeDelete { edge_id } => format!("edge-delete:{edge_id}"),
        results::PointHit::NodeAction {
            node_id,
            action_id,
            menu,
        } => format!(
            "node-action:{node_id}:{action_id}{}",
            if menu { ":menu" } else { "" }
        ),
        results::PointHit::SelectionAction { action_id, menu } => format!(
            "selection-action:{action_id}{}",
            if menu { ":menu" } else { "" }
        ),
    }))
}

#[cfg(test)]
mod tests;
