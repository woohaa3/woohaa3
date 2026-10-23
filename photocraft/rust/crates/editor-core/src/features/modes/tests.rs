//! U45 模式转换的域级回归：真实像素、真实模式、颜色表/油墨、历史、保存重开与拒绝路径。
//!
//! 这些用例只走本域入口（`Editor::plan_mode/apply_mode/...`），不依赖浏览器或 GPU。

use crate::Editor;
use serde_json::{Value, json};

fn open(width: u32, height: u32) -> Editor {
    let mut editor = Editor::new();
    editor.execute("file.new", json!({"width": width, "height": height, "mode": "rgb"})).unwrap();
    editor
}

/// 在背景层画左右两半（红 | 蓝），给量化与灰度一个有意义的输入。
fn paint_halves(editor: &mut Editor) {
    use photocraft_geom::Rect;
    let state = editor.session.active_mut().expect("document");
    let id = state.active_layer.expect("background");
    let fmt = state.doc.pixel_format();
    let (w, h) = (state.doc.size.width, state.doc.size.height);
    let layer = std::sync::Arc::make_mut(&mut state.doc).layer_mut(id).expect("layer");
    let surface = layer.surface_mut().expect("raster");
    surface.fill_rect(Rect::from_xywh(0, 0, w / 2, h), &[1.0, 0.0, 0.0, 1.0]);
    surface.fill_rect(Rect::from_xywh(w as i32 / 2, 0, w / 2, h), &[0.0, 0.0, 1.0, 1.0]);
    assert_eq!(fmt.channels(), 4);
}

fn revision(editor: &Editor) -> u64 {
    editor.revision().unwrap()
}

#[test]
fn grayscale_conversion_reports_layers_and_keeps_them() {
    let mut editor = open(16, 8);
    paint_halves(&mut editor);
    editor.execute("layer.new.layer", json!({"name": "上层"})).unwrap();
    let before_layers = editor.state()["document"]["layers"].as_array().unwrap().len();

    let plan = editor.plan_mode("grayscale", json!({})).unwrap();
    assert_eq!(plan["report"]["toMode"], "grayscale");
    assert_eq!(plan["report"]["fromMode"], "rgb");
    assert_eq!(plan["report"]["flattened"], false, "灰度转换保留图层");
    assert_eq!(plan["report"]["layersBefore"], before_layers);
    assert_eq!(plan["report"]["layersAfter"], before_layers);
    assert_eq!(plan["report"]["lossy"], false);
    assert_eq!(plan["preview"]["width"], 16);
    assert_eq!(plan["preview"]["bytes"], 16 * 8 * 4);

    let applied = editor.apply_mode("grayscale", json!({})).unwrap();
    assert_eq!(applied["committed"], true);
    assert_eq!(editor.state()["document"]["mode"], "Grayscale");
    assert_eq!(editor.state()["document"]["depth"], 8);
    // 一步历史。
    assert_eq!(editor.state()["document"]["history"].as_array().unwrap().last().unwrap(), "Grayscale");
}

#[test]
fn preview_never_touches_the_document_revision_or_history() {
    let editor = open(8, 8);
    let hash = editor.content_hash().unwrap();
    let rev = revision(&editor);
    let state = editor.state();
    editor.plan_mode("indexed", json!({"colors": 16})).unwrap();
    editor.plan_mode("grayscale", json!({})).unwrap();
    editor.plan_color_table(json!({})).unwrap_err(); // 非索引色：只读拒绝，也不写
    assert_eq!(revision(&editor), rev);
    assert_eq!(editor.content_hash().unwrap(), hash);
    assert_eq!(editor.state(), state);
}

