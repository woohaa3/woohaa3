//! Document operations shared by the explicit web handle and non-rendering tests.
use crate::PhotocraftApp;
pub fn list(app: &PhotocraftApp) -> String {
    serde_json::json!({"documents": app.session.documents().iter().map(|st| serde_json::json!({
        "id": st.doc.id.0.to_string(), "name": st.doc.name, "revision": st.revision.saturating_sub(st.view_revision), "dirty": st.is_dirty()
    })).collect::<Vec<_>>(), "documentId":app.session.active().map(|st|st.doc.id.0.to_string())}).to_string()
}
pub fn open(app: &mut PhotocraftApp, name: &str, bytes: &[u8]) -> Result<String, String> {
    if app.session.documents().len() >= 8 { return Err("工作区最多保留 8 份文档，请先关闭一份".into()); }
    let imported = photocraft_io::import_with_options(name, bytes, &Default::default()).map_err(|e| e.to_string())?;
    let mut doc = imported.document; doc.name = name.into();
    let index = app.session.add_document(doc, None); app.sync_views();
    Ok(app.session.documents()[index].doc.id.0.to_string())
}
pub fn activate(app: &mut PhotocraftApp, id: &str) -> Result<(), String> {
    let i = app.session.documents().iter().position(|d| d.doc.id.0.to_string() == id).ok_or("Document is closed")?;
    app.session.set_active(i); app.sync_views(); Ok(())
}
pub fn close(app: &mut PhotocraftApp, id: &str) -> Result<(), String> {
    let i = app.session.documents().iter().position(|d| d.doc.id.0.to_string() == id).ok_or("Document is closed")?;
    let active = app.session.active_index() == Some(i);
    drop(app.session.close(i)); app.sync_views();
    if active && !app.session.documents().is_empty() { app.session.set_active(i.saturating_sub(1).min(app.session.documents().len()-1)); }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn app() -> PhotocraftApp { PhotocraftApp::new(photocraft_engine::Session::new(), Default::default()) }
    fn png() -> Vec<u8> {
        let mut a = app(); a.session.execute("file.new", serde_json::json!({"width":2,"height":2})).unwrap();
        photocraft_io::export(&a.session.active().unwrap().doc, "x.png", &Default::default()).unwrap().bytes
    }
    #[test]
    fn workspace_operations_keep_views_and_failed_open_is_atomic() {
        let mut a = app(); let png = png(); let first = open(&mut a,"same.png",&png).unwrap();
        a.ui.views[0].zoom = 2.5;
        let second = open(&mut a,"same.png",&png).unwrap(); assert_ne!(first,second);
        assert!(open(&mut a,"broken.png",b"broken").is_err()); assert_eq!(a.session.documents().len(),2);
        assert_eq!(a.session.active().unwrap().doc.id.0.to_string(),second);
        activate(&mut a,&first).unwrap(); assert_eq!(a.ui.views[0].zoom,2.5);
        close(&mut a,&second).unwrap(); assert_eq!(a.ui.views[0].zoom,2.5);
        assert!(activate(&mut a,&second).is_err());
        let project=photocraft_io::export(&a.session.active().unwrap().doc,"x.pcraft",&Default::default()).unwrap();
        assert!(!project.bytes.is_empty());
        close(&mut a,&first).unwrap(); assert!(a.session.active().is_none());
        let reopened=open(&mut a,"same.png",&png).unwrap(); assert_ne!(first,reopened);
    }
    #[test]
    fn capacity_rejects_without_evicting_local_history() {
        let mut a=app(); let png=png();
        for _ in 0..8 { open(&mut a,"same.png",&png).unwrap(); }
        let before=list(&a);
        crate::overlay::set_hosted(true);
        assert!(a.run("file.new", serde_json::json!({"width":2,"height":2})).is_err());
        assert!(a.run("image.duplicate", serde_json::json!({})).is_err());
        crate::overlay::set_hosted(false);
        assert!(open(&mut a,"ninth.png",&png).is_err()); assert_eq!(before,list(&a));
    }
}
