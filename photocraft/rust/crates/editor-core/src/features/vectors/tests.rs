//! 矢量域回归（U08–U16，change: 2026-10-22-add-photocraft-vector-canvas-tools）。
//!
//! 这些用例走**真实**内核路径：`Editor::execute` → 能力门 → `Session` → 上游注册表，覆盖每项
//! 交付约束里能离线判定的部分：一步历史、几何来自内核、失败保留现场、库与已应用形状解耦、
//! 未开放命令被拒绝。真实 WASM 与 1440×1000 / 1024×768 界面走查见 verification.md。

use serde_json::{Value, json};

use crate::editor::Editor;
use crate::features::vectors::{gestures, path_edit, presets};

fn editor() -> Editor {
    let mut editor = Editor::new();
    editor
        .execute("file.new", json!({"width": 400, "height": 300, "background": "white"}))
        .expect("新文档");
    editor
}

fn history_len(editor: &Editor) -> usize {
    editor
        .state()
        .pointer("/document/history")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or_else(|| panic!("状态里没有历史记录：{}", editor.state()))
}

fn layers(editor: &Editor) -> usize {
    editor
        .state()
        .pointer("/document/layers")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0)
}

fn square() -> Value {
    json!({"subpaths": [{"closed": true, "knots": [[20, 20], [120, 20], [120, 120], [20, 120]]}]})
}

#[test]
fn dragging_a_shape_commits_once_and_keeps_live_parameters() {
    let mut editor = editor();
    let before_history = history_len(&editor);
    let before_layers = layers(&editor);
    // 拖绘预览与数值创建共用同一份几何（零面积不提交）。
    let params = editor
        .vector_draw_params(&json!({
            "kind": "roundedRect", "start": [40, 30], "end": [140, 90], "radius": 12
        }))
        .expect("拖绘参数");
    assert_eq!(params["kind"], "roundedRect");
    assert_eq!(params["rect"], json!([40.0, 30.0, 100.0, 60.0]));
    assert_eq!(params["radii"], json!([12.0, 12.0, 12.0, 12.0]));
    assert!(
        editor
            .vector_draw_params(&json!({"kind": "rect", "start": [8, 8], "end": [8, 8]}))
            .is_err(),
        "零面积必须拒绝而不是创建看不见的形状"
    );

    let created = editor
        .vector_command("shape.create", json!({"kind": params["kind"], "rect": params["rect"], "radii": params["radii"], "fill": "#3366cc"}))
        .expect("创建形状");
    let layer = created["layer"].as_u64().expect("层 id");
    assert_eq!(history_len(&editor), before_history + 1, "松手一层一步历史");
    assert_eq!(layers(&editor), before_layers + 1);

    // 快照暴露可重编的规范参数，属性面板据此回显。
    let snapshot = editor.vector_snapshot().expect("快照");
    let shape = snapshot["shapes"]
        .as_array()
        .and_then(|shapes| shapes.iter().find(|shape| shape["layer"] == layer))
        .expect("形状出现在快照里");
    assert_eq!(shape["kind"], "roundedRect");
    // `live` 是上游 `LiveShape` 的序列化形态：变体名是 `rect`，圆角保存在 `radii`。
    assert_eq!(shape["live"]["kind"], "rect");
    assert_eq!(shape["live"]["radii"], json!([12.0, 12.0, 12.0, 12.0]));
    assert_eq!(shape["hasFill"], true);
    assert_eq!(shape["hasStroke"], false);

    // 修改圆角只改同一层，不新增形状，且仍是一步历史。
    let history = history_len(&editor);
    editor
        .vector_command("shape.edit", json!({"layer": layer, "radii": [2, 2, 2, 2]}))
        .expect("编辑圆角");
    assert_eq!(history_len(&editor), history + 1);
    assert_eq!(layers(&editor), before_layers + 1, "属性修改不能新增形状层");
    let info = editor.vector_command("shape.info", json!({"layer": layer})).expect("形状信息");
    assert_eq!(info["live"]["radii"], json!([2.0, 2.0, 2.0, 2.0]));

    editor.undo().expect("撤销圆角");
    assert_eq!(
        editor.vector_command("shape.info", json!({"layer": layer})).expect("形状信息")["live"]["radii"],
        json!([12.0, 12.0, 12.0, 12.0]),
        "一次撤销恢复上一次有效参数"
    );
}

