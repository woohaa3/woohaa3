//! 自定形状与形状预设库（U16，change: 2026-10-22-add-photocraft-vector-canvas-tools，
//! design D3/D4）。
//!
//! 三条边界：
//!
//! 1. **库是工具状态，不是文档内容**。选择/保存/重命名/分组/删除预设不进入文档修订、内容
//!    指纹或撤销栈；已经应用的形状是独立几何快照（`shape.presets.place` 生成普通路径形状），
//!    因此删除库项不会改变画面上已有的形状。
//! 2. **原子发布**。恢复快照先在候选列表上完成全部校验与预算核算，成功后整批替换；任何一项
//!    失败都保留现场，不发布半个库。
//! 3. **有界**。预设数、名称长度、节点数与坐标范围都按本域常量裁定，不抬高全局工程预算。
//!
//! 预设数据本身归上游 `Session::presets`（内置组）与 `edit_state.custom_shapes`（
//! Define Custom Shape 结果）；本模块只提供有界的读写入口与身份摘要，不复制第二套库。

use photocraft_doc::vector::Path;
use photocraft_engine::Session;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::error::{EditorError, Result};

/// 一次可保存的自定形状上限（与笔刷库同量级，远小于全局工程预算）。
pub const MAX_CUSTOM_SHAPES: usize = 256;
/// 单条预设名称的最大字符数。
pub const MAX_PRESET_NAME: usize = 200;
/// 一个预设路径的节点总数上限。
pub const MAX_PRESET_KNOTS: usize = 4096;
/// 一个预设的子路径数上限。
pub const MAX_PRESET_SUBPATHS: usize = 256;
/// 快照 JSON 字节上限。
pub const MAX_SNAPSHOT_BYTES: usize = 1 << 20;

fn error(message: impl std::fmt::Display) -> EditorError {
    EditorError::CommandFailed { id: "vector.presets".into(), message: message.to_string() }
}

fn valid_name(name: &str) -> bool {
    let trimmed = name.trim();
    !trimmed.is_empty() && trimmed.chars().count() <= MAX_PRESET_NAME && !name.contains('\0')
}

/// 名称规则（供文案与命令入口共用）：非空、去掉首尾空白后不超限、无控制字符。
pub fn name_allowed(name: &str) -> bool {
    valid_name(name)
}

/// 预设几何是否在本域可保存范围内（与工程核验同一口径）。
pub fn path_within_budget(path: &Path) -> bool {
    if path.subpaths.is_empty() || path.subpaths.len() > MAX_PRESET_SUBPATHS {
        return false;
    }
    let mut knots = 0usize;
    let limit = 8192.0 * 8.0;
    for subpath in &path.subpaths {
        knots += subpath.knots.len();
        if knots > MAX_PRESET_KNOTS {
            return false;
        }
        for knot in &subpath.knots {
            for point in [knot.anchor, knot.in_ctrl, knot.out_ctrl] {
                if !point.x.is_finite() || !point.y.is_finite() || point.x.abs() > limit || point.y.abs() > limit {
                    return false;
                }
            }
        }
    }
    knots > 0
}

/// 预设几何摘要：删除/重载后据此核对已应用形状仍是同一份独立快照。
pub fn path_digest(path: &Path) -> String {
    let mut hash = Sha256::new();
    hash.update(b"photocraft-shape-preset-v1:");
    for subpath in &path.subpaths {
        hash.update([subpath.closed as u8]);
        for knot in &subpath.knots {
            for point in [knot.anchor, knot.in_ctrl, knot.out_ctrl] {
                hash.update(((point.x * 1e4).round() as i64).to_le_bytes());
                hash.update(((point.y * 1e4).round() as i64).to_le_bytes());
            }
            hash.update([knot.smooth as u8]);
        }
    }
    hash.finalize()[..8].iter().map(|byte| format!("{byte:02x}")).collect()
}

/// 库快照（本域唯一持久化形状）：只包含用户可编辑部分与身份摘要。
pub fn snapshot(session: &Session) -> Value {
    let groups = session
        .presets
        .shapes
        .iter()
        .map(|group| {
            json!({
                "name": group.name,
                "shapes": group.items.iter().map(|item| json!({
                    "name": item.name,
                    "digest": path_digest(&item.path),
                    "subpaths": item.path.subpaths.len(),
                })).collect::<Vec<_>>()
            })
        })
        .collect::<Vec<_>>();
    let custom = session
        .edit_state
        .custom_shapes
        .iter()
        .map(|shape| {
            json!({
                "name": shape.name,
                "digest": path_digest(&shape.path),
                "subpaths": shape.path.subpaths.len(),
            })
        })
        .collect::<Vec<_>>();
    json!({
        "groups": groups,
        "custom": custom,
        "revision": session.presets.rev,
    })
}

