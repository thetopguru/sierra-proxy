const express = require('express');
const axios = require('axios');
const app = express();

const SCRAPINGBEE_API_KEY = process.env.SCRAPINGBEE_API_KEY;

app.get('/', async (req, res) => {
  const targetUrl = req.query.url;

  if (!targetUrl) {
    return res.status(400).json({ error: "Missing 'url' query parameter" });
  }

  try {
    // Загружаем HTML с помощью ScrapingBee с включенным браузером
    const response = await axios.get('https://app.scrapingbee.com/api/v1/', {
      params: {
        api_key: SCRAPINGBEE_API_KEY,
        url: targetUrl,
        render_js: 'true',
        wait_browser: 'networkidle2'
      }
    });

    const html = response.data;

    // Ищем блок с dataLayer.push(...)
    const dataLayerMatch = html.match(/dataLayer\.push\((\{.*?\})\);/s);
    if (!dataLayerMatch) {
      return res.status(404).json({ error: "dataLayer not found in HTML" });
    }

    // Парсим JSON из найденного куска
    let productData;
    try {
      productData = JSON.parse(dataLayerMatch[1]);
    } catch (e) {
      return res.status(500).json({ error: "Failed to parse dataLayer JSON" });
    }

    // Достаём данные о товаре (если это PDP)
    let productInfo = {};
    if (productData.ecommerce && productData.ecommerce.detail && productData.ecommerce.detail.products) {
      const p = productData.ecommerce.detail.products[0];
      productInfo = {
        id: p.id,
        name: p.name,
        brand: p.brand,
        category: p.category,
        variant: p.variant,
        price: p.price,
        discount: p.discount,
        stock: p.productChildStock
      };
    } else {
      productInfo = { raw: productData };
    }

    res.json(productInfo);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Sierra proxy running on port ${PORT}`);
});
