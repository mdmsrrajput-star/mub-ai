import test from "node:test";
import assert from "node:assert/strict";
import { analyzeHeikinAshi } from "./heikin-ashi.js";

function makeCandles(direction, count = 30) {
  const rows = [];
  let close = 100;
  for (let i = 0; i < count; i++) {
    const open = close;
    close += direction === "BUY" ? 1 : -1;
    rows.push({
      time: 1_700_000_000 + i * 60,
      open,
      high: Math.max(open, close) + 0.05,
      low: Math.min(open, close) - 0.05,
      close,
      volume: 10
    });
  }
  return rows;
}

test("recognizes a strong bullish Heikin Ashi candle", () => {
  const result = analyzeHeikinAshi(makeCandles("BUY"));
  assert.equal(result.direction, "BUY");
  assert.equal(result.strong, true);
  assert.equal(result.uncertain, false);
  assert.equal(result.stochastic.ready, true);
});

test("recognizes a strong bearish Heikin Ashi candle", () => {
  const result = analyzeHeikinAshi(makeCandles("SELL"));
  assert.equal(result.direction, "SELL");
  assert.equal(result.strong, true);
  assert.equal(result.uncertain, false);
  assert.equal(result.stochastic.ready, true);
});

test("returns WAIT for insufficient candle history", () => {
  const result = analyzeHeikinAshi(makeCandles("BUY", 10));
  assert.equal(result.direction, "WAIT");
  assert.equal(result.uncertain, true);
});

test("rejects a flat doji-like market as uncertain", () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({
    time: 1_700_000_000 + i * 60,
    open: 100, high: 100, low: 100, close: 100, volume: 10
  }));
  const result = analyzeHeikinAshi(rows);
  assert.equal(result.direction, "WAIT");
  assert.equal(result.strong, false);
  assert.equal(result.uncertain, true);
});
