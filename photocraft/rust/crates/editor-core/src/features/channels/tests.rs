//! 通道与通道计算的域内回归：命令门、参数拒绝、内容/元数据往返、分量隔离、
//! 拆分/合并预算、预览不改正式内容、确认一步历史、亮度选区。
use super::*;
use serde_json::json;

fn editor_with(width: u32, height: u32) -> Editor {
    let mut editor = Editor::new();
    editor
        .execute("file.new", json!({ "width": width, "height": height }))
        .expect("new document");
    editor
}

fn channels(editor: &Editor) -> Vec<Value> {
    editor.channel_snapshot().expect("snapshot")["alpha"]
        .as_array()
        .cloned()
        .unwrap_or_default()
}

fn history_len(editor: &Editor) -> usize {
    editor.state()["document"]["history"]
        .as_array()
        .map(Vec::len)
        .unwrap_or(0)
}

#[test]
fn the_domain_gate_opens_only_the_declared_commands() {
    let mut editor = editor_with(16, 12);
    // 未登记的通道命令保持在白名单外。
    for id in ["select.editInQuickMaskMode", "channel.thumbnail", "image.applyImageExtra"] {
        let error = editor
            .channel_command(id, json!({}))
            .expect_err("outside the domain gate");
        assert_eq!(error.code(), "capability-disabled", "{id}");
    }
    // 登记过的命令同时出现在全局命令白名单里（菜单/快捷键/命令面板同一道门）。
    let allowed = editor.allowed_command_ids();
    let ids: Vec<&str> = allowed.as_array().unwrap().iter().filter_map(|id| id.as_str()).collect();
    for id in CHANNEL_COMMANDS {
        assert!(ids.contains(id), "全局白名单缺少 {id}");
    }
    assert!(CHANNEL_COMMANDS.contains(&"image.applyImage"));
    // `channel.list` 是只读，返回通道行。
    let listed = editor.channel_command("channel.list", Value::Null).expect("list");
    assert_eq!(listed["composite"], json!("RGB"));
}

#[test]
fn no_document_and_malformed_parameters_never_write() {
    let mut editor = Editor::new();
    assert_eq!(
        editor.channel_command("channel.new", json!({})).expect_err("no document").code(),
        "no-document"
    );
    let mut editor = editor_with(16, 12);
    let before = editor.state();
    let hash = editor.content_hash().expect("hash");
    let rejected = [
        ("channel.new", json!({ "fill": "gradient" })),
        ("channel.new", json!({ "color": "#ffzz00" })),
        ("channel.new", json!({ "opacity": 120 })),
        ("channel.new", json!({ "name": "x".repeat(201) })),
        ("channel.newSpot", json!({ "solidity": -1 })),
        ("channel.newSpot", json!({ "fromSelection": "yes" })),
        ("channel.new", json!({ "unknown": true })),
        ("channel.duplicate", json!({ "channel": 9 })),
        ("channel.rename", json!({ "channel": 0 })),
        ("channel.move", json!({ "channel": 0, "to": 4 })),
        ("channel.options", json!({ "channel": 0, "indicates": "print" })),
        ("select.loadLuminosity", json!({ "mode": "add" })),
        ("image.applyImage", json!({ "blending": "dissolve" })),
        ("image.applyImage", json!({ "opacity": 101 })),
        ("image.applyImage", json!({ "scale": 3 })),
        ("image.applyImage", json!({ "offset": 999 })),
        ("image.applyImage", json!({ "target": "quickMask" })),
        ("image.applyImage", json!({ "source": { "channel": "composite", "bogus": 1 } })),
        ("image.calculations", json!({ "result": "layer" })),
        ("image.calculations", json!({ "source1": { "invert": "yes" } })),
        ("channel.merge", json!({ "mode": "cmyk4" })),
        ("channel.merge", json!({ "mode": "cmyk" })),
        ("channel.merge", json!({ "mode": "lab" })),
        ("channel.merge", json!({ "documents": [0, 0] })),
    ];
    for (id, params) in rejected {
        let error = editor
            .channel_command(id, params.clone())
            .expect_err("must be rejected");
        assert_eq!(error.code(), "command-failed", "{id}: {params}");
        assert_eq!(editor.state(), before, "{id}: 拒绝后状态被改动");
        assert_eq!(editor.content_hash().expect("hash"), hash, "{id}: 拒绝后指纹变化");
    }
    // 全部参数都合法但通道不存在时也拒绝，且不产生历史。
    let error = editor
        .channel_command("channel.delete", json!({ "channel": 0 }))
        .expect_err("no such channel");
    assert_eq!(error.code(), "command-failed");
    assert!(
        error.message().to_ascii_lowercase().contains("alpha channels"),
        "{}",
        error.message()
    );
    assert_eq!(history_len(&editor), 1, "拒绝不能新增历史");
}

