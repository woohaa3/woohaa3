use super::*;
use photocraft_geom::Rect;

#[test]
fn region_preview_rejection_preserves_the_document_and_uses_the_same_draft() {
    let mut editor=Editor::new();
    assert_eq!(editor.render_region(json!({"x":0,"y":0,"width":1,"height":1})),Err(EditorError::NoDocument));
    editor.execute("file.new",json!({"width":8000,"height":6000})).unwrap();
    editor.execute("layer.new.layer",json!({})).unwrap();
    let id=editor.active_layer_id().unwrap();
    let before=editor.state();let hash=editor.content_hash().unwrap();
    editor.begin_layer_properties(id.0).unwrap();
    editor.preview_layer_properties(json!({"opacity":0.4})).unwrap();
    // 只检查快照来源与参数拒绝，不运行合成器或读取有效像素。
    assert_eq!(editor.preview_document().unwrap().layer(id).unwrap().opacity,0.4);
    assert_eq!(editor.active_doc().unwrap().doc.layer(id).unwrap().opacity,1.0);
    for params in [json!({"x":8000,"y":0,"width":1,"height":1}),json!({"x":0,"y":0,"width":8000,"height":6000}),json!({"x":-1,"y":0,"width":1,"height":1})] {
        assert!(matches!(editor.render_region(params),Err(EditorError::RenderFailed(_))));
        assert_eq!(editor.state(),before);assert_eq!(editor.content_hash().unwrap(),hash);
    }
    editor.cancel_layer_properties();
    assert_eq!(editor.preview_document().unwrap().layer(id).unwrap().opacity,1.0);
    editor.close();
    assert_eq!(editor.render_region(json!({"x":0,"y":0,"width":1,"height":1})),Err(EditorError::NoDocument));
}

#[test]
fn frame_projection_uses_the_selection_not_only_occupied_content() {
    let mut editor = Editor::new();
    editor.execute("file.new", json!({"width":100,"height":80})).unwrap();
    editor.execute("layer.new.layer", json!({"name":"几何样本"})).unwrap();
    let state = editor.session.active_mut().unwrap();
    let id = state.active_layer.unwrap();
    // 直接构造稀疏数据样本；不运行笔刷、合成器或图像输出。
    std::sync::Arc::make_mut(&mut state.doc).layer_mut(id).unwrap().surface_mut().unwrap()
        .fill_rect(Rect::new(10, 10, 30, 20), &[1.0, 0.0, 0.0, 1.0]);
    assert_eq!(editor.state()["document"]["transformFrame"], json!([10,10,30,20]));
    editor.execute("select.rect", json!({"x":5,"y":5,"width":15,"height":40})).unwrap();
    assert_eq!(editor.state()["document"]["transformFrame"], json!([5,5,20,45]));
    editor.execute("select.rect", json!({"x":60,"y":60,"width":10,"height":10})).unwrap();
    assert!(editor.state()["document"]["transformFrame"].is_null());
    editor.execute("select.deselect", Value::Null).unwrap();
    editor.execute("layer.new.layer", json!({})).unwrap();
    assert!(editor.state()["document"]["transformFrame"].is_null());
}

