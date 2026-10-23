use super::*;
use photocraft_doc::{ColorMode, SampleType, Size};
use photocraft_geom::{Rect, TileCoord};

#[test]
fn pattern_resources_have_identity_and_roundtrip_without_preview_or_pixels() {
    use photocraft_doc::{Pattern,Surface};
    let registry=AssetRegistry::default();let mut doc=document();
    let baseline=document_content_hash(&doc,&registry).unwrap();
    let make=|id:&str|Pattern{id:id.into(),name:"图案".into(),width:16,height:16,surface:Surface::new(doc.pixel_format())};
    doc.patterns=vec![make("b"),make("a")];
    let content=project_content(&doc,&registry);assert!(content["patternContentHash"].as_str().is_some());
    let hash=document_content_hash(&doc,&registry).unwrap();assert_ne!(hash,baseline);
    let saved=photocraft_format::save_to_bytes(&doc,&Default::default()).unwrap();
    photocraft_project_verify::verify(&saved).unwrap();
    let loaded=photocraft_format::load_from_bytes(&saved).unwrap();
    assert_eq!(document_content_hash(&loaded,&registry).unwrap(),hash);
    doc.patterns.reverse();assert_eq!(document_content_hash(&doc,&registry).unwrap(),hash);
    doc.patterns[0].width=17;assert_ne!(document_content_hash(&doc,&registry).unwrap(),hash);
    doc.patterns[0].width=16;doc.patterns[0].name="改名".into();assert_ne!(document_content_hash(&doc,&registry).unwrap(),hash);
    doc.patterns[0].id=doc.patterns[1].id.clone();assert!(document_content_hash(&doc,&registry).is_none());
    doc.patterns.clear();assert_eq!(document_content_hash(&doc,&registry).unwrap(),baseline);
}

fn document() -> Document {
    let mut doc = Document::new("工程", Size::new(64, 48), ColorMode::Rgb, SampleType::U8);
    doc.layers.push(Layer::raster("Background", doc.pixel_format()));
    doc
}

