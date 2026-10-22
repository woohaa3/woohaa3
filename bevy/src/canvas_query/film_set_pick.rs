//! 片场内部对象 picking（change: 2026-10-09-add-film-set-object-motion-and-editing，任务 4.1；
//! change: 2026-10-14-scope-film-set-object-picking-to-focus —— 索引收敛到已接受场景的聚焦片场）。
//!
//! 与 [`super::model_pick`] 同源的纯几何：`set_scene` 接受点把**当前聚焦片场**每个对象的
//! 世界 AABB（含组合根 transform）以紧凑列表传入；查询在**聚焦透视相机**下按指针构造世界射线，
//! 按最近可见深度命中，返回稳定 `itemId`。地面等巨大对象仍按 ray 距离参与最近命中，不抢走前方模型。
//!
//! 关键：对象选择只在聚焦（透视）工作区发生，因此射线必须用聚焦相机投影（与
//! `canvas_query::gizmo` 的 `focus_projector` 同源），不能用普通正交画布相机。
//!
//! 作用域（design D1/D2）：接受点先解析目标再发布，本地状态只能是「未接受场景 / 已关闭 /
//! 单一 owner + 候选」；查询的 `nodeId` 必须匹配 accepted owner，跨目标、总览与非片场聚焦一律
//! 不可用。总览位置增量不维护本索引（design D3）。

use serde::Serialize;
use std::cell::{Cell, RefCell};

use super::gizmo::{FocusCamera, focus_ray};

/// 聚焦相机（与 contracts `ModelFocusProjection` 同字段）。
#[derive(Clone, Copy, Debug)]
pub(crate) struct FocusPickCamera {
    pub(crate) target: [f32; 3],
    pub(crate) yaw: f32,
    pub(crate) pitch: f32,
    pub(crate) distance: f32,
}

impl FocusPickCamera {
    fn to_gizmo(self) -> FocusCamera {
        FocusCamera {
            target: self.target,
            yaw: self.yaw,
            pitch: self.pitch,
            distance: self.distance,
        }
    }
}

/// 片场对象候选（world AABB + 稳定 itemId）：附加在所属片场节点下。
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct FilmSetItemCandidate {
    pub(crate) node_id: String,
    pub(crate) item_id: String,
    pub(crate) min: [f32; 3],
    pub(crate) max: [f32; 3],
    pub(crate) unit: f32,
    pub(crate) yaw: f32,
    pub(crate) world_to_local: Option<[f32; 9]>,
    pub(crate) plane_inverse: Option<bevy::math::Affine3A>,
}

/// 内部对象索引的本地作用域（与模型候选同 generation 发布）。
///
/// `accepted` 区分「尚未接受任何合法场景」（新 realm 未就绪）与「已接受但无片场聚焦目标」；
/// 两者对外都是不可用，但前者不会被后续总览清除逻辑误标为已关闭。`owner` 只取最近合法
/// 接受场景的聚焦目标（`modelFocus.nodeId` 指向的复合资产节点）。
#[derive(Default)]
struct ItemIndex {
    accepted: bool,
    owner: Option<String>,
    candidates: Vec<FilmSetItemCandidate>,
}

/// 内部对象准备的实际工作量累计（真实执行边界；见 design D5）。
#[derive(Clone, Copy, Default, Debug, PartialEq, Eq)]
pub(crate) struct FilmSetItemWork {
    /// 实际执行了内部对象准备的聚焦片场次数（清空/无目标不计）。
    pub(crate) builds: u64,
    /// 进入内部对象准备的目标数（0 或 1）。
    pub(crate) targets: u64,
    /// 产出的对象候选数（媒体平面 + 模型对象）。
    pub(crate) candidates: u64,
    /// 为内部候选实际求值的部件包围盒次数。
    pub(crate) part_bounds: u64,
}

