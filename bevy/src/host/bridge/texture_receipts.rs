//! Bevy 资产应用回执，不代表 GPU presentation。scope 在发送时冻结。
use std::{collections::HashMap, sync::{LazyLock, Mutex}};

type Receipt = (String, String, u32, u32, String);
type Key = (Option<u64>, String, String);

#[derive(Default)]
struct ReceiptStore {
    active: Option<u64>,
    entries: HashMap<Key, (u32, u32, String)>,
}

impl ReceiptStore {
    fn begin(&mut self, token: u64) {
        self.active = Some(token);
        self.entries.retain(|(scope, _, _), _| scope.is_none());
    }
    fn end(&mut self, token: u64) -> bool {
        if self.active != Some(token) { return false; }
        self.active = None;
        self.entries.retain(|(scope, _, _), _| scope.is_none());
        true
    }
    fn reset_renderer(&mut self) {
        self.active = None;
        self.entries.retain(|(scope, _, _), _| scope.is_none());
    }
    fn permitted(&self, scope: Option<u64>) -> bool {
        match scope {
            Some(token) => self.active == Some(token),
            None => true,
        }
    }
    fn invalidate(&mut self, scope: Option<u64>, channel: &str, id: &str) {
        if self.permitted(scope) { self.entries.remove(&(scope, channel.to_owned(), id.to_owned())); }
    }
    fn applied(&mut self, scope: Option<u64>, channel: &str, id: &str, width: u32, height: u32, content: &str) {
        if self.permitted(scope) {
            self.entries.insert((scope, channel.to_owned(), id.to_owned()), (width, height, content.to_owned()));
        }
    }
    fn take(&mut self, scope: Option<u64>) -> Vec<Receipt> {
        if !self.permitted(scope) { return Vec::new(); }
        let keys: Vec<_> = self.entries.keys().filter(|(entry_scope, _, _)| *entry_scope == scope).cloned().collect();
        keys.into_iter().filter_map(|key| self.entries.remove(&key).map(|(width, height, content)|
            (key.1, key.2, width, height, content))).collect()
    }
}

static APPLIED: LazyLock<Mutex<ReceiptStore>> = LazyLock::new(|| Mutex::new(ReceiptStore::default()));
fn serialize(rows: Vec<Receipt>) -> String { serde_json::to_string(&rows).unwrap_or_else(|_| "[]".into()) }
pub(crate) fn begin_scope(token: u64) { APPLIED.lock().unwrap().begin(token); }
pub(crate) fn end_scope(token: u64) -> bool { APPLIED.lock().unwrap().end(token) }
pub(crate) fn reset_renderer() { APPLIED.lock().unwrap().reset_renderer(); }
pub(crate) fn invalidate(channel: &str, id: &str) { APPLIED.lock().unwrap().invalidate(None, channel, id); }
pub(crate) fn invalidate_scoped(token: u64, channel: &str, id: &str) { APPLIED.lock().unwrap().invalidate(Some(token), channel, id); }
pub(crate) fn applied(channel: &str, id: &str, width: u32, height: u32, content: &str) {
    APPLIED.lock().unwrap().applied(None, channel, id, width, height, content);
}
pub(crate) fn applied_scoped(token: u64, channel: &str, id: &str, width: u32, height: u32, content: &str) {
    APPLIED.lock().unwrap().applied(Some(token), channel, id, width, height, content);
}
pub(crate) fn take() -> String { serialize(APPLIED.lock().unwrap().take(None)) }
pub(crate) fn take_scoped(token: u64) -> String { serialize(APPLIED.lock().unwrap().take(Some(token))) }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replacement_invalidates_old_receipts_and_scheduler_threads_share_outbox() {
        let _guard = super::super::test_global_state_guard();
        applied("node", "a", 128, 128, "old");
        invalidate("node", "a");
        assert_eq!(take(), "[]");
        std::thread::spawn(|| applied("node", "a", 256, 128, "new")).join().unwrap();
        assert!(take().contains("new"));
        assert_eq!(take(), "[]");
    }
    #[test]
    fn texture_receipts_reject_late_previous_scope_without_losing_new() {
        let mut store = ReceiptStore::default();
        store.begin(1);
        store.applied(Some(1), "node", "same", 1, 1, "a");
        store.begin(2);
        store.applied(Some(2), "node", "same", 1, 1, "b");
        store.applied(Some(1), "node", "same", 1, 1, "late-a");
        store.invalidate(Some(1), "node", "same");
        assert!(store.take(Some(1)).is_empty());
        let rows = store.take(Some(2));
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].4, "b");
    }
    #[test]
    fn texture_receipts_end_blocks_late_but_preserves_legacy_channel() {
        let mut store = ReceiptStore::default();
        store.begin(3);
        assert!(!store.end(2));
        store.applied(Some(3), "node", "same", 1, 1, "current");
        assert_eq!(store.take(Some(3)).len(), 1);
        assert!(store.end(3));
        store.applied(Some(3), "node", "same", 1, 1, "late");
        store.applied(None, "node", "same", 1, 1, "legacy");
        assert_eq!(store.take(None)[0].4, "legacy");
        store.reset_renderer();
        store.applied(None, "node", "same", 1, 1, "legacy");
        assert_eq!(store.take(None)[0].4, "legacy");
    }
    #[test]
    fn texture_receipts_reset_renderer_keeps_legacy_and_blocks_old_scope() {
        let mut store = ReceiptStore::default();
        store.applied(None, "node", "legacy", 1, 1, "legacy-before");
        store.begin(4);
        store.applied(Some(4), "node", "scoped", 2, 2, "scoped");
        assert_eq!(store.take(None)[0].4, "legacy-before");
        assert_eq!(store.take(Some(4))[0].4, "scoped");
        store.applied(None, "node", "legacy", 1, 1, "legacy-after");
        store.reset_renderer();
        assert_eq!(store.take(None)[0].4, "legacy-after");
        store.applied(Some(4), "node", "scoped", 2, 2, "late");
        assert!(store.take(Some(4)).is_empty());
    }
}
