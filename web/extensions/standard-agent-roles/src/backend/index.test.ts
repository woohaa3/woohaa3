import { describe, expect, it, vi } from "vitest";
import type { ApplicationBackendHost, AgentRoleImplementation } from "@woohaa3/contracts";
import { createStandardAgentRolesExtension, STANDARD_AGENT_ROLES } from "./index.js";

function host(registered: AgentRoleImplementation[], hasRegister = true): ApplicationBackendHost {
  return {
    extensionId: "standard-agent-roles",
    ...(hasRegister ? { registerAgentRole: (implementation: AgentRoleImplementation) => { registered.push(implementation); return () => undefined; } } : {}),
    logger: vi.fn()
  } as unknown as ApplicationBackendHost;
}

describe("standard-agent-roles extension", () => {
  it("激活时注册全部标准角色，归属由宿主记账", () => {
    const registered: AgentRoleImplementation[] = [];
    createStandardAgentRolesExtension().activate(host(registered));
    expect(registered.map((implementation) => implementation.definition.id)).toEqual(
      STANDARD_AGENT_ROLES.map((implementation) => implementation.definition.id)
    );
  });

  it("宿主没有角色注册面时明确跳过，不伪造实现", () => {
    const logger = vi.fn();
    const definition = createStandardAgentRolesExtension();
    definition.activate({ extensionId: "standard-agent-roles", logger } as unknown as ApplicationBackendHost);
    expect(logger).toHaveBeenCalledWith(expect.objectContaining({ event: "standard-agent-roles-disabled" }));
  });
});
