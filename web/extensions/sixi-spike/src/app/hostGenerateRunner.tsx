/**
 * 执行首页「生成」留下的交接:在新画布里建一个图片 / 视频节点,把参考图连上去,提交一次生成。
 *
 * 这与画布内那个生成面板提交的是**同一条链路**(`canvasRemote.run` → `POST /api/canvases/:id/runs`),
 * 不是 Agent 的「用 AI 创作」—— 后者建的是创作组,交给助手自己搭节点,是另一件事。
 *
 * 步骤与面板一致(见宿主 `model-execution-host.tsx` / `submit-coordinator.ts`):
 * 1. 参考图先作为图片节点落到画布上(`planUploadedNode` 一批提交),
 * 2. 再建目标节点,
 * 3. 用**连线**把参考图接到目标节点上(角色由服务端按图像来源推断为 `reference_image`,
 *    运行请求体里没有参考图字段),
 * 4. 参数 = 目录默认值 + 用户在首页改过的项,
 * 5. 提交运行。
 *
 * **每次提交命令都要等 `settled`**:运行服务端是从权威画布解析节点的,连线还没落盘就提交
 * 会得到 `unknown-node`。
 *
 * 这些服务都是画布页作用域的,而外壳在应用作用域,所以由调用方传一个懒取函数,
 * 轮询到全部就绪且会话可写再动手。
 */
import { useEffect, useState } from "react";
import {
  buildUploadedAsset,
  planUploadedNode,
  projectModelConfig,
  type CanvasCommandsService,
  type CanvasRemoteService,
  type CanvasScopeService,
  type CanvasLocateService,
  type CanvasSession,
  type TaskCatalogService
} from "@woohaa3/frontend/extension-api";
import type { CanvasCommand } from "@woohaa3/contracts";
import { takeHandoff, type GenerateHandoff } from "./hostGenerateHandoff";

/** 画布页作用域的服务;任何一个拿不到就还没就绪 */
export type GenerateServices = {
  scope?: CanvasScopeService;
  session?: CanvasSession;
  commands?: CanvasCommandsService;
  remote?: CanvasRemoteService;
  catalog?: TaskCatalogService;
  locate?: CanvasLocateService;
};

type ReadyServices = Required<GenerateServices>;

const POLL_MS = 250;
/** 画布冷启动(同步、渲染器)通常几秒;再久基本是卡住了 */
const WAIT_MS = 30_000;

/** 参考图节点与目标节点的排布(画布世界坐标) */
const IMAGE_STEP_X = 360;
const TARGET_GAP_Y = 420;

function ready(s: GenerateServices): s is ReadyServices {
  return Boolean(s.scope && s.session && s.commands && s.remote && s.catalog);
}

function commandId(label: string): string {
  return `sixi-${label}-${crypto.randomUUID()}`;
}

/** 提交一批命令并等它落盘;失败抛错,由调用方提示 */
async function submitAndSettle(
  services: ReadyServices,
  commands: readonly CanvasCommand[],
  label: string
): Promise<void> {
  const result = services.commands.submit(commands, commandId(label));
  if (!result.ok) throw new Error(result.reason || "画布当前不可写");
  const settled = await result.handle.settled;
  if (settled.error) throw new Error(settled.error);
}

