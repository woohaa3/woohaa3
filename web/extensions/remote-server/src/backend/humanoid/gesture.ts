import { decodeSomaPosedJoints } from '@woohaa3/contracts';

/** A raised wrist is a necessary pose prerequisite; these metrics do not prove a complete wave. */
export function describeRaisedHandFrames(posedJoints: ArrayLike<number>, expectedFrames: number) {
 if(!Number.isInteger(expectedFrames)||expectedFrames<1||expectedFrames>18_000||posedJoints.length!==expectedFrames*77*3)throw new Error('抬手姿态检查的动作帧数不符');
 let leftRaisedFrames=0,rightRaisedFrames=0;
 for(let frame=0;frame<expectedFrames;frame++){
  const y=(joint:number)=>posedJoints[(frame*77+joint)*3+1]!;
  if(y(14)>y(12))leftRaisedFrames++;
  if(y(42)>y(40))rightRaisedFrames++;
 }
 return {frameCount:expectedFrames,leftRaisedFrames,rightRaisedFrames,leftRaisedFraction:leftRaisedFrames/expectedFrames,rightRaisedFraction:rightRaisedFrames/expectedFrames};
}
export async function validateRaisedWavePrerequisite(bytes: Uint8Array, expectedFrames: number) {
 const metrics=describeRaisedHandFrames(await decodeSomaPosedJoints(bytes),expectedFrames);
 if(Math.max(metrics.leftRaisedFraction,metrics.rightRaisedFraction)<.1)throw new Error('生成动作没有满足挥手所需的抬手姿态');
 return metrics;
}
