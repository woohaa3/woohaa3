//! 通道的**内容身份贡献**（change: 2026-10-22-add-photocraft-channel-workflows，任务 3.2）。
//!
//! 通道是文档级内容：名称、Alpha/专色种类、叠层颜色与不透明度、专色密度，以及灰度平面
//! 的完整稀疏像素摘要。查看态（`channel_view` 的目标/显隐）**不进**内容身份，偏好与工具
//! 设置也不进。
//!
//! 本模块只产出**一个**顶层字段 `channelsContentHash`（16 位小写 hex），与既有
//! `patternContentHash` 同形：
//! - 没有通道时不写字段，旧工程的身份逐字节不变（「空新字段不改变旧身份」）；
//! - 有通道时字段进入 `project_content`，由 `identity` 的规范化文本一起覆盖。
//!
//! 接线由共享 `document_content.rs` 完成（`#[path = "features/channels/content.rs"]` +
//! `attach(doc, &mut content)`），属集成负责人顺序提交；未接线时这些条目只在域内测试使用。
use serde_json::{json, Value};

/// 通道内容身份：把通道行折成确定性文本后取 FNV-1a 64。
///
/// 文本规范（与 `packages/protocol/src/features/channels/content.ts` 逐字符一致）：
/// ```text
/// channels:<count>
/// channel:<名称 UTF-16 长度>:<名称>:<alpha|spot>:<opacity>:<indicates>:<ink>:<solidity>:<surfaceHash>
/// ```
/// 数值与内容指纹的其它数值同精度（1e-4），`-0` 归一化为 `0`。
pub fn channels_content_hash(doc: &photocraft_doc::Document) -> Option<String> {
    if doc.channels.is_empty() {
        return None;
    }
    let mut lines = vec![format!("channels:{}", doc.channels.len())];
    for channel in &doc.channels {
        let kind = if channel.spot.is_some() { "spot" } else { "alpha" };
        let (ink, solidity) = match channel.spot {
            Some((ink, solidity)) => (
                hex_rgb(ink.to_rgb()),
                rounded(solidity),
            ),
            // 非专色行不带密度：用 `-` 占位，避免「缺省」与「0」混为一谈。
            None => (hex_rgb(channel.color.to_rgb()), "-".to_string()),
        };
        let indicates = match channel.indicates {
            photocraft_doc::ColorIndicates::MaskedAreas => "masked",
            photocraft_doc::ColorIndicates::SelectedAreas => "selected",
        };
        lines.push(format!(
            "channel:{}:{}:{}:{}:{}:{}:{}:{}",
            utf16_len(&channel.name),
            channel.name,
            kind,
            rounded(channel.opacity),
            indicates,
            ink,
            solidity,
            crate::document_content::surface_hash(&channel.surface),
        ));
    }
    Some(crate::identity::fnv1a64_hex(&lines.join("\n")))
}

/// 把通道身份写进宿主内容描述；空通道不写字段（旧身份兼容）。
pub fn attach(doc: &photocraft_doc::Document, content: &mut Value) {
    if let Some(hash) = channels_content_hash(doc) {
        content["channelsContentHash"] = json!(hash);
    }
}

/// 内容指纹的数值形式：与 `identity` 的其他数值一样取 1e-4，`-0` 归零。
fn rounded(value: f32) -> String {
    let value = (f64::from(value) * 1e4).round() / 1e4;
    let value = if value == 0.0 { 0.0 } else { value };
    if value == value.trunc() {
        format!("{}", value as i64)
    } else {
        let mut text = format!("{value}");
        while text.ends_with('0') {
            text.pop();
        }
        if text.ends_with('.') {
            text.pop();
        }
        text
    }
}

