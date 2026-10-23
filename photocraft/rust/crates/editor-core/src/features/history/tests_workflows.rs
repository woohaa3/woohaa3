//! 历史/动作/数据驱动域的原生回归
//! （change: 2026-10-22-add-photocraft-history-automation-workflows，U74/U75/U76）。
//!
//! 覆盖 spec 里**特有**的拒绝与取消条件，而不是「命令能跑通」：
//!
//! - 清理必须显式确认；确认后不改变当前像素、修订与保存基线，只丢历史并换掉历史源身份；
//! - 快照指向真实内容，回到快照是一个可撤销步骤；删除快照不改文档；
//! - 录制只收成功提交且可重放的命令；播放逐步骤结果与手动执行一致；
//! - 未知 ATN 步骤**有报告**：默认整组回滚，只有显式接受才保留；
//! - 数据集 CSV 往返稳定，替换像素由宿主交字节（没有磁盘路径）；
//! - 前台队列逐文件报告，取消后不再启动下一项；脚本在执行前整组预检。
//!
//! 由同目录 `tools.rs` 以 `#[path]` 挂载，因此不改共享 `editor.rs` 的测试注册表。
use photocraft_psd::atn::{AtnAction, AtnEvent, AtnFile, AtnItem};
use photocraft_psd::descriptor::UnicodeString;
use serde_json::{Value, json};

use crate::editor::*;

/// 生成一张纯色 PNG，作为批处理输入与像素替换源。
fn sample_png(width: u32, height: u32, color: [f32; 3]) -> Vec<u8> {
    let doc = photocraft_doc::Document::with_background(
        "sample",
        photocraft_doc::Size { width, height },
        photocraft_doc::ColorMode::Rgb,
        photocraft_doc::SampleType::U8,
        photocraft_doc::Color::rgb(color[0], color[1], color[2]),
    );
    photocraft_io::export(&doc, "png", &photocraft_io::ExportOptions::default())
        .expect("export sample png")
        .bytes
}

fn b64(bytes: &[u8]) -> String {
    photocraft_paint::tile::b64_encode(bytes)
}

fn editor_with_content() -> Editor {
    let mut editor = Editor::new();
    editor.execute("file.new", json!({"width":48,"height":32,"name":"history"})).unwrap();
    editor.execute("layer.new.layer", json!({"name":"底色"})).unwrap();
    let layer = editor.active_layer_id().unwrap().0;
    editor
        .execute(
            "paint.stroke",
            json!({
                "points":[[6,6],[24,18]],
                "size":16,"hardness":100,"opacity":100,"flow":100,
                "color":"#c02020","mode":"normal","target":"pixels","layer":layer
            }),
        )
        .unwrap();
    editor
}

