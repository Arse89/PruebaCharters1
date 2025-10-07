// step4c: Barcelona -> pagina todo (como step3) -> confirma Charter por get-map/{id}
// y si no queda claro, consulta /node/{id} (HTML) buscando "Charter".
import fs from "node:fs/promises";

const BASE = "https://www.consum.es/get-map-list/block_supermercados_en_barcelona/";
const OUT  = "docs/charter.geojson";

const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
const strip = (s="")=>String(s).replace(/<[^>]*>/g," ").replace(/\s+/g," ").trim();

async function getText(url, ms=12000){
  const ctrl = new AbortController(); const t=setTimeout(()=>ctrl.abort(), ms);
  try{
    const r = await fetch(url, { headers:{accept:"*/*"}, signal: ctrl.signal });
    const txt = await r.text();
    if(!r.ok) throw new Error(`HTTP ${r.status} ${txt.slice(0,120)}`);
    return txt;
  } finally { clearTimeout(t); }
}
const getJson = async (url, ms)=> JSON.parse(await getText(url, ms));

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
  try{ return findFeatures(await getJson(url)) || []; } catch { return []; }
}

async function fetchAllIds(){
  const seen = new Set(), raws = [];
  // primera
  for (const f of await fetchPage(BASE)){
    const id = String(f?.properties?.entity_id||""); if(id && !seen.has(id)){ seen.add(id); raws.push(f); }
  }
  // modos de paginación con corte por “no crecimiento”
  for (const mode of ["page","p"]) {
    let stagnant = 0;
    for (let i=1;i<=20;i++){
      const url = `${BASE}?${mode}=${i}`;
      const feats = await fetchPage(url);
      let grew = 0;
      for (const f of feats){
        const id = String(f?.properties?.entity_id||"");
        if(id && !seen.has(id)){ seen.add(id); raws.push(f); grew++; }
      }
      stagnant = grew===0 ? stagnant+1 : 0;
      if (stagnant>=2) break;
      await sleep(120);
    }
  }
  return { ids:[...seen], raws };
}

// --- detalle por ID ---
async function getDetailsById(id){
  for (const base of ["https://www.consum.es","https://www.consum.es/va"]) {
    try{
      const j = await getJson(`${base}/get-map/${id}/`, 10000);
      const f = (findFeatures(j)||[])[0];
      if(!f) continue;
      return {
        icon: String(f?.properties?.icon||""),
        name: strip(f?.properties?.tooltip || f?.properties?.title || ""),
        desc: strip(f?.properties?.description || ""),
        geom: f?.geometry || null
      };
    }catch{}
    await sleep(60);
  }
  return { icon:"", name:"", desc:"", geom:null };
}

// --- fallback HTML /node/{id} ---
async function getHtmlFlagByNode(id){
  try{
    const html = await getText(`https://www.consum.es/node/${id}`, 10000);
    const text = strip(html);
    const isCharter = /\bcharter\b/i.test(text) || /enseña:\s*charter/i.test(text);
    // intenta sacar dirección básica (opcional)
    let addr = "";
    const m = text.match(/\b(Direcci[oó]n|Adre[cs]a|Domicilio)\s*:\s*([^\n\r]+)\b/i);
    if(m) addr = strip(m[2]);
    return { isCharter, addrHint: addr };
  }catch{ return { isCharter:false, addrHint:"" }; }
}

// pool simple
async function mapPool(items, fn, size=8){
  const out=[]; let i=0;
  async function worker(){
    while(i<items.length){
      const idx=i++; const r=await fn(items[idx], idx); if(r!==undefined) out.push(r);
      await sleep(40);
    }
  }
  await Promise.all(Array.from({length:size}, worker));
  return out;
}

function toFeature(id, det, rawGeom, addrHint){
  const geom = det.geom || rawGeom;
  if(!geom || !Array.isArray(geom.coordinates)) return null;
  const name = det.name || "";
  const address = strip(det.desc || addrHint || "");
  return {
    type:"Feature",
    geometry: geom,
    properties:{ id, name, address, brand:"Charter", icon: det.icon || "" , source:"bcn" }
  };
}

async function main(){
  // 1) ids desde paginación “que funciona”
  const { ids, raws } = await fetchAllIds();
  console.log("IDS BCN:", ids.length);

  // mapa id -> geom del feed
  const rawGeom = new Map();
  for(const f of raws){ const id=String(f?.properties?.entity_id||""); if(id && f?.geometry) rawGeom.set(id, f.geometry); }

  // 2) detalle por ID
  const details = new Map();
  await mapPool(ids, async (id)=>{
    const det = await getDetailsById(id);
    details.set(id, det);
  }, 8);

  // 3) charterness por icon/text o fallback /node/{id}
  const feats = [];
  for (const id of ids){
    const det = details.get(id) || {};
    let isCharter = /charter/i.test(det.icon||"") || /\bcharter\b/i.test(`${det.name||""} ${det.desc||""}`);
    let addrHint = "";
    if(!isCharter){
      const htmlFlag = await getHtmlFlagByNode(id);
      isCharter = htmlFlag.isCharter;
      addrHint = htmlFlag.addrHint;
    }
    if(isCharter){
      const feat = toFeature(id, det, rawGeom.get(id), addrHint);
      if(feat) feats.push(feat);
    }
  }

  const fc = {
    type:"FeatureCollection",
    features: feats,
    metadata:{ source:"bcn:get-map-list + get-map/{id} + node/{id}", ids_total: ids.length, charter: feats.length, generated_at: new Date().toISOString() }
  };
  await fs.mkdir("docs",{recursive:true});
  await fs.writeFile(OUT, JSON.stringify(fc));
  console.log(`IDS=${ids.length}  CHARTER=${feats.length}  → ${OUT}`);
}
main().catch(e=>{ console.error(e); process.exit(1); });
