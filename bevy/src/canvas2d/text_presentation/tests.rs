use super::*;

/// 覆盖的 DPR 组合（1/1.25/2/3 对应常见屏幕与系统缩放）。
const DPRS: [f32; 4] = [1.0, 1.25, 2.0, 3.0];

fn world(size: f32) -> LogicalText {
    LogicalText::world(size, None)
}

fn keys(size: f32, dpr: f32, trajectory: &[f32]) -> Vec<u32> {
    let mut meta = world(size);
    let mut out = Vec::new();
    for zoom in trajectory {
        let target = present(&meta, *zoom, dpr).expect("合法 zoom 必须产出呈现");
        meta.applied_step = Some(target.step);
        out.push(target.raster_key(dpr));
    }
    out.sort_unstable();
    out.dedup();
    out
}

fn ascend() -> Vec<f32> {
    (0..=1200).map(|i| 0.1 + i as f32 * 0.01).collect()
}

fn descend() -> Vec<f32> {
    ascend().into_iter().rev().collect()
}

#[test]
fn world_text_uses_finite_steps_across_legal_zoom() {
    for zoom in [0.1, 0.5, 1.0, 1.25, 2.0, 4.0, 8.0, 12.0] {
        let target = present(&world(12.0), zoom, 1.0).expect("合法输入");
        assert!(
            SCALE_STEPS.contains(&target.step),
            "zoom={zoom} 档位必须来自有限集合：{target:?}"
        );
        assert!(
            target.step >= zoom.max(1.0) - 1.0e-4,
            "zoom={zoom} 档位不得低于需求"
        );
    }
}

#[test]
fn world_text_scale_compensates_raster_growth() {
    for size in [10.0, 11.0, 12.0, 13.0, 14.0, 16.0] {
        for dpr in DPRS {
            for zoom in [0.1, 0.5, 1.0, 2.0, 4.0, 8.0, 12.0] {
                let target = present(&world(size), zoom, dpr).expect("合法输入");
                // 显示尺寸仍为逻辑字号：栅格放大由局部尺度反比抵消。
                let displayed = target.font_size * target.scale;
                assert!(
                    (displayed - size).abs() <= 1.0e-3,
                    "size={size} dpr={dpr} zoom={zoom}：显示尺寸 {displayed} 偏离逻辑字号"
                );
                assert!(target.font_size > 0.0 && target.scale > 0.0);
            }
        }
    }
}

#[test]
fn screen_text_keeps_font_size_and_cancels_zoom() {
    for zoom in [0.1, 0.5, 1.0, 2.0, 4.0, 8.0, 12.0] {
        let target = present(&LogicalText::screen(13.0), zoom, 2.0).expect("合法输入");
        // 字号键固定为设备 DPR 下的整数物理字号，不随 1/zoom 变化。
        assert_eq!(target.raster_key(2.0), 26);
        // 世界尺寸 = 屏幕字号 / zoom，投影后回到固定屏幕字号。
        assert!((target.font_size * target.scale - 13.0 / zoom).abs() <= 1.0e-3);
    }
    // 同一 DPR 下连续缩放不产生新的字号键。
    let keys: Vec<u32> = [0.1, 0.35, 1.0, 2.5, 6.0, 12.0]
        .iter()
        .map(|zoom| {
            present(&LogicalText::screen(13.0), *zoom, 1.25)
                .expect("合法输入")
                .raster_key(1.25)
        })
        .collect();
    assert_eq!(keys, vec![16; keys.len()], "屏幕文字字号键必须恒定");
}

#[test]
fn single_glyph_raster_is_capped_without_changing_layout() {
    for size in [10.0, 12.0, 13.0, 16.0] {
        for dpr in DPRS {
            for zoom in [8.0, 12.0] {
                let target = present(&world(size), zoom, dpr).expect("合法输入");
                assert!(
                    target.raster_key(dpr) <= MAX_GLYPH_PX as u32,
                    "size={size} dpr={dpr} zoom={zoom} 超过单字形上限"
                );
                assert!((target.font_size * target.scale - size).abs() <= 1.0e-3);
            }
        }
    }
}

