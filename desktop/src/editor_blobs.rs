//! Bounded binary editor transfer. Uploads survive rejected owner admission for retry;
//! exported payloads are weak references to retained control receipts, never duplicate caches.
use crate::document_editor::{CompletionReceipt, OperationResult};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex, OnceLock, Weak},
    time::{Duration, Instant},
};
pub(crate) const MAX_BLOB_BYTES: usize = 64 * 1024 * 1024;
const UPLOAD_TTL: Duration = Duration::from_secs(120);
struct Upload {
    ticket: String,
    bytes: Arc<Vec<u8>>,
    created: Instant,
}
#[derive(Default)]
struct Blobs {
    upload: Option<Upload>,
    output: BTreeMap<String, Weak<CompletionReceipt>>,
    revoked: Vec<Weak<CompletionReceipt>>,
}
fn store() -> &'static Mutex<Blobs> {
    static STORE: OnceLock<Mutex<Blobs>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(Blobs::default()))
}
fn prune_upload(blobs: &mut Blobs) {
    if blobs
        .upload
        .as_ref()
        .is_some_and(|u| u.created.elapsed() > UPLOAD_TTL)
    {
        blobs.upload = None;
    }
}
pub(crate) fn upload(bytes: Vec<u8>) -> Result<String, String> {
    if bytes.is_empty() || bytes.len() > MAX_BLOB_BYTES {
        return Err("editor upload exceeds byte budget".into());
    }
    let mut blobs = store()
        .lock()
        .map_err(|_| "editor binary cache unavailable")?;
    prune_upload(&mut blobs);
    if blobs.upload.is_some() {
        return Err("editor upload busy; retry current ticket or wait for its 120s expiry".into());
    }
    let ticket = uuid::Uuid::new_v4().to_string();
    blobs.upload = Some(Upload {
        ticket: ticket.clone(),
        bytes: Arc::new(bytes),
        created: Instant::now(),
    });
    Ok(ticket)
}
pub(crate) fn source(ticket: &str) -> Result<Arc<Vec<u8>>, String> {
    let mut blobs = store()
        .lock()
        .map_err(|_| "editor binary cache unavailable")?;
    prune_upload(&mut blobs);
    blobs
        .upload
        .as_ref()
        .filter(|u| u.ticket == ticket)
        .map(|u| u.bytes.clone())
        .ok_or("editor upload expired or unknown".into())
}
pub(crate) fn admitted(ticket: &str) {
    if let Ok(mut blobs) = store().lock() {
        if blobs.upload.as_ref().is_some_and(|u| u.ticket == ticket) {
            blobs.upload = None;
        }
    }
}
pub(crate) fn output(receipt: &Arc<CompletionReceipt>) -> Result<String, String> {
    let mut blobs = store()
        .lock()
        .map_err(|_| "editor binary cache unavailable")?;
    blobs.output.retain(|_, value| value.strong_count() > 0);
    blobs.revoked.retain(|value| value.strong_count() > 0);
    if blobs
        .revoked
        .iter()
        .any(|value| std::ptr::eq(value.as_ptr(), Arc::as_ptr(receipt)))
    {
        return Err("editor export already acknowledged".into());
    }
    if let Some((ticket, _)) = blobs
        .output
        .iter()
        .find(|(_, value)| std::ptr::eq(value.as_ptr(), Arc::as_ptr(receipt)))
    {
        return Ok(ticket.clone());
    }
    if blobs.output.len() >= 256 {
        return Err("editor binary receipt budget exceeded".into());
    }
    let ticket = uuid::Uuid::new_v4().to_string();
    blobs.output.insert(ticket.clone(), Arc::downgrade(receipt));
    Ok(ticket)
}
pub(crate) fn download(ticket: &str) -> Result<Arc<CompletionReceipt>, String> {
    store()
        .lock()
        .map_err(|_| "editor binary cache unavailable")?
        .output
        .get(ticket)
        .and_then(Weak::upgrade)
        .filter(|r| matches!(&r.result, Ok(OperationResult::Exported { .. })))
        .ok_or("editor export acknowledged or unknown".into())
}
pub(crate) fn acknowledge(request_id: u64) {
    if let Ok(mut blobs) = store().lock() {
        blobs
            .output
            .retain(|_, value| value.upgrade().is_some_and(|r| r.request_id != request_id));
    }
}

pub(crate) fn revoke(receipt: &Arc<CompletionReceipt>) {
    acknowledge(receipt.request_id);
    if let Ok(mut blobs) = store().lock() {
        blobs.revoked.retain(|value| value.strong_count() > 0);
        if !blobs
            .revoked
            .iter()
            .any(|value| std::ptr::eq(value.as_ptr(), Arc::as_ptr(receipt)))
        {
            blobs.revoked.push(Arc::downgrade(receipt));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejected_upload_retry_retains_bytes_and_admission_consumes_ticket() {
        let bytes = vec![7; 5 * 1024 * 1024];
        let ticket = upload(bytes).unwrap();
        assert!(upload(vec![9]).is_err());
        assert_eq!(source(&ticket).unwrap().len(), 5 * 1024 * 1024);
        let wire=serde_json::json!({"session_id":"test","request_id":1,"generation":1,"operation":{"kind":"open","source_id":"image","node_binding":null,"format":"image/png","bytes_blob_id":ticket}}).to_string();
        assert!(wire.len() < 512);
        let prepared =
            crate::editor_runtime::prepare("document_editor_enqueue", Some(&wire)).unwrap();
        let crate::editor_runtime::PreparedControl::Enqueue(request, Some(_)) = prepared else {
            panic!("binary Open not prepared");
        };
        let crate::document_editor::ControlOperation::Open { bytes, .. } = request.operation else {
            panic!("not Open");
        };
        assert_eq!(bytes.len(), 5 * 1024 * 1024);
        assert!(
            source(&ticket).is_ok(),
            "preparation alone must not consume retry data"
        );
        admitted(&ticket);
        assert!(source(&ticket).is_err());
    }
    #[test]
    fn export_cache_is_weak_and_ack_revokes_even_while_poll_snapshot_exists() {
        let r = Arc::new(CompletionReceipt {
            request_id: 654321,
            generation: 1,
            result: Ok(OperationResult::Exported {
                bytes: vec![9],
                revision: 1,
            }),
        });
        let ticket = output(&r).unwrap();
        assert_eq!(ticket, output(&r).unwrap());
        assert!(Arc::ptr_eq(&download(&ticket).unwrap(), &r));
        acknowledge(r.request_id);
        assert!(download(&ticket).is_err());
        let ticket = output(&r).unwrap();
        revoke(&r);
        assert!(
            output(&r).is_err(),
            "late poll serialization cannot resurrect acknowledged ticket"
        );
        drop(r);
        assert!(download(&ticket).is_err());
    }
}
