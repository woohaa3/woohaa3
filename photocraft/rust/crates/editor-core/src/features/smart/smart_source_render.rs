//! 从已核验源图恢复文字和嵌套对象，再按原生合成与放置语义生成外观。
use crate::{EditorError, Result};
use photocraft_doc::{
    Affine, Document, Layer, LayerContent, LayerId, PixelFormat, Rect, SmartSource, Surface,
    TextLayer,
};
use photocraft_project_verify::{limits, smart_source::SourceGraph};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

fn error(message: impl std::fmt::Display) -> EditorError {
    EditorError::CommandFailed {
        id: "smart.replaceSource".into(),
        message: message.to_string(),
    }
}

/// 两类工作量各自累计，不以稀疏像素或共享身份跳过实例放置。
/// 这是合成/放置像素预算，不是 GPU 性能或总内存上限。
#[derive(Default)]
struct Work {
    source_pixels: u64,
    placed_pixels: u64,
}
impl Work {
    fn charge(used: &mut u64, pixels: u64) -> Result<()> {
        let next = used
            .checked_add(pixels)
            .filter(|n| *n <= limits::MAX_CANVAS_PIXELS)
            .ok_or_else(|| error("智能对象累计重算像素超限"))?;
        *used = next;
        Ok(())
    }
}

trait Backend {
    fn text(&mut self, text: &mut TextLayer, dpi: f32, format: PixelFormat) -> Result<()>;
    fn composite(&mut self, document: &Document) -> Result<Surface>;
    fn place(&mut self, surface: &Surface, bounds: Rect, transform: &Affine) -> Result<Surface>;
}
struct Native;
impl Backend for Native {
    fn text(&mut self, text: &mut TextLayer, dpi: f32, format: PixelFormat) -> Result<()> {
        text.cache = None;
        photocraft_text::shared()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .render_layer(text, dpi, format);
        Ok(())
    }
    fn composite(&mut self, document: &Document) -> Result<Surface> {
        Ok(photocraft_compose::flatten_to_surface(
            document,
            document.pixel_format(),
            None,
        ))
    }
    fn place(&mut self, surface: &Surface, bounds: Rect, transform: &Affine) -> Result<Surface> {
        photocraft_algo::warp::place_source(surface, bounds, transform, None).map_err(error)
    }
}