#[test]
fn purge_clipboard_all_and_multi_document_histories_do_not_touch_content() {
    let mut editor=Editor::new();editor.execute("file.new",json!({"width":16,"height":16})).unwrap();
    editor.execute("layer.new.layer",json!({"name":"A"})).unwrap();
    editor.execute("file.new",json!({"width":16,"height":16})).unwrap();
    editor.execute("layer.new.layer",json!({"name":"B"})).unwrap();
    editor.session.style_clipboard=Some((Default::default(),photocraft_doc::BlendMode::Normal,1.0,Default::default()));
    let docs:Vec<_>=editor.session.documents().iter().map(|state|state.doc.clone()).collect();
    let hash=editor.content_hash().unwrap();
    assert_eq!(editor.commands().as_array().unwrap().iter().find(|c|c["id"]=="edit.purge.clipboard").unwrap()["enabled"],true);
    editor.execute("edit.purge.clipboard",Value::Null).unwrap();assert!(editor.session.style_clipboard.is_none());
    assert_eq!(editor.content_hash().unwrap(),hash);
    editor.session.style_clipboard=Some((Default::default(),photocraft_doc::BlendMode::Normal,1.0,Default::default()));
    editor.execute("edit.purge.all",Value::Null).unwrap();
    assert!(editor.session.style_clipboard.is_none());
    for (state,doc) in editor.session.documents().iter().zip(docs) {
        assert_eq!(state.doc,doc);assert!(!state.history.can_undo());assert!(!state.history.can_redo());assert!(state.coalesce.is_none());
    }
    assert_eq!(editor.content_hash().unwrap(),hash);
}


#[test]
fn text_save_checkpoint_rebases_without_ending_input_or_rendering() {
    use photocraft_doc::{Layer,LayerContent,TextLayer};
    let mut editor=Editor::new();editor.execute("file.new",json!({"width":100,"height":100})).unwrap();
    let layer=Layer::new("Title",LayerContent::Text(TextLayer{text:"before".into(),font_family:"Inter".into(),..Default::default()}));let id=layer.id;
    std::sync::Arc::make_mut(&mut editor.session.active_mut().unwrap().doc).layers.push(layer);
    editor.begin_text(json!({"layer":id.0})).unwrap();
    let before=editor.state();let hash=editor.content_hash().unwrap();
    {
        let draft=editor.text_preview.as_mut().unwrap();
        let LayerContent::Text(text)=&mut std::sync::Arc::make_mut(&mut draft.doc).layer_mut(id).unwrap().content else {panic!()};text.text="saved checkpoint".into();
    }
    assert!(editor.require_export_ready().is_err());assert_eq!(editor.state(),before);assert_eq!(editor.content_hash().unwrap(),hash);
    let info=editor.checkpoint_text().unwrap();assert_eq!(info["text"],"saved checkpoint");assert!(editor.text_preview.is_some());
    assert!(editor.require_export_ready().is_ok());let saved=editor.state();let saved_hash=editor.content_hash().unwrap();assert_ne!(saved_hash,hash);
    editor.checkpoint_text().unwrap();assert_eq!(editor.state(),saved);assert_eq!(editor.content_hash().unwrap(),saved_hash);
    {
        let draft=editor.text_preview.as_mut().unwrap();
        let LayerContent::Text(text)=&mut std::sync::Arc::make_mut(&mut draft.doc).layer_mut(id).unwrap().content else {panic!()};text.text="after checkpoint".into();
    }
    assert!(editor.require_export_ready().is_err());editor.cancel_text();assert_eq!(editor.state(),saved);assert_eq!(editor.content_hash().unwrap(),saved_hash);
    editor.execute("edit.undo",Value::Null).unwrap();assert_eq!(editor.content_hash().unwrap(),hash);
    editor.execute("edit.redo",Value::Null).unwrap();assert_eq!(editor.content_hash().unwrap(),saved_hash);
    editor.begin_text(json!({"layer":id.0})).unwrap();
    assert!(editor.preview_text(json!({"text":7})).is_err());let before=editor.state();
    assert!(editor.checkpoint_text().is_err());assert!(editor.require_export_ready().is_err());assert_eq!(editor.state(),before);
}

