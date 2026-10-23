//! 视图导航、参考线与分析辅助的域内回归（U70–U73）。
//!
//! 只验证本域真实语义：视图状态不污染内容身份、参考线/原点/计数/注释走文档历史、
//! 取样点是会话状态、其持久投影随工程保存（不改内容身份）、旋转后源坐标仍可换算、
//! 非法参数拒绝且保留现场。
use serde_json::json;

use crate::editor::Editor;
use crate::features::views::required_capability;
use crate::composition::{GUIDE_COMMANDS, GUIDE_LAYOUT_COMMANDS, VIEW_COMMANDS};

fn editor() -> Editor {
    let mut editor = Editor::new();
    editor.execute("file.new", json!({"width": 120, "height": 90})).unwrap();
    editor.execute("layer.new.layer", json!({"name": "paint"})).unwrap();
    editor
}

fn hash(editor: &Editor) -> String {
    editor.content_hash().unwrap()
}

fn revision(editor: &Editor) -> u64 {
    editor.state()["document"]["revision"].as_u64().unwrap()
}

fn history_len(editor: &Editor) -> usize {
    editor.state()["document"]["history"].as_array().unwrap().len()
}

// ------------------------------------------------------------------ U70 参考线单条编辑

#[test]
fn dragging_a_guide_out_of_the_ruler_adds_a_document_guide_without_touching_pixels() {
    let mut editor = editor();
    let before_hash = hash(&editor);
    editor.guide_command("view.newGuide", json!({"orientation": "vertical", "position": 30})).unwrap();
    editor.guide_command("view.newGuide", json!({"orientation": "horizontal", "position": 12.5})).unwrap();
    let snapshot = editor.view_snapshot().unwrap();
    assert_eq!(snapshot["guides"]["vertical"], json!([30.0]));
    assert_eq!(snapshot["guides"]["horizontal"], json!([12.5]));
    // 参考线是视图字段：内容身份不变，但它是文档数据，所以有历史。
    assert_eq!(hash(&editor), before_hash);
    assert!(history_len(&editor) > 1);
}

#[test]
fn a_single_guide_can_be_moved_edited_and_deleted_by_its_own_index() {
    let mut editor = editor();
    for position in [10, 20, 40] {
        editor.guide_command("view.newGuide", json!({"orientation": "vertical", "position": position})).unwrap();
    }
    editor.guide_command("view.moveGuide", json!({"orientation": "vertical", "index": 1, "position": 25})).unwrap();
    assert_eq!(editor.view_snapshot().unwrap()["guides"]["vertical"], json!([10.0, 25.0, 40.0]));
    // 数值编辑：同一命令改朝向与颜色，保留未给出的字段。
    editor
        .guide_command("view.editGuide", json!({"orientation": "vertical", "index": 0, "position": "50%", "color": "#123456"}))
        .unwrap();
    let snapshot = editor.view_snapshot().unwrap();
    assert_eq!(snapshot["guides"]["vertical"], json!([60.0, 25.0, 40.0]));
    assert_eq!(snapshot["guides"]["colors"][0]["rgb"], json!([18, 52, 86]));
    // 单条删除只去掉那一根；其余保持。
    editor.guide_command("view.deleteGuide", json!({"orientation": "vertical", "index": 1})).unwrap();
    assert_eq!(editor.view_snapshot().unwrap()["guides"]["vertical"], json!([60.0, 40.0]));
    // 清空是显式动作。
    editor.guide_command("view.clearGuides", json!({})).unwrap();
    assert_eq!(editor.view_snapshot().unwrap()["guides"]["vertical"], json!([]));
}

#[test]
fn guide_commands_reject_a_locked_guide_set_and_keep_the_previous_guides() {
    let mut editor = editor();
    editor.guide_command("view.newGuide", json!({"orientation": "vertical", "position": 10})).unwrap();
    editor.set_view_aids(json!({"lockGuides": true})).unwrap();
    let error = editor
        .view_command("view.newGuide", json!({"orientation": "vertical", "position": 20}))
        .expect_err("locked guides must be refused");
    assert!(error.to_string().contains("锁定"), "{error}");
    assert_eq!(editor.view_snapshot().unwrap()["guides"]["vertical"], json!([10.0]));
    // 解锁后恢复可用。
    editor.set_view_aids(json!({"lockGuides": false})).unwrap();
    editor.view_command("view.newGuide", json!({"orientation": "vertical", "position": 20})).unwrap();
    assert_eq!(editor.view_snapshot().unwrap()["guides"]["vertical"], json!([10.0, 20.0]));
}

#[test]
fn an_illegal_guide_index_or_unit_is_refused_and_the_document_survives() {
    let mut editor = editor();
    let before = editor.state();
    let before_hash = hash(&editor);
    assert!(editor.guide_command("view.moveGuide", json!({"orientation": "vertical", "index": 3, "position": 5})).is_err());
    assert!(editor.guide_command("view.newGuide", json!({"orientation": "vertical", "position": "3 apples"})).is_err());
    assert!(editor.guide_command("view.deleteGuide", json!({"orientation": "vertical", "index": 0})).is_err());
    assert_eq!(editor.state(), before);
    assert_eq!(hash(&editor), before_hash);
}

#[test]
fn the_ruler_origin_can_be_dragged_and_reset() {
    let mut editor = editor();
    assert_eq!(editor.view_snapshot().unwrap()["rulerOrigin"], json!([0.0, 0.0]));
    editor.guide_command("view.setRulerOrigin", json!({"x": 24, "y": -8})).unwrap();
    assert_eq!(editor.view_snapshot().unwrap()["rulerOrigin"], json!([24.0, -8.0]));
    editor.guide_command("view.resetRulerOrigin", json!({})).unwrap();
    assert_eq!(editor.view_snapshot().unwrap()["rulerOrigin"], json!([0.0, 0.0]));
    // 越界原点被拒绝，保持上一次成功值。
    editor.guide_command("view.setRulerOrigin", json!({"x": 5, "y": 6})).unwrap();
    assert!(editor.guide_command("view.setRulerOrigin", json!({"x": 1e9, "y": 0})).is_err());
    assert_eq!(editor.view_snapshot().unwrap()["rulerOrigin"], json!([5.0, 6.0]));
}

#[test]
fn cancelling_a_guide_drag_only_restores_the_aid_and_never_dirties_content() {
    let mut editor = editor();
    editor.guide_command("view.newGuide", json!({"orientation": "vertical", "position": 40})).unwrap();
    let hash_after_guide = hash(&editor);
    let revision_after_guide = revision(&editor);
    // 拖动中的中间位置只存在于 UI 草稿；提交前不写内核，因此内容与修订都不动。
    assert_eq!(hash(&editor), hash_after_guide);
    assert_eq!(revision(&editor), revision_after_guide);
    // 取消即丢弃草稿：参考线仍是上一份有效位置。
    assert_eq!(editor.view_snapshot().unwrap()["guides"]["vertical"], json!([40.0]));
}

// ------------------------------------------------------------------ U71 参考线布局与吸附

#[test]
fn guide_layout_generates_the_columns_rows_gutters_and_margins_asked_for() {
    let mut editor = editor();
    editor
        .guide_layout_command(
            "view.newGuideLayout",
            json!({"columns": 2, "gutter": 10, "margin": [5, 10, 5, 10], "clearExisting": true}),
        )
        .unwrap();
    let snapshot = editor.view_snapshot().unwrap();
    // 边距线 + 两列的左右边（120 - 10 - 10 = 100 宽，两列 + 10 间距）。
    // 上游按插入顺序保存参考线（边距线先、列线后），因此比较排序后的位置。
    let mut vertical: Vec<f64> = snapshot["guides"]["vertical"].as_array().unwrap().iter().filter_map(|v| v.as_f64()).collect();
    vertical.sort_by(f64::total_cmp);
    assert_eq!(vertical, vec![10.0, 55.0, 65.0, 110.0]);
    assert_eq!(snapshot["guides"]["horizontal"], json!([5.0, 85.0]));
    let before_hash = hash(&editor);
    let before_revision = revision(&editor);
    // 结果证据：生成线位置正确且不改文档内容。
    assert_eq!(hash(&editor), before_hash);
    assert_eq!(revision(&editor), before_revision);
}

#[test]
fn an_over_dense_layout_is_refused_and_leaves_the_previous_guides() {
    let mut editor = editor();
    editor.guide_layout_command("view.newGuideLayout", json!({"columns": 1})).unwrap();
    let previous = editor.view_snapshot().unwrap()["guides"]["vertical"].clone();
    let error = editor
        .guide_layout_command("view.newGuideLayout", json!({"columns": 200_000}))
        .expect_err("absurd column count must be refused");
    assert!(error.to_string().contains("columns"), "{error}");
    assert_eq!(editor.view_snapshot().unwrap()["guides"]["vertical"], previous);
    // 计数、尺寸与间距放不进边距时也拒绝。
    assert!(editor
        .guide_layout_command("view.newGuideLayout", json!({"columns": 4, "width": 200}))
        .is_err());
}

#[test]
fn guides_from_a_shape_layer_need_an_actual_shape() {
    let mut editor = editor();
    let error = editor
        .guide_layout_command("view.newGuidesFromShape", json!({}))
        .expect_err("a raster layer is not a shape");
    assert!(!error.to_string().is_empty());
    assert_eq!(editor.view_snapshot().unwrap()["guides"]["vertical"], json!([]));
    // 形状图层：三条竖线与三条横线落在形状边界与中线。
    editor
        .vector_command("shape.create", json!({"kind": "rect", "rect": [20, 10, 80, 60], "fill": "#ff0000"}))
        .unwrap();
    editor.guide_layout_command("view.newGuidesFromShape", json!({})).unwrap();
    let snapshot = editor.view_snapshot().unwrap();
    assert_eq!(snapshot["guides"]["vertical"].as_array().unwrap().len(), 3);
    assert_eq!(snapshot["guides"]["horizontal"].as_array().unwrap().len(), 3);
}

