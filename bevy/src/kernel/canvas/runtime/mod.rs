//! 派生调度层。只依赖 `protocol` 与纯算法，不 import `app` / `bridge` /
//! `canvas_ecs` / `canvas2d`，也不持有 `Entity` 或 Bevy ECS 资源。
//!
//! 标签期望集、有版本的脏键队列、epoch、`ChangeSet`、索引和主视口工作集都在这里；
//! 具体 ECS 投影与可见性仍由上层消费者负责。

mod dirty;
mod epoch;
mod changes;
mod indices;
mod labels;
mod workset;
pub(crate) mod texture_scope;

pub(crate) use dirty::{LabelConsumer, MAX_PENDING_DIRTY_KEYS};
pub(crate) use epoch::begin_renderer_instance;
pub(crate) use changes::{ChangeSet, NodeChange, NodeSlots, ViewportChange};
pub(crate) use indices::{CanvasIndices, EdgeIndex, NodeIndex as RuntimeNodeIndex};
pub(crate) use labels::{
    CommitOutcome, LabelConflict, LabelDirty, LabelOwner, LabelRole, LabelSet, LabelSpec,
    LabelStyle, LabelWriter, Op,
};
pub(crate) use workset::{Aabb, Workset, WorksetDelta, WorksetIndex};
