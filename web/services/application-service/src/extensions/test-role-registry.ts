import { createAgentRoleRegistry } from "../agent-roles/registry.js";

export function testRoleRegistry() {
  const registry = createAgentRoleRegistry({ availableTools: () => [] });
  const registered = registry.register({
    extensionId: "test",
    artifactId: "test@1",
    implementation: {
      definition: {
        id: "discussion",
        revision: "1",
        title: "测试讨论",
        specialty: "会话账本测试",
        instructions: "按用户输入回复。",
        inputSchema: { type: "object" },
        contextSchema: { type: "object" },
        tools: { required: [], optional: [] },
        nativeCapabilities: { required: [], optional: [] },
        requirements: { imageInput: false, toolCalling: false, structuredOutput: "none" },
        output: { kind: "reply" }
      },
      prepare: ({ input }) => ({
        messages: [{ role: "user", content: typeof (input as { prompt?: unknown })?.prompt === "string" ? (input as { prompt: string }).prompt : "继续" }]
      })
    }
  });
  if (!registered.ok) throw new Error(registered.message);
  return registry;
}