#[test]
fn snapping_honours_each_target_family_and_keeps_a_stable_screen_threshold() {
    let mut editor = editor();
    editor.set_view_aids(json!({"guides": true, "snap": {"guides": true, "document": false, "layers": false}})).unwrap();
    editor.guide_command("view.newGuide", json!({"orientation": "vertical", "position": 50})).unwrap();
    // 缩放 1：6 屏幕像素 = 6 源像素。
    let snapped = editor.snap_point(json!({"point": [53.0, 20.0], "zoom": 1, "tolerance": 6})).unwrap();
    assert_eq!(snapped["point"][0], 50.0);
    assert_eq!(snapped["lines"][0]["kind"], "guide");
    assert_eq!(snapped["lines"][0]["smart"], false);
    // 缩放 4：同样的 6 屏幕像素只覆盖 1.5 源像素，53 已超出。
    let missed = editor.snap_point(json!({"point": [53.0, 20.0], "zoom": 4, "tolerance": 6})).unwrap();
    assert_eq!(missed["point"][0], 53.0);
    // 关闭参考线吸附后完全不动。
    editor.set_view_aids(json!({"snap": {"guides": false}})).unwrap();
    let off = editor.snap_point(json!({"point": [51.0, 20.0], "zoom": 1, "tolerance": 6})).unwrap();
    assert_eq!(off["point"][0], 51.0);
    assert!(off["lines"].as_array().unwrap().is_empty());
}

#[test]
fn smart_guides_are_a_separate_switch_from_the_other_snap_targets() {
    let mut editor = editor();
    let document = editor.active_doc().unwrap().doc.clone();
    editor.set_view_aids(json!({"smartGuides": false, "snap": {"document": true, "guides": false, "grid": false, "layers": true}})).unwrap();
    let aids = editor.view_aids();
    assert_eq!(aids["smartGuides"], false);
    // 智能参考线关闭时，图层/中心类目标不再参与吸附，文档边界仍在。
    let snapped = editor.snap_point(json!({"point": [1.0, 1.0], "zoom": 1, "tolerance": 4})).unwrap();
    let kinds: Vec<&str> = snapped["lines"].as_array().unwrap().iter().filter_map(|line| line["kind"].as_str()).collect();
    assert!(!kinds.iter().any(|kind| *kind == "layerEdge" || *kind == "layerCenter" || *kind == "documentCenter"), "{kinds:?}");
    // 内容从未被吸附/视图状态修改。
    assert_eq!(editor.active_doc().unwrap().doc, document);
}

#[test]
fn grid_subdivisions_and_ruler_units_are_bounded_session_preferences() {
    let mut editor = editor();
    editor.set_view_aids(json!({"units": "cm", "gridSubdivisions": 4, "gridStep": [10, 10]})).unwrap();
    let aids = editor.view_aids();
    assert_eq!(aids["units"], "cm");
    assert_eq!(aids["gridSubdivisions"], 4);
    // 非法单位与越界细分被拒绝，保持上一次成功值。
    assert!(editor.set_view_aids(json!({"units": "furlong"})).is_err());
    assert!(editor.set_view_aids(json!({"gridSubdivisions": 0})).is_err());
    assert!(editor.set_view_aids(json!({"gridSubdivisions": 64})).is_err());
    assert_eq!(editor.view_aids()["units"], "cm");
    assert_eq!(editor.view_aids()["gridSubdivisions"], 4);
    // 会话偏好不改内容身份，也不造 dirty。
    let before = hash(&editor);
    assert_eq!(hash(&editor), before);
}

// ------------------------------------------------------------------ U72 旋转视图、导航器与多视图

#[test]
fn rotating_the_view_keeps_source_coordinates_reversible_and_never_rotates_pixels() {
    let mut editor = editor();
    let before_hash = hash(&editor);
    let before_revision = revision(&editor);
    editor.set_view_aids(json!({"rotation": 30, "zoom": 2, "offset": [15, -5]})).unwrap();
    let snapshot = editor.view_snapshot().unwrap();
    assert_eq!(snapshot["rotation"], 30.0);
    assert_eq!(snapshot["transform"]["zoom"], 2.0);
    assert_eq!(snapshot["transform"]["rotation"], 30.0);
    // 投影后的原点与中心也是有限数：落笔/命中都用同一份矩阵。
    let origin = snapshot["projected"]["origin"].as_array().unwrap();
    assert!(origin.iter().all(|value| value.as_f64().unwrap().is_finite()));
    // 图像内容没有旋转，也没有新历史。
    assert_eq!(hash(&editor), before_hash);
    assert_eq!(revision(&editor), before_revision);
    // 复位到 0 度。
    editor.set_view_aids(json!({"rotation": "reset"})).unwrap();
    assert_eq!(editor.view_snapshot().unwrap()["rotation"], 0.0);
}

#[test]
fn an_out_of_range_rotation_is_refused_without_moving_the_view() {
    let mut editor = editor();
    editor.set_view_aids(json!({"rotation": 45})).unwrap();
    assert!(editor.set_view_aids(json!({"rotation": 361})).is_err());
    assert!(editor.set_view_aids(json!({"rotation": "sideways"})).is_err());
    assert!(editor.set_view_aids(json!({"zoom": 0})).is_err());
    assert_eq!(editor.view_snapshot().unwrap()["rotation"], 45.0);
}

#[test]
fn two_views_share_the_document_but_keep_their_own_framing() {
    let mut editor = editor();
    editor.set_view_aids(json!({"zoom": 3, "offset": [40, 0]})).unwrap();
    editor.set_view_aids(json!({"viewAction": "new"})).unwrap();
    let aids = editor.view_aids();
    let views = aids["views"].as_array().unwrap();
    assert_eq!(views.len(), 2);
    assert_eq!(views.iter().filter(|view| view["active"] == true).count(), 1);
    assert_eq!(aids["activeView"], "view-2");
    // 新视图从当前取景开始，之后各自独立。
    assert_eq!(views[1]["zoom"], 3.0);
    editor.set_view_aids(json!({"zoom": 1})).unwrap();
    let aids = editor.view_aids();
    assert_eq!(aids["views"][0]["zoom"], 3.0);
    assert_eq!(aids["views"][1]["zoom"], 1.0);
    // 内容与历史是同一份：两边看到同一个修订和同一个 hash。
    let snapshot = editor.view_snapshot().unwrap();
    assert_eq!(snapshot["scope"]["view"], "session");
    // 切回视图 1 恢复它的取景。
    editor.set_view_aids(json!({"viewAction": "activate", "viewId": "view-1"})).unwrap();
    assert_eq!(editor.view_aids()["activeView"], "view-1");
    assert_eq!(editor.view_aids()["views"][0]["active"], true);
    // 关闭一个视图后至少留一个。
    editor.set_view_aids(json!({"viewAction": "close", "viewId": "view-2"})).unwrap();
    assert_eq!(editor.view_aids()["views"].as_array().unwrap().len(), 1);
    assert!(editor.set_view_aids(json!({"viewAction": "close", "viewId": "view-1"})).is_err());
}

#[test]
fn the_view_count_is_bounded_and_unknown_view_actions_are_refused() {
    let mut editor = editor();
    for _ in 0..3 {
        editor.set_view_aids(json!({"viewAction": "new"})).unwrap();
    }
    assert_eq!(editor.view_aids()["views"].as_array().unwrap().len(), 4);
    let error = editor.set_view_aids(json!({"viewAction": "new"})).expect_err("view cap");
    assert!(error.to_string().contains("最多"), "{error}");
    assert!(editor.set_view_aids(json!({"viewAction": "float"})).is_err());
    assert!(editor.set_view_aids(json!({"viewAction": "activate", "viewId": "view-9"})).is_err());
}

#[test]
fn the_navigator_switch_is_session_state_and_never_touches_the_document() {
    let mut editor = editor();
    let before = editor.state();
    editor.set_view_aids(json!({"navigator": true})).unwrap();
    assert_eq!(editor.view_aids()["navigator"], true);
    assert_eq!(editor.state(), before);
    editor.set_view_aids(json!({"navigator": false})).unwrap();
    assert_eq!(editor.view_aids()["navigator"], false);
}

// ------------------------------------------------------------------ U73 Info、取样、测量、计数与注释

