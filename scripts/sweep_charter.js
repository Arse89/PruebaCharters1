// Barrido robusto: filtro "Charter" + paginación + captura XHR (Views/GeoJSON)
// Fallback: consulta get-map/{id} cuando el icon no confirma la enseña
import fs from "node:fs/promises";
import { chromium } from "playwright";

const OUT = "docs/charter.geojson";
const CACHE = "docs/cache-icons.json";

const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
const strip = (s="")=>String(s).replace(/<[^>]*>/g," ").replace(/\s+/g," ").trim();
const isCharterText = (t="")=> /\bcharter\b/i.test(t);
const isCharterIcon  = (i="")=> /charter/i.test(i);

// cache id→{icon,name,desc,geom,ts}
async function loadCache(){ try{ return JSON.parse(await fs.readFile(CACHE,"utf-8")); }catch{ return {}; } }
async function saveCache(c){ await fs.mkdir("docs",{recursive:true}); await fs.writeFile(CACHE, JSON.stringify(c)); }

// Busca array "features" en cualquier JSON
function findFeatures(obj){
  if(!obj) return null;
  if(Array.isArray(obj)){ for(const el of obj){ const f=findFeatures(el); if(f) return f; } return null; }
  if(typeof obj==="object"){
    if(Array.isArray(obj.features)) return obj.features;
    for(const k of Object.keys(obj)){ const f=findFeatures(obj[k]); if(f) return f; }
  }
  return null;
}

async function getDetailsById(id){
  const urls = [
    `https://www.consum.es/get-map/${id}/`,
    `https://www.consum.es/va/get-map/${id}/`
  ];
  for(const u of urls){
    try{
      const res = await fetch(u, { headers:{accept:"*/*"} });
      const txt = await res.text();
      const j = JSON.parse(txt);
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

async function main(){
  const browser = await chromium.launch({ args:["--no-sandbox"] });
  const page = await browser.newPage({ userAgent:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari" });

  // Captura de XHR/Fetch
  const rawItems = []; // elementos tal cual del feed
  page.on("requestfinished", async (req) => {
    const rt = req.resourceType();
    if(rt!=="xhr" && rt!=="fetch") return;
    try{
      const res = await req.response();
      const ct = res.headers()["content-type"] || "";
      const body = await res.text();
      if(!/json|javascript|geojson|html/.test(ct)) return;
      let j; try{ j = JSON.parse(body); }catch{ return; }
      const feats = findFeatures(j) || [];
      if(feats.length){
        rawItems.push(...feats);
      }
    }catch{}
  });

  // 1) Ir al buscador
  await page.goto("https://www.consum.es/supermercados/", { waitUntil:"domcontentloaded" });

  // 2) Activar filtro "Charter" si existe
  await page.locator('text=Charter').first().click({ trial: true }).catch(()=>{});
  await page.locator('text=Charter').first().click().catch(()=>{});
  await page.waitForLoadState("networkidle");

  // 3) Paginar hasta agotar
  for(let i=0;i<50;i++){
    const next = await page.locator('text=Siguiente').first();
    if(!(await next.isVisible().catch(()=>false))) break;
    await next.click();
    await page.waitForLoadState("networkidle");
    await sleep(150);
  }

  await browser.close();

  // 4) Consolidar por id
  const byId = new Map();
  for(const f of rawItems){
    const id = String(f?.properties?.entity_id || "").trim();
    if(!id) continue;
    const icon = String(f?.properties?.icon||"");
    const name = strip(f?.properties?.tooltip || f?.properties?.title || "");
    const desc = strip(f?.properties?.description || "");
    const geom = f?.geometry || null;
    const prev = byId.get(id) || { icons:[], names:[], descs:[], geom:null };
    if(icon) prev.icons.push(icon);
    if(name) prev.names.push(name);
    if(desc) prev.descs.push(desc);
    if(!prev.geom && geom) prev.geom = geom;
    byId.set(id, prev);
  }

  // 5) Carga caché y decide qué IDs requieren detalle
  const cache = await loadCache();
  const needDetail = [];
  for(const [id,agg] of byId){
    const iconAny = agg.icons.join(" ");
    const textAny = `${agg.names.join(" ")} ${agg.descs.join(" ")}`;
    const hasHint = isCharterIcon(iconAny) || isCharterText(textAny);
    const haveCache = Boolean(cache[id]);
    if(!haveCache || (!hasHint && !(cache[id]?.icon))){
      needDetail.push([id, agg.geom]);
    }else{
      // Completa geom si el cache la trae
      if(!agg.geom && cache[id]?.geom) byId.set(id, { ...agg, geom: cache[id].geom });
    }
  }

  // 6) Resuelve detalle para los dudosos
  for(const [id, geomHint] of needDetail){
    const det = await getDetailsById(id);
    cache[id] = {
      icon: det.icon, name: det.name, desc: det.desc,
      geom: det.geom || geomHint || null, ts: new Date().toISOString()
    };
  }
  await saveCache(cache);

  // 7) Construir GeoJSON solo Charter
  const out = [];
  for(const [id,agg] of byId){
    const baseIcon = agg.icons.join(" ");
    const baseText = `${agg.names.join(" ")} ${agg.descs.join(" ")}`;
    const det = cache[id] || {};
    const iconAny = `${baseIcon} ${det.icon||""}`;
    const textAny = `${baseText} ${det.name||""} ${det.desc||""}`;
    const isCharter = isCharterIcon(iconAny) || isCharterText(textAny);
    const geom = agg.geom || det.geom;
    if(isCharter && geom && Array.isArray(geom.coordinates)){
      out.push({
        type:"Feature",
        geometry: geom,
        properties:{
          id, name: det.name || agg.names[0] || "",
          address: strip(det.desc || agg.descs[0] || ""),
          brand:"Charter", icon: det.icon || agg.icons[0] || ""
        }
      });
    }
  }

  const fc = { type:"FeatureCollection", features: out };
  if(fc.features.length===0){
    // conserva último válido si existe
    try{ await fs.access(OUT); process.exit(0); }catch{}
  }
  await fs.mkdir("docs",{recursive:true});
  await fs.writeFile(OUT, JSON.stringify(fc));
  console.log("TOTAL Charter:", fc.features.length);
}
main().catch(e=>{ console.error(e); process.exit(1); });
