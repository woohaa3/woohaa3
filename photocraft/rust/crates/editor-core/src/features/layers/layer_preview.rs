//! 图层目标与隔离预览复用内核文档，不修改正式图层或选区。
use photocraft_doc::{Document, LayerContent, LayerId};
use photocraft_engine::{DocState, channel_cmds::ChannelTarget, transform_cmds};
use serde_json::{Value, json};
use crate::{Preview, error::{EditorError, Result}};

pub(crate) fn mask_target(state: &DocState) -> bool {
    (state.channel_view.target == ChannelTarget::LayerMask || photocraft_engine::mask_view_cmds::current(state).is_some())
        && state.active_layer.and_then(|id|state.doc.layer(id)).is_some_and(|layer|layer.mask.is_some())
}
pub(crate) fn target_params(state: &DocState) -> Value {
    json!({"target":if mask_target(state) {"mask"} else {"pixels"}})
}
pub(crate) fn transform_frame(state: &DocState) -> photocraft_geom::Rect {
    let params=target_params(state);
    if let Ok(Some(surface))=transform_cmds::lone_target(&state.doc,state.active_layer,&params) {
        return transform_cmds::target_frame(&state.doc,surface);
    }
    let targets=transform_targets(state);
    if crate::smart_identity::contains_smart(&state.doc.layers) {
        return crate::smart_transform::frame(&state.doc,&targets).unwrap_or(photocraft_geom::Rect::EMPTY);
    }
    targets.iter().filter_map(|id|state.doc.layer(*id))
        .map(|layer|transform_cmds::transform_frame(&state.doc,layer))
        .fold(photocraft_geom::Rect::EMPTY,|frame,next|frame.union(&next))
}

/// 独立蒙版只变换活动目标；其他情况按文档顺序处理所选根层，避免父子重复变换。
pub(crate) fn transform_targets(state:&DocState)->Vec<LayerId> {
    if transform_cmds::lone_target(&state.doc,state.active_layer,&target_params(state)).ok().flatten().is_some() {
        return state.active_layer.into_iter().collect();
    }
    selected_roots(state)
}

pub(crate) fn selected_roots(state:&DocState)->Vec<LayerId> {
    let selected=state.selected_layers();
    let paths:Vec<_>=selected.iter().filter_map(|id|state.doc.path_of(*id).map(|path|(*id,path))).collect();
    paths.iter().filter(|(_,path)|!paths.iter().any(|(_,parent)|parent.len()<path.len() && path.starts_with(parent)))
        .map(|(id,_)|*id).collect()
}

pub(crate) fn layer_count(layers: &[photocraft_doc::Layer]) -> usize {
    layers.iter().map(|layer| 1 + layer.children().map_or(0, layer_count)).sum()
}

pub(crate) fn layer_depth(layers: &[photocraft_doc::Layer]) -> usize {
    layers.iter().map(|layer| 1 + layer.children().map_or(0, layer_depth)).max().unwrap_or(0)
}

/// 复制按整个子树计数，同时选择祖先和后代时只计算祖先。
pub(crate) fn target_layer_count(doc: &Document, ids: &[LayerId]) -> usize {
    let paths: Vec<_> = ids.iter().filter_map(|id| doc.path_of(*id).map(|path| (*id, path))).collect();
    paths.iter().enumerate().filter(|(index, (_, path))| !paths.iter().enumerate().any(|(other, (_, parent))| {
        other != *index && (parent.len() < path.len() || (parent == path && other < *index)) && path.starts_with(parent)
    })).filter_map(|(_, (id, _))| doc.layer(*id))
        .map(|layer| 1 + layer.children().map_or(0, layer_count)).sum()
}

pub(crate) fn check_reorder_depth(state: &DocState, params: &Value) -> Result<()> {
    let Some(target) = params.get("target").and_then(Value::as_u64).map(LayerId) else { return Ok(()) };
    let Some(path) = state.doc.path_of(target) else { return Ok(()) };
    let destination = path.len() + usize::from(params.get("position").and_then(Value::as_str) == Some("into"));
    let ids: Vec<_> = if let Some(layers) = params.get("layers").and_then(Value::as_array) {
        layers.iter().filter_map(Value::as_u64).map(LayerId).collect()
    } else {
        params.get("layer").and_then(Value::as_u64).map(LayerId).or(state.active_layer).into_iter().collect()
    };
    fn height(layer: &photocraft_doc::Layer) -> usize {
        1 + layer.children().and_then(|children| children.iter().map(height).max()).unwrap_or(0)
    }
    if ids.iter().filter_map(|id| state.doc.layer(*id)).any(|layer| destination + height(layer) - 1 > photocraft_project_verify::MAX_DOCUMENT_DEPTH) {
        return Err(EditorError::CommandFailed { id: "layer.moveTo".into(), message: "图层重排超过工程层级上限（16 层）".into() });
    }
    Ok(())
}