#[test]
fn color_samplers_are_session_state_and_read_real_source_pixels() {
    let mut editor = editor();
    let before_hash = hash(&editor);
    let before_history = history_len(&editor);
    let before_revision = revision(&editor);
    editor.view_command("view.colorSamplers.add", json!({"x": 10, "y": 20})).unwrap();
    editor.view_command("view.colorSamplers.add", json!({"x": 40, "y": 30})).unwrap();
    let list = editor.view_command("view.colorSamplers.list", json!({})).unwrap();
    assert_eq!(list["max"], 10);
    assert_eq!(list["samplers"].as_array().unwrap().len(), 2);
    // 读数来自真实源像素（新建图层的 RGBA 读数）。
    let rgb = list["samplers"][0]["rgb"].as_array().unwrap();
    assert_eq!(rgb.len(), 3);
    assert!(rgb.iter().all(|value| value.as_i64().unwrap() >= 0));
    // 会话状态：不改内容、不加历史；持久投影只在保存时写进工程，所以这里脏标记保持干净。
    assert_eq!(hash(&editor), before_hash);
    assert_eq!(history_len(&editor), before_history);
    assert!(revision(&editor) >= before_revision, "取样点可以递增 view revision，但不能退回");
    // 单点读数与列表第 n 项一致。
    assert_eq!(editor.sampler_readout(1).unwrap(), list["samplers"][1]);
    // 删除与清空。
    editor.view_command("view.colorSamplers.delete", json!({"index": 0})).unwrap();
    let list = editor.view_command("view.colorSamplers.list", json!({})).unwrap();
    assert_eq!(list["samplers"].as_array().unwrap().len(), 1);
    editor.view_command("view.colorSamplers.clear", json!({})).unwrap();
    assert_eq!(
        editor.view_command("view.colorSamplers.list", json!({})).unwrap()["samplers"],
        json!([])
    );
    assert!(editor.sampler_readout(0).is_err());
}

#[test]
fn a_sampler_outside_the_canvas_or_over_the_limit_is_refused() {
    let mut editor = editor();
    assert!(editor.view_command("view.colorSamplers.add", json!({"x": -1, "y": 5})).is_err());
    assert!(editor.view_command("view.colorSamplers.add", json!({"x": 500, "y": 5})).is_err());
    for index in 0..10 {
        editor.view_command("view.colorSamplers.add", json!({"x": index, "y": 5})).unwrap();
    }
    let error = editor
        .view_command("view.colorSamplers.add", json!({"x": 0, "y": 0}))
        .expect_err("11th sampler");
    assert!(error.to_string().contains("10"), "{error}");
}

#[test]
fn the_ruler_measures_in_source_units_and_straighten_uses_the_same_line() {
    let mut editor = editor();
    editor
        .view_command("image.analysis.setMeasurementScale", json!({"preset": "custom", "pixelLength": 10, "logicalLength": 5, "units": "mm"}))
        .unwrap();
    let info = editor
        .view_command("image.analysis.rulerTool", json!({"start": [10, 20], "end": [40, 60]}))
        .unwrap();
    // 50 px 的直线按 10 px = 5 mm 的比例是 25 mm。
    assert_eq!(info["info"]["l1"], 50.0);
    assert_eq!(info["info"]["length"], 25.0);
    assert_eq!(info["info"]["units"], "mm");
    // 相同比例下 45° 的线角度稳定。
    let diagonal = editor
        .view_command("image.analysis.rulerTool", json!({"start": [0, 0], "end": [10, -10]}))
        .unwrap();
    assert_eq!(diagonal["info"]["angle"], 45.0);
    // 测量记录进入会话日志，可读可导出。
    editor.view_command("image.analysis.recordMeasurements", json!({"source": "ruler"})).unwrap();
    let log = editor.view_command("measurementLog.list", json!({})).unwrap();
    assert!(!log["rows"].as_array().unwrap().is_empty());
    let export = editor.view_command("measurementLog.export", json!({})).unwrap();
    assert!(export["csv"].as_str().unwrap().contains('L'));
    // 拉直依赖标尺线；没有标尺时明确失败。
    let mut fresh = self::editor();
    assert!(fresh.view_command("image.analysis.straightenLayer", json!({})).is_err());
}

#[test]
fn measurement_scale_outside_the_supported_range_is_refused() {
    let mut editor = editor();
    assert!(editor
        .view_command("image.analysis.setMeasurementScale", json!({"preset": "custom", "pixelLength": 0, "logicalLength": 5, "units": "mm"}))
        .is_err());
    assert!(editor
        .view_command("image.analysis.setMeasurementScale", json!({"preset": "custom", "pixelLength": 10, "logicalLength": 5, "units": "  "}))
        .is_err());
    assert!(editor
        .view_command("image.analysis.setMeasurementScale", json!({"preset": "average"}))
        .is_err());
    let snapshot = editor.view_snapshot().unwrap();
    assert_eq!(snapshot["measurement"]["scale"]["units"], "pixels");
}

#[test]
fn count_groups_markers_move_and_clear_are_document_data() {
    let mut editor = editor();
    let before_history = history_len(&editor);
    editor.view_command("count.newGroup", json!({"name": "裂缝", "color": "#00ff00"})).unwrap();
    editor.view_command("count.add", json!({"x": 5, "y": 6, "group": 0})).unwrap();
    editor.view_command("count.add", json!({"x": 15, "y": 16, "group": 0})).unwrap();
    editor.view_command("count.move", json!({"index": 0, "group": 0, "to": [7, 8]})).unwrap();
    let snapshot = editor.view_snapshot().unwrap();
    assert_eq!(snapshot["measurement"]["count"]["total"], 2);
    assert_eq!(snapshot["measurement"]["count"]["groups"][0]["name"], "裂缝");
    assert_eq!(snapshot["measurement"]["count"]["groups"][0]["points"][0], json!([7.0, 8.0]));
    // 计数是文档数据：有历史、可撤销，并且随工程保存。
    assert!(history_len(&editor) > before_history);
    editor.undo().unwrap();
    let snapshot = editor.view_snapshot().unwrap();
    assert_eq!(snapshot["measurement"]["count"]["groups"][0]["points"][0], json!([5.0, 6.0]));
    // 删除标记、删组与清空。
    editor.view_command("count.remove", json!({"index": 0, "group": 0})).unwrap();
    assert_eq!(editor.view_snapshot().unwrap()["measurement"]["count"]["total"], 1);
    editor.view_command("count.clear", json!({"group": "all"})).unwrap();
    assert_eq!(editor.view_snapshot().unwrap()["measurement"]["count"]["total"], 0);
    // 分组参数有界：标记大小夹到 1–10，非整数与未知分组拒绝。
    editor.view_command("count.setGroup", json!({"group": 0, "markerSize": 11})).unwrap();
    assert_eq!(editor.view_snapshot().unwrap()["measurement"]["count"]["groups"][0]["markerSize"], 10);
    assert!(editor.view_command("count.setGroup", json!({"group": 0, "markerSize": 2.5})).is_err());
    assert!(editor.view_command("count.setGroup", json!({"group": 7, "name": "x"})).is_err());
    editor.view_command("count.setGroup", json!({"group": 0, "markerSize": 5, "color": "#0000ff"})).unwrap();
    assert_eq!(editor.view_snapshot().unwrap()["measurement"]["count"]["groups"][0]["markerSize"], 5);
    let groups = editor.view_snapshot().unwrap()["measurement"]["count"]["groups"].as_array().unwrap().len();
    editor.view_command("count.deleteGroup", json!({"group": groups.saturating_sub(1)})).unwrap();
    assert!(editor.view_command("count.deleteGroup", json!({"group": 9})).is_err());
}

#[test]
fn notes_round_trip_as_bounded_document_annotations() {
    let mut editor = editor();
    editor
        .view_command("notes.add", json!({"x": 12, "y": 14, "text": "这里补光", "author": "美术"}))
        .unwrap();
    let list = editor.view_command("notes.list", json!({})).unwrap();
    assert_eq!(list["notes"][0]["text"], "这里补光");
    assert_eq!(list["notes"][0]["author"], "美术");
    editor
        .view_command("notes.set", json!({"index": 0, "text": "改成暖光"}))
        .unwrap();
    assert_eq!(editor.view_snapshot().unwrap()["notes"][0]["text"], "改成暖光");
    // 注释不污染像素：仍能撤销回原文本。
    editor.undo().unwrap();
    assert_eq!(editor.view_snapshot().unwrap()["notes"][0]["text"], "这里补光");
    editor.view_command("notes.delete", json!({"index": 0})).unwrap();
    assert_eq!(editor.view_snapshot().unwrap()["notes"], json!([]));
    // 非有限坐标与非法索引拒绝；越界坐标由上游按画布拉伸（与 PSD 导入一致），不静默失败。
    assert!(editor.view_command("notes.add", json!({"x": "left", "y": 0, "text": "坏坐标"})).is_err());
    assert!(editor.view_command("notes.set", json!({"index": 4, "text": "x"})).is_err());
}

#[test]
fn the_domain_gate_refuses_unlisted_commands_instead_of_opening_a_prefix() {
    let mut editor = editor();
    for id in [
        "view.show.grid",
        "view.rotateView",
        "image.analysis.selectDataPoints",
        "image.analysis.placeScaleMarker",
        "count.unknown",
        "notes.import",
    ] {
        let error = editor.view_command(id, json!({})).expect_err(id);
        assert_eq!(error.code(), "capability-disabled", "{id}");
    }
    // 已逐项声明的命令仍然可用。
    assert!(editor.view_command("image.analysis.info", json!({})).is_ok());
}

#[test]
fn a_draft_in_progress_blocks_every_view_command_and_keeps_the_scene() {
    let mut editor = editor();
    editor.guide_command("view.newGuide", json!({"orientation": "vertical", "position": 10})).unwrap();
    let layer = editor.active_layer_id().unwrap();
    editor.begin_layer_properties(layer.0).unwrap();
    editor.preview_layer_properties(json!({"opacity": 0.5})).unwrap();
    let before = editor.view_snapshot().unwrap();
    let error = editor.view_command("notes.add", json!({"x": 1, "y": 1, "text": "no"})).expect_err("draft gate");
    assert!(!error.to_string().is_empty());
    assert!(editor.view_command("count.add", json!({"x": 1, "y": 1})).is_err());
    assert_eq!(editor.view_snapshot().unwrap()["notes"], json!([]));
    assert_eq!(editor.view_snapshot().unwrap()["guides"], before["guides"]);
    editor.cancel_layer_properties();
    editor.view_command("notes.add", json!({"x": 1, "y": 1, "text": "ok"})).unwrap();
    assert_eq!(editor.view_snapshot().unwrap()["notes"].as_array().unwrap().len(), 1);
}

