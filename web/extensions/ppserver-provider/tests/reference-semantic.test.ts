/**
 * 参考图语义补标：画布上的图能不能连进 ppserver 模型，取决于 describe 的表单有没有被标成参考图。
 *
 * 全是纯函数断言，不碰网络、不发生成请求。字段形状取自线上 describe 的真实返回
 * （Banana2.1：`3_image` 主图像 + `1x_image` 参考图；个别模型另有 `mask` / `maskUrl` 遮罩）。
 */
import { describe, expect, it } from "vitest";
import { referenceInputCapabilityFromDescription } from "@woohaa3/contracts";
import { interpretDescribe } from "../src/discovery.js";

function upload(title: string, maxCount: number, accept = "image/*", extra: Record<string, unknown> = {}) {
  return {
    title,
    type: "array",
    "x-component": "Upload",
    "x-component-props": { variant: "nomask", maxCount, listType: "picture-card", accept },
    ...extra
  };
}

function describeWith(properties: Record<string, unknown>) {
  return interpretDescribe({
    kind: "image",
    name_zhcn: "测试模板",
    formSchema: { type: "object", properties }
  });
}

describe("ppserver 参考图语义补标", () => {
  it("接受图片的上传字段被标成 reference-image，maxCount 带成 maxItems", () => {
    const { inputSchema } = describeWith({
      "3_image": upload("主图像", 1),
      "1x_image": upload("上传参考图像【选填】", 9)
    });
    const props = (inputSchema as any).properties;
    expect(props["3_image"]["x-pptask-semantic"]).toBe("reference-image");
    expect(props["3_image"].maxItems).toBe(1);
    expect(props["1x_image"]["x-pptask-semantic"]).toBe("reference-image");
    expect(props["1x_image"].maxItems).toBe(9);
  });

  it("补标之后宿主能推导出输入绑定：画布图片不再被判「不接受」", () => {
    const { inputSchema } = describeWith({
      "3_image": upload("主图像", 1),
      "1x_image": upload("上传参考图像【选填】", 9)
    });
    const capability = referenceInputCapabilityFromDescription({ inputSchema });
    expect(capability.acceptsImages).toBe(true);
    expect(capability.bindings.map((binding) => [binding.field, binding.maxItems])).toEqual([
      ["3_image", 1],
      ["1x_image", 9]
    ]);
    // 选择器正是用 mediaKinds 判断：图片必须在里面。
    expect(capability.bindings.every((binding) => binding.mediaKinds.includes("image"))).toBe(true);
  });

  it("补标之前就是复现问题的样子：没有绑定", () => {
    const raw = { properties: { "1x_image": upload("上传参考图像【选填】", 9) } };
    expect(referenceInputCapabilityFromDescription({ inputSchema: raw }).bindings).toEqual([]);
  });

  it("遮罩字段不补：蒙版不是参考图（按字段名与标题两路判断）", () => {
    const { inputSchema } = describeWith({
      mask: upload("PNG 遮罩", 1),
      maskUrl: upload("画布遮罩", 1),
      overlay: upload("局部蒙版", 1),
      "1x_image": upload("上传参考图像【选填】", 3)
    });
    const props = (inputSchema as any).properties;
    expect(props.mask["x-pptask-semantic"]).toBeUndefined();
    expect(props.maskUrl["x-pptask-semantic"]).toBeUndefined();
    expect(props.overlay["x-pptask-semantic"]).toBeUndefined();
    expect(props["1x_image"]["x-pptask-semantic"]).toBe("reference-image");
  });

  it("不猜：没写 accept、或接受视频的 Upload 不补", () => {
    const { inputSchema } = describeWith({
      noAccept: { title: "文件", type: "array", "x-component": "Upload", "x-component-props": { maxCount: 1 } },
      clip: upload("参考视频", 1, "video/*"),
      pic: upload("参考图", 2, "image/png, image/jpeg")
    });
    const props = (inputSchema as any).properties;
    expect(props.noAccept["x-pptask-semantic"]).toBeUndefined();
    expect(props.clip["x-pptask-semantic"]).toBeUndefined();
    expect(props.pic["x-pptask-semantic"]).toBe("reference-image");
  });

  it("只补不改：已有语义的字段原样保留；非 Upload 字段不动；不修改入参", () => {
    const original = {
      keep: upload("已声明", 4, "image/*", { "x-pptask-semantic": "reference-video" }),
      prompt: { title: "提示词", type: "string", "x-component": "Input.TextArea" },
      ref: upload("参考图", 2)
    };
    const snapshot = JSON.stringify(original);
    const { inputSchema } = describeWith(original);
    const props = (inputSchema as any).properties;
    expect(props.keep["x-pptask-semantic"]).toBe("reference-video");
    expect(props.prompt).toEqual(original.prompt);
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it("主图字段带出标题，界面据此显示「主图像」而不是和参考图同名", () => {
    const { inputSchema } = describeWith({
      "3_image": upload("主图像", 1),
      "1x_image": upload("上传参考图像【选填】", 9)
    });
    const capability = referenceInputCapabilityFromDescription({ inputSchema });
    expect(capability.bindings.map((binding) => [binding.field, binding.label])).toEqual([
      ["3_image", "主图像"],
      ["1x_image", "上传参考图像【选填】"]
    ]);
  });

  it("没有标题的主图字段补成「主图像」；有标题的不覆盖", () => {
    const { inputSchema } = describeWith({
      bare: { ...upload("", 1), title: undefined, "x-component-props": { variant: "deferred", maxCount: 1, accept: "image/*" } },
      titled: upload("我的底图", 1, "image/*", { "x-component-props": { variant: "deferred", maxCount: 1, accept: "image/*" } })
    });
    const props = (inputSchema as any).properties;
    expect(props.bare.title).toBe("主图像");
    expect(props.titled.title).toBe("我的底图");
  });

  it("没有表单或没有 properties 时原样返回，不抛错", () => {
    expect(interpretDescribe({ kind: "image" }).inputSchema).toBeUndefined();
    expect(interpretDescribe({ formSchema: { type: "object" } }).inputSchema).toEqual({ type: "object" });
  });
});
