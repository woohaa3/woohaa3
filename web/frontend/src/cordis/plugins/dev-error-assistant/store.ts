/**
 * 开发期报错捕获（change: 2026-10-30-add-dev-error-assistant）。
 *
 * 画布出问题时的现场分三处，缺一处就定位不到：
 * 1. **主窗口**的 `window.onerror` / `unhandledrejection` —— React、插件、业务代码；
 * 2. **渲染器 iframe**（`renderer.html`）里的同类错误 —— 画布本体（Bevy/WASM）在这里，
 *    它跨不了 iframe 边界，只能由入口侧转发过来；
 * 3. **只 console 不 throw** 的路径 —— 不少库把失败写成 `console.error` 后继续跑，
 *    不接管就完全看不见。
 *
 * 三条都接上，汇总成一份有界的环形记录，供左下角浮标读取。
 *
 * 只捕获、不改行为：不吞异常、不阻止默认处理（`preventDefault` 一个都不调），
 * 所以接上它不会让本来会崩的地方变得不崩，也不会掩盖真实错误。
 */

export type CapturedErrorKind = "error" | "rejection" | "console";

export type CapturedErrorOrigin = "page" | "renderer";

export type CapturedError = {
  id: string;
  /** 毫秒时间戳。 */
  at: number;
  kind: CapturedErrorKind;
  origin: CapturedErrorOrigin;
  message: string;
  stack: string | null;
  /** 触发位置（脚本地址 + 行列），拿得到才有。 */
  source: string | null;
  /** 同一条错误重复出现的次数（去重后累加，不重复占位）。 */
  count: number;
};

/** 最多保留多少条。超出的从最旧的开始丢 —— 画布卡死时可能瞬间刷出成百上千条。 */
const MAX_ENTRIES = 200;

/** 堆栈保留前几帧。完整堆栈在长帧里能到几百行，面板里根本读不下去。 */
const MAX_STACK_LINES = 16;

/** 同一条错误在这段时间内再次出现，只累加计数，不新增条目。 */
const DEDUPE_WINDOW_MS = 3000;

/** 单条消息长度上限。 */
const MAX_MESSAGE_CHARS = 2000;

export type DevErrorLog = {
  getSnapshot(): readonly CapturedError[];
  subscribe(listener: () => void): () => void;
  /** 手动记一条（渲染器转发、或其它模块想上报）。 */
  report(input: Omit<CapturedError, "id" | "at" | "count">): void;
  clear(): void;
  /** 装上全部监听；重复调用无副作用。 */
  install(): void;
  /** 卸下全部监听并清空（测试用）。 */
  uninstall(): void;
};

/** 渲染器 iframe → 父窗口的转发消息标记。 */
export const DEV_ERROR_MESSAGE_FLAG = "__sixiDevError";

