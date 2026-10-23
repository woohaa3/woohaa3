//! U17–U24 的域内回归：只用公开入口与内核状态，不采集合成图或 GPU 结果。
//!
//! 每个用例锁定一类事务语义：预览不推进修订／历史、确认一次、取消恢复、非法最后输入不能
//! 提交旧候选。选区与蒙版内容都由上游命令产生，这里只核对本域编译与提交边界。

use serde_json::{Value, json};

use crate::Editor;
use crate::editor::EditorError;

/// 新建文档并在指定位置点两团同色像素（两块互不相连的受控色块）。
fn editor_with_two_blocks() -> Editor {
    let mut editor = Editor::new();
    editor.execute("file.new", json!({"width": 60, "height": 40})).unwrap();
    editor.execute("layer.new.layer", Value::Null).unwrap();
    for point in [[12, 20], [45, 20]] {
        editor
            .execute(
                "paint.stroke",
                json!({
                    "points": [point],
                    "size": 16,
                    "hardness": 1,
                    "opacity": 1,
                    "flow": 1,
                    "color": "#ff0000",
                    "target": "pixels",
                }),
            )
            .unwrap();
    }
    editor
}

fn history_len(editor: &Editor) -> usize {
    editor.session.active().unwrap().history.past_len()
}

fn revision(editor: &Editor) -> u64 {
    editor.session.active().unwrap().revision
}

// ------------------------------------------------------------------ U17 单行/单列

#[test]
fn u17_line_selection_is_exactly_one_source_pixel_and_rejects_off_canvas() {
    let mut editor = Editor::new();
    editor.execute("file.new", json!({"width": 20, "height": 16})).unwrap();

    let row = editor.select_line(json!({"x": 3, "y": 5, "line": "row"})).unwrap();
    assert_eq!(row["line"], "row");
    assert_eq!(row["bounds"], json!([0, 5, 20, 1]), "一行源像素横跨画布");

    let column = editor.select_line(json!({"x": 7, "y": 2, "line": "column", "mode": "replace"})).unwrap();
    assert_eq!(column["line"], "column");
    assert_eq!(column["bounds"], json!([7, 0, 1, 16]), "一列源像素纵贯画布");

    // 图外点击、未知轴和羽化都在提交前拒绝，且不改当前选区。
    let before = editor.state();
    assert!(editor.select_line(json!({"x": 20, "y": 5, "line": "row"})).is_err());
    assert!(editor.select_line(json!({"x": -1, "y": 5, "line": "row"})).is_err());
    assert!(editor.select_line(json!({"x": 1, "y": 5, "line": "diagonal"})).is_err());
    assert!(editor.select_line(json!({"x": 1, "y": 5, "line": "row", "feather": 2})).is_err());
    assert!(editor.select_line(json!({"y": 5, "line": "row"})).is_err());
    assert_eq!(editor.state(), before);
}

#[test]
fn u17_line_selection_keeps_the_requested_combine_mode() {
    let mut editor = Editor::new();
    editor.execute("file.new", json!({"width": 20, "height": 16})).unwrap();
    editor.select_line(json!({"x": 3, "y": 5, "line": "row"})).unwrap();
    let added = editor
        .select_line(json!({"x": 3, "y": 9, "line": "row", "mode": "add"}))
        .unwrap();
    assert_eq!(added["bounds"], json!([0, 5, 20, 5]), "两行加选后跨 5 行");
}

// ------------------------------------------------------------------ U18 磁性套索

#[test]
fn u18_draft_is_discarded_when_the_active_document_is_swapped() {
    let mut editor = editor_with_two_blocks();
    editor
        .begin_magnetic_lasso(json!({"points": [[6, 14], [18, 14], [18, 26], [6, 26]], "width": 12}))
        .unwrap();
    let own = editor.session.active().unwrap().doc.id;
    let own_index = editor.session.active_index().unwrap();
    // 直接换活动文档（等价于宿主切标签 / 父子回写在同一个会话里换目标）。
    let other = editor
        .session
        .add_document(photocraft_doc::Document::new(
            "B",
            photocraft_geom::Size::new(30, 20),
            photocraft_doc::ColorMode::Rgb,
            photocraft_doc::SampleType::U8,
        ), None);
    editor.session.set_active(other);
    assert_ne!(editor.session.active().unwrap().doc.id, own);
    let target_state = (revision(&editor), history_len(&editor));

    // 草稿仍在，但内核明确标记它属于别的文档。
    let state = editor.selection_draft_state();
    assert_eq!(state["active"], true);
    assert_eq!(state["stale"], true, "活动文档换掉后草稿被标记为过期归属");

    // 确认必须拒绝，且不能把 A 的候选写进 B。
    let target = editor.session.active().unwrap().doc.id;
    let failure = editor.commit_selection_draft().expect_err("过期草稿不能提交");
    assert_eq!(failure.code(), "command-failed");
    assert!(failure.to_string().contains("活动文档已切换"));
    assert_eq!(editor.session.active().unwrap().doc.id, target, "不换目标文档");
    assert!(editor.session.active().unwrap().doc.selection.is_none(), "B 没有被写入 A 的选区");
    assert_eq!((revision(&editor), history_len(&editor)), target_state, "B 的修订与历史都没有推进");
    // 过期草稿现场已丢弃，不是"可以重试成功"的失败。
    assert_eq!(editor.selection_draft_state()["active"], false);

    // 丢弃后目标文档必须能继续正常编辑：不能因为一份被丢弃的过期草稿把统一门禁卡死。
    editor.execute("layer.new.layer", json!({"name": "b1"})).expect("新文档仍可新建图层");
    editor
        .execute("select.rect", json!({"x": 1, "y": 1, "width": 4, "height": 4}))
        .expect("新文档仍可建立自己的选区");
    assert_eq!(editor.selection_bounds_json(), json!([1, 1, 4, 4]), "B 得到的是自己的选区");
    // 原文档 A 也没有被这次交互改写：切回去看它仍然没有选区。
    let b_index = editor.session.active_index().unwrap();
    assert_ne!(editor.session.active().unwrap().doc.id, own);
    editor.session.set_active(own_index);
    assert!(editor.session.active().unwrap().doc.selection.is_none(), "A 的候选没有被写进任何文档");
    editor.session.set_active(b_index);
}

