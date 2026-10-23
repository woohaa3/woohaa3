//! 直接调整与调整层两条流程的事务证据（change: 2026-10-22-add-photocraft-adjustment-workflows）。
//!
//! 只读内核内存里的图层像素（`Surface::sample_channel`），不经过合成/渲染，也不采集 GPU 证据。
//! 覆盖：草稿门禁、一步历史、不新增图层、选区边界、无变化不增历史、目标拒绝、失败后不可确认、
//! 取消恢复、保存重开，以及「同一草稿槽不能同时承载两种目标」。

use crate::Editor;
use serde_json::{json, Value};

/// 取活动文档的一层像素（RGB 0–1）；只在同一个内核内读取，不依赖渲染。
fn pixel(editor: &Editor, layer: u64, x: i32, y: i32) -> [f32; 3] {
    let doc = &editor.session.active().unwrap().doc;
    let surface = doc.layer(photocraft_doc::LayerId(layer)).and_then(|layer| layer.surface()).unwrap();
    [surface.sample_channel(x, y, 0), surface.sample_channel(x, y, 1), surface.sample_channel(x, y, 2)]
}

fn past(editor: &Editor) -> usize {
    editor.session.active().unwrap().history.past_len()
}

fn layer_ids(editor: &Editor) -> Vec<u64> {
    fn walk(layers: &[photocraft_doc::Layer], out: &mut Vec<u64>) {
        for layer in layers {
            out.push(layer.id.0);
            if let photocraft_doc::LayerContent::Group(group) = &layer.content {
                walk(&group.children, out);
            }
        }
    }
    let mut out = Vec::new();
    walk(&editor.session.active().unwrap().doc.layers, &mut out);
    out
}

#[test]
fn direct_adjustment_changes_pixels_in_one_step_without_adding_a_layer() {
    let mut editor = Editor::new();
    editor.execute("file.new", json!({"width": 24, "height": 16, "background": "#336699"})).unwrap();
    let layer = editor.session.active().unwrap().active_layer.unwrap();
    let before_pixel = pixel(&editor, layer.0, 4, 4);
    let before_hash = editor.content_hash().unwrap();
    let before_layers = layer_ids(&editor);
    let before_past = past(&editor);

    let info = editor.begin_direct_adjustment("brightnessContrast", json!({"brightness": 60}), None).unwrap();
    assert_eq!(info["mode"], "pixels");
    assert_eq!(info["kind"], "brightnessContrast");
    assert_eq!(info["command"], "image.adjustments.brightnessContrast");
    assert_eq!(info["layer"], layer.0);
    // 预览不改名册指纹，也不改历史。
    assert_eq!(editor.content_hash().unwrap(), before_hash);
    assert_eq!(past(&editor), before_past);

    let preview = editor.preview_adjustment(json!({"brightness": 90})).unwrap();
    assert_eq!(preview["params"]["brightness"], 90);
    assert_eq!(editor.content_hash().unwrap(), before_hash, "预览不写正式文档");

    editor.commit_adjustment().unwrap();
    assert_eq!(past(&editor), before_past + 1, "直接调整确认只增加一步历史");
    assert_eq!(layer_ids(&editor), before_layers, "直接调整不新增图层");
    assert_ne!(editor.content_hash().unwrap(), before_hash, "像素被真实改写");
    let after_pixel = pixel(&editor, layer.0, 4, 4);
    assert!(after_pixel[0] > before_pixel[0] && after_pixel[2] > before_pixel[2], "{after_pixel:?}");
    assert_eq!(editor.session.active().unwrap().active_layer, Some(layer), "活动层保持在被调整的像素层");

    // 撤销回到原始像素与原始指纹。
    editor.execute("edit.undo", Value::Null).unwrap();
    assert_eq!(editor.content_hash().unwrap(), before_hash);
    assert_eq!(pixel(&editor, layer.0, 4, 4), before_pixel);
    editor.execute("edit.redo", Value::Null).unwrap();
    assert_eq!(pixel(&editor, layer.0, 4, 4), after_pixel);
}

