//! 真实字形布局回归（非 GPU）：用随包 `NotoSansSC-Regular.otf` 走 Bevy 的
//! `TextPipeline`，确认栅格档位只改变字形分辨率，不改变文案、业务分行与逻辑排版
//! （change: 2026-10-22-improve-canvas-text-clarity，任务 1.3 / 2.2 / 3.4）。
//!
//! 这些用例不做截图或 GPU 帧比较：它们只覆盖 CPU 排版、字形栅格与 `FontAtlasSet` 键集合，
//! 因此无 GPU 环境也能跑。屏幕显示效果仍需真实设备人工验收。

use std::collections::HashSet;

use bevy::ecs::system::RunSystemOnce;
use bevy::prelude::*;
use bevy::text::{
    ComputedTextBlock, FontAtlasKey, FontAtlasSet, FontCx, FontHinting, FontSize, Justify,
    LayoutCx, LetterSpacing, LineBreak, LineHeight, RemSize, ScaleCx, TextBounds, TextElement,
    TextFont, TextLayoutInfo, TextPipeline,
};

use super::*;

/// 随包字体：与画布运行时的 `assets/fonts/NotoSansSC-Regular.otf` 同一份。
const FONT_BYTES: &[u8] = include_bytes!("../../../assets/fonts/NotoSansSC-Regular.otf");

/// 中英混排 + 数字 + 常见复杂汉字（design D6 的对比样本同一类）。
const MIXED: &str = "镜头 Camera 03 · 渲染预览帧率 59.9fps 龘靐齉";
const TITLE: &str = "角色：深海潜行者";

/// 一次真实排版的稳定输出：业务行数、字形数，以及换算回**世界**与**屏幕**的排版尺寸。
///
/// 换算规则与 `bevy_sprite_render::extract_text2d_sprite` 一致：引擎把
/// `TextLayoutInfo.size` 除以 DPR 得到逻辑排版尺寸，再乘实体 `GlobalTransform` 尺度；
/// 屏幕尺寸再乘相机 zoom。这样两类文字可以用同一组断言比较逻辑排版是否稳定。
#[derive(Debug, PartialEq)]
struct Measured {
    lines: usize,
    glyphs: usize,
    world_width: f32,
    world_height: f32,
    screen_width: f32,
    screen_height: f32,
}

/// 跨多次排版复用的真实文字管线：`FontAtlasSet` 常驻，因此可以观察字号键增长。
struct Harness {
    world: World,
    entity: Entity,
    pipeline: TextPipeline,
    computed: ComputedTextBlock,
    layout_info: TextLayoutInfo,
    fonts: Assets<Font>,
    images: Assets<Image>,
    atlases: FontAtlasSet,
    font_cx: FontCx,
    layout_cx: LayoutCx,
    scale_cx: ScaleCx,
}

impl Harness {
    fn new(text: &str) -> Self {
        let mut world = World::new();
        world.init_resource::<Assets<Font>>();
        world.init_resource::<Assets<Image>>();
        world.init_resource::<FontAtlasSet>();
        world.init_resource::<FontCx>();
        world.init_resource::<LayoutCx>();
        world.init_resource::<ScaleCx>();
        world.init_resource::<RemSize>();
        let handle = world
            .resource_mut::<Assets<Font>>()
            .add(Font::from_bytes(FONT_BYTES.to_vec()));
        let entity = world
            .spawn((
                Text2d::new(text),
                TextFont {
                    font: handle.into(),
                    ..default()
                },
                TextColor::default(),
                TextBounds::UNBOUNDED,
                TextLayout::new(Justify::Left, LineBreak::NoWrap),
            ))
            .id();
        // 注册到 parley collection 并写入 `Font.alias`（`FontSource::Handle` 靠它解析）。
        world
            .run_system_once(bevy::text::load_font_assets_into_font_collection)
            .expect("注册字体");
        let harness = Self {
            pipeline: TextPipeline::default(),
            computed: ComputedTextBlock::default(),
            layout_info: TextLayoutInfo::default(),
            fonts: world.remove_resource::<Assets<Font>>().unwrap(),
            images: world.remove_resource::<Assets<Image>>().unwrap(),
            atlases: FontAtlasSet::default(),
            // 必须复用注册过该字体的 collection：新建空 `FontCx` 会让 Parley 找不到字体族，
            // 排版结果为空（0 行 0 字形），断言会变成假通过。
            font_cx: world.remove_resource::<FontCx>().unwrap(),
            layout_cx: LayoutCx::default(),
            scale_cx: ScaleCx::default(),
            world,
            entity,
        };
        harness
    }

