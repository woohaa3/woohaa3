import { canonicalFilmSetFields, readFilmSetAnimationProjection } from "@woohaa3/contracts";
import { nativeFilmSetFrame } from "../../preview/backend/native-frame.js";
import type { ContentRecordingCommitPlan, ContentRecordingCommitRequest, ContentRecordingFreezeResult, ContentRecordingRuntime, ContentRecordingSnapshot } from "@woohaa3/contracts";
import { describeFilmSetRecording, freezeFilmSetRecording, matchesFilmSetRecording, planFilmSetRecordingCommit, validateRecordingResources } from "../../authoring/backend/recording-compile.js";

/**
 * 片场录制的 `ContentRecordingRuntime` 适配
 * （change: 2026-10-17-add-native-offscreen-film-set-recording，任务 2.1 / design D3）。
 *
 * 宿主只依赖 `@woohaa3/contracts` 的端口；这里把端口方法映射到本扩展的编译/提交实现。
 * 冻结是同步纯编译；媒体可读性校验由宿主随后异步执行（`validateRecordingResources`）。
 */

export type FilmSetRecordingRuntimeOptions = {
  /** 现在时间（可注入，便于测试稳定输出）。 */
  now?: () => string;
};

export function createFilmSetRecordingRuntime(options: FilmSetRecordingRuntimeOptions = {}): ContentRecordingRuntime {
  const now = options.now ?? (() => new Date().toISOString());
  return {
    matches: matchesFilmSetRecording,
    async freeze(input): Promise<ContentRecordingFreezeResult> {
      const projection = input.canvas.sourceCanvas ? readFilmSetAnimationProjection(input.canvas.sourceCanvas, input.nodeId) : null;
      const result = freezeFilmSetRecording({ prepareFrame: nativeFilmSetFrame,
        request: {
          requestId: input.requestId,
          purpose: input.purpose,
          canvasId: input.canvasId,
          nodeId: input.nodeId,
          clipId: input.clipId,
          profileKey: input.profileKey,
          ...(input.profile === undefined ? {} : { profile: input.profile })
        },
        nodeData: input.canvas.sourceCanvas ? projection && canonicalFilmSetFields(projection) : input.canvas.nodeData,
        ...(input.canvas.node ? { node: input.canvas.node } : {}),
        ...(input.canvas.themeBackdrop === undefined ? {} : { themeBackdrop: input.canvas.themeBackdrop }),
        assets: input.canvas.assets as never,
        canvasRevision: input.canvas.revision,
        sourceIncarnation: input.sourceIncarnation,
        ...(input.readOnly !== undefined ? { readOnly: input.readOnly } : {}),
        ...(input.hasPendingDraft !== undefined ? { hasPendingDraft: input.hasPendingDraft } : {}),
      });
      if (!("ok" in result) || !result.ok) return result as ContentRecordingFreezeResult;
      // 素材必须真实可读：缺源在冻结之后立刻失败，不把问题推给 worker。
      if (input.canvas.read) {
        const readable = await validateRecordingResources(result.snapshot, input.canvas.read);
        if (!readable.ok) return readable;
      }
      return result;
    },
    /**
     * 提交计划。来源布局由宿主在提交时给出（`sourcePosition`）；缺省视为源已删除。
     */
    async planCommit(input: ContentRecordingCommitRequest & {
      sourcePosition?: { x: number; y: number; width: number } | null;
    }): Promise<ContentRecordingCommitPlan> {
      return planFilmSetRecordingCommit({
        request: input,
        source: input.sourcePosition ?? null,
        now
      });
    },
    describe(input) {
      const projection = input.sourceCanvas && input.nodeId ? readFilmSetAnimationProjection(input.sourceCanvas, input.nodeId) : null;
      return describeFilmSetRecording(input.sourceCanvas && input.nodeId ? projection && canonicalFilmSetFields(projection) : input.nodeData, input.clipId);
    }
  };
}

/** 供宿主在冻结后异步校验素材可读性。 */
export { validateRecordingResources, type ContentRecordingSnapshot };
