/**
 * 复盘页 HTTP 客户端测试（change: 2026-10-25-enhance-telemetry-performance-collection，任务 4.3）。
 *
 * 这一层只做两件事：拼查询串、把响应解析成契约类型。两件都值得测：
 * - 拼串错了，界面看起来"筛了"其实没筛（最坏的一种静默错误）；
 * - 解析时漏了 `groupBy`，聚合表与耗时榜就永远按事件名，分组筛选变成死开关。
 */
import { describe, expect, it, vi } from "vitest";
import { createTelemetryRemote, type TelemetryTransport } from "./remote.js";

function transportReturning(data: unknown): TelemetryTransport & { paths: string[] } {
  const paths: string[] = [];
  return {
    paths,
    request: async (input) => {
      paths.push(input.path);
      return { ok: true, status: 200, data };
    }
  };
}

describe("遥测 HTTP 客户端", () => {
  it("构建模式筛选走 attributeKey/attributeValue（宿主只有一份属性筛选实现）", async () => {
    const transport = transportReturning({ events: [] });
    const remote = createTelemetryRemote({ transport });

    await remote.events({ window: "1h", mode: "production" });

    const path = transport.paths[0]!;
    expect(path).toContain("attributeKey=mode");
    expect(path).toContain("attributeValue=production");
    // 不额外发明 `mode=` 这种只有前端认识的参数。
    expect(path).not.toContain("mode=production");
  });

  it("summary 同时带 bucket 与 groupBy；anomalies 也带 groupBy（两者同口径）", async () => {
    const transport = transportReturning({
      window: "24h",
      bucket: "1h",
      rows: [],
      series: [],
      groupBy: "kind"
    });
    const remote = createTelemetryRemote({ transport });

    await remote.summary({ window: "24h", groupBy: "kind", mode: "dev" });
    await remote.anomalies({ window: "24h", groupBy: "kind" });

    expect(transport.paths[0]).toContain("bucket=1h");
    expect(transport.paths[0]).toContain("groupBy=kind");
    expect(transport.paths[0]).toContain("attributeKey=mode");
    expect(transport.paths[1]).toContain("groupBy=kind");
  });

  it("未指定分组时不写 groupBy（宿主据此返回按事件名的行）", async () => {
    const transport = transportReturning({ window: "24h", bucket: "1h", rows: [], series: [] });
    const remote = createTelemetryRemote({ transport });

    await remote.summary({ window: "24h" });

    expect(transport.paths[0]).not.toContain("groupBy=");
  });

  it("解析 summary 时保留 groupBy（丢掉它会让聚合表退回按事件名）", async () => {
    const transport = transportReturning({
      window: "24h",
      bucket: "1h",
      since: 1,
      until: 2,
      total: 3,
      groupBy: "kind",
      rows: [],
      series: []
    });
    const remote = createTelemetryRemote({ transport });

    const outcome = await remote.summary({ window: "24h", groupBy: "kind" });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.value.groupBy).toBe("kind");
  });

  it("响应不是对象时降级成 malformed，不抛到渲染层", async () => {
    const remote = createTelemetryRemote({ transport: transportReturning(null) });
    const outcome = await remote.summary({ window: "24h" });
    expect(outcome).toEqual({ ok: false, code: "malformed", error: "遥测服务返回了无法识别的响应" });
  });

  it("传输层抛错也降级成可读失败", async () => {
    const remote = createTelemetryRemote({
      transport: {
        request: vi.fn(async () => {
          throw new Error("socket closed");
        }) as unknown as TelemetryTransport["request"]
      }
    });
    const outcome = await remote.status();
    expect(outcome).toEqual({ ok: false, code: "unavailable", error: "socket closed" });
  });
});
