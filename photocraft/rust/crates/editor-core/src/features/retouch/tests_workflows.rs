//! 修饰域入口的原生回归（change: 2026-10-22-add-photocraft-retouch-workflows）。
//!
//! 覆盖 spec 的「草稿保持文档归属」要求：预览不推进修订/历史/指纹，确认一次，取消恢复；
//! 晚到候选不写入更新过的文档；历史画笔不移动当前历史游标，源不可用时不静默降级。
//! 由同目录 `tools.rs` 以 `#[path]` 挂载，因此不改共享 `editor.rs` 的测试注册表。
//!
//! 每个用例都先画上真实像素：空层上的修饰本来就没有可改的内容，用它做断言会把
//! 「无变化」误判成实现错误。撤销后的比较用内容指纹/像素，而不是整个 `state()`
//! （撤销后会正常多出 redo 记录，那是历史语义而不是内容变化）。
use super::*;

/// 有真实像素的文档：新图层上画一块红块，修饰工具才有可改的内容。
fn editor_with_content() -> Editor {
    let mut editor = Editor::new();
    editor.execute("file.new", json!({"width":64,"height":64,"name":"retouch"})).unwrap();
    editor.execute("layer.new.layer", json!({"name":"修饰层"})).unwrap();
    let target = editor.active_layer_id().unwrap().0;
    editor
        .execute(
            "paint.stroke",
            json!({
                "points":[[10,10],[20,20],[28,28]],
                "size":24,"hardness":60,"opacity":100,"flow":100,"color":"#d02020",
                "mode":"normal","target":"pixels","layer":target
            }),
        )
        .unwrap();
    editor
}

fn layer(editor: &Editor) -> u64 {
    editor.active_layer_id().unwrap().0
}

fn stroke_params(size: u64) -> Value {
    json!({"size":size,"hardness":100,"opacity":100,"flow":100,"spacing":25})
}

fn points(values: &[[f64; 2]]) -> Value {
    json!(values.iter().map(|[x, y]| json!([x, y])).collect::<Vec<_>>())
}

#[test]
fn stroke_draft_previews_without_advancing_revision_history_or_identity() {
    let mut editor = editor_with_content();
    let target = layer(&editor);
    let before = editor.state();
    let hash = editor.content_hash().unwrap();
    let mut params = stroke_params(10);
    params["layer"] = json!(target);
    params["points"] = points(&[[14.0, 14.0]]);
    // 通用笔迹模板总会写 mode=normal；海绵必须被归一化成 saturate/desaturate。
    params["mode"] = json!("normal");
    let begun = editor.begin_retouch("paint.sponge", params).unwrap();
    assert_eq!(begun["live"], json!(false));
    editor.append_retouch(json!({"points":[[15.0, 15.0],[16.0, 16.0]]})).unwrap();
    // 预览：修订、状态、指纹都不动。
    assert_eq!(editor.state(), before);
    assert_eq!(editor.content_hash().unwrap(), hash);
    assert_eq!(editor.retouch_state()["active"], json!(true));
    let committed = editor.commit_retouch().unwrap();
    assert_eq!(committed["points"], json!(3));
    assert_ne!(editor.content_hash().unwrap(), hash, "海绵必须真的改动像素");
    assert_eq!(editor.retouch_state()["active"], json!(false));
    // 一步历史；撤销后内容与指纹回到原样。
    editor.undo().unwrap();
    assert_eq!(editor.content_hash().unwrap(), hash);
}

#[test]
fn cancelled_stroke_leaves_no_half_step_and_reopens_the_gate() {
    let mut editor = editor_with_content();
    let target = layer(&editor);
    let before = editor.state();
    let hash = editor.content_hash().unwrap();
    let mut params = stroke_params(10);
    params["layer"] = json!(target);
    params["points"] = points(&[[14.0, 14.0]]);
    editor.begin_retouch("paint.dodge", params).unwrap();
    editor.append_retouch(json!({"points":[[20.0, 20.0]]})).unwrap();
    // 草稿期间拒绝其它写入口与另一笔修饰。
    assert!(editor.execute("paint.stroke", json!({"points":[[1,1]],"size":4,"color":"#ff0000"})).is_err());
    let mut second = stroke_params(4);
    second["points"] = points(&[[2.0, 2.0]]);
    assert!(editor.begin_retouch("paint.burn", second).is_err());
    editor.cancel_retouch();
    assert_eq!(editor.state(), before);
    assert_eq!(editor.content_hash().unwrap(), hash);
    assert_eq!(editor.retouch_state()["active"], json!(false));
    // 取消后可以正常开始新的一笔。
    let mut fresh = stroke_params(6);
    fresh["layer"] = json!(target);
    fresh["points"] = points(&[[15.0, 15.0]]);
    assert!(editor.begin_retouch("paint.sharpen", fresh).is_ok());
    editor.cancel_retouch();
}

