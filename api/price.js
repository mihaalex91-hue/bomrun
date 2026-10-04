// Bomrun pricing engine — POST /api/price { lines:[{mpn, qty}], currency:"GBP"|"EUR"|"USD" }
// Queries distributors DIRECTLY. Each adapter switches on when its env var exists:
//   FARNELL_API_KEY                           (element14 Product Search API, Basic plan: 2/s, 1000/day)
//   MOUSER_API_KEY                            (Mouser Search API: 1000/day)
//   DIGIKEY_CLIENT_ID + DIGIKEY_CLIENT_SECRET (DigiKey Product Information v4: 1000/day)
// With no keys at all it returns demo data so the UI stays testable.
const MAX_LINES = 60;
// Indicative FX used only when a distributor answers in a different currency than requested. Update occasionally.
const FX = { GBP: 1, EUR: 1.17, USD: 1.27 }; // 1 GBP = x
const toCur = (amount, from, to) => amount / (FX[from] || 1) * (FX[to] || 1);

// ---------- helpers ----------
function limiter(n, gapMs = 0) { let active = 0, nextSlot = 0; const q = [];
  const next = () => { if (active >= n || !q.length) return; const job = q.shift(); active++;
    const start = Math.max(Date.now(), nextSlot); nextSlot = start + gapMs;
    setTimeout(() => { job.fn().then(job.res, job.rej).finally(() => { active--; next(); }); }, start - Date.now()); };
  return fn => new Promise((res, rej) => { q.push({ fn, res, rej }); next(); }); }
function priceAt(breaks, qty) { // breaks: [{qty, unit}]. Unit price for buying qty (never below the first break).
  const b = [...breaks].filter(x => x.unit > 0).sort((a, c) => a.qty - c.qty); if (!b.length) return null;
  let pick = b[0]; for (const x of b) if (x.qty <= Math.max(qty, b[0].qty)) pick = x; return pick; }
function offer(d, { sku, stock, moq = 1, mult = 1, packaging, breaks, url, currency }, qty, want) {
  const p = priceAt(breaks, qty); if (!p) return null;
  let buy = Math.max(qty, moq, p.qty > qty ? p.qty : 0); if (mult > 1) buy = Math.ceil(buy / mult) * mult;
  const unit = toCur(p.unit, currency, want);
  return { distributor: d, sku, stock: stock || 0, moq, packaging, unit: +unit.toFixed(5), buyQty: buy, lineTotal: +(unit * buy).toFixed(4), url, inStock: (stock || 0) >= qty, nativeCurrency: currency }; }
const num = s => parseFloat(String(s ?? "").replace(/[^0-9.]/g, "")) || 0;
function lifecycle(s) { s = String(s || "").toLowerCase(); if (!s) return null;
  if (/obsolete|no longer|discontinued|end of life|eol/.test(s)) return "Obsolete";
  if (/nrnd|not recommended|last time/.test(s)) return "NRND";
  if (/active|production|normal|new product/.test(s)) return "Production"; return s; }

// ---------- Farnell / element14 ----------
const farnellLimit = limiter(2, 510); // Basic plan: 2 calls/s
const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
async function farnellQuery(term, key) {
  const url = `https://api.element14.com/catalog/products?versionNumber=1.4&term=${encodeURIComponent(term)}&storeInfo.id=uk.farnell.com&resultsSettings.offset=0&resultsSettings.numberOfResults=10&resultsSettings.responseGroup=large&callInfo.responseDataFormat=JSON&callInfo.apiKey=${key}`;
  const r = await farnellLimit(() => fetch(url)); if (!r.ok) throw new Error("farnell " + r.status);
  const j = await r.json(); const ret = j.manufacturerPartNumberSearchReturn || j.keywordSearchReturn || j.premierFarnellPartNumberReturn || {}; return ret.products || []; }
