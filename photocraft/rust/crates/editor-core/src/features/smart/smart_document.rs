//! 嵌入智能对象的子文档会话：关联、基线、幂等回写与冲突恢复
//! （change: 2026-10-22-complete-photocraft-webui-editing，P4 / design D7）。
//!
//! 复用已有 `smart_convert` / `smart_copy` / `smart_source_edit` / `smart_source_render` /
//! `smart_identity`，不重新实现一套源关系。本模块只补三件此前缺失的事：
//!
//! 1. **子文档关联**：父文档身份／修订、`contents_id`、源 hash 与父基线，供回写核对。
//! 2. **原子回写**：完整候选父文档 → 重算全部共享实例 → 一步父历史；失败无部分更新。
//! 3. **幂等 Attempt**：同一 `attemptId` 的重试返回原结果（提交成功但回执丢失时不会重复提交）。
//!
//! 冲突（父修订变化、父关闭、只读、源失效）一律不覆盖：保留子文档，由 UI 提供
//! 「重载父源／导出子工程／建立独立对象副本」三条显式恢复路径。

use std::collections::BTreeMap;
use std::sync::Arc;

use photocraft_doc::{LayerContent, LayerId};
use serde_json::{Value, json};

use crate::document_content;
use crate::error::{EditorError, Result};

fn error(message: impl std::fmt::Display) -> EditorError {
    EditorError::CommandFailed { id: "layer.smartObjects.editContents".into(), message: message.to_string() }
}

/// 一个打开中的子文档会话。
#[derive(Clone)]
struct ChildSession {
    layer: LayerId,
    contents_id: u64,
    /// 打开时子文档的内容身份（用于「无变化不增历史」）。
    source_hash: String,
    parent_doc: photocraft_doc::DocId,
    /// 打开时的父修订；父内容变化即保守视为冲突。
    parent_revision: u64,
    /// 父基线内容指纹（与父文档比对，避免只靠修订号）。
    parent_content_hash: String,
}

/// 一次回写尝试的结果（同一 attemptId 重试返回同一份）。
#[derive(Clone)]
struct AttemptRecord {
    /// 产生该回执的子会话代号：只有同一会话内的重试才算重试。
    epoch: u64,
    result: Value,
}

/// 子文档协调状态；挂在 `Editor` 上，随父文档生命周期释放。
#[derive(Default)]
pub(crate) struct SmartChildState {
    child: Option<ChildSession>,
    attempts: BTreeMap<String, AttemptRecord>,
    /// 子会话代号：每次新开／重载／分离都递增，用于把回执限定在产生它的那次会话内。
    ///
    /// UI 的回执键是「子文档修订号」（`ui-child-<revision>`），关闭再打开同一对象、
    /// 或重载父源后子修订会回到同一个数，不能因此把新编辑当成旧回执。
    epoch: u64,
    /// 关联失效原因（父关闭／删层／撤销源／只读），供 UI 提示恢复路径。
    invalidated: Option<String>,
}

impl SmartChildState {
    /// 清空会话（父文档关闭/替换时调用）。
    pub fn clear(&mut self) {
        self.child = None;
        self.invalidated = None;
        self.attempts.clear();
        self.epoch += 1;
    }

    /// 开始新的子会话：旧会话的回执不再有效。
    fn begin_session(&mut self) {
        self.attempts.clear();
        self.epoch += 1;
    }

    /// 会话关联改变（重载基线／分离到新副本）：回执同样作废。
    fn rekey_session(&mut self) {
        self.attempts.clear();
        self.epoch += 1;
    }

    /// 当前子会话绑定的父层。
    pub fn layer(&self) -> Option<LayerId> {
        self.child.as_ref().map(|child| child.layer)
    }
}

/// 尝试记录上限：只用于回执重试，不需要无限增长。
const MAX_ATTEMPTS: usize = 64;

