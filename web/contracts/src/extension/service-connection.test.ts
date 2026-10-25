import { describe, expect, it } from "vitest";
import { isServiceConnectionSave } from "./service-connection.js";
const save = { operationId: "save-1", expectedRevision: 0, expectedCredentialEpoch: 0, name: "Relay", endpoints: [{ protocol: "responses", baseUrl: "https://relay.example/v1" }], secret: "write-only" };
describe("service connection browser write boundary", () => {
  it("accepts write-only input but rejects host authority fields and arbitrary secret references", () => {
    expect(isServiceConnectionSave(save)).toBe(true);
    for (const field of ["owner", "scope", "credentialRef", "credentialKey", "capabilities", "bindings"])
      expect(isServiceConnectionSave({ ...save, [field]: "forged" })).toBe(false);
  });
  it("rejects invalid versions, protocols and contradictory key actions", () => {
    for (const expectedRevision of [-1, 1.5, NaN, "0"]) expect(isServiceConnectionSave({ ...save, expectedRevision })).toBe(false);
    expect(isServiceConnectionSave({ ...save, clearCredential: true })).toBe(false);
    expect(isServiceConnectionSave({ ...save, endpoints: [{ protocol: "unknown", baseUrl: "https://relay.example" }] })).toBe(false);
    expect(isServiceConnectionSave({ ...save, endpoints: [{ ...save.endpoints[0], credentialRef: "forged" }] })).toBe(false);
  });
});
