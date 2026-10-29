#!/usr/bin/env node
/** Build signed updater artifacts and an isolated upload tree (CDN directory or GitHub Release). */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {parseDesktopArgs,nativeTargetError} from './lib/desktop-release.mjs';
import {releaseSettings,buildReleaseIndex,updateChannelFromEnv} from './lib/desktop-release-index.mjs';
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
if(!options.bundle||options.debug||options.uiUrl)throw new Error('Signed releases require release profile, bundled installer and packaged local host');
const key=process.env.WOOHAA_DESKTOP_SIGNING_KEY??path.join(os.homedir(),'.config/woohaa-release/updater.key');
if(!options.dryRun&&(!fs.existsSync(key)||!fs.existsSync(key+'.pub')))throw new Error('缺少更新签名密钥。先用 Tauri signer generate --write-keys '+key+' 创建；不要把私钥提交到仓库。');
// 公钥取环境变量或签名密钥旁的 .pub；dry-run 允许用占位值只验证通道解析。
const publicKey=process.env.WOOHAA_DESKTOP_UPDATE_PUBLIC_KEY??(fs.existsSync(key+'.pub')?fs.readFileSync(key+'.pub','utf8').trim():null)??(options.dryRun?'dry-run-public-key':null);
// 更新通道来自环境变量：自托管 CDN（endpoint）或 GitHub Release（repo）。
const channel=updateChannelFromEnv({...process.env,...(publicKey?{WOOHAA_DESKTOP_UPDATE_PUBLIC_KEY:publicKey}:{})},{platform:process.platform,arch:process.arch});
if(!channel)throw new Error('签名发行必须配置更新通道：WOOHAA_DESKTOP_UPDATE_ENDPOINT 或 WOOHAA_DESKTOP_UPDATE_GITHUB_REPO');
const settings=releaseSettings({platform:process.platform,arch:process.arch,channel:channel.channel});
const out=path.resolve(root,options.out??settings.output);
// Defaults are supplied only when absent, preserving explicit bundle/out overrides.
const defaults=[...(options.bundles===null?['--bundles',settings.bundle]:[]),...(options.out===null?['--out',out]:[])];
const result=spawnSync(process.execPath,[path.join(root,'scripts/build-desktop.mjs'),...defaults,...args],{
 cwd:root,stdio:'inherit',env:{...process.env,WOOHAA_DESKTOP_HOST_STAGING:path.join(root,'.local/desktop-host-signed-'+process.platform+'-'+process.arch),WOOHAA_DESKTOP_PACKAGING_DIR:path.join(root,'desktop/build/packaging-signed-'+process.platform+'-'+process.arch),...(!options.dryRun?{TAURI_SIGNING_PRIVATE_KEY:key,TAURI_SIGNING_PRIVATE_KEY_PASSWORD:process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD??'',WOOHAA_DESKTOP_UPDATE_PUBLIC_KEY:publicKey}:{})}
});
if(result.error)throw result.error;
if(result.status!==0)process.exit(result.status??1);
if(options.dryRun)process.exit(0);
const manifest=JSON.parse(fs.readFileSync(path.join(out,'manifest.json'),'utf8'));
const archive=manifest.artifacts.find(file=>file.name.endsWith(settings.suffix));
const signature=manifest.artifacts.find(file=>file.name===archive?.name+'.sig');
if(!signature)throw new Error('构建没有产出 matching updater archive/signature');
const index=buildReleaseIndex({manifest,platform:process.platform,arch:process.arch,channel:settings.channel,signature:fs.readFileSync(path.resolve(root,signature.path),'utf8'),notes:process.env.WOOHAA_DESKTOP_RELEASE_NOTES});
const upload=path.join(out,'upload');
const versionDir=path.join(upload,index.versionDir);
fs.mkdirSync(versionDir,{recursive:true});
for(const artifact of [index.archive,index.signature])fs.copyFileSync(path.resolve(root,artifact.path),path.join(versionDir,artifact.name));
fs.writeFileSync(path.join(upload,index.assetName),JSON.stringify(index.latest,null,2)+'\n');
if(settings.channel.kind==='github') {
 const tag=settings.channel.tagFor(index.versionDir);
 console.log('[desktop-release] 上传目录：'+upload+'；先建 '+tag+' release 并上传 '+index.versionDir+'/，最后上传 '+index.assetName+'。');
 console.log('[desktop-release] 可直接执行：node scripts/publish-desktop-github.mjs --repo '+settings.channel.repo+' --tag '+tag+' --dir '+path.relative(root,upload));
} else {
 console.log('[desktop-release] 上传目录：'+upload+'；先上传 '+index.versionDir+'/，最后上传 '+index.assetName+' 到 '+settings.endpoint+'。');
}
