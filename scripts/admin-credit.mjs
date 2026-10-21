import {randomUUID} from 'node:crypto';
import {loadConfig} from '../server/config.mjs';
import {openDatabase,transaction} from '../server/database.mjs';
const [email,amount,reason]=process.argv.slice(2),credits=Number(amount);
if(!email||!Number.isSafeInteger(credits)||credits<1||credits>100000||!reason)throw Error('Usage: node scripts/admin-credit.mjs EMAIL POSITIVE_CREDITS "Reason for adjustment"');
const db=openDatabase(loadConfig());
try{const user=db.prepare('SELECT id FROM users WHERE email=?').get(email.trim().toLowerCase());if(!user)throw Error('Account not found; sign in first.');transaction(db,()=>{db.prepare('UPDATE users SET credits=credits+? WHERE id=?').run(credits,user.id);db.prepare('INSERT INTO credit_ledger(user_id,amount,reason,reference,created) VALUES(?,?,?,?,?)').run(user.id,credits,reason,'admin:'+randomUUID(),Date.now());});console.log('Credit adjustment recorded.')}finally{db.close()}
