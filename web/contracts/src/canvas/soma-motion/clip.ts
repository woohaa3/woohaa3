import { validateSomaSceneLapRoute, type SomaSceneLapRoute } from './scene-lap.js';
import type { PreparedSomaMotion } from './index.js';
import { quatMul, quatRotate, type Quat, type Vec3 } from '../model-transform.js';
import type { WorldRotation, WorldPoint } from '../shared-world.js';

/** Immutable asset identity and bounded playback metadata; never contains NPZ data. */
export type WorldSomaClipTrack = {
  targetId: string; assetId: string; checksum: string; fps: number; frameCount: number;
  startTime: number; endTime: number; jointPrefix: string; rootMotion?: 'in-place' | 'translate'; route?: SomaSceneLapRoute;
};
export function validateSomaClip(input: unknown, duration: number): WorldSomaClipTrack {
  const x = input as Record<string, unknown>;
  const fail = () => { throw new Error('Invalid SOMA clip metadata'); };
  if (!x || typeof x !== 'object' || Array.isArray(x) || !Object.keys(x).every(k => ['targetId','assetId','checksum','fps','frameCount','startTime','endTime','jointPrefix','rootMotion','route'].includes(k))) return fail();
  for (const k of ['targetId','assetId','checksum','jointPrefix']) if (typeof x[k] !== 'string' || !(x[k] as string).trim() || (x[k] as string).length > 200) return fail();
  if (!/^[a-f0-9]{64}$/i.test(x.checksum as string) || typeof x.fps !== 'number' || !Number.isFinite(x.fps) || x.fps <= 0 || x.fps > 240 || !Number.isInteger(x.frameCount) || (x.frameCount as number) < 1 || (x.frameCount as number) > 18000 || typeof x.startTime !== 'number' || !Number.isFinite(x.startTime) || x.startTime < 0) return fail();
  if (x.rootMotion !== undefined && x.rootMotion !== 'in-place' && x.rootMotion !== 'translate') return fail();
  const endTime = x.endTime === undefined ? Math.min(duration, x.startTime + (x.frameCount as number) / x.fps) : x.endTime;
  if (typeof endTime !== 'number' || !Number.isFinite(endTime) || endTime <= x.startTime || endTime > duration || endTime - x.startTime > (x.frameCount as number) / x.fps + 1e-8) return fail();
  const route=x.route===undefined ? undefined : validateSomaSceneLapRoute(x.route,endTime-x.startTime);
  if(route && x.rootMotion!=='in-place')return fail();
  return {...(route ? {route} : {}),targetId:x.targetId as string,assetId:x.assetId as string,checksum:x.checksum as string,fps:x.fps,frameCount:x.frameCount as number,startTime:x.startTime,endTime,jointPrefix:x.jointPrefix as string,...(x.rootMotion !== undefined ? {rootMotion:x.rootMotion as WorldSomaClipTrack['rootMotion']} : {})};
}
function matrixQuaternion(m: number[]): Quat {
  const trace = m[0]! + m[4]! + m[8]!;
  let q: Quat;
  if (trace > 0) { const s = Math.sqrt(trace + 1) * 2; q = [(m[7]!-m[5]!)/s,(m[2]!-m[6]!)/s,(m[3]!-m[1]!)/s,s/4]; }
  else { const i = m[0]! > m[4]! && m[0]! > m[8]! ? 0 : m[4]! > m[8]! ? 1 : 2, j=(i+1)%3,k=(i+2)%3; const s=Math.sqrt(1+m[i*3+i]!-m[j*3+j]!-m[k*3+k]!)*2; q=[0,0,0,0]; q[i]=s/4;q[j]=(m[j*3+i]!+m[i*3+j]!)/s;q[k]=(m[k*3+i]!+m[i*3+k]!)/s;q[3]=(m[k*3+j]!-m[j*3+k]!)/s; }
  const length=Math.hypot(...q); return q.map(v=>v/length) as Quat;
}
function slerp(a:Quat,b:Quat,t:number):Quat {
  let dot=a.reduce((s,v,i)=>s+v*b[i]!,0); if(dot<0){b=b.map(v=>-v) as Quat;dot=-dot;}
  if(dot>0.9995){const q=a.map((v,i)=>v+(b[i]!-v)*t) as Quat;const n=Math.hypot(...q);return q.map(v=>v/n) as Quat;}
  const angle=Math.acos(Math.min(1,dot)),s=Math.sin(angle);return a.map((v,i)=>(v*Math.sin((1-t)*angle)+b[i]!*Math.sin(t*angle))/s) as Quat;
}
/** Project model-space root travel through the instance transform into ground coordinates. */
export function projectSomaRootTranslation(local: Vec3, rotation: WorldRotation, scale: number, position: WorldPoint): WorldPoint {
  const [u,v,h] = quatRotate(rotation as Quat, [local[0]*scale,-local[2]*scale,local[1]*scale]);
  return {u:position.u+u,v:position.v+v,h:position.h+h};
}
/** Pure seekable local deltas; root travel is opt-in and never enters Hips X/Z. */
export function sampleSomaClip(p:PreparedSomaMotion,jointPrefix:string,time:number,rootMotion:WorldSomaClipTrack['rootMotion']='in-place',normalizeRootYaw=false):{partRotations:Record<string,WorldRotation>;partPositions:Record<string,Vec3>;rootTranslation?:Vec3} {
  if(!Number.isFinite(time))throw new Error('SOMA: invalid time');
  const frame=Math.max(0,Math.min(p.frameCount-1,time*p.fps)),a=Math.floor(frame),b=Math.min(p.frameCount-1,a+1),t=frame-a,joints=p.jointNames.length;
  const partRotations:Record<string,WorldRotation>={},partPositions:Record<string,Vec3>={};
  for(let n=0;n<joints;n++){
    const parent=p.parents[n]!,bind:number[]=[];
    for(let r=0;r<3;r++)for(let c=0;c<3;c++){
      let value=p.bindTransforms[n*16+r*4+c]!;
      if(parent>=0){value=0;for(let k=0;k<3;k++)value+=p.bindTransforms[parent*16+k*4+r]!*p.bindTransforms[n*16+k*4+c]!;}
      bind.push(value);
    }
    const q=matrixQuaternion(bind),inverse:Quat=[-q[0],-q[1],-q[2],q[3]];
    const rotation=(f:number)=>matrixQuaternion(Array.from(p.localRotations.subarray((f*joints+n)*9,(f*joints+n+1)*9)));
    let sampled=slerp(rotation(a),rotation(b),t);
    if(normalizeRootYaw && parent<0){const forward=quatRotate(sampled,[0,0,1]);const yaw=Math.atan2(forward[0],forward[2]);sampled=quatMul([0,-Math.sin(yaw/2),0,Math.cos(yaw/2)],sampled);}
    partRotations[`${jointPrefix}.${p.jointNames[n]}`]=quatMul(inverse,sampled);
    if(p.jointNames[n]==='Hips' && parent<0)partPositions[`${jointPrefix}.Hips`]=[0,p.rootPositions[a*3+1]!*(1-t)+p.rootPositions[b*3+1]!*t-p.bindTransforms[n*16+7]!,0];
  }
  return {partRotations,partPositions,...(rootMotion === 'translate' ? {rootTranslation:[p.rootPositions[a*3]!*(1-t)+p.rootPositions[b*3]!*t-p.rootPositions[0]!,0,p.rootPositions[a*3+2]!*(1-t)+p.rootPositions[b*3+2]!*t-p.rootPositions[2]!] as Vec3} : {})};
}