impl super::Editor {
    /// 打开「编辑内容」：返回子文档工程字节与关联信息。
    ///
    /// 同一父源复用已打开的子文档（返回 `reused: true` 且仍给出当前源字节）。
    pub fn begin_smart_child(&mut self, layer: u64) -> Result<Value> {
        self.require_no_stroke()?;
        let state = self.active_doc()?.clone();
        let id = LayerId(layer);
        let LayerContent::Smart(smart) = &state.doc.layer(id).ok_or_else(|| error("目标图层不存在"))?.content else {
            return Err(error("请先选择智能对象图层"));
        };
        // 复用已打开的同源子文档。
        if let Some(child) = &self.smart_child.child {
            if child.layer == id
                && child.contents_id == smart.contents_id.0
                && child.parent_doc == state.doc.id
            {
                let edit = crate::smart_source_edit::SourceContentsEdit::new(&self.session, id)
                    .map_err(|failure| error(failure.message()))?;
                let project = photocraft_format::save_to_bytes(edit.document(), &Default::default())
                    .map_err(|failure| error(format!("子文档序列化失败：{failure}")))?;
                return Ok(json!({
                    "layer": id.0,
                    "contentsId": child.contents_id,
                    "sourceHash": child.source_hash,
                    "parentRevision": child.parent_revision,
                    "parentContentHash": child.parent_content_hash,
                    "reused": true,
                    "project": crate::psd::bytes_json(&project),
                }));
            }
            // 换了一个源：旧子文档仍是独立文档，不能静默丢弃；这里拒绝并要求先结算。
            return Err(error("已有一个子文档在编辑中；请先回写或导出再打开另一个"));
        }
        let contents_id = smart.contents_id.0;
        let edit = crate::smart_source_edit::SourceContentsEdit::new(&self.session, id)
            .map_err(|failure| error(failure.message()))?;
        let source_hash = crate::smart_identity::document_hash(
            edit.document(),
            &photocraft_project_verify::smart_source::inspect_document_sources(edit.document())
                .map_err(|failure| error(failure.message))?,
        )
        .ok_or_else(|| error("无法计算子文档内容身份"))?;
        let parent_content_hash = self.content_hash()?;
        let project = photocraft_format::save_to_bytes(edit.document(), &Default::default())
            .map_err(|failure| error(format!("子文档序列化失败：{failure}")))?;
        self.smart_child.begin_session();
        self.smart_child.child = Some(ChildSession {
            layer: id,
            contents_id,
            source_hash: source_hash.clone(),
            parent_doc: state.doc.id,
            parent_revision: state.revision,
            parent_content_hash: parent_content_hash.clone(),
        });
        self.smart_child.invalidated = None;
        Ok(json!({
            "layer": id.0,
            "contentsId": contents_id,
            "sourceHash": source_hash,
            "parentRevision": state.revision,
            "parentContentHash": parent_content_hash,
            "reused": false,
            "project": crate::psd::bytes_json(&project),
        }))
    }

    /// 回写父文档：完整候选 → 重算共享实例 → 一步父历史。
    ///
    /// `attemptId` 是幂等键：**同一子会话内**的重试返回第一次的结果，不重复提交历史。
    /// 关闭/重开、重载父源、分离副本都会开新会话，旧回执随之作废——UI 用的是子修订号
    /// 做键，新会话可能回到同一个数，不能把新编辑当成旧回执丢掉。
    /// `child` 是子文档 `.pcraft` 字节（调用方从自己的编辑器导出）。
    pub fn update_smart_parent(&mut self, attempt_id: &str, child: &[u8]) -> Result<Value> {
        if attempt_id.trim().is_empty() || attempt_id.len() > 200 {
            return Err(error("attemptId 必须是 1–200 字符"));
        }
        let epoch = self.smart_child.epoch;
        if let Some(record) = self.smart_child.attempts.get(attempt_id)
            && record.epoch == epoch
        {
            let mut replay = record.result.clone();
            if let Some(obj) = replay.as_object_mut() {
                obj.insert("replayed".into(), json!(true));
            }
            return Ok(replay);
        }
        let result = self.perform_update_smart_parent(child)?;
        if self.smart_child.attempts.len() >= MAX_ATTEMPTS {
            // 只保留最近的记录：旧的回执已不可能再被重试（客户端也会丢弃旧 attempt）。
            if let Some(oldest) = self.smart_child.attempts.keys().next().cloned() {
                self.smart_child.attempts.remove(&oldest);
            }
        }
        self.smart_child.attempts.insert(
            attempt_id.to_string(),
            AttemptRecord { epoch, result: result.clone() },
        );
        Ok(result)
    }