#[test]
fn history_limit_is_local_trims_without_content_changes_and_gates_drafts() {
    let mut editor=Editor::new();editor.execute("file.new",json!({"width":16,"height":12})).unwrap();
    for name in ["甲","乙","丙","丁"] {editor.execute("layer.new.layer",json!({"name":name})).unwrap();}
    let before=editor.state();let hash=editor.content_hash().unwrap();
    for limit in [0,1001] {assert!(editor.set_history_limit(limit).is_err());}
    editor.set_history_limit(2).unwrap();let after=editor.state();
    assert_eq!(editor.content_hash().unwrap(),hash);assert_eq!(after["document"]["revision"],before["document"]["revision"]);
    assert_eq!(editor.session.active().unwrap().history.max_states,2);
    editor.execute("layer.new.layer",json!({"name":"达到新上限"})).unwrap();assert!(editor.session.active().unwrap().history.past_len()<=2);
    editor.execute("file.new",json!({"width":10,"height":10})).unwrap();assert_eq!(editor.session.active().unwrap().history.max_states,2);
    editor.begin_text(json!({"x":1,"y":1,"forceNew":true})).unwrap();assert!(editor.set_history_limit(3).is_err());editor.cancel_text();
    editor.set_history_limit(1000).unwrap();assert_eq!(editor.session.active().unwrap().history.max_states,1000);
}

#[test]
fn image_rotation_candidate_is_cancelable_atomic_and_gates_invalid_updates() {
    let mut editor=Editor::new();editor.execute("file.new",json!({"width":12,"height":8})).unwrap();
    let before=editor.state();let hash=editor.content_hash().unwrap();
    editor.begin_image_rotation().unwrap();editor.preview_image_rotation(json!({"angle":90,"direction":"ccw"})).unwrap();
    assert_eq!(editor.state(),before);assert_eq!(editor.content_hash().unwrap(),hash);assert_eq!(editor.preview_document().unwrap().size,photocraft_doc::Size::new(8,12));
    assert!(editor.execute("layer.new.layer",Value::Null).is_err());assert!(editor.export_bundle().is_err());
    assert!(editor.preview_image_rotation(json!({"angle":"bad"})).is_err());assert!(editor.commit_image_rotation().is_err());assert_eq!(editor.state(),before);
    editor.cancel_image_rotation();assert_eq!(editor.state(),before);
    editor.begin_image_rotation().unwrap();editor.preview_image_rotation(json!({"angle":180})).unwrap();editor.preview_image_rotation(json!({"angle":90})).unwrap();editor.commit_image_rotation().unwrap();
    assert_eq!(editor.state()["document"]["history"].as_array().unwrap().len(),before["document"]["history"].as_array().unwrap().len()+1);
    editor.undo().unwrap();assert_eq!(editor.content_hash().unwrap(),hash);editor.redo().unwrap();
    editor.begin_image_rotation().unwrap();editor.preview_image_rotation(json!({"angle":360})).unwrap();let state=editor.state();editor.commit_image_rotation().unwrap();assert_eq!(editor.state(),state);
}

