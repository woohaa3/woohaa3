# Native embedding boundary

The renderer bridge is intentionally one list shared by the Tauri adapter and
external hosts:

- readiness, capabilities, runtime health and diagnostics;
- scene, viewport, observer and position updates;
- model/texture payload registration and leases;
- point, marquee, probe, drop-target, model-pick, gizmo and composite queries;
- shot capture request and bounded polling.

Every bridge request carries protocol version, runtime generation and an
optional sequence. Payloads are rejected before mutation when they exceed the
configured budget. A stale generation returns `stale-runtime`; a disposed
runtime returns `runtime-disposed`; version and readiness failures use
`protocol-mismatch` and `not-ready`. No request is executed on an IPC/WebView
worker thread: an adapter queues it to the thread that created the Bevy App.

The Woohaa shell keeps window controls, Tauri token/source authentication,
WebView labels, notifications, popup ownership and local-host process control.
Those operations are not part of `NativeCanvasBridge`. External hosts own the
parent handle, child HWND/NSView/X11 surface, WebView z-order, resize observer,
IPC queue and shutdown ordering around the borrowed runtime.
