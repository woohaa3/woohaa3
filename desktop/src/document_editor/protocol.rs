use super::{EditorLayout, NativeEditorInput};
use bevy::render::renderer::{RenderAdapter, RenderDevice, RenderInstance, RenderQueue};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

pub const EDITOR_API_MAJOR: u32 = 1;
pub const MAX_PENDING_REQUESTS: usize = 256;
pub const MAX_DOCUMENTS: usize = 8;
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorCode {
    Unavailable,
    Incompatible,
    Unsupported,
    Busy,
    StaleGeneration,
    StaleRevision,
    BudgetExceeded,
    DeviceLost,
    Cancelled,
    InternalError,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EditorError {
    pub code: ErrorCode,
    pub message: String,
    pub diagnostic_id: Option<String>,
}
impl EditorError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            diagnostic_id: (code == ErrorCode::InternalError)
                .then(|| uuid::Uuid::new_v4().to_string()),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderDescriptor {
    pub provider_id: String,
    pub api_major: u32,
    pub api_minor: u32,
    pub project_protocol: u32,
    pub browser_protocol: u32,
    pub formats: Vec<String>,
    pub capabilities: Vec<String>,
    pub build_identity: String,
}
#[derive(Debug, Clone)]
pub struct AdmissionRequirements {
    pub project_protocol: u32,
    pub browser_protocol: u32,
    pub capabilities: Vec<String>,
}
#[derive(Clone)]
pub struct GpuContext {
    pub adapter: RenderAdapter,
    pub instance: RenderInstance,
    pub device: RenderDevice,
    pub queue: RenderQueue,
    pub device_generation: u64,
    pub max_texture_dimension_2d: u32,
    pub budget_bytes: u64,
    pub color_space: String,
}
pub trait RuntimeAssetResolver: Send + Sync {
    fn resolve(&self, identity: &str, max_bytes: usize) -> Result<Vec<u8>, EditorError>;
}
pub struct EditorCreateContext {
    pub gpu: GpuContext,
    pub physical_size: [u32; 2],
    pub scale_factor: f64,
    pub assets: Arc<dyn RuntimeAssetResolver>,
}
pub trait NativeDocumentEditorFactory: Send + Sync {
    fn descriptor(&self) -> ProviderDescriptor;
    fn create(&self, context: EditorCreateContext) -> Result<Box<dyn EditorSession>, EditorError>;
}
/// Invoked exclusively on the coordinator owner thread. Heavy work must be
/// scheduled by the provider, never computed inline by enqueue or a UI frame.
pub trait EditorSession {
    fn execute(&mut self, request: &ControlRequest)
    -> Result<Option<OperationResult>, EditorError>;
    fn poll_completions(&mut self) -> Vec<CompletionReceipt>;
    /// Authoritative lightweight projection for all already-admitted documents.
    /// IDs/source bindings must remain stable; no pixels or serialization work.
    /// Local UI-created documents must be unbound; host Open requests reserve
    /// their source identity until their durable completion receipt settles.
    fn document_states(&self) -> Option<Vec<DocumentState>> {
        None
    }
    fn poll_state(&mut self) -> Vec<EditorStateEvent> {
        Vec::new()
    }
    fn prepare_render(&mut self) -> Option<RenderPlan> {
        None
    }
    /// Release every reference to resources of the lost device. CPU-only providers
    /// may retain their document state without additional action.
    fn device_lost(&mut self) {}
    fn recover_gpu(&mut self, _gpu: GpuContext) -> Result<(), EditorError> {
        Err(EditorError::new(
            ErrorCode::Unsupported,
            "GPU recovery is not implemented",
        ))
    }
    /// Clear pointer/key/IME ownership immediately, without creating a GPU frame.
    fn cancel_input(&mut self) {}
    fn render_frame(
        &mut self,
        _context: EditorFrameContext,
    ) -> Result<Option<EditorFrame>, EditorError> {
        Ok(None)
    }
    fn shutdown(&mut self) -> Result<(), EditorError>;
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ControlRequest {
    pub session_id: String,
    pub request_id: u64,
    pub generation: u64,
    pub operation: ControlOperation,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ControlOperation {
    Open {
        source_id: String,
        node_binding: Option<String>,
        format: String,
        bytes: Vec<u8>,
    },
    Activate {
        document_id: String,
    },
    Input {
        input: NativeEditorInput,
    },
    Layout {
        layout: EditorLayout,
    },
    Show,
    Hide,
    Close {
        document_id: String,
        expected_revision: u64,
        discard: bool,
    },
    Command {
        document_id: String,
        expected_revision: u64,
        command: String,
        parameters: Vec<u8>,
    },
    Export {
        document_id: String,
        expected_revision: u64,
        format: String,
    },
    CancelJob {
        job_id: u64,
    },
    MarkSaved {
        document_id: String,
        expected_revision: u64,
    },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocumentState {
    pub document_id: String,
    pub source_id: String,
    pub node_binding: Option<String>,
    pub revision: u64,
    pub saved_revision: u64,
    pub source_size: [u32; 2],
}
impl DocumentState {
    pub fn dirty(&self) -> bool {
        self.revision != self.saved_revision
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum OperationResult {
    Opened {
        document_id: String,
        revision: u64,
        source_size: [u32; 2],
    },
    Changed {
        revision: u64,
    },
    Exported {
        bytes: Vec<u8>,
        revision: u64,
    },
    NeedsSettlement {
        document_id: String,
    },
    Done,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompletionReceipt {
    pub request_id: u64,
    pub generation: u64,
    pub result: Result<OperationResult, EditorError>,
}

/// Reconstructable state is separate from durable control receipts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditorStateEvent {
    pub key: String,
    pub generation: u64,
    pub document_id: Option<String>,
    pub revision: Option<u64>,
    pub progress: Option<f32>,
}
/// Metadata for a provider-owned immutable plan, never an editor reference or JS handle.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenderPlan {
    pub plan_id: u64,
    pub device_generation: u64,
    pub layout_generation: u64,
    pub document_id: String,
    pub document_revision: u64,
}

/// CPU metadata and input are owned values. GPU objects never cross WebView JSON.
pub struct EditorFrameContext {
    pub physical_size: [u32; 2],
    pub scale_factor: f64,
    pub time_seconds: f64,
    pub layout_generation: u64,
    pub viewport_origin_css: [f64; 2],
    pub input: Vec<NativeEditorInput>,
}
pub struct EditorFrame {
    pub device_generation: u64,
    pub layout_generation: u64,
    pub document_id: String,
    pub document_revision: u64,
    pub ui_texture: Option<bevy::render::render_resource::Texture>,
    pub document_texture: Option<bevy::render::render_resource::Texture>,
    pub document_rect_css: [f64; 4],
    pub snapshot: serde_json::Value,
}