#[test]
fn region_candidate_is_previewed_separately_and_commits_once() {
    let mut editor = editor_with_content();
    let target = layer(&editor);
    editor.execute("select.rect", json!({"x":6,"y":6,"width":12,"height":12,"mode":"replace"})).unwrap();
    let before = editor.state();
    let hash = editor.content_hash().unwrap();
    let begun = editor
        .begin_retouch_region("paint.patch", json!({"layer":target,"offset":[14,0],"mode":"source"}))
        .unwrap();
    assert!(begun["result"].is_object());
    assert_eq!(editor.state(), before, "候选不改正式文档");
    assert_eq!(editor.content_hash().unwrap(), hash);
    assert_eq!(editor.retouch_state()["region"], json!(true));
    // 区域候选期间不接受笔迹，也不能用笔迹确认入口消费候选。
    let mut params = stroke_params(4);
    params["layer"] = json!(target);
    params["points"] = points(&[[2.0, 2.0]]);
    assert!(editor.begin_retouch("paint.blur", params).is_err());
    assert!(editor.commit_retouch().is_err());
    let committed = editor.commit_retouch_region().unwrap();
    assert_eq!(committed["changed"], json!(true));
    assert_ne!(editor.content_hash().unwrap(), hash, "修补必须真的改动像素");
    editor.undo().unwrap();
    assert_eq!(editor.content_hash().unwrap(), hash);
}

#[test]
fn cancelled_region_candidate_leaves_the_document_untouched() {
    let mut editor = editor_with_content();
    let target = layer(&editor);
    editor.execute("select.rect", json!({"x":6,"y":6,"width":10,"height":10,"mode":"replace"})).unwrap();
    let before = editor.state();
    let hash = editor.content_hash().unwrap();
    editor
        .begin_retouch_region("paint.contentAwareMove", json!({"layer":target,"offset":[10,4],"mode":"move"}))
        .unwrap();
    editor.cancel_retouch_region();
    assert_eq!(editor.state(), before);
    assert_eq!(editor.content_hash().unwrap(), hash);
    assert_eq!(editor.retouch_state()["region"], json!(false));
}

#[test]
fn region_candidate_targets_the_active_layer_even_without_an_explicit_layer() {
    // 不带 layer 时，笔迹与区域命令都必须作用于**活动层**（内核语义），
    // 而不是文档最上层——后者会静默改写用户没选中的图层。
    let mut editor = editor_with_content();
    let active = layer(&editor);
    // 在活动层之上再加一个锁定层，让「最上层」不等于「活动层」。
    editor.execute("layer.new.layer", json!({"name":"锁定层"})).unwrap();
    let top = layer(&editor);
    assert_ne!(top, active);
    // `layer.lockLayers` 作用于活动层，所以先选中新层再锁定，最后切回原活动层。
    editor.execute("layer.lockLayers", json!({"pixels":true})).unwrap();
    editor.execute("layer.select", json!({"layer":active,"mode":"replace"})).unwrap();
    assert_eq!(layer(&editor), active);
    editor.execute("select.rect", json!({"x":6,"y":6,"width":10,"height":10,"mode":"replace"})).unwrap();
    let hash = editor.content_hash().unwrap();
    // 区域候选：不给 layer 必须走活动层。若仍按「最上层」解析就会命中锁定层并被
    // 可写性校验拒绝——因此这里能开始候选本身就是回归证据。
    let begun = editor.begin_retouch_region("paint.patch", json!({"offset":[10,0]})).unwrap();
    assert_eq!(begun["command"], json!("paint.patch"));
    assert_eq!(editor.content_hash().unwrap(), hash);
    // 显式指定那个锁定层仍然被拒绝（校验没被放宽）。
    assert!(editor.begin_retouch_region("paint.patch", json!({"layer":top,"offset":[10,0]})).is_err());
    editor.commit_retouch_region().unwrap();
    assert_eq!(editor.retouch_state()["region"], json!(false));
    if editor.content_hash().unwrap() != hash {
        editor.undo().unwrap();
        assert_eq!(editor.content_hash().unwrap(), hash);
    }
    // 笔迹同理：不传 layer 也落到活动层，而不是被锁定层拒绝。
    let mut params = stroke_params(8);
    params["points"] = points(&[[16.0, 16.0]]);
    editor.begin_retouch("paint.dodge", params).unwrap();
    editor.append_retouch(json!({"points":[[18.0, 18.0]]})).unwrap();
    editor.commit_retouch().unwrap();
    assert_ne!(editor.content_hash().unwrap(), hash);
    editor.undo().unwrap();
    assert_eq!(editor.content_hash().unwrap(), hash);
}

