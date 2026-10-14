export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");

  const LIVE_TRADING_ENABLED = false;
  const STARTING_BALANCE = 10000;
  const FEE_RATE = 0.001; // 0.10% per side
  const STATE_KEY = "mub:paper:account:v1";

  const send = (status, data) => res.status(status).json({
    mode: "PAPER_ONLY",
    liveTradingEnabled: LIVE_TRADING_ENABLED,
    ...data
  });

  if (!["GET", "POST"].includes(req.method)) {
    res.setHeader("Allow", "GET, POST");
    return send(405, { error: "Method not allowed" });
  }

  const dbUrl = process.env.UPSTASH_REDIS_REST_URL;
  const dbToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const writeKey = process.env.PAPER_WRITE_KEY;

  if (!dbUrl || !dbToken || !writeKey) {
    return send(500, {
      error: "Server configuration incomplete",
      hint: "Check Vercel environment variables."
    });
  }

  // Mutations require a secret header. Never put this secret
  // in public HTML or client-side JavaScript.
  let action = "status";
  let payload = {};

  if (req.method === "POST") {
    const supplied = req.headers["x-paper-key"];

    if (
      typeof supplied !== "string" ||
      supplied.length !== writeKey.length ||
      supplied !== writeKey
    ) {
      return send(401, { error: "Unauthorized paper-trading request" });
    }

    payload = req.body || {};

    if (typeof payload === "string") {
      try {
        payload = JSON.parse(payload);
      } catch {
        return send(400, { error: "Invalid JSON body" });
      }
    }

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return send(400, { error: "Expected a JSON object" });
    }

    action = payload.action;
    if (!["open", "close"].includes(action)) {
      return send(400, {
        error: "Action must be open or close"
      });
    }
  }

  // Only allow these two spot-market symbols.
  const symbol = String(payload.symbol || "BTCUSDT").toUpperCase();

  if (!["BTCUSDT", "ETHUSDT"].includes(symbol)) {
    return send(400, {
      error: "Only BTCUSDT and ETHUSDT are supported"
    });
  }

  async function getPrice(pair) {
    const response = await fetch(
      "https://data-api.binance.vision/api/v3/ticker/price?symbol=" +
      encodeURIComponent(pair),
      { headers: { Accept: "application/json" } }
    );

    if (!response.ok) {
      throw new Error("Public market price unavailable");
    }

    const data = await response.json();
    const price = Number(data.price);

    if (!Number.isFinite(price) || price <= 0) {
      throw new Error("Invalid market price");
    }

    return price;
  }

  // All account mutations run inside a Redis Lua script,
  // so concurrent requests cannot overwrite each other's state.
  const script = `
local key = KEYS[1]
local action = ARGV[1]
local p = cjson.decode(ARGV[2])

local raw = redis.call("GET", key)
local s

if raw then
  s = cjson.decode(raw)
else
  s = {
    version = 1,
    initialBalance = 10000,
    cash = 10000,
    realizedPnl = 0,
    positions = cjson.decode("[]"),
    trades = cjson.decode("[]"),
    nextId = 1,
    feeRate = 0.001,
    createdAt = (tonumber(p.timestamp) or 0)
  }
end

local function fail(message)
  return cjson.encode({error = message})
end

local function number(v)
  local n = tonumber(v)
  if not n or n ~= n or n == math.huge or n == -math.huge then
    return nil
  end
  return n
end

if action == "status" then
  return cjson.encode(s)
end

local symbol = tostring(p.symbol or "")
local price = number(p.price)

if symbol ~= "BTCUSDT" and symbol ~= "ETHUSDT" then
  return fail("Unsupported symbol")
end

if not price or price <= 0 then
  return fail("Price must be positive")
end

if action == "open" then
  local side = tostring(p.side or "")
  local qty = number(p.quantity)

  if side ~= "LONG" and side ~= "SHORT" then
    return fail("Side must be LONG or SHORT")
  end

  if not qty or qty <= 0 or qty > 1000000 then
    return fail("Invalid quantity")
  end

  local notional = qty * price
  local fee = notional * s.feeRate

  if notional ~= notional or notional == math.huge then
    return fail("Invalid order value")
  end

  if notional + fee > s.cash then
    return fail("Insufficient paper cash")
  end

  local id = tostring(s.nextId)
  s.nextId = s.nextId + 1
  s.cash = s.cash - notional - fee

  local position = {
    id = id,
    symbol = symbol,
    side = side,
    quantity = qty,
    entryPrice = price,
    notional = notional,
    openFee = fee,
    openedAt = (tonumber(p.timestamp) or 0)
  }

  table.insert(s.positions, position)

  table.insert(s.trades, {
    id = id,
    action = "OPEN",
    symbol = symbol,
    side = side,
    quantity = qty,
    price = price,
    fee = fee,
    time = (tonumber(p.timestamp) or 0)
  })

elseif action == "close" then
  local id = tostring(p.positionId or "")
  local found = nil

  for i, position in ipairs(s.positions) do
    if position.id == id then
      found = i
      break
    end
  end

  if not found then
    return fail("Open position not found")
  end

  local position = s.positions[found]

  if position.symbol ~= symbol then
    return fail("Symbol does not match position")
  end

  local pnl
  if position.side == "LONG" then
    pnl = (price - position.entryPrice) * position.quantity
  else
    pnl = (position.entryPrice - price) * position.quantity
  end

  local closeFee = position.quantity * price * s.feeRate

  s.cash = s.cash + position.notional + pnl - closeFee
  s.realizedPnl = s.realizedPnl + pnl
      - position.openFee - closeFee

  table.insert(s.trades, {
    id = position.id,
    action = "CLOSE",
    symbol = position.symbol,
    side = position.side,
    quantity = position.quantity,
    entryPrice = position.entryPrice,
    price = price,
    grossPnl = pnl,
    openFee = position.openFee,
    closeFee = closeFee,
    netPnl = pnl - position.openFee - closeFee,
    time = (tonumber(p.timestamp) or 0)
  })

  local remaining = cjson.decode("[]")
  for i, item in ipairs(s.positions) do
    if i ~= found then
      table.insert(remaining, item)
    end
  end
  s.positions = remaining
else
  return fail("Unsupported action")
end

-- Keep history bounded.
while #s.trades > 500 do
  table.remove(s.trades, 1)
end

s.updatedAt = (tonumber(p.timestamp) or 0)
redis.call("SET", key, cjson.encode(s))
return cjson.encode(s)
`;

  
async function redisCommand(command) {
  const response = await fetch(
    dbUrl.replace(/\/+$/, ""),
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + dbToken,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(command)
    }
  );

  const raw = await response.text();

  if (!response.ok) {
    console.error(
      "Upstash HTTP error:",
      response.status,
      raw.slice(0, 500)
    );
    throw new Error(
      "Upstash HTTP error: " + response.status
    );
  }

  let result;

  try {
    result = JSON.parse(raw);
  } catch {
    console.error("Invalid Upstash response:", raw.slice(0, 500));
    throw new Error("Invalid database response");
  }

  if (result.error) {
    console.error("Upstash command error:", result.error);
    throw new Error("Database command failed");
  }

  return result.result;
}

  try {
    let price = null;

    // For opening/closing, use the server-fetched market price
    // unless a positive price is explicitly supplied for simulation.
    if (action === "open" || action === "close") {
      if (payload.price === undefined) {
        price = await getPrice(symbol);
      } else {
        price = Number(payload.price);
        if (!Number.isFinite(price) || price <= 0) {
          return send(400, { error: "Invalid simulation price" });
        }
      }
    }

    const input = {
  ...payload,
  symbol,
  price,
  timestamp: Math.floor(Date.now() / 1000)
};

    const result = await redisCommand([
      "EVAL",
      script,
      "1",
      STATE_KEY,
      action,
      JSON.stringify(input)
    ]);

    const state = typeof result === "string"
      ? JSON.parse(result)
      : result;

    if (state.error) {
      return send(400, { error: state.error });
    }

    // Add current public market marks for display.
    // No exchange order is ever submitted.
    const marks = {};

    await Promise.all(
      ["BTCUSDT", "ETHUSDT"].map(async pair => {
        try {
          marks[pair] = await getPrice(pair);
        } catch {
          marks[pair] = null;
        }
      })
    );

    let unrealizedPnl = 0;

    const positions = state.positions.map(position => {
      const mark = marks[position.symbol];
      const usableMark = mark || position.entryPrice;

      const pnl = position.side === "LONG"
        ? (usableMark - position.entryPrice) * position.quantity
        : (position.entryPrice - usableMark) * position.quantity;

      unrealizedPnl += pnl;

      return {
        ...position,
        markPrice: mark,
        unrealizedPnl: pnl
      };
    });

    const equity = state.cash +
      positions.reduce(
        (sum, position) =>
          sum + position.notional + position.unrealizedPnl,
        0
      );

    return send(200, {
      account: {
        initialBalance: state.initialBalance,
        cash: state.cash,
        equity,
        realizedPnl: state.realizedPnl,
        unrealizedPnl,
        feesPerSide: state.feeRate,
        openPositions: positions.length
      },
      positions,
      trades: state.trades,
      marketPrices: marks,
      lastUpdated: new Date().toISOString(),
      note: "Paper simulation only. No live orders are possible."
    });
  } catch (error) {
    console.error("Paper trading API error:", error.message);
    return send(502, {
      error: "Paper service temporarily unavailable",
      liveTradingEnabled: false
    });
  }
    }
      