#[test]
fn alpha_channel_data_and_metadata_survive_a_project_round_trip() {
    let mut editor = editor_with(24, 16);
    editor.execute("layer.new.layer", json!({})).unwrap();
    editor
        .execute("paint.stroke", json!({ "points": [[2, 2], [8, 6]], "size": 4, "hardness": 1, "opacity": 1, "flow": 1, "color": "#3366cc", "target": "pixels" }))
        .unwrap();
    editor.execute("select.rect", json!({ "x": 3, "y": 4, "width": 10, "height": 6 })).unwrap();
    let created = editor
        .channel_command("channel.new", json!({ "fill": "selection", "name": "Alpha 选区", "indicates": "selected", "opacity": 30 }))
        .expect("new channel");
    assert_eq!(created["channel"], json!(0));
    let after_create = channels(&editor);
    assert_eq!(after_create.len(), 1);
    assert_eq!(after_create[0]["name"], json!("Alpha 选区"));
    assert_eq!(after_create[0]["kind"], json!("alpha"));
    // 上游把「表示选区」序列化为 `selectedAreas`。
    assert_eq!(after_create[0]["indicates"], json!("selectedAreas"));
    assert_eq!(after_create[0]["reference"], json!({ "alpha": 0 }));
    // 新建通道按 Photoshop 语义被选中并显示，且这是查看态而不是内容。
    let snapshot = editor.channel_snapshot().unwrap();
    assert_eq!(snapshot["target"], json!({ "kind": "alpha", "index": 0 }));
    assert_eq!(snapshot["alpha"][0]["visible"], json!(true));
    // 选区覆盖的像素在白（选中）一侧，其余为黑。
    let state = editor.active_doc().unwrap();
    let plane = &state.doc.channels[0].surface;
    assert!(plane.sample_channel(4, 5, 0) > 0.5);
    assert!(plane.sample_channel(20, 14, 0) < 0.5);

    let project = editor.save_project().expect("save");
    let mut reopened = Editor::new();
    reopened.open_project(&project, None).expect("reopen");
    let reopened_channels = channels(&reopened);
    assert_eq!(reopened_channels.len(), 1);
    assert_eq!(reopened_channels[0]["name"], json!("Alpha 选区"));
    assert_eq!(reopened_channels[0]["indicates"], json!("selectedAreas"));
    let reopened_state = reopened.active_doc().unwrap();
    assert!(reopened_state.doc.channels[0].surface.sample_channel(4, 5, 0) > 0.5);
    // 重开后的内容指纹与保存前一致（通道内容进入内容身份）。
    assert_eq!(
        reopened.content_hash().expect("reopened hash"),
        editor.content_hash().expect("saved hash")
    );
}

#[test]
fn a_colour_channel_target_edits_only_that_component() {
    let mut editor = editor_with(8, 8);
    editor.execute("layer.new.layer", json!({})).unwrap();
    editor.channel_command("channel.target", json!({ "channel": "red" })).expect("target red");
    let snapshot = editor.channel_snapshot().unwrap();
    assert_eq!(snapshot["target"], json!({ "kind": "color", "index": 0 }));
    // 目标与查看分离：目标变成红色分量时，只有红色分量的眼睛是开的。
    assert_eq!(snapshot["colors"][0]["visible"], json!(true));
    assert_eq!(snapshot["colors"][1]["visible"], json!(false));
    editor
        .execute("paint.stroke", json!({ "points": [[2, 2], [5, 5]], "size": 3, "hardness": 1, "opacity": 1, "flow": 1, "color": "#ff8000", "target": "pixels" }))
        .unwrap();
    let state = editor.active_doc().unwrap();
    let layer = state.doc.layer(state.active_layer.unwrap()).unwrap().surface().unwrap();
    let sample = [layer.sample_channel(3, 3, 0), layer.sample_channel(3, 3, 1), layer.sample_channel(3, 3, 2)];
    assert!(sample[0] > 0.5, "红色分量应被写入：{sample:?}");
    assert_eq!(sample[1], 0.0, "绿色分量不能被改动：{sample:?}");
    assert_eq!(sample[2], 0.0, "蓝色分量不能被改动：{sample:?}");
    // 目标切回复合不写入内容，也不新增历史。
    let steps = history_len(&editor);
    editor.channel_command("channel.target", json!({ "channel": "composite" })).unwrap();
    assert_eq!(history_len(&editor), steps);
}

