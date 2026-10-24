//! 自由变换草稿只持有上游文档快照，不改正式修订或撤销分支。
use std::sync::Arc;
use photocraft_engine::{DocState, Session};
use serde_json::{json, Value};
use crate::error::{EditorError, Result};

pub(crate) struct TransformPreview {
    base: DocState,
    pub doc: Arc<photocraft_doc::Document>,
    pub params: Option<Value>,
    pub duplicate: bool,
    pub selection_only: bool,
    pub whole_layer: bool,
    pub selected_pixels: Option<photocraft_engine::float_cmds::CutParts>,
    active: Option<photocraft_doc::LayerId>,
    selected: Vec<photocraft_doc::LayerId>,
    valid: bool,
}

impl TransformPreview {
    pub fn new(base: &DocState) -> Self {
        Self { base: base.clone(), doc: base.doc.clone(), params: None, duplicate: false, selection_only: false, whole_layer: false, selected_pixels: None, active: base.active_layer, selected: base.selected_layers(), valid: true }
    }

    /// 每次从进入时的原文档计算累计矩阵，避免连续重采样损失。
    pub fn update(&mut self, matrix: Value) -> Result<()> {
        self.update_with(matrix,execute_snapshot)
    }

    fn update_with(&mut self,matrix:Value,mut execute:impl FnMut(&DocState,&str,Value)->Result<DocState>)->Result<()> {
        self.update_using(matrix,&mut execute,crate::smart_transform::refresh)
    }

    fn update_using(&mut self,matrix:Value,mut execute:impl FnMut(&DocState,&str,Value)->Result<DocState>,mut refresh:impl FnMut(&photocraft_doc::Document,&mut photocraft_doc::Document)->Result<()>)->Result<()> {
        self.valid=false;
        let values = matrix.as_array().filter(|values| values.len() == 6)
            .ok_or_else(|| error("变换矩阵需要六个有限数值"))?;
        let numbers: Option<Vec<f64>> = values.iter().map(Value::as_f64).collect();
        let numbers = numbers.filter(|values| values.iter().all(|value| value.is_finite()))
            .ok_or_else(|| error("变换矩阵需要六个有限数值"))?;
        let determinant=numbers[0] * numbers[3] - numbers[1] * numbers[2];
        if !determinant.is_finite() || determinant.abs() < 1e-12 {
            return Err(error("变换矩阵不可逆"));
        }
        let identity=numbers.iter().zip([1.,0.,0.,1.,0.,0.]).all(|(a,b)| *a==b);
        if identity && (!self.duplicate || self.selected_pixels.is_some()) {
            self.doc = self.base.doc.clone();
            self.params = None;
            self.active = self.base.active_layer;
            self.selected = self.base.selected_layers();
            self.valid = true;
            return Ok(());
        }
        if let Some(parts)=&self.selected_pixels {
            if numbers[..4] != [1.,0.,0.,1.] || numbers[4..].iter().any(|v| v.abs()>i32::MAX as f64) {
                return Err(error("选区像素移动只接受有效的平移"));
            }
            let (dx,dy)=(numbers[4].round() as i32,numbers[5].round() as i32);
            let mut doc=parts.moved(&self.base.doc,dx,dy).map_err(error)?;
            doc.selection=self.base.doc.selection.as_ref().map(|sel|photocraft_algo::resample::translate_surface(sel,dx,dy));
            self.doc=Arc::new(doc);self.params=Some(json!({"matrix":matrix}));self.valid=true;
            return Ok(());
        }
        let mut source=self.base.clone();
        if self.whole_layer {Arc::make_mut(&mut source.doc).selection=None;}
        if self.duplicate {
            source.selected_layers=crate::layer_preview::transform_targets(&source);
            if !source.active_layer.is_some_and(|id|source.selected_layers.contains(&id)) {source.active_layer=source.selected_layers.last().copied();}
            source=execute(&source,"layer.duplicate",json!({"inPlace":true}))?;
        }
        let targets=crate::layer_preview::transform_targets(&source);
        let mut params=if self.selection_only {json!({})} else {crate::layer_preview::target_params(&source)};
        params["matrix"]=matrix;
        let before_transform=source.doc.clone();
        let mut preview=if identity {source} else if self.selection_only || targets.len()<=1 {
            if !self.selection_only {if let Some(id)=targets.first() {params["layer"]=json!(id.0);}}
            execute(&source,self.command(),params.clone())?
        } else {
            let frame=crate::layer_preview::transform_frame(&source);
            if frame.is_empty() {return Err(error("所选图层没有可变换内容"));}
            params["rect"]=json!([frame.x0,frame.y0,frame.x1,frame.y1]);
            params["target"]=json!("pixels");
            let mut merged=(*source.doc).clone();
            for (index,id) in targets.iter().enumerate() {
                let mut target_params=params.clone();target_params["layer"]=json!(id.0);
                // 各层共享原快照与原选区，不将前一层移动过的选区传给下一层。
                let transformed=execute(&source,self.command(),target_params)?;
                let layer=transformed.doc.layer(*id).ok_or_else(||error("变换目标图层丢失"))?.clone();
                *merged.layer_mut(*id).ok_or_else(||error("变换目标图层丢失"))?=layer;
                if index==0 {merged.selection=transformed.doc.selection.clone();}
            }
            let mut result=source.clone();result.doc=Arc::new(merged);result
        };
        if !self.selection_only && crate::smart_identity::contains_smart(&preview.doc.layers) {refresh(&before_transform,Arc::make_mut(&mut preview.doc))?;}
        if self.whole_layer {Arc::make_mut(&mut preview.doc).selection=self.base.doc.selection.clone();}
        self.active=preview.active_layer;
        self.selected=preview.selected_layers();
        self.doc=preview.doc;
        self.params=Some(params);
        self.valid = true;
        Ok(())
    }
    pub fn command(&self) -> &'static str {
        if self.selection_only { "select.transformSelection" } else { "edit.transform" }
    }
    pub fn require_valid(&self) -> Result<()> {
        if self.valid {Ok(())} else {Err(error("请修正变换参数或取消编辑"))}
    }
    /// 直接确认已经预览的同一快照，避免二次变换与跨命令合并历史。
    pub fn commit(&self, session: &mut Session) -> Result<Value> {
        self.require_valid()?;
        let current=session.active().ok_or(EditorError::NoDocument)?;
        if !Arc::ptr_eq(&current.doc,&self.base.doc) || current.revision!=self.base.revision
            || current.active_layer!=self.base.active_layer || current.selected_layers()!=self.base.selected_layers() {
            return Err(error("文档或变换目标已变化，请重新开始变换"));
        }
        let label=if self.duplicate {"移动副本"} else if self.selection_only {"变换选区"} else {"自由变换"};
        crate::preview_history::commit_selected(session,self.doc.clone(),self.active,self.selected.clone(),label).map_err(error)?;
        Ok(Value::Null)
    }

}

