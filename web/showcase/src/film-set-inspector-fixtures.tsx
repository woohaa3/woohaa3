/**
 * 片场检查面板 Showcase 夹具
 * （change: 2026-10-10-improve-film-set-editing-and-inspector，任务 7.1 / showcase-acceptance）。
 *
 * 直接组合**生产**组件，不复制业务 UI：
 * - `ModelEditorOverlay`（生产 shell + 对象/镜头/动画三任务页 + 生成宿主 + 播放器/预览）；
 * - `FilmSetObjectSession` / `ModelEditorSession`（生产会话）；
 * - `FilmSetAdaptationConfirm`（生产当前片段适配确认，单独展示失配态）。
 *
 * 只替换 IO：`canvasSession.submitCommands` 只记录命令，不写 Y.Doc；`canvasRuntime` 为确定性
 * 假运行时；`woohaa3CanvasStore` 写入的是生产公开组合边界。fixtures 覆盖多对象、长名称、
 * 空集合、只读、失配与窄屏。
 */
import { useEffect, useRef, useState } from "react";
// 通过 frontend 再导出的 `Context` 类型（`@deepseek-ai/cordis` 只声明在 frontend 依赖里，
// showcase 自身无法直接解析该包）。
import type { FilmSetContext as Context } from "@woohaa3/extension-film-set/frontend";
import {
  canonicalFilmSetFields,
  createFilmSetSnapshot,
  createEmptyWoohaa3ServerCanvas,
  createModelSnapshot,
  DEFAULT_FILM_SET_PLAYBACK,

  COMPOSITE_ASSET_NODE_TYPE,
  FILM_SET_EXTENSION_ID,
  type FilmSetNodeData,
  type CanvasCommand,
  type FilmSetAnimationClip,
  type FilmSetContent,
  type FilmSetItem,
  type FilmSetModelItem,
  type ServerCanvas
} from "@woohaa3/contracts";
import { CompositeAssetRegistry } from "../../frontend/src/extension-api/composite-assets.js";
import { ModelEditorToolbar } from "../../frontend/src/cordis/plugins/model-editor/model-editor-toolbar.js";
import { RuntimeProvider } from "../../frontend/src/cordis/react.js";
import { FilmSetObjectSession } from "@woohaa3/extension-film-set/shared";
import { ModelEditorSession } from "../../frontend/src/extension-api/model-workspace-session.js";
import { FilmSetInspector, FilmSetAdaptationConfirm, FilmSetPlaybackService } from "@woohaa3/extension-film-set/frontend";

const NOW = "2026-10-10T00:00:00.000Z";

function modelItem(id: string, name: string, color: string): FilmSetModelItem {
  return {
    id,
    kind: "model",
    name,
    localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 },
    model: createModelSnapshot({ modelScript: `scene.box({id:'${id}',size:[1.4,1.4,1.4],color:'${color}'});`, modelScriptVersion: "woohaa-model-js-v2" })
  };
}

function groundItem(name = "地面"): FilmSetItem {
  return { id: "ground", kind: "ground", name, localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }, size: { width: 8, depth: 8 } };
}

export type FilmSetInspectorFixtureId = "mixed" | "longName" | "empty" | "adaptation";

