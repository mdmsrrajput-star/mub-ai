const USDT_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const TRON_API = "https://api.trongrid.io";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }
  const address = typeof req.query.address === "string" ? req.query.address.trim() : "";
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) {
    return res.status(400).json({ ok: false, error: "A valid TRON mainnet address is required." });
  }
  try {
    const url = new URL(`${TRON_API}/v1/accounts/${encodeURIComponent(address)}/transactions/trc20`);
    url.searchParams.set("limit", "20");
    url.searchParams.set("only_confirmed", "true");
    url.searchParams.set("order_by", "block_timestamp,desc");
    url.searchParams.set("contract_address", USDT_CONTRACT);
    const headers = { Accept: "application/json" };
    if (process.env.TRONGRID_API_KEY) headers["TRON-PRO-API-KEY"] = process.env.TRONGRID_API_KEY;
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (!response.ok) return res.status(502).json({ ok: false, error: "TRON history provider unavailable." });
    const payload = await response.json();
    const rows = Array.isArray(payload.data) ? payload.data : [];
    const incoming = rows.filter(row => String(row.to || "").toLowerCase() === address.toLowerCase())
      .map(row => ({
        txid: String(row.transaction_id || ""),
        amount: Number(row.value || 0) / (10 ** Number(row.token_info?.decimals ?? 6)),
        timestamp: Number(row.block_timestamp || 0),
        confirmed: row.confirmed === true || Number(row.block_timestamp || 0) > 0,
        asset: "USDT",
        network: "TRON / TRC20",
        explorerUrl: `https://tronscan.org/#/transaction/${encodeURIComponent(String(row.transaction_id || ""))}`
      })).filter(row => row.txid && Number.isFinite(row.amount) && row.amount >= 0);
    return res.status(200).json({ ok: true, address, network: "TRON Mainnet", asset: "USDT TRC20", incoming, checkedAt: new Date().toISOString(), mode: "READ_ONLY", transactionsEnabled: false, note: "Recent indexed incoming transfers only; this is not a persistent accounting ledger." });
  } catch (error) {
    console.error("TRON history lookup failed:", error.message);
    return res.status(502).json({ ok: false, error: "Could not reach the TRON history provider." });
  }
}
