//! 本域贡献清单的发布断言（P7）。
//!
//! 三条约束：能力/命令清单与协议域逐项一致；命令必须真的位于上游注册表（否则命令门放开
//! 也会在 `Session::execute` 失败）；陷印仍因缺少 CMYK 保持关闭。

use super::*;

#[test]
fn contribution_publishes_exactly_the_wrapped_commands() {
    assert_eq!(CONTRIBUTION.id, "modes");

    let published: Vec<&str> = CONTRIBUTION.commands.iter().map(|entry| entry.id).collect();
    let mut expected = mode::MODE_COMMANDS.to_vec();
    expected.sort_unstable();
    let mut actual = published.clone();
    actual.sort_unstable();
    assert_eq!(actual, expected, "发布清单必须与真实包装的命令逐项一致");
    // `COMMANDS` 按发布顺序声明，`actual` 已排序：比内容而不是比顺序。
    let mut declared = COMMANDS.to_vec();
    declared.sort_unstable();
    assert_eq!(actual, declared, "`COMMANDS` 与 CONTRIBUTION 必须是同一份");
    // 全部落在 P7、且 order 唯一（同一阶段内靠 order 决定握手顺序）。
    let orders: Vec<usize> = CONTRIBUTION.commands.iter().map(|entry| entry.order).collect();
    for entry in CONTRIBUTION.commands {
        assert_eq!(entry.stage, "P7", "{} 必须发布在已交付阶段", entry.id);
    }
    assert_eq!(orders.len(), orders.iter().collect::<std::collections::BTreeSet<_>>().len(), "order 不能重复");
}

#[test]
fn capabilities_match_the_declared_list() {
    let published: Vec<&str> = CONTRIBUTION.capabilities.iter().map(|entry| entry.id).collect();
    assert_eq!(published, CAPABILITIES.to_vec());
    assert_eq!(published.len(), 3);
    for id in &published {
        assert!(id.starts_with("image."), "{id} 必须带 image. 前缀");
        assert_eq!(crate::capability::capability_stage(id), Some("P7"));
        assert!(crate::capability::is_enabled(id), "{id} 应已开放");
    }
    // 三个 id 不得与既有能力重名（重名会让握手顺序与归属都含糊）。
    let all = crate::capability::delivered_capabilities();
    for id in &published {
        assert_eq!(all.iter().filter(|candidate| *candidate == id).count(), 1, "{id} 重复登记");
    }
}

#[test]
fn published_commands_pass_the_single_command_gate() {
    for id in COMMANDS {
        assert!(crate::capability::command_allowed(id), "{id} 未通过命令门");
        assert!(
            photocraft_engine::commands::find(id).is_some(),
            "{id} 在上游命令注册表中不存在"
        );
    }
    // 陷印不在范围内：不得因为发布模式能力而顺带放开。
    assert!(!crate::capability::command_allowed("print.trap"));
}

#[test]
fn targets_cover_every_supported_mode_once() {
    use photocraft_doc::ColorMode;
    let mut ids: Vec<&str> = mode::TARGETS.to_vec();
    ids.sort_unstable();
    assert_eq!(ids, vec!["bitmap", "duotone", "grayscale", "indexed", "rgb"]);
    for (raw, id) in [
        (ColorMode::Rgb, "rgb"),
        (ColorMode::Grayscale, "grayscale"),
        (ColorMode::Bitmap, "bitmap"),
        (ColorMode::Indexed, "indexed"),
        (ColorMode::Duotone, "duotone"),
    ] {
        assert_eq!(mode::mode_id(raw), Some(id));
    }
    // 范围外的颜色模型不冒充已支持模式。
    for raw in [ColorMode::Cmyk, ColorMode::Lab, ColorMode::Multichannel] {
        assert_eq!(mode::mode_id(raw), None);
    }
}

#[test]
fn trap_stays_closed_with_a_specific_reason() {
    let status = mode::trap_status();
    assert_eq!(status["available"], false);
    assert_eq!(status["requires"], "cmyk");
    assert!(status["reason"].as_str().unwrap_or_default().contains("CMYK"));
}
