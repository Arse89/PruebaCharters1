// Lista "Charter" → IDs por DOM+XHR → detalle get-map/{id} → GeoJSON
import fs from "node:fs/promises";
import { chromium } from "playwright";

const START = "https://www.consum.es/supermercados/";
const OUT   = "docs/charter.geojson";

const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
const strip = (s="")=>String(s).replace(/<[^>]*>/g," ").replace(/\s+/g," ").trim();
const isCharter = (icon="", text="") => /charter/i.test(icon) || /\bcharter\b/i.test(text);

// --- util HTTP sin CORS (desde Node, no Playwright)
async function getText(url, ms=12000){
  const ctrl = new AbortController(); const t = setTimeout(()=>ctrl.abort(), ms);
  try{
    const r = await fetch(url, { headers:{accept:"*/*"}, signal: ctrl.signal });
    const txt = await r.text();
    if(!r.ok) throw new Error(`HTTP ${r.status} ${txt.slice(0,120)}`);
    return txt;
  } finally { clearTimeout(t); }
}
function findFeatures(obj){
  if(!obj) return null;
  if(Array.isArray(obj)){ for(const el of obj){ const f=findFeatures(el); if(f) return f; } return null; }
  if(typeof obj==="object"){
    if(Array.isArray(obj.features)) return obj.features;
    for(const v of Object.values(obj)){ const f=findFeatures(v); if(f) return f; }
  }
  return null;
}
async function getDetailsById(id){
  for(const base of ["https://www.consum.es","https://www.consum.es/va"]){
    try{
      const j = JSON.parse(await getText(`${base}/get-map/${id}/`, 10000));
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

// --- parseo de IDs desde HTML/JSON crudo ---
function extractIdsFromHtml(html){
  const ids = new Set();
  const re = /\/node\/(\d+)/g; let m;
  while((m = re.exec(html))) ids.add(m[1]);
  // A veces llegan como data-entity-id="123456"
  const re2 = /data-entity-id=["'](\d+)["']/g; let m2;
  while((m2 = re2.exec(html))) ids.add(m2[1]);
  return ids;
}

// --- principal ---
async function main(){
  const browser = await chromium.launch({ args:["--no-sandbox"] });
  const page = await browser.newPage({ viewport:{ width:1280, height:900 } });

  // Captura de XHR/HTML del listado
  const idsNet = new Set();
  page.on("requestfinished", async (req) => {
    const rt = req.resourceType();
    if(rt!=="xhr" && rt!=="fetch" && rt!=="document") return;
    try{
      const res = await req.response();
      const ct = res.headers()["content-type"] || "";
      const body = await res.text();
      if(!/json|html|javascript/i.test(ct)) return;
      for(const id of extractIdsFromHtml(body)) idsNet.add(id);
    }catch{}
  });

  await page.goto(START, { waitUntil:"domcontentloaded" });

  // Cerrar cookies OneTrust
  try{
    await page.waitForSelector('#onetrust-accept-btn-handler, #onetrust-reject-all-handler', { timeout: 6000 });
    await page.locator('#onetrust-reject-all-handler, #onetrust-accept-btn-handler').first().click({ force:true });
    await page.keyboard.press('Escape').catch(()=>{});
    await page.evaluate(()=>{ const sdk=document.getElementById('onetrust-consent-sdk'); if(sdk) sdk.remove(); });
  }catch{}

  // Cambiar a "Listado" (tab o botón)
  try{
    const listadoTab = page.getByRole('tab', { name: /Listado/i }).first();
    if(await listadoTab.isVisible()) await listadoTab.click({ force:true });
    else {
      const listadoTxt = page.getByText(/Listado/i).first();
      if(await listadoTxt.isVisible()) await listadoTxt.click({ force:true });
    }
  }catch{}
  await page.waitForLoadState("networkidle");
  await sleep(400);

  // Abrir panel de filtros si existe
  try{
    const filtrosBtn = page.getByRole('button', { name: /Filtros|Filtrar/i }).first();
    if(await filtrosBtn.isVisible()) await filtrosBtn.click({ force:true });
  }catch{}

  // Activar filtro "Charter" (suele ser un checkbox o chip)
  try{
    const charter = page.getByLabel(/Charter/i).first();
    if(await charter.isVisible()) { await charter.check({ force:true }).catch(async()=>{ await charter.click({force:true}); }); }
    else{
      const chip = page.getByText(/^Charter$/i).first();
      if(await chip.isVisible()) await chip.click({ force:true });
    }
  }catch{}
  await page.waitForLoadState("networkidle");
  await sleep(500);

  // Función para extraer IDs del DOM actual
  async function idsFromDom(){
    const { ids, rows } = await page.evaluate(()=>{
      const out = new Set();
      document.querySelectorAll('[data-entity-id]').forEach(el=>{
        const id = el.getAttribute('data-entity-id'); if(id) out.add(id);
      });
      document.querySelectorAll('a[href*="/node/"]').forEach(a=>{
        const m = a.getAttribute('href').match(/\/node\/(\d+)/); if(m) out.add(m[1]);
      });
      return { ids: Array.from(out), rows: document.querySelectorAll('article, li, .store, .result').length };
    });
    return { ids: new Set(ids), rows };
  }

  // Paginación del listado hasta no crecer
  const idsDom = new Set();
  let stagnant = 0;
  for(let i=0; i<80; i++){
    // extrae
    const snap = await idsFromDom();
    for(const id of snap.ids) idsDom.add(id);

    // siguiente
    const next = page.locator('button[aria-label="Siguiente"], a[aria-label="Siguiente"], text=/Siguiente/i').first();
    const canNext = await next.isVisible().catch(()=>false);
    const beforeCount = idsDom.size + idsNet.size;

    if(!canNext){
      // intenta scroll por si hay lazy-load
      await page.mouse.wheel(0, 2000);
      await page.waitForLoadState("networkidle");
      await sleep(300);
      const afterScroll = idsDom.size + idsNet.size;
      if(afterScroll === beforeCount) stagnant++;
      if(stagnant >= 2) break;
      continue;
    }

    await next.click({ force:true });
    await page.waitForLoadState("networkidle");
    await sleep(300);

    const afterClick = idsDom.size + idsNet.size;
    stagnant = (afterClick === beforeCount) ? stagnant+1 : 0;
    if(stagnant >= 2) break;
  }

  const ids = new Set([...idsDom, ...idsNet]);
  console.log("IDS_DOM:", idsDom.size, "IDS_XHR:", idsNet.size, "UNION:", ids.size);

  await browser.close();

  // Detalles por ID → coords + verificación Charter
  const feats = [];
  let idx = 0;
  for(const id of ids){
    idx++;
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
        icon: det.icon || ""
      }
    });
    await sleep(40);
  }

  const fc = { type:"FeatureCollection", features: feats,
    metadata:{ source:"Listado Charter + XHR + get-map/{id}", ids_seen: ids.size, charter: feats.length, generated_at: new Date().toISOString() } };
  await fs.mkdir("docs",{recursive:true});
  await fs.writeFile(OUT, JSON.stringify(fc));
  console.log(`LIST_IDS=${ids.size}  CHARTER=${feats.length}  → ${OUT}`);
}

main().catch(e=>{ console.error(e); process.exit(1); });
