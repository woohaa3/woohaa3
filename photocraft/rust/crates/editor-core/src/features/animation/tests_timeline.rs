//! 时间轴、视频图层与帧导入的编辑器级回归（U77）。
use super::*;
use serde_json::json;

fn open_editor() -> Editor {
    let mut editor = Editor::new();
    editor.execute("file.new", json!({"width":8,"height":8})).unwrap();
    editor
}

/// 一帧纯色 RGBA8 字节。
fn solid(width: u32, height: u32, rgba: [u8; 4]) -> Vec<u8> {
    rgba.iter().copied().cycle().take(width as usize * height as usize * 4).collect()
}

#[test]
fn timeline_commands_are_behind_the_single_command_gate() {
    // 本域登记的命令立即进入唯一命令门（P7 已交付）。
    for id in [
        "timeline.create",
        "timeline.setFrame",
        "timeline.nextFrame",
        "timeline.previousFrame",
        "timeline.setProps",
        "timeline.info",
        "layer.videoLayers.newBlankVideoLayer",
        "layer.videoLayers.insertBlankFrame",
        "layer.videoLayers.duplicateFrame",
        "layer.videoLayers.deleteFrame",
        "layer.videoLayers.restoreFrame",
        "layer.videoLayers.restoreAllFrames",
        "layer.videoLayers.showAlteredVideo",
        "layer.videoLayers.rasterize",
        "layer.rasterize.video",
        "layer.videoLayers.interpretFootage",
    ] {
        assert!(crate::capability::command_allowed(id), "{id} 应已开放");
    }
    // 依赖文件路径或原生解复用的上游命令必须保持关闭：浏览器没有等价物。
    for id in [
        "layer.videoLayers.newVideoLayerFromFile",
        "layer.videoLayers.replaceFootage",
        "layer.videoLayers.reloadFrame",
        "file.import.videoFramesToLayers",
        "file.export.renderVideo",
    ] {
        assert!(!crate::capability::command_allowed(id), "{id} 不应开放");
    }
}

#[test]
fn timeline_create_navigate_and_delete_round_trip_through_the_domain_entry() {
    let mut editor = open_editor();
    let info = editor.timeline_info().unwrap();
    assert!(info["timeline"].is_null());
    assert_eq!(info["budget"]["maxFrames"], crate::features::animation::limits::MAX_FRAMES);

    editor.create_timeline(json!({"duration":12,"fps":24.0})).unwrap();
    let info = editor.timeline_info().unwrap();
    assert_eq!(info["timeline"]["duration"], 12);
    assert_eq!(info["timeline"]["fps"], 24.0);
    assert_eq!(info["timeline"]["current"], 0);

    // 导航不新增历史步骤，也不改内容身份。
    let hash = editor.content_hash().unwrap();
    let history = editor.execute("timeline.info", json!({})).unwrap();
    let steps = editor.active_doc().unwrap().history.past_len();
    let moved = editor.navigate_timeline("timeline.setFrame", json!({"frame":7})).unwrap();
    assert_eq!(moved["historyAdded"], 0);
    assert_eq!(editor.timeline_info().unwrap()["timeline"]["current"], 7);
    let stepped = editor.navigate_timeline("timeline.nextFrame", json!({})).unwrap();
    assert_eq!(stepped["historyAdded"], 0);
    assert_eq!(editor.timeline_info().unwrap()["timeline"]["current"], 8);
    let back = editor.navigate_timeline("timeline.previousFrame", json!({})).unwrap();
    assert_eq!(back["historyAdded"], 0);
    assert_eq!(editor.timeline_info().unwrap()["timeline"]["current"], 7);
    assert_eq!(editor.active_doc().unwrap().history.past_len(), steps);
    assert_eq!(editor.content_hash().unwrap(), hash);
    let _ = history;

    // 越界帧号被拒绝，播放位置保持原样。
    let failure = editor.navigate_timeline("timeline.setFrame", json!({"frame":9999})).unwrap_err();
    assert!(failure.message().contains("帧预算"), "{}", failure.message());
    assert_eq!(editor.timeline_info().unwrap()["timeline"]["current"], 7);

    editor.navigate_timeline("timeline.delete", json!({})).unwrap_err();
    editor.execute("timeline.delete", json!({})).unwrap();
    assert!(editor.timeline_info().unwrap()["timeline"].is_null());
}

