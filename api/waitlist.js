// Bomrun alerts waitlist — POST /api/waitlist { email, source, lines }
// Every signup is written to Vercel Logs (line starting "[waitlist]"), so nothing is lost even before a database is set up.
// If SUPABASE_URL and SUPABASE_SERVICE_KEY are set, it is also saved in the Supabase table "waitlist".
module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const email = String(b.email || "").trim().toLowerCase().slice(0, 200);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return res.status(400).json({ error: "please enter a valid email" });
    const row = { email, source: String(b.source || "").slice(0, 30), bom_lines: Math.max(0, parseInt(b.lines) || 0) };
    console.log("[waitlist]", JSON.stringify({ ...row, at: new Date().toISOString() }));
    const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
    if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
      const r = await fetch(SUPABASE_URL.replace(/\/$/, "") + "/rest/v1/waitlist", { method: "POST",
        headers: { apikey: SUPABASE_SERVICE_KEY, ...(SUPABASE_SERVICE_KEY.startsWith("eyJ") ? { Authorization: "Bearer " + SUPABASE_SERVICE_KEY } : {}), "Content-Type": "application/json", Prefer: "return=minimal" }, // new sb_secret_ keys go in apikey only
        body: JSON.stringify(row) });
      if (!r.ok && r.status !== 409) console.log("[waitlist] supabase error", r.status, (await r.text()).slice(0, 300)); // 409 = already signed up, fine
    }
    res.status(200).json({ ok: true });
  } catch (e) { console.log("[waitlist] error", String(e.message || e)); res.status(500).json({ error: "server error" }); }
};
