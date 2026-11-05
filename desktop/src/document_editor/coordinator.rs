use super::*;
use std::{
    collections::{BTreeMap, VecDeque},
    sync::Arc,
};

pub fn admit_provider(
    descriptor: Option<&ProviderDescriptor>,
    required: &AdmissionRequirements,
) -> Result<(), EditorError> {
    let d = descriptor.ok_or_else(|| {
        EditorError::new(
            ErrorCode::Unavailable,
            "native editor provider is not registered",
        )
    })?;
    if d.api_major != EDITOR_API_MAJOR
        || d.project_protocol != required.project_protocol
        || d.browser_protocol != required.browser_protocol
        || required
            .capabilities
            .iter()
            .any(|c| !d.capabilities.contains(c))
    {
        return Err(EditorError::new(
            ErrorCode::Incompatible,
            "native editor protocol or capabilities differ",
        ));
    }
    Ok(())
}
/// Own this value on a dedicated coordination thread; enqueue performs no provider work.
/// Queued, running and completed-but-unacknowledged controls share one hard limit.
pub struct EditorCoordinator {
    session_id: String,
    generation: u64,
    provider: Box<dyn EditorSession>,
    formats: Vec<String>,
    queue: VecDeque<ControlRequest>,
    running: BTreeMap<u64, ControlRequest>,
    receipts: BTreeMap<u64, Arc<CompletionReceipt>>,
    documents: BTreeMap<String, DocumentState>,
    active: Option<String>,
    visible: bool,
    last_request: u64,
    byte_budget: usize,
    stopped: bool,
    state: BTreeMap<String, EditorStateEvent>,
    render_plan: Option<RenderPlan>,
    gpu_lost: bool,
    device_generation: Option<u64>,
    render_watermarks: BTreeMap<String, (u64, u64)>,
    layout: Option<EditorLayout>,
    input: EditorInputQueue,
}
impl EditorCoordinator {
    pub fn new(
        session_id: String,
        generation: u64,
        provider: Box<dyn EditorSession>,
        formats: Vec<String>,
        byte_budget: usize,
    ) -> Self {
        Self {
            session_id,
            generation,
            provider,
            formats,
            queue: VecDeque::new(),
            running: BTreeMap::new(),
            receipts: BTreeMap::new(),
            documents: BTreeMap::new(),
            active: None,
            visible: false,
            last_request: 0,
            byte_budget,
            stopped: false,
            state: BTreeMap::new(),
            render_plan: None,
            gpu_lost: false,
            device_generation: None,
            render_watermarks: BTreeMap::new(),
            layout: None,
            input: EditorInputQueue::default(),
        }
    }
    pub fn layout(&self) -> Option<&EditorLayout> {
        self.layout.as_ref()
    }
    pub fn set_layout(&mut self, layout: EditorLayout) -> Result<(), EditorError> {
        layout.validate()?;
        if self.layout.as_ref().is_some_and(|old| {
            layout.layout_generation < old.layout_generation
                || (layout.layout_generation == old.layout_generation
                    && (layout.physical_size != old.physical_size
                        || layout.scale_factor != old.scale_factor
                        || layout.viewport_origin_css != old.viewport_origin_css))
        }) {
            return Err(EditorError::new(
                ErrorCode::StaleGeneration,
                "layout must advance before changing geometry",
            ));
        }
        if self
            .layout
            .as_ref()
            .is_none_or(|old| old.layout_generation != layout.layout_generation)
        {
            self.provider.cancel_input();
        }
        self.input.set_layout(layout.layout_generation);
        self.layout = Some(layout);
        Ok(())
    }
    pub fn enqueue_input(&mut self, input: NativeEditorInput) -> Result<(), EditorError> {
        if !self.visible || self.stopped {
            return Err(EditorError::new(
                ErrorCode::Unavailable,
                "native editor is hidden",
            ));
        }
        if self.gpu_lost {
            return Err(EditorError::new(
                ErrorCode::DeviceLost,
                "native editor presentation paused",
            ));
        }
        let cancels = matches!(input.event, NativeInputEvent::Blur);
        let result = self.input.enqueue(input);
        if (cancels && result.is_ok()) || result.as_ref().is_err_and(|e| e.code == ErrorCode::Busy)
        {
            self.provider.cancel_input();
        }
        result
    }
    pub fn cancel_input(&mut self) {
        self.input.cancel_all();
        self.provider.cancel_input();
    }
    /// Consume owner input before snapshot/export controls. A mouse-up and export
    /// admitted in the same host turn must never export the pre-stroke revision.
    pub fn advance_frame(&mut self, time_seconds: f64) -> Result<Option<EditorFrame>, EditorError> {
        let frame = self.render_frame(time_seconds);
        self.pump();
        match frame {
            Ok(Some(frame))
                if self.visible
                    && self.active.as_deref() == Some(frame.document_id.as_str())
                    && self
                        .documents
                        .get(&frame.document_id)
                        .is_some_and(|d| d.revision == frame.document_revision) =>
            {
                Ok(Some(frame))
            }
            Ok(_) => Ok(None),
            Err(error) => Err(error),
        }
    }
    pub fn render_frame(&mut self, time_seconds: f64) -> Result<Option<EditorFrame>, EditorError> {
        self.refresh_document_states();
        if !self.visible || self.gpu_lost || self.stopped {
            return Ok(None);
        }
        if !time_seconds.is_finite() {
            return Err(EditorError::new(
                ErrorCode::Unsupported,
                "invalid frame time",
            ));
        }
        let layout = self
            .layout
            .clone()
            .ok_or_else(|| EditorError::new(ErrorCode::Unavailable, "editor layout unavailable"))?;
        let frame_result = self.provider.render_frame(EditorFrameContext {
            physical_size: layout.physical_size,
            scale_factor: layout.scale_factor,
            time_seconds,
            layout_generation: layout.layout_generation,
            viewport_origin_css: layout.viewport_origin_css,
            input: self.input.drain(),
        });
        let frame = match frame_result {
            Ok(frame) => frame,
            Err(error) => {
                self.cancel_input();
                return Err(error);
            }
        };
        self.refresh_document_states();
        if let Some(frame) = &frame {
            if self.device_generation != Some(frame.device_generation)
                || frame.layout_generation != layout.layout_generation
            {
                return Err(EditorError::new(
                    ErrorCode::StaleGeneration,
                    "editor frame generation differs",
                ));
            }
            let document = self.documents.get(&frame.document_id).ok_or_else(|| {
                EditorError::new(ErrorCode::Unavailable, "editor frame document is closed")
            })?;
            if frame.document_revision < document.revision {
                return Err(EditorError::new(
                    ErrorCode::StaleRevision,
                    "editor frame revision is stale",
                ));
            }
            let rect = frame.document_rect_css;
            let css_size = layout.physical_size.map(|n| n as f64 / layout.scale_factor);
            if rect.iter().any(|n| !n.is_finite())
                || rect[0] < 0.0
                || rect[1] < 0.0
                || rect[2] < 0.0
                || rect[3] < 0.0
                || rect[0] + rect[2] > css_size[0] + 0.5
                || rect[1] + rect[3] > css_size[1] + 0.5
                || !bounded_snapshot(&frame.snapshot)
            {
                return Err(EditorError::new(
                    ErrorCode::BudgetExceeded,
                    "invalid frame metadata",
                ));
            }
            if let Some(texture) = &frame.ui_texture {
                if texture.width() != layout.physical_size[0]
                    || texture.height() != layout.physical_size[1]
                {
                    return Err(EditorError::new(
                        ErrorCode::Incompatible,
                        "UI texture dimensions differ",
                    ));
                }
            }
            if let Some(texture) = &frame.document_texture {
                let expected = [
                    (rect[2] * layout.scale_factor).round() as u32,
                    (rect[3] * layout.scale_factor).round() as u32,
                ];
                if texture.width() != expected[0] || texture.height() != expected[1] {
                    return Err(EditorError::new(
                        ErrorCode::Incompatible,
                        "document texture dimensions differ",
                    ));
                }
            }
            // This synchronous owner-produced frame is a commit observation, unlike
            // an asynchronous immutable plan. Older observations are rejected above.
            self.documents.get_mut(&frame.document_id).unwrap().revision = frame.document_revision;
            if self.active.as_ref() != Some(&frame.document_id) {
                self.input.cancel_all();
                self.active = Some(frame.document_id.clone());
            }
        }
        Ok(frame)
    }
    /// Bind the device supplied to factory.create before admitting any render plan.
    /// This can only seed a new coordinator; recovery uses recover_gpu instead.
    pub fn bind_initial_device_generation(&mut self, generation: u64) -> Result<(), EditorError> {
        if generation == 0 || self.device_generation.is_some() || self.gpu_lost {
            return Err(EditorError::new(
                ErrorCode::StaleGeneration,
                "initial GPU generation already bound or invalid",
            ));
        }
        self.device_generation = Some(generation);
        Ok(())
    }
    /// Detach presentation resources while preserving the sole document owner,
    /// dirty revisions, undo history and pending completion receipts.
    pub fn device_lost(&mut self) {
        self.gpu_lost = true;
        self.cancel_input();
        self.render_plan = None;
        self.render_watermarks.clear();
        self.state.clear();
        self.provider.device_lost();
    }
    pub fn recover_gpu(&mut self, gpu: GpuContext) -> Result<(), EditorError> {
        self.render_plan = None;
        self.render_watermarks.clear();
        self.state.clear();
        self.gpu_lost = true;
        if self
            .device_generation
            .is_some_and(|generation| gpu.device_generation <= generation)
        {
            return Err(EditorError::new(
                ErrorCode::StaleGeneration,
                "GPU device generation must increase",
            ));
        }
        let generation = gpu.device_generation;
        self.provider.recover_gpu(gpu)?;
        self.device_generation = Some(generation);
        self.gpu_lost = false;
        Ok(())
    }
    pub fn documents(&self) -> &BTreeMap<String, DocumentState> {
        &self.documents
    }
    pub fn visible(&self) -> bool {
        self.visible
    }
    pub fn enqueue(&mut self, request: ControlRequest) -> Result<(), EditorError> {
        if self.stopped {
            return Err(EditorError::new(ErrorCode::Unavailable, "session stopped"));
        }
        if request.session_id != self.session_id || request.generation != self.generation {
            return Err(EditorError::new(
                ErrorCode::StaleGeneration,
                "session generation differs",
            ));
        }
        if request.request_id <= self.last_request {
            return Err(EditorError::new(
                ErrorCode::StaleGeneration,
                "request IDs must increase",
            ));
        }
        if self.queue.len() + self.running.len() + self.receipts.len() >= MAX_PENDING_REQUESTS {
            return Err(EditorError::new(
                ErrorCode::Busy,
                "acknowledge completed requests before enqueue",
            ));
        }
        let bytes = operation_bytes(&request.operation);
        let held: usize = self
            .queue
            .iter()
            .chain(self.running.values())
            .map(|r| operation_bytes(&r.operation))
            .sum::<usize>()
            .saturating_add(
                self.receipts
                    .values()
                    .map(|receipt| receipt_bytes(receipt))
                    .sum::<usize>(),
            );
        if bytes > self.byte_budget.saturating_sub(held) {
            return Err(EditorError::new(
                ErrorCode::BudgetExceeded,
                "control byte budget exceeded",
            ));
        }
        self.last_request = request.request_id;
        self.queue.push_back(request);
        Ok(())
    }
    pub fn poll_events(&self) -> Vec<CompletionReceipt> {
        self.receipts
            .values()
            .map(|receipt| (**receipt).clone())
            .collect()
    }
    pub fn poll_shared_events(&self) -> Vec<Arc<CompletionReceipt>> {
        self.receipts.values().cloned().collect()
    }
    pub fn state_events(&self) -> Vec<EditorStateEvent> {
        self.state.values().cloned().collect()
    }
    pub fn take_render_plan(&mut self) -> Option<RenderPlan> {
        self.render_plan
            .take()
            .filter(|plan| self.plan_is_current(plan))
    }
    pub fn acknowledge(&mut self, request_id: u64) -> bool {
        self.receipts.remove(&request_id).is_some()
    }
    fn validate(&self, op: &ControlOperation) -> Result<Option<OperationResult>, EditorError> {
        match op {
            ControlOperation::Open {
                source_id, format, ..
            } => {
                if self
                    .running
                    .values()
                    .any(|r| matches!(r.operation, ControlOperation::Open { .. }))
                {
                    return Err(EditorError::new(
                        ErrorCode::Busy,
                        "another source is being decoded",
                    ));
                }
                if !self.formats.contains(format) {
                    return Err(EditorError::new(
                        ErrorCode::Unsupported,
                        "format not supported",
                    ));
                }
                if self.documents.values().any(|d| &d.source_id==source_id) || self.running.values().any(|r| matches!(&r.operation,ControlOperation::Open{source_id:s,..} if s==source_id)) { return Err(EditorError::new(ErrorCode::Busy,"source already has an owner")); }
                if self.documents.len()
                    + self
                        .running
                        .values()
                        .filter(|r| matches!(r.operation, ControlOperation::Open { .. }))
                        .count()
                    >= MAX_DOCUMENTS
                {
                    return Err(EditorError::new(
                        ErrorCode::BudgetExceeded,
                        "document limit reached",
                    ));
                }
            }
            ControlOperation::Activate { document_id } => {
                self.document(document_id)?;
                if self
                    .running
                    .values()
                    .any(|r| document_id_of(&r.operation) == Some(document_id.as_str()))
                {
                    return Err(EditorError::new(
                        ErrorCode::Busy,
                        "document has an active operation",
                    ));
                }
            }
            ControlOperation::Close {
                document_id,
                expected_revision,
                ..
            }
            | ControlOperation::Command {
                document_id,
                expected_revision,
                ..
            }
            | ControlOperation::Export {
                document_id,
                expected_revision,
                ..
            }
            | ControlOperation::MarkSaved {
                document_id,
                expected_revision,
            } => {
                let d = self.document(document_id)?;
                if (matches!(op, ControlOperation::MarkSaved { .. })
                    && *expected_revision > d.revision)
                    || (!matches!(op, ControlOperation::MarkSaved { .. })
                        && d.revision != *expected_revision)
                {
                    return Err(EditorError::new(
                        ErrorCode::StaleRevision,
                        "document revision differs",
                    ));
                }
                if self
                    .running
                    .values()
                    .any(|r| document_id_of(&r.operation) == Some(document_id.as_str()))
                {
                    return Err(EditorError::new(
                        ErrorCode::Busy,
                        "document has an active operation",
                    ));
                }
                if matches!(op, ControlOperation::Close { discard: false, .. }) && d.dirty() {
                    return Ok(Some(OperationResult::NeedsSettlement {
                        document_id: document_id.clone(),
                    }));
                }
            }
            _ => {}
        }
        Ok(None)
    }
    fn document(&self, id: &str) -> Result<&DocumentState, EditorError> {
        self.documents
            .get(id)
            .ok_or_else(|| EditorError::new(ErrorCode::Unavailable, "document not open"))
    }
    /// Run on the owner thread. Provider admission must be short; asynchronous work
    /// returns None and settles through poll_completions on a later pump.
    pub fn pump(&mut self) {
        self.refresh_document_states();
        // Drain every returned receipt: stale/duplicate prefixes must never discard
        // admitted completions. The provider owns bounded production, not this iterator.
        for receipt in self.provider.poll_completions() {
            if receipt.generation == self.generation {
                if let Some(request) = self.running.remove(&receipt.request_id) {
                    self.finish(request, receipt.result);
                }
            }
        }
        for event in self.provider.poll_state().into_iter().take(128) {
            if !self.gpu_lost
                && event.generation == self.generation
                && (self.state.contains_key(&event.key) || self.state.len() < 128)
            {
                self.state.insert(event.key.clone(), event);
            }
        }
        if !self.gpu_lost {
            if let Some(plan) = self.provider.prepare_render() {
                if self.plan_is_current(&plan)
                    && self
                        .render_watermarks
                        .get(&plan.document_id)
                        .is_none_or(|&(layout, id)| {
                            plan.layout_generation > layout
                                || (plan.layout_generation == layout && plan.plan_id > id)
                        })
                {
                    self.render_watermarks.insert(
                        plan.document_id.clone(),
                        (plan.layout_generation, plan.plan_id),
                    );
                    self.render_plan = Some(plan);
                }
            }
        }
        // Selection/visibility changes share one ordering domain, including opens
        // that implicitly activate a document. A second Open still receives Busy.
        if self.queue.front().is_some_and(|next| {
            self.running.values().any(|active| {
                selection_operation(&next.operation)
                    && selection_operation(&active.operation)
                    && !(matches!(next.operation, ControlOperation::Open { .. })
                        && matches!(active.operation, ControlOperation::Open { .. }))
            })
        }) {
            return;
        }
        if let Some(request) = self.queue.pop_front() {
            match self.validate(&request.operation) {
                Err(e) => self.finish(request, Err(e)),
                Ok(Some(result)) => self.finish(request, Ok(result)),
                Ok(None) => match &request.operation {
                    ControlOperation::Input { input } => {
                        let result = self
                            .enqueue_input(input.clone())
                            .map(|_| OperationResult::Done);
                        self.finish(request, result);
                    }
                    ControlOperation::Layout { layout } => {
                        let result = self
                            .set_layout(layout.clone())
                            .map(|_| OperationResult::Done);
                        self.finish(request, result);
                    }
                    _ => match self.provider.execute(&request) {
                        Ok(None) => {
                            self.running.insert(request.request_id, request);
                        }
                        Ok(Some(result)) => self.finish(request, Ok(result)),
                        Err(e) => self.finish(request, Err(e)),
                    },
                },
            }
        }
    }
    fn refresh_document_states(&mut self) {
        if let Some(states) = self.provider.document_states() {
            if states.len() > MAX_DOCUMENTS {
                return;
            }
            let mut ids = std::collections::BTreeSet::new();
            let mut sources = std::collections::BTreeSet::new();
            if states.iter().any(|state| {
                state.document_id.is_empty()
                    || state.document_id.len() > 4096
                    || state.source_id.is_empty()
                    || state.source_id.len() > 4096
                    || !ids.insert(state.document_id.clone())
                    || !sources.insert(state.source_id.clone())
                    || state.saved_revision > state.revision
                    || state.source_size.iter().any(|&n| n == 0 || n > 32768)
            }) {
                return;
            }
            // Pending host opens reserve their identity until the Open receipt settles.
            let reserved_sources = self
                .queue
                .iter()
                .chain(self.running.values())
                .filter_map(|request| match &request.operation {
                    ControlOperation::Open { source_id, .. } => Some(source_id.clone()),
                    _ => None,
                })
                .collect::<std::collections::BTreeSet<_>>();
            let reserved_ids = self
                .running
                .values()
                .filter_map(|r| document_id_of(&r.operation).map(str::to_owned))
                .collect::<std::collections::BTreeSet<_>>();
            self.documents
                .retain(|id, _| ids.contains(id) || reserved_ids.contains(id));
            for state in states {
                if let Some(old) = self.documents.get_mut(&state.document_id) {
                    if state.source_id == old.source_id
                        && state.node_binding == old.node_binding
                        && state.revision >= old.revision
                    {
                        *old = state;
                    }
                } else if state.node_binding.is_none()
                    && !reserved_sources.contains(&state.source_id)
                    && self.documents.len() < MAX_DOCUMENTS
                    && !self
                        .documents
                        .values()
                        .any(|old| old.source_id == state.source_id)
                {
                    // Provider UI may create local files in this same authoritative
                    // Session. It cannot manufacture a bound host/node document.
                    self.documents.insert(state.document_id.clone(), state);
                }
            }
            if self
                .active
                .as_ref()
                .is_some_and(|id| !self.documents.contains_key(id))
            {
                self.active = None;
                self.cancel_input();
            }
            if self
                .render_plan
                .as_ref()
                .is_some_and(|plan| !self.plan_is_current(plan))
            {
                self.render_plan = None;
            }
            self.render_watermarks
                .retain(|id, _| self.documents.contains_key(id));
        }
    }
    fn plan_is_current(&self, plan: &RenderPlan) -> bool {
        !self.gpu_lost
            && self.device_generation == Some(plan.device_generation)
            && self
                .documents
                .get(&plan.document_id)
                .is_some_and(|document| document.revision == plan.document_revision)
    }
    fn finish(
        &mut self,
        request: ControlRequest,
        mut result: Result<OperationResult, EditorError>,
    ) {
        if let Ok(OperationResult::Exported { bytes, .. }) = &result {
            let retained = self
                .receipts
                .values()
                .map(|receipt| receipt_bytes(receipt))
                .sum::<usize>()
                .saturating_add(
                    self.queue
                        .iter()
                        .chain(self.running.values())
                        .map(|r| operation_bytes(&r.operation))
                        .sum::<usize>(),
                );
            if bytes.len() > self.byte_budget.saturating_sub(retained) {
                result = Err(EditorError::new(
                    ErrorCode::BudgetExceeded,
                    "export receipt byte budget exceeded",
                ));
            }
        }
        if result.is_ok() {
            if let Some(id) = document_id_of(&request.operation) {
                if !self.documents.contains_key(id) {
                    result = Err(EditorError::new(
                        ErrorCode::Unavailable,
                        "document closed before completion",
                    ));
                }
            }
        }
        if let Ok(value) = &result {
            let applied = self.apply(&request.operation, value);
            if let Err(e) = applied {
                result = Err(e);
            }
        }
        if result.is_ok()
            && matches!(
                request.operation,
                ControlOperation::Hide
                    | ControlOperation::Activate { .. }
                    | ControlOperation::Close { .. }
            )
        {
            self.cancel_input();
        }
        if self
            .render_plan
            .as_ref()
            .is_some_and(|plan| !self.plan_is_current(plan))
        {
            self.render_plan = None;
        }
        self.render_watermarks
            .retain(|id, _| self.documents.contains_key(id));
        self.receipts.insert(
            request.request_id,
            Arc::new(CompletionReceipt {
                request_id: request.request_id,
                generation: self.generation,
                result,
            }),
        );
    }
    fn apply(
        &mut self,
        op: &ControlOperation,
        result: &OperationResult,
    ) -> Result<(), EditorError> {
        match (op, result) {
            (
                ControlOperation::Open {
                    source_id,
                    node_binding,
                    ..
                },
                OperationResult::Opened {
                    document_id,
                    revision,
                    source_size,
                },
            ) => {
                if self.documents.contains_key(document_id) {
                    return Err(EditorError::new(
                        ErrorCode::InternalError,
                        "provider reused document identity",
                    ));
                }
                self.documents.insert(
                    document_id.clone(),
                    DocumentState {
                        document_id: document_id.clone(),
                        source_id: source_id.clone(),
                        node_binding: node_binding.clone(),
                        revision: *revision,
                        saved_revision: *revision,
                        source_size: *source_size,
                    },
                );
                self.active = Some(document_id.clone());
            }
            (ControlOperation::Command { .. }, OperationResult::Done) => {}
            (
                ControlOperation::Command {
                    document_id,
                    expected_revision,
                    ..
                },
                OperationResult::Changed { revision },
            ) if revision > expected_revision => {
                self.documents.get_mut(document_id).unwrap().revision = *revision;
            }
            (
                ControlOperation::Export {
                    expected_revision, ..
                },
                OperationResult::Exported { bytes, revision },
            ) if revision == expected_revision && bytes.len() <= self.byte_budget => {}
            (ControlOperation::Close { document_id, .. }, OperationResult::Done) => {
                self.documents.remove(document_id);
                if self.active.as_ref() == Some(document_id) {
                    self.active = None;
                }
            }
            (
                ControlOperation::MarkSaved {
                    document_id,
                    expected_revision,
                },
                OperationResult::Done,
            ) => {
                self.documents.get_mut(document_id).unwrap().saved_revision = *expected_revision;
            }
            (ControlOperation::Activate { document_id }, OperationResult::Done) => {
                self.active = Some(document_id.clone())
            }
            (
                ControlOperation::Input { .. }
                | ControlOperation::Layout { .. }
                | ControlOperation::CancelJob { .. },
                OperationResult::Done,
            ) => {}
            (ControlOperation::Show, OperationResult::Done) => self.visible = true,
            (ControlOperation::Hide, OperationResult::Done) => self.visible = false,
            (ControlOperation::Close { .. }, OperationResult::NeedsSettlement { .. }) => {}
            _ => {
                return Err(EditorError::new(
                    ErrorCode::InternalError,
                    "provider returned incompatible completion",
                ));
            }
        }
        Ok(())
    }
    /// Dirty documents must be settled, and all controls acknowledged, before owner replacement.
    pub fn shutdown(&mut self) -> Result<(), EditorError> {
        if !self.documents.is_empty()
            || !self.queue.is_empty()
            || !self.running.is_empty()
            || !self.receipts.is_empty()
        {
            return Err(EditorError::new(
                ErrorCode::Busy,
                "close documents and acknowledge controls before shutdown",
            ));
        }
        self.provider.shutdown()?;
        self.stopped = true;
        Ok(())
    }
}
fn document_id_of(op: &ControlOperation) -> Option<&str> {
    match op {
        ControlOperation::Activate { document_id }
        | ControlOperation::Close { document_id, .. }
        | ControlOperation::Command { document_id, .. }
        | ControlOperation::Export { document_id, .. }
        | ControlOperation::MarkSaved { document_id, .. } => Some(document_id),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fake {
        next: u64,
    }
    impl EditorSession for Fake {
        fn execute(&mut self, r: &ControlRequest) -> Result<Option<OperationResult>, EditorError> {
            Ok(Some(match &r.operation {
                ControlOperation::Open { bytes, .. } => {
                    if bytes.is_empty() {
                        return Err(EditorError::new(ErrorCode::Unsupported, "invalid input"));
                    }
                    self.next += 1;
                    OperationResult::Opened {
                        document_id: format!("d{}", self.next),
                        revision: 1,
                        source_size: [10, 10],
                    }
                }
                ControlOperation::Command {
                    expected_revision, ..
                } => OperationResult::Changed {
                    revision: expected_revision + 1,
                },
                ControlOperation::Export {
                    expected_revision, ..
                } => OperationResult::Exported {
                    bytes: vec![1],
                    revision: *expected_revision,
                },
                _ => OperationResult::Done,
            }))
        }
        fn poll_completions(&mut self) -> Vec<CompletionReceipt> {
            vec![]
        }
        fn shutdown(&mut self) -> Result<(), EditorError> {
            Ok(())
        }
    }
    fn coordinator() -> EditorCoordinator {
        EditorCoordinator::new(
            "s".into(),
            1,
            Box::new(Fake { next: 0 }),
            vec!["image".into()],
            1024,
        )
    }
    fn request(id: u64, operation: ControlOperation) -> ControlRequest {
        ControlRequest {
            session_id: "s".into(),
            request_id: id,
            generation: 1,
            operation,
        }
    }
    fn open(source: &str) -> ControlOperation {
        ControlOperation::Open {
            source_id: source.into(),
            node_binding: None,
            format: "image".into(),
            bytes: vec![1],
        }
    }
    fn run(c: &mut EditorCoordinator, id: u64, op: ControlOperation) {
        c.enqueue(request(id, op)).unwrap();
        c.pump();
    }
    #[test]
    fn missing_and_incompatible_are_rejected_before_create() {
        let required = AdmissionRequirements {
            project_protocol: 1,
            browser_protocol: 1,
            capabilities: vec!["jobs".into()],
        };
        assert_eq!(
            admit_provider(None, &required).unwrap_err().code,
            ErrorCode::Unavailable
        );
        let mut descriptor = ProviderDescriptor {
            provider_id: "fake".into(),
            api_major: 2,
            api_minor: 0,
            project_protocol: 1,
            browser_protocol: 1,
            formats: vec![],
            capabilities: vec!["jobs".into()],
            build_identity: "test".into(),
        };
        assert_eq!(
            admit_provider(Some(&descriptor), &required)
                .unwrap_err()
                .code,
            ErrorCode::Incompatible
        );
        descriptor.api_major = 1;
        admit_provider(Some(&descriptor), &required).unwrap();
    }
    #[test]
    fn receipts_are_retained_until_explicit_acknowledgement() {
        let mut c = coordinator();
        for id in 1..=256 {
            run(&mut c, id, ControlOperation::Hide);
        }
        assert_eq!(c.poll_events().len(), 256);
        assert_eq!(c.poll_events().len(), 256);
        assert_eq!(
            c.enqueue(request(257, ControlOperation::Show))
                .unwrap_err()
                .code,
            ErrorCode::Busy
        );
        assert!(c.acknowledge(1));
        c.enqueue(request(257, ControlOperation::Show)).unwrap();
    }
    #[test]
    fn dirty_close_requires_settlement_and_hide_retains_owner() {
        let mut c = coordinator();
        run(&mut c, 1, open("source"));
        run(
            &mut c,
            2,
            ControlOperation::Command {
                document_id: "d1".into(),
                expected_revision: 1,
                command: "paint".into(),
                parameters: vec![],
            },
        );
        run(&mut c, 3, ControlOperation::Hide);
        assert!(c.documents()["d1"].dirty());
        run(
            &mut c,
            4,
            ControlOperation::Close {
                document_id: "d1".into(),
                expected_revision: 2,
                discard: false,
            },
        );
        assert!(matches!(
            c.poll_events()[3].result,
            Ok(OperationResult::NeedsSettlement { .. })
        ));
        assert_eq!(c.shutdown().unwrap_err().code, ErrorCode::Busy);
        run(
            &mut c,
            5,
            ControlOperation::Close {
                document_id: "d1".into(),
                expected_revision: 2,
                discard: true,
            },
        );
        assert!(c.documents().is_empty());
    }
    #[test]
    fn stale_and_duplicate_requests_do_not_create_another_document() {
        let mut c = coordinator();
        let mut stale = request(1, open("source"));
        stale.generation = 2;
        assert_eq!(
            c.enqueue(stale).unwrap_err().code,
            ErrorCode::StaleGeneration
        );
        run(&mut c, 1, open("source"));
        run(&mut c, 2, open("source"));
        assert_eq!(c.documents().len(), 1);
        assert_eq!(
            c.poll_events()[1].result.as_ref().unwrap_err().code,
            ErrorCode::Busy
        );
        run(
            &mut c,
            3,
            ControlOperation::Command {
                document_id: "d1".into(),
                expected_revision: 0,
                command: "paint".into(),
                parameters: vec![],
            },
        );
        assert_eq!(
            c.poll_events()[2].result.as_ref().unwrap_err().code,
            ErrorCode::StaleRevision
        );
    }
    #[test]
    fn failed_open_does_not_reserve_a_slot() {
        let mut c = coordinator();
        let mut op = open("s");
        if let ControlOperation::Open { bytes, .. } = &mut op {
            bytes.clear();
        }
        run(&mut c, 1, op);
        assert!(c.documents().is_empty());
        run(&mut c, 2, open("s"));
        assert_eq!(c.documents().len(), 1);
    }
}

#[cfg(test)]
mod asynchronous_tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    struct AsyncProvider(Arc<Mutex<Vec<CompletionReceipt>>>);
    impl EditorSession for AsyncProvider {
        fn execute(&mut self, _: &ControlRequest) -> Result<Option<OperationResult>, EditorError> {
            Ok(None)
        }
        fn poll_completions(&mut self) -> Vec<CompletionReceipt> {
            std::mem::take(&mut *self.0.lock().unwrap())
        }
        fn shutdown(&mut self) -> Result<(), EditorError> {
            Ok(())
        }
    }
    #[test]
    fn asynchronous_open_is_single_owner_and_stale_completion_is_ignored() {
        let mailbox = Arc::new(Mutex::new(Vec::new()));
        let mut c = EditorCoordinator::new(
            "s".into(),
            1,
            Box::new(AsyncProvider(mailbox.clone())),
            vec!["image".into()],
            100,
        );
        let request = |id| ControlRequest {
            session_id: "s".into(),
            generation: 1,
            request_id: id,
            operation: ControlOperation::Open {
                source_id: "source".into(),
                node_binding: None,
                format: "image".into(),
                bytes: vec![1],
            },
        };
        c.enqueue(request(1)).unwrap();
        c.pump();
        assert!(c.documents().is_empty());
        c.enqueue(request(2)).unwrap();
        c.pump();
        assert_eq!(
            c.poll_events()[0].result.as_ref().unwrap_err().code,
            ErrorCode::Busy
        );
        let completion = |generation| CompletionReceipt {
            generation,
            request_id: 1,
            result: Ok(OperationResult::Opened {
                document_id: "d".into(),
                revision: 1,
                source_size: [2, 2],
            }),
        };
        mailbox.lock().unwrap().push(completion(0));
        c.pump();
        assert!(c.documents().is_empty());
        mailbox.lock().unwrap().push(completion(1));
        c.pump();
        assert_eq!(c.documents().len(), 1);
        mailbox.lock().unwrap().push(completion(1));
        c.pump();
        assert_eq!(c.documents().len(), 1);
        assert_eq!(c.poll_events().len(), 2);
    }
}