thread_local! {
    /// 最近接受场景派生的聚焦片场对象候选；在 `set_scene` 接受点原子替换。
    static INDEX: RefCell<ItemIndex> = const { RefCell::new(ItemIndex { accepted: false, owner: None, candidates: Vec::new() }) };
    /// 累计实际工作量；只增不减，清空索引不重置也不计构建。
    static WORK: Cell<FilmSetItemWork> = const { Cell::new(FilmSetItemWork { builds: 0, targets: 0, candidates: 0, part_bounds: 0 }) };
}

/// 接受点发布内部对象索引：`owner` 为 `None` 即发布关闭状态（总览/非片场聚焦/空目标）。
///
/// `part_bounds_evaluations` 必须来自真实派生（不得为计数额外求值）；无目标时忽略。
pub(crate) fn accept_items(
    owner: Option<String>,
    candidates: Vec<FilmSetItemCandidate>,
    part_bounds_evaluations: u64,
) {
    let has_target = owner.is_some();
    let produced = candidates.len() as u64;
    INDEX.with(|slot| {
        let mut index = slot.borrow_mut();
        index.accepted = true;
        index.owner = owner;
        index.candidates = candidates;
    });
    if has_target {
        WORK.with(|cell| {
            let work = cell.get();
            cell.set(FilmSetItemWork {
                builds: work.builds + 1,
                targets: work.targets + 1,
                candidates: work.candidates + produced,
                part_bounds: work.part_bounds + part_bounds_evaluations,
            });
        });
    }
}

/// 匹配 accepted owner 的候选；未接受场景、已关闭或跨目标返回 `None`。
fn owned_candidates(node_id: &str) -> Option<Vec<FilmSetItemCandidate>> {
    INDEX.with(|slot| {
        let index = slot.borrow();
        if !index.accepted {
            return None;
        }
        let owner = index.owner.as_deref()?;
        (owner == node_id).then(|| index.candidates.clone())
    })
}

/// 清空索引到「尚未接受场景」（测试 / 新实例重放前）。
#[cfg(test)]
pub(crate) fn clear_items() {
    INDEX.with(|slot| *slot.borrow_mut() = ItemIndex::default());
    WORK.with(|cell| cell.set(FilmSetItemWork::default()));
}

/// 当前已接受的原始候选快照（测试：验证位置增量不修改内部候选）。
#[cfg(test)]
pub(crate) fn current_candidates() -> Vec<FilmSetItemCandidate> {
    INDEX.with(|slot| slot.borrow().candidates.clone())
}

/// 当前累计工作量快照（测试 / 诊断）。
pub(crate) fn work() -> FilmSetItemWork {
    WORK.with(Cell::get)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ItemDiagnostics<'a> {
    builds: u64,
    targets: u64,
    candidates_produced: u64,
    part_bounds: u64,
    /// 当前 accepted owner；未接受/已关闭为 null。
    owner: Option<&'a str>,
    /// 当前候选数量快照（与累计量分开）。
    candidate_count: usize,
}

/// 内部对象诊断快照（JSON，供 `canvas_work_diagnostics` 合并；累计量与当前状态分开）。
pub(crate) fn diagnostics_json() -> String {
    let work = work();
    INDEX.with(|slot| {
        let index = slot.borrow();
        serde_json::to_string(&ItemDiagnostics {
            builds: work.builds,
            targets: work.targets,
            candidates_produced: work.candidates,
            part_bounds: work.part_bounds,
            owner: index.accepted.then(|| index.owner.as_deref()).flatten(),
            candidate_count: index.candidates.len(),
        })
        .unwrap_or_else(|_| "{}".to_owned())
    })
}