#[test]
fn indexed_conversion_flattens_writes_a_real_palette_and_survives_reopen() {
    let mut editor = open(16, 8);
    paint_halves(&mut editor);
    editor.execute("layer.new.layer", json!({"name": "上层"})).unwrap();
    editor.execute("select.rect", json!({"x": 0, "y": 0, "width": 4, "height": 4})).unwrap();

    let plan = editor.plan_mode("indexed", json!({"colors": 8, "dither": "none", "palette": "adaptive"})).unwrap();
    let report = &plan["report"];
    assert_eq!(report["toMode"], "indexed");
    assert_eq!(report["flattened"], true, "索引色拼合图层");
    assert!(report["dropped"]["raster"].as_u64().unwrap_or(0) >= 1);
    assert!(report["notes"].as_array().unwrap().iter().any(|note| note.as_str().unwrap().contains("拼合")));
    assert_eq!(report["transparentIndex"], Value::Null, "不透明图像没有透明索引");

    let applied = editor.apply_mode("indexed", json!({"colors": 8, "dither": "none", "palette": "adaptive"})).unwrap();
    let colors = applied["report"]["colors"].as_array().unwrap();
    assert!((2..=8).contains(&colors.len()), "颜色表按实际颜色数量生成，最多请求的 8 条");
    assert!(colors.iter().all(|entry| entry.as_str().unwrap().len() == 7));
    let table_count = colors.len();

    // 工程往返：模式、颜色表与像素都在。
    let bytes = editor.save_project().unwrap();
    let mut reopened = Editor::new();
    reopened.open_project(&bytes, None).unwrap();
    assert_eq!(reopened.state()["document"]["mode"], "Indexed");
    let info = reopened.mode_info().unwrap();
    assert_eq!(info["mode"], "indexed");
    assert_eq!(info["colorTable"]["colors"].as_array().unwrap().len(), table_count);
    assert_eq!(info["depth"], 8);
}

#[test]
fn bitmap_conversion_quantises_to_black_and_white() {
    let mut editor = open(8, 8);
    paint_halves(&mut editor);
    editor.apply_mode("grayscale", json!({})).unwrap();
    let applied = editor.apply_mode("bitmap", json!({"method": "threshold"})).unwrap();
    assert_eq!(applied["report"]["toMode"], "bitmap");
    assert_eq!(editor.state()["document"]["mode"], "Bitmap");
    // 位图只在灰度上可用：从 RGB 直接转换被拒绝。
    let rgb = open(8, 8);
    let error = rgb.plan_mode("bitmap", json!({})).unwrap_err();
    assert!(error.message().contains("灰度"), "{error}");
}

#[test]
fn duotone_inks_are_stored_edited_and_reopened() {
    let mut editor = open(16, 8);
    paint_halves(&mut editor);
    editor.apply_mode("grayscale", json!({})).unwrap();
    let params = json!({
        "type": "tritone",
        "inks": [
            {"name": "Black", "color": "#101010", "curve": [[0, 0], [100, 100]]},
            {"name": "Warm", "color": "#aa5522"},
            {"name": "Blue", "color": "#2244aa"}
        ]
    });
    let applied = editor.apply_mode("duotone", params.clone()).unwrap();
    assert_eq!(applied["report"]["toMode"], "duotone");
    assert_eq!(applied["report"]["inks"].as_array().unwrap().len(), 3);
    assert_eq!(editor.state()["document"]["mode"], "Duotone");

    let info = editor.mode_info().unwrap();
    assert_eq!(info["duotone"]["inks"].as_array().unwrap().len(), 3);
    assert_eq!(info["duotone"]["inks"][2]["name"], "Blue");

    // 编辑油墨：再次应用保留灰度像素并替换油墨。
    let edited = editor
        .apply_mode("duotone", json!({"type": "monotone", "inks": [{"name": "Only", "color": "#335533"}]}))
        .unwrap();
    assert_eq!(edited["committed"], true);
    assert_eq!(editor.mode_info().unwrap()["duotone"]["inks"].as_array().unwrap().len(), 1);

    let bytes = editor.save_project().unwrap();
    let mut reopened = Editor::new();
    reopened.open_project(&bytes, None).unwrap();
    assert_eq!(reopened.state()["document"]["mode"], "Duotone");
    assert_eq!(reopened.mode_info().unwrap()["duotone"]["inks"][0]["color"], "#335533");
}

