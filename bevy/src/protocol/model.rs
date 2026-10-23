//! Scene IR 模型 DTO：V1/V2 部件 op、模型快照与 placement
//! （change: refactor-bevy-rust-file-size，任务 2.1 / design D3）。

use serde::Deserialize;

/// 当前画布快照协议版本；与 contracts `CANVAS_RENDER_SCENE_VERSION` 一致。
/// v5 起模型从节点内联 payload 拆出为按内容签名注册的不可变资源
/// （change: optimize-model-scene-snapshot-hot-path）。
/// v7 起新增单节点拖动粘连瞬时投影 `dragAttach`
/// （change: add-drag-touch-connections）。
/// v8 起新增多选聚合拉线瞬时投影 `aggregateConnect`
/// （change: add-multi-select-aggregate-connect）。
/// v9 起支持通用容器表面与图片聚焦（Camera2d 二维取景）瞬时投影，渲染资源留在引擎内部；
/// v10 起支持普通模型卡片内嵌预览与本地观察姿态；
/// v13 起新增视频聚焦瞬时投影 `videoFocus`（与 `imageFocus` 共用二维媒体取景语义）；
/// v14 起新增媒体解码/缓冲瞬时状态 `mediaLoading`；
/// v15 起 `CompositeAssetPresentation` 新增缺省 `rect` 的通用范围形状声明 `scopeShape`
/// （change: 2026-10-12-align-film-set-scope-with-isometric-grid）。
/// v17 起新增节点下方独立历史条 `historyStrip` 与聚合节点运行遮罩 `aggregateRun`
/// （change: 2026-10-12-unify-generation-history-strip）。
/// v18 起节点新增 `nodeActions` 顶部操作横条描述（change: 2026-10-13-add-node-to-film-set-shortcut）。
/// v19 起 `CompositeAssetPresentation` 新增可选总览 primitive LOD 策略声明 `geometryQuality`
/// （change: 2026-10-15-add-film-set-overview-lod）。
/// v20 起预览卡片新增节点内 `shotPreview` 呈现、场景新增派生 `shotPreviewLinks` 归属线集合、
/// 动画播放新增 `shot-node-preview` 模式与目标卡片路由
/// （change: 2026-10-15-add-film-set-shooting-shot-previews）。
pub(crate) const CANVAS_RENDER_SCENE_VERSION: &str = "woohaa-canvas-render-scene-v22";
/// prepared model resource envelope 版本。
pub(crate) const MODEL_ASSET_VERSION: &str = "woohaa-prepared-model-resource-v1";

/// 节点上的轻量模型引用：只含稳定 resource key 与动态 placement。
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelReference {
    /// Scene IR 版本（V1 或 V2）。
    #[serde(default)]
    #[allow(dead_code)] // 线格式字段：由 contracts 下发，渲染按 resource_key 解析；保留以对齐协议。
    pub(crate) scene_version: Option<String>,
    /// 按内容签名注册的资源 key；不含节点 id。
    pub(crate) resource_key: String,
    /// 模型内容签名；placement/viewport 变化时不变。
    #[serde(default)]
    pub(crate) signature: String,
    #[serde(default)]
    pub(crate) placement: ModelPlacement,
}

/// 坐标轴对齐包围盒（prepared resource 携带，供渲染/取景复用）。
#[derive(Clone, Copy, Debug, PartialEq, Deserialize, serde::Serialize)]
pub(crate) struct ModelAabbDto {
    pub(crate) min: [f32; 3],
    pub(crate) max: [f32; 3],
}

/// 独立注册通道的模型资源 descriptor（change: optimize-model-scene-snapshot-hot-path）。
///
/// 由 Frontend 从同一份规范化 Scene IR 一次性派生；`resourceKey` 为 `sceneVersion:signature`。
/// 生产侧 prepared-and-register 走 `PreparedModelRequest`；本 DTO 保留为线格式契约与单测入口。
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub(crate) struct ModelAssetDescriptor {
    #[serde(default)]
    pub(crate) resource_version: String,
    #[serde(default)]
    pub(crate) resource_key: String,
    #[serde(default)]
    pub(crate) scene_version: Option<String>,
    #[serde(default)]
    pub(crate) signature: String,
    #[serde(default = "default_extent")]
    pub(crate) extent: f32,
    #[serde(default)]
    pub(crate) aabb: Option<ModelAabbDto>,
    pub(crate) ops: Vec<ModelOp>,
}