#[test]
fn u18_magnetic_draft_previews_without_touching_the_session_then_commits_once() {
    let mut editor = editor_with_two_blocks();
    let before = (revision(&editor), history_len(&editor), editor.content_hash().unwrap());

    let info = editor
        .begin_magnetic_lasso(json!({"points": [[6, 14], [18, 14], [18, 26], [6, 26]], "width": 12}))
        .unwrap();
    assert_eq!(info["kind"], "magnetic");
    assert!(info["bounds"].is_array(), "追踪结果给出候选包围盒");
    assert!(!info["outline"].as_array().unwrap().is_empty(), "候选边界来自真实追踪");
    let state = editor.selection_draft_state();
    assert_eq!(state["active"], true);
    assert_eq!(state["kind"], "magnetic");

    // 预览不推进修订／历史，也不改内容指纹。
    assert_eq!((revision(&editor), history_len(&editor), editor.content_hash().unwrap()), before);

    let committed = editor.commit_selection_draft().unwrap();
    assert_eq!(committed["committed"], true);
    assert_eq!(history_len(&editor), before.1 + 1, "确认只提交一步历史");
    assert_eq!(editor.selection_draft_state()["active"], false);
    assert_eq!(editor.selection_bounds_json(), info["bounds"], "确认后边界等于预览");
    // 选区不是内容：指纹保持。
    assert_eq!(editor.content_hash().unwrap(), before.2);
}

#[test]
fn u18_polygon_lasso_uses_the_anchors_as_the_border_without_tracing() {
    let mut editor = editor_with_two_blocks();
    let before = (revision(&editor), history_len(&editor));

    let polygon = editor
        .begin_magnetic_lasso(json!({"points": [[6, 14], [18, 14], [18, 26], [6, 26]], "trace": false}))
        .unwrap();
    assert_eq!(polygon["kind"], "magnetic");
    // 不追踪时边界就是锚点：包围盒正好是锚点包围盒，不是被吸附后的形状。
    assert_eq!(polygon["bounds"], json!([6, 14, 12, 12]));
    assert_eq!((revision(&editor), history_len(&editor)), before, "预览不改文档");

    let traced = editor
        .update_magnetic_lasso(json!({"points": [[6, 14], [18, 14], [18, 26], [6, 26]], "width": 12}))
        .unwrap();
    assert!(traced["bounds"].is_array());
    let committed = editor.commit_selection_draft().unwrap();
    assert_eq!(committed["committed"], true);
    assert_eq!(history_len(&editor), before.1 + 1, "确认只提交一步历史");
    assert_eq!(editor.selection_bounds_json(), traced["bounds"], "确认后边界等于最后一次预览");
}

#[test]
fn u18_magnetic_rejects_short_outlines_updates_in_place_and_cancels_cleanly() {
    let mut editor = editor_with_two_blocks();
    let before = (revision(&editor), history_len(&editor), editor.state());

    assert!(editor.begin_magnetic_lasso(json!({"points": [[6, 14], [18, 14]]})).is_err(), "锚点不足必须拒绝");
    assert!(editor.begin_magnetic_lasso(json!({"points": []})).is_err());
    assert_eq!(editor.selection_draft_state()["active"], false);

    editor
        .begin_magnetic_lasso(json!({"points": [[6, 14], [18, 14], [18, 26]], "width": 12}))
        .unwrap();
    let updated = editor
        .update_magnetic_lasso(json!({"points": [[4, 12], [20, 12], [20, 28], [4, 28]], "width": 8}))
        .unwrap();
    assert!(updated["bounds"].is_array());
    // 非法参数把草稿标为不可确认，但保留现场。
    assert!(editor.update_magnetic_lasso(json!({"points": []})).is_err());
    assert_eq!(editor.selection_draft_state()["invalid"], true);
    assert!(editor.commit_selection_draft().is_err(), "非法最后输入不能确认旧候选");
    assert_eq!(editor.selection_draft_state()["active"], true, "失败保留草稿现场");

    editor.cancel_selection_draft();
    assert_eq!(editor.selection_draft_state()["active"], false);
    assert_eq!(revision(&editor), before.0);
    assert_eq!(history_len(&editor), before.1);
    assert_eq!(editor.state(), before.2, "取消不写文档");
}

