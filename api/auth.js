import crypto from "node:crypto";

const CLIENT_ID = "1064070440957-1ial119jci1jninb5t10stg5p79bttpi.apps.googleusercontent.com";
const SESSION_SECRET = process.env.TOURNAMENT_SESSION_SECRET || process.env.MUB_AUTH_SESSION_SECRET || "";
const SESSION_COOKIE = "mub_auth_session";
const SESSION_SECONDS = 60 * 60 * 24 * 7;

async function redis(command) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Account storage is not configured. Set the Upstash Redis environment variables in Vercel.");
  const response = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(command) });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data || data.error) throw new Error("Account storage is temporarily unavailable.");
  return data.result;
}
function b64(value) { return Buffer.from(value).toString("base64url"); }
function sign(value) { return crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("base64url"); }
function makeSession(userId) {
  const payload = b64(JSON.stringify({ sub: userId, exp: Date.now() + SESSION_SECONDS * 1000 }));
  return payload + "." + sign(payload);
}
function readCookie(req) {
  const raw = String(req.headers.cookie || "");
  const item = raw.split(";").map(x => x.trim()).find(x => x.startsWith(SESSION_COOKIE + "="));
  return item ? decodeURIComponent(item.slice(SESSION_COOKIE.length + 1)) : "";
}
function verifySession(token) {
  if (!SESSION_SECRET || SESSION_SECRET.length < 32 || !token) return null;
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
function reply(res, status, body) { return res.status(status).json({ mode: "PAPER_ONLY", realTradingEnabled: false, ...body }); }

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "GET" && req.method !== "POST") { res.setHeader("Allow", "GET, POST"); return reply(res, 405, { ok: false, error: "Use GET or POST." }); }
  if (!SESSION_SECRET || SESSION_SECRET.length < 32) return reply(res, 503, { ok: false, error: "Account sessions are not configured. Set MUB_AUTH_SESSION_SECRET to a random secret of at least 32 characters in Vercel." });
  try {
    let body = req.body || {};
    if (typeof body === "string") body = JSON.parse(body);
    const action = req.method === "GET" ? String(req.query?.action || "me") : String(body.action || "");

    if (action === "login") {
      if (req.method !== "POST") return reply(res, 405, { ok: false, error: "POST required." });
      const credential = String(body.credential || "");
      if (!credential || credential.length > 10000) return reply(res, 400, { ok: false, error: "Google sign-in credential is missing or invalid." });

      // Validate the ID token with Google's tokeninfo endpoint on the server.
      const verifyResponse = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(credential), { cache: "no-store" });
      if (!verifyResponse.ok) return reply(res, 401, { ok: false, error: "Google sign-in could not be verified. Please try again." });
      const claims = await verifyResponse.json();
      if (claims.aud !== CLIENT_ID || !["accounts.google.com", "https://accounts.google.com"].includes(claims.iss) ||
          claims.email_verified !== "true" || !claims.sub || !claims.email ||
          !Number.isFinite(Number(claims.exp)) || Number(claims.exp) * 1000 <= Date.now()) {
        return reply(res, 401, { ok: false, error: "Google account verification failed." });
      }

      const googleSub = String(claims.sub);
      const email = String(claims.email).trim().toLowerCase();
      const profileKey = "mub:account:google:" + crypto.createHash("sha256").update(googleSub).digest("hex");
      let raw = await redis(["GET", profileKey]);
      let profile = null;
      if (raw) { try { profile = JSON.parse(raw); } catch {} }

      if (!profile) {
        const userId = "mub_" + crypto.randomUUID().replace(/-/g, "");
        profile = {
          id: userId,
          displayName: String(claims.name || email.split("@")[0] || "MuB User").replace(/[<>]/g, "").trim().slice(0, 40) || "MuB User",
          email,
          picture: typeof claims.picture === "string" && claims.picture.startsWith("https://") ? claims.picture : "",
          provider: "google",
          createdAt: Date.now()
        };
        await redis(["SET", profileKey, JSON.stringify(profile)]);
        await redis(["SET", "mub:account:id:" + userId, JSON.stringify(profile)]);
        // Index only verified Google email for safe linking to existing tournament accounts.
        await redis(["SET", "mub:account:email:" + crypto.createHash("sha256").update(email).digest("hex"), userId]);
      } else {
        profile.displayName = String(claims.name || profile.displayName || "MuB User").replace(/[<>]/g, "").trim().slice(0, 40);
        profile.email = email;
        profile.picture = typeof claims.picture === "string" && claims.picture.startsWith("https://") ? claims.picture : (profile.picture || "");
        await redis(["SET", profileKey, JSON.stringify(profile)]);
        await redis(["SET", "mub:account:id:" + profile.id, JSON.stringify(profile)]);
      }
      setCookie(res, makeSession(profile.id));
      return reply(res, 200, { ok: true, user: profile, message: "Signed in to MuB." });
    }

    if (action === "logout") {
      if (req.method !== "POST") return reply(res, 405, { ok: false, error: "POST required." });
      clearCookie(res);
      return reply(res, 200, { ok: true });
    }

    const userId = verifySession(readCookie(req));
    if (!userId) return reply(res, 401, { ok: false, authenticated: false });
    const raw = await redis(["GET", "mub:account:id:" + userId]);
    if (!raw) { clearCookie(res); return reply(res, 401, { ok: false, authenticated: false }); }
    const user = JSON.parse(raw);
    return reply(res, 200, { ok: true, authenticated: true, user });
  } catch (error) {
    console.error("MuB account API error:", error?.message || "unknown");
    return reply(res, 503, { ok: false, error: error?.message || "Account service unavailable." });
  }
}
