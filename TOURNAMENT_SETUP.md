# MuB Daily Tournament setup

## Required Vercel environment variables

Set these in **Vercel → Project → Settings → Environment Variables → Production**, then redeploy:

- `UPSTASH_REDIS_REST_URL` — existing Upstash Redis REST URL
- `UPSTASH_REDIS_REST_TOKEN` — existing Upstash Redis REST token
- `TOURNAMENT_SESSION_SECRET` — generate a cryptographically random secret with at least 32 characters; keep it private

Optional:
- `TOURNAMENT_ADMIN_KEY` — private admin secret reserved for future administration. Do not expose it in browser code.

Do not paste secrets into GitHub source, screenshots, or chat.

## Current tournament behavior

- Registration and login use email + password; password hashes use PBKDF2-SHA256 and sessions use a signed HttpOnly, Secure, SameSite=Lax cookie.
- Tournament entries and predictions are server-validated. Each new London calendar day starts with 100 non-purchasable tournament coins.
- Session is 08:00–16:30 in `Europe/London`, including daylight-saving transitions.
- Supported tournament demo predictions: BTC/USDT and ETH/USDT; 1-minute or 5-minute expiry; 1–20 coins per prediction; maximum three unsettled predictions.
- The leaderboard uses server-side Redis scores. Real-money prizes and payout APIs remain disabled pending legal/compliance, eligibility, anti-fraud and payment review.

## Before public launch

This is an initial implementation, not a compliance-approved cash-prize service. Add email verification, rate limiting/abuse controls, secure account recovery, a reviewed privacy/terms flow, admin tooling and deployment/runtime tests before public launch. Do not advertise the $25 as guaranteed or pay a winner until all checks and payment infrastructure are approved.


## Password recovery email

The tournament now restores the signed-in session from its secure HttpOnly cookie when the dashboard opens, and has a one-time password reset link flow.

For password recovery email to send, configure these additional **Production** environment variables in Vercel, then redeploy:

- `RESEND_API_KEY` — API key from your Resend account.
- `TOURNAMENT_FROM_EMAIL` — a sender address verified in Resend, for example `MuB Tournament <tournament@your-verified-domain.example>`.
- `TOURNAMENT_PUBLIC_URL` — optional canonical public base URL, such as `https://mub-brown.vercel.app`. Set this to the actual deployed domain so reset links point to the correct site.

Reset links expire after 30 minutes and are single-use. If email variables are not configured, the page shows a generic response but no email can be delivered. Verify the sender domain in Resend before testing. Never put the Resend key in browser code or commit it to GitHub.