    fn perform_update_smart_parent(&mut self, child: &[u8]) -> Result<Value> {
        let Some(session) = self.smart_child.child.clone() else {
            return Err(error("没有正在编辑的智能对象子文档"));
        };
        let state = self.active_doc()?;
        // 1) 父关联与基线核对：保守地把任何父修订/内容变化视为冲突。
        if state.doc.id != session.parent_doc {
            self.smart_child.invalidated = Some("父文档已替换或关闭".into());
            return Err(error("父文档已关闭，子文档已保留为独立文档"));
        }
        if state.revision != session.parent_revision
            || document_content::document_content_hash(&state.doc, &self.registry)
                .is_some_and(|hash| hash != session.parent_content_hash)
        {
            self.smart_child.invalidated = Some("父文档在子文档编辑期间已修改".into());
            return Err(error("父文档已修改（冲突）；子文档保留，请选择重载父源、导出或在父文档建立独立副本"));
        }
        let target = state.doc.layer(session.layer);
        let Some(target) = target else {
            self.smart_child.invalidated = Some("父文档中的对象已删除".into());
            return Err(error("父文档中的智能对象已不存在"));
        };
        let LayerContent::Smart(smart) = &target.content else {
            self.smart_child.invalidated = Some("父文档中的对象已不再是智能对象".into());
            return Err(error("父文档中的对象已不再是智能对象"));
        };
        if smart.contents_id.0 != session.contents_id {
            self.smart_child.invalidated = Some("父文档中的共享源已更换".into());
            return Err(error("父文档中的共享源已更换，无法回写"));
        }
        // 2) 子文档必须是可核验工程且落在预算内。
        if child.len() > photocraft_project_verify::limits::MAX_PROJECT_BYTES {
            return Err(error("子文档超过工程字节预算"));
        }
        photocraft_project_verify::smart_source::verify_project(child)
            .map_err(|failure| error(format!("子文档未通过核验：{}", failure.message)))?;
        let edited = photocraft_format::load_from_bytes(child)
            .map_err(|failure| error(format!("子文档无法解析：{failure}")))?;
        if edited.mode != photocraft_doc::ColorMode::Rgb || edited.depth != photocraft_doc::SampleType::U8 {
            return Err(error("子文档必须是 RGB/U8"));
        }
        // 3) 无变化：不产生父历史。
        let graph = photocraft_project_verify::smart_source::inspect_document_sources(&edited)
            .map_err(|failure| error(failure.message))?;
        let child_hash = crate::smart_identity::document_hash(&edited, &graph)
            .ok_or_else(|| error("无法计算子文档内容身份"))?;
        if child_hash == session.source_hash {
            return Ok(json!({
                "committed": false,
                "noChange": true,
                "instances": [],
                "parentRevision": state.revision,
                "childHash": child_hash,
            }));
        }
        // 4) 原子回写：候选 + 重算全部共享实例 + 一步父历史。
        let edit = crate::smart_source_edit::SourceContentsEdit::new(&self.session, session.layer)
            .map_err(|failure| error(failure.message()))?;
        let transaction = edit
            .prepare(&self.session, &edited)
            .map_err(|failure| error(failure.message()))?;
        let instances = transaction
            .finish(&mut self.session)
            .map_err(|failure| error(failure.message()))?;
        let (revision, content_hash) = {
            let state = self.active_doc()?;
            (
                state.revision,
                document_content::document_content_hash(&state.doc, &self.registry),
            )
        };
        // 5) 成功后同步子基线（父子各自的 dirty 独立，不自动回写）。
        if let Some(child) = &mut self.smart_child.child {
            child.source_hash = child_hash.clone();
            child.parent_revision = revision;
            if let Some(hash) = content_hash {
                child.parent_content_hash = hash;
            }
        }
        self.smart_child.invalidated = None;
        Ok(json!({
            "committed": true,
            "noChange": false,
            "instances": instances.iter().map(|id| id.0).collect::<Vec<_>>(),
            "parentRevision": revision,
            "childHash": child_hash,
        }))
    }

    /// 放弃子修改并重载父源（冲突恢复路径之一，需要显式确认）。
    pub fn reload_smart_child(&mut self) -> Result<Value> {
        let Some(session) = self.smart_child.child.clone() else {
            return Err(error("没有正在编辑的智能对象子文档"));
        };
        let state = self.active_doc()?.clone();
        let edit = crate::smart_source_edit::SourceContentsEdit::new(&self.session, session.layer)
            .map_err(|failure| error(failure.message()))?;
        let project = photocraft_format::save_to_bytes(edit.document(), &Default::default())
            .map_err(|failure| error(format!("子文档序列化失败：{failure}")))?;
        let source_hash = crate::smart_identity::document_hash(
            edit.document(),
            &photocraft_project_verify::smart_source::inspect_document_sources(edit.document())
                .map_err(|failure| error(failure.message))?,
        )
        .ok_or_else(|| error("无法计算子文档内容身份"))?;
        if let Some(child) = &mut self.smart_child.child {
            child.source_hash = source_hash.clone();
            child.parent_revision = state.revision;
            child.parent_content_hash = document_content::document_content_hash(&state.doc, &self.registry)
                .unwrap_or_default();
        }
        // 重载会把子文档拉回父源基线：子修订回到旧值，旧回执不能再顶替重载后的编辑。
        self.smart_child.rekey_session();
        self.smart_child.invalidated = None;
        Ok(json!({ "reloaded": true, "sourceHash": source_hash,
            "project": crate::psd::bytes_json(&project) }))
    }

    /// 导出子工程字节（冲突恢复路径之二）：不修改父文档。
    pub fn export_smart_child(&self) -> Result<Vec<u8>> {
        let Some(session) = &self.smart_child.child else {
            return Err(error("没有正在编辑的智能对象子文档"));
        };
        let edit = crate::smart_source_edit::SourceContentsEdit::new(&self.session, session.layer)
            .map_err(|failure| error(failure.message()))?;
        photocraft_format::save_to_bytes(edit.document(), &Default::default())
            .map_err(|failure| error(format!("子文档序列化失败：{failure}")))
    }

