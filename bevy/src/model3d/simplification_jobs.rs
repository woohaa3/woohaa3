//! At most one asynchronous content job, bounded source retention and queue.
//! Browser work first yields to an idle callback (timer fallback), rather than
//! running immediately in Bevy's microtask. This is still not a worker thread:
//! a running simplification is indivisible and has no elapsed-time guarantee.
use super::{
    quality::Quality,
    scene::ModelGeometry,
    simplification::{self, Fallback, Reduced},
};
use bevy::{
    platform::time::Instant,
    tasks::{AsyncComputeTaskPool, Task, TaskPoolBuilder, block_on, poll_once},
};
use std::{
    collections::{BTreeMap, VecDeque},
    sync::Arc,
};

const MAX_JOBS: usize = 64;
const MAX_BYTES: usize = 16 * 1024 * 1024;

/// Let rendering and input run before each content job. The timeout prevents
/// continuous interaction from starving derived geometry indefinitely. Passing
/// Promise's JS resolver directly avoids Rust callbacks outliving a dropped Task.
#[cfg(all(target_arch = "wasm32", feature = "wasm"))]
async fn wait_for_browser_turn() {
    use wasm_bindgen::{JsCast, JsValue};
    let promise = js_sys::Promise::new(&mut |resolve, _reject| {
        let global = js_sys::global();
        let options = js_sys::Object::new();
        let _ = js_sys::Reflect::set(&options, &"timeout".into(), &250.into());
        let idle = js_sys::Reflect::get(&global, &"requestIdleCallback".into())
            .ok()
            .and_then(|value| value.dyn_into::<js_sys::Function>().ok());
        if idle.is_some_and(|idle| idle.call2(&global, &resolve, &options).is_ok()) {
            return;
        }
        let timer = js_sys::Reflect::get(&global, &"setTimeout".into())
            .ok()
            .and_then(|value| value.dyn_into::<js_sys::Function>().ok());
        if timer.is_some_and(|timer| timer.call2(&global, &resolve, &16.into()).is_ok()) {
            return;
        }
        // A non-window JS host may provide neither API. Keep high usable and
        // permit the bounded job rather than leaving a permanently pending task.
        let _ = resolve.call0(&JsValue::UNDEFINED);
    });
    let _ = wasm_bindgen_futures::JsFuture::from(promise).await;
}

