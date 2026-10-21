import path from 'node:path';
export function loadConfig(env=process.env){
  const production=env.NODE_ENV==='production';
  const origin=new URL(env.APP_URL||'http://localhost:3000').origin;
  if(production&&!origin.startsWith('https://'))throw Error('APP_URL must use HTTPS in production.');
  const integer=(value,fallback)=>{const n=Number(value||fallback);if(!Number.isSafeInteger(n)||n<1||n>1000000)throw Error('Invalid numeric configuration.');return n;};
  const config={production,origin,port:integer(env.PORT,3000),dataDir:path.resolve(env.DATA_DIR||'./data'),falKey:env.FAL_KEY||'',resendKey:env.RESEND_API_KEY||'',emailFrom:env.EMAIL_FROM||'',stripeKey:env.STRIPE_SECRET_KEY||'',webhookSecret:env.STRIPE_WEBHOOK_SECRET||'',trustProxy:env.TRUST_PROXY==='1',supportEmail:env.SUPPORT_EMAIL||'',businessName:env.BUSINESS_NAME||'FrameForge',enableBilling:env.ENABLE_BILLING==='1',plans:{creator:{name:'Creator',credits:integer(env.CREATOR_MONTHLY_CREDITS,200),price:env.STRIPE_CREATOR_PRICE_ID||''},studio:{name:'Studio',credits:integer(env.STUDIO_MONTHLY_CREDITS,600),price:env.STRIPE_STUDIO_PRICE_ID||''}}};
  for(const p of Object.values(config.plans))if(p.price&&!/^price_[a-zA-Z0-9]+$/.test(p.price))throw Error('Stripe plan IDs must be recurring price IDs.');
  if(config.plans.creator.price&&config.plans.creator.price===config.plans.studio.price)throw Error('Each plan requires a distinct Stripe price.');
  return config;
}
