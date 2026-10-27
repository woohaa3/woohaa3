import { createHash } from 'node:crypto';

const UPDATED_AT = '2026-01-01T00:00:00.000Z';
/** Canonical text-only fixture. Media fixtures require separately verified assets. */
export function generateFixture({ nodes = 1000, visible = 24, seed = 42, kind = 'text', edgesPerNode = 0, layout = 'legacy' } = {}) {
  for (const [name, value] of Object.entries({nodes, visible, seed, edgesPerNode})) {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a nonnegative safe integer`);
  }
  if (layout !== 'legacy' && layout !== 'fit-grid') throw new RangeError('layout must be legacy or fit-grid');
  const fitGrid = layout === 'fit-grid';
  const maxVisible = fitGrid ? 300 : 100;
  const emptyBaseline = nodes === 0 && visible === 0;
  if (!emptyBaseline && (visible < 1 || visible > maxVisible || nodes < 2 * visible || nodes > 50000)) throw new RangeError(`Require nodes=visible=0, or 1 <= visible <= ${maxVisible} and 2*visible <= nodes <= 50000`);
  if (kind !== 'text') throw new RangeError('Only text fixtures have verified content; image/model assets are unavailable');
  if (emptyBaseline ? edgesPerNode !== 0 : edgesPerNode >= nodes) throw new RangeError('edgesPerNode must be zero for the empty baseline, otherwise less than nodes');
  if (nodes * edgesPerNode > 200000) throw new RangeError('Fixture edge budget exceeded: maximum 200000 edges');
  const dense = visible > 24;
  const columns = fitGrid ? 20 : dense ? 10 : 6;
  const stepX = fitGrid ? 200 : dense ? 120 : 200;
  const stepY = fitGrid ? 150 : dense ? 60 : 150;
  const nodeList = []; const nodeData = {}; const targets = {origin:[],distant:[]};
  for (let i=0;i<nodes;i++) {
    const id = `benchmark-${seed}-${String(i).padStart(5,'0')}`;
    const region = i < visible ? 'origin' : i < 2*visible ? 'distant' : null;
    const local = region ? i % visible : i - 2*visible;
    const position = region ? {x:100+(local%columns)*stepX+(region==='distant'?20000:0),y:140+Math.floor(local/columns)*stepY} : {x:40000+(local%200)*200,y:20000+Math.floor(local/200)*150};
    nodeList.push({id,type:'text',position,width:180,height:130});
    nodeData[id]={title:`Benchmark ${seed} / ${i}`,prompt:`Deterministic text node ${i}. Seed ${seed}. Fixed visible working set.`};
    if(region) targets[region].push(id);
  }
  const edges=[];
  for(let i=0;i<nodes;i++) for(let offset=1;offset<=edgesPerNode;offset++) edges.push({id:`edge-${i}-${offset}`,source:nodeList[i].id,target:nodeList[(i+offset)%nodes].id,sourceHandle:null,targetHandle:null,data:{}});
  const canvas={id:'woohaa3-default-canvas',revision:1,title:'Canvas benchmark',document:{schemaVersion:'asset-canvas-v1',nodes:nodeList,edges,updatedAt:UPDATED_AT},nodeData,assets:[],jobs:[],updatedAt:UPDATED_AT};
  const manifest={generatorVersion:fitGrid||edgesPerNode>0?2:1,seed,N:nodes,V:visible,kind,edgesPerNode,dimensions:{width:1440,height:900,nodeWidth:180,nodeHeight:130},layout:fitGrid?'fit-grid':dense?'dense-overlap':'six-column-grid',hash:createHash('sha256').update(JSON.stringify(canvas)).digest('hex'),mediaSupport:'text-only; image/model assets not independently verified'};
  if (fitGrid) manifest.initialViewport={x:48,y:35.2,zoom:0.32};
  return {canvas,manifest,targets};
}
