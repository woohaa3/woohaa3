//! 智能对象源替换的候选、重算与原子提交。只有事务 finish 执行渲染。
use crate::{EditorError, Result};
use photocraft_doc::{Document, LayerContent, LayerId, SmartSource};
use photocraft_engine::{DocState, Session};
use photocraft_project_verify::smart_source::{SourceGraph, inspect_document_sources};
use std::sync::Arc;

/// 调用方确认修订仍匹配后，才能将候选文档及所选集合提交为一步历史。
/// 图中解析文档供后续内容身份和源重算复用；本模块不开放编辑入口。
pub struct PreparedSourceEdit {
    pub document: Document,
    pub instances: Vec<LayerId>,
    pub sources: SourceGraph,
}

/// 源替换的一次会话事务；候选和基线不向调用方暴露可写引用。
/// 构造后可以直接丢弃来取消，不修改文档或子编辑器关联。
pub struct SourceEditTransaction {
    base: DocState,
    prepared: PreparedSourceEdit,
    contents_id: photocraft_doc::SmartContentsId,
}

/// 独立的内容编辑基线。子文档可在自己的编辑器中修改，不注册自动回写关联。
pub struct SourceContentsEdit {
    transaction: SourceEditTransaction,
    layer: LayerId,
    document: Document,
    hash: String,
}

impl SourceContentsEdit {
    pub fn new(session: &Session, layer: LayerId) -> Result<Self> {
        let state = session.active().ok_or(EditorError::NoDocument)?;
        let source = match state.doc.layer(layer).map(|item| &item.content) {
            Some(LayerContent::Smart(smart)) => smart.source.clone(),
            _ => return Err(error("请先选择智能对象图层")),
        };
        let transaction = SourceEditTransaction::new(session, layer, source.clone())?;
        let document = transaction
            .prepared
            .sources
            .document(&source)
            .ok_or_else(|| error("源文档不在核验图中"))?
            .clone();
        let hash = contents_hash(&document)?;
        Ok(Self {
            transaction,
            layer,
            document,
            hash,
        })
    }

    pub fn document(&self) -> &Document {
        &self.document
    }

    /// 返回前先准备完整父文档事务；失败后可保留子编辑器并修正重试。
    /// 不生成预览，不修改父文档或子编辑器关联；finish 才重算并提交。
    pub fn prepare(&self, session: &Session, edited: &Document) -> Result<SourceEditTransaction> {
        self.transaction.check_base(session)?;
        inspect_document_sources(edited).map_err(|failure| error(failure.message))?;
        let LayerContent::Smart(original) =
            &self.transaction.base.doc.layer(self.layer).unwrap().content
        else {
            unreachable!("构造时已核验目标")
        };
        // 交互状态或容器变化不重打包，保留原字节、外观和旧子关联。
        let source = if contents_hash(edited)? == self.hash {
            original.source.clone()
        } else {
            let SmartSource::Embedded { file_name, .. } = &original.source else {
                return Err(error("不支持外链源"));
            };
            SmartSource::Embedded {
                file_name: file_name.clone(),
                bytes: Arc::new(
                    photocraft_format::save_to_bytes(edited, &Default::default()).map_err(error)?,
                ),
            }
        };
        let prepared = prepare(&self.transaction.base.doc, self.layer, source)?;
        Ok(SourceEditTransaction {
            base: self.transaction.base.clone(),
            prepared,
            contents_id: self.transaction.contents_id,
        })
    }
}

fn contents_hash(document: &Document) -> Result<String> {
    let graph = inspect_document_sources(document).map_err(|failure| error(failure.message))?;
    crate::smart_identity::document_hash(document, &graph)
        .ok_or_else(|| error("无法计算源内容身份"))
}

impl SourceEditTransaction {
    pub fn new(session: &Session, layer: LayerId, source: SmartSource) -> Result<Self> {
        let base = session.active().ok_or(EditorError::NoDocument)?.clone();
        let prepared = prepare(&base.doc, layer, source)?;
        let LayerContent::Smart(smart) = &base.doc.layer(layer).unwrap().content else {
            unreachable!("prepare 已核验目标类型")
        };
        let contents_id = smart.contents_id;
        Ok(Self {
            base,
            prepared,
            contents_id,
        })
    }

    fn check_base(&self, session: &Session) -> Result<()> {
        let current = session.active().ok_or(EditorError::NoDocument)?;
        if current.revision != self.base.revision
            || !Arc::ptr_eq(&current.doc, &self.base.doc)
            || current.active_layer != self.base.active_layer
            || current.selected_layers() != self.base.selected_layers()
            || current.layer_anchor != self.base.layer_anchor
        {
            return Err(error("文档或编辑目标已变化，请重新替换源"));
        }
        Ok(())
    }

