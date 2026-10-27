import crypto from "node:crypto";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "1064070440957-kuihr9e5r7go5qv87nks4igmnbbfum0a.apps.googleusercontent.com";
const SESSION_SECRET = process.env.MUB_AUTH_SESSION_SECRET || "";
const SESSION_COOKIE = "mub_session";
const SESSION_SECONDS = 60 * 60 * 24 * 7;

async function redis(command) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Account storage is not configured.");
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(command)
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data || data.error) throw new Error("Account storage unavailable.");
  return data.result;
}

function b64(value) {
  return Buffer.from(value).toString("base64url");
}
function sign(value) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("base64url");
}
function makeSession(userId) {
  const payload = b64(JSON.stringify({ sub: userId, exp: Date.now() + SESSION_SECONDS * 1000 }));
  return payload + "." + sign(payload);
}
function readCookie(req) {
  const raw = String(req.headers.cookie || "");
  const entry = raw.split(";").map(x => x.trim()).find(x => x.startsWith(SESSION_COOKIE + "="));
  if (!entry) return "";
  try { return decodeURIComponent(entry.slice(SESSION_COOKIE.length + 1)); } catch { return ""; }
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
function reply(res, status, body) {
  return res.status(status).json({ ok: status < 400, ...body });
}
async function getProfile(userId) {
  const raw = await redis(["GET", `mub:user:${userId}`]);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "GET") {
    const userId = verifySession(readCookie(req));
    if (!userId) return reply(res, 200, { user: null });
    try {
      const user = await getProfile(userId);
      if (!user) { clearCookie(res); return reply(res, 200, { user: null }); }
      return reply(res, 200, { user });
    } catch {
      return reply(res, 503, { error: "Account service temporarily unavailable." });
    }
  }
  if (req.method === "POST") {
    const action = String(req.body?.action || "");
    if (action === "logout") {
      clearCookie(res);
      return reply(res, 200, { user: null });
    }
    if (action !== "login" || typeof req.body?.credential !== "string") {
      return reply(res, 400, { error: "A Google credential is required." });
    }
    if (!SESSION_SECRET) return reply(res, 503, { error: "Set MUB_AUTH_SESSION_SECRET in Vercel environment variables before enabling login." });
    try {
      // Validate the Google ID token server-side; never trust browser-supplied profile fields.
      const response = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(req.body.credential));
      if (!response.ok) return reply(res, 401, { error: "Google sign-in could not be verified. Please try again." });
      const claims = await response.json();
      if (
        claims.aud !== CLIENT_ID ||
        !["accounts.google.com", "https://accounts.google.com"].includes(claims.iss) ||
        claims.email_verified !== "true" ||
        !claims.sub ||
        !claims.email
      ) return reply(res, 401, { error: "Google returned an invalid or unverified account." });

      const userId = "mub_" + crypto.createHash("sha256").update(String(claims.sub)).digest("hex").slice(0, 20);
      const existing = await getProfile(userId);
      const user = {
        id: userId,
        name: String(claims.name || claims.given_name || claims.email.split("@")[0]).slice(0, 80),
        email: String(claims.email).toLowerCase().slice(0, 254),
        picture: typeof claims.picture === "string" ? claims.picture.slice(0, 1000) : "",
        createdAt: existing?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      await redis(["SET", `mub:user:${userId}`, JSON.stringify(user)]);
      setCookie(res, makeSession(userId));
      return reply(res, 200, { user });
    } catch {
      return reply(res, 503, { error: "Sign-in service is temporarily unavailable." });
    }
  }
  res.setHeader("Allow", "GET, POST");
  return reply(res, 405, { error: "Method not allowed." });
}