#[test]
fn pencil_auto_erase_uses_host_colors_and_commits_the_same_candidate() {
 let mut editor=Editor::new();editor.execute("file.new",json!({"width":16,"height":16})).unwrap();
 let params=json!({"strokeCommand":"paint.pencil","points":[[4,4]],"size":1,"color":"#ff0000","backgroundColor":"#00ff00","smoothing":0,"autoErase":true});
 let before=editor.state();let hash=editor.content_hash().unwrap();let tools=editor.session.tools.clone();
 editor.begin_stroke(params.clone()).unwrap();assert_eq!(editor.state(),before);assert_eq!(editor.content_hash().unwrap(),hash);
 assert_eq!(editor.preview_document().unwrap().layers[0].surface().unwrap().rgba(4,4),[1.,0.,0.,1.]);
 let candidate=editor.preview_document().unwrap().clone();editor.commit_stroke().unwrap();assert_eq!(*editor.active_doc().unwrap().doc,candidate);assert_eq!(editor.session.tools.background,tools.background);
 let base=editor.active_doc().unwrap().clone();editor.begin_stroke(params.clone()).unwrap();assert_eq!(editor.preview_document().unwrap().layers[0].surface().unwrap().rgba(4,4),[0.,1.,0.,1.]);assert_eq!(editor.active_doc().unwrap().doc,base.doc);
 let candidate=editor.preview_document().unwrap().clone();editor.commit_stroke().unwrap();assert_eq!(*editor.active_doc().unwrap().doc,candidate);assert_eq!(editor.active_doc().unwrap().history.past_len(),base.history.past_len()+1);
 editor.undo().unwrap();assert_eq!(editor.active_doc().unwrap().doc,base.doc);editor.begin_stroke(params).unwrap();editor.cancel_stroke();assert_eq!(editor.active_doc().unwrap().doc,base.doc);
 for params in [json!({"strokeCommand":"paint.gradient"}),json!({"strokeCommand":false}),json!({"points":[[4,4]],"backgroundColor":"#bad"}),json!({"points":[[4,4]],"autoErase":1})]{assert!(editor.begin_stroke(params).is_err());assert_eq!(editor.active_doc().unwrap().doc,base.doc);}
}
#[test]
fn pencil_block_eraser_has_zoom_sized_square_without_rendering() {
 let mut editor=Editor::new();editor.execute("file.new",json!({"width":32,"height":32})).unwrap();editor.execute("layer.new.layer",Value::Null).unwrap();
 let state=editor.session.active_mut().unwrap();let doc=std::sync::Arc::make_mut(&mut state.doc);let id=state.active_layer.unwrap();let bounds=doc.bounds();doc.layer_mut(id).unwrap().surface_mut().unwrap().fill_rect(bounds,&[1.,0.,0.,1.]);
 let before=editor.content_hash().unwrap();editor.begin_stroke(json!({"strokeCommand":"paint.pencil","points":[[16,16]],"block":true,"erase":true,"size":1,"opacity":0.1,"zoom":2})).unwrap();
 let candidate=editor.preview_document().unwrap().clone();let surface=candidate.layer(id).unwrap().surface().unwrap();assert_eq!(surface.sample_channel(16,16,3),0.);assert_eq!(surface.sample_channel(8,8,3),1.);
 assert_eq!(editor.content_hash().unwrap(),before);editor.commit_stroke().unwrap();assert_eq!(*editor.active_doc().unwrap().doc,candidate);editor.undo().unwrap();assert_eq!(editor.content_hash().unwrap(),before);
}

#[test]
fn pencil_same_pixel_fractional_tip_and_appended_object_samples_snap_identically() {
 let mut editor=Editor::new();editor.execute("file.new",json!({"width":8,"height":8})).unwrap();
 for point in [json!([2.1,2.1]),json!([2.9,2.9]),json!({"x":2.8,"y":2.4,"pressure":1})] {
  editor.begin_stroke(json!({"strokeCommand":"paint.pencil","points":[point],"size":1,"color":"#ff0000","smoothing":0})).unwrap();
  let original=editor.preview_document().unwrap().clone();
  editor.append_stroke(json!({"points":[{"x":2.7,"y":2.8,"pressure":1}]})).unwrap();
  assert_eq!(*editor.preview_document().unwrap(),original);
  assert_eq!(original.layers[0].surface().unwrap().rgba(2,2),[1.,0.,0.,1.]);assert_eq!(original.layers[0].surface().unwrap().rgba(3,3),editor.active_doc().unwrap().doc.layers[0].surface().unwrap().rgba(3,3));
  editor.cancel_stroke();
 }
}