    /// 先在候选重算全部共享实例，全部成功后发布一步历史。
    /// 本方法走真实刷新；单元测试用 `finish_with` 替身，未覆盖成功路径的真实刷新。
    pub fn finish(self, session: &mut Session) -> Result<Vec<LayerId>> {
        self.finish_using(session, crate::smart_source_render::refresh_instances)
    }

    #[cfg(test)]
    fn finish_with(
        self,
        session: &mut Session,
        mut refresh: impl FnMut(&mut Document, LayerId) -> Result<()>,
    ) -> Result<Vec<LayerId>> {
        self.finish_using(session, |document, ids, _| {
            for id in ids {
                refresh(document, *id)?;
            }
            Ok(())
        })
    }

    fn finish_using(
        mut self,
        session: &mut Session,
        refresh: impl FnOnce(&mut Document, &[LayerId], &SourceGraph) -> Result<()>,
    ) -> Result<Vec<LayerId>> {
        self.check_base(session)?;
        if self.prepared.instances.is_empty() {
            return Ok(Vec::new());
        }
        refresh(
            &mut self.prepared.document,
            &self.prepared.instances,
            &self.prepared.sources,
        )?;
        for id in &self.prepared.instances {
            if !matches!(self.prepared.document.layer(*id).map(|layer| &layer.content),
                Some(LayerContent::Smart(smart)) if smart.cache.is_some())
            {
                return Err(error("智能对象重算未返回外观，未替换内容"));
            }
        }
        self.check_base(session)?;
        crate::preview_history::commit_selected(
            session,
            Arc::new(self.prepared.document),
            self.base.active_layer,
            self.base.selected_layers(),
            "替换智能对象内容",
        )
        .map_err(error)?;
        if let Some(state) = session.active_mut() {
            state.layer_anchor = self.base.layer_anchor;
        }
        // 只在成功发布后断开旧子编辑器；它仍可留在会话中，但不能回写旧源。
        session
            .smart_links
            .retain(|link| link.parent != self.base.doc.id || link.contents_id != self.contents_id);
        Ok(self.prepared.instances)
    }
}

fn error(message: impl std::fmt::Display) -> EditorError {
    EditorError::CommandFailed {
        id: "smart.replaceSource".into(),
        message: message.to_string(),
    }
}

/// 替换当前文档中共享同一 contents_id 的所有实例，包括组内和隐藏实例。
/// 保留每个实例的完整仿射、蒙版及图层属性；独立副本和嵌套源文档不受影响。
/// 整份候选文档共用源树预算，任何失败都不修改输入，也不发布部分替换。
pub fn prepare(
    document: &Document,
    layer: LayerId,
    source: SmartSource,
) -> Result<PreparedSourceEdit> {
    // 先验证旧状态，不能通过替换掩盖坏源、共享身份冲突或未支持的参数。
    inspect_document_sources(document).map_err(|failure| error(failure.message))?;
    let target = document
        .layer(layer)
        .ok_or_else(|| error("目标图层不存在"))?;
    let LayerContent::Smart(target) = &target.content else {
        return Err(error("请先选择智能对象图层"));
    };
    let contents_id = target.contents_id;
    let instances: Vec<_> = document
        .walk()
        .into_iter()
        .filter_map(|(_, _, item)| {
            matches!(&item.content, LayerContent::Smart(smart) if smart.contents_id == contents_id)
                .then_some(item.id)
        })
        .collect();
    // 共享源的内容替换不是局部绘画：锁定实例仍须保持同源关系。
    // 全部锁定任一实例或其父组时，整次拒绝，不把它变成独立副本。
    if instances.iter().any(|id| document.effective_locks(*id).all) {
        return Err(error("共享智能对象或其父组已全部锁定，请先解锁"));
    }
    let unchanged = target.source == source;
    let mut candidate = document.clone();
    if !unchanged {
        for id in &instances {
            let item = candidate
                .layer_mut(*id)
                .ok_or_else(|| error("共享实例不存在"))?;
            let LayerContent::Smart(smart) = &mut item.content else {
                return Err(error("共享实例类型已变化"));
            };
            smart.source = source.clone();
            // 旧外观不得作为新源的可保存或可显示结果。
            smart.cache = None;
        }
    }
    let sources = inspect_document_sources(&candidate).map_err(|failure| error(failure.message))?;
    Ok(PreparedSourceEdit {
        document: candidate,
        instances: if unchanged { Vec::new() } else { instances },
        sources,
    })
}

#[cfg(test)]
#[path = "smart_source_edit/tests.rs"]
mod tests;
