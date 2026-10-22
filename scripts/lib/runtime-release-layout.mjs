/** Shared build-time layout. Component versions/cache identities remain independent. */
export function runtimeReleaseLayout({platform=process.platform,arch=process.arch,version,cdnBaseUrl=''}={}) {
 const platformKey=platform==='darwin'&&arch==='arm64'?'darwin-aarch64':platform==='win32'&&arch==='x64'?'windows-x86_64':undefined;
 if(!platformKey)throw new Error(`Unsupported runtime release platform: ${platform}/${arch}`);
 if(typeof version!=='string'||!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version)||version.split('+')[0].split('-').slice(1).join('-').split('.').some(x=>/^0\d+$/.test(x)))throw new Error('Invalid runtime release version');
 const relativeDirectory=`${platformKey}/${version}`;
 if(!cdnBaseUrl)return {platformKey,version,relativeDirectory,baseUrl:''};
 let base;
 try {base=new URL(cdnBaseUrl);}catch{throw new Error('Invalid runtime CDN URL');}
 if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash)throw new Error('Runtime CDN must use HTTPS without credentials or query parameters');
 if(!base.pathname.endsWith('/'))base.pathname+='/';
 const parts=base.pathname.split('/').filter(Boolean).map(decodeURIComponent);
 if(['darwin-aarch64','windows-x86_64'].includes(parts.at(-2))){
  if(parts.at(-2)!==platformKey||parts.at(-1)!==version)throw new Error('Runtime CDN URL points to a different platform/release');
  return {platformKey,version,relativeDirectory,baseUrl:base.href};
 }
 return {platformKey,version,relativeDirectory,baseUrl:new URL(`${platformKey}/${encodeURIComponent(version)}/`,base).href};
}
