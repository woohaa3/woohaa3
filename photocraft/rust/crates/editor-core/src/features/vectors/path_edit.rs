//! 锚点级路径编辑（U12，change: 2026-10-22-add-photocraft-vector-canvas-tools，design D5）。
//!
//! 上游 `path_edit_cmds` 已经是权威实现：移动锚点/手柄、弯折线段、平滑↔尖角转换、增删锚点，
//! 每条命令一次拖动一步历史，形状层被编辑后会退化为普通路径。本模块只做两件本域必须负责的事：
//!
//! 1. **参数裁定**：节点索引、`t`、位移与手柄坐标在进入内核前就按上游范围校验，避免
//!    「先提交一半再失败」；错误文案统一带命令 id，界面可直接展示。
//! 2. **命中换算**：屏幕阈值除以缩放得到源像素容差，然后在同一份 `Path` 上找最近的锚点或
//!    方向手柄。命中判定与渲染共用内核几何，不在前端另算一套曲线。
//!
//! 命中结果直接对应命令参数（`subpath` / `knot` / `handle`），不引入第三套节点编号。

use photocraft_doc::vector::{Knot, Path};
use serde_json::Value;

use crate::error::{EditorError, Result};

use super::gestures::hit_tolerance;

/// 一次路径编辑可以命中的对象种类。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PathHitKind {
    /// 锚点本身：拖动即 `path.moveAnchors` / `path.convertPoint` 的目标。
    Anchor,
    /// 入向方向手柄：拖动即 `path.moveHandle` 且 `handle: "in"`。
    InHandle,
    /// 出向方向手柄：拖动即 `path.moveHandle` 且 `handle: "out"`。
    OutHandle,
}

/// 命中结果：节点索引 + 种类 + 源坐标距离（供界面决定优先级）。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PathHit {
    pub subpath: usize,
    pub knot: usize,
    pub kind: PathHitKind,
    pub distance: f64,
}

fn error(id: &str, message: impl std::fmt::Display) -> EditorError {
    EditorError::CommandFailed { id: id.into(), message: message.to_string() }
}

fn index(params: &Value, key: &str, id: &str) -> Result<usize> {
    params
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| error(id, format!("缺少 `{key}` 节点索引")))
}

/// 有限坐标或位移（与上游 `path.transform` 同一量级上限）。
fn point(value: &Value, key: &str, id: &str) -> Result<[f64; 2]> {
    let pair = value
        .as_array()
        .filter(|list| list.len() == 2)
        .and_then(|list| Some([list[0].as_f64()?, list[1].as_f64()?]))
        .ok_or_else(|| error(id, format!("`{key}` 必须是 [x, y]")))?;
    if pair.iter().any(|coordinate| !coordinate.is_finite() || coordinate.abs() > 1_000_000.0) {
        return Err(error(id, format!("`{key}` 必须是 ±1000000 内的有限坐标")));
    }
    Ok(pair)
}

/// 参数是否允许进入内核（形状层与文档路径共用同一套范围）。
pub fn validate(id: &str, params: &Value) -> Result<()> {
    match id {
        "path.moveAnchors" => {
            let anchors = params
                .get("anchors")
                .and_then(Value::as_array)
                .filter(|anchors| !anchors.is_empty())
                .ok_or_else(|| error(id, "`anchors` 必须列出 [subpath, knot] 对"))?;
            for anchor in anchors {
                let pair = anchor
                    .as_array()
                    .filter(|pair| pair.len() == 2)
                    .ok_or_else(|| error(id, "每个锚点必须是 [subpath, knot]"))?;
                for value in pair {
                    if value.as_u64().is_none() {
                        return Err(error(id, "锚点索引必须是非负整数"));
                    }
                }
            }
            point(params.get("move").unwrap_or(&Value::Null), "move", id)?;
            optional_bool(params, "curvature", id)?;
        }
        "path.moveHandle" => {
            index(params, "subpath", id)?;
            index(params, "knot", id)?;
            let handle = params.get("handle").and_then(Value::as_str);
            if !matches!(handle, Some("in" | "out")) {
                return Err(error(id, "`handle` 必须是 \"in\" 或 \"out\""));
            }
            point(params.get("to").unwrap_or(&Value::Null), "to", id)?;
            optional_bool(params, "independent", id)?;
        }
        "path.bendSegment" => {
            index(params, "subpath", id)?;
            index(params, "knot", id)?;
            if let Some(t) = params.get("t") {
                let t = t.as_f64().filter(|t| t.is_finite() && (0.0..=1.0).contains(t));
                if t.is_none() {
                    return Err(error(id, "`t` 必须在 0–1 之间"));
                }
            }
            point(params.get("move").unwrap_or(&Value::Null), "move", id)?;
        }
        "path.convertPoint" => {
            index(params, "subpath", id)?;
            index(params, "knot", id)?;
            optional_bool(params, "curvature", id)?;
            if params.get("curvature").and_then(Value::as_bool) != Some(true) && params.get("out").is_some() {
                point(params.get("out").unwrap_or(&Value::Null), "out", id)?;
            }
        }
        "path.addAnchor" => {
            index(params, "subpath", id)?;
            index(params, "knot", id)?;
            if let Some(t) = params.get("t") {
                let t = t.as_f64().filter(|t| t.is_finite() && *t > 0.0 && *t < 1.0);
                if t.is_none() {
                    return Err(error(id, "`t` 必须严格在 0 与 1 之间"));
                }
            }
        }
        "path.deleteAnchor" => {
            index(params, "subpath", id)?;
            index(params, "knot", id)?;
        }
        other => return Err(error("path.edit", format!("{other} 不是已开放的锚点编辑命令"))),
    }
    Ok(())
}

