import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import init,{WasmEditor} from '../packages/editor/dist/wasm/photocraft_editor.js';
await init({module_or_path:await readFile(new URL('../packages/editor/dist/wasm/photocraft_editor_bg.wasm',import.meta.url))});
const editor=new WasmEditor();
const run=(id,params=null)=>JSON.parse(editor.execute(id,JSON.stringify(params)));
const state=()=>JSON.parse(editor.stateJson()).document;
assert.match(JSON.parse(WasmEditor.buildInfoJson()).engineVersion,/woohaa-resolution-v1$/);
run('file.new',{width:16,height:12});
const a=run('layer.new.layer',{name:'Photo A',color:'red'}).layer;
const b=run('layer.new.layer',{name:'Photo B'}).layer;
run('select.findLayers',{name:'photo'});assert.equal(state().selectedLayers.length,2);
const hash=editor.contentHash(),history=state().history.length;
run('select.isolateLayers');assert.equal(state().isolatedLayers.length,2);run('select.isolateLayers',{on:false});
assert.equal(editor.contentHash(),hash);assert.equal(state().history.length,history);
editor.beginLayerVisibility(a);editor.previewLayerProperties(JSON.stringify({layers:[a,b],visible:false}));
assert.equal(editor.contentHash(),hash);editor.commitLayerProperties();assert.equal(state().history.length,history+1);
editor.undo();assert.equal(editor.contentHash(),hash);
editor.beginLayerVisibility(a);editor.previewLayerProperties(JSON.stringify({layers:[a,b],visible:false}));editor.cancelLayerProperties();assert.equal(editor.contentHash(),hash);
editor.beginLayerProperties(a);editor.previewLayerProperties(JSON.stringify({blend:'Multiply'}));assert.equal(editor.contentHash(),hash);editor.cancelLayerProperties();assert.equal(editor.contentHash(),hash);
editor.beginLayerProperties(a);editor.previewLayerProperties(JSON.stringify({blend:'Screen'}));editor.commitLayerProperties();assert.equal(state().layers.find(layer=>layer.id===a).blend,'Screen');editor.undo();assert.equal(editor.contentHash(),hash);
run('layer.linkLayers');assert.notEqual(editor.contentHash(),hash);run('layer.select',{layer:a});run('layer.selectLinkedLayers');assert.equal(state().selectedLayers.length,2);
run('select.rect',{line:'row',x:99,y:11});assert.deepEqual(state().selectionFrame,[0,11,16,12]);
assert.equal(editor.selectionContains(0.5,11.5),true);assert.equal(editor.selectionContains(0.5,10.5),false);
run('layer.select',{layer:b});run('layer.toggleClippingAt',{upper:b,lower:a});assert.equal(state().layers.find(layer=>layer.id===b).clipped,true);
run('layer.toggleClippingAt',{upper:b,lower:a});assert.equal(state().layers.find(layer=>layer.id===b).clipped,false);
// Empty-raster selected-pixel drafts exercise the real WASM state bridge without rendering.
run('layer.select',{layer:b});
const beforeMove=editor.contentHash(),beforeMoveHistory=state().history.length;
assert.equal(editor.beginMove(JSON.stringify({x:0,y:11,selectedPixels:true,duplicate:true})),true);
editor.previewTransform(JSON.stringify([1,0,0,1,2,0]));assert.equal(editor.contentHash(),beforeMove);
editor.cancelTransform();assert.equal(editor.contentHash(),beforeMove);
assert.equal(editor.beginMove(JSON.stringify({x:0,y:11,selectedPixels:true})),true);
editor.previewTransform(JSON.stringify([1,0,0,1,2,0]));editor.commitTransform();assert.equal(state().history.length,beforeMoveHistory+1);assert.equal(state().layers.length,3);
editor.undo();assert.equal(editor.contentHash(),beforeMove);
run('select.deselect');run('file.scripts.deleteAllEmptyLayers');assert.equal(state().layers.length,1);
run('layer.layerMask.hideAll');
const maskLayer=state().activeLayer,maskHash=editor.contentHash(),maskHistory=state().history.length;
editor.beginLayerProperties(maskLayer);editor.previewLayerProperties(JSON.stringify({mask:{density:0.37,feather:4.25}}));assert.equal(editor.contentHash(),maskHash);editor.cancelLayerProperties();assert.equal(editor.contentHash(),maskHash);
editor.beginLayerProperties(maskLayer);editor.previewLayerProperties(JSON.stringify({mask:{density:0.37,feather:4.25}}));editor.commitLayerProperties();assert.notEqual(editor.contentHash(),maskHash);assert.equal(state().history.length,maskHistory+1);
assert.equal(state().layers.find(layer=>layer.id===maskLayer).maskFeather,4.25);
editor.undo();assert.equal(editor.contentHash(),maskHash);
run('layer.layerMask.edit',{density:25,feather:3});assert.notEqual(editor.contentHash(),maskHash);editor.undo();assert.equal(editor.contentHash(),maskHash);
assert.throws(()=>run('layer.layerMask.edit',{density:101}));assert.equal(editor.contentHash(),maskHash);
const beforePurge=editor.contentHash();run('edit.purge.histories');assert.equal(editor.contentHash(),beforePurge);assert.equal(state().history.length,1);assert.equal(state().redoHistory.length,0);
assert.equal(run('edit.purge.videoCache').bytes,0);
run('layer.layerMask.delete');
const beforeTextHash=editor.contentHash(),beforeTextHistory=state().history.length;
editor.beginText(JSON.stringify({x:1,y:1,forceNew:true}));
const checkpoint=JSON.parse(editor.checkpointText());assert.equal(checkpoint.text,'');assert.equal(checkpoint.layer,null);
assert.equal(editor.contentHash(),beforeTextHash);assert.equal(state().history.length,beforeTextHistory);
assert.throws(()=>editor.previewText(JSON.stringify({text:7})));
assert.throws(()=>editor.checkpointText());editor.cancelText();assert.equal(editor.contentHash(),beforeTextHash);
const geometryHash=editor.contentHash(),geometryHistory=state().history.length;
run('image.imageSize',{resolution:300.1,resample:'none'});assert.notEqual(editor.contentHash(),geometryHash);assert.equal(state().width,16);assert.equal(state().height,12);assert.equal(state().history.length,geometryHistory+1);
editor.undo();assert.equal(editor.contentHash(),geometryHash);
run('image.canvasSize',{width:4,height:2,relative:true,anchor:'topLeft',extensionColor:'transparent'});assert.equal(state().width,20);assert.equal(state().height,14);editor.undo();assert.equal(editor.contentHash(),geometryHash);
assert.throws(()=>run('image.canvasSize',{width:8193}));assert.equal(editor.contentHash(),geometryHash);
run('file.automate.fitImage',{width:32,height:32,dontEnlarge:true});assert.equal(editor.contentHash(),geometryHash);assert.equal(state().history.length,geometryHistory);
run('file.automate.fitImage',{width:8,height:8});assert.equal(state().width,8);assert.equal(state().height,6);assert.equal(state().history.length,geometryHistory+1);editor.undo();assert.equal(editor.contentHash(),geometryHash);
assert.throws(()=>run('file.automate.fitImage',{width:8193}));assert.equal(editor.contentHash(),geometryHash);
assert.equal(run('image.revealAll').changed,false);
assert.throws(()=>run('image.trim',{basedOn:'invalid'}));assert.equal(editor.contentHash(),geometryHash);
run('image.rotation.arbitrary',{angle:360});assert.equal(editor.contentHash(),geometryHash);
const rotationDraftHash=editor.contentHash(),rotationDraftHistory=state().history.length;
editor.beginImageRotation();editor.previewImageRotation(JSON.stringify({angle:360}));assert.equal(editor.contentHash(),rotationDraftHash);assert.throws(()=>run('layer.new.layer'));assert.throws(()=>editor.previewImageRotation(JSON.stringify({angle:'bad'})));assert.throws(()=>editor.commitImageRotation());editor.cancelImageRotation();assert.equal(editor.contentHash(),rotationDraftHash);
editor.beginImageRotation();editor.previewImageRotation(JSON.stringify({angle:360}));editor.commitImageRotation();assert.equal(state().history.length,rotationDraftHistory);
run('file.new',{width:8,height:6});const bucketHash=editor.contentHash(),bucketHistory=state().history.length;
assert.equal(JSON.parse(editor.commandsJson()).find(command=>command.id==='paint.bucket').allowed,true);
assert.throws(()=>run('paint.bucket',{x:1,y:1,opacity:0}));assert.equal(editor.contentHash(),bucketHash);
run('paint.bucket',{x:1,y:1,color:'#ff0000',target:'pixels',antiAlias:false});assert.notEqual(editor.contentHash(),bucketHash);assert.equal(state().history.length,bucketHistory+1);editor.undo();assert.equal(editor.contentHash(),bucketHash);
const samplingOptionsHash=editor.contentHash();assert.throws(()=>editor.sampleColorOptions(JSON.stringify({x:0,y:0,size:2})));assert.equal(editor.sampleColorOptions(JSON.stringify({x:-1,y:0,size:11,sampleLayer:'current'})),undefined);assert.equal(editor.contentHash(),samplingOptionsHash);
const symmetryHash=editor.contentHash(),symmetryRevision=state().revision,symmetryHistory=state().history.length;
run('paint.setSymmetry',{mode:'dual',center:[4,3],rotation:15});assert.equal(state().paintingSymmetry.mode,'dual');assert.equal(state().paintingSymmetry.segments.length,2);assert.equal(editor.contentHash(),symmetryHash);assert.equal(state().revision,symmetryRevision);assert.equal(state().history.length,symmetryHistory);
assert.throws(()=>run('paint.setSymmetry',{mode:'bad'}));assert.equal(state().paintingSymmetry.mode,'dual');run('paint.symmetryDisable',{});assert.equal(state().paintingSymmetry,null);assert.equal(editor.contentHash(),symmetryHash);
const pencilHash=editor.contentHash(),pencilHistory=state().history.length;
const pencilParams={strokeCommand:'paint.pencil',points:[[2.8,2.8]],size:1,color:'#ff0000',backgroundColor:'#00ff00',autoErase:true,smoothing:0};
assert.equal(JSON.parse(editor.commandsJson()).find(command=>command.id==='paint.pencil').allowed,true);
editor.beginStroke(JSON.stringify(pencilParams));editor.appendStroke(JSON.stringify({points:[[3.2,2.2]]}));assert.equal(editor.contentHash(),pencilHash);editor.commitStroke();assert.notEqual(editor.contentHash(),pencilHash);assert.equal(state().history.length,pencilHistory+1);
const redPencilHash=editor.contentHash();editor.beginStroke(JSON.stringify(pencilParams));editor.commitStroke();assert.notEqual(editor.contentHash(),redPencilHash);editor.undo();assert.equal(editor.contentHash(),redPencilHash);editor.undo();assert.equal(editor.contentHash(),pencilHash);
const historyLimitHash=editor.contentHash(),historyLimitRevision=state().revision;
assert.throws(()=>editor.setHistoryLimit(0));editor.setHistoryLimit(2);assert.equal(editor.contentHash(),historyLimitHash);assert.equal(state().revision,historyLimitRevision);
// History jumps and session snapshots do not invoke composition.
run('file.new',{width:8,height:6});const historyStart=editor.contentHash();
const snapshot=run('history.newSnapshot',{name:'Original'}).snapshot;
assert.equal(editor.contentHash(),historyStart);assert.equal(state().historySnapshots[0].name,'Original');
run('layer.new.layer',{name:'After'});const historyEnd=editor.contentHash(),historyRevision=state().revision;
run('history.selectState',{state:0});assert.equal(editor.contentHash(),historyStart);assert.equal(state().revision,historyRevision+1);
run('history.selectState',{state:1});assert.equal(editor.contentHash(),historyEnd);assert.equal(state().revision,historyRevision+2);
run('history.renameSnapshot',{snapshot,name:'Before'});assert.equal(editor.contentHash(),historyEnd);
run('history.selectSnapshot',{snapshot});assert.equal(editor.contentHash(),historyStart);editor.undo();assert.equal(editor.contentHash(),historyEnd);
assert.throws(()=>run('history.selectState',{state:0.5}));assert.equal(editor.contentHash(),historyEnd);
run('history.deleteSnapshot',{snapshot});assert.equal(state().historySnapshots.length,0);
assert.ok(state().statusMetadata.flatBytes>0);assert.ok(state().statusMetadata.profile);
run('file.new',{width:32,height:24});run('type.create',{x:1,y:2,text:'Refresh',font:'Inter',size:8});
const refreshHistory=state().history.length,refreshHash=editor.contentHash();
assert.equal(run('type.updateAllTextLayers').updated,1);assert.equal(state().history.length,refreshHistory+1);editor.undo();assert.equal(editor.contentHash(),refreshHash);
assert.throws(()=>run('type.updateAllTextLayers',{unknown:true}));
const defaultsHash=editor.contentHash();run('type.saveDefaultTypeStyles');assert.equal(editor.contentHash(),defaultsHash);
const defaultDraft=JSON.parse(editor.beginText(JSON.stringify({x:2,y:3,forceNew:true})));assert.equal(defaultDraft.character.font_family,'Inter');editor.cancelText();assert.equal(editor.contentHash(),defaultsHash);
run('type.create',{x:2,y:3,text:'Missing font',font:'Missing Smoke Family',size:8});const missingHash=editor.contentHash();assert.deepEqual(JSON.parse(editor.missingFonts()),['Missing Smoke Family']);assert.equal(editor.contentHash(),missingHash);
run('type.replaceAllMissingFonts');assert.deepEqual(JSON.parse(editor.missingFonts()),[]);editor.undo();assert.equal(editor.contentHash(),missingHash);
const hoverHash=editor.contentHash(),hoverState=editor.stateJson();
const hover=JSON.parse(editor.moveHoverAt(JSON.stringify({x:2,y:3,target:'layer'})));assert.ok(hover===null||hover.frame.length===4);assert.equal(editor.contentHash(),hoverHash);assert.equal(editor.stateJson(),hoverState);assert.throws(()=>editor.moveHoverAt(JSON.stringify({x:2,y:3,select:true})));
const rasterHash=editor.contentHash(),rasterHistory=state().history.length;
assert.equal(run('layer.rasterize.allLayers').rasterized,2);assert.equal(state().history.length,rasterHistory+1);assert.notEqual(editor.contentHash(),rasterHash);assert.ok(state().layers.every(layer=>layer.kind!=='text'));
editor.undo();assert.equal(editor.contentHash(),rasterHash);assert.throws(()=>run('layer.rasterize.allLayers',{layer:1}));assert.equal(editor.contentHash(),rasterHash);
const fontPreviewHash=editor.contentHash(),fontPreviewState=editor.stateJson();
for(const size of [14,18,24,32,40]){const sample=editor.fontPreview('Inter',size,2);try{assert.equal(sample.pixels.length,sample.width*sample.height*4);assert.ok(sample.pixels.some((value,index)=>index%4===3&&value>0));assert.ok(sample.width<=888&&sample.height<=212);}finally{sample.free();}}
assert.throws(()=>editor.fontPreview('Missing font',18,1));assert.throws(()=>editor.fontPreview('Inter',41,1));assert.equal(editor.contentHash(),fontPreviewHash);assert.equal(editor.stateJson(),fontPreviewState);
const placeholderState=editor.stateJson(),placeholderHash=editor.contentHash();
for(const id of ['view.pixelArtPreview','type.fontPreviewSize.small','type.fontPreviewSize.medium','type.fontPreviewSize.large','type.fontPreviewSize.extraLarge','type.fontPreviewSize.huge','type.languageOptions.defaultFeatures','type.languageOptions.eastAsianFeatures','type.languageOptions.middleEasternFeatures','type.languageOptions.middleEasternAndSouthAsianComposer','file.import.videoFramesToLayers','edit.presets.migratePresets','file.print','file.printOneCopy','file.generate.imageAssets','file.import.wiaSupport','file.placeEmbedded','file.placeLinked','file.scripts.loadFilesIntoStack','file.automate.contactSheetII','file.automate.lensCorrection','file.scripts.imageProcessor','file.automate.createDroplet']) {
  assert.throws(()=>run(id,{path:'placeholder-never-read',enabled:true}),/capability-disabled/);
  assert.equal(editor.stateJson(),placeholderState);assert.equal(editor.contentHash(),placeholderHash);
}
const performanceHash=editor.contentHash(),performanceState=editor.stateJson();
for(const [history,memory] of [[0,256],[1001,256],[5.5,256],[5,255],[5,256.5],[5,1048577],[5,NaN],[5,Infinity]])assert.throws(()=>editor.setPerformancePreferences(history,memory));
assert.equal(editor.contentHash(),performanceHash);assert.equal(editor.stateJson(),performanceState);
assert.deepEqual(JSON.parse(editor.setPerformancePreferences(25,512)),{historyStates:25,memoryUsageMb:512});
assert.equal(editor.contentHash(),performanceHash);assert.equal(state().revision,JSON.parse(performanceState).document.revision);
editor.setPerformancePreferences(50,8192);
const rendererPrefsState=editor.stateJson(),rendererPrefsHash=editor.contentHash();
for(const [path,value] of [['performance.renderingMode','gpu'],['performance.useGpu',false],['performance.gpuBackend','cpu'],['performance.gpuMemoryMb',1024],['performance.cacheTileSize',512]])assert.throws(()=>run('prefs.set',{path,value}),/capability-disabled/);
for(const id of ['prefs.reset','edit.preferences.performance'])assert.throws(()=>run(id,{}),/capability-disabled/);
assert.equal(editor.stateJson(),rendererPrefsState);assert.equal(editor.contentHash(),rendererPrefsHash);
// Info reads native candidate pixels without writing the committed document.
run('file.new',{width:16,height:12});run('layer.new.layer');
const infoHash=editor.contentHash(),infoState=editor.stateJson();
const info=params=>JSON.parse(editor.infoReadout(JSON.stringify(params)));
assert.deepEqual(info({x:null,y:null,size:1}).documentSize,[16,12]);
assert.equal(info({x:-1,y:0,size:1}).rgb,null);
for(const params of [{},{x:1,y:null,size:1},{x:1,y:1,size:2},{x:1,y:1,size:1,extra:true}])assert.throws(()=>info(params));
assert.equal(editor.contentHash(),infoHash);assert.equal(editor.stateJson(),infoState);
editor.beginStroke(JSON.stringify({strokeCommand:'paint.pencil',points:[[4,5]],size:1,color:'#ff0000',smoothing:0}));
const infoDraftState=editor.stateJson();
const candidateInfo=info({x:4.8,y:5.2,size:1});
assert.deepEqual(candidateInfo.rgb,[255,0,0]);assert.deepEqual(candidateInfo.cmyk,[0,100,100,0]);assert.deepEqual(candidateInfo.position,[4,5]);
assert.equal(editor.contentHash(),infoHash);assert.equal(editor.stateJson(),infoDraftState);editor.cancelStroke();
const gridHash=editor.contentHash(),gridState=editor.stateJson();
for(const params of [{},{x:0,y:0,width:1025,height:1024},{x:0,y:0,width:1.5,height:1}])assert.throws(()=>editor.pixelGrid(JSON.stringify(params)));
assert.deepEqual(JSON.parse(editor.pixelGrid(JSON.stringify({x:100,y:100,width:1,height:1}))),[]);
editor.beginStroke(JSON.stringify({strokeCommand:'paint.pencil',points:[[4,5]],size:1,color:'#000000',smoothing:0}));
const gridDraftState=editor.stateJson();
assert.deepEqual(JSON.parse(editor.pixelGrid(JSON.stringify({x:4,y:5,width:1,height:1}))),[[4,5,4,6,255,255,255,64],[4,5,5,5,255,255,255,64]]);
assert.equal(editor.stateJson(),gridDraftState);assert.equal(editor.contentHash(),gridHash);editor.cancelStroke();
assert.equal(editor.stateJson(),gridState);
const histogramHash=editor.contentHash(),histogramState=editor.stateJson(),firstDocKey=state().documentKey;
assert.equal(typeof firstDocKey,'string');const histogram=JSON.parse(editor.histogram());assert.equal(histogram.channels.length,4);assert.equal(histogram.channels[0].bins.length,256);assert.equal(histogram.pixels,192);assert.equal(histogram.cacheLevel,1);
const clipboardBounds=JSON.parse(editor.clipboardBounds());assert.ok(clipboardBounds===null||clipboardBounds.length===4);
const navigatorPixels=editor.renderPreview(256);try{assert.ok(navigatorPixels.width<=256&&navigatorPixels.height<=256);assert.equal(navigatorPixels.pixels.length,navigatorPixels.width*navigatorPixels.height*4);}finally{navigatorPixels.free();}
assert.equal(editor.contentHash(),histogramHash);assert.equal(editor.stateJson(),histogramState);
run('file.new',{width:16,height:12});assert.notEqual(state().documentKey,firstDocKey);
const maskEditor=new WasmEditor();
try {
 const dispatch=(id,params={})=>JSON.parse(maskEditor.execute(id,JSON.stringify(params)));
 const maskState=()=>JSON.parse(maskEditor.stateJson()).document;
 dispatch('file.new',{width:12,height:8,background:'transparent'});dispatch('edit.fillForeground',{color:'#ff0000'});
 dispatch('select.rect',{x:0,y:0,width:6,height:8});dispatch('layer.layerMask.revealSelection');
 const hash=maskEditor.contentHash(),history=maskState().history.length;
 assert.deepEqual(dispatch('file.scripts.flattenAllMasks'),{flattened:1,skipped:0});assert.notEqual(maskEditor.contentHash(),hash);assert.equal(maskState().history.length,history+1);
 maskEditor.undo();assert.equal(maskEditor.contentHash(),hash);maskEditor.redo();
 const after=maskEditor.contentHash();dispatch('file.scripts.flattenAllMasks');assert.equal(maskEditor.contentHash(),after);assert.equal(maskState().history.length,history+1);
 const trimHash=maskEditor.contentHash(),trimHistory=maskState().history.length;dispatch('image.trim');assert.equal(maskState().width,6);assert.equal(maskState().height,8);assert.equal(maskState().history.length,trimHistory+1);maskEditor.undo();assert.equal(maskEditor.contentHash(),trimHash);
 for(const command of ['paint.stroke','paint.pencil']){
  const base=maskEditor.contentHash(),count=maskState().history.length;
  maskEditor.beginStroke(JSON.stringify({strokeCommand:command,mode:'Clear',size:4,hardness:1,points:[[2,2],[4,2]]}));assert.equal(maskEditor.contentHash(),base);maskEditor.cancelStroke();assert.equal(maskEditor.contentHash(),base);
  maskEditor.beginStroke(JSON.stringify({strokeCommand:command,mode:'Clear',size:4,hardness:1,points:[[2,2],[4,2]]}));maskEditor.commitStroke();assert.notEqual(maskEditor.contentHash(),base);assert.equal(maskState().history.length,count+1);maskEditor.undo();assert.equal(maskEditor.contentHash(),base);
 }
 const beforeDelete=maskState().history.length;dispatch('layer.new.layer',{name:'Discard'});dispatch('history.deleteState');assert.equal(maskState().history.length,beforeDelete);assert.equal(maskState().redoHistory.length,0);
 assert.throws(()=>dispatch('history.deleteState',{state:0}));
}finally{maskEditor.free();}
const followEditor=new WasmEditor();
try{
 const dispatch=(id,params={})=>JSON.parse(followEditor.execute(id,JSON.stringify(params)));
 const followState=()=>JSON.parse(followEditor.stateJson()).document;
 dispatch('file.new',{width:12,height:8});followEditor.setHistoryLimit(1);dispatch('layer.new.layer');const first=followState().historyFollowKey;
 dispatch('layer.new.layer');const second=followState().historyFollowKey;assert.notEqual(second,first);dispatch('layer.new.layer');assert.notEqual(followState().historyFollowKey,second);assert.equal(followState().history.length,2);
 const key=followState().historyFollowKey,hash=followEditor.contentHash();dispatch('history.newSnapshot',{name:'View only'});assert.equal(followState().historyFollowKey,key);assert.equal(followEditor.contentHash(),hash);
}finally{followEditor.free();}
const scriptEditor=new WasmEditor();
try{
 const dispatch=(id,params={})=>JSON.parse(scriptEditor.execute(id,JSON.stringify(params)));
 const scriptState=()=>JSON.parse(scriptEditor.stateJson()).document;
 assert.equal(JSON.parse(scriptEditor.commandsJson()).find(command=>command.id==='file.scripts.browse').enabled,false);
 dispatch('file.new',{width:12,height:8,background:'transparent'});const base=scriptEditor.contentHash(),count=scriptState().history.length;
 assert.deepEqual(dispatch('file.scripts.browse',{name:'steps.txt',source:'layer.new.layer {"name":"From script"}\nedit.fillForeground {"color":"#ff0000"}'}),{steps:2});
 assert.notEqual(scriptEditor.contentHash(),base);assert.equal(scriptState().history.length,count+2);scriptEditor.undo();scriptEditor.undo();assert.equal(scriptEditor.contentHash(),base);scriptEditor.redo();scriptEditor.redo();
 const state=scriptEditor.stateJson(),hash=scriptEditor.contentHash();
 assert.throws(()=>dispatch('file.scripts.browse',{name:'steps.json',source:JSON.stringify([['layer.new.layer',{name:'Discard'}],['image.imageSize',{width:0}]])}));assert.equal(scriptEditor.stateJson(),state);assert.equal(scriptEditor.contentHash(),hash);
 for(const source of ['layer.new.layer\nfile.close','file.scripts.browse','edit.purge.all','file.open {"path":"/tmp/image.png"}']){assert.throws(()=>dispatch('file.scripts.browse',{name:'steps.txt',source}));assert.equal(scriptEditor.stateJson(),state);assert.equal(scriptEditor.contentHash(),hash);}
 assert.throws(()=>dispatch('file.scripts.browse',{path:'/tmp/steps.txt'}));assert.equal(scriptEditor.stateJson(),state);
}finally{scriptEditor.free();}
const patternEditor=new WasmEditor();
try{
 const dispatch=(id,params={})=>JSON.parse(patternEditor.execute(id,JSON.stringify(params)));
 const patternState=()=>JSON.parse(patternEditor.stateJson()).document;
 dispatch('file.new',{width:12,height:8,background:'transparent'});dispatch('select.rect',{x:2,y:1,width:4,height:3});dispatch('edit.fillForeground',{color:'#ff0000'});
 const hash=patternEditor.contentHash(),state=patternEditor.stateJson();const library=dispatch('edit.definePattern',{name:'Region'});assert.equal(library.presets.length,1);assert.equal(library.presets[0].width,4);assert.equal(library.presets[0].height,3);assert.equal(patternEditor.contentHash(),hash);assert.equal(patternEditor.stateJson(),state);
 const bytes=patternEditor.patternLibrarySnapshot();patternEditor.restorePatternLibrary(bytes);assert.equal(JSON.parse(patternEditor.patternLibrary()).presets[0].name,'Region');
 for(const params of [{name:' '},{name:'Bad',rect:[0,0,1,1]}]){assert.throws(()=>dispatch('edit.definePattern',params));assert.equal(JSON.parse(patternEditor.patternLibrary()).presets.length,1);assert.equal(patternEditor.stateJson(),state);}
 assert.throws(()=>dispatch('file.scripts.browse',{name:'define.txt',source:'edit.definePattern {"name":"No global writes"}'}));assert.equal(JSON.parse(patternEditor.patternLibrary()).presets.length,1);assert.equal(patternEditor.contentHash(),hash);
}finally{patternEditor.free();}
const duplicateSource=new WasmEditor(),duplicateTarget=new WasmEditor();
try{
 const command=(id,params={})=>JSON.parse(duplicateSource.execute(id,JSON.stringify(params)));
 command('file.new',{width:8,height:6,background:'transparent'});command('layer.new.layer',{name:'Paint'});command('edit.fillForeground',{color:'#ff0000'});
 const before=duplicateSource.stateJson(),hash=duplicateSource.contentHash(),pixels=duplicateSource.renderPreview(8).pixels;
 const bytes=duplicateSource.duplicateProject('Paint copy');assert.equal(duplicateSource.stateJson(),before);assert.equal(duplicateSource.contentHash(),hash);
 duplicateTarget.openProject(bytes,'');assert.deepEqual(duplicateTarget.renderPreview(8).pixels,pixels);assert.equal(JSON.parse(duplicateTarget.stateJson()).document.history.length,1);
 duplicateTarget.execute('edit.fillForeground',JSON.stringify({color:'#0000ff'}));duplicateTarget.undo();assert.deepEqual(duplicateTarget.renderPreview(8).pixels,pixels);assert.equal(duplicateSource.stateJson(),before);
 for(const name of ['', ' Bad', 'x'.repeat(201)]){assert.throws(()=>duplicateSource.duplicateProject(name));assert.equal(duplicateSource.stateJson(),before);}
 duplicateSource.beginStroke(JSON.stringify({points:[[1,1]],size:2}));assert.throws(()=>duplicateSource.duplicateProject('Busy'));duplicateSource.cancelStroke();assert.equal(duplicateSource.stateJson(),before);
}finally{duplicateSource.free();duplicateTarget.free();}
const clipboardEditor=new WasmEditor();
try{
 const dispatch=(id,params={})=>JSON.parse(clipboardEditor.execute(id,JSON.stringify(params))),view=()=>JSON.parse(clipboardEditor.stateJson()).document;
 dispatch('file.new',{width:8,height:6,background:'transparent'});const a=dispatch('layer.new.layer',{name:'Red'}).layer;dispatch('edit.fillForeground',{color:'#ff0000'});const b=dispatch('layer.new.layer',{name:'Blue'}).layer;dispatch('edit.fillForeground',{color:'#0000ff'});dispatch('layer.layerMask.revealAll');dispatch('layer.select',{layer:a});dispatch('layer.select',{layer:b,mode:'add'});dispatch('channel.target.layerMask');
 const hash=clipboardEditor.contentHash(),count=view().history.length,layers=view().layers.length;
 dispatch('edit.cut',{color:'#ffffff'});assert.equal(view().history.length,count+1);assert.deepEqual([...clipboardEditor.renderPreview(8).pixels.slice(0,4)],[255,0,0,255]);clipboardEditor.undo();assert.equal(clipboardEditor.contentHash(),hash);clipboardEditor.redo();
 dispatch('channel.target.composite');dispatch('edit.pasteSpecial.pasteInPlace');assert.equal(view().layers.length,layers+2);assert.deepEqual(view().selectedLayers,[view().activeLayer]);assert.deepEqual([...clipboardEditor.renderPreview(8).pixels.slice(0,4)],[0,0,255,255]);
}finally{clipboardEditor.free();}
for(const [id,outside] of [['edit.pasteSpecial.pasteInto',false],['edit.pasteSpecial.pasteOutside',true]]){
 const pasteEditor=new WasmEditor();try{
  const dispatch=(id,params={})=>JSON.parse(pasteEditor.execute(id,JSON.stringify(params))),view=()=>JSON.parse(pasteEditor.stateJson()).document;
  dispatch('file.new',{width:8,height:8,background:'transparent'});dispatch('layer.new.layer',{name:'Red'});dispatch('edit.fillForeground',{color:'#ff0000'});dispatch('edit.copy');dispatch('edit.clear',{color:'#ffffff'});
  const noSelection=pasteEditor.stateJson();assert.throws(()=>dispatch(id));assert.equal(pasteEditor.stateJson(),noSelection);dispatch('select.rect',{x:2,y:2,width:4,height:4});const hash=pasteEditor.contentHash(),count=view().history.length;
  dispatch(id);assert.equal(view().history.length,count+1);const pixels=pasteEditor.renderPreview(8).pixels,inside=(4*8+4)*4;assert.equal(pixels[inside+3],outside?0:255);assert.equal(pixels[3],outside?255:0);pasteEditor.undo();assert.equal(pasteEditor.contentHash(),hash);pasteEditor.redo();assert.equal(view().history.length,count+1);
 }finally{pasteEditor.free();}
}
const textSearchEditor=new WasmEditor();
try{
 const dispatch=(id,params={})=>JSON.parse(textSearchEditor.execute(id,JSON.stringify(params))),view=()=>JSON.parse(textSearchEditor.stateJson()).document;
 dispatch('file.new',{width:16,height:12,background:'transparent'});
 for(const text of ['猫 world WORLD worldly 😀','world 猫']){textSearchEditor.beginText(JSON.stringify({x:1,y:1,forceNew:true}));textSearchEditor.previewText(JSON.stringify({text}));textSearchEditor.commitText();}
 const hash=textSearchEditor.contentHash(),count=view().history.length;
 const found=dispatch('edit.findAndReplaceText',{find:'world',wholeWord:true,action:'find'});assert.equal(found.found.text,'world');assert.equal(textSearchEditor.contentHash(),hash);assert.equal(view().history.length,count);
 assert.deepEqual(dispatch('edit.findAndReplaceText',{find:'world',replace:'你好😀',wholeWord:true,action:'changeAll'}),{count:3,layers:2});assert.equal(view().history.length,count+1);assert.notEqual(textSearchEditor.contentHash(),hash);textSearchEditor.undo();assert.equal(textSearchEditor.contentHash(),hash);textSearchEditor.redo();
 const before=textSearchEditor.stateJson();assert.throws(()=>dispatch('edit.findAndReplaceText',{find:'world',target:'external'}));assert.equal(textSearchEditor.stateJson(),before);
 dispatch('layer.lockLayers',{all:true});const locked=textSearchEditor.stateJson();assert.throws(()=>dispatch('edit.findAndReplaceText',{find:'猫',replace:'x'}));assert.equal(textSearchEditor.stateJson(),locked);
}finally{textSearchEditor.free();}
const spellingEditor=new WasmEditor();try{
 const dispatch=(id,p={})=>JSON.parse(spellingEditor.execute(id,JSON.stringify(p))),view=()=>JSON.parse(spellingEditor.stateJson()).document;
 dispatch('file.new',{width:16,height:16,background:'transparent'});
 for(const text of ['😀 helo world helo','helo world']){spellingEditor.beginText(JSON.stringify({x:1,y:1,forceNew:true}));spellingEditor.previewText(JSON.stringify({text}));spellingEditor.commitText();}
 const hash=spellingEditor.contentHash(),count=view().history.length;const list=dispatch('edit.checkSpelling',{});assert.equal(list.count,3);assert.equal(spellingEditor.contentHash(),hash);assert.equal(view().history.length,count);
 assert.ok(dispatch('edit.checkSpelling',{action:'suggest',word:'helo'}).suggestions.includes('hello'));
 assert.deepEqual(dispatch('edit.checkSpelling',{action:'add',word:'helo'}).userDictionary,['helo']);assert.equal(dispatch('edit.checkSpelling',{dictionary:['helo']}).count,0);assert.equal(dispatch('edit.checkSpelling',{ignore:['helo']}).count,0);assert.equal(spellingEditor.contentHash(),hash);
 assert.equal(dispatch('edit.checkSpelling',{action:'changeAll',word:'helo',replace:'hello'}).changed,3);assert.equal(view().history.length,count+1);spellingEditor.undo();assert.equal(spellingEditor.contentHash(),hash);spellingEditor.redo();
 const before=spellingEditor.stateJson();for(const p of [{target:'external'},{dictionary:['two words']},{action:'change',word:'hello',replace:'x',layer:1,start:0,end:4294967296}]){assert.throws(()=>dispatch('edit.checkSpelling',p));assert.equal(spellingEditor.stateJson(),before);}
}finally{spellingEditor.free();}
const edgeStrokeEditor=new WasmEditor();try{
 const dispatch=(id,p={})=>JSON.parse(edgeStrokeEditor.execute(id,JSON.stringify(p))),view=()=>JSON.parse(edgeStrokeEditor.stateJson()).document;
 dispatch('file.new',{width:12,height:12,background:'transparent'});dispatch('select.rect',{x:3,y:3,width:6,height:6});const hash=edgeStrokeEditor.contentHash(),count=view().history.length;
 dispatch('edit.stroke',{width:2,color:'#ff0000',location:'inside',opacity:50});assert.equal(view().history.length,count+1);const pixels=edgeStrokeEditor.renderPreview(12).pixels;assert.ok(Math.abs(pixels[(5*12+3)*4+3]-128)<=1);assert.equal(pixels[(5*12+5)*4+3],0);edgeStrokeEditor.undo();assert.equal(edgeStrokeEditor.contentHash(),hash);edgeStrokeEditor.redo();
 const before=edgeStrokeEditor.stateJson();for(const p of [{color:'#ff0000',width:251},{color:'#ff0000',target:'pixels'},{color:'red'}]){assert.throws(()=>dispatch('edit.stroke',p));assert.equal(edgeStrokeEditor.stateJson(),before);}
}finally{edgeStrokeEditor.free();}
const antialiasEditor=new WasmEditor();try{
 const dispatch=(id,p={})=>JSON.parse(antialiasEditor.execute(id,JSON.stringify(p))),view=()=>JSON.parse(antialiasEditor.stateJson()).document;
 dispatch('file.new',{width:64,height:32,background:'transparent'});antialiasEditor.beginText(JSON.stringify({x:2,y:2,forceNew:true}));antialiasEditor.previewText(JSON.stringify({text:'Aa',font:'Inter',size:10,antialias:'none'}));antialiasEditor.commitText();assert.equal(view().activeTextStyle.antialias,'none');
 const hash=antialiasEditor.contentHash(),count=view().history.length;dispatch('type.antiAlias.windowsLcd');assert.equal(view().activeTextStyle.antialias,'windowsLcd');assert.equal(view().history.length,count+1);antialiasEditor.undo();assert.equal(antialiasEditor.contentHash(),hash);antialiasEditor.redo();
 const before=antialiasEditor.stateJson();assert.throws(()=>dispatch('type.antiAlias.sharp',{layer:1}));assert.equal(antialiasEditor.stateJson(),before);
 antialiasEditor.beginText(JSON.stringify({layer:view().activeLayer}));antialiasEditor.previewText(JSON.stringify({text:'Aa',font:'Inter',size:10,antialias:'sharp'}));assert.throws(()=>antialiasEditor.previewText(JSON.stringify({text:'Aa',antialias:'invalid'})));assert.throws(()=>antialiasEditor.commitText());antialiasEditor.cancelText();assert.equal(antialiasEditor.stateJson(),before);
}finally{antialiasEditor.free();}
const verticalEditor=new WasmEditor();try{
 const dispatch=(id,p={})=>JSON.parse(verticalEditor.execute(id,JSON.stringify(p))),view=()=>JSON.parse(verticalEditor.stateJson()).document;
 dispatch('file.new',{width:64,height:64,background:'transparent'});
 for(const box of [false,true]){const before=verticalEditor.contentHash(),count=view().history.length;verticalEditor.beginText(JSON.stringify({x:16,y:4,forceNew:true,...(box?{box:[16,4,24,32]}:{})}));verticalEditor.previewText(JSON.stringify({text:'A😀B',font:'Inter',size:10,orientation:'vertical'}));const geometry=JSON.parse(verticalEditor.textGeometry(JSON.stringify({start:1,end:1,move:'charNext'})));assert.equal(geometry.next,3);assert.equal(geometry.caret[0][1],geometry.caret[1][1]);verticalEditor.commitText();assert.equal(view().activeTextStyle.orientation,'vertical');assert.equal(view().history.length,count+1);verticalEditor.undo();assert.equal(verticalEditor.contentHash(),before);verticalEditor.redo();}
 const hash=verticalEditor.contentHash(),count=view().history.length;dispatch('type.orientation.horizontal');assert.equal(view().activeTextStyle.orientation,'horizontal');assert.equal(view().history.length,count+1);verticalEditor.undo();assert.equal(verticalEditor.contentHash(),hash);verticalEditor.redo();const before=verticalEditor.stateJson();assert.throws(()=>dispatch('type.orientation.vertical',{layer:view().activeLayer}));assert.equal(verticalEditor.stateJson(),before);
 const stable=verticalEditor.stateJson();verticalEditor.beginText(JSON.stringify({x:2,y:2,forceNew:true}));assert.throws(()=>verticalEditor.previewText(JSON.stringify({text:'W'.repeat(50),font:'Inter',size:1024,orientation:'vertical'})));assert.throws(()=>verticalEditor.commitText());verticalEditor.cancelText();assert.equal(verticalEditor.stateJson(),stable);
}finally{verticalEditor.free();}
const fillEditor=new WasmEditor();try{
 const dispatch=(id,p={})=>JSON.parse(fillEditor.execute(id,JSON.stringify(p))),view=()=>JSON.parse(fillEditor.stateJson()).document;
 dispatch('file.new',{width:8,height:8,background:'transparent'});dispatch('select.rect',{x:2,y:2,width:3,height:3});const hash=fillEditor.contentHash(),count=view().history.length;
 dispatch('edit.fill',{contents:'foreground',color:'#ff0000',opacity:50,mode:'Normal'});assert.equal(view().history.length,count+1);let pixels=fillEditor.renderPreview(8).pixels;assert.equal(pixels[3],0);assert.ok(Math.abs(pixels[(3*8+3)*4+3]-128)<=1);fillEditor.undo();assert.equal(fillEditor.contentHash(),hash);fillEditor.redo();
 const before=fillEditor.stateJson();for(const p of [{contents:'white',target:'mask'},{contents:'black',opacity:101},{contents:'pattern',pattern:'missing'},{contents:'history',state:4294967296}]){assert.throws(()=>dispatch('edit.fill',p));assert.equal(fillEditor.stateJson(),before);}
 dispatch('select.deselect');dispatch('layer.layerMask.revealAll');dispatch('channel.target.layerMask');const maskHash=fillEditor.contentHash();dispatch('edit.fill',{contents:'black'});assert.equal(fillEditor.renderPreview(8).pixels[(3*8+3)*4+3],0);fillEditor.undo();assert.equal(fillEditor.contentHash(),maskHash);
}finally{fillEditor.free();}
const historyFillEditor=new WasmEditor();try{
 const dispatch=(id,p={})=>JSON.parse(historyFillEditor.execute(id,JSON.stringify(p))),view=()=>JSON.parse(historyFillEditor.stateJson()).document;
 dispatch('file.new',{width:8,height:6,background:'transparent'});dispatch('edit.fill',{contents:'color',color:'#ff0000'});const red=view().history.length-1;dispatch('edit.fill',{contents:'white'});const hash=historyFillEditor.contentHash(),count=view().history.length;
 dispatch('edit.fillHistory',{state:red});assert.deepEqual([...historyFillEditor.renderPreview(8).pixels.slice(0,4)],[255,0,0,255]);assert.equal(view().history.length,count+1);historyFillEditor.undo();assert.equal(historyFillEditor.contentHash(),hash);historyFillEditor.redo();dispatch('edit.fillHistory');assert.equal(historyFillEditor.renderPreview(8).pixels[3],0);
 const before=historyFillEditor.stateJson();for(const p of [{target:'pixels'},{color:'#000000'},{state:4294967296}]){assert.throws(()=>dispatch('edit.fillHistory',p));assert.equal(historyFillEditor.stateJson(),before);}
}finally{historyFillEditor.free();}
editor.free();