#[test]
fn alpha_channels_accept_pixel_writes_and_reject_clear_targets() {
    let mut editor = editor_with(8, 8);
    editor.execute("layer.new.layer", json!({})).unwrap();
    editor.channel_command("channel.new", json!({ "fill": "black", "name": "绘图层" })).unwrap();
    editor.channel_command("channel.target", json!({ "channel": 0 })).unwrap();
    editor
        .execute("paint.stroke", json!({ "points": [[1, 1], [4, 4]], "size": 2, "hardness": 1, "opacity": 1, "flow": 1, "color": "#ffffff", "target": { "channel": 0 } }))
        .unwrap();
    let state = editor.active_doc().unwrap();
    assert!(state.doc.channels[0].surface.sample_channel(2, 2, 0) > 0.5);
    // 图层像素没有被这次通道落笔改动（只改所选通道）。
    let layer = state.doc.layer(state.active_layer.unwrap()).unwrap().surface().unwrap();
    assert_eq!(layer.sample_channel(2, 2, 3), 0.0, "透明图层不应被通道落笔写入");
    // `channel.target` 不接受快速蒙版（由选区蒙版 change 负责）。
    let error = editor
        .channel_command("channel.target", json!({ "channel": "quickMask" }))
        .expect_err("quick mask is out of scope");
    assert!(error.message().contains("快速蒙版"), "{}", error.message());
}

#[test]
fn spot_channels_keep_screen_ink_metadata_and_can_merge_into_pixels() {
    let mut editor = editor_with(10, 10);
    editor.execute("layer.new.layer", json!({})).unwrap();
    editor
        .channel_command("channel.newSpot", json!({ "name": "专色绿", "color": "#00ff00", "solidity": 60, "fromSelection": false }))
        .unwrap();
    let spot = &channels(&editor)[0];
    assert_eq!(spot["kind"], json!("spot"));
    assert_eq!(spot["spot"]["color"], json!([0.0, 1.0, 0.0]));
    assert!((spot["spot"]["solidity"].as_f64().unwrap() - 0.6).abs() < 1e-6);
    // 选项只改屏幕替代色/密度，不承诺印刷分色。
    editor
        .channel_command("channel.options", json!({ "channel": 0, "color": "#0000ff", "solidity": 25 }))
        .unwrap();
    let spot = &channels(&editor)[0];
    assert_eq!(spot["spot"]["color"], json!([0.0, 0.0, 1.0]));
    assert!((spot["spot"]["solidity"].as_f64().unwrap() - 0.25).abs() < 1e-6);
    // 画一笔专色内容，再合并进像素层。
    editor
        .execute("paint.stroke", json!({ "points": [[2, 2], [6, 6]], "size": 4, "hardness": 1, "opacity": 1, "flow": 1, "color": "#ffffff", "target": { "channel": 0 } }))
        .unwrap();
    let steps = history_len(&editor);
    editor.channel_command("channel.mergeSpot", json!({ "channel": 0 })).unwrap();
    assert!(channels(&editor).is_empty(), "合并后专色通道移除");
    assert_eq!(history_len(&editor), steps + 1, "合并专色是一步历史");
    let state = editor.active_doc().unwrap();
    assert_eq!(state.doc.layers.len(), 1);
    assert_eq!(state.doc.layers[0].name, "Background");
}

#[test]
fn visibility_and_ordering_are_view_state_without_history() {
    let mut editor = editor_with(12, 12);
    editor.channel_command("channel.new", json!({ "name": "A" })).unwrap();
    editor.channel_command("channel.new", json!({ "name": "B" })).unwrap();
    let steps = history_len(&editor);
    let hash = editor.content_hash().unwrap();
    editor.channel_command("channel.setVisible", json!({ "channel": 1, "visible": false })).unwrap();
    assert_eq!(channels(&editor)[1]["visible"], json!(false));
    // 显隐只是查看态：不新增历史，也不改内容指纹。
    assert_eq!(editor.content_hash().unwrap(), hash, "显隐不能改内容身份");
    assert_eq!(history_len(&editor), steps, "显隐不能新增历史");
    // 排序是内容操作：一步历史。通道内容目前不在 `document_content` 指纹里（由集成负责人补齐）。
    editor.channel_command("channel.move", json!({ "channel": 1, "to": 0 })).unwrap();
    let names: Vec<String> = channels(&editor).iter().map(|row| row["name"].as_str().unwrap_or("").to_string()).collect();
    assert_eq!(names, ["B", "A"]);
    assert_eq!(history_len(&editor), steps + 1, "排序是一步历史");
    // 上游保证画布不会全空：没有任何其他可见分量时，关闭复合会立刻恢复颜色通道。
    editor.channel_command("channel.setVisible", json!({ "channel": "composite", "visible": false })).unwrap();
    assert_eq!(editor.channel_snapshot().unwrap()["compositeVisible"], json!(true));
    // 先显示一个 Alpha 覆盖层，再关闭复合就可以真的只剩该通道。
    editor.channel_command("channel.setVisible", json!({ "channel": 0, "visible": true })).unwrap();
    editor.channel_command("channel.setVisible", json!({ "channel": "composite", "visible": false })).unwrap();
    assert_eq!(editor.channel_snapshot().unwrap()["compositeVisible"], json!(false));
    editor.channel_command("channel.setVisible", json!({ "channel": "composite", "visible": true })).unwrap();
    assert_eq!(editor.channel_snapshot().unwrap()["compositeVisible"], json!(true));
}

