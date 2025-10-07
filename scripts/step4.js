// Abre /supermercados/, cambia a "Listado", activa filtro "Charter",
// pagina todo el listado, extrae IDs y luego saca coords con get-map/{id}.
// Es simple: sin AJAX manual, sin grid de mapa.
import fs from "node:fs/promises";
import { chromium } from "playwright";

const START = "https://www.consum.es/supermercados/";
const OUT   = "docs/charter.geojson";

const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
const strip = (s="")=>String(s).replace(/<[^>]*>/g," ").replace(/\s+/g," ").trim();
const isCharter = (icon="", text="") => /charter/i.test(icon) || /\bcharter\b/i.test(text);

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

async function main(){
  const browser = await chromium.launch({ args:["--no-sandbox"] });
  const page = await browser.newPage({ viewport:{ width:1280, height:900 } });

  // Captura de errores en consola para depurar
  page.on("pageerror", e=>console.log("PAGEERR:", String(e).slice(0,160)));

  await page.goto(START, { waitUntil:"domcontentloaded" });

  // 1) Cerrar cookies OneTrust
  try{
    await page.waitForSelector('#onetrust-accept-btn-handler, #onetrust-reject-all-handler', { timeout: 6000 });
    await page.locator('#onetrust-reject-all-handler, #onetrust-accept-btn-handler').first().click({ force:true });
    await page.keyboard.press('Escape').catch(()=>{});
    await page.evaluate(()=>{ const sdk=document.getElementById('onetrust-consent-sdk'); if(sdk) sdk.remove(); });
  }catch{}

  // 2) Cambiar a "Listado"
  try{
    const listado = page.getByText(/Listado/i).first();
    if(await listado.isVisible()) await listado.click({ force:true });
  }catch{}

  await page.waitForLoadState("networkidle");
  await sleep(400);

  // 3) Activar filtro Charter
  try{
    const charter = page.getByText(/Charter/i).first();
    if(await charter.isVisible()) await charter.click({ force:true });
  }catch{}
  await page.waitForLoadState("networkidle");
  await sleep(400);

  // 4) Recolector de una página de listado
  async function scrapeListPage(){
    return await page.evaluate(()=>{
      const out = [];
      // Preferencia: elementos con data-entity-id
      document.querySelectorAll('[data-entity-id]').forEach(el=>{
        const id = String(el.getAttribute('data-entity-id')||'').trim();
        if(!id) return;
        const card = el.closest('article,li,div') || el;
        const name = (card.querySelector('h3,h2,.title')?.textContent||'').trim();
        const addr = (card.querySelector('[class*="domicilio"], [class*="address"], .address, p')?.textContent||'').trim();
        const href = card.querySelector('a[href]')?.getAttribute('href') || '';
        out.push({ id, name, addr, href });
      });
      // Fallback: IDs en enlaces /node/123
      document.querySelectorAll('a[href*="/node/"]').forEach(a=>{
        const m = a.getAttribute('href').match(/\/node\/(\d+)/);
        if(!m) return;
        const id = m[1];
        if(out.some(x=>x.id===id)) return;
        const card = a.closest('article,li,div') || a;
        const name = (card.querySelector('h3,h2,.title')?.textContent||a.textContent||'').trim();
        const addr = (card.querySelector('[class*="domicilio"], [class*="address"], .address, p')?.textContent||'').trim();
        out.push({ id, name, addr, href: a.getAttribute('href') });
      });
      return out;
    });
  }

  // 5) Paginar hasta no crecer
  const seen = new Map(); // id -> {name,addr}
  let stagnant = 0;
  for(let pageIdx=0; pageIdx<80; pageIdx++){
    const rows = await scrapeListPage();
    let grew = 0;
    for(const r of rows){
      if(!r.id) continue;
      if(!seen.has(r.id)) { seen.set(r.id, { name:r.name, addr:r.addr }); grew++; }
    }
    // Avanzar
    const next = page.locator('button[aria-label="Siguiente"], a[aria-label="Siguiente"], text=Siguiente').first();
    const canNext = await next.isVisible().catch(()=>false);
    if(!canNext){ break; }
    await next.click({ force:true });
    await page.waitForLoadState("networkidle");
    await sleep(300);

    stagnant = grew===0 ? stagnant+1 : 0;
    if(stagnant>=2) break;
  }

  const ids = [...seen.keys()];
  console.log("IDS listado (Charter):", ids.length);

  await browser.close();

  // 6) Detalles por ID → coords + validación Charter
  const feats = [];
  for(const id of ids){
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
        name: det.name || seen.get(id)?.name || "",
        address: strip(det.desc || seen.get(id)?.addr || ""),
        brand: "Charter",
        icon: det.icon || ""
      }
    });
    await sleep(40);
  }

  // 7) Escribir GeoJSON
  const fc = { type:"FeatureCollection", features: feats, metadata:{ source:"listado Charter + get-map/{id}", ids: ids.length, charter: feats.length, generated_at: new Date().toISOString() } };
  await fs.mkdir("docs",{recursive:true});
  await fs.writeFile(OUT, JSON.stringify(fc));
  console.log(`LIST_IDS=${ids.length}  CHARTER=${feats.length}  → ${OUT}`);
}

main().catch(e=>{ console.error(e); process.exit(1); });
