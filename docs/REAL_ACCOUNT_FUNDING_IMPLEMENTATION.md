# MuB Real-Account Funding: Implementation Plan

Status: planning only. Real deposits, withdrawals, and live orders remain disabled.

## Product requirements

- Minimum requested deposit: USD 5 equivalent. The actual minimum must respect provider, currency, method, fee, and exchange-rate rules.
- India fiat methods requested: credit card, debit card, net banking, and UPI.
- Crypto methods requested: USDT and BTC.
- Crypto daily cap: no additional MuB-imposed daily cap is planned; provider limits, compliance controls, network limits, sanctions screening, and applicable law always take precedence.
- Demo/paper trading must remain fully separate from any future real-money ledger.
- Never represent a deposit as successful based on a browser redirect alone.

## Proposed integration boundaries

### 1. INR fiat checkout

Evaluate an India-capable payment aggregator such as Razorpay for cards, net banking, and UPI. Its official documentation lists these payment methods, but availability can depend on merchant category, account type, activation, underwriting, and provider approval:
- https://razorpay.com/upi/
- https://github.com/razorpay/razorpay-node

Do not integrate production checkout until the business account is approved and the provider confirms that MuB's business model and intended use are permitted. Payment-aggregator acceptance of ordinary ecommerce payments does not imply approval for brokerage, trading, crypto, or stored-value funding.

### 2. Crypto deposit provider

Crypto must be assessed separately from INR checkout. Require written confirmation that the provider supports:
- the legal entity's jurisdiction and customer locations;
- BTC and USDT, including the exact supported USDT networks;
- hosted address generation or a documented custody model;
- deposit confirmation webhooks, idempotency, refunds/recovery, reconciliation, and withdrawal controls;
- the provider's AML/KYC and Travel Rule responsibilities.

Do not assume Coinbase Commerce/Business is available to an India-based entity. Check current regional eligibility before choosing a vendor.

### 3. Server-side payment flow

1. Authenticate the user and create a server-side pending deposit intent.
2. Validate amount and currency server-side; enforce the requested USD 5-equivalent minimum using a documented exchange-rate source and disclosed fees.
3. Create checkout/session/address through the selected provider using server-only secrets.
4. Verify webhook signature on the server; fetch the transaction from the provider API when appropriate.
5. Process each provider event idempotently and store provider reference, amount, currency, fees, status, timestamps, and reconciliation metadata.
6. Credit only after verified settlement according to the provider's settlement rules. Never credit from a query parameter or client-supplied success flag.
7. Add admin reconciliation, refunds/reversals, dispute handling, audit logs, rate limits, and alerting before launch.

## Security and compliance launch gates

- Legal review for the actual business model, target jurisdictions, payment acceptance, stored balances, trading functionality, crypto custody, tax, consumer disclosures, and licensing obligations.
- For VDA-related activity in India, review current FIU-IND registration and AML/CFT/CPF guidance before accepting crypto. Official FIU-IND resources: https://fiuindia.gov.in/files/Downloads/Downloads.html
- No secrets in frontend code, Git history, or logs. Use Vercel server-side environment variables and rotate any exposed keys.
- Use sandbox/test mode first. Production credentials must not be added until provider approval and launch review.
- Keep real-account UI clearly marked unavailable until every launch gate is passed.
- Keep real order execution hard-disabled independently of payment/deposit status.

## Current implementation state

- The Real Account panel describes intended methods and minimum deposit.
- The Deposit button warns that deposits are not enabled.
- There is no active payment provider, no deposit ledger, no live checkout, and no real trading authorization.
- Next blocking decision: obtain an eligible legal business/merchant account and provider confirmation. Provider credentials alone do not replace this approval.