fn receipt_bytes(receipt: &CompletionReceipt) -> usize {
    match &receipt.result {
        Ok(OperationResult::Exported { bytes, .. }) => bytes.len(),
        _ => 0,
    }
}
fn operation_bytes(op: &ControlOperation) -> usize {
    match op {
        ControlOperation::Input { input } => {
            serde_json::to_vec(input).map_or(usize::MAX, |v| v.len())
        }
        ControlOperation::Layout { .. } => 128,
        ControlOperation::Open {
            source_id,
            node_binding,
            format,
            bytes,
        } => bytes
            .len()
            .saturating_add(source_id.len())
            .saturating_add(node_binding.as_ref().map_or(0, String::len))
            .saturating_add(format.len()),
        ControlOperation::Command {
            document_id,
            command,
            parameters,
            ..
        } => parameters
            .len()
            .saturating_add(document_id.len())
            .saturating_add(command.len()),
        ControlOperation::Export {
            document_id,
            format,
            ..
        } => document_id.len().saturating_add(format.len()),
        _ => document_id_of(op).map_or(0, str::len),
    }
}

fn selection_operation(op: &ControlOperation) -> bool {
    matches!(
        op,
        ControlOperation::Show
            | ControlOperation::Hide
            | ControlOperation::Activate { .. }
            | ControlOperation::Open { .. }
    )
}

