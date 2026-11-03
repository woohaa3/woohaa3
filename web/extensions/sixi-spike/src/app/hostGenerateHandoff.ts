/**
 * 首页「生成」→ 画布 的交接数据。
 *
 * 为什么要交接:进入新画布是一次**整页跳转**(见 `SixiShell` 的 `HostProjectSource`,页内切换
 * 会让新画布空白),内存里的提示词与参考图跳转后全部丢失。所以跳转前把"要做什么"写进
 * sessionStorage,新页面上的 `HostGenerateRunner` 读走并执行。
 *
 * 只存**引用**:图片在跳转前已经上传到 Media Service(内容寻址,同一份字节不会重复存),
 * 这里只留 storageKey 等元信息,不存字节 —— sessionStorage 只有几 MB,放不下图。
 *
 * 必须带时效:读取方靠"执行后清掉"收尾,一旦新页面没能挂载成功(扩展加载失败、渲染抛错),
 * 清除就永远不会执行,残留的交接会在下一次打开时凭空建出一个任务。超时视为过期。
 */
import type { UploadedMedia } from "@woohaa3/frontend/extension-api";
import type { HostGenerateKind } from "@/app/hostGenerate";

const HANDOFF_KEY = "sixi-spike.generate-handoff";

/** 跳转 + 画布就绪通常几秒;给到一分钟,再久说明这次跳转没落成 */
const HANDOFF_TTL_MS = 60_000;

export type HandoffImage = {
  /** 原文件名,作为图片节点标题 */
  name: string;
  media: UploadedMedia;
};

export type GenerateHandoff = {
  canvasId: string;
  prompt: string;
  images: HandoffImage[];
  /** 图片 / 视频;缺省按图片 */
  kind: HostGenerateKind;
  /** 用户选的模型;缺省由目录默认模型补 */
  modelKey?: string;
  /** 用户改过的参数;缺省由目录默认值补 */
  params?: Record<string, string>;
};

export function writeHandoff(handoff: GenerateHandoff): boolean {
  try {
    sessionStorage.setItem(HANDOFF_KEY, JSON.stringify({ ...handoff, at: Date.now() }));
    return true;
  } catch {
    return false;
  }
}

/** 读并**立刻清除**:同一份交接只执行一次(热重载 / 外壳重挂不会重复提交任务) */
export function takeHandoff(): GenerateHandoff | null {
  try {
    const raw = sessionStorage.getItem(HANDOFF_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(HANDOFF_KEY);
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { canvasId, prompt, images, at, kind, modelKey, params } = parsed as Record<string, unknown>;
    if (typeof canvasId !== "string" || typeof prompt !== "string" || typeof at !== "number") return null;
    if (Date.now() - at > HANDOFF_TTL_MS) return null;
    if (!Array.isArray(images)) return null;
    return {
      canvasId,
      prompt,
      images: images as HandoffImage[],
      kind: kind === "video" ? "video" : "image",
      ...(typeof modelKey === "string" ? { modelKey } : {}),
      ...(params && typeof params === "object" ? { params: params as Record<string, string> } : {})
    };
  } catch {
    return null;
  }
}