#[test]
fn u18_magnetic_rejects_a_border_over_the_trace_budget() {
    let mut editor = editor_with_two_blocks();
    let before = (revision(&editor), history_len(&editor));

    // 1600 个在角上反复跳的锚点：闭合环长远超上游 200000 px 的追踪预算。
    let mut points = Vec::new();
    for index in 0..1600 {
        points.push(if index % 2 == 0 { json!([0, 0]) } else { json!([40, 30]) });
    }
    let failure = editor
        .begin_magnetic_lasso(json!({ "points": points, "trace": true }))
        .expect_err("超过追踪预算必须拒绝，而不是静默截断");
    assert!(
        failure.message().contains("longer than") || failure.message().contains("追踪"),
        "{}",
        failure.message()
    );
    assert_eq!(editor.selection_draft_state()["active"], false, "拒绝后不留草稿");
    assert_eq!((revision(&editor), history_len(&editor)), before, "拒绝不改文档");
}

// ------------------------------------------------------------------ U19 命名选区 / Grow / Similar

#[test]
fn u19_named_selection_roundtrips_and_refuses_an_unconfirmed_overwrite() {
    let mut editor = editor_with_two_blocks();
    editor.execute("select.rect", json!({"x": 6, "y": 14, "width": 12, "height": 12})).unwrap();
    let saved = editor.save_named_selection(json!({"name": "左色块"})).unwrap();
    assert_eq!(saved["saved"], true);
    assert_eq!(saved["overwritten"], Value::Null);

    // 同名未确认覆盖：拒绝，通道数不变。
    let channels = |editor: &Editor| editor.active_doc().unwrap().doc.channels.len();
    let before = channels(&editor);
    let failure = editor.save_named_selection(json!({"name": "左色块"})).unwrap_err();
    assert!(failure.message().contains("覆盖"), "{}", failure.message());
    assert_eq!(channels(&editor), before);

    // 明确覆盖才替换。
    editor.execute("select.rect", json!({"x": 40, "y": 14, "width": 6, "height": 6})).unwrap();
    let replaced = editor.save_named_selection(json!({"name": "左色块", "overwrite": true})).unwrap();
    assert_eq!(replaced["overwritten"], 0);
    assert_eq!(channels(&editor), before, "覆盖替换同名通道，不新增");

    // 无选区保存、空名称、超长名称都拒绝。
    editor.execute("select.deselect", Value::Null).unwrap();
    assert!(editor.save_named_selection(json!({"name": "空"})).is_err());
    editor.execute("select.rect", json!({"x": 4, "y": 4, "width": 4, "height": 4})).unwrap();
    assert!(editor.save_named_selection(json!({"name": "   "})).is_err());
    assert!(editor.save_named_selection(json!({"name": "x".repeat(201)})).is_err());

    // 加载：按名称恢复，未知名称明确拒绝。
    editor.execute("select.deselect", Value::Null).unwrap();
    let loaded = editor.load_named_selection(json!({"name": "左色块"})).unwrap();
    assert_eq!(loaded["loaded"], true);
    assert_eq!(loaded["bounds"], json!([40, 14, 6, 6]), "加载回来的是覆盖后的通道");
    assert!(editor.load_named_selection(json!({"name": "不存在"})).is_err());
}

#[test]
fn u19_named_selection_rejects_an_unbounded_storage_growth() {
    use photocraft_project_verify::MAX_ENTRIES;

    // 直接顶到条目上限附近再保存一次：验证的是"越界被拒"，不需要循环 4000 多次。
    let mut editor = Editor::new();
    editor.execute("file.new", json!({"width": 1, "height": 1})).unwrap();
    editor.execute("select.all", Value::Null).unwrap();
    {
        let doc = std::sync::Arc::make_mut(&mut editor.session.active_mut().unwrap().doc);
        // 用最小代价把已用条目推到上限：名字里不含冒号即可，内容不参与保存。
        while doc.channels.len() + doc.layers.len() + 1 <= MAX_ENTRIES {
            let index = doc.channels.len();
            doc.channels.push(photocraft_doc::AlphaChannel::new(
                format!("占位{index}"),
                photocraft_doc::Surface::new(doc.pixel_format()),
            ));
        }
    }
    let used = editor.active_doc().unwrap().doc.channels.len();
    assert!(
        used + editor.active_doc().unwrap().doc.layers.len() >= MAX_ENTRIES,
        "测试场景要把已用条目顶到上限：{used} + 层"
    );

    let failure = editor
        .save_named_selection(json!({"name": "再来一个"}))
        .expect_err("越过条目上限必须被拒绝，而不是无限增长");
    assert_eq!(failure.code(), "command-failed");
    assert!(failure.message().contains("命名选区条目已满"), "{}", failure.message());
    assert_eq!(
        editor.active_doc().unwrap().doc.channels.len(),
        used,
        "拒绝后没有多出通道"
    );

    // 覆盖同名通道不增加条目：满了以后不会被条目预算挡住（上游仍可能因其它原因拒绝）。
    if let Err(error) = editor.save_named_selection(json!({"name": "占位0", "overwrite": true})) {
        assert!(
            !error.message().contains("命名选区条目已满"),
            "覆盖不该被条目预算拒绝：{}",
            error.message()
        );
    }
}