#[test]
fn color_table_edits_keep_indices_and_change_pixels() {
    let mut editor = open(8, 8);
    paint_halves(&mut editor);
    editor.apply_mode("indexed", json!({"colors": 4, "dither": "none", "palette": "uniform"})).unwrap();
    let before = editor.mode_info().unwrap()["colorTable"]["colors"].as_array().unwrap().clone();
    assert_eq!(before.len(), 4);

    let applied = editor.apply_color_table(json!({"entries": {"0": "#00ff00"}})).unwrap();
    assert_eq!(applied["committed"], true);
    let after = applied["report"]["colors"].as_array().unwrap();
    assert_eq!(after[0], "#00ff00");
    assert_eq!(after.len(), before.len(), "编辑条目不改数量");
    assert_eq!(editor.mode_info().unwrap()["colorTable"]["colors"][0], "#00ff00");
    assert_eq!(editor.state()["document"]["history"].as_array().unwrap().last().unwrap(), "Color Table");

    // 预设整表替换。
    let preset = editor.apply_color_table(json!({"table": "grayscale"})).unwrap();
    let colors = preset["report"]["colors"].as_array().unwrap();
    assert_eq!(colors.len(), 256);
    assert_eq!(colors[0], "#000000");
    assert_eq!(colors[255], "#ffffff");
}

#[test]
fn color_table_accepts_a_transparent_index_and_rejects_out_of_range_entries() {
    let mut editor = open(8, 8);
    paint_halves(&mut editor);
    editor.apply_mode("indexed", json!({"colors": 4, "dither": "none"})).unwrap();
    // 超限条目：必须在写入前被拒绝，且不提交半成品。
    let rev = revision(&editor);
    let error = editor.apply_color_table(json!({"entries": {"300": "#ffffff"}})).unwrap_err();
    assert!(error.message().contains("索引"), "{error}");
    let error = editor.plan_color_table(json!({"colors": []})).unwrap_err();
    assert!(error.message().contains("1–256"), "{error}");
    let error = editor.plan_color_table(json!({"transparent": 400})).unwrap_err();
    assert!(error.message().contains("透明索引"), "{error}");
    assert_eq!(revision(&editor), rev);

    let applied = editor.apply_color_table(json!({"transparent": 2})).unwrap();
    assert_eq!(applied["report"]["transparent"], 2);
}

#[test]
fn stale_plan_cannot_commit_onto_a_changed_document() {
    let mut editor = open(8, 8);
    let plan = editor.plan_mode("grayscale", json!({})).unwrap();
    let base_revision = plan["baseRevision"].as_u64().unwrap();
    let base_hash = plan["baseContentHash"].as_str().unwrap().to_string();
    editor.execute("layer.new.layer", json!({"name": "改动"})).unwrap();

    let error = editor
        .apply_mode("grayscale", json!({"baseRevision": base_revision, "baseContentHash": base_hash}))
        .unwrap_err();
    assert!(error.message().contains("已变化"), "{error}");
    assert_eq!(editor.state()["document"]["mode"], "Rgb", "拒绝后不写模式");
}

#[test]
fn invalid_last_input_never_commits_the_previous_valid_plan() {
    let mut editor = open(8, 8);
    editor.plan_mode("indexed", json!({"colors": 8})).unwrap();
    let rev = revision(&editor);
    for params in [json!({"colors": 1}), json!({"colors": 257}), json!({"dither": "bogus"}), json!({"nope": 1})] {
        assert!(editor.apply_mode("indexed", params).is_err(), "非法参数必须拒绝");
    }
    assert_eq!(revision(&editor), rev);
    assert_eq!(editor.state()["document"]["mode"], "Rgb");
}

