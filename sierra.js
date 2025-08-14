const express = require("express");
const fs = require("fs");

const app = express();
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

const SCRAPINGBEE_KEY =
  process.env.SCRAPINGBEE_KEY || process.env.SCRAPINGBEE_API_KEY;

// Проверка, что ключ есть
if (!SCRAPINGBEE_KEY) {
  console.error(
    "❌ SCRAPINGBEE_KEY не задан. Укажи его в Environment Variables на Render."
  );
  process.exit(1);
}

// Тест ключа при старте
(async () => {
  console.log("🔍 Проверка ключа ScrapingBee...");
  const testUrl =
    "https://app.scrapingbee.com/api/v1/?" +
    new URLSearchParams({
      api_key: SCRAPINGBEE_KEY,
      url: "https://www.sierra.com/product/index/7kuga/",
      render_js: "true",
      wait: "3000",
      country_code: "US",
    });

  try {
    const resp = await fetch(testUrl, { headers: { "User-Agent": UA } });
    if (!resp.ok) {
      console.error(
        `❌ ScrapingBee вернул ошибку: ${resp.status} ${resp.statusText}`
      );
      const txt = await resp.text();
      console.error("Ответ:", txt.slice(0, 300));
      process.exit(1);
    }
    const html = await resp.text();
    if (!html.startsWith("<!DOCTYPE html")) {
      console.error("❌ HTML от ScrapingBee не получен (ключ неверный или блокировка)");
      console.error(html.slice(0, 300));
      process.exit(1);
    }
    console.log("✅ Ключ ScrapingBee рабочий, сервер запускается...");
  } catch (err) {
    console.error("❌ Ошибка при обращении к ScrapingBee:", err.message);
    process.exit(1);
  }
})();

// ==================== Хелперы ====================

function okUrl(u) {
  try {
    return new URL(u).hostname.toLowerCase().endsWith("sierra.com");
  } catch {
    return false;
  }
}

async function fetchHtml(url) {
  const api = "https://app.scrapingbee.com/api/v1/";
  const qs = new URLSearchParams({
    api_key: SCRAPINGBEE_KEY,
    url,
    render_js: "true",
    premium_proxy: "true",
    country_code: "US",
    block_resources: "false",
    wait: "5000",
    timeout: "60000",
  });

  const resp = await fetch(`${api}?${qs.toString()}`, {
    headers: { "User-Agent": UA },
  });

  if (!resp.ok) throw new Error(`ScrapingBee HTTP ${resp.status}`);
  return await resp.text();
}

function extractAllDataLayerObjects(html) {
  const out = [];
  const re = /dataLayer\.push\(\s*(\{[\s\S]*?\})\s*\);/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      out.push(JSON.parse(m[1]));
    } catch {
      // пробуем раскодировать
      const unescaped = m[1]
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");
      try {
        out.push(JSON.parse(unescaped));
      } catch {}
    }
  }
  return out;
}

function scanFlags(html) {
  const txt = html.toLowerCase();
  return {
    clearance: /clearance/i.test(txt),
    almostGone: /almost\s+gone/i.test(txt),
    onlyOneLeft: /only\s+one\s+(left|in\s+stock)/i.test(txt),
  };
}

function extractFromMeta(html) {
  const meta = {};
  const mPrice = html.match(
    /<meta[^>]+name=["']product:price:amount["'][^>]+content=["']([\d.]+)["']/i
  );
  if (mPrice) meta.price = parseFloat(mPrice[1]);
  const currency = html.match(
    /<meta[^>]+name=["']product:price:currency["'][^>]+content=["']([A-Z]{3})["']/i
  );
  if (currency) meta.currency = currency[1];
  const title = html.match(/<title>\s*([\s\S]*?)\s*<\/title>/i);
  if (title) meta.title = title[1].trim();
  return meta;
}

function reduceProduct(dataLayers, html) {
  const dlWithProducts =
    dataLayers.find(
      (o) =>
        o?.ecommerce?.detail?.products &&
        Array.isArray(o.ecommerce.detail.products)
    ) || null;

  const flags = scanFlags(html);
  const meta = extractFromMeta(html);

  let product = {
    source: "fallback",
    name: meta.title || null,
    price: meta.price ?? null,
    currency: meta.currency ?? "USD",
    flags,
  };

  if (dlWithProducts) {
    const p = dlWithProducts.ecommerce.detail.products[0];
    product = {
      source: "dataLayer",
      id: p?.id ?? null,
      name: p?.name ?? product.name,
      price: p?.discountPrice ?? p?.price ?? product.price,
      currency: product.currency,
      brand: p?.brand ?? null,
      category: p?.category ?? null,
      variant: p?.variant ?? null,
      stock: p?.productChildStock ?? null,
      flags,
    };
  }

  return product;
}

// ==================== API ====================

app.get("/", async (req, res) => {
  try {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: "Missing url" });
    if (!okUrl(url))
      return res.status(400).json({ error: "URL must be on sierra.com" });

    const html = await fetchHtml(url);
    const dls = extractAllDataLayerObjects(html);
    const data = reduceProduct(dls, html);

    res.json({ ...data, scrapedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log(`🚀 Sierra proxy running on port ${PORT}`)
);