fn optional_bool(params: &Value, key: &str, id: &str) -> Result<()> {
    match params.get(key) {
        Some(value) if !value.is_boolean() => Err(error(id, format!("`{key}` 必须是布尔值"))),
        _ => Ok(()),
    }
}

/// 在源坐标里找最近的锚点或方向手柄。
///
/// 优先级：锚点 > 手柄（同距离时锚点胜出），因为锚点拖动是默认手势；`screen_px` 是屏幕
/// 阈值（通常 6 px），`zoom` 是当前取景缩放，换算后比较源像素距离。
pub fn hit_test(path: &Path, point: [f64; 2], screen_px: f64, zoom: f64) -> Option<PathHit> {
    let tolerance = hit_tolerance(screen_px, zoom);
    let mut best: Option<PathHit> = None;
    for (subpath_index, subpath) in path.subpaths.iter().enumerate() {
        for (knot_index, knot) in subpath.knots.iter().enumerate() {
            consider(&mut best, subpath_index, knot_index, PathHitKind::Anchor, distance(knot.anchor, point), tolerance);
            // 收回的手柄与锚点重合：既不可见也不该被拖到，否则锚点拖动会被手柄抢走。
            if retracted(knot, knot.in_ctrl) {
                consider(&mut best, subpath_index, knot_index, PathHitKind::InHandle, distance(knot.in_ctrl, point), tolerance);
            }
            if retracted(knot, knot.out_ctrl) {
                consider(&mut best, subpath_index, knot_index, PathHitKind::OutHandle, distance(knot.out_ctrl, point), tolerance);
            }
        }
    }
    best
}

/// 手柄是否真的伸出（上游用「控制点 == 锚点」表示收回）。
fn retracted(knot: &Knot, handle: photocraft_geom::Point) -> bool {
    (handle.x - knot.anchor.x).abs() > 1e-9 || (handle.y - knot.anchor.y).abs() > 1e-9
}

fn distance(to: photocraft_geom::Point, point: [f64; 2]) -> f64 {
    (to.x - point[0]).hypot(to.y - point[1])
}

fn consider(best: &mut Option<PathHit>, subpath: usize, knot: usize, kind: PathHitKind, distance: f64, tolerance: f64) {
    if !distance.is_finite() || distance > tolerance {
        return;
    }
    let better = match best {
        None => true,
        Some(current) => match (current.kind == PathHitKind::Anchor, kind == PathHitKind::Anchor) {
            (true, false) => false,
            (false, true) => true,
            _ => distance < current.distance,
        },
    };
    if better {
        *best = Some(PathHit { subpath, knot, kind, distance });
    }
}