#[test]
fn timeline_budget_rejects_impossible_durations_and_rates() {
    let mut editor = open_editor();
    let failure = editor.create_timeline(json!({"duration":121})).unwrap_err();
    assert!(failure.message().contains("121"), "{}", failure.message());
    assert!(editor.timeline_info().unwrap()["timeline"].is_null());
    // 非法的帧率不得写入半份时间轴。
    editor.create_timeline(json!({"duration":10})).unwrap();
    for fps in [0.0, -4.0, 5000.0] {
        let failure = editor.set_timeline_props(json!({"fps":fps})).unwrap_err();
        assert!(failure.message().contains("帧率"), "{}", failure.message());
    }
    let failure = editor.set_timeline_props(json!({"duration":500})).unwrap_err();
    assert!(failure.message().contains("500"));
    // 合法属性仍然生效。
    editor.set_timeline_props(json!({"fps":12.0,"duration":10,"workStart":1,"workEnd":9})).unwrap();
    let info = editor.timeline_info().unwrap();
    assert_eq!(info["timeline"]["fps"], 12.0);
    assert_eq!(info["timeline"]["workEnd"], 9);
}

#[test]
fn three_imported_frames_keep_order_duration_and_pixels() {
    let mut editor = open_editor();
    let frames = vec![
        solid(8, 8, [255, 0, 0, 255]),
        solid(8, 8, [0, 255, 0, 255]),
        solid(8, 8, [0, 0, 255, 255]),
    ];
    let imported = editor.import_frames("我的三帧", 8, 8, 10.0, frames.clone()).unwrap();
    assert_eq!(imported["frames"], 3);
    assert_eq!(imported["fps"], 10.0);
    assert_eq!(imported["duration"], 3);

    let info = editor.timeline_info().unwrap();
    assert_eq!(info["timeline"]["duration"], 3);
    assert_eq!(info["videoLayers"][0]["frames"], 3);

    // 一次导入 = 一步历史。`past_len()` 只数「当前步骤之前」的历史：`file.new` 的 "Open"
    // 就是当前步骤，导入把它推进历史，所以这里是 1 而不是 2。
    let steps = editor.active_doc().unwrap().history.past_len();
    assert_eq!(steps, 1, "导入帧只应新增一步历史");

    // 交付的每一帧都保留自己的像素（不能只取首帧）。
    for (index, expected) in [[255u8, 0, 0], [0, 255, 0], [0, 0, 255]].iter().enumerate() {
        let rgba = editor.render_frame(index).unwrap();
        assert_eq!(rgba.len(), 8 * 8 * 4);
        assert_eq!(&rgba[..3], expected, "第 {index} 帧像素不符");
    }

    // 撤销一次回到导入前：单步结算，不逐帧堆历史。
    editor.undo().unwrap();
    assert!(editor.timeline_info().unwrap()["timeline"].is_null());
}

#[test]
fn frame_import_rejects_over_budget_input_without_touching_the_document() {
    let mut editor = open_editor();
    let before = editor.content_hash().unwrap();
    let steps = editor.active_doc().unwrap().history.past_len();

    // 帧数超限。
    let failure = editor.import_frames("太多", 4, 4, 30.0, vec![solid(4, 4, [1, 2, 3, 255]); 121]).unwrap_err();
    assert!(failure.message().contains("121"), "{}", failure.message());
    // 累计像素超限：2048×2048 × 5 帧。
    let big = vec![vec![0u8; 2048 * 2048 * 4]; 5];
    let failure = editor.import_frames("太大", 2048, 2048, 30.0, big).unwrap_err();
    assert!(failure.message().contains("像素"), "{}", failure.message());
    // 解码字节超限：同一次导入的累计字节上限。
    let failure = editor.import_frames("损坏", 8, 8, 30.0, vec![vec![0u8; 3]; 2]).unwrap_err();
    assert!(failure.message().contains("字节长度"), "{}", failure.message());
    // 非法帧率。
    let failure = editor.import_frames("帧率", 8, 8, 0.0, vec![solid(8, 8, [0, 0, 0, 255])]).unwrap_err();
    assert!(failure.message().contains("帧率"), "{}", failure.message());
    // 空输入。
    let failure = editor.import_frames("空", 8, 8, 30.0, Vec::new()).unwrap_err();
    assert!(failure.message().contains("没有可导入的帧"));

    // 全部拒绝：文档、内容身份与历史都没变。
    assert_eq!(editor.content_hash().unwrap(), before);
    assert_eq!(editor.active_doc().unwrap().history.past_len(), steps);
    assert!(editor.timeline_info().unwrap()["timeline"].is_null());
}

