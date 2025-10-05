// scripts/fetch_charter.js
// Estrategia: 1) listar IDs por provincia (feeds get-map-list, con paginación real)
//             2) para cada ID pedir /get-map/{id} y confirmar Charter por el icono
//             3) cachear detalles por ID para acelerar siguientes runs
import fs from "node:fs/promises";

const OUT = "docs/charter.geojson";
const CACHE = "docs/cache-icons.json";

// Feeds provinciales conocidos (añade más si haces falta; intenta ES y VA)
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
    }catch(e){ if(i===3) throw e; await sleep(400*i); }
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

// Paginación real (algunos devuelven 200 por página): probamos ?page= y ?p=
async function fetchAllPageFeatures(base){
  const urls = [base];
  for(let i=1;i<=20;i++) urls.push(`${base}?page=${i}`);
  for(let i=1;i<=20;i++) urls.push(`${base}?p=${i}`);
  const out = [];
  for(const u of urls){
    try{
      const j = await getJson(u);
      const feats = findFeatures(j) || [];
      if(!feats.length) continue;
      out.push(...feats);
      // heurística: si <200, probablemente ya no hay más
      if((u.includes("?page=")||u.includes("?p=")) && feats.length < 200) break;
    }catch{}
    await sleep(120);
  }
  return out;
}

// --- Caché de detalles por ID ---
async function loadCache(){
  try{ return JSON.parse(await fs.readFile(CACHE,"utf-8")); }catch{ return {}; }
}
async function saveCache(cache){
  await fs.mkdir("docs",{recursive:true});
  await fs.writeFile(CACHE, JSON.stringify(cache));
}

// Pide detalle por ID (ES o VA) y devuelve {icon, name, desc, geometry}
async function getDetailsById(id){
  const urls = [
    `https://www.consum.es/get-map/${id}/`,
    `https://www.consum.es/va/get-map/${id}/`
  ];
  for(const u of urls){
    try{
      const j = await getJson(u);
      const f = (findFeatures(j)||[])[0];
      if(!f) continue;
      const icon = String(f?.properties?.icon || "");
      const name = strip(f?.properties?.tooltip || f?.properties?.title || "");
      const desc = strip(f?.properties?.description || "");
      const geom = f?.geometry;
      return { icon, name, desc, geom };
    }catch{}
    await sleep(80);
  }
  return { icon:"", name:"", desc:"", geom:null };
}

function dedupeIds(ids){ return [...new Set(ids)]; }
function isCharterBy(icon, text){ return /charter/i.test(icon) || /\bcharter\b/i.test(text); }

// Pool de concurrencia
async function mapPool(items, fn, size=8){
  const out = []; let i=0;
  async function worker(){
    while(i<items.length){
      const idx = i++; const r = await fn(items[idx], idx);
      if(r) out.push(r);
      await sleep(40);
    }
  }
  await Promise.all(Array.from({length:size}, worker));
  return out;
}

async function main(){
  // 1) Recoger TODOS los entity_id de todas las páginas de cada feed
  const allIds = [];
  for(const base of FEEDS){
    const feats = await fetchAllPageFeatures(base);
    const ids = feats.map(f => f?.properties?.entity_id).filter(Boolean);
    console.log(`IDs ${base}: ${ids.length}`);
    allIds.push(...ids);
  }
  const uniqueIds = dedupeIds(allIds);
  console.log("IDs totales únicos:", uniqueIds.length);

  // 2) Cargar caché y resolver SOLO los que falten
  const cache = await loadCache();
  const missing = uniqueIds.filter(id => !cache[id]);
  console.log("IDs sin cache:", missing.length);

  const resolved = await mapPool(missing, async (id)=>{
    const det = await getDetailsById(id);
    cache[id] = {
      icon: det.icon,
      name: det.name,
      desc: det.desc,
      geom: det.geom
    };
    return true;
  }, 8);

  await saveCache(cache);

  // 3) Construir GeoJSON solo con Charter
  const featsOut = [];
  for(const id of uniqueIds){
    const det = cache[id] || {};
    const icon = det.icon || "";
    const text = `${det.name||""} ${det.desc||""}`;
    const charter = isCharterBy(icon, text);
    const geom = det.geom;
    if(!charter || !geom || !Array.isArray(geom.coordinates)) continue;
    featsOut.push({
      type:"Feature",
      geometry: geom,
      properties:{
        id: String(id),
        name: det.name || "",
        address: strip(det.desc || ""), // el desc suele contener domicilio
        brand: "Charter",
        icon
      }
    });
  }

  const fc = { type:"FeatureCollection", features: featsOut };
  if(fc.features.length===0){
    console.error("Vacío. Conservo charter.geojson anterior si existe.");
    try{ await fs.access(OUT); process.exit(0); }catch{}
  }
  await fs.mkdir("docs",{recursive:true});
  await fs.writeFile(OUT, JSON.stringify(fc));
  console.log("TOTAL Charter:", fc.features.length);
}
main().catch(e=>{ console.error(e); process.exit(1); });
