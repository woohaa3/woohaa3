//! 录制帧屏障状态机
//! （change: 2026-10-17-add-native-offscreen-film-set-recording，任务 3.4 / design D4）。
//!
//! 每一帧必须按顺序取得**本帧身份匹配**的确认，才能进入下一步：
//!
//! ```text
//! Applied（场景/相机/运动已应用）
//!   → MediaReady（所有媒体帧已 decode + upload）
//!   → PipelineReady（模型/材质管线就绪）
//!   → Rendered（真实离屏 pass 完成）
//!   → Readback（像素已映射回主机）
//! ```
//!
//! 关键不变量：
//! - 所有确认都携带完整 [`FrameIdentity`]；旧 attempt / 旧 snapshot / 旧 frameIndex / 旧
//!   sampleTime / 旧 camera generation / 缺失媒体 的确认一律拒绝，**不推进**本帧；
//! - 暂停（交互让路）期间计时冻结：用户操作不应把后台录制判成超时；
//! - 超时报告真实阶段，而不是统一的 "timeout"；
//! - device loss 立即失败并区分阶段。
//!
//! 纯状态机：不含 Bevy/GPU 依赖，任何 feature 下可编译，可用注入时钟单测。
//! `sleep`/`tick` 数量**不能**替代这里的确认（design D4 明确禁止）。

use crate::recording_timeline::Rational;

/// 帧身份：屏障只认这一个身份。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FrameIdentity {
    pub job_id: String,
    pub attempt_id: String,
    /// 执行代际；执行器重启或 device loss 后递增。
    pub execution_epoch: u64,
    pub snapshot_hash: String,
    pub frame_index: u32,
    /// 采样时刻（有理数，避免浮点相等比较）。
    pub sample: Rational,
    /// 相机 rig generation；静态镜头不会递增，因此**不能**只靠它判定新帧。
    pub camera_generation: u64,
    /// 本帧引用的媒体身份（resourceId@pts），缺一不可。
    pub media_identities: Vec<String>,
}

impl FrameIdentity {
    /// 与另一份身份是否指向同一帧（媒体清单也纳入比较）。
    pub fn matches(&self, other: &FrameIdentity) -> bool {
        self.job_id == other.job_id
            && self.attempt_id == other.attempt_id
            && self.execution_epoch == other.execution_epoch
            && self.snapshot_hash == other.snapshot_hash
            && self.frame_index == other.frame_index
            && self.sample.eq_value(other.sample)
            && self.camera_generation == other.camera_generation
            && self.media_identities == other.media_identities
    }
}

/// 屏障阶段（顺序即推进顺序）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum BarrierStage {
    /// 场景/相机/运动已按 T 应用。
    Applied,
    /// 所有媒体帧已解码并上传纹理。
    MediaReady,
    /// 模型/材质管线就绪（无等待编译的 pipeline、所需 RenderAssets 在场）。
    PipelineReady,
    /// 真实离屏 pass 已绘制本帧。
    Rendered,
    /// 像素已映射回主机。
    Readback,
}

impl BarrierStage {
    /// 失败时上报的稳定阶段名（与 proto `RecordingErrorStage` 的对应关系见 `stage_code`）。
    pub fn code(self) -> &'static str {
        match self {
            Self::Applied => "scene-applied",
            Self::MediaReady => "media-ready",
            Self::PipelineReady => "pipeline-ready",
            Self::Rendered => "offscreen-rendered",
            Self::Readback => "readback",
        }
    }

    /// 该阶段等待超时时的错误码。
    pub fn timeout_code(self) -> &'static str {
        match self {
            Self::Applied => "recording-scene-not-applied",
            Self::MediaReady => "recording-media-not-ready",
            Self::PipelineReady => "recording-pipeline-not-ready",
            Self::Rendered => "capture-readiness-timeout",
            Self::Readback => "recording-readback-timeout",
        }
    }

    /// 下一个阶段；Readback 之后没有阶段。
    pub fn next(self) -> Option<Self> {
        match self {
            Self::Applied => Some(Self::MediaReady),
            Self::MediaReady => Some(Self::PipelineReady),
            Self::PipelineReady => Some(Self::Rendered),
            Self::Rendered => Some(Self::Readback),
            Self::Readback => None,
        }
    }
}

