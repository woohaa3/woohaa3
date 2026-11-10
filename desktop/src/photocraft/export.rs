//! Source-size export from an immutable document snapshot. No viewport or live Session access.
use photocraft_engine::doc::Document;
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU32, Ordering},
        mpsc,
    },
    thread::JoinHandle,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExportFormat {
    Png,
    Project,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ExportError {
    Busy,
    BudgetExceeded,
    Cancelled,
    Failed(String),
}
#[derive(Debug)]
pub struct ExportCompletion {
    pub job_id: u64,
    pub document: u64,
    pub revision: u64,
    pub result: Result<Vec<u8>, ExportError>,
}
struct Pending {
    id: u64,
    document: u64,
    revision: u64,
    cancelled: Arc<AtomicBool>,
    progress: Arc<AtomicU32>,
    receiver: mpsc::Receiver<Result<Vec<u8>, ExportError>>,
    thread: JoinHandle<()>,
}
#[derive(Default)]
pub struct ExportWorker {
    next: u64,
    pending: Option<Pending>,
}
impl ExportWorker {
    pub fn busy(&self) -> bool {
        self.pending.is_some()
    }
    /// Budget covers encoded bytes. Pixel preflight also bounds transient CPU compositor work
    /// to 40 million pixels; encoding is the official engine codec, preserving layers/CMS/effects.
    pub fn start(
        &mut self,
        snapshot: Arc<Document>,
        document: u64,
        revision: u64,
        format: ExportFormat,
        output_budget: usize,
    ) -> Result<u64, ExportError> {
        if self.busy() {
            return Err(ExportError::Busy);
        }
        let pixels = u64::from(snapshot.size.width)
            .checked_mul(u64::from(snapshot.size.height))
            .ok_or(ExportError::BudgetExceeded)?;
        if pixels == 0
            || pixels > 40_000_000
            || output_budget == 0
            || output_budget > 256 * 1024 * 1024
        {
            return Err(ExportError::BudgetExceeded);
        }
        // A fixed upper bound for PNG's 16-bit RGBA scanlines plus compression framing.
        // Reject before composition rather than silently exporting a lower resolution.
        if format == ExportFormat::Png
            && pixels
                .saturating_mul(8)
                .saturating_add(pixels / 100)
                .saturating_add(1024 * 1024)
                > output_budget as u64
        {
            return Err(ExportError::BudgetExceeded);
        }
        self.next = self
            .next
            .checked_add(1)
            .ok_or(ExportError::BudgetExceeded)?;
        let id = self.next;
        let cancelled = Arc::new(AtomicBool::new(false));
        let cancel = cancelled.clone();
        let progress = Arc::new(AtomicU32::new(0));
        let fraction = progress.clone();
        let (tx, receiver) = mpsc::sync_channel(1);
        let thread = std::thread::Builder::new()
            .name("photocraft-export".into())
            .spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let check = || cancel.load(Ordering::Acquire);
                    let report = |p: f32| fraction.store(p.to_bits(), Ordering::Relaxed);
                    let interrupt = photocraft_raster::Interrupt::new(&check, &report);
                    if check() {
                        return Err(ExportError::Cancelled);
                    }
                    let name = match format {
                        ExportFormat::Png => "export.png",
                        ExportFormat::Project => "export.pcraft",
                    };
                    let encoded = photocraft_io::export_with(
                        &snapshot,
                        name,
                        &Default::default(),
                        &interrupt,
                    )
                    .map_err(|error| {
                        if check() {
                            ExportError::Cancelled
                        } else {
                            ExportError::Failed(error.to_string())
                        }
                    })?;
                    if check() {
                        return Err(ExportError::Cancelled);
                    }
                    if encoded.bytes.len() > output_budget {
                        return Err(ExportError::BudgetExceeded);
                    }
                    Ok(encoded.bytes)
                }))
                .unwrap_or_else(|_| Err(ExportError::Failed("export worker failed".into())));
                let _ = tx.send(result);
            })
            .map_err(|e| ExportError::Failed(e.to_string()))?;
        self.pending = Some(Pending {
            id,
            document,
            revision,
            cancelled,
            progress,
            receiver,
            thread,
        });
        Ok(id)
    }
    pub fn cancel(&self, id: u64) -> bool {
        if let Some(p) = &self.pending {
            if p.id == id {
                p.cancelled.store(true, Ordering::Release);
                return true;
            }
        }
        false
    }
    pub fn progress(&self) -> Option<(u64, f32)> {
        self.pending
            .as_ref()
            .map(|p| (p.id, f32::from_bits(p.progress.load(Ordering::Relaxed))))
    }
    /// Never waits for a worker. Cancellation is checked again here, including cancellation
    /// after encoding finished but before the result was consumed.
    pub fn poll(&mut self) -> Option<ExportCompletion> {
        let p = self.pending.as_ref()?;
        if !p.thread.is_finished() {
            return None;
        }
        let result = match p.receiver.try_recv() {
            Ok(result) => result,
            Err(_) => Err(ExportError::Failed("export worker disconnected".into())),
        };
        let p = self.pending.take()?;
        let _ = p.thread.join();
        Some(ExportCompletion {
            job_id: p.id,
            document: p.document,
            revision: p.revision,
            result: if p.cancelled.load(Ordering::Acquire) {
                Err(ExportError::Cancelled)
            } else {
                result
            },
        })
    }
    pub fn shutdown(&mut self) {
        if let Some(p) = self.pending.take() {
            p.cancelled.store(true, Ordering::Release);
            let _ = p.thread.join();
        }
    }
}
impl Drop for ExportWorker {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use photocraft_engine::Session;
    fn document(width: u32, height: u32) -> Arc<Document> {
        let mut session = Session::new();
        session
            .execute(
                "file.new",
                serde_json::json!({"width":width,"height":height}),
            )
            .unwrap();
        session.active().unwrap().doc.clone()
    }
    fn wait(worker: &mut ExportWorker) -> ExportCompletion {
        let until = std::time::Instant::now() + std::time::Duration::from_secs(120);
        loop {
            if let Some(result) = worker.poll() {
                return result;
            }
            assert!(std::time::Instant::now() < until);
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
    }
    #[test]
    fn saved_project_round_trips_multiple_layers() {
        let mut snapshot = document(16, 16);
        let mut layer = snapshot.layers[0].clone();
        layer.id.0 += 1;
        layer.name = "Saved second layer".into();
        Arc::make_mut(&mut snapshot).layers.push(layer);
        let mut worker = ExportWorker::default();
        worker
            .start(
                snapshot.clone(),
                1,
                0,
                ExportFormat::Project,
                64 * 1024 * 1024,
            )
            .unwrap();
        let bytes = wait(&mut worker).result.unwrap();
        let restored = photocraft_io::import("saved.pcraft", &bytes)
            .unwrap()
            .document;
        assert_eq!(restored.layers.len(), 2);
        assert_eq!(restored.layers[1].name, "Saved second layer");
        if let Some(path) = std::env::var_os("WOOHAA_TEST_PROJECT_FIXTURE") {
            std::fs::write(&path, &bytes).unwrap();
            worker
                .start(snapshot, 1, 0, ExportFormat::Png, 256 * 1024 * 1024)
                .unwrap();
            std::fs::write(
                format!("{}.png", std::path::Path::new(&path).display()),
                wait(&mut worker).result.unwrap(),
            )
            .unwrap();
        }
    }
    #[test]
    fn source_size_exports_4k_and_8k_without_viewport_or_document_mutation() {
        for (w, h) in [(3840, 2100), (7680, 4200)] {
            let mut snapshot = document(w, h);
            if let photocraft_engine::doc::LayerContent::Raster(surface) =
                &mut Arc::make_mut(&mut snapshot).layers[0].content
            {
                surface.write_pixel((w - 1) as i32, (h - 1) as i32, &[1.0, 0.0, 0.0, 1.0]);
            }
            let before = snapshot.clone();
            let mut worker = ExportWorker::default();
            worker
                .start(
                    snapshot.clone(),
                    7,
                    19,
                    ExportFormat::Png,
                    256 * 1024 * 1024,
                )
                .unwrap();
            let completion = wait(&mut worker);
            let bytes = completion.result.unwrap();
            assert_eq!(u32::from_be_bytes(bytes[16..20].try_into().unwrap()), w);
            assert_eq!(u32::from_be_bytes(bytes[20..24].try_into().unwrap()), h);
            let decoded = photocraft_io::import("export.png", &bytes)
                .unwrap()
                .document;
            let photocraft_engine::doc::LayerContent::Raster(surface) = &decoded.layers[0].content
            else {
                panic!("PNG must decode as pixels");
            };
            assert_eq!(
                &surface.pixel((w - 1) as i32, (h - 1) as i32)[..3],
                &[1.0, 0.0, 0.0]
            );
            assert_eq!(completion.document, 7);
            assert_eq!(completion.revision, 19);
            assert_eq!(*snapshot, *before);
        }
    }
    #[test]
    fn only_one_export_and_cancelled_results_never_escape() {
        let doc = document(128, 128);
        let mut worker = ExportWorker::default();
        let id = worker
            .start(doc.clone(), 1, 2, ExportFormat::Png, 1024 * 1024 * 2)
            .unwrap();
        assert_eq!(
            worker.start(doc.clone(), 1, 2, ExportFormat::Png, 1024 * 1024 * 2),
            Err(ExportError::Busy)
        );
        assert!(worker.cancel(id));
        assert_eq!(wait(&mut worker).result, Err(ExportError::Cancelled));
        let id = worker
            .start(doc, 1, 2, ExportFormat::Png, 1024 * 1024 * 2)
            .unwrap();
        while !worker.pending.as_ref().unwrap().thread.is_finished() {
            std::thread::yield_now();
        }
        assert!(worker.cancel(id));
        assert_eq!(wait(&mut worker).result, Err(ExportError::Cancelled));
    }
    #[test]
    fn codec_stage_failure_does_not_mutate_snapshot_or_publish_bytes() {
        use photocraft_engine::doc::{Group, Layer, LayerContent, MAX_GROUP_DEPTH};
        let mut snapshot = (*document(16, 16)).clone();
        let mut layer = snapshot.layers[0].clone();
        for _ in 0..MAX_GROUP_DEPTH + 2 {
            layer = Layer::new(
                "group",
                LayerContent::Group(Group {
                    children: vec![layer],
                    expanded: true,
                    artboard: None,
                }),
            );
        }
        snapshot.layers = vec![layer];
        let before = snapshot.clone();
        let snapshot = Arc::new(snapshot);
        let mut worker = ExportWorker::default();
        worker
            .start(
                snapshot.clone(),
                1,
                4,
                ExportFormat::Project,
                16 * 1024 * 1024,
            )
            .unwrap();
        assert!(matches!(
            wait(&mut worker).result,
            Err(ExportError::Failed(_))
        ));
        assert_eq!(*snapshot, before);
    }
    #[test]
    fn project_round_trip_and_budget_failure_preserve_source() {
        let snapshot = document(32, 24);
        let mut worker = ExportWorker::default();
        assert_eq!(
            worker.start(snapshot.clone(), 1, 3, ExportFormat::Png, 1),
            Err(ExportError::BudgetExceeded)
        );
        worker
            .start(
                snapshot.clone(),
                1,
                3,
                ExportFormat::Project,
                16 * 1024 * 1024,
            )
            .unwrap();
        let bytes = wait(&mut worker).result.unwrap();
        let imported = photocraft_io::import("export.pcraft", &bytes).unwrap();
        assert_eq!(imported.document.size, snapshot.size);
        assert_eq!(imported.document.layers, snapshot.layers);
        worker
            .start(snapshot.clone(), 1, 3, ExportFormat::Project, 1)
            .unwrap();
        assert_eq!(wait(&mut worker).result, Err(ExportError::BudgetExceeded));
        assert_eq!(snapshot.size.width, 32);
    }
}