#[test]
fn adjustment_layer_path_edits_the_recomposable_layer_and_keeps_the_kind() {
    let mut editor = Editor::new();
    editor.execute("file.new", json!({"width": 16, "height": 16})).unwrap();
    let pixels = editor.session.active().unwrap().active_layer.unwrap();
    let before_pixel = pixel(&editor, pixels.0, 2, 2);
    let before_past = past(&editor);

    editor.execute("layer.newAdjustmentLayer.curves", Value::Null).unwrap();
    let adjustment = editor.session.active().unwrap().active_layer.unwrap();
    assert_ne!(adjustment, pixels);
    let info = editor.begin_adjustment(adjustment.0).unwrap();
    assert_eq!(info["mode"], "adjustmentLayer");
    assert_eq!(info["kind"], "curves");
    editor.preview_adjustment(json!({"points": [[0, 0], [50, 120], [255, 255]]})).unwrap();
    editor.commit_adjustment().unwrap();

    assert_eq!(pixel(&editor, pixels.0, 2, 2), before_pixel, "调整层不改原像素");
    assert!(layer_ids(&editor).contains(&adjustment.0), "调整层仍可重编");
    let layer = editor.session.active().unwrap().doc.layer(adjustment).unwrap();
    let photocraft_doc::LayerContent::Adjustment(adjustment_value) = &layer.content else { panic!("仍是调整层") };
    assert!(!matches!(adjustment_value, photocraft_doc::Adjustment::Unsupported { .. }));
    assert!(past(&editor) > before_past);
}

#[test]
fn the_same_draft_slot_serves_both_targets_but_only_one_at_a_time() {
    let mut editor = Editor::new();
    editor.execute("file.new", json!({"width": 8, "height": 8})).unwrap();
    editor.begin_direct_adjustment("brightnessContrast", json!({"brightness": 20}), None).unwrap();
    // 草稿进行中不能再开始第二个（无论直接调整还是调整层）。
    assert!(editor.begin_direct_adjustment("brightnessContrast", json!({"brightness": 30}), None).is_err());
    let layer = editor.session.active().unwrap().active_layer.unwrap();
    let before_pixel = pixel(&editor, layer.0, 1, 1);
    assert!(editor.begin_adjustment(layer.0).is_err());
    // 保存与关闭也受同一道草稿门禁保护。
    assert!(editor.save_project().is_err(), "草稿未结算不能保存");
    editor.cancel_adjustment();
    assert_eq!(pixel(&editor, layer.0, 1, 1), before_pixel, "取消不改像素");
    assert!(editor.save_project().is_ok());
}

#[test]
fn invalid_input_keeps_the_draft_uncommittable_and_cancel_restores_the_document() {
    let mut editor = Editor::new();
    editor.execute("file.new", json!({"width": 12, "height": 12, "background": "#204060"})).unwrap();
    let layer = editor.session.active().unwrap().active_layer.unwrap();
    let before_hash = editor.content_hash().unwrap();

    editor.begin_direct_adjustment("levels", json!({"inBlack": 10, "gamma": 1.4, "inWhite": 240}), None).unwrap();
    // 类型不对才是错误（越界标量按上游字段语义夹紧，与 Photoshop 一致）。
    assert!(editor.preview_adjustment(json!({"inWhite": "240"})).is_err(), "非法类型让草稿失效");
    assert!(editor.preview_adjustment(json!({"eyedropper": {"point": "guess"}})).is_err(), "非法吸管同样失效");
    // 上一份成功预览不能被当成最后一版提交。
    assert!(editor.commit_adjustment().is_err());
    assert_eq!(editor.content_hash().unwrap(), before_hash);
    // 修正后可以继续并提交。
    editor.preview_adjustment(json!({"inWhite": 200})).unwrap();
    editor.commit_adjustment().unwrap();
    assert_ne!(editor.content_hash().unwrap(), before_hash);

    // 取消恢复：任何预览都不落到正式文档。
    let committed = editor.content_hash().unwrap();
    let committed_pixel = pixel(&editor, layer.0, 0, 0);
    editor.begin_direct_adjustment("brightnessContrast", json!({"brightness": -50}), None).unwrap();
    editor.cancel_adjustment();
    assert_eq!(editor.content_hash().unwrap(), committed);
    assert_eq!(pixel(&editor, layer.0, 0, 0), committed_pixel);
}

