/** Deterministic SOMA77 template: fixed official bind frames, official skinned human or editable rigid armor. */
import {somaBodyData} from './body-presets.js';
import {SOMA_SKIN} from './skin-data.js';
import {SOMA77_JOINTS} from './skeleton.js';
import type {Vec3} from '../model-transform.js';

type Builder={mesh(o:Record<string,unknown>):string;group(o:Record<string,unknown>):string;material(o:Record<string,unknown>):string;box(o:Record<string,unknown>):string;sphere(o:Record<string,unknown>):string;segment(o:Record<string,unknown>):string};
export type SomaHumanoidHandle={root:string;joint(name:string):string};
const keys=new Set(['id','style','armorColor','jointColor','accentColor','lightColor','bodyPreset']);
const color=(value:unknown,fallback:string)=>{
 const c=value===undefined?fallback:value;
 if(typeof c!=='string'||!/^#[0-9a-fA-F]{6}$/.test(c))throw new Error('SOMA colors must be #rrggbb');
 return c;
};
function euler(r:number[][]):Vec3{
 const x=Math.asin(Math.max(-1,Math.min(1,-r[1]![2]!)));
 return [x,Math.atan2(r[0]![2]!,r[2]![2]!),Math.atan2(r[1]![0]!,r[1]![1]!)].map(n=>n*180/Math.PI) as Vec3;
}
export function createSomaHumanoid(scene:Builder,options:Record<string,unknown>={}):SomaHumanoidHandle{
 if(!options||typeof options!=='object'||Array.isArray(options))throw new Error('SOMA options must be an object');
 for(const k of Object.keys(options))if(!keys.has(k))throw new Error(`Unknown SOMA option ${k}; skeleton is fixed`);
 const id=options.id??'humanoid';if(typeof id!=='string'||!id||id.length>80)throw new Error('Invalid SOMA id');
 const style=options.style??'mecha';if(style!=='mecha'&&style!=='humanoid')throw new Error('SOMA style must be mecha or humanoid');
 if(options.bodyPreset!==undefined&&style!=='humanoid')throw new Error('SOMA body presets require humanoid style');
 const body=options.bodyPreset===undefined?undefined:somaBodyData(options.bodyPreset);
 const joints=body?.joints??SOMA77_JOINTS, skin=body?.skin??SOMA_SKIN;
 const armorColor=color(options.armorColor,'#cbd5d1'),jointColor=color(options.jointColor,'#17242c'),accentColor=color(options.accentColor,'#ed542c'),lightColor=color(options.lightColor,'#45d7ff');
 const root=scene.group({id});
 const named=new Map(joints.map(j=>[j.name,j]));
 const joint=(name:string)=>{if(!named.has(name))throw new Error(`Unknown SOMA joint ${name}`);return `${id}.${name}`;};
 for(const j of joints)scene.group({id:joint(j.name),parent:j.parent<0?root:joint(joints[j.parent]!.name),position:[...j.position],rotation:[...j.rotation]});
 if(style==='humanoid'){
  const material=scene.material({id:`${id}.material.skin`,baseColor:'#eeeeea',roughness:.8,metallic:0});
  scene.mesh({id:`${id}.skin`,parent:root,material,vertices:skin.vertices,faces:skin.faces,skin:{jointIds:joints.map(j=>joint(j.name)),inverseBindMatrices:skin.inverseBindMatrices,indices:skin.indices,weights:skin.weights}});
  return Object.freeze({root,joint});
 }
 const mat=(suffix:string,c:string,metallic:number,emission=false)=>scene.material({id:`${id}.material.${suffix}`,baseColor:c,metallic,roughness:.36,...(emission?{emissive:c,emissiveStrength:2}:{})});
 const armor=mat('armor',armorColor,.65),dark=mat('joints',jointColor,.65),accent=mat('accent',accentColor,.45),light=mat('light',lightColor,.3,true);
 let serial=0;
 const bind=(name:string)=>named.get(name)!;
 const pos=(name:string):Vec3=>bind(name).bind.slice(0,3).map(row=>row[3]) as Vec3;
 const local=(name:string,p:Vec3):Vec3=>{
  const m=bind(name).bind;const d=p.map((v,k)=>v-m[k]![3]!) as Vec3;
  return [0,1,2].map(k=>m[0]![k]!*d[0]+m[1]![k]!*d[1]+m[2]![k]!*d[2]) as Vec3;
 };
 const shape=(kind:'box'|'sphere',name:string,p:Vec3,size:Vec3,material:string)=>{
  const b=bind(name).bind;
  const rotation=euler([0,1,2].map(i=>[0,1,2].map(k=>b[k]![i]!)));
  scene[kind]({id:`${id}.part.${++serial}`,parent:joint(name),position:local(name,p),rotation,material,...(kind==='box'?{size}:{radius:1,scale:size})});
 };
 const box=(j:string,p:Vec3,s:Vec3,m=armor)=>shape('box',j,p,s,m);
 const ball=(j:string,p:Vec3,s:Vec3,m=dark)=>shape('sphere',j,p,s,m);
 const add=(a:Vec3,b:Vec3):Vec3=>a.map((v,k)=>v+b[k]!) as Vec3;
 const limb=(a:string,b:string,width:number,depth:number,m=armor)=>{
  const start=pos(a),end=pos(b),d=end.map((v,k)=>v-start[k]!) as Vec3;
  const point=(f:number)=>add(start,d.map(v=>v*f) as Vec3);
  scene.segment({id:`${id}.part.${++serial}`,parent:joint(a),from:local(a,point(.12)),to:local(a,point(.86)),width,depth,shape:style==='mecha'?'box':'capsule',material:m});
 };
 // Rigid articulated inner body, including all finger bones; no fabricated smooth skin.
 for(const j of SOMA77_JOINTS){
  if(j.parent<0)continue;
  const parent=SOMA77_JOINTS[j.parent]!;
  if(/(Eye|Jaw|HeadEnd|Neck)/.test(j.name))continue;
  const finger=/(Thumb|Index|Middle|Ring|Pinky)/.test(j.name);
  const a=pos(parent.name),b=pos(j.name);
  if(Math.hypot(...b.map((v,k)=>v-a[k]!))<.001)continue;
  scene.segment({id:`${id}.part.${++serial}`,parent:joint(parent.name),from:[0,0,0],to:local(parent.name,b),width:finger?.017:.055,depth:finger?.017:.055,shape:'capsule',material:dark});
 }
 box('Chest',[0,1.31,-.015],[.35,.29,.24]);
 box('Chest',[0,1.335,.122],[.23,.15,.025],dark);
 box('Chest',[0,1.345,.14],[.15,.018,.012],light);
 box('Chest',[0,1.24,.132],[.08,.10,.045],accent);
 for(const side of [-1,1]){
  box('Chest',[side*.115,1.465,.025],[.13,.055,.18]);
  for(let k=0;k<3;k++)box('Spine1',[side*.063,1.17-k*.055,.095],[.115,.041,.055],dark);
 }
 box('Hips',[0,1.005,-.02],[.29,.12,.205],dark);
 box('Hips',[0,.965,.094],[.19,.12,.07]);
 box('Hips',[0,1.03,.135],[.105,.026,.016],accent);
 const h=pos('Head');ball('Head',add(h,[0,.047,0]),[.116,.145,.108],armor);
 box('Head',add(h,[0,.07,.091]),[.19,.067,.047],dark);
 box('Head',add(h,[0,.075,.119]),[.15,.014,.012],light);
 box('Head',add(h,[0,-.005,.083]),[.12,.045,.065],dark);
 box('Head',add(h,[0,.18,.005]),[.035,.015,.13],accent);
 for(const [sign,side] of [[1,'Left'],[-1,'Right']] as const){
  const arm=side+'Arm',fore=side+'ForeArm',hand=side+'Hand',leg=side+'Leg',shin=side+'Shin',foot=side+'Foot';
  ball(arm,add(pos(arm),[sign*.03,.025,0]),[.145,.13,.135],armor);
  box(arm,add(pos(arm),[sign*.035,.045,.12]),[.09,.045,.035],accent);
  limb(arm,fore,.125,.14);ball(fore,pos(fore),[.074,.074,.074]);limb(fore,hand,.145,.155);
  box(fore,add(pos(hand),[0,.065,.06]),[.04,.05,.02],light);
  ball(leg,pos(leg),[.11,.11,.10]);limb(leg,shin,.17,.19);
  ball(shin,pos(shin),[.085,.085,.085]);box(shin,add(pos(shin),[0,.015,.08]),[.14,.12,.075],accent);limb(shin,foot,.145,.17);
  const mid=pos(shin).map((v,k)=>(v+pos(foot)[k]!)/2) as Vec3;
  box(shin,add(mid,[0,0,.094]),[.022,.16,.016],light);
  const f=pos(foot);box(foot,add(f,[0,-.018,.065]),[.19,.12,.31],dark);box(foot,add(f,[0,.007,.15]),[.18,.10,.13]);
 }
 box('Chest',[0,1.32,-.18],[.25,.26,.15],dark);
 return Object.freeze({root,joint});
}
