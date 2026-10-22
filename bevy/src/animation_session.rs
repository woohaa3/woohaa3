//! 动画节点运行时：自包含模型姿态、唯一时钟与运动求值
//! （change: 2026-10-05-bind-model-animation-to-shots，任务 4.1–4.3）。
//!
//! 每个活动动画节点拥有独立模型姿态与**唯一时钟**；不可变网格/材质可按内容共享，但
//! transform、播放进度与镜头姿态独立。播放时由 Bevy 按时间求值（`motion` 纯函数），
//! **不**每帧重跑 JavaScript。
//!
//! 本模块只是可复用、无框架依赖的时钟与姿态状态机：宿主 adapter 负责把 canonical 动画
//! 节点投影为 `AnimationSession` 并读取 `pose_at`。它不依赖 Canvas 协议或 DOM。

use bevy::prelude::*;

use crate::motion::{evaluate, InitialCameraState, ModelDelta, MotionIr};

/// 单个动画节点的播放状态。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlaybackState {
    Stopped,
    Playing,
    Paused,
}

/// 动画节点会话：独立于其它节点。
#[derive(Clone, Debug)]
pub struct AnimationSession {
    /// 时间线时长（秒）；0 为静态节点。
    pub duration: f32,
    /// 是否循环。
    pub looped: bool,
    /// 当前时间（秒，已钳制在 `[0, duration]`）。
    pub time: f32,
    pub state: PlaybackState,
    /// 初始镜头（第 0 秒）。
    pub initial_camera: InitialCameraState,
    motion: MotionIr,
}

/// 求值后的节点姿态。
#[derive(Clone, Debug)]
pub struct AnimationPose {
    pub camera: crate::motion::CameraState,
    /// 每个受影响部件的增量姿态。
    pub model: Vec<(String, ModelDelta)>,
}

impl AnimationSession {
    /// 由受控运动 IR 建立会话，停在第 0 秒。
    pub fn new(duration: f32, looped: bool, initial_camera: InitialCameraState, motion: MotionIr) -> Self {
        Self {
            duration: if duration.is_finite() { duration.max(0.0) } else { 0.0 },
            looped,
            time: 0.0,
            state: PlaybackState::Stopped,
            initial_camera,
            motion,
        }
    }

    /// 播放：从当前位置推进（静止后回到第 0 秒重新开始）。
    pub fn play(&mut self) {
        if self.state != PlaybackState::Playing {
            self.state = PlaybackState::Playing;
        }
    }

    pub fn pause(&mut self) {
        if self.state == PlaybackState::Playing {
            self.state = PlaybackState::Paused;
        }
    }

    /// 停止并回到第 0 秒重新求值。
    pub fn stop(&mut self) {
        self.state = PlaybackState::Stopped;
        self.time = 0.0;
    }

    /// 时间定位：在 `[0, duration]` 内求值并暂停（末尾可精确截帧）。
    pub fn seek(&mut self, time: f32) {
        self.time = clamp_time(time, self.duration);
        self.state = PlaybackState::Paused;
    }

    /// 推进本地时钟；`delta` 秒。仅 `Playing` 时前进。
    pub fn advance(&mut self, delta: f32) {
        if self.state != PlaybackState::Playing {
            return;
        }
        let next = self.time + delta.max(0.0);
        if self.duration <= f32::EPSILON {
            self.time = 0.0;
            return;
        }
        if self.looped {
            self.time = next.rem_euclid(self.duration);
        } else if next >= self.duration {
            self.time = self.duration;
            self.state = PlaybackState::Paused;
        } else {
            self.time = next;
        }
    }

    /// 在指定时间求值（不改变会话时钟）。
    pub fn pose_at(&self, time: f32) -> AnimationPose {
        let (camera, model) = evaluate(&self.motion, clamp_time(time, self.duration), self.initial_camera);
        AnimationPose { camera, model }
    }

    /// 当前位置求值。
    pub fn pose(&self) -> AnimationPose {
        self.pose_at(self.time)
    }
}

fn clamp_time(time: f32, duration: f32) -> f32 {
    if !time.is_finite() {
        return 0.0;
    }
    time.clamp(0.0, duration)
}

/// 单个动画节点会话的稳定身份（节点 id + 内容 identity）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionIdentity {
    pub node_id: String,
    /// 本节点完整内容标识（模型 contentHash + 运动 sourceHash + 时间线 + 镜头）。
    pub snapshot_hash: String,
}

/// 会话容器：切换节点或定义变化时原子重建并取消旧会话（忽略迟到结果）。
#[derive(Clone, Debug, Default)]
pub struct AnimationSessionHolder {
    identity: Option<SessionIdentity>,
    /// 每次重建前进；迟到异步结果凭它判定失效。
    generation: u32,
    session: Option<AnimationSession>,
}

impl AnimationSessionHolder {
    pub fn generation(&self) -> u32 {
        self.generation
    }

    pub fn identity(&self) -> Option<&SessionIdentity> {
        self.identity.as_ref()
    }

    /// 是否仍接受 `generation` 的异步结果（迟到结果返回 false）。
    pub fn accepts(&self, generation: u32) -> bool {
        self.is_active() && generation == self.generation
    }

    pub fn is_active(&self) -> bool {
        self.session.is_some()
    }

    /// 选择节点：总是重建并前进 generation（即使同 identity 也取消旧会话）。
    pub fn select(&mut self, identity: SessionIdentity, session: AnimationSession) -> u32 {
        self.install(identity, session, true)
    }

    /// 定义变化：仅当 identity 变化时重建，否则保持会话。
    pub fn reconcile(&mut self, identity: SessionIdentity, session: AnimationSession) -> u32 {
        if self.identity.as_ref() == Some(&identity) {
            return self.generation;
        }
        self.install(identity, session, true)
    }

    fn install(&mut self, identity: SessionIdentity, session: AnimationSession, cancel: bool) -> u32 {
        if cancel {
            self.generation = self.generation.wrapping_add(1);
        }
        self.identity = Some(identity);
        self.session = Some(session);
        self.generation
    }

    /// 退出：取消会话；generation 前进使所有迟到结果失效。
    pub fn exit(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        self.identity = None;
        self.session = None;
    }

    pub fn session(&self) -> Option<&AnimationSession> {
        self.session.as_ref()
    }

    pub fn session_mut(&mut self) -> Option<&mut AnimationSession> {
        self.session.as_mut()
    }
}