#[test]
fn only_writable_pixel_targets_and_open_commands_can_start_a_draft() {
    let mut editor = Editor::new();
    editor.execute("file.new", json!({"width": 16, "height": 16})).unwrap();
    let raster = editor.session.active().unwrap().active_layer.unwrap();

    // 参数里的 `layer`/`target` 不能改写目标；目标必须真实存在。
    assert!(editor.begin_direct_adjustment("brightnessContrast", json!({"layer": raster.0}), None).is_err());
    assert!(editor.begin_direct_adjustment("brightnessContrast", json!({"target": "mask"}), None).is_err());
    assert!(editor.begin_direct_adjustment("brightnessContrast", json!({"brightness": 10}), Some(u64::MAX)).is_err());
    // 未实现的类型、以及本域实现但未进命令门的类型。
    assert!(editor.begin_direct_adjustment("colorLookup", json!({}), None).is_err());
    assert!(editor.begin_direct_adjustment("hdrToning", json!({}), None).is_err());
    assert!(editor.begin_direct_adjustment("image.adjustments.colorLookup", json!({}), None).is_err());
    // 文字层不是可写像素目标：必须先栅格化。
    editor.execute("type.create", json!({"text": "字", "x": 2, "y": 2})).unwrap();
    let text = editor.session.active().unwrap().active_layer.unwrap();
    assert!(editor.begin_direct_adjustment("brightnessContrast", json!({"brightness": 10}), Some(text.0)).is_err());
    // 锁定像素的层直接拒绝。
    editor.execute("layer.setProps", json!({"layer": raster.0, "locks": {"pixels": true}})).unwrap();
    assert!(editor.begin_direct_adjustment("brightnessContrast", json!({"brightness": 10}), Some(raster.0)).is_err());
}

