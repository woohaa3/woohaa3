/**
 * Woohaa 适配层的工作区控制器
 * （change: 2026-10-21-extract-photocraft-subproject，design D3/D4）。
 *
 * 核心 `EditorWorkspaceController` 只认端口；这个子类把宿主输入（画布/节点/会话/基线身份、
 * base 资产与 requestId）和 `project-save` 的请求身份对账接进去：
 *
 * - 一次 `save(input)` 只登记本次宿主输入，随后交给核心冻结；
 * - 重试复用同一 requestId、冻结产物和已成功上传对象（`attempt` 保留在适配层）；
 * - 成功后推进会话基线与「进入时的工程定义」，失败保留草稿。
 *
 * 控制器本身仍不触 DOM；插件与面板只调用公开方法。
 */
import {
  EditorWorkspaceController as CoreEditorWorkspaceController,
  type ArtifactDigest,
  type EditorAssetPort,
  type EditorDocumentSession,
  type EditorEditingOwner,
  type EditorResult,
  type EditorHandle,
  type EditorSaveOutcome,
  type EditorSnapshot,
  type EditorViewModel
} from "@woohaa3/photocraft-editor";
import type { ImageEditDocument } from "@woohaa3/contracts";
import {
  saveImageProject,
  type ProjectSaveAttempt,
  type ProjectSaveDeps,
  type ProjectSaveInput,
  type ProjectSaveOutcome
} from "./project-save.js";

export type EditorWorkspaceOptions = {
  dialogOwner?: () => EditorEditingOwner | null;
  session: EditorDocumentSession;
  sessionId: string;
  /** 保存依赖（上传/回执/资产 id）。 */
  saveDeps: ProjectSaveDeps;
  /** 进入本次编辑时携带的工程定义。 */
  baselineDocument: ImageEditDocument | null;
  load?: () => Promise<EditorResult<EditorHandle>>;
  /** 宿主部署基路径下的静态资源地址（字体）。 */
  assetUrl?: EditorAssetPort;
  yieldTask?: () => Promise<void>;
  digest?: ArtifactDigest;
  onState?: (state: EditorSnapshot["state"]) => void;
  onViewModel?: (view: EditorViewModel, commands: Map<string, unknown>) => void;
};

/** 一次保存的宿主输入（不含冻结产物；产物由核心在同一修订上同步生成）。 */
export type SaveInput = Omit<ProjectSaveInput, "artifacts" | "document">;

export class EditorWorkspaceController extends CoreEditorWorkspaceController {
  private readonly host: {
    input: SaveInput | null;
    baseline: ImageEditDocument | null;
    deps: ProjectSaveDeps;
    attempt: ProjectSaveAttempt;
  };

  constructor(options: EditorWorkspaceOptions) {
    const host = {
      input: null as SaveInput | null,
      baseline: options.baselineDocument,
      deps: options.saveDeps,
      attempt: {} as ProjectSaveAttempt
    };
    super({
      ...(options.dialogOwner ? { dialogOwner: options.dialogOwner } : {}),
      session: options.session,
      ...(options.load ? { load: options.load } : {}),
      ...(options.assetUrl ? { assetUrl: options.assetUrl } : {}),
      ...(options.yieldTask ? { yieldTask: options.yieldTask } : {}),
      ...(options.digest ? { digest: options.digest } : {}),
      ...(options.onState ? { onState: options.onState } : {}),
      ...(options.onViewModel ? { onViewModel: options.onViewModel } : {}),
      save: async ({ artifacts, sourceAssetIds, isCurrent, onProgress }): Promise<EditorSaveOutcome> => {
        const input = host.input;
        if (!input) return { ok: false, code: "invalid-artifacts", message: "缺少保存输入", retriable: false };
        const closed = { ok: false as const, code: "complete-failed" as const, error: "编辑会话已结束" };
        const outcome = await saveImageProject(
          { ...input, artifacts, document: host.baseline, sourceAssetIds },
          {
            ...host.deps,
            // 上传完成后再次检查代际；退出后的迟到结果不得提交回执。
            complete: (request) => isCurrent() ? host.deps.complete(request) : Promise.resolve(closed),
            ...(host.deps.status ? { status: (request: Parameters<NonNullable<ProjectSaveDeps["status"]>>[0]) => isCurrent() ? host.deps.status!(request) : Promise.resolve(closed) } : {}),
            // 进度只在会话仍是当前代际时上报，避免过期任务刷新别的文档。
            ...(onProgress ? { onProgress: (percent: number) => { if (isCurrent()) onProgress(percent); } } : {})
          },
          host.attempt
        );
        if (outcome.ok) {
          // 首次转为工程后换用刚写入的工程定义：否则下一次保存会丢来源资产引用。
          host.baseline = outcome.project;
          host.attempt = {};
          return outcome;
        }
        if (outcome.code === "conflict" || !outcome.retriable) host.attempt = {};
        return outcome;
      }
    });
    this.host = host;
  }

  /** 记录本次宿主保存输入并冻结/写回；重试时调用方传入同一输入。 */
  save(input?: SaveInput): Promise<ProjectSaveOutcome> {
    if (input) this.host.input = input;
    return super.save() as Promise<ProjectSaveOutcome>;
  }
}