    /// 用真实管线排版；`meta` 与 `(zoom, dpr)` 走与运行时同一纯策略。
    fn measure(&mut self, meta: &LogicalText, zoom: f32, dpr: f32) -> Measured {
        self.measure_with(meta, zoom, dpr, FontHinting::Disabled)
    }

    /// 指定 hinting 策略的真实排版（用于有界 hinting 对比）。
    fn measure_with(
        &mut self,
        meta: &LogicalText,
        zoom: f32,
        dpr: f32,
        hinting: FontHinting,
    ) -> Measured {
        let target = present(meta, zoom, dpr).expect("合法输入必须产出呈现");
        let text = self.world.get::<Text2d>(self.entity).unwrap().0.clone();
        let mut font = self.world.get::<TextFont>(self.entity).unwrap().clone();
        font.font_size = FontSize::Px(target.font_size);
        let bounds = target
            .bounds
            .map(|bounds| TextBounds {
                width: Some(bounds.x),
                height: Some(bounds.y),
            })
            .unwrap_or(TextBounds::UNBOUNDED);
        let span = TextElement::Text {
            text: text.as_str(),
            font: &font,
            color: Color::WHITE,
            line_height: LineHeight::default(),
            letter_spacing: LetterSpacing::default(),
        };
        self.pipeline
            .update_buffer(
                &self.fonts,
                std::iter::once((self.entity, 0, span)),
                LineBreak::NoWrap,
                Justify::Left,
                bounds,
                dpr,
                &mut self.computed,
                &mut self.font_cx,
                &mut self.layout_cx,
                Vec2::new(800.0, 600.0),
                RemSize::default(),
            )
            .expect("真实排版");
        self.pipeline
            .update_text_layout_info(
                &mut self.layout_info,
                &mut self.atlases,
                &mut self.images,
                &mut self.computed,
                &mut self.scale_cx,
                bounds,
                Justify::Left,
                hinting,
            )
            .expect("真实字形栅格化");
        // 世界尺寸 = 物理布局 ÷ DPR × 实体尺度；屏幕尺寸 = 世界尺寸 × zoom。
        let world = self.layout_info.size / dpr * target.scale;
        Measured {
            lines: self.layout_info.run_geometry.len(),
            glyphs: self.layout_info.glyphs.len(),
            world_width: world.x,
            world_height: world.y,
            screen_width: world.x * zoom,
            screen_height: world.y * zoom,
        }
    }

    /// 当前 `FontAtlasSet` 的字形字号键（物理整数像素）。
    fn raster_keys(&self) -> HashSet<u32> {
        self.atlases
            .iter()
            .map(|(key, _)| self.raster_key(key))
            .collect()
    }

    /// 引擎的 `FontAtlasKey` 记录的是**物理**字号（逻辑字号 × DPR），这里还原为整数像素。
    fn raster_key(&self, key: &FontAtlasKey) -> u32 {
        // `FontAtlasKey` 只暴露 `font_size_bits`；它就是 `f32::to_bits` 的物理字号。
        f32::from_bits(key.font_size_bits).round().max(0.0) as u32
    }
}

fn harness(text: &str) -> Harness {
    Harness::new(text)
}

#[test]
fn real_layout_keeps_lines_and_content_across_steps() {
    // 固定 DPR，跨全部合法档位：行数与字形数必须一致（不增删字符、不改业务行数）。
    let mut text = harness(TITLE);
    let baseline = text.measure(&LogicalText::world(12.0, None), 1.0, 2.0);
    assert!(baseline.glyphs > 0, "必须真的栅格化字形");
    for zoom in [0.1, 0.5, 1.0, 1.25, 2.0, 4.0, 8.0, 12.0] {
        let measured = text.measure(&LogicalText::world(12.0, None), zoom, 2.0);
        assert_eq!(
            measured.lines, baseline.lines,
            "zoom={zoom} 业务行数必须不变"
        );
        assert_eq!(
            measured.glyphs, baseline.glyphs,
            "zoom={zoom} 字形数必须不变"
        );
        // 逻辑排版尺寸只允许字形舍入带来的极小差异（远小于半个字）。
        assert!(
            (measured.world_width - baseline.world_width).abs() <= 0.5,
            "zoom={zoom} 逻辑宽度漂移过大：{} vs {}",
            measured.world_width,
            baseline.world_width
        );
        assert!(
            (measured.world_height - baseline.world_height).abs() <= 0.5,
            "zoom={zoom} 逻辑高度漂移过大：{} vs {}",
            measured.world_height,
            baseline.world_height
        );
    }
}