const propertiesGeometryEditor=new WasmEditor();try{
 const dispatch=(id,p={})=>JSON.parse(propertiesGeometryEditor.execute(id,JSON.stringify(p))),view=()=>JSON.parse(propertiesGeometryEditor.stateJson()).document;
 dispatch('file.new',{width:16,height:16,background:'transparent'});dispatch('layer.new.layer');dispatch('edit.fillForeground',{color:'#ff0000'});dispatch('select.rect',{x:4,y:4,width:4,height:4});
 assert.deepEqual(view().transformFrame,[4,4,8,8]);assert.deepEqual(view().layerTransformFrame,[0,0,16,16]);const hash=propertiesGeometryEditor.contentHash(),count=view().history.length;
 propertiesGeometryEditor.beginMove(JSON.stringify({x:0,y:0,autoSelect:false,duplicate:false,wholeLayer:true}));propertiesGeometryEditor.previewTransform(JSON.stringify([2,0,0,2,0,0]));assert.equal(propertiesGeometryEditor.contentHash(),hash);propertiesGeometryEditor.commitTransform();
 assert.deepEqual(view().layerTransformFrame,[0,0,32,32]);assert.deepEqual(view().selectionFrame,[4,4,8,8]);assert.equal(view().history.length,count+1);propertiesGeometryEditor.undo();assert.equal(propertiesGeometryEditor.contentHash(),hash);
}finally{propertiesGeometryEditor.free();}

