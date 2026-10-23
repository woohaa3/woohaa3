import {copyFileSync, mkdirSync, renameSync, rmSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {randomUUID} from 'node:crypto';

/** LaunchServices must see the executable inside its app, not a link into Cargo's target. */
export function stageDevelopmentExecutable(source, destination) {
 const directory=dirname(destination);
 mkdirSync(directory,{recursive:true});
 const temporary=join(directory,`.woohaa-desktop-${randomUUID()}.tmp`);
 try{
  copyFileSync(source,temporary);
  renameSync(temporary,destination);
 }finally{rmSync(temporary,{force:true});}
}