#[cfg(test)]
mod ordering_regressions {
    use super::*;
    use std::sync::{Arc, Mutex};
    struct Deferred(Arc<Mutex<Vec<CompletionReceipt>>>);
    impl EditorSession for Deferred {
        fn execute(&mut self, _: &ControlRequest) -> Result<Option<OperationResult>, EditorError> {
            Ok(None)
        }
        fn poll_completions(&mut self) -> Vec<CompletionReceipt> {
            std::mem::take(&mut *self.0.lock().unwrap())
        }
        fn shutdown(&mut self) -> Result<(), EditorError> {
            Ok(())
        }
    }
    fn setup(budget: usize) -> (EditorCoordinator, Arc<Mutex<Vec<CompletionReceipt>>>) {
        let out = Arc::new(Mutex::new(vec![]));
        let mut c = EditorCoordinator::new(
            "s".into(),
            1,
            Box::new(Deferred(out.clone())),
            vec!["x".into()],
            budget,
        );
        c.documents.insert(
            "d".into(),
            DocumentState {
                document_id: "d".into(),
                source_id: "original".into(),
                node_binding: None,
                revision: 1,
                saved_revision: 1,
                source_size: [2, 2],
            },
        );
        (c, out)
    }
    fn req(id: u64, operation: ControlOperation) -> ControlRequest {
        ControlRequest {
            request_id: id,
            session_id: "s".into(),
            generation: 1,
            operation,
        }
    }
    fn complete(out: &Arc<Mutex<Vec<CompletionReceipt>>>, id: u64, result: OperationResult) {
        out.lock().unwrap().push(CompletionReceipt {
            request_id: id,
            generation: 1,
            result: Ok(result),
        });
    }
    fn open(source: &str, n: usize) -> ControlOperation {
        ControlOperation::Open {
            source_id: source.into(),
            node_binding: None,
            format: "x".into(),
            bytes: vec![1; n],
        }
    }
    #[test]
    fn exported_bytes_include_queued_payload_budget() {
        let (mut c, out) = setup(100);
        c.enqueue(req(
            1,
            ControlOperation::Export {
                document_id: "d".into(),
                expected_revision: 1,
                format: "x".into(),
            },
        ))
        .unwrap();
        c.pump();
        c.enqueue(req(2, open("next", 75))).unwrap();
        complete(
            &out,
            1,
            OperationResult::Exported {
                bytes: vec![1; 80],
                revision: 1,
            },
        );
        c.pump();
        assert_eq!(
            c.receipts[&1].result.as_ref().unwrap_err().code,
            ErrorCode::BudgetExceeded
        );
    }
    #[test]
    fn stale_prefix_cannot_discard_a_valid_completion() {
        let (mut c, out) = setup(100);
        c.enqueue(req(1, ControlOperation::Hide)).unwrap();
        c.pump();
        for _ in 0..300 {
            complete(&out, 999, OperationResult::Done);
        }
        complete(&out, 1, OperationResult::Done);
        c.pump();
        assert!(c.receipts[&1].result.is_ok());
        assert!(c.running.is_empty());
    }
    #[test]
    fn only_one_new_source_decodes_at_a_time() {
        let (mut c, _) = setup(100);
        c.enqueue(req(1, open("one", 1))).unwrap();
        c.pump();
        c.enqueue(req(2, open("two", 1))).unwrap();
        c.pump();
        assert_eq!(c.running.len(), 1);
        assert_eq!(
            c.receipts[&2].result.as_ref().unwrap_err().code,
            ErrorCode::Busy
        );
    }
    #[test]
    fn activate_cannot_race_async_close() {
        let (mut c, out) = setup(100);
        c.enqueue(req(
            1,
            ControlOperation::Close {
                document_id: "d".into(),
                expected_revision: 1,
                discard: false,
            },
        ))
        .unwrap();
        c.pump();
        c.enqueue(req(
            2,
            ControlOperation::Activate {
                document_id: "d".into(),
            },
        ))
        .unwrap();
        c.pump();
        assert_eq!(
            c.receipts[&2].result.as_ref().unwrap_err().code,
            ErrorCode::Busy
        );
        complete(&out, 1, OperationResult::Done);
        c.pump();
        assert!(c.documents.is_empty());
        assert!(c.active.is_none());
    }
    #[test]
    fn asynchronous_activation_preserves_global_selection_order() {
        let (mut c, out) = setup(100);
        let mut other = c.documents["d"].clone();
        other.document_id = "other".into();
        c.documents.insert("other".into(), other);
        c.enqueue(req(
            1,
            ControlOperation::Activate {
                document_id: "d".into(),
            },
        ))
        .unwrap();
        c.pump();
        c.enqueue(req(
            2,
            ControlOperation::Activate {
                document_id: "other".into(),
            },
        ))
        .unwrap();
        c.pump();
        assert!(!c.running.contains_key(&2));
        complete(&out, 1, OperationResult::Done);
        c.pump();
        assert_eq!(c.active.as_deref(), Some("d"));
        complete(&out, 2, OperationResult::Done);
        c.pump();
        assert_eq!(c.active.as_deref(), Some("other"));
    }
    #[test]
    fn asynchronous_visibility_preserves_admitted_order() {
        let (mut c, out) = setup(100);
        c.visible = true;
        c.enqueue(req(1, ControlOperation::Hide)).unwrap();
        c.pump();
        c.enqueue(req(2, ControlOperation::Show)).unwrap();
        c.pump();
        assert!(!c.running.contains_key(&2));
        complete(&out, 1, OperationResult::Done);
        c.pump();
        assert!(!c.visible());
        assert!(c.running.contains_key(&2));
        complete(&out, 2, OperationResult::Done);
        c.pump();
        assert!(c.visible());
    }
}

