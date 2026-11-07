//! Native preparation jobs. Compressed bytes are explicitly registered by an authorised caller.
//! This module has no network or filesystem access and never touches a renderer from its workers.
use crate::{PreparedImage, prepare, validate_input};
use std::{
    collections::HashMap,
    sync::atomic::{AtomicU64, Ordering},
    sync::{Arc, Mutex, OnceLock, mpsc},
};
static NEXT: AtomicU64 = AtomicU64::new(1);
struct Job {
    state: Mutex<State>,
}
enum State {
    Pending,
    Ready(Arc<PreparedImage>),
    Failed(String),
    Cancelled,
    Released,
}
struct Work {
    job: Arc<Job>,
    bytes: Vec<u8>,
    edge: u32,
}
pub struct NativeImageJobs {
    jobs: Mutex<HashMap<String, Arc<Job>>>,
    sender: mpsc::SyncSender<Work>,
}
#[derive(Debug, Clone, PartialEq)]
pub enum Snapshot {
    Pending,
    Draining,
    Released,
    Ready {
        width: u32,
        height: u32,
        source_width: u32,
        source_height: u32,
    },
    Failed(String),
}
impl NativeImageJobs {
    pub fn new() -> Self {
        let (sender, receiver) = mpsc::sync_channel::<Work>(2);
        let receiver = Arc::new(Mutex::new(receiver));
        for _ in 0..2 {
            let receiver = receiver.clone();
            std::thread::spawn(move || {
                loop {
                    let Ok(work) = receiver.lock().unwrap().recv() else {
                        break;
                    };
                    {
                        let mut state = work.job.state.lock().unwrap();
                        if matches!(*state, State::Cancelled) {
                            *state = State::Released;
                            continue;
                        }
                    }
                    let result = std::panic::catch_unwind(|| prepare(&work.bytes, work.edge));
                    let mut state = work.job.state.lock().unwrap();
                    if matches!(*state, State::Cancelled) {
                        *state = State::Released;
                        continue;
                    }
                    *state = match result {
                        Ok(Ok(image)) => State::Ready(Arc::new(image)),
                        Ok(Err(e)) => State::Failed(e),
                        Err(_) => State::Failed("native-image-worker-panic".into()),
                    };
                }
            });
        }
        Self {
            jobs: Mutex::new(HashMap::new()),
            sender,
        }
    }
    pub fn register(&self, bytes: Vec<u8>, edge: u32) -> Result<String, String> {
        validate_input(&bytes)?;
        if edge == 0 || edge > crate::MAX_EDGE {
            return Err("variant-limit".into());
        }
        let mut jobs = self.jobs.lock().unwrap();
        jobs.retain(|_, job| !matches!(*job.state.lock().unwrap(), State::Released));
        // Bound completed leases too. The owner must release before registering more.
        if jobs.len() >= 16 {
            return Err("native-image-lease-budget".into());
        }
        let handle = NEXT.fetch_add(1, Ordering::Relaxed).to_string();
        let job = Arc::new(Job {
            state: Mutex::new(State::Pending),
        });
        self.sender
            .try_send(Work {
                job: job.clone(),
                bytes,
                edge,
            })
            .map_err(|_| "native-image-busy".to_string())?;
        jobs.insert(handle.clone(), job);
        Ok(handle)
    }
    pub fn poll(&self, handle: &str) -> Result<Snapshot, String> {
        let jobs = self.jobs.lock().unwrap();
        let job = jobs.get(handle).ok_or("native-image-released")?;
        let state = job.state.lock().unwrap();
        Ok(match &*state {
            State::Pending => Snapshot::Pending,
            State::Ready(i) => Snapshot::Ready {
                width: i.width,
                height: i.height,
                source_width: i.source_width,
                source_height: i.source_height,
            },
            State::Failed(e) => Snapshot::Failed(e.clone()),
            State::Cancelled => Snapshot::Draining,
            State::Released => Snapshot::Released,
        })
    }
    pub fn image(&self, handle: &str) -> Result<Arc<PreparedImage>, String> {
        let jobs = self.jobs.lock().unwrap();
        let job = jobs.get(handle).ok_or("native-image-released")?;
        let state = job.state.lock().unwrap();
        match &*state {
            State::Ready(image) => Ok(image.clone()),
            _ => Err("native-image-not-ready".into()),
        }
    }
    /// Returns true while the underlying non-preemptible job is still draining.
    pub fn release(&self, handle: &str) -> bool {
        let mut jobs = self.jobs.lock().unwrap();
        let Some(job) = jobs.get(handle) else {
            return false;
        };
        let mut state = job.state.lock().unwrap();
        if matches!(*state, State::Pending | State::Cancelled) {
            *state = State::Cancelled;
            return true;
        }
        *state = State::Released;
        drop(state);
        jobs.remove(handle);
        false
    }
}
impl Default for NativeImageJobs {
    fn default() -> Self {
        Self::new()
    }
}
pub fn native_jobs() -> &'static NativeImageJobs {
    static JOBS: OnceLock<NativeImageJobs> = OnceLock::new();
    JOBS.get_or_init(NativeImageJobs::new)
}
#[cfg(test)]
mod tests {
    use super::*;
    /// The native registrar enforces the same ceiling as `prepare`; both must follow the top
    /// residency tier (4096) or a zoomed-in card on the desktop shell is refused outright.
    #[test]
    fn register_accepts_the_full_ceiling_and_refuses_one_past_it() {
        let jobs = NativeImageJobs::new();
        let ok = jobs.register(b"invalid".to_vec(), crate::MAX_EDGE).unwrap();
        jobs.release(&ok);
        assert_eq!(
            jobs.register(b"invalid".to_vec(), crate::MAX_EDGE + 1)
                .unwrap_err(),
            "variant-limit"
        );
        assert_eq!(
            jobs.register(b"invalid".to_vec(), 0).unwrap_err(),
            "variant-limit"
        );
    }
    #[test]
    fn releases_are_idempotent_and_late_completion_cannot_restore_a_lease() {
        let jobs = NativeImageJobs::new();
        let id = jobs.register(b"invalid".to_vec(), 128).unwrap();
        jobs.release(&id);
        jobs.release(&id);
        assert!(!matches!(jobs.poll(&id), Ok(Snapshot::Ready { .. })));
        assert!(jobs.image(&id).is_err());
    }
    #[test]
    fn produces_owned_native_pixels() {
        let jobs = NativeImageJobs::new();
        let id = jobs
            .register(include_bytes!("../tests/fixtures/alpha.avif").to_vec(), 128)
            .unwrap();
        let until = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while jobs.poll(&id).unwrap() == Snapshot::Pending {
            assert!(std::time::Instant::now() < until);
            std::thread::yield_now();
        }
        assert!(matches!(
            jobs.poll(&id).unwrap(),
            Snapshot::Ready {
                width: 4,
                height: 2,
                ..
            }
        ));
        assert_eq!(jobs.image(&id).unwrap().pixels().len(), 32);
        jobs.release(&id);
    }
}
