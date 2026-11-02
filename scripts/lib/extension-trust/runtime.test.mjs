import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fixture } from "./fixture.mjs";
import { openInstallations } from "../extension-installations.mjs";
import { runtimeTrust, verifyManagedActivation } from "./runtime.mjs";
import { packDirectory, unpackExtensionPackage, filesDigest } from "../extension-package.mjs";

test("managed installation persists evidence, verifies activation and stops revoked or tampered code", async t => {
 const f=fixture(Math.floor(Date.now()/1000));const dir=fs.mkdtempSync(path.join(os.tmpdir(),"runtime-trust-"));
 let offline=false;let bundle=f.bundle();const server=http.createServer((req,res)=>{if(offline){res.writeHead(503);res.end();return}res.setHeader("content-type","application/json");res.end(JSON.stringify({bundle,rootUpdates:[]}))});
 await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));fs.rmSync(dir,{recursive:true,force:true})});
 const config=path.join(dir,"config.json");fs.writeFileSync(config,JSON.stringify({schemaVersion:2,domains:[{root:f.root,floors:f.floors,extensionIds:["photocraft"],metadataUrl:`http://127.0.0.1:${server.address().port}/trust`}]}));
 const src=path.join(dir,"source");fs.mkdirSync(src);fs.writeFileSync(path.join(src,"extension.json"),JSON.stringify({extensionId:"photocraft",version:"1.0.0"}));fs.writeFileSync(path.join(src,"index.js"),"export default {};");
 const archive=path.join(dir,"package.wxt"),treeDir=path.join(dir,"unpacked");packDirectory({treeDir:src,outFile:archive,privateKey:f.keys.publisher.privateKey,certificateChain:f.chain});unpackExtensionPackage({packagePath:archive,destDir:treeDir});
 const runtime=runtimeTrust({managedRoot:path.join(dir,"managed"),env:{WOOHAA3_EXTENSION_TRUST_CONFIG:config}});
 const result=await runtime.install({treeDir,allowUnsigned:false,trustedKeys:[]});assert.equal(result.trust,"certified:test-only:test-publisher");
 const record={...result,filesDigest:filesDigest(treeDir)};assert.equal((await runtime.installed(treeDir,record)).trust,result.trust);
 const managedRoot=path.join(dir,"managed"),env={WOOHAA3_EXTENSION_TRUST_CONFIG:config};
 const handle=openInstallations({managedRoot});try{handle.commit(state=>{state.extensions.photocraft={...record,current:"1.0.0",previous:null,sourceId:"test",state:"active",history:[]}}, {expectedRevision:0})}finally{handle.release()}
 assert.equal((await verifyManagedActivation({dir:treeDir,managedRoot,env})).trust,result.trust);
 const originalNow=Date.now;offline=true;Date.now=()=>(f.now+7200)*1000;
 try{assert.equal((await runtime.installed(treeDir,record)).trust,result.trust);await assert.rejects(runtime.install({treeDir,allowUnsigned:false}));}finally{Date.now=originalNow;offline=false}

 fs.writeFileSync(path.join(treeDir,"index.js"),"tampered");await assert.rejects(runtime.installed(treeDir,record));fs.writeFileSync(path.join(treeDir,"index.js"),"export default {};");
 bundle=f.bundle({...f.targets,version:2,revokedKeys:[f.keys.publisher.keyId]},2);await runtime.refresh();
 await assert.rejects(runtime.installed(treeDir,record),/revoked/);await assert.rejects(runtime.install({treeDir,allowUnsigned:true,trustedKeys:[{publicKey:f.keys.publisher.publicKey}]}));
});

test("legacy migration binds exact archive, version, files and key rather than granting a CA", async t => {
 const {createHash}=await import("node:crypto");const f=fixture(Math.floor(Date.now()/1000));
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"legacy-trust-"));const src=path.join(dir,"src");fs.mkdirSync(src);
 fs.writeFileSync(path.join(src,"extension.json"),JSON.stringify({extensionId:"photocraft",version:"1.0.0"}));
 const archive=path.join(dir,"legacy.wxt"),treeDir=path.join(dir,"tree");packDirectory({treeDir:src,outFile:archive,privateKey:f.keys.publisher.privateKey});unpackExtensionPackage({packagePath:archive,destDir:treeDir});
 const hash=createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
 const grant={extensionId:"photocraft",version:"1.0.0",archiveDigest:hash,filesDigest:filesDigest(treeDir).slice(7),publicKey:f.keys.publisher.publicKey,publisherId:"test-publisher",expiresAt:f.now+600};
 const bundle=f.bundle({...f.targets,legacy:[grant]});const server=http.createServer((req,res)=>res.end(JSON.stringify({bundle,rootUpdates:[]})));
 await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));t.after(async()=>{await new Promise(resolve=>server.close(resolve));fs.rmSync(dir,{recursive:true,force:true})});
 const config=path.join(dir,"config.json");fs.writeFileSync(config,JSON.stringify({schemaVersion:2,domains:[{root:f.root,floors:f.floors,extensionIds:["photocraft"],metadataUrl:`http://127.0.0.1:${server.address().port}/trust`}]}));
 const runtime=runtimeTrust({managedRoot:path.join(dir,"managed"),env:{WOOHAA3_EXTENSION_TRUST_CONFIG:config}});
 await assert.rejects(runtime.install({treeDir,packageDigest:"sha256:"+"0".repeat(64)}),/legacy-package-not-authorized/);
 const result=await runtime.install({treeDir,packageDigest:"sha256:"+hash});assert.equal(result.evidence.legacy,true);
 assert.equal((await runtime.installed(treeDir,{...result,filesDigest:filesDigest(treeDir),packageDigest:"sha256:"+hash})).trust,result.trust);
});

