// Lista por provincia → Charter → IDs → get-map/{id} → GeoJSON
import fs from "node:fs/promises";
import { chromium } from "playwright";

const START = "https://www.consum.es/supermercados/";
const OUT   = "docs/charter.geojson";
const PROVINCES = ["Barcelona"]; // añade más luego: "Valencia","Alicante","Castellón","Murcia","Albacete"

const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
const strip = (s="")=>String(s).replace(/<[^>]*>/g," ").replace(/\s+/g," ").trim();
const isCharter = (icon="", text="") => /charter/i.test(icon) || /\bcharter\b/i.test(text);

async function getText(url, ms=12000){
  const ctrl = new AbortController(); const t=setTimeout(()=>ctrl.abort(), ms);
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

async function closeCookies(page){
  try {
    await page.waitForSelector('#onetrust-accept-btn-handler, #onetrust-reject-all-handler', { timeout: 6000 });
    await page.locator('#onetrust-reject-all-handler, #onetrust-accept-btn-handler').first().click({ force:true });
    await page.keyboard.press('Escape').catch(()=>{});
    await page.evaluate(()=>{ const sdk=document.getElementById('onetrust-consent-sdk'); if(sdk) sdk.remove(); });
  } catch {}
}

async function gotoListado(page){
  // tab “Listado” o botón equivalente
  for(const sel of [
    () => page.getByRole('tab', { name: /Listado/i }).first(),
    () => page.getByText(/Listado/i).first()
  ]){
    try{ const h=sel(); if(await h.isVisible()) { await h.click({force:true}); break; } }catch{}
  }
  await page.waitForLoadState("networkidle");
  await sleep(300);
}

async function openFilters(page){
  for(const sel of [
    () => page.getByRole('button', { name: /Filtros|Filtrar|Filters|Filtrar resultats/i }).first(),
    () => page.locator('button:has-text("Filtros"), button:has-text("Filtrar")').first()
  ]){
    try{ const b=sel(); if(await b.isVisible()) { await b.click({force:true}); break; } }catch{}
  }
  await page.waitForLoadState("networkidle");
  await sleep(200);
}

async function setCharter(page){
  // checkbox/label/chip “Charter”
  for(const sel of [
    async ()=>{ const x=page.getByLabel(/Charter/i).first(); if(await x.isVisible()) { await x.check({force:true}).catch(async()=>{ await x.click({force:true}); }); return true; } },
    async ()=>{ const x=page.getByText(/^Charter$/i).first(); if(await x.isVisible()) { await x.click({force:true}); return true; } }
  ]){
    try{ if(await sel()) break; }catch{}
  }
  await page.waitForLoadState("networkidle");
  await sleep(300);
}

async function selectProvince(page, name){
  // intenta por label
  try{
    const sel = page.getByLabel(/Provincia|Província|Provincia\/Ciudad|Provincia y ciudad/i).first();
    if(await sel.isVisible()){ await sel.selectOption({ label: new RegExp(`^${name}$`,'i') }); return; }
  }catch{}
  // intenta <select> genérico en panel de filtros
  try{
    const selects = page.locator('select').filter({ hasNot: page.locator('[multiple]') });
    const count = await selects.count();
    for(let i=0;i<count;i++){
      const s = selects.nth(i);
      const opts = await s.locator('option').allTextContents();
      if(opts.some(t=>new RegExp(`^${name}$`,'i').test(t.trim()))){
        await s.selectOption({ label: new RegExp(`^${name}$`,'i') });
        return;
      }
    }
  }catch{}
  // intenta combobox editable
  try{
    const combo = page.getByRole('combobox').first();
    if(await combo.isVisible()){
      await combo.click({force:true});
      await combo.fill(name);
      await page.keyboard.press('Enter').catch(()=>{});
    }
  }catch{}
  await page.waitForLoadState("networkidle");
  await sleep(400);
}

async function idsFromDom(page){
  const { ids, rows } = await page.evaluate(()=>{
    const out = new Set();
    document.querySelectorAll('[data-entity-id]').forEach(el=>{
      const id = el.getAttribute('data-entity-id'); if(id) out.add(id);
    });
    document.querySelectorAll('a[href*="/node/"]').forEach(a=>{
      const m = a.getAttribute('href')?.match(/\/node\/(\d+)/); if(m) out.add(m[1]);
    });
    return { ids: Array.from(out), rows: document.querySelectorAll('article, li, .store, .result').length };
  });
  return { ids: new Set(ids), rows };
}

async function paginateAndCollect(page){
  const ids = new Set();
  let stagnant = 0;
  for(let i=0;i<80;i++){
    const snap = await idsFromDom(page);
    for(const id of snap.ids) ids.add(id);

    const before = ids.size;
    // botón Siguiente o scroll si no existe
    const next = page.locator('button[aria-label*="Siguiente"], a[aria-label*="Siguiente"], text=/Siguiente|Següent|Next/i').first();
    const canNext = await next.isVisible().catch(()=>false);
    if(canNext){
      await next.click({ force:true });
      await page.waitForLoadState("networkidle");
      await sleep(300);
    } else {
      await page.mouse.wheel(0,2000);
      await page.waitForLoadState("networkidle");
      await sleep(300);
    }
    stagnant = (ids.size===before) ? stagnant+1 : 0;
    if(stagnant>=2) break;
  }
  return ids;
}

async function main(){
  const browser = await chromium.launch({ args:["--no-sandbox"] });
  const page = await browser.newPage({ viewport:{ width:1366, height:900 } });

  const allIds = new Set();

  for(const prov of PROVINCES){
    await page.goto(START, { waitUntil:"domcontentloaded" });
    await closeCookies(page);
    await gotoListado(page);
    await openFilters(page);
    await selectProvince(page, prov);
    await setCharter(page);

    const ids = await paginateAndCollect(page);
    console.log(`Provincia ${prov}: IDs=${ids.size}`);
    ids.forEach(id=>allIds.add(id));
  }

  await browser.close();

  // Detalle por ID → validación Charter + coords
  const feats = [];
  let k = 0;
  for(const id of allIds){
    k++;
    const det = await getDetailsById(id);
    const text = `${det.name||""} ${det.desc||""}`;
    if(!isCharter(det.icon, text)) continue;
    const g = det.geom;
    if(!g || !Array.isArray(g.coordinates)) continue;
    feats.push({
      type:"Feature",
      geometry: g,
      properties:{ id, name: det.name||"", address: strip(det.desc||""), brand:"Charter", icon: det.icon||"" }
    });
    await sleep(40);
  }

  await fs.mkdir("docs",{recursive:true});
  const fc = { type:"FeatureCollection", features: feats, metadata:{ provinces: PROVINCES, ids_seen: allIds.size, charter: feats.length, generated_at: new Date().toISOString() } };
  await fs.writeFile(OUT, JSON.stringify(fc));
  console.log(`TOTAL Provincias=${PROVINCES.length}  IDs=${allIds.size}  CHARTER=${feats.length} → ${OUT}`);
}
main().catch(e=>{ console.error(e); process.exit(1); });