/// 一次恢复请求里的一条自定形状（前端快照 JSON 的有界形态）。
fn parse_custom(entries: &Value) -> Result<Vec<photocraft_engine::edit_menu_cmds::CustomShape>> {
    let array = entries
        .as_array()
        .ok_or_else(|| error("自定形状快照必须是数组"))?;
    if array.len() > MAX_CUSTOM_SHAPES {
        return Err(error(format!("自定形状超过上限 {MAX_CUSTOM_SHAPES}")));
    }
    let mut out = Vec::with_capacity(array.len());
    let mut seen = std::collections::HashSet::new();
    let mut knots = 0usize;
    for entry in array {
        let name = entry
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| error("自定形状缺少名称"))?;
        if !valid_name(name) || !seen.insert(name.trim().to_string()) {
            return Err(error(format!("自定形状名称重复或非法：{name}")));
        }
        let path = photocraft_engine::vector_cmds::parse_path(
            entry.get("path").ok_or_else(|| error("自定形状缺少路径"))?,
        )
        .map_err(|message| error(format!("自定形状路径非法：{message}")))?;
        if !path_within_budget(&path) {
            return Err(error(format!("自定形状「{name}」几何超出上限")));
        }
        knots += path.subpaths.iter().map(|subpath| subpath.knots.len()).sum::<usize>();
        if knots > MAX_PRESET_KNOTS * 4 {
            return Err(error("自定形状库节点总数超出上限"));
        }
        out.push(photocraft_engine::edit_menu_cmds::CustomShape { name: name.trim().to_string(), path });
    }
    Ok(out)
}

/// 恢复自定形状库：先校验整批，再一次性替换；失败保留原库。
pub fn restore(session: &mut Session, entries: &Value) -> Result<Value> {
    let candidate = parse_custom(entries)?;
    let count = candidate.len();
    session.edit_state.custom_shapes = candidate;
    Ok(json!({ "custom": count }))
}

/// 快照 JSON 字节上限检查（前端恢复前可先用它拒绝超大输入）。
pub fn snapshot_within_budget(bytes: &[u8]) -> bool {
    bytes.len() <= MAX_SNAPSHOT_BYTES
}

/// 从自定形状列表里删除一条（改库不改已应用的形状）。
pub fn delete_custom(session: &mut Session, name: &str) -> Result<Value> {
    let before = session.edit_state.custom_shapes.len();
    session.edit_state.custom_shapes.retain(|shape| shape.name != name);
    if session.edit_state.custom_shapes.len() == before {
        return Err(error(format!("没有名为「{name}」的自定形状")));
    }
    Ok(json!({ "deleted": 1, "custom": session.edit_state.custom_shapes.len() }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use photocraft_engine::Session;

    fn session() -> Session {
        let mut session = Session::new();
        session.execute("file.new", json!({"width": 64, "height": 64, "background": "white"})).unwrap();
        session
    }

    fn square() -> Value {
        json!({"subpaths": [{"closed": true, "knots": [[4, 4], [40, 4], [40, 40], [4, 40]]}]})
    }

    #[test]
    fn custom_shapes_round_trip_through_a_bounded_snapshot() {
        let mut session = session();
        let restored = restore(&mut session, &json!([{ "name": "Box", "path": square() }])).unwrap();
        assert_eq!(restored["custom"], 1);
        assert_eq!(session.edit_state.custom_shapes.len(), 1);
        let snapshot_json = snapshot(&session);
        assert_eq!(snapshot_json["custom"][0]["name"], "Box");
        assert_eq!(snapshot_json["custom"][0]["subpaths"], 1);
        // 内置组始终可见，且不因恢复而被清空。
        assert!(snapshot_json["groups"].as_array().unwrap().len() >= 5);
    }

    #[test]
    fn restore_is_atomic_and_rejects_duplicates_names_and_illegal_geometry() {
        let mut session = session();
        restore(&mut session, &json!([{ "name": "Keep", "path": square() }])).unwrap();
        let cases = [
            json!([{ "name": "A", "path": square() }, { "name": "A", "path": square() }]),
            json!([{ "name": "", "path": square() }]),
            json!([{ "name": "B" }]),
            json!([{ "name": "C", "path": {"subpaths": []} }]),
            json!([{ "name": "D", "path": {"subpaths": [{"knots": [[1e9, 0]]}]} }]),
            json!({ "name": "not-an-array" }),
        ];
        for case in cases {
            assert!(restore(&mut session, &case).is_err(), "{case}");
            assert_eq!(session.edit_state.custom_shapes.len(), 1, "失败保留原库");
            assert_eq!(session.edit_state.custom_shapes[0].name, "Keep");
        }
    }

    #[test]
    fn deleting_a_library_entry_does_not_touch_an_applied_shape() {
        let mut session = session();
        restore(&mut session, &json!([{ "name": "Star", "path": square() }])).unwrap();
        let applied = session
            .execute("shape.presets.place", json!({"preset": "Star", "rect": [8, 8, 32, 32]}))
            .unwrap();
        let layer = applied["layer"].as_u64().unwrap();
        let digest_before = applied["path"].clone();
        delete_custom(&mut session, "Star").unwrap();
        assert!(session.edit_state.custom_shapes.is_empty());
        // 已应用的层仍是独立几何快照。
        let info = session.execute("shape.info", json!({"layer": layer})).unwrap();
        assert_eq!(info["path"], digest_before);
        assert_eq!(&session.execute("shape.info", json!({"layer": layer})).unwrap()["kind"], "path");
        assert!(delete_custom(&mut session, "Star").is_err());
    }

    #[test]
    fn preset_budget_rejects_oversized_libraries() {
        assert!(snapshot_within_budget(&vec![0u8; MAX_SNAPSHOT_BYTES]));
        assert!(!snapshot_within_budget(&vec![0u8; MAX_SNAPSHOT_BYTES + 1]));
        let too_many: Vec<Value> = (0..=MAX_CUSTOM_SHAPES)
            .map(|index| json!({ "name": format!("S{index}"), "path": square() }))
            .collect();
        let mut session = session();
        assert!(restore(&mut session, &Value::Array(too_many)).is_err());
    }
}