#[test]
fn view_snapshot_declares_which_data_is_persistent_and_which_is_session_only() {
    let editor = editor();
    let snapshot = editor.view_snapshot().unwrap();
    assert_eq!(snapshot["scope"]["view"], "session");
    assert_eq!(snapshot["scope"]["samplers"], "session+project");
    assert_eq!(snapshot["scope"]["guides"], "document");
    assert_eq!(snapshot["scope"]["count"], "document");
    assert_eq!(snapshot["scope"]["notes"], "document");
    assert_eq!(snapshot["documentSize"], json!([120.0, 90.0]));
    assert_eq!(snapshot["units"], "px");
}

#[test]
fn view_commands_need_a_document_and_do_not_leave_a_half_written_state() {
    let mut editor = Editor::new();
    assert!(editor.view_command("notes.add", json!({"x": 0, "y": 0, "text": "a"})).is_err());
    assert!(editor.guide_layout_command("view.newGuideLayout", json!({"columns": 1})).is_err());
    assert!(editor.view_snapshot().is_err());
    // 无文档时视图辅助仍可读写：它是工作区偏好。
    assert!(editor.set_view_aids(json!({"rulers": true})).is_ok());
    assert_eq!(editor.view_aids()["rulers"], true);
}

#[test]
fn length_formatting_follows_the_selected_unit_without_touching_the_document() {
    let editor = editor();
    let before = hash(&editor);
    // 120 px 宽、72 dpi 的文档：1 in = 72 px。
    assert_eq!(crate::composition::format_length(72.0, "in", 72.0, 120.0).as_deref(), Some("1 in"));
    assert_eq!(crate::composition::format_length(120.0, "%", 72.0, 120.0).as_deref(), Some("100 %"));
    assert_eq!(crate::composition::format_length(72.0, "mm", 72.0, 120.0).as_deref(), Some("25.4 mm"));
    assert_eq!(crate::composition::format_length(10.4, "px", 72.0, 120.0).as_deref(), Some("10 px"));
    assert!(crate::composition::format_length(10.0, "furlong", 72.0, 120.0).is_none());
    assert!(crate::composition::format_length(f64::NAN, "px", 72.0, 120.0).is_none());
    assert_eq!(hash(&editor), before);
}

#[test]
fn every_declared_view_command_is_a_real_upstream_command() {
    for id in crate::composition::VIEW_COMMANDS {
        assert!(
            photocraft_engine::commands::find(id).is_some(),
            "声明的视图命令在上游注册表中不存在：{id}"
        );
    }
    assert!(crate::composition::is_view_command("notes.add"));
    assert!(!crate::composition::is_view_command("view.rotateView"));
    let groups = crate::composition::command_groups();
    assert_eq!(groups["U70"].as_array().unwrap().len(), 7);
    assert_eq!(groups["U71"].as_array().unwrap().len(), 3);
}

#[test]
fn guides_ruler_origin_count_notes_and_measurement_scale_survive_a_project_round_trip() {
    let mut editor = editor();
    editor.guide_command("view.newGuide", json!({"orientation": "vertical", "position": 33})).unwrap();
    editor.guide_command("view.setRulerOrigin", json!({"x": 4, "y": 6})).unwrap();
    editor.view_command("count.newGroup", json!({"name": "瑕疵"})).unwrap();
    editor.view_command("count.add", json!({"x": 3, "y": 4, "group": 0})).unwrap();
    editor.view_command("notes.add", json!({"x": 10, "y": 20, "text": "保留"})).unwrap();
    editor
        .view_command("image.analysis.setMeasurementScale", json!({"preset": "custom", "pixelLength": 2, "logicalLength": 1, "units": "cm"}))
        .unwrap();
    let bytes = editor.save_project().unwrap();

    let mut reopened = Editor::new();
    reopened.open_project(&bytes, None).unwrap();
    let snapshot = reopened.view_snapshot().unwrap();
    assert_eq!(snapshot["guides"]["vertical"], json!([33.0]));
    assert_eq!(snapshot["rulerOrigin"], json!([4.0, 6.0]));
    assert_eq!(snapshot["measurement"]["count"]["groups"][0]["name"], "瑕疵");
    assert_eq!(snapshot["measurement"]["count"]["groups"][0]["count"], 1);
    assert_eq!(snapshot["notes"][0]["text"], "保留");
    assert_eq!(snapshot["measurement"]["scale"]["units"], "cm");
    // 会话数据不随工程保存：取样点与旋转/多视图重新开始。
    assert_eq!(snapshot["samplers"], json!([]));
    assert_eq!(snapshot["rotation"], 0.0);
    assert_eq!(reopened.view_aids()["views"].as_array().unwrap().len(), 1);
}

#[test]
fn saved_view_data_changes_no_pixels_and_keeps_the_same_document_hash() {
    let mut editor = editor();
    let before = hash(&editor);
    let before_revision = revision(&editor);
    editor.guide_command("view.newGuide", json!({"orientation": "vertical", "position": 40})).unwrap();
    editor.guide_command("view.setRulerOrigin", json!({"x": 1, "y": 2})).unwrap();
    editor.view_command("notes.add", json!({"x": 5, "y": 5, "text": "说明"})).unwrap();
    editor.view_command("count.add", json!({"x": 5, "y": 5})).unwrap();
    // 这些是文档视图/注释数据：有修订与历史，但不含像素，内容指纹只由图层与画布决定。
    assert_eq!(hash(&editor), before);
    assert!(revision(&editor) > before_revision);
    let preview = editor.render_preview(32).unwrap();
    let saved = editor.save_project().unwrap();
    let mut reopened = Editor::new();
    reopened.open_project(&saved, None).unwrap();
    assert_eq!(reopened.content_hash().unwrap(), before);
    let again = reopened.render_preview(32).unwrap();
    assert_eq!(preview.pixels, again.pixels);
}

// ------------------------------------------------------------------ U70/U72 画布指针几何

#[test]
fn guide_hits_are_resolved_in_source_coordinates_after_rotation() {
    let mut editor = editor();
    editor.guide_command("view.newGuide", json!({"orientation": "vertical", "position": 100})).unwrap();
    editor.guide_command("view.newGuide", json!({"orientation": "horizontal", "position": 50})).unwrap();
    // 文档 120×90：源 x=100 → 客户 x=100；容差 6 屏幕像素 = 6 源像素。
    let hit = editor.view_pointer("hit-guide", json!({"client": [104, 10], "tolerance": 6})).unwrap();
    assert_eq!(hit["hit"]["vertical"], true);
    assert_eq!(hit["hit"]["index"], 0);
    assert_eq!(hit["hit"]["position"], 100.0);
    assert_eq!(hit["hit"]["distance"], 4.0);
    // 超出容差不命中，且没有回报任何鬼影。
    let miss = editor.view_pointer("hit-guide", json!({"client": [120, 10], "tolerance": 6})).unwrap();
    assert!(miss["hit"].is_null());

    // 旋转 90° 后判定仍按源坐标：源 (100, 20) 的客户位置必须命中同一条竖线。
    editor.set_view_aids(json!({"rotation": 90})).unwrap();
    let snapshot = editor.view_snapshot().unwrap();
    let transform = &snapshot["transform"];
    assert_eq!(transform["rotation"], 90.0);
    // 文档 120×90、中心 (60,45)：源 (100,20) → 客户 (85,85)，仍命中源 x=100 的竖线。
    let rotated = editor.view_pointer("hit-guide", json!({"client": [85, 85], "tolerance": 6})).unwrap();
    assert_eq!(rotated["hit"]["vertical"], true);
    assert_eq!(rotated["hit"]["position"], 100.0);
    // 未命中源坐标的同一屏幕位置在 0° 下也不该算命中，证明换算真的用了旋转。
    editor.set_view_aids(json!({"rotation": 0})).unwrap();
    let unrotated = editor.view_pointer("hit-guide", json!({"client": [85, 85], "tolerance": 6})).unwrap();
    assert!(unrotated["hit"].is_null());
}

#[test]
fn guide_hits_respect_the_lock_and_scale_with_zoom() {
    let mut editor = editor();
    editor.guide_command("view.newGuide", json!({"orientation": "vertical", "position": 100})).unwrap();
    editor.set_view_aids(json!({"lockGuides": true})).unwrap();
    let hit = editor.view_pointer("hit-guide", json!({"client": [100, 10]})).unwrap();
    // 命中本身仍然给出（界面需要画禁止光标），但明确标注已锁定。
    assert_eq!(hit["locked"], true);
    assert_eq!(hit["hit"]["vertical"], true);
    editor.set_view_aids(json!({"lockGuides": false})).unwrap();

    // 缩放 4 倍：6 屏幕像素只等于 1.5 源像素，因此 4 源像素的偏差不再命中。
    editor.set_view_aids(json!({"zoom": 4})).unwrap();
    let transform = editor.view_snapshot().unwrap()["transform"].clone();
    assert_eq!(transform["zoom"], 4.0);
    // 源 x=100 → 客户 x=400；偏 16 客户像素 = 4 源像素 > 1.5。
    let far = editor.view_pointer("hit-guide", json!({"client": [416, 40], "tolerance": 6})).unwrap();
    assert!(far["hit"].is_null());
    let near = editor.view_pointer("hit-guide", json!({"client": [404, 40], "tolerance": 6})).unwrap();
    assert_eq!(near["hit"]["position"], 100.0);
}

