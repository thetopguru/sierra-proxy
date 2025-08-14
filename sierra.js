const express = require("express");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));
const app = express();

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

// Функция парсинга HTML
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

  // Ищем JSON внутри window.__STATE__
  const match = html.match(/window\.__STATE__\s*=\s*(\{.*?\});/s);
  if (!match) throw new Error("window.__STATE__ not found");

  let state;
  try {
    state = JSON.parse(match[1]);
  } catch (err) {
    throw new Error("Failed to parse __STATE__ JSON");
  }

  const items = state.product?.inventory?.items || [];
  if (!items.length) throw new Error("No inventory items found");

  const prices = items.map(i => i.salePrice).filter(p => p !== null && p !== undefined);
  const sizes = items.map(i => i.skuSize).filter(Boolean);
  const availability = [...new Set(items.map(i => i.availability))];
  const flags = [...new Set(items.flatMap(i => i.flags || []))];
  const minPrice = prices.length ? Math.min(...prices) : null;

  return { minPrice, sizes, availability, flags };
}

// API-эндпоинт
app.get("/api/sierra", async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: "Missing url" });

    const data = await getSierraDataFromHTML(url);
    res.json({ ...data, cached: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sierra proxy running on port ${PORT}`));
