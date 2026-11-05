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

/// 断言「回执已发出」的用例必须互斥：`take()` 是排空语义，两个用例并发时会把对方
/// 刚写入的条目取走（`canvas2d::textures` 的同步测试也会写这张表）。
#[cfg(test)]
pub(crate) fn test_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}
#[cfg(test)]
mod tests {
    use super::*;
    /// 只断言本用例写入的条目：`APPLIED` 是进程级全局表，同二进制的其它测试（如
    /// `canvas2d::textures` 的纹理同步）会并发写入，`take()` 之后不保证为空。
    fn taken_contains(channel: &str, id: &str) -> bool {
        take().contains(&format!("\"{channel}\",\"{id}\""))
    }
    #[test]
    fn replacement_invalidates_old_receipts_and_scheduler_threads_share_outbox() {
        let id = "receipts-test-replacement";
        applied("node", id, 128, 128, "old");
        invalidate("node", id);
        let drained = take();
        assert!(!drained.contains(&format!("\"node\",\"{id}\"")), "{drained}");
        std::thread::spawn(move || applied("node", id, 256, 128, "new")).join().unwrap();
        assert!(taken_contains("node", id));
    }
}