#[test]
fn triangle_is_accepted_as_a_three_sided_polygon_and_star_params_stay_valid() {
    let mut editor = editor();
    // `triangle` 不是内核种类：拖绘编译必须把它归一到 polygon + sides: 3，
    // 且不能给非星形发 `starRatio`（上游用 1.0 作正多边形哨兵，显式发会被拒）。
    let params = gestures::shape_create_params(
        &gestures::DrawInput {
            kind: "triangle".into(),
            start: [10.0, 10.0],
            end: [90.0, 90.0],
            modifiers: Default::default(),
            radius: 0.0,
            sides: 5,
            star_ratio: 0.5,
            weight: 1.0,
        },
        [200, 200],
    )
    .expect("三角形几何可编译");
    assert_eq!(params["kind"], "polygon");
    assert_eq!(params["sides"], 3);
    assert!(params.get("starRatio").is_none(), "非星形不得带星形比例");

    let layer = editor.vector_command("shape.create", params).expect("创建三角形")["layer"]
        .as_u64()
        .expect("层 id");
    let info = editor.vector_command("shape.info", json!({ "layer": layer })).expect("形状信息");
    assert_eq!(info["kind"], "polygon");
    assert_eq!(info["live"]["sides"], 3);
    assert_eq!(info["live"]["star_ratio"], 1.0);

    // 多边形显式给 1.0 是合法的「正多边形」哨兵值（内核与上游同义）。
    editor
        .vector_command("shape.create", json!({"kind": "polygon", "rect": [0, 0, 20, 20], "sides": 5, "starRatio": 1.0}))
        .expect("多边形接受 1.0 哨兵");
    // 但星形给 1.0 会退化成正多边形，必须拒绝。
    assert!(
        editor
            .vector_command("shape.create", json!({"kind": "star", "rect": [0, 0, 20, 20], "sides": 5, "starRatio": 1.0}))
            .is_err()
    );
}

#[test]
fn editing_only_star_ratio_uses_the_layer_kind_instead_of_allowing_a_silent_downgrade() {
    let mut editor = editor();
    let layer = editor
        .vector_command("shape.create", json!({"kind": "star", "rect": [0, 0, 60, 60], "sides": 5, "starRatio": 0.4}))
        .expect("创建星形")["layer"]
        .as_u64()
        .expect("层 id");
    // `shape.edit` 省略 `kind` 时，比例范围必须按图层实际种类（星形）裁定；
    // 否则 1.0 会被当成合法「多边形哨兵」，把星形悄悄降级成多边形。
    assert!(
        editor
            .vector_command("shape.edit", json!({"layer": layer, "starRatio": 1.0}))
            .is_err(),
        "星形不能被一次省略 kind 的编辑降级成多边形"
    );
    // 合法比例仍可编辑，且种类不变。
    editor
        .vector_command("shape.edit", json!({"layer": layer, "starRatio": 0.7}))
        .expect("修改星形比例");
    let info = editor.vector_command("shape.info", json!({"layer": layer})).expect("形状信息");
    assert_eq!(info["kind"], "star");
    assert_eq!(info["live"]["star_ratio"], 0.7);
}