fn execute_snapshot(base:&DocState,command:&str,params:Value)->Result<DocState> {
    if crate::smart_identity::contains_smart(&base.doc.layers) {
        return crate::smart_transform::execute(base,command,params);
    }
    let mut preview=Session::new();preview.add_document((*base.doc).clone(),None);
    *preview.active_mut().unwrap()=base.clone();
    preview.execute(command,params).map_err(error)?;
    Ok(preview.active().unwrap().clone())
}

pub(crate) fn error(error: impl std::fmt::Display) -> EditorError {
    EditorError::CommandFailed { id: "edit.transform".into(), message: error.to_string() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copy_commit_records_one_step_and_restores_layer_target_on_undo() {
        // 仅空层结构与撤销状态，不执行绘制、合成或非空像素变换。
        let mut session = Session::new();
        session.execute("file.new",json!({"width":20,"height":20})).unwrap();
        session.execute("layer.new.layer",json!({"name":"来源"})).unwrap();
        let before = session.active().unwrap().clone();
        let mut draft = TransformPreview::new(&before);
        let mut scratch = Session::new();
        scratch.add_document((*before.doc).clone(),None);
        *scratch.active_mut().unwrap() = before.clone();
        scratch.execute("layer.duplicate",json!({"inPlace":true})).unwrap();
        draft.doc = scratch.active().unwrap().doc.clone();
        draft.active = scratch.active().unwrap().active_layer;
        draft.selected = scratch.active().unwrap().selected_layers();
        draft.commit(&mut session).unwrap();
        assert_eq!(session.active().unwrap().doc.layers.len(), before.doc.layers.len()+1);
        assert_eq!(session.active().unwrap().history.past_len(),before.history.past_len()+1);
        assert_eq!(session.active().unwrap().active_layer,draft.active);
        session.execute("edit.undo",Value::Null).unwrap();
        assert_eq!(session.active().unwrap().doc.layers.len(),before.doc.layers.len());
        assert_eq!(session.active().unwrap().active_layer,before.active_layer);
        session.execute("edit.redo",Value::Null).unwrap();
        assert_eq!(session.active().unwrap().active_layer,draft.active);
    }
    fn multi_session() -> Session {
        let mut session = Session::new();
        session.execute("file.new", json!({"width":20,"height":20})).unwrap();
        let mut ids = Vec::new();
        for name in ["甲", "乙"] {
            session.execute("layer.new.layer", json!({"name":name})).unwrap();
            ids.push(session.active().unwrap().active_layer.unwrap());
        }
        photocraft_engine::layer_multi_cmds::set_selection(&mut session, ids.clone(), ids.last().copied(), None).unwrap();
        session
    }

    #[test]
    fn multi_copy_identity_keeps_one_history_step_and_full_selection() {
        let mut session = multi_session();
        let base = session.active().unwrap().clone();
        let mut draft = TransformPreview::new(&base);
        draft.duplicate = true;
        for _ in 0..2 { draft.update(json!([1,0,0,1,0,0])).unwrap(); }
        assert_eq!(draft.doc.layers.len(), base.doc.layers.len()+2);
        assert_eq!(draft.selected.len(), 2);
        assert!(draft.selected.iter().all(|id|!base.selected_layers().contains(id)));
        assert!(Arc::ptr_eq(&session.active().unwrap().doc, &base.doc));
        draft.commit(&mut session).unwrap();
        assert_eq!(session.active().unwrap().history.past_len(), base.history.past_len()+1);
        assert_eq!(session.active().unwrap().selected_layers(), draft.selected);
        session.execute("edit.undo", Value::Null).unwrap();
        assert_eq!(session.active().unwrap().selected_layers(), base.selected_layers());
        assert_eq!(session.active().unwrap().doc.layers.len(), base.doc.layers.len());
        session.execute("edit.redo", Value::Null).unwrap();
        assert_eq!(session.active().unwrap().selected_layers(), draft.selected);
    }

    #[test]
    fn multi_preview_uses_one_source_and_publishes_only_complete_results() {
        // 手工 surface 仅用于范围读取；变换 executor 只修改名字和选区领域状态。
        let mut session = multi_session();
        let mut base = session.active().unwrap().clone();
        let ids = base.selected_layers();
        let doc = Arc::make_mut(&mut base.doc);
        for (index,id) in ids.iter().enumerate() {
            doc.layer_mut(*id).unwrap().surface_mut().unwrap().write_pixel(2+index as i32*5,3,&[1.,0.,0.,1.]);
        }
        let mut selection = photocraft_doc::LayerMask::hide_all().surface;
        selection.write_pixel(2,3,&[1.]);
        selection.write_pixel(7,3,&[1.]);
        doc.selection = Some(selection);
        let frame = crate::layer_preview::transform_frame(&base);
        let mut draft = TransformPreview::new(&base);
        let mut calls = 0;
        for dx in [4,8] {
            draft.update_with(json!([1,0,0,1,dx,0]), |source, command, params| {
                calls += 1;
                assert_eq!(command,"edit.transform");
                assert!(Arc::ptr_eq(&source.doc,&base.doc));
                assert_eq!(params["rect"],json!([frame.x0,frame.y0,frame.x1,frame.y1]));
                assert_eq!(params["matrix"],json!([1,0,0,1,dx,0]));
                let id = photocraft_doc::LayerId(params["layer"].as_u64().unwrap());
                let mut result = source.clone();
                let doc = Arc::make_mut(&mut result.doc);
                doc.layer_mut(id).unwrap().name = format!("移动{dx}");
                // 未指向的层变化不得被合入，选区只采用第一个结果。
                doc.layers[0].name = "不应合入".into();
                if id == ids[0] {doc.selection=None;}
                Ok(result)
            }).unwrap();
            for id in &ids {assert_eq!(draft.doc.layer(*id).unwrap().name,format!("移动{dx}"));}
            assert_eq!(draft.doc.layers[0].name,base.doc.layers[0].name);
            assert!(draft.doc.selection.is_none());
        }
        assert_eq!(calls,4);
        let successful = draft.doc.clone();
        let mut calls = 0;
        assert!(draft.update_with(json!([1,0,0,1,12,0]), |source,_,_| {
            calls += 1;
            if calls==2 {return Err(error("第二层失败"));}
            let mut result = source.clone();
            Arc::make_mut(&mut result.doc).layer_mut(ids[0]).unwrap().name="部分结果".into();
            Ok(result)
        }).is_err());
        assert!(Arc::ptr_eq(&draft.doc,&successful));
        assert!(draft.require_valid().is_err());
        assert!(draft.commit(&mut session).is_err());
        draft.update(json!([1,0,0,1,0,0])).unwrap();
        draft.require_valid().unwrap();
        assert!(draft.params.is_none());
        assert!(Arc::ptr_eq(&draft.doc,&base.doc));
    }

    // 仅空源、空缓存与状态运算；不生成或变换有效像素。
    fn smart_session() -> Session {
        use photocraft_doc::{Affine, ColorMode, Document, Layer, LayerContent, LayerMask, SampleType, Size, SmartObject, SmartSource, Surface};
        let mut child=Document::new("源",Size::new(16,12),ColorMode::Rgb,SampleType::U8);
        child.layers=vec![Layer::raster("空",child.pixel_format())];
        let source=SmartSource::Embedded {file_name:"source.pcraft".into(),bytes:Arc::new(photocraft_format::save_to_bytes(&child,&Default::default()).unwrap())};
        let mut doc=Document::new("父",Size::new(40,30),ColorMode::Rgb,SampleType::U8);
        let mut a=Layer::new("甲",LayerContent::Smart(SmartObject::new(source,Affine{m:[2.,0.25,1e-8,1.5,3.,-2.]},Some(Surface::new(doc.pixel_format())))));
        a.mask=Some(LayerMask::reveal_all());
        let b=a.duplicate();
        let group=Layer::group("组",vec![b,Layer::raster("普通空层",doc.pixel_format())]);
        let ids=vec![a.id,group.id];
        doc.layers=vec![a,group];
        let mut session=Session::new();session.add_document(doc,None);
        let state=session.active_mut().unwrap();state.active_layer=Some(ids[0]);state.selected_layers=ids;
        session
    }
    fn smart(doc:&photocraft_doc::Document,id:photocraft_doc::LayerId)->&photocraft_doc::SmartObject {
        let photocraft_doc::LayerContent::Smart(s)=&doc.layer(id).unwrap().content else {panic!("应为智能对象")};s
    }
    fn smart_cache_stub(before:&photocraft_doc::Document,after:&mut photocraft_doc::Document)->Result<()> {
        use photocraft_doc::{LayerContent,Surface};
        let format=after.pixel_format();
        let ids:Vec<_>=after.walk().into_iter().filter_map(|(_,_,l)|matches!(&l.content,LayerContent::Smart(_)).then_some(l.id)).collect();
        for id in ids {
            let old=smart(before,id);
            let LayerContent::Smart(current)=&mut after.layer_mut(id).unwrap().content else {unreachable!()};
            assert_eq!(current.source,old.source);assert_eq!(current.contents_id,old.contents_id);
            if current.transform!=old.transform {assert!(current.cache.is_none());current.cache=Some(Surface::new(format));}
        }
        Ok(())
    }
    #[test]
    fn smart_multi_group_preview_uses_original_affines_and_commits_one_complete_snapshot() {
        let mut session=smart_session();let base=session.active().unwrap().clone();
        let ids:Vec<_>=base.doc.walk().into_iter().filter_map(|(_,_,l)|matches!(&l.content,photocraft_doc::LayerContent::Smart(_)).then_some(l.id)).collect();
        assert_eq!(crate::layer_preview::transform_frame(&base),photocraft_doc::Rect::new(3,-2,36,20));
        let mut draft=TransformPreview::new(&base);
        for m in [[0.5,0.,0.,0.5,5.,6.],[1.,0.,0.,1.,8.,-3.]] {
            draft.update_using(json!(m),execute_snapshot,smart_cache_stub).unwrap();
            for id in &ids {assert_eq!(smart(&draft.doc,*id).transform,photocraft_doc::Affine{m}.mul(&smart(&base.doc,*id).transform));}
            assert!(Arc::ptr_eq(&session.active().unwrap().doc,&base.doc));
        }
        draft.commit(&mut session).unwrap();
        assert_eq!(session.active().unwrap().history.past_len(),base.history.past_len()+1);
        assert_eq!(session.active().unwrap().selected_layers(),base.selected_layers());
        let hash=crate::document_content::document_content_hash(&draft.doc,&Default::default()).unwrap();
        let bytes=photocraft_format::save_to_bytes(&draft.doc,&Default::default()).unwrap();
        let loaded=photocraft_format::load_from_bytes(&bytes).unwrap();
        assert_eq!(crate::document_content::document_content_hash(&loaded,&Default::default()).unwrap(),hash);
        session.execute("edit.undo",Value::Null).unwrap();
        for id in &ids {assert_eq!(smart(&session.active().unwrap().doc,*id).transform,smart(&base.doc,*id).transform);}
        session.execute("edit.redo",Value::Null).unwrap();
        for id in &ids {assert_eq!(smart(&session.active().unwrap().doc,*id).transform,smart(&draft.doc,*id).transform);}
    }
    #[test]
    fn smart_failed_refresh_invalidates_confirmation_and_identity_restores_base_without_render() {
        let mut session=smart_session();let base=session.active().unwrap().clone();let mut draft=TransformPreview::new(&base);
        draft.update_using(json!([1,0,0,1,2,3]),execute_snapshot,smart_cache_stub).unwrap();
        let successful=draft.doc.clone();
        assert!(draft.update_using(json!([1,0,0,1,4,5]),execute_snapshot,|_,_|Err(error("重算失败"))).is_err());
        assert!(Arc::ptr_eq(&draft.doc,&successful));assert!(draft.commit(&mut session).is_err());
        assert!(Arc::ptr_eq(&session.active().unwrap().doc,&base.doc));
        assert!(draft.update_using(json!([1e308,0,0,1e308,0,0]),|_,_,_|panic!("应先拒绝行列式溢出"),|_,_|panic!("不应重算")).is_err());
        draft.update_using(json!([1,0,0,1,0,0]),|_,_,_|panic!("恒等不执行"),|_,_|panic!("恒等不重算")).unwrap();
        assert!(draft.params.is_none());assert!(Arc::ptr_eq(&draft.doc,&base.doc));draft.require_valid().unwrap();
    }
    #[test]
    fn smart_tiny_shear_is_preserved_and_stale_commit_cannot_overwrite_later_edit() {
        let mut session=smart_session();session.active_mut().unwrap().selected_layers.truncate(1);
        let base=session.active().unwrap().clone();let id=base.active_layer.unwrap();let mut draft=TransformPreview::new(&base);
        let m=[1.,0.,1e-13,1.,0.,0.];
        draft.update_using(json!(m),execute_snapshot,smart_cache_stub).unwrap();
        assert!(draft.params.is_some());assert_eq!(smart(&draft.doc,id).transform,photocraft_doc::Affine{m}.mul(&smart(&base.doc,id).transform));
        Arc::make_mut(&mut session.active_mut().unwrap().doc).name="后续修改".into();
        let later=session.active().unwrap().doc.clone();
        assert!(draft.commit(&mut session).is_err());assert!(Arc::ptr_eq(&session.active().unwrap().doc,&later));
    }
    #[test]
    fn smart_duplicate_preview_preserves_originals_and_uses_shared_source_with_one_undo() {
        let mut session=smart_session();session.active_mut().unwrap().selected_layers.truncate(1);
        let base=session.active().unwrap().clone();let id=base.active_layer.unwrap();let mut draft=TransformPreview::new(&base);draft.duplicate=true;
        draft.update_using(json!([1,0,0,1,2,3]),execute_snapshot,smart_cache_stub).unwrap();
        let copy=draft.active.unwrap();assert_ne!(copy,id);
        assert_eq!(smart(&draft.doc,id),smart(&base.doc,id));
        assert_eq!(smart(&draft.doc,copy).contents_id,smart(&base.doc,id).contents_id);
        assert_eq!(smart(&draft.doc,copy).source,smart(&base.doc,id).source);
        draft.commit(&mut session).unwrap();assert_eq!(session.active().unwrap().history.past_len(),base.history.past_len()+1);
        session.execute("edit.undo",Value::Null).unwrap();assert!(session.active().unwrap().doc.layer(copy).is_none());
        assert_eq!(smart(&session.active().unwrap().doc,id),smart(&base.doc,id));
    }

    #[test]
    fn smart_out_of_bounds_and_locked_targets_reject_before_refresh() {
        let session=smart_session();let base=session.active().unwrap().clone();
        let mut draft=TransformPreview::new(&base);
        assert!(draft.update_using(json!([1,0,0,1,3e9,0]),execute_snapshot,|_,_|panic!("越界不应进入重算")).is_err());
        assert!(Arc::ptr_eq(&draft.doc,&base.doc));
        let mut locked=base.clone();
        Arc::make_mut(&mut locked.doc).layer_mut(base.active_layer.unwrap()).unwrap().locks.position=true;
        let mut draft=TransformPreview::new(&locked);
        assert!(draft.update_using(json!([1,0,0,1,2,3]),execute_snapshot,|_,_|panic!("锁定不应进入重算")).is_err());
        assert!(Arc::ptr_eq(&draft.doc,&locked.doc));
    }

}

#[cfg(test)]
mod selected_move_tests {
    use super::*;
    fn fixture()->Session {
        use photocraft_doc::*;
        let mut doc=Document::new("选区移动",Size::new(16,16),ColorMode::Rgb,SampleType::U8);
        let mut layer=Layer::raster("像素",doc.pixel_format());
        layer.surface_mut().unwrap().write_pixel(2,3,&[1.,0.,0.,1.]);
        layer.surface_mut().unwrap().write_pixel(6,3,&[0.,1.,0.,1.]);
        let mut selection=LayerMask::hide_all().surface;selection.write_pixel(2,3,&[1.]);doc.selection=Some(selection);
        doc.layers=vec![layer];let mut session=Session::new();session.add_document(doc,None);session
    }
    #[test]
    fn selected_pixel_move_and_copy_are_cancelable_single_step_and_do_not_duplicate_layers() {
        for copy in [false,true] {
            let mut session=fixture();let base=session.active().unwrap().clone();let id=base.active_layer.unwrap();
            let mut draft=TransformPreview::new(&base);
            draft.selected_pixels=Some(photocraft_engine::float_cmds::CutParts::new(&base.doc,id,copy,[1.,1.,1.,1.],false).unwrap());draft.duplicate=copy;
            for dx in [2,3] {draft.update(json!([1,0,0,1,dx,0])).unwrap();}
            let surface=draft.doc.layer(id).unwrap().surface().unwrap();
            assert_eq!(surface.sample_channel(5,3,3),1.);assert_eq!(surface.sample_channel(2,3,3),if copy {1.} else {0.});assert_eq!(surface.sample_channel(6,3,3),1.);
            assert_eq!(draft.doc.layers.len(),1);assert_eq!(draft.doc.selection.as_ref().unwrap().sample_channel(5,3,0),1.);
            assert!(Arc::ptr_eq(&session.active().unwrap().doc,&base.doc));
            assert!(draft.update(json!([2,0,0,1,3,0])).is_err());assert!(draft.commit(&mut session).is_err());
            draft.update(json!([1,0,0,1,3,0])).unwrap();draft.commit(&mut session).unwrap();assert_eq!(session.active().unwrap().history.past_len(),base.history.past_len()+1);
            session.execute("edit.undo",Value::Null).unwrap();assert_eq!(session.active().unwrap().doc,base.doc);
            session.execute("edit.redo",Value::Null).unwrap();assert_eq!(session.active().unwrap().doc,draft.doc);
        }
    }
    #[test]
    fn whole_layer_move_preserves_selection_and_moves_unselected_pixels() {
        let mut session=fixture();let base=session.active().unwrap().clone();let id=base.active_layer.unwrap();
        let mut draft=TransformPreview::new(&base);draft.whole_layer=true;
        draft.update(json!([1,0,0,1,3,0])).unwrap();
        assert_eq!(draft.doc.selection,base.doc.selection);let surface=draft.doc.layer(id).unwrap().surface().unwrap();
        assert_eq!(surface.sample_channel(5,3,3),1.);assert_eq!(surface.sample_channel(9,3,3),1.);assert_eq!(surface.sample_channel(6,3,3),0.);
        draft.commit(&mut session).unwrap();session.execute("edit.undo",Value::Null).unwrap();assert_eq!(session.active().unwrap().doc,base.doc);
    }
}
