import { describe, expect, it, vi } from "vitest";
import { installRendererFaultDetails } from "./renderer-fault-details.js";

describe("renderer fault details", () => {
  it("preserves the first Rust panic before a generic cross-realm WASM trap", () => {
    const log = vi.fn(), output = { error: log };
    const details = installRendererFaultDetails(output);
    output.error("unrelated validation warning");
    output.error("panicked at src/example.rs:42:9:\nindex out of bounds\n\nStack:\nwasm-function[123]");
    output.error("panicked at later.rs:1:1:\nsecondary failure");
    const result = details({ stack: "RuntimeError: unreachable\nwasm-function[456]" }, "Uncaught RuntimeError: unreachable");
    expect(result).toContain("src/example.rs:42:9");
    expect(result).toContain("index out of bounds");
    expect(result).toContain("wasm-function[456]");
    expect(result).not.toContain("unrelated validation warning");
    expect(result).not.toContain("secondary failure");
    expect(log).toHaveBeenCalledTimes(3);
  });

  it("bounds diagnostics per realm and tolerates inaccessible stacks", () => {
    const details = installRendererFaultDetails({ error: vi.fn() });
    const other = { error: vi.fn() }, isolated = installRendererFaultDetails(other);
    other.error("panicked at " + "x".repeat(10000));
    expect(isolated(new Error("unreachable".repeat(1000)))).toHaveLength(4000);
    expect(details({ get stack() { throw new Error("denied"); } }, "trap")).toBe("trap");
    expect(details(new Error("plain"))).toContain("plain");
    expect(details(new Error("plain"))).not.toContain("panicked at");
  });
});