#[test]
fn stale_region_candidate_is_discarded_instead_of_written() {    let mut editor = editor_with_content();
    let target = layer(&editor);
    editor.execute("select.rect", json!({"x":6,"y":6,"width":10,"height":10,"mode":"replace"})).unwrap();
    editor
        .begin_retouch_region("paint.patch", json!({"layer":target,"offset":[8,0]}))
        .unwrap();
    // 候选之后文档又被改（独立的一笔普通画笔），候选的起始修订因此过期。
    editor
        .execute(
            "paint.stroke",
            json!({"points":[[40,40]],"size":8,"hardness":100,"opacity":100,"flow":100,"color":"#00ff00","mode":"normal","target":"pixels","layer":target}),
        )
        .unwrap();
    let stale = editor.content_hash().unwrap();
    let error = editor.commit_retouch_region();
    assert!(error.is_err(), "过期候选不得写入");
    assert_eq!(editor.content_hash().unwrap(), stale, "拒绝后也不得改内容");
    assert_eq!(editor.retouch_state()["region"], json!(false));
}

#[test]
fn region_commands_reject_missing_selection_and_out_of_range_parameters() {
    let mut editor = editor_with_content();
    let target = layer(&editor);
    // 没有选区。
    assert!(editor
        .begin_retouch_region("paint.patch", json!({"layer":target,"offset":[4,0]}))
        .is_err());
    assert!(!editor.retouch_state()["region"].as_bool().unwrap());
    editor.execute("select.rect", json!({"x":6,"y":6,"width":10,"height":10,"mode":"replace"})).unwrap();
    // 缺偏移 / 模式越界 / 结构越界。
    assert!(editor.begin_retouch_region("paint.patch", json!({"layer":target})).is_err());
    assert!(editor
        .begin_retouch_region("paint.patch", json!({"layer":target,"offset":[4,0],"mode":"elsewhere"}))
        .is_err());
    assert!(editor
        .begin_retouch_region("paint.patch", json!({"layer":target,"offset":[4,0],"structure":9}))
        .is_err());
    // 红眼参数越界。
    assert!(editor
        .begin_retouch_region("paint.redEye", json!({"layer":target,"x":4,"y":4,"pupilSize":0}))
        .is_err());
    assert!(editor
        .begin_retouch_region("paint.redEye", json!({"layer":target,"x":4,"y":4,"darken":101}))
        .is_err());
    assert!(!editor.retouch_state()["region"].as_bool().unwrap());
}

#[test]
fn red_eye_never_degrades_into_a_plain_brush_submit() {
    let mut editor = editor_with_content();
    let target = layer(&editor);
    let before_hash = editor.content_hash().unwrap();
    let started = editor.begin_retouch_region(
        "paint.redEye",
        json!({"layer":target,"x":12,"y":12,"pupilSize":60,"darken":80}),
    );
    match started {
        Ok(info) => {
            assert_eq!(info["command"], json!("paint.redEye"));
            let committed = editor.commit_retouch_region().unwrap();
            assert_eq!(committed["command"], json!("paint.redEye"));
            // 红眼是区域命令：确认后内容变化可撤销；撤销即恢复。
            editor.undo().unwrap();
            assert_eq!(editor.content_hash().unwrap(), before_hash);
        }
        Err(_) => {
            // 上游判定该点没有可修正的红眼：拒绝且文档保持原样，不回落到普通画笔。
            assert_eq!(editor.content_hash().unwrap(), before_hash);
            assert_eq!(editor.retouch_state()["region"], json!(false));
            assert!(editor.commit_retouch_region().is_err());
        }
    }
}