/// 命中结果 → `path.moveHandle` 的参数（锚点拖动由 `path.moveAnchors` 处理）。
pub fn handle_params(hit: &PathHit, name: &str, layer: Option<u64>, to: [f64; 2]) -> Option<Value> {
    let handle = match hit.kind {
        PathHitKind::InHandle => "in",
        PathHitKind::OutHandle => "out",
        PathHitKind::Anchor => return None,
    };
    Some(serde_json::json!({
        "name": name,
        "layer": layer,
        "subpath": hit.subpath,
        "knot": hit.knot,
        "handle": handle,
        "to": to,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn path() -> Path {
        photocraft_engine::vector_cmds::parse_path(&json!({
            "subpaths": [{"closed": false, "knots": [
                {"anchor": [10, 10], "out": [30, 10]},
                {"anchor": [50, 40], "in": [40, 30]}
            ]}]
        }))
        .unwrap()
    }

    #[test]
    fn move_anchors_requires_pairs_and_finite_offsets() {
        validate("path.moveAnchors", &json!({"anchors": [[0, 1]], "move": [4, -2]})).unwrap();
        assert!(validate("path.moveAnchors", &json!({"anchors": [], "move": [0, 0]})).is_err());
        assert!(validate("path.moveAnchors", &json!({"anchors": [[0]], "move": [0, 0]})).is_err());
        assert!(validate("path.moveAnchors", &json!({"anchors": [["a", 0]], "move": [0, 0]})).is_err());
        assert!(validate("path.moveAnchors", &json!({"anchors": [[0, 0]], "move": [1e9, 0]})).is_err());
        assert!(validate("path.moveAnchors", &json!({"anchors": [[0, 0]], "move": [1, 0], "curvature": 1})).is_err());
    }

    #[test]
    fn handle_and_point_commands_keep_strict_ranges() {
        validate("path.moveHandle", &json!({"subpath": 0, "knot": 0, "handle": "out", "to": [20, 5]})).unwrap();
        assert!(validate("path.moveHandle", &json!({"subpath": 0, "knot": 0, "handle": "side", "to": [0, 0]})).is_err());
        assert!(validate("path.moveHandle", &json!({"knot": 0, "handle": "in", "to": [0, 0]})).is_err());
        validate("path.bendSegment", &json!({"subpath": 0, "knot": 0, "t": 0.25, "move": [0, 4]})).unwrap();
        assert!(validate("path.bendSegment", &json!({"subpath": 0, "knot": 0, "t": 1.5, "move": [0, 4]})).is_err());
        validate("path.addAnchor", &json!({"subpath": 0, "knot": 0, "t": 0.5})).unwrap();
        assert!(validate("path.addAnchor", &json!({"subpath": 0, "knot": 0, "t": 0.0})).is_err());
        assert!(validate("path.addAnchor", &json!({"subpath": 0, "knot": 0, "t": 1.0})).is_err());
        validate("path.convertPoint", &json!({"subpath": 0, "knot": 1})).unwrap();
        validate("path.convertPoint", &json!({"subpath": 0, "knot": 1, "curvature": true})).unwrap();
        assert!(validate("path.convertPoint", &json!({"subpath": 0, "knot": 1, "out": [1e9, 0]})).is_err());
        validate("path.deleteAnchor", &json!({"subpath": 0, "knot": 1})).unwrap();
        assert!(validate("path.deleteAnchor", &json!({"subpath": 0})).is_err());
        assert!(validate("path.unknown", &json!({})).is_err());
    }

    #[test]
    fn hit_test_prefers_anchors_and_scales_the_screen_threshold() {
        let path = path();
        let hit = hit_test(&path, [11.0, 10.0], 6.0, 1.0).unwrap();
        assert_eq!((hit.subpath, hit.knot, hit.kind), (0, 0, PathHitKind::Anchor));
        // 放大后同样的屏幕阈值对应更小的源容差：3.5 px 外不再命中。
        assert!(hit_test(&path, [13.5, 10.0], 6.0, 4.0).is_none());
        assert!(hit_test(&path, [13.5, 10.0], 6.0, 1.0).is_some());
        // 手柄命中带方向，可直接编译成命令参数。
        let handle = hit_test(&path, [29.0, 11.0], 6.0, 1.0).unwrap();
        assert_eq!(handle.kind, PathHitKind::OutHandle);
        let params = handle_params(&handle, "layer", Some(3), [29.0, 11.0]).unwrap();
        assert_eq!(params["handle"], "out");
        assert_eq!(params["layer"], 3);
        assert!(handle_params(&hit, "work", None, [0.0, 0.0]).is_none());
        // 远处不命中。
        assert!(hit_test(&path, [200.0, 200.0], 6.0, 1.0).is_none());
    }
}
