# Scope gestures integration notes (T07 scope-gestures)

This batch owns `gestures.ts`, `gestures.test.ts`, `group-actions.ts`, `gesture-controls.tsx`
and the four `canvas-shell` interaction files. `plugin.tsx` is owned by the presentation
task and already calls the installer below. Do not copy these implementations into the
presentation plugin or `canvas-menu`.

## Install (page scope)

```ts
import { installWorldScopeGestureControls, worldScopeGestureControlsPlugin } from "./gesture-controls.js";

// Inside worldScopesExtension (presentation-owned), before or after the scope panel slot:
const disposeGestures = installWorldScopeGestureControls(ctx, canvasId);
ctx.effect(() => disposeGestures, "world-scope-gesture-controls");
```

Required Cordis services: `slots`, `canvasRuntime`, `canvasRemote`, `canvasSession`,
`canvasEdit`. The plugin factory form for a manifest is:

```ts
{ id: "world-scope-gesture-controls",
  create: (options) => worldScopeGestureControlsPlugin(options.canvasId) }
```

`installWorldScopeGestureControls` does three things:

1. binds `SceneAreaGesturePort` through `currentSceneAreaGestures()`;
2. binds `GroupActionController` through `currentGroupActions()`;
3. registers the visible `canvas.overlay` entry: the gesture status pill. The old top-center
   scene-area control panel and the projected `搬场景` handle were removed; dragging and
   selection stay on the canvas, and the global undo shortcuts/journal own history.

The interaction controller reads `currentSceneAreaGestures()` lazily on every pointer
down. No `canvas-runtime` option wiring is required. For tests/hosts the controller also
accepts `options.sceneAreaGestures` and `controller.setSceneAreaGestures(port)`.

## Pointer contract

`interaction-2d-input.ts` forwards only:

- a `scene-area` node card hit (kept for a future card presentation), or
- an empty-ground pointerdown where `InteractionCore.queryWorldGround` returns a ground
  point and `begin()` decides to start.

`WorldScopeGesturePort`:

```ts
begin(input: {
  point: { x: number; y: number };     // client CSS pixels
  areaNodeId?: string | null;
  card: boolean;
  altKey?: boolean;
  preferredAreaNodeId?: string | null;
  mode?: "auto" | "move" | "resize";
}): { areaNodeId: string; intent: "move" | "resize" } | null;

update(point: { x: number; y: number }): boolean;
end(): Promise<SceneAreaGestureResult>;
cancel(): void;
active(): boolean;
deleteArea(areaNodeId: string, withContents: boolean): Promise<SceneAreaGestureResult>;
undo(): Promise<SceneAreaGestureResult>;
redo(): Promise<SceneAreaGestureResult>;
```

Semantics:

- `auto` (default): area edge → `resize`; interior blank → `null`, so the existing
  `groundClick` + marquee path is never swallowed. Clicking overlapping ground cycles the
  selected area exactly as before.
- `move` (visible Pad entry): anywhere inside the area → move the fixed prepare member set.
- `resize` (visible Pad entry): anywhere inside the area → resize from the nearest edge.
- Explicit `move` / `resize` takes precedence over world-model picking, so the visible
  copy (“在区域内任意位置拖动”) is true even when the pointer is over a world model.
  In `auto`, world-model picking stays first so ordinary model selection is unchanged.
- `Alt` + drag inside the area → resize only, independent of the visible mode.
- Release always goes through `scene-area-prepare` then `scene-area-commit`; the request is
  built from the prepared snapshot only (`buildSceneAreaRequest`), so members cannot be
  recomputed or expanded mid-drag.

## Gesture ownership and release

Scene-area drags now start only from the canvas pointer path:

- `interaction-2d-input.ts` starts a pointer gesture and calls
  `core.claimSceneAreaGesture("pointer")`.
- The controller still exposes `beginSceneAreaGesture(...)` for external hosts, which marks
  the owner `external`; `performFrame` only cancels pointer-owned gestures whose
  `InteractionState` was reset. The in-product `搬场景` handle was removed.