/// `0–1` RGB → `#rrggbb`（与 `type_content::hex_color` 同形，但不依赖图层内容模块）。
fn hex_rgb(rgb: [f32; 3]) -> String {
    let byte = |value: f32| (value.clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
    format!(
        "#{:02x}{:02x}{:02x}",
        byte(rgb[0]),
        byte(rgb[1]),
        byte(rgb[2])
    )
}

/// UTF-16 长度（与 JavaScript `String.length` 一致，中文/emoji 使用同一计数）。
fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    use crate::editor::Editor;

    fn doc() -> Editor {
        let mut editor = Editor::new();
        editor
            .execute("file.new", json!({ "width": 8, "height": 8 }))
            .unwrap();
        editor.execute("layer.new.layer", json!({})).unwrap();
        editor
    }

    /// 没有通道时**不写字段**：旧工程身份逐字节不变。
    #[test]
    fn empty_channels_do_not_change_the_content_identity() {
        let mut editor = doc();
        let mut content = json!({ "canvasWidth": 8, "canvasHeight": 8, "layers": [] });
        let before = content.clone();
        let doc = &editor.active_doc().unwrap().doc;
        assert_eq!(channels_content_hash(doc), None);
        attach(doc, &mut content);
        assert_eq!(content, before, "空通道不能新增内容字段");
        // 接线后 `Editor::content_hash` 覆盖通道：新建通道必须改变指纹。
        let hash = editor.content_hash().unwrap();
        editor.channel_command("channel.new", json!({ "name": "A" })).unwrap();
        assert_ne!(
            channels_content_hash(&editor.active_doc().unwrap().doc),
            None,
            "有通道时字段必须能生成"
        );
        assert_ne!(
            editor.content_hash().unwrap(),
            hash,
            "通道内容必须进入 Editor::content_hash（接线生效）"
        );
    }

    /// 共享指纹现在真的覆盖通道：内容变则指纹变，查看态不变则指纹不变，
    /// 且删除全部通道后回到「没有该字段」的旧身份形态。
    #[test]
    fn the_shared_content_hash_covers_channels() {
        let mut editor = doc();
        let bare = editor.content_hash().unwrap();
        assert!(
            crate::document_content::project_content(
                &editor.active_doc().unwrap().doc,
                &crate::document_content::AssetRegistry::default(),
            )
            .get("channelsContentHash")
            .is_none(),
            "没有通道时不得写通道字段"
        );
        editor
            .channel_command("channel.new", json!({ "name": "Alpha 一", "opacity": 40 }))
            .unwrap();
        let created = editor.content_hash().unwrap();
        assert_ne!(created, bare, "建通道必须改变共享内容指纹");
        // 查看态不进入指纹。
        editor
            .channel_command("channel.setVisible", json!({ "channel": 0, "visible": false }))
            .unwrap();
        assert_eq!(editor.content_hash().unwrap(), created, "显隐是查看态");
        editor.channel_command("channel.target", json!({ "channel": 0 })).unwrap();
        assert_eq!(editor.content_hash().unwrap(), created, "目标切换是查看态");
        // 平面像素进入指纹。
        editor.channel_command("channel.setVisible", json!({ "channel": 0, "visible": true })).unwrap();
        editor
            .execute(
                "paint.stroke",
                json!({ "points": [[1, 1], [5, 5]], "size": 3, "hardness": 1, "opacity": 1, "flow": 1, "color": "#ffffff", "target": { "channel": 0 } }),
            )
            .unwrap();
        let painted = editor.content_hash().unwrap();
        assert_ne!(painted, created, "通道像素必须改变共享内容指纹");
        // 删除通道后回到没有该字段的形态。
        editor.channel_command("channel.delete", json!({ "channel": 0 })).unwrap();
        assert_eq!(editor.content_hash().unwrap(), bare, "删空通道应回到旧身份");
    }

    /// 通道内容一改，身份摘要就变；只改查看态（目标/显隐）不变。
    #[test]
    fn channel_content_is_part_of_the_identity_but_view_state_is_not() {
        let mut editor = doc();
        let before = channels_content_hash(&editor.active_doc().unwrap().doc);
        assert_eq!(before, None);
        editor
            .channel_command("channel.new", json!({ "name": "Alpha 一", "opacity": 40 }))
            .unwrap();
        let created = channels_content_hash(&editor.active_doc().unwrap().doc).expect("hash");
        assert_eq!(created.len(), 16);
        // 显隐与目标只是查看态。
        editor
            .channel_command("channel.setVisible", json!({ "channel": 0, "visible": false }))
            .unwrap();
        editor.channel_command("channel.target", json!({ "channel": 0 })).unwrap();
        assert_eq!(
            channels_content_hash(&editor.active_doc().unwrap().doc),
            Some(created.clone()),
            "查看态不能进入内容身份"
        );
        // 改名、改不透明度、改叠层颜色都改变身份。
        for (id, params) in [
            ("channel.rename", json!({ "channel": 0, "name": "Alpha 二" })),
            ("channel.options", json!({ "channel": 0, "opacity": 70 })),
            ("channel.options", json!({ "channel": 0, "color": "#00ff00" })),
        ] {
            let previous = channels_content_hash(&editor.active_doc().unwrap().doc).expect("hash");
            editor.channel_command(id, params).unwrap();
            let next = channels_content_hash(&editor.active_doc().unwrap().doc).expect("hash");
            assert_ne!(next, previous, "{id} 必须改变内容身份");
        }
        // 像素内容（Alpha 平面）同样进入身份。
        let previous = channels_content_hash(&editor.active_doc().unwrap().doc).expect("hash");
        editor.channel_command("channel.target", json!({ "channel": 0 })).unwrap();
        editor
            .execute(
                "paint.stroke",
                json!({ "points": [[1, 1], [5, 5]], "size": 3, "hardness": 1, "opacity": 1, "flow": 1, "color": "#ffffff", "target": { "channel": 0 } }),
            )
            .unwrap();
        assert_ne!(
            channels_content_hash(&editor.active_doc().unwrap().doc),
            Some(previous),
            "Alpha 平面像素必须改变内容身份"
        );
        // 专色：密度与墨色进入身份。
        editor
            .channel_command("channel.newSpot", json!({ "name": "专色", "color": "#00ff00", "solidity": 20 }))
            .unwrap();
        let spot = channels_content_hash(&editor.active_doc().unwrap().doc).expect("hash");
        editor
            .channel_command("channel.options", json!({ "channel": 1, "solidity": 80 }))
            .unwrap();
        assert_ne!(
            channels_content_hash(&editor.active_doc().unwrap().doc),
            Some(spot),
            "专色密度必须改变内容身份"
        );
    }

    /// 通道顺序是内容：同一组通道换序得到不同身份。
    #[test]
    fn channel_order_is_part_of_the_identity() {
        let mut editor = doc();
        editor.channel_command("channel.new", json!({ "name": "A" })).unwrap();
        editor.channel_command("channel.new", json!({ "name": "B" })).unwrap();
        let ordered = channels_content_hash(&editor.active_doc().unwrap().doc).expect("hash");
        editor
            .channel_command("channel.move", json!({ "channel": 1, "to": 0 }))
            .unwrap();
        assert_ne!(
            channels_content_hash(&editor.active_doc().unwrap().doc),
            Some(ordered),
            "顺序属于内容身份"
        );
    }

    /// 固定 fixture：TS 端 `content.test.ts` 用同一份行生成同一个摘要。
    #[test]
    fn the_canonical_text_is_stable_for_the_shared_fixture() {
        let mut editor = doc();
        // 固定行：Alpha（白平面、50% 叠层红、被蒙版区域）+ 专色（黑平面、绿墨、密度 60%）。
        editor
            .channel_command("channel.new", json!({ "name": "Alpha 一", "fill": "white", "opacity": 50 }))
            .unwrap();
        editor
            .channel_command("channel.newSpot", json!({ "name": "专色绿", "color": "#00ff00", "solidity": 60 }))
            .unwrap();
        let doc = &editor.active_doc().unwrap().doc;
        let hash = channels_content_hash(doc).expect("hash");
        // 同一文档重复计算稳定。
        assert_eq!(channels_content_hash(doc), Some(hash.clone()));
        // 文本形状：以通道数开头，逐行 channel:
        let mut lines = vec![format!("channels:{}", doc.channels.len())];
        for channel in &doc.channels {
            lines.push(format!(
                "channel:{}:{}:{}:{}:{}:{}:{}:{}",
                utf16_len(&channel.name),
                channel.name,
                if channel.spot.is_some() { "spot" } else { "alpha" },
                rounded(channel.opacity),
                match channel.indicates {
                    photocraft_doc::ColorIndicates::MaskedAreas => "masked",
                    photocraft_doc::ColorIndicates::SelectedAreas => "selected",
                },
                match channel.spot {
                    Some((ink, _)) => hex_rgb(ink.to_rgb()),
                    None => hex_rgb(channel.color.to_rgb()),
                },
                match channel.spot {
                    Some((_, solidity)) => rounded(solidity),
                    None => "-".to_string(),
                },
                crate::document_content::surface_hash(&channel.surface),
            ));
        }
        assert_eq!(
            crate::identity::fnv1a64_hex(&lines.join("\n")),
            hash,
            "摘要必须正好是规范文本的 FNV-1a"
        );
        assert!(lines[1].starts_with("channel:7:Alpha 一:alpha:0.5:masked:#ff0000:-:"), "{}", lines[1]);
        assert!(lines[2].starts_with("channel:3:专色绿:spot:0.5:masked:#00ff00:0.6:"), "{}", lines[2]);
        // 与 TS `content.test.ts` 的同一 fixture 逐字符同值（跨语言身份一致性）。
        // 期望值由 `packages/protocol/src/features/channels/content.ts` 对同一行独立算出。
        assert_eq!(
            lines,
            [
                "channels:2".to_string(),
                format!("channel:7:Alpha 一:alpha:0.5:masked:#ff0000:-:{}", crate::document_content::surface_hash(&doc.channels[0].surface)),
                format!("channel:3:专色绿:spot:0.5:masked:#00ff00:0.6:{}", crate::document_content::surface_hash(&doc.channels[1].surface)),
            ]
        );
        assert_eq!(
            hash, "984d1d9a4311a91d",
            "TS 与 Rust 必须对同一 fixture 得到同一指纹"
        );
    }
}