/** 渲染器侧发送时用的负载结构（`runtime-realm-entry.ts` 与这里共用）。 */
export type DevErrorRelayPayload = {
  [DEV_ERROR_MESSAGE_FLAG]: true;
  kind: CapturedErrorKind;
  message: string;
  stack: string | null;
  source: string | null;
};

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…（已截断）`;
}

/**
 * 裁到前若干帧。
 *
 * 保留**每一行的缩进**：栈里真正有用的信息是「哪个文件哪一行」，截平了就分不清层级。
 */
function trimStack(stack: string | undefined): string | null {
  if (!stack) return null;
  const lines = stack.split("\n");
  if (lines.length <= MAX_STACK_LINES) return stack;
  return `${lines.slice(0, MAX_STACK_LINES).join("\n")}\n…（还有 ${lines.length - MAX_STACK_LINES} 帧）`;
}

/**
 * 把 `ErrorEvent` 的源码位置拼成一行伪堆栈。
 *
 * 跨域脚本（或 `throw` 非 Error 值）拿不到 `event.error`，也就没有堆栈。这时
 * `filename:line:col` 是唯一的定位线索，直接放进「堆栈」栏比留空有用得多。
 */
function sourceFromFormatted(event: ErrorEvent): string | null {
  if (!event.filename) return null;
  const line = event.lineno ?? 0;
  const column = event.colno ?? 0;
  return `at ${event.filename}:${line}:${column}`;
}

/** 从任意 thrown 值里取消息与堆栈。`throw "字符串"` 也要能读。 */function readThrown(value: unknown): { message: string; stack: string | null } {
  if (value instanceof Error) {
    return { message: value.message || value.name || "未知异常", stack: trimStack(value.stack) };
  }
  if (typeof value === "string") return { message: value, stack: null };
  // `undefined` / `null` —— 例如 `throw undefined`、被 reject 却没有理由。
  // 直接 `String(value)` 会得到 "undefined"，读起来像错误内容本身，必须换成可读描述。
  if (value === undefined || value === null) {
    return { message: `抛出了 ${String(value)}（无错误对象）`, stack: null };
  }
  try {
    return { message: JSON.stringify(value) ?? String(value), stack: null };
  } catch {
    return { message: "无法读取异常内容", stack: null };
  }
}

/**
 * 判断这条 `error` 事件是不是**资源加载失败**（而不是 JS 异常）。
 *
 * 两者共用同一个事件名，但资源失败的事件对象是普通 `Event`：`target` 是
 * `<img>` / `<script>` / `<link>` / `<video>` 等元素，没有 `message` / `error` / `filename`。
 * 返回可读标签（`img: 地址`），不是资源失败则返回 null。
 */
function resourceErrorOf(event: Event): string | null {
  const target = event.target;
  if (!(target instanceof Element)) return null;
  // JS 异常在 `window` 上触发，target 不可能是元素 —— 走到这里说明是资源失败。
  const tag = target.tagName.toLowerCase();
  if (!["img", "script", "link", "video", "audio", "source", "iframe", "track", "object", "embed"].includes(tag)) {
    return null;
  }
  const url = resourceUrl(target);
  return url ? `${tag}: ${url}` : tag;
}

/** 从资源元素上取它想加载的地址（各标签的属性名不同）。 */
function resourceUrl(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  const candidate =
    target.getAttribute("src") ??
    target.getAttribute("href") ??
    target.getAttribute("poster") ??
    target.getAttribute("data");
  return candidate?.trim() || null;
}

/** 去重键：同源 + 同消息 + 同堆栈首帧才算同一条。 */
function dedupeKey(kind: CapturedErrorKind, origin: CapturedErrorOrigin, message: string, stack: string | null): string {
  const firstFrame = stack?.split("\n")[1]?.trim() ?? "";
  return `${origin}|${kind}|${message}|${firstFrame}`;
}

export function createDevErrorLog(now: () => number = Date.now): DevErrorLog {
  let entries: readonly CapturedError[] = [];
  const listeners = new Set<() => void>();
  /** 去重键 → 上次记录的时间与条目 id。 */
  const recent = new Map<string, { at: number; id: string }>();
  let sequence = 0;

  const emit = () => {
    for (const listener of listeners) listener();
  };

  const report: DevErrorLog["report"] = input => {
    const message = truncate(input.message, MAX_MESSAGE_CHARS);
    const key = dedupeKey(input.kind, input.origin, message, input.stack);
    const at = now();
    const previous = recent.get(key);
    if (previous && at - previous.at < DEDUPE_WINDOW_MS) {
      // 同一条错误反复触发：只把计数加一，不占新位置，也不把列表刷到底。
      previous.at = at;
      entries = entries.map(entry =>
        entry.id === previous.id ? { ...entry, count: entry.count + 1, at } : entry
      );
      emit();
      return;
    }
    sequence += 1;
    const id = `dev-error-${sequence}`;
    recent.set(key, { at, id });
    // 环形裁剪：一次性丢弃最旧的多条，避免每来一条就重建整个数组。
    const next = [...entries, { ...input, message, id, at, count: 1 }];
    entries = next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;
    emit();
  };

  let installed = false;
  const teardown: Array<() => void> = [];

  const install: DevErrorLog["install"] = () => {
    if (installed) return;
    if (typeof window === "undefined") return;
    installed = true;

    // 1) 未捕获异常。用监听而不是覆写 `window.onerror`：覆写会踩掉别人的处理器
    //    （宿主或扩展可能已经挂了一个），而监听可以共存。
    const onError = (event: Event) => {
      // **资源加载失败与 JS 异常共用 `error` 事件**，但两者完全不同：
      // `<img>` / `<script>` / `<link>` / `<video>` 加载失败时触发的是普通 `Event`，
      // `target` 是那个元素，既没有 `message` 也没有 `error` / `filename`。
      // 不做区分就会把它们记成一条信息全无的「未捕获异常」（踩过）。
      const resource = resourceErrorOf(event);
      if (resource) {
        report({
          kind: "error",
          origin: "page",
          message: `资源加载失败：${resource}`,
          stack: null,
          source: resourceUrl(event.target)
        });
        return;
      }

      const errorEvent = event as ErrorEvent;
      const fromSource = errorEvent.filename
        ? `${errorEvent.filename}:${errorEvent.lineno}:${errorEvent.colno}`
        : null;
      const hasErrorObject = errorEvent.error !== undefined && errorEvent.error !== null;
      const thrown = hasErrorObject ? readThrown(errorEvent.error) : { message: "", stack: null };
      // **`event.message` 优先**：脚本跨域（没有 CORS 头）时浏览器会把 `event.error`
      // 抹成 undefined，但 `event.message` 仍是真实报文。反过来用 `readThrown` 的结果
      // 会把这条真实信息覆盖成「抛出了 undefined」，等于把唯一线索丢了。
      const message = errorEvent.message?.trim() || thrown.message || "未捕获异常（无消息）";
      report({
        kind: "error",
        origin: "page",
        message,
        // 没有 Error 对象时用「源码位置」当堆栈的替代 —— 那正是用户要找的「哪一行」。
        stack: thrown.stack ?? (hasErrorObject ? null : sourceFromFormatted(errorEvent)),
        source: fromSource
      });
    };
    // `capture: true` 才能在事件被别处 `stopPropagation` 时仍然收到：有些库在 window 上
    // 拦截 error 事件做自己的上报，冒泡阶段就轮不到我们了。
    window.addEventListener("error", onError, true);
    teardown.push(() => window.removeEventListener("error", onError, true));

    // 2) 未处理的 Promise 拒绝。这是异步代码失败最常见的落点，且很少进 window.onerror。
    const onRejection = (event: PromiseRejectionEvent) => {
      const thrown = readThrown(event.reason);
      report({
        kind: "rejection",
        origin: "page",
        message: thrown.message || "未处理的 Promise 拒绝",
        stack: thrown.stack,
        source: null
      });
    };
    window.addEventListener("unhandledrejection", onRejection);
    teardown.push(() => window.removeEventListener("unhandledrejection", onRejection));

    // 3) 只打 console 不 throw 的失败。保留原实现，只是旁听 —— 不能因为接管日志
    //    让别人丢了自己的 console 行为。
    const originalError = console.error;
    const patchedError: typeof console.error = (...args: unknown[]) => {
      try {
        const first = args[0];
        if (first instanceof Error) {
          report({ kind: "console", origin: "page", message: first.message, stack: trimStack(first.stack), source: null });
        } else {
          const text = args.map(arg => (typeof arg === "string" ? arg : safeString(arg))).join(" ");
          // 空调用（`console.error()`）没有诊断价值，别刷屏。
          if (text.trim()) report({ kind: "console", origin: "page", message: text, stack: null, source: null });
        }
      } finally {
        originalError.apply(console, args);
      }
    };
    console.error = patchedError;
    teardown.push(() => {
      // 只有还是我们这份补丁时才还原：别把后来者的替换又覆盖回去。
      if (console.error === patchedError) console.error = originalError;
    });

    // 4) 渲染器 iframe 转发过来的错误。校验 `event.source === iframe.contentWindow`
    //    这类信息拿不稳（iframe 会重建），所以改用消息标记 + 同源校验。
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as Partial<DevErrorRelayPayload> | null;
      if (!data || typeof data !== "object" || data[DEV_ERROR_MESSAGE_FLAG] !== true) return;
      report({
        kind: data.kind === "rejection" || data.kind === "console" ? data.kind : "error",
        origin: "renderer",
        message: typeof data.message === "string" ? data.message : "渲染器报错",
        stack: typeof data.stack === "string" ? trimStack(data.stack) : null,
        source: typeof data.source === "string" ? data.source : null
      });
    };
    window.addEventListener("message", onMessage);
    teardown.push(() => window.removeEventListener("message", onMessage));
  };

  const uninstall: DevErrorLog["uninstall"] = () => {
    if (!installed) return;
    installed = false;
    for (const fn of teardown.splice(0)) fn();
    entries = [];
    recent.clear();
    emit();
  };

  return {
    getSnapshot: () => entries,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    report,
    clear() {
      entries = [];
      recent.clear();
      emit();
    },
    install,
    uninstall
  };
}

/** `console.error` 的参数序列化；循环引用、代理抛错都要扛住（日志本身不能抛）。 */
function safeString(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === "function") return `[Function ${(value as { name?: string }).name || "anonymous"}]`;
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "[对象无法序列化]";
    }
  }
  return String(value);
}

/** 全应用共用一份。插件挂载时 `install()`，卸载时**不** `uninstall()` —— 见插件注释。 */
export const devErrorLog = createDevErrorLog();