#[test]
fn guide_drags_stay_inside_the_canvas_and_round_to_two_decimals() {
    let mut editor = editor();
    let dragged = editor.view_pointer("drag-guide", json!({"client": [12.3456, 20], "vertical": true})).unwrap();
    assert_eq!(dragged["position"], 12.35);
    let clamped = editor.view_pointer("drag-guide", json!({"client": [-40, 20], "vertical": true})).unwrap();
    assert_eq!(clamped["position"], 0.0);
    let bottom = editor.view_pointer("drag-guide", json!({"client": [10, 999], "vertical": false})).unwrap();
    assert_eq!(bottom["position"], 90.0);
    // 拖动不写文档：仍没有参考线，也没有历史。
    assert_eq!(editor.view_snapshot().unwrap()["guides"]["vertical"], json!([]));
}

#[test]
fn the_ruler_origin_drag_uses_the_same_inverse_transform() {
    let mut editor = editor();
    let origin = editor.view_pointer("drag-origin", json!({"client": [30, 40]})).unwrap();
    assert_eq!(origin["origin"], json!([30.0, 40.0]));
    assert_eq!(origin["current"], json!([0.0, 0.0]));
    // 拖动只给候选位置；提交仍要显式走 setRulerOrigin。
    editor.guide_command("view.setRulerOrigin", json!({"x": 30, "y": 40})).unwrap();
    let after = editor.view_pointer("drag-origin", json!({"client": [30, 40]})).unwrap();
    assert_eq!(after["current"], json!([30.0, 40.0]));
    // 旋转后同一个客户点落在不同源坐标，说明换算没有写死 0°。
    // 文档 120×90、中心 (60,45)：客户 (30,40) 在 90° 下对应源 (55,75)。
    editor.set_view_aids(json!({"rotation": 90})).unwrap();
    let rotated = editor.view_pointer("drag-origin", json!({"client": [30, 40]})).unwrap();
    assert_eq!(rotated["origin"], json!([55.0, 75.0]));
}

#[test]
fn pointer_actions_are_allowlisted_and_need_a_document() {
    let mut editor = editor();
    assert!(editor.view_pointer("hit-guide", json!({"client": [f64::NAN, 0]})).is_err());
    assert!(editor.view_pointer("hit-guide", json!({"client": [0]})).is_err());
    assert!(editor.view_pointer("select-everything", json!({"client": [0, 0]})).is_err());
    // 空会话：指针动作与视图命令一样拒绝，而不是造一个空文档。
    let mut empty = Editor::new();
    assert!(empty.view_pointer("hit-guide", json!({"client": [0, 0]})).is_err());
    assert!(empty.view_snapshot().is_err());
    assert!(editor.view_snapshot().is_ok());
}

#[test]
fn reads_stay_available_while_a_draft_is_open_but_writes_do_not() {
    let mut editor = editor();
    editor.view_command("notes.add", json!({"x": 1, "y": 1, "text": "已有"})).unwrap();
    let layer = editor.active_layer_id().unwrap();
    editor.begin_layer_properties(layer.0).unwrap();
    editor.preview_layer_properties(json!({"opacity": 0.5})).unwrap();
    // 只读读数在草稿期间仍可用：Info/日志/注释列表不该等手指抬起才刷新。
    assert!(editor.view_command("notes.list", json!({})).is_ok());
    assert!(editor.view_command("measurementLog.list", json!({})).is_ok());
    assert!(editor.view_command("view.colorSamplers.list", json!({})).is_ok());
    assert!(editor.view_command("image.analysis.info", json!({})).is_ok());
    // 写入仍被草稿门禁挡住，并且不落进文档。
    assert!(editor.view_command("notes.delete", json!({"index": 0})).is_err());
    assert!(editor.guide_command("view.newGuide", json!({"orientation": "vertical", "position": 5})).is_err());
    editor.cancel_layer_properties();
    assert_eq!(editor.view_snapshot().unwrap()["notes"].as_array().unwrap().len(), 1);
    // 未知 id 无论文档状态如何都按能力关闭拒绝。
    let unknown = editor.view_command("count.unknown", json!({})).expect_err("allowlist");
    assert!(unknown.to_string().contains("count.unknown") || !unknown.to_string().is_empty());
}

#[test]
fn the_dedicated_guide_entry_enforces_the_same_lock_and_allowlist() {
    let mut editor = editor();
    editor.guide_command("view.newGuide", json!({"orientation": "vertical", "position": 20})).unwrap();
    editor.set_view_aids(json!({"lockGuides": true})).unwrap();
    // 逐条编辑入口（面板用的就是它）也必须尊重锁定。
    assert!(editor.guide_command("view.moveGuide", json!({"orientation": "vertical", "index": 0, "position": 60})).is_err());
    assert!(editor.guide_command("view.deleteGuide", json!({"orientation": "vertical", "index": 0})).is_err());
    assert_eq!(editor.view_snapshot().unwrap()["guides"]["vertical"], json!([20.0]));
    // 「清除」是解锁之外的例外，仍允许（用户明确要移除全部参考线）。
    editor.guide_command("view.clearGuides", json!({})).unwrap();
    assert_eq!(editor.view_snapshot().unwrap()["guides"]["vertical"], json!([]));
    // 未声明的 id 不会被这条入口转给上游。
    assert!(editor.guide_command("view.newGuideLayout", json!({"columns": 2})).is_err());
}

#[test]
fn a_locked_guide_set_still_allows_moving_the_ruler_origin() {
    let mut editor = editor();
    editor.guide_command("view.newGuide", json!({"orientation": "vertical", "position": 20})).unwrap();
    editor.set_view_aids(json!({"lockGuides": true})).unwrap();
    // 锁定的是参考线位置；标尺原点是另一个字段，仍可拖动到别处。
    editor.guide_command("view.setRulerOrigin", json!({"x": 5, "y": 6})).unwrap();
    assert_eq!(editor.view_snapshot().unwrap()["rulerOrigin"], json!([5.0, 6.0]));
    editor.guide_command("view.resetRulerOrigin", json!({})).unwrap();
    assert_eq!(editor.view_snapshot().unwrap()["rulerOrigin"], json!([0.0, 0.0]));
    // 参考线本身仍然不可动。
    assert_eq!(editor.view_snapshot().unwrap()["guides"]["vertical"], json!([20.0]));
}

// ------------------------------------------------------------------ U73/3.2 跨格式：PSD 能带走什么

#[test]
fn psd_carries_guides_notes_and_scale_but_not_the_ruler_origin_or_counts() {
    let mut editor = editor();
    editor.guide_command("view.newGuide", json!({"orientation": "vertical", "position": 27})).unwrap();
    editor.guide_command("view.newGuide", json!({"orientation": "horizontal", "position": 13})).unwrap();
    editor.guide_command("view.setRulerOrigin", json!({"x": 4, "y": 6})).unwrap();
    editor
        .view_command("image.analysis.setMeasurementScale", json!({"preset": "custom", "pixelLength": 10, "logicalLength": 5, "units": "mm"}))
        .unwrap();
    editor.view_command("count.add", json!({"x": 5, "y": 5})).unwrap();
    editor.view_command("notes.add", json!({"x": 6, "y": 7, "text": "补光"})).unwrap();
    let preview = editor.render_preview(32).unwrap().pixels;

    let (bytes, report) = editor.export_psd(json!({"rasterizeLossy": true})).unwrap();
    // 导出报告必须给出逐层结论，不能静默压平。
    assert!(report.get("lossy").is_some(), "导出报告要说明损失");

    let mut reopened = Editor::new();
    reopened.import_psd_project(&bytes, false).unwrap();
    let snapshot = reopened.view_snapshot().unwrap();
    // 上游 PSD 通道真实支持的字段：grid-and-guides(1032)、Anno 注释、测量比例(1074)。
    assert_eq!(snapshot["guides"]["vertical"], json!([27.0]));
    assert_eq!(snapshot["guides"]["horizontal"], json!([13.0]));
    assert_eq!(snapshot["notes"][0]["text"], json!("补光"));
    assert_eq!(snapshot["measurement"]["scale"]["units"], json!("mm"));
    // 像素逐字节相同：PSD 往返不重采样。
    assert_eq!(reopened.render_preview(32).unwrap().pixels, preview);
    // PSD 没有对应通道的字段：标尺原点与计数标记不会凭空恢复。界面据此提示改用 .pcraft，
    // 而不是让用户以为保存过。
    assert_eq!(snapshot["rulerOrigin"], json!([0.0, 0.0]));
    assert_eq!(snapshot["measurement"]["count"]["total"], json!(0));
}

