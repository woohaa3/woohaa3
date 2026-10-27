import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
const sha256 = value => createHash('sha256').update(value).digest('hex');
/** Hash the served runtime, independently of source timestamps and source maps. */
export function collectBuildIdentity({clientRoot,dist='web/frontend/dist-benchmark'}={}) {
  if(typeof clientRoot!=='string'||!clientRoot) throw new TypeError('clientRoot is required');
  const directory=resolve(clientRoot,dist);
  try { if(!statSync(join(directory,'index.html')).isFile()) throw new Error(); }
  catch { throw new Error('Benchmark build requires dist index.html'); }
  const files=[];
  function visit(directoryPath) {
    for(const entry of readdirSync(directoryPath,{withFileTypes:true})) {
      const path=join(directoryPath,entry.name);
      if(entry.isDirectory()) visit(path);
      else if(entry.isFile()&&!entry.name.endsWith('.map')) {
        const content=readFileSync(path);
        files.push({path:relative(directory,path).split(sep).join('/'),sha256:sha256(content),bytes:content.length});
      }
    }
  }
  visit(directory);files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  const wasm=files.filter(file=>file.path.endsWith('.wasm'));
  if(!wasm.length) throw new Error('Benchmark build requires a WASM runtime asset');
  const bevyCandidates=wasm.filter(file=>/^(?:assets\/)?woohaa_bevy_canvas_bg(?:-[A-Za-z0-9_-]+)?\.wasm$/.test(file.path));
  if(bevyCandidates.length!==1) throw new Error('Benchmark build requires exactly one canonical Bevy WASM candidate');
  const bevy=bevyCandidates[0];
  const basename=bevy.path.split('/').at(-1);
  const referenced=files.filter(file=>file.path.endsWith('.js')).some(file=>readFileSync(join(directory,file.path),'utf8').includes(basename));
  if(!referenced) throw new Error('Served JavaScript must reference the canonical Bevy WASM filename');
  let stamp;
  try {stamp=JSON.parse(readFileSync(join(clientRoot,'bevy/target/bevy-wasm-build.stamp.json'),'utf8'));}
  catch {throw new Error('Missing or invalid Bevy WASM build stamp');}
  if(stamp.mode!=='performance'||stamp.profile!=='release'||stamp.optEnabled!==true) throw new Error('Build stamp requires performance mode, release profile and optEnabled=true');
  const expected=stamp.outputs?.['woohaa_bevy_canvas_bg.wasm'];
  if(typeof expected!=='string'||!/^[a-f0-9]{64}$/.test(expected)||bevy.sha256!==expected) throw new Error('Served Bevy WASM does not match build stamp output SHA256');
  if(typeof stamp.rawWasmSha256!=='string'||!/^[a-f0-9]{64}$/.test(stamp.rawWasmSha256)) throw new Error('Build stamp requires raw WASM SHA256');
  const provenance={mode:stamp.mode,profile:stamp.profile,rawWasmSha256:stamp.rawWasmSha256,opt:stamp.opt??null};
  return {buildId:sha256(JSON.stringify({files,stamp:provenance})),buildMode:'performance',files,stamp:provenance};
}
