export async function invokeVercelHandler(handler, request, env) {
  const url = new URL(request.url);
  const headers = Object.fromEntries(request.headers.entries());
  const query = Object.fromEntries(url.searchParams.entries());
  let body;

  if (request.method !== "GET" && request.method !== "HEAD") {
    const raw = await request.text();
    if (raw) {
      try { body = JSON.parse(raw); }
      catch { body = raw; }
    }
  }

  const req = { method: request.method, url: request.url, headers, query, body };
  const responseHeaders = new Headers();
  let statusCode = 200;
  let responseBody;
  let hasResponseBody = false;
  const res = {
    status(code) { statusCode = Number(code) || 200; return this; },
    setHeader(name, value) { responseHeaders.set(name, String(value)); return this; },
    getHeader(name) { return responseHeaders.get(name); },
    json(value) {
      responseHeaders.set("Content-Type", "application/json; charset=utf-8");
      responseBody = JSON.stringify(value);
      hasResponseBody = true;
      return new Response(responseBody, { status: statusCode, headers: responseHeaders });
    },
    send(value) {
      responseBody = typeof value === "string" ? value : JSON.stringify(value);
      hasResponseBody = true;
      return new Response(responseBody, { status: statusCode, headers: responseHeaders });
    },
    end(value = "") {
      responseBody = value;
      hasResponseBody = true;
      return new Response(responseBody, { status: statusCode, headers: responseHeaders });
    }
  };

  const returned = await handler(req, res, env);
  if (returned instanceof Response) return returned;
  if (hasResponseBody) return new Response(responseBody, { status: statusCode, headers: responseHeaders });
  return Response.json({ ok: false, error: "API handler returned no response" }, { status: 500 });
}
