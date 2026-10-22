//! Wall-clock preview synchronization stages; render wait is not GPU execution time.
use bevy::platform::time::Instant;
use std::collections::{HashMap, HashSet, VecDeque};

struct Waiting {
    since: Instant,
    admitted: Option<Instant>,
    selected: Option<Instant>,
    generation: u64,
    unadmitted: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn superseded_work_keeps_its_age_and_old_ready_cannot_complete_new_work() {
        let mut latency = Latency::default();
        latency.invalidate("private-node");
        let since = latency.waiting["private-node"].since;
        latency.admitted("private-node", 1);
        latency.selected("private-node");
        latency.invalidate("private-node");
        latency.ready("private-node", 1);
        assert_eq!(latency.totals.completed, 0);
        assert_eq!(latency.waiting["private-node"].since, since);
        latency.admitted("private-node", 2);
        latency.selected("private-node");
        latency.ready("private-node", 1);
        assert_eq!(latency.totals.completed, 0);
        latency.ready("private-node", 2);
        assert_eq!(latency.totals.completed, 1);
        assert_eq!(latency.totals.superseded, 1);
        let sum = latency.totals.admission_wait_ms
            + latency.totals.render_queue_wait_ms
            + latency.totals.prepare_wait_ms;
        assert!((latency.totals.total_ms - sum).abs() < 1e-9);
        let snapshot = latency.snapshot_if_changed().unwrap();
        assert!(!snapshot.contains("private-node"));
        assert!(latency.snapshot_if_changed().is_none());
        latency.invalidate("deleted");
        latency.retain(&HashSet::new());
        assert_eq!(latency.totals.cancelled, 1);
        for generation in 0..130 {
            latency.invalidate("card");
            latency.admitted("card", generation);
            latency.selected("card");
            latency.ready("card", generation);
        }
        assert_eq!(latency.recent.len(), 128);
        assert!(latency.waiting.is_empty());
    }
}
#[derive(Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Totals {
    completed: u64,
    cancelled: u64,
    superseded: u64,
    untracked: u64,
    total_ms: f64,
    admission_wait_ms: f64,
    render_queue_wait_ms: f64,
    prepare_wait_ms: f64,
    max_total_ms: f64,
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Completion {
    total_ms: f64,
    admission_wait_ms: f64,
    render_queue_wait_ms: f64,
    prepare_wait_ms: f64,
}
pub(super) struct Latency {
    waiting: HashMap<String, Waiting>,
    totals: Totals,
    recent: VecDeque<Completion>,
    dirty: bool,
}
impl Default for Latency {
    fn default() -> Self {
        Self {
            waiting: HashMap::new(),
            totals: Totals::default(),
            recent: VecDeque::new(),
            dirty: true,
        }
    }
}
impl Latency {
    pub fn invalidate(&mut self, id: &str) {
        if let Some(waiting) = self.waiting.get_mut(id) {
            waiting.unadmitted = true;
            return;
        }
        if self.waiting.len() >= 4096 {
            self.totals.untracked += 1;
            self.dirty = true;
            return;
        }
        self.waiting.insert(
            id.into(),
            Waiting {
                since: Instant::now(),
                admitted: None,
                selected: None,
                generation: 0,
                unadmitted: true,
            },
        );
    }
    pub fn admitted(&mut self, id: &str, generation: u64) {
        let Some(waiting) = self.waiting.get_mut(id) else {
            return;
        };
        if waiting.admitted.is_some() {
            self.totals.superseded += 1;
            self.dirty = true;
        }
        waiting.admitted = Some(Instant::now());
        waiting.selected = None;
        waiting.generation = generation;
        waiting.unadmitted = false;
    }
    pub fn selected(&mut self, id: &str) {
        if let Some(waiting) = self.waiting.get_mut(id) {
            if !waiting.unadmitted && waiting.selected.is_none() {
                waiting.selected = Some(Instant::now());
            }
        }
    }
    pub fn ready(&mut self, id: &str, generation: u64) {
        let Some(waiting) = self.waiting.get(id) else {
            return;
        };
        if waiting.unadmitted || waiting.generation != generation || waiting.selected.is_none() {
            return;
        }
        let waiting = self.waiting.remove(id).unwrap();
        let now = Instant::now();
        let admitted = waiting.admitted.unwrap();
        let selected = waiting.selected.unwrap();
        let ms =
            |later: Instant, earlier: Instant| later.duration_since(earlier).as_secs_f64() * 1000.;
        let total = ms(now, waiting.since);
        self.totals.completed += 1;
        self.totals.total_ms += total;
        self.totals.max_total_ms = self.totals.max_total_ms.max(total);
        self.totals.admission_wait_ms += ms(admitted, waiting.since);
        self.totals.render_queue_wait_ms += ms(selected, admitted);
        self.totals.prepare_wait_ms += ms(now, selected);
        self.recent.push_back(Completion {
            total_ms: total,
            admission_wait_ms: ms(admitted, waiting.since),
            render_queue_wait_ms: ms(selected, admitted),
            prepare_wait_ms: ms(now, selected),
        });
        if self.recent.len() > 128 {
            self.recent.pop_front();
        }
        self.dirty = true;
    }
    pub fn cancel(&mut self, id: &str) {
        if self.waiting.remove(id).is_some() {
            self.totals.cancelled += 1;
            self.dirty = true;
        }
    }
    pub fn retain(&mut self, alive: &HashSet<&str>) {
        let stale: Vec<_> = self
            .waiting
            .keys()
            .filter(|id| !alive.contains(id.as_str()))
            .cloned()
            .collect();
        for id in stale {
            self.cancel(&id);
        }
    }
    pub fn snapshot_if_changed(&mut self) -> Option<String> {
        if !self.dirty {
            return None;
        }
        self.dirty = false;
        #[derive(serde::Serialize)]
        struct Snapshot<'a> {
            #[serde(flatten)]
            totals: &'a Totals,
            recent: &'a VecDeque<Completion>,
        }
        Some(
            serde_json::to_string(&Snapshot {
                totals: &self.totals,
                recent: &self.recent,
            })
            .unwrap(),
        )
    }
}
