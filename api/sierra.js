// === Sierra Proxy with Cookies + Retry + Cache ===

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

// Простейший кэш в памяти (живёт, пока инстанс функции не перезапущен)
const cache = new Map();
const CACHE_TTL = 120 * 1000; // 120 сек

function getSetCookiesArray(res) {
  if (typeof res.headers.getSetCookie === "function") {
    return res.headers.getSetCookie();
  }
  if (typeof res.headers.raw === "function") {
    return res.headers.raw()["set-cookie"] || [];
  }
  const single = res.headers.get("set-cookie");
  return single ? [single] : [];
}

function mergeCookies(jar, setCookies) {
  for (const sc of setCookies) {
    const [nv] = sc.split(";");
    const eq = nv.indexOf("=");
    if (eq > 0) {
      const name = nv.slice(0, eq).trim();
      const val = nv.slice(eq + 1).trim();
      if (name && val) jar.set(name, val);
    }
  }
}

async function fetchWithRedirects(url, headers, maxHops = 5, cookieJar = new Map()) {
  let current = url;
  for (let i = 0; i < maxHops; i++) {
    const res = await fetch(current, { headers, redirect: "manual" });
    mergeCookies(cookieJar, getSetCookiesArray(res));
    if (![301, 302, 303, 307, 308].includes(res.status)) {
      return { res, cookieJar };
    }
    const loc = res.headers.get("location");
    if (!loc) return { res, cookieJar };
    current = new URL(loc, current).toString();
  }
  throw new Error("Too many redirects");
}

function cookieHeaderFromJar(jar) {
  return Array.from(jar.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function badHost(u) {
  try {
    const h = new URL(u).hostname.toLowerCase();
    return !h.endsWith("sierra.com");
  } catch {
    return true;
  }
}

async function getSierraData(itemCode, url) {
  // Шаг 1: открыть страницу, получить куки
  const commonHeaders = {
    "User-Agent": UA,
    "Accept":
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
  };
  const { cookieJar } = await fetchWithRedirects(url, commonHeaders, 5, new Map());

  // Шаг 2: запросить API
  const apiUrl = `https://www.sierra.com/api/product/inventory/${encodeURIComponent(itemCode)}`;
  const apiHeaders = {
    "User-Agent": UA,
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": url,
    "Cache-Control": "no-cache",
  };
  const cookieHeader = cookieHeaderFromJar(cookieJar);
  if (cookieHeader) apiHeaders["Cookie"] = cookieHeader;

  let apiRes = await fetch(apiUrl, { headers: apiHeaders });
  if (apiRes.status !== 200) {
    // Прогрев: ещё раз загрузим страницу и повторим API-запрос
    const warm = await fetchWithRedirects(url, commonHeaders, 5, cookieJar);
    const warmedCookieHeader = cookieHeaderFromJar(warm.cookieJar);
    if (warmedCookieHeader) apiHeaders["Cookie"] = warmedCookieHeader;
    apiRes = await fetch(apiUrl, { headers: apiHeaders });
  }

  if (apiRes.status !== 200) {
    throw new Error(`Upstream ${apiRes.status}: ${await apiRes.text()}`);
  }

  const json = await apiRes.json();
  if (!json.items || !json.items.length) throw new Error("Нет items");

  // Обработка данных: только нужные поля
  const prices = json.items.map(i => i.salePrice).filter(p => p !== null && p !== undefined);
  const sizes = json.items.map(i => i.skuSize).filter(Boolean);
  const availability = [...new Set(json.items.map(i => i.availability))];
  const flags = [...new Set(json.items.flatMap(i => i.flags || []))];
  const minPrice = prices.length ? Math.min(...prices) : null;

  return { minPrice, sizes, availability, flags };
}

module.exports = async (req, res) => {
  try {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.status(204).end();

    const { itemCode, url } = req.query || {};
    if (!itemCode || !url) return res.status(400).json({ error: "Missing itemCode or url" });
    if (badHost(url)) return res.status(400).json({ error: "Invalid referer host (must be sierra.com)" });

    // Проверка кэша
    const cacheKey = `${itemCode}::${url}`;
    const now = Date.now();
    if (cache.has(cacheKey)) {
      const { ts, data } = cache.get(cacheKey);
      if (now - ts < CACHE_TTL) {
        return res.status(200).json({ ...data, cached: true });
      }
    }

    const data = await getSierraData(itemCode, url);

    // Сохраняем в кэш
    cache.set(cacheKey, { ts: now, data });

    return res.status(200).json({ ...data, cached: false });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
};
