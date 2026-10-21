export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-MuB-Mode", "PAPER_ONLY");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, mode: "PAPER_ONLY", liveTradingEnabled: false, error: "Use GET" });
  }

  const symbols = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "ADAUSDT", "DOGEUSDT"];
  const timeframes = ["1m", "5m", "10m", "15m"];
  const results = [];
  const concurrency = 4;
  const queue = symbols.flatMap(symbol => timeframes.map(timeframe => ({ symbol, timeframe })));
  let cursor = 0;

  async function worker() {
    while (cursor < queue.length) {
      const job = queue[cursor++];
      try {
        const url = new URL("/api/crypto-signal", `https://${req.headers.host || "mub-brown.vercel.app"}`);
        url.searchParams.set("symbol", job.symbol);
        url.searchParams.set("timeframe", job.timeframe);
        const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(12000) });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.error) {
          results.push({ ...job, signal: "UNAVAILABLE", eligible: false, reason: data.detail || data.error || "Signal unavailable" });
          continue;
        }
        const side = data.signal;
        const eligible = (side === "BUY" || side === "SELL") &&
          data.mode === "PAPER_ONLY" &&
          data.liveTradingEnabled === false &&
          Number.isFinite(Number(data.candle?.close)) &&
          Number(data.candle.close) > 0 &&
          Number(data.agreementPercent) >= 100;
        results.push({
          ...job,
          signal: side || "WAIT",
          score: Number(data.score) || 0,
          agreementPercent: Number(data.agreementPercent) || 0,
          trend: data.trend || "UNKNOWN",
          price: Number(data.candle?.close) || null,
          candleTime: data.candle?.time || null,
          generatedAt: data.generatedAt || null,
          eligible,
          reason: eligible ? "Strict signal qualified; paper execution eligibility only" : (data.reasons || ["No qualifying signal"]).join("; ")
        });
      } catch (error) {
        results.push({ ...job, signal: "UNAVAILABLE", eligible: false, reason: String(error?.message || "Scan failed") });
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    results.sort((a, b) => Number(b.eligible) - Number(a.eligible) ||
      Number(b.agreementPercent || 0) - Number(a.agreementPercent || 0));
    const eligible = results.filter(x => x.eligible);
    return res.status(200).json({
      ok: true,
      mode: "PAPER_ONLY",
      liveTradingEnabled: false,
      executionEnabled: false,
      scanUniverse: { crypto: symbols, timeframes, marketsNotYetSupportedByExecutor: ["metals", "forex"] },
      scanned: results.length,
      qualifiedCount: eligible.length,
      bestCandidate: eligible[0] || null,
      results,
      note: "This endpoint scans and ranks crypto only; it does not place orders. The current paper-trades ledger supports BTCUSDT and ETHUSDT only. Metals and forex require a separate verified paper price/settlement implementation."
    });
  } catch (error) {
    console.error("MuB auto scan failed:", error?.message || error);
    return res.status(500).json({ ok: false, mode: "PAPER_ONLY", liveTradingEnabled: false, error: "Auto scan failed closed" });
  }
}