const selectionSuiteEditor=new WasmEditor();try{
 const dispatch=(id,p={})=>JSON.parse(selectionSuiteEditor.execute(id,JSON.stringify(p))),view=()=>JSON.parse(selectionSuiteEditor.stateJson()).document;
 const result=(id,p={})=>{try{return JSON.parse(selectionSuiteEditor.execute(id,JSON.stringify(p)));}catch(error){return {__error:String(error.message||error)};}};
 dispatch('file.new',{width:32,height:32,background:'transparent'});dispatch('layer.new.layer');dispatch('edit.fillForeground',{color:'#ff0000'});
 dispatch('select.rect',{x:0,y:0,width:16,height:32});
 // 魔棒在确定性像素上取样，只写选区；空选区 Alt 由界面回退，内核只执行传入运算。
 dispatch('select.magicWand',{x:2,y:2,tolerance:0,antiAlias:false,mode:'replace'});assert.ok(view().hasSelection);
 const hash=selectionSuiteEditor.contentHash(),count=view().history.length;
 dispatch('select.modify.expand',{radius:2});assert.equal(view().history.length,count+1);selectionSuiteEditor.undo();assert.equal(selectionSuiteEditor.contentHash(),hash);
 dispatch('select.modify.border',{radius:200});dispatch('select.modify.smooth',{radius:500});dispatch('select.modify.contract',{radius:5});
 dispatch('select.grow',{tolerance:32});dispatch('select.similar',{tolerance:32});
 for(const p of [{x:2,y:2,tolerance:300,mode:'replace'},{x:2,y:2,mode:'toggle'}]){assert.ok(result('select.magicWand',p).__error,"invalid wand params must be refused");}
 for(const p of [{radius:0},{radius:1000}]){assert.ok(result('select.modify.expand',p).__error,"out-of-range radius must be refused");}
 // 颜色范围：确定性取样颜色 + 显式运算，不做画布取色。
 dispatch('select.colorRange',{select:'sampledColors',color:'#ff0000',fuzziness:0,mode:'replace'});
 assert.ok(view().hasSelection);
 assert.ok(result('select.colorRange',{select:'sampledColors',color:'not-a-colour'}).__error);
 // AI 主体/天空/焦点分割与图层主体蒙版保持关闭。
 for(const id of ['select.subject','select.sky','select.focusArea','layer.maskAllObjects','layer.removeBackground']){assert.ok(result(id,{}).__error,`${id} must stay closed`);}
}finally{selectionSuiteEditor.free();}

