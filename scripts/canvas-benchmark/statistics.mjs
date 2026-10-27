import { isDeepStrictEqual } from 'node:util';

function finite(values) {
  if (!Array.isArray(values) || values.some(v=>typeof v!=='number'||!Number.isFinite(v))) throw new TypeError('Expected finite numeric samples');
}
function rank(sorted,p) { return sorted[Math.max(0,Math.ceil(sorted.length*p)-1)]; }
function median(values) { const sorted=[...values].sort((a,b)=>a-b); const n=sorted.length; return n%2 ? sorted[(n-1)/2] : (sorted[n/2-1]+sorted[n/2])/2; }
export function summarize(values) {
  finite(values); if(!values.length) return null;
  const sorted=[...values].sort((a,b)=>a-b);
  return {count:values.length,mean:values.reduce((a,b)=>a+b,0)/values.length,min:sorted[0],max:sorted.at(-1),p50:rank(sorted,.5),p95:rank(sorted,.95),p99:rank(sorted,.99),p99Sufficient:values.length>=1000};
}
/** Resample independent run pairs, never pool their individual frames. Relative values are fractions. */
export function comparePairs(pairs,{seed=42,iterations=10000}={}) {
  if(!Number.isSafeInteger(seed)||!Number.isSafeInteger(iterations)||iterations<1) throw new RangeError('seed and positive iterations must be safe integers');
  if(!Array.isArray(pairs)) throw new TypeError('Expected pairs');
  finite(pairs.flatMap(p=>[p.baseline,p.candidate]));
  if(!pairs.length) return null;
  const differences=pairs.map(p=>p.candidate-p.baseline);
  const relative=pairs.some(p=>p.baseline===0)?null:pairs.map(p=>(p.candidate-p.baseline)/p.baseline);
  let state=seed>>>0;
  const random=()=>{state=(Math.imul(1664525,state)+1013904223)>>>0;return state/4294967296;};
  const boot=[];const relativeBoot=[];
  for(let i=0;i<iterations;i++) {
    const indices=Array.from({length:pairs.length},()=>Math.floor(random()*pairs.length));
    boot.push(median(indices.map(j=>differences[j])));
    if(relative) relativeBoot.push(median(indices.map(j=>relative[j])));
  }
  const interval=v=>{v.sort((a,b)=>a-b);return [rank(v,.025),rank(v,.975)];};
  return {count:pairs.length,medianDifference:median(differences),medianRelativeDifference:relative?median(relative):null,confidenceInterval:interval(boot),relativeConfidenceInterval:relative?interval(relativeBoot):null,seed,iterations};
}
export const COMPARISON_KEYS = Object.freeze(['fixtureHash','scenario','gpu','browser','viewport','devicePixelRatio','buildMode','sampleDurationMs','warmupMs']);
/** Missing metadata is incompatible, even when both sides omit it. */
export function checkCompatibility(a,b,keys=COMPARISON_KEYS) {
  if(!Array.isArray(keys)||!keys.length) throw new TypeError('Explicit nonempty metadata keys required');
  const mismatches=keys.filter(key=>a?.[key]==null||b?.[key]==null||!isDeepStrictEqual(a[key],b[key]));
  return {compatible:mismatches.length===0,mismatches};
}