pub(crate) fn isolated(doc: &Document, id: LayerId, mask: bool, max_side: u32) -> Result<Preview> {
    let isolated=isolated_document(doc,id,mask)?;
    let image=photocraft_compose::thumbnail(&isolated,max_side);
    Ok(Preview{width:image.width,height:image.height,pixels:image.pixels})
}

pub(crate) fn isolated_document(doc: &Document, id: LayerId, mask: bool) -> Result<Document> {
    let mut layer=doc.layer(id).cloned().ok_or_else(||EditorError::CommandFailed{id:"layer.thumbnail".into(),message:"图层不存在".into()})?;
    if mask {
        let surface=layer.mask.as_ref().ok_or_else(||EditorError::CommandFailed{id:"layer.thumbnail".into(),message:"图层没有蒙版".into()})?.surface.clone();
        layer.content=LayerContent::Raster(surface);
    }
    layer.mask=None;
    layer.visible=true;
    layer.opacity=1.0;
    layer.blend=photocraft_doc::BlendMode::Normal;
    let mut isolated=doc.clone();
    isolated.layers=vec![layer];
    Ok(isolated)
}

#[cfg(test)]
mod tests {
    use super::*;
    use photocraft_doc::{Layer, LayerMask};
    use photocraft_engine::Session;

    #[test]
    fn subtree_capacity_deduplicates_ancestors_and_repeated_ids_without_rendering() {
        let mut doc = Document::new("组", photocraft_doc::Size::new(16, 16), photocraft_doc::ColorMode::Rgb, photocraft_doc::SampleType::U8);
        let child = Layer::raster("子层", doc.pixel_format()); let child_id = child.id;
        let group = Layer::group("组", vec![child, Layer::group("空组", vec![])]); let group_id = group.id;
        doc.layers = vec![group];
        assert_eq!(layer_count(&doc.layers), 3);
        assert_eq!(target_layer_count(&doc, &[child_id]), 1);
        assert_eq!(target_layer_count(&doc, &[child_id, group_id, group_id]), 3);
    }

    #[test]
    fn root_targets_and_unlinked_mask_share_the_frame_contract() {
        let mut session=Session::new();
        session.execute("file.new",json!({"width":20,"height":20})).unwrap();
        session.execute("layer.new.layer",json!({"name":"甲"})).unwrap();
        let first=session.active().unwrap().active_layer.unwrap();
        session.execute("layer.new.layer",json!({"name":"乙"})).unwrap();
        let second=session.active().unwrap().active_layer.unwrap();
        let state=session.active_mut().unwrap();
        state.selected_layers=vec![first,second];
        let doc=std::sync::Arc::make_mut(&mut state.doc);
        doc.layer_mut(first).unwrap().surface_mut().unwrap().write_pixel(2,3,&[1.,0.,0.,1.]);
        doc.layer_mut(second).unwrap().surface_mut().unwrap().write_pixel(7,8,&[1.,0.,0.,1.]);
        let mut mask=LayerMask::hide_all();
        mask.surface.write_pixel(12,13,&[1.]);
        mask.linked=false;
        doc.layer_mut(second).unwrap().mask=Some(mask);
        state.channel_view.target=ChannelTarget::LayerMask;
        assert_eq!(transform_targets(state),vec![second]);
        assert_eq!(transform_frame(state),photocraft_geom::Rect::new(12,13,13,14));
        std::sync::Arc::make_mut(&mut state.doc).layer_mut(second).unwrap().mask.as_mut().unwrap().linked=true;
        assert_eq!(transform_targets(state),vec![first,second]);
        assert_eq!(transform_frame(state),photocraft_geom::Rect::new(2,3,8,9));
        // 仅检查组树路径去重，未开放分组入口或执行组变换。
        let doc=std::sync::Arc::make_mut(&mut state.doc);
        let child=doc.remove(first).unwrap();
        let group=Layer::group("组",vec![child]);
        let group_id=doc.insert_above(None,group);
        state.selected_layers=vec![group_id,first,second];
        assert_eq!(selected_roots(state).len(),2);
        assert!(!selected_roots(state).contains(&first));
    }
}
