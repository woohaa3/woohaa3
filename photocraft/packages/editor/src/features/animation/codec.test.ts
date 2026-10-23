/**
 * codec 端口注册与容器协商（U77，design D2）。
 *
 * 覆盖三条容易被「只问 MP4 + 同步乐观宣称支持」掩盖的行为：
 * - 只支持 WebM 的宿主仍然可用（按偏好顺序协商，而不是把 MP4 当唯一容器）；
 * - 真实能力探测是异步的：结果回来前是 `pending`，界面据此保持禁用而不是乐观打开；
 * - 全不支持时，界面拿到的是端口自己给出的原因，不会退化成「只取首帧」的假成功。
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  ANIMATION_CONTAINERS,
  animationCodecPort,
  negotiateAnimationContainer,
  setAnimationCodecPort
} from "./codec.js";
import type { AnimationCodecPort, AnimationCodecSupport } from "@woohaa3/photocraft-protocol";

function port(
  supported: Record<"decode" | "encode", string[]>,
  reason = "容器不受支持"
): AnimationCodecPort {
  return {
    supports: ({ direction, container }): AnimationCodecSupport =>
      container && supported[direction].includes(container)
        ? { supported: true, container, codec: "avc1" }
        : { supported: false, reason: `${reason}：${container ?? "未指定"}` },
    decode: async () => ({ ok: false, reason: "未实现" }),
    encode: async () => ({ ok: false, reason: "未实现" }),
    cancel: () => {}
  };
}

afterEach(() => setAnimationCodecPort(null));

describe("codec 端口注册", () => {
  it("缺方法的替身不算已注册端口", () => {
    setAnimationCodecPort({ supports: () => ({ supported: true }) } as unknown as AnimationCodecPort);
    expect(animationCodecPort()).toBeNull();
  });

  it("完整端口注册后可按方向协商", async () => {
    setAnimationCodecPort(port({ decode: ["mp4"], encode: ["mp4"] }));
    const codec = animationCodecPort()!;
    expect(codec).not.toBeNull();
    const encoded = await negotiateAnimationContainer(codec, "encode");
    expect(encoded).toEqual({ state: "ready", container: "mp4" });
  });
});

describe("容器协商", () => {
  it("只支持 WebM 的宿主可用，且不把 MP4 当唯一容器", async () => {
    const codec = port({ decode: ["webm"], encode: ["webm"] });
    expect(await negotiateAnimationContainer(codec, "encode")).toEqual({ state: "ready", container: "webm" });
    expect(await negotiateAnimationContainer(codec, "decode")).toEqual({ state: "ready", container: "webm" });
  });

  it("两种容器都支持时按偏好顺序取第一个", async () => {
    const both = port({ decode: ["mp4", "webm"], encode: ["mp4", "webm"] });
    const negotiated = await negotiateAnimationContainer(both, "encode");
    expect(negotiated).toEqual({ state: "ready", container: ANIMATION_CONTAINERS[0] });
  });

  it("全不支持时返回端口原因，不伪造容器", async () => {
    const negotiated = await negotiateAnimationContainer(port({ decode: [], encode: [] }, "宿主没有编解码器"), "encode");
    expect(negotiated.state).toBe("unavailable");
    if (negotiated.state !== "unavailable") return;
    expect(negotiated.reason).toContain("宿主没有编解码器");
  });

  it("方向独立协商：能解码不等于能编码", async () => {
    const codec = port({ decode: ["mp4"], encode: [] });
    expect(await negotiateAnimationContainer(codec, "decode")).toEqual({ state: "ready", container: "mp4" });
    expect((await negotiateAnimationContainer(codec, "encode")).state).toBe("unavailable");
  });

  it("异步探测按真实结果协商（不会乐观宣称支持）", async () => {
    const codec: AnimationCodecPort = {
      // 真实宿主用 `VideoEncoder.isConfigSupported`，本来就是异步的。
      supports: async ({ direction, container }) =>
        direction === "encode" && container === "webm"
          ? { supported: true, container: "webm", codec: "vp9" }
          : { supported: false, reason: "该编解码器不可用" },
      decode: async () => ({ ok: false, reason: "未实现" }),
      encode: async () => ({ ok: false, reason: "未实现" }),
      cancel: () => {}
    };
    expect(await negotiateAnimationContainer(codec, "encode")).toEqual({ state: "ready", container: "webm" });
    expect((await negotiateAnimationContainer(codec, "decode")).state).toBe("unavailable");
  });

  it("探测抛错时把错误当原因，不静默宣称不可用/可用", async () => {
    const codec: AnimationCodecPort = {
      supports: () => { throw new Error("WebCodecs 初始化失败"); },
      decode: async () => ({ ok: false, reason: "未实现" }),
      encode: async () => ({ ok: false, reason: "未实现" }),
      cancel: () => {}
    };
    const negotiated = await negotiateAnimationContainer(codec, "encode");
    expect(negotiated.state).toBe("unavailable");
    if (negotiated.state === "unavailable") expect(negotiated.reason).toContain("WebCodecs 初始化失败");
  });
});
