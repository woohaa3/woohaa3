import type { ThumbnailTier } from "./residency/policy.js";
import type { NodeResourceLoad } from "../../services/node-resource-loading.js";

/** 后台准备中的目标绑定，上传成功前不替换当前纹理。 */
export type PendingTextureEntry = {
  url: string;
  contentKey: string;
  tier: ThumbnailTier;
  load: NodeResourceLoad;
};
