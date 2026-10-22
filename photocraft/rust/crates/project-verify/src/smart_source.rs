//! 嵌入智能对象源的有界解析。只读原生工程，不导入、合成或访问外部文件。
use crate::{
    ProjectSummary, VerifyError, VerifyErrorCode, err, limits, map_load_error,
    verify_container_with,
};
use photocraft_doc::{Document, Layer, LayerContent, SmartSource};
use photocraft_format::{
    ByteSource, FormatError, LoadOptions,
    manifest::{ContentM, LayerM, SmartSourceM},
    zip::ZipReader,
};
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    io::Read,
};

/// 源树的累计资源；相同源的多个实例按实际解析次数计费，不以共享身份豁免预算。
#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceResources {
    pub document_count: usize,
    pub layer_count: usize,
    pub entry_count: usize,
    pub depth: usize,
    pub archive_bytes: u64,
    pub decoded_bytes: u64,
}
/// 通过核验的源快照。summary 描述根文档，resources 覆盖整棵嵌套源树。
pub struct VerifiedSource {
    pub source: SmartSource,
    pub summary: ProjectSummary,
    pub document: Document,
    pub resources: SourceResources,
}
/// 已核验的嵌入文档，保留其不可变源快照供内容身份复用，避免重新解析。
pub struct SourceDocument {
    pub source: SmartSource,
    pub document: std::sync::Arc<Document>,
}
pub struct SourceGraph {
    pub resources: SourceResources,
    pub documents: Vec<SourceDocument>,
}
impl SourceGraph {
    pub fn document(&self, source: &SmartSource) -> Option<&Document> {
        self.documents
            .iter()
            .find(|entry| match (&entry.source, source) {
                (
                    SmartSource::Embedded {
                        file_name: a,
                        bytes: x,
                    },
                    SmartSource::Embedded {
                        file_name: b,
                        bytes: y,
                    },
                ) => a == b && std::sync::Arc::ptr_eq(x, y),
                _ => false,
            })
            .map(|entry| entry.document.as_ref())
    }
}
struct Budget {
    documents: RefCell<Vec<SourceDocument>>,
    used: RefCell<SourceResources>,
    decoded_limit: u64,
    archive_limit: u64,
    entry_limit: usize,
    layer_limit: usize,
    decode_exceeded: Cell<bool>,
}
impl Default for Budget {
    fn default() -> Self {
        Self {
            documents: RefCell::new(Vec::new()),
            used: RefCell::new(SourceResources::default()),
            decoded_limit: limits::MAX_DECOMPRESSED_RESOURCE_BYTES,
            archive_limit: limits::MAX_DECOMPRESSED_RESOURCE_BYTES,
            entry_limit: limits::MAX_ENTRIES,
            layer_limit: limits::MAX_LAYERS,
            decode_exceeded: Cell::new(false),
        }
    }
}
#[derive(Clone, Copy)]
pub(crate) struct Scope<'a> {
    budget: &'a Budget,
    pub depth: usize,
}
impl Scope<'_> {
    pub(crate) fn admit_archive(self, entries: usize) -> Result<(), VerifyError> {
        if self.depth > limits::MAX_DOCUMENT_DEPTH {
            return Err(err(VerifyErrorCode::TooDeep, "智能对象源嵌套层级超限"));
        }
        let mut used = self.budget.used.borrow_mut();
        used.document_count = used.document_count.saturating_add(1);
        used.entry_count = used.entry_count.saturating_add(entries);
        if used.entry_count > self.budget.entry_limit {
            return Err(err(
                VerifyErrorCode::TooManyEntries,
                "智能对象源树的累计条目超限",
            ));
        }
        Ok(())
    }
    pub(crate) fn archive_allowance(self) -> usize {
        self.budget
            .archive_limit
            .saturating_sub(self.budget.used.borrow().archive_bytes)
            .min(limits::MAX_ENTRY_DECOMPRESSED_BYTES as u64) as usize
    }
    pub(crate) fn account_archive(self, bytes: u64) -> Result<(), VerifyError> {
        let mut used = self.budget.used.borrow_mut();
        used.archive_bytes = used.archive_bytes.saturating_add(bytes);
        if used.archive_bytes > self.budget.archive_limit {
            return Err(err(
                VerifyErrorCode::DecompressedTooLarge,
                "智能对象源树的累计容器字节超限",
            ));
        }
        Ok(())
    }
    pub(crate) fn admit_manifest(self, layers: &[LayerM]) -> Result<(), VerifyError> {
        fn walk(scope: Scope<'_>, layers: &[LayerM], depth: usize) -> Result<(), VerifyError> {
            if depth > limits::MAX_DOCUMENT_DEPTH {
                return Err(err(VerifyErrorCode::TooDeep, "智能对象源树的累计层级超限"));
            }
            for layer in layers {
                {
                    let mut used = scope.budget.used.borrow_mut();
                    used.layer_count = used.layer_count.saturating_add(1);
                    used.depth = used.depth.max(depth);
                    if used.layer_count > scope.budget.layer_limit {
                        return Err(err(
                            VerifyErrorCode::TooManyLayers,
                            "智能对象源树的累计图层超限",
                        ));
                    }
                }
                match &layer.content {
                    ContentM::Group { children, .. } if !children.is_empty() => {
                        walk(scope, children, depth + 1)?
                    }
                    ContentM::Smart {
                        source,
                        transform,
                        smart_filters,
                        psd_raw,
                        filter_mask,
                        warp,
                        stack_mode,
                        perspective,
                        ..
                    } => {
                        let SmartSourceM::Embedded { file_name, .. } = source else {
                            return Err(external());
                        };
                        if !native_name(file_name) {
                            return Err(bad_name());
                        }
                        if !transform.m.iter().all(|v| v.is_finite())
                            || !transform.determinant().is_finite()
                            || transform.inverse().is_none()
                            || !smart_filters.is_empty()
                            || psd_raw.is_some()
                            || filter_mask.is_some()
                            || warp.is_some()
                            || stack_mode.is_some()
                            || perspective.is_some()
                        {
                            return Err(err(
                                VerifyErrorCode::UnsupportedObject,
                                "智能对象源包含未开放的滤镜、变形或无效仿射变换",
                            ));
                        }
                    }
                    _ => {}
                }
            }
            Ok(())
        }
        walk(self, layers, self.depth)
    }
    pub(crate) fn load_document(
        self,
        archive: &ZipReader<'_>,
        options: &LoadOptions,
    ) -> Result<Document, VerifyError> {
        let source = BudgetSource {
            archive,
            scope: self,
        };
        photocraft_format::load_bytes_source(&source, options).map_err(|error| {
            if self.budget.decode_exceeded.get() {
                err(
                    VerifyErrorCode::DecompressedTooLarge,
                    "智能对象源树的累计资源解压字节超限",
                )
            } else {
                map_load_error(error)
            }
        })
    }
    pub(crate) fn inspect_document(self, document: &Document) -> Result<(), VerifyError> {
        fn walk(
            scope: Scope<'_>,
            layers: &[Layer],
            depth: usize,
            identities: &mut HashMap<u64, SmartSource>,
        ) -> Result<(), VerifyError> {
            for layer in layers {
                match &layer.content {
                    LayerContent::Group(group) => {
                        walk(scope, &group.children, depth + 1, identities)?
                    }
                    LayerContent::Smart(smart) => {
                        if !smart.transform.m.iter().all(|v| v.is_finite())
                            || !smart.transform.determinant().is_finite()
                            || smart.transform.inverse().is_none()
                            || !smart.smart_filters.is_empty()
                            || smart.psd_raw.is_some()
                            || smart.filter_mask.is_some()
                            || smart.warp.is_some()
                            || smart.stack_mode.is_some()
                            || smart.perspective.is_some()
                        {
                            return Err(err(
                                VerifyErrorCode::UnsupportedObject,
                                "智能对象包含未开放参数或无效变换",
                            ));
                        }
                        if let Some(previous) = identities.get(&smart.contents_id.0) {
                            if previous != &smart.source {
                                return Err(err(
                                    VerifyErrorCode::InvalidManifest,
                                    "同一智能对象共享身份指向不同源",
                                ));
                            }
                        } else {
                            identities.insert(smart.contents_id.0, smart.source.clone());
                        }
                        let (_, child) = load_in(
                            &smart.source,
                            Scope {
                                depth: depth + 1,
                                ..scope
                            },
                        )?;
                        // 只验证仿射变换后源边界，不触发缓存重算、图层边界或效果映射。
                        let [a, b, c, d, e, f] = smart.transform.m;
                        let (w, h) = (f64::from(child.size.width), f64::from(child.size.height));
                        let xs = [e, a * w + e, c * h + e, a * w + c * h + e];
                        let ys = [f, b * w + f, d * h + f, b * w + d * h + f];
                        let bounds = |values: [f64; 4]| {
                            (
                                values.into_iter().fold(f64::INFINITY, f64::min).floor(),
                                values.into_iter().fold(f64::NEG_INFINITY, f64::max).ceil(),
                            )
                        };
                        let (x0, x1) = bounds(xs);
                        let (y0, y1) = bounds(ys);
                        if ![x0, x1, y0, y1].iter().all(|v| {
                            v.is_finite() && *v >= i32::MIN as f64 && *v <= i32::MAX as f64
                        }) || x1 - x0 > f64::from(limits::MAX_CANVAS_SIDE)
                            || y1 - y0 > f64::from(limits::MAX_CANVAS_SIDE)
                            || (x1 - x0) * (y1 - y0) > limits::MAX_CANVAS_PIXELS as f64
                        {
                            return Err(err(
                                VerifyErrorCode::CanvasTooLarge,
                                "智能对象仿射变换后的源边界超限",
                            ));
                        }
                    }
                    _ => {}
                }
            }
            Ok(())
        }
        walk(self, &document.layers, self.depth, &mut HashMap::new())
    }
}
/// 从固定解析器的 ByteSource 入口计费。流式计数不保留第二份解压资源；内容解码和摘要仍由上游负责。
struct BudgetSource<'a, 'b> {
    archive: &'a ZipReader<'b>,
    scope: Scope<'a>,
}
impl ByteSource for BudgetSource<'_, '_> {
    fn get(&self, path: &str, max: usize) -> Result<Vec<u8>, FormatError> {
        let data = self.archive.read_by_name(path, max)?;
        let budget = self.scope.budget;
        let remaining = budget
            .decoded_limit
            .saturating_sub(budget.used.borrow().decoded_bytes);
        let remaining = remaining.min(limits::MAX_ENTRY_DECOMPRESSED_BYTES as u64);
        let amount = if path.starts_with("blobs/") || path.starts_with("tiles/") {
            let decoder = ruzstd::decoding::StreamingDecoder::new(data.as_slice())
                .map_err(|e| FormatError::Corrupt(format!("智能对象资源 zstd 损坏：{e}")))?;
            std::io::copy(
                &mut decoder.take(remaining.saturating_add(1)),
                &mut std::io::sink(),
            )
            .map_err(|e| FormatError::Corrupt(format!("智能对象资源解压失败：{e}")))?
        } else {
            data.len() as u64
        };
        if amount > remaining {
            budget.decode_exceeded.set(true);
            return Err(FormatError::LimitExceeded(
                "智能对象共享资源解压预算超限".into(),
            ));
        }
        budget.used.borrow_mut().decoded_bytes += amount;
        Ok(data)
    }
}
fn external() -> VerifyError {
    err(
        VerifyErrorCode::ExternalReference,
        "智能对象仅支持嵌入源，不读取外部文件",
    )
}
fn bad_name() -> VerifyError {
    err(
        VerifyErrorCode::UnsupportedObject,
        "智能对象源须为有效名称的 .pcraft 原生工程",
    )
}
fn native_name(name: &str) -> bool {
    !name.trim().is_empty()
        && name.encode_utf16().count() <= 200
        && !name
            .chars()
            .any(|c| c.is_control() || matches!(c, '/' | '\\' | ':'))
        && name.rsplit_once('.').is_some_and(|(stem, ext)| {
            !stem.trim().is_empty() && ext.eq_ignore_ascii_case("pcraft")
        })
}
fn load_in(
    source: &SmartSource,
    scope: Scope<'_>,
) -> Result<(ProjectSummary, std::sync::Arc<Document>), VerifyError> {
    let SmartSource::Embedded { file_name, bytes } = source else {
        return Err(external());
    };
    if !native_name(file_name) {
        return Err(bad_name());
    }
    let (summary, document) = verify_container_with(bytes, false, Some(scope))?;
    let result = (summary, std::sync::Arc::new(document));
    scope.budget.documents.borrow_mut().push(SourceDocument {
        source: source.clone(),
        document: result.1.clone(),
    });
    Ok(result)
}
/// 核验整个嵌入原生源树。组和源共享层数/深度、ZIP 条目和两级解压预算；不生成合成缓存。
/// 此专用入口不放宽普通工程上传或编辑器的能力清单。
pub fn load(source: &SmartSource) -> Result<VerifiedSource, VerifyError> {
    let budget = Budget::default();
    let (summary, document) = load_in(
        source,
        Scope {
            budget: &budget,
            depth: 1,
        },
    )?;
    let resources = budget.used.into_inner();
    drop(budget.documents);
    let document = std::sync::Arc::unwrap_or_clone(document);
    Ok(VerifiedSource {
        source: source.clone(),
        summary,
        document,
        resources,
    })
}

