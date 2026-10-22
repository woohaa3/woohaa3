/** Native commands and isolated installed-host layout shared by runtime tooling. */
import path from 'node:path';
export function systemTar(platform=process.platform, env=process.env) {
 return platform==='win32'?path.win32.join(env.SystemRoot??env.SYSTEMROOT??'C:\\Windows','System32','tar.exe'):'/usr/bin/tar';
}
export function installedHostLayout(input,platform=process.platform) {
 const paths=platform==='win32'?path.win32:path;
 if(platform==='darwin')return {node:paths.join(input,'Contents/MacOS/woohaa-node'),archive:paths.join(input,'Contents/Resources/desktop-host.tar.gz')};
 const root=/\.exe$/i.test(input)?paths.dirname(input):input;
 return {node:paths.join(root,platform==='win32'?'woohaa-node.exe':'woohaa-node'),archive:paths.join(root,'desktop-host.tar.gz')};
}
export function isolatedHostEnvironment(work,platform=process.platform,inherited=process.env) {
 if(platform!=='win32')return {PATH:'/usr/bin:/bin',HOME:work,TMPDIR:inherited.TMPDIR??'/tmp'};
 const SystemRoot=inherited.SystemRoot??inherited.SYSTEMROOT??'C:\\Windows';
 const temp=inherited.TEMP??inherited.TMP??path.win32.join(work,'Temp');
 return {SystemRoot,PATH:path.win32.join(SystemRoot,'System32'),HOME:work,USERPROFILE:work,APPDATA:path.win32.join(work,'AppData/Roaming'),LOCALAPPDATA:path.win32.join(work,'AppData/Local'),TEMP:temp,TMP:temp};
}
