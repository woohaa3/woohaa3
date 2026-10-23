/** Native commands and isolated installed-host layout shared by runtime tooling. */
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Cached resolution so packaging loops do not stat the same candidates repeatedly. */
let tarResolution = null;

/**
 * 可用的 `tar` 可执行文件。
 *
 * Windows 只在 1803+ 自带 `System32\tar.exe`（bsdtar）；Windows Server 2016/2012 与更早的
 * Windows 10 没有它，而桌面打包必须生成 `desktop-host.tar.gz`。此时按固定位置与 PATH
 * 依次回退（MSYS2/Cygwin/Git for Windows），避免在旧系统上必然失败。
 */
export function systemTar(platform=process.platform, env=process.env, fileExists=fs.existsSync) {
 if(platform!=='win32')return '/usr/bin/tar';
 const systemRoot=env.SystemRoot??env.SYSTEMROOT??'C:\\Windows';
 const cacheKey=`${systemRoot}|${env.PATH??env.Path??''}`;
 if(tarResolution?.key===cacheKey)return tarResolution.value;
 const candidates=[
  path.win32.join(systemRoot,'System32','tar.exe'),
  'C:\\msys64\\usr\\bin\\tar.exe',
  'C:\\cygwin64\\bin\\tar.exe',
  'C:\\cygwinroot\\bin\\tar.exe',
  ...pathEntries(env).map(entry=>path.win32.join(entry,'tar.exe')),
  'C:\\Program Files\\Git\\usr\\bin\\tar.exe'
 ];
 const value=candidates.find(fileExists)??path.win32.join(systemRoot,'System32','tar.exe');
 tarResolution={key:cacheKey,value};
 return value;
}

function pathEntries(env) {
 const raw=env.PATH??env.Path??'';
 return raw.split(path.win32.delimiter).map(entry=>entry.replace(/^"|"$/g,'')).filter(Boolean);
}

/**
 * Keep tar and its compression children in the same Windows installation.
 * Mixing MSYS2 tar with Git/Cygwin gzip can crash before an archive is written.
 */
export function systemTarExec(args, options = {}, platform = process.platform, run = execFileSync, fileExists = fs.existsSync) {
 if (platform !== 'win32') return run('/usr/bin/tar', args, options);
 const inherited = options.env ?? process.env;
 const tarPath = systemTar(platform, inherited, fileExists);
 const bin = path.win32.dirname(tarPath);
 // Windows treats environment names case-insensitively; Node may otherwise select
 // an inherited Path instead of our PATH when both are present.
 const env = Object.fromEntries(Object.entries(inherited).filter(([key]) => key.toUpperCase() !== 'PATH'));
 env.PATH = [bin, ...pathEntries(inherited).filter(entry => path.win32.normalize(entry).toLowerCase() !== path.win32.normalize(bin).toLowerCase())].join(';');
 const probe = (command, parameters, probeOptions) => run(command, parameters, {...probeOptions, env});
 const parameters = systemTarArgs(tarPath, args, platform, probe);
 const usesGzip = args.some(arg => /^-[^-]*z/.test(arg) || ['--gzip','--gunzip','--ungzip'].includes(arg));
 if (parameters[0] === '--force-local' && usesGzip && !fileExists(path.win32.join(bin, 'gzip.exe'))) {
  throw new Error(`GNU tar requires gzip.exe from the same directory: ${bin}`);
 }
 return run(tarPath, parameters, {...options, env});
}

export function systemTarArgs(tarPath, args, platform=process.platform, run=execFileSync) {
 if(platform!=='win32')return args;
 let gnu=false;
 try{ gnu=/GNU tar/.test(String(run(tarPath,['--version'],{encoding:'utf8',windowsHide:true}))); }catch{}
 return gnu?['--force-local',...args]:args;
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