#[test]
fn imported_frames_survive_a_project_round_trip() {
    let mut editor = open_editor();
    editor
        .import_frames("往返", 8, 8, 24.0, vec![solid(8, 8, [255, 0, 0, 255]), solid(8, 8, [0, 255, 0, 255])])
        .unwrap();
    editor.flush_video_frames().unwrap();
    let bytes = editor.save_project().unwrap();

    let mut reopened = Editor::new();
    reopened.open_project(&bytes, None).unwrap();
    let info = reopened.timeline_info().unwrap();
    assert_eq!(info["timeline"]["duration"], 2, "时长应随工程往返");
    assert_eq!(info["timeline"]["fps"], 24.0);
    assert_eq!(info["videoLayers"][0]["frames"], 2);
    // 帧像素也随工程往返（上游 manifest 保存 video 帧栈）。
    let red = reopened.render_frame(0).unwrap();
    let green = reopened.render_frame(1).unwrap();
    assert_eq!(&red[..3], &[255, 0, 0]);
    assert_eq!(&green[..3], &[0, 255, 0]);
}

#[test]
fn imported_frame_order_is_editable_and_persists() {
    let mut editor = open_editor();
    editor
        .import_frames("顺序", 8, 8, 30.0, vec![solid(8, 8, [255, 0, 0, 255]), solid(8, 8, [0, 255, 0, 255])])
        .unwrap();
    editor.navigate_timeline("timeline.setFrame", json!({"frame":0})).unwrap();
    // 复制第 0 帧 → 三帧，第 1 帧变成副本。
    let duplicated = editor.video_layer_command("layer.videoLayers.duplicateFrame", json!({})).unwrap();
    assert_eq!(duplicated["frames"], 3);
    let info = editor.timeline_info().unwrap();
    assert_eq!(info["timeline"]["duration"], 3, "复制帧应把时间轴一起增长");
    let first = editor.render_frame(0).unwrap();
    let second = editor.render_frame(1).unwrap();
    assert_eq!(&first[..3], &second[..3], "复制帧的像素与原帧一致");
    let third = editor.render_frame(2).unwrap();
    assert_ne!(&first[..3], &third[..3]);

    let bytes = editor.save_project().unwrap();
    let mut reopened = Editor::new();
    reopened.open_project(&bytes, None).unwrap();
    assert_eq!(reopened.timeline_info().unwrap()["videoLayers"][0]["frames"], 3);
}

#[test]
fn painting_after_navigating_hits_the_current_frame_only() {
    let mut editor = open_editor();
    editor
        .import_frames("绘画", 8, 8, 30.0, vec![solid(8, 8, [0, 0, 0, 255]), solid(8, 8, [0, 0, 0, 255])])
        .unwrap();
    editor.navigate_timeline("timeline.setFrame", json!({"frame":1})).unwrap();
    editor
        .execute("paint.stroke", json!({
            "points": [[2,2],[5,5]], "size": 4, "hardness": 1, "opacity": 1, "flow": 1,
            "color": "#ff0000", "target": "pixels"
        }))
        .unwrap();
    // 作画后必须先把显示内容写回所在帧，否则只有显示内容变化、帧栈还是旧的。
    assert_eq!(editor.flush_video_frames().unwrap()["written"], true);
    // 第 1 帧被画上红色，第 0 帧不变。
    let painted = editor.render_frame(1).unwrap();
    assert_eq!(&painted[(4 * 8 + 4) * 4..(4 * 8 + 4) * 4 + 3], &[255, 0, 0]);
    let untouched = editor.render_frame(0).unwrap();
    assert_eq!(&untouched[(4 * 8 + 4) * 4..(4 * 8 + 4) * 4 + 3], &[0, 0, 0]);
    assert_ne!(painted, untouched);
}

