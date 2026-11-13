//! `super::layout` 的单测（自 `layout.rs` 移出以保持文件体积守卫）。
    use super::*;

    fn node(width: f32, height: f32) -> GraphNode {
        GraphNode {
            chrome: crate::protocol::NodeChrome::Card,
            shared_world_instance: None,
            world_camera: None,
            id: "n".into(),
            kind: "text".into(),
            x: 10.0,
            y: 20.0,
            width,
            height,
            body: String::new(),
            title: String::new(),
            type_label: String::new(),
            progress: 0.0,
            progress_started_at: None,
            busy: false,
            texture: false,
            media_loading: false,
            resizable: false,
            ghost: false,
            card_label: None,
            model: None,
            history_strip: None,
        }
    }

    fn kind_node(kind: &str, width: f32, height: f32, busy: bool) -> GraphNode {
        GraphNode {
            chrome: crate::protocol::NodeChrome::Card,
            shared_world_instance: None,
            world_camera: None,
            kind: kind.into(),
            busy,
            ..node(width, height)
        }
    }

    #[test]
    fn ring_gate_covers_compact_and_pure_model_nodes() {
        // 富内容图片节点。
        assert!(shows_generation_ring(&kind_node(
            "image", 248.0, 232.0, true
        )));
        // 紧凑节点（<=116 高）此前被 shows_content 门禁漏掉。
        assert!(shows_generation_ring(&kind_node(
            "image", 196.0, 64.0, true
        )));
        // 紧凑卡片（高度 ≤116）的进度环此前被 shows_content 门禁漏掉。
        assert!(shows_generation_ring(&kind_node(
            "model", 196.0, 64.0, true
        )));
        // 非 busy 不显示。
        assert!(!shows_generation_ring(&kind_node(
            "image", 248.0, 232.0, false
        )));
    }

    #[test]
    fn generation_ring_follows_busy_state() {
        let mut node = kind_node("model", 260.0, 195.0, false);
        assert!(!shows_generation_ring(&node));
        node.busy = true;
        assert!(shows_generation_ring(&node));
    }

    #[test]
    fn ring_rect_uses_compact_inset_for_compact_nodes() {
        // node() 位于 (10,20)；紧凑节点按 6px 内缩。
        let (x, y, w, h) = generation_ring_rect(&kind_node("model", 196.0, 64.0, true));
        assert_eq!((x, y), (16.0, 26.0));
        assert_eq!((w, h), (184.0, 52.0));
    }

    #[test]
    fn history_dots_are_centered_inside_node_bottom() {
        let (sx, sy, sw, sh) = history_strip_rect(0.0, 0.0, 248.0, 232.0);
        assert_eq!((sx, sy, sw, sh), (24.0, 212.0, 200.0, 16.0));
        let first = history_strip_dot(0.0, 0.0, 248.0, 232.0, 0, 3);
        let last = history_strip_dot(0.0, 0.0, 248.0, 232.0, 2, 3);
        assert_eq!(first, Vec2::new(112.0, 220.0));
        assert_eq!(last, Vec2::new(136.0, 220.0));
        assert!(sx + sw <= 248.0 - RESIZE_HANDLE_SIZE);
    }

    #[test]
    fn content_rect_fills_to_uniform_padding() {
        // 状态文案已移除：内容区不再为底部状态行预留 42px，而是延伸到底部内缘，
        // 与左右 16px 内边距对称（change: add-node-running-progress）。
        let (x, y, w, h) = content_rect(&node(224.0, 300.0));
        assert_eq!((x, y), (26.0, 72.0));
        assert_eq!(w, 192.0);
        assert_eq!(h, 232.0);
        // 内容区底边 = 节点底边 - 16px。
        assert_eq!(y + h, 72.0 + 232.0);
    }

    #[test]
    fn content_rect_clamps_tiny_nodes() {
        let (_, _, w, h) = content_rect(&node(10.0, 10.0));
        assert_eq!(w, 1.0);
        assert_eq!(h, 24.0);
    }

    #[test]
    fn texture_contain_preserves_aspect() {
        let size = texture_size(&node(224.0, 300.0), Vec2::new(400.0, 100.0));
        assert!((size.x / size.y - 4.0).abs() < 1e-4);
        assert!(size.x <= 192.0 + 1e-4);
    }

    #[test]
    fn port_sides() {
        assert_eq!(port(&node(224.0, 100.0), false), Vec2::new(10.0, 70.0));
        assert_eq!(port(&node(224.0, 100.0), true), Vec2::new(234.0, 70.0));
    }

    #[test]
    fn edge_label_width_shrinks_to_content() {
        // 两个字的中文标签只占 38px，而不是固定 104px（修复：标签过宽导致删除按钮点不到）。
        assert_eq!(edge_label_width("图片"), 38.0);
        assert_eq!(edge_label_width(""), 0.0);
        // 超长标签封顶到最大宽度。
        assert_eq!(edge_label_width(&"宽".repeat(40)), EDGE_LABEL_MAX_WIDTH);
    }

    #[test]
    fn edge_label_text_keeps_short_labels_without_ellipsis() {
        // 短标签必须原样绘制，不能被 shortened 预留省略号宽度而吞掉最后一个字。
        assert_eq!(edge_label_text("图片"), "图片");
        assert_eq!(edge_label_text("图\u{0007}片"), "图 片");
        // 只有超过最大胶囊的内容宽度才截断。
        assert!(edge_label_text(&"宽".repeat(40)).ends_with('…'));
    }

    #[test]
    fn shortened_handles_ascii_cjk_and_controls() {
        assert_eq!(shortened("abc", 100.0, 12.0), "abc");
        assert_eq!(shortened("中\u{0007}文", 100.0, 12.0), "中 文");
        assert!(shortened(&"宽".repeat(50), 40.0, 12.0).ends_with('…'));
    }

    #[test]
    fn wrapped_lines_uses_full_width_before_ellipsis() {
        // 失败原因必须先用满预览区宽度再换行，不能一行提前省略。
        let text = format!("失败：{}", "很长的错误原因".repeat(20));
        let lines = wrapped_lines(&text, 96.0, 12.0, 6);
        assert_eq!(lines.len(), 6);
        assert!(lines
            .iter()
            .all(|line| estimated_text_width(line, 12.0) <= 96.0 + 1e-3));
        assert!(lines.last().unwrap().ends_with('…'));

        let short = format!("失败：{}", "原因".repeat(10));
        let wrapped = wrapped_lines(&short, 96.0, 12.0, 6);
        assert!(wrapped.len() > 1);
        assert!(!wrapped.last().unwrap().ends_with('…'));
    }

    #[test]
    fn wrapped_lines_keeps_explicit_newlines_and_breaks_words_at_spaces() {
        let lines = wrapped_lines("第一行\n第二行", 200.0, 12.0, 6);
        assert_eq!(lines, vec!["第一行".to_string(), "第二行".to_string()]);

        // 英文长词在空格处断行，不把单词拆开。
        let text = "provider timeout while calling upstream endpoint";
        let lines = wrapped_lines(text, 120.0, 12.0, 6);
        assert!(lines.len() > 1);
        assert!(lines.iter().all(|line| !line.starts_with(' ')));
        assert!(lines.iter().any(|line| line.split(' ').count() > 1));
        assert_eq!(lines.join(" ").split_whitespace().collect::<Vec<_>>().join(" "), text);
    }

    #[test]
    fn wrapped_lines_respects_line_budget() {
        assert!(wrapped_lines("内容", 96.0, 12.0, 0).is_empty());
        // 行数足够时保留全部内容，不追加省略号。
        let lines = wrapped_lines("短正文", 200.0, 12.0, 6);
        assert_eq!(lines, vec!["短正文".to_string()]);
    }

    #[test]
    fn overlay_camera2d_hidden_during_focus_keeps_titles_out_of_final_cut() {
        // 片场标题/虚线/抓手只由 2D 覆盖层绘制；聚焦与预览（截图/离屏历史/视频导出）都
        // 进入 focused 状态，此时 2D 相机必须停用，成片结构上不含标题
        // （change: 2026-10-10-improve-film-set-editing-and-inspector，design D1）。
        assert!(!overlay_camera2d_active(true));
        assert!(overlay_camera2d_active(false));
    }

    #[test]
    fn label_pool_plan_supports_toggle_and_resize() {
        // 首次显示：无实体、需补建 1、不保留空池。
        assert_eq!(label_pool_plan(0, 1), (0, 1, 0, true));
        // 隐藏：回收 1、不保留（下次可重建）。
        assert_eq!(label_pool_plan(1, 0), (0, 0, 1, false));
        // 再次显示：仍然从零补建（0→1→0→1 的关键）。
        assert_eq!(label_pool_plan(0, 1), (0, 1, 0, true));
        // 卡片正文缩减/增长：更新重叠、回收多余、补建不足。
        assert_eq!(label_pool_plan(6, 2), (2, 0, 4, true));
        assert_eq!(label_pool_plan(2, 6), (2, 4, 0, true));
        // 长按/稳定：数量一致只原地更新。
        assert_eq!(label_pool_plan(3, 3), (3, 0, 0, true));
    }

    fn action_node(x: f32, y: f32) -> GraphNode {
        GraphNode {
            chrome: crate::protocol::NodeChrome::Card,
            shared_world_instance: None,
            world_camera: None,
            id: "n1".into(),
            kind: "image".into(),
            x,
            y,
            width: 200.0,
            height: 120.0,
            body: String::new(),
            title: String::new(),
            type_label: String::new(),
            progress: 0.0,
            progress_started_at: None,
            busy: false,
            texture: false,
            media_loading: false,
            resizable: false,
            ghost: false,
            card_label: None,
            model: None,
            history_strip: None,
        }
    }

    fn action_list(summary: Option<&str>) -> crate::protocol::NodeActions {
        crate::protocol::NodeActions {
            actions: vec![
                crate::protocol::NodeAction {
                    id: "download".into(),
                    label: "下载".into(),
                    enabled: true,
                    menu: false,
                    ..Default::default()
                },
                crate::protocol::NodeAction {
                    id: "convert".into(),
                    label: "转为片场".into(),
                    enabled: true,
                    menu: true,
                    ..Default::default()
                },
            ],
            summary: summary.map(str::to_owned),
        }
    }

    #[test]
    fn node_action_toolbar_is_centered_above_with_fixed_gap() {
        let node = action_node(500.0, 300.0);
        let layout = node_action_toolbar(&node, &action_list(None), None, None).expect("layout");
        // 底边 = 节点顶边 - GAP；水平居中于节点。
        assert!((layout.bar.1 + layout.bar.3 - (node.y - NODE_ACTION_TOOLBAR_GAP)).abs() < 1e-3);
        assert!((layout.bar.0 + layout.bar.2 / 2.0 - (node.x + node.width / 2.0)).abs() < 1e-3);
        assert!(!layout.below);
    }

    #[test]
    fn node_action_toolbar_actions_do_not_overlap_and_chevron_follows_menu() {
        let node = action_node(500.0, 300.0);
        let layout =
            node_action_toolbar(&node, &action_list(Some("gpt-5")), None, None).expect("layout");
        assert_eq!(layout.slots.len(), 2);
        let first = layout.slots[0].rect;
        let second = layout.slots[1].rect;
        assert!(second.0 >= first.0 + first.2);
        let chevron = layout.slots[1].menu.expect("chevron");
        assert!(chevron.0 >= second.0 + second.2);
        let (_, summary) = layout.summary.as_ref().expect("summary");
        assert!(summary.0 + summary.2 <= first.0 + 1e-3);
        assert!(summary.0 + summary.2 <= layout.bar.0 + layout.bar.2 + 1e-3);
    }

    #[test]
    fn node_action_toolbar_falls_below_when_no_room_above() {
        let node = action_node(500.0, 0.0);
        let layout = node_action_toolbar(
            &node,
            &action_list(None),
            Some((0.0, 0.0, 1.0)),
            Some((1000.0, 800.0)),
        )
        .expect("layout");
        assert!(layout.below);
        assert!((layout.bar.1 - (node.y + node.height + NODE_ACTION_TOOLBAR_GAP)).abs() < 1e-3);
    }

    #[test]
    fn node_action_toolbar_reserves_icon_cell_for_icon_and_text() {
        let node = action_node(500.0, 300.0);
        let action = |icon_only| crate::protocol::NodeActions {
            actions: vec![crate::protocol::NodeAction {
                id: "edit".into(),
                label: "编辑".into(),
                icon: Some("edit".into()),
                icon_only,
                enabled: true,
                menu: false,
                tone: String::new(),
            }],
            summary: None,
        };
        let compact =
            node_action_toolbar(&node, &action(true), None, None).expect("icon-only layout");
        let labelled =
            node_action_toolbar(&node, &action(false), None, None).expect("icon+text layout");
        assert!((compact.slots[0].rect.2 - NODE_ACTION_TOOLBAR_ACTION_HEIGHT).abs() < 1e-3);
        let text = estimated_text_width("编辑", NODE_ACTION_TOOLBAR_FONT);
        assert!(
            labelled.slots[0].rect.2
                >= NODE_ACTION_TOOLBAR_ACTION_PAD * 2.0
                    + NODE_ACTION_TOOLBAR_ICON_SIZE
                    + NODE_ACTION_TOOLBAR_ICON_GAP
                    + text
        );
    }

    #[test]
    fn node_action_toolbar_empty_actions_is_none() {
        let node = action_node(500.0, 300.0);
        let empty = crate::protocol::NodeActions {
            actions: Vec::new(),
            summary: None,
        };
        assert!(node_action_toolbar(&node, &empty, None, None).is_none());
    }

    #[test]
    fn node_action_content_centers_short_labels_in_spare_room() {
        let node = action_node(500.0, 300.0);
        let actions = crate::protocol::NodeActions {
            actions: vec![crate::protocol::NodeAction {
                id: "audio-preview".into(),
                label: "试听".into(),
                icon: None,
                icon_only: false,
                enabled: true,
                menu: false,
                tone: String::new(),
            }],
            summary: None,
        };
        let layout = node_action_toolbar(&node, &actions, None, None).expect("layout");
        let width = layout.slots[0].rect.2;
        let text = estimated_text_width("试听", NODE_ACTION_TOOLBAR_FONT);
        // 两字动作被最小宽度撑宽：内容居中，不再贴着左内边距。
        assert!(width - (NODE_ACTION_TOOLBAR_ACTION_PAD * 2.0 + text) > 1.0);
        let x = node_action_content_x(width, "试听", false);
        assert!((x - (width - text) / 2.0).abs() < 1e-3);
        // 文案把槽撑满时退回左内边距。
        let tight = node_action_content_x(text, "试听", false);
        assert!((tight - NODE_ACTION_TOOLBAR_ACTION_PAD).abs() < 1e-3);
        // 带图标时图标宽度也计入占用。
        let with_icon = node_action_content_x(width, "试听", true);
        assert!(with_icon < x);
    }

    #[test]
    fn node_action_toolbar_summary_is_truncated_to_max_width() {
        let node = action_node(500.0, 300.0);
        let long = "一个非常非常非常非常非常非常非常非常长的模型名称";
        let layout =
            node_action_toolbar(&node, &action_list(Some(long)), None, None).expect("layout");
        let (text, rect) = layout.summary.as_ref().expect("summary");
        assert!(text.ends_with('…'));
        assert!(rect.2 <= NODE_ACTION_TOOLBAR_SUMMARY_MAX_WIDTH + 1e-3);
    }