#[allow(dead_code)]
impl ModelAssetDescriptor {
    /// 边界级防御校验：版本、场景版本（V2-only）、key、签名、有限 extent 与至少一个 op。
    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        if self.resource_version != MODEL_ASSET_VERSION {
            return Err("Unknown model resource version");
        }
        // change: 2026-10-07-remove-residual-compatibility —— 只接受 V2 Scene IR。
        match self.scene_version.as_deref() {
            Some(version) if is_supported_scene_ir_version(version) => {}
            _ => return Err("Unsupported model scene version"),
        }
        if self.resource_key.is_empty() || self.resource_key.len() > 256 {
            return Err("Invalid model resource key");
        }
        if self.signature.is_empty() || self.signature.len() > 256 {
            return Err("Invalid model resource signature");
        }
        if !self.resource_key.ends_with(&self.signature) {
            return Err("Model resource key/signature mismatch");
        }
        if !self.extent.is_finite() || self.extent <= 0.0 {
            return Err("Invalid model resource extent");
        }
        if self.ops.is_empty() {
            return Err("Empty model resource ops");
        }
        Ok(())
    }

    /// 转为渲染用的 `ModelSnapshot`（placement 由节点引用逐帧提供）。
    pub(crate) fn into_snapshot(self) -> ModelSnapshot {
        ModelSnapshot {
            scene_version: self.scene_version,
            ops: self.ops,
            geometry_keys: None,
            prepared_bounds: None,
            signature: self.signature,
            extent: self.extent,
            aabb: self.aabb,
            placement: ModelPlacement::default(),
        }
    }
}

#[derive(Clone, Default, Deserialize)]
pub(crate) struct ModelSnapshot {
    /// Scene IR 版本（V1 或 V2）；显式携带以便选择渲染语义（change: enhance-model-...）。
    #[serde(default, rename = "sceneVersion")]
    #[allow(dead_code)] // 跨目标字段：native renderer 预览路径读取；wasm 侧按 prepared 结果渲染。
    pub(crate) scene_version: Option<String>,
    pub(crate) ops: Vec<ModelOp>,
    /// Renderer-only identities prepared once per immutable content; never accepted from the wire.
    #[serde(skip)]
    pub(crate) geometry_keys: Option<std::sync::Arc<Vec<Option<String>>>>,
    #[serde(skip)]
    pub(crate) prepared_bounds: Option<std::sync::Arc<crate::model3d::scene::PreparedBounds>>,
    #[serde(default)]
    pub(crate) signature: String,
    #[serde(default = "default_extent")]
    pub(crate) extent: f32,
    /// prepared 阶段保留的局部 AABB（change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm）：
    /// 布局、聚焦与 picking 复用同一结果，不在 viewport/hover/selection/placement 变化时重遍历 mesh。
    #[serde(default)]
    pub(crate) aabb: Option<ModelAabbDto>,
    #[serde(default)]
    #[allow(dead_code)] // 跨目标字段：native renderer 预览路径读取；wasm 侧 placement 由节点引用逐帧提供。
    pub(crate) placement: ModelPlacement,
}

// `ModelSnapshot` 是纯构建逻辑（scene/preview）共享的入参：可由资源表或原生 renderer
// 请求构造。为避免构造点遗漏字段，提供带 placement 的 helper。
impl ModelSnapshot {
    /// 由 Scene IR 与 placement 构造（prepared resource 解析 / 原生 renderer 共用）。
    #[allow(dead_code)]
    pub(crate) fn new(
        scene_version: Option<String>,
        ops: Vec<ModelOp>,
        signature: String,
        extent: f32,
        placement: ModelPlacement,
    ) -> Self {
        Self {
            scene_version,
            ops,
            geometry_keys: None,
            prepared_bounds: None,
            signature,
            extent,
            aabb: None,
            placement,
        }
    }

    /// 设置已派生的局部 AABB（prepared/register 边界；builder pattern）。
    pub(crate) fn with_aabb(mut self, aabb: Option<ModelAabbDto>) -> Self {
        self.aabb = aabb;
        self
    }
}

pub(crate) const MODEL_SCENE_IR_V2: &str = "woohaa-model-scene-ir-v2";

/// 唯一受支持的 Scene IR 版本（change: 2026-10-07-remove-residual-compatibility）。
pub(crate) fn is_supported_scene_ir_version(version: &str) -> bool {
    version == MODEL_SCENE_IR_V2
}

fn default_extent() -> f32 {
    1.0
}

