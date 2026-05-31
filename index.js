const WebSocket = require('ws');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');

const SUPABASE_URL = 'https://howzzoedgffdvikmgizl.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhvd3p6b2VkZ2ZmZHZpa21naXpsIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MDIyNDcyNSwiZXhwIjoyMDk1ODAwNzI1fQ.GQi7YtKHzdglJEzpNXgVEQqCVCMNWqmTZcf_CVLNfuE';
const SYMBOL = 'btcusdt';
const CANDLE_SIZE_BTC = 0.1;
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
let totalTicks = 0;
let obiHistory = [];
let recentCandles = [];
let tickBuffer = [];
let isInsertingCandle = false;
let activeTradeStream = 'none';

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
    const total = currentCandle.buyVol + currentCandle.sellVol;
    const aggression = total > 0 ? (currentCandle.buyVol - currentCandle.sellVol) / total : 0;

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
    else console.log(`Candle #${candleCount} sealed | close=${sealed.close} | delta=${sealed.delta.toFixed(4)} | consensus=${sealed.consensus} | stream=${activeTradeStream}`);

    if (tickBuffer.length > 0) {
      const toInsert = tickBuffer.splice(0, tickBuffer.length);
      const { error: te } = await supabase.from('ticks').insert(toInsert);
      if (te) console.error('Tick insert error:', te.message);
    }

    const cutoff48h = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const cutoff7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    supabase.from('ticks').delete().lt('created_at', cutoff48h).then(() => {});
    supabase.from('candles').delete().lt('created_at', cutoff7d).then(() => {});

    currentCandle = null;
  } catch (err) {
    console.error('Seal error:', err.message);
    currentCandle = null;
  }
  isInsertingCandle = false;
}

function processTick(price, qty, isBuyerMaker, timestamp) {
  totalTicks++;
  if (totalTicks % 100 === 0) {
    console.log(`Ticks: ${totalTicks} | cum_delta: ${cumulativeDelta.toFixed(4)} | candles: ${candleCount} | vol: ${currentCandle ? currentCandle.volume.toFixed(4) : 0} | stream: ${activeTradeStream}`);
  }
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

function handleTradeMessage(data, streamName) {
  try {
    const raw = data.toString();
    const t = JSON.parse(raw);
    const price = parseFloat(t.p);
    const qty = parseFloat(t.q);
    if (price > 0 && qty > 0) {
      activeTradeStream = streamName;
      processTick(price, qty, t.m, t.T);
    } else {
      console.log('Invalid tick from', streamName, raw.slice(0, 80));
    }
  } catch (e) {
    console.error('Parse error from', streamName, e.message);
  }
}

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
    total_ticks: totalTicks,
    active_stream: activeTradeStream,
    order_book: { bids: bids.slice(0, 10), asks: asks.slice(0, 10) },
    recent_candles: recentCandles.slice(-10)
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', candles: candleCount, cum_delta: cumulativeDelta, ticks: totalTicks, stream: activeTradeStream });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

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
    } catch (e) { console.error('Book parse error:', e.message); }
  });
  ws.on('close', () => { console.log('Book closed, reconnecting...'); setTimeout(connectBook, 3000); });
  ws.on('error', (e) => { console.error('Book error:', e.message); ws.terminate(); setTimeout(connectBook, 3000); });
}

function connectFuturesTrades() {
  const endpoints = [
    'wss://fstream.binance.com/ws/' + SYMBOL + '@aggTrade',
    'wss://fstream1.binance.com/ws/' + SYMBOL + '@aggTrade',
    'wss://fstream2.binance.com/ws/' + SYMBOL + '@aggTrade',
    'wss://fstream3.binance.com/ws/' + SYMBOL + '@aggTrade',
  ];
  let idx = 0;

  function tryNext() {
    const url = endpoints[idx % endpoints.length];
    idx++;
    console.log('Trying futures endpoint:', url);
    const ws = new WebSocket(url);
    let count = 0;

    const timer = setTimeout(() => {
      if (count === 0) {
        console.log('No data from', url, '— trying next endpoint');
        ws.terminate();
        tryNext();
      }
    }, 8000);

    ws.on('open', () => console.log('Futures trade stream opened:', url));
    ws.on('message', (data) => {
      count++;
      if (count === 1) { console.log('SUCCESS: Futures ticks flowing from', url); clearTimeout(timer); }
      handleTradeMessage(data, 'futures:' + url.split('/')[2]);
    });
    ws.on('close', () => { clearTimeout(timer); if (count > 0) { console.log('Futures stream closed, reconnecting...'); setTimeout(() => connectFuturesTrades(), 3000); } });
    ws.on('error', (e) => { clearTimeout(timer); console.error('Futures stream error:', e.message); ws.terminate(); setTimeout(tryNext, 2000); });
  }

  tryNext();
}

function connectSpotTrades() {
  console.log('Starting spot trade stream fallback...');
  const ws = new WebSocket('wss://stream.binance.com:9443/ws/' + SYMBOL + '@aggTrade');
  let count = 0;
  ws.on('open', () => console.log('Spot trade stream opened'));
  ws.on('message', (data) => {
    count++;
    if (count === 1) console.log('SUCCESS: Spot ticks flowing');
    handleTradeMessage(data, 'spot');
  });
  ws.on('close', () => { console.log('Spot stream closed, reconnecting...'); setTimeout(connectSpotTrades, 3000); });
  ws.on('error', (e) => { console.error('Spot stream error:', e.message); ws.terminate(); setTimeout(connectSpotTrades, 3000); });
}

function connectBybitTrades() {
  console.log('Starting Bybit trade stream fallback...');
  const ws = new WebSocket('wss://stream.bybit.com/v5/public/linear');
  let count = 0;
  ws.on('open', () => {
    console.log('Bybit stream opened, subscribing...');
    ws.send(JSON.stringify({ op: 'subscribe', args: ['publicTrade.BTCUSDT'] }));
  });
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.topic && msg.data) {
        msg.data.forEach(t => {
          const price = parseFloat(t.p);
          const qty = parseFloat(t.v);
          const isBuyerMaker = t.S === 'Sell';
          if (price > 0 && qty > 0) {
            count++;
            if (count === 1) console.log('SUCCESS: Bybit ticks flowing');
            activeTradeStream = 'bybit';
            processTick(price, qty, isBuyerMaker, t.T);
          }
        });
      }
    } catch (e) { console.error('Bybit parse error:', e.message); }
  });
  ws.on('close', () => { console.log('Bybit stream closed, reconnecting...'); setTimeout(connectBybitTrades, 3000); });
  ws.on('error', (e) => { console.error('Bybit stream error:', e.message); ws.terminate(); setTimeout(connectBybitTrades, 3000); });
}

connectBook();
connectFuturesTrades();
setTimeout(connectSpotTrades, 10000);
setTimeout(connectBybitTrades, 20000);

console.log('BTC Order Flow server starting...');
console.log('Will try: Binance futures → Binance spot → Bybit');
