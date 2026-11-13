/** Kinematic hints in NPZ source seconds, never semantic contact or visual verification. */
export function inspectSomaMotionTiming(posed:Float64Array, fps:number, frameCount:number) {
  if(!Number.isFinite(fps)||fps<=0||fps>240||!Number.isInteger(frameCount)||frameCount<1||frameCount>18000||posed.length!==frameCount*77*3||!posed.every(Number.isFinite))throw Error('Invalid SOMA timing data');
  const relative=(f:number,j:number)=>[0,1,2].map(k=>posed[(f*77+j)*3+k]!-posed[f*77*3+k]!);
  const firstTorso=relative(0,3),initialLength=Math.hypot(...firstTorso);
  const displacement=(f:number,j:number)=>Math.hypot(...relative(f,j).map((v,k)=>v-relative(0,j)[k]!));
  const values={torsoTilt:[] as number[],headDisplacement:[] as number[],leftHandDisplacement:[] as number[],rightHandDisplacement:[] as number[],leftFootForward:[] as number[],rightFootForward:[] as number[]};
  for(let f=0;f<frameCount;f++){
    const torso=relative(f,3),length=Math.hypot(...torso);
    values.torsoTilt.push(length>1e-8&&initialLength>1e-8?Math.acos(Math.max(-1,Math.min(1,torso.reduce((n,v,k)=>n+v*firstTorso[k]!,0)/(length*initialLength))))*180/Math.PI:0);
    values.headDisplacement.push(displacement(f,6));
    values.leftHandDisplacement.push(displacement(f,14));values.rightHandDisplacement.push(displacement(f,42));
    values.leftFootForward.push(relative(f,69)[2]!-relative(0,69)[2]!);
    values.rightFootForward.push(relative(f,74)[2]!-relative(0,74)[2]!);
  }
  const thresholds={torsoTilt:10,headDisplacement:.04,leftHandDisplacement:.05,rightHandDisplacement:.05,leftFootForward:.04,rightFootForward:.04};
  const signals=Object.fromEntries(Object.entries(values).map(([key,series])=>{
    const threshold=thresholds[key as keyof typeof thresholds],hold=Math.max(2,Math.ceil(fps*.08));
    let onset:number|null=null,peak=0;
    for(let f=0;f<frameCount;f++){
      if(Math.abs(series[f]!)>Math.abs(series[peak]!))peak=f;
      if(onset===null&&f+hold<=frameCount&&series.slice(f,f+hold).every(v=>Math.abs(v)>=threshold))onset=f/fps;
    }
    return [key,{onsetTime:onset,peakTime:peak/fps,peakValue:series[peak],threshold,unit:key==='torsoTilt'?'degrees':'meters'}];
  })) as Record<keyof typeof values,{onsetTime:number|null;peakTime:number;peakValue:number|undefined;threshold:number;unit:string}>;
  const stride=Math.max(1,Math.ceil(frameCount/32));
  const profile=[];
  for(let f=0;f<frameCount;f+=stride)profile.push({time:f/fps,...Object.fromEntries(Object.entries(values).map(([key,series])=>[key,Number(series[f]!.toFixed(4))]))});
  return {verification:'kinematic-candidates-only',fps,frameCount,duration:frameCount/fps,lastSampleTime:(frameCount-1)/fps,signals,profile,limits:'All times are NPZ source seconds. Displacements are pelvis-relative changes from frame zero; foot forward is source +Z. Torso tilt is angular change from frame zero. Onsets require sustained thresholds; peaks may include noise. No impact, contact, facing or visual verification.'};
}
