/**
 * 日志归一测试（change: unify-host-client-logging，任务 1.4）。
 *
 * 锁定四件事：
 * - **向后兼容**：扩展现有的 `{ event, ...任意字段 }` 写法不改一行仍然可用；
 * - **有界**：message / 属性值 / 属性对数都有上限；
 * - **可分析**：module/event/errorCode 形状固定，非法输入被修正而不是丢整条；
 * - **永不抛错**：怪输入退化成最小记录。
 */
import { describe, expect, it } from "vitest";
import { normalizeLogRecord, type NormalizeLogInput } from "./normalize.js";
import { REDACTED } from "./redact.js";
import { LOG_LIMITS } from "./record.js";

const NOW = Date.UTC(2026, 10, 4, 2, 30, 0);

function normalize(raw: Record<string, unknown>, overrides: Partial<NormalizeLogInput> = {}) {
  return normalizeLogRecord({
    module: "task",
    runtime: "host",
    raw,
    now: NOW,
    ...overrides
  });
}

describe("信封必填字段", () => {
  it("补齐 schema/time/level/runtime/module/event", () => {
    const record = normalize({ event: "task-queued" });
    expect(record.schema).toBe(1);
    expect(record.time).toBe(new Date(NOW).toISOString());
    expect(record.level).toBe("info");
    expect(record.runtime).toBe("host");
    expect(record.module).toBe("task");
    expect(record.event).toBe("task-queued");
  });

  it("缺失 event 时退化为 log", () => {
    expect(normalize({}).event).toBe("log");
  });

  it("非法 module 被 slug 化而不是丢记录", () => {
    expect(normalize({}, { module: "Task Runtime!" }).module).toBe("task-runtime");
  });

  it("module 完全无法 slug 时退化为 unknown", () => {
    expect(normalize({}, { module: "!!! " }).module).toBe("unknown");
  });
});

describe("级别读取", () => {
  it("接受字符串级别", () => {
    expect(normalize({ level: "warn" }).level).toBe("warn");
  });

  it("大小写不敏感", () => {
    expect(normalize({ level: "ERROR" }).level).toBe("error");
  });

  it("Cordis 数值级别映射", () => {
    expect(normalize({ level: 0 }).level).toBe("error");
    expect(normalize({ level: 2 }).level).toBe("warn");
    expect(normalize({ level: 3 }).level).toBe("debug");
  });

  it("非法级别退回 info", () => {
    expect(normalize({ level: "verbose" }).level).toBe("info");
  });
});

describe("message 与其他字段分离", () => {
  it("message 被收进独立字段，不进 attrs", () => {
    const record = normalize({ event: "x", message: "hello", count: 3 });
    expect(record.message).toBe("hello");
    expect(record.attrs).toEqual({ count: 3 });
  });

  it("detail 与 msg 是 message 的别名", () => {
    expect(normalize({ detail: "from detail" }).message).toBe("from detail");
    expect(normalize({ msg: "from msg" }).message).toBe("from msg");
  });

  it("message 受长度上限约束", () => {
    const record = normalize({ message: "x".repeat(LOG_LIMITS.message * 2) });
    expect(Array.from(record.message!).length).toBe(LOG_LIMITS.message);
  });
});

describe("attrs 投影", () => {
  it("标量保留类型，便于按数值聚合", () => {
    const record = normalize({ event: "x", count: 3, ok: true, label: "a" });
    expect(record.attrs).toEqual({ count: 3, ok: true, label: "a" });
  });

  it("对象序列化成文本", () => {
    const record = normalize({ event: "x", detail_obj: { a: 1 } });
    expect(record.attrs).toEqual({ detail_obj: '{"a":1}' });
  });

  it("属性值受长度上限约束", () => {
    const record = normalize({ event: "x", big: "y".repeat(LOG_LIMITS.attributeValue * 2) });
    expect(Array.from(String(record.attrs!.big)).length).toBe(LOG_LIMITS.attributeValue);
  });

  it("属性对数受上限约束", () => {
    const raw: Record<string, unknown> = { event: "x" };
    for (let index = 0; index < LOG_LIMITS.attributes + 10; index += 1) raw[`k${index}`] = index;
    expect(Object.keys(normalize(raw).attrs!).length).toBe(LOG_LIMITS.attributes);
  });

  it("没有剩余字段时省略 attrs", () => {
    expect(normalize({ event: "x", level: "warn" }).attrs).toBeUndefined();
  });
});

describe("脱敏在归一里生效", () => {
  it("message 里的 token 被打码", () => {
    expect(normalize({ message: "token=abc123" }).message).toBe(`token=${REDACTED}`);
  });

  it("敏感键名的值被替换，键名保留", () => {
    const record = normalize({ event: "x", access_token: "abc123" });
    expect(record.attrs).toEqual({ access_token: REDACTED });
  });
});

describe("可选的关联字段", () => {
  it("合法 traceId 被采纳", () => {
    expect(normalize({ traceId: "4BF92F3577B34DA6A3CE929D0E0E4736" }).traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
  });

  it("非法 traceId 被丢弃", () => {
    expect(normalize({ traceId: "not-a-trace" }).traceId).toBeUndefined();
  });

  it("pid 与 runId 透传", () => {
    const record = normalize({ event: "x" }, { pid: 4242, runId: "run-1" });
    expect(record.pid).toBe(4242);
    expect(record.runId).toBe("run-1");
  });

  it("空 runId 被省略", () => {
    expect(normalize({ event: "x" }, { runId: "" }).runId).toBeUndefined();
  });
});

describe("errorCode", () => {
  it("合法码保留并小写化", () => {
    expect(normalize({ errorCode: "E_TIMEOUT" }).errorCode).toBe("e_timeout");
  });

  it("非法码丢弃", () => {
    expect(normalize({ errorCode: "not a code!" }).errorCode).toBeUndefined();
  });
});

describe("健壮性", () => {
  it("永远不抛错：循环引用输入", () => {
    const raw: Record<string, unknown> = { event: "x" };
    raw.self = raw;
    expect(() => normalize(raw)).not.toThrow();
  });

  it("怪输入仍产出可用的最小记录", () => {
    const record = normalize({ event: 123, level: {}, message: null });
    expect(record.schema).toBe(1);
    expect(record.event).toBe("log");
    expect(record.level).toBe("info");
  });
});