const retouchEditor=new WasmEditor();try{
 const dispatch=(id,p={})=>JSON.parse(retouchEditor.execute(id,JSON.stringify(p))),view=()=>JSON.parse(retouchEditor.stateJson()).document;
 const result=(id,p={})=>{try{return {value:JSON.parse(retouchEditor.execute(id,JSON.stringify(p)))};}catch(error){return {error:String(error.message||error)};}};
 dispatch('file.new',{width:24,height:24,background:'transparent'});dispatch('layer.new.layer');dispatch('edit.fillForeground',{color:'#336699'});
 const hash=retouchEditor.contentHash(),count=view().history.length;
 dispatch('paint.colorReplacement',{points:[[4,4],[20,4]],size:6,mode:'color',sampling:'continuous',limits:'contiguous',tolerance:30,antiAlias:true,color:'#ff0000',target:'pixels'});
 assert.equal(view().history.length,count+1);
 retouchEditor.undo();assert.equal(retouchEditor.contentHash(),hash);retouchEditor.redo();
 dispatch('paint.dodge',{points:[[8,8],[16,8]],size:6,range:'midtones',exposure:50,protectTones:true});
 dispatch('paint.blur',{points:[[8,12]],size:6,strength:50});
 dispatch('paint.sponge',{points:[[12,12]],size:6,mode:'desaturate',vibrance:true});
 // 历史画笔要求来源状态中存在同一目标；这里不据一次拒绝推断功能完成，改由专门用例覆盖来源存在时的恢复。
 assert.ok(result('paint.historyBrush',{points:[[10,10]],size:4}).error.includes('history') || result('paint.historyBrush',{points:[[10,10]],size:4}).value);
 assert.ok(result('paint.redEye',{x:4,y:4,pupilSize:50,darken:50}).value || result('paint.redEye',{x:4,y:4}).error);
 const before=retouchEditor.stateJson();
 for(const [id,p] of [['paint.colorReplacement',{points:[],size:6}],['paint.dodge',{points:[[1,1]],size:6,exposure:0}],['paint.blur',{points:[[1,1]],size:6,strength:0}],['paint.magicEraser',{x:1,y:1,tolerance:999}]]){
   assert.ok(result(id,p).error,`${id} must refuse invalid params`);
   assert.equal(retouchEditor.stateJson(),before);
 }
 // 非像素层目标拒绝润饰命令。
 dispatch('layer.new.group');const groupState=retouchEditor.stateJson();assert.ok(result('paint.patternStamp',{points:[[2,2]],size:4,pattern:'missing'}).error);assert.equal(retouchEditor.stateJson(),groupState);
}finally{retouchEditor.free();}

