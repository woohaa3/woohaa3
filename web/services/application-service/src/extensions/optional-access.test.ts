import { expect, it, vi } from "vitest";
import { createAccessEnforcer } from "./access-enforcement.js";
import { resolveAuth, assertActions } from "../api/extension-api/auth.js";
import type { ApplicationExtensionApiDependencies } from "../api/extension-api/types.js";
import type { IncomingMessage } from "node:http";

const runtime = Object.freeze({ enabled: false as const, instance: Object.freeze({ kind: "instance" as const, id: "instance:x", ownerId: "instance:x", credentialOwnerId: "instance:x" }) });
it("无鉴权接缝不读取 provider、不认证、不生成默认 action 用户", async () => {
  const policy = vi.fn(() => { throw new Error("must not resolve"); });
  const authenticator = vi.fn(async () => { throw new Error("must not authenticate"); });
  const enforcer = createAccessEnforcer({ runtime, siteAccessPolicy: policy, resourceAccessPolicy: policy });
  await enforcer.assertAction(undefined, "models.manage");
  await enforcer.assertResource(undefined, { kind: "canvas", id: "c" }, "write");
  expect(await enforcer.allowedActions(undefined)).toEqual([]);
  const deps = { accessRuntime: runtime, accessEnforcer: enforcer, authenticator } as unknown as ApplicationExtensionApiDependencies;
  const context = await resolveAuth({} as IncomingMessage, deps);
  expect(context).toEqual({
    authLevel: "public",
    accessControl: false,
    dataScope: runtime.instance,
    principal: { subject: runtime.instance.ownerId, identityProvider: "instance" },
    actor: runtime.instance.ownerId
  });
  await assertActions(deps, undefined, ["extensions.configure"]);
  expect(policy).not.toHaveBeenCalled(); expect(authenticator).not.toHaveBeenCalled();
});

it("受控装配运行期失去 provider 时拒绝，不改为默认开放", async () => {
  const enforcer = createAccessEnforcer({ runtime: { enabled: true }, siteAccessPolicy: () => null, resourceAccessPolicy: () => null });
  const principal = { subject: "a", identityProvider: "verified" };
  await expect(enforcer.assertAction(principal, "models.manage")).rejects.toMatchObject({ code: "access-provider-unavailable" });
  await expect(enforcer.assertResource(principal, { kind: "canvas", id: "c" }, "read")).rejects.toMatchObject({ code: "access-provider-unavailable" });
  expect(enforcer.runtime?.enabled).toBe(true);
});