#[cfg(test)]
mod thread_affinity_test {
    use super::*;
    use std::{cell::Cell, rc::Rc};
    struct LocalSession(Rc<Cell<usize>>);
    impl EditorSession for LocalSession {
        fn execute(&mut self, _: &ControlRequest) -> Result<Option<OperationResult>, EditorError> {
            self.0.set(self.0.get() + 1);
            Ok(Some(OperationResult::Done))
        }
        fn poll_completions(&mut self) -> Vec<CompletionReceipt> {
            vec![]
        }
        fn shutdown(&mut self) -> Result<(), EditorError> {
            Ok(())
        }
    }
    #[test]
    fn session_can_own_non_send_ui_state() {
        let calls = Rc::new(Cell::new(0));
        let mut c = EditorCoordinator::new(
            "s".into(),
            1,
            Box::new(LocalSession(calls.clone())),
            vec![],
            100,
        );
        c.enqueue(ControlRequest {
            session_id: "s".into(),
            generation: 1,
            request_id: 1,
            operation: ControlOperation::Hide,
        })
        .unwrap();
        c.pump();
        assert_eq!(calls.get(), 1);
    }
}

#[cfg(test)]
mod device_loss_regressions {
    use super::*;
    use std::{cell::Cell, rc::Rc};
    struct RenderProvider {
        losses: Rc<Cell<u32>>,
    }
    impl EditorSession for RenderProvider {
        fn execute(&mut self, _: &ControlRequest) -> Result<Option<OperationResult>, EditorError> {
            Ok(Some(OperationResult::Done))
        }
        fn poll_completions(&mut self) -> Vec<CompletionReceipt> {
            vec![]
        }
        fn prepare_render(&mut self) -> Option<RenderPlan> {
            Some(RenderPlan {
                plan_id: 1,
                device_generation: 1,
                layout_generation: 1,
                document_id: "d".into(),
                document_revision: 2,
            })
        }
        fn poll_state(&mut self) -> Vec<EditorStateEvent> {
            vec![EditorStateEvent {
                key: "cursor".into(),
                generation: 1,
                document_id: Some("d".into()),
                revision: Some(2),
                progress: None,
            }]
        }
        fn device_lost(&mut self) {
            self.losses.set(self.losses.get() + 1);
        }
        fn shutdown(&mut self) -> Result<(), EditorError> {
            Ok(())
        }
    }
    #[test]
    fn first_render_plan_cannot_choose_its_device_generation() {
        let mut c = EditorCoordinator::new(
            "s".into(),
            1,
            Box::new(RenderProvider {
                losses: Rc::new(Cell::new(0)),
            }),
            vec![],
            100,
        );
        c.pump();
        assert!(c.take_render_plan().is_none());
        assert_eq!(
            c.bind_initial_device_generation(0).unwrap_err().code,
            ErrorCode::StaleGeneration
        );
        c.bind_initial_device_generation(2).unwrap();
        c.pump();
        assert!(c.take_render_plan().is_none());
        assert!(c.bind_initial_device_generation(1).is_err());
    }
    #[test]
    fn device_loss_preserves_dirty_owner_and_rejects_old_plans() {
        let losses = Rc::new(Cell::new(0));
        let mut c = EditorCoordinator::new(
            "s".into(),
            1,
            Box::new(RenderProvider {
                losses: losses.clone(),
            }),
            vec![],
            100,
        );
        c.documents.insert(
            "d".into(),
            DocumentState {
                document_id: "d".into(),
                source_id: "source".into(),
                node_binding: Some("node".into()),
                revision: 2,
                saved_revision: 1,
                source_size: [20, 20],
            },
        );
        c.bind_initial_device_generation(1).unwrap();
        c.pump();
        assert!(c.take_render_plan().is_some());
        assert_eq!(c.state_events().len(), 1);
        c.device_lost();
        assert_eq!(losses.get(), 1);
        assert!(c.take_render_plan().is_none());
        assert!(c.state_events().is_empty());
        c.pump();
        assert!(c.take_render_plan().is_none());
        assert!(c.state_events().is_empty());
        assert!(c.documents()["d"].dirty());
        assert_eq!(c.documents()["d"].revision, 2);
        // After successful recovery to a newer generation, delayed old-device plans
        // are still rejected. No actual GPU is created for this protocol regression.
        c.gpu_lost = false;
        c.device_generation = Some(2);
        c.pump();
        assert!(c.take_render_plan().is_none());
    }
}

