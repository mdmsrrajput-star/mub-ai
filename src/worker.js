import { invokeVercelHandler } from "../api/_lib/vercel-adapter.js";
import paperTrades from "../api/paper-trades.js";
import paperPredictions from "../api/paper-predictions.js";
import cryptoSignal from "../api/crypto-signal.js";
import forexSignal from "../api/forex-signal.js";
import forexMarket from "../api/forex-market.js";

const routes = new Map([
  ["/api/paper-trades", paperTrades],
  ["/api/paper-predictions", paperPredictions],
  ["/api/crypto-signal", cryptoSignal],
  ["/api/forex-signal", forexSignal],
  ["/api/forex-market", forexMarket]
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/auto-scan") {
      // Temporary compatibility bridge: this endpoint fans out to 64 market
      // requests, which exceeds the Workers Free subrequest ceiling. Keep it
      // on the existing Vercel deployment until the scanner is split into
      // bounded batches and independently verified.
      const legacyOrigin = String(env.LEGACY_VERCEL_ORIGIN || "").replace(/\/$/, "");
      if (!legacyOrigin) return Response.json({ ok: false, mode: "PAPER_ONLY", liveTradingEnabled: false, executionEnabled: false, error: "Scanner bridge is not configured" }, { status: 503 });
      const target = new URL(url.pathname + url.search, legacyOrigin);
      return fetch(new Request(target.toString(), { method: "GET", headers: request.headers }));
    }

    const handler = routes.get(url.pathname);
    if (handler) return invokeVercelHandler(handler, request, env);
    if (url.pathname.startsWith("/api/")) {
      return Response.json({ ok: false, error: "API route not found", liveTradingEnabled: false }, { status: 404 });
    }
    return env.ASSETS.fetch(request);
  }
};