#[test]
fn painting_symmetry_live_pencil_mirrors_and_commits_once_without_dirtying_the_aid() {
 let mut e=Editor::new();e.execute("file.new",json!({"width":12,"height":12})).unwrap();let base=e.content_hash().unwrap();let revision=e.revision().unwrap();let history=e.active_doc().unwrap().history.past_len();
 e.execute("paint.setSymmetry",json!({"mode":"dual"})).unwrap();assert_eq!(e.content_hash().unwrap(),base);assert_eq!(e.revision().unwrap(),revision);assert_eq!(e.active_doc().unwrap().history.past_len(),history);
 assert_eq!(e.state()["document"]["paintingSymmetry"]["segments"].as_array().unwrap().len(),2);
 e.begin_stroke(json!({"strokeCommand":"paint.pencil","points":[[2.7,3.8]],"size":1,"color":"#ff0000","smoothing":0})).unwrap();let candidate=e.preview_document().unwrap().clone();
 for (x,y) in [(2,3),(9,3),(2,8),(9,8)] {assert_eq!(candidate.layers[0].surface().unwrap().rgba(x,y),[1.,0.,0.,1.]);}
 assert!(e.execute("paint.symmetryDisable",json!({})).is_err());assert_eq!(e.content_hash().unwrap(),base);e.commit_stroke().unwrap();assert_eq!(*e.active_doc().unwrap().doc,candidate);assert_eq!(e.active_doc().unwrap().history.past_len(),history+1);
 e.undo().unwrap();assert_eq!(e.content_hash().unwrap(),base);assert!(e.active_doc().unwrap().symmetry.is_some());e.execute("paint.symmetryDisable",json!({})).unwrap();assert_eq!(e.state()["document"]["paintingSymmetry"],Value::Null);assert_eq!(e.content_hash().unwrap(),base);
}

#[test]
fn sampling_options_strict_errors_and_off_canvas_do_not_render_or_mutate() {
 let mut e=Editor::new();e.execute("file.new",json!({"width":8,"height":8})).unwrap();let base=e.state();let hash=e.content_hash().unwrap();
 for params in [json!({"x":0,"y":0,"size":2}),json!({"x":0,"y":0,"size":null}),json!({"x":0,"y":0,"sampleLayer":"bad"}),json!({"x":0,"y":0,"sampleLayer":false}),json!({"x":0,"y":0,"extra":true}),json!({"x":"bad","y":0})] {assert!(e.sample_color_options(params).is_err());assert_eq!(e.state(),base);assert_eq!(e.content_hash().unwrap(),hash);}
 for source in ["current","currentAndBelow","all","allNoAdjustments","currentAndBelowNoAdjustments"] {for size in [1,3,5,11,31,51,101] {assert_eq!(e.sample_color_options(json!({"x":-1,"y":0,"size":size,"sampleLayer":source})).unwrap(),None);}}
 e.begin_stroke(json!({"points":[[1,1]],"size":1})).unwrap();assert!(e.sample_color_options(json!({"x":-1,"y":0})).is_err());e.cancel_stroke();assert_eq!(e.state(),base);
}

#[test]
fn sampling_gray_mask_average_is_clipped_and_identity_preserving_without_rendering() {
 let mut e=Editor::new();e.execute("file.new",json!({"width":4,"height":4})).unwrap();e.execute("layer.layerMask.hideAll",Value::Null).unwrap();
 let state=e.session.active_mut().unwrap();let id=state.active_layer.unwrap();let doc=std::sync::Arc::make_mut(&mut state.doc);doc.layer_mut(id).unwrap().mask.as_mut().unwrap().surface.fill_rect(photocraft_geom::Rect::from_xywh(0,0,1,1),&[1.]);
 e.execute("view.layerMask",json!({"mode":"gray"})).unwrap();let base=e.state();let hash=e.content_hash().unwrap();
 assert_eq!(e.sample_color_options(json!({"x":0,"y":0,"size":1})).unwrap(),Some("#ffffff".into()));
 assert_eq!(e.sample_color_options(json!({"x":0,"y":0,"size":3,"sampleLayer":"current"})).unwrap(),Some("#404040".into()));
 assert_eq!(e.state(),base);assert_eq!(e.content_hash().unwrap(),hash);
}

