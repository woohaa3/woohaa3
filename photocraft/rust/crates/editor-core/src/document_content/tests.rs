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