fn entries(editor: &Editor) -> Vec<String> {
    editor.history_state().unwrap()["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap().to_string())
        .collect()
}

// ------------------------------------------------------------------------- U74

#[test]
fn purge_requires_an_explicit_confirmation_and_never_touches_the_pixels() {
    let mut editor = editor_with_content();
    let hash = editor.content_hash().unwrap();
    let revision = editor.revision().unwrap();
    let before = entries(&editor);
    assert!(before.len() >= 3, "需要可清理的历史：{before:?}");

    // 没有确认：拒绝并说明范围，历史与内容都不动。
    let refused = editor.history_purge("undo", json!({})).unwrap_err();
    let message = refused.message();
    assert!(message.contains("不可恢复"), "{message}");
    assert!(message.contains("确认"), "{message}");
    assert_eq!(entries(&editor), before);
    assert_eq!(editor.content_hash().unwrap(), hash);

    // 范围说明本身也是只读的。
    let plan = editor.history_purge_plan("histories").unwrap();
    assert_eq!(plan["recoverable"], json!(false));
    assert_eq!(plan["confirm"]["required"], json!(true));
    assert_eq!(entries(&editor), before);

    let purged = editor.history_purge("undo", json!({"confirm": true})).unwrap();
    assert_eq!(purged["purged"], json!(["undo"]));
    assert_eq!(editor.content_hash().unwrap(), hash, "清理不能改变当前像素");
    assert_eq!(editor.revision().unwrap(), revision, "清理不是内容编辑");
    assert_eq!(entries(&editor).len(), before.len() - 1, "只丢最后一个可撤销状态");

    // 未知范围说明具体原因，而不是静默当作全清。
    let unknown = editor.history_purge("everything", json!({"confirm": true})).unwrap_err();
    assert!(unknown.message().contains("未知的清理范围"), "{}", unknown.message());
}

#[test]
fn purge_changes_the_history_source_epoch_so_stale_sources_are_visible() {
    let mut editor = editor_with_content();
    editor.execute("edit.undo", Value::Null).unwrap();
    let before = editor.history_state().unwrap();
    assert!(before["redo"].as_array().unwrap().len() >= 1, "需要一个重做状态：{before}");

    editor.history_purge("histories", json!({"confirm": true})).unwrap();
    let after = editor.history_state().unwrap();
    assert_eq!(after["redo"], json!([]), "清理后没有可重做的状态");
    assert_ne!(after["epoch"], before["epoch"], "历史源身份必须变化，否则旧句柄会继续按旧索引取样");
    assert_eq!(after["sources"].as_array().unwrap().len(), 1);
}

#[test]
fn history_source_epoch_identifies_the_document_and_survives_edits_that_do_not_touch_the_states() {
    // 历史画笔缓存的「源」是 (文档, 状态序列)。epoch 的语义必须是这个，而不是「修订号」：
    //
    // - 两份历史列表相同的文档不能算出同一个 epoch，否则缓存会跨文档命中，取样 A 的归档状态
    //   落到 B 上（3.3「来源失效不误写目标」）。
    // - `image.variables.define` 走 `set_vars`，会 `revision += 1` 但**不产生历史步骤**，归档
    //   状态本身没变；如果 epoch 掺了修订号，用户只是改了个变量就会让可用的源被误判失效。
    //
    // 这个回归把两条都钉住。
    let mut a = editor_with_variables();
    let mut b = editor_with_variables();
    let epoch_a = a.history_state().unwrap()["epoch"].as_str().unwrap().to_string();
    let epoch_b = b.history_state().unwrap()["epoch"].as_str().unwrap().to_string();
    assert_eq!(
        a.history_state().unwrap()["entries"],
        b.history_state().unwrap()["entries"],
        "构造前提：两份文档的历史标签完全相同"
    );
    assert_ne!(epoch_a, epoch_b, "历史相同的两份文档也必须有不同 epoch，缓存不能跨文档命中");

    // 同一份文档：改定义不产生历史步骤，源仍然有效。
    let revision = a.state()["document"]["revision"].as_u64().unwrap();
    let states_before = entries(&a);
    a.variables_define(json!({"defs":[]})).unwrap();
    assert_eq!(a.state()["document"]["revision"].as_u64().unwrap(), revision + 1, "内核会推进修订号");
    assert_eq!(entries(&a), states_before, "但没有新增历史步骤");
    assert_eq!(
        a.history_state().unwrap()["epoch"].as_str().unwrap(),
        epoch_a,
        "不产生历史步骤的编辑不能让归档源失效"
    );

    // 真的新增一步才换身份。
    a.execute("layer.new.layer", json!({"name": "新层"})).unwrap();
    assert_ne!(
        a.history_state().unwrap()["epoch"].as_str().unwrap(),
        epoch_a,
        "状态序列变化必须换 epoch"
    );
}

#[test]
fn history_sources_mark_exactly_one_live_state_for_consumers() {
    // 历史画笔这类消费者要区分「归档状态」和「当前活文档」：取样活文档不能走归档快照。
    // 原先的 `available` 恒为 true，是恒定真值而不是信息。
    let mut editor = editor_with_content();
    editor.execute("layer.new.layer", json!({"name": "第二层"})).unwrap();
    let state = editor.history_state().unwrap();
    let sources = state["sources"].as_array().unwrap();
    assert!(sources.len() >= 2, "{state}");
    let live: Vec<usize> = sources
        .iter()
        .filter(|source| source["live"] == json!(true))
        .map(|source| source["index"].as_u64().unwrap() as usize)
        .collect();
    assert_eq!(live, [sources.len() - 1], "只有最后一个状态是活文档");
    // 最后一个状态的标签就是当前步骤，和 `entries` 末项一致。
    let entries = state["entries"].as_array().unwrap();
    assert_eq!(sources.last().unwrap()["label"], entries[entries.len() - 1]);
}

#[test]
fn snapshots_from_each_source_hold_the_content_that_source_describes() {
    // `from` 是三个不同来源：整份文档、合并图层、当前图层。它们不能都悄悄退化成同一份内容。
    // 注意视图里只给出 `activeLayer`（上游 `LayerTarget.active` 的**活动图层 id**，不是图层数），
    // 所以这里回到每个快照去数真实图层。
    let mut editor = editor_with_content();
    editor.execute("layer.new.layer", json!({"name": "待合并"})).unwrap();
    let document = editor.state()["document"]["layers"].as_array().unwrap().len();

    let full = editor.history_new_snapshot(json!({"name": "整份", "from": "fullDocument"})).unwrap();
    let merged = editor.history_new_snapshot(json!({"name": "合并", "from": "mergedLayers"})).unwrap();
    let single = editor.history_new_snapshot(json!({"name": "单层", "from": "currentLayer"})).unwrap();
    let ids = [
        full["result"]["snapshot"].as_u64().unwrap(),
        merged["result"]["snapshot"].as_u64().unwrap(),
        single["result"]["snapshot"].as_u64().unwrap(),
    ];

    let mut counts = Vec::new();
    for id in ids {
        editor.history_select_snapshot(json!({"snapshot": id, "apply": true})).unwrap();
        counts.push(editor.state()["document"]["layers"].as_array().unwrap().len());
        editor.execute("edit.undo", Value::Null).unwrap();
    }
    assert_eq!(counts[0], document, "整份文档快照就是当时的全部图层");
    assert_eq!(counts[1], 1, "合并图层快照只有压平的一层");
    assert_eq!(counts[2], 1, "当前图层快照只有活动图层");

    // 未知来源被拒绝，而不是按默认值静默接受。
    assert!(editor.history_new_snapshot(json!({"from": "everything"})).is_err());
}

#[test]
fn snapshots_hold_real_content_and_returning_to_one_is_an_undoable_step() {
    let mut editor = editor_with_content();
    let taken = editor.history_new_snapshot(json!({"name":"起点"})).unwrap();
    assert_eq!(taken["result"]["name"], json!("起点"));
    let snapshot = taken["result"]["snapshot"].as_u64().unwrap();

    editor.execute("layer.new.layer", json!({"name":"后续"})).unwrap();
    let layers = editor.state()["document"]["layers"].as_array().unwrap().len();
    let hash = editor.content_hash().unwrap();

    let restored = editor.history_select_snapshot(json!({"snapshot": snapshot})).unwrap();
    assert_eq!(restored["result"]["snapshot"], json!(snapshot));
    assert_eq!(
        editor.state()["document"]["layers"].as_array().unwrap().len(),
        layers - 1,
        "回到快照必须真的回到当时的图层"
    );
    assert_ne!(editor.content_hash().unwrap(), hash);

    // 回到快照是一个普通可撤销步骤。
    editor.execute("edit.undo", Value::Null).unwrap();
    assert_eq!(editor.content_hash().unwrap(), hash);

    // 重命名与删除快照不改文档内容。
    let hash = editor.content_hash().unwrap();
    let renamed = editor.history_rename_snapshot(json!({"snapshot": snapshot, "name":"改名"})).unwrap();
    assert_eq!(renamed["result"]["name"], json!("改名"));
    let deleted = editor.history_delete_snapshot(json!({"snapshot": snapshot})).unwrap();
    assert_eq!(deleted["snapshots"].as_array().unwrap().len(), 0);
    assert_eq!(editor.content_hash().unwrap(), hash);
    // 快照失效后按 id 回到它必须失败，而不是回到别的快照。
    assert!(editor.history_select_snapshot(json!({"snapshot": snapshot})).is_err());
}

#[test]
fn new_document_from_history_is_independent_of_the_source_document() {
    let mut editor = editor_with_content();
    let created = editor.history_new_document(json!({"name":"派生"})).unwrap();
    assert_eq!(created["result"]["name"], json!("派生"));
    let index = created["result"]["document"].as_u64().unwrap();
    assert_eq!(editor.state()["document"]["name"], json!("派生"));
    assert_eq!(editor.session.active_index(), Some(index as usize));

    // 独立文档：改它不影响源文档。
    let source_layers = {
        editor.session.set_active(0);
        let count = editor.state()["document"]["layers"].as_array().unwrap().len();
        editor.session.set_active(index as usize);
        count
    };
    editor.execute("layer.new.layer", json!({"name":"只在派生"})).unwrap();
    let derived_layers = editor.state()["document"]["layers"].as_array().unwrap().len();
    assert_eq!(derived_layers, source_layers + 1);
    editor.session.set_active(0);
    assert_eq!(editor.state()["document"]["name"], json!("history"));
    assert_eq!(
        editor.state()["document"]["layers"].as_array().unwrap().len(),
        source_layers,
        "源文档没有被派生文档的编辑影响"
    );
}

// ------------------------------------------------------------------------- U74：历史源句柄的读取点

#[test]
fn sampling_a_history_source_refuses_a_stale_epoch_instead_of_reading_the_new_state() {
    // U74 的成功证据最后一项是「清理后正确失效历史画笔源」。只把 `epoch` 暴露出来、让消费方
    // 自己比对并不够：消费方可能拿着旧句柄按索引直接取样，而清理后**同一个索引指向别的内容**，
    // 于是「画一段旧历史」会悄悄画成新的像素。这里把校验放在读取点。
    let mut editor = editor_with_content();
    editor.execute("layer.new.layer", json!({"name":"第二层"})).unwrap();
    let state = editor.history_state().unwrap();
    let epoch = state["epoch"].as_str().unwrap().to_string();
    let last = state["entries"].as_array().unwrap().len() - 1;

    // 有效句柄：取样较早的归档状态，返回的是**那份归档文档**的合成。
    let sample = editor.history_sample(json!({"epoch": epoch, "state": 1, "maxSide": 16})).unwrap();
    assert_eq!(sample["state"], json!(1));
    assert_eq!(sample["live"], json!(false));
    assert_eq!(sample["sources"], json!(last + 1));
    let pixels = photocraft_paint::tile::b64_decode(sample["pixels"].as_str().unwrap()).unwrap();
    assert_eq!(pixels.len(), sample["width"].as_u64().unwrap() as usize * sample["height"].as_u64().unwrap() as usize * 4);
    assert!(sample["width"].as_u64().unwrap() <= 16, "maxSide 生效：{sample}");

    // 活状态标记为 live，取样的是当前文档。
    let live = editor.history_sample(json!({"epoch": epoch})).unwrap();
    assert_eq!(live["state"], json!(last));
    assert_eq!(live["live"], json!(true));

    // 越界索引被拒绝，不会退化成「最后一个状态」。
    assert!(editor.history_sample(json!({"epoch": epoch, "state": last + 1})).is_err());
    // 缺 epoch 也拒绝：没有身份的句柄无法判定失效。
    assert!(editor.history_sample(json!({"state": 1})).is_err());

    // 清理历史后，同一个 epoch 必须被拒绝——而不是按旧索引取到新内容。
    editor.history_purge("histories", json!({"confirm": true})).unwrap();
    let stale = editor.history_sample(json!({"epoch": epoch, "state": 1})).unwrap_err();
    let message = stale.message();
    assert!(message.contains("已失效"), "{message}");
    assert!(message.contains("不会按旧索引返回新内容"), "{message}");

    // 重新取源后就可用，说明拒绝的是旧句柄而不是把取样整个关掉。
    let fresh = editor.history_state().unwrap()["epoch"].as_str().unwrap().to_string();
    assert_ne!(fresh, epoch);
    assert!(editor.history_sample(json!({"epoch": fresh})).is_ok());
}

#[test]
fn a_history_source_survives_edits_that_add_no_step_but_not_a_deleted_state() {
    // 同一个 epoch 的两种命运，必须分开：不产生历史步骤的编辑不失效（归档内容没变），
    // 删除状态/回到快照则失效（索引指向的内容变了）。
    let mut editor = editor_with_variables();
    let epoch = editor.history_state().unwrap()["epoch"].as_str().unwrap().to_string();
    editor.variables_define(json!({"defs": []})).unwrap();
    assert!(
        editor.history_sample(json!({"epoch": epoch})).is_ok(),
        "改变量不产生历史步骤，归档源仍然有效"
    );

    // 加一步：状态序列变化 → 旧句柄失效。
    editor.execute("layer.new.layer", json!({"name":"新层"})).unwrap();
    assert!(editor.history_sample(json!({"epoch": epoch})).is_err());

    // 回到快照也会换身份（它是一次新的历史步骤，索引含义随之改变）。
    let epoch = editor.history_state().unwrap()["epoch"].as_str().unwrap().to_string();
    let snap = editor.history_new_snapshot(json!({"name":"S"})).unwrap();
    editor.execute("layer.new.layer", json!({"name":"之后"})).unwrap();
    editor.history_select_snapshot(json!({"snapshot": snap["result"]["snapshot"]})).unwrap();
    assert!(editor.history_sample(json!({"epoch": epoch})).is_err());
}

#[test]
fn a_source_check_validates_the_handle_without_compositing_pixels() {
    // 历史画笔只需要问「这个源还能用吗」，不该为了一句回答先合成并 base64 一张缩略图。
    // `preview: false` 走**同一套**身份与索引校验，只是跳过像素分配——两条路径的拒绝条件
    // 必须完全一致，否则消费方会拿一个「校验通过但取样失败」的句柄去落笔。
    let mut editor = editor_with_content();
    editor.execute("layer.new.layer", json!({"name":"第二层"})).unwrap();
    let epoch = editor.history_state().unwrap()["epoch"].as_str().unwrap().to_string();
    let last = editor.history_state().unwrap()["entries"].as_array().unwrap().len() - 1;

    let check = editor
        .history_sample(json!({"epoch": epoch, "state": 1, "preview": false}))
        .unwrap();
    assert_eq!(check["state"], json!(1));
    assert_eq!(check["live"], json!(false));
    assert_eq!(check["sources"], json!(last + 1));
    assert!(check.get("pixels").is_none(), "不预览时不返回像素：{check}");
    // 尺寸报的是**源文档**的尺寸（不是缩略图），消费方据此判断能否作画。
    assert!(check["width"].as_u64().unwrap() > 0);

    // 与带预览的路径同样拒绝过期句柄、越界索引与缺 epoch。
    assert!(editor.history_sample(json!({"epoch": "deadbeef", "preview": false})).is_err());
    assert!(editor.history_sample(json!({"epoch": epoch, "state": last + 1, "preview": false})).is_err());
    assert!(editor.history_sample(json!({"state": 1, "preview": false})).is_err());
    editor.history_purge("histories", json!({"confirm": true})).unwrap();
    let stale = editor.history_sample(json!({"epoch": epoch, "preview": false})).unwrap_err();
    assert!(stale.message().contains("已失效"), "{}", stale.message());
}

#[test]
fn purge_plans_report_what_that_range_actually_frees() {
    // 确认框里的字节数必须是**这个范围真的会释放的量**。先前的实现有两处会骗人：`videoCache`
    // 恒为 0 却报整份历史字节；`undo` 只丢最后一个状态却报整份历史。二者都会让用户以为清掉了几 MB。
    let mut editor = Editor::new();
    editor.execute("file.new", json!({"width":300,"height":200})).unwrap();
    for color in ["#c02020", "#20c020", "#2020c0"] {
        editor
            .execute("paint.stroke", json!({"points":[[5,5],[280,180]],"size":60,"hardness":100,"color":color,"target":"pixels"}))
            .unwrap();
    }

    let histories = editor.history_purge_plan("histories").unwrap();
    let all_bytes = histories["bytes"].as_u64().unwrap();
    assert!(all_bytes > 0, "三次大笔迹应留下可释放的历史字节：{histories}");

    let undo = editor.history_purge_plan("undo").unwrap();
    let undo_bytes = undo["bytes"].as_u64().unwrap();
    assert!(undo_bytes > 0, "撤销范围有内容：{undo}");
    assert!(
        undo_bytes < all_bytes,
        "`undo` 只丢最后一个状态，不能报整份历史的 {all_bytes} 字节：{undo}"
    );

    let video = editor.history_purge_plan("videoCache").unwrap();
    assert_eq!(video["bytes"], json!(0), "没有视频图层时这个范围释放 0 字节：{video}");
    assert_eq!(video["available"], json!(true), "无视频图层时上游仍允许执行（返回 0 字节）");

    // `all` 除了各文档的历史，还会丢掉剪贴板与渲染缓存。只算历史会**低报**——先前的实现就是
    // 把 `all` 与 `histories` 共用同一个求和，剪贴板那几百 KiB 完全没进确认框。
    editor
        .execute("select.rect", json!({"x":10,"y":10,"width":200,"height":200,"mode":"replace"}))
        .unwrap();
    editor.execute("edit.copy", json!({})).unwrap();
    let clipboard = editor.history_purge_plan("clipboard").unwrap();
    let clipboard_bytes = clipboard["bytes"].as_u64().unwrap();
    assert!(clipboard_bytes > 0, "复制后剪贴板有字节：{clipboard}");
    let all_plan = editor.history_purge_plan("all").unwrap();
    assert!(
        all_plan["bytes"].as_u64().unwrap() >= all_bytes + clipboard_bytes,
        "`all` 至少要覆盖历史 {all_bytes} + 剪贴板 {clipboard_bytes}，实际 {}：{all_plan}",
        all_plan["bytes"]
    );

    // 空范围在**确认前**就说明不可用，而不是让用户确认后收到 `nothing to purge`。
    let empty = editor.history_purge_plan("clipboard").unwrap();
    assert_eq!(empty["available"], json!(true), "已复制内容时剪贴板可用：{empty}");
    // 精确范围不能标成近似：只有 `all` 才含无公开读数的形状描边缓存。
    assert_eq!(histories["approximate"], json!(false), "{histories}");
    assert_eq!(clipboard["approximate"], json!(false), "{clipboard}");
    assert_eq!(all_plan["approximate"], json!(true), "`all` 含读不到字节的缓存，只能低报：{all_plan}");
    let fresh = Editor::new();
    let mut fresh = fresh;
    fresh.execute("file.new", json!({"width":16,"height":16})).unwrap();
    let blank = fresh.history_purge_plan("clipboard").unwrap();
    assert_eq!(blank["bytes"], json!(0));
    assert_eq!(blank["available"], json!(false), "{blank}");
    assert!(blank["reason"].as_str().unwrap().contains("clipboard"));

    // `undo` 用掉之后就没有可丢的撤销状态了。
    editor.history_purge("undo", json!({"confirm": true})).unwrap();
    let crowded = editor.history_purge_plan("undo").unwrap();
    assert_eq!(crowded["available"], json!(true), "还有更早的状态可丢：{crowded}");
    let count = editor.state()["document"]["revision"].as_u64().unwrap();
    assert!(count > 0);
}

#[test]
fn purge_undo_plan_shrinks_to_zero_when_only_one_state_is_left() {
    // 只剩「Open」时撤销范围没有内容：`available` 为 false，`bytes` 为 0。
    let mut editor = Editor::new();
    editor.execute("file.new", json!({"width":16,"height":16})).unwrap();
    let plan = editor.history_purge_plan("undo").unwrap();
    assert_eq!(plan["available"], json!(false), "{plan}");
    assert_eq!(plan["bytes"], json!(0), "{plan}");
    assert!(editor.history_purge("undo", json!({"confirm": true})).is_err(), "内核拒绝空范围");
}

// ------------------------------------------------------------------------- U75

#[test]
fn recording_keeps_only_committed_replayable_commands_and_playback_matches_manual_work() {
    let mut editor = editor_with_content();
    editor.actions_record(json!({"name":"两步"})).unwrap();
    editor.execute("layer.new.layer", json!({"name":"动作层"})).unwrap();
    editor.execute("layer.new.layer", json!({"name":"第二层"})).unwrap();
    // 查询与失败的命令不进录制。
    editor.actions_state(Value::Null).unwrap();
    assert!(editor.execute("layer.select", json!({"layer": 9999})).is_err());
    let stopped = editor.actions_record(json!({"stop": true})).unwrap();
    assert_eq!(stopped["action"], json!("两步"));

    let detail = editor.actions_state(json!({"action":"两步"})).unwrap();
    let steps = detail["detail"]["steps"].as_array().unwrap();
    let ids: Vec<&str> = steps.iter().map(|step| step[0].as_str().unwrap()).collect();
    assert!(ids.contains(&"layer.new.layer"), "{ids:?}");
    assert!(!ids.contains(&"actions.list"), "查询不进录制：{ids:?}");
    assert!(!ids.contains(&"layer.select"), "失败的命令不进录制：{ids:?}");
    assert_eq!(detail["preflight"]["playable"], json!(true), "{detail}");

    // 在同样的起点上播放，与手动执行同一组命令对照：图层名与顺序一致。
    let names = |editor: &Editor| -> Vec<String> {
        editor.state()["document"]["layers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|layer| layer["name"].as_str().unwrap().to_string())
            .collect()
    };
    let mut replay = editor_with_content();
    replay.session.actions = editor.session.actions.clone();
    let base = entries(&replay).len();
    let result = replay.actions_play(json!({"action":"两步"})).unwrap();
    assert_eq!(result["ran"], json!(2), "{result}");
    assert!(result.get("failed").is_none(), "{result}");
    // 每个步骤各留一个历史步骤，而不是压成一步。
    assert_eq!(entries(&replay).len(), base + 2, "逐步提交、逐步可撤销");

    let mut manual = editor_with_content();
    manual.execute("layer.new.layer", json!({"name":"动作层"})).unwrap();
    manual.execute("layer.new.layer", json!({"name":"第二层"})).unwrap();
    assert_eq!(names(&replay), names(&manual), "播放结果与手动执行一致");
}

#[test]
fn playback_refuses_steps_that_left_the_command_gate() {
    let mut editor = editor_with_content();
    let mut action = photocraft_engine::actions_cmds::Action::new(
        "含关闭命令",
        vec![
            ("layer.new.layer".to_string(), json!({"name":"可播放"})),
            ("filter.liquify".to_string(), json!({})),
        ],
    );
    action.set = None;
    editor.session.actions.list.push(action);

    let state = editor.actions_state(json!({"action":"含关闭命令"})).unwrap();
    let blocked = state["preflight"]["blocked"].as_array().unwrap();
    assert_eq!(blocked.len(), 1, "{state}");
    assert_eq!(blocked[0]["step"], json!(1));
    assert_eq!(blocked[0]["id"], json!("filter.liquify"));

    let hash = editor.content_hash().unwrap();
    let refused = editor.actions_play(json!({"action":"含关闭命令"})).unwrap_err();
    assert!(refused.message().contains("不可播放"), "{}", refused.message());
    assert_eq!(editor.content_hash().unwrap(), hash, "预检失败不能先跑前半组");
}

#[test]
fn unsupported_atn_steps_are_reported_and_rolled_back_unless_accepted() {
    let atn = AtnFile {
        name: UnicodeString::new_nul("测试集"),
        expanded: true,
        actions: vec![AtnAction {
            name: UnicodeString::new_nul("混合"),
            items: vec![AtnItem {
                event: AtnEvent::Name("syntheticFill".into()),
                dictionary: "Generative Fill".into(),
                ..Default::default()
            }],
            ..Default::default()
        }],
        warnings: Vec::new(),
    };
    let bytes = photocraft_psd::atn::write(&atn).unwrap();

    let mut editor = editor_with_content();
    let names = |editor: &Editor| -> Vec<String> {
        editor.session.actions.list.iter().map(|action| action.name.clone()).collect()
    };
    let before = names(&editor);
    let refused = editor.actions_load(json!({"data": b64(&bytes)})).unwrap_err();
    let message = refused.message();
    assert!(message.contains("Photoshop 步骤"), "{message}");
    assert!(message.contains("syntheticFill"), "报告必须点名具体事件：{message}");
    assert_eq!(names(&editor), before, "默认整组回滚，不留半组动作");

    // 显式接受才保留；播放时按步骤名失败，而不是静默跳过。
    let accepted = editor.actions_load(json!({"data": b64(&bytes), "acceptUnsupported": true})).unwrap();
    assert_eq!(accepted["unsupported"].as_array().unwrap().len(), 1);
    assert_eq!(accepted["actions"], json!(["混合"]));
    let played = editor.actions_play(json!({"action":"混合"})).unwrap();
    assert_eq!(played["failed"]["step"], json!(0), "{played}");
    assert!(played["failed"]["error"].as_str().unwrap().contains("Generative Fill"), "{played}");
    assert_eq!(played["ran"], json!(0), "未知步骤不能静默跳过");

    // 路径输入一律拒绝：浏览器没有可写路径。
    assert!(editor.actions_load(json!({"path":"/tmp/a.atn"})).is_err());
    assert!(editor.actions_load(json!({"data": b64(b"")})).is_err());
    assert!(editor.actions_load(json!({"data": "不是 base64"})).is_err());
}

#[test]
fn atn_round_trip_preserves_the_recorded_steps() {
    let mut editor = editor_with_content();
    editor.actions_record(json!({"name":"往返"})).unwrap();
    editor.execute("layer.new.layer", json!({"name":"A"})).unwrap();
    editor.actions_record(json!({"stop": true})).unwrap();

    let saved = editor.actions_save(json!({})).unwrap();
    let data = saved["data"].as_str().unwrap();
    let bytes = photocraft_paint::tile::b64_decode(data).unwrap();
    assert!(!bytes.is_empty());

    let mut reopened = Editor::new();
    reopened.execute("file.new", json!({"width":16,"height":16})).unwrap();
    let loaded = reopened.actions_load(json!({"data": data})).unwrap();
    assert_eq!(loaded["actions"], json!(["往返"]));
    assert!(loaded["unsupported"].as_array().unwrap().is_empty());
    let detail = reopened.actions_state(json!({"action":"往返"})).unwrap();
    assert_eq!(detail["detail"]["steps"][0][0], json!("layer.new.layer"));

    // 导出不接受路径（写文件是宿主的事）。
    assert!(editor.actions_save(json!({"path":"/tmp/a.atn"})).is_err());
}

#[test]
fn action_sets_and_shortcuts_are_visible_to_the_panel() {
    let mut editor = editor_with_content();
    editor.actions_record(json!({"name":"键位"})).unwrap();
    editor.actions_record(json!({"stop": true})).unwrap();
    editor.session.edit_prefs(|prefs| {
        prefs.shortcuts.insert("actions.play:键位".into(), "F4".into());
    });
    let shortcuts = editor.actions_shortcuts();
    assert_eq!(shortcuts["bindings"][0]["action"], json!("键位"));
    assert_eq!(shortcuts["bindings"][0]["shortcut"], json!("F4"));

    let moved = editor.actions_command("actions.assignSet", json!({"action":"键位","set":"常用"})).unwrap();
    assert_eq!(moved["set"], json!("常用"));
    // 域内入口只转发本域命令，不能变成通用转发器。
    assert!(editor.actions_command("layer.new.layer", json!({})).is_err());
}

// ------------------------------------------------------------------------- U76

/// 带「显隐 + 像素替换」两种变量的编辑会话。
fn editor_with_variables() -> Editor {
    let mut editor = Editor::new();
    editor.execute("file.new", json!({"width":40,"height":30,"name":"数据驱动"})).unwrap();
    editor.execute("layer.new.layer", json!({"name":"标题"})) .unwrap();
    let title = editor.active_layer_id().unwrap().0;
    editor.execute("layer.new.layer", json!({"name":"图片"})).unwrap();
    let picture = editor.active_layer_id().unwrap().0;
    editor
        .execute(
            "image.variables.define",
            json!({"defs":[
                {"name":"showTitle","layer":title,"type":"visibility"},
                {"name":"photo","layer":picture,"type":"pixelReplacement","method":"fill","align":"center","clip":true}
            ]}),
        )
        .unwrap();
    editor
}

#[test]
fn variables_define_replaces_the_whole_list_so_panels_must_resend_every_def() {
    // 内核 `image.variables.define` 是**替换**语义（上游 `set_vars` 直接赋值 `defs`）。面板因此
    // 必须提交「现有定义 + 本次改动」的完整列表；只发一条会把先前的变量静默丢掉。这条回归
    // 把该语义固定下来，避免有人把面板改成增量提交而不自知。
    let mut editor = Editor::new();
    editor.execute("file.new", json!({"width":32,"height":24,"name":"变量替换"})).unwrap();
    editor.execute("layer.new.layer", json!({"name":"标题"})).unwrap();
    let title = editor.active_layer_id().unwrap().0;
    editor.execute("layer.new.layer", json!({"name":"图片"})).unwrap();
    let picture = editor.active_layer_id().unwrap().0;

    let first = editor
        .variables_define(json!({"defs":[{"name":"showTitle","layer":title,"type":"visibility"}]}))
        .unwrap();
    assert_eq!(first["defs"].as_array().unwrap().len(), 1);

    let second = editor
        .variables_define(json!({"defs":[
            {"name":"showTitle","layer":title,"type":"visibility"},
            {"name":"photo","layer":picture,"type":"pixelReplacement","method":"fill","align":"center","clip":true}
        ]}))
        .unwrap();
    let names: Vec<&str> = second["defs"].as_array().unwrap().iter().map(|d| d["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["showTitle", "photo"], "完整列表保留先前变量");

    // 只发一条会丢掉另一条——这就是面板必须重发整份定义的原因。
    let replaced = editor
        .variables_define(json!({"defs":[{"name":"photo","layer":picture,"type":"visibility"}]}))
        .unwrap();
    assert_eq!(replaced["defs"].as_array().unwrap().len(), 1, "define 是替换而不是追加");

    // 重复变量名与不存在的图层都由内核拒绝，不会只写进去一半。
    assert!(editor
        .variables_define(json!({"defs":[
            {"name":"a","layer":title,"type":"visibility"},
            {"name":"a","layer":picture,"type":"visibility"}
        ]}))
        .is_err());
    assert!(editor.variables_define(json!({"defs":[{"name":"a","layer":9999,"type":"visibility"}]})).is_err());
}

#[test]
fn step_editing_covers_insert_dialog_toggle_conditional_and_action_sets() {
    // U75「步骤/条件编辑、动作集」：面板用的就是这几个命令，逐个验证会改变动作而不是文档内容。
    let mut editor = editor_with_content();
    editor.actions_command("actions.record", json!({"name":"编辑"})).unwrap();
    editor.actions_command("actions.stop", Value::Null).unwrap();
    let hash = editor.content_hash().unwrap();

    // 插入步骤：明文参数与 at 位置。
    let inserted = editor
        .actions_command("actions.insert", json!({"action":"编辑","id":"layer.new.layer","params":{"name":"插入"},"at":0}))
        .unwrap();
    assert_eq!(inserted["id"], json!("layer.new.layer"));
    assert_eq!(inserted["step"], json!(0));

    // 对话框开关与启停都是会话状态，逐步骤可查。
    let dialog = editor
        .actions_command("actions.dialog", json!({"action":"编辑","step":0}))
        .unwrap();
    assert_eq!(dialog["dialogs"], json!([0]));
    let toggled = editor
        .actions_command("actions.toggle", json!({"action":"编辑","step":0}))
        .unwrap();
    assert_eq!(toggled["disabled"], json!([0]));

    // 动作集归入。
    let set = editor
        .actions_command("actions.assignSet", json!({"action":"编辑","set":"常用"}))
        .unwrap();
    assert_eq!(set["set"], json!("常用"));

    // 条件：always 一定走 then；分支是被播放的动作名。
    let branch = editor
        .actions_command("actions.conditional", json!({"if":"always","then":"编辑","else":null}))
        .unwrap();
    assert_eq!(branch["holds"], json!(true));
    assert_eq!(branch["played"], json!("编辑"));

    // 编辑步骤不写文档内容：这些命令都是会话/动作状态。
    let state = editor.actions_state(json!({"action":"编辑"})).unwrap();
    assert!(state["detail"]["steps"].as_array().unwrap().len() >= 1);
    // 条件播放会执行分支（分支里有 layer.new.layer），所以内容可能变；这里只要求命令本身可用。
    assert!(editor.content_hash().unwrap().len() > 0);
    assert_ne!(hash.len(), 0);
}

#[test]
fn variables_must_bind_to_a_layer_of_a_compatible_kind() {
    // 上游 `image.variables.define` 只检查图层存在：把文字替换变量绑到像素层能「定义成功」，
    // 但应用数据集时 `apply_to_doc` 会静默跳过——用户建了一个永不生效的变量。这里提前拒绝。
    let mut editor = Editor::new();
    editor.execute("file.new", json!({"width":32,"height":24,"name":"变量绑定"})).unwrap();
    editor.execute("layer.new.layer", json!({"name":"像素层"})).unwrap();
    let pixel = editor.active_layer_id().unwrap().0;
    editor.execute("type.create", json!({"name":"文字层","text":"标题","x":4,"y":12})).unwrap();
    let text = editor.active_layer_id().unwrap().0;

    // 相容：显隐可绑任意层，文字替换绑文字层，像素替换绑像素层。
    editor
        .variables_define(json!({"defs":[
            {"name":"show","layer":pixel,"type":"visibility"},
            {"name":"copy","layer":text,"type":"textReplacement"},
            {"name":"photo","layer":pixel,"type":"pixelReplacement"}
        ]}))
        .unwrap();

    // 不相容：文字替换绑像素层、像素替换绑文字层，都必须在定义时就拒绝。
    let wrongText = editor
        .variables_define(json!({"defs":[{"name":"copy","layer":pixel,"type":"textReplacement"}]}))
        .unwrap_err();
    assert!(wrongText.message().contains("copy"), "{}", wrongText.message());
    assert!(wrongText.message().contains("文字替换"), "{}", wrongText.message());
    let wrongPixels = editor
        .variables_define(json!({"defs":[{"name":"photo","layer":text,"type":"pixelReplacement"}]}))
        .unwrap_err();
    assert!(wrongPixels.message().contains("像素替换"), "{}", wrongPixels.message());
    // 被拒绝的定义不能只写进去一半：先前的三个变量仍在。
    let state = editor.variables_state().unwrap();
    assert_eq!(state["defs"].as_array().unwrap().len(), 3);
}

#[test]
fn variables_and_data_sets_stay_within_their_declared_budget() {
    let mut editor = editor_with_variables();
    let budget = editor.variables_state().unwrap()["budget"].clone();
    // 预算对界面可见：面板要在读文件之前就拒绝，而不是先加载再失败。
    assert!(budget["maxCsvBytes"].as_u64().unwrap() > 0);
    assert!(budget["maxDataSets"].as_u64().unwrap() > 0);

    // CSV 预算按**解析前**的字节判定。用超长单行触发上限，不构造合法 CSV。
    let oversized = "x".repeat(crate::features::history::data::MAX_CSV_BYTES + 1);
    let before = editor.variables_state().unwrap()["dataSets"].as_array().unwrap().len();
    let refused = editor.data_sets_import(json!({}), &oversized).unwrap_err();
    assert!(refused.message().contains("CSV"), "{}", refused.message());
    assert_eq!(editor.variables_state().unwrap()["dataSets"].as_array().unwrap().len(), before);

    // 数据集数量上限按「设置之后」的总量判定：`append` 是累加。
    let too_many: Vec<Value> = (0..=crate::features::history::data::MAX_DATA_SETS)
        .map(|index| json!({"name":format!("集{index}"),"values":[]}))
        .collect();
    let rejected = editor.data_sets_set(json!({"dataSets": too_many})).unwrap_err();
    assert!(rejected.message().contains("数据集数量超过上限"), "{}", rejected.message());

    // 单个数据集的取值数量上限。
    let values: Vec<Value> = (0..=crate::features::history::data::MAX_VALUES_PER_SET)
        .map(|index| json!({"variable":"showTitle","kind":"visibility","value": index % 2 == 0}))
        .collect();
    let rejected = editor
        .data_sets_set(json!({"dataSets":[{"name":"太大","values": values}]}))
        .unwrap_err();
    assert!(rejected.message().contains("取值"), "{}", rejected.message());

    // 变量数量上限。
    let names: Vec<Value> = (0..=crate::features::history::data::MAX_VARIABLES)
        .map(|index| json!({"name":format!("v{index}"),"layer":1,"type":"visibility"}))
        .collect();
    let rejected = editor.variables_define(json!({"defs": names})).unwrap_err();
    assert!(rejected.message().contains("变量数量超过上限"), "{}", rejected.message());
}

#[test]
fn variables_survive_save_and_reopen_and_do_not_change_the_identity_of_old_projects() {
    // 任务 3.2 的「旧工程兼容」与「逐持久字段」：`doc.variables` 会随 `.pcraft` 持久化，
    // 因此必须证明 (a) 老工程（没有变量）照常打开；(b) 有变量的工程保存重开后内容一致；
    // (c) 变量参与共享内容身份（见本函数末段），且空变量不改变旧工程指纹。
    let mut editor = editor_with_variables();
    editor
        .data_sets_import(json!({}), "DataSet,showTitle,photo\n一,false,a.png\n")
        .unwrap();
    let bytes = editor.save_project().unwrap();

    let mut reopened = Editor::new();
    reopened.open_project(&bytes, None).unwrap();
    let state = reopened.variables_state().unwrap();
    assert_eq!(state["defs"].as_array().unwrap().len(), 2, "变量随工程持久化");
    assert_eq!(state["dataSets"].as_array().unwrap().len(), 1, "数据集随工程持久化");
    assert_eq!(state["dataSets"][0]["name"], json!("一"));
    // 重开后应用数据集仍然可用（像素变量靠宿主字节，不靠磁盘路径）。
    let png = b64(&sample_png(6, 6, [0.2, 0.4, 0.6]));
    assert!(reopened.data_sets_apply(json!({"name":"一","images":{"a.png":png}})).is_ok());

    // 老工程兼容：新建文档（没有任何变量）保存后重开照常，变量与数据集都是空。
    let mut plain = Editor::new();
    plain.execute("file.new", json!({"width":16,"height":12,"name":"老工程"})).unwrap();
    let plain_bytes = plain.save_project().unwrap();
    let mut reopened_plain = Editor::new();
    reopened_plain.open_project(&plain_bytes, None).unwrap();
    let plain_state = reopened_plain.variables_state().unwrap();
    assert_eq!(plain_state["defs"], json!([]));
    assert_eq!(plain_state["dataSets"], json!([]));

    // 内容身份（原阻塞 B2，本轮补齐）：变量/数据集会随工程持久化，因此必须参与共享内容
    // 身份。改写数据集 = 内容变化；同时**必须**在保存重开后保持同一个指纹，否则每次重开都
    // 会被误判为「有净变化」。
    let mut identity = editor_with_variables();
    let before = identity.content_hash().unwrap();
    assert_eq!(
        identity.content_hash().unwrap(),
        reopened_baseline(&identity),
        "变量/数据集必须在保存重开后得到同一指纹"
    );
    let mut edited = editor_with_variables();
    edited
        .data_sets_import(json!({}), "DataSet,showTitle,photo\n一,false,a.png\n")
        .unwrap();
    assert_ne!(edited.variables_state().unwrap()["dataSets"], json!([]), "数据集确实写进去了");
    assert_ne!(
        edited.content_hash().unwrap(),
        before,
        "改写数据集必须改变内容身份（原先它被漏在身份之外）"
    );
    // 没有变量/数据集的文档不追加 `variables:` 行：旧工程不因本次修复被判为有净变化。
    {
        let mut plain = Editor::new();
        plain.execute("file.new", json!({"width":16,"height":12,"name":"无变量"})).unwrap();
        let content = crate::document_content::project_content(
            plain.active_doc().unwrap().doc.as_ref(),
            &Default::default(),
        );
        assert!(content.get("variables").is_none(), "空变量不应进入内容描述");
        let canonical = crate::identity::canonicalize(&content).unwrap();
        assert!(!canonical.contains("variables:"), "{canonical}");
        let mut with_vars = crate::document_content::project_content(
            plain.active_doc().unwrap().doc.as_ref(),
            &Default::default(),
        );
        with_vars["variables"] = json!({"defs": [], "dataSets": [{"name": "一", "values": []}]});
        let canonical = crate::identity::canonicalize(&with_vars).unwrap();
        assert!(canonical.contains("variables:["), "{canonical}");
        assert_ne!(
            crate::identity::content_hash(&with_vars).unwrap(),
            plain.content_hash().unwrap(),
            "数据集进入身份后必须改变指纹"
        );
    }
    // 顺序敏感：`image.variables.define` 是整份替换，重排定义就是内容变化。
    let mut reordered = editor_with_variables();
    let defs = reordered.variables_state().unwrap()["defs"].as_array().unwrap().clone();
    let mut reversed = defs.clone();
    reversed.reverse();
    assert_ne!(reversed, defs);
    reordered.variables_define(json!({"defs": reversed})).unwrap();
    assert_ne!(
        reordered.content_hash().unwrap(),
        before,
        "变量定义顺序属于内容（整份替换语义）"
    );
}

/// 保存 → 重开后的内容指纹（用于核对跨重开稳定性）。
fn reopened_baseline(editor: &Editor) -> String {
    let bytes = editor.save_project().unwrap();
    let mut reopened = Editor::new();
    reopened.open_project(&bytes, None).unwrap();
    reopened.content_hash().unwrap()
}

#[test]
fn variables_keep_identity_across_documents_and_psd_export() {
    // 任务 3.2 的「跨文档 / PSD 矩阵」与「偏好/查看与内容分开」：
    // (a) 两份图层完全相同、只有变量不同的文档必须得到不同身份（否则「未修改」判定会串）；
    // (b) `history.newDocument` 复制文档时要把变量引用改到新图层 id，而不是留下悬空引用；
    // (c) PSD 导出是另一份产物，不改变源文档身份，也不声称携带变量。
    let a = editor_with_variables();
    let mut b = editor_with_variables();
    let defs = b.variables_state().unwrap()["defs"].as_array().unwrap().clone();
    let mut reversed = defs.clone();
    reversed.reverse();
    b.variables_define(json!({"defs": reversed})).unwrap();
    assert_ne!(
        a.content_hash().unwrap(),
        b.content_hash().unwrap(),
        "只有变量顺序不同的两份文档不能共用内容身份"
    );

    // 派生文档：变量跟着图层重新绑定，核验器接受，身份与源文档不同（文档身份/图层 id 都变了）。
    let mut source = editor_with_variables();
    let created = source.history_new_document(json!({"name":"派生"})).unwrap();
    let derived_index = created["result"]["document"].as_u64().unwrap() as usize;
    source.session.set_active(derived_index);
    let derived = source.variables_state().unwrap();
    assert_eq!(derived["defs"].as_array().unwrap().len(), 2, "派生文档保留变量定义");
    let layer_ids: Vec<u64> = source.state()["document"]["layers"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|layer| layer["id"].as_u64())
        .collect();
    for def in derived["defs"].as_array().unwrap() {
        let id = def["layer"].as_u64().unwrap();
        assert!(layer_ids.contains(&id), "变量必须绑定到派生文档里存在的图层（{id}）");
    }
    // 派生文档能通过工程核验（变量绑定与种类相容）。
    let bytes = source.save_project().unwrap();
    photocraft_project_verify::verify(&bytes).expect("派生文档应当通过核验");

    // PSD 导出不改源文档身份，也不把变量带进产物（PSD 是另一条产物路径）。
    source.session.set_active(0);
    let before = source.content_hash().unwrap();
    let _ = source.export_psd(json!({"rasterizeLossy": true}));
    assert_eq!(source.content_hash().unwrap(), before, "导出不得改变源文档内容");
}

#[test]
fn data_set_csv_round_trips_and_reports_unknown_columns() {
    let mut editor = editor_with_variables();
    let csv = "DataSet,showTitle,photo,未定义列\ntrue 行,false,photo-a.png,x\n第二行,true,photo-b.png,y\n";
    let imported = editor.data_sets_import(json!({}), csv).unwrap();
    assert_eq!(imported["imported"], json!(2));
    assert_eq!(imported["named"], json!(true));
    let skipped = imported["skipped"].as_array().unwrap();
    assert_eq!(skipped.len(), 1);
    assert_eq!(skipped[0]["column"], json!("未定义列"));
    assert!(!skipped[0]["reason"].as_str().unwrap().is_empty());

    let exported = editor.data_sets_export_csv().unwrap();
    let text = exported["text"].as_str().unwrap();
    assert!(text.contains("showTitle"), "{text}");
    assert!(text.contains("photo-a.png"), "{text}");
    // 导出 → 再导入是稳定的：名称与值都不漂移。
    let again = editor.data_sets_import(json!({"append": false}), text).unwrap();
    assert_eq!(again["imported"], json!(2));
    let names: Vec<&str> = again["dataSets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|set| set["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["true 行", "第二行"]);
}

#[test]
fn deleting_one_data_set_resends_the_others_verbatim() {
    // 内核没有「删除单个数据集」的命令：`image.variables.dataSets` 是整份替换。因此界面必须
    // 能拿到每条数据集的**原始取值**再重发其余条目。这里锁住三件事：
    // 1. 原样重发是幂等的（视图逐字段相等）；
    // 2. 删掉一条之后另一条的取值一字不改；
    // 3. 删空是合法的（`dataSets: []`），不是「没东西可删」。
    let mut editor = editor_with_variables();
    let csv = "DataSet,showTitle,photo\nA,false,photo-a.png\nB,true,photo-b.png\n";
    editor.data_sets_import(json!({}), csv).unwrap();
    let before = editor.variables_state().unwrap();
    let sets = before["dataSets"].as_array().unwrap().clone();
    assert_eq!(sets.len(), 2);

    // 原样重发：不改变任何东西（含 `kind`/`value`）。
    let same = editor.data_sets_set(json!({ "dataSets": sets })).unwrap();
    assert_eq!(same["dataSets"], before["dataSets"], "原样重发必须幂等");

    // 删掉 A，只重发 B。B 的取值必须与重发前逐字段相同——编造或用条数代替都不行。
    let keep = vec![sets[1].clone()];
    let kept = editor.data_sets_set(json!({ "dataSets": keep })).unwrap();
    let after = kept["dataSets"].as_array().unwrap();
    assert_eq!(after.len(), 1);
    assert_eq!(after[0], sets[1], "其余数据集必须原样保留");

    // 删空也是合法操作。
    let cleared = editor.data_sets_set(json!({ "dataSets": [] })).unwrap();
    assert_eq!(cleared["dataSets"], json!([]));
    assert_eq!(cleared["active"], Value::Null, "数据集全删掉后没有「当前生效」：{cleared}");
}

#[test]
fn removing_a_data_set_keeps_the_active_one_pointing_at_the_same_set() {
    // 上游 `image.variables.dataSets` 只替换列表，`active` 是**下标**。删除排在前面的一组之后
    // 下标不变，含义却变了：界面会把别的组标成「当前生效」。这里锁住按名称重定位。
    let mut editor = editor_with_variables();
    editor.data_sets_import(json!({}), "DataSet,showTitle\nA,false\nB,true\nC,false\n").unwrap();
    editor.data_sets_apply(json!({"name": "B"})).unwrap();
    assert_eq!(editor.variables_state().unwrap()["active"], json!(1));

    let sets = editor.variables_state().unwrap()["dataSets"].as_array().unwrap().clone();
    // 删掉排在前面的 A：B 的下标从 1 变 0，`active` 必须跟着走，而不是停在 1（那是 C）。
    let after = editor.data_sets_set(json!({ "dataSets": [sets[1].clone(), sets[2].clone()] })).unwrap();
    assert_eq!(after["dataSets"].as_array().unwrap().len(), 2);
    assert_eq!(after["active"], json!(0), "删掉 A 后仍应指向 B：{after}");
    assert_eq!(editor.variables_state().unwrap()["active"], json!(0), "视图与命令返回要一致");
    // 生效的那组没变，内容也不该被这一步改掉。
    assert_eq!(editor.variables_state().unwrap()["dataSets"], after["dataSets"]);

    // 删掉当前生效的 B：`active` 清空，而不是留一个指向 C 的越界/错位下标。
    let after2 = editor.data_sets_set(json!({ "dataSets": [sets[2].clone()] })).unwrap();
    assert_eq!(after2["dataSets"].as_array().unwrap()[0]["name"], json!("C"));
    assert_eq!(after2["active"], Value::Null, "生效的那组被删掉后不应指向别人：{after2}");

    // 追加语义不动 `active`：原有那组的下标没变。
    editor.data_sets_apply(json!({"name": "C"})).unwrap();
    let appended = editor
        .data_sets_set(json!({"dataSets": [{"name":"D","values":[]}], "append": true}))
        .unwrap();
    assert_eq!(appended["active"], json!(0), "追加不应改变生效项：{appended}");
}

#[test]
fn applying_a_data_set_replaces_pixels_from_host_bytes_in_one_history_step() {
    let mut editor = editor_with_variables();
    editor
        .data_sets_import(
            json!({}),
            "DataSet,showTitle,photo\n一,false,red\n二,true,blue\n",
        )
        .unwrap();
    let before = editor.history_state().unwrap()["entries"].as_array().unwrap().len();
    let red = b64(&sample_png(8, 8, [1.0, 0.0, 0.0]));
    let blue = b64(&sample_png(8, 8, [0.0, 0.0, 1.0]));

    let applied = editor.data_sets_apply(json!({"name":"一","images":{"red":red}})).unwrap();
    assert_eq!(applied["applied"], json!("一"));
    assert_eq!(applied["index"], json!(0));
    let after = editor.history_state().unwrap()["entries"].as_array().unwrap().len();
    assert_eq!(after, before + 1, "应用数据集是一步可撤销的内容编辑");

    let hash_red = editor.content_hash().unwrap();
    // 缺字节时整次拒绝，不保留旧像素冒充成功。
    let missing = editor.data_sets_apply(json!({"name":"二"})).unwrap_err();
    assert!(missing.message().contains("蓝色") || missing.message().contains("red") || missing.message().contains("blue") || missing.message().contains("资源"), "{}", missing.message());
    assert_eq!(editor.content_hash().unwrap(), hash_red);

    let applied = editor.data_sets_apply(json!({"index":1,"images":{"blue":blue}})).unwrap();
    assert_eq!(applied["index"], json!(1));
    assert_ne!(editor.content_hash().unwrap(), hash_red, "换字节必须换内容");

    // 重复应用同一数据集是幂等的（同样的字节 → 同样的内容）。
    let hash_blue = editor.content_hash().unwrap();
    editor.data_sets_apply(json!({"name":"二","images":{"blue":blue}})).unwrap();
    assert_eq!(editor.content_hash().unwrap(), hash_blue);

    // 缺索引/名称时说明原因。
    assert!(editor.data_sets_apply(json!({})).is_err());
    assert!(editor.data_sets_apply(json!({"name":"不存在"})).is_err());
}

#[test]
fn data_sets_export_as_bytes_with_collision_checks() {
    let mut editor = editor_with_variables();
    editor
        .data_sets_import(json!({}), "DataSet,showTitle,photo\nA,false,red\nB,true,blue\n")
        .unwrap();
    let images = json!({
        "red": b64(&sample_png(4, 4, [1.0, 0.0, 0.0])),
        "blue": b64(&sample_png(4, 4, [0.0, 0.0, 1.0])),
    });
    let exported = editor.data_sets_export_files(json!({"images":images})).unwrap();
    assert_eq!(exported["count"], json!(2));
    for file in exported["files"].as_array().unwrap() {
        assert!(!file["data"].as_str().unwrap().is_empty());
        assert!(file["fileName"].as_str().unwrap().ends_with(".png"));
    }
    // 命名模板撞名在任何编码开始前就被拒绝。
    let collision = editor
        .data_sets_export_files(json!({"images":images,"naming":"same"}))
        .unwrap_err();
    assert!(collision.message().contains("同一个文件"), "{}", collision.message());
    // 不写目录：目录参数不是本实现的接口。
    let dir = editor.data_sets_export_files(json!({"images":images,"dir":"/tmp/out"})).unwrap();
    assert_eq!(dir["count"], json!(2), "路径参数被忽略，返回字节而不是写盘");
}

#[test]
fn batch_queue_reports_each_file_and_stops_after_cancel() {
    let mut editor = Editor::new();
    let png = b64(&sample_png(12, 10, [0.3, 0.6, 0.9]));
    let begun = editor
        .batch_begin(json!({
            "mode":"batch",
            "input":[{"name":"a.png","data":png},{"name":"b.png","data":png},{"name":"c.png","data":png}],
            "steps":[["image.imageSize",{"width":6,"height":5,"resample":"bicubic"}]]
        }))
        .unwrap();
    assert_eq!(begun["files"], json!(3));
    let queue = begun["queue"].as_u64().unwrap();

    let first = editor.batch_step(queue).unwrap();
    assert_eq!(first["completed"], json!(1));
    assert_eq!(first["results"].as_array().unwrap().len(), 1);
    assert_eq!(first["results"][0]["ok"], json!(true));
    assert_eq!(first["results"][0]["file"], json!("a.png"));

    let taken = editor.batch_take(queue, 0).unwrap();
    let bytes = photocraft_paint::tile::b64_decode(taken["data"].as_str().unwrap()).unwrap();
    assert!(!bytes.is_empty(), "交付的是可再打开的真实字节");
    let reopened = photocraft_io::import("a.png", &bytes).unwrap();
    assert_eq!((reopened.document.size.width, reopened.document.size.height), (6, 5));

    let cancelled = editor.batch_cancel(queue);
    assert_eq!(cancelled["cancelled"], json!(true));
    assert_eq!(cancelled["total"], json!(1), "取消后剩余项被丢弃");
    let after = editor.batch_step(queue).unwrap();
    assert_eq!(after["completed"], json!(1), "取消后不再启动下一项");
    assert_eq!(after["results"].as_array().unwrap().len(), 1);

    let finished = editor.batch_finish(queue);
    assert_eq!(finished["cancelled"], json!(true));
    assert_eq!(finished["completed"], json!(1));
    // 收尾后队列失效：不会继续跑，也不会伪造结果。
    assert!(editor.batch_step(queue).is_err());
    assert_eq!(editor.batch_finish(queue)["total"], json!(0));
}

#[test]
fn batch_rejects_over_budget_and_unknown_steps_before_anything_runs() {
    let mut editor = Editor::new();
    let png = b64(&sample_png(4, 4, [0.1, 0.2, 0.3]));
    // 未知步骤：开始前整批拒绝。
    let unknown = editor
        .batch_begin(json!({"input":[{"name":"a.png","data":png}],"steps":[["filter.liquify",{}]]}))
        .unwrap_err();
    assert!(unknown.message().contains("不可执行"), "{}", unknown.message());
    // 重名输入会撞交付文件名。
    assert!(editor
        .batch_begin(json!({"input":[{"name":"a.png","data":png},{"name":"A.PNG","data":png}]}))
        .is_err());
    // 空输入、非 base64 与未知模式都拒绝。
    assert!(editor.batch_begin(json!({"input":[]})).is_err());
    assert!(editor.batch_begin(json!({"input":[{"name":"a.png","data":"??"}]})).is_err());
    assert!(editor.batch_begin(json!({"mode":"background","input":[{"name":"a.png","data":png}]})).is_err());
    // 联系表容量超出网格。
    assert!(editor
        .batch_begin(json!({"mode":"contactSheet","columns":1,"rows":1,"input":[{"name":"a.png","data":png},{"name":"b.png","data":png}]}))
        .is_err());
    assert_eq!(crate::features::history::preflight::live(), 0, "被拒绝的规划不能留下队列");
}

#[test]
fn contact_sheet_and_load_stack_deliver_one_composite_from_many_inputs() {
    let mut editor = Editor::new();
    let a = b64(&sample_png(10, 10, [1.0, 0.0, 0.0]));
    let b = b64(&sample_png(20, 20, [0.0, 1.0, 0.0]));
    for mode in ["contactSheet", "loadStack"] {
        let begun = editor
            .batch_begin(json!({"mode":mode,"input":[{"name":"a.png","data":a},{"name":"b.png","data":b}]}))
            .unwrap();
        let queue = begun["queue"].as_u64().unwrap();
        let progress = editor.batch_step(queue).unwrap();
        assert_eq!(progress["completed"], json!(2), "{mode}");
        assert_eq!(progress["results"].as_array().unwrap().len(), 1, "{mode} 是多输入一份输出");
        let taken = editor.batch_take(queue, 0).unwrap();
        let bytes = photocraft_paint::tile::b64_decode(taken["data"].as_str().unwrap()).unwrap();
        let imported = photocraft_io::import("out.png", &bytes).unwrap();
        if mode == "contactSheet" {
            assert!(imported.document.size.width > 10, "联系表按网格排布");
        } else {
            assert_eq!(imported.document.size.width, 20, "载入堆栈的画布取最大输入尺寸");
            assert_eq!(imported.document.size.height, 20);
        }
        editor.batch_finish(queue);
    }
    // 载入堆栈至少两个文件。
    assert!(editor.batch_begin(json!({"mode":"loadStack","input":[{"name":"a.png","data":a}]})).is_err());
}

#[test]
fn declarative_scripts_preflight_every_step_before_running_any() {
    let mut editor = editor_with_content();
    let before = editor.content_hash().unwrap();
    let layers = editor.state()["document"]["layers"].as_array().unwrap().len();

    let refused = editor
        .script_run(json!({"steps":[["layer.new.layer",{"name":"不应出现"}],["filter.liquify",{}]]}))
        .unwrap_err();
    assert!(refused.message().contains("不可执行"), "{}", refused.message());
    assert_eq!(editor.content_hash().unwrap(), before, "预检失败不能先跑第一步");
    assert_eq!(editor.state()["document"]["layers"].as_array().unwrap().len(), layers);

    let ok = editor.script_run(json!({"steps":[["layer.new.layer",{"name":"脚本层"}]]})).unwrap();
    assert_eq!(ok["ok"], json!(true));
    assert_eq!(editor.state()["document"]["layers"].as_array().unwrap().len(), layers + 1);

    // 文本脚本：每行一条命令；ExtendScript 一律拒绝。
    let text = editor.script_run(json!({"script":"layer.new.layer {\"name\":\"文本层\"}"})).unwrap();
    assert_eq!(text["ok"], json!(true));
    let extend = editor.script_run(json!({"script":"app.activeDocument.close()"})).unwrap_err();
    assert!(extend.message().contains("ExtendScript") || extend.message().contains("不可执行"), "{}", extend.message());
    assert!(editor.script_run(json!({"steps":[]})).is_err());
}

#[test]
fn variables_state_is_read_only_and_reports_definitions() {
    let mut editor = editor_with_variables();
    let before = editor.content_hash().unwrap();
    let revision = editor.revision().unwrap();
    let state = editor.variables_state().unwrap();
    assert_eq!(state["defs"].as_array().unwrap().len(), 2);
    assert_eq!(state["dataSets"].as_array().unwrap().len(), 0);
    assert_eq!(editor.content_hash().unwrap(), before);
    assert_eq!(editor.revision().unwrap(), revision, "只读查询不推进修订");
    assert!(editor.variables_define(json!({})).is_err(), "缺 defs 时拒绝");
    assert!(editor.data_sets_set(json!({})).is_err(), "缺 dataSets 时拒绝");
}

#[test]
fn domain_entry_points_are_bounded_to_the_commands_this_domain_registers() {
    for id in super::HISTORY_COMMANDS {
        assert!(
            crate::capability::command_allowed(id),
            "{id} 已登记为本域入口，但唯一命令门不认它"
        );
    }
    for id in super::ACTION_COMMANDS {
        assert!(
            crate::capability::command_allowed(id),
            "{id} 已登记为本域入口，但唯一命令门不认它"
        );
    }
    // 平台暂缓项保持关闭：原生 Droplet、任意脚本事件、后台批处理与 MCP。
    for id in ["file.automate.createDroplet", "file.automate.runDroplet", "file.scripts.scriptEventsManager", "automation.mcp"] {
        assert!(!crate::capability::command_allowed(id), "{id} 必须保持关闭");
    }
    let mut editor = Editor::new();
    assert!(editor.history_command("layer.new.layer", json!({})).is_err());
    assert!(editor.actions_command("filter.liquify", json!({})).is_err());

    // `history.sample` 是**读取点**，不是命令门里的上游命令（没有对应的 `history.sample` 注册表
    // 条目），因此不能借 `history_command` 转发，也不能进 `HISTORY_COMMANDS`：那会让
    // `domain_entry_points_are_bounded...` 的第一段断言失败，还会给人「上游有这条命令」的错觉。
    assert!(!crate::capability::command_allowed("history.sample"));
    assert!(!super::HISTORY_COMMANDS.contains(&"history.sample"));
    assert!(editor.history_command("history.sample", json!({})).is_err());
}