#[test]
fn identical_edits_add_no_history_and_keep_the_document_clean() {
    // 索引色：应用与当前完全相同的颜色表不新增历史。
    let mut editor = open(8, 8);
    editor.apply_mode("indexed", json!({"colors": 4, "dither": "none"})).unwrap();
    let table = editor.mode_info().unwrap()["colorTable"]["colors"].as_array().unwrap().clone();
    let rev = revision(&editor);
    let history = editor.state()["document"]["history"].as_array().unwrap().len();
    let imported = json!({ "colors": table, "transparent": Value::Null });
    let applied = editor.apply_color_table(imported).unwrap();
    assert_eq!(applied["committed"], false, "同一张颜色表不提交");
    assert_eq!(revision(&editor), rev);
    assert_eq!(editor.state()["document"]["history"].as_array().unwrap().len(), history);

    // 双色调：再次应用同一组油墨同样不新增历史（灰度→双色调允许重复应用以编辑油墨）。
    let mut tone = open(8, 8);
    tone.apply_mode("grayscale", json!({})).unwrap();
    let inks = json!({"type": "duotone", "inks": [{"name": "A", "color": "#111111"}, {"name": "B", "color": "#999999"}]});
    tone.apply_mode("duotone", inks.clone()).unwrap();
    let rev = revision(&tone);
    let history = tone.state()["document"]["history"].as_array().unwrap().len();
    assert_eq!(tone.apply_mode("duotone", inks).unwrap()["committed"], false);
    assert_eq!(revision(&tone), rev);
    assert_eq!(tone.state()["document"]["history"].as_array().unwrap().len(), history);
}

#[test]
fn color_table_plan_reports_the_shared_mode_report_shape() {
    // 颜色表计划与模式计划共用同一份前端解码器：结构损失字段必须齐备且为空。
    let mut editor = open(8, 8);
    paint_halves(&mut editor);
    editor.apply_mode("indexed", json!({"colors": 4, "dither": "none"})).unwrap();
    let plan = editor.plan_color_table(json!({"entries": {"0": "#00ff00"}})).unwrap();
    let report = &plan["report"];
    assert_eq!(report["target"], "color-table");
    assert_eq!(report["fromMode"], "indexed");
    assert_eq!(report["toMode"], "indexed");
    assert_eq!(report["depth"], 8);
    assert_eq!(report["flattened"], false);
    assert_eq!(report["lossy"], false);
    assert_eq!(report["dropped"], json!({}));
    assert_eq!(report["layersBefore"], report["layersAfter"]);
    assert_eq!(report["colors"][0], "#00ff00");
    assert_eq!(report["transparentIndex"], Value::Null);
    assert!(report["notes"].as_array().unwrap().iter().any(|note| note.as_str().unwrap().contains("颜色表")));
}

#[test]
fn read_only_documents_report_unavailable_targets_and_trap() {
    let editor = open(8, 8);
    let state = editor.session.active().expect("document");
    let info = super::info(&state.doc, state.revision, "hash", true);
    assert_eq!(info["readOnly"], true);
    // 只读来源：原本可用的目标追加只读原因；本来就不可用的目标保留模式原因。
    let targets = info["targets"].as_array().unwrap();
    assert!(targets.iter().all(|target| target["available"] == false));
    let grayscale = targets.iter().find(|target| target["id"] == "grayscale").unwrap();
    assert!(grayscale["reason"].as_str().unwrap().contains("只读"), "{grayscale}");
    assert_eq!(info["trap"]["available"], false);
}

