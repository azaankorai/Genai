import {loadConfig} from '../server/config.mjs';
const c=loadConfig();
const checks=[['Public HTTPS URL',c.origin.startsWith('https://')],['Sign-in email',Boolean(c.resendKey&&c.emailFrom)],['AI generation provider',Boolean(c.falKey)],['Stripe API and signed webhook',Boolean(c.stripeKey&&c.webhookSecret)],['Recurring plan IDs',Object.values(c.plans).every(p=>p.price)],['Support contact',Boolean(c.supportEmail)],['Billing explicitly enabled',c.enableBilling]];
for(const [name,ready] of checks)console.log(`${ready?'READY':'MISSING'} ${name}`);
console.log('Checks detect configuration presence only; they do not validate provider access.');
process.exitCode=checks.every(([,ready])=>ready)?0:1;
