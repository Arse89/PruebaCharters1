// Crawl por ciudades (ES + VA) -> fichas -> node id robusto -> get-map/{id} -> filtra Charter
import fs from "node:fs/promises";

const ORIGIN_ES = "https://www.consum.es";
const ORIGIN_VA = "https://www.consum.es/va";

const CITY_SLUGS_ES = ["barcelona","valencia","alicante","castellon","murcia","albacete"];
const CITY_SLUGS_VA = ["barcelona","valencia","alicante","castello","murcia","albacete"]; // añade "valencia/valència" si lo ves en producción

const OUT = "docs/charter.geojson";

const sleep = ms => new Promise(r=>setTimeout(r,ms));
const strip = s => String(s||"").replace(/<[^>]*>/g," ").replace(/\s+/g," ").trim();
const isCharter = (icon="", text="") => /charter/i.test(icon) || /\bcharter\b/i.test(text);

async function get(u, ms=12000){
  const c = new AbortController(); const t=setTimeout(()=>c.abort(), ms);
  try{
    const r = await fetch(u, { headers:{accept:"text/html,*/*"}, signal:c.signal });
    const txt = await r.text();
    if(!r.ok) throw new Error(`GET ${u} -> ${r.status}`);
    return txt;
  } finally { clearTimeout(t); }
}
async function getJson(u, ms=12000){
  const txt = await get(u, ms);
  try{ return JSON.parse(txt); }catch{ throw new Error("Bad JSON "+u); }
}

// -------- extracción de URLs de tienda desde listados --------
function pickLinksToStores(html, origin){
  const urls = new Set();

  // ES: /supermercados/<ciudad>/<slug-tienda>
  const reES = /href=["'](\/supermercados\/[^"'#?]+\/[^"'#?\/]+)["']/gi;
  let m; while((m=reES.exec(html))) urls.add(origin + m[1]);

  // VA: /va/supermercats/<ciutat>/<slug-tenda>
  const reVA = /href=["'](\/va\/supermercats\/[^"'#?]+\/[^"'#?\/]+)["']/gi;
  while((m=reVA.exec(html))) urls.add(origin + m[1]);

  // filtra listados (acaban en /ciudad/)
  for(const u of [...urls]){
    if(/\/supermercados\/[^/]+\/$/i.test(u) || /\/va\/supermercats\/[^/]+\/$/i.test(u)) urls.delete(u);
  }
  return urls;
}

// -------- extracción robusta de node id en ficha --------
function pickNodeId(html){
  // <link rel="shortlink" href="https://www.consum.es/node/123456">
  let m = html.match(/rel=["']shortlink["'][^>]+href=["'][^"']*\/node\/(\d+)["']/i);
  if(m) return m[1];

  // cualquier /node/123456 en HTML
  m = html.match(/\/node\/(\d+)/);
  if(m) return m[1];

  // data-entity-id="123456"
  m = html.match(/data-entity-id=["'](\d+)["']/i);
  if(m) return m[1];

  // JSON incrustado: "entity_id": 123456  |  'entity_id':'123456'
  m = html.match(/["']entity_id["']\s*:\s*["']?(\d+)["']?/i);
  if(m) return m[1];

  return null;
}

// -------- detalle por id --------
function findFeature(o){
  if(!o) return null;
  if(Array.isArray(o)){ for(const x of o){ const f=findFeature(x); if(f) return f; } return null; }
  if(typeof o==="object"){
    if(Array.isArray(o.features) && o.features[0]) return o.features[0];
    for(const v of Object.values(o)){ const f=findFeature(v); if(f) return f; }
  }
  return null;
}
async function getDetailsById(id){
  for(const base of [ORIGIN_ES, ORIGIN_VA]){
    try{
      const j = await getJson(`${base}/get-map/${id}/`, 10000);
      const f = findFeature(j);
      if(!f) continue;
      const icon = String(f?.properties?.icon||"");
      const name = strip(f?.properties?.tooltip || f?.properties?.title || "");
      const desc = strip(f?.properties?.description || "");
      const geom = f?.geometry || null;
      return { icon, name, desc, geom };
    }catch{}
    await sleep(60);
  }
  return { icon:"", name:"", desc:"", geom:null };
}

// -------- paginado simple de listados de ciudad --------
async function gatherStoreUrls(){
  const storeUrls = new Set();

  // ES
  for(const slug of CITY_SLUGS_ES){
    for(let p=0; p<25; p++){
      const url = `${ORIGIN_ES}/supermercados/${slug}/${p?`?page=${p}`:""}`;
      try{
        const html = await get(url, 10000);
        const batch = pickLinksToStores(html, ORIGIN_ES);
        if(batch.size===0 && p>0) break;
        batch.forEach(u=>storeUrls.add(u));
      }catch{}
      await sleep(120);
    }
  }
  // VA
  for(const slug of CITY_SLUGS_VA){
    for(let p=0; p<25; p++){
      const url = `${ORIGIN_VA}/supermercats/${slug}/${p?`?page=${p}`:""}`;
      try{
        const html = await get(url, 10000);
        const batch = pickLinksToStores(html, ORIGIN_VA);
        if(batch.size===0 && p>0) break;
        batch.forEach(u=>storeUrls.add(u));
      }catch{}
      await sleep(120);
    }
  }
  return [...storeUrls];
}

async function main(){
  const storeUrls = await gatherStoreUrls();
  console.log("URLs de tiendas:", storeUrls.length);

  const feats = [];
  let i = 0;

  for(const u of storeUrls){
    i++;
    let html;
    try { html = await get(u, 12000); } catch { continue; }

    // id
    const id = pickNodeId(html);
    if(!id) continue;

    // detalle
    const det = await getDetailsById(id);
    const text = `${det.name||""} ${det.desc||""}`;
    if(!isCharter(det.icon, text)) continue;

    const g = det.geom;
    if(!g || !Array.isArray(g.coordinates)) continue;

    feats.push({
      type:"Feature",
      geometry: g,
      properties:{
        id,
        name: det.name || "",
        address: strip(det.desc || ""),
        brand: "Charter",
        icon: det.icon || "",
        url: u
      }
    });

    if(i % 25 === 0) await sleep(150);
  }

  await fs.mkdir("docs",{recursive:true});
  const fc = { type:"FeatureCollection", features: feats,
    metadata:{ urls_seen: storeUrls.length, charter: feats.length, generated_at: new Date().toISOString() } };
  await fs.writeFile(OUT, JSON.stringify(fc));
  console.log(`FIN → vistas=${storeUrls.length}  charter=${feats.length}  → ${OUT}`);
}
main().catch(e=>{ console.error(e); process.exit(1); });