/// 屏障失败。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BarrierFailure {
    /// 阶段超时，附真实阶段与已耗时。
    Timeout { stage: BarrierStage, waited_ms: u64 },
    /// 身份不匹配（旧 ACK / 另一 attempt / 缺失媒体）。
    StaleAck { stage: BarrierStage, reason: String },
    /// 缺少媒体帧；`missing` 精确到 resource 身份。
    MissingMedia { missing: Vec<String> },
    /// GPU device loss。
    DeviceLost { stage: BarrierStage },
    /// 用户/宿主取消。
    Cancelled { stage: BarrierStage },
}

impl BarrierFailure {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Timeout { stage, .. } => stage.timeout_code(),
            Self::StaleAck { .. } => "recording-stale-frame-ack",
            Self::MissingMedia { .. } => "recording-media-missing",
            Self::DeviceLost { .. } => "recording-device-lost",
            Self::Cancelled { .. } => "recording-cancelled",
        }
    }

    /// 是否是瞬态失败（参考录制可退避重试；取消/身份不符/缺媒体不是）。
    pub fn transient(&self) -> bool {
        matches!(self, Self::Timeout { .. } | Self::DeviceLost { .. })
    }

    /// 失败阶段；缺失媒体归到 `MediaReady`。
    pub fn stage(&self) -> BarrierStage {
        match self {
            Self::Timeout { stage, .. }
            | Self::StaleAck { stage, .. }
            | Self::DeviceLost { stage }
            | Self::Cancelled { stage } => *stage,
            Self::MissingMedia { .. } => BarrierStage::MediaReady,
        }
    }
}

/// 各阶段的活动耗时预算（毫秒）。暂停期间不计入。
#[derive(Clone, Copy, Debug)]
pub struct BarrierBudget {
    pub applied_ms: u64,
    pub media_ms: u64,
    pub pipeline_ms: u64,
    pub rendered_ms: u64,
    pub readback_ms: u64,
}

impl Default for BarrierBudget {
    /// 默认值刻意保守：真实机器上按 fixture 标定后调整，不以放宽超时掩盖屏障不匹配。
    fn default() -> Self {
        Self {
            applied_ms: 2_000,
            media_ms: 15_000,
            pipeline_ms: 20_000,
            rendered_ms: 5_000,
            readback_ms: 10_000,
        }
    }
}

impl BarrierBudget {
    pub fn for_stage(&self, stage: BarrierStage) -> u64 {
        match stage {
            BarrierStage::Applied => self.applied_ms,
            BarrierStage::MediaReady => self.media_ms,
            BarrierStage::PipelineReady => self.pipeline_ms,
            BarrierStage::Rendered => self.rendered_ms,
            BarrierStage::Readback => self.readback_ms,
        }
    }
}

/// 单帧屏障。
#[derive(Clone, Debug)]
pub struct FrameBarrier {
    identity: FrameIdentity,
    stage: BarrierStage,
    budget: BarrierBudget,
    /// 当前阶段已消耗的**活动**毫秒（暂停不累加）。
    elapsed_ms: u64,
    paused: bool,
    required_media: Vec<String>,
    acknowledged_media: Vec<String>,
    finished: bool,
}

impl FrameBarrier {
    /// 开始等待一帧。
    ///
    /// `required_media` 来自冻结快照：全部到位才能通过 `MediaReady`。
    pub fn begin(identity: FrameIdentity, budget: BarrierBudget) -> Self {
        let required_media = identity.media_identities.clone();
        Self {
            identity,
            stage: BarrierStage::Applied,
            budget,
            elapsed_ms: 0,
            paused: false,
            required_media,
            acknowledged_media: Vec::new(),
            finished: false,
        }
    }

    pub fn identity(&self) -> &FrameIdentity {
        &self.identity
    }

    pub fn stage(&self) -> BarrierStage {
        self.stage
    }

    pub fn paused(&self) -> bool {
        self.paused
    }

    pub fn elapsed_ms(&self) -> u64 {
        self.elapsed_ms
    }

    /// 暂停：交互让路时调用。暂停期间 `advance` 不累计耗时。
    pub fn pause(&mut self) {
        self.paused = true;
    }

    /// 恢复：后续耗时继续计入当前阶段。
    pub fn resume(&mut self) {
        self.paused = false;
    }

    /// 推进时钟。`paused` 时不累计，返回当前阶段是否已超时。
    ///
    /// 注意：这只是**预算**推进，不代表任何阶段已经就绪。
    pub fn tick(&mut self, delta_ms: u64) -> Option<BarrierFailure> {
        if self.finished || self.paused {
            return None;
        }
        self.elapsed_ms = self.elapsed_ms.saturating_add(delta_ms);
        if self.elapsed_ms > self.budget.for_stage(self.stage) {
            self.finished = true;
            return Some(BarrierFailure::Timeout {
                stage: self.stage,
                waited_ms: self.elapsed_ms,
            });
        }
        None
    }