#[test]
fn history_sources_query_is_read_only() {
    let mut editor = editor_with_content();
    let target = layer(&editor);
    let mut params = stroke_params(8);
    params["layer"] = json!(target);
    params["points"] = points(&[[14.0, 14.0]]);
    editor.begin_retouch("paint.dodge", params).unwrap();
    editor.commit_retouch().unwrap();
    let before = editor.state();
    let hash = editor.content_hash().unwrap();
    let sources = editor.retouch_history_sources().unwrap();
    let states = sources["states"].as_array().unwrap();
    assert!(states.len() >= 2);
    assert_eq!(states.last().unwrap()["current"], json!(true));
    // 查询不推进修订、不改指纹。
    assert_eq!(editor.state(), before);
    assert_eq!(editor.content_hash().unwrap(), hash);
}

#[test]
fn history_brush_restores_the_selected_source_without_moving_the_cursor() {
    let mut editor = editor_with_content();
    let target = layer(&editor);
    let painted_hash = editor.content_hash().unwrap();
    let mut params = stroke_params(10);
    params["layer"] = json!(target);
    params["points"] = points(&[[16.0, 16.0],[20.0, 20.0]]);
    params["range"] = json!("midtones");
    params["exposure"] = json!(100);
    editor.begin_retouch("paint.dodge", params).unwrap();
    editor.commit_retouch().unwrap();
    let dodged = editor.content_hash().unwrap();
    assert_ne!(dodged, painted_hash, "减淡必须真的改动像素");
    let history_before = editor.state()["document"]["history"].as_array().unwrap().len();
    // 选一个**确实含有该图层且内容不同**的历史状态作为源：最旧的 Open 快照早于该图层创建，
    // 不能用；紧邻当前状态之前的那一步（画完红块、还没减淡）才是可恢复的有效源。
    let sources = editor.retouch_history_sources().unwrap();
    let states = sources["states"].as_array().unwrap();
    assert!(states.len() >= 2);
    let usable = states
        .iter()
        .rev()
        .find(|state| state["available"] == json!(true) && state["current"] == json!(false))
        .expect("至少应有一个可用的历史源");
    let source_index = usable["index"].as_u64().unwrap();
    let mut restore = stroke_params(10);
    restore["layer"] = json!(target);
    restore["points"] = points(&[[16.0, 16.0],[20.0, 20.0]]);
    restore["historyState"] = json!(source_index);
    let begun = editor.begin_retouch("paint.historyBrush", restore).unwrap();
    assert_eq!(begun["historySource"], json!(source_index));
    editor.append_retouch(json!({"points":[[18.0, 18.0]]})).unwrap();
    editor.commit_retouch().unwrap();
    // 只多一步历史；游标停在最新（不跳到源状态）。
    let after = editor.state();
    assert_eq!(after["document"]["history"].as_array().unwrap().len(), history_before + 1);
    assert_ne!(editor.content_hash().unwrap(), dodged, "历史画笔必须恢复源内容");
    // 撤销只回退这一笔，减淡结果仍在。
    editor.undo().unwrap();
    assert_eq!(editor.content_hash().unwrap(), dodged);
    // 不含该图层的历史状态被拒绝，并给出可操作原因（不退化为普通画笔）。
    let unavailable = states.iter().find(|state| state["available"] == json!(false)).map(|state| state["index"].as_u64().unwrap());
    if let Some(index) = unavailable {
        let mut missing = stroke_params(10);
        missing["layer"] = json!(target);
        missing["points"] = points(&[[16.0, 16.0]]);
        missing["historyState"] = json!(index);
        let error = editor.begin_retouch("paint.historyBrush", missing).err();
        let message = format!("{}", error.expect("不含该图层的历史源必须被拒绝"));
        assert!(message.contains("图层"), "原因要说明图层不在该状态里：{message}");
        assert_eq!(editor.content_hash().unwrap(), dodged);
        assert_eq!(editor.retouch_state()["active"], json!(false));
    }
    // 越界的历史索引同样拒绝。
    let mut missing = stroke_params(10);
    missing["layer"] = json!(target);
    missing["points"] = points(&[[16.0, 16.0]]);
    missing["historyState"] = json!(250);
    assert!(editor.begin_retouch("paint.historyBrush", missing).is_err());
    assert_eq!(editor.content_hash().unwrap(), dodged);
    assert_eq!(editor.retouch_state()["active"], json!(false));
    // 非法索引不得被静默当成「最旧状态」：负索引、小数、字符串都明确拒绝。
    // （状态 0 在这个文档里是可用源，若默认成 0 就会「成功」并恢复错误的内容。）
    for bad in [json!(-1), json!(1.5), json!("2")] {
        for key in ["state", "historyState"] {
            let mut malformed = stroke_params(10);
            malformed["layer"] = json!(target);
            malformed["points"] = points(&[[16.0, 16.0]]);
            malformed[key] = bad.clone();
            let error = editor.begin_retouch("paint.historyBrush", malformed).err();
            let message = format!("{}", error.expect("非法历史源索引必须被拒绝"));
            assert!(
                message.contains("非负整数"),
                "原因要说明索引形态（{key}={bad}）：{message}"
            );
            assert_eq!(editor.retouch_state()["active"], json!(false));
            assert_eq!(editor.content_hash().unwrap(), dodged, "拒绝后内容不变");
        }
    }
}