#[test]
fn downgrade_requires_crossing_hysteresis_band() {
    // 档位 2 的下一较低档为 1：低于 0.85 才降档。
    assert_eq!(step_for(1.9, Some(2.0)), 2.0, "未穿过滞回边界不降档");
    assert_eq!(step_for(0.86, Some(2.0)), 2.0);
    assert_eq!(step_for(0.84, Some(2.0)), 1.0);
    // 档位 4 的下一较低档为 2：低于 1.7 才降档。
    assert_eq!(step_for(3.9, Some(4.0)), 4.0);
    assert_eq!(step_for(1.75, Some(4.0)), 4.0);
    assert_eq!(step_for(1.6, Some(4.0)), 2.0);
    // 升级立即生效，不受滞回影响。
    assert_eq!(step_for(8.0, Some(1.0)), 8.0);
    assert_eq!(step_for(9.5, Some(8.0)), 12.0);
    // 新建实体（无历史档位）直接按当前倍率选档。
    assert_eq!(step_for(3.0, None), 4.0);
    assert_eq!(step_for(0.2, None), 1.0);
    assert_eq!(step_for(40.0, None), 12.0, "超过末档使用末档");
}

#[test]
fn boundary_oscillation_keeps_one_step() {
    let mut meta = world(12.0);
    // 先放大到档位 4，再在 2 倍阈值附近小幅往返。
    let target = present(&meta, 4.0, 1.0).expect("合法输入");
    meta.applied_step = Some(target.step);
    let mut steps = Vec::new();
    for zoom in [4.0, 1.9, 2.05, 1.85, 2.2, 1.95] {
        let target = present(&meta, zoom, 1.0).expect("合法输入");
        meta.applied_step = Some(target.step);
        steps.push(target.step);
    }
    assert!(
        steps.iter().all(|step| *step == 4.0),
        "滞回区间内不得切档：{steps:?}"
    );
}

#[test]
fn repeated_trajectories_keep_a_finite_key_set() {
    for size in [11.0, 13.0, 16.0] {
        for dpr in DPRS {
            let first = keys(size, dpr, &ascend());
            // 连续轨迹扫过全部合法倍率后，重复同一轨迹不再新增字号键。
            let mut trajectory = ascend();
            trajectory.extend(descend());
            trajectory.extend(ascend());
            let repeated = keys(size, dpr, &trajectory);
            assert_eq!(
                first, repeated,
                "size={size} dpr={dpr} 重复轨迹新增了字号键"
            );
            assert!(
                repeated.len() <= SCALE_STEPS.len(),
                "size={size} dpr={dpr} 字号键数量 {} 超过档位数",
                repeated.len()
            );
        }
    }
}

#[test]
fn pure_pan_and_still_frames_do_not_change_presentation() {
    let meta = world(12.0);
    let first = present(&meta, 2.0, 2.0).expect("合法输入");
    let second = present(&meta, 2.0, 2.0).expect("合法输入");
    assert_eq!(first, second, "同状态必须幂等");
}

#[test]
fn invalid_zoom_or_dpr_yields_no_presentation() {
    for zoom in [0.0, -1.0, f32::NAN, f32::INFINITY] {
        assert!(
            present(&world(12.0), zoom, 2.0).is_none(),
            "zoom={zoom} 必须拒绝"
        );
        assert!(
            present(&LogicalText::screen(13.0), zoom, 2.0).is_none(),
            "屏幕模式不得对非法 zoom 取倒数"
        );
    }
    for dpr in [0.0, -1.0, f32::NAN, f32::INFINITY] {
        assert!(
            present(&world(12.0), 1.0, dpr).is_none(),
            "dpr={dpr} 必须拒绝"
        );
    }
    assert!(present(&world(0.0), 1.0, 1.0).is_none());
    assert!(present(&world(f32::NAN), 1.0, 1.0).is_none());
}

