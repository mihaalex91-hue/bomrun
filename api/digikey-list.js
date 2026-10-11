// Bomrun — POST /api/digikey-list { name: "Bomrun 2026-10-11", items: [{ sku, mpn, manufacturer, qty, refdes }] }
// Uses DigiKey's public myLists third-party endpoint (no API key needed). It returns a single-use URL that
// opens myLists with the parts preloaded; from there the user clicks "Add to Cart" or saves the list.
// Docs: https://forum.digikey.com/t/mylists-third-party-api-easily-get-parts-into-mylists-from-third-party-applications/61445
const ENDPOINT = "https://www.digikey.com/mylists/api/thirdparty";

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const items = (Array.isArray(body.items) ? body.items : []).slice(0, 200)
      .map(i => ({ pn: String(i.sku || i.mpn || "").trim(), mfr: String(i.manufacturer || "").trim().slice(0, 80), qty: Math.max(1, parseInt(i.qty, 10) || 1), ref: String(i.refdes || "").trim().slice(0, 80) }))
      .filter(i => i.pn);
    if (!items.length) return res.status(400).json({ error: "no items" });
    const listName = String(body.name || "Bomrun").replace(/[^\w .-]/g, "").slice(0, 60) || "Bomrun";

    const payload = items.map(i => ({ requestedPartNumber: i.pn, manufacturerName: i.mfr, referenceDesignator: i.ref, customerReference: "", notes: "", quantities: [{ quantity: i.qty }] }));
    const url = ENDPOINT + "?listName=" + encodeURIComponent(listName) + "&tags=" + encodeURIComponent("Bomrun");
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json", "User-Agent": "Mozilla/5.0 (compatible; Bomrun/1.0; +https://bomrun.com)" }, body: JSON.stringify(payload) });
    const text = await r.text();
    let data = null; try { data = JSON.parse(text); } catch {}
    if (!r.ok || !data || !data.singleUseUrl) {
      const blocked = /just a moment|cloudflare|challenge/i.test(text);
      return res.status(502).json({ error: blocked ? "DigiKey blocked the request (bot check). Use the CSV upload instead." : ("DigiKey returned " + r.status), detail: (data && data.error) || text.slice(0, 200) });
    }
    return res.status(200).json({ url: data.singleUseUrl, count: items.length });
  } catch (e) {
    return res.status(500).json({ error: String(e && e.message || e) });
  }
};
