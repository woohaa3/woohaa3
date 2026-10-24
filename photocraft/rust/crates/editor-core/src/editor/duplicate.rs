//! Export a fresh document through bytes; the host retains ownership of workspace tabs.
use super::*;

impl Editor {
    pub fn duplicate_project(&self, name: &str) -> Result<Vec<u8>> {
        self.require_no_stroke()?;
        let fail=|message:&str|EditorError::CommandFailed{id:"image.duplicate".into(),message:message.into()};
        if name.trim()!=name || name.is_empty() || name.encode_utf16().count()>200 || name.chars().any(char::is_control) {
            return Err(fail("副本文档名称须为1–200个字符且不含控制字符"));
        }
        let source=self.active_doc()?;
        let mut scratch=Session::new();
        scratch.add_document((*source.doc).clone(),None);
        if scratch.active().unwrap().memory_bytes()>256*1024*1024 {return Err(fail("复制文档超过256 MiB像素预算"));}
        scratch.execute("image.duplicate",json!({"name":name})).map_err(|error|EditorError::SaveFailed(error.to_string()))?;
        let doc=&scratch.active().unwrap().doc;
        let opts=photocraft_format::SaveOptions{
            thumbnail:Some(photocraft_compose::thumbnail(doc,PROJECT_THUMBNAIL_SIDE)),
            composite:Some(photocraft_compose::thumbnail(doc,PROJECT_PREVIEW_SIDE)),
        };
        let bytes=photocraft_format::save_to_bytes(doc,&opts).map_err(|error|EditorError::SaveFailed(error.to_string()))?;
        photocraft_project_verify::verify(&bytes).map_err(|error|EditorError::SaveFailed(error.message))?;
        Ok(bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn document_duplicate_exports_fresh_identity_layers_pixels_and_independent_history() {
        let mut source=Editor::new();
        source.execute("file.new",json!({"width":8,"height":6,"background":"transparent"})).unwrap();
        source.execute("layer.new.layer",json!({"name":"Paint"})).unwrap();
        source.execute("edit.fillForeground",json!({"color":"#ff0000"})).unwrap();
        source.execute("select.rect",json!({"x":1,"y":1,"width":3,"height":2})).unwrap();
        source.execute("history.newSnapshot",json!({"name":"Source only"})).unwrap();
        source.undo().unwrap();
        let before=source.state();let hash=source.content_hash().unwrap();let pixels=source.render_preview(8).unwrap();
        let bytes=source.duplicate_project("Paint copy").unwrap();
        assert_eq!(source.state(),before);assert_eq!(source.content_hash().unwrap(),hash);
        let mut copy=Editor::new();copy.open_project(&bytes,None).unwrap();
        assert_eq!(copy.render_preview(8).unwrap(),pixels);
        let original=source.active_doc().unwrap();let duplicate=copy.active_doc().unwrap();
        assert_ne!(original.doc.id,duplicate.doc.id);assert_eq!(duplicate.doc.name,"Paint copy");
        assert_eq!(original.doc.layers.len(),duplicate.doc.layers.len());
        assert!(original.doc.layers.iter().zip(&duplicate.doc.layers).all(|(a,b)|a.id!=b.id && a.name==b.name));
        assert_eq!(duplicate.history.past_len(),0);assert!(duplicate.snapshots.is_empty());
        copy.execute("edit.fillForeground",json!({"color":"#0000ff"})).unwrap();copy.undo().unwrap();
        assert_eq!(copy.render_preview(8).unwrap(),pixels);assert_eq!(source.state(),before);
        for name in [""," leading","bad\nname",&"x".repeat(201)]{assert!(source.duplicate_project(name).is_err());assert_eq!(source.state(),before);}
        source.begin_stroke(json!({"points":[[1,1]],"size":2})).unwrap();assert!(source.duplicate_project("Blocked").is_err());source.cancel_stroke();assert_eq!(source.state(),before);
    }
}