#[cfg(test)]
mod render_metadata_regressions {
    use super::*;
    use std::{cell::RefCell, rc::Rc};
    struct Metadata {
        plans: Rc<RefCell<Option<RenderPlan>>>,
        completions: Rc<RefCell<Vec<CompletionReceipt>>>,
    }
    impl EditorSession for Metadata {
        fn execute(&mut self, _: &ControlRequest) -> Result<Option<OperationResult>, EditorError> {
            Ok(None)
        }
        fn poll_completions(&mut self) -> Vec<CompletionReceipt> {
            std::mem::take(&mut *self.completions.borrow_mut())
        }
        fn prepare_render(&mut self) -> Option<RenderPlan> {
            self.plans.borrow_mut().take()
        }
        fn shutdown(&mut self) -> Result<(), EditorError> {
            Ok(())
        }
    }
    #[test]
    fn render_metadata_tracks_completions_documents_revisions_and_layout_watermarks() {
        let plans = Rc::new(RefCell::new(None));
        let completions = Rc::new(RefCell::new(vec![]));
        let mut c = EditorCoordinator::new(
            "s".into(),
            1,
            Box::new(Metadata {
                plans: plans.clone(),
                completions: completions.clone(),
            }),
            vec![],
            100,
        );
        c.bind_initial_device_generation(1).unwrap();
        c.documents.insert(
            "d".into(),
            DocumentState {
                document_id: "d".into(),
                source_id: "source".into(),
                node_binding: None,
                revision: 1,
                saved_revision: 1,
                source_size: [2, 2],
            },
        );
        let plan = |revision, layout, id| RenderPlan {
            plan_id: id,
            device_generation: 1,
            layout_generation: layout,
            document_id: "d".into(),
            document_revision: revision,
        };
        let req = |id, operation| ControlRequest {
            request_id: id,
            session_id: "s".into(),
            generation: 1,
            operation,
        };
        c.enqueue(req(
            1,
            ControlOperation::Command {
                document_id: "d".into(),
                expected_revision: 1,
                command: "edit".into(),
                parameters: vec![],
            },
        ))
        .unwrap();
        c.pump();
        *plans.borrow_mut() = Some(plan(1, 5, 10));
        completions.borrow_mut().push(CompletionReceipt {
            request_id: 1,
            generation: 1,
            result: Ok(OperationResult::Changed { revision: 2 }),
        });
        c.pump();
        assert!(c.take_render_plan().is_none());
        *plans.borrow_mut() = Some(plan(2, 5, 11));
        c.pump();
        assert!(c.take_render_plan().is_some());
        for stale in [plan(2, 4, 12), plan(2, 5, 10), plan(1, 6, 13)] {
            *plans.borrow_mut() = Some(stale);
            c.pump();
            assert!(c.take_render_plan().is_none());
        }
        c.enqueue(req(
            2,
            ControlOperation::Close {
                document_id: "d".into(),
                expected_revision: 2,
                discard: true,
            },
        ))
        .unwrap();
        c.pump();
        *plans.borrow_mut() = Some(plan(2, 6, 14));
        completions.borrow_mut().push(CompletionReceipt {
            request_id: 2,
            generation: 1,
            result: Ok(OperationResult::Done),
        });
        c.pump();
        assert!(c.take_render_plan().is_none());
        assert!(c.documents.is_empty());
    }
}