async function run(handoff: GenerateHandoff, services: ReadyServices): Promise<void> {
  const canvasId = services.scope.canvasId();

  // 1. 参考图:上传后作为图片节点落到画布(与右键「上传」同一条命令)
  const imageIds: string[] = [];
  const now = new Date().toISOString();
  if (handoff.images.length > 0) {
    const commands = handoff.images.flatMap((image, i) => {
      const nodeId = `node-ref-${crypto.randomUUID()}`;
      imageIds.push(nodeId);
      const file = { name: image.name, type: image.media.contentType, size: image.media.size };
      return planUploadedNode({
        nodeType: "image",
        position: { x: i * IMAGE_STEP_X, y: 0 },
        file,
        asset: buildUploadedAsset({ media: image.media, mediaKind: "image", file, now }),
        nodeId
      });
    });
    await submitAndSettle(services, commands, "refs");
  }

  // 2. 目录里取模型:用户选的优先,否则取该类型的默认模型
  if (services.catalog.getState().status !== "ready") await services.catalog.load();
  const state = services.catalog.getState();
  if (state.status !== "ready") throw new Error("读不到模型目录,请稍后再试");
  const catalog = state.catalog;
  const models = catalog.models.filter((m) => m.modelType === handoff.kind);
  const model = handoff.modelKey ? models.find((m) => m.modelKey === handoff.modelKey) : undefined;
  const fallbackKey = catalog.defaultModels[handoff.kind];
  const picked =
    model ??
    models.find((m) => m.modelKey === fallbackKey) ??
    models[0];
  // 选过的模型后来没了:明说,不悄悄换成别的 —— 用户选的是具体模型
  if (handoff.modelKey && !model) throw new Error("所选模型已不在目录中,请回首页重新选择");
  if (!picked) throw new Error("模型目录里没有可用的图片 / 视频模型");

  // 3. 目标节点
  const targetId = `node-gen-${crypto.randomUUID()}`;
  await submitAndSettle(
    services,
    [
      {
        type: "node.add",
        node: {
          id: targetId,
          type: picked.modelType,
          position: { x: 0, y: imageIds.length > 0 ? TARGET_GAP_Y : 0 }
        }
      }
    ],
    "target"
  );

  // 4. 连线:参考图 → 目标节点。角色与槽位由服务端在同一批提交里补全
  if (imageIds.length > 0) {
    await submitAndSettle(
      services,
      imageIds.map((source) => ({
        type: "edge.add" as const,
        edge: { id: `edge-${source}-${targetId}`, source, target: targetId }
      })),
      "refs-wire"
    );
  }

  // 5. 参数:目录默认值,叠上用户在首页改过的项(只认目录里声明过的 key)
  const config = projectModelConfig(models, picked.modelKey, picked.modelKey);
  const defaults = config.defaultsByModel[picked.modelKey] ?? {};
  const allowed = new Set((config.parameterSchemaByModel[picked.modelKey] ?? []).map((f) => f.key));
  const parameters: Record<string, unknown> = { ...defaults };
  for (const [key, value] of Object.entries(handoff.params ?? {})) {
    if (allowed.has(key)) parameters[key] = value;
  }
  parameters.model = picked.modelKey;

  // 6. 提交运行
  const runId = `run-${crypto.randomUUID()}`;
  const result = await services.remote.run({
    nodeId: targetId,
    runId,
    jobId: `job-${runId}`,
    modelKey: picked.modelKey,
    prompt: handoff.prompt,
    parameters
  });
  if (!result.ok) throw new Error(result.error);

  // 7. 把视图落到新节点上(纯呈现;失败不影响任务)
  try {
    services.locate?.locateNodes([targetId], { select: true });
  } catch {
    /* 定位是锦上添花 */
  }
}

/**
 * 挂在外壳里,进入画布态后执行一次交接。
 *
 * 交接在模块里持有(而不是每次 effect 都去读 sessionStorage):`takeHandoff` 读后即清,
 * 外壳在 node-focus 切换或严格模式下会重挂,effect 被取消后第二轮若再去读就拿不到了。
 * `undefined` = 还没读过;`null` = 已经执行完或没有交接。
 */
let pending: GenerateHandoff | null | undefined;

export function HostGenerateRunner({ getServices }: { getServices: () => GenerateServices }) {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (pending === undefined) pending = takeHandoff();
    const handoff = pending;
    if (!handoff) return;

    let cancelled = false;
    const deadline = Date.now() + WAIT_MS;
    const tick = async () => {
      if (cancelled) return;
      const services = getServices();
      // 画布 id 对上、会话可写才动手:交接里记的是新建的那张,别写到别的画布上
      if (ready(services) && services.scope.canvasId() === handoff.canvasId && services.session.isWritable()) {
        pending = null; // 开始执行即视为用掉,重挂不会再提交第二次
        try {
          await run(handoff, services);
        } catch (e) {
          if (!cancelled) setError(e instanceof Error ? e.message : "创建任务失败");
        }
        return;
      }
      if (Date.now() > deadline) {
        pending = null;
        if (!cancelled) setError("画布加载超时,任务没有创建,请回首页重试");
        return;
      }
      setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
    };
  }, [getServices]);

  if (!error) return null;
  // 不用宿主 toast(扩展没有公开入口):一条固定在画布顶栏下方的提示,点一下消失
  return (
    <div
      role="alert"
      onClick={() => setError(null)}
      style={{
        position: "fixed",
        top: 64,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 1000,
        padding: "8px 16px",
        borderRadius: 8,
        background: "var(--sixi-danger-bg, #fff1f0)",
        color: "var(--sixi-danger, #cf1322)",
        border: "1px solid currentColor",
        cursor: "pointer"
      }}
    >
      {error}(点击关闭)
    </div>
  );
}
