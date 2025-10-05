// Barrido robusto: abre el buscador, activa "Charter", pagina y captura XHR.
// Verifica enseña por get-map/{id} solo si falta confirmación.
// Cachea por ID para acelerar runs posteriores.
import fs from "node:fs/promises";
import { chromium } from "playwright";

const OUT = "docs/charter.geojson";
const CACHE_PATH = "docs/cache-icons.json";
const START_URL = "https://www.consum.es/supermercados/";

// TTL caché: menos peticiones en runs diarios
const TTL_CHARTER_MS = 90 * 24 * 3600 * 1000;
const TTL_OTHER_MS   = 14 * 24 * 3600 * 1000;

const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
const strip = (s="")=>String(s).replace(/<[^>]*>/g," ").replace(/\s+/g," ").trim();
const isCharterText = (t="") => /\bcharter\b/i.test(t);
const isCharterIcon = (i="") => /charter/i.test(i);

async function loadCache(){
  try { return JSON.parse(await fs.readFile(CACHE_PATH, "utf-8")); }
  catch { return {}; }
}
async function saveCache(cache){
  await fs.mkdir("docs", { recursive: true });
  await fs.writeFile(CACHE_PATH, JSON.stringify(cache));
}
function isStale(entry){
  if(!entry || !entry.ts) return true;
  const age = Date.now() - new Date(entry.ts).getTime();
  const looksCharter = isCharterIcon(entry.icon||"") || isCharterText(`${entry.name||""} ${entry.desc||""}`);
  return age > (looksCharter ? TTL_CHARTER_MS : TTL_OTHER_MS);
}

// Busca un array "features" en JSON en estructuras Drupal/GeoJSON
function findFeatures(obj){
  if(!obj) return null;
  if(Array.isArray(obj)){
    for(const el of obj){ const f = findFeatures(el); if(f) return f; }
    return null;
  }
  if(typeof obj === "object"){
    if(Array.isArray(obj.features)) return obj.features;
    for(const v of Object.values(obj)){ const f = findFeatures(v); if(f) return f; }
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
      const r = await fetch(u, { headers:{ accept: "*/*" } });
      const txt = await r.text();
      const j = JSON.parse(txt);
      const f = (findFeatures(j)||[])[0];
      if(!f) continue;
      return {
        icon: String(f?.properties?.icon || ""),
        name: strip(f?.properties?.tooltip || f?.properties?.title || ""),
        desc: strip(f?.properties?.description || ""),
        geom: f?.geometry || null
      };
    }catch{}
    await sleep(80);
  }
  return { icon:"", name:"", desc:"", geom:null };
}

// Pool simple con concurrencia controlada
async function mapPool(items, fn, size=8){
  const out = []; let i=0;
  async function worker(){
    while(i < items.length){
      const idx = i++; const r = await fn(items[idx], idx);
      if(r) out.push(r);
      await sleep(40);
    }
  }
  await Promise.all(Array.from({length:size}, worker));
  return out;
}

async function main(){
  const browser = await chromium.launch({ args:["--no-sandbox"] });
  const page = await browser.newPage({
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari",
    viewport: { width: 1280, height: 900 }
  });

  // Captura XHR/fetch y recoge todas las features que vayan saliendo
  const rawItems = [];
  page.on("requestfinished", async (req) => {
    const t = req.resourceType();
    if(t !== "xhr" && t !== "fetch") return;
    try{
      const res = await req.response();
      const body = await res.text();
      let j; try { j = JSON.parse(body); } catch { return; }
      const feats = findFeatures(j) || [];
      if(feats.length) rawItems.push(...feats);
    }catch{}
  });

  await page.goto(START_URL, { waitUntil: "domcontentloaded" });

  // Cerrar banner de cookies (OneTrust) si estorba
  try {
    await page.waitForSelector('#onetrust-accept-btn-handler, #onetrust-reject-all-handler', { timeout: 7000 });
    await page.locator('#onetrust-reject-all-handler, #onetrust-accept-btn-handler').first().click({ force: true });
    await page.keyboard.press('Escape').catch(()=>{});
    await page.evaluate(() => {
      const sdk = document.getElementById('onetrust-consent-sdk');
      if (sdk) sdk.remove();
    });
  } catch {}

  // Activar filtro "Charter"
  try {
    // botón/checkbox/etiqueta visible
    const charter = page.getByText(/Charter/, { exact: false }).first();
    if(await charter.isVisible()) await charter.click({ force: true });
  } catch {}

  await page.waitForLoadState("networkidle");
  await sleep(300);

  // Paginar hasta agotar
  for(let i=0; i<80; i++){
    const next = page.locator('button[aria-label="Siguiente"], a[aria-label="Siguiente"], text=Siguiente página').first();
    const vis = await next.isVisible().catch(()=>false);
    if(!vis) break;
    await next.click({ force: true });
    await page.waitForLoadState("networkidle");
    await sleep(150);
  }

  await browser.close();

  // Consolidar por ID (agrega iconos/textos/geom parciales)
  const byId = new Map();
  for(const f of rawItems){
    const id = String(f?.properties?.entity_id || "").trim();
    if(!id) continue;
    const icon = String(f?.properties?.icon || "");
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

  // Caché y decisión de qué IDs necesitan detalle
  const cache = await loadCache();
  const needDetail = [];
  for(const [id,agg] of byId){
    const iconAny = agg.icons.join(" ");
    const textAny = `${agg.names.join(" ")} ${agg.descs.join(" ")}`;
    const hinted = isCharterIcon(iconAny) || isCharterText(textAny);

    if(!cache[id] || isStale(cache[id]) || (!hinted && !(cache[id]?.icon))){
      needDetail.push([id, agg.geom]);
    }else{
      if(!agg.geom && cache[id]?.geom) byId.set(id, { ...agg, geom: cache[id].geom });
    }
  }

  // Resolver detalles en paralelo moderado
  await mapPool(needDetail, async ([id, geomHint])=>{
    const det = await getDetailsById(id);
    cache[id] = {
      icon: det.icon, name: det.name, desc: det.desc,
      geom: det.geom || geomHint || null,
      ts: new Date().toISOString()
    };
    return true;
  }, 8);

  await saveCache(cache);

  // Construir GeoJSON solo Charter
  const out = [];
  for(const [id,agg] of byId){
    const det = cache[id] || {};
    const iconAny = `${agg.icons.join(" ")} ${det.icon||""}`;
    const textAny = `${agg.names.join(" ")} ${agg.descs.join(" ")} ${det.name||""} ${det.desc||""}`;
    const charter = isCharterIcon(iconAny) || isCharterText(textAny);
    const geom = agg.geom || det.geom;
    if(charter && geom && Array.isArray(geom.coordinates)){
      out.push({
        type:"Feature",
        geometry: geom,
        properties:{
          id,
          name: det.name || agg.names[0] || "",
          address: strip(det.desc || agg.descs[0] || ""),
          brand: "Charter",
          icon: det.icon || agg.icons[0] || ""
        }
      });
    }
  }

  const fc = { type: "FeatureCollection", features: out };
  if(fc.features.length === 0){
    try { await fs.access(OUT); process.exit(0); } catch {}
  }
  await fs.mkdir("docs", { recursive: true });
  await fs.writeFile(OUT, JSON.stringify(fc));
  console.log("TOTAL Charter:", fc.features.length);
}

main().catch(e=>{ console.error(e); process.exit(1); });