#[test]
fn clone_source_query_stays_readable_while_stroking() {
    // 叠加取样框与面板刷新在落笔期间也要能读到取景：`cloneSource.list` 不写内容，
    // 不该被共享草稿门禁整笔挡住。写命令（select/set/overlay）仍被拒绝，变换保持冻结。
    let mut editor = editor_with_content();
    let target = layer(&editor);
    editor
        .execute("cloneSource.set", json!({"index":0,"source":[12,12],"anchor":[14,14],"width":200,"rotation":30}))
        .unwrap();
    let before = editor.state();
    let hash = editor.content_hash().unwrap();
    let mut params = stroke_params(8);
    params["layer"] = json!(target);
    params["points"] = points(&[[14.0, 14.0]]);
    let begun = editor.begin_retouch("paint.cloneStamp", params).unwrap();
    assert_eq!(begun["layer"], json!(target));
    let listed = editor.retouch_clone_sources().unwrap();
    assert_eq!(listed["active"], json!(0));
    assert_eq!(listed["sources"][0]["source"], json!([12.0, 12.0]));
    assert_eq!(listed["sources"][0]["width"], json!(200.0));
    assert_eq!(listed["sources"][0]["rotation"], json!(30.0));
    // 只读：状态、指纹、历史都不动。
    assert_eq!(editor.state(), before);
    assert_eq!(editor.content_hash().unwrap(), hash);
    // 落笔中改工具状态仍被拒绝（取样变换冻结于一笔）。
    for id in ["cloneSource.select", "cloneSource.set", "cloneSource.overlay"] {
        let error = editor.execute(id, json!({"index":1,"opacity":40})).err();
        assert!(error.is_some(), "{id} 在落笔期间必须被拒绝");
    }
    editor.cancel_retouch();
    // 取消后查询仍然可用（没有文档时明确失败，而不是空列表）。
    assert!(editor.retouch_clone_sources().is_ok());
    assert_eq!(editor.content_hash().unwrap(), hash);
}

#[test]
fn pattern_stamp_requires_a_pattern_and_rejects_out_of_range_transform() {
    let mut editor = editor_with_content();
    let target = layer(&editor);
    let mut params = stroke_params(10);
    params["layer"] = json!(target);
    params["points"] = points(&[[8.0, 8.0]]);
    params["aligned"] = json!(true);
    // 显式指定不存在的图案：拒绝并说明原因（不静默换成别的图案，也不回退成普通画笔）。
    let mut unknown = params.clone();
    unknown["patternId"] = json!("no-such-pattern");
    let error = editor.begin_retouch("paint.patternStamp", unknown).err();
    assert!(error.is_some(), "不存在的图案必须被拒绝");
    assert_eq!(editor.retouch_state()["active"], json!(false));
    // 缩放越界同样拒绝（不是静默截断）。
    let mut bad = params.clone();
    bad["scale"] = json!(0);
    assert!(editor.begin_retouch("paint.patternStamp", bad).is_err());
    // 未指定图案时使用图案面板当前图案（上游默认库里有图案），可以直接落笔。
    let begun = editor.begin_retouch("paint.patternStamp", params).unwrap();
    assert_eq!(begun["command"], json!("paint.patternStamp"));
    editor.append_retouch(json!({"points":[[10.0, 10.0]]})).unwrap();
    let before = editor.content_hash().unwrap();
    editor.commit_retouch().unwrap();
    assert_ne!(editor.content_hash().unwrap(), before, "图案图章必须真的落笔");
    assert_eq!(editor.retouch_state()["active"], json!(false));
}

