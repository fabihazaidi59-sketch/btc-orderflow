const WebSocket = require('ws');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');

const SUPABASE_URL = 'https://howzzoedgffdvikmgizl.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhvd3p6b2VkZ2ZmZHZpa21naXpsIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MDIyNDcyNSwiZXhwIjoyMDk1ODAwNzI1fQ.GQi7YtKHzdglJEzpNXgVEQqCVCMNWqmTZcf_CVLNfuE';
const SYMBOL = 'btcusdt';
const CANDLE_SIZE_BTC = 1.0;
const LOOKBACK = 5;
const VOTE_THRESHOLD = 0.05;
const VOTE_PASS = 12;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const app = express();
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  next();
});

let orderBook = { bids: {}, asks: {} };
let currentCandle = null;
let cumulativeDelta = 0;
let candleCount = 0;
let obiHistory = [];
let recentCandles = [];
let tickBuffer = [];
let isInsertingCandle = false;

function calcOBI(b, a) {
  const bv = b.reduce((s, [, q]) => s + parseFloat(q), 0);
  const av = a.reduce((s, [, q]) => s + parseFloat(q), 0);
  const t = bv + av;
  return t ? (bv - av) / t : 0;
}

function calcWOBI(b, a) {
  let bw = 0, aw = 0;
  b.forEach(([, q], i) => bw += parseFloat(q) / (i + 1));
  a.forEach(([, q], i) => aw += parseFloat(q) / (i + 1));
  const t = bw + aw;
  return t ? (bw - aw) / t : 0;
}

function calcWall(b, a) {
  if (!b.length || !a.length) return 0;
  const ab = b.reduce((s, [, q]) => s + parseFloat(q), 0) / b.length;
  const aa = a.reduce((s, [, q]) => s + parseFloat(q), 0) / a.length;
  const bb = b.filter(([, q]) => parseFloat(q) > ab * 3).length;
  const ba = a.filter(([, q]) => parseFloat(q) > aa * 3).length;
  return Math.max(-1, Math.min(1, (bb - ba) / Math.max(1, bb + ba)));
}

function calcSpread(b, a) {
  if (!b.length || !a.length) return 0;
  const sp = parseFloat(a[0][0]) - parseFloat(b[0][0]);
  const mid = (parseFloat(a[0][0]) + parseFloat(b[0][0])) / 2;
  return mid ? (sp / mid) * 100 : 0;
}

function calcVel(b, a) {
  const bv = b.reduce((s, [, q]) => s + parseFloat(q), 0);
  const av = a.reduce((s, [, q]) => s + parseFloat(q), 0);
  return bv + av > 0 ? Math.max(-1, Math.min(1, (bv - av) / (bv + av))) : 0;
}

function getConsensus(candles) {
  if (candles.length < LOOKBACK) return 'NONE';
  const window = candles.slice(-LOOKBACK);
  let bullVotes = 0, bearVotes = 0;
  const voteKeys = ['wobi', 'obi_roc', 'aggression'];
  window.forEach(c => {
    voteKeys.forEach(k => {
      const v = c[k] || 0;
      if (v > VOTE_THRESHOLD) bullVotes++;
      else if (v < -VOTE_THRESHOLD) bearVotes++;
    });
  });
  const votingResult = bullVotes >= VOTE_PASS ? 'BULL' : bearVotes >= VOTE_PASS ? 'BEAR' : 'NONE';
  if (votingResult === 'NONE') return 'NONE';
  const cdNow = candles[candles.length - 1].cum_delta;
  const cdThen = candles[candles.length - LOOKBACK].cum_delta;
  const cdChange = cdNow - cdThen;
  if (votingResult === 'BULL' && cdChange > 0) return 'BULL';
  if (votingResult === 'BEAR' && cdChange < 0) return 'BEAR';
  return 'BLOCKED';
}

function getOrderBookSnapshot() {
  const bids = Object.entries(orderBook.bids)
    .sort((a, b) => parseFloat(b[0]) - parseFloat(a[0])).slice(0, 20);
  const asks = Object.entries(orderBook.asks)
    .sort((a, b) => parseFloat(a[0]) - parseFloat(b[0])).slice(0, 20);
  return { bids, asks };
}