/// 片场对象 picking（JSON 入口）。
///
/// 请求携带聚焦相机投影（`projection`：target/yaw/pitch/distance）与 surface 尺寸；由 Rust
/// 用与主画面同一透视相机构造指针射线，再对对象 AABB 取最近命中。查询的 `nodeId` 必须等于
/// accepted owner，否则不可用（不返回旧目标数据）。
pub(crate) fn item_pick_query_json(json: &str) -> String {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    #[allow(dead_code)] // width/height 属查询线格式。
    struct Request {
        node_id: String,
        x: f32,
        y: f32,
        width: f32,
        height: f32,
        projection: Projection,
    }
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Projection {
        target: [f32; 3],
        yaw: f32,
        pitch: f32,
        distance: f32,
    }
    let request = match serde_json::from_str::<Request>(json) {
        Ok(request) => request,
        Err(_) => return stale_result("unavailable"),
    };
    // 跨目标/总览/未就绪：不可用，不返回任何旧 itemId。
    let Some(items) = owned_candidates(&request.node_id) else {
        return stale_result("unavailable");
    };
    let camera = FocusPickCamera {
        target: request.projection.target,
        yaw: request.projection.yaw,
        pitch: request.projection.pitch,
        distance: request.projection.distance,
    };
    let (origin, direction) = focus_ray(
        camera.to_gizmo(),
        (request.width, request.height),
        (request.x, request.y),
    );
    let item_id = items
        .iter()
        .filter_map(|item| hit_distance(item, origin, direction).map(|t| (item, t)))
        .min_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(item, _)| item.item_id.clone());
    serde_json::to_string(&FilmSetItemPickResult {
        available: true,
        reason: None,
        node_id: Some(request.node_id),
        item_id,
    })
    .unwrap_or_else(|_| stale_result("unavailable"))
}

fn hit_distance(item: &FilmSetItemCandidate, origin: [f32; 3], direction: [f32; 3]) -> Option<f32> {
    if let Some(inverse) = item.plane_inverse {
        let origin = inverse.transform_point3(bevy::math::Vec3::from_array(origin));
        let direction = inverse.transform_vector3(bevy::math::Vec3::from_array(direction));
        if direction.y.abs() < 1e-7 {
            return None;
        }
        let t = -origin.y / direction.y;
        let hit = origin + direction * t;
        return (t >= 0.0 && hit.x.abs() <= 0.5 && hit.z.abs() <= 0.5).then_some(t);
    }
    super::model_pick::ray_hits_aabb_clipped(origin, direction, item.min, item.max, f32::INFINITY)
}

fn stale_result(reason: &str) -> String {
    serde_json::to_string(&FilmSetItemPickResult {
        available: false,
        reason: Some(reason.to_owned()),
        node_id: None,
        item_id: None,
    })
    .unwrap_or_else(|_| "{}".to_owned())
}

/// 片场对象 picking 结果。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FilmSetItemPickResult {
    pub(crate) available: bool,
    pub(crate) reason: Option<String>,
    pub(crate) node_id: Option<String>,
    pub(crate) item_id: Option<String>,
}

/// 片场对象世界包围盒查询（供对象选中反馈/gizmo 定位）。
///
/// 返回 accepted owner 下每个对象的 `itemId` → 世界中心与包围球半径；跨目标/总览/未就绪返回
/// 不可用且 `items` 为空，前端 facade 沿用 `null`/`[]` 降级。
pub(crate) fn item_bounds_query_json(json: &str) -> String {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Request {
        node_id: String,
    }
    let Ok(request) = serde_json::from_str::<Request>(json) else {
        return unavailable_bounds();
    };
    let Some(items) = owned_candidates(&request.node_id) else {
        return unavailable_bounds();
    };
    let bounds: Vec<ItemBounds> = items
        .iter()
        .map(|candidate| {
            let (center, radius) = super::model_pick::center_radius(candidate.min, candidate.max);
            ItemBounds {
                item_id: candidate.item_id.clone(),
                center,
                radius,
                unit: candidate.unit,
                yaw: candidate.yaw,
                world_to_local: candidate.world_to_local,
            }
        })
        .collect();
    serde_json::to_string(&ItemBoundsResult {
        available: true,
        items: bounds,
    })
    .unwrap_or_else(|_| unavailable_bounds())
}