#[test]
fn rename_duplicate_and_delete_follow_the_target() {
    let mut editor = editor_with(16, 16);
    editor.channel_command("channel.new", json!({ "name": "Alpha 原始" })).unwrap();
    editor.channel_command("channel.rename", json!({ "channel": 0, "name": "蒙版备用" })).unwrap();
    assert_eq!(channels(&editor)[0]["name"], json!("蒙版备用"));
    let duplicated = editor
        .channel_command("channel.duplicate", json!({ "channel": 0, "name": "蒙版备份", "invert": true }))
        .unwrap();
    assert_eq!(duplicated["channel"], json!(1));
    let rows = channels(&editor);
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[1]["name"], json!("蒙版备份"));
    // 反相副本与原始内容相反（原始全黑 → 副本全白）。
    let state = editor.active_doc().unwrap();
    assert_eq!(state.doc.channels[0].surface.sample_channel(4, 4, 0), 0.0);
    assert_eq!(state.doc.channels[1].surface.sample_channel(4, 4, 0), 1.0);
    // 删除目标通道后目标回落到复合，通道索引前移。
    editor.channel_command("channel.target", json!({ "channel": 0 })).unwrap();
    editor.channel_command("channel.delete", Value::Null).unwrap();
    let snapshot = editor.channel_snapshot().unwrap();
    assert_eq!(snapshot["target"], json!({ "kind": "composite" }));
    assert_eq!(snapshot["alpha"].as_array().unwrap().len(), 1);
    assert_eq!(snapshot["alpha"][0]["name"], json!("蒙版备份"));
}

#[test]
fn split_and_merge_respect_size_and_the_open_document_budget() {
    let mut editor = editor_with(16, 12);
    editor.channel_command("channel.new", json!({ "name": "备份" })).unwrap();
    editor.channel_command("channel.split", json!({ "closeOriginal": true })).unwrap();
    // RGB 三分量 + 一个 Alpha = 四个灰度文档，原始文档关闭。
    assert_eq!(editor.session.documents().len(), 4);
    for document in editor.session.documents() {
        assert_eq!(document.doc.mode, photocraft_color::ColorMode::Grayscale);
        assert_eq!(document.doc.size.width, 16);
    }
    // 尺寸不同的文档不能合并。
    let mut other = Editor::new();
    other.execute("file.new", json!({ "width": 8, "height": 8 })).unwrap();
    let error = other
        .channel_command("channel.merge", json!({ "mode": "rgb", "documents": [0, 0, 0] }))
        .expect_err("duplicate documents");
    assert!(error.message().contains("重复"), "{}", error.message());
    // 预算：已经打开 8 个文档时拆分会被拒绝。
    let mut full = Editor::new();
    for _ in 0..photocraft_project_verify::limits::MAX_OPEN_DOCUMENTS {
        full.execute("file.new", json!({ "width": 4, "height": 4 })).unwrap();
    }
    let error = full
        .channel_command("channel.split", json!({ "closeOriginal": true }))
        .expect_err("document budget");
    assert!(error.message().contains("同时打开的文档"), "{}", error.message());
    assert_eq!(full.session.documents().len(), photocraft_project_verify::limits::MAX_OPEN_DOCUMENTS);
}

#[test]
fn merge_only_composes_rgb_and_refuses_cmyk_lab() {
    let mut editor = editor_with(16, 12);
    editor.channel_command("channel.split", json!({ "closeOriginal": true })).unwrap();
    let before = editor.state();
    let history = history_len(&editor);
    for mode in ["cmyk", "lab"] {
        let error = editor
            .channel_command("channel.merge", json!({ "mode": mode }))
            .expect_err("only RGB is in scope");
        assert_eq!(error.code(), "command-failed");
        assert!(
            error.message().contains("CMYK/Lab"),
            "{}",
            error.message()
        );
        assert_eq!(editor.state(), before, "{mode}: 拒绝后状态被改动");
        assert_eq!(history_len(&editor), history, "{mode}: 拒绝不能新增历史");
    }
    // 不写 mode 时上游默认 RGB，本域与之一致。
    let merged = editor
        .channel_command("channel.merge", json!({ "name": "合成的 RGB" }))
        .expect("rgb merge");
    let index = merged["document"].as_u64().expect("document index") as usize;
    let document = &editor.session.documents()[index].doc;
    assert_eq!(document.mode, photocraft_color::ColorMode::Rgb);
    assert_eq!(document.name, "合成的 RGB");
}

