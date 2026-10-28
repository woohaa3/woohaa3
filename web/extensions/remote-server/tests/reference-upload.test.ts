/**
 * 参考输入落点：画布托管对象优先，主体命名空间兜底。
 *
 * 这里钉住的是「明明画布里已经有这张图，却复制到 actor/ 后管理端看不到」的回归：
 * - 画布键命中且大小一致：返回画布 locator，不再 put；
 * - 大小不一致 / head 失败 / 没有画布身份：回退到 actor/ 上传（与旧行为一致）；
 * - 没有会话主体：返回 undefined（由 provider 收敛成「尚未连接远端服务」）。
 */
import { describe, expect, it } from "vitest";
import type { StorageBackend } from "@woohaa3/contracts";
import { uploadReference } from "../src/backend/storage/reference-upload.js";

type PutCall = { key: string; bytes: Uint8Array; contentType: string; scope?: unknown };

function fakeBackend(options: {
  objects?: Map<string, { size: number; contentType?: string }>;
  headThrows?: boolean;
  withLocator?: boolean;
} = {}) {
  const puts: PutCall[] = [];
  const heads: string[] = [];
  const objects = options.objects ?? new Map();
  const backend: Pick<StorageBackend, "head" | "put" | "locatorOf"> = {
    async head(key) {
      heads.push(key);
      if (options.headThrows) throw new Error("network down");
      const found = objects.get(key);
      return found ? { size: found.size, ...(found.contentType ? { contentType: found.contentType } : {}) } : null;
    },
    async put(key, bytes, contentType, scope) {
      puts.push({ key, bytes, contentType, scope });
    },
    ...(options.withLocator === false
      ? {}
      : { async locatorOf(key: string) { return `media://server/${key}`; } })
  };
  return { backend, puts, heads };
}

const bytes = new Uint8Array([1, 2, 3, 4]);
const CANVAS = "canvas-a";
const KEY = "generation-inputs/abc.png";
const CANVAS_KEY = `${CANVAS}/media/${KEY}`;

describe("uploadReference", () => {
  it("画布对象已存在且大小一致：复用它，不再上传副本", async () => {
    const fake = fakeBackend({ objects: new Map([[CANVAS_KEY, { size: bytes.byteLength }]]) });
    const locator = await uploadReference(
      { backend: fake.backend, subject: "alice" },
      { bytes, contentType: "image/png", canvasId: CANVAS, storageKey: KEY }
    );
    expect(locator).toBe(`media://server/${CANVAS_KEY}`);
    expect(fake.heads).toEqual([CANVAS_KEY]);
    expect(fake.puts).toHaveLength(0);
  });

  it("同名对象大小不一致：不能拿旧内容冒充这次参考图，回退上传", async () => {
    const fake = fakeBackend({ objects: new Map([[CANVAS_KEY, { size: bytes.byteLength + 1 }]]) });
    const locator = await uploadReference(
      { backend: fake.backend, subject: "alice" },
      { bytes, contentType: "image/png", canvasId: CANVAS, storageKey: KEY }
    );
    expect(locator).toMatch(/^media:\/\/server\/actor\/[0-9a-f]{64}\/media\/reference-inputs\/abc\.png$/);
    expect(fake.puts).toHaveLength(1);
    expect(fake.puts[0].key).toMatch(/^actor\/[0-9a-f]{64}\/media\/reference-inputs\/abc\.png$/);
  });

  it("画布尚未登记或没有读权限（head 抛错）：仍能回退上传", async () => {
    const fake = fakeBackend({ headThrows: true });
    const locator = await uploadReference(
      { backend: fake.backend, subject: "alice" },
      { bytes, contentType: "image/png", canvasId: CANVAS, storageKey: KEY }
    );
    expect(locator).toContain("/actor/");
    expect(fake.puts).toHaveLength(1);
  });

  it("没有画布身份：维持主体命名空间上传", async () => {
    const fake = fakeBackend();
    const locator = await uploadReference(
      { backend: fake.backend, subject: "alice" },
      { bytes, contentType: "image/png", storageKey: KEY }
    );
    expect(locator).toContain("/actor/");
    expect(fake.heads).toHaveLength(0);
    expect(fake.puts).toHaveLength(1);
  });

  it("没有稳定键时按字节现算文件名", async () => {
    const fake = fakeBackend();
    await uploadReference({ backend: fake.backend, subject: "alice" }, { bytes, contentType: "image/png" });
    expect(fake.puts[0].key).toMatch(/^actor\/[0-9a-f]{64}\/media\/reference-inputs\/[0-9a-f]{64}$/);
  });

  it("没有会话主体：返回 undefined，不写任何对象", async () => {
    const fake = fakeBackend();
    const locator = await uploadReference({ backend: fake.backend, subject: "" }, { bytes, contentType: "image/png" });
    expect(locator).toBeUndefined();
    expect(fake.puts).toHaveLength(0);
  });

  it("后端不支持 locatorOf：上传完成但拿不到定位符，返回 undefined", async () => {
    const fake = fakeBackend({ withLocator: false });
    const locator = await uploadReference(
      { backend: fake.backend, subject: "alice" },
      { bytes, contentType: "image/png", storageKey: KEY }
    );
    expect(locator).toBeUndefined();
    expect(fake.puts).toHaveLength(1);
  });
});
