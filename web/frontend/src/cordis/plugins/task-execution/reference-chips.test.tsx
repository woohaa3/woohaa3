/**
 * 参考 tile strip 与 picker 渲染
 * （change: 2026-09-28-align-execution-reference-and-expansion，task 2/3；
 *   前身：add-reference-inputs-and-mentions ReferenceTileStrip）。
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ReferenceTileStrip, ReferencePickerContent } from "./reference-chips.js";
import type { ReferenceItem } from "./reference-items.js";

const ready: ReferenceItem = {
  slotId: "s1",
  sourceNodeId: "n1",
  role: "reference_image",
  mentionType: "input_image",
  label: "图片 1",
  mediaKind: "image",
  previewUrl: "/api/media/x.png",
  assetId: "a1",
  status: "ready",
  blockingReason: null,
  fieldLabel: null,
};

const waiting: ReferenceItem = {
  slotId: "s2",
  sourceNodeId: "n2",
  role: "reference_image",
  mentionType: "input_image",
  label: "图片 2",
  mediaKind: null,
  previewUrl: null,
  assetId: null,
  status: "waiting",
  blockingReason: "上游节点 n2 还没有可用输出",
  fieldLabel: null,
};

const invalid: ReferenceItem = {
  slotId: "s3",
  sourceNodeId: "n3",
  role: "reference_video",
  mentionType: "input_video",
  label: "视频 1",
  mediaKind: "video",
  previewUrl: null,
  assetId: "a3",
  status: "invalid",
  blockingReason: "所选模型不接受参考角色",
  fieldLabel: null,
};

describe("ReferenceTileStrip", () => {
  it("渲染 ready/waiting/invalid tiles 且不静默消失", () => {
    const html = renderToStaticMarkup(
      <ReferenceTileStrip items={[ready, waiting, invalid]} onRemove={() => undefined} onAdd={() => undefined} />
    );
    expect(html).toContain("图片 1");
    expect(html).toContain("图片 2");
    expect(html).toContain("视频 1");
    // tile 的 accessible name 覆盖角色与状态，而不是可见状态文字。
    expect(html).toContain("就绪");
    expect(html).toContain("等待中");
    expect(html).toContain("不可用");
    expect(html).toContain("移除参考 图片 1");
    expect(html).toContain('data-status="waiting"');
    expect(html).toContain('data-status="invalid"');
  });

  it("预览只使用稳定同源地址", () => {
    const html = renderToStaticMarkup(<ReferenceTileStrip items={[ready]} />);
    expect(html).toContain('src="/api/media/x.png"');
  });

  it("没有引用时仍有同尺寸虚线 add tile", () => {
    const html = renderToStaticMarkup(<ReferenceTileStrip items={[]} onAdd={() => undefined} />);
    expect(html).toContain('data-role="add"');
    expect(html).toContain("选择参考素材节点");
  });

  it("超过三个引用全部留在 DOM（不折叠）", () => {
    const many = Array.from({ length: 5 }, (_, index) => ({ ...ready, slotId: `s${index}`, label: `图片 ${index}` }));
    const html = renderToStaticMarkup(<ReferenceTileStrip items={many} onRemove={() => undefined} />);
    for (let index = 0; index < 5; index += 1) expect(html).toContain(`图片 ${index}`);
    expect(html).not.toContain("收起参考");
  });
});

describe("ReferencePicker", () => {
  it("渲染候选、类型、缩略图与关闭", () => {
    const html = renderToStaticMarkup(
      <ReferencePickerContent
        candidates={[{ nodeId: "n9", label: "素材 A", mediaKind: "image", previewUrl: "/api/media/a.png" }]}
        activeIndex={0}
        onActiveIndexChange={() => undefined}
        onPick={() => undefined}
        onClose={() => undefined}
      />
    );
    expect(html).toContain('role="listbox"');
    expect(html).toContain("素材 A");
    expect(html).toContain('src="/api/media/a.png"');
    expect(html).toContain("关闭");
  });

  it("无候选时显示空态", () => {
    const html = renderToStaticMarkup(
      <ReferencePickerContent
        candidates={[]}
        activeIndex={0}
        onActiveIndexChange={() => undefined}
        onPick={() => undefined}
        onClose={() => undefined}
      />
    );
    expect(html).toContain("没有可连接的素材节点");
  });

  it("全部禁用时显示稳定原因", () => {
    const html = renderToStaticMarkup(
      <ReferencePickerContent
        candidates={[{ nodeId: "n9", label: "素材 A", mediaKind: "image", disabled: true, reason: "上游还没有可用输出" }]}
        activeIndex={0}
        onActiveIndexChange={() => undefined}
        onPick={() => undefined}
        onClose={() => undefined}
      />
    );
    expect(html).toContain("上游还没有可用输出");
  });
});
