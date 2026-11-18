/**
 * Pure updater metadata; platform feeds and upload roots remain independent.
 *
 * 通道（change: 2026-11-18-add-desktop-update-channels）：产物按通道写到不同 feed，
 * alpha 发布绝不触碰 stable 的 latest.json。通道只影响 feed 与应用版本号的合法形态，
 * 不影响 bundle 种类、产物目录或平台键。
 */
import { STABLE_UPDATE_CHANNEL, UPDATE_CHANNEL_PATTERN } from "./build-profile.mjs";

/** 版本里的预发布后缀（`0.2.0-alpha.3` 的 `alpha.3`）；没有时返回空串。 */
export function prereleaseTag(version) {
  const match = /^\d+\.\d+\.\d+-([0-9A-Za-z.-]+)(?:\+[0-9A-Za-z.-]+)?$/.exec(typeof version === "string" ? version : "");
  return match ? match[1] : "";
}

export function releaseSettings({platform,arch,endpoint,channel=STABLE_UPDATE_CHANNEL}) {
 const windows=platform==='win32'&&arch==='x64';
 if(!windows&&!(platform==='darwin'&&arch==='arm64')) throw new Error('Signed desktop releases require Windows x64 or Apple Silicon');
 if(typeof endpoint!=='string'||!endpoint.trim())throw new Error('Signed release requires an update endpoint (build profile cdn.updatePath)');
 if(new URL(endpoint).protocol!=='https:')throw new Error('Update endpoint requires HTTPS');
 if(!UPDATE_CHANNEL_PATTERN.test(String(channel)))throw new Error('Invalid update channel: '+String(channel));
 return {bundle:windows?'nsis':'app',output:windows?'artifacts/desktop/standalone-windows-x64':'artifacts/desktop/standalone-apple-silicon',platformKey:windows?'windows-x86_64':'darwin-aarch64',suffix:windows?'.exe':'.app.tar.gz',endpoint,channel};
}
export function buildReleaseIndex({manifest,platform,arch,endpoint,channel=STABLE_UPDATE_CHANNEL,signature,notes,pubDate=new Date().toISOString()}) {
 const settings=releaseSettings({platform,arch,endpoint,channel}); const version=manifest.product.version;
 if(typeof version!=='string'||!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/.test(version))throw new Error('Invalid release version');
 // stable 通道只收正式版：预发布版落进 stable feed 就等于对所有用户强制推送开发者版本。
 if(settings.channel===STABLE_UPDATE_CHANNEL&&prereleaseTag(version))throw new Error(`stable 通道不能发布预发布版本 ${version}；请用 alpha 通道发布`);
 const archives=manifest.artifacts.filter(file=>file.name.endsWith(settings.suffix));
 // bundle 目录可能残留上一版安装包（工作区跨构建复用）。tauri 的 NSIS 产物名带 _<version>_，
 // 有多个候选时先按本次版本收敛；收敛不出恰好一个就带着候选清单失败，便于直接看出是谁。
 const current=archives.length>1?archives.filter(file=>file.name.includes('_'+version+'_')):archives;
 if(current.length!==1)throw new Error('Expected exactly one updater archive（版本 '+version+'，候选：'+(archives.map(file=>file.name).join('、')||'无')+'）');
 const archive=current[0];
 if(/[\\/]/.test(archive.name))throw new Error('Invalid archive filename');
 const signed=manifest.artifacts.find(file=>file.name===archive.name+'.sig');
 if(!signed)throw new Error('Missing matching updater signature');
 if(typeof signature!=='string'||!signature.trim())throw new Error('Empty updater signature');
 const base=new URL('.',settings.endpoint);
 if(base.protocol!=='https:')throw new Error('Update endpoint requires HTTPS');
 return {archive,signature:signed,versionDir:version,channel:settings.channel,prerelease:prereleaseTag(version)!=='',latest:{version,notes:notes??`WooHaa3 ${version}`,pub_date:pubDate,platforms:{[settings.platformKey]:{url:new URL(`${encodeURIComponent(version)}/${encodeURIComponent(archive.name)}`,base).href,signature:signature.trim()}}}};
}
