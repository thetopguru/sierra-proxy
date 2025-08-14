const express = require("express");
const fs = require("fs");
const app = express();

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

// поддерживаем оба названия переменной
const SCRAPINGBEE_KEY =
  process.env.SCRAPINGBEE_KEY || process.env.SCRAPINGBEE_API_KEY;

// простой кэш в памяти
const cache = new Map();
const CACHE_TTL_MS = 90 * 1000;

function okUrl(u) {
  try {
    const h = new URL(u).hostname.toLowerCase();
    return h.endsWith("sierra.com");
  } catch {
    return false;
  }
}

async function fetchHtmlViaScrapingBee(url, debug = false) {
  if (!SCRAPINGBEE_KEY) {
    throw new Error(
      "SCRAPINGBEE_KEY (или SCRAPINGBEE_API_KEY) не задан в переменных окружения"
    );
  }

  const api = "https://app.scrapingbee.com/api/v1/";
  const qs = new URLSearchParams({
    api_key: SCRAPINGBEE_KEY,
    url,
    render_js: "true",
    premium_proxy: "true",
    country_code: "US",
    block_resources: "false",
    // важно: используем wait (мс), а не wait_browser с неправильным значением
    wait: "5000",
    timeout: "60000",
  });

  const resp = await fetch(`${api}?${qs.toString()}`, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`ScrapingBee HTTP ${resp.status}: ${txt.slice(0, 300)}`);
  }

  const html = await resp.text();

  if (debug) {
    console.log("===== HTML START =====");
    console.log(html.slice(0, 30000));
    console.log("===== HTML END =====");
    try {
      fs.writeFileSync("/tmp/page.html", html);
      console.log("Full HTML saved to /tmp/page.html");
    } catch (e) {
      console.log("Save /tmp/page.html failed:", e.message);
    }
  }

  return html;
}

// вытаскиваем ВСЕ объекты из dataLayer.push({...})
function extractAllDataLayerObjects(html) {
  const out = [];
  const re = /dataLayer\.push\(\s*(\{[\s\S]*?\})\s*\);/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1];
    try {
      out.push(JSON.parse(raw));
    } catch {
      // на всякий случай пробуем раскодировать HTML-сущности
      const unescaped = raw
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");
      try {
        out.push(JSON.parse(unescaped));
      } catch {
        // пропускаем
      }
    }
  }
  return out;
}

