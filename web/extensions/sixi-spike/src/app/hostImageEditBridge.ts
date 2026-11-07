/**
 * 「独立编辑 · 局部修改」的宿主实现。
 *
 * 和对话框生图(「添加到对话框」)是**同一个机制**:结果落回**原来的那张卡片**,旧图进卡片右边的版本圆点,
 * 画布上不新增节点、也没有额外的连线。具体做法与宿主 `hover-composer-button.tsx` 一致:
 * 把一张图记成这张卡片的「自带主图」(`selfReferenceAssetId`),再对这张卡片 `canvasRemote.run`。
 * 区别只是这里记的不是卡片当前的图,而是**裁切后的那一块**(已画好红框)。
 *
 * 提交时运行服务端就把「自带主图」与入边解析成任务输入并记进输入快照,所以提交成功后立刻还原
 * (`selfReferenceAssetId: ""`),不会在卡片的对话框里留下一个多余的参考图。
 *
 * 拼合(把生成的那一块按选区贴回原图)在四喜侧的浏览器里做(`features/imageEdit`),
 * 这里负责:提交、等结果、把完整图写回卡片。用户加的参考图要作为节点接进来(映射与入边一一对应),
 * 这几个临时节点在写回完整图后清掉。
 *
 * **完整图怎么写回**:宿主的版本历史只登记「生成任务的结果」,直接改卡片的输出,版本条会继续预览
 * 上一个生成结果(拼合图不在条里)。所以优先让完整图走一次本地的「直通」生成(宿主 ppserver 扩展里的
 * 内部模板,原样返回图片、不调 ppserver、不扣积分),它就成为最新的版本并被自动选中。
 * 直通模板不可用时才退回直接替换输出(见 `commit`)。
 *
 * 画布页作用域的服务由调用方传一个懒取函数(渲染时它们可能还没起来)。
 */
import {
  buildUploadedAsset,
  planReplaceImage,
  planUploadedNode,
  projectModelConfig,
  type CanvasCommandsService,
  type CanvasLocateService,
  type CanvasRemoteService,
  type CanvasScopeService,
  type CanvasSession,
  type CanvasStoreFacade,
  type MediaRemoteService,
  type TaskCatalogService
} from "@woohaa3/frontend/extension-api";
import { SELF_REFERENCE_ASSET_FIELD, type CanvasCommand, type CanvasNodeData } from "@woohaa3/contracts";
import type {
  HostImageEditBridge,
  HostImageEditCommitInput,
  HostImageEditCommitted,
  HostImageEditFinished,
  HostImageEditInput,
  HostImageEditJob,
  HostImageEditModel,
  HostImageEditPrepared,
  HostImageEditStarted
} from "@/app/hostImageEdit";
import { isRunning, judgeRun, type NodeRunSnapshot } from "@/features/imageEdit/model/runState";

export type ImageEditServices = {
  scope?: CanvasScopeService;
  session?: CanvasSession;
  commands?: CanvasCommandsService;
  remote?: CanvasRemoteService;
  catalog?: TaskCatalogService;
  locate?: CanvasLocateService;
  store?: CanvasStoreFacade;
  media?: MediaRemoteService;
};

type Ready = Required<ImageEditServices>;

/** 参考图临时节点放在原卡片右侧,逐个往下排(画布世界坐标) */
const GAP_X = 120;
const STEP_Y = 360;
const DEFAULT_NODE_WIDTH = 320;
/** 等一次生成的上限;图像模型通常几十秒 */
const RESULT_TIMEOUT_MS = 10 * 60 * 1000;
/** 写回完整图后回读确认的上限:投影可能晚一拍才生效 */
const VERIFY_TIMEOUT_MS = 5_000;
/** 直通生成不调模型,只下载一张图;给得宽一点但不能无限等 */
const COMPOSE_TIMEOUT_MS = 90_000;
/** 完整图要连续稳定这么久才算写好 */
const STABLE_MS = 3_000;
const POLL_MS = 600;
const VERIFY_POLL_MS = 250;
/** 没读到模型时的保守参考图上限 / 目录里模型能接的上限封顶 */
const FALLBACK_MAX_REFERENCES = 4;
const MAX_REFERENCES_CAP = 8;