    /// 在父文档建立独立对象副本（冲突恢复路径之三）：不覆盖共享源。
    pub fn detach_smart_child(&mut self) -> Result<Value> {
        let Some(session) = &self.smart_child.child else {
            return Err(error("没有正在编辑的智能对象子文档"));
        };
        let layer = session.layer;
        let copies = crate::smart_copy::duplicate(&mut self.session, &[layer], crate::smart_copy::CopyKind::Independent)
            .map_err(|failure| error(failure.message()))?;
        // 子文档继续编辑新的独立副本。
        if let Some(copy) = copies.first() {
            let state = self.active_doc()?.clone();
            // 独立副本有**自己的** contents_id；会话不改绑过去的编号，后续每次回写都会
            // 被「共享源已更换」挡掉，等于这条恢复路径只完成了一半。
            let contents_id = match state.doc.layer(*copy).map(|layer| &layer.content) {
                Some(LayerContent::Smart(smart)) => Some(smart.contents_id.0),
                _ => None,
            };
            match contents_id {
                Some(contents_id) => {
                    if let Some(child) = &mut self.smart_child.child {
                        child.layer = *copy;
                        child.contents_id = contents_id;
                        child.parent_revision = state.revision;
                        child.parent_content_hash = document_content::document_content_hash(&state.doc, &self.registry)
                            .unwrap_or_else(|| child.parent_content_hash.clone());
                    }
                    // 关联已换到新副本：旧回执描述的是原来那一层，不能再来顶替新层。
                    self.smart_child.rekey_session();
                }
                // 副本不是智能对象（当前 `Independent` 校验下不会发生）：没有可继续编辑的
                // 关联，结束会话而不是留下一个指向旧源的过期绑定。
                None => self.smart_child.clear(),
            }
        }
        Ok(json!({ "detached": copies.iter().map(|id| id.0).collect::<Vec<_>>() }))
    }

    /// 结束子文档会话（不自动回写）。
    pub fn close_smart_child(&mut self) -> Value {
        self.smart_child.clear();
        json!({ "closed": true })
    }

    /// 子文档会话状态（UI 据此显示「更新父文档」是否可用与冲突原因）。
    pub fn smart_child_state(&self) -> Value {
        match &self.smart_child.child {
            None => json!({ "active": false, "invalidated": self.smart_child.invalidated }),
            Some(child) => json!({
                "active": true,
                "layer": child.layer.0,
                "contentsId": child.contents_id,
                "sourceHash": child.source_hash,
                "parentRevision": child.parent_revision,
                "invalidated": self.smart_child.invalidated,
            }),
        }
    }

    /// 受控智能对象转换（所选层／组 → 嵌入对象，一步历史）。
    pub fn convert_to_smart_object(&mut self, layers: &[u64]) -> Result<Value> {
        self.require_no_stroke()?;
        let ids: Vec<LayerId> = layers.iter().map(|id| LayerId(*id)).collect();
        let id = crate::smart_convert::convert(&mut self.session, &ids)
            .map_err(|failure| error(failure.message()))?;
        Ok(json!({ "layer": id.0, "converted": true }))
    }

    /// 智能对象复制：`shared` 共享源，`independent` 通过拷贝新建。
    pub fn duplicate_smart_object(&mut self, layers: &[u64], independent: bool) -> Result<Value> {
        self.require_no_stroke()?;
        let ids: Vec<LayerId> = layers.iter().map(|id| LayerId(*id)).collect();
        let kind = if independent {
            crate::smart_copy::CopyKind::Independent
        } else {
            crate::smart_copy::CopyKind::Shared
        };
        let copies = crate::smart_copy::duplicate(&mut self.session, &ids, kind)
            .map_err(|failure| error(failure.message()))?;
        Ok(json!({ "layers": copies.iter().map(|id| id.0).collect::<Vec<_>>(), "independent": independent }))
    }

    /// 替换智能对象源内容（保留实例变换与样式，一步历史）。
    pub fn replace_smart_contents(&mut self, layer: u64, bytes: &[u8]) -> Result<Value> {
        self.require_no_stroke()?;
        if bytes.len() > photocraft_project_verify::limits::MAX_PROJECT_BYTES {
            return Err(error("替换源超过工程字节预算"));
        }
        photocraft_project_verify::smart_source::verify_project(bytes)
            .map_err(|failure| error(format!("替换源未通过核验：{}", failure.message)))?;
        let document = photocraft_format::load_from_bytes(bytes)
            .map_err(|failure| error(format!("替换源无法解析：{failure}")))?;
        let edit = crate::smart_source_edit::SourceContentsEdit::new(&self.session, LayerId(layer))
            .map_err(|failure| error(failure.message()))?;
        let transaction = edit
            .prepare(&self.session, &document)
            .map_err(|failure| error(failure.message()))?;
        let instances = transaction
            .finish(&mut self.session)
            .map_err(|failure| error(failure.message()))?;
        Ok(json!({ "instances": instances.iter().map(|id| id.0).collect::<Vec<_>>() }))
    }

