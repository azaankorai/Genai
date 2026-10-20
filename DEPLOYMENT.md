# Deploy FrameForge

## Current status

The independent application is implemented. It has not been deployed to a public host. No hosting account, AI API key, email API key, Stripe account, or custom domain has been configured in this workspace. Integration tests use controlled provider doubles; no live generation or payment has been performed.

The supplied Dockerfile and Render Blueprint deploy one web service with a persistent disk. Do not deploy this SQLite version to an ephemeral serverless filesystem or run multiple instances against the same database. The initial architecture is for a small launch, not a high-volume marketplace.

## 1. Put the source in your repository

The application source is in https://github.com/azaankorai/Genai (a public repository selected by the owner). For a separate deployment, copy the source, including `render.yaml`, `Dockerfile`, `package.json`, `server/`, `public/`, and `scripts/`. Do not upload `.env`, `data/`, backups, or API keys. CI is provided in `.github/workflows/test.yml`.

If an assistant is continuing deployment, provide the repository URL and connect repository/hosting access through your workspace's secure credential setup. Do not paste tokens into chat. The repository can be prepared before any provider account is funded.

## 2. Deploy the web service

1. Open https://render.com/deploy?repo=https://github.com/azaankorai/Genai, or in Render choose New → Blueprint and select `azaankorai/Genai`.
2. Review `render.yaml`: it selects a paid Starter web service, one instance, Frankfurt region, and a 10 GB persistent disk at `/var/data`. Render determines the current price; review it before creating the resource. You can change the region/plan in the manifest first.
3. Set `APP_URL` to the service's exact public HTTPS origin, without a path, e.g. the `https://...onrender.com` address assigned by Render. Set it again if you later add your custom domain. Incorrect origins cause sign-in and mutation failures.
4. Add the environment values listed below in Render's environment/secret settings. Keep `ENABLE_BILLING=0` during setup. The site can render without external credentials and clearly shows unavailable services.
5. Deploy. Render builds the Docker image and starts the HTTP server on port 10000. The health-check route is `/healthz`; success means the app and database are reachable, not that provider credentials work.
6. Verify the live page, mobile layout, `/healthz`, and `/api/config`. The latter exposes readiness booleans and public plan details, never secret values.

The container starts as root only to initialize ownership on the attached disk, then drops to UID/GID 1000 before starting the application. The app has no third-party runtime npm dependencies and needs Node 24.

## 3. Configure verified sign-in email

Use Resend (or replace the adapter in `server/providers.mjs`):

- Verify your own sending domain and its DNS records in Resend.
- Set `RESEND_API_KEY` securely.
- Set `EMAIL_FROM` to a verified sender, such as `FrameForge <studio@your-domain.example>`.
- Set `BUSINESS_NAME` to your business/operator name and `SUPPORT_EMAIL` to a monitored address.

Sign-in links expire after 15 minutes, are single-use, and must open in the browser that requested them. A mail app's embedded browser may be different; open the link in the original browser. Session cookies expire after seven days.

No email has been sent during development. Request a real sign-in link after deployment to verify delivery. Do not switch to live payments while customer sign-in is unavailable.

## 4. Connect generation

Create/fund your own fal.ai account and put its server key in `FAL_KEY`.

The current model configuration in `server/providers.mjs` is:

| Workflow | Endpoint | Customer credits |
| --- | --- | --- |
| Image | `fal-ai/flux/schnell` | 2 |
| Five-second video | `fal-ai/kling-video/v1.6/standard/text-to-video` | 20 |

These integrations were tested against contract fixtures, not the live provider. Verify current endpoint availability, input schemas, model licensing, output rights, and provider pricing in your fal.ai account before launch. Model credit prices are application units, not dollar prices. Adjust them and your subscription allowances for actual margins before charging customers.

The server submits to the provider queue, polls jobs, and copies finished media to the attached private disk. Downloads accept only HTTPS `fal.media` hosts, known media types, matching file signatures, and bounded sizes. If the provider changes its CDN, review the exact new hostname before extending the allowlist; do not accept arbitrary URLs.

New accounts have zero credits. To test generation without buying a subscription, sign in, then use the hosting service's shell:

```sh
node scripts/admin-credit.mjs you@your-domain.example 30 "Owner launch test"
```

This is an explicit ledger adjustment, not a public admin endpoint. One image and one video test spend actual fal.ai balance. Confirm the provider's charges before performing them. Observe queued/running/completed states, private playback, download, deletion, and a failed request's credit refund. Also check that a second account cannot access the first account's media URL.

## 5. Configure Stripe in TEST mode first