async function farnell(mpn, qty, want, key) {
  let ps = await farnellQuery("manuPartNum:" + mpn, key);
  let exact = ps.filter(p => norm(p.translatedManufacturerPartNumber) === norm(mpn));
  if (!exact.length) { ps = await farnellQuery("any:" + mpn, key); exact = ps.filter(p => norm(p.translatedManufacturerPartNumber) === norm(mpn)); }
  if (!exact.length) return null; // never substitute a different part
  // Farnell lists reels, packs and cut tape as separate SKUs: pick the cheapest way to buy this qty, preferring in-stock
  const offers = exact.map(e => {
    const breaks = (e.prices || []).map(p => ({ qty: +p.from, unit: +p.cost }));
    const pack = e.packSize && e.packSize > 1 ? e.packSize : 1;
    return offer("Farnell", { sku: e.sku, stock: e.stock?.level, moq: e.translatedMinimumOrderQuality || 1, mult: pack, packaging: e.unitOfMeasure, breaks, url: `https://uk.farnell.com/${e.sku}`, currency: "GBP" }, qty, want); })
    .filter(Boolean).sort((a, b) => (b.inStock - a.inStock) || (a.lineTotal - b.lineTotal));
  const e = exact[0]; const brand = e.brandName || "";
  const desc = String(e.displayName || "").replace(new RegExp("^" + brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*-\\s*", "i"), "").replace(new RegExp("^" + mpn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*-\\s*", "i"), "");
  return { meta: { manufacturer: brand, description: desc, lifecycle: lifecycle(e.productStatus) }, offer: offers[0] || null };
}