async function sealCandle() {
  if (!currentCandle || isInsertingCandle) return;
  isInsertingCandle = true;
  try {
    const { bids, asks } = getOrderBookSnapshot();
    const obi = calcOBI(bids, asks);
    const wobi = calcWOBI(bids, asks);
    const wall = calcWall(bids, asks);
    const spread = calcSpread(bids, asks);
    const vel = calcVel(bids, asks);
    const aggression = currentCandle.buyVol - currentCandle.sellVol > 0
      ? currentCandle.buyVol / (currentCandle.buyVol + currentCandle.sellVol) * 2 - 1
      : currentCandle.buyVol / (currentCandle.buyVol + currentCandle.sellVol) * 2 - 1;

    obiHistory.push(obi);
    const prevObi = obiHistory.length > LOOKBACK
      ? obiHistory[obiHistory.length - LOOKBACK - 1] : obi;
    const obiRoc = obi - prevObi;

    candleCount++;
    const sealed = {
      candle_num: candleCount,
      ts_open: currentCandle.tsOpen,
      ts_close: Date.now(),
      open: currentCandle.open,
      high: currentCandle.high,
      low: currentCandle.low,
      close: currentCandle.close,
      volume: parseFloat(currentCandle.volume.toFixed(8)),
      buy_vol: parseFloat(currentCandle.buyVol.toFixed(8)),
      sell_vol: parseFloat(currentCandle.sellVol.toFixed(8)),
      delta: parseFloat((currentCandle.buyVol - currentCandle.sellVol).toFixed(8)),
      cum_delta: parseFloat(cumulativeDelta.toFixed(8)),
      trade_count: currentCandle.tradeCount,
      obi: parseFloat(obi.toFixed(6)),
      wobi: parseFloat(wobi.toFixed(6)),
      obi_roc: parseFloat(obiRoc.toFixed(6)),
      aggression: parseFloat(aggression.toFixed(6)),
      vel: parseFloat(vel.toFixed(6)),
      wall: parseFloat(wall.toFixed(6)),
      spread_pct: parseFloat(spread.toFixed(6)),
      consensus: 'NONE'
    };

    recentCandles.push(sealed);
    if (recentCandles.length > 500) recentCandles.shift();

    sealed.consensus = getConsensus(recentCandles);

    const { error } = await supabase.from('candles').insert(sealed);
    if (error) console.error('Candle insert error:', error.message);

    // flush tick buffer
    if (tickBuffer.length > 0) {
      const toInsert = tickBuffer.splice(0, tickBuffer.length);
      const { error: te } = await supabase.from('ticks').insert(toInsert);
      if (te) console.error('Tick insert error:', te.message);
    }

    // cleanup old data
    const cutoff48h = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const cutoff7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    supabase.from('ticks').delete().lt('created_at', cutoff48h).then(() => {});
    supabase.from('candles').delete().lt('created_at', cutoff7d).then(() => {});

    console.log(`Candle #${candleCount} sealed | close=${sealed.close} | delta=${sealed.delta} | consensus=${sealed.consensus}`);
    currentCandle = null;
  } catch (err) {
    console.error('Seal error:', err.message);
  }
  isInsertingCandle = false;
}

function processTick(price, qty, isBuyerMaker, timestamp) {
  const aggressiveBuy = !isBuyerMaker;
  if (aggressiveBuy) cumulativeDelta += qty;
  else cumulativeDelta -= qty;

  tickBuffer.push({ t: timestamp, p: price, q: qty, m: isBuyerMaker });

  if (!currentCandle) {
    currentCandle = {
      tsOpen: timestamp, open: price, high: price,
      low: price, close: price,
      volume: 0, buyVol: 0, sellVol: 0, tradeCount: 0
    };
  }

  currentCandle.high = Math.max(currentCandle.high, price);
  currentCandle.low = Math.min(currentCandle.low, price);
  currentCandle.close = price;
  currentCandle.volume += qty;
  currentCandle.tradeCount++;
  if (aggressiveBuy) currentCandle.buyVol += qty;
  else currentCandle.sellVol += qty;

  if (currentCandle.volume >= CANDLE_SIZE_BTC) {
    sealCandle();
  }
}

// REST API endpoints for browser
app.get('/candles', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 500;
    const { data, error } = await supabase
      .from('candles').select('*')
      .order('candle_num', { ascending: true })
      .limit(limit);
    if (error) throw error;
    res.json({ candles: data, cum_delta: cumulativeDelta, candle_count: candleCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/latest', (req, res) => {
  const { bids, asks } = getOrderBookSnapshot();
  res.json({
    current_candle: currentCandle,
    cum_delta: cumulativeDelta,
    candle_count: candleCount,
    order_book: { bids: bids.slice(0, 10), asks: asks.slice(0, 10) },
    recent_candles: recentCandles.slice(-10)
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', candles: candleCount, cum_delta: cumulativeDelta });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// WebSocket connections
function connectBook() {
  const ws = new WebSocket('wss://fstream.binance.com/ws/' + SYMBOL + '@depth20@100ms');
  ws.on('open', () => console.log('Order book connected'));
  ws.on('message', (data) => {
    try {
      const d = JSON.parse(data);
      orderBook.bids = {};
      orderBook.asks = {};
      (d.b || []).forEach(([p, q]) => { if (parseFloat(q) > 0) orderBook.bids[p] = q; });
      (d.a || []).forEach(([p, q]) => { if (parseFloat(q) > 0) orderBook.asks[p] = q; });
    } catch (e) {}
  });
  ws.on('close', () => { console.log('Book closed, reconnecting...'); setTimeout(connectBook, 3000); });
  ws.on('error', () => { ws.terminate(); setTimeout(connectBook, 3000); });
}

function connectTrades() {
  const ws = new WebSocket('wss://fstream.binance.com/ws/' + SYMBOL + '@aggTrade');
  ws.on('open', () => console.log('Trade stream connected'));
  ws.on('message', (data) => {
    try {
      const t = JSON.parse(data);
      const price = parseFloat(t.p);
      const qty = parseFloat(t.q);
      if (price > 0 && qty > 0) processTick(price, qty, t.m, t.T);
    } catch (e) {}
  });
  ws.on('close', () => { console.log('Trades closed, reconnecting...'); setTimeout(connectTrades, 3000); });
  ws.on('error', () => { ws.terminate(); setTimeout(connectTrades, 3000); });
}

connectBook();
connectTrades();
console.log('BTC Order Flow server starting...');