/** 生产画布：一个复合资产（片场）节点，按 fixture 决定内部对象集合与适配状态。 */
export function filmSetInspectorCanvas(id: FilmSetInspectorFixtureId): {
  canvas: ServerCanvas;
  content: FilmSetContent;
  clipId: string | null;
} {
  const mixed: FilmSetItem[] = [modelItem("a", "角色 A", "#e23b3b"), modelItem("b", "角色 B", "#3b6fe2"), groundItem()];
  const longName: FilmSetItem[] = [modelItem("a", "非常长的中文对象名称用于验证截断与完整可读", "#2f9e44"), groundItem("这是一个非常长的大地面名称")];
  const items = id === "empty" ? [] : id === "longName" ? longName : mixed;

  const base = createFilmSetSnapshot({
    title: "检查面板片场",
    timeline: { duration: 5, loop: false }
  });

  let animation: FilmSetNodeData = { ...base, filmSetContent: { schemaVersion: 4, items } };
  // 适配 fixture：首对象 binding 的动作基于过期内容版本 → 失配。
  if (id === "adaptation" && animation.filmSetContent.items[0]?.kind === "model") {
    const item = animation.filmSetContent.items[0] as FilmSetModelItem;
    const clipBase = createFilmSetSnapshot({ title: "", modelSnapshot: item.model, modelItemId: item.id, motionScript: "motion.model.rotate('a', { speed: 1 });", timeline: { duration: 5, loop: false } }).filmSetAnimations!.clips[0]!;
    const motion = clipBase.bindings[0]!.motion!;
    const clip: FilmSetAnimationClip = { ...clipBase, bindings: [{ itemId: item.id, motion: { ...motion, basedOnModelVersion: { ...motion.basedOnModelVersion, revision: 99, contentHash: "stale-hash" } }, playback: { ...DEFAULT_FILM_SET_PLAYBACK, duration: clipBase.timeline.duration } }] };
    animation = { ...animation, filmSetAnimations: { schemaVersion: 3, defaultClipId: clip.id, clips: [clip] } };
  }

  const canvasBase = createEmptyWoohaa3ServerCanvas("showcase-film-set", NOW);
  const canvas = {
    ...canvasBase,
    revision: 1,
    document: {
      ...canvasBase.document,
      nodes: [{ id: "film", type: COMPOSITE_ASSET_NODE_TYPE, position: { x: 0, y: 0 }, width: 320, height: 240 }]
    },
    nodeData: { film: { extensionId: FILM_SET_EXTENSION_ID, ...canonicalFilmSetFields(animation) } }
  } as unknown as ServerCanvas;

  const clipId = animation.filmSetAnimations?.defaultClipId ?? null;
  return { canvas, content: animation.filmSetContent, clipId };
}

/** 生产 overlay 所需的确定性假服务；`submitCommands` 只记录，不写网络/持久层。 */
function fakeContext(submitted: CanvasCommand[], writable: boolean, readOnly: boolean, canvas: ServerCanvas): Context {
  const NAV_SNAPSHOT = { mode: { type: "overview" }, panel: null, menu: null };
  return {
    canvasState: { getCanvas: () => canvas, getWorkingCanvas: () => canvas, subscribe: () => () => undefined },
    compositeAssets: new CompositeAssetRegistry(),
    filmSetPlayback: new FilmSetPlaybackService(),
    slots: { subscribe: () => () => undefined, version: () => 0, list: () => [] },
    canvasNavigation: {
      subscribe: () => () => undefined,
      getSnapshot: () => NAV_SNAPSHOT,
      openDialog: () => ({ ok: true })
    },
    canvasRuntime: {
      modelFocusMode: () => (readOnly ? "history" : "edit"),
      runtime: () => ({ isReady: () => true }),
      controller: () => ({ viewport: () => ({ x: 0, y: 0, zoom: 1 }), surface: () => ({ width: 1000, height: 800 }), focusProjection: () => null }),
      exitModelFocus: () => undefined,
      animationPlaybackState: () => null
    },
    canvasSession: {
      isWritable: () => writable,
      submitCommands: (commands: CanvasCommand[]) => {
        submitted.push(...commands);
        return { ok: true, handle: { settled: Promise.resolve({ state: "committed", error: null }) } };
      }
    }
  } as unknown as Context;
}

export type FilmSetInspectorStageProps = {
  fixtureId: FilmSetInspectorFixtureId;
  /** 初始选中项（null = 无选中）。 */
  selectedItemId?: string | null;
  writable?: boolean;
  readOnly?: boolean;
  width?: number;
};

/**
 * 生产 `FilmSetInspector` 舞台（镜头与对象单栏 + 独立生成宿主）。挂载时写入画布 store，
 * 卸载时清空。构图展开与对象选择只修改本地状态。
 */
