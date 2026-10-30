use serde::Deserialize;

/// 动画节点播放瞬时投影（change: 2026-10-05-bind-model-animation-to-shots，任务 4.1）。
///
/// 只承载**活动动画节点**的本地时钟与运动 IR：Bevy 据此为该节点独立求值模型姿态与镜头，
/// 与 `modelFocus`/`modelEditor` 同一约定——浏览器本地呈现态，不进入 ServerCanvas / Y.Doc。
/// 缺失即无活动动画节点。`version` 为 Motion IR 版本；未知版本稳定拒绝该投影。
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AnimationPlayback {
    #[serde(default)]
    #[allow(dead_code)]
    pub(crate) clip_id: String,
    #[serde(default)]
    #[allow(dead_code)]
    pub(crate) source_identity: String,
    #[serde(default)]
    #[allow(dead_code)]
    pub(crate) generation: u32,
    #[serde(default)]
    pub(crate) view_mode: String,
    /// `shot-node-preview` 模式的目标预览卡片 canonical 节点 id
    /// （change: 2026-10-15-add-film-set-shooting-shot-previews，design D6）。
    /// 缺失即无指定卡片。
    #[serde(default, rename = "targetPreviewNodeId")]
    pub(crate) target_preview_node_id: Option<String>,

    /// 活动动画节点 canonical id。
    pub(crate) node_id: String,
    /// Motion IR 版本（缺失时按未知处理，不应用）。
    #[serde(default)]
    pub(crate) version: String,
    /// 当前时间（秒）。
    #[serde(default)]
    pub(crate) time: f32,
    /// 时间线时长（秒）。
    #[serde(default)]
    pub(crate) duration: f32,
    /// 是否循环。
    #[serde(default)]
    #[allow(dead_code)]
    // 线格式字段：随 scene 下发；循环语义由 playback 时钟消费，Rust 侧暂不读取。
    pub(crate) looped: bool,
    /// 所播放镜头背景的具体色（`#rrggbb`）；缺省即跟随主题（change: 2026-10-19，D6）。
    #[serde(default)]
    pub(crate) backdrop: Option<String>,
    /// 是否正在播放（false 表示已暂停在 `time`）。
    #[serde(default)]
    pub(crate) playing: bool,
    /// 初始镜头（第 0 秒）。
    pub(crate) initial_camera: PlaybackCamera,
    #[serde(default)]
    pub(crate) camera_motion: Vec<crate::motion::RawCameraTrack>,
    #[serde(default)]
    pub(crate) model_motion: Vec<crate::motion::RawModelTrack>,
    /// 受管条目 child 运动（change: 2026-10-09-add-film-set-object-motion-and-editing；
    ///  change: 2026-10-28-generic-extension-content-ownership 任务 4.3 通用化）。
    /// 按 owner 统一播放头 `time` 映射条目局部时间后求值；目标为组合作用域编码 id。
    #[serde(default)]
    pub(crate) managed_item_motion: Vec<crate::protocol::ManagedItemMotion>,
}

/// 动画节点的初始镜头（与 `motion::InitialCameraState` 同构）。
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlaybackCamera {
    #[serde(default = "default_playback_aspect")]
    pub(crate) aspect: String,
    #[serde(default)]
    pub(crate) azimuth: f32,
    #[serde(default = "default_playback_elevation")]
    pub(crate) elevation: f32,
    #[serde(default = "default_playback_distance")]
    pub(crate) distance: f32,
    #[serde(default)]
    pub(crate) focus_offset: [f32; 3],
}

fn default_playback_aspect() -> String {
    "16:9".to_owned()
}

fn default_playback_elevation() -> f32 {
    crate::isometric_grid::CANVAS_CAMERA_PITCH
}

fn default_playback_distance() -> f32 {
    8.0
}

impl AnimationPlayback {
    /// 边界级防御校验：节点 id、版本、有限时间/时长、初始镜头数值。
    ///
    /// 当前 `Scene::validate` 未串联本校验（动画瞬时投影由宿主投影保证）；保留供后续收紧边界。
    #[allow(dead_code)]
    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        if self.node_id.is_empty() || self.node_id.len() > 256 {
            return Err("Invalid animation node id");
        }
        if self.version.is_empty() {
            return Err("Missing motion ir version");
        }
        if !self.time.is_finite() || !self.duration.is_finite() || self.duration < 0.0 {
            return Err("Invalid animation time");
        }
        let camera = &self.initial_camera;
        if ![camera.azimuth, camera.elevation, camera.distance]
            .iter()
            .chain(camera.focus_offset.iter())
            .all(|value| value.is_finite())
            || camera.distance <= 0.0
        {
            return Err("Invalid initial camera");
        }
        Ok(())
    }

    /// 初始镜头状态（供 `motion::evaluate`）；经 `motion` 的数组构造 helper，保持 protocol
    /// 不依赖 Bevy 数学类型。
    pub(crate) fn initial_camera_state(&self) -> crate::motion::InitialCameraState {
        crate::motion::camera_state_from_arrays(
            self.initial_camera.azimuth,
            self.initial_camera.elevation,
            self.initial_camera.distance,
            self.initial_camera.focus_offset,
        )
    }
}