#[test]
fn remove_stroke_without_a_document_fails_instead_of_submitting_empty() {
    let mut editor = Editor::new();
    let mut params = stroke_params(8);
    params["points"] = points(&[[4.0, 4.0]]);
    assert!(editor.begin_retouch("paint.remove", params).is_err());
    assert_eq!(editor.retouch_state()["active"], json!(false));
}

#[test]
fn remove_stroke_commits_at_most_one_step_and_cancels_cleanly() {
    let mut editor = editor_with_content();
    let target = layer(&editor);
    let baseline_hash = editor.content_hash().unwrap();
    let mut params = stroke_params(10);
    params["layer"] = json!(target);
    params["points"] = points(&[[14.0, 14.0],[18.0, 18.0]]);
    params["removeNewLayer"] = json!(false);
    editor.begin_retouch("paint.remove", params).unwrap();
    editor.append_retouch(json!({"points":[[20.0, 20.0]]})).unwrap();
    editor.cancel_retouch();
    // 半笔取消：正式文档不变。
    assert_eq!(editor.content_hash().unwrap(), baseline_hash);
    // 再提交一笔：要么是一步历史，要么无变化，都不留半笔。
    let mut params = stroke_params(10);
    params["layer"] = json!(target);
    params["points"] = points(&[[14.0, 14.0],[18.0, 18.0]]);
    editor.begin_retouch("paint.remove", params).unwrap();
    editor.append_retouch(json!({"points":[[20.0, 20.0]]})).unwrap();
    let _ = editor.commit_retouch();
    assert_eq!(editor.retouch_state()["active"], json!(false));
    if editor.content_hash().unwrap() != baseline_hash {
        editor.undo().unwrap();
        assert_eq!(editor.content_hash().unwrap(), baseline_hash);
    }
}

#[test]
fn clone_source_slots_drive_the_stroke_and_stay_out_of_content() {
    // U39：多仿制源槽位是会话工具状态；开始一笔时冻结其取样点与变换，内容只在落笔时改变。
    let mut editor = editor_with_content();
    let target = layer(&editor);
    let hash = editor.content_hash().unwrap();
    let history_len = editor.state()["document"]["history"].as_array().unwrap().len();
    let list = editor.execute("cloneSource.list", json!({})).unwrap();
    assert_eq!(list["sources"].as_array().unwrap().len(), 5);
    editor
        .execute("cloneSource.set", json!({"index":0,"source":[8,8],"layer":target,"width":200,"height":100,"rotation":30,"flipH":true}))
        .unwrap();
    editor.execute("cloneSource.overlay", json!({"show":true,"opacity":60,"blend":"difference"})).unwrap();
    // 槽位/叠加是工具状态：不推进内容指纹，也不新增撤销步骤。
    assert_eq!(editor.content_hash().unwrap(), hash);
    assert_eq!(editor.state()["document"]["history"].as_array().unwrap().len(), history_len);
    let list = editor.execute("cloneSource.list", json!({})).unwrap();
    assert_eq!(list["active"], json!(0));
    assert_eq!(list["sources"][0]["source"], json!([8.0, 8.0]));
    assert_eq!(list["sources"][0]["width"], json!(200.0));
    assert_eq!(list["sources"][0]["rotation"], json!(30.0));
    assert_eq!(list["overlay"]["blend"], json!("difference"));
    // 槽位已有取样点时不必再传 source；变换由内核冻结进这一笔。
    // 目标落在透明区（源是红块），否则把红色仿制到已经是红色的像素上会是零变化。
    let mut params = stroke_params(8);
    params["layer"] = json!(target);
    params["points"] = points(&[[40.0, 40.0], [42.0, 42.0]]);
    editor.begin_retouch("paint.cloneStamp", params).unwrap();
    editor.append_retouch(json!({"points":[[44.0, 44.0]]})).unwrap();
    // 预览不改正式内容。
    assert_eq!(editor.content_hash().unwrap(), hash, "预览不改内容指纹");
    editor.commit_retouch().unwrap();
    assert_eq!(editor.retouch_state()["active"], json!(false));
    assert_ne!(editor.content_hash().unwrap(), hash, "带变换的仿制必须有实际采样结果");
    editor.undo().unwrap();
    assert_eq!(editor.content_hash().unwrap(), hash);
    // 变换重置只改槽位，不改内容。
    editor.execute("cloneSource.resetTransform", json!({"index":0})).unwrap();
    let list = editor.execute("cloneSource.list", json!({})).unwrap();
    assert_eq!(list["sources"][0]["width"], json!(100.0));
    assert_eq!(list["sources"][0]["rotation"], json!(0.0));
    assert_eq!(list["sources"][0]["flipH"], json!(false));
    assert_eq!(editor.content_hash().unwrap(), hash);
}