#[test]
fn u19_named_selection_survives_a_project_roundtrip() {
    let mut editor = editor_with_two_blocks();
    editor.execute("select.rect", json!({"x": 6, "y": 14, "width": 12, "height": 12})).unwrap();
    editor.save_named_selection(json!({"name": "重开"})).unwrap();
    let bytes = editor.save_project().unwrap();

    let mut reopened = Editor::new();
    reopened.open_project(&bytes, None).unwrap();
    reopened.execute("select.deselect", Value::Null).unwrap();
    let loaded = reopened.load_named_selection(json!({"name": "重开"})).unwrap();
    assert_eq!(loaded["bounds"], json!([6, 14, 12, 12]));
}

#[test]
fn u19_color_grow_and_similar_differ_from_geometric_expand() {
    // 几何扩展只按半径长大。
    let mut geometric = editor_with_two_blocks();
    geometric.execute("select.rect", json!({"x": 6, "y": 16, "width": 4, "height": 4})).unwrap();
    let expand = geometric.begin_selection_modify(json!({"operation": "expand", "radius": 4})).unwrap();
    let expanded = expand["bounds"].as_array().unwrap().clone();
    let expanded_width = expanded[2].as_i64().unwrap();

    // Grow 沿着颜色继续长，比同半径的几何扩展更宽。
    let mut grow = editor_with_two_blocks();
    grow.execute("select.rect", json!({"x": 6, "y": 16, "width": 4, "height": 4})).unwrap();
    let grow_info = grow.begin_color_grow(false, json!({"tolerance": 32})).unwrap();
    assert_eq!(grow_info["kind"], "grow");
    let grown = grow_info["bounds"].as_array().unwrap().clone();
    assert!(
        grown[2].as_i64().unwrap() > expanded_width,
        "Grow 在受控色块上应超出几何扩展：grow={grown:?} expand={expanded:?}"
    );
    grow.cancel_selection_draft();

    // Similar 选中另一块不相连的同色像素。
    let mut similar = editor_with_two_blocks();
    similar.execute("select.rect", json!({"x": 6, "y": 16, "width": 4, "height": 4})).unwrap();
    let similar_info = similar.begin_color_grow(true, json!({"tolerance": 32})).unwrap();
    assert_eq!(similar_info["kind"], "similar");
    let bounds = similar_info["bounds"].as_array().unwrap().clone();
    assert!(
        bounds[2].as_i64().unwrap() > 30,
        "Similar 应覆盖另一块同色像素：{bounds:?}"
    );
}

#[test]
fn u19_color_grow_requires_a_selection_and_a_bounded_tolerance() {
    let mut editor = editor_with_two_blocks();
    assert!(editor.begin_color_grow(false, json!({"tolerance": 32})).is_err(), "无选区不能 Grow");
    editor.execute("select.rect", json!({"x": 6, "y": 16, "width": 4, "height": 4})).unwrap();
    for tolerance in [-1.0, 256.0] {
        assert!(editor.begin_color_grow(false, json!({"tolerance": tolerance})).is_err(), "{tolerance}");
    }
    // JSON 没有 NaN：缺字段走默认值，非数值明确拒绝而不是静默当成默认值。
    assert!(editor.begin_color_grow(false, json!({"tolerance": "wide"})).is_err());
    assert_eq!(editor.selection_draft_state()["active"], false, "拒绝后没有留下草稿");
}

// ------------------------------------------------------------------ U20 快速蒙版

#[test]
fn u20_quick_mask_paints_only_the_temporary_channel_and_commits_one_step() {
    let mut editor = editor_with_two_blocks();
    editor.execute("select.rect", json!({"x": 6, "y": 14, "width": 8, "height": 8})).unwrap();
    let LayerSnapshot { hash, mask, pixels, revision: before_revision, history, .. } = snapshot(&editor);

    let begun = editor.begin_quick_mask().unwrap();
    assert_eq!(begun["quickMask"], true);
    // 进入快速蒙版是草稿，不写正式文档。
    assert_eq!(revision(&editor), before_revision);
    assert_eq!(history_len(&editor), history);

    let painted = editor
        .paint_quick_mask(json!({"points": [[20, 20], [24, 20]], "size": 6, "hardness": 1, "color": "#ffffff"}))
        .unwrap();
    assert_eq!(painted["quickMask"], true);
    assert_eq!(painted["strokes"], 1);
    assert_eq!(revision(&editor), before_revision, "笔迹只写候选文档");

    let exited = editor.exit_quick_mask(false).unwrap();
    assert_eq!(exited["committed"], true);
    assert_eq!(history_len(&editor), history + 1, "退出转选区只提交一步");
    // 临时笔迹不落到图层像素或像素蒙版。
    let after = snapshot(&editor);
    assert_eq!(after.mask, mask, "像素蒙版未变");
    assert_eq!(after.pixels, pixels, "图层像素未变");
    assert_eq!(after.hash, hash, "内容指纹未变（选区不是内容）");
    assert!(after.selection_bounds.is_array(), "退出后保留选区边界");
}