#[cfg(not(all(target_arch = "wasm32", feature = "wasm")))]
async fn wait_for_browser_turn() {}
pub(super) struct Job {
    pub key: String,
    pub geometry: Arc<ModelGeometry>,
    pub quality: Quality,
    bytes: usize,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pending_source_retention_is_bounded_and_cancellation_drops_all_work() {
        let geometry = Arc::new(ModelGeometry::Mesh {
            vertices: vec![[0., 0., 0.]; 100],
            faces: vec![[0, 1, 2]; 100],
        });
        let mut jobs = Jobs::default();
        for index in 0..MAX_JOBS + 3 {
            jobs.enqueue(index.to_string(), geometry.clone(), Quality::Low);
        }
        assert_eq!(jobs.pending.len(), MAX_JOBS);
        assert!(jobs.bytes <= MAX_BYTES);
        assert_eq!(jobs.diagnostics()["fallbacks"]["SizeBudget"], 3);
        jobs.clear();
        assert_eq!(jobs.bytes, 0);
        assert!(jobs.poll().is_none());
        assert!(jobs.running.is_none());
        let oversized = Arc::new(ModelGeometry::Mesh {
            vertices: vec![[0., 0., 0.]; simplification::MAX_VERTICES + 1],
            faces: vec![[0, 1, 2]; 100],
        });
        jobs.enqueue("large".into(), oversized, Quality::Low);
        assert!(jobs.pending.is_empty());
        assert_eq!(jobs.bytes, 0);
    }
}
pub(super) struct Finished {
    pub job: Job,
    pub result: Result<Reduced, Fallback>,
    ms: f64,
    wait_ms: f64,
}
#[derive(Default)]
pub(super) struct Jobs {
    pending: VecDeque<Job>,
    running: Option<Task<Finished>>,
    bytes: usize,
    generated: u64,
    cancelled: u64,
    failures: BTreeMap<String, u64>,
    total_ms: f64,
    max_ms: f64,
    wait_total_ms: f64,
    wait_max_ms: f64,
    max_error: f32,
}
impl Jobs {
    pub fn enqueue(&mut self, key: String, geometry: Arc<ModelGeometry>, quality: Quality) {
        let ModelGeometry::Mesh { vertices, faces } = geometry.as_ref() else {
            return;
        };
        if faces.len() < 64 {
            self.failure(Fallback::Small);
            return;
        }
        let bytes = vertices.len() * 12 + faces.len() * 12;
        if vertices.len() > simplification::MAX_VERTICES
            || faces.len() > simplification::MAX_FACES
            || self.pending.len() + usize::from(self.running.is_some()) >= MAX_JOBS
            || self.bytes + bytes > MAX_BYTES
        {
            self.failure(Fallback::SizeBudget);
            return;
        }
        self.bytes += bytes;
        self.pending.push_back(Job {
            key,
            geometry,
            quality,
            bytes,
        });
    }
    fn failure(&mut self, reason: Fallback) {
        *self.failures.entry(format!("{reason:?}")).or_default() += 1;
    }
    pub fn poll(&mut self) -> Option<Finished> {
        let completed = self
            .running
            .as_mut()
            .and_then(|task| block_on(poll_once(task)));
        if let Some(finished) = &completed {
            self.running = None;
            self.bytes = self.bytes.saturating_sub(finished.job.bytes);
            self.total_ms += finished.ms;
            self.max_ms = self.max_ms.max(finished.ms);
            self.wait_total_ms += finished.wait_ms;
            self.wait_max_ms = self.wait_max_ms.max(finished.wait_ms);
            match &finished.result {
                Ok(reduced) => {
                    self.generated += 1;
                    self.max_error = self.max_error.max(reduced.error);
                }
                Err(reason) => self.failure(*reason),
            }
        }
        if self.running.is_none() {
            if let Some(job) = self.pending.pop_front() {
                let pool = AsyncComputeTaskPool::get_or_init(|| {
                    TaskPoolBuilder::new().num_threads(1).build()
                });
                self.running = Some(pool.spawn(async move {
                    let queued = Instant::now();
                    wait_for_browser_turn().await;
                    let wait_ms = queued.elapsed().as_secs_f64() * 1000.0;
                    let start = Instant::now();
                    let result = simplification::generate(&job.geometry, job.quality);
                    Finished {
                        job,
                        result,
                        ms: start.elapsed().as_secs_f64() * 1000.0,
                        wait_ms,
                    }
                }));
            }
        }
        completed
    }
    /// Cancel queued source work that no longer has renderer ownership.
    /// Running synchronous native work cannot be preempted mid-simplification.
    pub fn retain_pending(&mut self, mut keep: impl FnMut(&Job) -> bool) -> Vec<Job> {
        let mut cancelled = Vec::new();
        let mut retained = VecDeque::new();
        while let Some(job) = self.pending.pop_front() {
            if keep(&job) {
                retained.push_back(job);
            } else {
                self.bytes = self.bytes.saturating_sub(job.bytes);
                self.cancelled += 1;
                cancelled.push(job);
            }
        }
        self.pending = retained;
        cancelled
    }
    pub fn clear(&mut self) {
        self.pending.clear();
        self.running = None;
        self.bytes = 0;
    }
    pub fn diagnostics(&self) -> serde_json::Value {
        let (active_bytes, peak_bytes) = super::simplification_allocator::workspace_bytes();
        serde_json::json!({ "algorithm": "meshoptimizer-0.6.2", "version": simplification::VERSION,
            "pending": self.pending.len(), "active": usize::from(self.running.is_some()),
            "sourceBytes": self.bytes, "generated": self.generated, "cancelled": self.cancelled, "fallbacks": self.failures,
            "generationTotalMs": self.total_ms, "generationMaxMs": self.max_ms,
            "schedulingWaitTotalMs": self.wait_total_ms, "schedulingWaitMaxMs": self.wait_max_ms,
            "cppWorkspaceActiveBytes": active_bytes, "cppWorkspacePeakBytes": peak_bytes,
            "maxRelativeQuadricError": self.max_error })
    }
}