#[test]
fn no_op_props_and_flush_report_without_adding_history() {
    let mut editor = open_editor();
    editor.create_timeline(json!({"duration":6,"fps":12.0})).unwrap();
    let steps = editor.active_doc().unwrap().history.past_len();
    let hash = editor.content_hash().unwrap();
    // 同一组属性再写一次：不是新内容，不新增历史步骤。
    editor.set_timeline_props(json!({"fps":12.0,"duration":6})).unwrap();
    assert_eq!(editor.active_doc().unwrap().history.past_len(), steps, "无变化不应新增历史");
    assert_eq!(editor.content_hash().unwrap(), hash);

    // 没有视频层时写回是明确的「未变化」，不是错误。
    assert_eq!(editor.flush_video_frames().unwrap()["reason"], "unchanged");

    // 有视频层但内容没变：同样是 unchanged。
    editor.video_layer_command("layer.videoLayers.newBlankVideoLayer", json!({})).unwrap();
    assert_eq!(editor.flush_video_frames().unwrap()["reason"], "unchanged");

    // 活动草稿期间拒绝写回（不能把预览烧进帧栈），原因可判别。
    editor.begin_filter("filter.blur.gaussianBlur", json!({"radius":2})).unwrap();
    let during = editor.flush_video_frames().unwrap();
    assert_eq!(during["written"], false);
    assert_eq!(during["reason"], "draft-active");
    editor.cancel_filter();

    // 写回本身不新增历史步骤（写回的正是已提交内容）。
    let steps = editor.active_doc().unwrap().history.past_len();
    editor
        .execute("paint.stroke", json!({
            "points": [[2,2],[5,5]], "size": 4, "hardness": 1, "opacity": 1, "flow": 1,
            "color": "#00ff00", "target": "pixels"
        }))
        .unwrap();
    let after_stroke = editor.active_doc().unwrap().history.past_len();
    assert!(editor.flush_video_frames().unwrap()["written"] == true);
    assert_eq!(editor.active_doc().unwrap().history.past_len(), after_stroke, "写回帧栈不应产生第二步撤销");
    assert_eq!(after_stroke, steps + 1, "一次笔迹仍是一步历史");
}

#[test]
fn navigation_and_reads_never_touch_content_identity() {
    let mut editor = open_editor();
    editor
        .import_frames("身份", 8, 8, 24.0, vec![solid(8, 8, [1, 2, 3, 255]), solid(8, 8, [4, 5, 6, 255])])
        .unwrap();
    let hash = editor.content_hash().unwrap();
    for id in ["timeline.nextFrame", "timeline.previousFrame"] {
        editor.navigate_timeline(id, json!({})).unwrap();
    }
    editor.navigate_timeline("timeline.setFrame", json!({"frame":0})).unwrap();
    assert_eq!(editor.content_hash().unwrap(), hash, "定位不改变内容身份");
    // 只读交付也不推进修订。
    let revision = editor.active_doc().unwrap().revision;
    editor.delivery_plan().unwrap();
    let _ = editor.render_frame(1).unwrap();
    let _ = editor.render_animation_gif().unwrap();
    assert_eq!(editor.active_doc().unwrap().revision, revision, "只读交付不推进修订");
    // 时间轴/帧已接入共享内容身份（`document_content::project_content` → `identity::content_hash`）。
    // 帧率是内容：改它必须改变指纹；播放头仍是会话视图，不改变指纹（上一段已断言）。
    editor.set_timeline_props(json!({"fps":30.0})).unwrap();
    assert_eq!(editor.timeline_info().unwrap()["timeline"]["fps"], 30.0);
    assert_ne!(
        editor.content_hash().unwrap(),
        hash,
        "帧率属于时间轴内容，必须进入共享内容 hash"
    );
    // 改回去必须回到同一个指纹（内容身份是纯函数，不累积噪声）。
    editor.set_timeline_props(json!({"fps":24.0})).unwrap();
    assert_eq!(editor.content_hash().unwrap(), hash, "改回原值必须回到原指纹");
}

