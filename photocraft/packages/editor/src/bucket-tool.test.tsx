/** @vitest-environment jsdom */
import {act} from "react";
import {createRoot} from "react-dom/client";
import {expect,it,vi} from "vitest";
import {BucketOptions,DEFAULT_BUCKET,bucketParams} from "./bucket-tool.js";
import type {EditorWorkspaceController} from "./editor-workspace.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
it("bucket command compilation rejects incomplete fields and passes explicit target and pattern",()=>{
 const point={x:2.5,y:3.5};expect(bucketParams(DEFAULT_BUCKET,point,"#123456","mask")).toEqual({contents:"foreground",opacity:100,tolerance:32,antiAlias:true,contiguous:true,sampleAllLayers:false,x:2.5,y:3.5,color:"#123456",target:"mask"});
 expect(bucketParams({...DEFAULT_BUCKET,contents:"pattern",pattern:"p"},point,"#123456","pixels")).toMatchObject({contents:"pattern",pattern:"p"});
 for(const patch of [{opacity:""},{opacity:"0"},{opacity:"101"},{tolerance:""},{tolerance:"-1"},{tolerance:"256"},{contents:"pattern" as const}])expect(bucketParams({...DEFAULT_BUCKET,...patch},point,"#123456","pixels")).toBeNull();
});
it("pattern selection uses native library metadata and keeps foreground as the default",()=>{
 const host=document.createElement("div"),root=createRoot(host),change=vi.fn();
 const controller={patternLibrary:()=>({ok:true,value:{presets:[{key:"user",id:"p",name:"纹理",width:2,height:2}],patternPresets:[{id:"builtin",name:"内置",width:8,height:8}]}})} as unknown as EditorWorkspaceController;
 try {
 act(()=>root.render(<BucketOptions controller={controller} value={DEFAULT_BUCKET} disabled={false} onChange={change}/>));expect(host.querySelectorAll("select")).toHaveLength(1);
 act(()=>root.render(<BucketOptions controller={controller} value={{...DEFAULT_BUCKET,contents:"pattern"}} disabled={false} onChange={change}/>));
 const pattern=host.querySelectorAll("select")[1]!;expect([...pattern.options].map(option=>option.value)).toEqual(["","p","builtin"]);
 act(()=>{pattern.value="p";pattern.dispatchEvent(new Event("change",{bubbles:true}));});expect(change).toHaveBeenCalledWith({pattern:"p"});
 }finally{act(()=>root.unmount());}
});
