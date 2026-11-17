//! 同一访问的纹理先暂存，直到带相同 token 的场景接受后才交给 ECS。
use std::collections::HashMap;
use crate::canvas_runtime::texture_scope::TextureScopeGate;

pub(crate) type Texture = (u32, u32, Vec<u8>, Option<String>);

#[derive(Default)]
pub(crate) struct ScopedTextureInbox {
    gate: TextureScopeGate,
    active: Option<u64>,
    pending: HashMap<String, Texture>,
    model_pending: HashMap<String, (u32, u32, Vec<u8>)>,
    focus: crate::protocol::focus_details::FocusDetailInbox,
    sealed: bool,
}

impl ScopedTextureInbox {
    pub(crate) fn begin(&mut self, canvas_id: &str) -> Result<u64, &'static str> {
        let token = self.gate.begin(canvas_id)?;
        self.active = Some(token);
        self.pending.clear();
        self.model_pending.clear();
        self.focus = crate::protocol::focus_details::FocusDetailInbox::new();
        self.sealed = true;
        Ok(token)
    }

    pub(crate) fn end(&mut self, token: u64) -> bool {
        if !self.gate.accept_upload(token) { return false; }
        self.gate.invalidate();
        self.active = None;
        self.pending.clear();
        self.model_pending.clear();
        self.focus = crate::protocol::focus_details::FocusDetailInbox::new();
        true
    }

    pub(crate) fn legacy_allowed(&self) -> bool { !self.sealed }

    pub(crate) fn matches_scene(&self, token: u64, canvas_id: &str) -> bool {
        self.gate.matches_scene(token, canvas_id)
    }

    pub(crate) fn matches_token(&self, token: u64) -> bool {
        self.gate.accept_upload(token)
    }

    pub(crate) fn queue(&mut self, token: u64, id: String, texture: Texture) -> bool {
        if !self.gate.accept_upload(token) { return false; }
        self.pending.insert(id, texture);
        true
    }

    pub(crate) fn queue_model(&mut self, token: u64, id: String, texture: (u32, u32, Vec<u8>)) -> bool {
        if !self.gate.accept_upload(token) { return false; }
        self.model_pending.insert(id, texture);
        true
    }

    pub(crate) fn queue_focus(&mut self, token: u64, frame: Option<crate::protocol::focus_details::FocusDetails>, bytes: &[u8]) -> Result<(), &'static str> {
        if !self.gate.accept_upload(token) { return Err("Stale canvas scope"); }
        self.focus.queue(frame, bytes)
    }

    pub(crate) fn scene(&mut self, token: u64, canvas_id: &str) -> bool {
        self.gate.accept_scene(token, canvas_id)
    }

    pub(crate) fn drain_scope(&self) -> Option<u64> { self.active.filter(|token| self.gate.can_drain(*token)) }

    pub(crate) fn drain(&mut self) -> HashMap<String, Texture> {
        if !self.active.is_some_and(|token| self.gate.can_drain(token)) {
            return HashMap::new();
        }
        std::mem::take(&mut self.pending)
    }

    pub(crate) fn drain_model(&mut self) -> HashMap<String, (u32, u32, Vec<u8>)> {
        if !self.active.is_some_and(|token| self.gate.can_drain(token)) {
            return HashMap::new();
        }
        std::mem::take(&mut self.model_pending)
    }

    pub(crate) fn drain_focus(&mut self) -> Option<Option<crate::protocol::focus_details::FocusDetailUpload>> {
        if !self.active.is_some_and(|token| self.gate.can_drain(token)) {
            return None;
        }
        self.focus.take()
    }

    pub(crate) fn invalidate(&mut self) { self.gate.invalidate(); self.active = None; self.pending.clear(); self.model_pending.clear(); self.focus = crate::protocol::focus_details::FocusDetailInbox::new(); self.sealed = false; }

    pub(crate) fn is_active(&self) -> bool { self.active.is_some() }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn texture(byte: u8) -> Texture { (1, 1, vec![byte; 4], None) }

    #[test]
    fn scoped_texture_waits_for_new_scene_and_rejects_late_old() {
        let mut inbox = ScopedTextureInbox::default();
        let a = inbox.begin("canvas-a").unwrap();
        assert!(inbox.scene(a, "canvas-a"));
        assert!(inbox.queue(a, "node".into(), texture(1)));
        let b = inbox.begin("canvas-b").unwrap();
        assert!(inbox.queue(b, "node".into(), texture(2)));
        assert!(!inbox.queue(a, "node".into(), texture(3)));
        assert!(inbox.drain().is_empty());
        assert!(!inbox.scene(a, "canvas-a"));
        assert!(!inbox.scene(b, "canvas-a"));
        assert!(inbox.drain().is_empty());
        assert!(inbox.scene(b, "canvas-b"));
        assert_eq!(inbox.drain().remove("node").unwrap().2, vec![2; 4]);
        assert!(inbox.drain().is_empty());
    }

    #[test]
    fn scoped_texture_revisit_waits_for_second_a_scene() {
        let mut inbox = ScopedTextureInbox::default();
        let first = inbox.begin("canvas-a").unwrap();
        assert!(inbox.scene(first, "canvas-a"));
        let b = inbox.begin("canvas-b").unwrap();
        assert!(inbox.scene(b, "canvas-b"));
        let second = inbox.begin("canvas-a").unwrap();
        assert!(inbox.queue(second, "node".into(), texture(4)));
        assert!(!inbox.scene(first, "canvas-a"));
        assert!(!inbox.queue(first, "node".into(), texture(5)));
        assert!(inbox.drain().is_empty());
        assert!(inbox.scene(second, "canvas-a"));
        assert_eq!(inbox.drain().remove("node").unwrap().2, vec![4; 4]);
    }

    #[test]
    fn scoped_texture_invalid_begin_preserves_pending() {
        let mut inbox = ScopedTextureInbox::default();
        let token = inbox.begin("canvas-a").unwrap();
        assert!(inbox.queue(token, "node".into(), texture(6)));
        assert!(inbox.begin("").is_err());
        assert!(inbox.scene(token, "canvas-a"));
        assert_eq!(inbox.drain().remove("node").unwrap().2, vec![6; 4]);
    }

    #[test]
    fn scoped_texture_invalidate_drops_pending_and_requires_new_scene() {
        let mut inbox = ScopedTextureInbox::default();
        let a = inbox.begin("canvas-a").unwrap();
        assert!(inbox.queue(a, "node".into(), texture(7)));
        inbox.invalidate();
        assert!(!inbox.is_active());
        assert!(!inbox.queue(a, "node".into(), texture(8)));
        assert!(inbox.drain().is_empty());
        let again = inbox.begin("canvas-a").unwrap();
        assert_ne!(a, again);
        assert!(inbox.queue(again, "node".into(), texture(9)));
        assert!(inbox.drain().is_empty());
        assert!(inbox.scene(again, "canvas-a"));
        assert_eq!(inbox.drain().remove("node").unwrap().2, vec![9; 4]);
    }

    #[test]
    fn scoped_texture_wrong_end_leaves_valid_scope() {
        let mut inbox = ScopedTextureInbox::default();
        let a = inbox.begin("canvas-a").unwrap();
        assert!(!inbox.legacy_allowed());
        assert!(inbox.queue(a, "node".into(), texture(1)));
        assert!(!inbox.end(0));
        assert!(!inbox.end(a.wrapping_add(9)));
        assert!(inbox.is_active());
        assert!(!inbox.legacy_allowed());
        assert!(inbox.scene(a, "canvas-a"));
        assert_eq!(inbox.drain().remove("node").unwrap().2, vec![1; 4]);
    }

    #[test]
    fn scoped_texture_end_rejects_late_upload_and_fresh_begin() {
        let mut inbox = ScopedTextureInbox::default();
        let a = inbox.begin("canvas-a").unwrap();
        assert!(inbox.queue(a, "node".into(), texture(2)));
        assert!(inbox.end(a));
        assert!(!inbox.legacy_allowed());
        assert!(!inbox.is_active());
        assert!(!inbox.queue(a, "late".into(), texture(3)));
        assert!(!inbox.scene(a, "canvas-a"));
        assert!(inbox.drain().is_empty());
        let b = inbox.begin("canvas-a").unwrap();
        assert_ne!(a, b);
        assert!(!inbox.queue(a, "node".into(), texture(4)));
        assert!(inbox.queue(b, "node".into(), texture(5)));
    }

    #[test]
    fn scoped_texture_renderer_invalidate_reopens_legacy_without_reusing_token() {
        let mut inbox = ScopedTextureInbox::default();
        let a = inbox.begin("canvas-a").unwrap();
        assert!(inbox.end(a));
        assert!(!inbox.legacy_allowed());
        inbox.invalidate();
        assert!(inbox.legacy_allowed());
        assert!(!inbox.is_active());
        let b = inbox.begin("canvas-b").unwrap();
        assert_ne!(a, b);
        assert!(!inbox.legacy_allowed());
    }

    #[test]
    fn scoped_model_and_focus_wait_for_scene() {
        let mut inbox = ScopedTextureInbox::default();
        let a = inbox.begin("canvas-a").unwrap();
        assert!(inbox.scene(a, "canvas-a"));
        assert!(inbox.queue_model(a, "plane".into(), (1, 1, vec![1; 4])));
        let b = inbox.begin("canvas-b").unwrap();
        assert!(!inbox.queue_model(a, "plane".into(), (1, 1, vec![9; 4])));
        assert!(inbox.queue_model(b, "plane".into(), (1, 1, vec![2; 4])));
        let frame: crate::protocol::focus_details::FocusDetails = serde_json::from_value(serde_json::json!({
            "nodeId":"img", "width":1, "height":1,
            "tiles":[{"x":0,"y":0,"width":1,"height":1}]
        })).unwrap();
        assert!(inbox.queue_focus(a, Some(frame.clone()), &[9; 4]).is_err());
        inbox.queue_focus(b, Some(frame), &[3; 4]).unwrap();
        assert!(inbox.drain_model().is_empty());
        assert!(inbox.drain_focus().is_none());
        assert!(inbox.scene(b, "canvas-b"));
        assert_eq!(inbox.drain_model().remove("plane").unwrap().2, vec![2; 4]);
        let upload = inbox.drain_focus().unwrap().unwrap();
        assert_eq!(upload.frame.node_id, "img");
        assert_eq!(upload.pixels[0].as_ref(), &[3; 4]);
        inbox.queue_focus(b, None, &[]).unwrap();
        assert!(matches!(inbox.drain_focus(), Some(None)));
    }
}
