//! 有版本的脏键队列。去重范围是 live 键与未确认删除键的并集。
//!
//! 两个消费者各自持有读指针。旧版本的 ack 不能清掉之后的同键更新。超过
//! [`MAX_PENDING_DIRTY_KEYS`] 进入 full-resync barrier，两边都 ack 之后才丢旧日志。

use std::collections::HashMap;

use super::labels::LabelKey;

/// 去重后的脏键上限。超出则进入 full-resync barrier，不按 live 键数截断 tombstone。
pub(crate) const MAX_PENDING_DIRTY_KEYS: usize = 4096;

/// 脏队列消费者。条目要两边都 ack 过对应版本才能丢。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum LabelConsumer {
    Labels = 0,
    Geometry = 1,
}

#[derive(Clone, Copy)]
pub(crate) struct DirtyEntry {
    pub(crate) version: u64,
    pub(crate) tombstone: bool,
}

pub(crate) struct LabelWork<T> {
    pub(crate) barrier: bool,
    pub(crate) through: u64,
    /// 读指针所属的队列世代。旧 epoch 的 ack 带不上这个值。
    pub(crate) epoch: u64,
    pub(crate) dirty: Vec<T>,
}

pub(crate) struct DirtySnapshot {
    pub(crate) barrier: bool,
    pub(crate) through: u64,
    pub(crate) epoch: u64,
    pub(crate) keys: Vec<(LabelKey, bool)>,
}

#[derive(Default)]
pub(crate) struct DirtyQueue {
    pending: HashMap<LabelKey, DirtyEntry>,
    next_version: u64,
    cursors: [u64; 2],
    barrier: Option<u64>,
    /// 每次丢弃队列加一。旧世代的 ack 一律拒绝。
    epoch: u64,
}

impl DirtyQueue {
    pub(crate) fn enqueue(&mut self, key: LabelKey, tombstone: bool) -> u64 {
        self.next_version = self.next_version.saturating_add(1);
        let version = self.next_version;
        if self.barrier.is_some() {
            self.barrier = Some(version);
            return version;
        }
        let replacing = self.pending.contains_key(&key);
        if !replacing && self.pending.len() >= MAX_PENDING_DIRTY_KEYS {
            self.barrier = Some(version);
            return version;
        }
        self.pending.insert(key, DirtyEntry { version, tombstone });
        version
    }

    /// `issued` 必须是这次读取时的队列世代。旧 ack 即使版本号碰巧更大也不推进游标。
    pub(crate) fn ack(&mut self, consumer: LabelConsumer, through: u64, issued: u64) -> bool {
        if issued != self.epoch {
            return false;
        }
        let slot = consumer as usize;
        if through > self.cursors[slot] {
            self.cursors[slot] = through;
        }
        self.compact();
        true
    }

    /// 只返回键和版本窗口。视图由期望集拼，避免回调再借这张表。
    pub(crate) fn snapshot(&self, consumer: LabelConsumer) -> DirtySnapshot {
        let through = self.high_water();
        if self
            .barrier
            .is_some_and(|barrier| barrier > self.cursor(consumer))
        {
            return DirtySnapshot {
                barrier: true,
                through: self.barrier.unwrap_or(through).max(through),
                epoch: self.epoch,
                keys: Vec::new(),
            };
        }
        let cursor = self.cursor(consumer);
        let keys = self
            .pending
            .iter()
            .filter(|(_, entry)| entry.version > cursor && entry.version <= through)
            .map(|(key, entry)| (key.clone(), entry.tombstone))
            .collect();
        DirtySnapshot {
            barrier: false,
            through,
            epoch: self.epoch,
            keys,
        }
    }

    pub(crate) fn high_water(&self) -> u64 {
        self.barrier.unwrap_or(0).max(self.next_version)
    }

    pub(crate) fn needs_resync(&self, consumer: LabelConsumer) -> bool {
        self.barrier
            .is_some_and(|barrier| barrier > self.cursor(consumer))
    }

    pub(crate) fn discard(&mut self) {
        self.pending.clear();
        self.cursors = [0, 0];
        self.barrier = None;
        self.next_version = 0;
        self.epoch = self.epoch.saturating_add(1);
    }

    pub(crate) fn epoch(&self) -> u64 {
        self.epoch
    }

    pub(crate) fn barrier(&self) -> bool {
        self.barrier.is_some()
    }

    pub(crate) fn pending_len(&self) -> usize {
        self.pending.len()
    }

    pub(crate) fn tombstone(&self, key: &LabelKey) -> bool {
        self.pending.get(key).is_some_and(|entry| entry.tombstone)
    }

    fn cursor(&self, consumer: LabelConsumer) -> u64 {
        self.cursors[consumer as usize]
    }

    fn compact(&mut self) {
        let Some(barrier) = self.barrier else {
            let done = self.cursors.into_iter().min().unwrap_or(0);
            self.pending.retain(|_, entry| entry.version > done);
            return;
        };
        if self.cursors.into_iter().all(|cursor| cursor >= barrier) {
            self.pending.clear();
            self.barrier = None;
        }
    }
}
