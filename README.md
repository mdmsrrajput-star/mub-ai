# MuB AI — Cloudflare Workers migration

This branch is the isolated Cloudflare Workers migration for the MuB paper-trading dashboard.

## Deployment safety
- Keep the existing Vercel deployment available until Cloudflare dashboard and API checks pass.
- Paper trading only: live order execution remains disabled.
- Existing Upstash Redis keys and paper-trading history must be preserved.
- Configure these Worker secrets in Cloudflare before testing data-backed APIs:
  - `UPSTASH_REDIS_REST_URL`
  - `UPSTASH_REDIS_REST_TOKEN`
  - `TWELVE_DATA_API_KEY`
- Do not commit credentials or API keys to this repository.

## Current migration boundary
The Worker serves the dashboard assets and routes the paper account, paper prediction, crypto signal, forex signal, and forex market APIs. The auto-scan route temporarily bridges to the existing Vercel endpoint because its current 64-request fan-out exceeds Cloudflare Workers Free subrequest limits. Keep Vercel available until that route is redesigned and verified.

## Local checks
- `npm install`
- `npm run check`
- `npm run dev`

Deploy only from this migration branch until the migration has been validated.