function extractFromMeta(html) {
  // простые мета-теги: цена и доступность
  const meta = {};
  const metaPrice = html.match(
    /<meta[^>]+name=["']product:price:amount["'][^>]+content=["']([\d.]+)["']/i
  );
  if (metaPrice) meta.price = parseFloat(metaPrice[1]);

  const currency = html.match(
    /<meta[^>]+name=["']product:price:currency["'][^>]+content=["']([A-Z]{3})["']/i
  );
  if (currency) meta.currency = currency[1];

  const avail = html.match(
    /<meta[^>]+name=["']og:availability["'][^>]+content=["']([^"']+)["']/i
  );
  if (avail) meta.availability = avail[1];

  const title = html.match(/<title>\s*([\s\S]*?)\s*<\/title>/i);
  if (title) meta.title = title[1].trim();

  // запасной способ вытащить цену из текста
  if (!meta.price) {
    const priceInText = html.match(
      /"price"\s*:\s*([0-9]+(?:\.[0-9]+)?)|>\s*\$([0-9]+(?:\.[0-9]+)?)\s*</i
    );
    if (priceInText) {
      meta.price = parseFloat(priceInText[1] || priceInText[2]);
    }
  }

  return meta;
}

function scanFlags(html) {
  const txt = html.toLowerCase();
  return {
    clearance: /clearance/i.test(txt),
    almostGone: /almost\s+gone/i.test(txt),
    onlyOneLeft: /only\s+one\s+(left|in\s+stock)/i.test(txt),
  };
}

// приводим данные к единому виду
function reduceProduct(dataLayers, html) {
  // ищем событие PDP с ecommerce.detail.products
  const dlWithProducts =
    dataLayers.find(
      (o) => o?.ecommerce?.detail?.products && Array.isArray(o.ecommerce.detail.products)
    ) || null;

  const flags = scanFlags(html);
  const meta = extractFromMeta(html);

  let product = {
    source: "fallback",
    id: null,
    name: meta.title || null,
    brand: null,
    category: null,
    variant: null,
    price: meta.price ?? null,
    currency: meta.currency ?? "USD",
    discount: null,
    productParentStock: null,
    productChildStock: null,
    availability: meta.availability || null,
    flags,
  };

  if (dlWithProducts) {
    const p = dlWithProducts.ecommerce.detail.products[0];
    product = {
      source: "dataLayer",
      id: p?.id ?? product.id,
      name: p?.name ?? product.name,
      brand: p?.brand ?? product.brand,
      category: p?.category ?? product.category,
      variant: p?.variant ?? product.variant,
      price: (p?.discountPrice ?? p?.price ?? product.price) ?? null,
      rrPrice: p?.rrPrice ?? null,
      discount: p?.discount ?? product.discount,
      productParentStock: p?.productParentStock ?? product.productParentStock,
      productChildStock: p?.productChildStock ?? product.productChildStock,
      publishDate: p?.publishDate ?? null,
      availability: product.availability, // оставим из meta, если было
      flags,
    };
  }

  return product;
}

async function handleRequest(req, res) {
  try {
    const url = req.query.url;
    const debug = req.query.debug === "1";

    if (!url) return res.status(400).json({ error: "Missing url" });
    if (!okUrl(url)) return res.status(400).json({ error: "URL must be on sierra.com" });

    // кэш
    const key = `u:${url}`;
    const now = Date.now();
    const cached = cache.get(key);
    if (cached && now - cached.ts < CACHE_TTL_MS) {
      return res.json({ ...cached.data, cached: true, cachedAt: cached.ts });
    }

    const html = await fetchHtmlViaScrapingBee(url, debug);
    const dls = extractAllDataLayerObjects(html);
    const data = reduceProduct(dls, html);

    const resp = {
      ...data,
      scrapedAt: new Date().toISOString(),
      cached: false,
    };

    cache.set(key, { ts: now, data: resp });
    return res.json(resp);
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}

// эндпоинты
app.get("/", handleRequest);
app.get("/api/sierra", handleRequest);

// вспомогательный — посмотреть первые символы HTML (для отладки)
app.get("/debugHtml", async (req, res) => {
  try {
    const url = req.query.url;
    if (!url) return res.status(400).send("Missing url");
    const html = await fetchHtmlViaScrapingBee(url, true);
    res.type("text/plain").send(html.slice(0, 50000));
  } catch (e) {
    res.status(500).send(String(e.message || e));
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Sierra proxy running on port ${PORT}`);
});
const express = require("express");
const fs = require("fs");
const app = express();

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

// поддерживаем оба названия переменной
const SCRAPINGBEE_KEY =
  process.env.SCRAPINGBEE_KEY || process.env.SCRAPINGBEE_API_KEY;

// простой кэш в памяти
const cache = new Map();
const CACHE_TTL_MS = 90 * 1000;

function okUrl(u) {
  try {
    const h = new URL(u).hostname.toLowerCase();
    return h.endsWith("sierra.com");
  } catch {
    return false;
  }
}

async function fetchHtmlViaScrapingBee(url, debug = false) {
  if (!SCRAPINGBEE_KEY) {
    throw new Error(
      "SCRAPINGBEE_KEY (или SCRAPINGBEE_API_KEY) не задан в переменных окружения"
    );
  }

  const api = "https://app.scrapingbee.com/api/v1/";
  const qs = new URLSearchParams({
    api_key: SCRAPINGBEE_KEY,
    url,
    render_js: "true",
    premium_proxy: "true",
    country_code: "US",
    block_resources: "false",
    // важно: используем wait (мс), а не wait_browser с неправильным значением
    wait: "5000",
    timeout: "60000",
  });

  const resp = await fetch(`${api}?${qs.toString()}`, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`ScrapingBee HTTP ${resp.status}: ${txt.slice(0, 300)}`);
  }

  const html = await resp.text();

  if (debug) {
    console.log("===== HTML START =====");
    console.log(html.slice(0, 30000));
    console.log("===== HTML END =====");
    try {
      fs.writeFileSync("/tmp/page.html", html);
      console.log("Full HTML saved to /tmp/page.html");
    } catch (e) {
      console.log("Save /tmp/page.html failed:", e.message);
    }
  }

  return html;
}

// вытаскиваем ВСЕ объекты из dataLayer.push({...})
function extractAllDataLayerObjects(html) {
  const out = [];
  const re = /dataLayer\.push\(\s*(\{[\s\S]*?\})\s*\);/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1];
    try {
      out.push(JSON.parse(raw));
    } catch {
      // на всякий случай пробуем раскодировать HTML-сущности
      const unescaped = raw
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");
      try {
        out.push(JSON.parse(unescaped));
      } catch {
        // пропускаем
      }
    }
  }
  return out;
}

function extractFromMeta(html) {
  // простые мета-теги: цена и доступность
  const meta = {};
  const metaPrice = html.match(
    /<meta[^>]+name=["']product:price:amount["'][^>]+content=["']([\d.]+)["']/i
  );
  if (metaPrice) meta.price = parseFloat(metaPrice[1]);

  const currency = html.match(
    /<meta[^>]+name=["']product:price:currency["'][^>]+content=["']([A-Z]{3})["']/i
  );
  if (currency) meta.currency = currency[1];

  const avail = html.match(
    /<meta[^>]+name=["']og:availability["'][^>]+content=["']([^"']+)["']/i
  );
  if (avail) meta.availability = avail[1];

  const title = html.match(/<title>\s*([\s\S]*?)\s*<\/title>/i);
  if (title) meta.title = title[1].trim();

  // запасной способ вытащить цену из текста
  if (!meta.price) {
    const priceInText = html.match(
      /"price"\s*:\s*([0-9]+(?:\.[0-9]+)?)|>\s*\$([0-9]+(?:\.[0-9]+)?)\s*</i
    );
    if (priceInText) {
      meta.price = parseFloat(priceInText[1] || priceInText[2]);
    }
  }

  return meta;
}

function scanFlags(html) {
  const txt = html.toLowerCase();
  return {
    clearance: /clearance/i.test(txt),
    almostGone: /almost\s+gone/i.test(txt),
    onlyOneLeft: /only\s+one\s+(left|in\s+stock)/i.test(txt),
  };
}

// приводим данные к единому виду
function reduceProduct(dataLayers, html) {
  // ищем событие PDP с ecommerce.detail.products
  const dlWithProducts =
    dataLayers.find(
      (o) => o?.ecommerce?.detail?.products && Array.isArray(o.ecommerce.detail.products)
    ) || null;

  const flags = scanFlags(html);
  const meta = extractFromMeta(html);

  let product = {
    source: "fallback",
    id: null,
    name: meta.title || null,
    brand: null,
    category: null,
    variant: null,
    price: meta.price ?? null,
    currency: meta.currency ?? "USD",
    discount: null,
    productParentStock: null,
    productChildStock: null,
    availability: meta.availability || null,
    flags,
  };

  if (dlWithProducts) {
    const p = dlWithProducts.ecommerce.detail.products[0];
    product = {
      source: "dataLayer",
      id: p?.id ?? product.id,
      name: p?.name ?? product.name,
      brand: p?.brand ?? product.brand,
      category: p?.category ?? product.category,
      variant: p?.variant ?? product.variant,
      price: (p?.discountPrice ?? p?.price ?? product.price) ?? null,
      rrPrice: p?.rrPrice ?? null,
      discount: p?.discount ?? product.discount,
      productParentStock: p?.productParentStock ?? product.productParentStock,
      productChildStock: p?.productChildStock ?? product.productChildStock,
      publishDate: p?.publishDate ?? null,
      availability: product.availability, // оставим из meta, если было
      flags,
    };
  }

  return product;
}

async function handleRequest(req, res) {
  try {
    const url = req.query.url;
    const debug = req.query.debug === "1";

    if (!url) return res.status(400).json({ error: "Missing url" });
    if (!okUrl(url)) return res.status(400).json({ error: "URL must be on sierra.com" });

    // кэш
    const key = `u:${url}`;
    const now = Date.now();
    const cached = cache.get(key);
    if (cached && now - cached.ts < CACHE_TTL_MS) {
      return res.json({ ...cached.data, cached: true, cachedAt: cached.ts });
    }

    const html = await fetchHtmlViaScrapingBee(url, debug);
    const dls = extractAllDataLayerObjects(html);
    const data = reduceProduct(dls, html);

    const resp = {
      ...data,
      scrapedAt: new Date().toISOString(),
      cached: false,
    };

    cache.set(key, { ts: now, data: resp });
    return res.json(resp);
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}

// эндпоинты
app.get("/", handleRequest);
app.get("/api/sierra", handleRequest);

// вспомогательный — посмотреть первые символы HTML (для отладки)
app.get("/debugHtml", async (req, res) => {
  try {
    const url = req.query.url;
    if (!url) return res.status(400).send("Missing url");
    const html = await fetchHtmlViaScrapingBee(url, true);
    res.type("text/plain").send(html.slice(0, 50000));
  } catch (e) {
    res.status(500).send(String(e.message || e));
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Sierra proxy running on port ${PORT}`);
});
const express = require("express");
const fs = require("fs");
const app = express();

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

// поддерживаем оба названия переменной
const SCRAPINGBEE_KEY =
  process.env.SCRAPINGBEE_KEY || process.env.SCRAPINGBEE_API_KEY;

// простой кэш в памяти
const cache = new Map();
const CACHE_TTL_MS = 90 * 1000;

function okUrl(u) {
  try {
    const h = new URL(u).hostname.toLowerCase();
    return h.endsWith("sierra.com");
  } catch {
    return false;
  }
}

async function fetchHtmlViaScrapingBee(url, debug = false) {
  if (!SCRAPINGBEE_KEY) {
    throw new Error(
      "SCRAPINGBEE_KEY (или SCRAPINGBEE_API_KEY) не задан в переменных окружения"
    );
  }

  const api = "https://app.scrapingbee.com/api/v1/";
  const qs = new URLSearchParams({
    api_key: SCRAPINGBEE_KEY,
    url,
    render_js: "true",
    premium_proxy: "true",
    country_code: "US",
    block_resources: "false",
    // важно: используем wait (мс), а не wait_browser с неправильным значением
    wait: "5000",
    timeout: "60000",
  });

  const resp = await fetch(`${api}?${qs.toString()}`, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`ScrapingBee HTTP ${resp.status}: ${txt.slice(0, 300)}`);
  }

  const html = await resp.text();

  if (debug) {
    console.log("===== HTML START =====");
    console.log(html.slice(0, 30000));
    console.log("===== HTML END =====");
    try {
      fs.writeFileSync("/tmp/page.html", html);
      console.log("Full HTML saved to /tmp/page.html");
    } catch (e) {
      console.log("Save /tmp/page.html failed:", e.message);
    }
  }

  return html;
}

// вытаскиваем ВСЕ объекты из dataLayer.push({...})
function extractAllDataLayerObjects(html) {
  const out = [];
  const re = /dataLayer\.push\(\s*(\{[\s\S]*?\})\s*\);/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1];
    try {
      out.push(JSON.parse(raw));
    } catch {
      // на всякий случай пробуем раскодировать HTML-сущности
      const unescaped = raw
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");
      try {
        out.push(JSON.parse(unescaped));
      } catch {
        // пропускаем
      }
    }
  }
  return out;
}

function extractFromMeta(html) {
  // простые мета-теги: цена и доступность
  const meta = {};
  const metaPrice = html.match(
    /<meta[^>]+name=["']product:price:amount["'][^>]+content=["']([\d.]+)["']/i
  );
  if (metaPrice) meta.price = parseFloat(metaPrice[1]);

  const currency = html.match(
    /<meta[^>]+name=["']product:price:currency["'][^>]+content=["']([A-Z]{3})["']/i
  );
  if (currency) meta.currency = currency[1];

  const avail = html.match(
    /<meta[^>]+name=["']og:availability["'][^>]+content=["']([^"']+)["']/i
  );
  if (avail) meta.availability = avail[1];

  const title = html.match(/<title>\s*([\s\S]*?)\s*<\/title>/i);
  if (title) meta.title = title[1].trim();

  // запасной способ вытащить цену из текста
  if (!meta.price) {
    const priceInText = html.match(
      /"price"\s*:\s*([0-9]+(?:\.[0-9]+)?)|>\s*\$([0-9]+(?:\.[0-9]+)?)\s*</i
    );
    if (priceInText) {
      meta.price = parseFloat(priceInText[1] || priceInText[2]);
    }
  }

  return meta;
}

function scanFlags(html) {
  const txt = html.toLowerCase();
  return {
    clearance: /clearance/i.test(txt),
    almostGone: /almost\s+gone/i.test(txt),
    onlyOneLeft: /only\s+one\s+(left|in\s+stock)/i.test(txt),
  };
}

// приводим данные к единому виду
function reduceProduct(dataLayers, html) {
  // ищем событие PDP с ecommerce.detail.products
  const dlWithProducts =
    dataLayers.find(
      (o) => o?.ecommerce?.detail?.products && Array.isArray(o.ecommerce.detail.products)
    ) || null;

  const flags = scanFlags(html);
  const meta = extractFromMeta(html);

  let product = {
    source: "fallback",
    id: null,
    name: meta.title || null,
    brand: null,
    category: null,
    variant: null,
    price: meta.price ?? null,
    currency: meta.currency ?? "USD",
    discount: null,
    productParentStock: null,
    productChildStock: null,
    availability: meta.availability || null,
    flags,
  };

  if (dlWithProducts) {
    const p = dlWithProducts.ecommerce.detail.products[0];
    product = {
      source: "dataLayer",
      id: p?.id ?? product.id,
      name: p?.name ?? product.name,
      brand: p?.brand ?? product.brand,
      category: p?.category ?? product.category,
      variant: p?.variant ?? product.variant,
      price: (p?.discountPrice ?? p?.price ?? product.price) ?? null,
      rrPrice: p?.rrPrice ?? null,
      discount: p?.discount ?? product.discount,
      productParentStock: p?.productParentStock ?? product.productParentStock,
      productChildStock: p?.productChildStock ?? product.productChildStock,
      publishDate: p?.publishDate ?? null,
      availability: product.availability, // оставим из meta, если было
      flags,
    };
  }

  return product;
}

async function handleRequest(req, res) {
  try {
    const url = req.query.url;
    const debug = req.query.debug === "1";

    if (!url) return res.status(400).json({ error: "Missing url" });
    if (!okUrl(url)) return res.status(400).json({ error: "URL must be on sierra.com" });

    // кэш
    const key = `u:${url}`;
    const now = Date.now();
    const cached = cache.get(key);
    if (cached && now - cached.ts < CACHE_TTL_MS) {
      return res.json({ ...cached.data, cached: true, cachedAt: cached.ts });
    }

    const html = await fetchHtmlViaScrapingBee(url, debug);
    const dls = extractAllDataLayerObjects(html);
    const data = reduceProduct(dls, html);

    const resp = {
      ...data,
      scrapedAt: new Date().toISOString(),
      cached: false,
    };

    cache.set(key, { ts: now, data: resp });
    return res.json(resp);
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}

// эндпоинты
app.get("/", handleRequest);
app.get("/api/sierra", handleRequest);

// вспомогательный — посмотреть первые символы HTML (для отладки)
app.get("/debugHtml", async (req, res) => {
  try {
    const url = req.query.url;
    if (!url) return res.status(400).send("Missing url");
    const html = await fetchHtmlViaScrapingBee(url, true);
    res.type("text/plain").send(html.slice(0, 50000));
  } catch (e) {
    res.status(500).send(String(e.message || e));
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Sierra proxy running on port ${PORT}`);
});