fn bounded_snapshot(value: &serde_json::Value) -> bool {
    fn count(value: &serde_json::Value, depth: usize, left: &mut usize, nodes: &mut usize) -> bool {
        if depth > 16 || *nodes == 0 {
            return false;
        }
        *nodes -= 1;
        let bytes = match value {
            serde_json::Value::String(s) => s.len(),
            serde_json::Value::Array(a) => {
                if a.len() > 1024 {
                    return false;
                }
                return a.iter().all(|v| count(v, depth + 1, left, nodes));
            }
            serde_json::Value::Object(o) => {
                if o.len() > 128 {
                    return false;
                }
                return o.iter().all(|(key, v)| {
                    if key.len() > *left {
                        return false;
                    }
                    *left -= key.len();
                    count(v, depth + 1, left, nodes)
                });
            }
            _ => 16,
        };
        if bytes > *left {
            false
        } else {
            *left -= bytes;
            true
        }
    }
    count(value, 0, &mut (128 * 1024), &mut 4096)
}

#[cfg(test)]
mod frame_regressions {
    use super::*;
    use std::{cell::RefCell, rc::Rc};
    #[derive(Default)]
    struct FrameProbe {
        events: usize,
        calls: usize,
        wrong_layout: bool,
    }
    struct Frames(Rc<RefCell<FrameProbe>>);
    impl EditorSession for Frames {
        fn execute(&mut self, _: &ControlRequest) -> Result<Option<OperationResult>, EditorError> {
            Ok(Some(OperationResult::Done))
        }
        fn poll_completions(&mut self) -> Vec<CompletionReceipt> {
            vec![]
        }
        fn render_frame(
            &mut self,
            c: EditorFrameContext,
        ) -> Result<Option<EditorFrame>, EditorError> {
            let mut p = self.0.borrow_mut();
            p.calls += 1;
            p.events += c.input.len();
            Ok(Some(EditorFrame {
                device_generation: 1,
                layout_generation: if p.wrong_layout {
                    0
                } else {
                    c.layout_generation
                },
                document_id: "d".into(),
                document_revision: 2,
                ui_texture: None,
                document_texture: None,
                document_rect_css: [0.0, 0.0, 100.0, 50.0],
                snapshot: serde_json::json!({"cursor":"default"}),
            }))
        }
        fn shutdown(&mut self) -> Result<(), EditorError> {
            Ok(())
        }
    }
    #[test]
    fn frame_admission_requires_visible_current_layout_device_and_document() {
        let p = Rc::new(RefCell::new(FrameProbe::default()));
        let mut c =
            EditorCoordinator::new("s".into(), 1, Box::new(Frames(p.clone())), vec![], 1024);
        c.bind_initial_device_generation(1).unwrap();
        c.set_layout(EditorLayout {
            physical_size: [200, 100],
            scale_factor: 2.0,
            layout_generation: 1,
            viewport_origin_css: [10.0, 20.0],
        })
        .unwrap();
        c.documents.insert(
            "d".into(),
            DocumentState {
                document_id: "d".into(),
                source_id: "source".into(),
                node_binding: None,
                revision: 1,
                saved_revision: 1,
                source_size: [100, 50],
            },
        );
        assert!(c.render_frame(1.0).unwrap().is_none());
        assert_eq!(p.borrow().calls, 0);
        c.visible = true;
        c.enqueue_input(NativeEditorInput {
            sequence: 1,
            layout_generation: 1,
            time_seconds: 1.0,
            event: NativeInputEvent::Blur,
        })
        .unwrap();
        assert!(c.render_frame(1.0).unwrap().is_some());
        assert_eq!(c.documents()["d"].revision, 2);
        assert!(c.documents()["d"].dirty());
        assert_eq!(p.borrow().events, 1);
        p.borrow_mut().wrong_layout = true;
        assert_eq!(
            c.render_frame(2.0).err().unwrap().code,
            ErrorCode::StaleGeneration
        );
        c.device_lost();
        assert!(c.render_frame(3.0).unwrap().is_none());
        assert_eq!(p.borrow().calls, 2);
    }
    #[test]
    fn same_turn_input_commits_before_export_revision_is_checked() {
        let p = Rc::new(RefCell::new(FrameProbe::default()));
        let mut c = EditorCoordinator::new("s".into(), 1, Box::new(Frames(p)), vec![], 1024);
        c.bind_initial_device_generation(1).unwrap();
        c.set_layout(EditorLayout {
            physical_size: [100, 50],
            scale_factor: 1.,
            layout_generation: 1,
            viewport_origin_css: [0., 0.],
        })
        .unwrap();
        c.documents.insert(
            "d".into(),
            DocumentState {
                document_id: "d".into(),
                source_id: "source".into(),
                node_binding: None,
                revision: 1,
                saved_revision: 1,
                source_size: [100, 50],
            },
        );
        c.active = Some("d".into());
        c.visible = true;
        c.enqueue(ControlRequest {
            session_id: "s".into(),
            request_id: 1,
            generation: 1,
            operation: ControlOperation::Export {
                document_id: "d".into(),
                expected_revision: 1,
                format: "png".into(),
            },
        })
        .unwrap();
        c.advance_frame(1.).unwrap();
        assert_eq!(c.documents()["d"].revision, 2);
        assert_eq!(
            c.receipts[&1].result.as_ref().err().unwrap().code,
            ErrorCode::StaleRevision
        );
    }
    #[test]
    fn layout_geometry_cannot_change_without_generation_and_snapshot_is_bounded() {
        let p = Rc::new(RefCell::new(FrameProbe::default()));
        let mut c = EditorCoordinator::new("s".into(), 1, Box::new(Frames(p)), vec![], 1024);
        let l = EditorLayout {
            physical_size: [200, 100],
            scale_factor: 2.0,
            layout_generation: 1,
            viewport_origin_css: [0.0, 0.0],
        };
        c.set_layout(l.clone()).unwrap();
        let mut changed = l;
        changed.physical_size = [201, 100];
        assert_eq!(
            c.set_layout(changed).unwrap_err().code,
            ErrorCode::StaleGeneration
        );
        assert!(!bounded_snapshot(
            &serde_json::json!({"value":"x".repeat(128*1024+1)})
        ));
    }
}

