//! Receipts after Bevy applies texture assets/bindings, not GPU presentation.
//! Native systems may run on scheduler threads; the control poll runs on the host thread.
use std::{collections::HashMap, sync::{LazyLock, Mutex}};

type Receipts = HashMap<(String, String), (u32, u32, String)>;
static APPLIED: LazyLock<Mutex<Receipts>> = LazyLock::new(|| Mutex::new(HashMap::new()));

pub(crate) fn invalidate(channel: &str, id: &str) {
    APPLIED.lock().unwrap().remove(&(channel.to_owned(), id.to_owned()));
}
pub(crate) fn applied(channel: &str, id: &str, width: u32, height: u32, content: &str) {
    APPLIED.lock().unwrap().insert(
        (channel.to_owned(), id.to_owned()), (width, height, content.to_owned()),
    );
}
pub(crate) fn take() -> String {
    let entries = std::mem::take(&mut *APPLIED.lock().unwrap());
    serde_json::to_string(&entries.into_iter().map(|((channel, id), (width, height, content))|
        (channel, id, width, height, content)).collect::<Vec<_>>()).unwrap_or_else(|_| "[]".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replacement_invalidates_old_receipts_and_scheduler_threads_share_outbox() {
        applied("node", "a", 128, 128, "old");
        invalidate("node", "a");
        assert_eq!(take(), "[]");
        std::thread::spawn(|| applied("node", "a", 256, 128, "new")).join().unwrap();
        assert!(take().contains("new"));
        assert_eq!(take(), "[]");
    }
}
