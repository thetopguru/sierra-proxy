const express = require("express");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
const app = express();

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

// Простой кэш (живёт внутри процесса)
const cache = new Map();
const CACHE_TTL = 120 * 1000; // 120 сек

function okUrl(u) {
  try {
    const h = new URL(u).hostname.toLowerCase();
    return h.endsWith("sierra.com");
  } catch {
    return false;
  }
}

async function fetchHtmlViaScrapingBee(url) {
  const key = process.env.SCRAPINGBEE_KEY;
  if (!key) {
    throw new Error("SCRAPINGBEE_KEY is not set in environment");
  }

  const api = "https://app.scrapingbee.com/api/v1/";
  const qs = new URLSearchParams({
    api_key: key,
    url,
    render_js: "true",          // выполнить JS
    premium_proxy: "true",      // включить stealth/residential
    country_code: "US",         // гео — США
    block_resources: "false",   // не резать ресурсы, пусть страница загрузится «как есть»
    timeout: "30000"            // мс
  });

  const res = await fetch(`${api}?${qs.toString()}`, {
    headers: {
      "User-Agent": UA,
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9"
    }
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`ScrapingBee HTTP ${res.status}: ${txt.slice(0, 300)}`);
  }
  return res.text();
}

// Универсальный парсер window.__STATE__
function extractState(html) {
  // Вариант 1: до закрывающего </script>
  let m = html.match(/window\.__STATE__\s*=\s*(\{[\s\S]*?\});\s*<\/script>/i);
  if (!m) {
    // Вариант 2: до первой точкой с запятой
    m = html.match(/window\.__STATE__\s*=\s*(\{[\s\S]*?\});/i);
  }
  if (!m) throw new Error("window.__STATE__ not found");

  const raw = m[1];
  try {
    return JSON.parse(raw);
  } catch (e) {
    // Иногда встречается HTML-escape — можно попробовать чуть «почистить»
    const unescaped = raw
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
    return JSON.parse(unescaped);
  }
}

function reduceInventory(state) {
  // На Sierra структура может меняться, но чаще всего:
  // state.product.inventory.items
  const items =
    state?.product?.inventory?.items ||
    state?.inventory?.items ||
    [];

  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("No inventory items found in __STATE__");
  }

  const prices = items.map(i => i?.salePrice).filter(p => p !== null && p !== undefined);
  const sizes = items.map(i => i?.skuSize).filter(Boolean);
  const availability = [...new Set(items.map(i => i?.availability).filter(Boolean))];
  const flags = [...new Set(items.flatMap(i => (i?.flags || [])).filter(Boolean))];
  const minPrice = prices.length ? Math.min(...prices) : null;

  return { minPrice, sizes, availability, flags };
}

app.get("/api/sierra", async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: "Missing url" });
    if (!okUrl(url)) return res.status(400).json({ error: "URL must be on sierra.com" });

    // Кэш ключом берём сам URL
    const now = Date.now();
    const key = `u:${url}`;
    const cached = cache.get(key);
    if (cached && now - cached.ts < CACHE_TTL) {
      return res.json({ ...cached.data, cached: true });
    }

    // Тянем HTML через ScrapingBee и парсим
    const html = await fetchHtmlViaScrapingBee(url);
    const state = extractState(html);
    const data = reduceInventory(state);

    cache.set(key, { ts: now, data });
    return res.json({ ...data, cached: false });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sierra proxy (ScrapingBee) on ${PORT}`));
