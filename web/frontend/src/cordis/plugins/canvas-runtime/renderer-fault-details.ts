import { errorDetail } from "./runtime-issues.js";

/** Each renderer realm retains its first Rust panic, which precedes the generic WASM trap. */
export function installRendererFaultDetails(output: Pick<Console, "error">) {
  let panic = "";
  const original = output.error.bind(output);
  output.error = (...args: unknown[]) => {
    try {
      if (!panic) {
        const message = args.find((value): value is string => typeof value === "string"
          && /(?:^|\n)(?:panicked at|thread .* panicked at)/.test(value));
        if (message) panic = message.slice(0, 3200);
      }
    } catch { /* Capturing diagnostics cannot interrupt rendering. */ }
    original(...args);
  };
  return (error: unknown, fallback?: string): string => {
    let stack = "";
    try {
      if (error && typeof error === "object" && "stack" in error && typeof error.stack === "string")
        stack = error.stack;
    } catch { /* Cross-realm/hostile errors may not expose a stack. */ }
    const message = fallback || errorDetail(error);
    return [panic, message, stack].filter(Boolean).join("\n\n").slice(0, 4000);
  };
}