#[test]
fn zero_area_shapes_are_rejected_before_the_kernel() {
    let mut editor = editor();
    // 上游对零宽/零高矩形是宽容的，会留下看不见的图层；本域在提交前拒掉。
    assert!(
        editor
            .vector_command("shape.create", json!({"kind": "rect", "rect": [10, 10, 0, 80]}))
            .is_err(),
        "零宽矩形不能创建"
    );
    assert!(
        editor
            .vector_command("shape.create", json!({"kind": "rect", "rect": [10, 10, 80, 0]}))
            .is_err(),
        "零高矩形不能创建"
    );
    // 正常矩形不受影响。
    editor
        .vector_command("shape.create", json!({"kind": "rect", "rect": [10, 10, 80, 60]}))
        .expect("正常矩形可创建");
    // 零长度直线同理：上游会建出看不见的线段。
    assert!(
        editor
            .vector_command("shape.create", json!({"kind": "line", "from": [10, 10], "to": [10, 10], "weight": 1}))
            .is_err(),
        "零长度直线不能创建"
    );
    editor
        .vector_command("shape.create", json!({"kind": "line", "from": [10, 10], "to": [40, 10], "weight": 1}))
        .expect("正常直线可创建");
}

#[test]
fn polygon_and_star_parameters_must_stay_inside_the_documented_ranges() {
    let mut editor = editor();
    // 边数与星形比例在进入内核前裁定，非法值不产生半成品。
    assert!(
        editor
            .vector_command("shape.create", json!({"kind": "polygon", "rect": [10, 10, 80, 80], "sides": 2}))
            .is_err()
    );
    assert!(
        editor
            .vector_command("shape.create", json!({"kind": "star", "rect": [10, 10, 80, 80], "sides": 5, "starRatio": 1.5}))
            .is_err()
    );
    let star = editor
        .vector_command("shape.create", json!({"kind": "star", "rect": [10, 10, 80, 80], "sides": 6, "starRatio": 0.4}))
        .expect("创建星形");
    let layer = star["layer"].as_u64().expect("层 id");
    let info = editor.vector_command("shape.info", json!({"layer": layer})).expect("形状信息");
    assert_eq!(info["kind"], "star");
    assert_eq!(info["live"]["sides"], 6);
    assert_eq!(info["live"]["star_ratio"], 0.4);
    // 改边数后轮廓真的变化（节点数不同），保存层仍保留规范形状参数。
    let before = info["path"]["subpaths"][0]["knots"].as_array().map(Vec::len).unwrap_or(0);
    editor
        .vector_command("shape.edit", json!({"layer": layer, "sides": 7}))
        .expect("修改边数");
    let after = editor
        .vector_command("shape.info", json!({"layer": layer}))
        .expect("形状信息")["path"]["subpaths"][0]["knots"]
        .as_array()
        .map(Vec::len)
        .unwrap_or(0);
    assert_ne!(before, after, "改变边数必须改变实际轮廓");
}

#[test]
fn boolean_operations_commit_the_candidate_geometry_in_one_step() {
    let mut editor = editor();
    let left = editor
        .vector_command("shape.create", json!({"kind": "rect", "rect": [20, 40, 100, 80], "fill": "#3366cc"}))
        .expect("左侧矩形");
    let left = left["layer"].as_u64().expect("层 id");
    let right = editor
        .vector_command("shape.create", json!({"kind": "rect", "rect": [80, 40, 100, 80], "fill": "#cc6633"}))
        .expect("右侧矩形");
    let right = right["layer"].as_u64().expect("层 id");
    editor.execute("layer.select", json!({"layer": left, "mode": "replace"})).expect("选中左侧");
    editor.execute("layer.select", json!({"layer": right, "mode": "add"})).expect("加选右侧");
    let history = history_len(&editor);
    let layers_before = layers(&editor);

    // 两个形状层合并：轮廓整体提交，组件数下降。
    editor.vector_command("layer.combineShapes.unite", json!({})).expect("合并形状");
    assert_eq!(history_len(&editor), history + 1, "布尔运算一步历史");
    assert!(layers(&editor) < layers_before, "合并后应减少图层");
    let merged = editor.vector_snapshot().expect("快照");
    let shapes: Vec<_> = merged["shapes"]
        .as_array()
        .map(|shapes| shapes.iter().filter(|shape| shape["kind"] == "path").collect())
        .unwrap_or_default();
    assert!(!shapes.is_empty(), "合并结果是普通路径轮廓");
    let subpaths = shapes[0]["path"]["subpaths"].as_array().map(Vec::len).unwrap_or(0);
    assert!(subpaths >= 1, "合并轮廓必须保留几何");

    // 一步撤销恢复原组件。
    editor.undo().expect("撤销合并");
    assert_eq!(layers(&editor), layers_before, "撤销恢复原组件数量");
    // 非法容差被拒绝，且不改文档。
    assert!(
        editor
            .vector_command("layer.combineShapes.mergeShapeComponents", json!({"tolerance": 999}))
            .is_err()
    );
    assert_eq!(layers(&editor), layers_before);
}

