/** Portable dependency graph; only internal directory junctions are permitted. */
import fs from 'node:fs';
import path from 'node:path';
export function writeRuntimeLinks(root,edges){fs.writeFileSync(path.join(root,'runtime-links.json'),JSON.stringify({schema:1,edges},null,2));}
function portable(value){if(typeof value!=='string'||!value||value.includes('\\')||value.includes(':')||value.startsWith('/')||value.split('/').some(part=>!part||part==='.'||part==='..'||/[. ]$/.test(part)||/[<>"|?*\x00-\x1f]/.test(part)||/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))throw new Error(`Invalid runtime link path: ${value}`);return value;}
function inspect(root,relative,{allowLeaf=false}={}){
 const parts=portable(relative).split('/');let current=root;
 for(let i=0;i<parts.length;i++){
  current=path.join(current,parts[i]);let stat;try{stat=fs.lstatSync(current);}catch(error){if(error.code==='ENOENT')continue;throw error;}
  if(stat.isSymbolicLink()&&!(allowLeaf&&i===parts.length-1))throw new Error(`Runtime link ancestor is a link: ${relative}`);
  if(!stat.isDirectory()&&!stat.isSymbolicLink())throw new Error(`Runtime link is not a directory: ${relative}`);
 }
 return current;
}
export function materializeRuntimeLinks(resourceRoot,{platform=process.platform}={}){
 const root=fs.realpathSync(resourceRoot),file=path.join(root,'runtime-links.json');if(!fs.existsSync(file))return;
 const manifest=JSON.parse(fs.readFileSync(file,'utf8'));if(manifest.schema!==1||!Array.isArray(manifest.edges))throw new Error('Invalid runtime link manifest');
 const links=new Set();const edges=manifest.edges.map(edge=>{
  const target=inspect(root,edge.target),link=inspect(root,edge.link,{allowLeaf:true});
  if(!fs.existsSync(target)||!fs.statSync(target).isDirectory())throw new Error(`Missing runtime link target: ${edge.target}`);
  if(links.has(link)||link===target)throw new Error('Duplicate or circular runtime link');links.add(link);
  const stat=fs.lstatSync(link,{throwIfNoEntry:false});if(stat&&(!stat.isSymbolicLink()||fs.realpathSync(link)!==fs.realpathSync(target)))throw new Error(`Runtime link replaced: ${edge.link}`);
  return {link,target};
 });
 // A manifest may not place another edge below a newly-created junction.
 for(const edge of edges)for(const other of edges)if(edge!==other&&(edge.link.startsWith(other.link+path.sep)||edge.target===other.link||edge.target.startsWith(other.link+path.sep)))throw new Error('Overlapping runtime links');
 for(const {link,target} of edges){inspect(root,path.relative(root,link).split(path.sep).join('/'),{allowLeaf:true});if(!fs.existsSync(link)){fs.mkdirSync(path.dirname(link),{recursive:true});fs.symlinkSync(platform==='win32'?target:path.relative(path.dirname(link),target),link,platform==='win32'?'junction':'dir');}}
}