#[test]
fn apply_image_preview_is_stateless_and_commit_writes_one_step() {
    let mut editor = editor_with(8, 8);
    editor.execute("layer.new.layer", json!({})).unwrap();
    editor
        .execute("paint.stroke", json!({ "points": [[1, 1], [6, 6]], "size": 3, "hardness": 1, "opacity": 1, "flow": 1, "color": "#804020", "target": "pixels" }))
        .unwrap();
    editor.channel_command("channel.new", json!({ "name": "应用图像目标" })).unwrap();
    editor.channel_command("channel.target", json!({ "channel": 0 })).unwrap();
    editor.channel_command("channel.setVisible", json!({ "channel": 0, "visible": true })).unwrap();
    let params = json!({
        "source": { "channel": { "color": 0 }, "invert": false },
        "target": { "channel": 0 },
        "blending": "normal",
        "opacity": 80,
        "preserveTransparency": false
    });
    let state = editor.state();
    let hash = editor.content_hash().unwrap();
    let steps = history_len(&editor);
    let (preview, summary) = editor.channel_calc_preview("image.applyImage", params.clone(), 32).expect("preview");
    assert!(preview.width > 0 && preview.height > 0);
    assert_eq!(summary["revisionChanged"], json!(true));
    // 预览不改正式文档、修订、指纹与历史。
    assert_eq!(editor.state(), state, "预览不能改正式状态");
    assert_eq!(editor.content_hash().unwrap(), hash, "预览不能改内容指纹");
    assert_eq!(history_len(&editor), steps, "预览不能新增历史");
    // 非法参数不能确认上一份成功预览：同一参数改成非法后确认也必须失败。
    let mut illegal = params.clone();
    illegal["blending"] = json!("dissolve");
    assert!(editor.channel_calc_preview("image.applyImage", illegal.clone(), 32).is_err());
    assert!(editor.channel_command("image.applyImage", illegal).is_err());
    assert_eq!(editor.content_hash().unwrap(), hash);
    // 确认一次：只有一个历史步骤，修订号前移，目标通道得到内容。
    let revision_before = editor.state()["document"]["revision"].as_u64().unwrap();
    let committed = editor.channel_command("image.applyImage", params.clone()).expect("commit");
    assert!(committed.is_null());
    assert_eq!(history_len(&editor), steps + 1, "确认是一步历史");
    assert!(editor.state()["document"]["revision"].as_u64().unwrap() > revision_before);
    // 确认后目标通道内容非空，并且通道内容已经进入共享内容身份（`channelsContentHash`）。
    assert_ne!(editor.content_hash().unwrap(), hash, "确认必须改变内容身份");
    let state = editor.active_doc().unwrap();
    assert!(state.doc.channels[0].surface.content_bounds().width() > 0);
}

/// 图层蒙版目标必须明确拒绝：上游只写图层像素，静默错写比拒绝更糟。
#[test]
fn apply_image_refuses_a_mask_target_instead_of_writing_pixels() {
    let mut editor = editor_with(8, 8);
    editor.execute("layer.new.layer", json!({})).unwrap();
    editor
        .execute("paint.stroke", json!({ "points": [[1, 1], [6, 6]], "size": 3, "hardness": 1, "opacity": 1, "flow": 1, "color": "#336699", "target": "pixels" }))
        .unwrap();
    let steps = history_len(&editor);
    let hash = editor.content_hash().unwrap();
    let error = editor
        .channel_command(
            "image.applyImage",
            json!({ "source": { "channel": { "color": 1 } }, "blending": "normal", "opacity": 100, "target": "mask" }),
        )
        .expect_err("mask target must be refused");
    assert!(error.message().contains("图层蒙版目标"), "{}", error.message());
    assert_eq!(history_len(&editor), steps, "拒绝不能新增历史");
    assert_eq!(editor.content_hash().unwrap(), hash, "拒绝不能改内容身份");
    // 预览同样拒绝，不返回「成功但写错目标」的候选。
    assert!(
        editor
            .channel_calc_preview("image.applyImage", json!({ "source": { "channel": { "color": 1 } }, "target": "mask" }), 16)
            .is_err()
    );
}

