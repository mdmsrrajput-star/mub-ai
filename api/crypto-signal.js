
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

  if (!["BTCUSDT", "ETHUSDT"].includes(symbol)) {
    return res.status(400).json({
      error: "Supported symbols: BTCUSDT, ETHUSDT"
    });
  }

  const requestedTimeframe = String(req.query?.timeframe || "5m");
  const timeframeMap = {
    "1m": { interval: "1m", seconds: 60, trend: "15m", trendSeconds: 900 },
    "3m": { interval: "3m", seconds: 180, trend: "15m", trendSeconds: 900 },
    "5m": { interval: "5m", seconds: 300, trend: "15m", trendSeconds: 900 },
    "15m": { interval: "15m", seconds: 900, trend: "1h", trendSeconds: 3600 },
    "30m": { interval: "30m", seconds: 1800, trend: "2h", trendSeconds: 7200 },
    "1h": { interval: "1h", seconds: 3600, trend: "4h", trendSeconds: 14400 },
    "4h": { interval: "4h", seconds: 14400, trend: "1d", trendSeconds: 86400 },
    "1d": { interval: "1d", seconds: 86400, trend: "1w", trendSeconds: 604800 },
    "1w": { interval: "1w", seconds: 604800, trend: "1M", trendSeconds: 2592000 }
  };
  const tf = timeframeMap[requestedTimeframe];
  if (!tf) return res.status(400).json({ error: "Unsupported signal timeframe. Use 1m, 3m, 5m, 15m, 30m, 1h, 4h, 1d, or 1w." });

  const emaSeries = (values, period) => {
    const alpha = 2 / (period + 1);
    let value = values[0];

    return values.map((v, i) => {
      value = i === 0
        ? v
        : v * alpha + value * (1 - alpha);
      return value;
    });
  };

  const rsi = (values, period = 14) => {
    if (values.length <= period) return 50;

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
  };

  const atr = (candles, period = 14) => {
    const ranges = [];

    for (let i = 1; i < candles.length; i++) {
      const c = candles[i];
      const prev = candles[i - 1];

      ranges.push(Math.max(
        c.high - c.low,
        Math.abs(c.high - prev.close),
        Math.abs(c.low - prev.close)
      ));
    }

    if (ranges.length < period) return 0;

    let value = ranges.slice(0, period)
      .reduce((sum, n) => sum + n, 0) / period;

    for (let i = period; i < ranges.length; i++) {
      value = (value * (period - 1) + ranges[i]) / period;
    }

    return value;
  };

  async function fetchCandles(interval, durationSeconds, limit) {
    const url =
      "https://data-api.binance.vision/api/v3/klines" +
      "?symbol=" + encodeURIComponent(symbol) +
      "&interval=" + interval +
      "&limit=" + limit;

    const response = await fetch(url, {
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error("Market data HTTP " + response.status);
    }

    const rows = await response.json();

    if (!Array.isArray(rows)) {
      throw new Error("Invalid market data");
    }

    const now = Math.floor(Date.now() / 1000);

    return rows
      // Exclude the currently forming candle.
      .filter(k =>
        Math.floor(Number(k[0]) / 1000) + durationSeconds <= now
      )
      .map(k => ({
        time: Math.floor(Number(k[0]) / 1000),
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
        volume: Number(k[5])
      }));
  }

  try {
    const [candles, trendCandles] = await Promise.all([
      fetchCandles(tf.interval, tf.seconds, 180),
      fetchCandles(tf.trend, tf.trendSeconds, 120)
    ]);

    if (candles.length < 60 || trendCandles.length < 55) {
      throw new Error("Insufficient completed candle history for " + tf.interval + " / " + tf.trend);
    }

    const closes = candles.map(c => c.close);
    const last = candles[candles.length - 1];

    const ema20Series = emaSeries(closes, 20);
    const ema50Series = emaSeries(closes, 50);

    const ema20 = ema20Series[ema20Series.length - 1];
    const ema50 = ema50Series[ema50Series.length - 1];

    const rsi14 = rsi(closes);
    const atr14 = atr(candles);

    const macdFast = emaSeries(closes, 12);
    const macdSlow = emaSeries(closes, 26);

    const macdLine = closes.map(
      (_, i) => macdFast[i] - macdSlow[i]
    );

    const signalSeries = emaSeries(macdLine, 9);
    const macd = macdLine[macdLine.length - 1];
    const macdSignal = signalSeries[signalSeries.length - 1];

    const trendCloses = trendCandles.map(c => c.close);
    const trendEma20 = emaSeries(trendCloses, 20).at(-1);
    const trendEma50 = emaSeries(trendCloses, 50).at(-1);

    const trend =
      trendEma20 > trendEma50 ? "BULLISH" :
      trendEma20 < trendEma50 ? "BEARISH" :
      "NEUTRAL";

    // Strict three-candle fair value gap detection.
    // Only use completed candles, recent gaps, and meaningful displacement.
    let fvg = null;

    if (atr14 > 0) {
      const firstIndex = Math.max(2, candles.length - 20);

      for (let i = candles.length - 1; i >= firstIndex; i--) {
        const a = candles[i - 2];
        const b = candles[i - 1];
        const c = candles[i];

        const displacement = Math.abs(b.close - b.open);

        if (displacement < atr14 * 0.8) continue;

        // Bullish FVG: third candle low is above first candle high.
        if (c.low > a.high) {
          const gap = c.low - a.high;

          if (gap >= atr14 * 0.1) {
            fvg = {
              direction: "BULLISH",
              lower: a.high,
              upper: c.low,
              formedAt: c.time,
              gap,
              retested: false,
              reaction: false,
              ageCandles: 0
            };
            break;
          }
        }

        // Bearish FVG: third candle high is below first candle low.
        if (c.high < a.low) {
          const gap = a.low - c.high;

          if (gap >= atr14 * 0.1) {
            fvg = {
              direction: "BEARISH",
              lower: c.high,
              upper: a.low,
              formedAt: c.time,
              gap,
              retested: false,
              reaction: false,
              ageCandles: 0
            };
            break;
          }
        }
      }
    }

    if (fvg) {
      const later = candles.filter(c => c.time > fvg.formedAt);

      fvg.ageCandles = later.length;

      fvg.retested = later.some(c =>
        c.low <= fvg.upper && c.high >= fvg.lower
      );

      // Require a completed candle to close away from the gap.
      fvg.reaction = fvg.direction === "BULLISH"
        ? last.close > fvg.upper && last.close > last.open
        : last.close < fvg.lower && last.close < last.open;
    }

    // Heuristic order-block detection from completed candles at the selected chart timeframe.
    // A candidate is the last opposite-colour candle before a strong move
    // that closes beyond the prior five-candle structure.
    const orderBlocks = [];
    if (atr14 > 0) {
      const first = Math.max(5, candles.length - 45);
      for (let i = candles.length - 4; i >= first; i--) {
        const candidate = candles[i];
        const bullishCandidate = candidate.close < candidate.open;
        const bearishCandidate = candidate.close > candidate.open;
        if (!bullishCandidate && !bearishCandidate) continue;
        let found = null;
        for (let j = i + 1; j <= Math.min(i + 3, candles.length - 1); j++) {
          const impulse = candles[j];
          const body = Math.abs(impulse.close - impulse.open);
          if (body < atr14 * 0.8) continue;
          const prior = candles.slice(Math.max(0, i - 5), i);
          const priorHigh = Math.max(...prior.map(x => x.high));
          const priorLow = Math.min(...prior.map(x => x.low));
          if (bullishCandidate && impulse.close > priorHigh && impulse.close > impulse.open) {
            found = { direction: "BULLISH", lower: candidate.low, upper: candidate.high, formedAt: candidate.time };
            break;
          }
          if (bearishCandidate && impulse.close < priorLow && impulse.close < impulse.open) {
            found = { direction: "BEARISH", lower: candidate.low, upper: candidate.high, formedAt: candidate.time };
            break;
          }
        }
        if (found) {
          const later = candles.filter(x => x.time > found.formedAt);
          found.ageCandles = later.length;
          found.retested = later.some(x => x.low <= found.upper && x.high >= found.lower);
          found.reaction = found.direction === "BULLISH"
            ? last.close > found.upper && last.close > last.open
            : last.close < found.lower && last.close < last.open;
          found.fresh = !found.retested;
          orderBlocks.push(found);
          if (orderBlocks.length >= 2) break;
        }
      }
    }
    const bullishOB = orderBlocks.find(b => b.direction === "BULLISH");
    const bearishOB = orderBlocks.find(b => b.direction === "BEARISH");

    // Three independent directional filters.
    const votes = [
      {
        name: "EMA trend",
        side: ema20 > ema50 ? "BUY" :
          ema20 < ema50 ? "SELL" : "WAIT"
      },
      {
        name: "RSI momentum",
        side: rsi14 > 52 && rsi14 < 68 ? "BUY" :
          rsi14 < 48 && rsi14 > 32 ? "SELL" : "WAIT"
      },
      {
        name: "MACD",
        side: macd > macdSignal ? "BUY" :
          macd < macdSignal ? "SELL" : "WAIT"
      }
    ];

    const buyVotes = votes.filter(v => v.side === "BUY").length;
    const sellVotes = votes.filter(v => v.side === "SELL").length;

    const agreementPercent =
      Math.max(buyVotes, sellVotes) / votes.length * 100;

    const reasons = [
      "Analysis uses completed " + tf.interval + " candles",
      tf.trend + " trend: " + trend,
      "Indicator agreement: " + agreementPercent.toFixed(0) + "%",
      fvg
        ? "Recent FVG: " + fvg.direction
        : "No qualifying recent FVG",
      orderBlocks.length
        ? "Order blocks: " + orderBlocks.map(b => b.direction + (b.retested ? " retested" : " fresh") + (b.reaction ? " with reaction" : "")).join(", ")
        : "No qualifying recent order block"
    ];

    let signal = "WAIT";

    // All filters must agree. Agreement is not win probability.
    if (
      fvg &&
      fvg.ageCandles > 0 &&
      fvg.ageCandles <= 12 &&
      fvg.retested &&
      fvg.reaction &&
      bullishOB && bullishOB.retested && bullishOB.reaction && bullishOB.ageCandles > 0 && bullishOB.ageCandles <= 12 &&
      fvg.direction === "BULLISH" &&
      trend === "BULLISH" &&
      buyVotes === 3
    ) {
      signal = "BUY";
      reasons.push("Bullish FVG retest and reaction confirmed");
    } else if (
      fvg &&
      fvg.ageCandles > 0 &&
      fvg.ageCandles <= 12 &&
      fvg.retested &&
      fvg.reaction &&
      bearishOB && bearishOB.retested && bearishOB.reaction && bearishOB.ageCandles > 0 && bearishOB.ageCandles <= 12 &&
      fvg.direction === "BEARISH" &&
      trend === "BEARISH" &&
      sellVotes === 3
    ) {
      signal = "SELL";
      reasons.push("Bearish FVG retest and reaction confirmed");
    } else {
      reasons.push(
        "Strict conditions not all satisfied; waiting is intentional"
      );
    }

    return res.status(200).json({
      mode: "PAPER_ONLY",
      executionEnabled: false,
      liveTradingEnabled: false,
      symbol,
      interval: tf.interval,
      trendInterval: tf.trend,
      signal,
      score: buyVotes - sellVotes,
      agreementPercent,
      agreementIsWinProbability: false,
      votes,
      reasons,
      fvg,
      orderBlocks,
      trend,
      indicators: {
        ema20,
        ema50,
        rsi14,
        macd,
        macdSignal,
        atr14,
        trendEma20,
        trendEma50
      },
      candle: last,
      candlesUsed: candles.length,
      generatedAt: new Date().toISOString(),
      note:
        "Experimental indicator filter only. No guarantee of profit. " +
        "Paper mode only; this endpoint never places orders."
    });
  } catch (error) {
    console.error("Signal calculation failed:", error.message);

    return res.status(502).json({
      mode: "PAPER_ONLY",
      executionEnabled: false,
      liveTradingEnabled: false,
      error: "Signal calculation failed",
      detail:
        "Market data unavailable or incomplete. Fail closed; do not trade."
    });
  }
                }
