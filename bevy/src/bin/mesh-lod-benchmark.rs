use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

struct TrackedHeap;
static ACTIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
#[global_allocator]
static HEAP: TrackedHeap = TrackedHeap;

fn add(size: usize) {
    let live = ACTIVE.fetch_add(size, Ordering::Relaxed) + size;
    PEAK.fetch_max(live, Ordering::Relaxed);
}
// SAFETY: every operation delegates ownership/alignment to System; tracking
// uses allocation-free atomics and does not change the returned pointers.
unsafe impl GlobalAlloc for TrackedHeap {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let pointer = unsafe { System.alloc(layout) };
        if !pointer.is_null() {
            add(layout.size());
        }
        pointer
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        unsafe {
            System.dealloc(pointer, layout);
        }
        ACTIVE.fetch_sub(layout.size(), Ordering::Relaxed);
    }
    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let result = unsafe { System.realloc(pointer, layout, new_size) };
        if !result.is_null() {
            if new_size > layout.size() {
                add(new_size - layout.size());
            } else {
                ACTIVE.fetch_sub(layout.size() - new_size, Ordering::Relaxed);
            }
        }
        result
    }
}

fn main() {
    let input = std::env::args()
        .nth(1)
        .expect("usage: mesh-lod-benchmark <normalized-mesh-fixture.json>");
    let json = std::fs::read_to_string(input).expect("read mesh fixture");
    let mut report = woohaa_bevy_canvas::model3d::lod_benchmark::measure_json(&json)
        .expect("measure mesh fixture");
    report["nativeProcessHeapPeakBytes"] = serde_json::json!(PEAK.load(Ordering::Relaxed));
    report["nativeHeapScope"] = serde_json::json!(
        "Rust/System allocation requests including input JSON, parsed source, validation, mesh buffers and tracked C++ workspace; excludes stack/GPU/RSS and allocator bookkeeping"
    );
    println!("{}", serde_json::to_string_pretty(&report).unwrap());
}