#[test]
fn switching_documents_switches_the_view_data_without_leaking_it() {
    let mut first = editor();
    first.guide_command("view.newGuide", json!({"orientation": "vertical", "position": 27})).unwrap();
    first.view_command("count.add", json!({"x": 5, "y": 5})).unwrap();
    first.view_command("notes.add", json!({"x": 6, "y": 7, "text": "第一份"})).unwrap();
    first.view_command("view.colorSamplers.add", json!({"x": 3, "y": 3})).unwrap();
    let first_bytes = first.save_project().unwrap();

    let mut editor = editor();
    editor.open_project(&first_bytes, None).unwrap();
    assert_eq!(editor.view_snapshot().unwrap()["guides"]["vertical"], json!([27.0]));

    // 打开另一份空白文档：文档级视图数据跟着文档走，不继承上一份。
    let blank = {
        let mut blank = Editor::new();
        blank.execute("file.new", json!({"width": 64, "height": 48})).unwrap();
        blank.execute("layer.new.layer", json!({"name": "paint"})).unwrap();
        blank.save_project().unwrap()
    };
    editor.open_project(&blank, None).unwrap();
    let snapshot = editor.view_snapshot().unwrap();
    assert_eq!(snapshot["guides"]["vertical"], json!([]));
    assert_eq!(snapshot["measurement"]["count"]["total"], json!(0));
    assert_eq!(snapshot["notes"], json!([]));
    // 取样点是会话数据但属于各自文档：另一份文档没有上一份的取样点。
    assert_eq!(snapshot["samplers"], json!([]));

    // 会话取景（旋转/单位）是工作区偏好：切文档保持，不会突然复位。
    editor.set_view_aids(json!({"rotation": 30, "units": "mm"})).unwrap();
    editor.open_project(&first_bytes, None).unwrap();
    let back = editor.view_snapshot().unwrap();
    assert_eq!(back["rotation"], json!(30.0));
    assert_eq!(back["units"], json!("mm"));
    // 参考线/计数/注释回到第一份文档自己的值。
    assert_eq!(back["guides"]["vertical"], json!([27.0]));
    assert_eq!(back["notes"][0]["text"], json!("第一份"));
}

#[test]
fn the_layout_entry_also_respects_the_guide_lock() {
    let mut editor = editor();
    editor
        .guide_layout_command("view.newGuideLayout", json!({"columns": 2, "margin": [0, 0, 0, 0]}))
        .unwrap();
    let before = editor.view_snapshot().unwrap()["guides"]["vertical"].clone();
    editor.set_view_aids(json!({"lockGuides": true})).unwrap();
    // 布局生成同样在改参考线：锁定后拒绝，且旧线原样保留。
    assert!(editor
        .guide_layout_command("view.newGuideLayout", json!({"columns": 3, "margin": [0, 0, 0, 0]}))
        .is_err());
    assert!(editor
        .guide_layout_command("view.newGuidesFromShape", json!({}))
        .is_err());
    // 快照里的 `locked` 会跟着锁定状态变，但线本身必须原样保留。
    assert_eq!(editor.view_snapshot().unwrap()["guides"]["vertical"], before);
    // 「清除画布参考线」不受锁定影响（用户明确要移除）。
    editor.guide_layout_command("view.clearCanvasGuides", json!({})).unwrap();
    assert_eq!(editor.view_snapshot().unwrap()["guides"]["vertical"], json!([]));
}

#[test]
fn sampler_points_can_be_moved_and_notes_can_be_repositioned() {
    let mut editor = editor();
    editor.view_command("view.colorSamplers.add", json!({"x": 10, "y": 20})).unwrap();
    // 移动取样点是会话数据：位置变了，读数跟着新位置重新取源像素。
    editor.view_command("view.colorSamplers.move", json!({"index": 0, "x": 33, "y": 44})).unwrap();
    let moved = editor.sampler_readout(0).unwrap();
    assert_eq!(moved["position"], json!([33.0, 44.0]));
    assert!(editor.view_command("view.colorSamplers.move", json!({"index": 3, "x": 1, "y": 1})).is_err());

    editor.view_command("notes.add", json!({"x": 6, "y": 7, "text": "补光", "open": true})).unwrap();
    let before_collapse = history_len(&editor);
    // 位置与展开状态都是文档字段：可改、有历史、可撤销，且不改内容身份。
    let before_hash = hash(&editor);
    editor.view_command("notes.set", json!({"index": 0, "x": 40, "y": 50, "open": false})).unwrap();
    let note = &editor.view_snapshot().unwrap()["notes"][0];
    assert_eq!(note["position"], json!([40.0, 50.0]));
    assert_eq!(note["open"], json!(false));
    assert_eq!(hash(&editor), before_hash);
    assert!(history_len(&editor) > before_collapse);
    editor.undo().unwrap();
    let restored = &editor.view_snapshot().unwrap()["notes"][0];
    assert_eq!(restored["position"], json!([6.0, 7.0]));
    assert_eq!(restored["open"], json!(true));
    // 非数值坐标被上游忽略（不是 NaN 落盘），位置保持上一份有效值。
    editor.view_command("notes.set", json!({"index": 0, "x": "left"})).unwrap();
    assert_eq!(editor.view_snapshot().unwrap()["notes"][0]["position"], json!([6.0, 7.0]));
    // 索引越界仍明确拒绝。
    assert!(editor.view_command("notes.set", json!({"index": 9, "x": 1})).is_err());
}

#[test]
fn moving_a_guide_to_the_other_axis_keeps_one_history_step() {
    let mut editor = editor();
    editor.guide_command("view.newGuide", json!({"orientation": "vertical", "position": 30})).unwrap();
    let before = history_len(&editor);
    // 换向是编辑同一条参考线，不是删一条加一条（历史只加一步）。
    editor
        .guide_command("view.editGuide", json!({"orientation": "vertical", "index": 0, "newOrientation": "horizontal", "position": 30}))
        .unwrap();
    let snapshot = editor.view_snapshot().unwrap();
    assert_eq!(snapshot["guides"]["vertical"], json!([]));
    assert_eq!(snapshot["guides"]["horizontal"], json!([30.0]));
    assert_eq!(history_len(&editor), before + 1);
    // 颜色与换向可以分开改，缺省字段保持原样。
    editor
        .guide_command("view.editGuide", json!({"orientation": "horizontal", "index": 0, "position": 45}))
        .unwrap();
    assert_eq!(editor.view_snapshot().unwrap()["guides"]["horizontal"], json!([45.0]));
    assert!(editor
        .guide_command("view.editGuide", json!({"orientation": "horizontal", "index": 9, "position": 1}))
        .is_err());
}

#[test]
fn a_write_carries_its_target_document_and_is_refused_after_a_switch() {
    // 「来源失效不误写目标」：面板持有 A 的快照，切到 B 后失焦提交仍带 A 的索引与文档 id。
    let mut first = editor();
    first.view_command("count.add", json!({"x": 3, "y": 3})).unwrap();
    first.view_command("notes.add", json!({"x": 4, "y": 4, "text": "A 文档"})).unwrap();
    let first_bytes = first.save_project().unwrap();
    let fresh = {
        let mut blank = Editor::new();
        blank.execute("file.new", json!({"width": 64, "height": 48})).unwrap();
        blank.execute("layer.new.layer", json!({"name": "paint"})).unwrap();
        blank.save_project().unwrap()
    };

    let mut editor = editor();
    editor.open_project(&first_bytes, None).unwrap();
    let stale_id = editor.view_snapshot().unwrap()["document"]["id"].as_u64().unwrap();
    editor.open_project(&fresh, None).unwrap();
    let live_id = editor.view_snapshot().unwrap()["document"]["id"].as_u64().unwrap();
    assert_ne!(stale_id, live_id, "换工程必须换成另一个文档身份");

    // 陈旧目标一律拒绝：参考线、统一写入口、布局入口三个入口口径一致。
    let refused = editor.guide_command("view.newGuide", json!({"orientation": "vertical", "position": 9, "targetDocument": stale_id}));
    assert!(refused.is_err(), "切文档后旧目标不得新增参考线");
    let refused = editor.view_command("notes.add", json!({"x": 1, "y": 1, "text": "迟到", "targetDocument": stale_id}));
    assert!(refused.is_err(), "切文档后旧目标不得写注释");
    assert!(editor
        .guide_layout_command("view.newGuideLayout", json!({"columns": 2, "targetDocument": stale_id}))
        .is_err());
    // 新文档保持干净：拒绝发生在写入之前，没有半成品。
    let snapshot = editor.view_snapshot().unwrap();
    assert_eq!(snapshot["guides"]["vertical"], json!([]));
    assert_eq!(snapshot["notes"], json!([]));

    // 带上正确的目标就正常写入，且守卫字段不会被透传给上游命令。
    editor
        .view_command("notes.add", json!({"x": 1, "y": 1, "text": "本文档", "targetDocument": live_id}))
        .unwrap();
    assert_eq!(editor.view_snapshot().unwrap()["notes"][0]["text"], json!("本文档"));
    editor
        .guide_command("view.newGuide", json!({"orientation": "vertical", "position": 11, "targetDocument": live_id}))
        .unwrap();
    assert_eq!(editor.view_snapshot().unwrap()["guides"]["vertical"], json!([11.0]));
    // 只读命令同样尊重目标：旧目标读不到新文档的读数，避免界面显示错文档的数值。
    assert!(editor
        .view_command("notes.list", json!({"targetDocument": stale_id}))
        .is_err());
    assert!(editor.view_command("view.colorSamplers.list", json!({"targetDocument": live_id})).is_ok());
    // 非法目标类型明确报错，而不是被当成「未参与守卫」放行。
    assert!(editor.view_command("count.add", json!({"x": 1, "y": 1, "targetDocument": "abc"})).is_err());
    // 不传目标字段的旧宿主行为不变。
    editor.view_command("count.add", json!({"x": 2, "y": 2})).unwrap();
    assert_eq!(editor.view_snapshot().unwrap()["measurement"]["count"]["total"], json!(1));
}