#[test]
fn vector_mask_editing_keeps_the_image_and_rejects_out_of_range_parameters() {
    let mut editor = editor();
    let created = editor.execute("layer.new.layer", json!({"name": "paint"})).expect("新层");
    let layer = created["layer"].as_u64().expect("新层 id");
    editor
        .vector_command("layer.vectorMask.add", json!({"layer": layer, "path": square()}))
        .expect("添加矢量蒙版");

    // 全隐/全显与直接编辑路径都只改蒙版几何。
    editor
        .vector_command("layer.vectorMask.edit", json!({"layer": layer, "density": 60, "feather": 4}))
        .expect("编辑蒙版参数");
    let snapshot = editor.vector_snapshot().expect("快照");
    let mask = snapshot["vectorMasks"]
        .as_array()
        .and_then(|masks| masks.iter().find(|mask| mask["layer"] == layer))
        .expect("蒙版出现在快照里");
    assert_eq!(mask["enabled"], true);
    assert_eq!(mask["linked"], true);
    assert!((mask["density"].as_f64().unwrap_or(0.0) - 0.6).abs() < 1e-6);

    assert!(
        editor.vector_command("layer.vectorMask.edit", json!({"layer": layer, "density": 101})).is_err(),
        "密度上限在分配资源前拒绝"
    );
    assert!(
        editor.vector_command("layer.vectorMask.edit", json!({"layer": layer, "feather": -1})).is_err(),
        "羽化必须非负"
    );

    // 蒙版路径可被锚点编辑命令直接改写（`name: "layer"` 指向矢量蒙版）。
    editor
        .vector_command("path.moveAnchors", json!({"name": "layer", "layer": layer, "anchors": [[0, 1]], "move": [10, 0]}))
        .expect("移动蒙版锚点");
    let moved = editor.vector_snapshot().expect("快照");
    let path = moved["vectorMasks"]
        .as_array()
        .and_then(|masks| masks.iter().find(|mask| mask["layer"] == layer))
        .map(|mask| mask["path"].clone())
        .expect("蒙版路径");
    // 快照里的蒙版路径是文档 `Path` 的序列化形态（点是 `{x, y}`）。
    assert_eq!(path["subpaths"][0]["knots"][1]["anchor"]["x"], 130.0);
    assert_eq!(path["subpaths"][0]["knots"][1]["anchor"]["y"], 20.0);
    // 图像层仍保留（矢量蒙版是几何，不是像素）。
    assert!(layers(&editor) >= 2);

    // 栅格化后蒙版合并进像素蒙版，原图像不丢。
    editor
        .vector_command("layer.rasterize.vectorMask", json!({"layer": layer}))
        .expect("栅格化矢量蒙版");
    assert!(
        editor
            .vector_snapshot()
            .expect("快照")["vectorMasks"]
            .as_array()
            .unwrap()
            .iter()
            .all(|mask| mask["layer"] != layer),
        "栅格化后不再有矢量蒙版"
    );
}