#[test]
fn u20_quick_mask_reports_the_overlay_colour_for_viewing() {
    let mut editor = editor_with_two_blocks();
    editor.execute("select.rect", json!({"x": 6, "y": 14, "width": 8, "height": 8})).unwrap();
    // 不进草稿时没有覆盖色可报。
    assert_eq!(editor.selection_draft_state()["active"], false);

    editor.begin_quick_mask().unwrap();
    let overlay = editor.selection_draft_state()["draft"]["overlay"].clone();
    // 内核默认是红 50%、着色遮住的一侧（Photoshop 默认），必须如实报出来而不是让界面猜。
    assert_eq!(overlay["color"], "#ff0000");
    assert_eq!(overlay["opacity"], 0.5);
    assert_eq!(overlay["indicates"], "maskedAreas");
    // 覆盖色是视图属性：进出与笔迹都不写内容，撤销后不为它留历史。
    assert!(editor.exit_quick_mask(true).is_ok());
    assert_eq!(editor.selection_draft_state()["active"], false);
}
#[test]
fn u20_quick_mask_cancel_restores_the_entry_selection_without_history() {
    let mut editor = editor_with_two_blocks();
    editor.execute("select.rect", json!({"x": 6, "y": 14, "width": 8, "height": 8})).unwrap();
    let before = (revision(&editor), history_len(&editor), editor.selection_bounds_json(), editor.state());
    editor.begin_quick_mask().unwrap();
    editor.paint_quick_mask(json!({"points": [[30, 30]], "size": 8, "color": "#ffffff"})).unwrap();
    let cancelled = editor.exit_quick_mask(true).unwrap();
    assert_eq!(cancelled["cancelled"], true);
    assert_eq!((revision(&editor), history_len(&editor)), (before.0, before.1));
    assert_eq!(editor.selection_bounds_json(), before.2, "取消恢复进入前的选区");
    assert_eq!(editor.state(), before.3);

    // 已在快速蒙版模式时不能再进入；非快速蒙版草稿不能退出。
    editor.begin_quick_mask().unwrap();
    assert!(editor.begin_quick_mask().is_err());
    editor.cancel_selection_draft();
    assert!(editor.exit_quick_mask(false).is_err());
}

#[test]
fn u20_quick_mask_blocks_other_drafts_until_settled() {
    let mut editor = editor_with_two_blocks();
    editor.begin_quick_mask().unwrap();
    assert!(editor.begin_magnetic_lasso(json!({"points": [[6, 14], [18, 14], [18, 26]]})).is_err());
    assert!(editor.begin_color_range(json!({"points": [[12, 20]]})).is_err());
    editor.cancel_selection_draft();
    assert!(editor.begin_magnetic_lasso(json!({"points": [[6, 14], [18, 14], [18, 26]]})).is_ok());
}

// ------------------------------------------------------------------ U21 传统分割

#[test]
fn u21_object_selection_produces_a_real_selection_and_undoes_in_one_step() {
    let mut editor = editor_with_two_blocks();
    let before = (revision(&editor), history_len(&editor), editor.content_hash().unwrap());
    let info = editor.begin_smart_select("object", json!({"point": [12, 20], "mode": "replace"})).unwrap();
    assert_eq!(info["traditional"], true, "传统分割不标记为 AI 能力");
    assert_eq!(info["command"], "select.object");
    assert_eq!((revision(&editor), history_len(&editor)), (before.0, before.1), "预览不写正式文档");

    let committed = editor.commit_selection_draft().unwrap();
    assert_eq!(history_len(&editor), before.1 + 1);
    assert!(committed["result"]["selected"].as_bool().unwrap_or(false), "对象选择命中真实像素");
    assert!(editor.selection_bounds_json().is_array());
    assert_eq!(editor.selection_bounds_json(), committed["bounds"], "确认回执边界来自正式会话");
    assert_eq!(editor.content_hash().unwrap(), before.2);

    editor.undo().unwrap();
    assert_eq!(history_len(&editor), before.1);
}

#[test]
fn u21_smart_select_can_commit_to_a_layer_mask() {
    let mut editor = editor_with_two_blocks();
    let before = (history_len(&editor), editor.content_hash().unwrap());
    let info = editor.begin_smart_select("object", json!({"point": [12, 20], "output": "mask"})).unwrap();
    assert_eq!(info["output"], "mask");
    // 预览阶段不得已经写出蒙版。
    let layer = editor.session.active().unwrap().active_layer.unwrap();
    assert!(editor.session.active().unwrap().doc.layer(layer).unwrap().mask.is_none(), "预览不写蒙版");

    let committed = editor.commit_selection_draft().unwrap();
    assert_eq!(committed["kind"], "smart");
    // 选区 + 转蒙版必须算**一步**（否则用户要按两次撤销才能回退）。
    assert_eq!(history_len(&editor), before.0 + 1, "输出到蒙版仍是一步历史");
    // 确认后：目标层有了像素蒙版。
    let layer = editor.session.active().unwrap().active_layer.unwrap();
    assert!(editor.session.active().unwrap().doc.layer(layer).unwrap().mask.is_some(), "确认写出像素蒙版");
    // 一次撤销就回到确认前（蒙版与选区一起回滚，不留"确认了一半"）。
    editor.undo().unwrap();
    let layer = editor.session.active().unwrap().active_layer.unwrap();
    assert!(editor.session.active().unwrap().doc.layer(layer).unwrap().mask.is_none(), "撤销后蒙版消失");
    assert_eq!(editor.content_hash().unwrap(), before.1, "撤销后回到确认前的身份");

    // 未知输出目标明确拒绝，不静默当成选区。
    assert!(editor.begin_smart_select("object", json!({"point": [12, 20], "output": "clipboard"})).is_err());
    // 移除背景本身就是蒙版输出，再选 mask 属于重复要求。
    assert!(editor.begin_smart_select("removeBackground", json!({"output": "mask"})).is_err());
}

