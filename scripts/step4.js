// Sonda: ciudad -> fichas -> node id -> get-map/{id} -> ¿Charter?
import fs from "node:fs/promises";

const ORIGIN = "https://www.consum.es";
const CITY_URL = `${ORIGIN}/supermercados/barcelona/`;   // cambia ciudad si quieres
const OUT = "docs/debug/probe.json";

const sleep = ms => new Promise(r=>setTimeout(r,ms));
async function get(u, ms=12000){
  const c = new AbortController(); const t=setTimeout(()=>c.abort(), ms);
  try{
    const r = await fetch(u, { headers:{ accept:"text/html,*/*" }, signal:c.signal });
    const txt = await r.text();
    if(!r.ok) throw new Error(`GET ${u} -> ${r.status}`);
    return txt;
  } finally { clearTimeout(t); }
}
async function getJson(u, ms=12000){
  const txt = await get(u, ms);
  try{ return JSON.parse(txt); } catch { throw new Error("Bad JSON "+u); }
}

function extractStoreUrls(html){
  const urls = new Set();
  // Relativos y absolutos (ES y VA)
  const re = /href=["'](?:https?:\/\/www\.consum\.es)?(\/(?:va\/)?supermercad[oa]s\/[^"'#?]+\/[^"'#?\/]+\/?)["']/gi;
  let m; while((m=re.exec(html))) urls.add(ORIGIN + m[1]);
  // filtra listados de ciudad (terminan en /ciudad/)
  for(const u of [...urls]){
    if(/\/supermercados\/[^/]+\/$/i.test(u) || /\/va\/supermercats\/[^/]+\/$/i.test(u)) urls.delete(u);
  }
  return [...urls];
}

function pickNodeId(html){
  let m = html.match(/rel=["']shortlink["'][^>]+href=["'][^"']*\/node\/(\d+)["']/i);
  if(m) return m[1];
  m = html.match(/\/node\/(\d+)/); if(m) return m[1];
  m = html.match(/data-entity-id=["'](\d+)["']/i); if(m) return m[1];
  m = html.match(/["']entity_id["']\s*:\s*["']?(\d+)["']?/i); if(m) return m[1];
  return null;
}

function findFeature(o){
  if(!o) return null;
  if(Array.isArray(o)){ for(const x of o){ const f=findFeature(x); if(f) return f; } return null; }
  if(typeof o==="object"){
    if(Array.isArray(o.features) && o.features[0]) return o.features[0];
    for(const v of Object.values(o)){ const f=findFeature(v); if(f) return f; }
  }
  return null;
}

async function getDetail(id){
  for(const base of [ORIGIN, ORIGIN+"/va"]){
    try{
      const j = await getJson(`${base}/get-map/${id}/`, 10000);
      const f = findFeature(j);
      if(!f) continue;
      const icon = String(f?.properties?.icon||"");
      const name = String(f?.properties?.tooltip || f?.properties?.title || "");
      const desc = String(f?.properties?.description || "");
      return { icon, name, desc };
    }catch{}
    await sleep(60);
  }
  return null;
}

function isCharter(icon="", text=""){
  return /charter/i.test(icon) || /\bcharter\b/i.test(text);
}

async function main(){
  const htmlList = await get(CITY_URL, 12000);
  const storeUrls = extractStoreUrls(htmlList).slice(0, 30); // 30 primeras para prueba
  const results = [];
  let withId = 0, withDetail = 0, charter = 0;

  for(const u of storeUrls){
    const html = await get(u, 12000);
    const id = pickNodeId(html);
    const row = { url: u, id: id || null, icon: null, name: null, charter: false };
    if(id){
      withId++;
      const det = await getDetail(id);
      if(det){
        withDetail++;
        row.icon = det.icon;
        row.name = det.name;
        row.charter = isCharter(det.icon, `${det.name} ${det.desc}`);
        if(row.charter) charter++;
      }
    }
    results.push(row);
    await sleep(80);
  }

  await fs.mkdir("docs/debug", { recursive: true });
  await fs.writeFile(OUT, JSON.stringify({
    city_url: CITY_URL,
    total_urls: storeUrls.length,
    with_id, with_detail, charter,
    sample: results.slice(0,10)
  }, null, 2));
  console.log(`URLs=${storeUrls.length}  IDs=${withId}  DETAIL=${withDetail}  CHARTER=${charter}  → ${OUT}`);
}
main().catch(e=>{ console.error(e); process.exit(1); });
