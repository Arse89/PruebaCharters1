// Crawl ligero: páginas de ciudad -> fichas de tienda -> filtra Charter -> coords por get-map/{id}
import fs from "node:fs/promises";

const ORIGIN = "https://www.consum.es";
const CITY_SLUGS = [
  "barcelona","valencia","alicante","castellon","murcia","albacete"
]; // añade más si procede
const OUT = "docs/charter.geojson";

const sleep = ms => new Promise(r=>setTimeout(r,ms));
const strip = s => String(s||"").replace(/<[^>]*>/g," ").replace(/\s+/g," ").trim();
const isCharterText = t => /\bcharter\b/i.test(String(t||""));

async function get(u, ms=12000){
  const c = new AbortController(); const t=setTimeout(()=>c.abort(), ms);
  try{
    const r = await fetch(u, { headers:{ "accept":"text/html,*/*" }, signal:c.signal });
    const txt = await r.text();
    if(!r.ok) throw new Error(`GET ${u} -> ${r.status}`);
    return txt;
  } finally { clearTimeout(t); }
}
async function getJson(u, ms=12000){
  const txt = await get(u, ms);
  try{ return JSON.parse(txt); } catch { throw new Error("Bad JSON "+u); }
}

function pickLinksToStores(html){
  const urls = new Set();
  const re = /href=["'](\/supermercados\/[^"'#?]+\/)["']/gi;
  let m;
  while((m = re.exec(html))) {
    const u = m[1];
    // descarta listados de ciudad y repite
    if (/\/supermercados\/[^/]+\/$/.test(u)) continue;
    urls.add(ORIGIN + u);
  }
  return urls;
}
function pickNodeId(html){
  // suele aparecer en enlaces "Conocer la tienda" o scripts
  const m1 = html.match(/\/node\/(\d+)/);
  if(m1) return m1[1];
  // a veces como data-entity-id
  const m2 = html.match(/data-entity-id=["'](\d+)["']/);
  if(m2) return m2[1];
  return null;
}

async function getCoordsById(id){
  for(const base of [ORIGIN, ORIGIN + "/va"]){
    try{
      const j = await getJson(`${base}/get-map/${id}/`, 10000);
      // buscar Feature con geometry
      const feat = (function findFeatures(o){
        if(!o) return null;
        if(Array.isArray(o)){ for(const x of o){ const f = findFeatures(x); if(f) return f; } return null; }
        if(typeof o==="object"){
          if(Array.isArray(o.features)) return o.features[0] || null;
          for(const v of Object.values(o)){ const f = findFeatures(v); if(f) return f; }
        }
        return null;
      })(j);
      const g = feat?.geometry;
      const name = strip(feat?.properties?.tooltip || feat?.properties?.title || "");
      const desc = strip(feat?.properties?.description || "");
      const icon = String(feat?.properties?.icon || "");
      return { geom: g || null, name, desc, icon };
    }catch{}
    await sleep(60);
  }
  return { geom:null, name:"", desc:"", icon:"" };
}

async function gatherStoreUrls(){
  const storeUrls = new Set();
  for(const slug of CITY_SLUGS){
    for(let page=0; page<20; page++){
      const url = `${ORIGIN}/supermercados/${slug}/${page?`?page=${page}`:""}`;
      try{
        const html = await get(url, 10000);
        const urls = pickLinksToStores(html);
        if(urls.size===0 && page>0) break; // no más páginas
        urls.forEach(u=>storeUrls.add(u));
      }catch{
        if(page===0) break;
        else continue;
      }
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
    try { html = await get(u, 12000); }
    catch { continue; }

    const text = strip(html);
    if(!isCharterText(text)) continue; // no marca Charter en la ficha

    // nombre y dirección aproximados desde H1 y párrafos
    const name = (text.match(/^(CHARTER\s+)?([A-ZÁÉÍÓÚÑ0-9 .,'\-]+)\s*\n/i)?.[2] || "") || (text.match(/Supermercado en\s+([^\n]+)/i)?.[1] || "");
    let address = "";
    const mAddr = text.match(/\b(Carrer|C\/|Avda\.?|Avenida|Av\.)[^\n]+?\d[^,\n]*(?:,\s*\d{5})?,?\s*[A-ZÁÉÍÓÚÑ][^\n]+/i);
    if(mAddr) address = strip(mAddr[0]);

    // intenta coords por node id
    const id = pickNodeId(html);
    let geom = null, icon = "";
    if(id){
      const det = await getCoordsById(id);
      geom = det.geom;
      icon = det.icon;
      // si el detalle trae Charter en icon/text mejor
      if(!isCharterText(text) && !isCharterText(`${det.name} ${det.desc} ${det.icon}`)) continue;
      if(!address) address = strip(det.desc || address);
    }

    if(!geom){
      // sin coords no pintamos en el mapa
      continue;
    }

    feats.push({
      type:"Feature",
      geometry: geom,
      properties:{
        id: id || u,
        name: strip(name)||"",
        address: address||"",
        brand: "Charter",
        icon,
        url: u
      }
    });

    if(i % 25 === 0) await sleep(200);
  }

  await fs.mkdir("docs", { recursive: true });
  const fc = { type:"FeatureCollection", features: feats, metadata:{ cities: CITY_SLUGS, urls_seen: storeUrls.length, charter: feats.length, generated_at: new Date().toISOString() } };
  await fs.writeFile(OUT, JSON.stringify(fc));
  console.log(`FIN → tiendas vistas=${storeUrls.length}  charter=${feats.length}  escrito=${OUT}`);
}

main().catch(e=>{ console.error(e); process.exit(1); });
