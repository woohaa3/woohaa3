/** Kinematic hints in NPZ source seconds, never semantic contact or visual verification. */
export function inspectSomaMotionTiming(posed:Float64Array, fps:number, frameCount:number) {
  if(!Number.isFinite(fps)||fps<=0||fps>240||!Number.isInteger(frameCount)||frameCount<1||frameCount>18000||posed.length!==frameCount*77*3||!posed.every(Number.isFinite))throw Error('Invalid SOMA timing data');
  const relative=(f:number,j:number)=>[0,1,2].map(k=>posed[(f*77+j)*3+k]!-posed[f*77*3+k]!);
  const firstTorso=relative(0,3),initialLength=Math.hypot(...firstTorso);
  const displacement=(f:number,j:number)=>Math.hypot(...relative(f,j).map((v,k)=>v-relative(0,j)[k]!));
  const values={leftHandForward:[] as number[],rightHandForward:[] as number[],handsForward:[] as number[],torsoTilt:[] as number[],headDisplacement:[] as number[],leftHandDisplacement:[] as number[],rightHandDisplacement:[] as number[],leftFootForward:[] as number[],rightFootForward:[] as number[]};
  for(let f=0;f<frameCount;f++){
    const torso=relative(f,3),length=Math.hypot(...torso);
    values.torsoTilt.push(length>1e-8&&initialLength>1e-8?Math.acos(Math.max(-1,Math.min(1,torso.reduce((n,v,k)=>n+v*firstTorso[k]!,0)/(length*initialLength))))*180/Math.PI:0);
    values.headDisplacement.push(displacement(f,6));
    values.leftHandDisplacement.push(displacement(f,14));values.rightHandDisplacement.push(displacement(f,42));
    const left=relative(f,14)[2]!-relative(0,14)[2]!,right=relative(f,42)[2]!-relative(0,42)[2]!;
    values.leftHandForward.push(left);values.rightHandForward.push(right);values.handsForward.push((left+right)/2);
    values.leftFootForward.push(relative(f,69)[2]!-relative(0,69)[2]!);
    values.rightFootForward.push(relative(f,74)[2]!-relative(0,74)[2]!);
  }
  const thresholds={leftHandForward:.04,rightHandForward:.04,handsForward:.04,torsoTilt:10,headDisplacement:.04,leftHandDisplacement:.05,rightHandDisplacement:.05,leftFootForward:.04,rightFootForward:.04};
  const signals=Object.fromEntries(Object.entries(values).map(([key,series])=>{
    const threshold=thresholds[key as keyof typeof thresholds],hold=Math.max(2,Math.ceil(fps*.08));
    const positive=key.endsWith('Forward');
    let onset:number|null=null,peak=0;
    for(let f=0;f<frameCount;f++){
      if((positive?series[f]!:Math.abs(series[f]!))>(positive?series[peak]!:Math.abs(series[peak]!)))peak=f;
      if(onset===null&&f+hold<=frameCount&&series.slice(f,f+hold).every(v=>(positive?v:Math.abs(v))>=threshold))onset=f/fps;
    }
    return [key,{onsetTime:onset,peakTime:peak/fps,peakValue:series[peak],threshold,unit:key==='torsoTilt'?'degrees':'meters'}];
  })) as Record<keyof typeof values,{onsetTime:number|null;peakTime:number;peakValue:number|undefined;threshold:number;unit:string}>;
  const stride=Math.max(1,Math.ceil(frameCount/32));
  const profile=[];
  for(let f=0;f<frameCount;f+=stride)profile.push({time:f/fps,...Object.fromEntries(Object.entries(values).map(([key,series])=>[key,Number(series[f]!.toFixed(4))]))});
  return {verification:'kinematic-candidates-only',fps,frameCount,duration:frameCount/fps,lastSampleTime:(frameCount-1)/fps,signals,profile,limits:'All times are NPZ source seconds. Displacements are pelvis-relative changes from frame zero; foot forward is source +Z. Torso tilt is angular change from frame zero. Onsets require sustained thresholds; peaks may include noise. No impact, contact, facing or visual verification.'};
}

/** Root displacement must be checked independently of pelvis-relative limb signals. */
export function inspectSomaRootTravel(roots:Float64Array,fps:number,frameCount:number){
 if(!Number.isFinite(fps)||fps<=0||!Number.isInteger(frameCount)||frameCount<1||frameCount>18000||roots.length!==frameCount*3||!roots.every(Number.isFinite))throw Error('Invalid SOMA root timing data');
 const distance=Array.from({length:frameCount},(_,f)=>Math.hypot(roots[f*3]!-roots[0]!,roots[f*3+2]!-roots[2]!));
 const hold=Math.max(2,Math.ceil(fps*.08)),threshold=.04;
 const onset=distance.findIndex((value,f)=>value>=threshold&&f+hold<=frameCount&&distance.slice(f,f+hold).every(v=>v>=threshold));
 return {maxHorizontalDistance:Math.max(...distance),endpointDistance:distance[frameCount-1]!,endpointDelta:[roots[roots.length-3]!-roots[0]!,0,roots[roots.length-1]!-roots[2]!],onsetTime:onset<0?null:onset/fps,threshold,unit:'meters'};
}
