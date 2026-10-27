import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { generateFixture } from './fixture.mjs';

test('fixture is canonical, deterministic and preserves working sets as total grows', () => {
  const a = generateFixture(); const b = generateFixture({nodes:50000});
  assert.deepEqual(a, generateFixture());
  assert.equal(a.canvas.id,'woohaa3-default-canvas');
  assert.equal(a.canvas.document.schemaVersion,'asset-canvas-v1');
  assert.equal(a.canvas.revision,1);
  assert.equal(b.canvas.document.nodes.length,50000);
  assert.deepEqual(a.canvas.document.nodes.slice(0,48),b.canvas.document.nodes.slice(0,48));
  assert.equal(a.targets.origin.length,24); assert.equal(a.targets.distant.length,24);
  assert.equal(a.canvas.document.nodes[24].position.x,20100);
  assert.equal(a.manifest.hash,createHash('sha256').update(JSON.stringify(a.canvas)).digest('hex'));
  assert.notEqual(a.manifest.hash,generateFixture({seed:43}).manifest.hash);
  assert.ok(a.canvas.nodeData[a.targets.origin[0]].prompt);
});
test('100 visible nodes use an explicit bounded dense layout', () => {
  const f=generateFixture({visible:100});
  assert.equal(f.manifest.layout,'dense-overlap');
  for(const n of f.canvas.document.nodes.slice(0,100)) {
    assert.ok(n.position.x>=0 && n.position.x+n.width<=1440);
    assert.ok(n.position.y>=0 && n.position.y+n.height<=900);
  }
});
test('invalid counts, unproven media and edges are rejected',()=>{
  for(const args of [{nodes:47},{visible:0},{visible:1.5},{nodes:NaN},{seed:Infinity},{kind:'image'},{edgesPerNode:-1},{edgesPerNode:0.5},{edgesPerNode:1000}]) assert.throws(()=>generateFixture(args));
});
test('edges use valid distinct endpoints and deterministic identities',()=>{
  const f=generateFixture({edgesPerNode:2}); const ids=new Set(f.canvas.document.nodes.map(n=>n.id));
  assert.equal(f.canvas.document.edges.length,2000);
  assert.equal(new Set(f.canvas.document.edges.map(e=>e.id)).size,2000);
  for(const e of f.canvas.document.edges){ assert.ok(ids.has(e.source)&&ids.has(e.target));assert.notEqual(e.source,e.target); }
});
test('edge budget permits 200000 edges and rejects unsafe allocations before generation',()=>{
  assert.equal(generateFixture({nodes:50000,edgesPerNode:4}).canvas.document.edges.length,200000);
  assert.throws(()=>generateFixture({nodes:50000,edgesPerNode:5}),/edge budget/i);
  assert.throws(()=>generateFixture({nodes:50000,edgesPerNode:49999}),/edge budget/i);
});
test('explicit zero baseline has no working sets or nodes',()=>{
  const f=generateFixture({nodes:0,visible:0});
  assert.deepEqual(f.targets,{origin:[],distant:[]});
  assert.deepEqual(f.canvas.document.nodes,[]);assert.deepEqual(f.canvas.document.edges,[]);
  assert.deepEqual(f.canvas.nodeData,{});assert.equal(f.manifest.N,0);assert.equal(f.manifest.V,0);
  assert.deepEqual(f,generateFixture({nodes:0,visible:0}));
  assert.throws(()=>generateFixture({nodes:1,visible:0}));
  assert.throws(()=>generateFixture({nodes:0,visible:0,edgesPerNode:1}));
});

