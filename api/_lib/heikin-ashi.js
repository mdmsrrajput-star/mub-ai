/**
 * Heikin Ashi confirmation for MuB's PAPER_ONLY signal engine.
 * Input candles must already be closed, chronological OHLC candles.
 * Stochastic defaults: %K 14, %D 3. These are configurable defaults,
 * not parameters specified in the supplied strategy PDF.
 */
export function analyzeHeikinAshi(candles) {
  if (!Array.isArray(candles) || candles.length < 20) {
    return {
      direction: "WAIT", strong: false, uncertain: true,
      bodyRatio: null, upperWickRatio: null, lowerWickRatio: null,
      stochastic: { k: null, d: null, direction: "WAIT", ready: false }
    };
  }

  const ha = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const close = (Number(c.open) + Number(c.high) + Number(c.low) + Number(c.close)) / 4;
    const open = i === 0
      ? (Number(c.open) + Number(c.close)) / 2
      : (ha[i - 1].open + ha[i - 1].close) / 2;
    ha.push({
      time: Number(c.time),
      open,
      close,
      high: Math.max(Number(c.high), open, close),
      low: Math.min(Number(c.low), open, close)
    });
  }

  const last = ha[ha.length - 1];
  const range = last.high - last.low;
  const body = Math.abs(last.close - last.open);
  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerWick = Math.min(last.open, last.close) - last.low;
  const bodyRatio = range > 0 ? body / range : 0;
  const upperWickRatio = range > 0 ? upperWick / range : 1;
  const lowerWickRatio = range > 0 ? lowerWick / range : 1;
  const direction = range > 0
    ? (last.close > last.open ? "BUY" : last.close < last.open ? "SELL" : "WAIT")
    : "WAIT";
  const strong = direction !== "WAIT" &&
    bodyRatio >= 0.55 &&
    upperWick <= body * 0.5 &&
    lowerWick <= body * 0.5;
  const uncertain = direction === "WAIT" || bodyRatio < 0.20 ||
    upperWick > body * 1.5 || lowerWick > body * 1.5;

  const lookback = 14;
  const rawK = [];
  for (let i = Math.max(lookback - 1, ha.length - 3); i < ha.length; i++) {
    const window = candles.slice(i - lookback + 1, i + 1);
    if (window.length !== lookback) continue;
    const highest = Math.max(...window.map(x => Number(x.high)));
    const lowest = Math.min(...window.map(x => Number(x.low)));
    const k = highest > lowest
      ? ((Number(candles[i].close) - lowest) / (highest - lowest)) * 100
      : 50;
    rawK.push(k);
  }
  const k = rawK.length ? rawK[rawK.length - 1] : null;
  const d = rawK.length >= 3
    ? rawK.slice(-3).reduce((sum, value) => sum + value, 0) / 3
    : null;
  let stochasticDirection = "WAIT";
  if (Number.isFinite(k) && Number.isFinite(d)) {
    if (k > d && k > 50 && k < 85) stochasticDirection = "BUY";
    else if (k < d && k < 50 && k > 15) stochasticDirection = "SELL";
  }

  return {
    direction,
    strong,
    uncertain,
    bodyRatio: Number(bodyRatio.toFixed(4)),
    upperWickRatio: Number(upperWickRatio.toFixed(4)),
    lowerWickRatio: Number(lowerWickRatio.toFixed(4)),
    candleTime: last.time,
    candle: last,
    stochastic: {
      k: Number.isFinite(k) ? Number(k.toFixed(2)) : null,
      d: Number.isFinite(d) ? Number(d.toFixed(2)) : null,
      direction: stochasticDirection,
      ready: Number.isFinite(k) && Number.isFinite(d)
    }
  };
}