#[test]
fn dpr_change_updates_raster_without_changing_logical_layout() {
    let meta = world(16.0);
    let base = present(&meta, 1.0, 1.0).expect("合法输入");
    let hidpi = present(&meta, 1.0, 2.0).expect("合法输入");
    assert_ne!(
        base.raster_key(1.0),
        hidpi.raster_key(2.0),
        "同 CSS 尺寸下 DPR 变化必须改变实际栅格键"
    );
    assert_eq!(base.raster_key(1.0), 16);
    assert_eq!(hidpi.raster_key(2.0), 32);
    assert!((base.font_size * base.scale - 16.0).abs() <= 1.0e-3);
    assert!((hidpi.font_size * hidpi.scale - 16.0).abs() <= 1.0e-3);
    // 逼近单字形上限时 DPR 会改变写回的字号（物理键被压到上限）。
    let capped = present(&meta, 12.0, 3.0).expect("合法输入");
    assert_eq!(capped.raster_key(3.0), MAX_GLYPH_PX as u32);
    assert!((capped.font_size * capped.scale - 16.0).abs() <= 1.0e-3);
}

#[test]
fn bounds_follow_raster_ratio() {
    let meta = LogicalText::world(12.0, Some(Vec2::new(600.0, 48.0)));
    let target = present(&meta, 4.0, 1.0).expect("合法输入");
    let bounds = target.bounds.expect("bounds 必须随栅格换算");
    let ratio = target.font_size / 12.0;
    assert!((bounds.x - 600.0 * ratio).abs() <= 1.0e-3);
    assert!((bounds.y - 48.0 * ratio).abs() <= 1.0e-3);
    // 无界文字保持无界。
    assert!(
        present(&world(12.0), 4.0, 1.0)
            .expect("合法输入")
            .bounds
            .is_none()
    );
}

#[test]
fn zoom_below_one_rasterizes_at_logical_size_only() {
    for zoom in [0.1, 0.25, 0.5, 0.9] {
        let target = present(&world(12.0), zoom, 1.0).expect("合法输入");
        assert_eq!(target.step, 1.0);
        assert_eq!(target.raster_key(1.0), 12);
    }
}

/// 有效倍率取自实际二维相机（含媒体聚焦取景），不是只读 overview zoom：
/// 聚焦时相机按 `focus.viewport.zoom` 投影，文字档位必须跟随同一条派生。
#[test]
fn effective_zoom_follows_media_focus_camera() {
    let node: crate::protocol::GraphNode = serde_json::from_value(serde_json::json!({
        "id": "img", "type": "image", "x": 0, "y": 0, "width": 320, "height": 240,
    }))
    .expect("节点");
    let mut scene = crate::protocol::Scene {
        nodes: vec![node],
        viewport: crate::protocol::Viewport {
            x: 0.0,
            y: 0.0,
            zoom: 1.0,
        },
        ..Default::default()
    };
    let mut app_world = World::new();
    app_world.insert_resource(CurrentScene(scene.clone()));
    app_world.insert_resource(SurfaceState::with_size(Vec2::new(800.0, 600.0)));
    assert!((effective_zoom(&app_world.resource::<CurrentScene>()) - 1.0).abs() <= 1.0e-6);

    // 聚焦同一节点：相机改按聚焦取景缩放，文字档位必须跟随它而不是 overview zoom。
    scene.image_focus = Some(crate::protocol::ImageFocus {
        version: crate::protocol::IMAGE_FOCUS_VERSION.to_owned(),
        node_id: "img".into(),
        presentation_ready: true,
        viewport: crate::protocol::ImageFocusViewport {
            x: 0.0,
            y: 0.0,
            zoom: 4.0,
        },
        source_width: 640.0,
        source_height: 480.0,
    });
    app_world.insert_resource(CurrentScene(scene.clone()));
    let focused = effective_zoom(&app_world.resource::<CurrentScene>());
    assert!(
        focused > 1.5,
        "聚焦倍率必须来自实际相机派生，得到 {focused}"
    );
    let step = present(&world(12.0), focused, 1.0).expect("合法输入").step;
    assert!(step > 1.0, "聚焦放大后文字档位必须提高");

    // 聚焦目标节点缺失：无可用取景，回落到 overview zoom（不套用错误的聚焦倍率）。
    scene.image_focus.as_mut().unwrap().node_id = "missing".into();
    app_world.insert_resource(CurrentScene(scene));
    assert!((effective_zoom(&app_world.resource::<CurrentScene>()) - 1.0).abs() <= 1.0e-6);
}

