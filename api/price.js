// Bomrun pricing engine — POST /api/price { lines:[{mpn, qty}], currency:"GBP"|"EUR"|"USD" }
// A line's "mpn" may also be a generic passive description ("C/CERSM 100n 50V X7R 0603", "R 10k 1% 0603"):
// it is resolved to one real part via DigiKey (needs DigiKey keys) and returned with query/spec/alternatives.
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
// Mouser Search API allows ~30 calls/min. We batch up to 10 part numbers per call ("A|B|C") and space calls 2.1 s apart,
// so a 60-line BOM costs 6 calls instead of 60 (the old per-line calls hit the limit and lines came back empty).
const mouserLimit = limiter(1, 2100);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function mouserCall(pns, key, retry = true) {
  const r = await mouserLimit(() => fetch(`https://api.mouser.com/api/v1/search/partnumber?apiKey=${key}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ SearchByPartRequest: { mouserPartNumber: pns.join("|"), partSearchOptions: "Exact" } }) }));
  const txt = await r.text(); let j = {}; try { j = JSON.parse(txt); } catch (_) {}
  const errMsg = !r.ok ? "mouser " + r.status + " " + txt.slice(0, 200) : (j.Errors && j.Errors.length ? "mouser: " + j.Errors.map(e => e.Message || e.Code).join("; ") : null);
  if (errMsg) { console.log("[mouser]", errMsg);
    if (retry && (r.status === 429 || /too many|rate|limit|exceed/i.test(errMsg))) { await sleep(3000); return mouserCall(pns, key, false); }
    throw new Error(errMsg); }
  return j.SearchResults?.Parts || []; }
async function mouserPrefetch(mpns, key) { // returns { normMpn: [parts] } or throws per chunk (recorded per mpn)
  const out = {}, errs = {}; const uniq = [...new Set(mpns)];
  const chunks = []; for (let i = 0; i < uniq.length; i += 10) chunks.push(uniq.slice(i, i + 10));
  await Promise.all(chunks.map(async ch => { try { const parts = await mouserCall(ch, key);
      for (const m of ch) out[norm(m)] = parts.filter(p => norm(p.ManufacturerPartNumber) === norm(m)); }
    catch (e) { for (const m of ch) errs[norm(m)] = String(e.message || e); } }));
  return { out, errs }; }
function mouserFromParts(parts, mpn, qty, want) {
  const cands = (parts || []).filter(p => norm(p.ManufacturerPartNumber) === norm(mpn)); if (!cands.length) return null;
  const offers = cands.map(exact => { const cur = exact.PriceBreaks?.[0]?.Currency || "GBP";
    const breaks = (exact.PriceBreaks || []).map(p => ({ qty: +p.Quantity, unit: num(p.Price) }));
    return offer("Mouser", { sku: exact.MouserPartNumber, stock: num(exact.AvailabilityInStock || exact.Availability), moq: +exact.Min || 1, mult: +exact.Mult || 1, packaging: exact.Packaging || undefined, breaks, url: exact.ProductDetailUrl, currency: cur }, qty, want); })
    .filter(Boolean).sort((a, b) => (b.inStock - a.inStock) || (a.lineTotal - b.lineTotal));
  const e = cands[0];
  return { meta: { manufacturer: e.Manufacturer, description: e.Description, lifecycle: lifecycle(e.LifecycleStatus) }, offer: offers[0] || null }; }

// ---------- DigiKey v4 ----------
let dkTok = { t: null, exp: 0 };
async function dkToken(id, secret) {
  if (dkTok.t && Date.now() < dkTok.exp - 60000) return dkTok.t;
  const r = await fetch("https://api.digikey.com/v1/oauth2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: id, client_secret: secret, grant_type: "client_credentials" }) });
  if (!r.ok) throw new Error("digikey auth " + r.status); const j = await r.json(); dkTok = { t: j.access_token, exp: Date.now() + j.expires_in * 1000 }; return dkTok.t; }
const dkLimit = limiter(3, 150);
async function digikey(mpn, qty, want, id, secret) {
  const tok = await dkToken(id, secret);
  const r = await dkLimit(() => fetch("https://api.digikey.com/products/v4/search/keyword", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok, "X-DIGIKEY-Client-Id": id, "X-DIGIKEY-Locale-Site": "UK", "X-DIGIKEY-Locale-Language": "en", "X-DIGIKEY-Locale-Currency": want }, body: JSON.stringify({ Keywords: mpn, Limit: 10 }) }));
  if (!r.ok) { const t = await r.text(); console.log("[digikey]", r.status, t.slice(0, 300)); throw new Error("digikey " + r.status + " " + t.slice(0, 150)); } const j = await r.json();
  // Exact hits come back in ExactMatches, separate from Products (the old code only read the first 3 Products and missed common parts)
  const ps = [...(j.ExactMatches || []), ...(j.Products || [])]; const exact = ps.find(p => norm(p.ManufacturerProductNumber) === norm(mpn));
  if (!exact) { console.log("[digikey] no exact match for", mpn, "got:", ps.slice(0, 5).map(p => p.ManufacturerProductNumber).join(", ")); return null; }
  const vars = (exact.ProductVariations || []).filter(v => (v.StandardPricing || []).length);
  const best = vars.map(v => offer("DigiKey", { sku: v.DigiKeyProductNumber, stock: v.QuantityAvailableforPackageType ?? exact.QuantityAvailable, moq: v.MinimumOrderQuantity || 1, packaging: v.PackageType?.Name, breaks: v.StandardPricing.map(p => ({ qty: +p.BreakQuantity, unit: +p.UnitPrice })), url: exact.ProductUrl, currency: want }, qty, want))
    .filter(Boolean).sort((a, b) => (b.inStock - a.inStock) || (a.lineTotal - b.lineTotal))[0] || null;
  return { meta: { manufacturer: exact.Manufacturer?.Name, description: exact.Description?.ProductDescription, lifecycle: lifecycle(exact.ProductStatus?.Status) }, offer: best };
}

// ---------- generic passive descriptions ("C/CERSM 100n 50V X7R 0603", "R 10k 1% 0603") ----------
// Parsed into a spec, resolved to one real MPN via DigiKey keyword search + attribute checks, then priced like any MPN.
const PKGS = ["01005", "0201", "0402", "0603", "0805", "1206", "1210", "1812", "2010", "2220", "2512"];
const CAP_SI = { p: 1e-12, n: 1e-9, u: 1e-6, "µ": 1e-6 };
const RES_SI = { "": 1, r: 1, k: 1e3, m: 1e6 };
function capVal(s) { let m = s.match(/^(\d+(?:\.\d+)?)\s*([pnuµ])f?$/i); if (m) return +m[1] * CAP_SI[m[2].toLowerCase()];
  m = s.match(/^(\d+)([pnuµ])(\d+)f?$/i); if (m) return +(m[1] + "." + m[3]) * CAP_SI[m[2].toLowerCase()]; return null; }
function resVal(s) { s = s.replace(/(ohms?|Ω)$/i, ""); let m = s.match(/^(\d+(?:\.\d+)?)([rkm])$/i); if (m) return +m[1] * RES_SI[m[2].toLowerCase()];
  m = s.match(/^(\d+)([rkm])(\d+)$/i); if (m) return +(m[1] + "." + m[3]) * RES_SI[m[2].toLowerCase()]; return null; }
const DIEL = s => { s = s.toUpperCase().replace("COG", "C0G").replace("NPO", "NP0"); return /^(X7R|X5R|X7S|X6S|X8R|Y5V|Z5U|C0G|NP0)$/.test(s) ? (s === "NP0" ? "C0G" : s) : null; };
function parseSpec(text) {
  const raw = String(text || ""); if (!/\s|\/.*\//.test(raw.trim())) return null;
  const toks = []; for (const t of raw.replace(/[,;]/g, " ").split(/\s+/).filter(Boolean)) { if (/^\d+\/\d+W$/i.test(t)) toks.push(t); else toks.push(...t.split("/").filter(Boolean)); }
  const sp = {}; let capWord = false, resWord = false, cv = null, rv = null, ohmNext = false;
  for (let i = 0; i < toks.length; i++) { const t = toks[i], u = t.toUpperCase();
    if (PKGS.includes(t)) { sp.pkg = t; continue; }
    if (/^(C|CAP|CAPS|CAPACITOR|CER|CERSM|CERAMIC|MLCC|CERCAP)$/.test(u)) { capWord = true; continue; }
    if (/^(R|RES|RESISTOR|RESSM|THICK|THIN|FILM|CHIP|SMD|SM)$/.test(u)) { if (/^R|RES/.test(u)) resWord = true; continue; }
    let m;
    if ((m = t.match(/^(\d+(?:\.\d+)?)V(DC)?$/i))) { sp.voltage = +m[1]; continue; }
    if (DIEL(t)) { sp.diel = DIEL(t); capWord = true; continue; }
    if ((m = t.match(/^±?(\d+(?:\.\d+)?)%$/))) { sp.tol = +m[1]; continue; }
    if ((m = t.match(/^(\d+)\/(\d+)W$/i))) { sp.power = +m[1] / +m[2]; continue; }
    if ((m = t.match(/^(\d*\.?\d+)(m?)W$/i))) { sp.power = +m[1] * (m[2] ? 1e-3 : 1); continue; }
    if (/^(ohms?|Ω)$/i.test(t)) { resWord = true; continue; }
    if (cv === null && capVal(t) !== null) { cv = capVal(t); continue; }
    if (rv === null && resVal(t) !== null) { rv = resVal(t); if (/ohm|Ω/i.test(t)) resWord = true; continue; }
    if (rv === null && /^\d+(\.\d+)?$/.test(t) && /^(ohms?|Ω)$/i.test(toks[i + 1] || "")) { rv = +t; resWord = true; continue; }
  }
  if (!sp.pkg) return null;
  if (cv !== null && (capWord || sp.diel || sp.voltage)) { sp.type = "C"; sp.value = cv; }
  else if (rv !== null && (resWord || sp.tol || sp.power || !capWord)) { sp.type = "R"; sp.value = rv; }
  else return null;
  sp.label = sp.type === "C" ? [fmtCap(sp.value), sp.voltage && sp.voltage + "V", sp.diel, sp.pkg].filter(Boolean).join(" ")
    : [fmtRes(sp.value), sp.tol && sp.tol + "%", sp.power && fmtW(sp.power), sp.pkg].filter(Boolean).join(" ");
  return sp; }
const g3 = x => +x.toPrecision(3) + "";
function fmtCap(f) { return f >= 1e-6 ? g3(f / 1e-6) + "µF" : f >= 1e-9 ? g3(f / 1e-9) + "nF" : g3(f / 1e-12) + "pF"; }
function fmtRes(o) { return o >= 1e6 ? g3(o / 1e6) + "MΩ" : o >= 1e3 ? g3(o / 1e3) + "kΩ" : g3(o) + "Ω"; }
function fmtW(w) { return w < 1 ? "1/" + Math.round(1 / w) + "W" : g3(w) + "W"; }
function dkKeywords(sp) {
  if (sp.type === "C") { const pf = sp.value / 1e-12; const v = pf <= 10000 ? g3(pf) + "PF" : g3(sp.value / 1e-6) + "UF";
    return ["CAP CER", v, sp.voltage && sp.voltage + "V", sp.diel, sp.pkg].filter(Boolean).join(" "); }
  const o = sp.value; const v = o >= 1e6 ? g3(o / 1e6) + "M" : o >= 1e3 ? g3(o / 1e3) + "K" : g3(o);
  return ["RES", v, "OHM", sp.tol && sp.tol + "%", sp.pkg].filter(Boolean).join(" "); }
// Read value/voltage/dielectric/tolerance/power back out of a DigiKey description ("CAP CER 0.1UF 50V X7R 0603", "RES 10K OHM 1% 1/10W 0603")
function candAttrs(desc) { const d = String(desc || "").toUpperCase(); const a = {}; let m;
  if ((m = d.match(/(\d+(?:\.\d+)?)\s*(PF|NF|UF|µF)\b/))) a.cap = +m[1] * { PF: 1e-12, NF: 1e-9, UF: 1e-6, "µF": 1e-6 }[m[2]];
  if ((m = d.match(/(\d+(?:\.\d+)?)\s*([KMG]?)\s*OHM/))) a.res = +m[1] * { "": 1, K: 1e3, M: 1e6, G: 1e9 }[m[2]];
  if ((m = d.match(/(\d+(?:\.\d+)?)V\b/))) a.voltage = +m[1];
  if ((m = d.match(/\b(X7R|X5R|X7S|X6S|X8R|Y5V|Z5U|C0G|NP0)\b/))) a.diel = m[1] === "NP0" ? "C0G" : m[1];
  if ((m = d.match(/±?(\d+(?:\.\d+)?)%/))) a.tol = +m[1];
  if ((m = d.match(/(\d+)\/(\d+)W\b/))) a.power = +m[1] / +m[2]; else if ((m = d.match(/(\d*\.?\d+)W\b/))) a.power = +m[1];
  a.pkgs = PKGS.filter(p => new RegExp("\\b" + p + "\\b").test(d)); return a; }
function matchesSpec(sp, desc) { const a = candAttrs(desc); const close = (x, y) => x != null && Math.abs(x - y) <= Math.abs(y) * 0.005 + 1e-15;
  if (!a.pkgs.includes(sp.pkg)) return false;
  if (sp.type === "C") { if (!/^CAP CER|CERAMIC/.test(String(desc).toUpperCase())) return false; if (!close(a.cap, sp.value)) return false;
    if (sp.voltage && !(a.voltage >= sp.voltage)) return false; if (sp.diel && a.diel !== sp.diel) return false; }
  else { if (!/^RES/.test(String(desc).toUpperCase())) return false; if (!(sp.value === 0 ? a.res === 0 || /JUMPER/.test(String(desc).toUpperCase()) : close(a.res, sp.value))) return false;
    if (sp.tol && !(a.tol <= sp.tol)) return false; if (sp.power && !(a.power >= sp.power - 1e-9)) return false; }
  return a; }
const GOOD_BRANDS = /murata|samsung|yageo|kemet|tdk|taiyo|kyocera|avx|vishay|panasonic|walsin|koa|bourns|stackpole|rohm|susumu|te connectivity|w(u|ü)rth|uniroyal|viking|ralec/i;
async function dkSearch(body, id, secret, want) {
  const tok = await dkToken(id, secret);
  const call = b => dkLimit(() => fetch("https://api.digikey.com/products/v4/search/keyword", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok, "X-DIGIKEY-Client-Id": id, "X-DIGIKEY-Locale-Site": "UK", "X-DIGIKEY-Locale-Language": "en", "X-DIGIKEY-Locale-Currency": want }, body: JSON.stringify(b) }));
  let r = await call(body);
  if (!r.ok && body.SortOptions) { console.log("[digikey spec] sort rejected", r.status, (await r.text()).slice(0, 200)); const { SortOptions, ...plain } = body; r = await call(plain); }
  if (!r.ok) { const t = await r.text(); throw new Error("digikey " + r.status + " " + t.slice(0, 150)); }
  const j = await r.json(); return [...(j.ExactMatches || []), ...(j.Products || [])]; }
// Pick one appropriate real part for a spec: matching attributes, Active, in stock, known brand, cheapest at the needed qty.
async function resolveSpec(sp, qty, want, id, secret) {
  const kw = dkKeywords(sp);
  const ps = await dkSearch({ Keywords: kw, Limit: 50, SortOptions: { Field: "QuantityAvailable", SortOrder: "Descending" } }, id, secret, want);
  const seen = new Set(); const cands = [];
  for (const p of ps) { const mpn = p.ManufacturerProductNumber; if (!mpn || seen.has(mpn)) continue; seen.add(mpn);
    const desc = p.Description?.ProductDescription || ""; const a = matchesSpec(sp, desc); if (!a) continue;
    if (p.ProductStatus?.Status && !/active/i.test(p.ProductStatus.Status)) continue;
    const vars = (p.ProductVariations || []).filter(v => (v.StandardPricing || []).length);
    const best = vars.map(v => offer("DigiKey", { sku: v.DigiKeyProductNumber, stock: v.QuantityAvailableforPackageType ?? p.QuantityAvailable, moq: v.MinimumOrderQuantity || 1, packaging: v.PackageType?.Name, breaks: v.StandardPricing.map(b => ({ qty: +b.BreakQuantity, unit: +b.UnitPrice })), url: p.ProductUrl, currency: want }, qty, want)).filter(Boolean)
      .sort((x, y) => (y.inStock - x.inStock) || (x.lineTotal - y.lineTotal))[0];
    const tolTxt = ((p.Parameters || []).find(x => /^tolerance$/i.test(x.ParameterText || "")) || {}).ValueText || "";
    const tolPct = (tolTxt.match(/(\d+(?:\.\d+)?)\s*%/) || [])[1];
    const tightTol = sp.type !== "C" || sp.tol ? true : (tolPct != null && +tolPct <= 10);
    const exactRating = sp.type === "C" ? (!sp.voltage || a.voltage === sp.voltage) : (!sp.tol || a.tol === sp.tol);
    cands.push({ mpn, manufacturer: p.Manufacturer?.Name || "", description: desc, inStock: (p.QuantityAvailable || 0) >= qty, brand: GOOD_BRANDS.test(p.Manufacturer?.Name || ""), exactRating, tightTol, cost: best ? best.lineTotal : Infinity }); }
  // caps with no tolerance given: prefer ±10% (or tighter) over ±20%
  cands.sort((x, y) => (y.inStock - x.inStock) || (y.brand - x.brand) || (y.tightTol - x.tightTol) || (x.cost - y.cost) || (y.exactRating - x.exactRating));
  console.log("[spec]", sp.label, "kw=", kw, "results", ps.length, "matching", cands.length, cands.slice(0, 3).map(c => c.mpn + " " + c.cost).join(" | "));
  return { keywords: kw, ranked: cands.slice(0, 6) }; }
// Mouser sometimes flags a part DigiKey still calls Active ("please see suggested alternate", NRND). Skip those picks.
const MOUSER_BAD = /suggested alternate|not recommended|nrnd|obsolete|discontinued|end of life|eol\b/i;
function mouserFlagged(parts) { return (parts || []).some(p => MOUSER_BAD.test(p.Description || "") || MOUSER_BAD.test(p.LifecycleStatus || "")); }

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
    let mouserPre = null;
    if (E.MOUSER_API_KEY) adapters.push({ name: "Mouser", fn: async (m, q) => { const pre = await mouserPre; const k = norm(m);
      if (pre.errs[k]) throw new Error(pre.errs[k]); return mouserFromParts(pre.out[k], m, q, want); } });
    if (E.DIGIKEY_CLIENT_ID && E.DIGIKEY_CLIENT_SECRET) adapters.push({ name: "DigiKey", fn: (m, q) => digikey(m, q, want, E.DIGIKEY_CLIENT_ID, E.DIGIKEY_CLIENT_SECRET) });
    if (!adapters.length) return res.status(200).json({ mode: "demo", sources: [], results: demo(clean) });

    // generic descriptions -> one real MPN each (before Mouser prefetch, so it batches the resolved MPNs)
    const errors = {}; const unresolved = {};
    const hasDK = E.DIGIKEY_CLIENT_ID && E.DIGIKEY_CLIENT_SECRET;
    await Promise.all(clean.map(async l => { const sp = parseSpec(l.mpn); if (!sp) return;
      l.query = l.mpn; l.spec = sp.label;
      if (!hasDK) { unresolved[l.query] = "description search needs DigiKey"; return; }
      try { const r = await resolveSpec(sp, l.qty, want, E.DIGIKEY_CLIENT_ID, E.DIGIKEY_CLIENT_SECRET);
        if (r.ranked.length) l.ranked = r.ranked; else unresolved[l.query] = "no matching part found for " + sp.label; }
      catch (e) { const msg = String(e.message || e); errors.DigiKey = msg; unresolved[l.query] = msg; } }));
    // check the top candidates on Mouser in one batch and drop any it flags as replaced/NRND
    let checked = { out: {}, errs: {} };
    const specLines = clean.filter(l => l.ranked);
    if (E.MOUSER_API_KEY && specLines.length) {
      try { checked = await mouserPrefetch(specLines.flatMap(l => l.ranked.slice(0, 4).map(c => c.mpn)), E.MOUSER_API_KEY); } catch (e) { console.log("[spec mouser check]", e.message); } }
    for (const l of specLines) {
      const ok = l.ranked.filter((c, i) => i >= 4 || checked.errs[norm(c.mpn)] || !mouserFlagged(checked.out[norm(c.mpn)]));
      const list = ok.length ? ok : l.ranked;
      if (ok.length < l.ranked.length) console.log("[spec] skipped flagged:", l.ranked.filter(c => !ok.includes(c)).map(c => c.mpn).join(", "));
      l.mpn = list[0].mpn; l.alternatives = list.slice(1, 4).map(c => ({ mpn: c.mpn, manufacturer: c.manufacturer })); delete l.ranked; }
    const priced = clean.filter(l => !unresolved[l.query]);
    if (E.MOUSER_API_KEY) { const need = priced.map(l => l.mpn).filter(m => !(norm(m) in checked.out));
      mouserPre = (need.length ? mouserPrefetch(need, E.MOUSER_API_KEY) : Promise.resolve({ out: {}, errs: {} }))
        .then(r => ({ out: { ...checked.out, ...r.out }, errs: r.errs })); }

    const results = await Promise.all(clean.map(async l => {
      if (l.query && unresolved[l.query]) return { mpn: l.query, query: l.query, spec: l.spec, manufacturer: null, description: unresolved[l.query], lifecycle: null, offers: [], notFound: true };
      const lineErr = {};
      const hits = await Promise.all(adapters.map(a => a.fn(l.mpn, l.qty).catch(e => { const msg = String(e.message || e); errors[a.name] = msg; lineErr[a.name] = msg; console.log("[" + a.name + "] " + l.mpn + ": " + msg); return null; })));
      const metas = hits.filter(Boolean).map(h => h.meta); const offers = hits.filter(h => h && h.offer).map(h => h.offer).sort((a, b) => a.lineTotal - b.lineTotal);
      const pick = k => (metas.find(m => m[k]) || {})[k] || null;
      const hasErr = Object.keys(lineErr).length > 0;
      // lifecycle: report the WORST status any distributor gives (DigiKey "Obsolete" must win over Farnell "stocked")
      const lcRank = x => /obsolete|discontinued|end of life|eol/i.test(x) ? 3 : /nrnd|not recommended|last time/i.test(x) ? 2 : 1;
      const lc = metas.map(m => m.lifecycle).filter(Boolean).sort((a, b) => lcRank(b) - lcRank(a))[0] || null;
      return { mpn: l.mpn, query: l.query, spec: l.spec, alternatives: l.alternatives, manufacturer: pick("manufacturer"), description: pick("description"), lifecycle: lc, offers, notFound: offers.length === 0 && metas.length === 0, errors: hasErr ? lineErr : undefined };
    }));
    res.status(200).json({ mode: "live", sources: adapters.map(a => a.name), errors: Object.keys(errors).length ? errors : undefined, currency: want, results });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
};
