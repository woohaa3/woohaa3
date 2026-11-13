# Regenerate packed official skin data. Requires numpy; no geometry simplification.
import numpy as n,base64,pathlib
root=pathlib.Path(__file__).resolve().parents[4]
p=pathlib.Path(__file__).with_name('skin-data.ts');a=n.load(root/'frontend/public/soma/skin_standard.npz')
s='// Generated from official skin_standard.npz. SHA256 90ee2cdf50f168382a7dd7e9c88b118298aba0aca4b72022080c89c4bab0ceb2.\n// License/provenance: frontend/public/soma/{LICENSE,SOURCE.md}. All eight influences retained.\nimport type {Vec3} from "../model-transform.js";\n'
s+='function unpack(s:string, width:number, integers=false):number[][]{const bytes=Uint8Array.from(atob(s),c=>c.charCodeAt(0));const v=new DataView(bytes.buffer);return Array.from({length:bytes.length/4/width},(_,i)=>Array.from({length:width},(_,j)=>integers?v.getUint32((i*width+j)*4,true):v.getFloat32((i*width+j)*4,true)));}\n'
for name,key,width,integer in [('vertices','bind_vertices',3,False),('faces','faces',3,True),('indices','lbs_indices',8,True),('weights','lbs_weights',8,False)]:
 b=base64.b64encode(a[key].astype('<u4' if integer else '<f4').tobytes()).decode();s+=f'const {name}=unpack("{b}",{width},{str(integer).lower()});\n'
s+='export const SOMA_SKIN={vertices:vertices as Vec3[],faces,indices,weights,inverseBindMatrices:'+str(n.linalg.inv(a['bind_rig_transform']).transpose(0,2,1).reshape(77,16).tolist())+'};\n';p.write_text(s)