mod ecs {
    use super::*;
    use crate::app::{CurrentScene, SurfaceState};
    use bevy::ecs::system::RunSystemOnce;

    fn world_with(zoom: f32, pixel_ratio: f32) -> World {
        let mut world = World::new();
        world.insert_resource(PresentationCache::default());
        world.insert_resource(CurrentScene(crate::protocol::Scene {
            viewport: crate::protocol::Viewport {
                x: 0.0,
                y: 0.0,
                zoom,
            },
            ..Default::default()
        }));
        world.insert_resource(SurfaceState {
            size: Vec2::new(800.0, 600.0),
            pixel_ratio,
        });
        world
    }

    fn spawn_text(world: &mut World, meta: LogicalText) -> Entity {
        world
            .spawn((
                Text2d::new("画布文字"),
                TextFont {
                    font_size: FontSize::Px(meta.size),
                    ..default()
                },
                TextColor::default(),
                TextBounds {
                    width: Some(600.0),
                    height: Some(48.0),
                },
                Transform::default(),
                meta,
            ))
            .id()
    }

    fn run(world: &mut World) {
        world.run_system_once(super::sync).unwrap();
    }

    fn font_size(world: &World, entity: Entity) -> f32 {
        world
            .get::<TextFont>(entity)
            .and_then(|font| match font.font_size {
                FontSize::Px(size) => Some(size),
                _ => None,
            })
            .unwrap_or_default()
    }

    #[test]
    fn applies_selected_step_then_stays_idle() {
        let mut world = world_with(4.0, 2.0);
        let entity = spawn_text(
            &mut world,
            LogicalText::world(12.0, Some(Vec2::new(600.0, 48.0))),
        );
        run(&mut world);
        let scale = world.get::<Transform>(entity).unwrap().scale.x;
        assert!((font_size(&world, entity) * scale - 12.0).abs() <= 1.0e-3);

        // 第二帧同一状态：不写任何文字组件。
        world.clear_trackers();
        run(&mut world);
        assert_eq!(
            world
                .query_filtered::<Entity, Changed<TextFont>>()
                .iter(&world)
                .count(),
            0,
            "静止帧不得重写字体"
        );
        assert_eq!(
            world
                .query_filtered::<Entity, Changed<TextBounds>>()
                .iter(&world)
                .count(),
            0,
            "静止帧不得重写 bounds"
        );
    }

    #[test]
    fn reused_entity_follows_new_logical_size() {
        let mut world = world_with(2.0, 1.0);
        let entity = spawn_text(&mut world, LogicalText::world(12.0, None));
        run(&mut world);
        let before = font_size(&world, entity);
        world
            .get_mut::<LogicalText>(entity)
            .unwrap()
            .set(16.0, None, TextScaleMode::World);
        run(&mut world);
        let after = font_size(&world, entity);
        assert_ne!(before, after, "逻辑字号变化必须重新派生字体");
        let scale = world.get::<Transform>(entity).unwrap().scale.x;
        assert!((after * scale - 16.0).abs() <= 1.0e-3, "仍按新逻辑字号显示");
    }

    #[test]
    fn zoom_step_change_updates_only_text_components() {
        let mut world = world_with(1.0, 1.0);
        let entity = spawn_text(&mut world, LogicalText::world(12.0, None));
        run(&mut world);
        let before = font_size(&world, entity);
        world.resource_mut::<CurrentScene>().0.viewport.zoom = 8.0;
        run(&mut world);
        assert!(font_size(&world, entity) > before, "跨档后栅格字号提高");
        let transform = world.get::<Transform>(entity).unwrap();
        assert!((transform.scale.x * font_size(&world, entity) - 12.0).abs() <= 1.0e-3);
        // 跨档只改文字组件：平移、z、旋转都不参与（锚点由 `Anchor` + 显示尺寸决定）。
        assert_eq!(transform.translation, Vec3::ZERO);
        assert_eq!(transform.rotation, Quat::IDENTITY);
        assert_eq!(transform.scale.z, 1.0, "只缩放 x/y，深度不变");
    }