// ---------- Mouser ----------
const mouserLimit = limiter(3, 200);
async function mouser(mpn, qty, want, key) {
  const r = await mouserLimit(() => fetch(`https://api.mouser.com/api/v1/search/partnumber?apiKey=${key}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ SearchByPartRequest: { mouserPartNumber: mpn, partSearchOptions: "Exact" } }) }));
  if (!r.ok) throw new Error("mouser " + r.status); const j = await r.json();
  if (j.Errors && j.Errors.length) throw new Error("mouser: " + j.Errors.map(e => e.Message).join("; "));
  const ps = j.SearchResults?.Parts || []; const exact = ps.find(p => norm(p.ManufacturerPartNumber) === norm(mpn)); if (!exact) return null;
  const cur = exact.PriceBreaks?.[0]?.Currency || "GBP";
  const breaks = (exact.PriceBreaks || []).map(p => ({ qty: +p.Quantity, unit: num(p.Price) }));
  return { meta: { manufacturer: exact.Manufacturer, description: exact.Description, lifecycle: lifecycle(exact.LifecycleStatus) },
    offer: offer("Mouser", { sku: exact.MouserPartNumber, stock: num(exact.AvailabilityInStock || exact.Availability), moq: +exact.Min || 1, mult: +exact.Mult || 1, packaging: exact.Packaging || undefined, breaks, url: exact.ProductDetailUrl, currency: cur }, qty, want) };
}

// ---------- DigiKey v4 ----------
let dkTok = { t: null, exp: 0 };
async function dkToken(id, secret) {
  if (dkTok.t && Date.now() < dkTok.exp - 60000) return dkTok.t;
  const r = await fetch("https://api.digikey.com/v1/oauth2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: id, client_secret: secret, grant_type: "client_credentials" }) });
  if (!r.ok) throw new Error("digikey auth " + r.status); const j = await r.json(); dkTok = { t: j.access_token, exp: Date.now() + j.expires_in * 1000 }; return dkTok.t; }
const dkLimit = limiter(3, 150);
async function digikey(mpn, qty, want, id, secret) {
  const tok = await dkToken(id, secret);
  const r = await dkLimit(() => fetch("https://api.digikey.com/products/v4/search/keyword", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok, "X-DIGIKEY-Client-Id": id, "X-DIGIKEY-Locale-Site": "UK", "X-DIGIKEY-Locale-Language": "en", "X-DIGIKEY-Locale-Currency": want }, body: JSON.stringify({ Keywords: mpn, Limit: 3 }) }));
  if (!r.ok) throw new Error("digikey " + r.status); const j = await r.json();
  const ps = j.Products || []; const exact = ps.find(p => norm(p.ManufacturerProductNumber) === norm(mpn)); if (!exact) return null;
  const vars = (exact.ProductVariations || []).filter(v => (v.StandardPricing || []).length);
  const best = vars.map(v => offer("DigiKey", { sku: v.DigiKeyProductNumber, stock: v.QuantityAvailableforPackageType ?? exact.QuantityAvailable, moq: v.MinimumOrderQuantity || 1, packaging: v.PackageType?.Name, breaks: v.StandardPricing.map(p => ({ qty: +p.BreakQuantity, unit: +p.UnitPrice })), url: exact.ProductUrl, currency: want }, qty, want))
    .filter(Boolean).sort((a, b) => (b.inStock - a.inStock) || (a.lineTotal - b.lineTotal))[0] || null;
  return { meta: { manufacturer: exact.Manufacturer?.Name, description: exact.Description?.ProductDescription, lifecycle: lifecycle(exact.ProductStatus?.Status) }, offer: best };
}

// ---------- demo (no keys) ----------
const DEMO_DIST = ["Mouser", "DigiKey", "Farnell", "LCSC", "RS"];
function demo(lines) { return lines.map(l => { const seed = [...l.mpn].reduce((a, c) => a + c.charCodeAt(0), 0); const base = 0.02 + ((seed % 97) / 97) * 8;
  const offers = DEMO_DIST.filter((d, k) => (seed + k) % 5 !== 0).map((d, k) => { const unit = +(base * (0.85 + ((seed * (k + 3)) % 40) / 100)).toFixed(4); const stock = ((seed * (k + 7)) % 3 === 0) ? 0 : ((seed * (k + 11)) % 9000) + 50; const moq = d === "LCSC" ? Math.max(1, (seed % 4) * 5) : 1; const buyQty = Math.max(l.qty, moq);
    return { distributor: d, sku: d.slice(0, 2).toUpperCase() + "-" + (seed * (k + 1) % 99999), stock, moq, packaging: "Cut Tape", unit, buyQty, lineTotal: +(unit * buyQty).toFixed(4), url: "#", inStock: stock >= l.qty }; }).sort((a, b) => a.lineTotal - b.lineTotal);
  return { mpn: l.mpn, manufacturer: ["Texas Instruments", "Murata", "Yageo", "STMicro", "Vishay"][seed % 5], description: "Demo part – add distributor API keys for live data", lifecycle: seed % 13 === 0 ? "Obsolete" : (seed % 7 === 0 ? "NRND" : "Production"), offers, demo: true }; }); }

// ---------- handler ----------
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const { lines = [], currency = "GBP" } = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const want = ["GBP", "EUR", "USD"].includes(currency) ? currency : "GBP";
    const clean = lines.filter(l => l && l.mpn).slice(0, MAX_LINES).map(l => ({ mpn: String(l.mpn).trim(), qty: Math.max(1, parseInt(l.qty) || 1) }));
    if (!clean.length) return res.status(400).json({ error: "no lines" });
    const E = process.env; const adapters = [];
    if (E.FARNELL_API_KEY) adapters.push({ name: "Farnell", fn: (m, q) => farnell(m, q, want, E.FARNELL_API_KEY) });
    if (E.MOUSER_API_KEY) adapters.push({ name: "Mouser", fn: (m, q) => mouser(m, q, want, E.MOUSER_API_KEY) });
    if (E.DIGIKEY_CLIENT_ID && E.DIGIKEY_CLIENT_SECRET) adapters.push({ name: "DigiKey", fn: (m, q) => digikey(m, q, want, E.DIGIKEY_CLIENT_ID, E.DIGIKEY_CLIENT_SECRET) });
    if (!adapters.length) return res.status(200).json({ mode: "demo", sources: [], results: demo(clean) });

    const errors = {};
    const results = await Promise.all(clean.map(async l => {
      const hits = await Promise.all(adapters.map(a => a.fn(l.mpn, l.qty).catch(e => { errors[a.name] = String(e.message || e); return null; })));
      const metas = hits.filter(Boolean).map(h => h.meta); const offers = hits.filter(h => h && h.offer).map(h => h.offer).sort((a, b) => a.lineTotal - b.lineTotal);
      const pick = k => (metas.find(m => m[k]) || {})[k] || null;
      return { mpn: l.mpn, manufacturer: pick("manufacturer"), description: pick("description"), lifecycle: pick("lifecycle"), offers, notFound: offers.length === 0 && metas.length === 0 };
    }));
    res.status(200).json({ mode: "live", sources: adapters.map(a => a.name), errors: Object.keys(errors).length ? errors : undefined, currency: want, results });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
};
