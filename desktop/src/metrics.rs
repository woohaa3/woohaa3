//! Development CPU wall timings, never GPU timestamps or presented-frame FPS.
//! Bounded nonblocking producers; aggregation and disk IO run off the UI thread.
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, VecDeque},
    sync::{
        OnceLock,
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

enum Event {
    Sample(&'static str, f64),
    Client(Value, Value),
    Layout(Value),
}
static SENDER: OnceLock<mpsc::SyncSender<Event>> = OnceLock::new();
static DROPPED: AtomicU64 = AtomicU64::new(0);
thread_local! { static NAVIGATION: std::cell::Cell<Option<(Instant, Instant)>> = const { std::cell::Cell::new(None) }; }

pub fn initialize() {
    if !cfg!(debug_assertions) {
        return;
    }
    let Ok(path) = std::env::var("WOOHAA_NATIVE_METRICS_PATH") else {
        return;
    };
    let (tx, rx) = mpsc::sync_channel(2048);
    if SENDER.set(tx).is_err() {
        return;
    }
    eprintln!("[native-performance] CPU wall timings → {path}");
    std::thread::spawn(move || {
        let mut groups: BTreeMap<&str, Samples> = BTreeMap::new();
        let (mut client, mut layout, mut work) = (Value::Null, Value::Null, Value::Null);
        let started = Instant::now();
        let mut next = Instant::now() + Duration::from_secs(2);
        loop {
            match rx.recv_timeout(next.saturating_duration_since(Instant::now())) {
                Ok(Event::Sample(name, ms)) => groups.entry(name).or_default().push(ms),
                Ok(Event::Client(value, snapshot)) => {
                    client = value;
                    work = snapshot;
                }
                Ok(Event::Layout(value)) => layout = value,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            if Instant::now() < next {
                continue;
            }
            let summary: BTreeMap<_, _> = groups
                .iter()
                .map(|(name, values)| (*name, values.summary()))
                .collect();
            let report = json!({"schema":1,"renderer":"native","scope":"CPU wall time; not GPU duration or presented FPS",
                "binary":std::env::var("WOOHAA_NATIVE_BINARY_ID").unwrap_or_else(|_| "unknown".into()),
                "epochMs":SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64,
                "elapsedSeconds":started.elapsed().as_secs_f64(),"dropped":DROPPED.load(Ordering::Relaxed),
                "host":summary,"client":client,"layout":layout,"work":work,
                "workScope":"1s asynchronous cumulative CPU diagnostics; not per-input work"});
            let temporary = format!("{path}.tmp");
            if let Ok(bytes) = serde_json::to_vec_pretty(&report) {
                if std::fs::write(&temporary, bytes).is_ok() {
                    let _ = std::fs::rename(&temporary, &path);
                }
            }
            next = Instant::now() + Duration::from_secs(2);
        }
    });
}
fn send(event: Event) {
    if let Some(sender) = SENDER.get() {
        if sender.try_send(event).is_err() {
            DROPPED.fetch_add(1, Ordering::Relaxed);
        }
    }
}
pub fn sample(name: &'static str, elapsed: Duration) {
    send(Event::Sample(name, elapsed.as_secs_f64() * 1000.0));
}
pub fn layout(value: Value) {
    send(Event::Layout(value));
}
pub fn navigation() {
    let now = Instant::now();
    NAVIGATION.with(|value| {
        let first = value.get().map(|(first, _)| first).unwrap_or(now);
        value.set(Some((first, now)));
    });
}
pub fn take_navigation() -> Option<(Instant, Instant)> {
    NAVIGATION.with(|value| value.replace(None))
}
#[cfg(test)]
pub fn client(value: &Value) -> Result<(), String> {
    client_with_work(value, &Value::Null)
}
pub fn client_with_work(value: &Value, work: &Value) -> Result<(), String> {
    // Fixed shape: only numeric timings/geometry, never request bodies or assets.
    let object = value.as_object().ok_or("Invalid client metrics")?;
    if object.len() > 32 {
        return Err("Too many client metrics".into());
    }
    let allowed = [
        "raf_interval",
        "canvas_work_diagnostics",
        "set_scene",
        "set_viewport",
        "set_viewport_async",
        "set_observer",
        "set_positions",
        "query_point_hit",
        "query_model_pick",
        "query_other",
        "status",
        "texture",
        "layout",
        "other",
    ];
    for (name, group) in object {
        if !allowed.contains(&name.as_str()) {
            return Err("Unknown client metric".into());
        }
        let fields = group.as_object().ok_or("Invalid metric fields")?;
        for (key, number) in fields {
            if !["count", "windowCount", "meanMs", "p50Ms", "p95Ms", "maxMs"]
                .contains(&key.as_str())
                || !number
                    .as_f64()
                    .is_some_and(|n| n.is_finite() && (0.0..=1e12).contains(&n))
            {
                return Err("Invalid client timing".into());
            }
        }
    }
    if !work.is_null() {
        let fields = work.as_object().ok_or("Invalid background work")?;
        for (key, number) in fields {
            if ![
                "readStartedAtMonotonicMs",
                "observedAtMonotonicMs",
                "readWallMs",
                "renderMs",
                "renderFrames",
                "queueMs",
                "prepareMs",
                "prepareFrames",
                "snapshotBuilds",
                "pickCandidateBuilds",
                "meshBuilds",
            ]
            .contains(&key.as_str())
                || !number
                    .as_f64()
                    .is_some_and(|n| n.is_finite() && (0.0..=1e12).contains(&n))
            {
                return Err("Invalid background work field".into());
            }
        }
    }
    send(Event::Client(value.clone(), work.clone()));
    Ok(())
}
#[derive(Default)]
struct Samples {
    count: u64,
    sum: f64,
    recent: VecDeque<f64>,
}
impl Samples {
    fn push(&mut self, value: f64) {
        self.count += 1;
        self.sum += value;
        if self.recent.len() == 2048 {
            self.recent.pop_front();
        }
        self.recent.push_back(value);
    }
    fn summary(&self) -> Value {
        let mut values: Vec<_> = self.recent.iter().copied().collect();
        values.sort_by(f64::total_cmp);
        let quantile =
            |q: f64| values[((values.len() as f64 * q).ceil() as usize).saturating_sub(1)];
        json!({"count":self.count,"meanMs":self.sum/self.count as f64,"windowCount":values.len(),
            "p50Ms":quantile(0.5),"p95Ms":quantile(0.95),"maxMs":values.last()})
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn client_rejects_content_and_invalid_durations() {
        assert!(client(&json!({"set_scene":{"payload":"secret"}})).is_err());
        assert!(client(&json!({"status":{"p95Ms":-1}})).is_err());
        assert!(client(&json!({"unbounded_name":{"count":1}})).is_err());
        assert!(client(&json!({"set_viewport":{"count":3,"p95Ms":4.0}})).is_ok());
        assert!(client(&json!({"set_viewport_async":{"count":3,"p95Ms":18.0}})).is_ok());
        assert!(client(&json!({"set_observer":{"count":3,"p95Ms":2.0}})).is_ok());
    }
    #[test]
    fn background_work_rejects_content_and_navigation_is_coalesced() {
        assert!(client_with_work(&json!({}), &json!({"modelId":"secret"})).is_err());
        assert!(client_with_work(&json!({}), &json!({"renderMs":-1})).is_err());
        assert!(
            client_with_work(
                &json!({}),
                &json!({"renderMs":5,"observedAtMonotonicMs":10})
            )
            .is_ok()
        );
        assert!(take_navigation().is_none());
        navigation();
        let initial = NAVIGATION.with(|value| value.get().unwrap());
        navigation();
        let (first, latest) = take_navigation().unwrap();
        assert_eq!(first, initial.0);
        assert!(latest >= initial.1);
        assert!(take_navigation().is_none());
    }
    #[test]
    fn rolling_quantiles_are_bounded_while_totals_remain_cumulative() {
        let mut data = Samples::default();
        for i in 1..=4096 {
            data.push(i as f64);
        }
        let result = data.summary();
        assert_eq!(result["count"], 4096);
        assert_eq!(result["windowCount"], 2048);
        assert_eq!(result["p50Ms"], 3072.0);
        assert_eq!(result["maxMs"], 4096.0);
    }
}
