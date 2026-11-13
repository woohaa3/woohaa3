//! Scene IR 模型 DTO：V1/V2 部件 op、模型快照与 placement
//! （change: refactor-bevy-rust-file-size，任务 2.1 / design D3）。

use serde::Deserialize;

/// 当前画布快照协议版本；与 contracts `CANVAS_RENDER_SCENE_VERSION` 一致。
/// v25 起模型改为「descriptor 声明」与「重型 payload 驻留」两阶段确认：场景只保护轻量
/// descriptor 身份，payload 按实际需求 lease 并在预算内淘汰
/// （change: 2026-10-23-scale-canvas-media-residency，design D5）。旧 renderer 会把
/// descriptor-only 引用当成未知资源拒绝，因此必须同步提升能力版本。
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
/// v23 起复合资产可携带派生 ownershipLinks；旧 renderer 不支持管理关系虚线。
/// v24 起镜头预览携带独立 backdrop，preview/capture 共用背景，拒绝忽略该字段的旧 renderer。
/// v27 adds node capability-driven rendering paths.
/// v28 adds the optional, strictly decoded overview-only empty placeholder.
/// v29 unifies group and film-set authoring: group presentations carry a badge scale,
/// model bounds and per-object ownership link item sources; media content keeps a
/// provider identity and schema version.
/// v32 adds the optional transparent overview cache declaration.
/// v33 carries the document identity (`canvasId`); the revision baseline resets per document.
/// v34 drops the group badge scale/resizable flags: the badge is the group model itself at the
/// shared canvas model unit, so an older renderer would draw a fixed badge frame.
/// v35 removes ordinary groups and the film-set feature: no `group`/`compositeAsset`/
/// `aggregateRun`/`shotPreview` node presentations, no `filmSetGroups`/`shotPreviewLinks`
/// scene collections and no per-object playback; composite-asset nodes render as plain cards.
/// v41 adds transient assistant execution IDs for scope-border feedback.
/// v42 adds derived `cameraShot` semantics to world-camera cards (video duration/status).
pub(crate) const CANVAS_RENDER_SCENE_VERSION: &str = "woohaa-canvas-render-scene-v43";
/// prepared model resource envelope 版本。
pub(crate) const MODEL_ASSET_VERSION: &str = "woohaa-prepared-model-resource-v1";
/// 轻量 descriptor envelope 版本（与 payload envelope 分开，二者可独立演进）。
pub(crate) const MODEL_DESCRIPTOR_VERSION: &str = "woohaa-model-descriptor-v1";

/// 轻量模型 descriptor：身份 + 必要几何声明，**不含** ops/mesh。
///
/// 场景引用只保护本结构（design D5）。确认它表示「身份合法、布局/查询可用」，
/// 不表示重型 payload 已驻留或模型可渲染。
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ModelDescriptor {
    pub(crate) resource_version: String,
    pub(crate) resource_key: String,
    pub(crate) scene_version: Option<String>,
    pub(crate) signature: String,
    pub(crate) extent: f32,
    pub(crate) aabb: Option<ModelAabbDto>,
}

impl ModelDescriptor {
    /// 是否与另一份声明描述同一内容身份（key/signature/sceneVersion 一致）。
    ///
    /// **extent/AABB 不参与身份判定**：它们是同一内容的派生结果，而派生有两条独立路径
    /// ——前端 `v2SceneAabb`（f64）与 Rust `prepare_snapshot`（f32）。同一份 IR 在两条路径上
    /// 的末位必然不同，若把派生值当身份，合法模型会被误判成「同 key 不同内容」而整片拒绝
    /// （2026-10-24 实际故障：22 个模型有 15 个报 `Model resource key conflict`）。
    ///
    /// 真冲突仍由两处稳定拒绝：`ModelDescriptorDto::validate` 的 key/signature 一致性，
    /// 以及 `queue_model_snapshot` 的 signature/sceneVersion 比较。
    pub(crate) fn same_identity(&self, other: &Self) -> bool {
        self.resource_key == other.resource_key
            && self.signature == other.signature
            && self.scene_version == other.scene_version
    }
}

/// 声明 wire DTO：`declare_model_descriptor` 的输入。
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelDescriptorDto {
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
}

impl ModelDescriptorDto {
    /// 边界级防御校验：版本、场景版本（V2-only）、key/签名一致、有限 extent。
    ///
    /// 与 payload 注册同一套身份校验，避免「声明轻松通过、注册才冲突」的漂移。
    pub(crate) fn validate(&self) -> Result<ModelDescriptor, &'static str> {
        if self.resource_version != MODEL_DESCRIPTOR_VERSION {
            return Err("Unknown model descriptor version");
        }
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
        if let Some(aabb) = &self.aabb
            && !aabb
                .min
                .iter()
                .chain(aabb.max.iter())
                .all(|v| v.is_finite())
        {
            return Err("Invalid model resource bounds");
        }
        Ok(ModelDescriptor {
            resource_version: self.resource_version.clone(),
            resource_key: self.resource_key.clone(),
            scene_version: self.scene_version.clone(),
            signature: self.signature.clone(),
            extent: self.extent,
            aabb: self.aabb,
        })
    }
}

