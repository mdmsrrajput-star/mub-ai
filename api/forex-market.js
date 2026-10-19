export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return res.status(405).json({ error: "Method not allowed" }); }
  const symbols = { EURUSD:"EUR/USD", GBPUSD:"GBP/USD", USDJPY:"USD/JPY", AUDUSD:"AUD/USD", USDCAD:"USD/CAD", USDCHF:"USD/CHF", NZDUSD:"NZD/USD", EURJPY:"EUR/JPY", GBPJPY:"GBP/JPY", XAGUSD:"XAG/USD" };
  const symbol = String(req.query?.symbol || "EURUSD").toUpperCase();
  const intervals = { "1m": "1min", "5m": "5min", "15m": "15min", "30m": "30min", "1h": "1h", "4h": "4h", "1d": "1day" };
  const interval = String(req.query?.timeframe || "5m");
  if (!symbols[symbol]) return res.status(400).json({ error: "Unsupported market symbol" });
  if (!intervals[interval]) return res.status(400).json({ error: "Unsupported timeframe" });
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "Forex data is not configured. Add TWELVE_DATA_API_KEY in Vercel environment variables." });
  try {
    const url = "https://api.twelvedata.com/time_series?symbol=" + encodeURIComponent(symbols[symbol]) + "&interval=" + encodeURIComponent(intervals[interval]) + "&outputsize=180&timezone=UTC&apikey=" + encodeURIComponent(apiKey);
    const upstream = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!upstream.ok) return res.status(502).json({ error: "Market-data provider returned HTTP " + upstream.status });
    const data = await upstream.json();
    if (data && data.status === "error") return res.status(502).json({ error: String(data.message || "Market-data provider request failed").slice(0, 180) });
    if (!Array.isArray(data.values)) return res.status(502).json({ error: "Market-data provider returned no candle data" });
    const candles = data.values.map(v => ({ time: Math.floor(Date.parse(v.datetime + " UTC") / 1000), open: Number(v.open), high: Number(v.high), low: Number(v.low), close: Number(v.close), volume: 0 })).filter(c => Number.isFinite(c.time) && [c.open,c.high,c.low,c.close].every(n => Number.isFinite(n) && n > 0)).reverse();
    if (candles.length < 30) return res.status(502).json({ error: "Insufficient market candle history returned" });
    return res.status(200).json({ ok: true, mode: "PAPER_ONLY", liveTradingEnabled: false, symbol, provider: "Twelve Data", timeframe: interval, candles });
  } catch (error) { return res.status(502).json({ error: error && error.message ? error.message : "Forex data request failed" }); }
}
