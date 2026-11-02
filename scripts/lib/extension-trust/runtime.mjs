import fs from "node:fs";
import path from "node:path";
import { readTrustDocument, openTrustStore } from "./store.mjs";
import { requireTrust, parseTrustJson, digest, fingerprint, exact } from "./encoding.mjs";
import { verifyTrustBundle, legacyGrant } from "./verify.mjs";
import { verifyExtensionPackage, filesDigest, CERTIFICATE_CHAIN_NAME } from "../extension-package.mjs";
import { readInstallations, resolveManagedRoot, writeFileAtomic } from "../extension-installations.mjs";

const runtimes=new Map();
/** Configuration is a deployment/build trust anchor, never a marketplace response or package field. */
export function runtimeTrust({managedRoot,env=process.env}={}) {
 const configFile=env.WOOHAA3_EXTENSION_TRUST_CONFIG;
 const key=path.resolve(managedRoot)+"\0"+(configFile??"");
 if(runtimes.has(key))return runtimes.get(key);
 const config=configFile?readTrustDocument(path.resolve(configFile)):null;
 if(config){requireTrust(config.schemaVersion===2&&Array.isArray(config.domains)&&config.domains.length>0,"invalid-trust-config")}
 const domains=(config?.domains??[]).map(domain=>{
  requireTrust(Array.isArray(domain.extensionIds)&&domain.extensionIds.length>0&&(domain.metadataUrl===undefined||typeof domain.metadataUrl==="string"),"invalid-trust-domain");
  requireTrust(/^[a-z][a-z0-9-]*$/.test(domain.root.trustDomain),"invalid-trust-domain");
  if(domain.metadataUrl!==undefined){
  const url=new URL(domain.metadataUrl);requireTrust(url.protocol==="https:"||(url.protocol==="http:"&&["127.0.0.1","[::1]","localhost"].includes(url.hostname)),"insecure-metadata-url");
  requireTrust(!url.username&&!url.password&&!url.hash,"invalid-metadata-url");
  }
  return {...domain,store:openTrustStore({directory:path.join(managedRoot,"trust",domain.root.trustDomain),pinnedRoot:domain.root,floors:domain.floors}),lastRefresh:0,lastAttempt:0,inFlight:null};
 });
 requireTrust(new Set(domains.map(d=>d.root.trustDomain)).size===domains.length,"duplicate-trust-domain");
 const ids=domains.flatMap(d=>d.extensionIds);requireTrust(new Set(ids).size===ids.length,"overlapping-trust-scopes");
 const receiptDir=path.join(managedRoot,"trust-receipts");
 function acceptMaterial(domain,incoming){
  exact(incoming,["bundle","rootUpdates"]);
  const prior=domain.store.snapshot();const oldUpdates=prior?.rootUpdates??[];const updates=incoming.rootUpdates;
  requireTrust(Array.isArray(updates)&&updates.length>=oldUpdates.length&&oldUpdates.every((value,index)=>digest(value)===digest(updates[index])),"root-history-rollback");
  return domain.store.update({bundle:incoming.bundle,rootUpdates:updates.slice(oldUpdates.length)});
 }
 async function refresh(domain,force=false){
  // A build-time seed is only initialization, never an overwrite of newer local state.
  if(!domain.store.snapshot()&&domain.bootstrap){
   try{acceptMaterial(domain,domain.bootstrap)}catch(error){if(!domain.metadataUrl)throw error}
  }
  if(!domain.metadataUrl)return;
  if(!force&&Date.now()-domain.lastRefresh<3600000)return;
  if(domain.inFlight)return domain.inFlight;
  if(!force&&Date.now()-domain.lastAttempt<60000)return;
  domain.lastAttempt=Date.now();
  domain.inFlight=(async()=>{
   const response=await fetch(domain.metadataUrl,{redirect:"error",signal:AbortSignal.timeout(10000),headers:{Accept:"application/json"}});
   requireTrust(response.ok&&response.body,"metadata-unavailable");let size=0;const chunks=[];
   for await(const chunk of response.body){size+=chunk.length;requireTrust(size<=1<<20,"metadata-too-large");chunks.push(chunk)}
   const incoming=parseTrustJson(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks)));
   acceptMaterial(domain,incoming);domain.lastRefresh=Date.now();
  })();
  try{await domain.inFlight}finally{domain.inFlight=null}
 }
 const receiptPath=hash=>{requireTrust(/^sha256:[a-f0-9]{64}$/.test(hash),"invalid-receipt-digest");return path.join(receiptDir,hash.slice(7)+".json")};
 function verifyManaged(options,context,descriptor,now=Math.floor(Date.now()/1000)) {
  if(fs.existsSync(path.join(options.treeDir,CERTIFICATE_CHAIN_NAME))) return verifyExtensionPackage({...options,allowUnsigned:false,trustContext:context,now});
  const hash=filesDigest(options.treeDir).slice(7);
  const grant=legacyGrant({context,extensionId:descriptor.extensionId,version:descriptor.version,archiveDigest:options.packageDigest?.replace(/^sha256:/,""),filesDigest:hash,now});
  const result=verifyExtensionPackage({...options,allowUnsigned:false,trustedKeys:[{publicKey:grant.publicKey}]});
  return {...result,trust:`certified:${context.root.trustDomain}:${grant.publisherId}`,evidence:{legacy:true,trustDomain:context.root.trustDomain,publisherId:grant.publisherId,keyId:fingerprint(grant.publicKey),filesDigest:hash}};
 }
 const api={
  enabled:domains.length>0,
  importMaterial(trustDomain,document){
   const domain=domains.find(d=>d.root.trustDomain===trustDomain);
   requireTrust(domain,"untrusted-domain");
   acceptMaterial(domain,document);
   return {trustDomain};
  },
  async refresh(){const results=await Promise.allSettled(domains.map(d=>refresh(d,true)));return results},
  async install(options){
   const descriptor=readTrustDocument(path.join(options.treeDir,"extension.json"));const domain=domains.find(d=>d.extensionIds.includes(descriptor.extensionId));
   const certified=fs.existsSync(path.join(options.treeDir,CERTIFICATE_CHAIN_NAME));
   if(!domain){requireTrust(!certified,"untrusted-domain");return verifyExtensionPackage(options)}
   try{await refresh(domain)}catch{/* A current authenticated cache can survive a network outage. */}
   const context=domain.store.current();
   const result=verifyManaged(options,context,descriptor);
   requireTrust(result.evidence&&result.evidence.trustDomain===domain.root.trustDomain,"certificate-required");
   const hash=filesDigest(options.treeDir);const snapshot=domain.store.snapshot();
   const receipt={packageDigest:options.packageDigest??null,schemaVersion:2,extensionId:descriptor.extensionId,version:descriptor.version,filesDigest:hash,verifiedAt:Math.floor(Date.now()/1000),rootUpdates:snapshot.rootUpdates,bundle:snapshot.bundle,evidence:result.evidence,trust:result.trust};
   fs.mkdirSync(receiptDir,{recursive:true,mode:0o700});writeFileAtomic(receiptPath(hash),JSON.stringify(receipt));
   return {...result,evidence:{...result.evidence,verifiedAt:receipt.verifiedAt}};
  },
  async installed(treeDir,record,{fresh=false}={}){
   const descriptor=readTrustDocument(path.join(treeDir,"extension.json"));const domain=domains.find(d=>d.extensionIds.includes(descriptor.extensionId));
   const certified=fs.existsSync(path.join(treeDir,CERTIFICATE_CHAIN_NAME));
   if(!domain){requireTrust(!certified&&!record?.trust?.startsWith("certified:"),"missing-trust-anchor");return null}
   if(fresh)return api.install({treeDir,packageDigest:record?.packageDigest,trustedKeys:[],allowUnsigned:false});
   const hash=filesDigest(treeDir);requireTrust(record?.filesDigest===hash,"installed-content-changed");
   if(!fs.existsSync(receiptPath(hash))&&!certified)return api.install({treeDir,packageDigest:record?.packageDigest,allowUnsigned:false});
   const receipt=readTrustDocument(receiptPath(hash),4<<20);
   requireTrust(receipt.filesDigest===hash&&receipt.extensionId===descriptor.extensionId&&receipt.version===descriptor.version,"receipt-mismatch");
   try{await refresh(domain)}catch{/* Existing verified installations use latest known revocations offline. */}
   const latest=domain.store.lastVerified();const e=receipt.evidence;
   requireTrust(!latest.targets.revokedKeys.includes(e.keyId)&&!latest.targets.revokedIssuers.includes(e.issuerId)&&!latest.targets.revokedCertificates.includes(e.certificateId)&&!latest.targets.deniedFilesDigests.includes(e.filesDigest),"revoked");
   if(!e.legacy){
   const chain=readTrustDocument(path.join(treeDir,CERTIFICATE_CHAIN_NAME));
   const issuerKey=chain.publisher.signatures[0]?.keyId;
   requireTrust(!latest.targets.revokedKeys.includes(issuerKey),"revoked");
   }
   const historical=verifyTrustBundle({pinnedRoot:domain.root,rootUpdates:receipt.rootUpdates,bundle:receipt.bundle,floors:{root:1,targets:1,snapshot:1,timestamp:1},now:receipt.verifiedAt});
   return verifyManaged({treeDir,packageDigest:receipt.packageDigest},historical,descriptor,receipt.verifiedAt);
  }
 };
 runtimes.set(key,api);return api;
}

export async function verifyManagedActivation({dir,managedRoot,repoRoot,env=process.env,record,fresh=false}){
 const root=managedRoot??resolveManagedRoot({repoRoot,env});
 const state=record?null:readInstallations(root).state;
 const descriptor=readTrustDocument(path.join(dir,"extension.json"));
 let selected=record??state.extensions[descriptor.extensionId];
 if(!record&&selected&&selected.current!==descriptor.version){const version=selected.versions?.[descriptor.version];requireTrust(version,"missing-version-evidence");selected={...selected,...version};}
 requireTrust(fresh||!selected?.quarantine,"installation-quarantined");
 return runtimeTrust({managedRoot:root,env}).installed(dir,selected,{fresh});
}