/// 节点上的轻量模型引用：只含稳定 resource key 与动态 placement。
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelReference {
    #[serde(default)]
    pub(crate) ground_anchor_local: Option<[f32; 3]>,
    /// Scene IR 版本（V1 或 V2）。
    #[serde(default)]
    #[allow(dead_code)]
    // 线格式字段：由 contracts 下发，渲染按 resource_key 解析；保留以对齐协议。
    pub(crate) scene_version: Option<String>,
    /// 按内容签名注册的资源 key；不含节点 id。
    pub(crate) resource_key: String,
    /// 模型内容签名；world transform/viewport 变化时不变。
    #[serde(default)]
    pub(crate) signature: String,
    /// Per-instance additive local joint rotations; presence preserves the hierarchy.
    #[serde(default, deserialize_with = "deserialize_part_rotations")]
    pub(crate) part_rotations: Option<std::collections::HashMap<String, [f32; 4]>>,
    #[serde(default, deserialize_with = "deserialize_part_positions")]
    pub(crate) part_positions: Option<std::collections::HashMap<String, [f32; 3]>>,
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
    #[allow(dead_code)]
    // 跨目标字段：native renderer 预览路径读取；wasm 侧按 prepared 结果渲染。
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
    #[allow(dead_code)]
    // 跨目标字段：native renderer 预览路径读取；wasm 侧 placement 由节点引用逐帧提供。
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
        /// GLB 文件模型的内嵌 baseColor 纹理 id（change: 2026-10-28-support-glb-model-nodes）。
        ///
        /// 纹理本身经独立的模型纹理通道上传并按 id 解析；缺失时保持纯色。
        #[serde(default, rename = "baseColorTexture")]
        base_color_texture: Option<String>,
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
        /// 可选顶点属性（GLB 文件模型）；长度必须与 `vertices` 一致，否则整条 op 被拒绝。
        #[serde(default)]
        normals: Option<Vec<[f32; 3]>>,
        #[serde(default)]
        uvs: Option<Vec<[f32; 2]>>,
        #[serde(default)]
        colors: Option<Vec<[f32; 4]>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        skin: Option<ModelSkin>,
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

fn deserialize_part_rotations<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<std::collections::HashMap<String, [f32; 4]>>, D::Error> {
    let value = Option::<std::collections::HashMap<String, [f32; 4]>>::deserialize(deserializer)?;
    if let Some(poses) = &value {
        if poses.len() > 4096 || poses.iter().any(|(id, q)| id.is_empty() || id.len() > 256 || q.iter().any(|v| !v.is_finite()) || (q.iter().map(|v| v * v).sum::<f32>() - 1.0).abs() > 0.001) {
            return Err(serde::de::Error::custom("Invalid model part rotations"));
        }
    }
    Ok(value)
}

#[cfg(test)]
mod part_rotation_tests {
    use super::*;
    #[test]
    fn part_rotations_reject_non_unit_and_unbounded_wire() {
        assert!(serde_json::from_str::<ModelReference>(r#"{"resourceKey":"m","partRotations":{"joint":[0,0,0,0]}}"#).is_err());
        assert!(serde_json::from_str::<ModelReference>(r#"{"resourceKey":"m","partRotations":{"joint":[1e50,0,0,1]}}"#).is_err());
        assert!(serde_json::from_str::<ModelReference>(r#"{"resourceKey":"m","partRotations":{"joint":[0,0,0,1]}}"#).is_ok());
        assert!(serde_json::from_str::<ModelReference>(r#"{"resourceKey":"m"}"#).unwrap().part_rotations.is_none());
        let map: std::collections::HashMap<_, _> = (0..4097).map(|i| (i.to_string(), [0.,0.,0.,1.])).collect();
        assert!(serde_json::from_value::<ModelReference>(serde_json::json!({"resourceKey":"m","partRotations":map})).is_err());
    }
}

fn deserialize_part_positions<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<std::collections::HashMap<String, [f32; 3]>>, D::Error> {
    let value = Option::<std::collections::HashMap<String, [f32; 3]>>::deserialize(deserializer)?;
    if let Some(poses) = &value {
        if poses.len() > 4096 || poses.iter().any(|(id, p)| id.is_empty() || id.len() > 256 || p.iter().any(|v| !v.is_finite() || v.abs() > 10000.0)) {
            return Err(serde::de::Error::custom("Invalid model part positions"));
        }
    }
    Ok(value)
}

#[cfg(test)]
mod part_position_tests {
    use super::*;
    #[test]
    fn reject_unbounded_part_positions() {
        assert!(serde_json::from_str::<ModelReference>(r#"{"resourceKey":"m","partPositions":{"hips":[0,0.2,0]}}"#).is_ok());
        assert!(serde_json::from_str::<ModelReference>(r#"{"resourceKey":"m","partPositions":{"hips":[0,10001,0]}}"#).is_err());
        assert!(serde_json::from_str::<ModelReference>(r#"{"resourceKey":"m","partPositions":{"hips":[0,1e50,0]}}"#).is_err());
    }
}

/// Column-major inverse bind matrices; all eight influences are authoritative.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelSkin {
 pub joint_ids: Vec<String>,
 pub inverse_bind_matrices: Vec<[f32;16]>,
 pub indices: Vec<[usize;8]>,
 pub weights: Vec<[f32;8]>,
}