#[test]
fn u21_subject_produces_a_real_candidate_and_commits_in_one_step() {
    // 传统主体分割（非 AI 模型）：候选来自上游本地算法，确认恰好一步历史。
    let mut editor = editor_with_two_blocks();
    let before = (editor.state()["document"]["revision"].clone(), editor.content_hash().unwrap());
    let info = editor.begin_smart_select("subject", json!({})).unwrap();
    assert_eq!(info["command"], "select.subject");
    let preview = &info["preview"];
    assert!(preview["bounds"].is_array(), "主体候选有真实包围盒");
    // 预览不推进正式修订/hash/历史。
    assert_eq!(editor.state()["document"]["revision"], before.0, "预览不推进修订");
    assert_eq!(editor.content_hash().unwrap(), before.1, "预览不改内容身份");

    let history_before = editor.state()["document"]["history"].as_array().unwrap().len();
    editor.commit_selection_draft().unwrap();
    assert_eq!(editor.state()["document"]["hasSelection"], true, "确认后得到选区");
    let history_after = editor.state()["document"]["history"].as_array().unwrap().len();
    assert_eq!(history_after, history_before + 1, "确认恰好一步历史");
    assert_eq!(editor.selection_draft_state()["active"], false, "确认后草稿清空");

    editor.undo().unwrap();
    assert_eq!(editor.state()["document"]["hasSelection"], false, "一次撤销回到无选区");
    // 未知种类仍然明确拒绝，不静默当主体。
    assert!(editor.begin_smart_select("unknown", json!({})).is_err());
}

#[test]
fn u21_remove_background_writes_a_mask_and_keeps_the_pixels() {
    let mut editor = editor_with_two_blocks();
    let before_pixels = layer_pixels(&editor);
    let info = editor.begin_smart_select("removeBackground", json!({})).unwrap();
    assert_eq!(info["command"], "layer.removeBackground");
    let preview = &info["preview"];
    assert!(preview["maskBounds"].is_array(), "候选遮罩有真实包围盒");
    assert!(layer_mask(&editor).is_none(), "预览不写蒙版");

    editor.commit_selection_draft().unwrap();
    let mask = layer_mask(&editor).expect("确认后写入像素蒙版");
    assert!(!mask.surface.content_bounds().is_empty());
    assert_eq!(layer_pixels(&editor), before_pixels, "移除背景只加蒙版，不抹像素");
    // 已带蒙版的图层再次移除背景明确拒绝。
    assert!(editor.begin_smart_select("removeBackground", json!({})).is_err());
}

#[test]
fn u21_remove_background_rejects_non_raster_targets() {
    let mut editor = editor_with_two_blocks();
    // 调整层不是像素层：移除背景在长计算前就拒绝。
    editor.execute("layer.newAdjustmentLayer.curves", Value::Null).unwrap();
    let failure = editor.begin_smart_select("removeBackground", json!({})).unwrap_err();
    assert!(failure.message().contains("像素图层"), "{}", failure.message());
    assert_eq!(editor.selection_draft_state()["active"], false);
}

// ------------------------------------------------------------------ U22 色彩范围

#[test]
fn u22_color_range_previews_sampling_and_commits_the_last_preview() {
    let mut editor = editor_with_two_blocks();
    let before = (revision(&editor), history_len(&editor), editor.content_hash().unwrap());
    let info = editor.begin_color_range(json!({"points": [[12, 20]], "fuzziness": 20})).unwrap();
    assert_eq!(info["kind"], "colorRange");
    assert!(info["bounds"].is_array());
    assert_eq!((revision(&editor), history_len(&editor)), (before.0, before.1));

    let updated = editor
        .update_color_range(json!({"points": [[45, 20]], "fuzziness": 20, "mode": "replace"}))
        .unwrap();
    assert!(updated["bounds"].is_array(), "改取样点立即改变候选选区");
    let committed = editor.commit_selection_draft().unwrap();
    assert_eq!(history_len(&editor), before.1 + 1);
    assert_eq!(editor.selection_bounds_json(), updated["bounds"], "确认与最后预览一致");
    assert_eq!(editor.content_hash().unwrap(), before.2);
    assert_eq!(committed["kind"], "colorRange");
}

#[test]
fn u22_color_range_validates_sampling_options_and_blocks_stale_previews() {
    let mut editor = editor_with_two_blocks();
    assert!(editor.begin_color_range(json!({})).is_err(), "无取样、无预设、无颜色");
    assert!(editor.begin_color_range(json!({"detectFaces": true, "points": [[12, 20]]})).is_err());
    assert!(editor.begin_color_range(json!({"localized": true, "range": 50})).is_err(), "局部颜色群组需要取样点");
    assert!(editor.begin_color_range(json!({"points": [[12, 20]], "range": 101})).is_err());
    assert!(editor.begin_color_range(json!({"points": [[12, 20]], "range": -1})).is_err());

    // 预设范围与色调不改取样点也能算；非法更新让旧候选不可确认。
    editor.begin_color_range(json!({"select": "reds", "fuzziness": 30})).unwrap();
    assert!(editor.update_color_range(json!({"points": [], "range": 500})).is_err());
    assert_eq!(editor.selection_draft_state()["invalid"], true);
    assert!(editor.commit_selection_draft().is_err());
    editor.cancel_selection_draft();
}

// ------------------------------------------------------------------ U23 选择并遮住