    /// 收到 `Applied` 确认。身份不匹配只丢弃，不推进。
    pub fn acknowledge_applied(&mut self, identity: &FrameIdentity) -> Result<(), BarrierFailure> {
        self.acknowledge(identity, BarrierStage::Applied)
    }

    /// 收到某媒体的 decode+upload 确认；**全部**媒体到位才推进到 `PipelineReady`。
    ///
    /// 返回 `MissingMedia` 时确认已被记录（不是失败丢弃），调用方应继续等待剩余媒体。
    pub fn acknowledge_media(
        &mut self,
        identity: &FrameIdentity,
        media_identity: &str,
    ) -> Result<(), BarrierFailure> {
        // 只校验身份与阶段，不在这里推进：媒体可能分多次到达。
        self.validate(identity, BarrierStage::MediaReady)?;
        if !self
            .required_media
            .iter()
            .any(|required| required == media_identity)
        {
            return Err(BarrierFailure::StaleAck {
                stage: BarrierStage::MediaReady,
                reason: format!("确认了快照未声明的媒体：{media_identity}"),
            });
        }
        if !self
            .acknowledged_media
            .iter()
            .any(|seen| seen == media_identity)
        {
            self.acknowledged_media.push(media_identity.to_owned());
        }
        let missing: Vec<String> = self
            .required_media
            .iter()
            .filter(|required| !self.acknowledged_media.iter().any(|seen| seen == *required))
            .cloned()
            .collect();
        if !missing.is_empty() {
            return Err(BarrierFailure::MissingMedia { missing });
        }
        self.advance()
    }

    /// 收到管线就绪确认。
    pub fn acknowledge_pipeline(&mut self, identity: &FrameIdentity) -> Result<(), BarrierFailure> {
        self.acknowledge(identity, BarrierStage::PipelineReady)
    }

    /// 收到真实离屏绘制完成确认。
    pub fn acknowledge_rendered(&mut self, identity: &FrameIdentity) -> Result<(), BarrierFailure> {
        self.acknowledge(identity, BarrierStage::Rendered)
    }

    /// 收到回读完成确认：整帧完成。
    pub fn acknowledge_readback(&mut self, identity: &FrameIdentity) -> Result<(), BarrierFailure> {
        self.acknowledge(identity, BarrierStage::Readback)?;
        self.finished = true;
        Ok(())
    }

    /// 是否整帧完成（可交付编码）。
    pub fn is_complete(&self) -> bool {
        self.finished && self.stage == BarrierStage::Readback
    }

    /// device loss：立即失败并保留阶段。
    pub fn device_lost(&mut self) -> BarrierFailure {
        self.finished = true;
        BarrierFailure::DeviceLost { stage: self.stage }
    }

    /// 取消：立即失败并保留阶段。
    pub fn cancel(&mut self) -> BarrierFailure {
        self.finished = true;
        BarrierFailure::Cancelled { stage: self.stage }
    }

    fn acknowledge(
        &mut self,
        identity: &FrameIdentity,
        stage: BarrierStage,
    ) -> Result<(), BarrierFailure> {
        self.validate(identity, stage)?;
        self.advance()
    }

    /// 身份与阶段校验；不推进。媒体确认可能分多次到达，需要单独校验后自行推进。
    fn validate(
        &self,
        identity: &FrameIdentity,
        stage: BarrierStage,
    ) -> Result<(), BarrierFailure> {
        if self.finished {
            return Err(BarrierFailure::StaleAck {
                stage: self.stage,
                reason: "屏障已终结".to_owned(),
            });
        }
        if !self.identity.matches(identity) {
            return Err(BarrierFailure::StaleAck {
                stage: self.stage,
                reason: format!(
                    "帧身份不匹配：当前 {}#{}，确认 {}#{}",
                    self.identity.attempt_id,
                    self.identity.frame_index,
                    identity.attempt_id,
                    identity.frame_index
                ),
            });
        }
        if stage != self.stage {
            return Err(BarrierFailure::StaleAck {
                stage: self.stage,
                reason: format!(
                    "确认阶段 {} 早于/晚于当前阶段 {}",
                    stage.code(),
                    self.stage.code()
                ),
            });
        }
        Ok(())
    }

