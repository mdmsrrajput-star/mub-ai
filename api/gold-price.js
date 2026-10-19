let cachedQuote = null;
let cachedAt = 0;
const CACHE_MS = 30_000;

export default async function handler(req, res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Short server-side cache prevents repeated mobile refreshes from exhausting provider credits.
  if (cachedQuote && Date.now() - cachedAt < CACHE_MS) {
    return res.status(200).json({
      spot_usd_oz: cachedQuote,
      data_state: { status: "received", as_of: new Date(cachedAt).toISOString() },
      provider: "Twelve Data",
      cached: true
    });
  }

  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: "Gold feed is not configured. Add TWELVE_DATA_API_KEY in Vercel Production environment variables." });
  }

  try {
    const url = "https://api.twelvedata.com/price?symbol=" + encodeURIComponent("XAU/USD") + "&apikey=" + encodeURIComponent(apiKey);
    const upstream = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
    const data = await upstream.json().catch(() => ({}));

    if (!upstream.ok) {
      return res.status(502).json({ error: "Twelve Data gold feed returned HTTP " + upstream.status });
    }
    if (data && (data.status === "error" || data.code)) {
      const message = String(data.message || data.values || "Twelve Data gold quote failed").slice(0, 180);
      const status = Number(data.code) === 429 ? 429 : 502;
      return res.status(status).json({ error: message });
    }

    const price = Number(data.price);
    if (!Number.isFinite(price) || price <= 0) {
      return res.status(502).json({ error: "Twelve Data returned no valid XAU/USD price. Check that your plan supports this symbol." });
    }

    cachedQuote = price;
    cachedAt = Date.now();
    return res.status(200).json({
      spot_usd_oz: price,
      data_state: { status: "received", as_of: new Date(cachedAt).toISOString() },
      provider: "Twelve Data",
      cached: false,
      note: "Quote received; provider timestamp is not supplied by the price endpoint."
    });
  } catch (error) {
    return res.status(502).json({ error: error && error.message ? error.message : "Gold quote request failed" });
  }
}