/// FNV-1a 64-bit（16 位小写 hex），按 **JavaScript UTF-16 code unit** 逐字符计算
/// （change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm，任务 6.2 / design D6）。
///
/// 与 `web/contracts/src/canvas/content-hash.ts` 的 `fnv1a64Hex` 逐字节一致：非 ASCII 字符
/// （含 surrogate pair）必须按其 UTF-16 码元异或，而不是 UTF-8 字节，否则 resource key 漂移。
pub(crate) fn fnv1a64_utf16(text: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for unit in text.encode_utf16() {
        hash ^= u64::from(unit);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// 兼容的内容 signature：`sceneVersion + ":" + opsJson` 的 FNV-1a UTF-16 指纹。
///
/// `ops_json` 必须是 validator 规范化输出的**逐字节** JSON（Frontend 已生成），因此 Rust 不
/// 重新序列化 ops（字段顺序/默认值/浮点格式会漂移），只对同一规范字符串取指纹。
pub(crate) fn canonical_signature(scene_version: &str, ops_json: &str) -> String {
    fnv1a64_utf16(&format!("{scene_version}:{ops_json}"))
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub(crate) struct ModelPlacement {
    #[serde(default)]
    pub(crate) offset: ModelOffset,
    #[serde(default = "default_model_scale")]
    pub(crate) scale: f32,
    #[serde(default)]
    pub(crate) yaw: f32,
}

fn default_model_scale() -> f32 {
    1.0
}

impl Default for ModelPlacement {
    fn default() -> Self {
        Self {
            offset: ModelOffset::default(),
            scale: default_model_scale(),
            yaw: 0.0,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Default, Deserialize)]
pub(crate) struct ModelOffset {
    #[serde(default)]
    pub(crate) x: f32,
    #[serde(default)]
    pub(crate) y: f32,
    #[serde(default)]
    pub(crate) z: f32,
}

#[derive(Clone, Debug, Deserialize, serde::Serialize)]
#[serde(tag = "t", rename_all = "lowercase")]
pub(crate) enum ModelOp {
    /// V2 受控 PBR 材质声明（无 transform）。V1 不会出现。
    Material {
        id: String,
        #[serde(default = "default_base_color", rename = "baseColor")]
        base_color: String,
        #[serde(default = "default_roughness")]
        roughness: f32,
        #[serde(default)]
        metallic: f32,
        #[serde(default = "default_black")]
        emissive: String,
        #[serde(default, rename = "emissiveStrength")]
        emissive_strength: f32,
        #[serde(default = "default_alpha_mode", rename = "alphaMode")]
        alpha_mode: String,
        #[serde(default, rename = "doubleSided")]
        double_sided: bool,
        /// 不受光照，呈平面色（change: 2026-10-19-extend-film-set-for-motion-graphics，D4）。
        #[serde(default)]
        unlit: bool,
        /// blend 模式下的静态透明度（0..=1）；缺失按 [`DEFAULT_BLEND_OPACITY`]。
        #[serde(default)]
        opacity: Option<f32>,
    },
    Group {
        id: String,
        parent: Option<String>,
        #[serde(default)]
        position: [f32; 3],
        #[serde(default)]
        rotation: [f32; 3],
        #[serde(default = "default_model_vector_scale")]
        scale: [f32; 3],
    },
    Box {
        id: String,
        parent: Option<String>,
        #[serde(default)]
        position: [f32; 3],
        #[serde(default)]
        rotation: [f32; 3],
        #[serde(default = "default_model_vector_scale")]
        scale: [f32; 3],
        /// V1 必填；V2 在引用 material 时为 null。两者都兼容。
        #[serde(default)]
        color: Option<String>,
        #[serde(default)]
        material: Option<String>,
        size: [f32; 3],
    },
    Cylinder {
        id: String,
        parent: Option<String>,
        #[serde(default)]
        position: [f32; 3],
        #[serde(default)]
        rotation: [f32; 3],
        #[serde(default = "default_model_vector_scale")]
        scale: [f32; 3],
        #[serde(default)]
        color: Option<String>,
        #[serde(default)]
        material: Option<String>,
        radius: f32,
        height: f32,
    },
    Mesh {
        id: String,
        parent: Option<String>,
        #[serde(default)]
        position: [f32; 3],
        #[serde(default)]
        rotation: [f32; 3],
        #[serde(default = "default_model_vector_scale")]
        scale: [f32; 3],
        #[serde(default)]
        color: Option<String>,
        #[serde(default)]
        material: Option<String>,
        vertices: Vec<[f32; 3]>,
        faces: Vec<[u32; 3]>,
    },
    /// V2 原生球体 primitive（quality 档由运行时固定）。
    Sphere {
        id: String,
        parent: Option<String>,
        #[serde(default)]
        position: [f32; 3],
        #[serde(default)]
        rotation: [f32; 3],
        #[serde(default = "default_model_vector_scale")]
        scale: [f32; 3],
        #[serde(default)]
        color: Option<String>,
        #[serde(default)]
        material: Option<String>,
        radius: f32,
    },
    /// V2 原生胶囊 primitive：`height` 为含半球的总高度。
    Capsule {
        id: String,
        parent: Option<String>,
        #[serde(default)]
        position: [f32; 3],
        #[serde(default)]
        rotation: [f32; 3],
        #[serde(default = "default_model_vector_scale")]
        scale: [f32; 3],
        #[serde(default)]
        color: Option<String>,
        #[serde(default)]
        material: Option<String>,
        radius: f32,
        height: f32,
    },
    /// V2 端点式部件：from/to 是 parent 局部空间中心线端点。
    Segment {
        id: String,
        parent: Option<String>,
        #[serde(default)]
        position: [f32; 3],
        #[serde(default)]
        rotation: [f32; 3],
        #[serde(default = "default_model_vector_scale")]
        scale: [f32; 3],
        #[serde(default)]
        color: Option<String>,
        #[serde(default)]
        material: Option<String>,
        from: [f32; 3],
        to: [f32; 3],
        width: f32,
        #[serde(default)]
        depth: Option<f32>,
        #[serde(default = "default_segment_shape")]
        shape: String,
        #[serde(default)]
        overlap: f32,
    },
    Oscillate {
        id: String,
        #[serde(default)]
        axis: String,
        #[serde(default)]
        speed: f32,
        #[serde(default)]
        mode: String,
        #[serde(default)]
        amplitude: f32,
        #[serde(default)]
        phase: f32,
    },
    Move {
        id: String,
        #[serde(default)]
        axis: String,
        #[serde(default)]
        speed: f32,
        range: [f32; 2],
    },
    Rotate {
        id: String,
        #[serde(default)]
        axis: String,
        #[serde(default)]
        speed: f32,
    },
}

fn default_model_vector_scale() -> [f32; 3] {
    [1.0, 1.0, 1.0]
}

fn default_base_color() -> String {
    "#ffffff".to_owned()
}

fn default_black() -> String {
    "#000000".to_owned()
}

fn default_roughness() -> f32 {
    0.5
}

fn default_alpha_mode() -> String {
    "opaque".to_owned()
}

/// blend 模式下未声明 `opacity` 时的静态透明度（与改动前写死的 0.6 一致）。
pub(crate) const DEFAULT_BLEND_OPACITY: f32 = 0.6;

fn default_segment_shape() -> String {
    "capsule".to_owned()
}

#[cfg(test)]
mod signature_tests {
    use super::*;

    /// 与 contracts 的 `fnv1a64Hex` golden 逐字节一致（ASCII、BMP、surrogate pair）。
    #[test]
    fn fnv1a64_matches_javascript_utf16() {
        assert_eq!(fnv1a64_utf16(""), "cbf29ce484222325");
        // 中文（BMP）与 emoji（surrogate pair）必须按 UTF-16 code unit 计算。
        assert_eq!(fnv1a64_utf16("中文:😀"), "d92c6886f040b9e8");
        assert_eq!(fnv1a64_utf16("abc"), "e71fa2190541574b");
    }

    /// prepared signature 对规范化 ops JSON 取指纹，保持与迁移前 resource key 兼容。
    #[test]
    fn canonical_signature_is_stable_for_normalized_ops() {
        let ops = r##"[{"t":"group","id":"root","parent":null,"position":[0,0,0],"rotation":[0,0,0],"scale":[1,1,1],"material":null,"color":"#cccccc"},{"t":"sphere","id":"s","parent":"root","position":[1,2,3],"rotation":[0,0,0],"scale":[1,1,1],"material":null,"color":"#ffffff","radius":2},{"t":"box","id":"b","parent":"root","position":[0,0,0],"rotation":[0,0,0],"scale":[1,1,1],"material":null,"color":"#ff0000","size":[1,2,3]}]"##;
        assert_eq!(
            canonical_signature("woohaa-model-scene-ir-v2", ops),
            "db83340ea472618b"
        );
    }
}
