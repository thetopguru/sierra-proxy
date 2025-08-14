const express = require("express");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
const app = express();

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

// Кэш в памяти (внутри процесса)
const cache = new Map();
const CACHE_TTL = 120 * 1000; // 120 сек

function okUrl(u) {
  try {
    const h = new URL(u).hostname.toLowerCase();
    return h.endsWith("sierra.com");
  } catch {
    return false;
