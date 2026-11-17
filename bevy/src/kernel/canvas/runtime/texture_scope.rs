//! 纹理上传与场景共享的访问身份；接入边界之前可独立验证顺序。

#[derive(Default)]
pub(crate) struct TextureScopeGate {
    next: u64,
    active: Option<(u64, String)>,
    accepted_scene: Option<u64>,
}

impl TextureScopeGate {
    pub(crate) fn begin(&mut self, canvas_id: &str) -> Result<u64, &'static str> {
        if canvas_id.is_empty() { return Err("empty canvas id"); }
        let token = self.next.checked_add(1).ok_or("texture scope exhausted")?;
        self.next = token;
        self.active = Some((token, canvas_id.to_owned()));
        self.accepted_scene = None;
        Ok(token)
    }

    pub(crate) fn accept_upload(&self, token: u64) -> bool {
        self.active.as_ref().is_some_and(|(current, _)| *current == token)
    }

    pub(crate) fn matches_scene(&self, token: u64, canvas_id: &str) -> bool {
        self.active.as_ref().is_some_and(|(current, id)| *current == token && id == canvas_id)
    }

    pub(crate) fn accept_scene(&mut self, token: u64, canvas_id: &str) -> bool {
        if !self.matches_scene(token, canvas_id) {
            return false;
        }
        self.accepted_scene = Some(token);
        true
    }

    pub(crate) fn can_drain(&self, token: u64) -> bool {
        self.accept_upload(token) && self.accepted_scene == Some(token)
    }

    pub(crate) fn invalidate(&mut self) { self.active = None; self.accepted_scene = None; }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn texture_scope_holds_early_new_upload_and_rejects_old() {
        let mut gate = TextureScopeGate::default();
        let a = gate.begin("canvas-a").unwrap();
        assert!(gate.accept_scene(a, "canvas-a"));
        assert!(gate.can_drain(a));
        let b = gate.begin("canvas-b").unwrap();
        assert!(!gate.accept_upload(a));
        assert!(!gate.accept_scene(a, "canvas-a"));
        assert!(gate.accept_upload(b));
        assert!(!gate.can_drain(b));
        assert!(!gate.accept_scene(b, "canvas-a"));
        assert!(!gate.can_drain(b));
        assert!(gate.accept_scene(b, "canvas-b"));
        assert!(gate.can_drain(b));
    }

    #[test]
    fn texture_scope_revisit_rejects_first_visit() {
        let mut gate = TextureScopeGate::default();
        let first = gate.begin("canvas-a").unwrap();
        assert!(gate.accept_scene(first, "canvas-a"));
        let b = gate.begin("canvas-b").unwrap();
        assert!(gate.accept_scene(b, "canvas-b"));
        let second = gate.begin("canvas-a").unwrap();
        assert_ne!(first, second);
        assert!(!gate.accept_upload(first));
        assert!(!gate.accept_scene(first, "canvas-a"));
        assert!(gate.accept_upload(second));
        assert!(!gate.can_drain(second));
        assert!(gate.accept_scene(second, "canvas-a"));
        assert!(gate.can_drain(second));
        let third = gate.begin("canvas-a").unwrap();
        assert_ne!(second, third);
        assert!(!gate.can_drain(third));
    }

    #[test]
    fn texture_scope_failed_begin_keeps_existing_visit() {
        let mut gate = TextureScopeGate::default();
        let a = gate.begin("canvas-a").unwrap();
        assert!(gate.accept_scene(a, "canvas-a"));
        assert!(gate.begin("").is_err());
        assert!(gate.can_drain(a));
        gate.next = u64::MAX;
        assert!(gate.begin("canvas-b").is_err());
        assert!(gate.can_drain(a));
        assert!(!gate.accept_scene(a, "canvas-b"));
    }
}
