//! Native PhotoCraft editor for the desktop host.
//! The engine Session remains the only document/history authority.
use photocraft_engine::{
    Session,
    jobs::{JobId, OpenSource, Started},
};
use serde_json::Value;
use std::sync::Arc;

pub const MAX_DOCUMENTS: usize = 8;
pub const MAX_SOURCE_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum AdapterError {
    Busy,
    BudgetExceeded,
    StaleRevision,
    UnknownDocument,
    NeedsSettlement,
    Unsupported,
    Engine(String),
}

// Compile-time owner choice: never retain a standalone Session beside the official app.
struct EngineOwner {
    #[cfg(not(feature = "native-ui"))]
    session: Session,
    #[cfg(feature = "native-ui")]
    app: photocraft_ui_egui::PhotocraftApp,
}
impl EngineOwner {
    fn new() -> Self {
        #[cfg(not(feature = "native-ui"))]
        {
            Self {
                session: Session::new(),
            }
        }
        #[cfg(feature = "native-ui")]
        {
            let mut app =
                photocraft_ui_egui::PhotocraftApp::new(Session::new(), Default::default());
            app.background_jobs = true;
            Self { app }
        }
    }
}
impl std::ops::Deref for EngineOwner {
    type Target = Session;
    fn deref(&self) -> &Session {
        #[cfg(not(feature = "native-ui"))]
        {
            &self.session
        }
        #[cfg(feature = "native-ui")]
        {
            &self.app.session
        }
    }
}
impl std::ops::DerefMut for EngineOwner {
    fn deref_mut(&mut self) -> &mut Session {
        #[cfg(not(feature = "native-ui"))]
        {
            &mut self.session
        }
        #[cfg(feature = "native-ui")]
        {
            &mut self.app.session
        }
    }
}
pub struct NativeSession {
    engine: EngineOwner,
    opening: Option<JobId>,
    visible: bool,
    exports: export::ExportWorker,
    #[cfg(feature = "native-ui")]
    job_context: egui::Context,
}
impl Default for NativeSession {
    fn default() -> Self {
        Self::new()
    }
}
impl NativeSession {
    pub fn new() -> Self {
        Self {
            engine: EngineOwner::new(),
            opening: None,
            visible: false,
            exports: Default::default(),
            #[cfg(feature = "native-ui")]
            job_context: egui::Context::default(),
        }
    }
    /// Only immutable access is exposed: callers cannot create a second document owner.
    pub fn engine(&self) -> &Session {
        &self.engine
    }
    #[cfg(feature = "native-ui")]
    pub fn with_services(services: photocraft_ui_egui::Services) -> Self {
        let mut app = photocraft_ui_egui::PhotocraftApp::new(Session::new(), services);
        app.background_jobs = true;
        Self {
            engine: EngineOwner { app },
            opening: None,
            visible: false,
            exports: Default::default(),
            #[cfg(feature = "native-ui")]
            job_context: egui::Context::default(),
        }
    }
    #[cfg(feature = "native-ui")]
    pub fn prepare_ui_input(&mut self, context: &egui::Context, input: &mut egui::RawInput) {
        self.engine.app.host_raw_input(context, input);
    }
    #[cfg(feature = "native-ui")]
    pub fn tick_ui(&mut self, context: &egui::Context) -> Vec<photocraft_engine::jobs::JobEvent> {
        self.engine.app.host_logic(context)
    }
    #[cfg(feature = "native-ui")]
    pub fn draw_ui(&mut self, ui: &mut egui::Ui, previous_cpu_seconds: Option<f32>) {
        self.engine.app.host_ui(ui, previous_cpu_seconds);
    }
    pub fn show(&mut self, visible: bool) {
        self.visible = visible;
    }
    pub fn visible(&self) -> bool {
        self.visible
    }
    /// Called on the coordinator thread, never on the OS/UI event callback.
    pub fn open(&mut self, name: &str, bytes: Arc<Vec<u8>>) -> Result<Started, AdapterError> {
        if self.opening.is_some() || self.engine.documents().len() >= MAX_DOCUMENTS {
            return Err(AdapterError::Busy);
        }
        if bytes.len() > MAX_SOURCE_BYTES {
            return Err(AdapterError::BudgetExceeded);
        }
        let started = self
            .engine
            .start_open(name, OpenSource::Bytes(bytes))
            .map_err(engine_error)?;
        if let Started::Job(id) = started {
            self.opening = Some(id);
        }
        Ok(started)
    }
    pub fn start_export(
        &mut self,
        document: u64,
        revision: u64,
        format: export::ExportFormat,
    ) -> Result<u64, export::ExportError> {
        let doc = self
            .engine
            .documents()
            .iter()
            .find(|d| d.doc.id.0 == document)
            .ok_or(export::ExportError::Failed("Unknown document".into()))?;
        if doc.revision != revision {
            return Err(export::ExportError::Failed("Stale revision".into()));
        }
        self.exports.start(
            doc.doc.clone(),
            document,
            revision,
            format,
            256 * 1024 * 1024,
        )
    }
    pub fn mark_saved(&mut self, document: u64, revision: u64) -> Result<(), AdapterError> {
        let prior = self.engine.active().map(|d| d.doc.id.0);
        let target = self
            .engine
            .documents()
            .iter()
            .find(|d| d.doc.id.0 == document)
            .ok_or(AdapterError::UnknownDocument)?;
        if revision > target.revision {
            return Err(AdapterError::StaleRevision);
        }
        self.activate(document)?;
        self.engine
            .active_mut()
            .ok_or(AdapterError::UnknownDocument)?
            .saved_revision = revision;
        if let Some(prior) = prior {
            self.activate(prior)?;
        }
        Ok(())
    }
    pub fn activate(&mut self, document: u64) -> Result<(), AdapterError> {
        let index = self
            .engine
            .documents()
            .iter()
            .position(|d| d.doc.id.0 == document)
            .ok_or(AdapterError::UnknownDocument)?;
        self.engine.set_active(index);
        Ok(())
    }
    pub fn close(&mut self, document: u64, discard: bool) -> Result<(), AdapterError> {
        let index = self
            .engine
            .documents()
            .iter()
            .position(|d| d.doc.id.0 == document)
            .ok_or(AdapterError::UnknownDocument)?;
        let doc = &self.engine.documents()[index];
        if self.engine.job_on(doc.doc.id).is_some() {
            return Err(AdapterError::Busy);
        }
        if doc.revision != doc.saved_revision && !discard {
            return Err(AdapterError::NeedsSettlement);
        }
        self.engine.close(index);
        Ok(())
    }
    /// Narrow allowlist: unknown commands may compute inline even with `Session::start`.
    /// File/open/export are separate bounded job operations, never arbitrary engine calls.
    pub fn start_command(
        &mut self,
        document: u64,
        revision: u64,
        command: &str,
        params: Value,
    ) -> Result<Started, AdapterError> {
        if !matches!(
            command,
            "paint.remove" | "paint.spotHealing" | "edit.undo" | "edit.redo"
        ) {
            return Err(AdapterError::Unsupported);
        }
        self.activate(document)?;
        let doc = self.engine.active().ok_or(AdapterError::UnknownDocument)?;
        if doc.revision != revision {
            return Err(AdapterError::StaleRevision);
        }
        if self.engine.job_on(doc.doc.id).is_some() {
            return Err(AdapterError::Busy);
        }
        self.engine.start(command, params).map_err(engine_error)
    }
    /// Poll/apply is the sole worker-result commit point. The engine checks cancellation and
    /// snapshot identity before applying and supplies its existing single-step undo semantics.
    pub fn poll(&mut self) -> Vec<photocraft_engine::jobs::JobEvent> {
        #[cfg(not(feature = "native-ui"))]
        let events = self.engine.poll_jobs();
        #[cfg(feature = "native-ui")]
        let events =
            photocraft_ui_egui::jobs_ui::tick_events(&mut self.engine.app, &self.job_context);
        if self
            .opening
            .is_some_and(|id| self.engine.job(id).is_none_or(|j| j.state != "running"))
        {
            self.opening = None;
        }
        events
    }
    pub fn cancel(&mut self, job: JobId) -> bool {
        self.engine.cancel_job(job)
    }
    pub fn shutdown(&mut self) {
        self.exports.shutdown();
        self.engine.cancel_all_jobs();
        self.engine.join_cancelled_jobs();
        self.opening = None;
    }
}
impl Drop for NativeSession {
    fn drop(&mut self) {
        self.shutdown();
    }
}
fn engine_error(e: photocraft_engine::EngineError) -> AdapterError {
    AdapterError::Engine(e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unsupported_commands_cannot_enter_inline_path() {
        let mut s = NativeSession::new();
        assert_eq!(
            s.start_command(1, 1, "filter.gaussianBlur", Value::Null),
            Err(AdapterError::Unsupported)
        );
        assert!(s.engine().documents().is_empty());
    }
    #[test]
    fn visibility_preserves_same_owner() {
        let mut s = NativeSession::new();
        s.engine
            .start("file.new", serde_json::json!({"width": 8, "height": 8}))
            .unwrap();
        let document = s.engine().active().unwrap().doc.clone();
        let revision = s.engine().active().unwrap().revision;
        s.show(true);
        s.show(false);
        s.show(true);
        assert!(s.visible());
        assert_eq!(*s.engine().active().unwrap().doc, *document);
        assert_eq!(s.engine().active().unwrap().revision, revision);
    }
    #[test]
    fn native_job_locks_only_its_document_and_rejects_stale_revision() {
        let mut s = NativeSession::new();
        s.engine
            .start("file.new", serde_json::json!({"width": 32, "height": 32}))
            .unwrap();
        let first = s.engine().active().unwrap().doc.id.0;
        let revision = s.engine().active().unwrap().revision;
        let params = serde_json::json!({"points": [[16, 16]], "size": 6});
        assert_eq!(
            s.start_command(first, revision + 1, "paint.spotHealing", params.clone()),
            Err(AdapterError::StaleRevision)
        );
        let Started::Job(job) = s
            .start_command(first, revision, "paint.spotHealing", params.clone())
            .unwrap()
        else {
            panic!("native healing must return a job")
        };
        assert_eq!(
            s.start_command(first, revision, "paint.spotHealing", params),
            Err(AdapterError::Busy)
        );
        assert_eq!(s.close(first, true), Err(AdapterError::Busy));
        s.engine
            .start("file.new", serde_json::json!({"width": 8, "height": 8}))
            .unwrap();
        let second = s.engine().active().unwrap().doc.id.0;
        assert_ne!(first, second);
        assert!(
            s.activate(second).is_ok(),
            "other documents remain navigable"
        );
        assert!(s.cancel(job));
        let until = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while s.engine().has_jobs() && std::time::Instant::now() < until {
            s.poll();
            std::thread::yield_now();
        }
        assert!(!s.engine().has_jobs());
        s.activate(first).unwrap();
        assert_eq!(
            s.engine().active().unwrap().revision,
            revision,
            "cancelled result never commits"
        );
    }
    #[test]
    fn document_limit_does_not_evict_existing_documents() {
        let mut s = NativeSession::new();
        for _ in 0..MAX_DOCUMENTS {
            s.engine
                .start("file.new", serde_json::json!({"width": 1, "height": 1}))
                .unwrap();
        }
        let ids: Vec<_> = s.engine().documents().iter().map(|d| d.doc.id.0).collect();
        assert_eq!(
            s.open("extra.png", Arc::new(vec![])),
            Err(AdapterError::Busy)
        );
        assert_eq!(
            s.engine()
                .documents()
                .iter()
                .map(|d| d.doc.id.0)
                .collect::<Vec<_>>(),
            ids
        );
    }
    #[test]
    fn invalid_open_runs_as_job_and_does_not_occupy_slot() {
        let mut s = NativeSession::new();
        let Started::Job(id) = s.open("invalid.png", Arc::new(vec![0, 1, 2])).unwrap() else {
            panic!("native decode must run off-thread")
        };
        assert_eq!(
            s.open("other.png", Arc::new(vec![])),
            Err(AdapterError::Busy)
        );
        let until = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while s.opening.is_some() && std::time::Instant::now() < until {
            s.poll();
            std::thread::yield_now();
        }
        assert!(s.opening.is_none(), "decode worker must terminate");
        assert!(s.engine().documents().is_empty());
        assert_eq!(
            s.engine()
                .jobs_with_recent()
                .into_iter()
                .find(|j| j.id == id)
                .unwrap()
                .state,
            "failed"
        );
    }
}

#[cfg(feature = "desktop")]
pub mod desktop;

pub mod export;
#[cfg(feature = "native-ui")]
pub mod renderer;

#[cfg(feature = "native-ui")]
mod native_input;

#[cfg(feature = "native-ui")]
mod native_services;
