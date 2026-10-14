
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  const symbol = String(req.query?.symbol || "BTCUSDT")
    .toUpperCase();

  const allowed = ["BTCUSDT", "ETHUSDT"];

  if (!allowed.includes(symbol)) {
    return res.status(400).json({
      error: "Supported symbols: BTCUSDT, ETHUSDT"
    });
  }

  try {
    const url =
      "https://data-api.binance.vision/api/v3/klines" +
      "?symbol=" + encodeURIComponent(symbol) +
      "&interval=5m&limit=150";

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error("Market data HTTP " + response.status);
    }

    const rows = await response.json();

    if (!Array.isArray(rows) || rows.length < 60) {
      throw new Error("Insufficient candle history");
    }

    // Exclude the currently forming candle.
    const nowSeconds = Math.floor(Date.now() / 1000);
    const candles = rows
      .filter(k => Math.floor(Number(k[0]) / 1000) + 300 <= nowSeconds)
      .map(k => ({
        time: Math.floor(Number(k[0]) / 1000),
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4])
      }));

    const closes = candles.map(c => c.close);

    function ema(values, period) {
      const alpha = 2 / (period + 1);
      let value = values[0];

      for (let i = 1; i < values.length; i++) {
        value = values[i] * alpha + value * (1 - alpha);
      }

      return value;
    }

    function rsi(values, period = 14) {
      let gains = 0;
      let losses = 0;

      for (let i = 1; i <= period; i++) {
        const change = values[i] - values[i - 1];
        gains += Math.max(change, 0);
        losses += Math.max(-change, 0);
      }

      let avgGain = gains / period;
      let avgLoss = losses / period;

      for (let i = period + 1; i < values.length; i++) {
        const change = values[i] - values[i - 1];

        avgGain =
          (avgGain * (period - 1) + Math.max(change, 0)) / period;

        avgLoss =
          (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
      }

      if (avgLoss === 0) return 100;

      return 100 - 100 / (1 + avgGain / avgLoss);
    }

    function atr(data, period = 14) {
      const ranges = [];

      for (let i = 1; i < data.length; i++) {
        ranges.push(Math.max(
          data[i].high - data[i].low,
          Math.abs(data[i].high - data[i - 1].close),
          Math.abs(data[i].low - data[i - 1].close)
        ));
      }

      let value = ranges.slice(0, period)
        .reduce((sum, n) => sum + n, 0) / period;

      for (let i = period; i < ranges.length; i++) {
        value = (value * (period - 1) + ranges[i]) / period;
      }

      return value;
    }

    const fastEMA = ema(closes.slice(-100), 20);
    const slowEMA = ema(closes.slice(-100), 50);
    const rsi14 = rsi(closes);
    const atr14 = atr(candles);

    // MACD: calculate EMA series so both lines use matching history.
    function emaSeries(values, period) {
      const alpha = 2 / (period + 1);
      const result = [];
      let value = values[0];

      for (let i = 0; i < values.length; i++) {
        value = i === 0
          ? values[i]
          : values[i] * alpha + value * (1 - alpha);

        result.push(value);
      }

      return result;
    }

    const fastSeries = emaSeries(closes, 12);
    const slowSeries = emaSeries(closes, 26);
    const macdLine = closes.map(
      (_, i) => fastSeries[i] - slowSeries[i]
    );

    const signalLine = emaSeries(macdLine, 9);
    const macd = macdLine[macdLine.length - 1];
    const macdSignal = signalLine[signalLine.length - 1];

    let score = 0;
    const reasons = [];

    if (fastEMA > slowEMA) {
      score++;
      reasons.push("EMA20 above EMA50");
    } else {
      score--;
      reasons.push("EMA20 below EMA50");
    }

    if (rsi14 > 50 && rsi14 < 70) {
      score++;
      reasons.push("RSI bullish but not overbought");
    } else if (rsi14 < 50 && rsi14 > 30) {
      score--;
      reasons.push("RSI bearish but not oversold");
    } else {
      reasons.push("RSI outside preferred momentum range");
    }

    if (macd > macdSignal) {
      score++;
      reasons.push("MACD above signal line");
    } else {
      score--;
      reasons.push("MACD below signal line");
    }

    const signal =
      score >= 2 ? "BUY" :
      score <= -2 ? "SELL" : "WAIT";

    return res.status(200).json({
      mode: "PAPER_ONLY",
      executionEnabled: false,
      symbol,
      interval: "5m",
      signal,
      score,
      reasons,
      indicators: {
        ema20: fastEMA,
        ema50: slowEMA,
        rsi14,
        macd,
        macdSignal,
        atr14
      },
      candle: candles[candles.length - 1],
      candlesUsed: candles.length,
      generatedAt: new Date().toISOString(),
      note: "Experimental indicator signal, not a guaranteed prediction."
    });
  } catch (error) {
    return res.status(502).json({
      error: "Signal calculation failed",
      detail: error.message
    });
  }
}
  
