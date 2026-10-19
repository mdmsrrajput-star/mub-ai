export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return res.status(405).json({ error: "Method not allowed" }); }
  const symbols = { EURUSD:"EUR/USD", GBPUSD:"GBP/USD", USDJPY:"USD/JPY", AUDUSD:"AUD/USD", USDCAD:"USD/CAD", USDCHF:"USD/CHF", NZDUSD:"NZD/USD", EURJPY:"EUR/JPY", GBPJPY:"GBP/JPY", XAGUSD:"XAG/USD" };
  const symbol = String(req.query?.symbol || "EURUSD").toUpperCase();
  const requested = String(req.query?.timeframe || "5m");
  const intervals = { "1m": "1min", "5m": "5min", "15m": "15min", "30m": "30min", "1h": "1h", "4h": "4h", "1d": "1day" };
  if (!symbols[symbol] || !intervals[requested]) return res.status(400).json({ error: "Unsupported market symbol or timeframe" });
  const key = process.env.TWELVE_DATA_API_KEY;
  if (!key) return res.status(503).json({ error: "TWELVE_DATA_API_KEY is not configured" });
  async function candles(tf, size=180) {
    const url = "https://api.twelvedata.com/time_series?symbol=" + encodeURIComponent(symbols[symbol]) + "&interval=" + encodeURIComponent(intervals[tf]) + "&outputsize=" + size + "&timezone=UTC&apikey=" + encodeURIComponent(key);
    const r = await fetch(url, { cache: "no-store", headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error("Twelve Data HTTP " + r.status);
    const d = await r.json();
    if (d.status === "error" || !Array.isArray(d.values)) throw new Error(String(d.message || "No candle data").slice(0, 160));
    return d.values.map(v => ({ time: Math.floor(Date.parse(v.datetime + " UTC")/1000), open:Number(v.open), high:Number(v.high), low:Number(v.low), close:Number(v.close), volume:0 })).filter(c => Number.isFinite(c.time) && [c.open,c.high,c.low,c.close].every(n=>Number.isFinite(n)&&n>0)).reverse();
  }
  try {
    const trendTf = ({ "1m":"15m", "5m":"15m", "15m":"1h", "30m":"1h", "1h":"4h", "4h":"1d", "1d":"1d" })[requested];
    const [cs, trend] = await Promise.all([candles(requested), candles(trendTf, 100)]);
    if (cs.length < 55 || trend.length < 50) throw new Error("Insufficient completed market candles");
    const closes = cs.map(c=>c.close);
    const ema = (a,n) => { const k=2/(n+1); let v=a[0]; return a.map((x,i)=>(v=i?x*k+v*(1-k):x)); };
    const e20=ema(closes,20), e50=ema(closes,50), te20=ema(trend.map(c=>c.close),20), te50=ema(trend.map(c=>c.close),50);
    let gains=0,losses=0; for(let i=closes.length-14;i<closes.length;i++){const d=closes[i]-closes[i-1];gains+=Math.max(d,0);losses+=Math.max(-d,0);}
    const rsi=losses===0?100:100-100/(1+gains/losses);
    const bullish=e20.at(-1)>e50.at(-1), trendBull=te20.at(-1)>te50.at(-1);
    let score=50; if(bullish===trendBull)score+=20; if(rsi>50&&rsi<70&&bullish)score+=15; if(rsi<50&&rsi>30&&!bullish)score+=15;
    const signal=score>=65?(bullish?"BUY":"SELL"):"WAIT";
    const last=cs.at(-1), blocks=[];
    for(let i=cs.length-1;i>=Math.max(2,cs.length-18);i--){const a=cs[i-2],b=cs[i-1],c=cs[i]; const displacement=Math.abs(b.close-b.open); if(displacement < Math.abs(b.close)*0.00035) continue; if(c.low>a.high){blocks.push({direction:"BULLISH",lower:a.high,upper:c.low,formedAt:c.time,retested:cs.slice(i+1).some(x=>x.low<=c.low&&x.high>=a.high),reaction:cs.slice(i+1).some(x=>x.close>c.low)});break;} if(c.high<a.low){blocks.push({direction:"BEARISH",lower:c.high,upper:a.low,formedAt:c.time,retested:cs.slice(i+1).some(x=>x.high>=c.high&&x.low<=a.low),reaction:cs.slice(i+1).some(x=>x.close<c.high)});break;} }
    return res.status(200).json({ ok:true, mode:"PAPER_ONLY", liveTradingEnabled:false, symbol, interval:requested, signal, score, candlesUsed:cs.length, generatedAt:new Date().toISOString(), indicators:{ema20:e20.at(-1),ema50:e50.at(-1),rsi14:rsi,macd:0,macdSignal:0,atr14:0}, trend:trendBull?"BULLISH":"BEARISH", reasons:["EMA20/EMA50 trend filter","Higher-timeframe trend confirmation","RSI14: "+rsi.toFixed(1)], orderBlocks:blocks, candles:cs });
  } catch(e) { return res.status(502).json({ error:e.message || "Market signal calculation failed" }); }
}
