/** Pure updater metadata; platform feeds and upload roots remain independent. */
export function releaseSettings({platform,arch,endpoint}) {
 const windows=platform==='win32'&&arch==='x64';
 if(!windows&&!(platform==='darwin'&&arch==='arm64')) throw new Error('Signed desktop releases require Windows x64 or Apple Silicon');
 if(typeof endpoint!=='string'||!endpoint.trim())throw new Error('Signed release requires WOOHAA_DESKTOP_UPDATE_ENDPOINT');
 if(new URL(endpoint).protocol!=='https:')throw new Error('Update endpoint requires HTTPS');
 return {bundle:windows?'nsis':'app',output:windows?'artifacts/desktop/standalone-windows-x64':'artifacts/desktop/standalone-apple-silicon',platformKey:windows?'windows-x86_64':'darwin-aarch64',suffix:windows?'.exe':'.app.tar.gz',endpoint};
}
export function buildReleaseIndex({manifest,platform,arch,endpoint,signature,notes,pubDate=new Date().toISOString()}) {
 const settings=releaseSettings({platform,arch,endpoint}); const version=manifest.product.version;
 if(typeof version!=='string'||!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/.test(version))throw new Error('Invalid release version');
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
 return {archive,signature:signed,versionDir:version,latest:{version,notes:notes??`WooHaa3 ${version}`,pub_date:pubDate,platforms:{[settings.platformKey]:{url:new URL(`${encodeURIComponent(version)}/${encodeURIComponent(archive.name)}`,base).href,signature:signature.trim()}}}};
}