test("offline first install and explicit imports use pinned roots without any server", async t => {
 const f=fixture(Math.floor(Date.now()/1000));const dir=fs.mkdtempSync(path.join(os.tmpdir(),"offline-trust-"));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 t.mock.method(globalThis,"fetch",()=>{assert.fail("offline trust must not fetch")});
 const material={bundle:f.bundle(),rootUpdates:[]};
 const domain={root:f.root,floors:f.floors,extensionIds:["photocraft"]};
 const config=path.join(dir,"config.json");fs.writeFileSync(config,JSON.stringify({schemaVersion:2,domains:[{...domain,bootstrap:material}]}));
 const env={WOOHAA3_EXTENSION_TRUST_CONFIG:config},managedRoot=path.join(dir,"managed");
 const src=path.join(dir,"src");fs.mkdirSync(src);fs.writeFileSync(path.join(src,"extension.json"),JSON.stringify({extensionId:"photocraft",version:"1.0.0"}));
 const archive=path.join(dir,"package.wxt"),treeDir=path.join(dir,"tree");packDirectory({treeDir:src,outFile:archive,privateKey:f.keys.publisher.privateKey,certificateChain:f.chain});unpackExtensionPackage({packagePath:archive,destDir:treeDir});
 const runtime=runtimeTrust({managedRoot,env});const result=await runtime.install({treeDir});
 const record={...result,filesDigest:filesDigest(treeDir)};
 assert.equal(result.trust,"certified:test-only:test-publisher");
 assert.throws(()=>runtime.importMaterial("unknown",material),/untrusted-domain/);
 assert.throws(()=>runtime.importMaterial("test-only",{...material,root:f.root}),/invalid-shape/);
 const other=fixture(f.now);assert.throws(()=>runtime.importMaterial("test-only",{bundle:other.bundle(),rootUpdates:[]}));
 const now=Date.now;t.mock.method(Date,"now",()=>(f.now+7200)*1000);
 assert.equal((await runtime.installed(treeDir,record)).trust,result.trust);
 await assert.rejects(runtime.install({treeDir}));
 Date.now=now;
 const revoked={bundle:f.bundle({...f.targets,version:2,revokedKeys:[f.keys.publisher.keyId]},2),rootUpdates:[]};
 const oldStamp=runtime.stateStamp();
 runtime.importMaterial("test-only",revoked);
 assert.notEqual(runtime.stateStamp(),oldStamp);
 assert.throws(()=>runtime.importMaterial("test-only",material));
 await assert.rejects(runtime.installed(treeDir,record),/revoked/);
 // Reopening with the original bundled seed must retain the newer revocation.
 const reopenedConfig=path.join(dir,"reopened.json");fs.copyFileSync(config,reopenedConfig);
 const reopened=runtimeTrust({managedRoot,env:{WOOHAA3_EXTENSION_TRUST_CONFIG:reopenedConfig}});
 await assert.rejects(reopened.install({treeDir}),/revoked/);
 // No bootstrap and no URL: first install works after an explicit offline import.
 const bareConfig=path.join(dir,"bare.json");fs.writeFileSync(bareConfig,JSON.stringify({schemaVersion:2,domains:[domain]}));
 const bare=runtimeTrust({managedRoot:path.join(dir,"bare"),env:{WOOHAA3_EXTENSION_TRUST_CONFIG:bareConfig}});
 await assert.rejects(bare.install({treeDir}),/missing-trust-cache/);
 bare.importMaterial("test-only",material);assert.equal((await bare.install({treeDir})).trust,result.trust);
 const materialFile=path.join(dir,"material.json");fs.writeFileSync(materialFile,JSON.stringify(material));
 const cli=spawnSync(process.execPath,[fileURLToPath(new URL("../../import-extension-trust.mjs",import.meta.url)),path.join(dir,"cli"),"test-only",materialFile],{env:{...process.env,WOOHAA3_EXTENSION_TRUST_CONFIG:bareConfig},encoding:"utf8"});
 assert.equal(cli.status,0,cli.stderr);
 const cliRuntime=runtimeTrust({managedRoot:path.join(dir,"cli"),env:{WOOHAA3_EXTENSION_TRUST_CONFIG:bareConfig}});
 assert.equal((await cliRuntime.install({treeDir})).trust,result.trust);
 t.mock.method(Date,"now",()=>(f.now+7200)*1000);
 assert.throws(()=>bare.importMaterial("test-only",material),/expired/);
});