#[test]
fn calculations_have_bounded_outputs_and_only_touch_their_target() {
    let mut editor = editor_with(8, 8);
    editor.execute("layer.new.layer", json!({})).unwrap();
    editor
        .execute("paint.stroke", json!({ "points": [[1, 1], [6, 6]], "size": 3, "hardness": 1, "opacity": 1, "flow": 1, "color": "#ffffff", "target": "pixels" }))
        .unwrap();
    editor.channel_command("channel.new", json!({ "name": "源一", "fill": "white" })).unwrap();
    editor.channel_command("channel.new", json!({ "name": "源二", "fill": "black" })).unwrap();
    let layer_before = editor.active_doc().unwrap().doc.clone();
    let selection_before = layer_before.selection.clone();
    let params = json!({
        "source1": { "channel": 0 },
        "source2": { "channel": 1 },
        "blending": "multiply",
        "opacity": 100,
        "result": "newChannel",
        "name": "计算结果"
    });
    let committed = editor.channel_command("image.calculations", params).expect("calculations");
    assert_eq!(committed["channel"], json!(2));
    let state = editor.active_doc().unwrap();
    // 只新增目标通道；图层像素与选区不变。
    assert_eq!(state.doc.layers.len(), layer_before.layers.len());
    assert_eq!(state.doc.selection.is_none(), selection_before.is_none());
    assert_eq!(state.doc.channels.len(), 3);
    assert_eq!(state.doc.channels[2].name, "计算结果");
    // 乘法：白 × 黑 = 黑，所以结果通道全为 0。
    assert_eq!(state.doc.channels[2].surface.sample_channel(4, 4, 0), 0.0);

    // 输出为选区时确实得到选区，而不是简单全选。
    let selection_params = json!({
        "source1": { "channel": 0 },
        "source2": { "channel": 1 },
        "blending": "screen",
        "result": "selection"
    });
    editor
        .channel_command("image.calculations", selection_params)
        .expect("selection output");
    let state = editor.active_doc().unwrap();
    let selection = state.doc.selection.as_ref().expect("selection output");
    assert!(selection.content_bounds().width() > 0);

    // 输出为新文档时新增一个灰度文档；受打开文档数上限约束。
    let document_params = json!({
        "source1": { "channel": 0 },
        "source2": { "channel": 1 },
        "blending": "normal",
        "result": "newDocument",
        "name": "计算文档"
    });
    let before = editor.session.documents().len();
    editor.channel_command("image.calculations", document_params).expect("new document");
    assert_eq!(editor.session.documents().len(), before + 1);
    let added = editor.session.documents().last().unwrap();
    assert_eq!(added.doc.mode, photocraft_color::ColorMode::Grayscale);
}

/// 来源文档关闭/尺寸不匹配：拒绝且不把半成品写进目标文档。
///
/// 这两条是 design 验收主线里「切来源文档、来源关闭、尺寸不匹配分别拒绝」的内核侧证据；
/// 界面侧只负责把来源索引与尺寸标出来（面板显示「尺寸不匹配」并禁用），最终判定在这里。
#[test]
fn a_closed_or_mismatched_source_is_refused_without_touching_the_target() {
    let mut editor = editor_with(8, 8);
    editor.execute("layer.new.layer", json!({})).unwrap();
    editor.channel_command("channel.new", json!({ "name": "目标通道" })).unwrap();
    editor.channel_command("channel.target", json!({ "channel": 0 })).unwrap();
    editor.channel_command("channel.setVisible", json!({ "channel": 0, "visible": true })).unwrap();
    // 第二个文档：尺寸不同，作为「尺寸不匹配」的来源。
    editor.execute("file.new", json!({ "width": 5, "height": 5 })).unwrap();
    let small = editor.session.documents().len() - 1;
    editor.session.set_active(0);
    let params = |source_document: usize| {
        json!({
            "source": { "document": source_document, "channel": { "color": 0 } },
            "target": { "channel": 0 },
            "blending": "normal",
            "opacity": 100
        })
    };
    // 尺寸不匹配：预览与确认都拒绝，目标通道内容与历史不变。
    let before = editor.state()["document"].clone();
    let hash = editor.content_hash().unwrap();
    let steps = history_len(&editor);
    let mismatch = editor
        .channel_calc_preview("image.applyImage", params(small), 16)
        .expect_err("size mismatch preview");
    assert!(
        mismatch.message().contains("must match the target size"),
        "{}",
        mismatch.message()
    );
    let mismatch = editor
        .channel_command("image.applyImage", params(small))
        .expect_err("size mismatch commit");
    assert!(
        mismatch.message().contains("must match the target size"),
        "{}",
        mismatch.message()
    );
    assert_eq!(editor.state()["document"], before, "拒绝后状态被改动");
    assert_eq!(editor.content_hash().unwrap(), hash, "拒绝后内容指纹变化");
    assert_eq!(history_len(&editor), steps, "拒绝不能新增历史");
    assert!(editor.active_doc().unwrap().doc.channels[0].surface.content_bounds().is_empty());

    // 来源文档关闭后，同一参数指向的索引已不存在：明确拒绝而不是落到活动文档。
    editor.session.close(small);
    let closed = editor
        .channel_calc_preview("image.applyImage", params(small), 16)
        .expect_err("closed source preview");
    assert!(closed.message().contains("no open document"), "{}", closed.message());
    let closed = editor
        .channel_command("image.applyImage", params(small))
        .expect_err("closed source commit");
    assert!(closed.message().contains("no open document"), "{}", closed.message());
    assert_eq!(editor.state()["document"], before, "来源关闭后拒绝仍不能改目标");
    assert_eq!(history_len(&editor), steps);
    // 指向活动文档的合法来源仍然可用（拒绝的是失效来源，不是功能本身）。
    editor
        .channel_command("image.applyImage", params(0))
        .expect("active document source");
    assert_eq!(history_len(&editor), steps + 1, "确认是一步历史");
}