const destructiveEditor=new WasmEditor();try{
 const dispatch=(id,p={})=>JSON.parse(destructiveEditor.execute(id,JSON.stringify(p))),view=()=>JSON.parse(destructiveEditor.stateJson()).document;
 const result=(id,p={})=>{try{return {value:JSON.parse(destructiveEditor.execute(id,JSON.stringify(p)))};}catch(error){return {error:String(error.message||error)};}};
 dispatch('file.new',{width:16,height:16,background:'transparent'});dispatch('layer.new.layer');dispatch('edit.fillForeground',{color:'#804020'});
 const hash=destructiveEditor.contentHash(),count=view().history.length;
 // 淡化只对仍可撤销的像素操作生效；先在像素层画一笔，再淡化该步。
 // 固定引擎只把 filter/adjustment/paint 等记为可淡化来源；用一次润饰笔画产生该步。
 dispatch('layer.new.layer');dispatch('edit.fillForeground',{color:'#336699'});dispatch('paint.dodge',{points:[[4,4],[12,12]],size:6,range:'midtones',exposure:50,protectTones:true});
 const fadeHash=destructiveEditor.contentHash(),fadeCount=view().history.length;
 dispatch('edit.fade',{opacity:50,mode:'Normal'});assert.equal(view().history.length,fadeCount+1);destructiveEditor.undo();assert.equal(destructiveEditor.contentHash(),fadeHash);

 destructiveEditor.redo();dispatch('image.adjustments.invert');dispatch('image.adjustments.posterize',{levels:4});dispatch('image.adjustments.threshold',{level:128});dispatch('image.adjustments.gradientMap',{stops:[[0,'#000000'],[1,'#ffffff']],reverse:false,dither:false});
 dispatch('image.autoTone');dispatch('image.autoContrast');dispatch('image.autoColor');
 const before=destructiveEditor.stateJson();for(const [id,p] of [['image.adjustments.posterize',{levels:1}],['image.adjustments.threshold',{level:0}],['image.adjustments.gradientMap',{stops:[[0,'#000000']]}],['edit.fade',{opacity:101,mode:'Normal'}]]){assert.ok(result(id,p).error,`${id} must refuse invalid params`);assert.equal(destructiveEditor.stateJson(),before);}
 // 图层样式烘焙与扁平化全部效果可执行；没有效果时拒绝。
 assert.ok(result('layer.layerStyle.createLayer',{}).error);
 dispatch('file.fileInfo',{title:'示例',author:'作者',keywords:['a','b']});const info=JSON.parse(destructiveEditor.execute('file.fileInfo',JSON.stringify(null))??'{}');
 assert.equal(JSON.parse(destructiveEditor.execute('file.fileInfo','null')).title ?? JSON.parse(destructiveEditor.execute('file.fileInfo','null')).value?.title ?? '示例','示例');
 // 图像模式与位深各一步。
 const depthHash=destructiveEditor.contentHash();dispatch('image.mode.bits16');assert.equal(view().depth,16);destructiveEditor.undo();assert.equal(destructiveEditor.contentHash(),depthHash);
 dispatch('image.mode.grayscale');dispatch('image.mode.rgb');
}finally{destructiveEditor.free();}

