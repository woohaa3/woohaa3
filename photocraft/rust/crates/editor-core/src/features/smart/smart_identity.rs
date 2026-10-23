//! 智能对象内容身份：源的可编辑内容、共享关系和完整仿射，不使用合成缓存或容器字节摘要。
use crate::{document_content::surface_hash, identity::affine_identity};
use photocraft_doc::{Document, Layer, LayerContent, SmartSource};
use photocraft_project_verify::smart_source::{SourceGraph, inspect_document_sources};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

pub(crate) fn contains_smart(layers: &[Layer]) -> bool {
    layers.iter().any(|layer| match &layer.content {
        LayerContent::Smart(_) => true,
        LayerContent::Group(g) => contains_smart(&g.children),
        _ => false,
    })
}
fn group(groups: &mut HashMap<u64, usize>, id: u64) -> usize {
    let next = groups.len() + 1;
    *groups.entry(id).or_insert(next)
}
fn digest(value: &Value) -> Option<String> {
    fn normalize(value: &mut Value) {
        match value {
            Value::Number(n) if n.as_f64() == Some(0.0) => *value = json!(0),
            Value::Array(values) => values.iter_mut().for_each(normalize),
            Value::Object(fields) => fields.values_mut().for_each(normalize),
            _ => {}
        }
    }
    let mut value = value.clone();
    normalize(&mut value);
    let bytes = serde_json::to_vec(&value).ok()?;
    let mut hash = Sha256::new();
    hash.update(b"woohaa-smart-source-v1:");
    hash.update(bytes);
    Some(
        hash.finalize()[..8]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
    )
}
fn source_hash(
    source: &SmartSource,
    graph: &SourceGraph,
    memo: &mut HashMap<usize, String>,
) -> Option<String> {
    let SmartSource::Embedded { bytes, .. } = source else {
        return None;
    };
    let key = std::sync::Arc::as_ptr(bytes) as usize;
    if let Some(hash) = memo.get(&key) {
        return Some(hash.clone());
    }
    let doc = graph.document(source)?;
    let hash = document_hash_with(doc, graph, memo)?;
    memo.insert(key, hash.clone());
    Some(hash)
}