#[test]
fn u23_refine_edge_previews_a_real_mask_and_commits_one_history_step() {
    let mut editor = editor_with_two_blocks();
    editor.execute("select.rect", json!({"x": 6, "y": 14, "width": 12, "height": 12})).unwrap();
    let before = (revision(&editor), history_len(&editor));
    let info = editor
        .begin_refine_edge(json!({
            "radius": 2,
            "smartRadius": true,
            "smooth": 4,
            "feather": 1,
            "contrast": 10,
            "output": "layerMask",
            "refineStrokes": [{"points": [[10, 16], [14, 20]], "mode": "foreground", "size": 8}],
        }))
        .unwrap();
    assert_eq!(info["kind"], "refine");
    assert_eq!(info["output"], "layerMask");
    assert_eq!((revision(&editor), history_len(&editor)), before);
    assert!(layer_mask(&editor).is_none(), "预览不写蒙版");

    editor.commit_selection_draft().unwrap();
    assert_eq!(history_len(&editor), before.1 + 1);
    assert!(layer_mask(&editor).is_some(), "确认后写入像素蒙版");
}

#[test]
fn u23_refine_edge_outputs_and_cancel_restore_the_baseline() {
    let mut editor = editor_with_two_blocks();
    editor.execute("select.rect", json!({"x": 6, "y": 14, "width": 12, "height": 12})).unwrap();
    let documents = editor.session.documents().len();
    let before = (revision(&editor), history_len(&editor));

    // 新文档输出：预览不创建文档，确认才占一个名额。
    editor.begin_refine_edge(json!({"radius": 1, "output": "newDocument"})).unwrap();
    assert_eq!(editor.session.documents().len(), documents, "预览不创建文档");
    assert_eq!((revision(&editor), history_len(&editor)), before);
    editor.commit_selection_draft().unwrap();
    assert_eq!(editor.session.documents().len(), documents + 1);
    editor.close();

    // 取消恢复基线。
    let mut editor = editor_with_two_blocks();
    editor.execute("select.rect", json!({"x": 6, "y": 14, "width": 12, "height": 12})).unwrap();
    let before = (revision(&editor), history_len(&editor), editor.state());
    editor.begin_refine_edge(json!({"radius": 3, "output": "selection"})).unwrap();
    editor.cancel_selection_draft();
    assert_eq!((revision(&editor), history_len(&editor)), (before.0, before.1));
    assert_eq!(editor.state(), before.2);

    // 新层输出：确认后多一层。
    let layers = editor.session.active().unwrap().doc.layers.len();
    editor.begin_refine_edge(json!({"radius": 1, "output": "newLayerWithMask"})).unwrap();
    editor.commit_selection_draft().unwrap();
    assert!(editor.session.active().unwrap().doc.layers.len() > layers);
}

#[test]
fn u23_refine_edge_rejects_bad_parameters_and_missing_selection() {
    let mut editor = editor_with_two_blocks();
    assert!(editor.begin_refine_edge(json!({"radius": 1})).is_err(), "无选区也无蒙版");
    editor.execute("select.rect", json!({"x": 6, "y": 14, "width": 12, "height": 12})).unwrap();
    assert!(editor.begin_refine_edge(json!({"radius": -1})).is_err());
    assert!(editor.begin_refine_edge(json!({"contrast": 101})).is_err());
    assert!(editor.begin_refine_edge(json!({"shiftEdge": -101})).is_err());
    assert!(editor.begin_refine_edge(json!({"output": "flatten"})).is_err());
    assert!(editor.begin_refine_edge(json!({"refineStrokes": [{"points": [], "mode": "foreground"}]})).is_err());
    assert!(editor.begin_refine_edge(json!({"refineStrokes": [{"points": [[1, 1]], "mode": "ai"}]})).is_err());
    // 只编译参数（旧 UI 兼容入口）不建草稿。
    let prepared = editor.prepare_refine_edge(json!({"radius": 2, "output": "layerMask"})).unwrap();
    assert_eq!(prepared["output"], "layerMask");
    assert_eq!(editor.selection_draft_state()["active"], false);
}

// ------------------------------------------------------------------ U24 像素蒙版属性

#[test]
fn u24_mask_density_and_feather_change_attributes_without_touching_samples() {
    let mut editor = editor_with_two_blocks();
    editor.execute("select.rect", json!({"x": 6, "y": 14, "width": 12, "height": 12})).unwrap();
    editor.execute("layer.layerMask.revealSelection", Value::Null).unwrap();
    let before = snapshot(&editor);
    assert!(before.mask.is_some());

    let edited = editor.edit_layer_mask(json!({"density": 40, "feather": 6})).unwrap();
    assert_eq!(edited["density"], 40.0);
    assert_eq!(edited["feather"], 6.0);
    assert_eq!(edited["pixelsPreserved"], true, "只改属性，蒙版采样值不变");

    let after = snapshot(&editor);
    assert_eq!(after.mask_bounds, before.mask_bounds, "蒙版像素包围盒不变");
    assert_ne!((after.density, after.feather), (before.density, before.feather), "属性确实改了");
    assert_eq!(after.history, before.history + 1, "属性修改是内容历史");
    assert_eq!(editor.layer_mask_properties(None).unwrap()["mask"]["density"], 40.0);
    assert_eq!(editor.layer_mask_properties(None).unwrap()["mask"]["feather"], 6.0);

    // 重开工程后仍可继续改参数。
    let bytes = editor.save_project().unwrap();
    let mut reopened = Editor::new();
    reopened.open_project(&bytes, None).unwrap();
    let properties = reopened.layer_mask_properties(None).unwrap();
    assert_eq!(properties["mask"]["feather"], 6.0);
    let again = reopened.edit_layer_mask(json!({"density": 70})).unwrap();
    assert_eq!(again["density"], 70.0);
}

