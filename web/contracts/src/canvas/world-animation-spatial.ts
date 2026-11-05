/** Data-only model motion diagnostics. Bounds are conservative, not mesh contact or IK. */
import {describeHumanoidMotion,sampleRigLandmarks,sampleJointEndpoint} from "./humanoid-motion-reference.js";
import type { WorldModelAnimationRig } from "./assistant-world-authority.js";
import type { StoredHumanoidRig } from "./humanoid-rig.js";
import { quatMul, quatRotate, transformOf, transformPoint, type Aabb, type Quat, type Transform, type Vec3 } from "./model-transform.js";
import { v2ShapeLocalBounds, v2ShapeLocalTransform, type SceneV2Op } from "./scene-ir-v2.js";
import { classifyCameraPoint } from "./scene-footprint.js";
import type { GroundAabb, GroundPoint, WorldTransform } from "./shared-world.js";
import { countWorldAnimationChannels, WORLD_ANIMATION_MAX_CHANNELS, type SampledInstanceMotion, type WorldAnimationIr } from "./world-animation-script.js";

function corners(bounds: Aabb): Vec3[] {
  return Array.from({length:8}, (_, i) => [bounds[i & 1 ? "max" : "min"][0],bounds[i & 2 ? "max" : "min"][1],bounds[i & 4 ? "max" : "min"][2]]);
}
function envelope(points: Vec3[]): Aabb | null {
  if (!points.length) return null;
  const min: Vec3 = [Infinity,Infinity,Infinity];
  const max: Vec3 = [-Infinity,-Infinity,-Infinity];
  for (const point of points) for (let i = 0; i < 3; i++) {
    min[i] = Math.min(min[i]!,point[i]!);
    max[i] = Math.max(max[i]!,point[i]!);
  }
  return {min,max};
}

/** Evaluate the actual group hierarchy, then carry each geometry's local bounds with it. */
function posedPoints(rig: WorldModelAnimationRig, rotations: SampledInstanceMotion["partRotations"] = {}) {
  const groups = new Map(rig.groups.map(group => [group.id,group]));
  const transforms = new Map<string,Transform>();
  const groupTransform = (id: string): Transform => {
    const cached = transforms.get(id);
    if (cached) return cached;
    const group = groups.get(id)!;
    const local = transformOf(group);
    if (rotations[id]) local.rotation = quatMul(local.rotation,[...rotations[id]] as Quat);
    transforms.set(id,local);
    return local;
  };
  const footParents = new Set<string>();
  if (rig.rig) for (const group of rig.groups) {
    let id: string | null = group.id;
    while (id !== null) {
      if (id === "LeftFoot" || id === "RightFoot") { footParents.add(group.id); break; }
      id = groups.get(id)?.parent ?? null;
    }
  }
  return (rig.shapes ?? []).map(shape => {
    const points = corners(shape.localBounds).map(point => {
      let posed = transformPoint(shape.localTransform ?? transformOf(shape),point);
      let parent = shape.parent;
      // Keep each local transform: collapsing TRS would lose affine shear.
      while (parent !== null && groups.has(parent)) {
        posed = transformPoint(groupTransform(parent),posed);
        parent = groups.get(parent)!.parent;
      }
      return posed;
    });
    return {foot:shape.parent !== null && footParents.has(shape.parent),points};
  });
}

