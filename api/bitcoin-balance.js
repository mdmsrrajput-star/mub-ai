const BTC_API = "https://mempool.space/api";

function validBitcoinAddress(address) {
  if (typeof address !== "string" || address.length < 14 || address.length > 90) return false;
  return /^(?:[13][a-km-zA-HJ-NP-Z1-9]{25,34}|bc1[ac-hj-np-z02-9]{11,71})$/.test(address);
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const address = typeof req.query.address === "string" ? req.query.address.trim() : "";

  if (req.query.mode === "history") {
    if (!validBitcoinAddress(address)) return res.status(400).json({ ok: false, error: "Enter a valid-looking Bitcoin mainnet address." });
    try {
      const historyResponse = await fetch(`${BTC_API}/address/${encodeURIComponent(address)}/txs`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
      if (!historyResponse.ok) return res.status(502).json({ ok: false, error: "Bitcoin history provider unavailable." });
      const txs = await historyResponse.json();
      if (!Array.isArray(txs)) return res.status(502).json({ ok: false, error: "Invalid Bitcoin history response." });
      const incoming = txs.map(tx => {
        const satoshis = (Array.isArray(tx.vout) ? tx.vout : []).filter(out => out.scriptpubkey_address === address).reduce((sum, out) => sum + Number(out.value || 0), 0);
        return { txid: String(tx.txid || ""), amountBtc: satoshis / 100000000, timestamp: Number(tx.status?.block_time || 0) * 1000, confirmed: tx.status?.confirmed === true, explorerUrl: `https://mempool.space/tx/${encodeURIComponent(String(tx.txid || ""))}` };
      }).filter(tx => tx.txid && tx.amountBtc > 0);
      return res.status(200).json({ ok: true, address, network: "Bitcoin Mainnet", incoming, checkedAt: new Date().toISOString(), mode: "READ_ONLY", transactionsEnabled: false, note: "Recent indexed incoming transactions only; this is not a persistent accounting ledger." });
    } catch (error) {
      console.error("Bitcoin history lookup failed:", error.message);
      return res.status(502).json({ ok: false, error: "Could not reach the Bitcoin history provider." });
    }
  }

  if (!validBitcoinAddress(address)) {
    return res.status(400).json({ ok: false, error: "Enter a valid-looking Bitcoin mainnet address." });
  }

  try {
    const response = await fetch(`${BTC_API}/address/${encodeURIComponent(address)}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) {
      return res.status(response.status === 404 ? 200 : 502).json({
        ok: response.status === 404,
        address,
        network: "Bitcoin Mainnet",
        balanceBtc: 0,
        confirmedBtc: 0,
        unconfirmedBtc: 0,
        checkedAt: new Date().toISOString(),
        mode: "READ_ONLY",
        transactionsEnabled: false,
        ...(response.status === 404 ? { note: "No indexed address activity found; balance shown as zero." } : { error: "Bitcoin data provider unavailable. Try again later." })
      });
    }

    const payload = await response.json();
    const funded = payload.chain_stats || {};
    const spent = payload.chain_stats || {};
    const mempool = payload.mempool_stats || {};
    const confirmedSats = Number(funded.funded_txo_sum || 0) - Number(spent.spent_txo_sum || 0);
    const unconfirmedSats = Number(mempool.funded_txo_sum || 0) - Number(mempool.spent_txo_sum || 0);
    if (![confirmedSats, unconfirmedSats].every(Number.isFinite) || confirmedSats < 0) {
      return res.status(502).json({ ok: false, error: "Invalid Bitcoin balance response." });
    }

    return res.status(200).json({
      ok: true,
      network: "Bitcoin Mainnet",
      address,
      confirmedBtc: confirmedSats / 100000000,
      unconfirmedBtc: unconfirmedSats / 100000000,
      balanceBtc: (confirmedSats + unconfirmedSats) / 100000000,
      checkedAt: new Date().toISOString(),
      mode: "READ_ONLY",
      transactionsEnabled: false,
      note: "Public address lookup only. No wallet connection, signing, or transaction broadcast."
    });
  } catch (error) {
    console.error("Bitcoin balance lookup failed:", error.message);
    return res.status(502).json({ ok: false, error: "Could not reach the Bitcoin data provider." });
  }
}
