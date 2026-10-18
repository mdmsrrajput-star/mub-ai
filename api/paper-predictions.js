const STATE_KEY = "mub:paper:prediction:v1";
const STARTING_BALANCE = 10000;
const MAX_STAKE = 1000;
const PAYOUT_RATE = 1.0;
const ALLOWED_SYMBOLS = ["BTCUSDT", "ETHUSDT"];
const EXPIRIES = { "1m": 60000, "3m": 180000, "5m": 300000, "15m": 900000, "30m": 1800000, "1h": 3600000 };

function send(res, status, data) {
  return res.status(status).json({ mode: "PAPER_ONLY", liveTradingEnabled: false, ...data });
}
async function redisCommand(command) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Paper prediction storage is not configured");
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(command)
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data || data.error) {
    // Preserve a safe server-side diagnostic so configuration and Redis errors
    // can be distinguished from market-price failures in the dashboard response.
    const detail = data && typeof data.error === "string"
      ? data.error.slice(0, 180)
      : `Storage provider returned HTTP ${response.status}`;
    console.error("Paper prediction storage error:", detail);
    throw new Error(`Paper prediction storage unavailable: ${detail}`);
  }
  return data.result;
}
async function getPrice(symbol) {
  if (!ALLOWED_SYMBOLS.includes(symbol)) throw new Error("Only BTC/USDT and ETH/USDT predictions are enabled");
  // Try multiple public Binance market-data hosts. A failure on one hostname
  // (regional routing, transient outage, or rate limiting) should not block a paper entry.
  const hosts = [
    "https://api.binance.com",
    "https://api1.binance.com",
    "https://api2.binance.com",
    "https://api3.binance.com",
    "https://data-api.binance.vision"
  ];
  let lastError = "Market price unavailable; prediction not started";
  for (const host of hosts) {
    try {
      const response = await fetch(`${host}/api/v3/ticker/price?symbol=${symbol}`, {
        headers: { Accept: "application/json" },
        cache: "no-store"
      });
      if (!response.ok) {
        lastError = `Market price host returned HTTP ${response.status}`;
        continue;
      }
      const data = await response.json();
      const price = Number(data && data.price);
      if (Number.isFinite(price) && price > 0) return price;
      lastError = "Market price response was invalid";
    } catch (error) {
      lastError = error && error.message ? error.message : "Market price request failed";
    }
  }
  throw new Error(`Market price unavailable; prediction not started (${lastError})`);
}
const LUA = `
local raw = redis.call("GET", KEYS[1])
local s
if raw then s = cjson.decode(raw) else
 s = { balance = 10000, active = false, history = {} }
end
if not s.history then s.history = {} end
local action = ARGV[1]
local p = cjson.decode(ARGV[2])
if action == "status" then return cjson.encode(s) end
if action == "start" then
 if s.active and s.active.status == "PENDING" then return redis.error_reply("A prediction is already active") end
 local amount = tonumber(p.amount)
 if not amount or amount < 1 or amount > 1000 then return redis.error_reply("Stake must be between $1 and $1,000") end
 if tonumber(s.balance or 0) < amount then return redis.error_reply("Insufficient paper balance") end
 s.active = {
  id = p.id, symbol = p.symbol, direction = p.direction, stake = amount,
  expiry = p.expiry, entryPrice = tonumber(p.price), startedAt = tonumber(p.now),
  expiresAt = tonumber(p.now) + tonumber(p.duration), status = "PENDING",
  payoutRate = 1.0
 }
 redis.call("SET", KEYS[1], cjson.encode(s))
 return cjson.encode(s)
end
if action == "settle" then
 if not s.active or s.active.status ~= "PENDING" then return cjson.encode(s) end
 if tonumber(p.now) < tonumber(s.active.expiresAt) then return cjson.encode(s) end
 local entry = tonumber(s.active.entryPrice)
 local exit = tonumber(p.price)
 local direction = s.active.direction
 local won = (direction == "UP" and exit > entry) or (direction == "DOWN" and exit < entry)
 local stake = tonumber(s.active.stake)
 local pnl = won and stake or -stake
 s.balance = tonumber(s.balance or 10000) + pnl
 s.active.status = "SETTLED"
 s.active.exitPrice = exit
 s.active.settledAt = tonumber(p.now)
 s.active.result = won and "WIN" or "LOSS"
 s.active.pnl = pnl
 table.insert(s.history, 1, s.active)
 while #s.history > 100 do table.remove(s.history) end
 redis.call("SET", KEYS[1], cjson.encode(s))
 return cjson.encode(s)
end
return redis.error_reply("Unsupported action")
`;
async function ledger(action, payload = {}) {
  const raw = await redisCommand(["EVAL", LUA, "1", STATE_KEY, action, JSON.stringify(payload)]);
  if (typeof raw !== "string") throw new Error("Unexpected paper prediction ledger response");
  return JSON.parse(raw);
}
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method === "GET") {
    try {
      let state = await ledger("status");
      if (state.active && state.active.status === "PENDING") {
        const now = Date.now();
        if (now >= Number(state.active.expiresAt)) {
          const price = await getPrice(state.active.symbol);
          state = await ledger("settle", { now, price });
        }
      }
      return send(res, 200, { ok: true, account: state, payoutRate: PAYOUT_RATE });
    } catch (error) {
      console.error("Prediction status failed:", error.message);
      return send(res, 503, { ok: false, error: error.message || "Paper prediction service unavailable" });
    }
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return send(res, 405, { ok: false, error: "Use GET or POST" });
  }
  try {
    let body = req.body;
    if (typeof body === "string") body = JSON.parse(body);
    if (!body || typeof body !== "object" || Array.isArray(body)) return send(res, 400, { ok: false, error: "Valid JSON body required" });
    const action = body.action;
    if (action !== "start") return send(res, 400, { ok: false, error: "Only start is supported" });
    const symbol = String(body.symbol || "BTCUSDT").toUpperCase();
    const direction = String(body.direction || "").toUpperCase();
    const expiry = String(body.expiry || "1m");
    const amount = Number(body.amount ?? 1);
    if (!ALLOWED_SYMBOLS.includes(symbol)) return send(res, 400, { ok: false, error: "Only BTC/USDT and ETH/USDT are supported; gold and forex predictions are disabled" });
    if (!["UP", "DOWN"].includes(direction)) return send(res, 400, { ok: false, error: "Direction must be UP or DOWN" });
    if (!Object.prototype.hasOwnProperty.call(EXPIRIES, expiry)) return send(res, 400, { ok: false, error: "Unsupported expiry" });
    if (!Number.isFinite(amount) || amount < 1 || amount > MAX_STAKE || Math.round(amount * 100) !== amount * 100) return send(res, 400, { ok: false, error: "Stake must be $1 to $1,000 with at most two decimal places" });
    const now = Date.now();
    const price = await getPrice(symbol);
    const account = await ledger("start", {
      id: `paper-${now}-${Math.random().toString(36).slice(2, 9)}`,
      symbol, direction, expiry, amount, price, now, duration: EXPIRIES[expiry]
    });
    return send(res, 201, { ok: true, account, payoutRate: PAYOUT_RATE, message: "Paper prediction started; no real-money order was placed." });
  } catch (error) {
    const message = error.message || "Paper prediction could not be started";
    const conflict = /already active/i.test(message);
    const client = /Stake must|Insufficient paper balance|Only BTC|Direction must|Unsupported expiry|Unsupported action/i.test(message);
    return send(res, conflict ? 409 : client ? 400 : 503, { ok: false, error: message });
  }
}