/// 解释素材帧率：只改视频层 `fps`，是浏览器可用的本地元数据编辑（不读文件）。
///
/// 上游对 `fps` 没有任何校验，`0`/`NaN`/`∞` 会让交付除零或无限循环，因此本域入口先按同一套
/// 帧率预算拒绝；拒绝时文档保持原样。
#[test]
fn interpreting_footage_rate_is_validated_and_affects_the_layer_not_the_timeline() {
    let mut editor = open_editor();
    editor
        .import_frames("解释", 8, 8, 24.0, vec![solid(8, 8, [1, 2, 3, 255]), solid(8, 8, [4, 5, 6, 255])])
        .unwrap();
    editor.create_timeline(json!({"duration": 2, "fps": 24.0})).unwrap();
    let before = editor.timeline_info().unwrap();
    assert_eq!(before["videoLayers"][0]["fps"], 24.0);

    let failure = editor
        .video_layer_command("layer.videoLayers.interpretFootage", json!({"fps": 0}))
        .unwrap_err();
    assert!(failure.message().contains("帧率"), "{}", failure.message());
    let failure = editor
        .video_layer_command("layer.videoLayers.interpretFootage", json!({}))
        .unwrap_err();
    assert!(failure.message().contains("帧率"), "缺少 fps 也必须拒绝：{}", failure.message());
    // 拒绝不写半份修改。
    assert_eq!(editor.timeline_info().unwrap()["videoLayers"][0]["fps"], 24.0);

    let applied = editor
        .video_layer_command("layer.videoLayers.interpretFootage", json!({"fps": 12.0}))
        .unwrap();
    assert_eq!(applied["frames"], 2);
    let after = editor.timeline_info().unwrap();
    assert_eq!(after["videoLayers"][0]["fps"], 12.0, "解释素材改的是视频层帧率");
    assert_eq!(after["timeline"]["fps"], 24.0, "时间轴帧率是另一份内容，不被改动");
    // 一步历史，且保存重开后仍在。
    let bytes = editor.save_project().unwrap();
    let mut reopened = Editor::new();
    reopened.open_project(&bytes, None).unwrap();
    assert_eq!(reopened.timeline_info().unwrap()["videoLayers"][0]["fps"], 12.0);
}

#[test]
fn video_layer_commands_stay_inside_the_frame_budget() {    let mut editor = open_editor();
    // 120 帧时间轴 + 视频层，然后插入/复制第 121 帧必须被拒绝。
    editor.create_timeline(json!({"duration":120})).unwrap();
    editor.video_layer_command("layer.videoLayers.newBlankVideoLayer", json!({})).unwrap();
    editor.navigate_timeline("timeline.setFrame", json!({"frame":0})).unwrap();
    let failure = editor.video_layer_command("layer.videoLayers.insertBlankFrame", json!({})).unwrap_err();
    assert!(failure.message().contains("121"), "{}", failure.message());
    assert_eq!(editor.timeline_info().unwrap()["videoLayers"][0]["frames"], 120);
}

