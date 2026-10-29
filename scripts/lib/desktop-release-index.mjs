/** Pure updater metadata; platform feeds and upload roots remain independent.
 *
 * 两种更新通道（互斥）：
 * - endpoint：自托管 CDN 上的静态索引，归档放在索引目录的 "<版本>/" 下；
 * - github：GitHub Release 资产。索引按平台拆成 "latest-<平台键>.json"，
 *   经 "releases/latest/download/" 取最新正式发布，归档放在 "releases/download/<tag>/"。
 *
 * 平台索引必须拆分：GitHub 同一 tag 的资产名唯一，两个平台各自发布时若都写
 * "latest.json" 会互相覆盖，后发布的平台会把另一平台的索引删掉。
 */
const SEGMENT=/^[A-Za-z0-9_+.-]+$/;
const REPO=/^[A-Za-z0-9_+.-]+\/[A-Za-z0-9_+.-]+$/;

/** 平台键：Tauri updater 的 platforms 键，也是 GitHub 索引资产名的后缀。 */
export function platformKeyFor({platform,arch}) {
 const keys={darwin:{arm64:'darwin-aarch64',x64:'darwin-x86_64'},win32:{x64:'windows-x86_64',arm64:'windows-aarch64'},linux:{x64:'linux-x86_64',arm64:'linux-aarch64'}};
 return keys[platform]?.[arch]??(platform+'-'+arch);
}

/** 解析更新通道；两种同时配置视为配置错误，缺省资产名按平台拆分。 */
export function resolveUpdateChannel({platformKey,endpoint=null,github=null}) {
 if(endpoint&&github)throw new Error('更新通道只能二选一：endpoint 或 GitHub Release');
 if(github) {
  const repo=String(github.repo??'').trim();
  if(!REPO.test(repo))throw new Error('GitHub release repo must be owner/name');
  const release=String(github.release??'latest').trim()||'latest';
  if(release!=='latest'&&!SEGMENT.test(release))throw new Error('Invalid GitHub release tag');
  const assetName=String(github.asset??('latest-'+platformKey+'.json')).trim();
  if(!SEGMENT.test(assetName)||assetName.includes('..'))throw new Error('Invalid update asset name');
  const tagPrefix=String(github.tagPrefix??'v').trim();
  if(!SEGMENT.test(tagPrefix)||tagPrefix.includes('..'))throw new Error('Invalid tag prefix');
  const tagFor=(version)=>release==='latest'?tagPrefix+version:release;
  const endpoint=release==='latest'
   ?'https://github.com/'+repo+'/releases/latest/download/'+assetName
   :'https://github.com/'+repo+'/releases/download/'+release+'/'+assetName;
  return {
   kind:'github',repo,release,tagPrefix,assetName,endpoint,tagFor,
   archiveUrl:(version,name)=>'https://github.com/'+repo+'/releases/download/'+encodeURIComponent(tagFor(version))+'/'+encodeURIComponent(name)
  };
 }
 if(typeof endpoint!=='string'||!endpoint.trim())throw new Error('Signed release requires WOOHAA_DESKTOP_UPDATE_ENDPOINT');
 let parsed;
 try{parsed=new URL(endpoint);}catch{throw new Error('Update endpoint requires HTTPS');}
 if(parsed.protocol!=='https:')throw new Error('Update endpoint requires HTTPS');
 return {
  kind:'endpoint',assetName:'latest.json',endpoint,
  archiveUrl:(version,name)=>new URL(encodeURIComponent(version)+'/'+encodeURIComponent(name),new URL('.',endpoint)).href
 };
}

export function releaseSettings({platform,arch,endpoint=null,github=null,channel:given=null}) {
 const windows=platform==='win32'&&arch==='x64';
 // 签名发行只覆盖 Windows x64 与 Apple Silicon；打包（build-desktop）不受这条限制。
 if(!windows&&!(platform==='darwin'&&arch==='arm64')) throw new Error('Signed desktop releases require Windows x64 or Apple Silicon');
 const platformKey=platformKeyFor({platform,arch});
 const channel=given??resolveUpdateChannel({platformKey,endpoint,github});
 return {bundle:windows?'nsis':'app',output:windows?'artifacts/desktop/standalone-windows-x64':'artifacts/desktop/standalone-apple-silicon',platformKey,suffix:windows?'.exe':'.app.tar.gz',endpoint:channel.endpoint,assetName:channel.assetName,channel};
}