fn unavailable_bounds() -> String {
    "{\"available\":false,\"items\":[]}".to_owned()
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ItemBounds {
    item_id: String,
    center: [f32; 3],
    radius: f32,
    unit: f32,
    yaw: f32,
    world_to_local: Option<[f32; 9]>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ItemBoundsResult {
    available: bool,
    items: Vec<ItemBounds>,
}

#[cfg(test)]
mod position_tests;

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(node_id: &str, item_id: &str, min: [f32; 3], max: [f32; 3]) -> FilmSetItemCandidate {
        FilmSetItemCandidate {
            node_id: node_id.into(),
            item_id: item_id.into(),
            min,
            max,
            unit: 1.0,
            yaw: 0.0,
            world_to_local: None,
            plane_inverse: None,
        }
    }

    #[test]
    fn rotated_media_quad_uses_exact_surface_and_visible_ray_depth() {
        use bevy::math::{Affine3A, Quat, Vec3};
        let transform = Affine3A::from_scale_rotation_translation(
            Vec3::new(4.0, 1.0, 4.0),
            Quat::from_rotation_z(std::f32::consts::FRAC_PI_4)
                * Quat::from_rotation_x(std::f32::consts::FRAC_PI_2),
            Vec3::new(0.0, 0.0, 2.0),
        );
        let plane = FilmSetItemCandidate {
            node_id: "film".into(),
            item_id: "image".into(),
            min: [-3.0, -3.0, 2.0],
            max: [3.0, 3.0, 2.0],
            unit: 1.0,
            yaw: 0.0,
            world_to_local: None,
            plane_inverse: Some(transform.inverse()),
        };
        assert!(
            (hit_distance(&plane, [0.0, 0.0, 20.0], [0.0, 0.0, -1.0]).unwrap() - 18.0).abs() < 1e-4
        );
        assert!(
            hit_distance(&plane, [2.7, 2.7, 20.0], [0.0, 0.0, -1.0]).is_none(),
            "inside projected AABB but outside rotated quad"
        );
        let mut model = plane.clone();
        model.item_id = "model".into();
        model.plane_inverse = None;
        model.min = [-1.0; 3];
        model.max = [1.0; 3];
        accept_items(Some("film".into()), vec![model, plane], 0);
        let out = item_pick_query_json(
            r#"{"nodeId":"film","x":500,"y":400,"width":1000,"height":800,"projection":{"target":[0,0,0],"yaw":0,"pitch":0,"distance":20}}"#,
        );
        assert!(out.contains("\"itemId\":\"image\""), "{out}");
    }

    #[test]
    fn picks_object_under_pointer_and_filters_node() {
        // 相机看向 -Z；target 在原点，distance=20 → 相机在 (0,0,20)。
        let a = ([-1.0, -1.0, -1.0], [1.0, 1.0, 1.0]);
        let b = ([4.0, -1.0, -1.0], [6.0, 1.0, 1.0]);
        accept_items(
            Some("anim".into()),
            vec![candidate("anim", "a", a.0, a.1), candidate("anim", "b", b.0, b.1)],
            0,
        );
        // 指针在 surface 中心 → 命中原点附近的对象 a（屏幕包围盒包含中心）。
        let center = item_pick_query_json(
            "{\"nodeId\":\"anim\",\"x\":500,\"y\":400,\"width\":1000,\"height\":800,\"projection\":{\"target\":[0,0,0],\"yaw\":0,\"pitch\":0,\"distance\":20}}",
        );
        assert!(center.contains("\"available\":true"));
        assert!(center.contains("\"itemId\":\"a\""));
        // 跨目标过滤：非 accepted owner 一律不可用，不返回旧目标数据。
        let other = item_pick_query_json(
            "{\"nodeId\":\"other\",\"x\":500,\"y\":400,\"width\":1000,\"height\":800,\"projection\":{\"target\":[0,0,0],\"yaw\":0,\"pitch\":0,\"distance\":20}}",
        );
        assert!(other.contains("\"available\":false"), "{other}");
        assert!(other.contains("\"itemId\":null"));
    }

    #[test]
    fn item_bounds_returns_world_center_and_radius() {
        accept_items(
            Some("anim".into()),
            vec![candidate("anim", "a", [-1.0; 3], [1.0; 3])],
            0,
        );
        let out = item_bounds_query_json("{\"nodeId\":\"anim\"}");
        assert!(out.contains("\"available\":true"));
        assert!(out.contains("\"itemId\":\"a\""));
        assert!(out.contains("\"center\":[0.0,0.0,0.0]") || out.contains("\"center\":[0,0,0]"));
    }

    /// 已接受总览/非片场聚焦（关闭状态）与尚未接受场景都不能命中，也不返回 bounds。
    #[test]
    fn closed_and_unaccepted_scope_never_hits() {
        clear_items();
        assert!(item_bounds_query_json("{\"nodeId\":\"film\"}").contains("\"available\":false"));
        assert!(item_pick_query_json(
            "{\"nodeId\":\"film\",\"x\":0,\"y\":0,\"width\":10,\"height\":10,\"projection\":{\"target\":[0,0,0],\"yaw\":0,\"pitch\":0,\"distance\":10}}"
        )
        .contains("\"available\":false"));

        // 已接受场景但无 modelFocus 片场目标 → 关闭；旧候选被清除。
        accept_items(Some("film".into()), vec![candidate("film", "obj", [-1.0; 3], [1.0; 3])], 3);
        assert!(item_bounds_query_json("{\"nodeId\":\"film\"}").contains("\"available\":true"));
        accept_items(None, Vec::new(), 0);
        assert!(item_bounds_query_json("{\"nodeId\":\"film\"}").contains("\"available\":false"));
        assert!(item_pick_query_json(
            "{\"nodeId\":\"film\",\"x\":0,\"y\":0,\"width\":10,\"height\":10,\"projection\":{\"target\":[0,0,0],\"yaw\":0,\"pitch\":0,\"distance\":10}}"
        )
        .contains("\"available\":false"));
    }

    /// 合法空片场：owner 明确、候选为空，查询可用但无命中。
    #[test]
    fn accepted_empty_film_set_is_available_without_hits() {
        accept_items(Some("empty".into()), Vec::new(), 0);
        let bounds = item_bounds_query_json("{\"nodeId\":\"empty\"}");
        assert!(bounds.contains("\"available\":true"), "{bounds}");
        assert!(bounds.contains("\"items\":[]"), "{bounds}");
        let picked = item_pick_query_json(
            "{\"nodeId\":\"empty\",\"x\":5,\"y\":5,\"width\":10,\"height\":10,\"projection\":{\"target\":[0,0,0],\"yaw\":0,\"pitch\":0,\"distance\":10}}",
        );
        assert!(picked.contains("\"available\":true"), "{picked}");
        assert!(picked.contains("\"itemId\":null"), "{picked}");
    }

    /// 清空/无目标不计构建；聚焦只处理一个目标；诊断快照与累计量分开。
    #[test]
    fn work_counters_count_only_real_target_preparation() {
        clear_items();
        // 总览/非片场聚焦：关闭不计构建，但仍更新当前状态快照。
        accept_items(None, Vec::new(), 0);
        assert_eq!(work(), FilmSetItemWork::default());
        // 聚焦一个片场：一次构建、一个目标、两个候选、三次部件求值。
        accept_items(
            Some("film".into()),
            vec![candidate("film", "a", [-1.0; 3], [1.0; 3]), candidate("film", "b", [2.0; 3], [3.0; 3])],
            3,
        );
        assert_eq!(
            work(),
            FilmSetItemWork { builds: 1, targets: 1, candidates: 2, part_bounds: 3 }
        );
        let snapshot = diagnostics_json();
        assert!(snapshot.contains("\"owner\":\"film\""), "{snapshot}");
        assert!(snapshot.contains("\"candidateCount\":2"), "{snapshot}");
        assert!(snapshot.contains("\"candidatesProduced\":2"), "{snapshot}");
        // 退出到总览：清空不计构建，累计量保持不变。
        accept_items(None, Vec::new(), 0);
        assert_eq!(work().builds, 1);
        let snapshot = diagnostics_json();
        assert!(snapshot.contains("\"owner\":null"), "{snapshot}");
        assert!(snapshot.contains("\"candidateCount\":0"), "{snapshot}");
        assert!(snapshot.contains("\"candidatesProduced\":2"), "{snapshot}");
    }
}
