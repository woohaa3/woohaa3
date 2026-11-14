/** Target bind-axis retargeting and a horizontal-ground kinematic sole constraint. */
import type { PreparedSomaMotion } from './index.js';
import { matrixQuaternion } from './clip.js';
import { somaBodyData, type SomaBodyPresetId, type SomaBodyJoint } from '../soma-humanoid/body-presets.js';
import { SOMA77_JOINTS } from '../soma-humanoid/skeleton.js';
import type { WorldRotation } from '../shared-world.js';
import { quatMul, quatRotate, type Quat, type Vec3 } from '../model-transform.js';

export const SOMA_BODY_ADAPTATION_VERSION = 'soma-body-retarget-v1';
const inverse = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];
const rotation = (m: number[][]): Quat => matrixQuaternion(m.slice(0, 3).flatMap(row => row.slice(0, 3)));
const add = (a: Vec3, b: Vec3): Vec3 => [a[0]+b[0], a[1]+b[1], a[2]+b[2]];
const distance = (a: Vec3,b: Vec3) => Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]);
export function somaBodyRootScale(id: SomaBodyPresetId): number {
  const joints = somaBodyData(id).joints;
  const leg = (j: typeof joints) => ['Left', 'Right'].reduce((sum, side) => {
    const point = (name: string) => j.find(b => b.name === side+name)!.bind.slice(0,3).map(row => row[3]!) as Vec3;
    return sum + distance(point('Leg'), point('Shin')) + distance(point('Shin'), point('Foot'));
  },0);
  return leg(joints)/leg(SOMA77_JOINTS);
}
type Frames = { names: string[]; parents: number[]; positions: Vec3[]; local: Quat[]; world: Quat[] };
type Foot = { joint: number; weight: number; local: Vec3 }[][];
type Calibration = { source: Frames; target: Frames; axes: Quat[]; sourceFeet: Foot; targetFeet: Foot; sourceFloor: number; rootScale: number };
const calibrations = new WeakMap<PreparedSomaMotion, Map<string, Calibration>>();
function frames(joints: SomaBodyJoint[]): Frames {
  const world = joints.map(j => rotation(j.bind));
  return { names: joints.map(j=>j.name), parents:joints.map(j=>j.parent), world,
    positions: joints.map(j=> j.parent<0 ? j.bind.slice(0,3).map(row=>row[3]!) as Vec3
      : quatRotate(inverse(world[j.parent]!),j.bind.slice(0,3).map((row,k)=>row[3]!-joints[j.parent]!.bind[k]![3]!) as Vec3)),
    local: joints.map((j,i)=>j.parent<0?world[i]!:quatMul(inverse(world[j.parent]!),world[i]!)) };
}
function feet(vertices: number[][], indices: number[][], weights: number[][], joints: SomaBodyJoint[]): Foot {
  const footJoints = new Set(joints.map((j,i)=>/^(Left|Right)(Foot|Toe)/.test(j.name)?i:-1));
  const result: Foot = [];
  for(let i=0;i<vertices.length;i++){
    if(indices[i]!.reduce((s,n,k)=>s+(footJoints.has(n)?weights[i]![k]!:0),0)<.5)continue;
    result.push(indices[i]!.flatMap((n,k)=>{
      const weight=weights[i]![k]!;if(!weight)return [];
      const b=joints[n]!.bind, d=vertices[i]!.map((v,k)=>v-b[k]![3]!) as Vec3;
      return [{joint:n,weight,local:quatRotate(inverse(rotation(b)),d)}];
    }));
  }
  if(!result.length)throw new Error('SOMA body: missing foot surface');
  return result;
}
function worldPose(f: Frames, prefix: string, pose: Pose) {
  const positions: Vec3[]=[], rotations: Quat[]=[];
  for(let i=0;i<f.names.length;i++){
    const parent=f.parents[i]!, id=`${prefix}.${f.names[i]}`;
    const q=quatMul(f.local[i]!,(pose.partRotations[id]??[0,0,0,1]) as Quat);
    const position=add(f.positions[i]!,pose.partPositions[id]??[0,0,0]);
    rotations[i]=parent<0?q:quatMul(rotations[parent]!,q);
    positions[i]=parent<0?position:add(positions[parent]!,quatRotate(rotations[parent]!,position));
  }
  return {positions,rotations};
}
function sole(feet:Foot, world:ReturnType<typeof worldPose>):number {
  let min=Infinity;
  for(const sample of feet){
    let y=0;
    for(const influence of sample)y+=(world.positions[influence.joint]![1]+quatRotate(world.rotations[influence.joint]!,influence.local)[1])*influence.weight;
    min=Math.min(min,y);
  }
  return min;
}
type Pose = { partRotations: Record<string, WorldRotation>; partPositions: Record<string, Vec3>; rootTranslation?: Vec3 };
function calibration(p:PreparedSomaMotion,id:SomaBodyPresetId):Calibration {
  const key=`${SOMA_BODY_ADAPTATION_VERSION}/${id}`;
  const cache=calibrations.get(p)??new Map<string,Calibration>();calibrations.set(p,cache);
  const old=cache.get(key);if(old)return old;
  // Source identity stays Kimodo's actual 77-joint bind, independently of the target.
  if(p.jointNames.length!==77||!SOMA77_JOINTS.every((j,i)=>p.jointNames[i]===j.name&&p.parents[i]===j.parent&&j.bind.every((row,r)=>row.every((v,c)=>Math.abs(v-p.bindTransforms[i*16+r*4+c]!)<1e-5))))throw new Error('SOMA body: unsupported source bind skeleton');
  const body=somaBodyData(id),source=frames(SOMA77_JOINTS),target=frames(body.joints);
  const rows=(a:ArrayLike<number>,width:number)=>Array.from({length:a.length/width},(_,i)=>Array.from({length:width},(_,k)=>a[i*width+k]!));
  const sourceFeet=feet(rows(p.bindVertices,3),rows(p.indices,8),rows(p.weights,8),SOMA77_JOINTS);
  const targetFeet=feet(body.skin.vertices,body.skin.indices,body.skin.weights,body.joints);
  const result:Calibration={source,target,sourceFeet,targetFeet,sourceFloor:sole(sourceFeet,worldPose(source,'',{partRotations:{},partPositions:{}})),
    axes:source.world.map((q,i)=>quatMul(inverse(target.world[i]!),q)),rootScale:somaBodyRootScale(id)};
  cache.set(key,result);return result;
}
/** Exact-time FK/LBS for soles. No clock, instance transform, source mutation or per-frame state. */
export function validateSomaBodyAdaptation(p:PreparedSomaMotion,id:SomaBodyPresetId):void { calibration(p,id); }
export function adaptSomaBodyPose(p:PreparedSomaMotion,id:SomaBodyPresetId,prefix:string,time:number,sourcePose:Pose,_normalizeYaw=false):Pose {
  if(!Number.isFinite(time))throw new Error('SOMA body: invalid sample time');
  const c=calibration(p,id), partRotations:Pose['partRotations']={},partPositions:Pose['partPositions']={};
  for(let i=0;i<c.source.names.length;i++){
    const name=`${prefix}.${c.source.names[i]}`,axis=c.axes[i]!;
    partRotations[name]=quatMul(quatMul(axis,(sourcePose.partRotations[name]??[0,0,0,1]) as Quat),inverse(axis));
  }
  const hips=`${prefix}.Hips`;
  partPositions[hips]=[0,(sourcePose.partPositions[hips]?.[1]??0)*c.rootScale,0];
  const result:Pose={partRotations,partPositions,...(sourcePose.rootTranslation?{rootTranslation:sourcePose.rootTranslation.map(v=>v*c.rootScale) as Vec3}:{})};
  const sourceHeight=sole(c.sourceFeet,worldPose(c.source,prefix,sourcePose))-c.sourceFloor;
  const targetHeight=sole(c.targetFeet,worldPose(c.target,prefix,result));
  // Preserve actual airborne source clearance, including jumps. This is a minimum-sole
  // rule without contact labels: it does not pin horizontal feet or promise zero slide.
  partPositions[hips][1]+=Math.max(0,sourceHeight)*c.rootScale-targetHeight;
  return result;
}