#[test]
fn only_the_active_view_accepts_pointer_input() {
    let mut editor = editor();
    editor.set_view_aids(json!({"viewAction": "new"})).unwrap();
    let views = editor.view_aids()["views"].as_array().unwrap().clone();
    assert_eq!(views.len(), 2);
    let active = views.iter().find(|view| view["active"] == json!(true)).unwrap()["id"].as_str().unwrap().to_string();
    let idle = views.iter().find(|view| view["active"] == json!(false)).unwrap()["id"].as_str().unwrap().to_string();

    // 活动视图照常命中；非活动视图的指针（后台视图的迟到拖动）明确拒绝，而不是共享取景。
    assert!(editor
        .view_pointer("hit-guide", json!({"client": [10, 10], "viewId": active}))
        .is_ok());
    let refused = editor.view_pointer("drag-guide", json!({"client": [10, 10], "vertical": true, "viewId": idle}));
    assert!(refused.is_err(), "非活动视图不得接收拖动");
    // 未知视图 id 同样拒绝（不是静默当成活动视图）。
    assert!(editor.view_pointer("drag-origin", json!({"client": [1, 2], "viewId": "view-9"})).is_err());
    // 不带 viewId 的旧调用方行为不变。
    assert!(editor.view_pointer("drag-origin", json!({"client": [1, 2]})).is_ok());

    // 切到另一个视图后，原活动视图变成非活动：它不能再接收输入。
    editor.set_view_aids(json!({"viewAction": "activate", "viewId": idle})).unwrap();
    assert!(editor.view_pointer("hit-guide", json!({"client": [10, 10], "viewId": idle})).is_ok());
    assert!(editor.view_pointer("hit-guide", json!({"client": [10, 10], "viewId": active})).is_err());
}

// ---- 4.4 声明/入口/实际结果一致 ----

#[test]
fn every_whitelisted_command_maps_to_a_published_capability() {
    // 白名单新增条目却没有在 CONTRIBUTION 里登记能力时，入口会以
    // `CapabilityDisabled` 拒绝——本用例把「漏登记」变成构建期可发现的问题。
    let mut editor = crate::editor::Editor::new();
    editor.execute("file.new", json!({"width":40,"height":30})).unwrap();
    for id in GUIDE_COMMANDS.iter().chain(GUIDE_LAYOUT_COMMANDS).chain(VIEW_COMMANDS) {
        let capability = required_capability(id).unwrap_or_else(|| panic!("{id} 没有登记所属能力"));
        assert!(
            crate::capability::is_enabled(capability),
            "{id} 属于已关闭的能力 {capability}"
        );
        assert_ne!(capability, "view.rotate-navigator", "{id} 属于保持关闭的能力");
    }
}

#[test]
fn published_capabilities_are_reported_and_kept_closed_ones_are_not() {
    let delivered = crate::capability::delivered_capabilities();
    assert!(delivered.contains(&"view.guide-layout"));
    assert!(delivered.contains(&"view.analysis"));
    // 旋转的像素呈现仍缺宿主渲染端口：能力保持关闭，声明与实际一致（并排本身已交付，
    // 但同一能力还包含旋转，不能只凭并排就把它算作已开放）。
    assert!(!delivered.contains(&"view.rotate-navigator"));
    assert!(crate::capability::disabled_reason("view.rotate-navigator").is_some());
}

#[test]
fn domains_that_are_not_the_views_stay_out_of_the_new_capabilities() {
    // 新能力只由本域命令使用，不把别的域的命令算进来。
    for id in ["paint.stroke", "layer.setProps", "edit.undo", "file.new"] {
        assert!(required_capability(id).is_none(), "{id} 不该被算作视图命令");
    }
}

#[test]
fn a_whitelisted_command_whose_capability_is_closed_is_refused_not_silently_run() {
    // 5.x 的「声明/入口一致」不是靠人手对照：入口实时查能力表。
    // `view.rotate-navigator` 保持关闭；这里用一条只属于它的命令验证拒绝路径。
    let mut editor = editor();
    let before = hash(&editor);
    assert!(crate::capability::disabled_reason("view.rotate-navigator").is_some());
    // 不属于任何已登记能力的命令：静态白名单也拒绝。
    let failure = editor.view_command("view.notARealCommand", json!({})).unwrap_err();
    assert!(matches!(failure, crate::error::EditorError::CapabilityDisabled(_)), "unexpected: {failure:?}");
    assert_eq!(hash(&editor), before, "拒绝的命令不能留下任何写入");
}

#[test]
fn capability_report_matches_what_the_entry_points_actually_allow() {
    // 发布清单、能力握手与入口判定三者一致：声明的每条能力都至少放行一条命令，
    // 反之本域放行的命令都落在已声明能力下。
    let mut editor = editor();
    let mut used = std::collections::BTreeSet::new();
    for id in GUIDE_COMMANDS.iter().chain(GUIDE_LAYOUT_COMMANDS).chain(VIEW_COMMANDS) {
        let capability = required_capability(id).unwrap();
        assert!(crate::capability::is_enabled(capability));
        used.insert(capability);
    }
    assert_eq!(
        used.into_iter().collect::<Vec<_>>(),
        ["view.analysis", "view.guide-layout", "view.guides"],
        "声明的视图能力都必须有真实命令，且不多不少"
    );
    // 入口对已声明能力确实放行：拿最轻的一条确认不是「声明了但全拒」。
    editor.view_command("view.colorSamplers.list", json!({})).unwrap();
}

// --------------------------------------------- U73 持久颜色采样点（文档元数据命名空间键）

