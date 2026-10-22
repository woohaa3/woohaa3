//! 有界的开播采样缓存。时钟由调用方注入，单元测试无需窗口或 GPU。
use serde_json::{Value, json};
pub(crate) type Key = (String, String, u32);
pub(crate) const MAX_FRAMES: usize = 120;
const WINDOW_MS: f64 = 3000.0;

#[derive(Default)]
pub(crate) struct Trace {
    key: Option<Key>,
    began_ms: f64,
    complete: bool,
    rows: Vec<Value>,
}
impl Trace {
    pub fn collecting(&self) -> bool { self.key.is_some() && !self.complete }
    pub fn arm(&mut self, key: Option<Key>, now_ms: f64) -> Option<Value> {
        if self.key == key { return None; }
        let old = self.finish(now_ms, "session-ended-or-replaced");
        self.key = key;
        self.began_ms = now_ms;
        self.complete = false;
        self.rows.clear();
        old
    }
    pub fn push(&mut self, now_ms: f64, mut row: Value) -> Option<Value> {
        if !self.collecting() { return None; }
        row["frame"] = json!(self.rows.len() + 1);
        row["sinceStartMs"] = json!((now_ms - self.began_ms).max(0.0));
        self.rows.push(row);
        if self.rows.len() == MAX_FRAMES { self.finish(now_ms, "frame-limit") }
        else if now_ms - self.began_ms >= WINDOW_MS { self.finish(now_ms, "window-complete") }
        else { None }
    }
    fn finish(&mut self, now_ms: f64, reason: &str) -> Option<Value> {
        if !self.collecting() { return None; }
        self.complete = true;
        let (node, clip, generation) = self.key.as_ref()?;
        Some(json!({"nodeId":node,"clipId":clip,"generation":generation,
            "reason":reason,"elapsedMs":(now_ms-self.began_ms).max(0.0),
            "gpuTime":"unavailable","frames":std::mem::take(&mut self.rows)}))
    }
}
// 每行只携带一个样本，保留会话信息和分段总数，避免采集端截断长行。
pub(crate) fn parts(mut report: Value) -> Vec<Value> {
    let frames = report["frames"].take().as_array().cloned().unwrap_or_default();
    let count = frames.len();
    frames.into_iter().enumerate().map(|(index, frame)| {
        let mut part = report.clone();
        part["part"] = json!(index + 1);
        part["parts"] = json!(count);
        part["frames"] = json!([frame]);
        part
    }).collect()
}
#[cfg(test)]
mod tests {
    use super::*;
    fn key(generation: u32) -> Option<Key> { Some(("node".into(), "clip".into(), generation)) }
    #[test]
    fn captures_start_and_later_frames_without_rearming_the_same_session() {
        let mut trace = Trace::default();
        assert!(trace.arm(key(1), 100.0).is_none());
        assert!(trace.push(120.0, json!({"extractMs":7})).is_none());
        assert!(trace.arm(key(1), 1000.0).is_none());
        let report = trace.push(3100.0, json!({"extractMs":1})).unwrap();
        assert_eq!(report["frames"][0]["sinceStartMs"], 20.0);
        assert_eq!(report["frames"][1]["sinceStartMs"], 3000.0);
        assert_eq!(report["reason"], "window-complete");
        assert!(trace.push(4000.0, json!({})).is_none());
        assert!(trace.arm(key(1), 5000.0).is_none());
        assert!(!trace.collecting());
    }
    #[test]
    fn flushes_partial_session_and_keeps_generations_separate() {
        let mut trace = Trace::default();
        trace.arm(key(1), 0.0);
        trace.push(10.0, json!({"value":1}));
        let old = trace.arm(key(2), 20.0).unwrap();
        assert_eq!(old["generation"], 1);
        assert_eq!(old["frames"].as_array().unwrap().len(), 1);
        trace.push(30.0, json!({"value":2}));
        let new = trace.arm(None, 40.0).unwrap();
        assert_eq!(new["generation"], 2);
        assert_eq!(new["frames"][0]["value"], 2);
        assert!(!trace.collecting());
    }
    #[test]
    fn split_preserves_every_frame_and_session_metadata() {
        let report = json!({"generation":42,"frames":[{"frame":1},{"frame":2}]});
        let rows = parts(report);
        assert_eq!(rows.len(), 2);
        for (index, row) in rows.iter().enumerate() {
            assert_eq!(row["generation"], 42);
            assert_eq!(row["part"], index + 1);
            assert_eq!(row["parts"], 2);
            assert_eq!(row["frames"].as_array().unwrap().len(), 1);
            assert_eq!(row["frames"][0]["frame"], index + 1);
        }
    }
    #[test]
    fn caps_high_frequency_capture_and_emits_only_once() {
        let mut trace = Trace::default();
        trace.arm(key(1), 0.0);
        for i in 0..MAX_FRAMES-1 { assert!(trace.push(i as f64, json!({})).is_none()); }
        let report = trace.push(120.0, json!({})).unwrap();
        assert_eq!(report["reason"], "frame-limit");
        assert_eq!(report["frames"].as_array().unwrap().len(), MAX_FRAMES);
        assert!(trace.arm(None, 130.0).is_none());
    }
}
