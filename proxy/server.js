// ============================================================================
// strkprice pool API — tiny zero-dependency proxy for strkprice.com
//
// The shielded page on GitHub Pages (static) can't call Voyager directly,
// because the Voyager API key must never ship to the browser. This service
// holds the key server-side (Railway env var VOYAGER_API_KEY), calls Voyager's
// token-balances endpoint for the privacy pool, sums the USD value of every
// asset, fetches Starknet's total TVL from DeFiLlama, and returns the result
// as JSON. The page polls GET /api/pool for a live, Voyager-exact number.
//
// Responses are cached in-memory for CACHE_MS so many visitors can't blow the
// Voyager rate limit — Voyager is hit at most once per cache window.
// ============================================================================

const http = require('node:http');

const PORT = process.env.PORT || 3000;
const VOYAGER_API_KEY = process.env.VOYAGER_API_KEY;
const POOL_ADDRESS =
  process.env.POOL_ADDRESS ||
  '0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a';

const VOYAGER_URL = `https://api.voyager.online/beta/contracts/${POOL_ADDRESS}/token-balances`;
const DEFILLAMA_URL = 'https://api.llama.fi/v2/chains';
const GECKOTERMINAL_URL = 'https://api.geckoterminal.com/api/v2/simple/networks/starknet-alpha/token_price/';

const CACHE_MS = Number(process.env.CACHE_MS || 20_000); // 20s
const FETCH_TIMEOUT_MS = 12_000;

// Origins allowed to read this API from the browser. Extra origins can be
// added via ALLOWED_ORIGINS (comma-separated) without a code change.
const ALLOWED_ORIGINS = new Set(
  [
    'https://strkprice.com',
    'https://www.strkprice.com',
    'https://calcutatator.github.io',
    'http://localhost:8080',
    'http://localhost:3000',
    'http://127.0.0.1:8080',
    ...(process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  ].filter(Boolean)
);

let cache = { at: 0, data: null };

function withTimeout(promise, ms) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, done: () => clearTimeout(id) };
}

async function fetchJson(url, headers) {
  const t = withTimeout(null, FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: headers || {}, signal: t.signal });
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    return await res.json();
  } finally {
    t.done();
  }
}

async function getStarknetTvl() {
  try {
    const chains = await fetchJson(DEFILLAMA_URL);
    const s = Array.isArray(chains)
      ? chains.find((c) => (c.name || '').toLowerCase() === 'starknet')
      : null;
    return s && typeof s.tvl === 'number' ? s.tvl : null;
  } catch (e) {
    console.warn('DeFiLlama TVL failed:', e.message);
    return null;
  }
}

// Normalise a Starknet address for matching (lowercase, strip leading zeros).
function normAddr(a) {
  if (!a) return '';
  return '0x' + String(a).toLowerCase().replace(/^0x/, '').replace(/^0+/, '');
}

function toDecimals(d) {
  if (d == null) return 18;
  const s = String(d);
  return s.startsWith('0x') ? parseInt(s, 16) : parseInt(s, 10);
}

function emptyish(v) {
  return v == null || String(v).trim() === '';
}

// Last-known good price per token address — tertiary fallback so a token that
// both Voyager and GeckoTerminal momentarily fail to price keeps its value.
const lastPrice = new Map();

// GeckoTerminal price fallback (keyless, by contract address). Voyager's price
// feed intermittently drops individual tokens (e.g. WBTC, xSTRK) for extended
// periods — returning their balance but a null price/usdBalance — which would
// otherwise swing the pool total by tens of thousands of dollars. We only use
// this for the tokens Voyager fails to price; everything else stays Voyager.
async function getGeckoPrices(addresses) {
  if (!addresses.length) return {};
  try {
    const data = await fetchJson(GECKOTERMINAL_URL + addresses.join(','), { accept: 'application/json' });
    const raw = data?.data?.attributes?.token_prices || {};
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      const p = parseFloat(v);
      if (isFinite(p) && p > 0) out[normAddr(k)] = p;
    }
    return out;
  } catch (e) {
    console.warn('GeckoTerminal fallback failed:', e.message);
    return {};
  }
}

async function computePool() {
  if (!VOYAGER_API_KEY) throw new Error('VOYAGER_API_KEY not configured');

  const [voyager, starknetTvl] = await Promise.all([
    fetchJson(VOYAGER_URL, { accept: 'application/json', 'x-api-key': VOYAGER_API_KEY }),
    getStarknetTvl(),
  ]);

  const balances = Array.isArray(voyager?.erc20TokenBalances)
    ? voyager.erc20TokenBalances
    : [];

  // Tokens Voyager couldn't price (null price AND empty usdBalance) → GeckoTerminal.
  const needPrice = balances
    .filter((t) => emptyish(t.price) && emptyish(t.usdBalance))
    .map((t) => t.address);
  const gecko = await getGeckoPrices(needPrice);

  let usd = 0;
  const unpriced = [];
  const tokens = [];
  for (const t of balances) {
    const key = normAddr(t.address);
    const voyPrice = emptyish(t.price) ? null : Number(t.price);
    const voyUsd = emptyish(t.usdBalance) ? null : parseFloat(t.usdBalance);
    let u;

    if (voyUsd != null && isFinite(voyUsd)) {
      // Voyager priced it — trust Voyager exactly so the total matches Voyager.
      u = voyUsd;
      if (voyPrice) lastPrice.set(key, voyPrice);
    } else {
      // Voyager couldn't price it — GeckoTerminal, then last-known price.
      const price = gecko[key] ?? voyPrice ?? lastPrice.get(key);
      if (price && isFinite(price)) {
        u = (Number(t.balance) / 10 ** toDecimals(t.decimals)) * price;
        lastPrice.set(key, price);
      } else {
        u = 0;
        unpriced.push(t.symbol);
      }
    }
    usd += u;
    tokens.push({ symbol: t.symbol, address: t.address, usd: u });
  }
  tokens.sort((a, b) => b.usd - a.usd);

  const pct = starknetTvl && starknetTvl > 0 ? (usd / starknetTvl) * 100 : null;

  return {
    t: new Date().toISOString(),
    usd,
    starknet_tvl: starknetTvl,
    pct,
    tokenCount: tokens.length,
    unpriced,
    tokens,
  };
}

async function getPool() {
  const now = Date.now();
  if (cache.data && now - cache.at < CACHE_MS) return cache.data;
  const data = await computePool();
  cache = { at: now, data };
  return data;
}

function corsHeaders(origin) {
  const allow = origin && ALLOWED_ORIGINS.has(origin) ? origin : 'https://strkprice.com';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const cors = corsHeaders(origin);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }

  const { pathname } = new URL(req.url, 'http://localhost');

  if (pathname === '/api/pool') {
    try {
      const data = await getPool();
      res.writeHead(200, {
        ...cors,
        'content-type': 'application/json',
        'cache-control': 'public, max-age=15',
      });
      res.end(JSON.stringify(data));
    } catch (e) {
      console.error('computePool failed:', e.message);
      res.writeHead(502, { ...cors, 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }

  if (pathname === '/' || pathname === '/health') {
    res.writeHead(200, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'strkprice-pool-api', pool: POOL_ADDRESS }));
    return;
  }

  res.writeHead(404, { ...cors, 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, () => {
  console.log(`strkprice-pool-api listening on :${PORT}`);
});