#[test]
fn performance_budget_is_atomic_local_applies_to_all_docs_and_gates_drafts() {
    let mut editor=Editor::new();
    for _ in 0..2 {editor.execute("file.new",json!({"width":16,"height":12})).unwrap();}
    let state=editor.state();let hash=editor.content_hash().unwrap();
    for (history,memory) in [(0,256),(1001,256),(5,255),(5,1_048_577)] {
        assert!(editor.set_performance_preferences(history,memory).is_err());
        assert_eq!(editor.session.prefs().performance.history_states,50);
        assert_eq!(editor.session.prefs().performance.memory_usage_mb,8192);
        assert_eq!(editor.state(),state);
    }
    editor.set_performance_preferences(25,256).unwrap();
    for document in editor.session.documents() {
        assert_eq!(document.history.max_states,25);
        assert_eq!(document.history.max_bytes,256usize<<20);
    }
    assert_eq!(editor.state(),state);assert_eq!(editor.content_hash().unwrap(),hash);
    editor.execute("file.new",json!({"width":8,"height":8})).unwrap();
    assert_eq!(editor.session.active().unwrap().history.max_bytes,256usize<<20);
    editor.begin_text(json!({"x":1,"y":1,"forceNew":true})).unwrap();
    assert!(editor.set_performance_preferences(30,512).is_err());editor.cancel_text();
    assert_eq!(editor.session.prefs().performance.memory_usage_mb,256);
    editor.set_performance_preferences(1000,1_048_576).unwrap();
    assert_eq!(editor.session.prefs().performance.memory_usage_mb,1_048_576);
}

#[test]
fn upstream_renderer_preferences_are_not_a_backdoor_into_shared_host_rendering() {
    let mut editor=Editor::new();editor.execute("file.new",json!({"width":8,"height":8})).unwrap();
    editor.set_performance_preferences(25,512).unwrap();
    let before=editor.state();let prefs=editor.session.prefs().performance.clone();
    for (path,value) in [("performance.renderingMode",json!("gpu")),("performance.useGpu",json!(false)),("performance.gpuBackend",json!("cpu")),("performance.gpuMemoryMb",json!(1024)),("performance.cacheTileSize",json!(512))] {
        let error=editor.execute("prefs.set",json!({"path":path,"value":value})).unwrap_err();
        assert_eq!(error.code(),"capability-disabled");
        assert_eq!(editor.session.prefs().performance,prefs);assert_eq!(editor.state(),before);
    }
    for id in ["prefs.reset","edit.preferences.performance"] {
        assert_eq!(editor.execute(id,json!({})).unwrap_err().code(),"capability-disabled");
        assert_eq!(editor.session.prefs().performance,prefs);
    }
}