- `controller.endSceneAreaGesture()` / `cancelSceneAreaGesture()` keep the owner until the
  authoritative prepare/commit settles, then release it.

`cancel()` refuses to abort once `end()` has started (prepare, commit or receipt). A quick
release or a slow `scene-area-prepare` therefore still commits; the release frame cannot
turn a real write into “未完成”. While a release is in flight, `begin()` returns `null`
and `ending()` is true, so an older finish can never clear a newer gesture's snapshot.

## Multi-select / group drag

`interaction-2d-input.ts` expands drag origins for **every** selected `workflow-group-2d`
node with its `workflowGroup2d.memberNodeIds` (excluding nested groups and missing nodes).
A mixed selection such as “group + ordinary card” still moves the group's members. The
resulting commit is the existing `planMoveNodes` + page journal path; group furniture is
not a shared-world write.

`group-actions.ts` exposes pure planners consumed by the visible controls:

```ts
planGroupTidy(layout)   // grid the member cards and grow the group in one journal batch
planGroupFit(layout)    // resize/reposition the group around existing members
planGroupMove(layout, delta) // pure whole-group translation
createGroupActions({ getCanvas, writable, edit }) // edit.record(commands, label)
```

These do not patch `workflowGroup2d.memberNodeIds`, do not change model transforms or
camera poses, and are fully undoable through `CanvasEditService.record`.

## Scene-area undo/redo and the page journal

A scene-area commit produces an authoritative receipt. After the verified commit this
module calls `CanvasEditService.recordExternal({ id: "scene-area:<operationId>", ... })`;
the journal stores the authority's own `scene-area-undo` / `scene-area-redo` replay
callbacks. This is the same cursor used by Ctrl+Z, the undo toasts and the visible panel.
A replay only returns `ok:true` when the history receipt matches the same
canvas/operation/direction; failures, cancellations and version conflicts leave the
cursor unchanged. Tests without a page journal keep the bounded
`sceneAreaHistoryStore` fallback. Move/resize and delete both validate
`canvasId` + `operationId` before adoption.

`recordExternal` can still refuse (journal busy, page became read-only, invalid id) even
though the authoritative write already succeeded. That is reported as a recoverable
`warning` on the successful result and as an idle status message; the commit is never
reported as failed, the real authority write is kept, and no synthetic entry is added to
the private fallback stack.

Do not record a scene receipt as a synthetic `edit.apply` command; the authority would
reject it and the journal would advance before the real history result is known.
`world-cameras/plugin.tsx` follows the same rule for camera saves/restores: the inverse
is another verified `world-camera-save`, and the expected settings version only advances
after that receipt succeeds.

## 2D group membership

`planGroupMembership` emits one `nodeData.patch` for `workflowGroup2d.memberNodeIds`
with a fresh scope version. `GroupControls` exposes per-member 移除 and a node picker with
添加成员; both use `CanvasEditService.record`, so add/remove, tidy and fit share the page
undo timeline. Membership rejects nested groups, scene areas and shared-world models
(no cards) and never changes model transforms, camera poses or scene-area authority.

## Known gaps in this batch

- The selected scene area has a projected `搬场景` handle. Its viewport subscription is
  only installed while a scene area is selected; there is no 400 ms polling interval.
  Interior ground presses in `auto` still fall through to marquee/overlap selection.
  Live feedback moves model instances through `controller.setWorldGroundPreview` and the
  area outline through `controller.setSceneAreaPreview`, so move/resize follows the pointer
  before release; the authoritative commit still owns the final bounds.
- Undo/redo is already adopted into the page `CanvasEditService` journal, and group
  membership add/remove already uses `CanvasEditService.record`; these are implemented,
  not gaps. Journal *adoption refusal* is surfaced as the recoverable warning above.
- No real-GPU visual validation was performed in this batch (no usable CDP / hardware
  browser connection). Unit and controller CPU tests only.