#[derive(Hash, PartialEq, Eq, Clone)]
struct SourceKey(String, usize);
fn key(source: &SmartSource) -> Result<SourceKey> {
    match source {
        SmartSource::Embedded { file_name, bytes } => {
            Ok(SourceKey(file_name.clone(), Arc::as_ptr(bytes) as usize))
        }
        _ => Err(error("智能对象重算不读取外部源")),
    }
}
struct Image {
    surface: Surface,
    bounds: Rect,
}
struct Renderer<'a, B> {
    graph: &'a SourceGraph,
    backend: B,
    images: HashMap<SourceKey, Arc<Image>>,
    visiting: HashSet<SourceKey>,
    work: Work,
}
impl<'a, B: Backend> Renderer<'a, B> {
    fn new(graph: &'a SourceGraph, backend: B) -> Self {
        Self {
            graph,
            backend,
            images: HashMap::new(),
            visiting: HashSet::new(),
            work: Work::default(),
        }
    }
    fn source(&mut self, source: &SmartSource) -> Result<Arc<Image>> {
        let key = key(source)?;
        if let Some(image) = self.images.get(&key) {
            return Ok(image.clone());
        }
        if !self.visiting.insert(key.clone()) {
            return Err(error("智能对象源图存在循环"));
        }
        if self.visiting.len() > limits::MAX_DOCUMENT_DEPTH {
            return Err(error("智能对象重算层级超限"));
        }
        let mut document = self
            .graph
            .document(source)
            .ok_or_else(|| error("源不在已核验文档图中"))?
            .clone();
        Work::charge(
            &mut self.work.source_pixels,
            u64::from(document.size.width) * u64::from(document.size.height),
        )?;
        let (dpi, format) = (document.resolution_dpi, document.pixel_format());
        self.layers(&mut document.layers, dpi, format)?;
        let image = Arc::new(Image {
            bounds: document.bounds(),
            surface: self.backend.composite(&document)?,
        });
        self.visiting.remove(&key);
        self.images.insert(key, image.clone());
        Ok(image)
    }
    fn layers(&mut self, layers: &mut [Layer], dpi: f32, format: PixelFormat) -> Result<()> {
        for layer in layers {
            match &mut layer.content {
                LayerContent::Group(group) => self.layers(&mut group.children, dpi, format)?,
                LayerContent::Text(text) => {
                    text.cache = None;
                    self.backend.text(text, dpi, format)?;
                    if text.cache.is_none() {
                        return Err(error("源文字重算未返回外观"));
                    }
                }
                LayerContent::Smart(smart) => {
                    smart.cache = None;
                    let source = self.source(&smart.source)?;
                    Self::charge_placement(&mut self.work, source.bounds, &smart.transform)?;
                    smart.cache = Some(self.backend.place(
                        &source.surface,
                        source.bounds,
                        &smart.transform,
                    )?);
                }
                LayerContent::Raster(_) | LayerContent::Adjustment(_) => {}
                _ => return Err(error("源包含未开放的重算内容")),
            }
        }
        Ok(())
    }
    fn charge_placement(work: &mut Work, bounds: Rect, transform: &Affine) -> Result<()> {
        let corners = [
            (bounds.x0, bounds.y0),
            (bounds.x1, bounds.y0),
            (bounds.x0, bounds.y1),
            (bounds.x1, bounds.y1),
        ]
        .map(|(x, y)| transform.apply(photocraft_geom::Point::new(f64::from(x), f64::from(y))));
        let width = corners
            .iter()
            .map(|p| p.x)
            .fold(f64::NEG_INFINITY, f64::max)
            .ceil()
            - corners
                .iter()
                .map(|p| p.x)
                .fold(f64::INFINITY, f64::min)
                .floor();
        let height = corners
            .iter()
            .map(|p| p.y)
            .fold(f64::NEG_INFINITY, f64::max)
            .ceil()
            - corners
                .iter()
                .map(|p| p.y)
                .fold(f64::INFINITY, f64::min)
                .floor();
        let pixels = width * height;
        if !pixels.is_finite()
            || width < 0.0
            || height < 0.0
            || pixels > limits::MAX_CANVAS_PIXELS as f64
        {
            return Err(error("智能对象放置像素超限"));
        }
        Work::charge(&mut work.placed_pixels, pixels as u64)
    }
    fn refresh(&mut self, document: &mut Document, id: LayerId) -> Result<()> {
        let layer = document
            .layer_mut(id)
            .ok_or_else(|| error("智能对象实例不存在"))?;
        let LayerContent::Smart(smart) = &mut layer.content else {
            return Err(error("目标不是智能对象"));
        };
        let image = self.source(&smart.source)?;
        Self::charge_placement(&mut self.work, image.bounds, &smart.transform)?;
        smart.cache = Some(
            self.backend
                .place(&image.surface, image.bounds, &smart.transform)?,
        );
        Ok(())
    }
}