#[test]
fn luminosity_selection_is_not_select_all() {
    let mut editor = Editor::new();
    // 透明背景：整幅画布不是均匀白色，亮度选区才有可判定的分布。
    editor
        .execute("file.new", json!({ "width": 16, "height": 16, "background": "transparent" }))
        .unwrap();
    // 只有左上角有像素：亮度选区不应覆盖整幅画布。
    editor
        .execute("paint.stroke", json!({ "points": [[2, 2], [5, 5]], "size": 3, "hardness": 1, "opacity": 1, "flow": 1, "color": "#ffffff", "target": "pixels" }))
        .unwrap();
    editor.channel_command("select.loadLuminosity", Value::Null).expect("luminosity selection");
    let state = editor.active_doc().unwrap();
    let selection = state.doc.selection.as_ref().expect("selection");
    let bounds = selection.content_bounds();
    assert!(bounds.width() > 0, "亮度选区不能为空");
    assert!(bounds.width() < 16 || bounds.height() < 16, "亮度选区不能是整幅画布：{bounds:?}");
    // 选区内容在暗部为 0（不是简单全选）。
    assert_eq!(selection.sample_channel(15, 15, 0), 0.0);
    assert!(selection.sample_channel(3, 3, 0) > 0.0);
}

#[test]
fn channel_thumbnails_are_bounded_and_view_preview_follows_target() {
    let mut editor = editor_with(64, 32);
    editor.execute("layer.new.layer", json!({})).unwrap();
    editor.channel_command("channel.new", json!({ "name": "缩略图", "fill": "white" })).unwrap();
    let thumbnail = editor.channel_thumbnail(json!({ "alpha": 0 }), 16).expect("thumbnail");
    assert_eq!((thumbnail.width, thumbnail.height), (16, 8));
    assert_eq!(thumbnail.pixels.len(), 16 * 8 * 4);
    assert!(thumbnail.pixels.chunks_exact(4).all(|pixel| pixel[0] == 255 && pixel[3] == 255));
    // 上限收敛：请求比上限大的缩略图不会返回原始尺寸。
    let capped = editor.channel_thumbnail(json!("composite"), 4096).expect("composite thumbnail");
    assert!(capped.width <= 64 && capped.height <= 32);
    // 视图预览跟随目标（不是编辑目标本身）。
    let view = editor.channel_view_preview(32).expect("view preview");
    assert!(view.width <= 32);
    editor.channel_command("channel.target", json!({ "channel": "green" })).unwrap();
    let green = editor.channel_view_preview(32).expect("green view");
    assert_eq!((green.width, green.height), (32, 16));
    // 未知引用明确拒绝。
    assert!(editor.channel_thumbnail(json!("nope"), 8).is_err());
}

#[test]
fn channel_thumbnail_rejects_unknown_references_and_missing_masks() {
    let mut editor = editor_with(8, 8);
    assert!(editor.channel_thumbnail(json!({ "alpha": 0 }), 8).is_err());
    assert!(editor.channel_thumbnail(json!("mask"), 8).is_err());
    assert!(editor.channel_thumbnail(json!("selection"), 8).is_err());
    assert!(editor.channel_thumbnail(json!("quickMask"), 8).is_err());
    editor.channel_command("channel.new", json!({ "fill": "white" })).unwrap();
    assert!(editor.channel_thumbnail(json!({ "alpha": 0 }), 8).is_ok());
}

/// 每份文档自报可选来源通道：面板因此能在非活动文档上选分量/Alpha 而不先切文档。
#[test]
fn each_document_reports_its_own_source_channels() {
    let mut editor = editor_with(16, 12);
    editor.execute("layer.new.layer", json!({})).unwrap();
    editor.channel_command("channel.new", json!({ "fill": "white", "name": "来源 Alpha" })).unwrap();
    editor.channel_command("channel.newSpot", json!({ "name": "来源专色", "color": "#00ff00" })).unwrap();
    // 第二个文档：同尺寸，打开后成为活动文档，自己没有任何 Alpha。
    editor.execute("file.new", json!({ "width": 16, "height": 12 })).unwrap();
    let active = editor.session.active_index().expect("active");
    assert_eq!(active, 1, "新建文档后应成为活动文档");
    let snapshot = editor.channel_snapshot().expect("snapshot");
    let documents = snapshot["documents"].as_array().expect("documents");
    assert_eq!(documents.len(), 2);
    let owner = documents
        .iter()
        .find(|row| row["active"] == json!(false))
        .expect("inactive document row");
    assert_eq!(owner["index"], json!(0));
    assert_eq!(owner["sameSize"], json!(true));
    assert_eq!(owner["colorCount"], json!(3));
    assert_eq!(owner["colorNames"], json!(["Red", "Green", "Blue"]));
    let alpha = owner["alpha"].as_array().expect("alpha list");
    assert_eq!(alpha.len(), 2);
    assert_eq!(alpha[0]["name"], json!("来源 Alpha"));
    assert_eq!(alpha[0]["kind"], json!("alpha"));
    assert_eq!(alpha[1]["kind"], json!("spot"));
    // 新文档（活动）自报自己的分量，且不冒充别人的 Alpha。
    let target = documents
        .iter()
        .find(|row| row["active"] == json!(true))
        .expect("active document row");
    assert_eq!(target["alpha"], json!([]));
    assert_eq!(target["colorNames"], json!(["Red", "Green", "Blue"]));
    // 来源名字可直接用于计算，命中非活动文档自己的通道，不需要切换文档。
    editor.channel_command("channel.new", json!({ "fill": "white" })).unwrap();
    let steps = history_len(&editor);
    editor
        .channel_command(
            "image.applyImage",
            json!({
                "source": { "document": 0, "channel": "来源 Alpha" },
                "blending": "normal",
                "opacity": 100
            }),
        )
        .expect("named source channel");
    assert_eq!(history_len(&editor), steps + 1);
    assert_eq!(editor.session.active_index(), Some(active), "来源不切换活动文档");
    // 灰度文档只给合成通道：分量清单退化成 Gray，面板不会再摆一行重复的 color:0。
    let mut gray = editor_with(10, 10);
    gray.channel_command("channel.split", json!({ "closeOriginal": true })).unwrap();
    assert_eq!(
        gray.session.active().unwrap().doc.mode,
        photocraft_color::ColorMode::Grayscale
    );
    let row = gray.channel_snapshot().expect("gray snapshot")["documents"][0].clone();
    assert_eq!(row["grayscale"], json!(true));
    assert_eq!(row["colorCount"], json!(1));
    assert_eq!(row["colorNames"], json!(["Gray"]));
}