#[test]
fn mode_targets_and_rejections_are_reported_per_document_state() {
    let editor = open(4, 4);
    let info = editor.mode_info().unwrap();
    let targets = info["targets"].as_array().unwrap();
    let by_id = |id: &str| targets.iter().find(|entry| entry["id"] == id).unwrap().clone();
    assert_eq!(by_id("rgb")["available"], false, "已是 RGB");
    assert!(by_id("rgb")["reason"].as_str().unwrap().contains("RGB"));
    assert_eq!(by_id("grayscale")["available"], true);
    assert_eq!(by_id("bitmap")["available"], false);
    assert!(by_id("bitmap")["reason"].as_str().unwrap().contains("灰度"));
    assert_eq!(by_id("duotone")["available"], false);
    assert_eq!(by_id("indexed")["available"], true);
    assert_eq!(info["trap"]["available"], false);
    assert!(info["trap"]["reason"].as_str().unwrap().contains("CMYK"));
    // 未知目标显式拒绝。
    assert!(editor.plan_mode("cmyk", json!({})).is_err());
    assert!(editor.plan_mode("lab", json!({})).is_err());
}

#[test]
fn mode_info_is_a_read_only_snapshot() {
    let editor = open(8, 8);
    let state = editor.state();
    let hash = editor.content_hash().unwrap();
    let first = editor.mode_info().unwrap();
    let second = editor.mode_info().unwrap();
    assert_eq!(first, second);
    assert_eq!(editor.state(), state);
    assert_eq!(editor.content_hash().unwrap(), hash);
    assert_eq!(first["mode"], "rgb");
    assert_eq!(first["revision"].as_u64().unwrap(), revision(&editor));
    assert_eq!(first["contentHash"], hash);
    assert_eq!(first["colorTable"], Value::Null);
    assert_eq!(first["duotone"], Value::Null);
}

#[test]
fn mode_conversion_is_blocked_while_another_draft_is_open() {
    let mut editor = open(16, 16);
    editor.execute("select.rect", json!({"x": 1, "y": 1, "width": 4, "height": 4})).unwrap();
    editor.begin_selection_modify(json!({"operation": "expand", "radius": 2})).unwrap();
    let error = editor.plan_mode("grayscale", json!({})).unwrap_err();
    assert!(error.message().contains("选区修改"), "{error}");
    editor.cancel_selection_modify();
    assert!(editor.plan_mode("grayscale", json!({})).is_ok());
}

/// 造一个指定模式的真实文档（走本域入口，不用手写 Document 字段）。
fn in_mode(mode: &str) -> Editor {
    let mut editor = open(8, 8);
    match mode {
        "rgb" => {}
        "grayscale" => {
            editor.apply_mode("grayscale", json!({})).unwrap();
        }
        "bitmap" => {
            editor.apply_mode("grayscale", json!({})).unwrap();
            editor.apply_mode("bitmap", json!({"method": "threshold"})).unwrap();
        }
        "indexed" => {
            editor.apply_mode("indexed", json!({"colors": 4, "dither": "none"})).unwrap();
        }
        "duotone" => {
            editor.apply_mode("grayscale", json!({})).unwrap();
            editor.apply_mode("duotone", json!({"type": "duotone"})).unwrap();
        }
        other => panic!("未知模式 {other}"),
    }
    assert_eq!(editor.mode_info().unwrap()["mode"], mode);
    editor
}

fn sample_params(target: &str) -> Value {
    match target {
        "bitmap" => json!({"method": "threshold"}),
        "indexed" => json!({"colors": 4, "dither": "none"}),
        "duotone" => json!({"type": "duotone"}),
        _ => json!({}),
    }
}

#[test]
fn advertised_targets_match_what_the_kernel_actually_accepts() {
    // 面板只按 `modeInfo().targets` 决定哪个目标可点。若这里与内核真实可用性不一致，
    // 用户会看到一个能点但必然失败的入口（实测曾出现 `位图 → 位图`：面板说可用，
    // 上游以 “Bitmap needs a Grayscale image” 拒绝）。这条用例把两者锁在一起。
    for mode in ["rgb", "grayscale", "bitmap", "indexed", "duotone"] {
        let editor = in_mode(mode);
        let targets = editor.mode_info().unwrap()["targets"].as_array().unwrap().clone();
        for target in super::TARGETS {
            let entry = targets.iter().find(|entry| entry["id"] == *target).expect("每个目标都要有可用性条目");
            let advertised = entry["available"].as_bool().unwrap();
            let accepted = editor.plan_mode(target, sample_params(target)).is_ok();
            assert_eq!(
                advertised, accepted,
                "{mode} → {target}：面板声明 available={advertised}，内核实际接受={accepted}（原因：{}）",
                entry["reason"]
            );
            if !advertised {
                assert!(entry["reason"].as_str().is_some_and(|reason| !reason.is_empty()), "{mode} → {target} 不可用时必须给出原因");
            }
        }
    }
}

