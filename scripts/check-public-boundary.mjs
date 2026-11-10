#!/usr/bin/env node
/** Verify the public checkout never needs a private parent to resolve source inputs. */
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const ignored=new Set(['.git','node_modules','target','target-host','dist','server-dist','browser-dist','.local','artifacts','coverage','.astro','.browser-build','.browser-test']);
function sourceFiles(root){
 try{const top=execFileSync('git',['rev-parse','--show-toplevel'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();if(fs.realpathSync(top)===fs.realpathSync(root))return [...new Set(execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean))];}catch{}
 const files=[];const walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){if(ignored.has(entry.name))continue;const file=path.join(dir,entry.name);if(entry.isDirectory())walk(file);else files.push(path.relative(root,file));}};walk(root);return files;
}
const outside=(root,file)=>{const relative=path.relative(root,file);return relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative);};
export function checkPublicBoundary(root,{files=sourceFiles(root)}={}){
 root=fs.realpathSync(root);const errors=[];
 const inspect=(file,specifier)=>{if(specifier.startsWith('.')&&outside(root,path.resolve(path.dirname(path.join(root,file)),specifier)))errors.push(`${file}: parent source dependency ${specifier}`);};
 for(const file of files){
  const absolute=path.join(root,file);if(!fs.existsSync(absolute))continue;
  if(/(?:^|[\\/])\.?woa-(?:identity|access)(?:[\\/]|$)/.test(file))errors.push(`${file}: corporate extension in public checkout`);
  if(/^(?:server|admin|tools|infra|openspec|\.agents)(?:[\\/]|$)/.test(file))errors.push(`${file}: private directory in public checkout`);
  if (/^extensions\/litellm-provider(?:\/|$)/.test(file)) errors.push(`${file}: private provider in public checkout`);
  // Protocol sources and their generation pipeline are private; this checkout carries compiled bindings only.
  if (/\.proto$/i.test(file)) errors.push(`${file}: protobuf definition in public checkout`);
  if (/^api\//.test(file) && !/^api\/gen\/es\//.test(file) && !/^api\/(?:package\.json|tsconfig\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc|README\.md)$/.test(file)) errors.push(`${file}: protocol source or tooling in public checkout`);
  // Administrative contracts stay in the closed repository: the published bindings are the
  // client-facing API surface only, so an admin service or admin channel in this checkout is a leak.
  if (/^api\/gen\/es\/.*\/(?:[a-z0-9_]+_admin_pb\.ts|ops_pb\.ts|rbac_pb\.ts|inspect_pb\.ts)$/.test(file)) errors.push(`${file}: administrative contract in public bindings`);
  const basename=path.basename(file);
  const sample=/^(?:\.env\.(?:example|sample|template)|config\.(?:example|sample|template)\.json|woohaa\.(?:config|secrets)\.(?:example|sample|template)\.ya?ml)$/.test(basename);
  if(!sample&&/^(?:\.env(?:\..+)?|woohaa\.(?:secrets|config)\.ya?ml|config\.local\.json|updater\.key|auth\.json|credentials\.json|.*\.(?:sqlite3?|sqlite-wal|sqlite-shm|woohaa|p12|pfx|p8|pem|key))$/.test(basename))errors.push(`${file}: local credentials or data in public checkout`);
  if(outside(root,fs.realpathSync(absolute))){errors.push(`${file}: symlink outside public checkout`);continue;}
  if(!fs.statSync(absolute).isFile()||fs.statSync(absolute).size>4*1024*1024)continue;
  const bytes=fs.readFileSync(absolute);if(bytes.includes(0))continue;
  const content=bytes.toString('utf8');
  // The policy definition itself contains the patterns it rejects elsewhere.
  if(file!=='scripts/check-public-boundary.mjs'){
   if(/https?:\/\/[^\s'"<>]*(?:\.woa\.com|mirrors\.tencent\.com|zaohuacdn\.com|woohaa3-\d+\.cos\.[a-z0-9-]+\.myqcloud\.com|\.forgeax\.com|\.internal)(?=[:/\s'"<>]|$)/i.test(content))errors.push(`${file}: private deployment endpoint`);
   if(/x-tai-identity|x-rio-seq|x-ext-data|SmartGate|太湖/.test(content))errors.push(`${file}: corporate integration details`);
   if(/asset_canvas_dzs|infinspire-(?:api|contracts)|InfinspireCanvas|resolveInfinspire/.test(content))errors.push(`${file}: private source reference`);
   if(/-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----[\s\S]{32,}?-----END (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/.test(content))errors.push(`${file}: private key material`);
  }
  for(const match of content.matchAll(/^\s*(?:import|export)\s+(?:[^;\n]*?\s+from\s*)?["']([^"']+)["']|(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)|new URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url/gm))inspect(file,match[1]??match[2]??match[3]);
  if(path.basename(file)==='Cargo.toml')for(const match of content.matchAll(/\bpath\s*=\s*["']([^"']+)["']/g))inspect(file,match[1]);
  if(path.basename(file)==='package.json'){
   const pkg=JSON.parse(content);if(/^@woohaa3\/extension-(?:woa-|litellm-provider$)/.test(pkg.name??''))errors.push(`${file}: corporate extension package in public checkout`);for(const section of ['dependencies','devDependencies','optionalDependencies','peerDependencies'])for(const value of Object.values(pkg[section]??{}))if(/^(?:file|link):/.test(value))inspect(file,value.replace(/^(?:file|link):/,''));
   for(const command of Object.values(pkg.scripts??{}))if(/\b(?:atc|pm2|dev-taihu-gateway|dev-server-watch)\b/.test(command))errors.push(`${file}: private developer command`);
  }
 }
 return [...new Set(errors)];
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const root=fileURLToPath(new URL('../',import.meta.url));const errors=checkPublicBoundary(root);if(errors.length){console.error(errors.join('\n'));process.exitCode=1;}else console.log('Public client boundary: passed');
}