/// 宿主显式请求的嵌入工程核验；根容器与全部源共用同一预算。
/// 不改变普通 verify 或上传能力门。
pub fn verify_project(bytes: &[u8]) -> Result<ProjectSummary, VerifyError> {
    let budget = Budget::default();
    verify_container_with(bytes, false, Some(Scope { budget: &budget, depth: 1 }))
        .map(|(summary, _)| summary)
}

/// 核验活动文档引用的整棵源树，并复用已解析文档。父文档本身不重新编码或渲染。
pub fn inspect_document_sources(document: &Document) -> Result<SourceGraph, VerifyError> {
    if document.mode != photocraft_doc::ColorMode::Rgb
        || document.depth != photocraft_doc::SampleType::U8
    {
        return Err(err(
            VerifyErrorCode::UnsupportedObject,
            "智能对象宿主仅支持 RGB/U8",
        ));
    }
    let mut inspection = crate::LayerInspection::default();
    crate::inspect_layers(&document.layers, 1, &mut inspection, true)?;
    let budget = Budget::default();
    *budget.used.borrow_mut() = SourceResources {
        document_count: 1,
        layer_count: inspection.count,
        depth: inspection.depth,
        ..Default::default()
    };
    Scope {
        budget: &budget,
        depth: 1,
    }
    .inspect_document(document)?;
    Ok(SourceGraph {
        resources: budget.used.into_inner(),
        documents: budget.documents.into_inner(),
    })
}

#[cfg(test)]
#[path = "smart_source/tests.rs"]
mod tests;
