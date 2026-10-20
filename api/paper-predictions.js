const STATE_KEY = "mub:paper:shared:v1";
const LEGACY_PREDICTION_KEY = "mub:paper:prediction:v1";
const LEGACY_SPOT_KEY = "mub:paper:account:v1";
const STARTING_BALANCE = 10000;
const MAX_STAKE = 1000;
const PAYOUT_RATE = 1.0;
const ALLOWED_SYMBOLS = ["BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT","ADAUSDT","DOGEUSDT","EURUSD","GBPUSD","USDJPY","AUDUSD","USDCAD","USDCHF","NZDUSD","EURJPY","GBPJPY","XAGUSD"];
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
  if (!ALLOWED_SYMBOLS.includes(symbol)) throw new Error("Supported crypto, forex and silver symbols");
  if (["EURUSD","GBPUSD","USDJPY","AUDUSD","USDCAD","USDCHF","NZDUSD","EURJPY","GBPJPY","XAGUSD"].includes(symbol)) {
    const apiKey = process.env.TWELVE_DATA_API_KEY;
    if (!apiKey) throw new Error("Forex data is not configured. Add TWELVE_DATA_API_KEY in Vercel environment variables.");
    const pair = ({EURUSD:"EUR/USD",GBPUSD:"GBP/USD",USDJPY:"USD/JPY",AUDUSD:"AUD/USD",USDCAD:"USD/CAD",USDCHF:"USD/CHF",NZDUSD:"NZD/USD",EURJPY:"EUR/JPY",GBPJPY:"GBP/JPY",XAGUSD:"XAG/USD"})[symbol];
    const url = "https://api.twelvedata.com/price?symbol=" + encodeURIComponent(pair) + "&apikey=" + encodeURIComponent(apiKey);
    const response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!response.ok) throw new Error("Forex price provider returned HTTP " + response.status);
    const data = await response.json();
    if (data && data.status === "error") throw new Error("Forex provider error: " + String(data.message || "request failed").slice(0, 180));
    const price = Number(data && data.price);
    if (!Number.isFinite(price) || price <= 0) throw new Error("Forex price response invalid; prediction not started");
    return price;
  }
  const hosts = ["https://api.binance.com", "https://api1.binance.com", "https://api2.binance.com", "https://api3.binance.com", "https://data-api.binance.vision"];
  let lastError = "Market price unavailable; prediction not started";
  for (const host of hosts) {
    try {
      const response = await fetch(host + "/api/v3/ticker/price?symbol=" + encodeURIComponent(symbol), { headers: { Accept: "application/json" }, cache: "no-store" });
      if (!response.ok) { lastError = "Market price host returned HTTP " + response.status; continue; }
      const data = await response.json();
      const price = Number(data && data.price);
      if (Number.isFinite(price) && price > 0) return price;
      lastError = "Market price response was invalid";
    } catch (error) { lastError = error && error.message ? error.message : "Market price request failed"; }
  }
  throw new Error("Market price unavailable; prediction not started (" + lastError + ")");
}
const LUA = `
local raw = redis.call("GET", KEYS[1])
local s
if raw then
 s = cjson.decode(raw)
else
 -- One-time migration: preserve prediction history and balance, plus spot trade
 -- records/positions. Spot P/L is applied as the change from its original $10k.
 local predRaw = redis.call("GET", KEYS[2])
 local spotRaw = redis.call("GET", KEYS[3])
 local pred = predRaw and cjson.decode(predRaw) or {}
 local spot = spotRaw and cjson.decode(spotRaw) or {}
 local predBalance = tonumber(pred.balance) or 10000
 local spotCash = tonumber(spot.cash) or 10000
 local sharedCash = predBalance + (spotCash - 10000)
 s = {
  balance = sharedCash, cash = sharedCash,
  active = pred.active or {}, history = pred.history or {},
  positions = spot.positions or {}, trades = spot.trades or {},
  realizedPnl = tonumber(spot.realizedPnl) or 0
 }
end
if not s.history then s.history = {} end
if not s.positions then s.positions = {} end
if not s.trades then s.trades = {} end
if not s.cash then s.cash = tonumber(s.balance) or 10000 end
if not s.balance then s.balance = tonumber(s.cash) or 10000 end
-- Migrate the older single-active-prediction format to an array.
if type(s.active) == "table" and s.active.status then s.active = { s.active } end
if type(s.active) ~= "table" then s.active = {} end
local action = ARGV[1]
local p = cjson.decode(ARGV[2])
if action == "status" then return cjson.encode(s) end
if action == "start" then
 local amount = tonumber(p.amount)
 if not amount or amount < 1 or amount > 1000 then return redis.error_reply("Stake must be between $1 and $1,000") end
 -- Idempotency is enforced inside Redis/Lua so simultaneous requests and page
 -- reloads cannot bypass the duplicate check for the same auto-zone signal.
 local requestKey = p.idempotencyKey
 if requestKey and requestKey ~= "" then
  for _, a in ipairs(s.active) do
   if a and a.idempotencyKey == requestKey then return redis.error_reply("Duplicate paper prediction request") end
  end
  for _, h in ipairs(s.history) do
   if h and h.idempotencyKey == requestKey then return redis.error_reply("Duplicate paper prediction request") end
  end
 end
 local committed = 0
 for _, a in ipairs(s.active) do
  if a and a.status == "PENDING" then committed = committed + (tonumber(a.stake) or 0) end
 end
 if tonumber(s.balance or 0) < amount then return redis.error_reply("Insufficient available paper balance") end
 -- Deduct the stake immediately when the paper order is accepted.
 s.balance = tonumber(s.balance or s.cash or 10000) - amount
 s.cash = s.balance
 table.insert(s.active, {
  id = p.id, idempotencyKey = p.idempotencyKey, symbol = p.symbol, direction = p.direction, stake = amount,
  expiry = p.expiry, entryPrice = tonumber(p.price), startedAt = tonumber(p.now),
  expiresAt = tonumber(p.now) + tonumber(p.duration), status = "PENDING",
  payoutRate = 1.0, stakeDeducted = true
 })
 local ok, encoded = pcall(cjson.encode, s)
 if not ok or not encoded then return redis.error_reply("Could not encode paper prediction state: " .. tostring(encoded)) end
 redis.call("SET", KEYS[1], encoded)
 return encoded
end
if action == "settle" then
 local found = false
 for idx = #s.active, 1, -1 do
  local a = s.active[idx]
  if a and a.status == "PENDING" and a.id == p.id and tonumber(p.now) >= tonumber(a.expiresAt) then
   local entry = tonumber(a.entryPrice)
   local exit = tonumber(p.price)
   local direction = a.direction
   local won = (direction == "UP" and exit > entry) or (direction == "DOWN" and exit < entry)
   local stake = tonumber(a.stake)
   local pnl = won and stake or -stake
   -- New trades already had their stake deducted at entry. On a win, return
   -- the stake plus equal profit; on a loss, no further balance deduction.
   -- Preserve the previous settlement behavior for legacy pending trades.
   if a.stakeDeducted then
    if won then s.balance = tonumber(s.balance or s.cash or 0) + (stake * 2) end
    s.cash = s.balance
   else
    s.balance = tonumber(s.balance or 10000) + pnl
   end
   a.status = "SETTLED"
   a.exitPrice = exit
   a.settledAt = tonumber(p.now)
   a.result = won and "WIN" or "LOSS"
   a.pnl = pnl
   local settled = {}
   for k, v in pairs(a) do settled[k] = v end
   table.insert(s.history, 1, settled)
   while #s.history > 100 do table.remove(s.history) end
   table.remove(s.active, idx)
   found = true
  end
 end
 local ok, encoded = pcall(cjson.encode, s)
 if not ok or not encoded then return redis.error_reply("Could not encode settled prediction state: " .. tostring(encoded)) end
 if found then redis.call("SET", KEYS[1], encoded) end
 return encoded
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
      const active = Array.isArray(state.active) ? state.active : (state.active && state.active.status ? [state.active] : []);
      const now = Date.now();
      for (const prediction of active) {
        if (prediction && prediction.status === "PENDING" && now >= Number(prediction.expiresAt)) {
          try {
            const price = await getPrice(prediction.symbol);
            state = await ledger("settle", { id: prediction.id, now: Date.now(), price });
          } catch (settleError) {
            console.error("Prediction settlement deferred:", settleError.message);
          }
        }
      }
      state = await ledger("status");
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
    if (!ALLOWED_SYMBOLS.includes(symbol)) return send(res, 400, { ok: false, error: "Unsupported symbol. Gold predictions remain disabled." });
    if (!["UP", "DOWN"].includes(direction)) return send(res, 400, { ok: false, error: "Direction must be UP or DOWN" });
    if (!Object.prototype.hasOwnProperty.call(EXPIRIES, expiry)) return send(res, 400, { ok: false, error: "Unsupported expiry" });
    if (!Number.isFinite(amount) || amount < 1 || amount > MAX_STAKE || Math.round(amount * 100) !== amount * 100) return send(res, 400, { ok: false, error: "Stake must be $1 to $1,000 with at most two decimal places" });
    const now = Date.now();
    const price = await getPrice(symbol);
    const account = await ledger("start", {
      id: `paper-${now}-${Math.random().toString(36).slice(2, 9)}`,
      symbol, direction, expiry, amount, price, now, duration: EXPIRIES[expiry],
      idempotencyKey: typeof body.idempotencyKey === "string" && /^[A-Za-z0-9:_|.-]{8,180}$/.test(body.idempotencyKey)
        ? body.idempotencyKey : null
    });
    return send(res, 201, { ok: true, account, payoutRate: PAYOUT_RATE, message: "Paper prediction started; no real-money order was placed." });
  } catch (error) {
    const message = error.message || "Paper prediction could not be started";
    const conflict = /already active|Duplicate paper prediction request/i.test(message);
    const client = /Stake must|Insufficient paper balance|Only BTC|Direction must|Unsupported expiry|Unsupported action/i.test(message);
    return send(res, conflict ? 409 : client ? 400 : 503, { ok: false, error: message });
  }
}
