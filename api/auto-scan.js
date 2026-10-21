export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-MuB-Mode", "PAPER_ONLY");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, mode: "PAPER_ONLY", liveTradingEnabled: false, error: "Use GET" });
  }

  const cryptoSymbols = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "ADAUSDT", "DOGEUSDT"];
  const forexSymbols = ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF", "NZDUSD"];
  const metalsWithSignalFeed = ["XAGUSD"];
  const cryptoTimeframes = ["1m", "5m", "10m", "15m"];
  const providerTimeframes = ["1m", "5m", "15m"];
  const results = [];
  const concurrency = 12;
  const queue = [
    ...cryptoSymbols.flatMap(symbol => cryptoTimeframes.map(timeframe => ({ symbol, timeframe, market: "CRYPTO", endpoint: "crypto-signal" }))),
    ...forexSymbols.flatMap(symbol => providerTimeframes.map(timeframe => ({ symbol, timeframe, market: "FOREX", endpoint: "forex-signal" }))),
    ...metalsWithSignalFeed.flatMap(symbol => providerTimeframes.map(timeframe => ({ symbol, timeframe, market: "METALS", endpoint: "forex-signal" })))
  ];
  let cursor = 0;

  async function worker() {
    while (cursor < queue.length) {
      const job = queue[cursor++];
      try {
        const url = new URL("/api/" + job.endpoint, `https://${req.headers.host || "mub-brown.vercel.app"}`);
        url.searchParams.set("symbol", job.symbol);
        url.searchParams.set("timeframe", job.timeframe);
        const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(8000) });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.error) {
          results.push({ ...job, signal: "UNAVAILABLE", eligible: false, reason: data.detail || data.error || "Signal unavailable" });
          continue;
        }
        const side = data.signal;
        const price = Number(data.candle?.close ?? data.candles?.at?.(-1)?.close);
        const agreement = Number(data.agreementPercent ?? data.score);
        const eligible = (side === "BUY" || side === "SELL") &&
          data.mode === "PAPER_ONLY" &&
          data.liveTradingEnabled === false &&
          Number.isFinite(price) && price > 0 &&
          (job.market !== "CRYPTO" || Number(data.agreementPercent) >= 100);
        results.push({
          ...job,
          signal: side || "WAIT",
          score: Number(data.score) || 0,
          agreementPercent: Number.isFinite(agreement) ? agreement : 0,
          trend: data.trend || "UNKNOWN",
          price: Number.isFinite(price) ? price : null,
          candleTime: data.candle?.time || data.candles?.at?.(-1)?.time || null,
          generatedAt: data.generatedAt || null,
          eligible,
          executionSupported: job.market === "CRYPTO" && ["BTCUSDT", "ETHUSDT"].includes(job.symbol),
          reason: eligible ? (job.market === "CRYPTO" && ["BTCUSDT", "ETHUSDT"].includes(job.symbol) ? "Signal qualified; paper prediction can be considered" : "Signal qualified for review; automated paper execution not yet supported for this market") : (data.reasons || ["No qualifying signal"]).join("; ")
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
      scanUniverse: { crypto: cryptoSymbols, forex: forexSymbols, metalsWithSignalFeed, cryptoTimeframes, forexAndSilverTimeframes: providerTimeframes, gold: "not scanned: current gold endpoint provides quote only, not candles" },
      scanned: results.length,
      qualifiedCount: eligible.length,
      bestCandidate: eligible[0] || null,
      results,
      note: "Scanner is read-only and never places orders. Crypto signals use strict FVG/order-block/indicator rules; forex and silver use the existing EMA/RSI signal endpoint. The existing UP/DOWN paper prediction settlement engine supports crypto only. Forex, metals, and crypto spot-position settlement must not be auto-executed until their price/expiry settlement paths are verified."
    });
  } catch (error) {
    console.error("MuB auto scan failed:", error?.message || error);
    return res.status(500).json({ ok: false, mode: "PAPER_ONLY", liveTradingEnabled: false, error: "Auto scan failed closed" });
  }
}
