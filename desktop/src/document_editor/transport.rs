//! Admission before dispatch to the UI owner thread. A reservation follows the
//! queued closure and releases capacity on completion, rejection or cancellation.
use super::{EditorError, ErrorCode, MAX_PENDING_REQUESTS};
use std::sync::{Arc, Mutex, OnceLock};

pub const MAX_DISPATCH_BYTES: usize = 64 * 1024 * 1024;
#[derive(Default)]
struct Usage {
    requests: usize,
    bytes: usize,
}
#[derive(Clone)]
pub struct ControlAdmission {
    usage: Arc<Mutex<Usage>>,
    max_requests: usize,
    max_bytes: usize,
}
impl Default for ControlAdmission {
    fn default() -> Self {
        Self::new(MAX_PENDING_REQUESTS, MAX_DISPATCH_BYTES)
    }
}
impl ControlAdmission {
    pub fn new(max_requests: usize, max_bytes: usize) -> Self {
        Self {
            usage: Arc::new(Mutex::new(Usage::default())),
            max_requests,
            max_bytes,
        }
    }
    pub fn reserve(&self, bytes: usize) -> Result<ControlReservation, EditorError> {
        let mut usage = self.usage.lock().map_err(|_| {
            EditorError::new(ErrorCode::InternalError, "control admission unavailable")
        })?;
        if usage.requests >= self.max_requests {
            return Err(EditorError::new(
                ErrorCode::Busy,
                "native editor dispatch queue is full",
            ));
        }
        if bytes > self.max_bytes.saturating_sub(usage.bytes) {
            return Err(EditorError::new(
                ErrorCode::BudgetExceeded,
                "native editor dispatch byte budget exceeded",
            ));
        }
        usage.requests += 1;
        usage.bytes += bytes;
        Ok(ControlReservation {
            usage: self.usage.clone(),
            bytes,
        })
    }
}
/// Move into the main-thread closure before scheduling it. Do not drop until
/// the request's retained transport payload has been consumed or rejected.
pub struct ControlReservation {
    usage: Arc<Mutex<Usage>>,
    bytes: usize,
}
impl Drop for ControlReservation {
    fn drop(&mut self) {
        // Recover poisoned accounting only for cleanup; new admission remains rejected.
        let mut usage = self
            .usage
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        usage.requests -= 1;
        usage.bytes -= self.bytes;
    }
}
pub fn reserve_control(bytes: usize) -> Result<ControlReservation, EditorError> {
    static ADMISSION: OnceLock<ControlAdmission> = OnceLock::new();
    ADMISSION
        .get_or_init(ControlAdmission::default)
        .reserve(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn count_is_bounded_until_queued_closures_drop() {
        let gate = ControlAdmission::default();
        let mut held = (0..MAX_PENDING_REQUESTS)
            .map(|_| gate.reserve(0).unwrap())
            .collect::<Vec<_>>();
        assert!(matches!(
            gate.reserve(0),
            Err(EditorError {
                code: ErrorCode::Busy,
                ..
            })
        ));
        held.pop();
        assert!(gate.reserve(0).is_ok());
    }
    #[test]
    fn bytes_are_aggregate_and_released_by_drop() {
        let gate = ControlAdmission::new(256, 100);
        let first = gate.reserve(80).unwrap();
        assert!(matches!(
            gate.reserve(21),
            Err(EditorError {
                code: ErrorCode::BudgetExceeded,
                ..
            })
        ));
        let second = gate.reserve(20).unwrap();
        drop(first);
        assert!(gate.reserve(80).is_ok());
        drop(second);
        assert!(gate.reserve(100).is_ok());
    }
    #[test]
    fn cancellation_or_dispatch_failure_returns_both_budgets() {
        let gate = ControlAdmission::new(1, 100);
        let reservation = gate.reserve(100).unwrap();
        let queued = move || {
            drop(reservation);
        };
        drop(queued);
        assert!(gate.reserve(100).is_ok());
    }
}
