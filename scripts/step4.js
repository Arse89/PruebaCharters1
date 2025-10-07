// Barcelona: pagina TODO y confirma Charter por get-map/{id}
import fs from "node:fs/promises";
const BASE = "https://www.consum.es/get-map-list/block_supermercados_en_barcelona/";
const OUT  = "docs/charter.geojson";

const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
const strip = (s="")=>String(s).replace(/<[^>]*>/g," ").replace(/\s+/g," ").trim();

async function getText(url, ms=12000){
  const ctrl = new AbortController(); const t=setTimeout(()=>ctrl.abort(),ms);
  try{
    const r = await fetch(url, { headers:{accept:"*/*"}, signal:ctrl.signal });
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
  try{ return findFeatures(JSON.parse(await getText(url))) || []; } catch { return []; }
}

// pagina con corte por “no crecimiento”
async function fetchAll(){
  const seen = new Set(); const raws = [];
  const first = await fetchPage(BASE);
  for(const f of first){ const id=String(f?.properties?.entity_id||""); if(id && !seen.has(id)){ seen.add(id); raws.push(f);} }
  for(const mode of ["page","p"]){
    let stagnant=0;
    for(let i=1;i<=20;i++){
      const u = `${BASE}?${mode}=${i}`;
      const feats = await fetchPage(u);
      let grew=0;
      for(const f of feats){
        const id=String(f?.properties?.entity_id||"");
        if(id && !seen.has(id)){ seen.add(id); raws.push(f); grew++; }
      }
      if(grew===0) stagnant++; else stagnant=0;
      if(stagnant>=2) break;
      await sleep(120);
    }
  }
  return { raws, ids:[...seen] };
}

async function getDetailsById(id){
  const urls = [
    `https://www.consum.es/get-map/${id}/`,
    `https://www.consum.es/va/get-map/${id}/`
  ];
  for(const u of urls){
    try{
      const txt = await getText(u, 10000);
      const j = JSON.parse(txt);
      const f = (findFeatures(j)||[])[0];
      if(!f) continue;
      return {
        icon: String(f?.properties?.icon||""),
        name: strip(f?.properties?.tooltip||f?.properties?.title||""),
        desc: strip(f?.properties?.description||""),
        geom: f?.geometry || null
      };
    }catch{}
    await sleep(60);
  }
  return { icon:"", name:"", desc:"", geom:null };
}

async function mapPool(items, fn, size=8){
  const out=[]; let i=0;
  async function worker(){
    while(i<items.length){
      const idx=i++; const r=await fn(items[idx], idx); if(r) out.push(r);
      await sleep(40);
    }
  }
  await Promise.all(Array.from({length:size}, worker));
  return out;
}

function toFeature(id, det, rawGeom){
  const geom = det.geom || rawGeom;
  if(!geom || !Array.isArray(geom.coordinates)) return null;
  const isCharter = /charter/i.test(det.icon||"") || /\bcharter\b/i.test(`${det.name||""} ${det.desc||""}`);
  if(!isCharter) return null;
  return {
    type:"Feature",
    geometry: geom,
    properties:{
      id,
      name: det.name||"",
      address: strip(det.desc||""),
      brand:"Charter",
      icon: det.icon||"",
      source: BASE
    }
  };
}

async function main(){
  const { raws, ids } = await fetchAll();
  // mapa id -> geom del feed por si detalle no trae geom
  const rawGeom = new Map();
  for(const f of raws){
    const id=String(f?.properties?.entity_id||"");
    if(id && f?.geometry) rawGeom.set(id, f.geometry);
  }

  // detalles por ID en paralelo
  const details = new Map();
  await mapPool(ids, async (id)=>{
    const det = await getDetailsById(id);
    details.set(id, det);
    return true;
  }, 8);

  // construir GeoJSON solo Charter
  const feats=[];
  for(const id of ids){
    const f = toFeature(id, details.get(id)||{}, rawGeom.get(id));
    if(f) feats.push(f);
  }

  const fc = {
    type:"FeatureCollection",
    features: feats,
    metadata:{
      source: BASE,
      ids_total: ids.length,
      charter: feats.length,
      generated_at: new Date().toISOString()
    }
  };
  await fs.mkdir("docs",{recursive:true});
  await fs.writeFile(OUT, JSON.stringify(fc));
  console.log(`IDS=${ids.length}  CHARTER=${feats.length}  → ${OUT}`);
}
main().catch(e=>{ console.error(e); process.exit(1); });