#[test]
fn bitmap_document_reports_its_own_target_as_unavailable_with_a_reason() {
    let editor = in_mode("bitmap");
    let info = editor.mode_info().unwrap();
    let bitmap = info["targets"].as_array().unwrap().iter().find(|entry| entry["id"] == "bitmap").unwrap().clone();
    assert_eq!(bitmap["available"], false);
    assert!(bitmap["reason"].as_str().unwrap().contains("已是位图"), "{bitmap}");
    // 位图可以直接回灰度或 RGB（上游允许）。
    for target in ["grayscale", "rgb"] {
        let entry = info["targets"].as_array().unwrap().iter().find(|entry| entry["id"] == target).unwrap().clone();
        assert_eq!(entry["available"], true, "{target}");
    }
    // 内核也真的拒绝位图重做位图，且不写模式、不新增历史。
    let rev = revision(&editor);
    let error = editor.plan_mode("bitmap", json!({"method": "threshold"})).unwrap_err();
    assert!(error.message().contains("已是位图"), "{error}");
    assert_eq!(revision(&editor), rev);
}

#[test]
fn sixteen_bit_documents_stay_out_of_scope_and_do_not_get_silently_downgraded() {
    // 本次只支持 8 位/通道：16 位文档必须整体不可用，绝不能静默降位深或压平。
    let mut editor = Editor::new();
    editor.execute("file.new", json!({"width": 8, "height": 8, "mode": "rgb", "depth": 16})).unwrap();
    let info = editor.mode_info().unwrap();
    assert_eq!(info["depth"], 16);
    assert_eq!(info["mode"], "rgb");
    for target in info["targets"].as_array().unwrap() {
        assert_eq!(target["available"], false, "{target}");
        assert!(target["reason"].as_str().unwrap().contains("8 位"), "{target}");
    }
    let rev = revision(&editor);
    assert!(editor.plan_mode("grayscale", json!({})).is_err());
    assert!(editor.apply_mode("indexed", json!({"colors": 4})).is_err());
    assert_eq!(revision(&editor), rev);
    assert_eq!(editor.state()["document"]["depth"], 16);
    assert_eq!(editor.state()["document"]["mode"], "Rgb");
}

#[test]
fn non_rgb_documents_report_the_real_mode_in_state_and_reject_unknown_parameters() {
    let mut editor = open(8, 8);
    editor.apply_mode("grayscale", json!({})).unwrap();
    assert_eq!(editor.state()["document"]["mode"], "Grayscale");
    // 灰度文档不能再转灰度。
    assert!(editor.plan_mode("grayscale", json!({})).unwrap_err().message().contains("已是灰度"));
    // 位图参数越界拒绝。
    assert!(editor.apply_mode("bitmap", json!({"frequency": 0})).is_err());
    assert!(editor.apply_mode("bitmap", json!({"angle": 181})).is_err());
    // 双色调油墨越界拒绝。
    let too_many = json!({"stats": 1});
    assert!(editor.apply_mode("duotone", too_many).is_err());
    let five = json!({"type": "quadtone", "inks": [{"name": "a"}, {"name": "b"}, {"name": "c"}, {"name": "d"}, {"name": "e"}]});
    assert!(editor.apply_mode("duotone", five).is_err());
    let long_curve: Vec<Value> = (0..70).map(|i| json!([i, i])).collect();
    let curve = json!({"inks": [{"name": "a", "curve": long_curve}]});
    assert!(editor.apply_mode("duotone", curve).is_err());
}
