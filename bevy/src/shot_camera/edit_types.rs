//! Shot camera 编辑状态机类型（输入设备无关）
//! （change: add-reusable-bevy-shot-camera，任务 3.1 / design D4）。

use bevy::prelude::*;

use super::components::{FocusComponent, ShotCameraAxis, ShotCameraPose};

/// 编辑状态机（输入设备无关）。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ShotEditSession {
    pub camera: Entity,
    pub axis: ShotCameraAxis,
    pub focus_component: Option<FocusComponent>,
    pub start_pose: ShotCameraPose,
    pub current_pose: ShotCameraPose,
    pub start_distance: f32,
    pub fit_distance: f32,
}

/// 编辑生命周期事件。
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ShotEditEvent {
    /// Begin：冻结起始 pose。
    Begun(ShotEditSession),
    /// Update：连续修改运行时 preview。
    Updated {
        camera: Entity,
        pose: ShotCameraPose,
        /// 相对起始值是否有净变化。
        moved: bool,
    },
    /// Commit：发布一次最终结果（无净变化不发布）。
    Committed { camera: Entity, pose: ShotCameraPose },
    /// Cancel：恢复起始 pose，不发布完成写入。
    Cancelled { camera: Entity, pose: ShotCameraPose },
    /// Reset：回到给定默认 pose。
    Reset { camera: Entity, pose: ShotCameraPose },
}

/// 开始一次编辑：冻结起始 pose。
pub fn begin_edit(
    camera: Entity,
    axis: ShotCameraAxis,
    focus_component: Option<FocusComponent>,
    pose: ShotCameraPose,
    fit_distance: f32,
) -> ShotEditSession {
    ShotEditSession {
        camera,
        axis,
        focus_component,
        start_pose: pose,
        current_pose: pose,
        start_distance: pose.distance,
        fit_distance,
    }
}

/// 应用一次 orbit 更新。
pub fn update_orbit(
    session: &mut ShotEditSession,
    delta_x: f32,
    surface_width: f32,
) -> ShotEditEvent {
    session.current_pose.azimuth = super::framing::azimuth_from_horizontal_drag(
        session.start_pose.azimuth,
        delta_x,
        surface_width,
    );
    updated_event(session)
}

/// 应用一次 elevation 更新（竖直半圆拖动，change: add-shot-camera-elevation-control）。
pub fn update_elevation(
    session: &mut ShotEditSession,
    delta_pixels: f32,
    surface_height: f32,
) -> ShotEditEvent {
    session.current_pose.elevation = super::framing::elevation_from_vertical_drag(
        session.start_pose.elevation,
        delta_pixels,
        surface_height,
    );
    updated_event(session)
}

/// 应用一次 distance 更新。
pub fn update_distance(
    session: &mut ShotEditSession,
    delta_pixels: f32,
    surface_height: f32,
) -> ShotEditEvent {
    session.current_pose.distance = super::framing::distance_from_drag(
        session.start_distance,
        delta_pixels,
        surface_height,
        session.fit_distance,
    );
    updated_event(session)
}

/// 应用一次 focus 轴更新（世界位移）。
pub fn update_focus(session: &mut ShotEditSession, world_delta: f32) -> ShotEditEvent {
    let mut offset = session.start_pose.focus_offset;
    let component = session.focus_component.unwrap_or(FocusComponent::Y);
    match component {
        FocusComponent::X => offset.x += world_delta,
        FocusComponent::Y => offset.y += world_delta,
        FocusComponent::Z => offset.z += world_delta,
    }
    session.current_pose.focus_offset = offset;
    updated_event(session)
}

fn updated_event(session: &ShotEditSession) -> ShotEditEvent {
    ShotEditEvent::Updated {
        camera: session.camera,
        pose: session.current_pose,
        moved: has_moved(session),
    }
}

/// 相对起始 pose 是否有净变化（用于 commit 去抖）。
pub fn has_moved(session: &ShotEditSession) -> bool {
    let start = session.start_pose;
    let current = session.current_pose;
    (start.azimuth - current.azimuth).abs() > 1e-6
        || (start.elevation - current.elevation).abs() > 1e-6
        || (start.distance - current.distance).abs() > 1e-6
        || (start.focus_offset - current.focus_offset).length() > 1e-6
}

/// 提交一次编辑；无净变化返回 None（不发布可持久化完成事件）。
pub fn commit_edit(session: &ShotEditSession) -> Option<ShotEditEvent> {
    if !has_moved(session) {
        return None;
    }
    Some(ShotEditEvent::Committed {
        camera: session.camera,
        pose: session.current_pose,
    })
}

/// 取消一次编辑；恢复起始 pose。
pub fn cancel_edit(session: &ShotEditSession) -> ShotEditEvent {
    ShotEditEvent::Cancelled {
        camera: session.camera,
        pose: session.start_pose,
    }
}

    /// reset：回到给定默认 pose（清空 focus offset，仰角回到全局默认值）。
pub fn reset_pose(azimuth: f32, distance: f32) -> ShotCameraPose {
    ShotCameraPose::new(azimuth, distance)
}

/// 活动编辑会话表（每 rig 至多一个）。
#[derive(Resource, Default)]
pub struct ShotEditSessions {
    pub active: Vec<ShotEditSession>,
}

impl ShotEditSessions {
    pub fn find(&self, camera: Entity) -> Option<&ShotEditSession> {
        self.active.iter().find(|session| session.camera == camera)
    }

    pub fn upsert(&mut self, session: ShotEditSession) {
        if let Some(existing) = self
            .active
            .iter_mut()
            .find(|entry| entry.camera == session.camera)
        {
            *existing = session;
        } else {
            self.active.push(session);
        }
    }

    pub fn remove(&mut self, camera: Entity) -> Option<ShotEditSession> {
        let index = self.active.iter().position(|entry| entry.camera == camera)?;
        Some(self.active.remove(index))
    }
}