1. Create two products with recurring **monthly** prices. Do not use annual or one-time prices with this version; credits are granted per paid recurring invoice.
2. Set test `STRIPE_SECRET_KEY`, `STRIPE_CREATOR_PRICE_ID`, and `STRIPE_STUDIO_PRICE_ID` from your account.
3. Set `CREATOR_MONTHLY_CREDITS` and `STUDIO_MONTHLY_CREDITS` to the allowances you intend to sell. Defaults are 200 and 600. The interface obtains its displayed allowances from the server.
4. Enable the Stripe customer billing portal with cancellation and payment-method management. Disable subscription/price switching for this initial release; upgrades and prorated credit adjustments are not implemented.
5. Add a webhook endpoint at `https://YOUR-APP/api/billing/webhook`. Subscribe to `checkout.session.completed`, `invoice.paid`, `customer.subscription.updated`, and `customer.subscription.deleted`. Use Stripe API version `2024-06-20` for the webhook when available; the code also accepts the newer invoice parent/price shapes covered in source.
6. Store the endpoint signing secret as `STRIPE_WEBHOOK_SECRET`.
7. Review operator details, privacy/terms pages, your refund policy, tax setup, and your actual subscription prices. The bundled legal copy is an operational starting point and needs your business-specific review. Tax calculation is not enabled by application code in this release; configure your appropriate tax treatment before live sales.
8. Set `ENABLE_BILLING=1` with TEST keys and redeploy. Test checkout, credit grants, duplicate webhook delivery, cancellation, renewal and portal access. Browser redirect alone must never add credits.
9. After those live-host TEST-mode checks, replace all Stripe keys, price IDs and webhook signing secret with their LIVE equivalents together. Webhook mode and API key mode must match. Enable live sales only after you choose the final prices and approve the service launch.

Pausing `ENABLE_BILLING` disables new checkouts; existing customers retain portal access. It does not cancel existing Stripe subscriptions or stop their renewals. Use Stripe to manage existing subscriptions.

## 6. Custom domain

Add your domain to the Render service and apply the DNS records Render gives you. Wait for its TLS certificate to become ready. Update `APP_URL` to that exact HTTPS origin, redeploy, and update the Stripe webhook address. Request a fresh login link on the new origin; sessions do not transfer between domains. Prefer one canonical domain.

## 7. Storage, backups and operations

- Keep one app instance. The database uses SQLite WAL and atomic transactions. Moving to multiple instances requires a shared database, shared object storage, and a distributed job worker/claim mechanism first.
- Generated media and the database live under `DATA_DIR`. The persistent disk is required across deploys/restarts. Monitor usage; submissions pause when less than 500 MB is free. Each account retains at most 100 visible generations; image/video downloads are capped at 25/150 MB each.
- Create an SQLite-safe backup with `node scripts/backup.mjs /ABSOLUTE/NEW/BACKUP.sqlite`. Copy `DATA_DIR/media/` separately. Store encrypted copies off the app disk and test restoration. The included helper does not upload or schedule backups; connect your storage/backup service for that.
- Submit crashes with unknown provider acceptance become `attention` jobs after restart, and customer credits are refunded. They are never automatically resubmitted. Review those records against the provider dashboard; the business may still incur a provider charge. Ordinary queued jobs resume; running jobs resume polling.
- Polling or media-storage interruptions retry without re-submitting a generation. Jobs exceeding 48 hours are marked for review and refunded.
- Logs include request paths and error types, not prompts, sign-in tokens, or secret values. Add hosting uptime alerts and monitor failed webhooks, provider balance, storage and `attention` jobs.
- Retain credit/payment records for your legal obligations and implement your support process for account deletion/export. There is no admin web dashboard or automated account-erasure flow in this initial release.
- Restore into a stopped service with the same data paths and UID 1000 ownership. Back up before upgrades and prefer additive database migrations.

## Environment reference

| Variable | Purpose |
| --- | --- |
| `APP_URL` | Exact canonical HTTPS origin; also used for CSRF checks and email/billing redirects |
| `NODE_ENV` | `production` on the host; enables secure cookies and HSTS |
| `PORT` | HTTP port, 10000 in the Render manifest |
| `DATA_DIR` | Persistent disk path, `/var/data` |
| `TRUST_PROXY` | `1` only behind a trusted proxy that appends the real client IP |
| `BUSINESS_NAME`, `SUPPORT_EMAIL` | Operator identity and customer contact |
| `RESEND_API_KEY`, `EMAIL_FROM` | Verified sign-in email service |
| `FAL_KEY` | Server-side fal.ai generation credential |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Server-side billing and signed webhook credentials |
| `STRIPE_CREATOR_PRICE_ID`, `STRIPE_STUDIO_PRICE_ID` | Distinct recurring monthly prices |
| `CREATOR_MONTHLY_CREDITS`, `STUDIO_MONTHLY_CREDITS` | Paid-invoice credit allowances |
| `ENABLE_BILLING` | Explicit switch for new subscriptions; starts at `0` |

Run `node scripts/readiness.mjs` in the configured host to check missing settings without printing secrets. Configuration presence is not verification of API access.
