#!/usr/bin/env node
/** Build signed updater artifacts and an isolated CDN upload tree.
 *
 * 通道（change: 2026-11-18-add-desktop-update-channels）：`--channel` 决定产物写哪条 feed。
 * 缺省 stable，行为与改造前一致；alpha 产物只写 alpha 前缀，绝不触碰 stable 的 latest.json。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {parseDesktopArgs,nativeTargetError} from './lib/desktop-release.mjs';
import {releaseSettings,buildReleaseIndex} from './lib/desktop-release-index.mjs';
import {loadBuildProfile,resolveUpdateEndpoints,STABLE_UPDATE_CHANNEL,updaterPlatformKey} from './lib/build-profile.mjs';
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
const channel=options.channel??STABLE_UPDATE_CHANNEL;
// 通道地址来自 profile（与 build-desktop 同一份事实），env 只作为加载期覆盖。
const buildProfile=loadBuildProfile({repoRoot:path.dirname(root),env:process.env});
if(!buildProfile.ok)throw new Error('build profile 校验失败：'+buildProfile.errors.map(error=>error.path+': '+error.message).join('；'));
const platformKey=updaterPlatformKey({platform:process.platform,arch:process.arch});
const updater=resolveUpdateEndpoints(buildProfile.resolved,platformKey,channel);
const settings=releaseSettings({platform:process.platform,arch:process.arch,channel,endpoint:updater.endpoints[channel]??updater.endpoints[STABLE_UPDATE_CHANNEL]});
const out=path.resolve(root,options.out??settings.output);
const key=process.env.WOOHAA_DESKTOP_SIGNING_KEY??path.join(os.homedir(),'.config/woohaa-release/updater.key');
if(!options.dryRun&&(!fs.existsSync(key)||!fs.existsSync(key+'.pub')))throw new Error(`缺少更新签名密钥。先用 Tauri signer generate --write-keys ${key} 创建；不要把私钥提交到仓库。`);
// Defaults are supplied only when absent, preserving explicit bundle/out overrides.
const defaults=[...(options.bundles===null?['--bundles',settings.bundle]:[]),...(options.out===null?['--out',out]:[])];
const result=spawnSync(process.execPath,[path.join(root,'scripts/build-desktop.mjs'),...defaults,...args],{
 cwd:root,stdio:'inherit',env:{...process.env,WOOHAA_DESKTOP_HOST_STAGING:path.join(root,`.local/desktop-host-signed-${process.platform}-${process.arch}`),WOOHAA_DESKTOP_PACKAGING_DIR:path.join(root,`desktop/build/packaging-signed-${process.platform}-${process.arch}`),...(!options.dryRun?{WOOHAA_DESKTOP_UPDATE_PUBLIC_KEY:fs.readFileSync(key+'.pub','utf8').trim(),TAURI_SIGNING_PRIVATE_KEY:key,TAURI_SIGNING_PRIVATE_KEY_PASSWORD:process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD??''}:{})}
});
if(result.error)throw result.error;
if(result.status!==0)process.exit(result.status??1);
if(options.dryRun||options.mode==='help')process.exit(0);
const manifest=JSON.parse(fs.readFileSync(path.join(out,'manifest.json'),'utf8'));
const archive=manifest.artifacts.find(file=>file.name.endsWith(settings.suffix));
const signature=manifest.artifacts.find(file=>file.name===archive?.name+'.sig');
if(!signature)throw new Error('构建没有产出 matching updater archive/signature');
const index=buildReleaseIndex({manifest,platform:process.platform,arch:process.arch,channel,endpoint:settings.endpoint,signature:fs.readFileSync(path.resolve(root,signature.path),'utf8'),notes:process.env.WOOHAA_DESKTOP_RELEASE_NOTES});
const upload=path.join(out,'upload');
const versionDir=path.join(upload,index.versionDir);
fs.mkdirSync(versionDir,{recursive:true});
for(const artifact of [index.archive,index.signature])fs.copyFileSync(path.resolve(root,artifact.path),path.join(versionDir,artifact.name));
fs.writeFileSync(path.join(upload,'latest.json'),JSON.stringify(index.latest,null,2)+'\n');
console.log(`[desktop-release] 通道 ${index.channel}${index.prerelease?'（预发布）':''}；上传目录：${upload}；先上传 ${index.versionDir}/，最后上传 latest.json 到 ${settings.endpoint}。`);