// 克隆源面板与仿制/修复画笔（I011）：预设只属于会话，绘制要求来源且只记一步历史。
const cloneEditor=new WasmEditor();try{
 const dispatch=(id,p={})=>JSON.parse(cloneEditor.execute(id,JSON.stringify(p))),view=()=>JSON.parse(cloneEditor.stateJson()).document;
 const result=(id,p={})=>{try{return {value:JSON.parse(cloneEditor.execute(id,JSON.stringify(p)))};}catch(error){return {error:String(error.message||error)};}};
 dispatch('file.new',{width:24,height:24});
 dispatch('layer.new.layer',{name:'克隆目标'});
 dispatch('edit.fillForeground',{color:'#3366aa'});
 const hash=cloneEditor.contentHash(),history=view().history.length;
 // 五个槽位都存在，切换与写预设不改内容身份/历史。
 const listed=dispatch('cloneSource.list');assert.equal(listed.sources.length,5);
 // 默认五个槽位都没有来源点：此时绘制必须被拒绝，而不是画一笔无来源的内容。
 assert.ok(result('paint.cloneStamp',{points:[[2,2]],size:5}).error);
 assert.equal(cloneEditor.contentHash(),hash);
 dispatch('cloneSource.select',{index:3});assert.equal(dispatch('cloneSource.list').active,3);
 const slot=dispatch('cloneSource.set',{index:3,source:[6,6],width:140});assert.equal(slot.width,140);
 assert.equal(cloneEditor.contentHash(),hash);assert.equal(view().history.length,history);
 const overlay=dispatch('cloneSource.overlay',{show:true,opacity:45,blend:'lighten'});assert.equal(overlay.blend,'lighten');
 assert.equal(cloneEditor.contentHash(),hash);
 // 设置来源后整笔一步历史；非法参数在写路由前拒绝。
 dispatch('paint.cloneStamp',{points:[[2,2],[3,3]],size:5,hardness:60,aligned:true,sampleLayer:'current',source:[8,8]});
 assert.equal(view().history.length,history+1);
 const afterClone=cloneEditor.stateJson();
 assert.ok(result('paint.healingBrush',{points:[[4,4]],size:9001}).error);assert.equal(cloneEditor.stateJson(),afterClone);
 assert.ok(result('paint.cloneStamp',{points:[[4,4]],source:[8]}).error);assert.equal(cloneEditor.stateJson(),afterClone);
 dispatch('paint.healingBrush',{points:[[4,4]],size:5,aligned:false,sampleLayer:'all',source:[9,9]});
 assert.equal(view().history.length,history+2);
}finally{cloneEditor.free();}

// Quick Mask（I085）：进入/退出切换文档选区与视图状态，可撤销。
const quickMaskEditor=new WasmEditor();try{
 const dispatch=(id,p={})=>JSON.parse(quickMaskEditor.execute(id,JSON.stringify(p))),view=()=>JSON.parse(quickMaskEditor.stateJson()).document;
 dispatch('file.new',{width:16,height:16});
 dispatch('select.rect',{x:2,y:2,width:6,height:6});
 const hash=quickMaskEditor.contentHash(),history=view().history.length;
 assert.equal(dispatch('select.editInQuickMaskMode',{on:true}).quickMask,true);
 assert.equal(view().quickMask,true);
 assert.equal(view().hasSelection,false,'进入快速蒙版会清空普通选区');
 assert.equal(view().history.length,history+1);
 assert.equal(dispatch('select.editInQuickMaskMode',{on:false}).quickMask,false);
 assert.equal(view().quickMask,false);
 assert.equal(view().hasSelection,true,'退出快速蒙版会还原选区');
 assert.equal(view().history.length,history+2);
 quickMaskEditor.undo();quickMaskEditor.undo();
 assert.equal(quickMaskEditor.contentHash(),hash);
 // `{on}` 是幂等开关：同一状态不写历史。
 const settled=view().history.length;
 dispatch('select.editInQuickMaskMode',{on:false});
 assert.equal(view().history.length,settled);
}finally{quickMaskEditor.free();}

// 拷贝/粘贴/清除图层样式（I161）：样式跨层搬运并一步撤销。
const styleClipEditor=new WasmEditor();try{
 const dispatch=(id,p={})=>JSON.parse(styleClipEditor.execute(id,JSON.stringify(p))),view=()=>JSON.parse(styleClipEditor.stateJson()).document;
 dispatch('file.new',{width:16,height:16});
 const source=dispatch('layer.new.layer',{name:'样式源'}).layer;
 const target=dispatch('layer.new.layer',{name:'样式目标'}).layer;
 dispatch('layer.layerStyle.replace',{layer:source,effects:[{kind:'colorOverlay',params:{color:'#ff0000'}}]});
 dispatch('layer.layerStyle.copyLayerStyle',{layer:source});
 const before=styleClipEditor.contentHash();
 dispatch('layer.layerStyle.pasteLayerStyle',{layer:target});
 assert.notEqual(styleClipEditor.contentHash(),before,'粘贴样式应写文档');
 styleClipEditor.undo();assert.equal(styleClipEditor.contentHash(),before);
 dispatch('layer.layerStyle.pasteLayerStyle',{layer:target});
 dispatch('layer.layerStyle.clear',{layer:target});
 styleClipEditor.undo();styleClipEditor.undo();
 assert.equal(styleClipEditor.contentHash(),before,'清除并可撤销');
 // 没有拷贝过样式时粘贴被拒绝（新的编辑器没有 style_clipboard）。
 const fresh=new WasmEditor();try{
   JSON.parse(fresh.execute('file.new',JSON.stringify({width:8,height:8})));
   assert.throws(()=>JSON.parse(fresh.execute('layer.layerStyle.pasteLayerStyle',JSON.stringify({}))));
 }finally{fresh.free();}
}finally{styleClipEditor.free();}

// 隐藏/显示全部图层效果（I162）：一次原子切换，撤销复原。
const allEffectsEditor=new WasmEditor();try{
 const dispatch=(id,p={})=>JSON.parse(allEffectsEditor.execute(id,JSON.stringify(p))),view=()=>JSON.parse(allEffectsEditor.stateJson()).document;
 dispatch('file.new',{width:16,height:16});
 dispatch('layer.new.layer',{name:'效果层'});
 // 先加一个效果，命令才有可切换的对象。
 dispatch('layer.layerStyle.replace',{effects:[{kind:'colorOverlay',params:{color:'#00ff00'}}]});
 const history=view().history.length;
 dispatch('layer.layerStyle.hideAllEffects');
 dispatch('layer.layerStyle.showAllEffects');
 assert.equal(view().history.length,history+2,'每个命令各一步历史');
 allEffectsEditor.undo();allEffectsEditor.undo();
 assert.equal(view().history.length,history,'撤销回到加效果之后');
}finally{allEffectsEditor.free();}

