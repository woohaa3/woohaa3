/**
 * 「直通」内部模板:收到一张图,原样当作生成结果返回,**不调用 ppserver、不扣积分**。
 *
 * 为什么需要:独立编辑的「局部修改」在浏览器里把模型生成的那一小块拼回原图,拼好的完整图要成为
 * 这张卡片的**版本历史里的一个版本**。宿主的版本历史只登记「生成任务的结果」,没有「把任意图记成一个
 * 版本」的接口,直接改卡片的输出会让版本条继续预览上一个生成结果(拼合图不在条里,选不中也显示不出来)。
 * 让拼合图作为一次本地的「生成」走完标准流程,它就成了最新版本、自动被选中,卡片与版本条一致。
 *
 * 参考图的上传沿用宿主对参考输入的统一处理(`uploadReference` 传到 ppserver 的 `/media/upload`,拿回
 * 云端可读的公网地址),这里只把那个地址原样交回去,宿主再把它下载进自己的存储。
 * 任务 id 里直接编码了结果地址,所以 `status` 无状态,宿主重启后仍能完成。
 */
import type { PpserverTemplate } from "./discovery.js";

/** 固定的模板 id(UUID 形状,过得了宿主对模板 id 的校验;不会与线上模板冲突) */
export const PASSTHROUGH_TEMPLATE_ID = "5a1c0000-0000-4000-8000-0000000000e1";

/** 内部模板的运营分类:前端据此不在模型下拉里展示它 */
export const PASSTHROUGH_CATEGORY = "sixi-internal";

const TASK_PREFIX = "passthrough:";

export function isPassthroughTemplate(templateId: string): boolean {
  return templateId.trim().toLowerCase() === PASSTHROUGH_TEMPLATE_ID;
}

/** 目录里的内部模板定义:一个主图槽位(`3_image`),与线上图片模板的字段名一致 */
export function passthroughTemplate(): PpserverTemplate {
  return {
    modelId: PASSTHROUGH_TEMPLATE_ID,
    templateId: PASSTHROUGH_TEMPLATE_ID,
    kind: "image",
    title: "局部修改合成(内部)",
    category: PASSTHROUGH_CATEGORY,
    cost: 0,
    inputSchema: {
      type: "object",
      properties: {
        "3_image": {
          title: "主图像",
          type: "array",
          maxItems: 1,
          "x-component": "Upload",
          "x-component-props": { accept: "image/*", maxCount: 1 },
          "x-pptask-semantic": "reference-image"
        }
      }
    },
    defaultInput: {}
  };
}

/** 从输入里取出那张图的地址;取不到返回空串 */
export function passthroughSource(input: Record<string, unknown>): string {
  const field = input["3_image"];
  const first = Array.isArray(field) ? field[0] : field;
  if (typeof first === "string") return first.trim();
  if (first && typeof first === "object" && typeof (first as { url?: unknown }).url === "string") {
    return (first as { url: string }).url.trim();
  }
  return "";
}

export function passthroughTaskId(url: string): string {
  return `${TASK_PREFIX}${encodeURIComponent(url)}`;
}

/** 是直通任务就返回其中编码的地址,否则 undefined */
export function readPassthroughTaskId(taskId: string): string | undefined {
  if (!taskId.startsWith(TASK_PREFIX)) return undefined;
  try {
    return decodeURIComponent(taskId.slice(TASK_PREFIX.length));
  } catch {
    return undefined;
  }
}
