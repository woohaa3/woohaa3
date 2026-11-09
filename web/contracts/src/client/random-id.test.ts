import { afterEach, describe, expect, it } from "vitest";
import { randomId, randomIdHex } from "./random-id.js";

/**
 * 这些用例的核心目的：**在非安全上下文里也不能抛**。
 *
 * 浏览器只在安全上下文（HTTPS / localhost / 127.0.0.1 / file://）里提供
 * `crypto.randomUUID`；通过局域网 IP 的普通 HTTP 打开时它是 `undefined`，
 * 裸调用会让整个页面「启动失败」（实测报错 `crypto.randomUUID is not a function`）。
 *
 * 用属性覆盖模拟三种上下文；`globalThis.crypto` 是 getter，只能临时替换再还原。
 */
const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");

function withCrypto<T>(fake: unknown, run: () => T): T {
  Object.defineProperty(globalThis, "crypto", { value: fake, configurable: true, writable: true });
  try {
    return run();
  } finally {
    if (original) Object.defineProperty(globalThis, "crypto", original);
    else delete (globalThis as { crypto?: unknown }).crypto;
  }
}

afterEach(() => {
  if (original) Object.defineProperty(globalThis, "crypto", original);
});

describe("randomId", () => {
  it("安全上下文：直接使用原生 randomUUID", () => {
    let calls = 0;
    const result = withCrypto(
      {
        randomUUID: () => {
          calls += 1;
          return "native-uuid";
        },
        getRandomValues: (buffer: Uint8Array) => buffer
      },
      () => randomId()
    );
    expect(result).toBe("native-uuid");
    expect(calls).toBe(1);
  });

  it("非安全上下文：crypto 在但没有 randomUUID 时仍产出 v4 形状 ID", () => {
    const result = withCrypto({ getRandomValues: (buffer: Uint8Array) => buffer.fill(0xab) }, () => randomId());
    // 不能抛，且形状与 UUID v4 一致——调用方会把它写进 commandId / requestId。
    expect(result).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("完全没有 crypto：退回时间戳 + 随机，不抛", () => {
    const result = withCrypto(undefined, () => randomId());
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(8);
  });
});

describe("randomIdHex", () => {
  it("三种上下文下都产出十六进制串", () => {
    expect(withCrypto({ getRandomValues: (b: Uint8Array) => b.fill(0x12) }, () => randomIdHex())).toBe("12".repeat(16));
    expect(withCrypto({ getRandomValues: (b: Uint8Array) => b.fill(0x34) }, () => randomIdHex())).toBe("34".repeat(16));
    expect(withCrypto(undefined, () => randomIdHex())).toMatch(/^[0-9a-z]+$/);
  });

  it("同一上下文内连续生成不重复", () => {
    const cryptoRef = globalThis.crypto;
    const ids = withCrypto(
      { getRandomValues: (b: Uint8Array<ArrayBuffer>) => cryptoRef.getRandomValues(b) },
      () => Array.from({ length: 200 }, () => randomId())
    );
    expect(new Set(ids).size).toBe(ids.length);
  });
});
