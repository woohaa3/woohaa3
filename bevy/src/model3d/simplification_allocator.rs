//! meshoptimizer's C++ new/delete on wasm32-unknown-unknown have no system
//! allocator. Both symbols use Rust's allocator with an aligned size header.
//! These are internal linker symbols, not wasm-bindgen application exports.
use std::alloc::{Layout, alloc, dealloc, handle_alloc_error};
use std::sync::{
    Once,
    atomic::{AtomicUsize, Ordering},
};
const ALIGN: usize = 16;
static INITIALIZED: Once = Once::new();
static ACTIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

pub(super) fn initialize() {
    INITIALIZED.call_once(|| {
        // SAFETY: installation runs exactly once before any simplifier task;
        // callbacks implement paired ownership and preserve required alignment.
        unsafe {
            meshopt::ffi::meshopt_setAllocator(Some(tracked_allocate), Some(tracked_deallocate));
        }
    });
}
pub(super) fn workspace_bytes() -> (usize, usize) {
    (ACTIVE.load(Ordering::Relaxed), PEAK.load(Ordering::Relaxed))
}
unsafe extern "C" fn tracked_allocate(size: usize) -> *mut std::ffi::c_void {
    unsafe { cpp_allocate(size).cast() }
}
unsafe extern "C" fn tracked_deallocate(pointer: *mut std::ffi::c_void) {
    unsafe {
        cpp_deallocate(pointer.cast());
    }
}

#[cfg_attr(target_arch = "wasm32", unsafe(export_name = "_Znwm"))]
unsafe extern "C" fn cpp_allocate(size: usize) -> *mut u8 {
    let layout = Layout::from_size_align(
        size.max(1).checked_add(ALIGN).expect("allocation overflow"),
        ALIGN,
    )
    .expect("invalid allocation layout");
    // SAFETY: layout is valid; the first aligned word stores the exact layout
    // size for deletion. The returned payload also retains 16-byte alignment.
    unsafe {
        let base = alloc(layout);
        if base.is_null() {
            handle_alloc_error(layout);
        }
        base.cast::<usize>().write(layout.size());
        let active = ACTIVE.fetch_add(layout.size(), Ordering::Relaxed) + layout.size();
        PEAK.fetch_max(active, Ordering::Relaxed);
        base.add(ALIGN)
    }
}

#[cfg_attr(target_arch = "wasm32", unsafe(export_name = "_ZdlPv"))]
unsafe extern "C" fn cpp_deallocate(payload: *mut u8) {
    if payload.is_null() {
        return;
    }
    // SAFETY: C++ delete receives only pointers allocated by cpp_allocate;
    // subtracting the header recovers the allocation and its original layout.
    unsafe {
        let base = payload.sub(ALIGN);
        let size = base.cast::<usize>().read();
        ACTIVE.fetch_sub(size, Ordering::Relaxed);
        dealloc(base, Layout::from_size_align_unchecked(size, ALIGN));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn aligned_allocations_round_trip_sizes_and_null_delete() {
        for size in [0, 1, 15, 16, 17, 65_536] {
            // SAFETY: each pointer is live until exactly one matching delete;
            // writes stay inside the requested payload.
            unsafe {
                let pointer = cpp_allocate(size);
                assert_eq!(pointer as usize % ALIGN, 0);
                if size > 0 {
                    pointer.write(42);
                    pointer.add(size - 1).write(73);
                }
                cpp_deallocate(pointer);
            }
        }
        unsafe {
            cpp_deallocate(std::ptr::null_mut());
        }
    }
}
