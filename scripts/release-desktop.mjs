#!/usr/bin/env node
/** Build signed updater artifacts and an isolated CDN upload tree. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {parseDesktopArgs,nativeTargetError} from './lib/desktop-release.mjs';
import {releaseSettings,buildReleaseIndex} from './lib/desktop-release-index.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const args=process.argv.slice(2).filter(arg=>arg!=='--');
const options=parseDesktopArgs(args);
if(options.mode==='help') {
 const help=spawnSync(process.execPath,[path.join(root,'scripts/build-desktop.mjs'),'--help'],{cwd:root,stdio:'inherit'});
 if(help.error)throw help.error;
 process.exit(help.status??1);
}
if(options.mode!=='build')throw new Error('desktop:release only supports build mode');
const targetError=nativeTargetError({platform:process.platform,arch:process.arch,target:options.target});
if(targetError)throw new Error(targetError);
if(options.mode!=='help'&&(!options.bundle||options.debug||options.uiUrl))throw new Error('Signed releases require release profile, bundled installer and packaged local host');
const settings=releaseSettings({platform:process.platform,arch:process.arch,endpoint:process.env.WOOHAA_DESKTOP_UPDATE_ENDPOINT});
const out=path.resolve(root,options.out??settings.output);
const key=process.env.WOOHAA_DESKTOP_SIGNING_KEY??path.join(os.homedir(),'.config/woohaa-release/updater.key');
if(!options.dryRun&&(!fs.existsSync(key)||!fs.existsSync(key+'.pub')))throw new Error(`缺少更新签名密钥。先用 Tauri signer generate --write-keys ${key} 创建；不要把私钥提交到仓库。`);
// Defaults are supplied only when absent, preserving explicit bundle/out overrides.
const defaults=[...(options.bundles===null?['--bundles',settings.bundle]:[]),...(options.out===null?['--out',out]:[])];
const result=spawnSync(process.execPath,[path.join(root,'scripts/build-desktop.mjs'),...defaults,...args],{
 cwd:root,stdio:'inherit',env:{...process.env,WOOHAA_DESKTOP_HOST_STAGING:path.join(root,`.local/desktop-host-signed-${process.platform}-${process.arch}`),WOOHAA_DESKTOP_PACKAGING_DIR:path.join(root,`desktop/build/packaging-signed-${process.platform}-${process.arch}`),WOOHAA_DESKTOP_UPDATE_ENDPOINT:settings.endpoint,...(!options.dryRun?{WOOHAA_DESKTOP_UPDATE_PUBLIC_KEY:fs.readFileSync(key+'.pub','utf8').trim(),TAURI_SIGNING_PRIVATE_KEY:key,TAURI_SIGNING_PRIVATE_KEY_PASSWORD:process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD??''}:{})}
});
if(result.error)throw result.error;
if(result.status!==0)process.exit(result.status??1);
if(options.dryRun||options.mode==='help')process.exit(0);
const manifest=JSON.parse(fs.readFileSync(path.join(out,'manifest.json'),'utf8'));
const archive=manifest.artifacts.find(file=>file.name.endsWith(settings.suffix));
const signature=manifest.artifacts.find(file=>file.name===archive?.name+'.sig');
if(!signature)throw new Error('构建没有产出 matching updater archive/signature');
const index=buildReleaseIndex({manifest,platform:process.platform,arch:process.arch,endpoint:settings.endpoint,signature:fs.readFileSync(path.resolve(root,signature.path),'utf8'),notes:process.env.WOOHAA_DESKTOP_RELEASE_NOTES});
const upload=path.join(out,'upload');
const versionDir=path.join(upload,index.versionDir);
fs.mkdirSync(versionDir,{recursive:true});
for(const artifact of [index.archive,index.signature])fs.copyFileSync(path.resolve(root,artifact.path),path.join(versionDir,artifact.name));
fs.writeFileSync(path.join(upload,'latest.json'),JSON.stringify(index.latest,null,2)+'\n');
console.log(`[desktop-release] 上传目录：${upload}；先上传 ${index.versionDir}/，最后上传 latest.json 到 ${settings.endpoint}。`);