function ready(s: ImageEditServices): s is Ready {
  return Boolean(s.scope && s.session && s.commands && s.remote && s.catalog && s.store && s.media);
}

function id(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 提交一批命令并等它落盘;失败抛错。运行服务端从权威画布解析节点,连线没落盘就提交会得到 `unknown-node` */
async function submitAndSettle(services: Ready, commands: readonly CanvasCommand[], label: string): Promise<void> {
  const result = services.commands.submit(commands, id(`sixi-edit-${label}`));
  if (!result.ok) throw new Error(result.reason || "画布当前不可写");
  const settled = await result.handle.settled;
  if (settled.error) throw new Error(settled.error);
}

/** 内部直通模板的运营分类(与 ppserver 扩展的 passthrough.ts 一致);用户的模型下拉里不展示它 */
const INTERNAL_CATEGORY = "sixi-internal";

function isInternal(model: { capabilities?: Record<string, unknown> }): boolean {
  return model.capabilities?.category === INTERNAL_CATEGORY;
}

function nodeData(services: Ready, nodeId: string): NodeRunSnapshot | undefined {
  return services.store.getCanvas()?.nodeData[nodeId] as NodeRunSnapshot | undefined;
}

/** 原卡片右侧的位置,参考图临时节点从这里往下排;读不到按原点算,不因此拒绝 */
function originOf(services: Ready, sourceNodeId: string): { x: number; y: number } {
  const node = services.store.getCanvas()?.document.nodes.find((n) => n.id === sourceNodeId);
  const width = typeof node?.width === "number" ? node.width : DEFAULT_NODE_WIDTH;
  return { x: (node?.position?.x ?? 0) + width + GAP_X, y: node?.position?.y ?? 0 };
}

async function uploadAsset(services: Ready, file: File) {
  const uploaded = await services.media.upload({ file, canvasId: services.scope.canvasId() });
  if (!uploaded.ok) throw new Error(`「${file.name}」上传失败:${uploaded.error}`);
  const info = { name: file.name, type: file.type || "image/png", size: file.size };
  return {
    info,
    asset: buildUploadedAsset({ media: uploaded.media, mediaKind: "image", file: info, now: new Date().toISOString() })
  };
}

/** 设置 / 还原卡片的「自带主图」。空串 = 还原(宿主约定,见 model-execution-host-helpers) */
function selfReferencePatch(nodeId: string, assetId: string): CanvasCommand {
  return {
    type: "nodeData.patch",
    nodeId,
    value: { [SELF_REFERENCE_ASSET_FIELD]: assetId } as unknown as CanvasNodeData
  };
}

async function removeNodes(services: Ready, nodeIds: readonly string[]): Promise<void> {
  if (nodeIds.length === 0) return;
  try {
    await submitAndSettle(services, [{ type: "node.remove", nodeIds }], "cleanup");
  } catch {
    /* 清理是尽力而为:留下几个临时节点不比丢掉用户的结果更糟 */
  }
}

async function restoreSelfReference(services: Ready, nodeId: string): Promise<void> {
  try {
    await submitAndSettle(services, [selfReferencePatch(nodeId, "")], "self-ref-clear");
  } catch {
    /* 还原失败只会在卡片对话框里多一个参考图,用户可以手动移除;不能因此丢掉已经提交的任务 */
  }
}

/** 等这张卡片上「基线之后」的那次生成出结果(或失败) */
async function waitForVerdict(
  services: Ready,
  nodeId: string,
  baseline: NodeRunSnapshot,
  signal: AbortSignal,
  timeoutMs: number
): Promise<{ ok: true; assetId: string } | { ok: false; error: string }> {
  const deadline = Date.now() + timeoutMs;
  while (!signal.aborted) {
    const verdict = judgeRun(baseline, nodeData(services, nodeId));
    if (verdict.state === "failed") return { ok: false, error: verdict.error };
    if (verdict.state === "done") return { ok: true, assetId: verdict.assetId };
    if (Date.now() > deadline) return { ok: false, error: "等待超时" };
    await sleep(POLL_MS);
  }
  return { ok: false, error: "已取消" };
}

/** 把拼合图当作一次本地「生成」写回卡片:记成自带主图 → 对卡片提交直通模型 → 还原 → 等结果 */
async function composeViaPassthrough(
  services: Ready,
  sourceId: string,
  asset: { id: string },
  modelKey: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  let selfReferenceSet = false;
  try {
    const before = nodeData(services, sourceId);
    const baseline: NodeRunSnapshot = {
      ...(before?.outputAssetId !== undefined ? { outputAssetId: before.outputAssetId } : {}),
      ...(before?.taskStatus !== undefined ? { taskStatus: before.taskStatus } : {}),
      ...(before?.errorMessage !== undefined ? { errorMessage: before.errorMessage } : {}),
      ...(before?.error !== undefined ? { error: before.error } : {})
    };
    await submitAndSettle(
      services,
      [{ type: "asset.upsert", asset: asset as never }, selfReferencePatch(sourceId, asset.id)],
      "compose-self-ref"
    );
    selfReferenceSet = true;
    const runId = id("run");
    const accepted = await services.remote.run({
      nodeId: sourceId,
      runId,
      jobId: `job-${runId}`,
      modelKey,
      prompt: "合成",
      parameters: { model: modelKey }
    });
    if (!accepted.ok) throw new Error(accepted.error);
    await restoreSelfReference(services, sourceId);
    selfReferenceSet = false;
    const outcome = await waitForVerdict(services, sourceId, baseline, new AbortController().signal, COMPOSE_TIMEOUT_MS);
    return outcome.ok ? { ok: true } : outcome;
  } catch (e) {
    if (selfReferenceSet) await restoreSelfReference(services, sourceId);
    return { ok: false, error: e instanceof Error ? e.message : "直通生成失败" };
  }
}

export function createHostImageEditBridge(getServices: () => ImageEditServices): HostImageEditBridge {
  let maxReferences = FALLBACK_MAX_REFERENCES;

  const requireReady = (): Ready => {
    const services = getServices();
    if (!ready(services)) throw new Error("画布还没准备好,请稍后再试");
    if (!services.session.isWritable()) throw new Error("画布当前不可写");
    return services;
  };

  return {
    async prepare(): Promise<HostImageEditPrepared> {
      const services = getServices();
      if (!services.catalog) return { ok: false, error: "读不到模型目录,请稍后再试" };
      try {
        if (services.catalog.getState().status !== "ready") await services.catalog.load();
      } catch {
        return { ok: false, error: "读不到模型目录,请稍后再试" };
      }
      const state = services.catalog.getState();
      if (state.status !== "ready") return { ok: false, error: "读不到模型目录,请稍后再试" };
      const { catalog } = state;
      // 主图要能接:至少有一个参考输入槽位的图片模型。默认模型优先
      const candidates = catalog.models.filter((m) => m.modelType === "image" && m.bindings.length > 0 && !isInternal(m));
      const picked = candidates.find((m) => m.modelKey === catalog.defaultModels.image) ?? candidates[0];
      if (!picked) return { ok: false, error: "模型目录里没有可用的图片模型" };

      const config = projectModelConfig(catalog.models, picked.modelKey, picked.modelKey);
      const aspectField = (config.parameterSchemaByModel?.[picked.modelKey] ?? []).find(
        (f) => f.semantic === "aspect-ratio" && Array.isArray(f.options) && f.options.length > 0
      );
      const model: HostImageEditModel = {
        modelKey: picked.modelKey,
        label: picked.title,
        ...(aspectField ? { aspectKey: aspectField.key } : {}),
        aspectOptions: (aspectField?.options ?? []).map((o) => o.value).filter((v) => v !== aspectField?.adaptiveValue)
      };
      // 第一个槽位是主图(裁切图),其余是参考图
      const slots = picked.bindings.reduce((sum, b) => sum + (b.maxItems ?? 1), 0);
      maxReferences = Math.max(0, Math.min(MAX_REFERENCES_CAP, slots - 1));
      return { ok: true, model };
    },

    async start(input: HostImageEditInput): Promise<HostImageEditStarted> {
      let services: Ready;
      try {
        services = requireReady();
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "画布还没准备好" };
      }
      const sourceId = input.sourceNodeId;
      const before = nodeData(services, sourceId);
      if (!before?.outputAssetId) return { ok: false, error: "这张图片还没有可编辑的内容" };
      if (isRunning(before)) return { ok: false, error: "这张图片正在生成中,请等它完成后再编辑" };
      const baseline = {
        outputAssetId: before.outputAssetId,
        ...(before.taskStatus !== undefined ? { taskStatus: before.taskStatus } : {}),
        ...(before.errorMessage !== undefined ? { errorMessage: before.errorMessage } : {}),
        ...(before.error !== undefined ? { error: before.error } : {})
      };

      const helperNodeIds: string[] = [];
      let selfReferenceSet = false;
      try {
        const origin = originOf(services, sourceId);

        // 1. 裁切图只登记成资产(不建节点);参考图作为图片节点落到原卡片右侧
        const crop = await uploadAsset(services, new File([input.image], "crop.png", { type: "image/png" }));
        const refIds = input.referenceFiles.map(() => id("node-edit-ref"));
        const refCommands: CanvasCommand[] = [];
        for (const [i, file] of input.referenceFiles.entries()) {
          const uploaded = await uploadAsset(services, file);
          refCommands.push(
            ...planUploadedNode({
              nodeType: "image",
              position: { x: origin.x, y: origin.y + i * STEP_Y },
              file: uploaded.info,
              asset: uploaded.asset,
              nodeId: refIds[i]!
            })
          );
        }
        await submitAndSettle(services, [{ type: "asset.upsert", asset: crop.asset }, ...refCommands], "inputs");
        helperNodeIds.push(...refIds);

        // 2. 与「添加到对话框」同一机制:裁切图记成这张卡片的自带主图(排在所有入边之前,落到主图槽位),
        //    参考图随后连进来
        await submitAndSettle(services, [selfReferencePatch(sourceId, crop.asset.id)], "self-ref");
        selfReferenceSet = true;
        if (refIds.length > 0) {
          await submitAndSettle(
            services,
            refIds.map((source) => ({
              type: "edge.add" as const,
              edge: { id: `edge-${source}-${sourceId}`, source, target: sourceId }
            })),
            "wire"
          );
        }

        // 3. 参数:目录默认值 + 比例(来自裁切框)
        const state = services.catalog.getState();
        if (state.status !== "ready") throw new Error("读不到模型目录,请稍后再试");
        const config = projectModelConfig(state.catalog.models, input.model.modelKey, input.model.modelKey);
        const parameters: Record<string, unknown> = { ...(config.defaultsByModel?.[input.model.modelKey] ?? {}) };
        if (input.aspect && input.model.aspectKey) parameters[input.model.aspectKey] = input.aspect;
        parameters.model = input.model.modelKey;

        // 4. 提交到**原卡片**
        const runId = id("run");
        const accepted = await services.remote.run({
          nodeId: sourceId,
          runId,
          jobId: `job-${runId}`,
          modelKey: input.model.modelKey,
          prompt: input.prompt,
          parameters
        });
        if (!accepted.ok) throw new Error(accepted.error);

        // 5. 输入已经在提交时解析并落进任务,自带主图可以还原了
        await restoreSelfReference(services, sourceId);
        selfReferenceSet = false;
        return { ok: true, job: { sourceNodeId: sourceId, helperNodeIds, baseline } };
      } catch (e) {
        if (selfReferenceSet) await restoreSelfReference(services, sourceId);
        await removeNodes(services, helperNodeIds);
        return { ok: false, error: e instanceof Error ? e.message : "局部修改失败" };
      }
    },

    async finish(job: HostImageEditJob, signal: AbortSignal): Promise<HostImageEditFinished> {
      const services = getServices();
      if (!ready(services)) return { ok: false, error: "画布还没准备好,请稍后再试" };
      const outcome = await waitForVerdict(services, job.sourceNodeId, job.baseline, signal, RESULT_TIMEOUT_MS);
      if (!outcome.ok) {
        return { ok: false, error: outcome.error === "等待超时" ? "等待生成结果超时,请到画布里查看这张图片的任务" : outcome.error };
      }
      const canvas = services.store.getCanvas();
      const asset = canvas?.assets.find((a) => a.id === outcome.assetId);
      const url = asset ? services.media.resolveCanonicalUrl(asset, canvas?.id) : null;
      return url ? { ok: true, imageUrl: url } : { ok: false, error: "读不到生成结果的地址" };
    },

    async commit(input: HostImageEditCommitInput): Promise<HostImageEditCommitted> {
      let services: Ready;
      try {
        services = requireReady();
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "画布还没准备好" };
      }
      const { job } = input;
      const log = (event: string, extra?: Record<string, unknown>): void => {
        const data = nodeData(services, job.sourceNodeId);
        console.info(`[sixi-image-edit] ${event}`, { nodeId: job.sourceNodeId, output: data?.outputAssetId, status: data?.taskStatus, ...extra });
      };
      try {
        // 卡片此刻装的是模型生成的那一小块,换成拼回原图后的完整图(位置、连线、尺寸都不动)
        const file = new File([input.image], input.name, { type: "image/png" });
        const { asset } = await uploadAsset(services, file);

        // 优先走直通生成:拼合图成为版本历史里的最新版本,卡片与版本条一致
        const state = services.catalog.getState();
        const internal = state.status === "ready" ? state.catalog.models.find((m) => m.modelType === "image" && isInternal(m)) : undefined;
        if (internal) {
          const composed = await composeViaPassthrough(services, job.sourceNodeId, asset, internal.modelKey);
          log(composed.ok ? "passthrough-done" : "passthrough-failed", composed.ok ? { composite: asset.id } : { error: composed.error });
          if (composed.ok) {
            await removeNodes(services, job.helperNodeIds);
            return { ok: true };
          }
        } else {
          log("passthrough-unavailable");
        }

        // 回退:直接替换卡片的输出(版本条可能仍预览模型生成的那一小块)
        const replace: CanvasCommand[] = [
          ...planReplaceImage({ nodeId: job.sourceNodeId, asset }),
          // 把这次 run 从卡片上「结算」掉:运行结果的投影只在 activeRunId 仍是该 run 时才写卡片
          // (latest-run-wins),清掉之后,晚到或重复投递的终态不会再把输出换回模型生成的那一小块
          { type: "nodeData.patch", nodeId: job.sourceNodeId, value: { activeRunId: null } as unknown as CanvasNodeData }
        ];
        log("commit-start", { composite: asset.id });
        await submitAndSettle(services, replace, "commit");

        // 写完不是结束:稳定观察一小段时间,被换掉就再写一次(最多两次)并留下日志。
        // 「命令落盘」不等于「卡片最终显示的是它」,要说出来而不是静默留着裁切图
        let rewrites = 0;
        const deadline = Date.now() + VERIFY_TIMEOUT_MS;
        let stableSince = 0;
        for (;;) {
          const current = nodeData(services, job.sourceNodeId)?.outputAssetId;
          if (current === asset.id) {
            stableSince ||= Date.now();
            if (Date.now() - stableSince >= STABLE_MS) break;
          } else {
            stableSince = 0;
            log("output-reverted", { expected: asset.id, rewrites });
            if (rewrites >= 2) throw new Error("完整图被换回了模型生成的那一小块(已重试两次),请把控制台里 [sixi-image-edit] 的日志发给我");
            rewrites += 1;
            await submitAndSettle(services, replace, "commit-retry");
          }
          if (Date.now() > deadline + rewrites * VERIFY_TIMEOUT_MS) {
            throw new Error("完整图没有写进卡片,卡片里现在是模型生成的那一小块,可在版本圆点里切回原图");
          }
          await sleep(VERIFY_POLL_MS);
        }
        log("commit-stable", { composite: asset.id });
        await removeNodes(services, job.helperNodeIds);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "写入结果失败,请重试" };
      }
    },

    async discard(job: HostImageEditJob): Promise<void> {
      const services = getServices();
      if (!ready(services) || !services.session.isWritable()) return;
      await restoreSelfReference(services, job.sourceNodeId);
      await removeNodes(services, job.helperNodeIds);
    },

    locate(nodeId: string): void {
      try {
        getServices().locate?.locateNodes([nodeId], { select: true });
      } catch {
        /* 定位是锦上添花 */
      }
    },

    maxReferences: () => maxReferences
  };
}