#[test]
fn u24_mask_properties_reject_out_of_range_and_missing_masks() {
    let mut editor = editor_with_two_blocks();
    assert!(editor.edit_layer_mask(json!({"density": 40})).is_err(), "没有蒙版");
    assert!(editor.layer_mask_properties(None).unwrap()["mask"].is_null());
    editor.execute("select.rect", json!({"x": 6, "y": 14, "width": 12, "height": 12})).unwrap();
    editor.execute("layer.layerMask.revealSelection", Value::Null).unwrap();
    assert!(editor.edit_layer_mask(json!({})).is_err(), "至少一个属性");
    assert!(editor.edit_layer_mask(json!({"density": 101})).is_err());
    assert!(editor.edit_layer_mask(json!({"density": -1})).is_err());
    assert!(editor.edit_layer_mask(json!({"feather": 1001})).is_err());
    assert!(editor.edit_layer_mask(json!({"layer": 9999, "density": 10})).is_err());
}

#[test]
fn u24_mask_view_is_session_state_not_content_history() {
    let mut editor = editor_with_two_blocks();
    editor.execute("select.rect", json!({"x": 6, "y": 14, "width": 12, "height": 12})).unwrap();
    editor.execute("layer.layerMask.revealSelection", Value::Null).unwrap();
    let before = snapshot(&editor);

    let gray = editor.view_layer_mask(json!({"mode": "gray"})).unwrap();
    assert_eq!(gray["contentUnchanged"], true, "查看不是内容修改");
    assert_eq!(editor.layer_mask_properties(None).unwrap()["view"], "gray");

    let overlay = editor.view_layer_mask(json!({"mode": "overlay"})).unwrap();
    assert_eq!(overlay["contentUnchanged"], true);
    assert_eq!(editor.layer_mask_properties(None).unwrap()["view"], "overlay");

    editor.view_layer_mask(json!({"mode": "off"})).unwrap();
    assert!(editor.layer_mask_properties(None).unwrap()["view"].is_null());

    let after = snapshot(&editor);
    // 查看是会话视图：内容指纹与历史不变。内核为「需要重绘」会推进修订号，但那是查看状态，
    // 不进历史、不进内容身份（重开后也不会把查看模式写进工程）。
    assert_eq!((after.hash, after.history), (before.hash, before.history));
    assert!(editor.view_layer_mask(json!({"mode": "sideways"})).is_err());
    // 无蒙版图层查看明确拒绝。
    editor.execute("layer.new.layer", Value::Null).unwrap();
    assert!(editor.view_layer_mask(json!({"mode": "gray"})).is_err());
}

// ------------------------------------------------------------------ 共用快照

struct LayerSnapshot {
    hash: String,
    mask: Option<Value>,
    mask_bounds: Option<[i32; 4]>,
    density: f32,
    feather: f32,
    pixels: Vec<f32>,
    revision: u64,
    history: usize,
    selection_bounds: Value,
}

fn snapshot(editor: &Editor) -> LayerSnapshot {
    let state = editor.active_doc().unwrap();
    let layer = state.active_layer.and_then(|id| state.doc.layer(id));
    let mask = layer.and_then(|layer| layer.mask.as_ref());
    LayerSnapshot {
        hash: editor.content_hash().unwrap(),
        mask: mask.map(|mask| {
            json!({
                "enabled": mask.enabled,
                "linked": mask.linked,
                "density": mask.density,
                "feather": mask.feather,
            })
        }),
        mask_bounds: mask.map(|mask| bounds(mask.surface.content_bounds())),
        density: mask.map_or(0.0, |mask| mask.density),
        feather: mask.map_or(0.0, |mask| mask.feather),
        pixels: layer
            .and_then(|layer| layer.surface())
            .map(|surface| surface.read_region(surface.content_bounds()))
            .unwrap_or_default(),
        revision: state.revision,
        history: state.history.past_len(),
        selection_bounds: editor.selection_bounds_json(),
    }
}

fn bounds(rect: photocraft_geom::Rect) -> [i32; 4] {
    [rect.x0, rect.y0, rect.width() as i32, rect.height() as i32]
}

fn layer_mask(editor: &Editor) -> Option<&photocraft_doc::LayerMask> {
    let state = editor.active_doc().unwrap();
    state.active_layer.and_then(|id| state.doc.layer(id)).and_then(|layer| layer.mask.as_ref())
}

fn layer_pixels(editor: &Editor) -> Vec<f32> {
    let state = editor.active_doc().unwrap();
    state
        .active_layer
        .and_then(|id| state.doc.layer(id))
        .and_then(|layer| layer.surface())
        .map(|surface| surface.read_region(surface.content_bounds()))
        .unwrap_or_default()
}

/// 未使用的能力错误分支保留在这里，避免测试外的错误码漂移。
#[allow(dead_code)]
fn assert_capability_disabled(failure: EditorError) {
    assert_eq!(failure.code(), "capability-disabled");
}