/// U56：画板的内容身份必须覆盖子层，且跨保存/重开稳定。
///
/// 画面板以前只写 `kind:"artboard"` 而不计子层，等于「画板里的任何改动都不改变工程 hash」，
/// 保存门禁与「是否净变化」判定都会失效。这里同时锁住三件事：子层进入指纹、子层改动改变指纹、
/// 保存重开后指纹不变。
#[test]
fn artboard_children_participate_in_content_identity_and_roundtrip() {
    use photocraft_engine::Session;
    let mut session = Session::new();
    session.execute("file.new", json!({"width":80,"height":60})).unwrap();
    session.execute("layer.new.layer", json!({"name":"p"})).unwrap();
    session
        .execute(
            "paint.stroke",
            json!({"points":[[10,10],[30,20]],"size":3,"hardness":1,"opacity":1,"flow":1,"color":"#ff0000","target":"pixels"}),
        )
        .unwrap();
    // `layer.new.artboard` 建的是空画板；真正把图层纳入画板的是 `artboardFromLayers`。
    session.execute("layer.new.artboardFromLayers", json!({"name":"画板"})).unwrap();
    let registry = AssetRegistry::default();
    let doc = &session.active().unwrap().doc;
    let content = project_content(doc, &registry);
    let artboard = content["layers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|layer| layer["kind"] == "artboard")
        .expect("应有画板图层");
    let children = artboard["children"].as_array().expect("画板必须带子层指纹");
    assert!(!children.is_empty(), "画板子层必须进入内容指纹");
    let hash = document_content_hash(doc, &registry).expect("画板工程必须能算出内容哈希");

    // 保存 → 核验 → 重开，指纹不变。
    let saved = photocraft_format::save_to_bytes(doc, &Default::default()).unwrap();
    photocraft_project_verify::verify(&saved).expect("画板工程应通过核验");
    let loaded = photocraft_format::load_from_bytes(&saved).unwrap();
    assert_eq!(document_content_hash(&loaded, &registry).unwrap(), hash, "画板指纹必须跨重开稳定");

    // 画板子层内做像素改动必须改变指纹（否则「是否净变化」失效）。
    // 先选中画板里的像素图层，再在选区内做一次填充。
    let child_id = {
        let doc = &session.active().unwrap().doc;
        doc.layers
            .iter()
            .find_map(|layer| match &layer.content {
                photocraft_doc::LayerContent::Group(group) if group.artboard.is_some() => group
                    .children
                    .iter()
                    .find(|child| matches!(child.content, photocraft_doc::LayerContent::Raster(_)))
                    .map(|child| child.id.0),
                _ => None,
            })
            .expect("画板里应有像素子层")
    };
    session.execute("layer.select", json!({"layer":child_id})).unwrap();
    session.execute("select.rect", json!({"x":12,"y":12,"width":6,"height":6})).unwrap();
    session.execute("edit.fill", json!({"contents":"color","color":"#00ff00"})).unwrap();
    assert_ne!(
        document_content_hash(&session.active().unwrap().doc, &registry).unwrap(),
        hash,
        "画板子层的像素改动必须改变工程内容哈希"
    );
}

#[test]
fn resource_free_styles_light_and_order_roundtrip_without_rendering() {
    let mut session=photocraft_engine::Session::new();
    session.execute("file.new",json!({"width":16,"height":16})).unwrap();
    let registry=AssetRegistry::default();
    let baseline=document_content_hash(&session.active().unwrap().doc,&registry).unwrap();
    for kind in ["dropShadow","innerShadow","outerGlow","innerGlow","stroke","colorOverlay","gradientOverlay","satin","bevelEmboss"] {
        session.execute("layer.layerStyle.clear",Value::Null).unwrap();
        session.execute(&format!("layer.layerStyle.{kind}"),json!({})).unwrap();
        let doc=&session.active().unwrap().doc;
        let hash=document_content_hash(doc,&registry).unwrap_or_else(||panic!("{kind}: {:?}",doc.layers[0].effects));assert_ne!(hash,baseline,"{kind}");
        let bytes=photocraft_format::save_to_bytes(doc,&Default::default()).unwrap();
        photocraft_project_verify::verify(&bytes).unwrap();
        let loaded=photocraft_format::load_from_bytes(&bytes).unwrap();
        assert_eq!(document_content_hash(&loaded,&registry).unwrap(),hash,"{kind}");
    }
    let mut doc=(*session.active().unwrap().doc).clone();
    let hash=document_content_hash(&doc,&registry).unwrap();
    doc.global_light.angle+=1.0;assert_ne!(document_content_hash(&doc,&registry).unwrap(),hash);
    let light_hash=document_content_hash(&doc,&registry).unwrap();
    doc.layers[0].effects.enabled=false;assert_ne!(document_content_hash(&doc,&registry).unwrap(),light_hash);
    session.execute("layer.layerStyle.dropShadow",json!({})).unwrap();
    let mut doc=(*session.active().unwrap().doc).clone();
    let before=document_content_hash(&doc,&registry).unwrap();
    doc.layers[0].effects.items.reverse();assert_ne!(document_content_hash(&doc,&registry).unwrap(),before);
    let group=Layer::group("组",doc.layers.clone());doc.layers=vec![group];
    assert!(project_content(&doc,&registry)["layers"][0]["children"][0]["effects"].is_object());
    doc.layers[0].effects.items=doc.layers[0].children().unwrap()[0].effects.items.clone();
    let item=doc.layers[0].effects.items[0].clone();
    doc.layers[0].effects.items.resize(65,item);
    assert!(document_content_hash(&doc,&registry).is_none());
}

#[test]
fn group_content_tracks_descendants_blend_and_order_without_rendering() {
    let mut doc = document();
    let registry = AssetRegistry { base_asset_id: Some("asset-base".into()), ..Default::default() };
    let pixel = Layer::raster("Background", doc.pixel_format());
    let empty = Layer::group("空组", vec![]);
    doc.layers.push(Layer::group("组", vec![pixel, empty]));
    let content = project_content(&doc, &registry);
    assert_eq!(content["layers"][0]["pixel"]["sourceAssetId"], "asset-base");
    assert_eq!(content["layers"][1]["kind"], "group");
    assert_eq!(content["layers"][1]["blend"], "pass-through");
    assert!(content["layers"][1]["children"][0]["pixel"]["sourceAssetId"].is_null());
    let baseline = document_content_hash(&doc, &registry).unwrap();
    let LayerContent::Group(group) = &mut doc.layers[1].content else { panic!("group") };
    group.expanded = false;
    assert_eq!(document_content_hash(&doc, &registry).unwrap(), baseline);
    let bytes = photocraft_format::save_to_bytes(&doc, &Default::default()).unwrap();
    let loaded = photocraft_format::load_from_bytes(&bytes).unwrap();
    assert_eq!(document_content_hash(&loaded, &registry).unwrap(), baseline);
    let LayerContent::Group(group) = &mut doc.layers[1].content else { panic!("group") };
    group.children[0].opacity = 0.5;
    assert_ne!(document_content_hash(&doc, &registry).unwrap(), baseline);
    let LayerContent::Group(group) = &mut doc.layers[1].content else { panic!("group") };
    group.children[0].opacity = 1.0; group.children.reverse();
    assert_ne!(document_content_hash(&doc, &registry).unwrap(), baseline);
    let LayerContent::Group(group) = &mut doc.layers[1].content else { panic!("group") };
    group.children.reverse(); doc.layers[1].blend = BlendMode::Normal;
    assert_ne!(document_content_hash(&doc, &registry).unwrap(), baseline);
}

#[test]
fn only_clipping_changes_are_content_and_roundtrip_without_compositing() {
    let registry=AssetRegistry::default();let mut doc=document();
    doc.layers.push(Layer::raster("剪贴层",doc.pixel_format()));
    let baseline=document_content_hash(&doc,&registry).unwrap();
    doc.layers[1].clipped=true;
    let hash=document_content_hash(&doc,&registry).unwrap();assert_ne!(hash,baseline);
    assert_eq!(project_content(&doc,&registry)["layers"][1]["clipped"],true);
    let bytes=photocraft_format::save_to_bytes(&doc,&Default::default()).unwrap();
    photocraft_project_verify::verify(&bytes).unwrap();
    let loaded=photocraft_format::load_from_bytes(&bytes).unwrap();
    assert!(loaded.layers[1].clipped);
    assert_eq!(document_content_hash(&loaded,&registry).unwrap(),hash);
    doc.layers[1].clipped=false;assert_eq!(document_content_hash(&doc,&registry).unwrap(),baseline);
}

#[test]
fn only_lock_changes_are_content_and_roundtrip_without_compositing() {
    let registry=AssetRegistry::default();let mut doc=document();
    let baseline=document_content_hash(&doc,&registry).unwrap();
    for key in ["transparency","pixels","position","artboard","all"] {
        doc.layers[0].locks=Default::default();doc.layers[0].locks.set(key,true);
        let hash=document_content_hash(&doc,&registry).unwrap();assert_ne!(hash,baseline);
        let bytes=photocraft_format::save_to_bytes(&doc,&Default::default()).unwrap();
        photocraft_project_verify::verify(&bytes).unwrap();
        let loaded=photocraft_format::load_from_bytes(&bytes).unwrap();
        assert_eq!(loaded.layers[0].locks,doc.layers[0].locks);
        assert_eq!(document_content_hash(&loaded,&registry).unwrap(),hash);
    }
    doc.layers[0].locks=Default::default();assert_eq!(document_content_hash(&doc,&registry).unwrap(),baseline);
}

#[test]
fn content_description_uses_the_contract_shape() {
    let mut doc = document();
    doc.layers.push(Layer::new("曲线", LayerContent::Adjustment(Adjustment::identity_curves())));
    let mut registry = AssetRegistry::default();
    registry.base_asset_id = Some("asset-base".into());
    let content = project_content(&doc, &registry);
    assert_eq!(content["canvasWidth"], 64);
    assert_eq!(content["layers"][0]["kind"], "pixel");
    assert_eq!(content["layers"][0]["pixel"]["sourceAssetId"], "asset-base");
    assert_eq!(content["layers"][1]["kind"], "adjustment");
    assert_eq!(content["layers"][1]["adjustment"]["kind"], "curves");
    assert!(content["layers"][1]["adjustment"]["parameters"]["rgb"].as_array().is_some_and(|p| p.len() == 2));
    assert!(document_content_hash(&doc, &registry).is_some());
}

#[test]
fn identical_documents_hash_identically_and_layer_changes_differ() {
    let mut registry = AssetRegistry::default();
    registry.base_asset_id = Some("asset-base".into());
    let doc = document();
    let first = document_content_hash(&doc, &registry).expect("指纹");
    assert_eq!(Some(first.clone()), document_content_hash(&doc, &registry));
    let mut changed = doc.clone();
    changed.layers.push(Layer::raster("另一个", changed.pixel_format()));
    assert_ne!(Some(first), document_content_hash(&changed, &registry));
}

#[test]
fn blend_and_visibility_changes_are_content_changes() {
    let mut registry = AssetRegistry::default();
    registry.base_asset_id = Some("asset-base".into());
    let doc = document();
    let base = document_content_hash(&doc, &registry).expect("指纹");
    let mut blended = doc.clone();
    blended.layers[0].blend = BlendMode::Multiply;
    assert_ne!(Some(base.clone()), document_content_hash(&blended, &registry));
    let mut hidden = doc.clone();
    hidden.layers[0].visible = false;
    assert_ne!(Some(base), document_content_hash(&hidden, &registry));
}

#[test]
fn small_pixel_and_mask_edits_change_the_hash_and_restoring_pixels_clears_it() {
    let doc = document();
    let mut surface = photocraft_doc::Surface::new(doc.pixel_format());
    let original = surface_hash(&surface);
    // 旧 64×64 采样会漏过大画布上的这个单像素。
    surface.fill_rect(Rect::new(1, 1, 2, 2), &[1.0, 0.0, 0.0, 1.0]);
    assert_ne!(surface_hash(&surface), original);
    surface.fill_rect(Rect::new(1, 1, 2, 2), &[0.0, 0.0, 0.0, 0.0]);
    assert_eq!(surface_hash(&surface), original);
    // 画布外仍是工程内容，不能在平移进画布前被漏判。
    surface.fill_rect(Rect::new(-2, -2, -1, -1), &[1.0, 0.0, 0.0, 1.0]);
    assert_ne!(surface_hash(&surface), original);
    let mut mask = photocraft_doc::LayerMask::reveal_all().surface;
    let revealed = surface_hash(&mask);
    mask.fill_rect(Rect::new(1, 1, 2, 2), &[0.0]);
    assert_ne!(surface_hash(&mask), revealed);
    mask.fill_rect(Rect::new(1, 1, 2, 2), &[1.0]);
    assert_eq!(surface_hash(&mask), revealed);
    // 仅分配默认 tile 不产生净变化。
    mask.tile_mut(TileCoord { tx: 2, ty: 2 });
    assert_eq!(surface_hash(&mask), revealed);
}

#[test]
fn cached_tiles_follow_copy_on_write_and_roundtrip_without_rendering() {
    let mut doc = document();
    let registry = AssetRegistry::default();
    let original = document_content_hash(&doc, &registry).expect("有效内容");
    if let LayerContent::Raster(surface) = &mut doc.layers[0].content {
        surface.fill_rect(Rect::new(1, 1, 2, 2), &[1.0, 0.0, 0.0, 1.0]);
    }
    let painted = document_content_hash(&doc, &registry).expect("有效内容");
    assert_ne!(painted, original);
    assert_eq!(document_content_hash(&doc, &registry), Some(painted.clone()));
    let snapshot = doc.clone();
    if let LayerContent::Raster(surface) = &mut doc.layers[0].content {
        surface.fill_rect(Rect::new(1, 1, 2, 2), &[0.0, 0.0, 0.0, 0.0]);
    }
    assert_eq!(document_content_hash(&doc, &registry), Some(original));
    assert_eq!(document_content_hash(&snapshot, &registry), Some(painted.clone()));
    // 不生成预览、不绘制，仅检查工程序列化后的像素内容指纹。
    let bytes = photocraft_format::save_to_bytes(&snapshot, &Default::default()).expect("工程编码");
    let reopened = photocraft_format::load_from_bytes(&bytes).expect("工程解码");
    assert_eq!(document_content_hash(&reopened, &registry), Some(painted));
}

#[test]
fn faux_bold_is_a_content_change_without_rasterizing_text() {
    let mut doc = document();
    let text = photocraft_doc::TextLayer {
        text: "文字".into(),
        font_family: "Inter".into(),
        runs: vec![photocraft_doc::text::TextRun { len: 6, style: Default::default() }],
        ..Default::default()
    };
    doc.layers.push(Layer::new("文字", LayerContent::Text(text)));
    let registry = AssetRegistry::default();
    let original = document_content_hash(&doc, &registry).expect("有效文字内容");
    if let LayerContent::Text(text) = &mut doc.layers[1].content {
        text.runs[0].style.faux_bold = true;
    }
    assert_ne!(document_content_hash(&doc, &registry), Some(original));
    assert_eq!(project_content(&doc, &registry)["layers"][1]["text"]["bold"], true);
}

#[test]
fn placed_layers_keep_provenance_out_of_the_content_hash() {
    // 置入来源只上报给宿主（`asset_ids`），不进入内容指纹：否则重开后无法重建映射，
    // 同一冻结文档会被误判为有净变化。
    let mut doc = document();
    let placed = Layer::raster("置入", doc.pixel_format());
    let id = placed.id;
    doc.layers.push(placed);
    let mut registry = AssetRegistry::default();
    registry.base_asset_id = Some("asset-base".into());
    registry.register_placed(id, "asset-placed");
    let content = project_content(&doc, &registry);
    assert_eq!(content["layers"][0]["pixel"]["sourceAssetId"], "asset-base");
    assert_eq!(content["layers"][1]["pixel"]["sourceAssetId"], serde_json::Value::Null);

    // 同一文档在「登记了置入来源」与「未登记」两种状态下指纹一致。
    let bare = AssetRegistry { base_asset_id: Some("asset-base".into()), ..Default::default() };
    assert_eq!(document_content_hash(&doc, &registry), document_content_hash(&doc, &bare));
}

#[test]
fn mask_links_survive_project_roundtrip_without_rendering() {
    let mut doc=document();
    doc.layers[0].mask=Some(photocraft_doc::LayerMask{linked:false,..photocraft_doc::LayerMask::reveal_all()});
    let registry=AssetRegistry::default();
    let before=document_content_hash(&doc,&registry);
    let bytes=photocraft_format::save_to_bytes(&doc,&Default::default()).expect("不附带预览的工程编码");
    let reopened=photocraft_format::load_from_bytes(&bytes).expect("工程解码");
    assert!(!reopened.layers[0].mask.as_ref().expect("蒙版").linked);
    assert_eq!(document_content_hash(&reopened,&registry),before);
    doc.layers[0].mask.as_mut().expect("蒙版").linked=true;
    assert_ne!(document_content_hash(&doc,&registry),before);
}

/// 时间轴/视频帧进入 `documentContentHash`，且真实保存→重开后指纹不变（B2 的验收点）。
#[test]
fn timeline_and_video_frames_join_the_document_content_hash() {
    let registry = AssetRegistry::default();
    let mut doc = document();
    let baseline = document_content_hash(&doc, &registry).expect("普通文档指纹");
    // 普通文档不追加 `animation` 字段，指纹与既有基线一致。
    assert!(project_content(&doc, &registry).get("animation").is_none());

    // 建时间轴：帧率/时长是内容，指纹必须改变。
    doc.timeline = Some(photocraft_doc::Timeline::new(3, 24.0));
    let with_timeline = document_content_hash(&doc, &registry).expect("带时间轴的文档指纹");
    assert_ne!(with_timeline, baseline, "时间轴必须进入内容身份");
    assert!(project_content(&doc, &registry)["animation"]["timeline"]["fps"].is_number());

    // 播放头与工作区范围是会话视图：不改变指纹。
    doc.timeline.as_mut().unwrap().current = 2;
    doc.timeline.as_mut().unwrap().work_start = 1;
    doc.timeline.as_mut().unwrap().work_end = 3;
    assert_eq!(document_content_hash(&doc, &registry).expect("指纹"), with_timeline, "播放头/工作区不是内容");

    // 改帧率是内容变化。
    doc.timeline.as_mut().unwrap().fps = 30.0;
    let at_30 = document_content_hash(&doc, &registry).expect("指纹");
    assert_ne!(at_30, with_timeline, "帧率属于内容");
    doc.timeline.as_mut().unwrap().fps = 24.0;
    assert_eq!(document_content_hash(&doc, &registry).expect("指纹"), with_timeline, "改回原值回到原指纹");

    // 视频层：帧数、帧像素与顺序都是内容。
    let format = doc.pixel_format();
    let mut frame_a = photocraft_doc::Surface::new(format);
    frame_a.write_pixel(1, 1, &[1.0, 0.0, 0.0, 1.0]);
    let frame_b = photocraft_doc::Surface::new(format);
    let mut layer = Layer::raster("视频", format);
    layer.video = Some(photocraft_doc::VideoData::new(vec![frame_a.clone(), frame_b.clone()], 24.0));
    doc.layers.push(layer);
    let with_video = document_content_hash(&doc, &registry).expect("带视频层的文档指纹");
    assert_ne!(with_video, with_timeline, "视频帧必须进入内容身份");

    // 真实容器往返：重开后指纹逐字节不变（图层 id 不进摘要）。
    let bytes = photocraft_format::save_to_bytes(&doc, &Default::default()).expect("保存带视频层的工程");
    let reopened = photocraft_format::load_from_bytes(&bytes).expect("重开工程");
    assert_eq!(
        document_content_hash(&reopened, &registry).expect("重开后指纹"),
        with_video,
        "重开不得改变内容身份（摘要不能含图层 id）"
    );

    // 换帧顺序与换帧像素都改变指纹。
    let mut reordered = reopened.clone();
    reordered.layers.last_mut().unwrap().video.as_mut().unwrap().frames = vec![frame_b, frame_a];
    assert_ne!(document_content_hash(&reordered, &registry).expect("指纹"), with_video, "帧顺序是内容");
    let mut repainted = reopened.clone();
    repainted.layers.last_mut().unwrap().video.as_mut().unwrap().frames[1].write_pixel(2, 2, &[0.0, 1.0, 0.0, 1.0]);
    assert_ne!(document_content_hash(&repainted, &registry).expect("指纹"), with_video, "帧像素是内容");

    // 删掉时间轴与视频层，指纹回到普通文档基线（纯函数，不残留）。
    let mut cleared = reopened;
    cleared.layers.pop();
    cleared.timeline = None;
    assert_eq!(document_content_hash(&cleared, &registry).expect("指纹"), baseline);
}

/// 视频层的显示内容是播放头处的投影：**拖动播放头不得改变内容身份**，但未写回的编辑仍算内容。
///
/// 这是「播放位置是会话态」在共享指纹上的落地。上游会把播放头处的帧同步成图层显示内容
/// （`video_cmds::sync`），若显示内容直接参与像素身份，仅拖播放头就会让宿主把工程判成已修改。
#[test]
fn playhead_does_not_leak_into_content_identity_but_unflushed_edits_do() {
    let registry = AssetRegistry::default();
    let format = document().pixel_format();
    let mut first = photocraft_doc::Surface::new(format);
    first.write_pixel(1, 1, &[1.0, 0.0, 0.0, 1.0]);
    let mut second = photocraft_doc::Surface::new(format);
    second.write_pixel(2, 2, &[0.0, 1.0, 0.0, 1.0]);

    let mut doc = document();
    let mut layer = Layer::raster("视频", format);
    layer.video = Some(photocraft_doc::VideoData::new(vec![first.clone(), second.clone()], 24.0));
    layer.content = photocraft_doc::LayerContent::Raster(first.clone());
    doc.layers.push(layer);
    doc.timeline = Some(photocraft_doc::Timeline::new(2, 24.0));

    let at_frame_0 = document_content_hash(&doc, &registry).expect("带视频层的指纹");

    // 把播放头移到第 1 帧，显示内容同步成第 1 帧（上游 `sync` 的语义）。
    doc.timeline.as_mut().unwrap().current = 1;
    doc.layers.last_mut().unwrap().content = photocraft_doc::LayerContent::Raster(second.clone());
    let at_frame_1 = document_content_hash(&doc, &registry).expect("带视频层的指纹");
    assert_eq!(at_frame_1, at_frame_0, "拖动播放头不得改变内容身份");

    // 回到第 0 帧同样不变；有未写回的编辑（显示内容与帧栈不一致）仍必须改变身份。
    doc.timeline.as_mut().unwrap().current = 0;
    doc.layers.last_mut().unwrap().content = photocraft_doc::LayerContent::Raster(first.clone());
    assert_eq!(document_content_hash(&doc, &registry).expect("指纹"), at_frame_0);

    let mut dirty = photocraft_doc::Surface::new(format);
    dirty.write_pixel(3, 3, &[0.0, 0.0, 1.0, 1.0]);
    doc.layers.last_mut().unwrap().content = photocraft_doc::LayerContent::Raster(dirty);
    assert_ne!(
        document_content_hash(&doc, &registry).expect("指纹"),
        at_frame_0,
        "尚未写回的绘画编辑必须被算作内容变化（否则保存时会被宿主当作无变化而丢掉）"
    );
}

/// 文档级路径（已存/工作/裁切）是持久内容：写入 → 保存 → 重开必须得到同一指纹
/// （change: 2026-10-22-add-photocraft-vector-canvas-tools，任务 3.2）。
#[test]
fn document_paths_are_persistent_content_identity() {
    use photocraft_doc::vector::{ClippingPath, NamedPath, Path, Subpath};

    let mut doc = document();
    let registry = AssetRegistry::default();
    let baseline = document_content_hash(&doc, &registry).expect("基线");
    let content = project_content(&doc, &registry);
    assert!(content.get("paths").is_none(), "没有路径时不得出现 paths 字段（旧工程兼容）");
    assert!(content.get("workPath").is_none());
    assert!(content.get("clippingPath").is_none());

    let square = |offset: f64| {
        Path::new(vec![Subpath::polygon(&[
            (offset, offset),
            (offset + 8.0, offset),
            (offset + 8.0, offset + 8.0),
        ])])
    };
    doc.paths.push(NamedPath { name: "剪裁".into(), path: square(2.0), psd_raw: None });
    doc.paths.push(NamedPath { name: "A".into(), path: square(0.0), psd_raw: None });
    doc.work_path = Some(Path::new(vec![Subpath::polyline(&[(0.0, 0.0), (4.0, 4.0)])]));
    doc.clipping_path = Some(ClippingPath { name: "剪裁".into(), flatness: 2.0 });

    let hash = document_content_hash(&doc, &registry).expect("有路径时可判定");
    assert_ne!(hash, baseline, "路径是持久字段，必须进入内容身份");

    // 保存 → 重开：同一份文档的指纹必须逐字相等。
    let bytes = photocraft_format::save_to_bytes(&doc, &Default::default()).expect("编码");
    photocraft_project_verify::verify(&bytes).expect("核验");
    let reopened = photocraft_format::load_from_bytes(&bytes).expect("解码");
    assert_eq!(reopened.paths.len(), 2);
    assert_eq!(document_content_hash(&reopened, &registry).as_deref(), Some(hash.as_str()));

    // 只改一条已存路径的几何 → 指纹必须变（否则宿主会误判成无净变化）。
    let mut edited = reopened.clone();
    edited.paths[0].path = square(20.0);
    assert_ne!(document_content_hash(&edited, &registry).as_deref(), Some(hash.as_str()));

    // 已存路径顺序不影响指纹（加载顺序不是内容）。
    let mut reordered = reopened.clone();
    reordered.paths.reverse();
    assert_eq!(document_content_hash(&reordered, &registry).as_deref(), Some(hash.as_str()));

    // 工作路径与裁切平直度同样是内容。
    let mut moved_work = reopened.clone();
    moved_work.work_path = Some(Path::new(vec![Subpath::polyline(&[(0.0, 0.0), (9.0, 9.0)])]));
    assert_ne!(document_content_hash(&moved_work, &registry).as_deref(), Some(hash.as_str()));
    let mut flatter = reopened.clone();
    flatter.clipping_path.as_mut().expect("裁切路径").flatness = 0.5;
    assert_ne!(document_content_hash(&flatter, &registry).as_deref(), Some(hash.as_str()));

    // 清空后回到旧工程指纹：不留下「曾经有路径」的痕迹。
    let mut cleared = reopened;
    cleared.paths.clear();
    cleared.work_path = None;
    cleared.clipping_path = None;
    assert_eq!(document_content_hash(&cleared, &registry).as_deref(), Some(baseline.as_str()));
}

/// 形状层的填充/描边/规范参数与矢量蒙版的密度/羽化都是**持久字段**（保存重开后逐字段还原）。
///
/// 只把路径几何算进内容身份时，「只改描边宽度」「把填充改成无填充」「调蒙版浓度」都会让
/// 工程字节变化而归一化指纹不变，宿主据此判成「无净变化」而丢工作
/// （change: 2026-10-22-add-photocraft-vector-canvas-tools，任务 3.2）。
#[test]
fn shape_appearance_and_mask_density_are_persistent_content_identity() {
    use photocraft_doc::vector::{LiveShape, Path, ShapeLayer, ShapeStroke, StrokeAlign, Subpath, VectorMask};
    use photocraft_doc::{Fill, LayerContent};

    let mut doc = document();
    let registry = AssetRegistry::default();
    let path = Path::new(vec![Subpath::polygon(&[(4.0, 4.0), (40.0, 4.0), (40.0, 30.0)])]);
    let shape = ShapeLayer {
        path: path.clone(),
        fill: Some(Fill::Solid(photocraft_color::Color::rgba(0.2, 0.4, 0.8, 1.0))),
        stroke: None,
        live: Some(LiveShape::Rect { rect: [4.0, 4.0, 36.0, 26.0], radii: [2.0; 4] }),
        cache: None,
        psd_raw: None,
    };
    doc.layers.push(Layer { content: LayerContent::Shape(shape.clone()), ..Layer::raster("形状", doc.pixel_format()) });
    let baseline = document_content_hash(&doc, &registry).expect("形状层基线");
    // 旧内容描述（没有 appearanceHash）仍按几何比较：字段是可选的，旧工程指纹不变。
    let content = project_content(&doc, &registry);
    assert!(content["layers"][1]["shape"]["appearanceHash"].is_string());
    assert_eq!(
        crate::identity::content_hash(&content).as_deref(),
        Some(baseline.as_str()),
        "内核内容描述与规范化必须自洽"
    );

    // 路径几何不变、只改填充色 → 指纹必须变。
    let set_fill = |doc: &mut Document, fill: Option<Fill>| {
        let LayerContent::Shape(shape) = &mut doc.layers[1].content else { panic!("形状层") };
        shape.fill = fill;
    };
    let mut recolored = doc.clone();
    set_fill(&mut recolored, Some(Fill::Solid(photocraft_color::Color::rgba(0.9, 0.1, 0.1, 1.0))));
    assert_ne!(document_content_hash(&recolored, &registry).as_deref(), Some(baseline.as_str()), "改填充色必须改变指纹");

    // 去掉填充（改成「无」）也是内容变化。
    let mut unfilled = doc.clone();
    set_fill(&mut unfilled, None);
    assert_ne!(document_content_hash(&unfilled, &registry).as_deref(), Some(baseline.as_str()), "去掉填充必须改变指纹");

    // 加描边、改线宽、改线帽/拐角/虚线/对齐/颜色都改变指纹。
    let stroke = |width: f32, cap: photocraft_doc::vector::LineCap, align: StrokeAlign| ShapeStroke {
        width,
        paint: Fill::Solid(photocraft_color::Color::rgba(0.0, 0.0, 0.0, 1.0)),
        opacity: 1.0,
        align,
        cap,
        join: photocraft_doc::vector::LineJoin::Bevel,
        miter_limit: 100.0,
        dashes: vec![4.0, 2.0],
        dash_offset: 1.0,
    };
    let set_stroke = |doc: &mut Document, value: Option<ShapeStroke>| {
        let LayerContent::Shape(shape) = &mut doc.layers[1].content else { panic!("形状层") };
        shape.stroke = value;
    };
    let mut stroked = doc.clone();
    set_stroke(&mut stroked, Some(stroke(4.0, photocraft_doc::vector::LineCap::Round, StrokeAlign::Inside)));
    let stroke_hash = document_content_hash(&stroked, &registry).expect("有描边");
    assert_ne!(stroke_hash, baseline, "加描边必须改变指纹");
    let mut wider = stroked.clone();
    set_stroke(&mut wider, Some(stroke(9.0, photocraft_doc::vector::LineCap::Round, StrokeAlign::Inside)));
    assert_ne!(document_content_hash(&wider, &registry).unwrap(), stroke_hash, "只改线宽必须改变指纹");
    let mut square_cap = stroked.clone();
    set_stroke(&mut square_cap, Some(stroke(4.0, photocraft_doc::vector::LineCap::Square, StrokeAlign::Inside)));
    assert_ne!(document_content_hash(&square_cap, &registry).unwrap(), stroke_hash, "只改线帽必须改变指纹");

    // 规范参数（圆角）改变外观与后续可编辑性，必须参与指纹。
    let mut rounded = doc.clone();
    let LayerContent::Shape(shape) = &mut rounded.layers[1].content else { panic!("形状层") };
    shape.live = Some(LiveShape::Rect { rect: [4.0, 4.0, 36.0, 26.0], radii: [8.0; 4] });
    assert_ne!(document_content_hash(&rounded, &registry).as_deref(), Some(baseline.as_str()), "只改圆角必须改变指纹");

    // 保存 → 重开：同一份形状层指纹逐字相等（外观字段确实写进了工程）。
    let bytes = photocraft_format::save_to_bytes(&stroked, &Default::default()).expect("编码");
    photocraft_project_verify::verify(&bytes).expect("核验");
    let reopened = photocraft_format::load_from_bytes(&bytes).expect("解码");
    assert_eq!(document_content_hash(&reopened, &registry).as_deref(), Some(stroke_hash.as_str()));

    // 矢量蒙版：只改密度/羽化（路径几何不变）也必须改变指纹。
    let mut masked = document();
    masked.layers.push(Layer::raster("蒙版层", masked.pixel_format()));
    masked.layers[1].vector_mask = Some(VectorMask { path: path.clone(), enabled: true, linked: true, density: 1.0, feather: 0.0 });
    let mask_hash = document_content_hash(&masked, &registry).expect("有蒙版");
    let mut thin = masked.clone();
    thin.layers[1].vector_mask.as_mut().expect("蒙版").density = 0.4;
    assert_ne!(document_content_hash(&thin, &registry).unwrap(), mask_hash, "只改蒙版密度必须改变指纹");
    let mut feathered = masked.clone();
    feathered.layers[1].vector_mask.as_mut().expect("蒙版").feather = 6.0;
    assert_ne!(document_content_hash(&feathered, &registry).unwrap(), mask_hash, "只改羽化必须改变指纹");

    // 蒙版密度/羽化同样保存重开稳定。
    let bytes = photocraft_format::save_to_bytes(&feathered, &Default::default()).expect("编码");
    let reopened = photocraft_format::load_from_bytes(&bytes).expect("解码");
    assert_eq!(
        document_content_hash(&reopened, &registry).unwrap(),
        document_content_hash(&feathered, &registry).unwrap()
    );
}