    /// 显式栅格化智能对象（不悄悄改写缓存）。
    pub fn rasterize_smart_object(&mut self, layer: u64) -> Result<Value> {
        self.require_no_stroke()?;
        let state = self.active_doc()?.clone();
        let id = LayerId(layer);
        let LayerContent::Smart(smart) = &state.doc.layer(id).ok_or_else(|| error("目标图层不存在"))?.content else {
            return Err(error("目标不是智能对象"));
        };
        let cache = smart.cache.clone().ok_or_else(|| error("智能对象缺少可栅格化的外观"))?;
        let base = state.clone();
        let mut candidate = (*state.doc).clone();
        let layer = candidate.layer_mut(id).ok_or_else(|| error("目标图层不存在"))?;
        layer.content = LayerContent::Raster(cache);
        inspect_document_sources(&candidate).map_err(|failure| error(failure.message))?;
        crate::preview_history::commit_selected(
            &mut self.session,
            Arc::new(candidate),
            Some(id),
            vec![id],
            "栅格化智能对象",
        )
        .map_err(|failure| error(format!("{failure}")))?;
        let _ = base;
        // 只结束被栅格化那一层的子会话：别的对象的子文档与父文档无关，不能被顺带关闭。
        if self.child_layer() == Some(id) {
            self.smart_child.clear();
        }
        Ok(json!({ "layer": id.0, "rasterized": true }))
    }

    /// 选中智能层的可用性（导出/替换/编辑内容/转回图层）。
    ///
    /// 只读：不要求已打开子文档；`active` 只用于标注「该层有子会话」。
    pub fn smart_layer_state(&self, layer: u64) -> Result<Value> {
        let state = self.active_doc()?;
        if state.doc.layer(LayerId(layer)).is_none() {
            return Err(error("目标图层不存在"));
        }
        // 非智能图层也返回结构化原因，UI 不需要另做一次类型判断。
        crate::features::smart::smart_source_io::layer_state(
            &self.session,
            LayerId(layer),
            self.child_layer(),
        )
    }

    /// 导出选中智能层的源字节（不要求已打开子文档；不产生历史）。
    pub fn export_smart_source(&self, layer: u64) -> Result<(String, Vec<u8>)> {
        crate::features::smart::smart_source_io::export_source(&self.session, LayerId(layer))
    }

    /// 转回图层：把嵌入源解包为可编辑图层/组，只改当前实例。
    pub fn convert_smart_to_layers(&mut self, layer: u64) -> Result<Value> {
        self.require_no_stroke()?;
        let id = LayerId(layer);
        let child_open = self.child_layer() == Some(id);
        crate::features::smart::unpack::convert(&mut self.session, id, child_open)
    }

    /// 当前子会话绑定的父层（`None` 表示没有打开的子文档）。
    pub(crate) fn child_layer(&self) -> Option<LayerId> {
        self.smart_child.layer()
    }
}