#[test]
fn define_pattern_captures_selection_composite_without_document_history_and_roundtrips_library(){
 let mut e=Editor::new();e.execute("file.new",json!({"width":12,"height":8,"background":"transparent"})).unwrap();
 e.execute("select.rect",json!({"x":2,"y":1,"width":4,"height":3})).unwrap();e.execute("edit.fillForeground",json!({"color":"#ff0000"})).unwrap();
 let before=e.state();let hash=e.content_hash().unwrap();let history=e.active_doc().unwrap().history.past_len();
 let result=e.execute("edit.definePattern",json!({"name":"  Region  "})).unwrap();assert_eq!(result["presets"][0]["name"],"Region");
 let patterns=e.pattern_library.patterns();assert_eq!((patterns[0].width,patterns[0].height),(4,3));assert_eq!(patterns[0].surface.rgba(0,0),[1.,0.,0.,1.]);
 assert_eq!(e.state(),before);assert_eq!(e.content_hash().unwrap(),hash);assert_eq!(e.active_doc().unwrap().history.past_len(),history);
 e.execute("select.deselect",json!({})).unwrap();e.execute("edit.definePattern",json!({"name":"Whole"})).unwrap();assert_eq!((e.pattern_library.patterns()[1].width,e.pattern_library.patterns()[1].height),(12,8));assert_eq!(e.pattern_library.patterns()[1].surface.rgba(0,0),[0.,0.,0.,0.]);
 let bytes=e.pattern_library_snapshot().unwrap();let pat=e.export_pattern_presets(None).unwrap();let mut reopened=Editor::new();reopened.restore_pattern_library(&bytes).unwrap();assert_eq!(reopened.pattern_library(),e.pattern_library());
 let mut imported=Editor::new();imported.import_pattern_presets(&pat).unwrap();assert_eq!(imported.pattern_library()["presets"].as_array().unwrap().len(),2);
}
#[test]
fn define_pattern_rejects_names_extent_capacity_and_drafts_without_touching_library(){
 let mut e=Editor::new();e.execute("file.new",json!({"width":1025,"height":1,"background":"transparent"})).unwrap();
 let before=e.state();let library=e.pattern_library();assert!(e.execute("edit.definePattern",json!({"name":"Wide"})).is_err());assert_eq!(e.state(),before);assert_eq!(e.pattern_library(),library);
 e.execute("select.rect",json!({"x":0,"y":0,"width":1,"height":1})).unwrap();
 for params in [json!({}),json!({"name":" "}),json!({"name":"line\nname"}),json!({"name":"a".repeat(201)}),json!({"name":"x","rect":[0,0,1,1]}),json!({"name":3})]{assert!(e.execute("edit.definePattern",params).is_err());assert_eq!(e.pattern_library(),library);}
 e.begin_layer_properties(e.active_layer_id().unwrap().0).unwrap();assert!(e.execute("edit.definePattern",json!({"name":"Draft"})).is_err());e.cancel_layer_properties();assert_eq!(e.pattern_library(),library);
 let f=e.active_doc().unwrap().doc.pixel_format();let patterns=(0..64).map(|i|photocraft_doc::Pattern{id:format!("p{i}"),name:format!("p{i}"),width:1,height:1,surface:photocraft_raster::Surface::new(f)}).collect();e.pattern_library.append(patterns,&[]).unwrap();let full=e.pattern_library();assert!(e.execute("edit.definePattern",json!({"name":"65"})).is_err());assert_eq!(e.pattern_library(),full);
}

#[test]
fn move_quick_alignment_targets_selection_union_or_single_canvas_with_one_history(){
 use photocraft_doc::{Document,Size,ColorMode,SampleType,Layer};
 for (target,selection,multiple,expected) in [("selection",true,true,7),("auto",false,true,4),("auto",false,false,0)] {
  let mut doc=Document::new("Align",Size::new(60,30),ColorMode::Rgb,SampleType::U8);let mut ids=Vec::new();
  for (name,x,y) in [("A",4,4),("B",20,10)]{let mut layer=Layer::raster(name,doc.pixel_format());layer.surface_mut().unwrap().fill_rect(Rect::new(x,y,x+4,y+4),&[1.,0.,0.,1.]);ids.push(layer.id);doc.layers.push(layer);}
  let mut e=Editor::new();e.session.add_document(doc,None);photocraft_engine::layer_multi_cmds::set_selection(&mut e.session,if multiple{ids.clone()}else{vec![ids[0]]},Some(ids[0]),Some(ids[0])).unwrap();
  if selection{e.execute("select.rect",json!({"x":7,"y":2,"width":20,"height":20})).unwrap();}
  let hash=e.content_hash().unwrap();let history=e.active_doc().unwrap().history.past_len();
  e.execute("layer.align.leftEdges",json!({"to":target})).unwrap();let after=e.active_doc().unwrap();
  for id in &ids[..if multiple{2}else{1}] {let layer=after.doc.layer(*id).unwrap();let bounds=photocraft_engine::layer_multi_cmds::layer_bounds(layer).unwrap();assert_eq!(bounds.x0,expected);assert_eq!(layer.surface().unwrap().rgba(bounds.x0,bounds.y0),[1.,0.,0.,1.]);}
  assert_eq!(after.history.past_len(),history+1);let aligned=e.content_hash().unwrap();e.undo().unwrap();assert_eq!(e.content_hash().unwrap(),hash);e.redo().unwrap();assert_eq!(e.content_hash().unwrap(),aligned);
 }
}
