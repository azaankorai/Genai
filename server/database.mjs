import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import path from 'node:path';
export function openDatabase(config){
  mkdirSync(config.dataDir,{recursive:true,mode:0o700});mkdirSync(path.join(config.dataDir,'media'),{recursive:true,mode:0o700});
  const db=new DatabaseSync(config.databasePath||path.join(config.dataDir,'frameforge.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,credits INTEGER NOT NULL DEFAULT 0 CHECK(credits>=0),stripe_customer TEXT UNIQUE,stripe_subscription TEXT,plan TEXT,subscription_status TEXT,created INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS magic_links(hash TEXT PRIMARY KEY,email TEXT NOT NULL,browser_hash TEXT NOT NULL,expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS rate_limits(key TEXT PRIMARY KEY,count INTEGER NOT NULL,expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS generations(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),idempotency_key TEXT NOT NULL,kind TEXT NOT NULL,prompt TEXT NOT NULL,ratio TEXT NOT NULL,style TEXT NOT NULL,model TEXT NOT NULL,cost INTEGER NOT NULL,status TEXT NOT NULL,provider_id TEXT,error TEXT,media_mime TEXT,media_size INTEGER,deleted INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL,updated INTEGER NOT NULL,UNIQUE(user_id,idempotency_key));
  CREATE TABLE IF NOT EXISTS credit_ledger(id INTEGER PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),amount INTEGER NOT NULL,reason TEXT NOT NULL,reference TEXT NOT NULL UNIQUE,created INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS stripe_events(id TEXT PRIMARY KEY,created INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS checkouts(user_id TEXT PRIMARY KEY REFERENCES users(id),plan TEXT NOT NULL,request_key TEXT NOT NULL,url TEXT,expires INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS jobs_user ON generations(user_id,created DESC);
  CREATE INDEX IF NOT EXISTS jobs_status ON generations(status,updated);
  CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires);
  CREATE INDEX IF NOT EXISTS ledger_user ON credit_ledger(user_id,created DESC);`);
  return db;
}
export function transaction(db,fn){db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result}catch(e){db.exec('ROLLBACK');throw e}}