/// 只用于私有候选。失败时调用方丢弃候选，不能发布已完成的部分实例。
pub(crate) fn refresh_instances(
    document: &mut Document,
    ids: &[LayerId],
    graph: &SourceGraph,
) -> Result<()> {
    let mut renderer = Renderer::new(graph, Native);
    for id in ids {
        renderer.refresh(document, *id)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use photocraft_doc::{ColorMode, SampleType, Size, SmartObject};
    use photocraft_project_verify::smart_source::{SourceDocument, inspect_document_sources};

    #[derive(Default)]
    struct Fake {
        events: Vec<String>,
        placements: Vec<(Rect, Affine)>,
        fail: Option<&'static str>,
        omit_text_cache: bool,
    }
    impl Backend for Fake {
        fn text(&mut self, text: &mut TextLayer, dpi: f32, format: PixelFormat) -> Result<()> {
            assert!(text.cache.is_none());
            self.events.push(format!("text:{}:{dpi}", text.text));
            if !self.omit_text_cache {
                text.cache = Some(Surface::new(format));
            }
            Ok(())
        }
        fn composite(&mut self, document: &Document) -> Result<Surface> {
            assert!(
                document
                    .walk()
                    .iter()
                    .all(|(_, _, layer)| match &layer.content {
                        LayerContent::Text(t) => t.cache.is_some(),
                        LayerContent::Smart(s) => s.cache.is_some(),
                        _ => true,
                    })
            );
            self.events.push(format!("composite:{}", document.name));
            if self.fail == Some("composite") {
                return Err(error("合成失败"));
            }
            Ok(Surface::new(document.pixel_format()))
        }
        fn place(
            &mut self,
            surface: &Surface,
            bounds: Rect,
            transform: &Affine,
        ) -> Result<Surface> {
            self.placements.push((bounds, *transform));
            self.events.push("place".into());
            if self.fail == Some("place") {
                return Err(error("放置失败"));
            }
            Ok(Surface::new(surface.format()))
        }
    }
    fn source(document: &Document) -> SmartSource {
        SmartSource::Embedded {
            file_name: format!("{}.pcraft", document.name),
            bytes: Arc::new(
                photocraft_format::save_to_bytes(document, &Default::default()).unwrap(),
            ),
        }
    }
    fn doc(name: &str, width: u32, height: u32) -> Document {
        Document::new(
            name,
            Size::new(width, height),
            ColorMode::Rgb,
            SampleType::U8,
        )
    }
    fn fixture() -> (Document, SourceGraph, Vec<LayerId>, Affine) {
        let mut leaf = doc("leaf", 16, 12);
        leaf.resolution_dpi = 144.0;
        leaf.layers.push(Layer::new(
            "文字",
            LayerContent::Text(TextLayer {
                text: "重建".into(),
                cache: Some(Surface::new(leaf.pixel_format())),
                ..Default::default()
            }),
        ));
        let mut middle = doc("middle", 32, 24);
        let nested = Affine {
            m: [1.0, 0.0, 0.0, 1.0, 2.0, 3.0],
        };
        middle.layers.push(Layer::group(
            "组",
            vec![Layer::new(
                "嵌套",
                LayerContent::Smart(SmartObject::new(
                    source(&leaf),
                    nested,
                    Some(Surface::new(middle.pixel_format())),
                )),
            )],
        ));
        let mut root = doc("root", 64, 48);
        let a = Layer::new(
            "A",
            LayerContent::Smart(SmartObject::new(source(&middle), Affine::IDENTITY, None)),
        );
        let mut b = a.duplicate();
        let LayerContent::Smart(s) = &mut b.content else {
            unreachable!()
        };
        s.transform.m = [1.0, 0.0, 0.0, 1.0, 5.5, -2.0];
        let ids = vec![a.id, b.id];
        root.layers = vec![a, b];
        let graph = inspect_document_sources(&root).unwrap();
        (root, graph, ids, nested)
    }
    #[test]
    fn rebuilds_nested_and_text_caches_once_per_source_then_places_each_instance() {
        let (mut root, graph, ids, nested) = fixture();
        let original: Vec<_> = graph.documents.iter().map(|d| d.document.clone()).collect();
        let mut renderer = Renderer::new(&graph, Fake::default());
        for id in &ids {
            renderer.refresh(&mut root, *id).unwrap();
        }
        assert_eq!(
            renderer.backend.events,
            vec![
                "text:重建:144",
                "composite:leaf",
                "place",
                "composite:middle",
                "place",
                "place"
            ]
        );
        assert_eq!(
            renderer.backend.placements[0],
            (Rect::new(0, 0, 16, 12), nested)
        );
        assert_eq!(
            renderer.backend.placements[1],
            (Rect::new(0, 0, 32, 24), Affine::IDENTITY)
        );
        assert_eq!(
            renderer.backend.placements[2].1.m,
            [1.0, 0.0, 0.0, 1.0, 5.5, -2.0]
        );
        assert_eq!(renderer.images.len(), 2);
        assert_eq!(renderer.work.source_pixels, 16 * 12 + 32 * 24);
        assert_eq!(renderer.work.placed_pixels, 16 * 12 + 32 * 24 + 33 * 24);
        for (old, current) in original.iter().zip(&graph.documents) {
            assert_eq!(old, &current.document);
        }
        assert!(ids.iter().all(|id| matches!(&root.layer(*id).unwrap().content,LayerContent::Smart(s) if s.cache.is_some())));
    }
    #[test]
    fn rejects_missing_source_external_source_and_cycle_without_compositing() {
        let (root, graph, ids, _) = fixture();
        let mut renderer = Renderer::new(&graph, Fake::default());
        assert!(
            renderer
                .source(&SmartSource::Linked {
                    path: "/never/read".into()
                })
                .is_err()
        );
        let unknown = source(&doc("unknown", 1, 1));
        assert!(renderer.source(&unknown).is_err());
        assert!(renderer.backend.events.is_empty());
        let LayerContent::Smart(smart) = &root.layer(ids[0]).unwrap().content else {
            unreachable!()
        };
        // 防御被错误装配的图；真实源图已在有界解析中排除循环。
        let malformed = SourceGraph {
            resources: Default::default(),
            documents: vec![SourceDocument {
                source: smart.source.clone(),
                document: Arc::new(root.clone()),
            }],
        };
        let mut renderer = Renderer::new(&malformed, Fake::default());
        assert!(
            renderer
                .source(&smart.source)
                .err()
                .unwrap()
                .to_string()
                .contains("循环")
        );
        assert!(renderer.backend.events.is_empty());
    }
    #[test]
    fn composite_place_and_missing_text_cache_fail_without_publishing_source_images() {
        for (fail, omit) in [
            (Some("composite"), false),
            (Some("place"), false),
            (None, true),
        ] {
            let (mut root, graph, ids, _) = fixture();
            let before = root.clone();
            let mut renderer = Renderer::new(
                &graph,
                Fake {
                    fail,
                    omit_text_cache: omit,
                    ..Default::default()
                },
            );
            assert!(renderer.refresh(&mut root, ids[0]).is_err());
            assert_eq!(root, before);
            // 失败源不能成为可复用的合成结果；可能已完成的叶源仅属于本次渲染器。
            assert!(renderer.images.len() <= 1);
        }
    }
    #[test]
    fn cumulative_work_and_fractional_bounds_are_charged_before_backend_calls() {
        let mut used = 0;
        Work::charge(&mut used, limits::MAX_CANVAS_PIXELS).unwrap();
        assert!(Work::charge(&mut used, 1).is_err());
        assert_eq!(used, limits::MAX_CANVAS_PIXELS);
        let (mut root, graph, ids, _) = fixture();
        let mut renderer = Renderer::new(&graph, Fake::default());
        renderer.work.source_pixels = limits::MAX_CANVAS_PIXELS;
        assert!(renderer.refresh(&mut root, ids[0]).is_err());
        assert!(renderer.backend.events.is_empty());
        let mut renderer = Renderer::new(&graph, Fake::default());
        renderer.work.placed_pixels = limits::MAX_CANVAS_PIXELS;
        assert!(renderer.refresh(&mut root, ids[0]).is_err());
        assert!(renderer.backend.placements.is_empty());
        let mut work = Work::default();
        Renderer::<Fake>::charge_placement(
            &mut work,
            Rect::new(0, 0, 10, 10),
            &Affine {
                m: [1.0, 0.0, 1e-8, 1.0, 0.0, 0.0],
            },
        )
        .unwrap();
        assert_eq!(work.placed_pixels, 110);
        assert!(
            Renderer::<Fake>::charge_placement(
                &mut work,
                Rect::new(0, 0, 10, 10),
                &Affine {
                    m: [f64::INFINITY, 0.0, 0.0, 1.0, 0.0, 0.0]
                }
            )
            .is_err()
        );
    }
}