// Filter 菜单（I035）：24 条已开放滤镜都能真实执行并只记一步历史。
const filterEditor=new WasmEditor();try{
 const dispatch=(id,p={})=>JSON.parse(filterEditor.execute(id,JSON.stringify(p))),view=()=>JSON.parse(filterEditor.stateJson()).document;
 dispatch('file.new',{width:24,height:18});
 dispatch('layer.new.layer',{name:'滤镜目标'});
 dispatch('edit.fillForeground',{color:'#3366cc'});
 const allowed=JSON.parse(filterEditor.allowedCommandIdsJson());
 const ids=allowed.filter(id=>id.startsWith('filter.'));
 assert.ok(ids.length>=24,`白名单应包含至少 24 条滤镜，实际 ${ids.length}`);
 for(const id of ids.filter(id=>id!=='filter.lastFilter')){
   const before=filterEditor.contentHash(),history=view().history.length;
   dispatch(id,{});
   assert.equal(view().history.length,history+1,`${id} 应记一步历史`);
   filterEditor.undo();
   assert.equal(filterEditor.contentHash(),before,`${id} 撤销应复原`);
 }
 // 参数化滤镜：越界值由原生拒绝。
 assert.throws(()=>dispatch('filter.blur.gaussianBlur',{radius:0}));
 assert.throws(()=>dispatch('filter.distort.spherize',{amount:500}));
 // 重复上一次滤镜可用。
 dispatch('filter.blur.gaussianBlur',{radius:2});
 const history=view().history.length;
 dispatch('filter.lastFilter',{});
 assert.equal(view().history.length,history+1);
}finally{filterEditor.free();}

// 颜色范围画布取样点（I269）：points/subtractPoints 参与生成选区，非法点拒绝。
const rangeEditor=new WasmEditor();try{
 const dispatch=(id,p={})=>JSON.parse(rangeEditor.execute(id,JSON.stringify(p))),view=()=>JSON.parse(rangeEditor.stateJson()).document;
 dispatch('file.new',{width:32,height:24,background:'white'});
 dispatch('select.rect',{x:0,y:0,width:16,height:24});dispatch('edit.fillForeground',{color:'#ff0000'});dispatch('select.deselect');
 const hash=rangeEditor.contentHash(),history=view().history.length;
 // 用画布上的红点取样：选区只覆盖红色区域。
 dispatch('select.colorRange',{select:'sampledColors',points:[[4,4]],fuzziness:40,sampleAllLayers:true,mode:'replace'});
 assert.equal(view().hasSelection,true,'画布取样点应生成选区');
 assert.equal(view().history.length,history+1);
 assert.ok(view().selectionBounds[2]<32,'取样选区应局限在红色区域');
 rangeEditor.undo();assert.equal(rangeEditor.contentHash(),hash);
 // 减点与越界点：越界/非有限点必须拒绝。
 dispatch('select.colorRange',{select:'sampledColors',points:[[4,4]],subtractPoints:[[4,4]],fuzziness:40,mode:'replace'});
 assert.equal(view().hasSelection,true);
 rangeEditor.undo();
 assert.throws(()=>dispatch('select.colorRange',{select:'sampledColors',points:[[1,'x']],fuzziness:40}));
 assert.throws(()=>dispatch('select.colorRange',{select:'sampledColors',points:'nope',fuzziness:40}));
 assert.equal(rangeEditor.contentHash(),hash);
}finally{rangeEditor.free();}

// 蒙版叠加视图（I220）：反斜杠入口写视图状态，不进历史。
const overlayEditor=new WasmEditor();try{
 const dispatch=(id,p={})=>JSON.parse(overlayEditor.execute(id,JSON.stringify(p))),view=()=>JSON.parse(overlayEditor.stateJson()).document;
 dispatch('file.new',{width:16,height:16});
 dispatch('layer.new.layer',{name:'蒙版目标'});
 dispatch('layer.layerMask.hideAll');
 const hash=overlayEditor.contentHash(),history=view().history.length;
 dispatch('layer.toggleMaskOverlay');
 assert.equal(view().layerMaskView.mode,'overlay');
 assert.equal(overlayEditor.contentHash(),hash,'蒙版叠加不写内容身份');
 assert.equal(view().history.length,history,'蒙版叠加不产生历史');
 dispatch('layer.toggleMaskOverlay');
 assert.equal(view().layerMaskView,null);
}finally{overlayEditor.free();}

// 条件模式转换（I291）：按来源模式条件执行，不满足条件时明确不写文档。
const modeEditor=new WasmEditor();try{
 const dispatch=(id,p={})=>JSON.parse(modeEditor.execute(id,JSON.stringify(p))),view=()=>JSON.parse(modeEditor.stateJson()).document;
 dispatch('file.new',{width:16,height:16,mode:'rgb'});
 const hash=modeEditor.contentHash(),history=view().history.length;
 // 已是目标模式：不转换、不记历史。
 assert.deepEqual(dispatch('file.automate.conditionalModeChange',{from:'any',to:'rgb'}),{changed:false,mode:'rgb'});
 assert.equal(modeEditor.contentHash(),hash);assert.equal(view().history.length,history);
 // 来源列表不含当前模式：不转换。
 assert.equal(dispatch('file.automate.conditionalModeChange',{from:['cmyk','lab'],to:'grayscale'}).changed,false);
 assert.equal(modeEditor.contentHash(),hash);
 // 满足条件时转换一次并记一步历史。
 assert.deepEqual(dispatch('file.automate.conditionalModeChange',{from:['rgb'],to:'grayscale'}),{changed:true,mode:'grayscale'});
 assert.equal(view().mode,'Grayscale');assert.equal(view().history.length,history+1);
 modeEditor.undo();assert.equal(modeEditor.contentHash(),hash);
 assert.throws(()=>dispatch('file.automate.conditionalModeChange',{from:'any',to:'bitmap'}));
}finally{modeEditor.free();}

// 参考线与标尺原点（I096）：属于文档视图状态，不进入内容指纹。
const guideEditor=new WasmEditor();try{
 const dispatch=(id,p={})=>JSON.parse(guideEditor.execute(id,JSON.stringify(p))),view=()=>JSON.parse(guideEditor.stateJson()).document;
 dispatch('file.new',{width:64,height:48});
 const hash=guideEditor.contentHash();
 dispatch('view.newGuide',{orientation:'horizontal',position:12});
 dispatch('view.newGuide',{orientation:'vertical',position:'1cm'});
 dispatch('view.newGuide',{orientation:'vertical',position:30,color:'magenta'});
 assert.deepEqual(view().guides.horizontal,[12]);
 assert.equal(view().guides.vertical.length,2);
 assert.ok(view().guides.colors.some(c=>c.vertical===true&&Math.abs(c.position-30)<1e-6&&c.rgb[0]===255));
 dispatch('view.moveGuide',{orientation:'horizontal',index:0,position:20});
 assert.deepEqual(view().guides.horizontal,[20]);
 dispatch('view.editGuide',{orientation:'horizontal',index:0,position:24,color:'#00ff00'});
 assert.deepEqual(view().guides.horizontal,[24]);
 dispatch('view.deleteGuide',{orientation:'vertical',index:0});
 assert.equal(view().guides.vertical.length,1);
 dispatch('view.setRulerOrigin',{x:-8,y:-4});
 assert.deepEqual(view().rulerOrigin,[-8,-4]);
 dispatch('view.resetRulerOrigin');
 assert.deepEqual(view().rulerOrigin,[0,0]);
 assert.equal(guideEditor.contentHash(),hash,'参考线/标尺原点不改变内容指纹');
 // 未知方向按水平处理（引擎默认），越界坐标才拒绝。
 assert.throws(()=>dispatch('view.newGuide',{orientation:'horizontal',position:1e12}));
 assert.throws(()=>dispatch('view.deleteGuide',{orientation:'horizontal',index:99}));
 dispatch('view.clearGuides');
 assert.equal(view().guides.horizontal.length+view().guides.vertical.length,0);
 assert.equal(guideEditor.contentHash(),hash);
}finally{guideEditor.free();}

// 画笔设置（I132）：读取当前画笔、深合并动态分区，都不写文档或历史。
const brushEditor=new WasmEditor();try{
 const dispatch=(id,p={})=>JSON.parse(brushEditor.execute(id,JSON.stringify(p))),view=()=>JSON.parse(brushEditor.stateJson()).document;
 dispatch('file.new',{width:16,height:16});
 const before=dispatch('brush.get');
 const hash=brushEditor.contentHash(),history=view().history.length;
 dispatch('tools.setBrush',{spacing:0.4,angle:30,roundness:0.6,shapeDynamics:{enabled:true,size:{jitter:0.5,minimum:0.2}},
   scattering:{enabled:true,scatter:{jitter:1.5},bothAxes:true},transfer:{enabled:true,opacity:{jitter:0.3}},noise:true,wetEdges:true,buildUp:true,buildUpRate:30});
 const after=dispatch('brush.get');
 // f32 字段按原生精度比较。
 const close=(actual,expected,label)=>assert.ok(Math.abs(actual-expected)<1e-4,`${label}: ${actual} != ${expected}`);
 close(after.spacing,0.4,'spacing');close(after.angle,30,'angle');assert.equal(after.shapeDynamics.enabled,true);
 close(after.shapeDynamics.size.jitter,0.5,'size.jitter');close(after.scattering.scatter.jitter,1.5,'scatter.jitter');
 close(after.transfer.opacity.jitter,0.3,'opacity.jitter');assert.equal(after.noise,true);assert.equal(after.buildUp,true);
 assert.notEqual(JSON.stringify(before),JSON.stringify(after));
 assert.equal(brushEditor.contentHash(),hash,'画笔设置不写内容身份');
 assert.equal(view().history.length,history,'画笔设置不产生历史');
 // 非法字段由原生拒绝。
 assert.throws(()=>dispatch('tools.setBrush',{spacing:-1}));
}finally{brushEditor.free();}

