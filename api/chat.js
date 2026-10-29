module.exports = async function handler(req, res) {
  // Keep Google account actions inside this existing function so the Vercel
  // Hobby deployment stays within its 12-function limit.
  const query = req.query || {};
  let body = req.body || {};
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const authAction = req.method === "GET"
    ? String(query.action || "")
    : String(body.action || "");

  if (["login", "logout", "me"].includes(authAction)) {
    return handleMuBAuth(req, res, authAction, body);
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { message } = body;
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Message is required" });
    }
    const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
    if (!apiKey) {
      return res.status(500).json({ error: "OPENAI_API_KEY is missing." });
    }
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "gpt-6-luna",
        instructions: "You are MuB, a helpful personal AI assistant. Be clear, practical, friendly, and concise. Help the user solve problems rather than merely describing them.",
        input: message
      })
    });
    const data = await response.json();
    if (!response.ok) {
      console.error("OpenAI API error:", data);
      return res.status(response.status).json({ error: "MuB could not get a response from the AI service." });
    }
    return res.status(200).json({ reply: data.output_text || "MuB could not generate a response." });
  } catch (error) {
    console.error("Server error:", error);
    return res.status(500).json({ error: error?.message || "Unknown server error" });
  }
};

async function handleMuBAuth(req, res, action, body) {
  const crypto = await import("node:crypto");
  const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "1064070440957-1ial119jci1jninb5t10stg5p79bttpi.apps.googleusercontent.com";
  const SESSION_SECRET = process.env.MUB_AUTH_SESSION_SECRET || process.env.TOURNAMENT_SESSION_SECRET || "";
  const SESSION_COOKIE = "mub_auth_session";
  const SESSION_SECONDS = 60 * 60 * 24 * 7;
  const redis = async (command) => {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) throw new Error("Account storage is not configured. Check Upstash Redis environment variables in Vercel.");
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(command)
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data || data.error) throw new Error("Account storage is temporarily unavailable.");
    return data.result;
  };
  const b64 = (value) => Buffer.from(value).toString("base64url");
  const sign = (value) => crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("base64url");
  const makeSession = (userId) => {
    const payload = b64(JSON.stringify({ sub: userId, exp: Date.now() + SESSION_SECONDS * 1000 }));
    return payload + "." + sign(payload);
  };
  const readCookie = () => {
    const raw = String(req.headers.cookie || "");
    const item = raw.split(";").map(x => x.trim()).find(x => x.startsWith(SESSION_COOKIE + "="));
    if (!item) return "";
    try { return decodeURIComponent(item.slice(SESSION_COOKIE.length + 1)); } catch { return ""; }
  };
  const verifySession = (token) => {
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
  };
  const setCookie = (token) => res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_SECONDS}`);
  const clearCookie = () => res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
  const reply = (status, data) => res.status(status).json({ mode: "PAPER_ONLY", realTradingEnabled: false, ...data });

  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return reply(405, { ok: false, error: "Use GET or POST." });
  }
  if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
    return reply(503, { ok: false, error: "Account sessions are not configured. Set MUB_AUTH_SESSION_SECRET to a random secret of at least 32 characters in Vercel." });
  }

  try {
    if (action === "login") {
      if (req.method !== "POST") return reply(405, { ok: false, error: "POST required." });
      const credential = String(body.credential || "");
      if (!credential || credential.length > 10000) return reply(400, { ok: false, error: "Google sign-in credential is missing or invalid." });
      const verifyResponse = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(credential), { cache: "no-store" });
      if (!verifyResponse.ok) return reply(401, { ok: false, error: "Google sign-in could not be verified. Please try again." });
      const claims = await verifyResponse.json();
      if (claims.aud !== CLIENT_ID ||
          !["accounts.google.com", "https://accounts.google.com"].includes(claims.iss) ||
          claims.email_verified !== "true" || !claims.sub || !claims.email ||
          !Number.isFinite(Number(claims.exp)) || Number(claims.exp) * 1000 <= Date.now()) {
        return reply(401, { ok: false, error: "Google account verification failed." });
      }

      const googleSub = String(claims.sub);
      const email = String(claims.email).trim().toLowerCase();
      const profileKey = "mub:account:google:" + crypto.createHash("sha256").update(googleSub).digest("hex");
      const existingRaw = await redis(["GET", profileKey]);
      let profile = null;
      if (existingRaw) { try { profile = JSON.parse(existingRaw); } catch {} }

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
      } else {
        profile.displayName = String(claims.name || profile.displayName || "MuB User").replace(/[<>]/g, "").trim().slice(0, 40) || "MuB User";
        profile.email = email;
        profile.picture = typeof claims.picture === "string" && claims.picture.startsWith("https://") ? claims.picture : (profile.picture || "");
      }
      await redis(["SET", profileKey, JSON.stringify(profile)]);
      await redis(["SET", "mub:account:id:" + profile.id, JSON.stringify(profile)]);
      await redis(["SET", "mub:account:email:" + crypto.createHash("sha256").update(email).digest("hex"), profile.id]);
      setCookie(makeSession(profile.id));
      return reply(200, { ok: true, user: profile, message: "Signed in to MuB." });
    }

    if (action === "logout") {
      if (req.method !== "POST") return reply(405, { ok: false, error: "POST required." });
      clearCookie();
      return reply(200, { ok: true });
    }

    const userId = verifySession(readCookie());
    if (!userId) return reply(200, { ok: true, authenticated: false, user: null });
    const raw = await redis(["GET", "mub:account:id:" + userId]);
    if (!raw) { clearCookie(); return reply(200, { ok: true, authenticated: false, user: null }); }
    return reply(200, { ok: true, authenticated: true, user: JSON.parse(raw) });
  } catch (error) {
    console.error("MuB account API error:", error?.message || "unknown");
    return reply(503, { ok: false, error: "MuB account service is temporarily unavailable." });
  }
};