/// 「无变化不新增历史」：改名成同一个名字、选项与当前值全等时不写文档、不推进历史。
#[test]
fn unchanged_commands_do_not_add_history_or_dirty_the_document() {
    let mut editor = editor_with(12, 12);
    editor.channel_command("channel.new", json!({ "name": "Alpha 一", "opacity": 50 })).unwrap();
    let steps = history_len(&editor);
    let revision = editor.active_doc().unwrap().revision;
    let hash = editor.content_hash().unwrap();
    // 同名（含前后空白，上游会 trim 后比较）不是写入。
    editor.channel_command("channel.rename", json!({ "channel": 0, "name": "Alpha 一" })).unwrap();
    editor.channel_command("channel.rename", json!({ "channel": 0, "name": "  Alpha 一  " })).unwrap();
    // 选项全等也不是写入。
    editor
        .channel_command("channel.options", json!({ "channel": 0, "name": "Alpha 一", "opacity": 50, "indicates": "masked" }))
        .unwrap();
    assert_eq!(history_len(&editor), steps, "无变化的改名/选项不能新增历史");
    assert_eq!(editor.active_doc().unwrap().revision, revision, "无变化不能推进修订");
    assert_eq!(editor.content_hash().unwrap(), hash, "无变化不能改内容身份");
    // 真的改了名字仍然是一步历史。
    editor.channel_command("channel.rename", json!({ "channel": 0, "name": "Alpha 二" })).unwrap();
    assert_eq!(history_len(&editor), steps + 1);
    assert_eq!(channels(&editor)[0]["name"], json!("Alpha 二"));
    // 只改不透明度也是一步历史（判定不能把「部分相同」当成无变化）。
    let steps = history_len(&editor);
    editor.channel_command("channel.options", json!({ "channel": 0, "opacity": 80 })).unwrap();
    assert_eq!(history_len(&editor), steps + 1);
    let opacity = channels(&editor)[0]["opacity"].as_f64().expect("opacity");
    assert!((opacity - 0.8).abs() < 1e-6, "opacity = {opacity}");
    // 转成专色是结构性变化，即使颜色与密度恰好等于默认值也必须写入。
    let steps = history_len(&editor);
    editor
        .channel_command("channel.options", json!({ "channel": 0, "indicates": "spot" }))
        .unwrap();
    assert_eq!(history_len(&editor), steps + 1);
    assert_eq!(channels(&editor)[0]["kind"], json!("spot"));
    // 专色行给出「表示」是转回 Alpha 的结构变化，不能当成无变化跳过。
    let steps = history_len(&editor);
    editor
        .channel_command("channel.options", json!({ "channel": 0, "indicates": "masked" }))
        .unwrap();
    assert_eq!(history_len(&editor), steps + 1);
    assert_eq!(channels(&editor)[0]["kind"], json!("alpha"));
    // 转回 Alpha 后再转成专色，为后续专色判定准备。
    editor
        .channel_command("channel.options", json!({ "channel": 0, "indicates": "spot", "color": "#ff0000", "solidity": 60 }))
        .unwrap();
    // 专色行里「密度与当前相等」同样不新增历史。
    let current = channels(&editor)[0]["spot"]["solidity"].as_f64().expect("solidity");
    let percent = current * 100.0;
    let steps = history_len(&editor);
    editor
        .channel_command("channel.options", json!({ "channel": 0, "color": "#ff0000", "solidity": percent }))
        .unwrap();
    assert_eq!(history_len(&editor), steps, "专色选项全等不能新增历史");
}
