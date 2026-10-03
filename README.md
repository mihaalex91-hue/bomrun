# Bomrun v1

Static page + one Vercel serverless function.

- `index.html` — the whole UI (BOM parsing, pricing table, order-split optimiser, CSV export)
- `api/price.js` — POST /api/price → looks parts up via Nexar (Octopart) Supply API. Without env vars it returns demo data.

## Deploy
1. Push this folder to a GitHub repo `bomrun` → import in Vercel (preset: Other, root `./`).
2. Vercel → Project → Settings → Environment Variables:
   - `NEXAR_CLIENT_ID` = (from nexar.com application)
   - `NEXAR_CLIENT_SECRET` = (same)
   Redeploy after adding them.
3. Settings → Domains → add `bomrun.com` (A record `216.198.79.1` at Namecheap, as for evchargecost).

## Later (v2)
Supabase auth + saved BOMs + alerts; Stripe; Mouser/DigiKey direct APIs; 20-line limit enforced server-side.
