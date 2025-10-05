// scripts/fetch_charter.js — pagina feeds y confirma marca por get-map/{id}
import fs from "node:fs/promises";

const OUT = "docs/charter.geojson";
const FEEDS = [
  "https://www.consum.es/get-map-list/block_supermercados_en_barcelona/",
  "https://www.consum.es/va/get-map-list/block_supermercados_en_valencia/",
  "https://www.consum.es/va/get-map-list/block_supermercados_en_alicante/",
  "https://www.consum.es/get-map-list/block_supermercados_en_castellon/",
  "https://www.consum.es/get-map-list/block_supermercados_en_murcia/",
  "https://www.consum.es/get-map-list/block_supermercados_en_albacete/"
];

const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
const strip = (s="")=>String(s).replace(/<[^>]*>/g," ").replace(/\s+/g," ").trim();

async function getText(url){
  for(let i=1;i<=3;i++){
    try{
      const r = await fetch(url, { headers:{accept:"*/*"} });
      const t = await r.text();
      if(!r.ok) throw new Error(`HTTP ${r.status} ${t.slice(0,120)}`);
      return t;
    } catch(e){ if(i===3) throw e; await sleep(400*i); }
  }
}
async function getJson(url){ return JSON.parse(await getText(url)); }

function findFeatures(obj){
  if(!obj) return null;
  if(Array.isArray(obj)){ for(const el of obj){ const f=findFeatures(el); if(f) return f; } return null; }
  if(typeof obj==="object"){
    if(Array.isArray(obj.features)) return obj.features;
    for(const k of Object.keys(obj)){ const f=findFeatures(obj[k]); if(f) return f; }
  }
  return null;
}

// pagina ?page=1..9 y ?p=1..9 (el base ya trae page=0 -> 20 items)
async function fetchAllPages(base){
  const urls = [base];
  for(let i=1;i<=9;i++) urls.push(`${base}?page=${i}`);
  for(let i=1;i<=9;i++) urls.push(`${base}?p=${i}`);
  const out = [];
  for(const u of urls){
    try{
      const j = await getJson(u);
      const feats = findFeatures(j) || [];
      if(!feats.length) continue;
      out.push(...feats);
      // heurística: si <20, no hay más páginas de este modo
      if(feats.length < 20 && (u.includes("?page=")||u.includes("?p="))) break;
    }catch{}
    await sleep(150);
  }
  return out;
}

async function getIconById(id){
  try{
    const j = await getJson(`https://www.consum.es/get-map/${id}/`);
    const f = (findFeatures(j)||[])[0];
    return String(f?.properties?.icon || "");
  }catch{ return ""; }
}

async function toFeature(raw, source){
  // coords
  let lon=null, lat=null;
  const c = raw?.geometry?.coordinates;
  if(Array.isArray(c) && c.length>=2){ lon=+c[0]; lat=+c[1]; }
  if((lon==null||lat==null) && raw?.properties?.data?.field_coordenadas){
    const wkt = String(raw.properties.data.field_coordenadas);
    let m = /POINT\s*\(\s*(-?\d+\.?\d*)\s+(-?\d+\.?\d*)\s*\)/i.exec(wkt);
    if(m){ lon=+m[1]; lat=+m[2]; }
    if(lon==null||lat==null){ m=/(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/.exec(wkt); if(m){ lat=+m[1]; lon=+m[2]; } }
  }
  if(lon==null||lat==null) return null;

  const name = strip(raw?.properties?.tooltip || raw?.properties?.title || raw?.properties?.data?.title);
  const addr = strip(raw?.properties?.data?.field_domicilio || raw?.properties?.field_domicilio || raw?.properties?.description);
  const id = String(raw?.properties?.entity_id || `${name}|${addr}`).toLowerCase();

  // SIEMPRE confirma marca por id (muchos feeds no traen icon correcto)
  const iconFeed = String(raw?.properties?.icon || "");
  const icon = (await getIconById(id)) || iconFeed;
  const isCharter = /charter/i.test(icon) || /\bcharter\b/i.test(name) || /\bcharter\b/i.test(addr);
  if(!isCharter) return null;

  return {
    type:"Feature",
    geometry:{ type:"Point", coordinates:[lon,lat] },
    properties:{ id, name, address: addr, brand:"Charter", icon, source }
  };
}

function dedupe(features){
  const m = new Map();
  for(const f of features){
    const k = f.properties.id || JSON.stringify(f.geometry.coordinates);
    if(!m.has(k)) m.set(k,f);
  }
  return [...m.values()];
}

async function main(){
  const all = [];
  for(const base of FEEDS){
    const feats = await fetchAllPages(base);
    const mapped = [];
    for(const f of feats){
      const g = await toFeature(f, base);
      if(g) mapped.push(g);
      await sleep(120); // rate limit por tienda
    }
    console.log(`OK ${base} → total=${feats.length} charter=${mapped.length}`);
    all.push(...mapped);
  }
  const fc = { type:"FeatureCollection", features: dedupe(all) };

  if(fc.features.length===0){
    console.error("Vacío. Conservo charter.geojson anterior si existe.");
    try{ await fs.access(OUT); process.exit(0); }catch{}
  }
  await fs.mkdir("docs", {recursive:true});
  await fs.writeFile(OUT, JSON.stringify(fc));
  console.log("TOTAL Charter:", fc.features.length);
}
main().catch(e=>{ console.error(e); process.exit(1); });
