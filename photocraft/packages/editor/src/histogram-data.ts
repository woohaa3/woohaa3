export type HistogramChannel={bins:number[];mean:number|null;stdDev:number|null;median:number|null;samples:number};
export type HistogramReadout={channels:HistogramChannel[];pixels:number;cacheLevel:number};
export function decodeHistogram(value:unknown):HistogramReadout {
  const fail=()=>{throw new Error("直方图读数无效");};
  if(!value||typeof value!=="object")return fail();const data=value as Record<string,unknown>;
  if(!Number.isSafeInteger(data.pixels)||Number(data.pixels)<1||!Number.isSafeInteger(data.cacheLevel)||Number(data.cacheLevel)<1||Number(data.cacheLevel)>32||!Array.isArray(data.channels)||data.channels.length!==4)return fail();
  const channels=data.channels.map((item:unknown)=>{
    if(!item||typeof item!=="object")return fail();const channel=item as HistogramChannel;
    if(!Array.isArray(channel.bins)||channel.bins.length!==256||channel.bins.some(n=>!Number.isSafeInteger(n)||n<0)||!Number.isSafeInteger(channel.samples)||channel.samples<0||channel.samples>384*384||channel.bins.reduce((a,b)=>a+b,0)!==channel.samples)return fail();
    if(channel.samples===0){if(channel.mean!==null||channel.stdDev!==null||channel.median!==null)return fail();}
    else if(typeof channel.mean!=="number"||!Number.isFinite(channel.mean)||channel.mean<0||channel.mean>255||typeof channel.stdDev!=="number"||!Number.isFinite(channel.stdDev)||channel.stdDev<0||channel.stdDev>255||!Number.isSafeInteger(channel.median)||channel.median!<0||channel.median!>255)return fail();
    return {...channel,bins:[...channel.bins]};
  });
  if(channels.some(channel=>channel.samples!==channels[0]!.samples))return fail();
  return {channels,pixels:Number(data.pixels),cacheLevel:Number(data.cacheLevel)};
}