#[test]
fn real_layout_is_stable_across_dprs() {
    let mut text = harness(MIXED);
    let baseline = text.measure(&LogicalText::world(13.0, None), 1.0, 1.0);
    for dpr in [1.0, 1.25, 2.0, 3.0] {
        let measured = text.measure(&LogicalText::world(13.0, None), 1.0, dpr);
        assert_eq!(measured.lines, baseline.lines, "dpr={dpr} 业务行数必须不变");
        assert_eq!(measured.glyphs, baseline.glyphs, "dpr={dpr} 字形数必须不变");
        // 整数物理字号键会带来每字形不足 1 物理像素的量化差：逻辑宽度限制在 5% 内
        // （13px @1.25 会被量化到 12.8px 字形）。
        assert!(
            (measured.world_width - baseline.world_width).abs() <= baseline.world_width * 0.05,
            "dpr={dpr} 逻辑宽度漂移过大：{} vs {}",
            measured.world_width,
            baseline.world_width
        );
    }
}

/// 屏幕模式（节点操作横条）：DPR 固定时字形键恒定，真实排版的**屏幕**尺寸也与缩放无关。
#[test]
fn real_screen_mode_layout_is_zoom_invariant() {
    let mut text = harness("转为片场");
    let baseline = text.measure(&LogicalText::screen(13.0), 1.0, 2.0);
    for zoom in [0.1, 0.5, 1.0, 2.0, 4.0, 8.0, 12.0] {
        let measured = text.measure(&LogicalText::screen(13.0), zoom, 2.0);
        assert_eq!(
            measured.glyphs, baseline.glyphs,
            "zoom={zoom} 字形数必须不变"
        );
        assert!(
            (measured.screen_width - baseline.screen_width).abs() <= 0.5,
            "zoom={zoom} 屏幕字号排版漂移：{} vs {}",
            measured.screen_width,
            baseline.screen_width
        );
        assert!(
            (measured.screen_height - baseline.screen_height).abs() <= 0.5,
            "zoom={zoom} 屏幕行高漂移：{} vs {}",
            measured.screen_height,
            baseline.screen_height
        );
    }
    // 同一 DPR 下连续缩放不新增字号键（只应有一个物理字号 26）。
    assert_eq!(
        text.raster_keys(),
        HashSet::from([26]),
        "屏幕文字字形键必须恒定"
    );
}

#[test]
fn real_raster_key_matches_presentation_for_mixed_text() {
    // 档位 × DPR 只产生有限字号键，且全部落在单字形上限内。
    let mut seen = Vec::new();
    for dpr in [1.0f32, 1.25, 2.0, 3.0] {
        for zoom in [0.1f32, 0.5, 1.0, 1.25, 2.0, 4.0, 8.0, 12.0] {
            let target = present(&LogicalText::world(12.0, None), zoom, dpr).expect("合法输入");
            seen.push(target.raster_key(dpr));
        }
    }
    seen.sort_unstable();
    seen.dedup();
    assert!(
        seen.len() <= SCALE_STEPS.len() * 4,
        "字号键集合必须有限：{seen:?}"
    );
    assert!(
        seen.iter()
            .all(|key| *key >= 1 && *key <= MAX_GLYPH_PX as u32)
    );
}

/// 固定内容与 DPR 下，扫过全部合法倍率后再重复同一轨迹：真实 `FontAtlasSet` 不新增字号键。
///
/// 这正是 design D5 的可核对结论：有限档位约束的是**缩放新增**的字号键；内容持续新增仍会
/// 增加字形，那是既有缓存语义，不能宣称全内容内存有界。
#[test]
fn repeated_zoom_trajectory_does_not_grow_real_atlas_keys() {
    let mut text = harness(TITLE);
    let meta = LogicalText::world(12.0, None);
    let trajectory = [0.1, 0.5, 1.0, 2.0, 4.0, 8.0, 12.0, 4.0, 2.0, 1.0, 0.1];
    for zoom in trajectory {
        text.measure(&meta, zoom, 2.0);
    }
    let warm = text.raster_keys();
    assert!(
        warm.len() <= SCALE_STEPS.len(),
        "真实字号键不得多于档位数：{warm:?}"
    );
    // 重复同一轨迹（含纯平移/静止的重复帧）：键集合与 atlas 数据都不再增长。
    let warm_bytes = text.atlases.total_bytes(&text.images);
    for _ in 0..3 {
        for zoom in trajectory {
            text.measure(&meta, zoom, 2.0);
        }
        // 纯静止帧：同 zoom 重复排版。
        text.measure(&meta, 1.0, 2.0);
    }
    assert_eq!(text.raster_keys(), warm, "重复轨迹不得新增字号键");
    assert_eq!(
        text.atlases.total_bytes(&text.images),
        warm_bytes,
        "重复轨迹不得继续增长 atlas"
    );
}

