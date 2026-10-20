
const ACCOUNT_KEY = "mub:paper:shared:v1";
const LEGACY_PREDICTION_KEY = "mub:paper:prediction:v1";
const LEGACY_SPOT_KEY = "mub:paper:account:v1";
const STARTING_BALANCE = 10000;
const FEE_RATE = 0.001; // 0.1% per transaction
const DAILY_LOSS_LIMIT = STARTING_BALANCE * 0.02;
const MAX_POSITION_NOTIONAL = STARTING_BALANCE * 0.10; // $1,000 maximum per simulated position

const LUA_SCRIPT = `
local raw = redis.call("GET", KEYS[1])
local s

if raw then
  s = cjson.decode(raw)
else
  -- One-time migration shares the prediction ledger's balance and preserves
  -- old prediction history plus spot positions/trades.
  local predRaw = redis.call("GET", KEYS[2])
  local spotRaw = redis.call("GET", KEYS[3])
  local pred = predRaw and cjson.decode(predRaw) or {}
  local spot = spotRaw and cjson.decode(spotRaw) or {}
  local predBalance = tonumber(pred.balance) or 10000
  local spotCash = tonumber(spot.cash) or 10000
  local sharedCash = predBalance + (spotCash - 10000)
  s = {
    cash = sharedCash, balance = sharedCash,
    active = pred.active or {}, history = pred.history or {},
    realizedPnl = tonumber(spot.realizedPnl) or 0,
    positions = spot.positions or {},
    trades = spot.trades or {}
  }
end

local action = ARGV[1]
local p = cjson.decode(ARGV[2])

if not s.positions then s.positions = {} end
if not s.active then s.active = {} end
if not s.history then s.history = {} end
if not s.cash then s.cash = tonumber(s.balance) or 10000 end
if not s.balance then s.balance = tonumber(s.cash) or 10000 end
if not s.trades then s.trades = {} end
if not s.realizedPnl then s.realizedPnl = 0 end

if action == "status" then
  if not raw then
    redis.call("SET", KEYS[1], cjson.encode(s))
  end
  return cjson.encode(s)
end

if action == "reset" then
  s = {
    cash = 10000,
    realizedPnl = 0,
    positions = {},
    trades = {}
  }
  redis.call("SET", KEYS[1], cjson.encode(s))
  return cjson.encode(s)
end

local symbol = p.symbol
local price = tonumber(p.price)
local side = p.side or "LONG"
local notional = tonumber(p.notional)

if not symbol or (symbol ~= "BTCUSDT" and symbol ~= "ETHUSDT") then
  return redis.error_reply("Unsupported symbol")
end

if not price or price <= 0 then
  return redis.error_reply("A valid price is required")
end

if action == "open" then
  -- This guard limits daily realized losses only; it does not cap unrealized losses.
  local dailyPnl = 0
  local dayStart = tonumber(p.dayStart)
  -- Fail closed if the API did not provide today's UTC midnight.
  -- Falling back to 0 would incorrectly count all historical closed trades.
  if not dayStart or dayStart <= 0 or dayStart % 86400000 ~= 0 then
    return redis.error_reply("Valid UTC dayStart is required")
  end
  for _, trade in ipairs(s.trades) do
    if trade.action == "CLOSE" and tonumber(trade.timestamp or 0) >= dayStart then
      dailyPnl = dailyPnl + (tonumber(trade.netPnl) or 0)
    end
  end
  local dailyLossLimit = tonumber(p.dailyLossLimit) or 200
  if dailyPnl <= -dailyLossLimit then
    return redis.error_reply("Daily realized loss limit reached")
  end

  if side ~= "LONG" and side ~= "SHORT" then
    return redis.error_reply("Side must be LONG or SHORT")
  end

  if not notional or notional <= 0 then
    return redis.error_reply("Notional must be positive")
  end
  local stopLoss = tonumber(p.stopLoss)
  local takeProfit = tonumber(p.takeProfit)
  if not stopLoss or not takeProfit then
    return redis.error_reply("Both stopLoss and takeProfit are required")
  end
  if side == "LONG" and (stopLoss >= price or takeProfit <= price) then
    return redis.error_reply("For LONG, stopLoss must be below entry and takeProfit above entry")
  end
  if side == "SHORT" and (stopLoss <= price or takeProfit >= price) then
    return redis.error_reply("For SHORT, stopLoss must be above entry and takeProfit below entry")
  end
  local maxNotional = tonumber(p.maxNotional) or 1000
  if notional > maxNotional then
    return redis.error_reply("Position notional exceeds the $1,000 paper-trading cap")
  end

  if s.positions[symbol] then
    return redis.error_reply("A position for this symbol is already open")
  end

  local fee = notional * 0.001
  if not s.cash or s.cash < notional + fee then
    return redis.error_reply("Insufficient paper cash")
  end

  s.cash = s.cash - notional - fee
  s.positions[symbol] = {
    symbol = symbol,
    side = side,
    entryPrice = price,
    quantity = notional / price,
    notional = notional,
    openFee = fee,
    openedAt = p.timestamp or 0,
    stopLoss = tonumber(p.stopLoss),
    takeProfit = tonumber(p.takeProfit)
  }

  table.insert(s.trades, {
    action = "OPEN",
    symbol = symbol,
    side = side,
    price = price,
    notional = notional,
    fee = fee,
    timestamp = p.timestamp or 0
  })

elseif action == "close" then
  local pos = s.positions[symbol]
  if not pos then
    return redis.error_reply("No open position for this symbol")
  end

  local qty = tonumber(pos.quantity)
  local entry = tonumber(pos.entryPrice)
  local openFee = tonumber(pos.openFee) or 0
  local closeValue = qty * price
  local closeFee = closeValue * 0.001
  local grossPnl

  if pos.side == "SHORT" then
    grossPnl = (entry - price) * qty
    s.cash = s.cash + pos.notional - closeValue - closeFee
  else
    grossPnl = (price - entry) * qty
    s.cash = s.cash + closeValue - closeFee
  end

  local netPnl = grossPnl - openFee - closeFee
  s.realizedPnl = (tonumber(s.realizedPnl) or 0) + netPnl

  table.insert(s.trades, {
    action = "CLOSE",
    symbol = symbol,
    side = pos.side,
    entryPrice = entry,
    price = price,
    quantity = qty,
    grossPnl = grossPnl,
    fees = openFee + closeFee,
    netPnl = netPnl,
    timestamp = p.timestamp or 0
  })

  s.positions[symbol] = nil

else
  return redis.error_reply("Unsupported action")
end

while #s.trades > 500 do
  table.remove(s.trades, 1)
end

s.balance = s.cash
redis.call("SET", KEYS[1], cjson.encode(s))
return cjson.encode(s)
`;