/// 没有原始素材时，「恢复原始帧」必须**拒绝**，不能把用户的帧清成空白。
///
/// 上游实现是 `original.unwrap_or_else(blank)`：取不到原始素材就写一张空白帧。浏览器里的帧导入
/// 不产生原始素材副本（上游只有路径命令 `newVideoLayerFromFile`/`replaceFootage`/`reloadFrame`
/// 才写 `original_frames`，而它们都在关闭清单里），因此直接执行会把用户导入的帧**静默清空**。
#[test]
fn restoring_without_original_footage_is_refused_instead_of_blanking_the_frame() {
    let mut editor = open_editor();
    editor
        .import_frames("无原帧", 8, 8, 24.0, vec![solid(8, 8, [255, 0, 0, 255]), solid(8, 8, [0, 0, 255, 255])])
        .unwrap();
    editor.navigate_timeline("timeline.setFrame", json!({"frame":0})).unwrap();
    let before = editor.render_frame(0).unwrap();
    let hash = editor.content_hash().unwrap();

    // 面板据此禁用按钮，但命令本身也必须拒绝：界面之外还有 WASM/脚本入口。
    for id in ["layer.videoLayers.restoreFrame", "layer.videoLayers.restoreAllFrames"] {
        let failure = editor.video_layer_command(id, json!({})).unwrap_err();
        assert!(failure.message().contains("原始素材"), "{id}: {}", failure.message());
        // 帧像素与内容身份都没变（拒绝不写半份修改）。
        assert_eq!(editor.render_frame(0).unwrap(), before, "{id} 不得清空帧");
        assert_eq!(editor.content_hash().unwrap(), hash);
    }
    // 上游判定仍为「没有原始素材」，面板的禁用条件与内核拒绝条件同源。
    assert_eq!(
        editor.timeline_info().unwrap()["videoLayers"][0]["hasOriginal"],
        false
    );
}

/// 有原始素材时「恢复原始帧」必须真的生效（不是靠一律拒绝来规避缺陷）。
///
/// 浏览器通路的帧导入不产生原始素材副本，但**原生应用保存的工程会**（`VideoDataM.original_frames`
/// 随 `.pcraft` 往返），因此这两个命令是真实可用的能力，不能为了躲开清空问题就永久关掉。
#[test]
fn restoring_with_original_footage_brings_the_frame_back() {
    let mut editor = open_editor();
    editor
        .import_frames("原帧", 8, 8, 24.0, vec![solid(8, 8, [255, 0, 0, 255]), solid(8, 8, [0, 0, 255, 255])])
        .unwrap();
    {
        let state = editor.session.active_mut().unwrap();
        let mut next = (*state.doc).clone();
        let layer = next.layers.last_mut().unwrap();
        let video = layer.video.as_mut().unwrap();
        video.original_frames = Some(video.frames.clone());
        state.doc = std::sync::Arc::new(next);
    }
    editor.navigate_timeline("timeline.setFrame", json!({"frame":0})).unwrap();
    editor
        .execute("paint.stroke", json!({
            "points": [[2,2],[5,5]], "size": 4, "hardness": 1, "opacity": 1, "flow": 1,
            "color": "#00ff00", "target": "pixels"
        }))
        .unwrap();
    editor.flush_video_frames().unwrap();
    let painted = editor.render_frame(0).unwrap();
    assert_eq!(&painted[(4 * 8 + 4) * 4..(4 * 8 + 4) * 4 + 3], &[0, 255, 0], "先确实画画了");

    let restored = editor.video_layer_command("layer.videoLayers.restoreFrame", json!({})).unwrap();
    assert_eq!(restored["frames"], 2);
    let back = editor.render_frame(0).unwrap();
    assert_eq!(&back[..3], &[255, 0, 0], "恢复回到原始帧的像素");
    assert_ne!(back, painted);
    // 恢复是一步历史。
    assert_eq!(editor.timeline_info().unwrap()["videoLayers"][0]["frames"], 2);
}

