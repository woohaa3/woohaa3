import { rotateGroundQuarterTurns } from '../world-quarter-turn.js';
import { quatRotate, type Vec3 } from '../model-transform.js';
import type { WorldRotation, WorldPoint, GroundPoint } from '../shared-world.js';
import { roundedWalkPath } from '../world-walk.js';
export type SomaSceneLapRoute = {
 kind:'scene-lap'; connectorMode?:'smooth'; referenceFrame?:{origin:GroundPoint;quarterTurns:number}; phaseDistance?:number; path:GroundPoint[]; startAnchor:GroundPoint; cornerRadius:number;
 groundAnchorLocal:Vec3; baseRotation:WorldRotation; scale:number; rootHeight:number;
};
const finite=(x:unknown):x is number=>typeof x==='number'&&Number.isFinite(x)&&Math.abs(x)<=100000;
function point(x:unknown):x is GroundPoint{return !!x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===2&&finite((x as GroundPoint).u)&&finite((x as GroundPoint).v);}
type Point=[number,number];
/** Deterministic arc-length table keeps route time proportional to traveled distance. */
function connectorCurve(a:Point,b:Point,start:Point,end:Point){
 const chord=Math.hypot(b[0]-a[0],b[1]-a[1]),handle=Math.min(.4,chord*.35);
 const c:Point=[a[0]+start[0]*handle,a[1]+start[1]*handle],e:Point=[b[0]-end[0]*handle,b[1]-end[1]*handle];
 const at=(t:number):{point:Point;tangent:Point}=>{
  const u=1-t;
  const point:Point=[0,1].map(i=>u*u*u*a[i]!+3*u*u*t*c[i]!+3*u*t*t*e[i]!+t*t*t*b[i]!) as Point;
  const d:Point=[0,1].map(i=>3*u*u*(c[i]!-a[i]!)+6*u*t*(e[i]!-c[i]!)+3*t*t*(b[i]!-e[i]!)) as Point;
  const n=Math.hypot(...d);return {point,tangent:n>1e-12?[d[0]/n,d[1]/n]:start};
 };
 const distances=[0];let previous=a;
 for(let i=1;i<=128;i++){const p=at(i/128).point;distances.push(distances[i-1]!+Math.hypot(p[0]-previous[0],p[1]-previous[1]));previous=p;}
 const length=distances[128]!;
 return {length,sample:(distance:number)=>{
  const d=Math.max(0,Math.min(length,distance));let i=1;while(i<128&&distances[i]!<d)i++;
  const span=distances[i]!-distances[i-1]!;return at((i-1+(span>0?(d-distances[i-1]!)/span:0))/128);
 }};
}
function routeFor(route:SomaSceneLapRoute){
 const lap=roundedWalkPath(route.path.map(p=>[p.u,p.v]),route.cornerRadius);
 const phase=route.phaseDistance??0,sample=lap.sample(phase);
 const entry=sample.point,delta:Point=[entry[0]-route.startAnchor.u,entry[1]-route.startAnchor.v],connector=Math.hypot(...delta);
 const start:Point=[route.startAnchor.u,route.startAnchor.v];
 const direction:Point=connector>1e-8?[delta[0]/connector,delta[1]/connector]:sample.tangent;
 const inbound=route.connectorMode==='smooth'&&connector>1e-8?connectorCurve(start,entry,direction,sample.tangent):undefined;
 const outbound=route.connectorMode==='smooth'&&connector>1e-8?connectorCurve(entry,start,sample.tangent,[-direction[0],-direction[1]]):undefined;
 const entryLength=inbound?.length??connector,exitLength=outbound?.length??connector;
 return {lap,phase,entry,delta,connector,inbound,outbound,entryLength,exitLength,length:lap.length+entryLength+exitLength};
}
export function describeSomaSceneLapRoute(route:SomaSceneLapRoute,duration:number):{lapLength:number;connectorLength:number;entryLength:number;exitLength:number;length:number;speed:number}{const r=routeFor(route);return {entryLength:r.entryLength,exitLength:r.exitLength,lapLength:r.lap.length,connectorLength:r.entryLength+r.exitLength,length:r.length,speed:r.length/duration};}
export function validateSomaSceneLapRoute(input:unknown,duration:number):SomaSceneLapRoute{
 const x=input as SomaSceneLapRoute;
 if(!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).filter(k=>k!=='phaseDistance'&&k!=='referenceFrame'&&k!=='connectorMode').sort().join(',')!==['kind','path','startAnchor','cornerRadius','groundAnchorLocal','baseRotation','scale','rootHeight'].sort().join(',')||x.kind!=='scene-lap'||(x.connectorMode!==undefined&&x.connectorMode!=='smooth')||(x.phaseDistance!==undefined&&!finite(x.phaseDistance))||!Array.isArray(x.path)||x.path.length<4||x.path.length>64||!x.path.every(point)||!point(x.startAnchor)||!finite(x.cornerRadius)||x.cornerRadius<=0||!finite(x.scale)||x.scale<.001||x.scale>1000||!finite(x.rootHeight)||!Array.isArray(x.groundAnchorLocal)||x.groundAnchorLocal.length!==3||!x.groundAnchorLocal.every(finite)||!Array.isArray(x.baseRotation)||x.baseRotation.length!==4||!x.baseRotation.every(finite)||Math.abs(Math.hypot(...x.baseRotation)-1)>1e-6||Math.abs(x.baseRotation[0])+Math.abs(x.baseRotation[1])>1e-6||!Number.isFinite(duration)||duration<=0)throw new Error('Invalid scene-lap route');
 if(new Set(x.path.map(p=>`${p.u},${p.v}`)).size!==x.path.length||Math.abs(x.path.reduce((sum,p,i)=>{const q=x.path[(i+1)%x.path.length]!;return sum+p.u*q.v-p.v*q.u;},0))<1e-6)throw new Error('Degenerate scene-lap route');
 if(x.referenceFrame!==undefined){const f=x.referenceFrame;if(!f||typeof f!=='object'||Array.isArray(f)||Object.keys(f).sort().join(',')!=='origin,quarterTurns'||!point(f.origin)||!Number.isInteger(f.quarterTurns)||Math.abs(f.quarterTurns)>100000)throw new Error('Invalid scene-lap reference frame');}
 const facts=describeSomaSceneLapRoute(x,duration);
 if(!Number.isFinite(facts.speed)||facts.speed>3||facts.length<.01)throw new Error('Scene-lap speed exceeds 3 m/s');
 return JSON.parse(JSON.stringify(x)) as SomaSceneLapRoute;
}
/** World-space route, one full closed lap with explicit straight entry and return connectors. */
export function sampleSomaSceneLapRoute(route:SomaSceneLapRoute,progress:number):{position:WorldPoint;rotation:WorldRotation}{
 const r=routeFor(route),d=Math.max(0,Math.min(1,progress))*r.length;
 let point:[number,number],tangent:[number,number];
 if(r.inbound&&d<r.entryLength){({point,tangent}=r.inbound.sample(d));}
 else if(r.outbound&&d>r.entryLength+r.lap.length){({point,tangent}=r.outbound.sample(d-r.entryLength-r.lap.length));}
 else if(r.connector>1e-8&&d<r.entryLength){const t=d/r.entryLength;point=[route.startAnchor.u+r.delta[0]*t,route.startAnchor.v+r.delta[1]*t];tangent=[r.delta[0]/r.connector,r.delta[1]/r.connector];}
 else if(r.connector>1e-8&&d>r.entryLength+r.lap.length){const t=(d-r.entryLength-r.lap.length)/r.exitLength;point=[r.entry[0]-r.delta[0]*t,r.entry[1]-r.delta[1]*t];tangent=[-r.delta[0]/r.connector,-r.delta[1]/r.connector];}
 else {const sample=r.lap.sample(d-r.entryLength+r.phase);point=sample.point;tangent=sample.tangent;}
 const yaw=Math.atan2(tangent[0],-tangent[1]);
 const rotation:WorldRotation=[0,0,Math.sin(yaw/2),Math.cos(yaw/2)];
 const anchor=route.groundAnchorLocal,offset=quatRotate([...rotation],[anchor[0]*route.scale,-anchor[2]*route.scale,anchor[1]*route.scale]);
 return {position:{u:point[0]-offset[0],v:point[1]-offset[1],h:route.rootHeight},rotation};
}

/** Rebase a stored route-world point into the director's current frame. */
export function transformSomaSceneLapPoint(point:GroundPoint,route:SomaSceneLapRoute,origin:GroundPoint,quarterTurns:number):GroundPoint{
 const reference=route.referenceFrame??{origin:{u:0,v:0},quarterTurns:0};
 if(origin.u===reference.origin.u&&origin.v===reference.origin.v&&(quarterTurns-reference.quarterTurns)%4===0)return {...point};
 const local=rotateGroundQuarterTurns({u:point.u-reference.origin.u,v:point.v-reference.origin.v},{u:0,v:0},-reference.quarterTurns);
 const rotated=rotateGroundQuarterTurns(local,{u:0,v:0},quarterTurns);
 return {u:rotated.u+origin.u,v:rotated.v+origin.v};
}