use photocraft_project_verify::smart_source::inspect_document_sources;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Editor;
    use serde_json::json;

    fn editor() -> Editor {
        let mut editor = Editor::new();
        editor.execute("file.new", json!({"width":20,"height":16})).unwrap();
        editor.execute("layer.new.layer", json!({"name":"内容"})).unwrap();
        // 转换要求非空像素：用填充命令制造内容，避免依赖绘画或合成器。
        editor.execute("edit.fillForeground", json!({"color":"#3366cc"})).unwrap();
        editor
    }

    /// 一个最小的嵌入源：8×8 的 pcraft，含两层。
    fn source_bytes(layers: usize) -> Vec<u8> {
        let mut document = photocraft_doc::Document::new(
            "内容",
            photocraft_doc::Size::new(8, 8),
            photocraft_doc::ColorMode::Rgb,
            photocraft_doc::SampleType::U8,
        );
        document.layers = (0..layers)
            .map(|_| photocraft_doc::Layer::raster("层", document.pixel_format()))
            .collect();
        photocraft_format::save_to_bytes(&document, &Default::default()).unwrap()
    }

    fn with_smart() -> Editor {
        let mut editor = editor();
        let layer = editor.active_layer_id().unwrap().0;
        editor.convert_to_smart_object(&[layer]).unwrap();
        editor
    }

    #[test]
    fn opening_a_child_reports_association_and_reuses_the_same_source() {
        let mut editor = with_smart();
        let state = editor.state();
        let layer = state["document"]["activeLayer"].as_u64().unwrap();
        let first = editor.begin_smart_child(layer).unwrap();
        assert_eq!(first["reused"], false);
        assert_eq!(first["contentsId"].as_u64().is_some(), true);
        assert!(first["sourceHash"].as_str().unwrap().len() == 16);
        assert!(first["project"].is_string());
        assert_eq!(editor.smart_child_state()["active"], true);
        // 同一源再次打开：复用，不新开。
        let again = editor.begin_smart_child(layer).unwrap();
        assert_eq!(again["reused"], true);
        assert_eq!(again["contentsId"], first["contentsId"]);
        assert_eq!(again["sourceHash"], first["sourceHash"]);
    }

    #[test]
    fn unchanged_child_writeback_adds_no_parent_history() {
        let mut editor = with_smart();
        let layer = editor.state()["document"]["activeLayer"].as_u64().unwrap();
        let opened = editor.begin_smart_child(layer).unwrap();
        let project = crate::psd::bytes_from_json(&opened["project"]).unwrap();
        let before = editor.state();
        let result = editor.update_smart_parent("attempt-1", &project).unwrap();
        assert_eq!(result["noChange"], true);
        assert_eq!(result["committed"], false);
        assert_eq!(editor.state(), before, "无变化回写不得增加历史");
    }

    #[test]
    fn changed_child_writeback_recomputes_all_instances_in_one_step_and_is_idempotent() {
        let mut editor = with_smart();
        let layer = editor.state()["document"]["activeLayer"].as_u64().unwrap();
        // 共享副本：同一 contents_id 的第二个实例。
        let copies = editor.duplicate_smart_object(&[layer], false).unwrap();
        assert_eq!(copies["layers"].as_array().unwrap().len(), 1);
        let opened = editor.begin_smart_child(layer).unwrap();
        let mut child = photocraft_format::load_from_bytes(
            &crate::psd::bytes_from_json(&opened["project"]).unwrap(),
        )
        .unwrap();
        // 子文档改一笔：新增一个像素层。
        child.layers.push(photocraft_doc::Layer::raster("新增", child.pixel_format()));
        let edited = photocraft_format::save_to_bytes(&child, &Default::default()).unwrap();
        let before = editor.state();
        let history_before = before["document"]["history"].as_array().unwrap().len();

        let result = editor.update_smart_parent("attempt-x", &edited).unwrap();
        assert_eq!(result["committed"], true);
        assert!(result["instances"].as_array().unwrap().len() >= 2, "两个共享实例都重算");
        let after = editor.state();
        assert_eq!(
            after["document"]["history"].as_array().unwrap().len(),
            history_before + 1,
            "父文档只增加一步历史"
        );
        // 同一 attemptId 重试：返回原结果且不重复提交。
        let replay = editor.update_smart_parent("attempt-x", &edited).unwrap();
        assert_eq!(replay["replayed"], true);
        assert_eq!(replay["parentRevision"], result["parentRevision"]);
        assert_eq!(editor.state(), after, "重试不得再提交");
        // 撤销一次即还原全部实例。
        editor.execute("edit.undo", Value::Null).unwrap();
        assert_eq!(
            editor.state()["document"]["history"].as_array().unwrap().len(),
            history_before
        );
    }

    #[test]
    fn different_attempt_keys_do_not_commit_the_same_content_twice() {
        // 两个「更新父文档」入口（子文档弹层用 `ui-child-<rev>`、面板用 `ui-<rev>`）键不同：
        // 用户先点一个再点另一个时，第二份相同内容必须走无变化分支，不能因为换了键就再提交一次历史。
        let mut editor = with_smart();
        let layer = editor.state()["document"]["activeLayer"].as_u64().unwrap();
        let opened = editor.begin_smart_child(layer).unwrap();
        let mut child = photocraft_format::load_from_bytes(
            &crate::psd::bytes_from_json(&opened["project"]).unwrap(),
        )
        .unwrap();
        child
            .layers
            .push(photocraft_doc::Layer::raster("子改", child.pixel_format()));
        let edited = photocraft_format::save_to_bytes(&child, &Default::default()).unwrap();

        let first = editor.update_smart_parent("ui-child-3", &edited).unwrap();
        assert_eq!(first["committed"], true);
        let history_after_first = editor.state()["document"]["history"]
            .as_array()
            .unwrap()
            .len();
        let second = editor.update_smart_parent("ui-3", &edited).unwrap();
        assert_eq!(second["committed"], false, "同内容换键不得再提交：{second}");
        assert_eq!(second["noChange"], true);
        assert_eq!(
            editor.state()["document"]["history"]
                .as_array()
                .unwrap()
                .len(),
            history_after_first,
            "换键重放同一内容不得增加历史"
        );
        // 原键的重试仍是幂等回执。
        assert_eq!(
            editor.update_smart_parent("ui-child-3", &edited).unwrap()["replayed"],
            true
        );
    }

    #[test]
    fn parent_revision_change_is_a_conflict_and_keeps_the_child_file() {
        let mut editor = with_smart();
        let layer = editor.state()["document"]["activeLayer"].as_u64().unwrap();
        let opened = editor.begin_smart_child(layer).unwrap();
        let mut child = photocraft_format::load_from_bytes(
            &crate::psd::bytes_from_json(&opened["project"]).unwrap(),
        )
        .unwrap();
        child.layers.push(photocraft_doc::Layer::raster("新增", child.pixel_format()));
        let edited = photocraft_format::save_to_bytes(&child, &Default::default()).unwrap();
        // 父文档在子文档编辑期间被修改。
        editor.execute("layer.new.layer", json!({"name":"父修改"})).unwrap();
        let before = editor.state();
        let failure = editor.update_smart_parent("attempt-conflict", &edited).unwrap_err();
        assert!(failure.message().contains("冲突") || failure.message().contains("已修改"));
        assert_eq!(editor.state(), before, "冲突不得覆盖父文档");
        assert_eq!(editor.smart_child_state()["active"], true, "子文档保留");
        assert!(editor.smart_child_state()["invalidated"].as_str().unwrap().contains("修改"));
        // 恢复路径：导出子工程仍可用（导出的是父文档当前持有的源基线；子编辑器可另存自己的字节）。
        let exported = editor.export_smart_child().unwrap();
        let reloaded = photocraft_format::load_from_bytes(&exported).unwrap();
        assert_eq!(reloaded.layers.len(), child.layers.len() - 1, "基线导出不含子编辑器未回写的修改");
        // 恢复路径：建立独立副本（不覆盖共享源）。
        let detached = editor.detach_smart_child().unwrap();
        assert_eq!(detached["detached"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn writeback_receipts_belong_to_their_own_child_session() {
        // UI 的回执键是子文档修订号；关闭重开或重载后它会回到同一个数。
        // 旧会话的回执不能顶替新会话的编辑，否则用户的第二次修改会被静默丢掉。
        fn edited(project: &[u8], name: &str) -> Vec<u8> {
            let mut child = photocraft_format::load_from_bytes(project).unwrap();
            child
                .layers
                .push(photocraft_doc::Layer::raster(name, child.pixel_format()));
            photocraft_format::save_to_bytes(&child, &Default::default()).unwrap()
        }
        let mut editor = with_smart();
        let layer = editor.state()["document"]["activeLayer"].as_u64().unwrap();
        let baseline = crate::psd::bytes_from_json(
            &editor.begin_smart_child(layer).unwrap()["project"],
        )
        .unwrap();
        editor.close_smart_child();
        let first_bytes = edited(&baseline, "第一轮");
        let second_bytes = edited(&baseline, "第二轮");

        // 会话 A：提交并重试，仍是幂等回执。
        editor.begin_smart_child(layer).unwrap();
        let first = editor.update_smart_parent("ui-child-3", &first_bytes).unwrap();
        assert_eq!(first["committed"], true);
        assert_eq!(
            editor.update_smart_parent("ui-child-3", &first_bytes).unwrap()["replayed"],
            true
        );

        // 关闭重开 = 新会话，同一个键必须真的提交。
        editor.close_smart_child();
        editor.begin_smart_child(layer).unwrap();
        let before = editor.state();
        let second = editor.update_smart_parent("ui-child-3", &second_bytes).unwrap();
        assert_eq!(second.get("replayed"), None, "新会话不得回放旧回执：{second}");
        assert_eq!(second["committed"], true);
        assert_ne!(editor.state(), before, "第二次编辑必须真的写进父文档");

        // 重载父源同样开新会话：旧回执作废。
        assert_eq!(editor.reload_smart_child().unwrap()["reloaded"], true);
        let before = editor.state();
        let third = editor.update_smart_parent("ui-child-3", &first_bytes).unwrap();
        assert_eq!(third.get("replayed"), None, "重载后不得回放旧回执：{third}");
        assert_eq!(third["committed"], true);
        assert_ne!(editor.state(), before);
        // 新会话内的重试依旧幂等。
        assert_eq!(
            editor.update_smart_parent("ui-child-3", &first_bytes).unwrap()["replayed"],
            true
        );
    }

    #[test]
    fn detached_copy_can_still_be_written_back() {
        // 「在父文档建立独立副本」是冲突恢复路径之一：分离之后用户会继续在子文档里改，
        // 再回写必须落到新副本上。独立副本有新的 contents_id，会话必须跟着改绑，
        // 否则每次回写都被「共享源已更换」挡掉，恢复路径等于没走通。
        let mut editor = with_smart();
        let layer = editor.state()["document"]["activeLayer"].as_u64().unwrap();
        let opened = editor.begin_smart_child(layer).unwrap();
        let mut child = photocraft_format::load_from_bytes(
            &crate::psd::bytes_from_json(&opened["project"]).unwrap(),
        )
        .unwrap();
        child.layers.push(photocraft_doc::Layer::raster(
            "分离后继续编辑",
            child.pixel_format(),
        ));
        let edited = photocraft_format::save_to_bytes(&child, &Default::default()).unwrap();

        let detached = editor.detach_smart_child().unwrap();
        let copy = detached["detached"].as_array().unwrap()[0]
            .as_u64()
            .unwrap();
        assert_eq!(
            editor.smart_child_state()["layer"],
            copy,
            "会话跟着到新副本"
        );
        let before = editor.state();
        let written = editor.update_smart_parent("after-detach", &edited).unwrap();
        assert_eq!(
            written.get("replayed"),
            None,
            "分离后第一次回写不能是旧回执：{written}"
        );
        assert_eq!(
            written["committed"], true,
            "分离后回写必须真的提交：{written}"
        );
        assert_ne!(editor.state(), before, "新副本的内容真的变了");
        assert_eq!(
            editor.smart_child_state()["invalidated"],
            serde_json::Value::Null
        );
        // 分离后同一会话内的重试仍幂等。
        assert_eq!(
            editor.update_smart_parent("after-detach", &edited).unwrap()["replayed"],
            true
        );
    }

    #[test]
    fn invalid_child_bytes_and_missing_sessions_reject_without_history() {
        let mut editor = with_smart();
        let layer = editor.state()["document"]["activeLayer"].as_u64().unwrap();
        editor.begin_smart_child(layer).unwrap();
        let before = editor.state();
        for bytes in [b"garbage".to_vec(), Vec::new()] {
            assert!(editor.update_smart_parent("attempt-bad", &bytes).is_err());
            assert_eq!(editor.state(), before);
        }
        assert!(editor.update_smart_parent("", &source_bytes(1)).is_err());
        editor.close_smart_child();
        assert!(editor.update_smart_parent("attempt-late", &source_bytes(1)).is_err());
        assert!(editor.export_smart_child().is_err());
        assert!(editor.reload_smart_child().is_err());
    }

    #[test]
    fn reload_and_rasterize_are_explicit_and_keep_documents_consistent() {
        let mut editor = with_smart();
        let layer = editor.state()["document"]["activeLayer"].as_u64().unwrap();
        editor.begin_smart_child(layer).unwrap();
        let reloaded = editor.reload_smart_child().unwrap();
        assert_eq!(reloaded["reloaded"], true);
        assert!(reloaded["project"].is_string());
        let raster = editor.rasterize_smart_object(layer).unwrap();
        assert_eq!(raster["rasterized"], true);
        assert_eq!(editor.smart_child_state()["active"], false);
        // 栅格化后不再接受「编辑内容」。
        assert!(editor.begin_smart_child(layer).is_err());
    }

    #[test]
    fn rasterizing_one_object_keeps_another_objects_child_session() {
        let mut editor = with_smart();
        let first = editor.state()["document"]["activeLayer"].as_u64().unwrap();
        // 第二个独立对象 + 它自己的子文档会话。
        let copies = editor.duplicate_smart_object(&[first], true).unwrap();
        let second = copies["layers"].as_array().unwrap()[0].as_u64().unwrap();
        editor.begin_smart_child(second).unwrap();
        assert_eq!(editor.smart_child_state()["layer"], second);
        // 栅格化另一个对象：无关的子会话必须保持。
        assert_eq!(editor.rasterize_smart_object(first).unwrap()["rasterized"], true);
        assert_eq!(
            editor.smart_child_state()["active"],
            true,
            "栅格化别的对象不得关闭当前子文档"
        );
        assert_eq!(editor.smart_child_state()["layer"], second);
        // 栅格化子会话自己的那一层才结束会话。
        assert_eq!(editor.rasterize_smart_object(second).unwrap()["rasterized"], true);
        assert_eq!(editor.smart_child_state()["active"], false);
    }

    #[test]
    fn replace_contents_keeps_instance_transform_and_one_history_step() {
        let mut editor = with_smart();
        let layer = editor.state()["document"]["activeLayer"].as_u64().unwrap();
        let before = editor.state();
        let replacement = source_bytes(3);
        let result = editor.replace_smart_contents(layer, &replacement).unwrap();
        assert!(result["instances"].as_array().unwrap().len() >= 1);
        assert_eq!(
            editor.state()["document"]["history"].as_array().unwrap().len(),
            before["document"]["history"].as_array().unwrap().len() + 1
        );
        editor.execute("edit.undo", Value::Null).unwrap();
        assert_eq!(
            editor.state()["document"]["history"].as_array().unwrap().len(),
            before["document"]["history"].as_array().unwrap().len()
        );
    }
}