/// 「显示原始素材」模式下的作画是预览，不会写回帧栈：必须如实报告，不能算进内容身份。
///
/// 上游 `store` 在 `show_altered == false` 且存在原始素材时**跳过写回**（#3060）。若内容身份仍按
/// 显示内容计算，指纹就会声称一份存不进工程的编辑：保存后重开会退回原值，宿主刚存完又认为工程
/// 被外部改过。
#[test]
fn edits_made_while_showing_the_original_are_reported_and_never_enter_content_identity() {
    let mut editor = open_editor();
    editor
        .import_frames("原帧", 8, 8, 24.0, vec![solid(8, 8, [255, 0, 0, 255]), solid(8, 8, [0, 0, 255, 255])])
        .unwrap();
    // 浏览器通路不产生原始素材副本；这里直接补上，模拟原生应用保存的工程（`hasOriginal: true`）。
    {
        let state = editor.session.active_mut().unwrap();
        let mut next = (*state.doc).clone();
        let layer = next.layers.last_mut().unwrap();
        let video = layer.video.as_mut().unwrap();
        video.original_frames = Some(video.frames.clone());
        state.doc = std::sync::Arc::new(next);
    }
    editor.navigate_timeline("timeline.setFrame", json!({"frame":0})).unwrap();

    // 切到「显示原始素材」：这一步本身就是内容（`showAltered` 进摘要），因此先切换再取基准指纹。
    editor.video_layer_command("layer.videoLayers.showAlteredVideo", json!({})).unwrap();
    assert_eq!(editor.timeline_info().unwrap()["videoLayers"][0]["showAltered"], false);
    let hash = editor.content_hash().unwrap();

    // 在画布上作画：显示内容变了，但写回会跳过。
    editor
        .execute("paint.stroke", json!({
            "points": [[2,2],[5,5]], "size": 4, "hardness": 1, "opacity": 1, "flow": 1,
            "color": "#00ff00", "target": "pixels"
        }))
        .unwrap();

    // 这份编辑存不进工程：内容身份不得因为它变化。
    assert_eq!(editor.content_hash().unwrap(), hash, "预览模式的编辑不能进内容身份");
    // 写回必须如实说明，而不是报「没有需要写回的东西」。
    let flushed = editor.flush_video_frames().unwrap();
    assert_eq!(flushed["written"], false);
    assert_eq!(flushed["reason"], "original-view-preview");
    assert!(
        flushed["message"].as_str().unwrap().contains("显示修帧结果"),
        "{}",
        flushed["message"]
    );
    // 帧栈仍保留作画前的像素。
    assert_eq!(&editor.render_frame(0).unwrap()[..3], &[255, 0, 0]);

    // 误报防护：切到原始视图但没作画（显示内容就是原始帧）时，写回必须报 `unchanged`。
    let mut clean = open_editor();
    clean
        .import_frames("干净", 8, 8, 24.0, vec![solid(8, 8, [9, 9, 9, 255])])
        .unwrap();
    {
        let state = clean.session.active_mut().unwrap();
        let mut next = (*state.doc).clone();
        let layer = next.layers.last_mut().unwrap();
        let video = layer.video.as_mut().unwrap();
        video.original_frames = Some(video.frames.clone());
        state.doc = std::sync::Arc::new(next);
    }
    clean.video_layer_command("layer.videoLayers.showAlteredVideo", json!({})).unwrap();
    let hash = clean.content_hash().unwrap();
    let flushed = clean.flush_video_frames().unwrap();
    assert_eq!(flushed["written"], false);
    assert_eq!(flushed["reason"], "unchanged", "没有编辑时不得误报 original-view-preview");
    assert_eq!(clean.content_hash().unwrap(), hash);
    let bytes = clean.save_project().unwrap();
    let mut reopened = Editor::new();
    reopened.open_project(&bytes, None).unwrap();
    assert_eq!(reopened.flush_video_frames().unwrap()["reason"], "unchanged", "重开后仍不误报");
    assert_eq!(reopened.content_hash().unwrap(), hash, "原始视图工程的指纹跨重开稳定");

    // 切回「显示修帧结果」后作画就能写回：同一次作画在有写回通路时仍算内容。
    editor.video_layer_command("layer.videoLayers.showAlteredVideo", json!({})).unwrap();
    let restored = editor.content_hash().unwrap();
    editor
        .execute("paint.stroke", json!({
            "points": [[1,1],[2,2]], "size": 3, "hardness": 1, "opacity": 1, "flow": 1,
            "color": "#0000ff", "target": "pixels"
        }))
        .unwrap();
    assert_eq!(editor.flush_video_frames().unwrap()["written"], true);
    assert_ne!(editor.content_hash().unwrap(), restored, "有写回通路的编辑必须算内容");
    // 且保存重开后仍是写回后的像素（不是「存完就退回」）。
    let bytes = editor.save_project().unwrap();
    let mut reopened = Editor::new();
    reopened.open_project(&bytes, None).unwrap();
    assert_eq!(reopened.content_hash().unwrap(), editor.content_hash().unwrap());
}

