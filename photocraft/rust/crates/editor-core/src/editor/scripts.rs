//! Bounded byte scripts run on an isolated editor, never through the upstream path reader.
use super::*;
pub(super) const ID:&str="file.scripts.browse";
const MAX_SOURCE:usize=256*1024;
const MAX_STEPS:usize=32;
const MAX_DOCUMENT_PIXELS:usize=256*1024*1024;
fn fail(message:impl std::fmt::Display)->EditorError {EditorError::CommandFailed{id:ID.into(),message:message.to_string()}}
fn permitted(id:&str)->bool {
    crate::capability::command_allowed(id)
        && !matches!(id,"file.new"|"file.close"|"edit.definePattern"|ID|"type.saveDefaultTypeStyles"|"type.loadDefaultTypeStyles")
        && !id.starts_with("edit.purge.")
}
impl Editor {
    pub(super) fn execute_byte_script(&mut self,params:Value)->Result<Value> {
        let fields=params.as_object().filter(|fields|fields.keys().all(|key|["name","source"].contains(&key.as_str()))).ok_or_else(||fail("脚本只接受文件名和文本内容，不接受路径"))?;
        let name=fields.get("name").and_then(Value::as_str).filter(|name|!name.is_empty() && name.len()<=255 && !name.chars().any(|c|c.is_control() || c=='/' || c=='\\')).ok_or_else(||fail("脚本文件名无效"))?;
        let extension=name.rsplit_once('.').map(|(_,ext)|ext.to_ascii_lowercase()).unwrap_or_default();
        if !matches!(extension.as_str(),"json"|"txt"|"pcdroplet") {return Err(fail("请选择PhotoCraft JSON、命令文本或pcdroplet脚本；不支持Photoshop JavaScript"));}
        let source=fields.get("source").and_then(Value::as_str).filter(|source|source.len()<=MAX_SOURCE).ok_or_else(||fail("脚本文本不能超过256 KiB"))?;
        let steps=photocraft_engine::automate_cmds::parse_script(source).map_err(fail)?;
        if steps.is_empty() || steps.len()>MAX_STEPS {return Err(fail("脚本须包含1–32个步骤"));}
        // Reject the complete list before the first operation; nested scripts and lifecycle/global
        // commands have no access to the isolated editor or any sibling document.
        for (index,(id,_)) in steps.iter().enumerate() {
            if !permitted(id) {return Err(fail(format!("第{}步命令未开放：{id}",index+1)));}
        }
        if self.session.active_job().is_some() {return Err(fail("文档后台任务尚未结束"));}
        let base=self.active_doc()?;
        if base.memory_bytes()>MAX_DOCUMENT_PIXELS {return Err(fail("脚本文档/历史像素超过256 MiB预算"));}
        let mut scratch=Editor::new();
        scratch.session.edit_prefs(|prefs|*prefs=self.session.prefs().clone());
        scratch.session.add_document((*base.doc).clone(),None);
        *scratch.session.active_mut().unwrap()=base.clone();
        scratch.session.active_mut().unwrap().coalesce=None;
        scratch.session.tools=self.session.tools.clone();
        scratch.session.clipboard=self.session.clipboard.clone();
        scratch.session.type_defaults=self.session.type_defaults.clone();
        scratch.session.edit_state=self.session.edit_state.clone();
        scratch.registry=self.registry.clone();
        scratch.pattern_library=self.pattern_library.clone();
        for (index,(id,params)) in steps.iter().enumerate() {
            scratch.execute(id,params.clone()).map_err(|error|fail(format!("第{}步（{id}）失败，未应用脚本：{error}",index+1)))?;
            if scratch.active_doc()?.memory_bytes()>MAX_DOCUMENT_PIXELS {return Err(fail(format!("第{}步超过脚本文档/历史256 MiB像素预算，未应用脚本",index+1)));}
        }
        // Only owners that the accepted commands can write are published, after every step succeeds.
        *self.session.active_mut().unwrap()=scratch.session.active().unwrap().clone();
        self.session.tools=scratch.session.tools;
        self.session.clipboard=scratch.session.clipboard;
        self.session.edit_state=scratch.session.edit_state;
        self.session.journal.extend(scratch.session.journal);
        Ok(json!({"steps":steps.len()}))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn editor()->Editor {let mut e=Editor::new();e.execute("file.new",json!({"width":12,"height":8,"background":"transparent"})).unwrap();e}
    fn run(e:&mut Editor,source:&str)->Result<Value>{e.execute(ID,json!({"name":"steps.txt","source":source}))}
    #[test]
    fn byte_scripts_parse_native_formats_and_preserve_step_history() {
        for source in ["\u{feff}# example\nlayer.new.layer {\"name\":\"Script\"}\nedit.fillForeground {\"color\":\"#ff0000\"}",r##"{"action":{"steps":[["layer.new.layer",{"name":"Script"}],{"command":"edit.fillForeground","params":{"color":"#ff0000"}}]}}"##] {
            let mut e=editor();let hash=e.content_hash().unwrap();let count=e.active_doc().unwrap().history.past_len();
            assert_eq!(run(&mut e,source).unwrap(),json!({"steps":2}));
            assert_ne!(e.content_hash().unwrap(),hash);assert_eq!(e.active_doc().unwrap().history.past_len(),count+2);
            let pixels=e.render_preview(12).unwrap();assert_eq!(&pixels.pixels[0..4],&[255,0,0,255]);
            e.undo().unwrap();e.undo().unwrap();assert_eq!(e.content_hash().unwrap(),hash);e.redo().unwrap();e.redo().unwrap();
            let bytes=e.save_project().unwrap();photocraft_project_verify::verify(&bytes).unwrap();
        }
    }
    #[test]
    fn byte_script_failure_rolls_back_documents_tools_clipboard_snapshots_and_history() {
        let mut e=editor();e.execute("edit.fillForeground",json!({"color":"#00ff00"})).unwrap();e.execute("select.all",json!({})).unwrap();e.execute("edit.copy",json!({})).unwrap();
        e.execute("history.newSnapshot",json!({"name":"Before"})).unwrap();let state=e.state();let hash=e.content_hash().unwrap();let clip=e.clipboard_bounds();let colors=e.session.tools.foreground;
        let snapshot=e.active_doc().unwrap().snapshots[0].id;
        let bad=serde_json::to_string(&json!([["layer.new.layer",{"name":"Transient"}],["edit.fillForeground",{"color":"#ff0000"}],["tools.setColors",{"foreground":"#ff0000"}],["history.deleteSnapshot",{"snapshot":snapshot}],["select.rect",{"x":0,"y":0,"width":3,"height":4}],["edit.copy"],["image.imageSize",{"width":0}]])).unwrap();
        let error=run(&mut e,&bad).unwrap_err().to_string();assert!(error.contains("第7步"),"{error}");assert_eq!(e.state(),state);assert_eq!(e.content_hash().unwrap(),hash);assert_eq!(e.clipboard_bounds(),clip);assert_eq!(e.session.tools.foreground,colors);
        let journal=e.session.journal.clone();
        for id in [ID,"file.new","file.close","edit.purge.all","file.open","file.placeEmbedded","type.saveDefaultTypeStyles","plugin.run","edit.definePattern"] {
            assert!(run(&mut e,&format!("layer.new.layer\n{id}")).is_err());assert_eq!(e.state(),state);assert_eq!(e.content_hash().unwrap(),hash);assert_eq!(e.session.journal,journal);
        }
        for params in [json!({"path":"/tmp/steps.txt"}),json!({"name":"x.js","source":"layer.new.layer"}),json!({"name":"../x.txt","source":"layer.new.layer"}),json!({"name":"x.txt","source":""}),json!({"name":"x.txt","source":"{broken"}),json!({"name":"x.txt","source":" ".repeat(MAX_SOURCE+1)}),json!({"name":"x.txt","source":"layer.new.layer\n".repeat(33)})] {assert!(e.execute(ID,params).is_err());assert_eq!(e.state(),state);}
        e.begin_layer_properties(e.active_layer_id().unwrap().0).unwrap();assert!(run(&mut e,"layer.new.layer").is_err());e.cancel_layer_properties();assert_eq!(e.state(),state);
    }
}