export function describeWorldModelAnimationRig(ops: readonly SceneV2Op[], rig: StoredHumanoidRig | null): WorldModelAnimationRig {
  const groups = ops.flatMap(op => op.t === "group" ? [{id:op.id,parent:op.parent,position:op.position,rotation:op.rotation,scale:op.scale}] : []);
  const shapes = ops.flatMap(op => {
    if (op.t === "group" || !("position" in op)) return [];
    const localBounds = v2ShapeLocalBounds(op);
    return localBounds ? [{id:op.id,parent:op.parent,position:op.position,rotation:op.rotation,scale:op.scale,localBounds,localTransform:v2ShapeLocalTransform(op)}] : [];
  });
  const result: WorldModelAnimationRig = {groups,shapes,rig};
  const motionReference=describeHumanoidMotion(result);
  if(motionReference)result.motionReference=motionReference;
  const points = posedPoints(result);
  const feet = points.filter(shape => shape.foot).flatMap(shape => shape.points);
  const bounds = envelope(feet.length ? feet : points.flatMap(shape => shape.points));
  const groundAnchorLocal: Vec3 | null = bounds ? [(bounds.min[0]+bounds.max[0])/2,bounds.min[1],(bounds.min[2]+bounds.max[2])/2] : null;
  result.spatial = {
    forwardLocal:rig ? [0,0,1] : null,
    forwardSource:rig ? "humanoid-v1" : "unknown",
    groundAnchorLocal,
    rootToGroundHeightMeters:groundAnchorLocal ? -groundAnchorLocal[1] : null,
    anchorSource:feet.length ? "foot-geometry-bounds" : bounds ? "geometry-bounds" : "unknown"
  };
  return result;
}

// Prepared ops are immutable and shared by content identity. Avoid geometry work on drag frames.
const groundAnchorCache = new WeakMap<readonly SceneV2Op[], Map<boolean, Vec3 | null>>();

/** Stable bind-pose membership anchor. Animated limb swing does not change ownership. */
export function modelGroundAnchorLocal(ops: readonly SceneV2Op[], rig: StoredHumanoidRig | null): Vec3 | null {
  let byProfile = groundAnchorCache.get(ops);
  if (!byProfile) { byProfile = new Map(); groundAnchorCache.set(ops,byProfile); }
  const humanoid = rig !== null;
  if (!byProfile.has(humanoid)) {
    byProfile.set(humanoid,describeWorldModelAnimationRig(ops,rig).spatial?.groundAnchorLocal ?? null);
  }
  const anchor = byProfile.get(humanoid);
  return anchor ? [...anchor] : null;
}

/** Asset XYZ -> world u/v/h basis, followed by the instance's rotation, scale and translation. */
export function worldModelGroundAnchor(localAnchor: Vec3, transform: WorldTransform): GroundPoint {
  const offset = quatRotate([...transform.rotation],[localAnchor[0]*transform.scale,-localAnchor[2]*transform.scale,localAnchor[1]*transform.scale]);
  return {u:transform.position.u+offset[0],v:transform.position.v+offset[1]};
}

export function worldAnimationSegmentSummary(ir: WorldAnimationIr) {
  const parts = ir.partTracks ?? [];
  const channelCount = countWorldAnimationChannels(ir);
  const partSegmentCount = parts.reduce((count, track) => count + (track.cycle ? track.cycle.keyframes.length - 1 : 1), 0);
  return {
    segmentCount: ir.instanceTracks.length + partSegmentCount + ir.cameraTracks.length,
    maxChannels: WORLD_ANIMATION_MAX_CHANNELS,
    animatedJointCount: new Set(parts.map(t => JSON.stringify([t.targetId,t.partId]))).size,
    channelCount,
    logicalTrackCount: channelCount,
    keyframeCount: 2 * (ir.instanceTracks.length + ir.cameraTracks.length) + parts.reduce((count, track) => count + (track.cycle ? track.cycle.keyframes.length : 2), 0),
    cycleCount: parts.filter(track => track.cycle).length,
    instanceSegmentCount: ir.instanceTracks.length,
    partSegmentCount,
    cameraSegmentCount: ir.cameraTracks.length
  };
}

