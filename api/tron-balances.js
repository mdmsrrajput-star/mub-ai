
const USDT_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const TRON_API = "https://api.trongrid.io";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({
      ok: false,
      error: "Method not allowed"
    });
  }

  const address =
    typeof req.query.address === "string"
      ? req.query.address.trim()
      : "";

  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) {
    return res.status(400).json({
      ok: false,
      error: "A valid TRON address is required."
    });
  }

  const headers = { Accept: "application/json" };

  if (process.env.TRONGRID_API_KEY) {
    headers["TRON-PRO-API-KEY"] =
      process.env.TRONGRID_API_KEY;
  }

  try {
    const accountUrl =
      `${TRON_API}/v1/accounts/${encodeURIComponent(address)}`;

    const tokenUrl =
      `${accountUrl}/trc20/balance?contract_address=` +
      `${encodeURIComponent(USDT_CONTRACT)}&limit=200`;

    const [accountResponse, tokenResponse] = await Promise.all([
      fetch(accountUrl, { headers }),
      fetch(tokenUrl, { headers })
    ]);

    if (!accountResponse.ok || !tokenResponse.ok) {
      return res.status(502).json({
        ok: false,
        error: "TRON data provider unavailable. Try again later."
      });
    }

    const [accountData, tokenData] = await Promise.all([
      accountResponse.json(),
      tokenResponse.json()
    ]);

    const account = Array.isArray(accountData.data)
      ? accountData.data[0]
      : null;

    const rawTrx = Number(account?.balance ?? 0);

    if (!Number.isFinite(rawTrx) || rawTrx < 0) {
      return res.status(502).json({
        ok: false,
        error: "Invalid TRX balance response."
      });
    }

    const tokenRows = Array.isArray(tokenData.data)
      ? tokenData.data
      : [];

    let rawUsdt = "0";

    for (const row of tokenRows) {
      if (row?.[USDT_CONTRACT] != null) {
        rawUsdt = String(row[USDT_CONTRACT]);
        break;
      }
    }

    if (!/^\d+$/.test(rawUsdt)) {
      return res.status(502).json({
        ok: false,
        error: "Invalid USDT balance response."
      });
    }

    return res.status(200).json({
      ok: true,
      network: "TRON Mainnet",
      address,
      trx: rawTrx / 1_000_000,
      usdt: Number(rawUsdt) / 1_000_000,
      token: "USDT",
      standard: "TRC20",
      tokenContract: USDT_CONTRACT,
      checkedAt: new Date().toISOString(),
      mode: "READ_ONLY",
      transactionsEnabled: false
    });
  } catch (error) {
    console.error("TRON balance lookup failed:", error.message);

    return res.status(502).json({
      ok: false,
      error: "Could not reach the TRON data provider."
    });
  }
      }