export function FilmSetInspectorStage({ fixtureId, selectedItemId = null, writable = true, readOnly = false, width = 380 }: FilmSetInspectorStageProps) {
  const [{ canvas, content }] = useState(() => filmSetInspectorCanvas(fixtureId));
  const submittedRef = useRef<CanvasCommand[]>([]);
  const [submittedCount, setSubmittedCount] = useState(0);
  // 稳定 ctx：submitCommands 记录到 ref 并触发计数刷新。
  const [ctx] = useState(() => fakeContext(submittedRef.current, writable, readOnly, canvas));
  const [objectSession] = useState(() => new FilmSetObjectSession({
    readContent: () => content,
    isWritable: () => writable,
    submitItemOp: ({ op }) => {
      submittedRef.current.push({ type: "filmSet.itemPatch", nodeId: "film", itemId: selectedItemId ?? "", op } as CanvasCommand);
      setSubmittedCount(submittedRef.current.length);
      return true;
    }
  }));
  const [session] = useState(() => new ModelEditorSession({ readCameras: () => [], isWritable: () => writable, submitCameras: () => true }));

  // submitCommands 记录到 ref（含适配/镜头/片段路径）并触发计数刷新。
  useEffect(() => {
    (ctx.canvasSession as unknown as { submitCommands: (commands: CanvasCommand[]) => unknown }).submitCommands = (commands: CanvasCommand[]) => {
      submittedRef.current.push(...commands);
      setSubmittedCount(submittedRef.current.length);
      return { ok: true, handle: { settled: Promise.resolve({ state: "committed", error: null }) } };
    };
  }, [ctx]);

  useEffect(() => {
    objectSession.enter("film");
    if (selectedItemId) objectSession.select(selectedItemId);
    session.enter("film");
    return () => {
      objectSession.exit();
      session.exit();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvas, objectSession, session, selectedItemId]);

  ctx.modelWorkspace = {
    session, captureSession: {} as never,
    defaultDistance: () => 5, addCamera: () => undefined, capture: async () => undefined,
    acquireCapture: async () => () => undefined, refreshGizmo: () => undefined,
    renderCameraPreview: () => null,
    renderGenerate: () => null,
    renderCameraPanel: input => <ModelEditorToolbar {...input} session={session} onAddCamera={() => undefined} onCapture={() => undefined} />
  };
  const runtime = { ctx, subscribe: () => () => undefined, status: () => ({ phase: "ready", error: null }) };
  return (
    <div className="showcase__stage">
      <div className="showcase__frame" style={{ width, maxWidth: "100%", position: "relative", height: 460 }}>
        <RuntimeProvider runtime={runtime as never}>
          <FilmSetInspector ctx={ctx} session={session} objectSession={objectSession} captureSession={{} as never} writable={writable && !readOnly} canvasId="showcase-film-set" />
        </RuntimeProvider>
      </div>
      <output className="showcase__log" data-testid="film-set-submitted" data-count={submittedCount}>{`command ×${submittedCount}`}</output>
    </div>
  );
}

/** 单独展示生产适配确认组件（失配态）。 */
export function FilmSetAdaptationStage({ width = 380 }: { width?: number }) {
  const [{ canvas, clipId }] = useState(() => filmSetInspectorCanvas("adaptation"));
  const [submitted, setSubmitted] = useState<CanvasCommand[]>([]);
  const ctx = fakeContext([], true, false, canvas);
  ctx.canvasSession.submitCommands = ((commands: CanvasCommand[]) => { setSubmitted(c => [...c, ...commands]); return { ok: true, handle: { settled: Promise.resolve({ state: "committed", error: null }) } }; }) as never;
  return (
    <div className="showcase__stage">
      <div className="showcase__frame" style={{ width, maxWidth: "100%" }}>
        <FilmSetAdaptationConfirm ctx={ctx} nodeId="film" itemId="a" clipId={clipId} writable />
      </div>
      <output className="showcase__log" data-testid="film-set-submitted" data-count={submitted.length}>{`command ×${submitted.length}`}</output>
    </div>
  );
}
