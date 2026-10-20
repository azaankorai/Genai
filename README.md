# FrameForge

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/azaankorai/Genai)

Source repository: https://github.com/azaankorai/Genai. The deploy button opens Render setup; it does not mean a live service already exists.

An independent AI image/video studio with email-link accounts, a private generation library, a durable job queue, credit accounting, and Stripe subscriptions. The original standalone demo remains in `dist/`; the real application is in `public/` and `server/`.

**Status:** implemented and tested locally at the API/adapter level. Not publicly deployed. Provider integrations need account credentials and live-host verification. No live payments or generation have run. The current execution environment blocks HTTP listening sockets and browser startup, so browser/HTTP-server QA remains outstanding.

## Run locally

Requires Node 24. No npm packages need to be installed for the server or backend tests.

```sh
cp .env.example .env
# Configure .env locally; never commit it.
node --env-file=.env server/index.mjs
```

Open `http://localhost:3000`. Without configured email/generation/billing services, the app explicitly marks those features unavailable. It never substitutes mock output for a real request. Use `npm start` when environment variables are already supplied by the hosting service.

## Features

- Responsive creative workspace, preset directions, image/video generation, review-before-submit credit confirmation.
- Verified, single-use email sign-in links bound to the requesting browser; secure sessions and origin checks.
- Per-account private library and authenticated image/video streaming, byte ranges and downloads.
- SQLite persistence, restart recovery, atomic credit reservation, request idempotency and failure refunds.
- Queue integration with FLUX Schnell and Kling through fal.ai; generated media copied into private durable storage.
- Stripe recurring checkout, signed and deduplicated webhooks, paid-invoice credit grants, billing portal.
- Rate limiting, prompt/settings validation, safe media URL/type/size checks, security headers and CSP.
- Docker image definition, Render Blueprint, CI, configuration readiness and backup/admin scripts.

## Validation

```sh
npm run check
npm test
```

32 automated tests cover account/session handling, ownership checks, ranges, credits, duplicate requests, concurrent spending, queue failures, restart recovery, webhook signatures/replay, checkout retries, and provider request/media contracts. Tests use isolated temporary databases and controlled provider responses. They do not validate live credentials, current provider pricing/model availability, Docker builds, or public hosting.

## Deployment

Follow [the deployment guide](docs/DEPLOYMENT.md). It lists the exact Render, Resend, fal.ai, Stripe, DNS, backup, and live verification steps. The paid hosting plan and external API charges are your account's responsibility; no paid resource was created during this build.

This release supports a single server with a persistent disk. Team workspaces, an admin dashboard, model training, arbitrary video editing, user-reference uploads, automatic account erasure, tax automation, and distributed scaling are not implemented. Plan changes/proration are disabled in the recommended billing portal setup.

## Layout

- `public/` — real product interface and legal starting pages
- `server/` — HTTP server, database, account/credit/generation/billing logic, provider adapters
- `test/` — automated API and adapter tests
- `scripts/` — container privilege drop, readiness, backup and owner credit adjustment
- `render.yaml`, `Dockerfile` — deployment configuration
- `.env.example` — documented configuration keys without secrets
- `dist/` — original self-contained demo; not used by the production server