#[test]
fn delivery_plan_and_gif_are_produced_from_the_real_document() {
    let mut editor = open_editor();
    editor
        .import_frames("交付", 8, 8, 10.0, vec![solid(8, 8, [255, 0, 0, 255]), solid(8, 8, [0, 0, 255, 255])])
        .unwrap();
    let plan = editor.delivery_plan().unwrap();
    assert_eq!(plan["frames"], 2);
    assert_eq!(plan["frameBytes"], 8 * 8 * 4);
    let gif = editor.render_animation_gif().unwrap();
    assert_eq!(&gif[..6], b"GIF89a");
    let frames = photocraft_codecs::decode_gif_frames(&gif, &photocraft_codecs::DecodeOptions::default()).unwrap();
    assert_eq!(frames.len(), 2);
    assert_ne!(frames[0].image.data(), frames[1].image.data());
}

#[test]
fn drafts_block_timeline_writes_but_not_navigation_reads() {
    let mut editor = open_editor();
    editor.create_timeline(json!({"duration":10})).unwrap();
    // 打开一个滤镜草稿：时间轴写入必须先结算。
    editor.begin_filter("filter.blur.gaussianBlur", json!({"radius":2})).unwrap();
    assert!(editor.create_timeline(json!({"duration":5})).is_err());
    assert!(editor.import_frames("草稿", 8, 8, 30.0, vec![solid(8, 8, [0, 0, 0, 255])]).is_err());
    // 只读信息与导航不是内容写入，仍然可用。
    assert!(editor.timeline_info().is_ok());
    editor.cancel_filter();
    editor.create_timeline(json!({"duration":5})).unwrap();
}

#[test]
fn frame_import_rejects_a_full_layer_tree() {
    let mut editor = open_editor();
    // 64 层上限：先补满，再导入帧必须被拒绝且不写入。
    for index in 1..photocraft_project_verify::MAX_LAYERS {
        editor.execute("layer.new.layer", json!({"name":format!("l{index}")})).unwrap();
    }
    let failure = editor
        .import_frames("满", 8, 8, 30.0, vec![solid(8, 8, [1, 1, 1, 255])])
        .unwrap_err();
    assert!(failure.message().contains("64"), "{}", failure.message());
    assert!(editor.timeline_info().unwrap()["timeline"].is_null());
}

/// 跨文档粘贴只搬图层（含帧栈），时间轴是**文档级**数据不会跟过去。
///
/// 这是数据模型的真实边界，不是丢失：帧栈完好，建好时间轴即可导航。界面据此提示
/// 「有视频层但没有时间轴」，而不是让用户面对一个只有第 1 帧可用的图层。
#[test]
fn cross_document_paste_keeps_the_frame_stack_while_the_timeline_stays_with_the_source() {
    let mut source = open_editor();
    source
        .import_frames(
            "视频",
            8,
            8,
            12.0,
            vec![solid(8, 8, [255, 0, 0, 255]), solid(8, 8, [0, 255, 0, 255])],
        )
        .unwrap();
    let id = source.active_layer_id().unwrap();
    let bytes = source
        .export_layer_transfer(json!({"layers": [id.0]}))
        .unwrap();

    let mut target = open_editor();
    let preview = target.can_paste_layer_transfer(&bytes).unwrap();
    assert_eq!(preview["ok"], true);
    target.paste_layer_transfer(&bytes, json!({})).unwrap();

    // 帧栈跟着图层过去了。
    let info = target.timeline_info().unwrap();
    let layers = info["videoLayers"].as_array().unwrap();
    assert_eq!(layers.len(), 1);
    assert_eq!(layers[0]["frames"], 2);
    assert_eq!(layers[0]["fps"], 12.0);
    // 但时间轴是源文档的，目标文档仍然没有：这正是界面要提示的那一半。
    assert!(info["timeline"].is_null());

    // 建好时间轴后帧栈可导航，像素仍是粘过来的那两帧。
    target.create_timeline(json!({"duration": 2, "fps": 12.0})).unwrap();
    assert_eq!(target.timeline_info().unwrap()["timeline"]["duration"], 2);
    let second = target.navigate_timeline("timeline.setFrame", json!({"frame": 1})).unwrap();
    assert_eq!(second["historyAdded"], 0);
}