#[test]
fn clone_source_commands_are_gated_by_the_single_command_gate() {
    // 新增命令必须真的进唯一命令门；未登记的名字仍然被拒绝。
    for id in ["cloneSource.list", "cloneSource.select", "cloneSource.set", "cloneSource.resetTransform", "cloneSource.overlay"] {
        assert!(crate::capability::command_allowed(id), "{id} 未进入命令门");
    }
    let mut editor = editor_with_content();
    assert!(editor.execute("cloneSource.select", json!({"index":9})).is_err());
    assert!(editor.execute("cloneSource.overlay", json!({"blend":"multiply"})).is_err());
}

#[test]
fn pending_capability_ids_match_the_delivered_contribution() {
    // U37/U38/U39 已随共享聚合开放：待发布清单必须与 CONTRIBUTION **同序同值**并真的进握手，
    // 否则会出现「清单说已发布、握手里没有」或只改一侧的假交付。
    let pending = crate::features::retouch::PENDING_CAPABILITIES;
    assert_eq!(pending.len(), 8);
    let declared: Vec<&str> = crate::features::retouch::CONTRIBUTION
        .capabilities
        .iter()
        .filter(|entry| entry.id.starts_with("retouch."))
        .map(|entry| entry.id)
        .collect();
    assert_eq!(declared, pending, "能力清单与 CONTRIBUTION 必须同序同值");
    for id in pending {
        assert!(crate::capability::delivered_capabilities().contains(id), "{id} 必须已进 P6 握手");
    }
    // 命令可以立即放行：命令门是唯一写入口，未登记的名字仍然被拒绝。
    for id in ["paint.patch", "paint.contentAwareMove", "paint.remove", "paint.redEye", "paint.patternStamp", "paint.historyBrush"] {
        assert!(crate::capability::command_allowed(id), "{id} 应已进命令门");
    }
}

#[test]
fn tool_parameters_are_normalized_instead_of_breaking_the_editor() {
    // U39：海绵发送 saturate/desaturate；减淡/加深范围与曝光、涂抹强度都按工具语义透传。
    let mut editor = editor_with_content();
    let target = layer(&editor);
    for (command, extra) in [
        ("paint.sponge", json!({"mode":"normal","spongeMode":"saturate"})),
        ("paint.sponge", json!({"mode":"normal"})),
        ("paint.dodge", json!({"toneRange":"highlights","exposure":70})),
        ("paint.burn", json!({"toneRange":"shadows","exposure":40})),
        ("paint.smudge", json!({"strength":80,"fingerPainting":false})),
        ("paint.blur", json!({"strength":60})),
        ("paint.sharpen", json!({"strength":40,"protectDetail":false})),
    ] {
        let mut params = stroke_params(10);
        params["layer"] = json!(target);
        params["points"] = points(&[[15.0, 15.0]]);
        for (key, value) in extra.as_object().unwrap() {
            params[key] = value.clone();
        }
        let begun = editor
            .begin_retouch(command, params)
            .unwrap_or_else(|error| panic!("{command} 应该可用: {error}"));
        assert_eq!(begun["command"], json!(command));
        editor.append_retouch(json!({"points":[[16.0, 16.0]]})).unwrap();
        editor
            .commit_retouch()
            .unwrap_or_else(|error| panic!("{command} 应该能提交: {error}"));
        assert_eq!(editor.retouch_state()["active"], json!(false), "{command} 提交后必须清空门禁");
    }
}
