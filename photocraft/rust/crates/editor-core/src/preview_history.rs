//! 草稿确认共用的历史边界，不与前后命令的 coalesce 合并。
use std::sync::Arc;
use photocraft_doc::{Document, LayerId};
use photocraft_engine::Session;

pub(crate) fn commit(session: &mut Session, doc: Arc<Document>, active: Option<Option<LayerId>>, label: &str) -> photocraft_engine::Result<()> {
    if let Some(state)=session.active_mut() {state.coalesce=None;}
    let result=session.edit(label,move |target,layer| {
        *target=(*doc).clone();
        if let Some(active)=active {*layer=active;}
        Ok(())
    });
    if let Some(state)=session.active_mut() {state.coalesce=None;}
    result
}

/// 副本的完整选择集合属于同一步历史，不另派发选层或增加修订。
pub(crate) fn commit_selected(session:&mut Session,doc:Arc<Document>,active:Option<LayerId>,selected:Vec<LayerId>,label:&str)->photocraft_engine::Result<()> {
    commit(session,doc,Some(active),label)?;
    if let Some(state)=session.active_mut() {
        state.selected_layers=selected.clone();
        state.layer_anchor=active;
        state.history.set_current_layers(photocraft_ops::LayerTarget{active,selected});
    }
    Ok(())
}
