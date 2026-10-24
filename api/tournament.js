import crypto from "node:crypto";

const SESSION_SECONDS = 60 * 60 * 24 * 7;
const START_COINS = 100;
const SESSION_SECRET = process.env.TOURNAMENT_SESSION_SECRET || "";
const ADMIN_KEY = process.env.TOURNAMENT_ADMIN_KEY || "";
const SESSION_COOKIE = "mub_tournament_session";

async function redis(command) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Tournament storage is not configured. Set Upstash Redis environment variables.");
  const response = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(command) });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data || data.error) throw new Error("Tournament storage unavailable");
  return data.result;
}
function b64(v) { return Buffer.from(v).toString("base64url"); }
function cookieValue(req) {
  const raw = String(req.headers.cookie || "");
  const match = raw.split(";").map(x => x.trim()).find(x => x.startsWith(SESSION_COOKIE + "="));
  return match ? decodeURIComponent(match.slice(SESSION_COOKIE.length + 1)) : "";
}
function sign(value) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("base64url");
}
function makeSession(userId) {
  const payload = b64(JSON.stringify({ sub: userId, exp: Date.now() + SESSION_SECONDS * 1000 }));
  return payload + "." + sign(payload);
}
function verifySession(token) {
  if (!SESSION_SECRET || !token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const expected = Buffer.from(sign(parts[0]));
  const actual = Buffer.from(parts[1]);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    return payload.exp > Date.now() && typeof payload.sub === "string" ? payload.sub : null;
  } catch { return null; }
}
function setCookie(res, token) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_SECONDS}`);
}
function clearCookie(res) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}
function json(res, status, body) { return res.status(status).json({ mode: "TOURNAMENT_DEMO_ONLY", realMoneyPayoutEnabled: false, ...body }); }
function londonSession(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  const day = `${p.year}-${p.month}-${p.day}`;
  const minute = Number(p.hour) * 60 + Number(p.minute);
  return { day, minute, open: minute >= 480 && minute < 990, startsAt: day + " 08:00 Europe/London", endsAt: day + " 16:30 Europe/London" };
}
function userKey(id) { return "mub:tournament:user:" + id; }
async function getUser(id) {
  const raw = await redis(["GET", userKey(id)]);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
async function saveUser(user) {
  await redis(["SET", userKey(user.id), JSON.stringify(user)]);
  await redis(["ZADD", "mub:tournament:leaderboard:" + user.day, String(user.coins), user.id]);
}
async function getMarketPrice(symbol) {
  if (symbol === "BTCUSDT" || symbol === "ETHUSDT") {
    for (const host of ["https://api.binance.com", "https://api1.binance.com", "https://data-api.binance.vision"]) {
      try {
        const r = await fetch(host + "/api/v3/ticker/price?symbol=" + symbol, { cache: "no-store" });
        if (!r.ok) continue;
        const d = await r.json();
        const price = Number(d.price);
        if (Number.isFinite(price) && price > 0) return price;
      } catch {}
    }
    throw new Error("Crypto price feed unavailable; no tournament prediction was started.");
  }
  throw new Error("Tournament predictions currently support BTC/USDT and ETH/USDT only.");
}
function publicUser(user) {
  return {
    id: user.id, displayName: user.displayName, coins: user.coins, day: user.day,
    joined: user.joined, pending: (user.pending || []).length,
    wins: user.wins || 0, losses: user.losses || 0, draws: user.draws || 0,
    history: Array.isArray(user.history) ? user.history.slice(0, 100) : []
  };
}
async function settleDue(user) {
  const pending = Array.isArray(user.pending) ? user.pending : [];
  if (!Array.isArray(user.history)) user.history = [];
  const still = [];
  for (const trade of pending) {
    if (Date.now() < trade.expiresAt) { still.push(trade); continue; }
    try {
      const exit = await getMarketPrice(trade.symbol);
      const tied = exit === Number(trade.entryPrice);
      const won = !tied && ((trade.direction === "UP" && exit > trade.entryPrice) || (trade.direction === "DOWN" && exit < trade.entryPrice));
      if (won) {
        user.coins += trade.stake * 2;
        user.wins = (user.wins || 0) + 1;
      } else if (tied) {
        // The stake was deducted at entry. Return it on an exact-price tie;
        // a draw must not be counted as either a win or a loss.
        user.coins += trade.stake;
        user.draws = (user.draws || 0) + 1;
      } else {
        user.losses = (user.losses || 0) + 1;
      }
      const settledAt = Date.now();
      const result = won ? "WIN" : (tied ? "DRAW" : "LOSS");
      const historyEntry = {
        id: trade.id, symbol: trade.symbol, direction: trade.direction, stake: trade.stake,
        expirySeconds: trade.expirySeconds, entryPrice: Number(trade.entryPrice), exitPrice: exit,
        result, startedAt: Number(trade.startedAt), settledAt,
        pnlCoins: won ? Number(trade.stake) : (tied ? 0 : -Number(trade.stake))
      };
      user.history.unshift(historyEntry);
      user.history = user.history.slice(0, 100);
      user.lastResult = historyEntry;
    } catch { still.push(trade); }
  }
  user.pending = still;
}
async function leaderboard(day) {
  const ids = await redis(["ZREVRANGE", "mub:tournament:leaderboard:" + day, "0", "49", "WITHSCORES"]);
  const rows = [];
  if (!Array.isArray(ids)) return rows;
  for (let i = 0; i + 1 < ids.length; i += 2) {
    const u = await getUser(String(ids[i]));
    if (u && u.day === day && u.joined) rows.push({ rank: rows.length + 1, displayName: u.displayName, coins: u.coins, wins: u.wins || 0, losses: u.losses || 0 });
  }
  return rows;
}
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "POST" && req.method !== "GET") { res.setHeader("Allow", "GET, POST"); return json(res, 405, { ok: false, error: "Use GET or POST" }); }
  if (!SESSION_SECRET || SESSION_SECRET.length < 32) return json(res, 503, { ok: false, error: "Tournament login is not configured. Set TOURNAMENT_SESSION_SECRET to a random secret of at least 32 characters in Vercel." });
  try {
    let body = req.body || {};
    if (typeof body === "string") body = JSON.parse(body);
    const action = req.method === "GET" ? String(req.query?.action || "me") : String(body.action || "");

    if (action === "request-password-reset") {
      if (req.method !== "POST") return json(res, 405, { ok:false, error:"POST required" });
      const email=String(body.email||"").trim().toLowerCase();
      if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) return json(res,400,{ok:false,error:"Enter the registered email address."});
      const emailHash=crypto.createHash("sha256").update(email).digest("hex");
      const id=await redis(["GET","mub:tournament:email:"+emailHash]);
      // Always return the same message so the endpoint does not disclose whether an email is registered.
      if (id) {
        const user=await getUser(id);
        const resendKey=process.env.RESEND_API_KEY||"";
        const from=process.env.TOURNAMENT_FROM_EMAIL||"";
        if (user && resendKey && from) {
          const rawToken=crypto.randomBytes(32).toString("base64url");
          const tokenHash=crypto.createHash("sha256").update(rawToken).digest("hex");
          await redis(["SET","mub:tournament:reset:"+tokenHash,JSON.stringify({userId:id,createdAt:Date.now()}),"EX",1800]);
          const proto=String(req.headers["x-forwarded-proto"]||"https").split(",")[0].trim();
          const host=String(req.headers.host||"");
          const base=process.env.TOURNAMENT_PUBLIC_URL||((proto==="https"?"https://":"http://")+host);
          const link=base+"/crypto/?tournamentReset="+encodeURIComponent(rawToken);
          const mail=await fetch("https://api.resend.com/emails",{method:"POST",headers:{"Authorization":"Bearer "+resendKey,"Content-Type":"application/json"},body:JSON.stringify({from,to:[email],subject:"Reset your MuB tournament password",text:"Use this one-time link to reset your MuB tournament password. It expires in 30 minutes and can only be used once:\n\n"+link+"\n\nIf you did not request this, ignore this email."})});
          if(!mail.ok) console.error("Tournament reset email failed:",mail.status);
        } else {
          console.error("Password recovery email is not configured (RESEND_API_KEY / TOURNAMENT_FROM_EMAIL).");
        }
      }
      return json(res,200,{ok:true,message:"If that email is registered and recovery email is configured, a one-time reset link will arrive shortly. Check spam too."});
    }
    if (action === "reset-password") {
      if (req.method !== "POST") return json(res,405,{ok:false,error:"POST required"});
      const token=String(body.token||"");
      const password=String(body.password||"");
      if (password.length<10||password.length>128) return json(res,400,{ok:false,error:"New password must be 10–128 characters."});
      if (token.length<30||token.length>200) return json(res,400,{ok:false,error:"Reset link is invalid or expired. Request a new one."});
      const tokenHash=crypto.createHash("sha256").update(token).digest("hex");
      const key="mub:tournament:reset:"+tokenHash;
      const raw=await redis(["GET",key]);
      if(!raw) return json(res,400,{ok:false,error:"Reset link is invalid or expired. Request a new one."});
      let reset; try { reset=JSON.parse(raw); } catch { return json(res,400,{ok:false,error:"Reset link is invalid or expired. Request a new one."}); }
      const user=await getUser(String(reset.userId||""));
      if(!user) { await redis(["DEL",key]); return json(res,400,{ok:false,error:"Reset link is invalid or expired. Request a new one."}); }
      const salt=crypto.randomBytes(16).toString("base64url");
      const passwordHash=await new Promise((resolve,reject)=>crypto.pbkdf2(password,salt,210000,32,"sha256",(e,k)=>e?reject(e):resolve(k.toString("base64url"))));
      user.salt=salt; user.passwordHash=passwordHash; user.passwordChangedAt=Date.now();
      await redis(["SET",userKey(user.id),JSON.stringify(user)]);
      await redis(["DEL",key]);
      setCookie(res,makeSession(user.id));
      return json(res,200,{ok:true,user:publicUser(user),message:"Password reset successfully. You are now signed in."});
    }
    if (action === "register" || action === "login") {
      if (req.method !== "POST") return json(res, 405, { ok: false, error: "POST required" });
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      const displayName = String(body.displayName || "").trim().replace(/[<>]/g, "").slice(0, 24);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res, 400, { ok: false, error: "Enter a valid email address." });
      if (password.length < 10 || password.length > 128) return json(res, 400, { ok: false, error: "Password must be 10–128 characters." });
      const emailHash = crypto.createHash("sha256").update(email).digest("hex");
      const emailKey = "mub:tournament:email:" + emailHash;
      let id = await redis(["GET", emailKey]);
      let user;
      if (action === "register") {
        if (id) return json(res, 409, { ok: false, error: "An account with this email already exists. Please log in." });
        if (displayName.length < 2) return json(res, 400, { ok: false, error: "Display name must be at least 2 characters." });
        id = crypto.randomUUID();
        const salt = crypto.randomBytes(16).toString("base64url");
        const passwordHash = await new Promise((resolve, reject) => crypto.pbkdf2(password, salt, 210000, 32, "sha256", (e, key) => e ? reject(e) : resolve(key.toString("base64url"))));
        const session = londonSession();
        user = { id, emailHash, displayName, salt, passwordHash, coins: START_COINS, day: session.day, joined: false, pending: [], history: [], wins: 0, losses: 0, draws: 0, createdAt: Date.now() };
        await redis(["SET", emailKey, id]);
        await saveUser(user);
      } else {
        if (!id) return json(res, 401, { ok: false, error: "Email or password is incorrect." });
        user = await getUser(id);
        if (!user) return json(res, 401, { ok: false, error: "Email or password is incorrect." });
        const supplied = await new Promise((resolve, reject) => crypto.pbkdf2(password, user.salt, 210000, 32, "sha256", (e, key) => e ? reject(e) : resolve(key)));
        const expected = Buffer.from(user.passwordHash, "base64url");
        if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return json(res, 401, { ok: false, error: "Email or password is incorrect." });
      }
      setCookie(res, makeSession(id));
      return json(res, 200, { ok: true, user: publicUser(user), message: "Signed in. Tournament results are demo-only; real-money payouts are disabled." });
    }
    if (action === "logout") { clearCookie(res); return json(res, 200, { ok: true }); }
    const userId = verifySession(cookieValue(req));
    if (action === "leaderboard") {
      const session = londonSession();
      return json(res, 200, { ok: true, session, leaderboard: await leaderboard(session.day), payout: { maximumUsd: 25, status: "DISABLED_PENDING_COMPLIANCE_AND_PAYMENT_REVIEW" } });
    }
    if (!userId) return json(res, 401, { ok: false, error: "Please register or log in first." });
    let user = await getUser(userId);
    if (!user) { clearCookie(res); return json(res, 401, { ok: false, error: "Session expired. Please log in again." }); }
    const session = londonSession();
    if (action === "me") {
      if (user.day !== session.day) {
        user.day = session.day; user.coins = START_COINS; user.joined = false; user.pending = []; user.wins = 0; user.losses = 0; user.draws = 0;
        await saveUser(user);
      } else {
        await settleDue(user);
        await saveUser(user);
      }
      return json(res, 200, { ok: true, user: publicUser(user), session, payout: { maximumUsd: 25, status: "DISABLED_PENDING_COMPLIANCE_AND_PAYMENT_REVIEW" } });
    }
    if (action === "join") {
      if (!session.open) return json(res, 409, { ok: false, error: "Tournament entry is open only from 08:00 to 16:30 Europe/London." });
      if (user.day !== session.day) { user.day = session.day; user.coins = START_COINS; user.joined = false; user.pending = []; user.wins = 0; user.losses = 0; user.draws = 0; }
      user.joined = true;
      await saveUser(user);
      return json(res, 200, { ok: true, user: publicUser(user), session, message: "You joined today's free tournament with 100 coins." });
    }
    if (action === "play") {
      if (!session.open) return json(res, 409, { ok: false, error: "Tournament trades are accepted only from 08:00 to 16:30 Europe/London." });
      if (!user.joined || user.day !== session.day) return json(res, 409, { ok: false, error: "Join today's tournament first." });
      if ((user.pending || []).length >= 3) return json(res, 409, { ok: false, error: "Maximum 3 unsettled tournament predictions." });
      const symbol = String(body.symbol || "").toUpperCase();
      const direction = String(body.direction || "").toUpperCase();
      const stake = Number(body.stake);
      const expiry = Number(body.expirySeconds || 60);
      if (!["BTCUSDT", "ETHUSDT"].includes(symbol) || !["UP", "DOWN"].includes(direction)) return json(res, 400, { ok: false, error: "Choose BTC/USDT or ETH/USDT and UP or DOWN." });
      if (!Number.isInteger(stake) || stake < 1 || stake > 20 || stake > user.coins) return json(res, 400, { ok: false, error: "Stake must be 1–20 tournament coins and within your available balance." });
      if (![60, 300].includes(expiry)) return json(res, 400, { ok: false, error: "Tournament prediction expiry must be 1 or 5 minutes." });
      const entryPrice = await getMarketPrice(symbol);
      user.coins -= stake;
      user.pending = user.pending || [];
      user.pending.push({ id: crypto.randomUUID(), symbol, direction, stake, expirySeconds: expiry, entryPrice, startedAt: Date.now(), expiresAt: Date.now() + expiry * 1000 });
      await saveUser(user);
      return json(res, 201, { ok: true, user: publicUser(user), message: "Tournament prediction accepted using a fresh market price. Result is settled after expiry." });
    }
    if (action === "admin-approve-prize") {
      if (!ADMIN_KEY || String(req.headers["x-tournament-admin-key"] || "") !== ADMIN_KEY) return json(res, 403, { ok: false, error: "Admin authorization denied." });
      return json(res, 409, { ok: false, error: "Real-money payout is intentionally disabled. Configure legal/compliance review and a verified payment workflow before enabling payouts." });
    }
    return json(res, 400, { ok: false, error: "Unsupported tournament action." });
  } catch (error) {
    console.error("Tournament API error:", error && error.message);
    return json(res, 503, { ok: false, error: error && error.message ? error.message : "Tournament service unavailable." });
  }
}
