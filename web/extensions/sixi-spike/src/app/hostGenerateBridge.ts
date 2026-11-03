/**
 * 首页「生成」的宿主实现:上传参考图 → 新建画布 → 记下交接 → 整页进入画布。
 *
 * 画布里的后半段(建图片/视频节点、连线参考图、提交生成)在 `HostGenerateRunner`,
 * 因为那需要画布页作用域的服务,首页(应用作用域)拿不到。
 *
 * 顺序有讲究:**先上传、再建画布**。上传失败时还没有任何副作用,用户改一下重试即可;
 * 反过来会留下一张空画布。建画布失败同理,图片已经是内容寻址的,重传命中去重、不占额外空间。
 */
import type {
  CanvasCatalogService,
  MediaRemoteService,
  TaskCatalogService
} from "@woohaa3/frontend/extension-api";
import { resolvePublicUrl } from "@woohaa3/frontend/extension-api";
import type { HostGenerateBridge, HostGenerateResult, HostModelOption } from "@/app/hostGenerate";
import { listGenerateModels } from "./hostGenerateModels";
import { writeHandoff, type HandoffImage } from "./hostGenerateHandoff";
import { writePendingEntry } from "./pendingEntry";
import { ROUTES } from "@/app/paths";

/** 画布标题取提示词开头:一屏「未命名画布」分不清谁是谁 */
const TITLE_MAX = 20;

function titleOf(prompt: string): string {
  const oneLine = (prompt.split("\n")[0] ?? "").replace(/\s+/g, " ").trim();
  return oneLine.length > TITLE_MAX ? `${oneLine.slice(0, TITLE_MAX)}…` : oneLine;
}

export function createHostGenerateBridge(
  catalog: CanvasCatalogService,
  media: MediaRemoteService | undefined,
  /** 懒取:首页渲染时这两项可能还没就绪 */
  services: { taskCatalog: () => TaskCatalogService | undefined }
): HostGenerateBridge {
  return {
    async listModels(): Promise<HostModelOption[]> {
      return listGenerateModels(services.taskCatalog());
    },
    async submit({ prompt, files, kind, modelKey, params }): Promise<HostGenerateResult> {
      if (files.length > 0 && !media) {
        return { ok: false, error: "当前环境无法上传图片,请去掉参考图后重试" };
      }

      const images: HandoffImage[] = [];
      for (const file of files) {
        const uploaded = await media!.upload({ file });
        if (!uploaded.ok) return { ok: false, error: `「${file.name}」上传失败:${uploaded.error}` };
        images.push({ name: file.name, media: uploaded.media });
      }

      const created = await catalog.create({ title: titleOf(prompt) });
      if (!created.ok) return { ok: false, error: created.error || "新建画布失败,请重试" };
      const canvasId = created.canvasId;

      // 交接写不进去(存储被禁用)就不要跳:跳过去只会得到一张空画布,任务凭空消失
      if (
        !writeHandoff({
          canvasId,
          prompt,
          images,
          kind,
          ...(modelKey ? { modelKey } : {}),
          ...(params ? { params } : {})
        })
      ) {
        return { ok: false, error: "浏览器存储不可用,无法带着任务进入画布" };
      }
      writePendingEntry(ROUTES.create);
      window.location.assign(`${resolvePublicUrl("/")}?canvasId=${encodeURIComponent(canvasId)}`);
      return { ok: true };
    }
  };
}
