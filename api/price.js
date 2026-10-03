// Vercel serverless function: POST /api/price  { lines:[{mpn, qty}], currency:"GBP" }
// Looks parts up through Nexar (Octopart) Supply API. Falls back to demo data if no credentials are set,
// so the UI can be tested before the API keys exist. Set NEXAR_CLIENT_ID / NEXAR_CLIENT_SECRET in Vercel env vars.
const TOKEN_URL = "https://identity.nexar.com/connect/token";
const GQL_URL = "https://api.nexar.com/graphql";
const MAX_LINES = 60;           // hard cap per request (free tier protection)
let tokenCache = { token: null, exp: 0 };

async function getToken() {
  if (tokenCache.token && Date.now() < tokenCache.exp - 60000) return tokenCache.token;
  const body = new URLSearchParams({ grant_type: "client_credentials", client_id: process.env.NEXAR_CLIENT_ID, client_secret: process.env.NEXAR_CLIENT_SECRET, scope: "supply.domain" });
  const r = await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!r.ok) throw new Error("nexar auth failed: " + r.status);
  const j = await r.json();
  tokenCache = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return tokenCache.token;
}

const QUERY = `query ($q:[SupPartMatchQuery!]!, $cur:String!){
  supMultiMatch(queries:$q, currency:$cur, country:"GB"){
    reference hits
    parts{ mpn manufacturer{name} shortDescription
      specs{ attribute{shortname} displayValue }
      sellers(authorizedOnly:true){ company{name} isAuthorized
        offers{ sku inventoryLevel moq packaging clickUrl
          prices{ quantity price currency convertedPrice convertedCurrency } } } } } }`;

function lifecycleOf(part){ const s=(part.specs||[]).find(x=>/lifecycle/i.test(x.attribute?.shortname||"")); return s?s.displayValue:null; }

function priceAt(prices, qty){ // best unit price for buying qty (uses the highest break <= qty; if qty < first break, first break applies)
  const ps=[...prices].sort((a,b)=>a.quantity-b.quantity); if(!ps.length) return null;
  let pick=ps[0]; for(const p of ps){ if(p.quantity<=Math.max(qty,ps[0].quantity)) pick=p; }
  return { unit: pick.convertedPrice ?? pick.price, breakQty: pick.quantity };
}

function normalise(part, qty){
  const offers=[];
  for(const s of part.sellers||[]){ for(const o of s.offers||[]){
    const pr=priceAt(o.prices||[], qty); if(!pr) continue;
    const buyQty=Math.max(qty, o.moq||1, pr.breakQty>qty?pr.breakQty:0);
    offers.push({ distributor:s.company.name, sku:o.sku, stock:o.inventoryLevel, moq:o.moq||1, packaging:o.packaging, unit:pr.unit, buyQty, lineTotal:+(pr.unit*buyQty).toFixed(4), url:o.clickUrl, inStock:(o.inventoryLevel||0)>=qty });
  }}
  // keep the best offer per distributor
  const best={}; for(const o of offers){ if(!best[o.distributor] || (o.inStock&&!best[o.distributor].inStock) || (o.inStock===best[o.distributor].inStock && o.lineTotal<best[o.distributor].lineTotal)) best[o.distributor]=o; }
  return { mpn:part.mpn, manufacturer:part.manufacturer?.name, description:part.shortDescription, lifecycle:lifecycleOf(part), offers:Object.values(best).sort((a,b)=>a.lineTotal-b.lineTotal) };
}

// ---- demo data so the tool works before keys exist ----
const DEMO_DIST=["Mouser","DigiKey","Farnell","LCSC","RS"];
function demo(lines){ return lines.map((l,i)=>{ const seed=[...l.mpn].reduce((a,c)=>a+c.charCodeAt(0),0); const base=0.02+((seed%97)/97)*8;
  const offers=DEMO_DIST.filter((d,k)=>(seed+k)%5!==0).map((d,k)=>{ const unit=+(base*(0.85+((seed*(k+3))%40)/100)).toFixed(4); const stock=((seed*(k+7))%3===0)?0:((seed*(k+11))%9000)+50; const moq=d==="LCSC"?Math.max(1,(seed%4)*5):1; const buyQty=Math.max(l.qty,moq);
    return { distributor:d, sku:d.slice(0,2).toUpperCase()+"-"+(seed*(k+1)%99999), stock, moq, packaging:"Cut Tape", unit, buyQty, lineTotal:+(unit*buyQty).toFixed(4), url:"#", inStock:stock>=l.qty }; }).sort((a,b)=>a.lineTotal-b.lineTotal);
  return { mpn:l.mpn, manufacturer:["Texas Instruments","Murata","Yageo","STMicro","Vishay"][seed%5], description:"Demo part – add Nexar keys for live data", lifecycle: seed%13===0?"Obsolete":(seed%7===0?"NRND":"Production"), offers, demo:true }; }); }

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin","*");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const { lines=[], currency="GBP" } = typeof req.body==="string"?JSON.parse(req.body):req.body||{};
    const clean=lines.filter(l=>l&&l.mpn).slice(0,MAX_LINES).map(l=>({mpn:String(l.mpn).trim(), qty:Math.max(1,parseInt(l.qty)||1)}));
    if(!clean.length) return res.status(400).json({error:"no lines"});
    if(!process.env.NEXAR_CLIENT_ID){ return res.status(200).json({ mode:"demo", results:demo(clean) }); }
    const token=await getToken();
    const r=await fetch(GQL_URL,{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+token},body:JSON.stringify({query:QUERY,variables:{q:clean.map(l=>({mpn:l.mpn,limit:3})),cur:currency}})});
    const j=await r.json(); if(j.errors) throw new Error(j.errors.map(e=>e.message).join("; "));
    const results=j.data.supMultiMatch.map((m,i)=>{ const q=clean[i]; const exact=m.parts.find(p=>p.mpn.toLowerCase()===q.mpn.toLowerCase())||m.parts[0];
      return exact? normalise(exact,q.qty) : { mpn:q.mpn, manufacturer:null, description:null, lifecycle:null, offers:[], notFound:true }; });
    res.status(200).json({ mode:"live", results });
  } catch (e) { res.status(500).json({ error: String(e.message||e) }); }
};