    /// 世界文字与屏幕文字的锚点契约不同但都由显示尺寸派生：局部 x/y 尺度不改变 `Anchor`
    /// 语义（`TOP_LEFT` 仍是左上角），因此卡片相对位置与命中矩形不受档位影响。
    #[test]
    fn scale_only_affects_local_extent_not_anchor_origin() {
        let mut world = world_with(8.0, 2.0);
        let world_text = spawn_text(
            &mut world,
            LogicalText::world(12.0, Some(Vec2::new(600.0, 48.0))),
        );
        let screen_text = spawn_text(&mut world, LogicalText::screen(13.0));
        run(&mut world);
        for entity in [world_text, screen_text] {
            let transform = world.get::<Transform>(entity).unwrap();
            // 锚点位置来自 translation（生产者写入），缩放不移动它。
            assert_eq!(transform.translation, Vec3::ZERO);
            assert!(transform.scale.x.is_finite() && transform.scale.x > 0.0);
            assert_eq!(transform.scale.x, transform.scale.y, "等比缩放，字形不变形");
        }
        // 世界文字显示尺寸 = 逻辑字号；屏幕文字 = 屏幕字号 / zoom。
        let world_font = font_size(&world, world_text);
        let world_scale = world.get::<Transform>(world_text).unwrap().scale.x;
        assert!((world_font * world_scale - 12.0).abs() <= 1.0e-3);
        let screen_font = font_size(&world, screen_text);
        let screen_scale = world.get::<Transform>(screen_text).unwrap().scale.x;
        assert!((screen_font * screen_scale - 13.0 / 8.0).abs() <= 1.0e-3);
    }

    #[test]
    fn dpr_only_change_retargets_capped_raster() {
        // 未触及上限时引擎自己会按新的 scale factor 重新栅格化，逻辑字号不变；
        // 逼近单字形上限时，DPR 变化会改变压到上限的实际字形。
        let mut world = world_with(12.0, 1.0);
        let entity = spawn_text(&mut world, LogicalText::world(16.0, None));
        run(&mut world);
        let before = font_size(&world, entity);
        assert_eq!(before, 192.0);
        assert!((before * world.get::<Transform>(entity).unwrap().scale.x - 16.0).abs() <= 1.0e-3);
        world.resource_mut::<SurfaceState>().pixel_ratio = 2.0;
        run(&mut world);
        let after = font_size(&world, entity);
        assert_ne!(after, before, "触及上限时 DPR 变化必须重取栅格表示");
        assert!((after * 2.0 - MAX_GLYPH_PX).abs() <= 1.0e-3);
        assert!((after * world.get::<Transform>(entity).unwrap().scale.x - 16.0).abs() <= 1.0e-3);
    }

    #[test]
    fn dpr_only_change_keeps_logical_font_size_below_cap() {
        let mut world = world_with(1.0, 1.0);
        let entity = spawn_text(&mut world, LogicalText::world(13.0, None));
        run(&mut world);
        assert_eq!(font_size(&world, entity), 13.0);
        world.resource_mut::<SurfaceState>().pixel_ratio = 1.25;
        run(&mut world);
        // 逻辑字号按 DPR 量化到整数物理键：13 × 1.25 = 16.25 → 16 物理像素。
        let retargeted = font_size(&world, entity);
        assert!(
            (retargeted - 12.8).abs() <= 1.0e-3,
            "dpr=1.25 应重取整数字形键"
        );
        let scale = world.get::<Transform>(entity).unwrap().scale.x;
        assert!(
            (retargeted * scale - 13.0).abs() <= 1.0e-3,
            "显示尺寸保持逻辑字号"
        );
    }

    #[test]
    fn invalid_zoom_keeps_last_legal_presentation() {
        let mut world = world_with(2.0, 1.0);
        let entity = spawn_text(&mut world, LogicalText::world(12.0, None));
        run(&mut world);
        let legal = font_size(&world, entity);
        world.resource_mut::<CurrentScene>().0.viewport.zoom = f32::NAN;
        run(&mut world);
        assert_eq!(
            font_size(&world, entity),
            legal,
            "非法倍率不得改写已接受的表示"
        );
    }

