//! U43/U44 逐类效果证据（change: 2026-10-22-add-photocraft-adjustment-workflows）。
//!
//! 直接调整的入口由唯一命令门发布；这里**不经过命令门**，只在隔离 `Session` 里用本域的参数表
//! 与命令 id 执行真实上游命令，证明：
//! - 每类/每条命令的参数形状被生产解析器接受（不是只过我们自己的校验）；
//! - 对受控图真实产生像素差异，并恰好增加一步历史；
//! - 调整层参数经 `to_params`/`from_params` 往返稳定。
//!
//! 只读 `Surface::sample_channel`，不合成、不渲染，也不采集 GPU 证据。

use photocraft_engine::Session;
use serde_json::{json, Value};

use super::direct_adjustment as domain;

/// 受控图：整层填充一个颜色（RGB 0–1），返回会话与像素样本点。
fn canvas(color: &str) -> Session {
    let mut session = Session::new();
    session.execute("file.new", json!({"width": 16, "height": 16})).unwrap();
    session.execute("edit.fill", json!({"contents": "color", "color": color})).unwrap();
    session
}

fn sample(session: &Session) -> [f32; 3] {
    let state = session.active().unwrap();
    let layer = state.active_layer.unwrap();
    let surface = state.doc.layer(layer).and_then(|layer| layer.surface()).unwrap();
    [surface.sample_channel(4, 4, 0), surface.sample_channel(4, 4, 1), surface.sample_channel(4, 4, 2)]
}

/// 两色图：左半 `left`、右半 `right`，用来给直方图类命令真实的范围。
fn split_canvas(left: &str, right: &str) -> Session {
    let mut session = canvas(right);
    session.execute("select.rect", json!({"x": 0, "y": 0, "width": 8, "height": 16})).unwrap();
    session.execute("edit.fill", json!({"contents": "color", "color": left})).unwrap();
    session.execute("select.deselect", Value::Null).unwrap();
    session
}

fn past(session: &Session) -> usize {
    session.active().unwrap().history.past_len()
}

/// 跑一条已实现命令：校验 → 执行 → 断言像素变化且只加一步历史。
fn expect_change(session: &mut Session, command: &str, params: &Value, label: &str) {
    let before_pixel = sample(session);
    let before_past = past(session);
    let mut payload = params.clone();
    payload["layer"] = json!(session.active().unwrap().active_layer.unwrap().0);
    session.execute(command, payload).unwrap_or_else(|failure| panic!("{label}: {failure}"));
    assert_ne!(sample(session), before_pixel, "{label} 必须真实改变像素");
    assert_eq!(past(session), before_past + 1, "{label} 必须只增加一步历史");
}

#[test]
fn every_implemented_kind_produces_a_real_pixel_change() {
    // 每类一条能在这张受控图上真实改变像素的参数；参数同时要通过本域校验。
    let cases: &[(&str, &str, Value)] = &[
        ("brightnessContrast", "#7a5230", json!({"brightness": 60, "contrast": 30})),
        ("exposure", "#7a5230", json!({"exposure": 1.5, "offset": 0.05, "gamma": 1.2})),
        ("hueSaturation", "#7a5230", json!({"hue": 90, "saturation": 40})),
        ("curves", "#7a5230", json!({"points": [[0, 0], [128, 200], [255, 255]]})),
        ("levels", "#7a5230", json!({"inBlack": 20, "gamma": 1.6, "inWhite": 200})),
        ("colorBalance", "#7a5230", json!({"midtones": [0, 70, 0], "preserveLuminosity": false})),
        ("blackWhite", "#7a5230", json!({"reds": 90, "blues": 10})),
        ("photoFilter", "#7a5230", json!({"filter": "cooling80", "density": 70})),
        ("channelMixer", "#7a5230", json!({"red": [0, 100, 0, 0]})),
        ("invert", "#7a5230", json!({})),
        ("posterize", "#7a5230", json!({"levels": 3})),
        ("threshold", "#7a5230", json!({"level": 200})),
        ("gradientMap", "#7a5230", json!({"stops": [[0.0, "#ff0000"], [1.0, "#0000ff"]]})),
        ("selectiveColor", "#ff0000", json!({"method": "absolute", "reds": [100, 0, 0, 0]})),
        ("vibrance", "#7a5230", json!({"vibrance": 90, "saturation": 40})),
    ];
    let mut covered = Vec::new();
    for (kind, color, params) in cases {
        domain::validate(kind, params).unwrap_or_else(|failure| panic!("{kind}: {failure}"));
        let mut session = canvas(color);
        expect_change(&mut session, &domain::adjustment_command(kind), params, kind);
        covered.push(*kind);
    }
    // 参数表里的每一类都必须在这张矩阵里出现，新增类型不能漏测。
    assert_eq!(covered.len(), domain::ADJUSTMENT_KINDS.len());
    for kind in domain::ADJUSTMENT_KINDS {
        assert!(covered.contains(kind), "{kind} 缺少真实效果证据");
    }
}