#[cfg(test)]
mod revision_projection_tests {
    use super::*;
    use std::{cell::RefCell, rc::Rc};
    struct Projection(Rc<RefCell<DocumentState>>);
    impl EditorSession for Projection {
        fn execute(&mut self, r: &ControlRequest) -> Result<Option<OperationResult>, EditorError> {
            if let ControlOperation::MarkSaved {
                expected_revision, ..
            } = r.operation
            {
                if expected_revision != 2 {
                    return Err(EditorError::new(
                        ErrorCode::StaleRevision,
                        "revision was not exported",
                    ));
                }
                self.0.borrow_mut().saved_revision = expected_revision;
            }
            Ok(Some(OperationResult::Done))
        }
        fn document_states(&self) -> Option<Vec<DocumentState>> {
            Some(vec![self.0.borrow().clone()])
        }
        fn poll_completions(&mut self) -> Vec<CompletionReceipt> {
            vec![]
        }
        fn shutdown(&mut self) -> Result<(), EditorError> {
            Ok(())
        }
    }
    #[test]
    fn authoritative_hidden_revisions_refresh_and_exported_old_revision_remains_dirty() {
        let doc = DocumentState {
            document_id: "d".into(),
            source_id: "source".into(),
            node_binding: None,
            revision: 1,
            saved_revision: 1,
            source_size: [10, 10],
        };
        let state = Rc::new(RefCell::new(doc.clone()));
        let mut c = EditorCoordinator::new(
            "s".into(),
            1,
            Box::new(Projection(state.clone())),
            vec![],
            1000,
        );
        c.documents.insert("d".into(), doc);
        state.borrow_mut().revision = 3;
        c.enqueue(ControlRequest {
            session_id: "s".into(),
            generation: 1,
            request_id: 1,
            operation: ControlOperation::MarkSaved {
                document_id: "d".into(),
                expected_revision: 2,
            },
        })
        .unwrap();
        c.pump();
        assert!(c.receipts[&1].result.is_ok());
        assert_eq!(c.documents()["d"].revision, 3);
        assert_eq!(c.documents()["d"].saved_revision, 2);
        assert!(c.documents()["d"].dirty());
        c.enqueue(ControlRequest {
            session_id: "s".into(),
            generation: 1,
            request_id: 2,
            operation: ControlOperation::MarkSaved {
                document_id: "d".into(),
                expected_revision: 1,
            },
        })
        .unwrap();
        c.pump();
        assert!(c.receipts[&2].result.is_err());
        assert_eq!(c.documents()["d"].saved_revision, 2);
    }
}

