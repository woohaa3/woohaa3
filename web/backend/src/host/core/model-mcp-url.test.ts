import { describe, expect, it } from "vitest";
import { internalModelMcpEndpoint, internalModelMcpUrl } from "./model-mcp-url.js";

describe("内部受控 MCP endpoint", () => {
  it("根路径直接使用 /mcp/model-canvas", () => {
    expect(internalModelMcpUrl({ port: 5181, basePath: "/" })).toBe("http://127.0.0.1:5181/mcp/model-canvas");
  });

  it("开发子路径必须保留应用挂载前缀", () => {
    expect(internalModelMcpUrl({ port: "5181", basePath: "/dev/68cd47d03258d06747b7/" })).toBe(
      "http://127.0.0.1:5181/dev/68cd47d03258d06747b7/mcp/model-canvas"
    );
  });

  it("容忍未规范化的末尾斜杠并保持端口缺省", () => {
    expect(internalModelMcpUrl({ port: "", basePath: "/canvas" })).toBe("http://127.0.0.1:5180/canvas/mcp/model-canvas");
  });

  it("缺少前导斜杠时补成合法挂载路径", () => {
    expect(internalModelMcpUrl({ port: 5181, basePath: "dev/app/" })).toBe("http://127.0.0.1:5181/dev/app/mcp/model-canvas");
  });

  it("回环 endpoint 跟随当前 env 端口，不在装配时拍死", () => {
    const env: { BACKEND_PORT?: string; PORT?: string } = { PORT: "5180" };
    const endpoint = internalModelMcpEndpoint(env, "/");
    expect(endpoint.name).toBe("woohaa");
    expect(endpoint.url).toBe("http://127.0.0.1:5180/mcp/model-canvas");
    env.BACKEND_PORT = "5181";
    expect(endpoint.url).toBe("http://127.0.0.1:5181/mcp/model-canvas");
  });
});
