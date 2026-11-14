import {it,expect} from 'vitest';
import {inspectSomaMotionTiming} from './timing.js';
it('reports source-time candidates without mistaking a single-frame spike for onset',()=>{
 const frames=90,fps=30,posed=new Float64Array(frames*77*3);
 for(let f=0;f<frames;f++){
  posed[(f*77+3)*3+1]=1;
  posed[(f*77+6)*3+1]=1.5;
  if(f===5)posed[(f*77+74)*3+2]=.5;
  if(f>=30)posed[(f*77+74)*3+2]=Math.min(.5,(f-29)*.05);
 }
 const result=inspectSomaMotionTiming(posed,fps,frames);
 expect(result.verification).toBe('kinematic-candidates-only');
 expect(result.signals.rightFootForward.onsetTime).toBe(1);
 expect(result.signals.rightFootForward.peakTime).toBeCloseTo(5/30);
 expect(result.signals.torsoTilt.onsetTime).toBeNull();
 expect(result.profile.length).toBeLessThanOrEqual(32);
 expect(()=>inspectSomaMotionTiming(posed,0,frames)).toThrow();
 expect(()=>inspectSomaMotionTiming(posed,30,frames-1)).toThrow();
 posed[4]=NaN;expect(()=>inspectSomaMotionTiming(posed,30,frames)).toThrow();
});
it('reports forward hand extension instead of confusing backward travel with the attack peak',()=>{
 const p=new Float64Array(30*77*3);
 for(let f=0;f<30;f++){p[(f*77+3)*3+1]=1;p[(f*77+14)*3+2]=f===10?.5:f>15?-1:0;p[(f*77+42)*3+2]=f===10?.3:f>15?-.5:0;}
 const timing=inspectSomaMotionTiming(p,30,30);
 expect(timing.signals.handsForward.peakTime).toBeCloseTo(1/3);
 expect(timing.signals.handsForward.peakValue).toBeCloseTo(.4);
 expect(timing.signals.leftHandForward.peakTime).toBeCloseTo(1/3);
});

import {inspectSomaRootTravel} from './timing.js';
it('measures full root path and sustained travel onset rather than only the endpoint',()=>{
 const roots=new Float64Array(30*3);
 for(let f=5;f<20;f++)roots[f*3+2]=-.5;
 const result=inspectSomaRootTravel(roots,30,30);
 expect(result.maxHorizontalDistance).toBe(.5);expect(result.endpointDistance).toBe(0);
 expect(result.onsetTime).toBeCloseTo(5/30);
});
it('uses the forward kick peak even when backward preparation is larger',()=>{
 const p=new Float64Array(30*77*3);
 for(let f=0;f<30;f++){p[(f*77+3)*3+1]=1;p[(f*77+74)*3+2]=f>=5&&f<10?-.6:f>=15&&f<20?.5:0;}
 const signal=inspectSomaMotionTiming(p,30,30).signals.rightFootForward;
 expect(signal.peakTime).toBe(.5);expect(signal.peakValue).toBe(.5);expect(signal.onsetTime).toBe(.5);
});
