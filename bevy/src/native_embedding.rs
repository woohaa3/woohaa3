//! Host-neutral native canvas embedding contract.
//!
//! This is the small, deterministic part of the native runtime that an
//! external Tauri (or another native) host can depend on.  Window parenting,
//! z-order and the OS event loop stay in the host adapter.  The contract is
//! intentionally usable in tests without a GPU or a display session.

use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fmt,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

use bevy::window::RawHandleWrapper;

pub const PROTOCOL_VERSION: u32 = 1;
pub const FACTS_SCHEMA_VERSION: u32 = 1;
pub const DEFAULT_MAX_DIMENSION: u32 = 16_384;
pub const DEFAULT_MAX_PAYLOAD_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ViewBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl ViewBounds {
    pub fn validate(self, max_dimension: u32) -> Result<Self, NativeCanvasError> {
        if ![self.x, self.y, self.width, self.height]
            .iter()
            .all(|v| v.is_finite())
        {
            return Err(NativeCanvasError::InvalidBounds("bounds must be finite"));
        }
        if self.width < 0.0 || self.height < 0.0 {
            return Err(NativeCanvasError::InvalidBounds(
                "bounds cannot be negative",
            ));
        }
        if self.width > f64::from(max_dimension) || self.height > f64::from(max_dimension) {
            return Err(NativeCanvasError::BoundsTooLarge);
        }
        Ok(self)
    }

    pub fn physical(
        self,
        scale_factor: f64,
        max_dimension: u32,
    ) -> Result<(u32, u32), NativeCanvasError> {
        if !scale_factor.is_finite() || scale_factor <= 0.0 {
            return Err(NativeCanvasError::InvalidScale);
        }
        let bounds = self.validate(max_dimension)?;
        let width = (bounds.width * scale_factor).ceil();
        let height = (bounds.height * scale_factor).ceil();
        if width > f64::from(max_dimension) || height > f64::from(max_dimension) {
            return Err(NativeCanvasError::BoundsTooLarge);
        }
        Ok((width as u32, height as u32))
    }

    pub fn is_zero(self) -> bool {
        self.width == 0.0 || self.height == 0.0
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EmbeddingManifest {
    pub renderer_build: String,
    pub protocol_version: u32,
    pub facts_schema_version: u32,
    pub platforms: Vec<String>,
    pub architectures: Vec<String>,
    pub asset_root: PathBuf,
    pub asset_sha256: String,
}

impl EmbeddingManifest {
    pub fn validate(&self, assets: &Path, protocol: u32) -> Result<(), NativeCanvasError> {
        if self.protocol_version != protocol || self.facts_schema_version != FACTS_SCHEMA_VERSION {
            return Err(NativeCanvasError::ProtocolMismatch);
        }
        if self.renderer_build.trim().is_empty() || self.asset_sha256.len() != 64 {
            return Err(NativeCanvasError::InvalidManifest);
        }
        let root = if self.asset_root.is_absolute() {
            self.asset_root.clone()
        } else {
            assets.join(&self.asset_root)
        };
        if !root.is_dir() {
            return Err(NativeCanvasError::AssetsMissing);
        }
        // Hash verification is performed by the packaging/host adapter.  The
        // runtime still rejects an unqualified manifest and arbitrary paths.
        if self
            .asset_root
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return Err(NativeCanvasError::InvalidManifest);
        }
        Ok(())
    }
}

#[derive(Debug)]
pub struct NativeCanvasOptions {
    pub parent: Option<RawHandleWrapper>,
    pub assets: PathBuf,
    pub logical_size: ViewBounds,
    pub scale_factor: f64,
    pub protocol_version: u32,
    pub host_identity: String,
    pub manifest: Option<EmbeddingManifest>,
    pub max_dimension: u32,
    pub max_payload_bytes: usize,
}

impl Default for NativeCanvasOptions {
    fn default() -> Self {
        Self {
            parent: None,
            assets: PathBuf::new(),
            logical_size: ViewBounds {
                x: 0.0,
                y: 0.0,
                width: 1280.0,
                height: 720.0,
            },
            scale_factor: 1.0,
            protocol_version: PROTOCOL_VERSION,
            host_identity: "default".into(),
            manifest: None,
            max_dimension: DEFAULT_MAX_DIMENSION,
            max_payload_bytes: DEFAULT_MAX_PAYLOAD_BYTES,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RuntimeState {
    Detached,
    Attached,
    Ready,
    Hidden,
    Visible,
    Disposing,
    Disposed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TickResult {
    Rendered,
    Hidden,
    NotReady,
    Disposed,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct CompositionFacts {
    pub facts_schema_version: u32,
    pub protocol_version: u32,
    pub physical_width: u32,
    pub physical_height: u32,
    pub scale_factor_milli: u32,
    pub webview_attached: bool,
    pub gpu_ready: bool,
    pub rendered_frames: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NativeCanvasError {
    InvalidBounds(&'static str),
    BoundsTooLarge,
    InvalidScale,
    ProtocolMismatch,
    AssetsMissing,
    InvalidManifest,
    AlreadyAttached,
    StaleRuntime,
    RuntimeDisposed,
    PayloadTooLarge,
    NotReady,
    Hidden,
    GpuInitFailed,
    DrainPending,
}
impl fmt::Display for NativeCanvasError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.code())
    }
}
impl std::error::Error for NativeCanvasError {}
impl NativeCanvasError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidBounds(_) => "invalid-bounds",
            Self::BoundsTooLarge => "bounds-too-large",
            Self::InvalidScale => "invalid-scale",
            Self::ProtocolMismatch => "protocol-mismatch",
            Self::AssetsMissing => "assets-missing",
            Self::InvalidManifest => "invalid-manifest",
            Self::AlreadyAttached => "already-attached",
            Self::StaleRuntime => "stale-runtime",
            Self::RuntimeDisposed => "runtime-disposed",
            Self::PayloadTooLarge => "payload-too-large",
            Self::NotReady => "not-ready",
            Self::Hidden => "hidden",
            Self::GpuInitFailed => "gpu-init-failed",
            Self::DrainPending => "drain-pending",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BridgeRequest {
    pub protocol_version: u32,
    pub generation: u64,
    pub sequence: u64,
    pub payload_bytes: usize,
}

pub trait NativeCanvasBridge: Send + Sync {
    fn validate(&self, request: &BridgeRequest) -> Result<(), NativeCanvasError>;
}
#[derive(Default)]
struct ContractBridge;
impl NativeCanvasBridge for ContractBridge {
    fn validate(&self, request: &BridgeRequest) -> Result<(), NativeCanvasError> {
        if request.protocol_version != PROTOCOL_VERSION {
            return Err(NativeCanvasError::ProtocolMismatch);
        }
        if request.payload_bytes > DEFAULT_MAX_PAYLOAD_BYTES {
            return Err(NativeCanvasError::PayloadTooLarge);
        }
        Ok(())
    }
}

pub struct NativeCanvasRuntime {
    state: RuntimeState,
    generation: u64,
    bounds: ViewBounds,
    scale_factor: f64,
    max_dimension: u32,
    max_payload_bytes: usize,
    facts: CompositionFacts,
    bridge: ContractBridge,
    host_identity: String,
}

fn attached_hosts() -> &'static Mutex<HashSet<String>> {
    static HOSTS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    HOSTS.get_or_init(|| Mutex::new(HashSet::new()))
}

impl NativeCanvasRuntime {
    pub fn attach(options: NativeCanvasOptions) -> Result<Self, NativeCanvasError> {
        if options.host_identity.trim().is_empty() {
            return Err(NativeCanvasError::AlreadyAttached);
        }
        options
            .logical_size
            .physical(options.scale_factor, options.max_dimension)?;
        if options.protocol_version != PROTOCOL_VERSION {
            return Err(NativeCanvasError::ProtocolMismatch);
        }
        if let Some(manifest) = &options.manifest {
            manifest.validate(&options.assets, options.protocol_version)?;
        }
        let (w, h) = options
            .logical_size
            .physical(options.scale_factor, options.max_dimension)?;
        let hidden = options.logical_size.is_zero();
        {
            let mut hosts = attached_hosts()
                .lock()
                .expect("embedding host registry poisoned");
            if !hosts.insert(options.host_identity.clone()) {
                return Err(NativeCanvasError::AlreadyAttached);
            }
        }
        Ok(Self {
            state: if hidden {
                RuntimeState::Hidden
            } else {
                RuntimeState::Ready
            },
            generation: 1,
            bounds: options.logical_size,
            scale_factor: options.scale_factor,
            max_dimension: options.max_dimension,
            max_payload_bytes: options.max_payload_bytes,
            facts: CompositionFacts {
                facts_schema_version: FACTS_SCHEMA_VERSION,
                protocol_version: PROTOCOL_VERSION,
                physical_width: w,
                physical_height: h,
                scale_factor_milli: (options.scale_factor * 1000.0).round() as u32,
                ..Default::default()
            },
            bridge: ContractBridge,
            host_identity: options.host_identity,
        })
    }
    pub fn state(&self) -> RuntimeState {
        self.state
    }
    pub fn generation(&self) -> u64 {
        self.generation
    }
    pub fn bridge(&self) -> &dyn NativeCanvasBridge {
        &self.bridge
    }
    pub fn facts(&self) -> CompositionFacts {
        self.facts
    }
    pub fn set_bounds(&mut self, bounds: ViewBounds, scale: f64) -> Result<(), NativeCanvasError> {
        if self.state == RuntimeState::Disposed {
            return Err(NativeCanvasError::RuntimeDisposed);
        }
        let (w, h) = bounds.physical(scale, self.max_dimension)?;
        self.bounds = bounds;
        self.scale_factor = scale;
        self.facts.physical_width = w;
        self.facts.physical_height = h;
        self.facts.scale_factor_milli = (scale * 1000.0).round() as u32;
        self.state = if bounds.is_zero() {
            RuntimeState::Hidden
        } else if self.state == RuntimeState::Hidden {
            RuntimeState::Visible
        } else {
            RuntimeState::Ready
        };
        Ok(())
    }
    pub fn set_visible(&mut self, visible: bool) -> Result<(), NativeCanvasError> {
        if self.state == RuntimeState::Disposed {
            return Err(NativeCanvasError::RuntimeDisposed);
        }
        self.state = if visible {
            if self.bounds.is_zero() {
                RuntimeState::Hidden
            } else {
                RuntimeState::Visible
            }
        } else {
            RuntimeState::Hidden
        };
        Ok(())
    }
    pub fn tick(&mut self) -> Result<TickResult, NativeCanvasError> {
        match self.state {
            RuntimeState::Disposed | RuntimeState::Disposing => {
                Err(NativeCanvasError::RuntimeDisposed)
            }
            RuntimeState::Hidden => Ok(TickResult::Hidden),
            RuntimeState::Detached | RuntimeState::Attached => Ok(TickResult::NotReady),
            RuntimeState::Ready | RuntimeState::Visible => {
                self.facts.rendered_frames += 1;
                Ok(TickResult::Rendered)
            }
        }
    }
    pub fn dispose(&mut self, in_flight: u32) -> Result<(), NativeCanvasError> {
        if self.state == RuntimeState::Disposed {
            return Ok(());
        }
        if in_flight > 0 {
            self.state = RuntimeState::Disposing;
            return Err(NativeCanvasError::DrainPending);
        }
        self.state = RuntimeState::Disposed;
        self.generation += 1;
        attached_hosts()
            .lock()
            .expect("embedding host registry poisoned")
            .remove(&self.host_identity);
        Ok(())
    }
    pub fn validate_request(&self, request: &BridgeRequest) -> Result<(), NativeCanvasError> {
        if self.state == RuntimeState::Disposed || self.state == RuntimeState::Disposing {
            return Err(NativeCanvasError::RuntimeDisposed);
        }
        if request.generation != self.generation {
            return Err(NativeCanvasError::StaleRuntime);
        }
        if request.protocol_version != PROTOCOL_VERSION {
            return Err(NativeCanvasError::ProtocolMismatch);
        }
        if request.payload_bytes > self.max_payload_bytes {
            return Err(NativeCanvasError::PayloadTooLarge);
        }
        Ok(())
    }
}

impl Drop for NativeCanvasRuntime {
    fn drop(&mut self) {
        attached_hosts()
            .lock()
            .expect("embedding host registry poisoned")
            .remove(&self.host_identity);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The attach registry is process-wide, so every test instance needs its
    /// own host identity to stay independent of the scheduler order.
    fn options(tag: &str) -> NativeCanvasOptions {
        NativeCanvasOptions {
            host_identity: format!("test-{tag}"),
            ..Default::default()
        }
    }

    #[test]
    fn rejects_non_finite_and_oversized_bounds() {
        assert!(
            ViewBounds {
                width: f64::NAN,
                ..Default::default()
            }
            .validate(100)
            .is_err()
        );
        assert!(
            ViewBounds {
                width: 101.0,
                ..Default::default()
            }
            .validate(100)
            .is_err()
        );
    }
    #[test]
    fn hide_show_preserves_generation_and_frames() {
        let mut r = NativeCanvasRuntime::attach(options("hide-show")).unwrap();
        let generation = r.generation();
        r.tick().unwrap();
        r.set_visible(false).unwrap();
        assert_eq!(r.tick().unwrap(), TickResult::Hidden);
        r.set_visible(true).unwrap();
        assert_eq!(r.generation(), generation);
        assert_eq!(r.tick().unwrap(), TickResult::Rendered);
    }
    #[test]
    fn stale_and_disposed_requests_are_rejected() {
        let mut r = NativeCanvasRuntime::attach(options("stale")).unwrap();
        assert_eq!(
            r.validate_request(&BridgeRequest {
                protocol_version: PROTOCOL_VERSION,
                generation: 99,
                sequence: 1,
                payload_bytes: 0
            })
            .unwrap_err(),
            NativeCanvasError::StaleRuntime
        );
        r.dispose(0).unwrap();
        assert_eq!(
            r.validate_request(&BridgeRequest {
                protocol_version: PROTOCOL_VERSION,
                generation: 1,
                sequence: 1,
                payload_bytes: 0
            })
            .unwrap_err(),
            NativeCanvasError::RuntimeDisposed
        );
    }
    #[test]
    fn drain_pending_is_idempotent() {
        let mut r = NativeCanvasRuntime::attach(options("drain-pending")).unwrap();
        assert_eq!(r.dispose(1), Err(NativeCanvasError::DrainPending));
        assert_eq!(r.state(), RuntimeState::Disposing);
        assert_eq!(r.dispose(0), Ok(()));
        assert_eq!(r.dispose(0), Ok(()));
    }

    #[test]
    fn duplicate_host_identity_is_rejected_until_disposed() {
        let first = NativeCanvasRuntime::attach(NativeCanvasOptions {
            host_identity: "duplicate-test".into(),
            ..Default::default()
        })
        .unwrap();
        assert!(matches!(
            NativeCanvasRuntime::attach(NativeCanvasOptions {
                host_identity: "duplicate-test".into(),
                ..Default::default()
            }),
            Err(NativeCanvasError::AlreadyAttached)
        ));
        drop(first);
        assert!(
            NativeCanvasRuntime::attach(NativeCanvasOptions {
                host_identity: "duplicate-test".into(),
                ..Default::default()
            })
            .is_ok()
        );
    }

    #[test]
    fn manifest_rejects_missing_assets_and_protocol_mismatch_before_attach() {
        let manifest = EmbeddingManifest {
            renderer_build: "build".into(),
            protocol_version: PROTOCOL_VERSION + 1,
            facts_schema_version: FACTS_SCHEMA_VERSION,
            platforms: vec!["linux-x86_64".into()],
            architectures: vec!["x86_64".into()],
            asset_root: PathBuf::from("assets"),
            asset_sha256: "0".repeat(64),
        };
        let options = NativeCanvasOptions {
            manifest: Some(manifest),
            host_identity: "manifest-test".into(),
            ..Default::default()
        };
        assert!(matches!(
            NativeCanvasRuntime::attach(options),
            Err(NativeCanvasError::ProtocolMismatch)
        ));
        let options = NativeCanvasOptions {
            manifest: Some(EmbeddingManifest {
                renderer_build: "build".into(),
                protocol_version: PROTOCOL_VERSION,
                facts_schema_version: FACTS_SCHEMA_VERSION,
                platforms: vec!["linux-x86_64".into()],
                architectures: vec!["x86_64".into()],
                asset_root: PathBuf::from("definitely-missing-assets"),
                asset_sha256: "0".repeat(64),
            }),
            host_identity: "manifest-test-2".into(),
            ..Default::default()
        };
        assert!(matches!(
            NativeCanvasRuntime::attach(options),
            Err(NativeCanvasError::AssetsMissing)
        ));
    }
}
