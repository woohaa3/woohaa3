/**
 * @vitest-environment jsdom
 *
 * 报错捕获 store 的单元测试（change: 2026-10-30-add-dev-error-assistant）。
 *
 * 只测 store 自身的纯逻辑：去重、环形裁剪、堆栈裁剪、序列化兜底。
 * 监听安装需要真实 window，`install` 的行为在 jsdom 下单独验证一次。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDevErrorLog, DEV_ERROR_MESSAGE_FLAG } from "./store.js";

describe("createDevErrorLog", () => {
  it("记录一条错误并通知订阅者", () => {
    const log = createDevErrorLog(() => 1000);
    const listener = vi.fn();
    log.subscribe(listener);
    log.report({ kind: "error", origin: "page", message: "boom", stack: null, source: null });
    expect(log.getSnapshot()).toHaveLength(1);
    expect(log.getSnapshot()[0]!.message).toBe("boom");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("同一条错误在窗口内只累加计数，不新增条目", () => {
    let now = 1000;
    const log = createDevErrorLog(() => now);
    const input = { kind: "error" as const, origin: "page" as const, message: "same", stack: "Error\n  at a (x.ts:1:1)", source: null };
    log.report(input);
    now = 1500;
    log.report(input);
    now = 2000;
    log.report(input);
    expect(log.getSnapshot()).toHaveLength(1);
    expect(log.getSnapshot()[0]!.count).toBe(3);
  });

  it("超出窗口后同样的消息会记成新条目", () => {
    let now = 1000;
    const log = createDevErrorLog(() => now);
    const input = { kind: "error" as const, origin: "page" as const, message: "same", stack: null, source: null };
    log.report(input);
    now = 1000 + 3001;
    log.report(input);
    expect(log.getSnapshot()).toHaveLength(2);
  });

  it("堆栈首帧不同视为不同错误", () => {
    const log = createDevErrorLog(() => 1000);
    log.report({ kind: "error", origin: "page", message: "x", stack: "Error\n  at a (1:1)", source: null });
    log.report({ kind: "error", origin: "page", message: "x", stack: "Error\n  at b (2:2)", source: null });
    expect(log.getSnapshot()).toHaveLength(2);
  });

  it("来源不同视为不同错误（渲染器与页面分开记）", () => {
    const log = createDevErrorLog(() => 1000);
    log.report({ kind: "error", origin: "page", message: "x", stack: null, source: null });
    log.report({ kind: "error", origin: "renderer", message: "x", stack: null, source: null });
    expect(log.getSnapshot()).toHaveLength(2);
  });

  it("超过上限时丢弃最旧的", () => {
    const log = createDevErrorLog(() => 1000);
    for (let index = 0; index < 205; index += 1) {
      log.report({ kind: "error", origin: "page", message: `e${index}`, stack: null, source: null });
    }
    const entries = log.getSnapshot();
    expect(entries).toHaveLength(200);
    // 最早的 5 条被丢弃，剩下的从 e5 开始。
    expect(entries[0]!.message).toBe("e5");
    expect(entries.at(-1)!.message).toBe("e204");
  });

  it("超长消息被截断", () => {
    const log = createDevErrorLog(() => 1000);
    log.report({ kind: "error", origin: "page", message: "a".repeat(5000), stack: null, source: null });
    const message = log.getSnapshot()[0]!.message;
    expect(message.length).toBeLessThan(2100);
    expect(message.endsWith("（已截断）")).toBe(true);
  });

  it("clear 清空记录", () => {
    const log = createDevErrorLog(() => 1000);
    log.report({ kind: "error", origin: "page", message: "x", stack: null, source: null });
    log.clear();
    expect(log.getSnapshot()).toHaveLength(0);
  });
});

describe("install / uninstall", () => {
  let log: ReturnType<typeof createDevErrorLog>;

  beforeEach(() => {
    log = createDevErrorLog(() => 1000);
    log.install();
  });

  afterEach(() => {
    log.uninstall();
  });

  it("捕获 window error 事件", () => {
    window.dispatchEvent(new ErrorEvent("error", { message: "window-boom", error: new Error("window-boom") }));
    const entries = log.getSnapshot();
    expect(entries.some(entry => entry.message === "window-boom")).toBe(true);
    expect(entries[0]!.origin).toBe("page");
  });

  it("资源加载失败单独记成资源错误，不冒充 JS 异常", () => {
    // `<img>` 加载失败触发的是普通 Event，target 是元素，没有 message / error。
    // 不区分就会记成一条信息全无的「未捕获异常」。
    const image = document.createElement("img");
    image.src = "/missing-texture.png";
    document.body.appendChild(image);

    const event = new Event("error");
    Object.defineProperty(event, "target", { value: image });
    window.dispatchEvent(event);
    image.remove();

    const entry = log.getSnapshot()[0]!;
    expect(entry.message).toBe("资源加载失败：img: /missing-texture.png");
    expect(entry.message).not.toBe("未捕获异常");
    expect(entry.source).toBe("/missing-texture.png");
  });

  it("event.error 为 undefined 时保留 event.message，并用源码位置当堆栈", () => {
    // 跨域脚本 / throw 非 Error 值时浏览器会把 error 抹成 undefined。
    // 此时 event.message 是唯一真实报文，不能被「抛出了 undefined」覆盖掉。
    const event = new Event("error") as Event & {
      message?: string;
      error?: unknown;
      filename?: string;
      lineno?: number;
      colno?: number;
    };
    event.message = "Uncaught TypeError: real message";
    event.error = undefined;
    event.filename = "https://example.test/canvas.js";
    event.lineno = 42;
    event.colno = 7;
    window.dispatchEvent(event);

    const entry = log.getSnapshot()[0]!;
    expect(entry.message).toBe("Uncaught TypeError: real message");
    expect(entry.message).not.toContain("抛出了 undefined");
    expect(entry.source).toBe("https://example.test/canvas.js:42:7");
    // 没有 Error 对象时，源码位置要能当作堆栈读。
    expect(entry.stack).toBe("at https://example.test/canvas.js:42:7");
  });

  it("捕获 unhandledrejection", () => {
    // jsdom 没有 PromiseRejectionEvent 构造器，用普通事件带上同名属性。
    const event = new Event("unhandledrejection") as Event & { reason?: unknown };
    event.reason = new Error("rejected");
    window.dispatchEvent(event);
    expect(log.getSnapshot().some(entry => entry.message === "rejected" && entry.kind === "rejection")).toBe(true);
  });

  it("被 reject 但没有理由时给出可读描述，而不是字面 undefined", () => {
    const event = new Event("unhandledrejection") as Event & { reason?: unknown };
    event.reason = undefined;
    window.dispatchEvent(event);
    const entry = log.getSnapshot().find(candidate => candidate.kind === "rejection");
    expect(entry?.message).toBe("抛出了 undefined（无错误对象）");
    expect(entry?.message).not.toBe("undefined");
  });

  it("console.error 既被记录也照常输出", () => {
    // 先卸掉补丁再装 spy **再** 装回补丁：顺序反了的话 spy 会把我们的补丁整个替换掉，
    // 测到的就不是真实链路了。
    log.uninstall();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    log.install();
    try {
      console.error("console-boom", { code: 42 });
      expect(log.getSnapshot().some(entry => entry.message.includes("console-boom"))).toBe(true);
      // 原实现必须还在：别人的 console 行为不能被接管掉。
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      log.uninstall();
    }
  });

  it("接收渲染器 iframe 转发的错误", () => {
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: window.location.origin,
        data: { [DEV_ERROR_MESSAGE_FLAG]: true, kind: "error", message: "renderer-boom", stack: null, source: "bevy.wasm" }
      })
    );
    const entry = log.getSnapshot().find(entry => entry.message === "renderer-boom");
    expect(entry?.origin).toBe("renderer");
    expect(entry?.source).toBe("bevy.wasm");
  });

  it("忽略没有标记或跨域的 message", () => {
    window.dispatchEvent(new MessageEvent("message", { origin: window.location.origin, data: { hello: 1 } }));
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "https://evil.example",
        data: { [DEV_ERROR_MESSAGE_FLAG]: true, kind: "error", message: "cross-origin", stack: null, source: null }
      })
    );
    expect(log.getSnapshot()).toHaveLength(0);
  });

  it("uninstall 之后不再捕获", () => {
    log.uninstall();
    // 用 console.error 而不是派发 error 事件：store 有意**不** preventDefault，
    // 监听已卸下时派发合成 error 事件会被运行器当成真正的未捕获异常。
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      console.error("after");
    } finally {
      spy.mockRestore();
    }
    expect(log.getSnapshot()).toHaveLength(0);
    // afterEach 会再 uninstall 一次；重复调用必须安全。
    log.uninstall();
  });

  it("重复 install 不会重复记录", () => {
    // 先卸掉 beforeEach 装的那份，再装 spy，最后才 install：这样补丁挂在 spy 外层，
    // 调用链才是 真实的 console.error → 我们的补丁 → spy。
    log.uninstall();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    log.install();
    log.install();
    try {
      console.error("once");
    } finally {
      spy.mockRestore();
    }
    expect(log.getSnapshot().filter(entry => entry.message === "once")).toHaveLength(1);
  });
});