#[test]
fn every_published_kind_can_create_an_adjustment_layer_and_be_edited() {
    // U43 的「调整层」入口：命令门放开后，创建 → 草稿 → 确认必须真的走通；
    // 只有直接调整能跑不算发布完成。
    let cases: &[(&str, Value)] = &[
        ("brightnessContrast", json!({"brightness": 20, "contrast": 10})),
        ("exposure", json!({"exposure": 0.5})),
        ("hueSaturation", json!({"hue": 30})),
        ("curves", json!({"points": [[0, 0], [128, 200], [255, 255]]})),
        ("levels", json!({"inBlack": 10, "outWhite": 240})),
        ("colorBalance", json!({"midtones": [0, 30, 0], "preserveLuminosity": false})),
        ("blackWhite", json!({"reds": 60})),
        ("photoFilter", json!({"filter": "cooling80", "density": 40})),
        ("channelMixer", json!({"red": [0, 100, 0, 0]})),
        ("invert", json!({})),
        ("posterize", json!({"levels": 3})),
        ("threshold", json!({"level": 180})),
        ("gradientMap", json!({"stops": [[0.0, "#ff0000"], [1.0, "#0000ff"]]})),
        ("selectiveColor", json!({"method": "absolute", "reds": [50, 0, 0, 0]})),
        ("vibrance", json!({"vibrance": 40})),
    ];
    let mut covered = Vec::new();
    for (kind, params) in cases {
        let mut session = canvas("#7a5230");
        let command = format!("layer.newAdjustmentLayer.{kind}");
        session
            .execute(&command, params.clone())
            .unwrap_or_else(|failure| panic!("{command}: {failure}"));
        let state = session.active().unwrap();
        let layer = state.active_layer.expect("新调整层成为活动层");
        assert!(
            matches!(state.doc.layer(layer).map(|layer| &layer.content), Some(photocraft_doc::LayerContent::Adjustment(_))),
            "{kind} 必须创建可重编的调整层"
        );
        covered.push(*kind);
    }
    assert_eq!(covered.len(), domain::ADJUSTMENT_KINDS.len());
    for kind in domain::ADJUSTMENT_KINDS {
        assert!(covered.contains(kind), "{kind} 缺少调整层创建证据");
    }
}

#[test]
fn every_implemented_command_produces_a_real_pixel_change() {
    let cases: &[(&str, fn() -> Session, Value)] = &[
        ("image.autoTone", || split_canvas("#202020", "#d0d0d0"), json!({})),
        ("image.autoContrast", || split_canvas("#202020", "#d0d0d0"), json!({})),
        ("image.autoColor", || split_canvas("#806040", "#604020"), json!({})),
        ("image.adjustments.desaturate", || canvas("#7a5230"), json!({})),
        ("image.adjustments.equalize", || split_canvas("#202020", "#d0d0d0"), json!({})),
        ("image.adjustments.shadowsHighlights", || canvas("#302010"), json!({"shadowAmount": 80})),
        (
            "image.adjustments.replaceColor",
            || canvas("#7a5230"),
            json!({"color": "#7a5230", "fuzziness": 200, "hue": 120}),
        ),
        (
            "image.adjustments.matchColor",
            || split_canvas("#806040", "#604020"),
            json!({"neutralize": true}),
        ),
    ];
    let mut covered = Vec::new();
    for (command, image, params) in cases {
        domain::validate_command(command, params).unwrap_or_else(|failure| panic!("{command}: {failure}"));
        let mut session = image();
        expect_change(&mut session, command, params, command);
        covered.push(*command);
    }
    assert_eq!(covered.len(), domain::ADJUSTMENT_COMMANDS.len());
    for command in domain::ADJUSTMENT_COMMANDS {
        assert!(covered.contains(command), "{command} 缺少真实效果证据");
    }
}