#[test]
fn color_samplers_survive_save_and_reopen_without_touching_content_identity() {
    let mut editor = editor();
    editor.view_command("view.colorSamplers.add", json!({"x": 10, "y": 20})).unwrap();
    editor.view_command("view.colorSamplers.add", json!({"x": 40, "y": 30})).unwrap();
    let before_hash = hash(&editor);
    let bytes = editor.save_project().unwrap();

    // 工程字节里确实带着本域命名空间键，且形状有界。
    let reloaded = photocraft_format::load_from_bytes(&bytes).unwrap();
    let entry = reloaded
        .metadata
        .text
        .iter()
        .find(|(key, _)| key == crate::features::views::samplers::SAMPLERS_KEY)
        .expect("保存后的工程应带有采样点元数据");
    assert_eq!(entry.1, r#"{"points":[[10.0,20.0],[40.0,30.0]]}"#);

    let mut reopened = Editor::new();
    reopened.open_project(&bytes, None).unwrap();
    assert_eq!(reopened.content_hash().unwrap(), before_hash, "采样点不改内容身份");
    let list = reopened.view_command("view.colorSamplers.list", json!({})).unwrap();
    assert_eq!(list["samplers"].as_array().unwrap().len(), 2);
    assert_eq!(list["samplers"][1]["position"], json!([40.0, 30.0]));
    // 读数仍是真实源像素：与保存前逐值一致。
    assert_eq!(reopened.sampler_readout(0).unwrap()["rgb"], json!([255, 255, 255]));
}

#[test]
fn a_document_without_samplers_keeps_its_saved_bytes_shape() {
    // 关键回归：没有采样点时**不写**元数据键，旧工程保存后仍然是原来的字节形状。
    let mut editor = editor();
    let bytes = editor.save_project().unwrap();
    let reloaded = photocraft_format::load_from_bytes(&bytes).unwrap();
    assert!(reloaded
        .metadata
        .text
        .iter()
        .all(|(key, _)| key != crate::features::views::samplers::SAMPLERS_KEY));
    // 清空后再保存也一样（键被移除，而不是留一个空数组）。
    editor.view_command("view.colorSamplers.add", json!({"x": 5, "y": 5})).unwrap();
    assert!(editor.save_project().unwrap().len() > bytes.len());
    editor.view_command("view.colorSamplers.clear", json!({})).unwrap();
    let cleared = editor.save_project().unwrap();
    let reloaded = photocraft_format::load_from_bytes(&cleared).unwrap();
    assert!(reloaded
        .metadata
        .text
        .iter()
        .all(|(key, _)| key != crate::features::views::samplers::SAMPLERS_KEY));
}

#[test]
fn saving_samplers_does_not_dirty_or_revision_the_session_document() {
    // 持久化只改**保存用的副本**：会话文档、revision 与内容指纹都不该因为保存而前进。
    let mut editor = editor();
    editor.view_command("view.colorSamplers.add", json!({"x": 12, "y": 8})).unwrap();
    let before = editor.state();
    let _ = editor.save_project().unwrap();
    let after = editor.state();
    assert_eq!(before["document"]["revision"], after["document"]["revision"]);
    assert_eq!(before["document"]["contentHash"], after["document"]["contentHash"]);
    // 会话文档本身仍不带视图键：撤销其它操作不会把持久点回滚掉。
    let session_doc = &editor.active_doc().unwrap().doc;
    assert!(session_doc
        .metadata
        .text
        .iter()
        .all(|(key, _)| key != crate::features::views::samplers::SAMPLERS_KEY));
}

#[test]
fn persisted_sampler_metadata_is_bounded_and_bad_values_are_ignored_on_load() {
    use crate::features::views::samplers::{apply_metadata, samplers_from_metadata, MAX_SAMPLERS};
    let document = editor().active_doc().unwrap().doc.clone();
    // 上限：11 个点写不进去（返回 None → 不写键）。
    let too_many: Vec<[f64; 2]> = (0..=MAX_SAMPLERS as i64).map(|n| [n as f64, 0.0]).collect();
    let mut copy = (*document).clone();
    apply_metadata(&mut copy, &too_many);
    assert!(copy.metadata.text.iter().all(|(key, _)| key != crate::features::views::samplers::SAMPLERS_KEY));
    // 非有限/越界坐标同样不写。
    let mut copy = (*document).clone();
    apply_metadata(&mut copy, &[[f64::NAN, 0.0]]);
    assert!(copy.metadata.text.is_empty());
    let mut copy = (*document).clone();
    apply_metadata(&mut copy, &[[1.0e9, 0.0]]);
    assert!(copy.metadata.text.is_empty());
    // 读回时坏数据（坏 JSON、错形状、超上限、非数值）一律当作「没有持久点」。
    let raw = |value: &str| vec![(crate::features::views::samplers::SAMPLERS_KEY.to_string(), value.to_string())];
    assert!(samplers_from_metadata(&raw("not json")).is_empty());
    assert!(samplers_from_metadata(&raw(r#"{"other":[]}"#)).is_empty());
    assert!(samplers_from_metadata(&raw(r#"{"points":[[1.0]]}"#)).is_empty());
    assert!(samplers_from_metadata(&raw(r#"{"points":[["a","b"]]}"#)).is_empty());
    assert!(samplers_from_metadata(&raw(r#"{"points":[[1.0,2.0]]}"#)) == vec![[1.0, 2.0]]);
    // 旧工程（没有键）读到空。
    assert!(samplers_from_metadata(&[]).is_empty());
}

#[test]
fn psd_export_reports_dropped_color_samplers() {
    let mut editor = editor();
    editor.view_command("view.colorSamplers.add", json!({"x": 10, "y": 10})).unwrap();
    let report = editor.inspect_psd_export().unwrap();
    let features: Vec<&str> = report["viewLosses"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|row| row["feature"].as_str())
        .collect();
    assert_eq!(features, ["view.color-samplers"]);
    assert_eq!(report["editable"], false);
    assert_eq!(report["blocking"], 0, "采样点不阻止导出，只是显式报告");
    // 实际导出后重新导入：采样点确实不在 PSD 里。
    let (bytes, report) = editor.export_psd(json!({"rasterizeLossy": true})).unwrap();
    assert_eq!(report["viewLosses"].as_array().unwrap().len(), 1);
    let mut fresh = Editor::new();
    fresh.import_psd_project(&bytes, false).unwrap();
    assert_eq!(fresh.view_command("view.colorSamplers.list", json!({})).unwrap()["samplers"], json!([]));
}

// --------------------------------------------------------- U73 Info 跟随光标的源像素读数

#[test]
fn probe_reads_the_source_pixel_under_the_pointer_through_the_view_matrix() {
    let mut editor = editor();
    // 1:1、无平移无旋转：文档 (10, 20) 在客户坐标就是 (10, 20)。
    let probe = editor.view_pointer("probe", json!({"client": [10.5, 20.5]})).unwrap();
    assert_eq!(probe["reading"]["pixel"], json!([10.0, 20.0]));
    assert_eq!(probe["reading"]["source"], json!([10.5, 20.5]));
    assert_eq!(probe["reading"]["rgb"], json!([255, 255, 255]));
    assert_eq!(probe["reading"]["cmyk"], json!([0, 0, 0, 0]));
    assert_eq!(probe["unit"], "px");

    // 与采样点读数逐值一致：同一个源像素只有一份读数实现。
    editor.view_command("view.colorSamplers.add", json!({"x": 10, "y": 20})).unwrap();
    let sampler = editor.sampler_readout(0).unwrap();
    assert_eq!(probe["reading"]["rgb"], sampler["rgb"]);
    assert_eq!(probe["reading"]["cmyk"], sampler["cmyk"]);

    // 视图缩放/平移后仍取源坐标：内核只有一份逆变换。
    editor.set_view_aids(json!({"zoom": 2.0, "offset": [5.0, 7.0]})).unwrap();
    let moved = editor.view_pointer("probe", json!({"client": [100.0, 30.0]})).unwrap();
    assert_eq!(moved["reading"]["source"], json!([47.5, 11.5]));
    // 视图旋转**不**改读数：像素平面由宿主按 origin/zoom 呈现（无旋转参数），屏幕上那个位置
    // 显示的就是未旋转的像素。若把旋转套进读数，面板就会报出「眼睛看到的像素之外」的另一处像素。
    // 读数属于像素这一侧，和落笔映射（共享无旋转的 `coordinates.ts`）保持一致。
    editor.set_view_aids(json!({"rotation": 90.0})).unwrap();
    let rotated = editor.view_pointer("probe", json!({"client": [100.0, 30.0]})).unwrap();
    assert_eq!(rotated["reading"]["source"], moved["reading"]["source"]);
    // 但参考线命中/标尺这类**几何**仍按旋转反算：同一客户点落到不同源坐标。
    let hit = editor.view_pointer("hit-guide", json!({"client": [100.0, 30.0]})).unwrap();
    assert!(hit["hit"].is_null() || hit["hit"]["position"].is_number(), "旋转下的几何仍应可算");
}

#[test]
fn probe_outside_the_canvas_returns_no_reading_instead_of_a_fake_pixel() {
    let mut editor = editor();
    for client in [json!([-1.0, 5.0]), json!([5.0, -1.0]), json!([500.0, 5.0]), json!([5.0, 500.0])] {
        let probe = editor.view_pointer("probe", json!({"client": client})).unwrap();
        assert!(probe["reading"].is_null(), "画布外不得伪造像素：{client}");
        assert_eq!(probe["unit"], "px");
    }
    // 非有限指针仍是参数错误，不是「画布外」。
    assert!(editor.view_pointer("probe", json!({"client": [f64::NAN, 0.0]})).is_err());
    assert!(editor.view_pointer("probe", json!({"client": [0.0]})).is_err());
}

#[test]
fn probe_is_read_only_and_respects_the_active_view() {
    let mut editor = editor();
    let before = editor.state();
    let before_history = history_len(&editor);
    editor.view_pointer("probe", json!({"client": [3.0, 3.0]})).unwrap();
    assert_eq!(editor.state(), before, "读数不得改文档/会话状态");
    assert_eq!(history_len(&editor), before_history, "读数不得加历史");
    // 「仅活动视图接收输入」同样适用于读数：非活动视图的迟到指针被拒绝。
    editor.set_view_aids(json!({"viewAction": "new"})).unwrap();
    let active = editor.view_aids().clone();
    let views = active["views"].as_array().unwrap();
    let stale = views
        .iter()
        .find(|view| view["active"] == false)
        .and_then(|view| view["id"].as_str())
        .unwrap()
        .to_string();
    assert!(editor.view_pointer("probe", json!({"client": [1.0, 1.0], "viewId": stale})).is_err());
}

// --------------------------------------------------------------- U72 并排：每视图独立取景

#[test]
fn side_by_side_needs_two_views_and_writes_each_views_own_framing() {
    let mut editor = editor();
    // 只有一个视图时打开并排是做不到的动作：明确拒绝，而不是留一个假开关。
    let error = editor.set_view_aids(json!({"sideBySide": true})).unwrap_err();
    assert!(error.to_string().contains("两个视图"), "{error}");
    assert_eq!(editor.view_aids()["sideBySide"], false);

    editor.set_view_aids(json!({"viewAction": "new"})).unwrap();
    editor.set_view_aids(json!({"sideBySide": true})).unwrap();
    let aids = editor.view_aids().clone();
    assert_eq!(aids["sideBySide"], true);
    let ids: Vec<String> = aids["views"]
        .as_array()
        .unwrap()
        .iter()
        .map(|view| view["id"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(ids.len(), 2);

    // 按 viewId 写取景：只改那个视图，另一视图与「活动视图」都不动。
    let active_before = aids["activeView"].as_str().unwrap().to_string();
    let (first, second) = (ids[0].clone(), ids[1].clone());
    editor.set_view_aids(json!({"viewId": first, "zoom": 2.0, "offset": [11.0, -3.0]})).unwrap();
    let after = editor.view_aids().clone();
    assert_eq!(after["activeView"].as_str().unwrap(), active_before, "改取景不该抢活动视图");
    let view = |id: &str| {
        after["views"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["id"] == id)
            .cloned()
            .unwrap()
    };
    assert_eq!(view(&first)["zoom"], 2.0);
    assert_eq!(view(&first)["offset"], json!([11.0, -3.0]));
    assert_eq!(view(&second)["zoom"], 1.0, "另一个视图的取景必须独立");
    assert_eq!(view(&second)["offset"], json!([0.0, 0.0]));

    // 未知 viewId 是参数错误，不会悄悄落到活动视图上。
    assert!(editor.set_view_aids(json!({"viewId": "view-9", "zoom": 3.0})).is_err());

    // 关掉并排不需要第二个视图消失；但只剩一个视图时并排自动关闭。
    editor.set_view_aids(json!({"viewId": first, "viewAction": "close"})).unwrap();
    let closed = editor.view_aids().clone();
    assert_eq!(closed["views"].as_array().unwrap().len(), 1);
    assert_eq!(closed["sideBySide"], false, "单视图时并排必须自动关闭");
}

#[test]
fn side_by_side_is_session_state_and_never_touches_content_or_history() {
    let mut editor = editor();
    editor.set_view_aids(json!({"viewAction": "new"})).unwrap();
    let before_hash = hash(&editor);
    let before_history = history_len(&editor);
    let before_revision = revision(&editor);
    editor.set_view_aids(json!({"sideBySide": true})).unwrap();
    editor.set_view_aids(json!({"viewId": "view-2", "zoom": 1.5, "offset": [4.0, 4.0]})).unwrap();
    assert_eq!(hash(&editor), before_hash, "取景不改内容身份");
    assert_eq!(history_len(&editor), before_history, "取景不进历史");
    assert_eq!(revision(&editor), before_revision, "会话状态不推进文档修订");
}
