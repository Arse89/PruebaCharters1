// step4: pagina Barcelona y filtra SOLO "Charter" por icono/texto
import fs from "node:fs/promises";
const BASE = "https://www.consum.es/get-map-list/block_supermercados_en_barcelona/";
const OUT  = "docs/charter.geojson";

const sleep = ms => new Promise(r=>setTimeout(r,ms));
const strip = s => String(s||"").replace(/<[^>]*>/g," ").replace(/\s+/g," ").trim();
const isCharterIcon = i => /charter/i.test(String(i||""));
const isCharterText = t => /\bcharter\b/i.test(String(t||""));

async function getText(url, ms=12000){
  const c = new AbortController(); const t = setTimeout(()=>c.abort(), ms);
  try{
    const r = await fetch(url, { headers:{accept:"*/*"}, signal:c.signal });
    const x = await r.text();
    if(!r.ok) throw new Error(`HTTP ${r.status} ${x.slice(0,120)}`);
    return x;
  } finally { clearTimeout(t); }
}
function findFeatures(o){
  if(!o) return null;
  if(Array.isArray(o)){ for(const x of o){ const f=findFeatures(x); if(f) return f; } return null; }
  if(typeof o==="object"){
    if(Array.isArray(o.features)) return o.features;
    for(const v of Object.values(o)){ const f=findFeatures(v); if(f) return f; }
  }
  return null;
}
async function fetchPage(url){
  try{ return findFeatures(JSON.parse(await getText(url))) || []; }
  catch{ return []; }
}
function toFeature(raw){
  let lon=null, lat=null;
  const c = raw?.geometry?.coordinates;
  if(Array.isArray(c)&&c.length>=2){ lon=+c[0]; lat=+c[1]; }
  const coordStr = raw?.properties?.data?.field_coordenadas || raw?.properties?.field_coordenadas;
  if((lon==null||lat==null) && coordStr){
    let m=/POINT\s*\(\s*(-?\d+\.?\d*)\s+(-?\d+\.?\d*)\s*\)/i.exec(String(coordStr));
    if(m){ lon=+m[1]; lat=+m[2]; }
    if(lon==null||lat==null){ m=/(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/.exec(String(coordStr)); if(m){ lat=+m[1]; lon=+m[2]; } }
  }
  if(lon==null||lat==null) return null;

  const id   = String(raw?.properties?.entity_id || "").trim();
  const name = strip(raw?.properties?.tooltip || raw?.properties?.title || "");
  const addr = strip(raw?.properties?.data?.field_domicilio || raw?.properties?.field_domicilio || raw?.properties?.description || "");
  const icon = String(raw?.properties?.icon || "");

  const charter = isCharterIcon(icon) || isCharterText(name) || isCharterText(addr);
  if(!charter) return null;

  return { type:"Feature", geometry:{type:"Point",coordinates:[lon,lat]},
           properties:{ id, name, address: addr, brand:"Charter", icon, source: BASE } };
}

async function main(){
  const tried = [];
  const seenIds = new Set();
  const raws = [];

  const addUnique = feats => {
    let added = 0;
    for(const f of feats){
      const id = String(f?.properties?.entity_id || "");
      if(!id || seenIds.has(id)) continue;
      seenIds.add(id); raws.push(f); added++;
    }
    return added;
  };

  // primera
  addUnique(await fetchPage(BASE)); tried.push(BASE);

  // paginación con corte por “no crecimiento”
  for (const mode of ["page","p"]) {
    let stagnant = 0;
    for (let i=1;i<=20;i++){
      const url = `${BASE}?${mode}=${i}`;
      const grew = addUnique(await fetchPage(url));
      tried.push(url);
      stagnant = grew===0 ? stagnant+1 : 0;
      if (stagnant>=2) break;
      await sleep(120);
    }
  }

  const mapped = raws.map(toFeature).filter(Boolean);

  const fc = {
    type:"FeatureCollection",
    features: mapped,
    metadata:{ source: BASE, pages_tried: tried.length, raw_total: raws.length, charter: mapped.length, generated_at: new Date().toISOString() }
  };
  await fs.mkdir("docs",{recursive:true});
  await fs.writeFile(OUT, JSON.stringify(fc));
  console.log(`RAW=${raws.length}  CHARTER=${mapped.length}  → ${OUT}`);
}
main().catch(e=>{ console.error(e); process.exit(1); });
