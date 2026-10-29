/**
 * 查看页片段 fixtures（change: expand-showcase-execution-ux，任务 2.1）。
 *
 * `#` 片段引用走生产 `PromptSnippetSource` 契约：搜索命中这里，materialize 返回可读正文。
 */

export type SnippetFixture = {
  id: string;
  name: string;
  summary: string;
  body: string;
};

export const SNIPPET_FIXTURES: readonly SnippetFixture[] = [
  {
    id: "psnip-photoreal",
    name: "写实增强",
    summary: "电影级布光、浅景深",
    body: "以写实摄影风格重绘：电影级布光，浅景深，细腻皮肤质感，8K 细节。"
  },
  {
    id: "psnip-storyboard",
    name: "分镜九宫格",
    summary: "拆解镜头/主体/动作/构图",
    body: "把内容拆解为九宫格分镜：每格描述镜头、主体、动作与构图，保持角色一致性。"
  },
  {
    id: "psnip-night",
    name: "霓虹夜景镜头",
    summary: "雨后街道、低机位仰拍",
    body: "霓虹夜景，雨后街道，低机位仰拍，冷暖对比强烈。"
  }
];
