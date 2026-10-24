export type FileBatchOutcome={opened:number;errors:{name:string;message:string}[];cancelled:boolean};
/** Locale fixed for reproducible numeric filename ordering; equal names retain picker order. */
export function sortOpenFiles<T extends {name:string}>(files:readonly T[]):T[] {
 const compare=new Intl.Collator("en",{numeric:true,sensitivity:"base"}).compare;
 return files.map((file,index)=>({file,index})).sort((a,b)=>compare(a.file.name,b.file.name)||a.index-b.index).map(entry=>entry.file);
}
/** Whole batches serialize: later picker callbacks cannot interleave document tabs. */
export class OpenFileBatchQueue<T extends {name:string}> {
 private tail:Promise<unknown>=Promise.resolve();
 enqueue(files:readonly T[],open:(file:T)=>Promise<string|null>,active:()=>boolean=()=>true):Promise<FileBatchOutcome> {
  const ordered=sortOpenFiles(files);
  const job=this.tail.then(async()=>{
   const result:FileBatchOutcome={opened:0,errors:[],cancelled:false};
   for(const file of ordered){
    if(!active()){result.cancelled=true;break;}
    try {const message=await open(file);if(message)result.errors.push({name:file.name,message});else result.opened++;}
    catch(error){result.errors.push({name:file.name,message:error instanceof Error?error.message:"无法打开文件，请重试"});}
   }
   return result;
  });
  this.tail=job.catch(()=>{});return job;
 }
}