export function buildReleaseIndex({manifest,platform,arch,endpoint=null,github=null,signature,notes,pubDate=new Date().toISOString(),assetName=null,channel:given=null}) {
 const channel=given??resolveUpdateChannel({platformKey:platformKeyFor({platform,arch}),endpoint,github}); const settings=releaseSettings({platform,arch,channel});
 const version=manifest.product.version;
 if(typeof version!=='string'||!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/.test(version))throw new Error('Invalid release version');
 const archives=manifest.artifacts.filter(file=>file.name.endsWith(settings.suffix));
 if(archives.length!==1)throw new Error('Expected exactly one updater archive');
 const archive=archives[0];
 if(/[\\/]/.test(archive.name))throw new Error('Invalid archive filename');
 const signed=manifest.artifacts.find(file=>file.name===archive.name+'.sig');
 if(!signed)throw new Error('Missing matching updater signature');
 if(typeof signature!=='string'||!signature.trim())throw new Error('Empty updater signature');
 if(assetName!==null&&(!SEGMENT.test(assetName)||assetName.includes('..')))throw new Error('Invalid update asset name');
 const name=assetName??channel.assetName;
 return {
  archive,signature:signed,versionDir:version,assetName:name,endpoint:channel.endpoint,channel,
  latest:{version,notes:notes??('WooHaa3 '+version),pub_date:pubDate,platforms:{[settings.platformKey]:{url:channel.archiveUrl(version,archive.name),signature:signature.trim()}}}
 };
}

/** 合并平台索引：只保留与合并后版本一致的平台条目，绝不把旧版本的归档挂到新版本下。 */
export function mergeReleaseIndex({existing,incoming}) {
 if(!existing)return incoming;
 const version=newerVersion(existing.version,incoming.version);
 const keep=(entry)=>entry.version===version?entry.platforms:{};
 const source=incoming.version===version?incoming:existing;
 return {version,notes:source.notes,pub_date:source.pub_date,platforms:{...keep(existing),...keep(incoming)}};
}

/** 版本比较：先比核心三元组，同版本时正式版高于预发布版。 */
export function newerVersion(left,right) {
 const core=(value)=>{const [base,pre]=String(value).split(/-(.*)/s);return {parts:base.split('.').map(Number),pre:pre??null};};
 const a=core(left),b=core(right);
 for(let index=0;index<3;index+=1){const x=a.parts[index]??0,y=b.parts[index]??0;if(x!==y)return x>y?left:right;}
 if(a.pre===b.pre)return left;
 if(a.pre===null)return left;
 if(b.pre===null)return right;
 return a.pre>b.pre?left:right;
}

/** 从打包环境变量解析更新通道：endpoint 与 GitHub 仓库二选一，公钥必填。 */
export function updateChannelFromEnv(env,{platform,arch}) {
 const endpoint=String(env.WOOHAA_DESKTOP_UPDATE_ENDPOINT??'').trim()||null;
 const repo=String(env.WOOHAA_DESKTOP_UPDATE_GITHUB_REPO??'').trim()||null;
 if(endpoint&&repo)throw new Error('更新通道只能二选一：WOOHAA_DESKTOP_UPDATE_ENDPOINT 或 WOOHAA_DESKTOP_UPDATE_GITHUB_REPO');
 if(!endpoint&&!repo)return null;
 const publicKey=String(env.WOOHAA_DESKTOP_UPDATE_PUBLIC_KEY??'').trim();
 if(!publicKey)throw new Error('配置更新通道时必须同时提供 WOOHAA_DESKTOP_UPDATE_PUBLIC_KEY');
 const github=repo?{repo,release:String(env.WOOHAA_DESKTOP_UPDATE_GITHUB_RELEASE??'').trim()||'latest',asset:String(env.WOOHAA_DESKTOP_UPDATE_GITHUB_ASSET??'').trim()||null}:null;
 const channel=resolveUpdateChannel({platformKey:platformKeyFor({platform,arch}),endpoint,github});
 const updater=channel.kind==='github'
  ?{publicKey,github:{repo:channel.repo,asset:channel.assetName,release:channel.release}}
  :{endpoint:channel.endpoint,publicKey};
 return {channel,updater};
}