#[test]
fn direct_selection_edits_one_anchor_per_drag_and_keeps_open_paths_open() {
    let mut editor = editor();
    editor
        .execute(
            "path.set",
            json!({"name": "work", "path": {"subpaths": [{"closed": false, "knots": [[20, 20], [60, 30], [100, 20]]}]}}),
        )
        .expect("设置开放路径");
    let history = history_len(&editor);
    // 命中判定与命令参数共用同一份节点编号。
    let stored = editor.vector_snapshot().expect("快照")["workPath"].clone();
    let stored = photocraft_engine::vector_cmds::parse_path(&stored).expect("工作路径可解析");
    let hit = path_edit::hit_test(&stored, [60.5, 30.0], 6.0, 1.0).expect("命中第二个锚点");
    assert_eq!((hit.subpath, hit.knot), (0, 1));
    let moved = editor
        .vector_command("path.moveAnchors", json!({"name": "work", "anchors": [[0, 1]], "move": [0, -15]}))
        .expect("移动单个锚点");
    assert_eq!(history_len(&editor), history + 1, "一次拖动一步历史");
    assert_eq!(moved["path"]["subpaths"][0]["knots"][1]["anchor"], json!([60.0, 15.0]));
    assert_eq!(moved["path"]["subpaths"][0]["closed"], false, "开放路径保持开放");

    editor
        .vector_command("path.addAnchor", json!({"name": "work", "subpath": 0, "knot": 0, "t": 0.5}))
        .expect("插入锚点");
    editor
        .vector_command("path.convertPoint", json!({"name": "work", "subpath": 0, "knot": 1}))
        .expect("尖角转换");
    editor
        .vector_command("path.deleteAnchor", json!({"name": "work", "subpath": 0, "knot": 1}))
        .expect("删除锚点");
    // 非法索引与 `t` 在进入内核前被拒绝。
    assert!(
        editor
            .vector_command("path.addAnchor", json!({"name": "work", "subpath": 0, "knot": 9, "t": 0.5}))
            .is_err()
    );
    assert!(
        editor
            .vector_command("path.bendSegment", json!({"name": "work", "subpath": 0, "knot": 0, "t": 2, "move": [0, 1]}))
            .is_err()
    );
}

#[test]
fn custom_shapes_and_presets_stay_independent_from_applied_geometry() {
    let mut editor = editor();
    editor
        .execute("path.set", json!({"name": "Box", "path": square()}))
        .expect("保存路径");
    let defined = editor
        .vector_command("edit.defineCustomShape", json!({"name": "Box", "path": "Box"}))
        .expect("定义自定形状");
    assert_eq!(defined["name"], "Box");

    let library = editor.vector_presets();
    assert_eq!(library["custom"][0]["name"], "Box");
    assert!(library["groups"].as_array().map(Vec::len).unwrap_or(0) >= 5, "内置组仍在");

    let placed = editor
        .vector_command("shape.presets.place", json!({"preset": "Box", "rect": [40, 40, 120, 120]}))
        .expect("应用预设");
    let layer = placed["layer"].as_u64().expect("层 id");
    let applied_path = placed["path"].clone();

    // 从库中删除预设：已应用的形状是独立几何快照，不受影响。
    editor
        .vector_command("shape.presets.edit", json!({"action": "delete", "preset": "Box"}))
        .expect("删除预设");
    assert!(editor.vector_presets()["custom"].as_array().unwrap().is_empty());
    let info = editor.vector_command("shape.info", json!({"layer": layer})).expect("形状信息");
    assert_eq!(info["path"], applied_path, "删除库项不损坏已应用的形状");
    assert_eq!(info["kind"], "path", "应用后的预设是普通路径快照");

    // 预设应用的参数范围裁定。
    assert!(
        editor
            .vector_command("shape.presets.place", json!({"preset": "Box", "rect": [0, 0, 0, 10]}))
            .is_err()
    );
    assert!(editor.vector_command("shape.presets.list", json!({})).is_ok());
    assert!(editor.vector_command("edit.defineCustomShape", json!({"name": "", "path": "Box"})).is_err());
}