    /// 逐帧生产者（横条/进度/粘连带）用 `matches` 先比较再写：静止帧不得留下变更标记，
    /// 否则策略系统每帧都会重扫全部文字（design D4「静止帧不写未变化组件」）。
    #[test]
    fn idle_frames_do_not_revisit_text_after_producer_rewrites() {
        let mut world = world_with(2.0, 2.0);
        let entity = spawn_text(&mut world, LogicalText::screen(13.0));
        run(&mut world);
        world.clear_trackers();
        // 模拟逐帧生产者：值未变时不得解引用写入。
        let idle = {
            let meta = world.get::<LogicalText>(entity).expect("元数据");
            meta.matches(13.0, None, TextScaleMode::Screen)
        };
        assert!(idle, "同值必须先判等再写");
        assert_eq!(
            world
                .query_filtered::<Entity, Changed<LogicalText>>()
                .iter(&world)
                .count(),
            0,
            "同值调用不得产生变更标记"
        );
        run(&mut world);
        assert_eq!(
            world
                .query_filtered::<Entity, Changed<TextFont>>()
                .iter(&world)
                .count(),
            0,
            "静止帧不得重写字体"
        );
    }

    /// 字体未就绪时仍先落定呈现：字体到达后由 Bevy 用最新逻辑状态排版，不会发布旧文案。
    #[test]
    fn presentation_applies_before_font_is_ready() {
        let mut world = world_with(8.0, 2.0);
        // 没有 `Assets<Font>`/`Text2d` 布局系统：模拟字体尚在加载。
        let entity = spawn_text(&mut world, LogicalText::world(12.0, None));
        run(&mut world);
        assert!(
            (font_size(&world, entity) * world.get::<Transform>(entity).unwrap().scale.x - 12.0)
                .abs()
                <= 1.0e-3,
            "字体未就绪也必须先选好当前倍率的栅格表示"
        );
        // 字体到达后再次同步：状态已一致，不重复改写。
        world.clear_trackers();
        run(&mut world);
        assert_eq!(
            world
                .query_filtered::<Entity, Changed<TextFont>>()
                .iter(&world)
                .count(),
            0
        );
    }

    /// 运行时重建：新的 `PresentationCache` 从 NaN 起算，即使 scene/DPR 与旧代相同也必须完整
    /// 重新派生一次（旧代档位与实体不复活）。
    #[test]
    fn fresh_generation_rederives_presentation_even_with_same_camera() {
        let mut world = world_with(4.0, 2.0);
        let entity = spawn_text(&mut world, LogicalText::world(12.0, None));
        run(&mut world);
        let applied = font_size(&world, entity);
        // 模拟新代：文字实体与元数据重建，缓存回到默认值。
        world.despawn(entity);
        world.insert_resource(PresentationCache::default());
        let rebuilt = spawn_text(&mut world, LogicalText::world(12.0, None));
        run(&mut world);
        assert_eq!(
            font_size(&world, rebuilt),
            applied,
            "同倍率同 DPR 的新代必须得到同一表示"
        );
        let scale = world.get::<Transform>(rebuilt).unwrap().scale.x;
        assert!((font_size(&world, rebuilt) * scale - 12.0).abs() <= 1.0e-3);
    }

    #[test]
    fn screen_mode_text_keeps_font_size_across_zoom() {
        let mut world = world_with(1.0, 1.0);
        let entity = spawn_text(&mut world, LogicalText::screen(13.0));
        run(&mut world);
        let base = font_size(&world, entity);
        assert_eq!(base, 13.0);
        for zoom in [0.5, 2.0, 4.0, 12.0] {
            world.resource_mut::<CurrentScene>().0.viewport.zoom = zoom;
            run(&mut world);
            assert_eq!(
                font_size(&world, entity),
                base,
                "屏幕文字字号键不得随 zoom 变化"
            );
            let scale = world.get::<Transform>(entity).unwrap().scale.x;
            assert!((scale * base - 13.0 / zoom).abs() <= 1.0e-3);
        }
    }
}