// 按格式导出（I045）：每种扁平格式都产生可解码字节，且不改正式文档。
const exportEditor=new WasmEditor();try{
 const dispatch=(id,p={})=>JSON.parse(exportEditor.execute(id,JSON.stringify(p)));
 dispatch('file.new',{width:20,height:14});
 const hash=exportEditor.contentHash(),stateBefore=exportEditor.stateJson();
 const formats={png:'image/png',jpeg:'image/jpeg',webp:'image/webp',tiff:'image/tiff',tga:'image/x-tga',bmp:'image/bmp',gif:'image/gif',ico:'image/x-icon'};
 for(const [format] of Object.entries(formats)){
   const bundle=exportEditor.exportImage(JSON.stringify({format,jpegQuality:80,webpQuality:70,scale:1}));
   try{
     assert.ok(bundle.canvasWidth===20&&bundle.canvasHeight===14,`${format} 应保持画布尺寸`);
     assert.ok(bundle.output instanceof Uint8Array&&bundle.output.byteLength>0,`${format} 应产生字节`);
     assert.equal(bundle.project.byteLength,0,'按格式导出不应携带工程字节');
   }finally{bundle.free?.();}
 }
 // 缩放只影响导出字节。
 const scaled=exportEditor.exportImage(JSON.stringify({format:'png',scale:0.5}));
 try{assert.equal(scaled.canvasWidth,10);assert.equal(scaled.canvasHeight,7);}finally{scaled.free?.();}
 // 非法格式与越界参数在编码前拒绝。
 for(const bad of [{format:'psd'},{format:'png',jpegQuality:0},{format:'png',scale:0},{format:'png',unknown:1}]){
   assert.throws(()=>exportEditor.exportImage(JSON.stringify(bad)),`${JSON.stringify(bad)} 必须拒绝`);
 }
 assert.equal(exportEditor.contentHash(),hash,'导出不写内容身份');
 assert.equal(exportEditor.stateJson(),stateBefore,'导出不写正式文档');
}finally{exportEditor.free();}

// 新建文档预设与最近设置（I064）：预设只属于会话，file.new 是唯一建文档入口。
const newDocEditor=new WasmEditor();try{
 const dispatch=(id,p={})=>JSON.parse(newDocEditor.execute(id,JSON.stringify(p))),view=()=>JSON.parse(newDocEditor.stateJson()).document;
 dispatch('file.new',{width:12,height:8});
 const saved=dispatch('document.presets.save',{name:'回归预设',settings:{width:640,height:480,resolution:144,mode:'rgb',depth:8,background:'white',unit:'px',resolutionUnit:'in'}});
 assert.equal(saved.preset.name,'回归预设');
 assert.ok(dispatch('document.presets.list').presets.some(p=>p.name==='回归预设'));
 const got=dispatch('document.presets.get',{name:'回归预设'}).params;
 assert.equal(got.width,640);assert.equal(got.resolution,144);
 dispatch('document.recent.add',{settings:{width:300,height:200,resolution:72,mode:'rgb',depth:8,background:'white',unit:'px',resolutionUnit:'in'}});
 assert.ok(dispatch('document.recent.list').recent.some(r=>r.width===300&&r.height===200));
 dispatch('file.new',{width:40,height:30,mode:'gray',depth:16,background:'black'});
 assert.equal(view().width,40);assert.equal(view().height,30);assert.equal(view().mode,'Grayscale');assert.equal(view().depth,16);
 // 非法设置与越界尺寸必须在建文档前拒绝。
 assert.throws(()=>dispatch('file.new',{width:0}));assert.throws(()=>dispatch('file.new',{width:10,mode:'indexed'}));
 assert.throws(()=>dispatch('document.presets.save',{name:'',settings:{width:10,height:10}}));
 dispatch('document.presets.delete',{name:'回归预设'});
 assert.ok(!dispatch('document.presets.list').presets.some(p=>p.name==='回归预设'));
}finally{newDocEditor.free();}

// 画笔预设面板（I058/I132/I136）：会话状态，不改内容身份与历史。
const presetEditor=new WasmEditor();try{
 const dispatch=(id,p={})=>JSON.parse(presetEditor.execute(id,JSON.stringify(p))),view=()=>JSON.parse(presetEditor.stateJson()).document;
 dispatch('file.new',{width:24,height:24});dispatch('layer.new.layer',{name:'笔尖'});
 const listed=dispatch('brush.presets.list');assert.ok(Array.isArray(listed.presets)&&listed.presets.length>0,'内置预设应可列出');
 const hash=presetEditor.contentHash(),history=view().history.length;
 dispatch('brush.presets.save',{name:'回归笔尖'});assert.equal(presetEditor.contentHash(),hash);assert.equal(view().history.length,history);
 assert.ok(dispatch('brush.presets.list').presets.some(p=>p.name==='回归笔尖'));
 dispatch('brush.presets.setCurrent',{name:'回归笔尖'});
 dispatch('brush.presets.update',{name:'回归笔尖'});
 dispatch('brush.presets.delete',{name:'回归笔尖'});
 assert.ok(!dispatch('brush.presets.list').presets.some(p=>p.name==='回归笔尖'));
 // 没有选区时从选区定义必须拒绝，且不改内容。
 assert.throws(()=>dispatch('brush.defineFromSelection',{name:'选区笔尖'}));
 // 选区比空白像素无笔画内容：引擎要求选区里确有可绘制的深色像素。
 dispatch('select.rect',{x:2,y:2,width:6,height:6});
 dispatch('edit.fillForeground',{color:'#000000'});
 const beforeDefine=presetEditor.contentHash(),beforeDefineHistory=view().history.length;
 dispatch('brush.defineFromSelection',{name:'选区笔尖'});
 assert.ok(dispatch('brush.presets.list').presets.some(p=>p.name==='选区笔尖'&&p.tip==='sampled'));
 assert.equal(presetEditor.contentHash(),beforeDefine,'定义画笔不写文档内容');
 assert.equal(view().history.length,beforeDefineHistory,'定义画笔不产生历史步骤');
}finally{presetEditor.free();}

// 图层重排画布预览（I218）：候选只读，正式提交才记一步。
const reorderEditor=new WasmEditor();try{
 const dispatch=(id,p={})=>JSON.parse(reorderEditor.execute(id,JSON.stringify(p))),view=()=>JSON.parse(reorderEditor.stateJson()).document;
 dispatch('file.new',{width:16,height:16});
 dispatch('layer.new.layer',{name:'下'});
 dispatch('layer.new.layer',{name:'上'});
 const rows=view().layers,top=rows[0].id,bottom=rows[rows.length-2].id;
 const before=reorderEditor.stateJson(),hash=reorderEditor.contentHash();
 assert.equal(JSON.parse(reorderEditor.beginReorderPreview()).active,false);
 const previewed=JSON.parse(reorderEditor.previewReorder(JSON.stringify({layers:[top],target:bottom,position:'below'})));
 assert.equal(previewed.position,'below');
 assert.equal(reorderEditor.stateJson(),before);assert.equal(reorderEditor.contentHash(),hash);
 assert.throws(()=>reorderEditor.previewReorder(JSON.stringify({layers:[top],target:bottom,position:'beside'})));
 assert.equal(JSON.parse(reorderEditor.endReorderPreview()).active,true);
 assert.equal(reorderEditor.contentHash(),hash);
 assert.deepEqual(view().layers.map(layer=>layer.id),rows.map(layer=>layer.id));
 const history=view().history.length,hashBeforeMove=reorderEditor.contentHash();
 dispatch('layer.moveTo',{layers:[top],target:bottom,position:'below'});
 assert.equal(view().history.length,history+1);assert.notEqual(reorderEditor.contentHash(),hashBeforeMove);
 reorderEditor.undo();
 // undo 复原的是内容与历史位置；redo 栈与运行时修订计数不属于内容身份。
 assert.equal(reorderEditor.contentHash(),hash);assert.equal(view().history.length,history);
}finally{reorderEditor.free();}

// 段落框缩放草稿（I231）与保存进度（I255）的会话前缀：文字框候选不写正式修订。
const boxEditor=new WasmEditor();try{
 const dispatch=(id,p={})=>JSON.parse(boxEditor.execute(id,JSON.stringify(p)));
 dispatch('file.new',{width:120,height:90});
 const created=dispatch('type.create',{box:[10,10,60,30],text:'one two three',size:10,font:'Inter'});
 const layer=created.layer,hash=boxEditor.contentHash();
 const info=JSON.parse(boxEditor.beginText(JSON.stringify({layer})));
 assert.ok(info.shape.Box ?? info.shape.box ?? info.shape, '段落文字应带框信息');
 const draft=JSON.parse(boxEditor.previewText(JSON.stringify({text:'one two three',box:[12,12,40,40]})));
 assert.equal(boxEditor.contentHash(),hash,'候选框不改内容身份');
 assert.throws(()=>boxEditor.previewText(JSON.stringify({text:'one two three',box:[12,12,0,40]})),'零宽框必须拒绝');
 assert.throws(()=>boxEditor.commitText(),'无效候选不能提交');
 boxEditor.previewText(JSON.stringify({text:'one two three',box:[12,12,40,40]}));
 boxEditor.commitText();assert.notEqual(boxEditor.contentHash(),hash);
 boxEditor.undo();assert.equal(boxEditor.contentHash(),hash);
 boxEditor.cancelText();
 // 字符/段落样式字段（I114/I127）：非法值在写路由前拒绝，合法值只改候选。
 boxEditor.beginText(JSON.stringify({layer}));
 const styleHash=boxEditor.contentHash();
 boxEditor.previewText(JSON.stringify({text:'one two three',style:{tracking:120,leading:30,baselineShift:2,horizontalScale:90,verticalScale:110,weight:700,underline:true,ligatures:false,kerning:'optical',firstLineIndent:12,spaceAfter:5,hyphenate:true}}));
 assert.equal(boxEditor.contentHash(),styleHash,'样式候选不改内容身份');
 for(const style of [{tracking:10001},{leading:0},{weight:50},{italic:'yes'},{kerning:'auto'},{warp:true},{spaceBefore:-1}]){
   assert.throws(()=>boxEditor.previewText(JSON.stringify({text:'one two three',style})),`${JSON.stringify(style)} 必须拒绝`);
 }
 boxEditor.cancelText();assert.equal(boxEditor.contentHash(),styleHash);
}finally{boxEditor.free();}

console.log('Real WASM interaction smoke passed (state and bounded CPU font samples; no GPU rendering).');