export function inspectWorldAnimationModelSample(
  model: {transform:WorldTransform;animationRig?:WorldModelAnimationRig},
  sample: SampledInstanceMotion | undefined,
  nextSample: SampledInstanceMotion | undefined,
  area?: GroundAabb,
  movementTimeDelta = 0.01
) {
  const base = model.transform;
  const worldTransform: WorldTransform = {
    ...base,position:sample?.position ?? base.position,
    rotation:sample?.rotation ? quatMul([...base.rotation],[...sample.rotation]) : base.rotation,
    scale:sample?.scale ?? base.scale
  };
  const rig = model.animationRig;
  const forward = rig?.spatial?.forwardLocal;
  const root = rig?.groups.find(group => group.id === "Root");
  const localForward = forward && root ? quatRotate(
    quatMul(transformOf(root).rotation,[...(sample?.partRotations?.Root ?? [0,0,0,1])] as Quat),forward
  ) : forward;
  const forwardWorld = localForward ? quatRotate([...worldTransform.rotation],[localForward[0],-localForward[2],localForward[1]]) : null;
  const nextPosition = nextSample?.position ?? worldTransform.position;
  const dt = movementTimeDelta !== 0 && Number.isFinite(movementTimeDelta) ? movementTimeDelta : 0.01;
  const velocity = [(nextPosition.u-worldTransform.position.u)/dt,(nextPosition.v-worldTransform.position.v)/dt];
  const speed = Math.hypot(velocity[0]!,velocity[1]!);
  const forwardLength = forwardWorld ? Math.hypot(forwardWorld[0],forwardWorld[1]) : 0;
  const alignment = speed > 1e-6 && forwardLength > 1e-6
    ? (forwardWorld![0]*velocity[0]!+forwardWorld![1]*velocity[1]!)/(speed*forwardLength) : null;
  const status = !forwardWorld ? "unknown" : speed <= 1e-6 ? "stationary" : alignment === null ? "unknown" : alignment > 0.5 ? "forward" : alignment < -0.5 ? "backward" : "sideways";
  const shapePoints = rig ? posedPoints(rig,sample?.partRotations) : [];
  const mapWorld = (point: Vec3): Vec3 => {
    const rotated = quatRotate([...worldTransform.rotation],[point[0]*worldTransform.scale,-point[2]*worldTransform.scale,point[1]*worldTransform.scale]);
    return [rotated[0]+worldTransform.position.u,rotated[1]+worldTransform.position.v,rotated[2]+worldTransform.position.h];
  };
  const bounds = envelope(shapePoints.flatMap(shape => shape.points.map(mapWorld)));
  const feet = shapePoints.filter(shape => shape.foot).flatMap(shape => shape.points.map(mapWorld));
  const groundBounds = envelope(feet) ?? bounds;
  const ground = groundBounds ? {
    lowestBoundsHeightMeters:groundBounds.min[2],
    recommendedRootHeightMeters:worldTransform.position.h-groundBounds.min[2],
    anchorWorld:{u:(groundBounds.min[0]+groundBounds.max[0])/2,v:(groundBounds.min[1]+groundBounds.max[1])/2,h:groundBounds.min[2]},
    status:groundBounds.min[2] < -0.01 ? "below-ground" : groundBounds.min[2] > 0.01 ? "above-ground" : "touching",
    method:"conservative-posed-bounds"
  } : null;
  const motionReference=rig ? rig.motionReference ?? describeHumanoidMotion(rig) : null;
  const jointEndpointsInParent:Record<string,Vec3>=Object.create(null) as Record<string,Vec3>;
  if(rig)for(const joint of motionReference?.joints ?? []){
    const endpoint=sampleJointEndpoint(rig,joint.jointId,joint.childId,sample?.partRotations);
    if(endpoint)jointEndpointsInParent[joint.jointId]=endpoint.endpointInParent;
  }
  const anchorWorld = rig?.spatial?.groundAnchorLocal ? worldModelGroundAnchor(rig.spatial.groundAnchorLocal,worldTransform) : null;
  return {
    worldTransform,forwardWorld,heading:{alignment,status},ground,
    landmarksLocal:rig ? sampleRigLandmarks(rig,sample?.partRotations) : {},
    jointEndpointsInParent,
    membership: {
      anchorWorld,
      insideSceneArea:anchorWorld && area ? classifyCameraPoint({area,position:{...anchorWorld,h:0}}) === "complete" : null,
      source:"bind-pose-ground-anchor"
    },
    bounds:bounds ? {...bounds,outsideSceneArea:area ? bounds.min[0]<area.min.u-1e-6 || bounds.max[0]>area.max.u+1e-6 || bounds.min[1]<area.min.v-1e-6 || bounds.max[1]>area.max.v+1e-6 : null} : null
  };
}