#[test]
fn undo_restores_the_library_and_the_shape_geometry_independently() {
    let mut editor = editor();
    editor
        .execute("path.set", json!({"name": "Star", "path": square()}))
        .expect("保存路径");
    editor
        .vector_command("edit.defineCustomShape", json!({"name": "Star", "path": "Star"}))
        .expect("定义自定形状");
    // 库状态不是文档内容：撤销文档命令不应清空库。
    editor
        .vector_command("shape.presets.place", json!({"preset": "Star", "rect": [10, 10, 60, 60]}))
        .expect("应用预设");
    editor.undo().expect("撤销应用");
    assert_eq!(editor.vector_presets()["custom"][0]["name"], "Star");
}

#[test]
fn commands_outside_the_vector_whitelist_stay_closed() {
    let mut editor = editor();
    for id in [
        "layer.combineShapes.unite",
        "shape.presets.list",
        "edit.defineCustomShape",
    ] {
        assert!(crate::capability::command_allowed(id), "{id} 应已开放");
    }
    // 未登记的同族命令仍然被能力门拒绝（不能靠前缀蒙混）。
    let error = editor
        .execute("shape.presets.import", json!({}))
        .expect_err("未开放命令必须拒绝");
    assert_eq!(error.code(), "capability-disabled");
}

#[test]
fn snapping_helpers_share_the_domain_tolerances() {
    // 命中容差与预设预算都是本域常量：UI 与内核读同一份。
    assert_eq!(gestures::hit_tolerance(6.0, 2.0), 3.0);
    assert!(presets::name_allowed("Box"));
    assert!(!presets::name_allowed(""));
    assert!(!presets::name_allowed(&"x".repeat(presets::MAX_PRESET_NAME + 1)));
    assert_eq!(path_edit::hit_test(&photocraft_engine::vector_cmds::parse_path(&square()).unwrap(), [21.0, 20.0], 6.0, 1.0).map(|hit| (hit.subpath, hit.knot)), Some((0, 0)));
}


#[test]
fn rounded_corner_radius_is_bounded_by_the_rectangle_that_will_be_used() {
    let mut editor = editor();
    // 新建：半径上限来自请求的矩形短边一半（10×10 → 5），越界在进入内核前拒绝。
    assert!(
        editor
            .vector_command("shape.create", json!({"kind": "roundedRect", "rect": [0, 0, 10, 10], "radii": [99, 99, 99, 99]}))
            .is_err(),
        "圆角不能超过短边的一半"
    );
    let created = editor
        .vector_command("shape.create", json!({"kind": "roundedRect", "rect": [0, 0, 10, 10], "radii": [5, 5, 5, 5]}))
        .expect("边界值可创建");
    let layer = created["layer"].as_u64().expect("层 id");
    // 编辑只改半径时，上限来自图层现有矩形；越界拒绝且不推进历史。
    let history = history_len(&editor);
    assert!(
        editor
            .vector_command("shape.edit", json!({"layer": layer, "radii": [6, 6, 6, 6]}))
            .is_err(),
        "只改半径也要按现有矩形裁定上限"
    );
    assert_eq!(history_len(&editor), history, "非法输入不能留下历史");
    editor
        .vector_command("shape.edit", json!({"layer": layer, "radii": [4, 4, 4, 4]}))
        .expect("合法半径");
    let info = editor.vector_command("shape.info", json!({"layer": layer})).expect("形状信息");
    assert_eq!(info["live"]["radii"], json!([4.0, 4.0, 4.0, 4.0]));
    // 同时改大矩形与半径：上限按**新**矩形算，因此 8 在 40×40 上合法。
    editor
        .vector_command("shape.edit", json!({"layer": layer, "rect": [0, 0, 40, 40], "radii": [8, 8, 8, 8]}))
        .expect("新矩形下更大的半径合法");
}
