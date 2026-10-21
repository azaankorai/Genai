import {mkdirSync,chownSync} from 'node:fs';
import path from 'node:path';
const dir=path.resolve(process.env.DATA_DIR||'/var/data');
if(['/','/app','/etc','/usr','/var'].includes(dir))throw Error('DATA_DIR must be a dedicated writable storage directory.');
mkdirSync(dir,{recursive:true,mode:0o700});mkdirSync(path.join(dir,'media'),{recursive:true,mode:0o700});
if(process.getuid?.()===0){
  chownSync(dir,1000,1000);chownSync(path.join(dir,'media'),1000,1000);
  process.setgroups([]);process.setgid(1000);process.setuid(1000);
}
await import('../server/index.mjs');
