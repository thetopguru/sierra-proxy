// Sierra Proxy — HTML Parsing Version

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

const cache = new Map();
const CACHE_TTL = 120 * 1000; // 120 сек

function badHost(u) {
  try {
    const h = new URL(u).hostname.toLowerCase();
    return !h.endsWith("sierra.com");
  } catch {
    return true;
  }
}

async function getSierraDataFromHTML(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9"
    }
  });

  if (res.status !== 200) {
    throw new Error(`HTML fetch failed: ${res.status}`);
  }

  const html = await res.text();

  // Ищем window.__STATE__ = {...};
  const match = html.match(/window\.__STATE__\s*=\s*(\{.*?\});/s);
  if (!match) throw new Error("window.__STATE__ not found");

  let state;
  try {
    state = JSON.parse(match[1]);
  } catch (err) {
    throw new Error("Failed to parse __STATE__ JSON");
  }

  // Попробуем найти inventory / items
  let items = [];
  try {
    // У Sierra часто данные лежат так: state.product.inventory.items
    items = state.product?.inventory?.items || [];
  } catch (e) {
    throw new Error("No items found in state");
  }

  if (!items.length) throw new Error("No inventory items");

  const prices = items.map(i => i.salePrice).filter(p => p !== null && p !== undefined);
  const sizes = items.map(i => i.skuSize).filter(Boolean);
  const availability = [...new Set(items.map(i => i.availability))];
  const flags = [...new Set(items.flatMap(i => i.flags || []))];
  const minPrice = prices.length ? Math.min(...prices) : null;

  return { minPrice, sizes, availability, flags };
}

module.exports = async (req, res) => {
  try {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.status(204).end();

    const { url } = req.query || {};
    if (!url) return res.status(400).json({ error: "Missing url" });
    if (badHost(url)) return res.status(400).json({ error: "Invalid host" });

    const cacheKey = url;
    const now = Date.now();
    if (cache.has(cacheKey)) {
      const { ts, data } = cache.get(cacheKey);
      if (now - ts < CACHE_TTL) {
        return res.status(200).json({ ...data, cached: true });
      }
    }

    const data = await getSierraDataFromHTML(url);
    cache.set(cacheKey, { ts: now, data });

    return res.status(200).json({ ...data, cached: false });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
};
