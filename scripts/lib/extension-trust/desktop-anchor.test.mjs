import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { desktopEnvironment } from "../desktop-host-data.mjs";

test("release desktop trusts only its bundled anchor, never inherited overrides",t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"desktop-trust-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const args={dataDir:path.join(root,"data"),resourceRoot:path.join(root,"resources"),baseEnv:{WOOHAA3_EXTENSION_TRUST_CONFIG:"/untrusted/root.json"}};
 assert.equal(desktopEnvironment(args).WOOHAA3_EXTENSION_TRUST_CONFIG,undefined);
 fs.mkdirSync(args.resourceRoot);const anchor=path.join(args.resourceRoot,"extension-trust.json");fs.writeFileSync(anchor,"{}");
 assert.equal(desktopEnvironment(args).WOOHAA3_EXTENSION_TRUST_CONFIG,anchor);
});
