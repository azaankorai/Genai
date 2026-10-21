import {DatabaseSync,backup} from 'node:sqlite';
import {mkdirSync,existsSync} from 'node:fs';
import path from 'node:path';
import {loadConfig} from '../server/config.mjs';
const config=loadConfig(),source=path.join(config.dataDir,'frameforge.sqlite');
const destination=process.argv[2];if(!destination||!path.isAbsolute(destination))throw Error('Pass an absolute destination path for the database backup.');
if(!existsSync(source)||path.resolve(destination)===source||existsSync(destination))throw Error('Source must exist and destination must be a new, separate file.');
mkdirSync(path.dirname(destination),{recursive:true,mode:0o700});
const db=new DatabaseSync(source);try{await backup(db,destination);console.log('Consistent database backup created. Copy generated media separately.')}finally{db.close()}