/// 与嵌入源相同的完整语义；不遗漏宿主简化描述之外的文字、蒙版或文档参数。
pub(crate) fn document_hash(doc: &Document, graph: &SourceGraph) -> Option<String> {
    document_hash_with(doc, graph, &mut HashMap::new())
}
fn document_hash_with(
    doc: &Document,
    graph: &SourceGraph,
    memo: &mut HashMap<usize, String>,
) -> Option<String> {
    let layers = semantic_layers(
        &doc.layers,
        graph,
        memo,
        &mut HashMap::new(),
        &mut HashMap::new(),
    )?;
    let mut patterns: Vec<_> = doc.patterns.iter().collect();
    patterns.sort_by(|a, b| a.id.cmp(&b.id));
    let patterns:Vec<_>=patterns.iter().map(|p|json!({"id":p.id,"name":p.name,"width":p.width,"height":p.height,"surface":surface_hash(&p.surface)})).collect();
    let channels:Vec<_>=doc.channels.iter().map(|c|json!({"name":c.name,"surface":surface_hash(&c.surface),"spot":c.spot,"color":c.color,"opacity":c.opacity,"indicates":format!("{:?}",c.indicates)})).collect();
    let hash = digest(
        &json!({"size":doc.size,"mode":doc.mode,"depth":doc.depth,"resolution":doc.resolution_dpi,"light":doc.global_light,
        "icc":doc.icc_profile.as_ref().map(|bytes|format!("{:x}",Sha256::digest(bytes.as_slice()))),"patterns":patterns,"channels":channels,"layers":layers}),
    )?;
    Some(hash)
}
fn semantic_layers(
    layers: &[Layer],
    graph: &SourceGraph,
    memo: &mut HashMap<usize, String>,
    groups: &mut HashMap<u64, usize>,
    links: &mut HashMap<u64, usize>,
) -> Option<Vec<Value>> {
    layers.iter().map(|layer| {
        let body=match &layer.content {
            LayerContent::Raster(surface)=>json!({"kind":"raster","surface":surface_hash(surface)}),
            LayerContent::Text(text)=>json!({"kind":"text","text":text.text,"font":text.font_family,"size":text.size_pt,"color":text.color,
                "transform":affine_identity(&text.transform.m)?,"runs":text.runs,"paragraphs":text.paragraphs,"shape":text.shape,"orientation":text.orientation,"antialias":text.antialias,"warp":text.warp}),
            LayerContent::Adjustment(adjustment)=>json!({"kind":"adjustment","value":adjustment}),
            LayerContent::Group(g)=>json!({"kind":"group","children":semantic_layers(&g.children,graph,memo,groups,links)?}),
            LayerContent::Smart(smart)=>{
                let SmartSource::Embedded{file_name,..}=&smart.source else {return None;};
                json!({"kind":"smart","group":group(groups,smart.contents_id.0),"source":source_hash(&smart.source,graph,memo)?,"name":file_name,"transform":affine_identity(&smart.transform.m)?})
            }
            _=>return None,
        };
        Some(json!({"name":layer.name,"visible":layer.visible,"locks":layer.locks,"blend":layer.blend,"opacity":layer.opacity,"fill":layer.fill_opacity,
            "clipped":layer.clipped,"label":layer.label,"link":layer.link_group.map(|id|group(links,id)),"channels":layer.excluded_channels,"blendIf":layer.blend_if,"advanced":layer.advanced,
            "effects":{"enabled":layer.effects.enabled,"items":layer.effects.items,"reference":layer.effects.reference},
            "mask":layer.mask.as_ref().map(|m|json!({"surface":surface_hash(&m.surface),"enabled":m.enabled,"linked":m.linked,"density":m.density,"feather":m.feather})),"body":body}))
    }).collect()
}
/// 已验证源图复用同一次解析；坏源显式产生不可用摘要，不能回退成像素层名字指纹。
pub(crate) fn attach(doc: &Document, content: &mut Value) {
    let graph = inspect_document_sources(doc).ok();
    let mut memo = HashMap::new();
    fn walk(
        layers: &[Layer],
        items: &mut [Value],
        graph: Option<&SourceGraph>,
        memo: &mut HashMap<usize, String>,
        groups: &mut HashMap<u64, usize>,
    ) {
        for (layer, item) in layers.iter().zip(items) {
            match &layer.content {
                LayerContent::Group(g) => {
                    if let Some(children) = item["children"].as_array_mut() {
                        walk(&g.children, children, graph, memo, groups);
                    }
                }
                LayerContent::Smart(smart) => {
                    let name = match &smart.source {
                        SmartSource::Embedded { file_name, .. } => file_name.as_str(),
                        _ => "",
                    };
                    item["smart"] = json!({"sourceContentHash":graph.and_then(|g|source_hash(&smart.source,g,memo)).unwrap_or_else(||"unsupported".into()),
                        "sourceName":name,"contentsGroup":group(groups,smart.contents_id.0),"transform":smart.transform.m});
                }
                _ => {}
            }
        }
    }
    if let Some(items) = content["layers"].as_array_mut() {
        walk(
            &doc.layers,
            items,
            graph.as_ref(),
            &mut memo,
            &mut HashMap::new(),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use photocraft_doc::{
        Affine, ColorMode, LayerMask, SampleType, Size, SmartContentsId, SmartObject, SmartSource,
        Surface, TextLayer,
    };
    use std::sync::Arc;
    fn source_doc() -> Document {
        let mut doc = Document::new("源", Size::new(16, 12), ColorMode::Rgb, SampleType::U8);
        doc.layers.push(Layer::new(
            "文字",
            LayerContent::Text(TextLayer {
                text: "内容".into(),
                font_family: "Inter".into(),
                ..Default::default()
            }),
        ));
        doc
    }
    fn source(doc: &Document) -> SmartSource {
        SmartSource::Embedded {
            file_name: "source.pcraft".into(),
            bytes: Arc::new(photocraft_format::save_to_bytes(doc, &Default::default()).unwrap()),
        }
    }
    fn outer(child: &Document) -> Document {
        let mut doc = Document::new("父", Size::new(32, 24), ColorMode::Rgb, SampleType::U8);
        doc.layers.push(Layer::new(
            "智能对象",
            LayerContent::Smart(SmartObject::new(source(child), Affine::IDENTITY, None)),
        ));
        doc
    }
    fn hash(doc: &Document) -> Option<String> {
        crate::document_content::document_content_hash(doc, &Default::default())
    }
    fn smart(doc: &mut Document) -> &mut photocraft_doc::SmartObject {
        let LayerContent::Smart(s) = &mut doc.layers[0].content else {
            panic!()
        };
        s
    }
    #[test]
    fn source_identity_ignores_container_metadata_layer_ids_selection_expansion_and_caches() {
        let mut child = source_doc();
        child.layers = vec![Layer::group("组", child.layers)];
        let mut doc = outer(&child);
        let before = hash(&doc).unwrap();
        child.id = photocraft_doc::DocId::fresh();
        child.name = "另存的名字".into();
        child.metadata.xmp = Some("打包信息".into());
        child.selection = Some(LayerMask::reveal_all().surface);
        let format = child.pixel_format();
        let outer_format = doc.pixel_format();
        let LayerContent::Group(g) = &mut child.layers[0].content else {
            panic!()
        };
        g.expanded = false;
        g.children[0].id = photocraft_doc::LayerId::fresh();
        let LayerContent::Text(text) = &mut g.children[0].content else {
            panic!()
        };
        text.cache = Some(Surface::new(format));
        smart(&mut doc).source = source(&child);
        smart(&mut doc).cache = Some(Surface::new(outer_format));
        assert_eq!(hash(&doc).as_deref(), Some(before.as_str()));
        let saved = photocraft_format::save_to_bytes(&doc, &Default::default()).unwrap();
        let loaded = photocraft_format::load_from_bytes_with(
            &saved,
            &photocraft_format::LoadOptions {
                preserve_ids: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(hash(&loaded).as_deref(), Some(before.as_str()));
        let SmartSource::Embedded { file_name, .. } = &mut smart(&mut doc).source else {
            panic!()
        };
        *file_name = "renamed.pcraft".into();
        assert_ne!(hash(&doc).unwrap(), before);
    }
    #[test]
    fn sharing_relationship_is_stable_across_id_renumbering_but_independent_copy_is_content() {
        let mut doc = outer(&source_doc());
        doc.layers.push(doc.layers[0].duplicate());
        let shared = hash(&doc).unwrap();
        let fresh = SmartContentsId::fresh();
        for layer in &mut doc.layers {
            let LayerContent::Smart(s) = &mut layer.content else {
                panic!()
            };
            s.contents_id = fresh;
        }
        assert_eq!(hash(&doc).as_deref(), Some(shared.as_str()));
        let LayerContent::Smart(second) = &mut doc.layers[1].content else {
            panic!()
        };
        second.contents_id = SmartContentsId::fresh();
        assert_ne!(hash(&doc).unwrap(), shared);
    }
    #[test]
    fn full_affine_and_source_text_style_mask_and_adjustment_parameters_change_identity() {
        let child = source_doc();
        let original = outer(&child);
        let baseline = hash(&original).unwrap();
        let mut moved = original.clone();
        smart(&mut moved).transform.m[2] = 1e-8;
        assert_ne!(hash(&moved).unwrap(), baseline);
        let mut resized = child.clone();
        let LayerContent::Text(text) = &mut resized.layers[0].content else {
            panic!()
        };
        text.transform.m[3] = 1.5;
        let mut changed = original.clone();
        smart(&mut changed).source = source(&resized);
        assert_ne!(hash(&changed).unwrap(), baseline);
        let LayerContent::Text(text) = &mut resized.layers[0].content else {
            panic!()
        };
        text.antialias = photocraft_doc::text::AntiAlias::None;
        smart(&mut changed).source = source(&resized);
        let styled = hash(&changed).unwrap();
        assert_ne!(styled, baseline);
        resized.layers[0].mask = Some(LayerMask::reveal_all());
        smart(&mut changed).source = source(&resized);
        let masked = hash(&changed).unwrap();
        resized.layers[0].mask.as_mut().unwrap().density = 0.5;
        smart(&mut changed).source = source(&resized);
        assert_ne!(hash(&changed).unwrap(), masked);
        assert_ne!(masked, styled);
        resized.layers.push(Layer::new(
            "调整",
            LayerContent::Adjustment(photocraft_doc::Adjustment::BrightnessContrast {
                brightness: 0.0,
                contrast: 0.0,
                legacy: false,
            }),
        ));
        smart(&mut changed).source = source(&resized);
        let adjusted = hash(&changed).unwrap();
        let LayerContent::Adjustment(photocraft_doc::Adjustment::BrightnessContrast {
            brightness,
            ..
        }) = &mut resized.layers[1].content
        else {
            panic!()
        };
        *brightness = 0.2;
        smart(&mut changed).source = source(&resized);
        assert_ne!(hash(&changed).unwrap(), adjusted);
    }
    #[test]
    fn nested_source_edit_is_detected_and_bad_source_never_falls_back_to_layer_name() {
        let leaf = source_doc();
        let mut middle = outer(&leaf);
        let mut doc = outer(&middle);
        let baseline = hash(&doc).unwrap();
        let mut edited = leaf.clone();
        let LayerContent::Text(text) = &mut edited.layers[0].content else {
            panic!()
        };
        text.text = "新内容".into();
        smart(&mut middle).source = source(&edited);
        smart(&mut doc).source = source(&middle);
        assert_ne!(hash(&doc).unwrap(), baseline);
        smart(&mut doc).source = SmartSource::Embedded {
            file_name: "broken.pcraft".into(),
            bytes: Arc::new(vec![0, 1]),
        };
        assert!(hash(&doc).is_none());
        smart(&mut doc).source = SmartSource::Linked {
            path: "/not/read".into(),
        };
        assert!(hash(&doc).is_none());
    }
    #[test]
    fn live_parent_and_all_source_roots_share_one_graph_budget() {
        let mut child = source_doc();
        child.layers = vec![child.layers[0].clone(); 32];
        let mut doc = outer(&child);
        doc.layers.push(doc.layers[0].duplicate());
        assert!(hash(&doc).is_none());
        doc.layers.pop();
        let graph = inspect_document_sources(&doc).unwrap();
        assert_eq!(graph.resources.layer_count, 33);
        assert!(graph.document(&smart(&mut doc).source).is_some());
        assert_eq!(graph.documents.len(), 1);
        smart(&mut doc).perspective = Some([1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]);
        assert!(hash(&doc).is_none());
    }
}
