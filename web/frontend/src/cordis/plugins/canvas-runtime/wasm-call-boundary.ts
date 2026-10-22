import { errorDetail, type RuntimeIssues } from "./runtime-issues.js";

/** A trapped guest is poisoned; never keep calling it or label it recovered. */
export function protectWasmModule<T extends object>(raw: T, issues: RuntimeIssues, allowed: () => boolean = () => true): T {
  let fatal: unknown = null;
  const wrappers = new Map<PropertyKey, unknown>();
  return new Proxy({} as T, {
    get(_target, property) {
      const value = Reflect.get(raw, property);
      if (typeof value !== "function") return value;
      if (!wrappers.has(property)) wrappers.set(property, (...args: unknown[]) => {
        if (fatal !== null) throw fatal;
        if (!allowed()) throw new Error("画布渲染实例当前不可用");
        try {
          const current: unknown = Reflect.get(raw, property);
          if (typeof current !== "function") throw new Error(`WASM export ${String(property)} is unavailable`);
          return Reflect.apply(current, raw, args);
        }
        catch (error) {
          if (error instanceof WebAssembly.RuntimeError || (typeof error === "object" && error !== null && "name" in error && error.name === "RuntimeError")) {
            fatal = error;
            issues.report({ key: "runtime:trap", scope: "runtime", operation: String(property),
              message: "画布渲染器发生故障，当前预览已暂停，编辑现场仍保留。",
              detail: errorDetail(error), recoverable: false });
          }
          throw error;
        }
      });
      return wrappers.get(property);
    }
  });
}