    fn advance(&mut self) -> Result<(), BarrierFailure> {
        match self.stage.next() {
            Some(next) => {
                self.stage = next;
                // 进入新阶段时重新计时（预算按阶段独立）。
                self.elapsed_ms = 0;
                Ok(())
            }
            None => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity(frame_index: u32) -> FrameIdentity {
        FrameIdentity {
            job_id: "job".into(),
            attempt_id: "attempt-1".into(),
            execution_epoch: 3,
            snapshot_hash: "snap".into(),
            frame_index,
            sample: Rational::new(u64::from(frame_index) * 1001, 30_000).expect("sample"),
            camera_generation: 12,
            media_identities: vec!["asset-a@0.5".into(), "asset-b@0.5".into()],
        }
    }

    fn walk_to(barrier: &mut FrameBarrier, target: BarrierStage) {
        let id = barrier.identity().clone();
        barrier.acknowledge_applied(&id).expect("applied");
        if target == BarrierStage::Applied {
            return;
        }
        for (index, media) in id.media_identities.clone().into_iter().enumerate() {
            let result = barrier.acknowledge_media(&id, &media);
            if index + 1 < id.media_identities.len() {
                // 中间媒体到达时仍是 MissingMedia，这是预期状态而不是失败。
                assert!(matches!(result, Err(BarrierFailure::MissingMedia { .. })));
            } else {
                result.expect("last media");
            }
        }
        if target == BarrierStage::MediaReady {
            return;
        }
        barrier.acknowledge_pipeline(&id).expect("pipeline");
        if target == BarrierStage::PipelineReady {
            return;
        }
        barrier.acknowledge_rendered(&id).expect("rendered");
        if target == BarrierStage::Rendered {
            return;
        }
        barrier.acknowledge_readback(&id).expect("readback");
    }

    #[test]
    fn full_barrier_completes_in_order() {
        let mut barrier = FrameBarrier::begin(identity(4), BarrierBudget::default());
        assert_eq!(barrier.stage(), BarrierStage::Applied);
        walk_to(&mut barrier, BarrierStage::Readback);
        assert!(barrier.is_complete());
        assert_eq!(barrier.stage(), BarrierStage::Readback);
    }

    #[test]
    fn media_barrier_waits_for_every_declared_resource() {
        let mut barrier = FrameBarrier::begin(identity(1), BarrierBudget::default());
        let id = barrier.identity().clone();
        barrier.acknowledge_applied(&id).expect("applied");
        let first = barrier
            .acknowledge_media(&id, "asset-a@0.5")
            .expect_err("still missing asset-b");
        assert_eq!(
            first,
            BarrierFailure::MissingMedia {
                missing: vec!["asset-b@0.5".into()]
            }
        );
        assert_eq!(first.code(), "recording-media-missing");
        assert_eq!(barrier.stage(), BarrierStage::MediaReady);
        // 重复确认已到位的媒体不推进、也不报错。
        assert!(matches!(
            barrier.acknowledge_media(&id, "asset-a@0.5"),
            Err(BarrierFailure::MissingMedia { .. })
        ));
        barrier
            .acknowledge_media(&id, "asset-b@0.5")
            .expect("second media");
        assert_eq!(barrier.stage(), BarrierStage::PipelineReady);
    }

    #[test]
    fn media_that_is_not_in_the_snapshot_is_rejected() {
        let mut barrier = FrameBarrier::begin(identity(2), BarrierBudget::default());
        let id = barrier.identity().clone();
        barrier.acknowledge_applied(&id).expect("applied");
        let error = barrier
            .acknowledge_media(&id, "asset-c@0.5")
            .expect_err("undeclared media");
        assert_eq!(error.code(), "recording-stale-frame-ack");
        assert_eq!(barrier.stage(), BarrierStage::MediaReady);
    }

    #[test]
    fn stale_attempt_frame_and_camera_generation_do_not_advance() {
        let mut barrier = FrameBarrier::begin(identity(3), BarrierBudget::default());
        let mut stale = barrier.identity().clone();
        stale.attempt_id = "attempt-0".into();
        let error = barrier
            .acknowledge_applied(&stale)
            .expect_err("stale attempt");
        assert_eq!(error.code(), "recording-stale-frame-ack");
        assert_eq!(barrier.stage(), BarrierStage::Applied);

        let mut other_frame = barrier.identity().clone();
        other_frame.frame_index += 1;
        assert!(barrier.acknowledge_applied(&other_frame).is_err());
        assert_eq!(barrier.stage(), BarrierStage::Applied);

        let mut other_epoch = barrier.identity().clone();
        other_epoch.execution_epoch += 1;
        assert!(barrier.acknowledge_applied(&other_epoch).is_err());

        let mut other_camera = barrier.identity().clone();
        other_camera.camera_generation += 1;
        assert!(barrier.acknowledge_applied(&other_camera).is_err());
        assert_eq!(barrier.stage(), BarrierStage::Applied);
    }

    #[test]
    fn out_of_order_acknowledgement_is_rejected() {
        let mut barrier = FrameBarrier::begin(identity(5), BarrierBudget::default());
        let id = barrier.identity().clone();
        // 未 applied 就报 rendered：拒绝，且不跳过阶段。
        let error = barrier.acknowledge_rendered(&id).expect_err("out of order");
        assert_eq!(error.code(), "recording-stale-frame-ack");
        assert_eq!(barrier.stage(), BarrierStage::Applied);
    }

    #[test]
    fn timeout_reports_the_real_stage() {
        let mut budget = BarrierBudget::default();
        budget.applied_ms = 100;
        budget.media_ms = 50;
        let mut barrier = FrameBarrier::begin(identity(6), budget);
        assert!(barrier.tick(99).is_none());
        let error = barrier.tick(2).expect("applied timeout");
        assert_eq!(
            error,
            BarrierFailure::Timeout {
                stage: BarrierStage::Applied,
                waited_ms: 101
            }
        );
        assert_eq!(error.code(), "recording-scene-not-applied");
        assert!(error.transient());
    }

    #[test]
    fn media_timeout_has_its_own_code() {
        let mut budget = BarrierBudget::default();
        budget.media_ms = 10;
        let mut barrier = FrameBarrier::begin(identity(7), budget);
        let id = barrier.identity().clone();
        barrier.acknowledge_applied(&id).expect("applied");
        let error = barrier.tick(11).expect("media timeout");
        assert_eq!(error.stage(), BarrierStage::MediaReady);
        assert_eq!(error.code(), "recording-media-not-ready");
    }

    #[test]
    fn pause_freezes_the_budget() {
        let mut budget = BarrierBudget::default();
        budget.media_ms = 100;
        let mut barrier = FrameBarrier::begin(identity(8), budget);
        let id = barrier.identity().clone();
        barrier.acknowledge_applied(&id).expect("applied");
        barrier.pause();
        // 用户交互 10 秒：不计入阶段预算。
        assert!(barrier.tick(10_000).is_none());
        assert_eq!(barrier.elapsed_ms(), 0);
        barrier.resume();
        assert!(barrier.tick(99).is_none());
        assert!(barrier.tick(2).is_some());
    }

    #[test]
    fn cancellation_and_device_loss_keep_the_stage_and_are_not_retried() {
        let mut barrier = FrameBarrier::begin(identity(9), BarrierBudget::default());
        let id = barrier.identity().clone();
        barrier.acknowledge_applied(&id).expect("applied");
        let cancelled = barrier.cancel();
        assert_eq!(cancelled.stage(), BarrierStage::MediaReady);
        assert!(!cancelled.transient());
        assert_eq!(cancelled.code(), "recording-cancelled");
        // 终结后不再接受确认。
        assert!(barrier.acknowledge_media(&id, "asset-a@0.5").is_err());

        let mut lost = FrameBarrier::begin(identity(10), BarrierBudget::default());
        let failure = lost.device_lost();
        assert_eq!(failure.stage(), BarrierStage::Applied);
        assert!(failure.transient());
        assert_eq!(failure.code(), "recording-device-lost");
    }

    #[test]
    fn ticking_after_completion_is_a_no_op() {
        let mut barrier = FrameBarrier::begin(identity(11), BarrierBudget::default());
        walk_to(&mut barrier, BarrierStage::Readback);
        assert!(barrier.tick(1_000_000).is_none());
        assert!(barrier.is_complete());
    }

    #[test]
    fn stage_codes_are_stable() {
        assert_eq!(BarrierStage::Applied.code(), "scene-applied");
        assert_eq!(BarrierStage::PipelineReady.code(), "pipeline-ready");
        assert_eq!(
            BarrierStage::Rendered.timeout_code(),
            "capture-readiness-timeout"
        );
        assert_eq!(BarrierStage::Readback.next(), None);
    }
}