#[test]
fn every_reported_target_matches_the_command_gate() {
    let editor = Editor::new();
    let targets = editor.direct_adjustment_targets();
    let kinds: Vec<&str> = targets["allKinds"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
    let commands: Vec<&str> = targets["allCommands"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
    let open_kinds: Vec<&str> = targets["kinds"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
    let open_commands: Vec<&str> = targets["commands"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
    // 界面只渲染真实可开始的入口。
    for kind in &open_kinds {
        assert!(kinds.contains(kind), "{kind}");
        assert!(crate::capability::command_allowed(&format!("image.adjustments.{kind}")), "{kind}");
    }
    for command in &open_commands {
        assert!(commands.contains(command), "{command}");
        assert!(crate::capability::command_allowed(command), "{command}");
    }
    for kind in kinds.iter().filter(|kind| !open_kinds.contains(kind)) {
        assert!(!crate::capability::command_allowed(&format!("image.adjustments.{kind}")), "{kind}");
    }
    for command in commands.iter().filter(|command| !open_commands.contains(command)) {
        assert!(!crate::capability::command_allowed(command), "{command}");
    }
}

#[test]
fn reported_documents_follow_the_kernel_session_not_a_shared_view_model() {
    // 匹配颜色的来源清单必须来自内核会话本身：打开/切换文档后索引与 active 都要跟着变。
    let mut editor = Editor::new();
    editor.execute("file.new", json!({"width": 8, "height": 8})).unwrap();
    editor.execute("file.new", json!({"width": 12, "height": 6})).unwrap();
    let targets = editor.direct_adjustment_targets();
    let documents = targets["documents"].as_array().unwrap();
    assert_eq!(documents.len(), 2);
    assert_eq!(documents[0]["index"], 0);
    assert_eq!(documents[0]["active"], false);
    assert_eq!(documents[1]["index"], 1);
    assert_eq!(documents[1]["active"], true);
    assert_eq!(documents[1]["width"], 12);
    assert_eq!(documents[1]["height"], 6);
    assert!(documents[1]["name"].as_str().is_some(), "来源下拉要能显示文档名");
    // 关闭后一份文档，清单与 active 同步收缩。
    editor.execute("file.close", Value::Null).unwrap();
    let targets = editor.direct_adjustment_targets();
    let documents = targets["documents"].as_array().unwrap();
    assert_eq!(documents.len(), 1);
    assert_eq!(documents[0]["active"], true);
}

#[test]
fn selection_bounds_the_direct_adjustment_and_outside_pixels_stay_untouched() {
    let mut editor = Editor::new();
    editor.execute("file.new", json!({"width": 24, "height": 16, "background": "#3060a0"})).unwrap();
    let layer = editor.session.active().unwrap().active_layer.unwrap();
    let outside = pixel(&editor, layer.0, 1, 1);
    let inside_index = (8, 8);
    let inside_before = pixel(&editor, layer.0, inside_index.0, inside_index.1);
    editor.execute("select.rect", json!({"x": 4, "y": 4, "width": 10, "height": 8})).unwrap();

    editor.begin_direct_adjustment("brightnessContrast", json!({"brightness": 80}), None).unwrap();
    editor.commit_adjustment().unwrap();

    assert_eq!(pixel(&editor, layer.0, 1, 1), outside, "选区外的像素不能被直接调整改写");
    let inside_after = pixel(&editor, layer.0, inside_index.0, inside_index.1);
    assert_ne!(inside_after, inside_before, "选区内的像素被真实调整");
    // 选区本身不因调整而清除，也不进入内容身份。
    assert!(editor.session.active().unwrap().doc.selection.is_some());
}

#[test]
fn a_preview_that_matches_the_document_adds_no_history_step() {
    let mut editor = Editor::new();
    editor.execute("file.new", json!({"width": 12, "height": 12, "background": "#204060"})).unwrap();
    let layer = editor.session.active().unwrap().active_layer.unwrap();
    let before_hash = editor.content_hash().unwrap();
    let before_past = past(&editor);
    let before_pixel = pixel(&editor, layer.0, 3, 3);

    // 默认参数即恒等调整：预览与正式文档一致，确认不能凭空多一步历史。
    editor.begin_direct_adjustment("brightnessContrast", json!({"brightness": 0, "contrast": 0}), None).unwrap();
    editor.commit_adjustment().unwrap();
    assert_eq!(editor.content_hash().unwrap(), before_hash, "无变化的直接调整不改内容指纹");
    assert_eq!(past(&editor), before_past, "无变化的直接调整不增历史");
    assert_eq!(pixel(&editor, layer.0, 3, 3), before_pixel);
}

#[test]
fn a_single_channel_curve_only_changes_its_own_channel() {
    let mut editor = Editor::new();
    editor.execute("file.new", json!({"width": 8, "height": 8, "background": "#808080"})).unwrap();
    let layer = editor.session.active().unwrap().active_layer.unwrap();
    let before = pixel(&editor, layer.0, 3, 3);

    editor
        .begin_direct_adjustment(
            "curves",
            json!({"points": [[0, 0], [255, 255]], "red": [[0, 0], [128, 200], [255, 255]]}),
            None,
        )
        .unwrap();
    editor.commit_adjustment().unwrap();

    let after = pixel(&editor, layer.0, 3, 3);
    assert!(after[0] > before[0], "R 曲线抬高红通道：{after:?}");
    assert_eq!([after[1], after[2]], [before[1], before[2]], "G/B 通道不受 R 曲线影响");
}

#[test]
fn a_single_hue_range_only_touches_pixels_in_that_range() {
    let adjust = |background: &str| {
        let mut editor = Editor::new();
        editor.execute("file.new", json!({"width": 8, "height": 8, "background": background})).unwrap();
        let layer = editor.session.active().unwrap().active_layer.unwrap();
        let before = pixel(&editor, layer.0, 2, 2);
        editor
            .begin_direct_adjustment("hueSaturation", json!({"reds": {"saturation": -100}}), None)
            .unwrap();
        editor.commit_adjustment().unwrap();
        (before, pixel(&editor, layer.0, 2, 2))
    };
    let (red_before, red_after) = adjust("#ff0000");
    assert_ne!(red_after, red_before, "红色像素落在「红」色域，被真实改变");
    let (blue_before, blue_after) = adjust("#0000ff");
    assert_eq!(blue_after, blue_before, "蓝色像素不在「红」色域，不能受影响");
}

#[test]
fn parameters_survive_save_and_reopen_for_the_direct_path() {
    let mut editor = Editor::new();
    editor.execute("file.new", json!({"width": 16, "height": 16, "background": "#446688"})).unwrap();
    editor.begin_direct_adjustment("curves", json!({"points": [[0, 0], [128, 200], [255, 255]]}), None).unwrap();
    editor.commit_adjustment().unwrap();
    let saved_pixel = {
        let layer = editor.session.active().unwrap().active_layer.unwrap();
        pixel(&editor, layer.0, 5, 5)
    };
    let bytes = editor.save_project().unwrap();
    let hash = editor.content_hash().unwrap();

    let mut reopened = Editor::new();
    reopened.open_project(&bytes, None).unwrap();
    assert_eq!(reopened.content_hash().unwrap(), hash, "直接调整后的像素进入内容指纹");
    let layer = reopened.session.active().unwrap().active_layer.unwrap();
    assert_eq!(pixel(&reopened, layer.0, 5, 5), saved_pixel);
}

#[test]
fn adjustment_layer_output_endpoints_and_hue_ranges_really_commit() {
    // 只改「输出端点」或只改某个色域：这些是 U41/U42 新增的持久参数，不能被当成「无变化」丢弃。
    let mut editor = Editor::new();
    editor.execute("file.new", json!({"width": 16, "height": 16, "background": "#808080"})).unwrap();
    editor.execute("layer.newAdjustmentLayer.levels", Value::Null).unwrap();
    let layer = editor.session.active().unwrap().active_layer.unwrap();
    let before = past(&editor);
    editor.begin_adjustment(layer.0).unwrap();
    editor.preview_adjustment(json!({"outWhite": 180})).unwrap();
    editor.commit_adjustment().unwrap();
    assert_eq!(past(&editor), before + 1, "输出端点改动必须成为一步历史");
    let stored = editor.session.active().unwrap().doc.layer(layer).unwrap();
    let photocraft_doc::LayerContent::Adjustment(adjustment) = &stored.content else { panic!("仍是调整层") };
    let photocraft_doc::Adjustment::Levels { master, .. } = adjustment else { panic!("仍是色阶") };
    // 存储是 0–1，参数语义是 0–255 级：180 级 → 约 0.7059。
    assert!((master.out_white * 255.0 - 180.0).abs() < 0.5, "输出端点必须真的写进调整层");

    let mut editor = Editor::new();
    editor.execute("file.new", json!({"width": 16, "height": 16, "background": "#808080"})).unwrap();
    editor.execute("layer.newAdjustmentLayer.hueSaturation", Value::Null).unwrap();
    let layer = editor.session.active().unwrap().active_layer.unwrap();
    let before = past(&editor);
    editor.begin_adjustment(layer.0).unwrap();
    editor.preview_adjustment(json!({"reds": {"saturation": -40}})).unwrap();
    editor.commit_adjustment().unwrap();
    assert_eq!(past(&editor), before + 1, "单色域改动必须成为一步历史");
}

#[test]
fn a_null_patch_clears_an_optional_key_instead_of_being_ignored() {
    // 界面切回「当前图像」或取消某项可选参数时只能发 `null`：增量合并下省略键会保留旧值。
    let mut editor = Editor::new();
    editor.execute("file.new", json!({"width": 16, "height": 16, "background": "#808080"})).unwrap();
    editor.begin_direct_adjustment("levels", json!({"inBlack": 10}), None).unwrap();
    let info = editor.preview_adjustment(json!({"eyedropper": {"point": "black", "color": [0.2, 0.2, 0.2]}})).unwrap();
    assert!(info["params"].get("eyedropper").is_some(), "先写入的可选键必须在草稿里");
    let info = editor.preview_adjustment(json!({"eyedropper": null})).unwrap();
    assert!(info["params"].get("eyedropper").is_none(), "null 必须清除该键，而不是被增量合并忽略");
    assert_eq!(info["params"]["inBlack"], 10.0, "清除只影响被点名的键");
    editor.commit_adjustment().unwrap();
    // 空补丁仍然是非法的：不能靠发 `{}` 绕过参数校验。
    editor.begin_direct_adjustment("levels", json!({"inBlack": 10}), None).unwrap();
    assert!(editor.preview_adjustment(json!({})).is_err());
    editor.cancel_adjustment();
}