#[cfg(test)]
mod provider_local_document_tests {
    use super::*;
    use std::{cell::RefCell, rc::Rc};
    struct LocalDocs {
        states: Rc<RefCell<Vec<DocumentState>>>,
        completions: Rc<RefCell<Vec<CompletionReceipt>>>,
    }
    impl EditorSession for LocalDocs {
        fn execute(&mut self, _: &ControlRequest) -> Result<Option<OperationResult>, EditorError> {
            Ok(None)
        }
        fn poll_completions(&mut self) -> Vec<CompletionReceipt> {
            std::mem::take(&mut *self.completions.borrow_mut())
        }
        fn document_states(&self) -> Option<Vec<DocumentState>> {
            Some(self.states.borrow().clone())
        }
        fn shutdown(&mut self) -> Result<(), EditorError> {
            Ok(())
        }
    }
    fn doc(id: &str, source: &str) -> DocumentState {
        DocumentState {
            document_id: id.into(),
            source_id: source.into(),
            node_binding: None,
            revision: 1,
            saved_revision: 1,
            source_size: [20, 10],
        }
    }
    #[test]
    fn provider_local_tabs_adopt_but_pending_host_open_keeps_its_reserved_source() {
        let states = Rc::new(RefCell::new(vec![doc("local", "local-source")]));
        let completions = Rc::new(RefCell::new(vec![]));
        let mut c = EditorCoordinator::new(
            "s".into(),
            1,
            Box::new(LocalDocs {
                states: states.clone(),
                completions: completions.clone(),
            }),
            vec!["x".into()],
            1000,
        );
        c.pump();
        assert!(c.documents.contains_key("local"));
        c.enqueue(ControlRequest {
            session_id: "s".into(),
            generation: 1,
            request_id: 1,
            operation: ControlOperation::Open {
                source_id: "host-source".into(),
                node_binding: None,
                format: "x".into(),
                bytes: vec![1],
            },
        })
        .unwrap();
        states.borrow_mut().push(doc("host", "host-source"));
        c.pump();
        assert!(!c.documents.contains_key("host"));
        assert!(c.running.contains_key(&1));
        completions.borrow_mut().push(CompletionReceipt {
            request_id: 1,
            generation: 1,
            result: Ok(OperationResult::Opened {
                document_id: "host".into(),
                revision: 1,
                source_size: [20, 10],
            }),
        });
        c.pump();
        assert!(c.receipts[&1].result.is_ok());
        assert!(c.documents.contains_key("host"));
        states.borrow_mut().retain(|d| d.document_id != "local");
        c.pump();
        assert!(!c.documents.contains_key("local"));
        c.enqueue(ControlRequest {
            session_id: "s".into(),
            generation: 1,
            request_id: 2,
            operation: ControlOperation::Close {
                document_id: "host".into(),
                expected_revision: 1,
                discard: false,
            },
        })
        .unwrap();
        c.pump();
        states.borrow_mut().clear();
        completions.borrow_mut().push(CompletionReceipt {
            request_id: 2,
            generation: 1,
            result: Ok(OperationResult::Done),
        });
        c.pump();
        assert!(c.receipts[&2].result.is_ok());
        assert!(c.documents.is_empty());
    }
    #[test]
    fn unrequested_bound_documents_cannot_be_adopted() {
        let mut bound = doc("bound", "source");
        bound.node_binding = Some("node".into());
        let states = Rc::new(RefCell::new(vec![bound]));
        let mut c = EditorCoordinator::new(
            "s".into(),
            1,
            Box::new(LocalDocs {
                states,
                completions: Rc::new(RefCell::new(vec![])),
            }),
            vec![],
            1000,
        );
        c.pump();
        assert!(c.documents.is_empty());
    }
}
