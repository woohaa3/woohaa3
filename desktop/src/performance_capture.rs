//! Opt-in numeric WebView timings. Bounded transport and disk IO off the UI thread.
use serde_json::{Value, json};
use std::{
    io::Write,
    sync::{
        OnceLock,
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

static SENDER: OnceLock<mpsc::SyncSender<Value>> = OnceLock::new();
static DROPPED: AtomicU64 = AtomicU64::new(0);
static FRAME: AtomicU64 = AtomicU64::new(0);
static THREADS: AtomicU64 = AtomicU64::new(4);
thread_local! {static TRACE_THREAD:u64=THREADS.fetch_add(1,Ordering::Relaxed);}
static CLOCK: OnceLock<Instant> = OnceLock::new();
const LIMIT: u64 = 64 * 1024 * 1024;

pub fn initialize() {
    if !cfg!(any(debug_assertions, feature = "diagnostic-performance")) {
        return;
    }
    let Some(path) = std::env::var_os("WOOHAA_WEBVIEW_TRACE_PATH") else {
        return;
    };
    CLOCK.get_or_init(Instant::now);
    let (tx, rx) = mpsc::sync_channel::<Value>(64);
    if SENDER.set(tx).is_err() {
        return;
    }
    std::thread::spawn(move || {
        let Ok(mut file) = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(path)
        else {
            return;
        };
        let mut bytes = 0;
        for value in rx {
            let Ok(mut line) = serde_json::to_vec(&value) else {
                continue;
            };
            line.push(b'\n');
            bytes += line.len() as u64;
            if bytes > LIMIT || file.write_all(&line).is_err() {
                break;
            }
        }
    });
}
pub fn enabled() -> bool {
    SENDER.get().is_some()
}

fn validate(body: &[u8]) -> Result<Value, String> {
    if body.len() > 64 * 1024 {
        return Err("Timing payload exceeds budget".into());
    }
    let value: Value = serde_json::from_slice(body).map_err(|_| "Invalid timing payload")?;
    let object = value.as_object().ok_or("Invalid timing batch")?;
    if object
        .keys()
        .any(|key| !["samples", "dropped", "capabilities", "clockPair"].contains(&key.as_str()))
        || !object.contains_key("samples")
        || !object.contains_key("dropped")
    {
        return Err("Unknown timing batch fields".into());
    }
    if value["dropped"].as_u64().is_none() {
        return Err("Invalid dropped count".into());
    }
    if let Some(capabilities) = object.get("capabilities") {
        let fields = capabilities.as_object().ok_or("Invalid capabilities")?;
        for (key, status) in fields {
            if ![
                "performance",
                "raf",
                "longtask",
                "clockPair",
                "nativeInterval",
            ]
            .contains(&key.as_str())
                || !status.as_str().is_some_and(|s| {
                    ["collected", "unsupported", "not-collected", "dropped"].contains(&s)
                })
            {
                return Err("Invalid capability status".into());
            }
        }
    }
    if let Some(pair) = object.get("clockPair") {
        let fields = pair.as_object().ok_or("Invalid clock pair")?;
        if fields.len() != 4
            || ["epochMs", "monotonicMs", "uncertaintyMs", "webviewEpochMs"]
                .iter()
                .any(|key| {
                    !fields
                        .get(*key)
                        .and_then(Value::as_f64)
                        .is_some_and(|v| v.is_finite() && v >= 0.0)
                })
        {
            return Err("Invalid clock pair".into());
        }
    }
    let samples = value["samples"]
        .as_array()
        .ok_or("Missing timing samples")?;
    if samples.len() > 128 {
        return Err("Too many timing samples".into());
    }
    for sample in samples {
        let fields = sample.as_object().ok_or("Invalid timing sample")?;
        for required in [
            "scope",
            "stage",
            "frame",
            "startMs",
            "durationMs",
            "timeOrigin",
        ] {
            if !fields.contains_key(required) {
                return Err("Incomplete timing sample".into());
            }
        }
        for (key, number) in fields {
            if ["scope", "stage"].contains(&key.as_str()) {
                let name = number.as_str().ok_or("Invalid timing name")?;
                if name.is_empty()
                    || name.len() > 48
                    || !name
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
                {
                    return Err("Invalid timing name".into());
                }
            } else if ![
                "frame",
                "startMs",
                "durationMs",
                "timeOrigin",
                "intervalMs",
                "width",
                "height",
                "sourceWidth",
                "sourceHeight",
                "bytes",
                "discarded",
                "stale",
            ]
            .contains(&key.as_str())
                || !number
                    .as_f64()
                    .is_some_and(|n| n.is_finite() && (0.0..=1e15).contains(&n))
            {
                return Err("Invalid numeric timing field".into());
            }
        }
    }
    Ok(value)
}
pub fn ingest(body: &[u8]) -> Result<(), String> {
    let sender = SENDER.get().ok_or("Timing capture disabled")?;
    let value = validate(body)?;
    sender
        .try_send(value)
        .map_err(|_| "Timing capture queue full or closed".into())
}

/// Pair process monotonic time with epoch time without waiting for the UI thread.
pub fn clock_pair() -> Value {
    let origin = CLOCK.get_or_init(Instant::now);
    let before = origin.elapsed().as_secs_f64() * 1000.0;
    let epoch = SystemTime::now().duration_since(UNIX_EPOCH).ok();
    let after = origin.elapsed().as_secs_f64() * 1000.0;
    json!({"epochMs":epoch.map(|v| v.as_secs_f64() * 1000.0),
        "monotonicMs":(before+after)/2.0,"uncertaintyMs":(after-before)/2.0})
}

/// Display-link callback intervals, not GPU presentation timestamps.
pub fn native_interval(elapsed: Duration) {
    let Some(sender) = SENDER.get() else {
        return;
    };
    let pair = clock_pair();
    let duration = elapsed.as_secs_f64() * 1000.0;
    let lost = DROPPED.swap(0, Ordering::Relaxed);
    let value = json!({"samples":[{"scope":"native-display-link","stage":"interval",
        "frame":FRAME.fetch_add(1, Ordering::Relaxed),"thread":TRACE_THREAD.with(|id|*id),"startMs":pair["monotonicMs"],"timeOrigin":0,"durationMs":duration,
        "intervalMs":duration}],"dropped":lost,
        "nativeClockPair":pair,"capabilities":{"nativeInterval":if lost > 0 { "dropped" } else { "collected" }}});
    if sender.try_send(value).is_err() {
        DROPPED.fetch_add(lost + 1, Ordering::Relaxed);
    }
}

/// Owner-observed presentation mode, recorded only on transitions. This is
/// backend identity metadata, not a GPU duration or a presented-frame timestamp.
pub fn native_presentation(mode: &'static str) {
    if !matches!(mode, "shared-gpu" | "native-cpu-viewport") {
        return;
    }
    let Some(sender) = SENDER.get() else { return };
    let lost = DROPPED.swap(0, Ordering::Relaxed);
    let batch = json!({"samples":[],"dropped":lost,"nativeClockPair":clock_pair(),"nativePresentation":mode});
    if sender.try_send(batch).is_err() {
        DROPPED.fetch_add(lost + 1, Ordering::Relaxed);
    }
}

/// Native CPU wall span ending now. Correlation is numeric only; no document/text data.
pub fn native_span(stage: &'static str, elapsed: Duration, request: Option<(u64, u64)>) {
    let Some(sender) = SENDER.get() else {
        return;
    };
    let pair = clock_pair();
    let lost = DROPPED.swap(0, Ordering::Relaxed);
    let mut sample = json!({"scope":"native-editor","stage":stage,"frame":FRAME.fetch_add(1,Ordering::Relaxed),
        "startMs":pair["monotonicMs"],"thread":TRACE_THREAD.with(|id|*id),"timeOrigin":0,"durationMs":elapsed.as_secs_f64()*1000.0});
    if let Some((id, generation)) = request {
        sample["requestId"] = json!(id);
        sample["generation"] = json!(generation);
    }
    let batch = json!({"samples":[sample],"dropped":lost,"nativeClockPair":pair});
    if sender.try_send(batch).is_err() {
        DROPPED.fetch_add(lost + 1, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn capability_metadata_is_closed_and_clock_pairs_are_numeric() {
        let mut batch = json!({"samples":[],"dropped":0,"capabilities":{"longtask":"unsupported","performance":"not-collected"}});
        assert!(validate(&serde_json::to_vec(&batch).unwrap()).is_ok());
        batch["capabilities"]["longtask"] = json!("document title");
        assert!(validate(&serde_json::to_vec(&batch).unwrap()).is_err());
        batch["capabilities"] = json!({"secret":"collected"});
        assert!(validate(&serde_json::to_vec(&batch).unwrap()).is_err());
        batch["capabilities"] = json!({});
        batch["clockPair"] =
            json!({"epochMs":1,"monotonicMs":2,"uncertaintyMs":0.1,"webviewEpochMs":3});
        assert!(validate(&serde_json::to_vec(&batch).unwrap()).is_ok());
        batch["clockPair"]["title"] = json!("secret");
        assert!(validate(&serde_json::to_vec(&batch).unwrap()).is_err());
        let pair = clock_pair();
        assert!(pair["epochMs"].as_f64().unwrap() > 0.0);
        assert!(pair["uncertaintyMs"].as_f64().unwrap() >= 0.0);
    }
    #[test]
    fn timings_reject_content_invalid_numbers_and_unbounded_batches() {
        let sample = json!({"scope":"image-edit","stage":"readback","frame":1,"startMs":10,"durationMs":2,"timeOrigin":1000});
        let batch =
            |sample: Value| serde_json::to_vec(&json!({"samples":[sample],"dropped":0})).unwrap();
        assert!(validate(&batch(sample.clone())).is_ok());
        let mut invalid = sample.clone();
        invalid["pixels"] = json!([1, 2]);
        assert!(validate(&batch(invalid)).is_err());
        let mut invalid = sample.clone();
        invalid["durationMs"] = json!(-1);
        assert!(validate(&batch(invalid)).is_err());
        let mut invalid = sample.clone();
        invalid["stage"] = json!("document title / private");
        assert!(validate(&batch(invalid)).is_err());
        assert!(
            validate(
                &serde_json::to_vec(&json!({"samples":vec![sample;129],"dropped":0})).unwrap()
            )
            .is_err()
        );
        assert!(validate(&vec![b' '; 65537]).is_err());
    }
}
