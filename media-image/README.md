# Rust image preparation

`cargo test --manifest-path media-image/Cargo.toml` runs CPU codec/alpha/orientation tests.
`node scripts/build-media-image.mjs` builds the independent, single-thread browser module.
It does not build or initialise Bevy and does not require cross-origin isolation.

All static image preparation runs in Dedicated Workers in the browser, and in a Rust pool
for native desktop. The page owns the transport read: it admits the read against a separate
fetch quota, then hands the compressed bytes to an admitted decode instance (transferred to
the Worker, registered with the native side). Reads never occupy a decode slot, so a slow
Media response does not serialise decoding. Decode instances are capped by page policy
(`imageDecodeMaxInstances`, default 4); small output tiers (≤512) reserve half a decode
slot and may run 4 at once, while 1024+ outputs keep the original 2-way equivalence. The
native boundary receives explicitly registered compressed bytes after a credentialed Media
read; it never fetches arbitrary URLs or interprets WebView cookies, paths or blob URLs.
Native texture application happens on Tauri's renderer owner thread. Editor-produced RGBA
and video paths keep their owners.

When the page becomes hidden, the page residency set is *frozen*: no new media work starts,
and already-decoded textures are not evicted, so switching tabs back does not re-fetch and
re-decode the whole canvas. Demand changes are recomputed on the next visible frame.

The core accepts PNG/JPEG/WebP/GIF/AVIF, up to 32 MiB compressed, 64 megapixels and
32768 pixels per axis. Output variants have a maximum edge of 2048. Untagged input
uses sRGB; ICC conversion uses moxcms, malformed or unsupported profiles fail explicitly.
EXIF orientation is applied. GIF/animated AVIF are static first-frame previews. Resampling
integrates linear-light premultiplied colours and returns straight-alpha RGBA8. It does not
allocate a full floating-point copy of the source. Source files are never rewritten.

The browser module has a 1 GiB linear-memory maximum, which remains the single-instance hard
cap (1152 MiB including compressed, transfer and encoded staging). Per-job reservations are
smaller and staged: a read reserves 40 MiB of transport buffer, and a decode reserves 96 MiB
for 1024+ outputs or 48 MiB for ≤512 outputs (RGBA + codec scratch + instance overhead).
These are reservations, not eager allocations; measured peaks are ~7 MiB of Worker memory
for 1024² sources and ~68 MiB for 4096² sources, so four concurrent 4K sources can exceed
the 192 MiB decode budget — the instance cap (4) bounds that worst case, and actual capacity
is reported separately. Instances above 64 MiB retire after a job; other idle instances
retire after ten seconds. Cancellation during non-preemptible codec execution drains the
job until its real receipt or confirmed Worker termination. A crash or timeout requires
explicit retry; HTTP/network transients keep the existing bounded retry schedule. Pixel
results copy out of WASM memory, transfer to the page, copy into the separate renderer
module, and then upload to the GPU. This is not zero-copy GPU upload.

AVIF uses `sqzer-codecs 0.3.0` and `sqzer-rav1d 0.1.0` (the latter supplies a wasm32
libc shim and single-thread AV1 decoding). The lockfile fixes the dependency graph. The
standalone release image module, including AVIF, is about 2.4 MiB before HTTP compression.
Upstream avif-decode 3.0.0 + rav1d 1.1.0 was tested and cannot compile for
wasm32-unknown-unknown (missing libc types/constants); it is not used.

Dependencies retain their upstream licences: image/moxcms MIT OR Apache-2.0,
sqzer-core/codecs MIT OR Apache-2.0, sqzer-rav1d BSD-2-Clause,
avif-parse MPL-2.0, yuv BSD-3-Clause OR Apache-2.0, wasm-bindgen MIT OR Apache-2.0.
No AGPL/commercial-only decoder was selected. Test images were generated specifically
for this repository with Pillow; they contain only synthetic colour geometry.

## Experimental threads

The default remains the single-thread pool. For a controlled comparison:

```sh
rustup toolchain install nightly-2026-10-30 --profile minimal --component rust-src
node scripts/build-media-image.mjs --threaded
WOOHAA_IMAGE_THREADS_ISOLATION=1 VITE_WOOHAA_IMAGE_THREADS=1 pnpm dev
```

The threaded build has its own `media-image/target-threaded`, nightly std rebuild,
atomics/bulk-memory flags, imported shared memory and explicit TLS exports required by
wasm-bindgen 0.2.128. Stable Bevy/native caches and the baseline artifact stay separate.
It is served from `public/assets/media-image-threaded/` using the adapter's no-bundler
ES-module helpers. Build this artifact before building an experimental frontend bundle.
`serve-web.mjs` accepts `WOOHAA_IMAGE_THREADS_ISOLATION=1` too; its frontend bundle must
have been built with `VITE_WOOHAA_IMAGE_THREADS=1`. Default deployments get neither header.

The executing image Worker checks secure context, crossOriginIsolated, SharedArrayBuffer
and shared-memory WASM validation. An experimental page uses one coordinator instance,
which owns two Rayon compute Workers; AV1 decoding itself stays single-threaded. Only the
resampling kernel uses Rayon. Initialization has a five-second deadline. Failure terminates
the old Worker and descendants before retrying the same request once in a fresh baseline
Worker. Missing isolation bypasses the threaded loader. This is a fallback inside Workers,
never a fallback to main-thread Image or Canvas processing.

The experiment was checked in Chromium at a non-root Vite mount. COOP/COEP may affect
OAuth popups, third-party fonts/extensions and CDN resources. The full integration matrix,
ATC external proxy deployment, target Pad browsers and hardware visual/performance checks
remain manual gates; do not enable these headers by default based on the CPU comparison.
