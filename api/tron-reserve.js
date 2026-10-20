const USDT_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const TRON_API = "https://api.trongrid.io";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const address = String(process.env.TRON_RESERVE_ADDRESS || "").trim();
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) {
    return res.status(200).json({
      ok: true,
      configured: false,
      status: "NOT_CONFIGURED",
      message: "Set TRON_RESERVE_ADDRESS in Vercel Environment Variables to a public TRON address dedicated to the reserve.",
      payoutEnabled: false,
      transactionsEnabled: false,
      demoProfitsWithdrawable: false
    });
  }

  const headers = { Accept: "application/json" };
  if (process.env.TRONGRID_API_KEY) {
    headers["TRON-PRO-API-KEY"] = process.env.TRONGRID_API_KEY;
  }

  try {
    const response = await fetch(
      `${TRON_API}/v1/accounts/${encodeURIComponent(address)}`,
      { headers }
    );
    if (!response.ok) {
      return res.status(502).json({
        ok: false,
        configured: true,
        status: "PROVIDER_ERROR",
        error: "TRON data provider unavailable. Reserve status could not be verified.",
        payoutEnabled: false,
        transactionsEnabled: false,
        demoProfitsWithdrawable: false
      });
    }

    const payload = await response.json();
    const account = Array.isArray(payload.data) ? payload.data[0] : null;
    if (!account) {
      return res.status(200).json({
        ok: true,
        configured: true,
        status: "ADDRESS_NOT_INDEXED",
        address,
        trx: 0,
        usdt: 0,
        checkedAt: new Date().toISOString(),
        message: "The address has no indexed account data yet; treat the reserve as unverified.",
        payoutEnabled: false,
        transactionsEnabled: false,
        demoProfitsWithdrawable: false
      });
    }

    const rawTrx = Number(account.balance ?? 0);
    if (!Number.isFinite(rawTrx) || rawTrx < 0) throw new Error("Invalid TRX balance response.");

    const tokenRows = Array.isArray(account.trc20) ? account.trc20 : [];
    let rawUsdt = "0";
    for (const row of tokenRows) {
      if (row && Object.prototype.hasOwnProperty.call(row, USDT_CONTRACT)) {
        rawUsdt = String(row[USDT_CONTRACT]);
        break;
      }
    }
    if (!/^\d+$/.test(rawUsdt)) throw new Error("Invalid USDT balance response.");

    return res.status(200).json({
      ok: true,
      configured: true,
      status: "READ_ONLY_VERIFIED",
      network: "TRON Mainnet",
      address,
      trx: rawTrx / 1_000_000,
      usdt: Number(rawUsdt) / 1_000_000,
      token: "USDT",
      standard: "TRC20",
      tokenContract: USDT_CONTRACT,
      checkedAt: new Date().toISOString(),
      mode: "READ_ONLY",
      payoutEnabled: false,
      transactionsEnabled: false,
      demoProfitsWithdrawable: false,
      note: "On-chain balance only. This endpoint does not prove ownership, reserve availability, legal source of funds, or payout eligibility."
    });
  } catch (error) {
    console.error("TRON reserve lookup failed:", error.message);
    return res.status(502).json({
      ok: false,
      configured: true,
      status: "VERIFICATION_ERROR",
      error: "Reserve balance could not be verified. Payouts remain disabled.",
      payoutEnabled: false,
      transactionsEnabled: false,
      demoProfitsWithdrawable: false
    });
  }
}