import { it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readRemoteServerDeployment } from "../src/deployment.js";

it("reads imported deployment config from writable desktop data, with normal override precedence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa-deployment-test-"));
  try {
    const file = path.join(root, "remote-server.json");
    fs.writeFileSync(file, JSON.stringify({ serverUrl: "https://imported.example", deviceToken: "shared-device" }));
    const env = { WOOHAA3_REMOTE_SERVER_CONFIG_FILE: file };
    expect(readRemoteServerDeployment({ env })).toMatchObject({ serverUrl: "https://imported.example", deviceToken: "shared-device" });
    expect(readRemoteServerDeployment({ env: { ...env, WOOHAA3_REMOTE_SERVER_URL: "https://env.example" }, values: { serverUrl: "https://settings.example" } }).serverUrl).toBe("https://settings.example");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