test('legacy defaults preserve their canonical canvas and manifest',()=>{
  for(const [visible,layout,hash] of [[24,'six-column-grid','d2e82451ece19fa0978598580ec006678c2210ab53d30bfe6a5fcecba7354362'],[100,'dense-overlap','dc49b55b715fdf275665ff98adc0e90352bf78af3ca5c4e035c9f872a9fa5454']]) {
    const f=generateFixture({visible});
    assert.deepEqual(f.manifest,{generatorVersion:1,seed:42,N:1000,V:visible,kind:'text',edgesPerNode:0,dimensions:{width:1440,height:900,nodeWidth:180,nodeHeight:130},layout,hash,mediaSupport:'text-only; image/model assets not independently verified'});
  }
});
for(const visible of [200,300]) test(`fit-grid keeps all ${visible} origin nodes fully onscreen without overlap`,()=>{
  const f=generateFixture({visible,layout:'fit-grid',edgesPerNode:2});
  assert.equal(f.manifest.generatorVersion,2);assert.equal(f.manifest.layout,'fit-grid');
  assert.deepEqual(f.manifest.initialViewport,{x:48,y:35.2,zoom:0.32});
  const {x,y,zoom}=f.manifest.initialViewport;
  const screen=n=>({left:x+n.position.x*zoom,top:y+n.position.y*zoom,right:x+(n.position.x+n.width)*zoom,bottom:y+(n.position.y+n.height)*zoom});
  const origin=f.canvas.document.nodes.slice(0,visible).map(screen);
  for(const n of origin) assert.ok(n.left>=0&&n.top>=0&&n.right<=1440&&n.bottom<=900,JSON.stringify(n));
  for(let i=0;i<origin.length;i++) for(let j=i+1;j<origin.length;j++) {
    const a=origin[i],b=origin[j];assert.ok(a.right<=b.left||b.right<=a.left||a.bottom<=b.top||b.bottom<=a.top);
  }
  for(const n of f.canvas.document.nodes.slice(visible).map(screen)) assert.ok(n.left>=1440||n.top>=900||n.right<=0||n.bottom<=0);
  assert.equal(f.canvas.document.edges.length,2000);
  const ids=new Set(f.canvas.document.nodes.map(n=>n.id));
  assert.equal(new Set(f.canvas.document.edges.map(e=>e.id)).size,2000);
  for(let i=0;i<1000;i++) for(let offset=1;offset<=2;offset++) assert.deepEqual(f.canvas.document.edges[i*2+offset-1],{id:`edge-${i}-${offset}`,source:f.canvas.document.nodes[i].id,target:f.canvas.document.nodes[(i+offset)%1000].id,sourceHandle:null,targetHandle:null,data:{}});
  for(const e of f.canvas.document.edges) assert.ok(ids.has(e.source)&&ids.has(e.target)&&e.source!==e.target);
  const larger=generateFixture({nodes:3000,visible,layout:'fit-grid',edgesPerNode:2});
  assert.deepEqual(f.canvas.document.nodes.slice(0,2*visible),larger.canvas.document.nodes.slice(0,2*visible));
  assert.deepEqual(f.targets,larger.targets);
  for(const id of [...f.targets.origin,...f.targets.distant]) assert.deepEqual(f.canvas.nodeData[id],larger.canvas.nodeData[id]);
  assert.equal(larger.canvas.document.edges.length,6000);
  assert.equal(f.manifest.hash,createHash('sha256').update(JSON.stringify(f.canvas)).digest('hex'));
});
test('fit-grid validates layout and expanded count limits',()=>{
  for(const args of [{layout:'unknown'},{layout:null},{visible:101},{layout:'fit-grid',visible:301},{layout:'fit-grid',visible:0},{layout:'fit-grid',visible:300,nodes:599},{layout:'fit-grid',nodes:50001}]) assert.throws(()=>generateFixture(args),RangeError);
  assert.equal(generateFixture({layout:'fit-grid',nodes:50000,visible:300}).manifest.N,50000);
});

// Use the built public contract used by the import/Yjs pipeline, rather than a
// fixture-shaped validator that could repeat the generator's schema mistake.
test('connected fixtures retain every edge through the production contract and Yjs round trip',async()=>{
  const {parseCanvasAggregate}=await import('../../web/contracts/dist/index.js');
  const {serverCanvasToYDoc,yDocToServerCanvas}=await import('../../web/contracts/dist/canvas-yjs/index.js');
  for(const layout of ['legacy','fit-grid']) {
    const {canvas,manifest}=generateFixture({nodes:1000,visible:layout==='fit-grid'?300:24,edgesPerNode:4,layout});
    const parsed=parseCanvasAggregate(canvas);
    assert.equal(parsed.ok,true);
    assert.equal(parsed.canvas.document.edges.length,4000);
    assert.ok(!parsed.issues.some(issue=>issue.code==='edge.dropped'));
    const doc=serverCanvasToYDoc(canvas);
    try {
      const exported=yDocToServerCanvas(doc);
      assert.equal(exported.ok,true);
      assert.equal(exported.canvas.document.edges.length,4000);
      assert.deepEqual([...exported.canvas.document.edges].sort((a,b)=>a.id.localeCompare(b.id)),[...canvas.document.edges].sort((a,b)=>a.id.localeCompare(b.id)));
      assert.equal(manifest.generatorVersion,2);
    } finally { doc.destroy(); }
  }
});
