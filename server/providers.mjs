import {createWriteStream} from 'node:fs';
import {rename, unlink} from 'node:fs/promises';
import {Readable, Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';

export class ServiceError extends Error {
  constructor(message, status=502, definite=false) {super(message);this.status=status;this.definite=definite;}
}
export const MODELS = {
  image: {id:'fal-ai/flux/schnell',queue:'fal-ai/flux',label:'FLUX Schnell',credits:2},
  video: {id:'fal-ai/kling-video/v1.6/standard/text-to-video',queue:'fal-ai/kling-video',label:'Kling 1.6 Standard',credits:20},
};
async function jsonFetch(url, init={}) {
  let response;
  try { response=await fetch(url,{...init,redirect:'error',signal:AbortSignal.timeout(25000)}); }
  catch {throw new ServiceError('The provider did not confirm the request. Please try again later.');}
  if(!response.ok) throw new ServiceError('The external service rejected the request.',502,[400,401,402,403,404,422,429].includes(response.status));
  try{return await response.json();}catch{throw new ServiceError('The external service returned an unreadable response.');}
}
export function createProviders(config) {
  const stripe=async(path,params,key)=>jsonFetch('https://api.stripe.com/v1/'+path,{method:params?'POST':'GET',headers:{Authorization:'Bearer '+config.stripeKey,'Stripe-Version':'2024-06-20',...(params?{'Content-Type':'application/x-www-form-urlencoded'}:{}),...(key?{'Idempotency-Key':key}:{})},...(params?{body:new URLSearchParams(params)}:{})});
  const falHeaders={Authorization:'Key '+config.falKey,'Content-Type':'application/json'};
  return {
    async sendMail(email,link){
      await jsonFetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+config.resendKey,'Content-Type':'application/json'},body:JSON.stringify({from:config.emailFrom,to:[email],subject:'Your FrameForge sign-in link',text:`Sign in to FrameForge using the browser where you requested this link:\n\n${link}\n\nThis link expires in 15 minutes and can only be used once. If you did not request it, ignore this email.`})});
    },
    async submit(job){
      const model=MODELS[job.kind];
      const sizes={'16:9':{width:1344,height:768},'1:1':{width:1024,height:1024},'9:16':{width:768,height:1344}};
      const input=job.kind==='image'?{prompt:job.prompt,image_size:sizes[job.ratio],num_images:1,enable_safety_checker:true,output_format:'jpeg'}:{prompt:job.prompt,aspect_ratio:job.ratio,duration:'5'};
      const r=await jsonFetch('https://queue.fal.run/'+model.id,{method:'POST',headers:falHeaders,body:JSON.stringify(input)});
      if(typeof r.request_id!=='string'||!/^[\w-]{1,150}$/.test(r.request_id))throw new ServiceError('The provider did not return a valid request ID.');
      return r.request_id;
    },
    async poll(job){
      const url='https://queue.fal.run/'+MODELS[job.kind].queue+'/requests/'+encodeURIComponent(job.provider_id);
      const status=await jsonFetch(url+'/status',{headers:falHeaders});
      if(status.status!=='COMPLETED')return {status:'running'};
      const result=await jsonFetch(url,{headers:falHeaders});
      if(result.detail||result.error) return {status:'failed'};
      const media=job.kind==='image'?result.images?.[0]?.url:result.video?.url;
      if(!media)return {status:'failed'};
      return {status:'succeeded',url:media};
    },
    async download(url,destination,kind){
      const parsed=new URL(url);
      if(parsed.protocol!=='https:'||!(parsed.hostname==='fal.media'||parsed.hostname.endsWith('.fal.media'))||parsed.username||parsed.password||parsed.port)throw new ServiceError('The media provider returned an unsupported storage address.');
      const response=await fetch(parsed,{redirect:'error',signal:AbortSignal.timeout(120000)});
      if(!response.ok||!response.body)throw new ServiceError('The generated media could not be saved.');
      const allowed=kind==='video'?['video/mp4']:['image/jpeg','image/png','image/webp'];
      const mime=(response.headers.get('content-type')||'').split(';')[0].trim();
      if(!allowed.includes(mime))throw new ServiceError('The provider returned an unsupported media format.');
      let total=0,head=Buffer.alloc(0);const limit=kind==='video'?150*1024*1024:25*1024*1024;
      const tmp=destination+'.tmp';
      try{
        await pipeline(Readable.fromWeb(response.body),new Transform({transform(chunk,_enc,done){total+=chunk.length;if(head.length<16)head=Buffer.concat([head,chunk.subarray(0,16-head.length)]);if(total>limit)return done(new ServiceError('Generated media exceeded the storage limit.'));done(null,chunk);}}),createWriteStream(tmp,{flags:'w',mode:0o600}));
        const valid=mime==='image/jpeg'?head[0]===255&&head[1]===216:mime==='image/png'?head.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):mime==='image/webp'?head.toString('ascii',0,4)==='RIFF'&&head.toString('ascii',8,12)==='WEBP':head.toString('ascii',4,8)==='ftyp';
        if(!valid)throw new ServiceError('The downloaded media did not match its format.');
        await rename(tmp,destination);return {mime,size:total};
      }catch(e){await unlink(tmp).catch(()=>{});throw e;}
    },
    checkout(user,plan,key,expiresAt){return stripe('checkout/sessions',{
      mode:'subscription',...(user.stripe_customer?{customer:user.stripe_customer}:{customer_email:user.email}),client_reference_id:user.id,'metadata[user_id]':user.id,'subscription_data[metadata][user_id]':user.id,
      'line_items[0][price]':config.plans[plan].price,'line_items[0][quantity]':'1',success_url:config.origin+'/?billing=success',cancel_url:config.origin+'/?billing=cancelled',expires_at:String(expiresAt),allow_promotion_codes:'true',
    },key);},
    portal(customer){return stripe('billing_portal/sessions',{customer,return_url:config.origin+'/'});},
    subscription(id){return stripe('subscriptions/'+encodeURIComponent(id));},
  };
}