/// 内容新增与缩放新增的成本不同：换成新文案会新增字形，但字号键集合不变。
#[test]
fn new_content_adds_glyphs_without_new_zoom_keys() {
    let mut text = harness(TITLE);
    let meta = LogicalText::world(12.0, None);
    for zoom in [0.1, 1.0, 4.0, 12.0] {
        text.measure(&meta, zoom, 2.0);
    }
    let zoom_keys = text.raster_keys();
    let before = text.atlases.total_bytes(&text.images);
    *text.world.get_mut::<Text2d>(text.entity).unwrap() = Text2d::new(MIXED);
    for zoom in [0.1, 1.0, 4.0, 12.0] {
        text.measure(&meta, zoom, 2.0);
    }
    assert_eq!(text.raster_keys(), zoom_keys, "新内容不得新增缩放字号键");
    assert!(
        text.atlases.total_bytes(&text.images) > before,
        "新内容会新增字形，这是既有缓存语义"
    );
}

/// 走到单字形上限：真实栅格键等于上限，且不再继续增长。
#[test]
fn capped_zoom_keeps_single_glyph_key_at_limit() {
    let mut text = harness(TITLE);
    // 16px × 档位 12 × DPR 3 = 576 物理像素需求，被压到 256。
    let meta = LogicalText::world(16.0, None);
    let measured = text.measure(&meta, 12.0, 3.0);
    assert!(measured.glyphs > 0);
    assert_eq!(
        text.raster_keys(),
        HashSet::from([MAX_GLYPH_PX as u32]),
        "超过上限时只使用上限栅格键"
    );
    // 更大的 zoom 被门禁拒绝（>12），此处再确认上限键复用而不是新建。
    text.measure(&meta, 12.0, 3.0);
    assert_eq!(text.raster_keys(), HashSet::from([MAX_GLYPH_PX as u32]));
}

/// 有界 hinting 对比（design D6）：hinting 只影响字形栅格，**不得**改变排版度量，
/// 否则会与「栅格档位变更保持逻辑排版」的硬要求冲突。
///
/// 本用例给出两条可核对结论：
/// 1. hinting 开关不改变真实排版的世界尺寸与行数（布局安全）；
/// 2. hinting 进入 `FontAtlasKey`，因此开启它会新增一套字形键（缓存成本）。
///
/// 笔画清晰度是否改善必须由真实 GPU 截图对比证明；本次未采集，因此**保持 Bevy `Text2d`
/// 默认的灰度抗锯齿、不启用 hinting**，并把决定写入 verification。
#[test]
fn hinting_is_layout_safe_but_needs_visual_evidence() {
    let mut text = harness(MIXED);
    let mut metrics_differ = Vec::new();
    for size in [11.0f32, 13.0, 16.0] {
        for dpr in [1.0f32, 1.25, 2.0, 3.0] {
            let meta = LogicalText::world(size, None);
            let off = text.measure_with(&meta, 1.0, dpr, FontHinting::Disabled);
            let on = text.measure_with(&meta, 1.0, dpr, FontHinting::Enabled);
            assert_eq!(
                off.lines, on.lines,
                "size={size} dpr={dpr} hinting 不得改变业务行数"
            );
            assert_eq!(
                off.glyphs, on.glyphs,
                "size={size} dpr={dpr} hinting 不得增删字形"
            );
            if (off.world_width - on.world_width).abs() > 1.0e-3
                || (off.world_height - on.world_height).abs() > 1.0e-3
            {
                metrics_differ.push((size, dpr, off.world_width, on.world_width));
            }
        }
    }
    assert!(
        metrics_differ.is_empty(),
        "hinting 改变了排版度量，会破坏跨档布局稳定性：{metrics_differ:?}"
    );
    // hinting 是独立字形键：同一字号的两种策略各自占用 `FontAtlasKey` 条目，
    // 因此开启它会翻倍字形缓存，必须由真实视觉收益来交换。
    assert!(
        text.atlases.len() > text.raster_keys().len(),
        "hinting 必须体现为独立字形键，否则对比样本没有覆盖到它"
    );
}

#[test]
fn font_bytes_are_the_packaged_font() {
    assert!(FONT_BYTES.len() > 1000, "随包字体必须可读");
}
