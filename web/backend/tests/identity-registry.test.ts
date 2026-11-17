import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  IDENTITY_REGISTRY_SCHEMA,
  readRegistry,
  registryDirFrom,
  registryFileOf,
  removeRegistryEntry,
  writeRegistryEntry
} from "../src/host/identity-registry.js";

/**
 * 实例登记表：写入方规则。
 *
 * 读取方是 `dsh-plugins/woohaa-attach` 的 `resolveRegistryDir`，两边算不出同一个目录就等于
 * 没有登记表。这一组把写入方的规则逐字钉住，特别是**没有 uid 时不加后缀**那条——POSIX 上
 * `getuid` 一定存在，所以只有显式覆盖 `uid: undefined` 才能测到 Windows 那条路径。
 */
describe("registryDirFrom", () => {
  it("没有 uid（Windows）时不加 -0 后缀", () => {
    const dir = registryDirFrom({ uid: undefined, tmpdir: "/tmp/base" });
    expect(dir.replace(/\\/g, "/")).toBe("/tmp/base/woohaa3/instances");
  });

  it("有 uid 时用 instances-<uid>", () => {
    const dir = registryDirFrom({ uid: 501, tmpdir: "/tmp/base" });
    expect(dir.replace(/\\/g, "/")).toBe("/tmp/base/woohaa3/instances-501");
  });

  it("XDG_RUNTIME_DIR 优先于临时目录，且不按 uid 分子目录", () => {
    const dir = registryDirFrom({ xdgRuntimeDir: "/run/user/501", uid: 501, tmpdir: "/tmp/base" });
    expect(dir.replace(/\\/g, "/")).toBe("/run/user/501/woohaa3/instances");
  });

  it("空白 XDG_RUNTIME_DIR 当作没设置", () => {
    const dir = registryDirFrom({ xdgRuntimeDir: "   ", uid: undefined, tmpdir: "/tmp/base" });
    expect(dir.replace(/\\/g, "/")).toBe("/tmp/base/woohaa3/instances");
  });
});

describe("登记读写", () => {
  const withDir = (run: (dir: string) => void): void => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "identity-registry-"));
    try {
      run(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  it("写进去的条目能被读回来", () => {
    withDir((dir) => {
      writeRegistryEntry(dir, {
        schema: IDENTITY_REGISTRY_SCHEMA,
        instanceId: "abc123",
        origin: "http://127.0.0.1:54605",
        apiOrigin: "http://127.0.0.1:54606",
        dataDir: "C:\\data",
        startedAt: "2026-11-17T09:49:55.903Z",
        pid: 1234,
        version: "0.1.25"
      });
      const entries = readRegistry(dir);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ instanceId: "abc123", origin: "http://127.0.0.1:54605" });
      expect(entries[0].apiOrigin).toBe("http://127.0.0.1:54606");
    });
  });

  it("坏文件与未知 schema 被跳过，不让一条脏记录毁掉整表", () => {
    withDir((dir) => {
      writeRegistryEntry(dir, {
        schema: IDENTITY_REGISTRY_SCHEMA,
        instanceId: "good",
        origin: "http://127.0.0.1:4173",
        dataDir: "/d",
        startedAt: "",
        pid: 1,
        version: ""
      });
      fs.writeFileSync(path.join(dir, "broken.json"), "{ not json", "utf8");
      fs.writeFileSync(path.join(dir, "v2.json"), JSON.stringify({ schema: 2, instanceId: "future" }), "utf8");
      expect(readRegistry(dir).map((entry) => entry.instanceId)).toEqual(["good"]);
    });
  });

  it("撤销登记后目录里不再有那一条", () => {
    withDir((dir) => {
      writeRegistryEntry(dir, {
        schema: IDENTITY_REGISTRY_SCHEMA,
        instanceId: "gone",
        origin: "http://127.0.0.1:4173",
        dataDir: "/d",
        startedAt: "",
        pid: 1,
        version: ""
      });
      expect(fs.existsSync(registryFileOf(dir, "gone"))).toBe(true);
      removeRegistryEntry(dir, "gone");
      expect(fs.existsSync(registryFileOf(dir, "gone"))).toBe(false);
      // 再删一次也算成功（退出路径不该因为条目已不存在而失败）。
      expect(() => removeRegistryEntry(dir, "gone")).not.toThrow();
    });
  });

  it("目录不存在时读回空数组，不抛异常", () => {
    expect(readRegistry(path.join(os.tmpdir(), "definitely-not-there-woohaa"))).toEqual([]);
  });
});