function send(res, status, data) {
  return res.status(status).json({
    mode: "PAPER_ONLY",
    liveTradingEnabled: false,
    ...data
  });
}

async function redisCommand(command) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    throw new Error("Missing Upstash environment variables");
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });

  const result = await response.json().catch(() => null);

  if (!response.ok || !result || result.error) {
    throw new Error(
      result?.error || `Redis request failed (${response.status})`
    );
  }

  return result.result;
}

async function runLedger(action, payload = {}) {
  const result = await redisCommand([
    "EVAL",
    LUA_SCRIPT,
    "3",
    ACCOUNT_KEY,
    LEGACY_PREDICTION_KEY,
    LEGACY_SPOT_KEY,
    action,
    JSON.stringify(payload)
  ]);

  if (typeof result !== "string") {
    throw new Error("Unexpected response from paper account database");
  }

  return JSON.parse(result);
}

async function getPrice(symbol) {
  const allowed = ["BTCUSDT", "ETHUSDT"];
  if (!allowed.includes(symbol)) {
    throw new Error("Only BTCUSDT and ETHUSDT are supported");
  }

  const response = await fetch(
    `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`
  );

  if (!response.ok) {
    throw new Error("Could not retrieve the public market price");
  }

  const data = await response.json();
  const price = Number(data.price);

  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("Invalid market price received");
  }

  return price;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "GET") {
    try {
      const account = await runLedger("status");
      return send(res, 200, {
        ok: true,
        account,
        startingBalance: STARTING_BALANCE,
        dailyLossLimit: DAILY_LOSS_LIMIT,
        maxPositionNotional: MAX_POSITION_NOTIONAL
      });
    } catch (error) {
      console.error("Paper account GET failed:", error.message);
      return send(res, 500, {
        ok: false,
        error: "Paper account unavailable. Check server logs and database configuration."
      });
    }
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return send(res, 405, {
      ok: false,
      error: "Use GET or POST"
    });
  }

  const writeKey = process.env.PAPER_WRITE_KEY;
  const suppliedKey = req.headers["x-paper-key"];

  if (!writeKey || typeof suppliedKey !== "string" ||
      suppliedKey !== writeKey) {
    return send(res, 401, {
      ok: false,
      error: "Unauthorized"
    });
  }

  try {
    let body = req.body;

    if (typeof body === "string") {
      body = JSON.parse(body);
    }

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return send(res, 400, {
        ok: false,
        error: "A valid JSON request body is required"
      });
    }

    const action = body.action;

    if (action === "manage") {
      const account = await runLedger("status");
      const checked = [];
      for (const symbol of ["BTCUSDT", "ETHUSDT"]) {
        const position = account.positions?.[symbol];
        if (!position) continue;
        const price = await getPrice(symbol);
        const stopHit = position.side === "LONG"
          ? price <= Number(position.stopLoss)
          : price >= Number(position.stopLoss);
        const targetHit = position.side === "LONG"
          ? price >= Number(position.takeProfit)
          : price <= Number(position.takeProfit);
        if (stopHit || targetHit) {
          const updated = await runLedger("close", {
            symbol, price, timestamp: Date.now(),
            dailyLossLimit: DAILY_LOSS_LIMIT,
            maxNotional: MAX_POSITION_NOTIONAL,
            dayStart: Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate())
          });
          checked.push({ symbol, closed: true, reason: stopHit ? "STOP_LOSS" : "TAKE_PROFIT", exitPrice: price, account: updated });
        } else {
          checked.push({ symbol, closed: false, price });
        }
      }
      return send(res, 200, { ok: true, action: "manage", checked });
    }

    if (action === "status") {
      const account = await runLedger("status");
      return send(res, 200, {
        ok: true,
        account,
        startingBalance: STARTING_BALANCE,
        dailyLossLimit: DAILY_LOSS_LIMIT,
        maxPositionNotional: MAX_POSITION_NOTIONAL
      });
    }

    if (action === "reset") {
      return send(res, 403, {
        ok: false,
        error: "Account reset is disabled to protect paper-trading history"
      });
    }

    if (!["open", "close"].includes(action)) {
      return send(res, 400, {
        ok: false,
        error: "Action must be open or close"
      });
    }

    const symbol = body.symbol || "BTCUSDT";
    if (!["BTCUSDT", "ETHUSDT"].includes(symbol)) {
      return send(res, 400, {
        ok: false,
        error: "Symbol must be BTCUSDT or ETHUSDT"
      });
    }

    let price = Number(body.price);
    if (!Number.isFinite(price) || price <= 0) {
      price = await getPrice(symbol);
    }

    const payload = {
      symbol,
      price,
      side: body.side || "LONG",
      notional: Number(body.notional),
      stopLoss: Number(body.stopLoss),
      takeProfit: Number(body.takeProfit),
      timestamp: Date.now(),
      dailyLossLimit: DAILY_LOSS_LIMIT,
      maxNotional: MAX_POSITION_NOTIONAL,
      dayStart: (() => {
        const now = new Date();
        return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
      })()
    };

    const account = await runLedger(action, payload);

    return send(res, 200, {
      ok: true,
      action,
      account
    });
  } catch (error) {
    console.error("Paper account POST failed:", error.message);

    const message = error.message || "Unknown server error";
    const clientError =
      /Unsupported symbol|valid price|positive|already open|Insufficient|No open position|Side must|Unsupported action|Daily realized loss limit|Position notional exceeds|stopLoss|takeProfit|For LONG|For SHORT/i.test(message);

    return send(res, clientError ? 400 : 500, {
      ok: false,
      error: clientError ? message : "Paper account operation failed. Check Vercel function logs."
    });
  }
}
