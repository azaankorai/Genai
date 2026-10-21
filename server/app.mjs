import {randomBytes,randomUUID,createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {readFile,stat,unlink} from 'node:fs/promises';
import {createReadStream,statfsSync} from 'node:fs';
import {Readable} from 'node:stream';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openDatabase,transaction} from './database.mjs';
import {createProviders,MODELS,ServiceError} from './providers.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../public');
const hash=value=>createHash('sha256').update(value).digest('hex');
const token=()=>randomBytes(32).toString('base64url');
const now=()=>Date.now();
const DAY=86400000;
const styles={
  'Natural':'Natural light, balanced color, realistic detail.',
  'Orbital dreams':'Surreal cosmic atmosphere, cinematic composition, violet and warm peach palette.',
  'Chrome study':'Editorial product photography, sculptural forms, soft green studio, reflective materials.',
  'Quiet architecture':'Warm terracotta architecture, soft afternoon light, contemplative composition.',
  'Electric motion':'Electric blue and violet lighting, expressive luminous trails, dark atmosphere.',
};
class HttpError extends Error{constructor(status,message){super(message);this.status=status}}
const fail=(status,message)=>{throw new HttpError(status,message)};
const json=(value,status=200,headers={})=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers}});
function cookie(req,name){const item=(req.headers.get('cookie')||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='));return item?item.slice(name.length+1):''}
async function bodyText(req,max=65536){if(Number(req.headers.get('content-length'))>max)fail(413,'Request too large.');if(!req.body)return '';const reader=req.body.getReader();let size=0;const chunks=[];try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>max){await reader.cancel();fail(413,'Request too large.')}chunks.push(Buffer.from(value))}}finally{reader.releaseLock()}return Buffer.concat(chunks).toString('utf8')}
async function bodyJson(req){if(!(req.headers.get('content-type')||'').startsWith('application/json'))fail(415,'Send JSON data.');try{const value=JSON.parse(await bodyText(req));if(!value||typeof value!=='object'||Array.isArray(value))fail(400,'Invalid request.');return value}catch(e){if(e instanceof HttpError)throw e;fail(400,'Invalid JSON.')}}
function validStripeURL(value,host){try{const u=new URL(value);return u.protocol==='https:'&&u.hostname===host&&!u.username&&!u.password&&!u.port}catch{return false}}
export function createApp(config,{db=openDatabase(config),providers=createProviders(config),log=console.error}={}){
  let working=false;
  const authReady=()=>Boolean(config.resendKey&&config.emailFrom);
  const billingReady=()=>Boolean(authReady()&&config.falKey&&config.enableBilling&&config.supportEmail&&config.stripeKey&&config.webhookSecret&&Object.values(config.plans).every(p=>p.price));
  const signedCookie=(name,value,maxAge)=>`${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.production?'; Secure':''}`;
  const publicUser=u=>({id:u.id,email:u.email,credits:u.credits,plan:u.plan,subscriptionStatus:u.subscription_status,hasBillingAccount:Boolean(u.stripe_customer)});
  const queryUser=req=>{const raw=cookie(req,'ff_session');if(!/^[\w-]{43}$/.test(raw))return null;return db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.hash=? AND s.expires>?').get(hash(raw),now())||null};
  const requireUser=req=>{const u=queryUser(req);if(!u)fail(401,'Sign in to continue.');return u};
  function limit(key,max,windowMs){transaction(db,()=>{const r=db.prepare('SELECT * FROM rate_limits WHERE key=?').get(key);if(r&&r.expires>now()&&r.count>=max)fail(429,'Too many requests. Please try again later.');db.prepare('INSERT INTO rate_limits(key,count,expires) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires<=? THEN 1 ELSE count+1 END, expires=CASE WHEN expires<=? THEN excluded.expires ELSE expires END').run(key,now()+windowMs,now(),now());});}
  function credit(userId,amount,reason,reference){const found=db.prepare('SELECT 1 FROM credit_ledger WHERE reference=?').get(reference);if(found)return false;db.prepare('UPDATE users SET credits=credits+? WHERE id=?').run(amount,userId);db.prepare('INSERT INTO credit_ledger(user_id,amount,reason,reference,created) VALUES(?,?,?,?,?)').run(userId,amount,reason,reference,now());return true;}
  function refundJob(job,message,status='failed'){transaction(db,()=>{const current=db.prepare('SELECT status FROM generations WHERE id=?').get(job.id);if(!current||['succeeded','failed','attention'].includes(current.status))return;db.prepare('UPDATE generations SET status=?,error=?,updated=? WHERE id=?').run(status,message,now(),job.id);credit(job.user_id,job.cost,'Generation refund','refund:'+job.id);});}
  const jobView=j=>({id:j.id,kind:j.kind,prompt:j.prompt,ratio:j.ratio,style:j.style,model:j.model,cost:j.cost,status:j.status,error:j.error,created:j.created,mediaUrl:j.status==='succeeded'?'/api/generations/'+j.id+'/media':null});
  // A crash after submission may have charged the provider. Never automatically resubmit.
  for(const job of db.prepare("SELECT * FROM generations WHERE status='submitting'").all())refundJob(job,'Submission could not be confirmed after a restart. Credits refunded; support can review the provider request.','attention');
  async function processJob(job){
    try{
      if(job.status==='queued'){
        const claimed=db.prepare("UPDATE generations SET status='submitting',updated=? WHERE id=? AND status='queued'").run(now(),job.id);if(!claimed.changes)return;
        try{const requestId=await providers.submit(job);db.prepare("UPDATE generations SET status='running',provider_id=?,updated=? WHERE id=?").run(requestId,now(),job.id);}catch(e){refundJob(job,e.definite?'The provider could not accept this generation. Credits refunded.':'The provider did not confirm submission. Credits refunded; support can review this request.',e.definite?'failed':'attention');log('Generation submission failed',job.id,e.name);}
        return;
      }
      if(job.created<now()-DAY*2){refundJob(job,'The generation exceeded its processing window. Credits refunded.','attention');return;}
      let result;
      try{result=await providers.poll(job)}catch(e){if(e.definite)refundJob(job,'The provider could not complete this generation. Credits refunded.');else db.prepare('UPDATE generations SET updated=? WHERE id=?').run(now(),job.id);return;}
      if(result.status==='failed'){refundJob(job,'Generation failed or was rejected by the provider. Credits refunded.');return;}
      if(result.status==='succeeded'){
        try{const media=await providers.download(result.url,path.join(config.dataDir,'media',job.id),job.kind);db.prepare("UPDATE generations SET status='succeeded',media_mime=?,media_size=?,updated=? WHERE id=?").run(media.mime,media.size,now(),job.id)}catch{db.prepare('UPDATE generations SET updated=? WHERE id=?').run(now(),job.id);log('Media storage will be retried',job.id);}
      }else db.prepare('UPDATE generations SET updated=? WHERE id=?').run(now(),job.id);
    }catch(e){log('Worker operation failed',job.id,e.name)}
  }
  async function tick(){if(working||!config.falKey)return;working=true;try{const jobs=db.prepare("SELECT * FROM generations WHERE status IN ('queued','running') ORDER BY updated ASC LIMIT 4").all();await Promise.allSettled(jobs.map(processJob));db.prepare('DELETE FROM sessions WHERE expires<?').run(now());db.prepare('DELETE FROM magic_links WHERE expires<?').run(now());db.prepare('DELETE FROM rate_limits WHERE expires<?').run(now());}finally{working=false}}
  async function stripeWebhook(req){
    if(!config.webhookSecret)fail(503,'Billing webhook is not configured.');
    const raw=await bodyText(req,262144),parts=(req.headers.get('stripe-signature')||'').split(',');
    const t=parts.find(p=>p.startsWith('t='))?.slice(2),sigs=parts.filter(p=>p.startsWith('v1=')).map(p=>p.slice(3));
    if(!/^\d+$/.test(t||'')||Math.abs(now()/1000-Number(t))>300)fail(400,'Invalid webhook signature.');
    const expected=createHmac('sha256',config.webhookSecret).update(t+'.'+raw).digest();
    if(!sigs.some(s=>/^[a-f0-9]{64}$/.test(s)&&timingSafeEqual(Buffer.from(s,'hex'),expected)))fail(400,'Invalid webhook signature.');
    let event;try{event=JSON.parse(raw)}catch{fail(400,'Invalid webhook body.');}
    if(typeof event.id!=='string'||!event.data?.object)fail(400,'Invalid webhook event.');
    if(db.prepare('SELECT 1 FROM stripe_events WHERE id=?').get(event.id))return json({received:true});
    const obj=event.data.object;
    const expectedLive=config.stripeKey.startsWith('sk_live_')||config.stripeKey.startsWith('rk_live_');
    if(Boolean(event.livemode)!==expectedLive)fail(400,'Webhook mode does not match the configured Stripe account.');
    let invoiceGrant=null;
    if(event.type==='invoice.paid'&&['subscription_create','subscription_cycle'].includes(obj.billing_reason)){
      const subscriptionId=typeof obj.subscription==='string'?obj.subscription:obj.parent?.subscription_details?.subscription;
      if(!subscriptionId||!/^sub_[a-zA-Z0-9]+$/.test(subscriptionId))fail(400,'Missing subscription reference.');
      const subscription=await providers.subscription(subscriptionId);
      const customer=typeof obj.customer==='string'?obj.customer:obj.customer?.id;
      if(subscription.id!==subscriptionId||subscription.customer!==customer)fail(400,'Subscription customer mismatch.');
      const user=db.prepare('SELECT * FROM users WHERE stripe_customer=?').get(customer)||db.prepare('SELECT * FROM users WHERE id=?').get(subscription.metadata?.user_id||'');
      if(!user)fail(409,'Subscription account is not available yet.');
      if(user.stripe_customer&&user.stripe_customer!==customer)fail(409,'Subscription account mismatch.');
      const plan=Object.entries(config.plans).find(([,p])=>p.price&&obj.lines?.data?.some(line=>(line.price?.id||line.pricing?.price_details?.price)===p.price&&!line.proration));
      if(plan)invoiceGrant={user,customer,subscription,plan:plan[0],amount:plan[1].credits,invoice:obj.id};
    }
    transaction(db,()=>{
      if(db.prepare('SELECT 1 FROM stripe_events WHERE id=?').get(event.id))return;
      if(event.type==='checkout.session.completed'&&obj.mode==='subscription'){
        const user=db.prepare('SELECT * FROM users WHERE id=?').get(obj.client_reference_id||'');
        if(user&&obj.metadata?.user_id===user.id&&typeof obj.customer==='string'&&(!user.stripe_customer||user.stripe_customer===obj.customer)){
          const nextSubscription=typeof obj.subscription==='string'?obj.subscription:null;const canReplace=!user.stripe_subscription||['canceled','incomplete_expired'].includes(user.subscription_status);db.prepare('UPDATE users SET stripe_customer=?,stripe_subscription=?,subscription_status=? WHERE id=?').run(obj.customer,canReplace?nextSubscription:user.stripe_subscription,canReplace?'pending':user.subscription_status,user.id);db.prepare('DELETE FROM checkouts WHERE user_id=?').run(user.id);
        }
      }
      if(invoiceGrant){const g=invoiceGrant;credit(g.user.id,g.amount,'Monthly '+config.plans[g.plan].name+' credits','invoice:'+g.invoice);db.prepare('UPDATE users SET stripe_customer=?,stripe_subscription=?,plan=?,subscription_status=? WHERE id=?').run(g.customer,g.subscription.id,g.plan,g.subscription.status,g.user.id);db.prepare('DELETE FROM checkouts WHERE user_id=?').run(g.user.id);}
      if(['customer.subscription.updated','customer.subscription.deleted'].includes(event.type)){
        const user=db.prepare('SELECT * FROM users WHERE stripe_customer=? AND stripe_subscription=?').get(typeof obj.customer==='string'?obj.customer:'',obj.id);
        if(user){const plan=Object.entries(config.plans).find(([,p])=>p.price&&obj.items?.data?.some(i=>i.price?.id===p.price));db.prepare('UPDATE users SET subscription_status=?,plan=? WHERE id=?').run(obj.status,plan?.[0]||user.plan,user.id);}
      }
      db.prepare('INSERT INTO stripe_events(id,created) VALUES(?,?)').run(event.id,now());
    });return json({received:true});
  }
  async function route(req,context){
    const url=new URL(req.url),method=req.method;
    if(method==='POST'&&url.pathname==='/api/billing/webhook')return stripeWebhook(req);
    if(!['GET','HEAD'].includes(method)&&req.headers.get('origin')!==config.origin)fail(403,'Request origin rejected. Reload the site and try again.');
    if(url.pathname==='/healthz'&&method==='GET'){db.prepare('SELECT 1').get();return json({status:'ok'});}
    if(url.pathname==='/api/config'&&method==='GET')return json({brand:'FrameForge',businessName:config.businessName,supportEmail:config.supportEmail,authReady:authReady(),generationReady:Boolean(config.falKey),billingReady:billingReady(),models:Object.fromEntries(Object.entries(MODELS).map(([k,v])=>[k,{name:v.label,credits:v.credits}])),plans:Object.fromEntries(Object.entries(config.plans).map(([k,v])=>[k,{name:v.name,credits:v.credits}])),styles:Object.keys(styles)});
    if(url.pathname==='/api/auth/request'&&method==='POST'){
      if(!authReady())fail(503,'Sign-in email is not configured yet. Please contact the site owner.');
      const data=await bodyJson(req),email=typeof data.email==='string'?data.email.trim().toLowerCase():'';
      if(email.length>254||!/^\S+@[^\s@]+\.[^\s@]+$/.test(email))fail(400,'Enter a valid email address.');
      limit('auth-ip:'+hash(context.ip||'unknown'),8,15*60000);limit('auth-email:'+hash(email),3,15*60000);
      const secret=token(),browser=token();
      db.prepare('INSERT INTO magic_links(hash,email,browser_hash,expires) VALUES(?,?,?,?)').run(hash(secret),email,hash(browser),now()+15*60000);
      try{await providers.sendMail(email,config.origin+'/#login='+secret)}catch{db.prepare('DELETE FROM magic_links WHERE hash=?').run(hash(secret));fail(503,'Sign-in email could not be sent. Please try again later.');}
      return json({message:'Check your email. Open the link in this same browser within 15 minutes.'},200,{'Set-Cookie':signedCookie('ff_login',browser,900)});
    }
    if(url.pathname==='/api/auth/verify'&&method==='POST'){
      limit('verify:'+hash(context.ip||'unknown'),20,15*60000);const data=await bodyJson(req),browser=cookie(req,'ff_login');
      if(typeof data.token!=='string'||!/^[\w-]{43}$/.test(data.token)||!/^[\w-]{43}$/.test(browser))fail(400,'This link must be opened in the browser where you requested it. Request a new link if needed.');
      const session=token();let user;
      transaction(db,()=>{const link=db.prepare('SELECT * FROM magic_links WHERE hash=? AND browser_hash=? AND expires>?').get(hash(data.token),hash(browser),now());if(!link)fail(400,'The sign-in link expired or has already been used. Request a new link.');user=db.prepare('SELECT * FROM users WHERE email=?').get(link.email);if(!user){const id=randomUUID();db.prepare('INSERT INTO users(id,email,created) VALUES(?,?,?)').run(id,link.email,now());user=db.prepare('SELECT * FROM users WHERE id=?').get(id);}db.prepare('DELETE FROM magic_links WHERE email=?').run(link.email);const prior=cookie(req,'ff_session');if(prior)db.prepare('DELETE FROM sessions WHERE hash=?').run(hash(prior));db.prepare('INSERT INTO sessions(hash,user_id,expires) VALUES(?,?,?)').run(hash(session),user.id,now()+DAY*7);});
      const response=json({user:publicUser(user)});response.headers.append('Set-Cookie',signedCookie('ff_session',session,604800));response.headers.append('Set-Cookie',signedCookie('ff_login','',0));return response;
    }
    if(url.pathname==='/api/auth/logout'&&method==='POST'){db.prepare('DELETE FROM sessions WHERE hash=?').run(hash(cookie(req,'ff_session')));return json({ok:true},200,{'Set-Cookie':signedCookie('ff_session','',0)});}
    if(url.pathname==='/api/me'&&method==='GET'){const user=queryUser(req);return json({user:user?publicUser(user):null});}
    if(url.pathname==='/api/credits'&&method==='GET'){const u=requireUser(req);return json({balance:u.credits,entries:db.prepare('SELECT amount,reason,created FROM credit_ledger WHERE user_id=? ORDER BY id DESC LIMIT 50').all(u.id)});}
    if(url.pathname==='/api/generations'&&method==='GET'){const u=requireUser(req);return json({generations:db.prepare('SELECT * FROM generations WHERE user_id=? AND deleted=0 ORDER BY created DESC LIMIT 100').all(u.id).map(jobView)});}
    if(url.pathname==='/api/generations'&&method==='POST'){
      const u=requireUser(req);if(!config.falKey)fail(503,'Generation is not available yet. Please contact the site owner.');
      limit('create:'+u.id,12,60000);const data=await bodyJson(req);
      const kind=data.kind,model=typeof kind==='string'&&Object.hasOwn(MODELS,kind)?MODELS[kind]:null;if(!model)fail(400,'Choose image or video generation.');
      if(typeof data.prompt!=='string'||data.prompt.trim().length<3||data.prompt.trim().length>2000)fail(400,'Write a prompt between 3 and 2,000 characters.');
      if(!['16:9','1:1','9:16'].includes(data.ratio))fail(400,'Choose a supported aspect ratio.');
      if(kind==='video'&&data.ratio==='1:1')fail(400,'Video supports landscape or portrait aspect ratios.');
      if(typeof data.style!=='string'||!Object.hasOwn(styles,data.style))fail(400,'Choose a supported creative direction.');
      const key=req.headers.get('idempotency-key');if(!key||!/^[\w-]{16,80}$/.test(key))fail(400,'Missing request identifier. Reload and try again.');
      const prompt=data.prompt.trim()+'\n\nCreative direction: '+styles[data.style];let job;
      transaction(db,()=>{
        const prior=db.prepare('SELECT * FROM generations WHERE user_id=? AND idempotency_key=?').get(u.id,key);
        if(prior){if(prior.deleted)fail(410,'This generation was deleted. Start a new request to create another.');if(prior.prompt!==prompt||prior.kind!==kind||prior.ratio!==data.ratio||prior.style!==data.style)fail(409,'This request identifier was already used with different settings.');job=prior;return;}
        if(db.prepare('SELECT credits FROM users WHERE id=?').get(u.id).credits<model.credits)fail(402,'Not enough credits. Choose a plan to add credits.');
        if(db.prepare("SELECT count(*) AS n FROM generations WHERE user_id=? AND status IN ('queued','submitting','running')").get(u.id).n>=3)fail(409,'You already have three generations in progress.');
        if(db.prepare('SELECT count(*) AS n FROM generations WHERE user_id=? AND deleted=0').get(u.id).n>=100)fail(409,'Your library is full. Delete an older generation first.');
        const disk=statfsSync(config.dataDir);if(disk.bavail*disk.bsize<500*1024*1024)fail(503,'Media storage is temporarily full. Please try again later.');
        const id=randomUUID();db.prepare('INSERT INTO generations(id,user_id,idempotency_key,kind,prompt,ratio,style,model,cost,status,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,u.id,key,kind,prompt,data.ratio,data.style,model.id,model.credits,'queued',now(),now());credit(u.id,-model.credits,'Generation reservation','generation:'+id);job=db.prepare('SELECT * FROM generations WHERE id=?').get(id);
      });return json({generation:jobView(job)},202);
    }
    const item=url.pathname.match(/^\/api\/generations\/([\w-]+)(\/media)?$/);
    if(item){const u=requireUser(req),job=db.prepare('SELECT * FROM generations WHERE id=? AND user_id=? AND deleted=0').get(item[1],u.id);if(!job)fail(404,'Project not found.');
      if(method==='DELETE'&&!item[2]){if(['queued','submitting','running'].includes(job.status))fail(409,'Wait for this generation to finish before deleting it.');await unlink(path.join(config.dataDir,'media',job.id)).catch(e=>{if(e.code!=='ENOENT')throw e});db.prepare('UPDATE generations SET deleted=1 WHERE id=?').run(job.id);return json({ok:true});}
      if(method==='GET'&&item[2]){
        if(job.status!=='succeeded')fail(409,'This media is not ready yet.');const file=path.join(config.dataDir,'media',job.id);let size;try{size=(await stat(file)).size}catch{fail(404,'Media is unavailable. Please contact support.');}
        const ext={'image/jpeg':'jpg','image/png':'png','image/webp':'webp','video/mp4':'mp4'}[job.media_mime];if(!ext)fail(404,'Unsupported media.');
        const headers={'Content-Type':job.media_mime,'Cache-Control':'private, no-store','Accept-Ranges':'bytes','Content-Disposition':`${url.searchParams.has('download')?'attachment':'inline'}; filename="frameforge-${job.id}.${ext}"`};
        let start=0,end=size-1,status=200;const range=req.headers.get('range');
        if(range){const m=range.match(/^bytes=(\d*)-(\d*)$/);if(!m||(!m[1]&&!m[2]))return new Response(null,{status:416,headers:{'Content-Range':'bytes */'+size}});if(!m[1])start=Math.max(0,size-Number(m[2]));else start=Number(m[1]);if(m[1]&&m[2])end=Math.min(end,Number(m[2]));if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=size)return new Response(null,{status:416,headers:{'Content-Range':'bytes */'+size}});status=206;headers['Content-Range']=`bytes ${start}-${end}/${size}`;}
        headers['Content-Length']=String(end-start+1);return new Response(Readable.toWeb(createReadStream(file,{start,end})),{status,headers});
      }
      if(method==='GET')return json({generation:jobView(job)});
    }
    if(url.pathname==='/api/billing/checkout'&&method==='POST'){
      const u=requireUser(req);if(!billingReady())fail(503,'Subscriptions are not available yet.');limit('billing:'+u.id,10,60000);const data=await bodyJson(req);if(typeof data.plan!=='string'||!Object.hasOwn(config.plans,data.plan))fail(400,'Choose a valid plan.');
      if(u.stripe_subscription&&!['canceled','incomplete_expired'].includes(u.subscription_status))fail(409,'Manage your existing subscription from your account.');
      let checkout;transaction(db,()=>{db.prepare('DELETE FROM checkouts WHERE user_id=? AND expires<?').run(u.id,now());checkout=db.prepare('SELECT * FROM checkouts WHERE user_id=?').get(u.id);if(checkout&&checkout.plan!==data.plan)fail(409,'A checkout for another plan is open. Complete it or wait 35 minutes before choosing a different plan.');if(!checkout){checkout={user_id:u.id,plan:data.plan,request_key:randomUUID(),expires:now()+35*60000};db.prepare('INSERT INTO checkouts(user_id,plan,request_key,expires) VALUES(?,?,?,?)').run(u.id,data.plan,checkout.request_key,checkout.expires);}});
      if(checkout.url)return json({url:checkout.url});const result=await providers.checkout(u,data.plan,checkout.request_key,Math.floor(checkout.expires/1000));if(!validStripeURL(result.url,'checkout.stripe.com'))fail(502,'Checkout could not be opened.');db.prepare('UPDATE checkouts SET url=? WHERE user_id=? AND request_key=?').run(result.url,u.id,checkout.request_key);return json({url:result.url});
    }
    if(url.pathname==='/api/billing/portal'&&method==='POST'){const u=requireUser(req);if(!config.stripeKey)fail(503,'Billing is unavailable.');if(!u.stripe_customer)fail(400,'You do not have a billing account yet.');limit('billing:'+u.id,10,60000);const result=await providers.portal(u.stripe_customer);if(!validStripeURL(result.url,'billing.stripe.com'))fail(502,'The billing portal could not be opened.');return json({url:result.url});}
    if(url.pathname.startsWith('/api/'))fail(404,'Endpoint not found.');
    if(!['GET','HEAD'].includes(method))fail(405,'Method not allowed.');
    const files={'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/styles.css':['styles.css','text/css; charset=utf-8'],'/favicon.svg':['favicon.svg','image/svg+xml'],'/legal.js':['legal.js','text/javascript; charset=utf-8'],'/robots.txt':['robots.txt','text/plain; charset=utf-8'],'/privacy':['privacy.html','text/html; charset=utf-8'],'/terms':['terms.html','text/html; charset=utf-8']};
    const file=files[url.pathname];if(!file)fail(404,'Page not found.');return new Response(method==='HEAD'?null:await readFile(path.join(ROOT,file[0])),{headers:{'Content-Type':file[1],'Cache-Control':'no-cache'}});
  }
  return {db,tick,async fetch(req,context={}){
    let response;try{response=await route(req,context)}catch(e){const status=e instanceof HttpError?e.status:e instanceof ServiceError?502:500;response=json({error:status===500?'Something went wrong. Please try again.':e.message},status);if(status>=500)log('Request failed',new URL(req.url).pathname,e.name);}
    response.headers.set('X-Content-Type-Options','nosniff');response.headers.set('Referrer-Policy','no-referrer');response.headers.set('X-Frame-Options','DENY');response.headers.set('Permissions-Policy','camera=(), microphone=(), geolocation=()');response.headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'");if(config.production)response.headers.set('Strict-Transport-Security','max-age=31536000');return response;
  }};
}
