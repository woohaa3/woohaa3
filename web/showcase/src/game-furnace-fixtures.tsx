import { useMemo, useState } from "react";
import { GameFurnaceWorkspace, type GameFurnaceWorkspaceProps } from "@woohaa3/extension-game-furnace/frontend";
import { createGameFurnaceState, type GameFurnaceState } from "@woohaa3/extension-game-furnace/shared";
import { createGameFurnaceNodeData } from "@woohaa3/extension-game-furnace/geometry";

export type FurnaceFixtureState = "empty" | "materials" | "readonly" | "no-model" | "running" | "failed" | "candidate" | "playable" | "invalid";

/** Production workspace; only Canvas/Media/Task transport is an in-memory fixture. */
export function FurnaceFixture({ state: mode = "empty", narrow = false }: { state?: FurnaceFixtureState; narrow?: boolean }) {
  const [events, setEvents] = useState<string[]>([]);
  const props = useMemo(() => {
    let state = createGameFurnaceState("showcase-project") as GameFurnaceState;
    state.requirements = { name: "收集星星", description: "点击收集星星，累计得分后重新开始。", modelKey: "showcase-language" };
    if (mode !== "empty") state.resources = [
      { resourceId: "text", kind: "text", name: "玩法参考", category: "文本", description: "完整文本参考", payload: { kind: "text", assetIds: [], snapshot: { text: "点击星星获得一分。" } } },
      { resourceId: "unknown", kind: "unknown", name: "关卡数据.bin", category: "未知文件", description: "已保留原件，暂无可用预览", metadata: { mime: "application/octet-stream", size: 2048 }, payload: { kind: "opaque", assetIds: [], snapshot: { type: "future-format" } } }
    ];
    const build = { buildId: "showcase-build", generationId: "showcase-generation", inputHash: "showcase-input", manifestAssetId: "manifest", sourceAssetId: "source", dependencyAssetIds: [], sourceHash: "source-hash", policyVersion: "game-furnace/v1", createdAt: "2026-10-11T00:00:00.000Z", title: "收集星星", controlsSummary: "点击星星", resources: [] };
    if (["candidate", "playable", "readonly"].includes(mode)) state.builds = [build];
    if (["playable", "readonly"].includes(mode)) state.activeBuildId = build.buildId;
    if (["running", "failed", "candidate"].includes(mode)) {
      state.latestGenerationId = "showcase-generation";
      state.generations = [{ generationId: "showcase-generation", inputHash: "showcase-input", workerTaskKey: "showcase-task", admittedAt: build.createdAt,
        ...(mode === "failed" ? { disposition: "failed" as const } : {}),
        ...(mode === "candidate" ? { disposition: "candidate" as const, candidateBuildId: build.buildId } : {}) }];
    }
    let canvas = { id: "showcase-canvas", document: { nodes: [{ id: "furnace", type: "extension3d" }] }, nodeData: { furnace: { ...createGameFurnaceNodeData(), projectStorageKey: "showcase-project" } } };
    const listeners = new Set<() => void>();
    const catalog = { status: "ready", catalog: { available: true, models: mode === "no-model" ? [] : [{ modelKey: "showcase-language", modelType: "language", title: "示例语言模型" }], defaultModels: {} } };
    const log = (event: string) => setEvents(events => [...events.slice(-7), event]);
    return {
      writable: mode !== "readonly", nodeId: "furnace", onBack: () => log("返回画布"), onConfigureModels: () => log("打开模型配置"),
      canvasState: { getCanvas: () => canvas, getWorkingCanvas: () => canvas, subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); } },
      commands: { isWritable: () => mode !== "readonly", submit: (commands: { value?: object }[]) => { canvas = { ...canvas, nodeData: { furnace: { ...canvas.nodeData.furnace, ...commands[0]?.value } } }; listeners.forEach(fn => fn()); log("保存画布关联"); return { ok: true, handle: {} }; } },
      remote: { transport: { request: async (request: { path: string; body: Record<string, unknown> }) => {
        log(request.path.split("/").at(-1) ?? "请求");
        if (mode === "invalid") return { ok: false, code: "unsupported-version", error: "项目版本不受支持，原件已保留" };
        if (request.path.endsWith("preview-open")) return { ok: true, status: 200, data: { ok: true, sessionId: "showcase-preview", expiresAt: Date.now() + 30 * 60 * 1000,
          html: '<!doctype html><html lang="zh"><body><button id="star">⭐ 收集星星</button><p id="score">0</p><script>let score=0;document.getElementById("star").onclick=()=>document.getElementById("score").textContent=++score</script></body></html>' } };
        if (request.path.endsWith("preview-close")) return { ok: true, status: 200, data: { ok: true } };
        if (request.path.endsWith("project-save")) state = request.body.state as GameFurnaceState;
        if (request.path.endsWith("activate-build")) state = { ...state, activeBuildId: String(request.body.buildId) };
        return { ok: true, status: 200, data: { ok: true, projectStorageKey: "showcase-project", inputHash: "showcase-input", state,
          ...(request.path.endsWith("activate-build") ? { activeBuildId: state.activeBuildId } : {}),
          ...(request.path.endsWith("generation-status") || request.path.endsWith("finalize") ? { state: mode === "failed" ? "failed" : "running", message: mode === "failed" ? "示例任务失败，可重试" : undefined } : {}) } };
      } } },
      mediaRemote: { upload: async () => ({ ok: false, error: "组件示例不提供文件存储" }), urlFor: (key: string) => `/api/media/${key}`, isAllowedUrl: () => true, resolveCanonicalUrl: () => null },
      taskCatalog: { getState: () => catalog, subscribe: () => () => undefined, load: async () => undefined }
    } as unknown as GameFurnaceWorkspaceProps;
  }, [mode]);
  return <div style={{ width: narrow ? 390 : "100%", maxWidth: "100%", height: 850, position: "relative", overflow: "auto" }}>
    <GameFurnaceWorkspace {...props} />
    <details style={{ position: "absolute", bottom: 0, right: 0 }}><summary>示例调用记录</summary><pre>{events.join("\n")}</pre></details>
  </div>;
}
