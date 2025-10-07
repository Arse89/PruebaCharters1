// step5: Barcelona via Drupal Views AJAX → IDs → get-map/{id} → solo Charter
import fs from "node:fs/promises";

const FEED = "https://www.consum.es/get-map-list/block_supermercados_en_barcelona/";
const OUT  = "docs/charter.geojson";

const sleep = ms => new Promise(r=>setTimeout(r,ms));
const strip = s => String(s||"").replace(/<[^>]*>/g," ").replace(/\s+/g," ").trim();

async function getText(url, {method="GET", body=null, timeout=12000, headers={}} = {}){
  const ctrl = new AbortController(); const t = setTimeout(()=>ctrl.abort(), timeout);
  try{
    const r = await fetch(url, { method, body, headers: { accept:"*/*", ...headers }, signal: ctrl.signal });
    const txt = await r.text();
    if(!r.ok) throw new Error(`HTTP ${r.status} ${txt.slice(0,120)}`);
    return txt;
  } finally { clearTimeout(t); }
}
const getJson = async (url, opt={}) => JSON.parse(await getText(url, opt));

function find(obj, pred){
  if(!obj) return null;
  if(Array.isArray(obj)){ for(const x of obj){ const f=find(x,pred); if(f) return f; } return null; }
  if(typeof obj==="object"){
    if(pred(obj)) return obj;
    for(const v of Object.values(obj)){ const f=find(v,pred); if(f) return f; }
  }
  return null;
}
const findFeatures = (o)=> find(o, x => Array.isArray(x.features))?.features || [];

async function discoverParams(){
  const j = await getJson(FEED); // el feed inicial suele incluir los params de la View
  const p = {};
  const grab = (k) => (find(j, x => typeof x[k]==="string")||{})[k];
  p.view_name      = grab("view_name")      || "supermercados";
  p.view_display_id= grab("view_display_id")|| "block_supermercados_en_barcelona";
  p.view_args      = grab("view_args")      || "";
  p.view_path      = grab("view_path")      || "/supermercados/";
  p.view_dom_id    = grab("view_dom_id")    || "map";
  const ajaxBase = FEED.includes("/va/") ? "https://www.consum.es/va/views/ajax" : "https://www.consum.es/views/ajax";
  return { p, ajaxBase, first: findFeatures(j) };
}

async function fetchPage(ajaxBase, p, page){
  const form = new URLSearchParams({
    view_name: p.view_name,
    view_display_id: p.view_display_id,
    view_args: p.view_args,
    view_path: p.view_path,
    view_dom_id: p.view_dom_id,
    pager_element: "0",
    page: String(page)
  });
  const txt = await getText(ajaxBase, { method:"POST", body: form, headers:{ "content-type":"application/x-www-form-urlencoded" } }).catch(()=>null);
  if(!txt) return [];
  let arr; try{ arr = JSON.parse(txt); } catch { return []; }
  return findFeatures(arr) || [];
}

async function getDetailsById(id){
  for(const base of ["https://www.consum.es","https://www.consum.es/va"]){
    try{
      const j = await getJson(`${base}/get-map/${id}/`);
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

async function main(){
  // 1) Descubre params + primera página
  const { p, ajaxBase, first } = await discoverParams();

  // 2) Recorre páginas hasta no crecer
  const seen = new Set(); const raws = [];
  const add = (feats)=>{ let a=0; for(const f of feats){ const id=String(f?.properties?.entity_id||""); if(id && !seen.has(id)){ seen.add(id); raws.push(f); a++; } } return a; };
  add(first);
  let stagnant = 0;
  for(let page=1; page<=100; page++){
    const feats = await fetchPage(ajaxBase, p, page);
    const grew = add(feats);
    stagnant = grew===0 ? stagnant+1 : 0;
    if(stagnant>=2) break;
    await sleep(120);
  }
  console.log(`VIEWS_PAGES≈${seen.size? (stagnant? "end":"limit") : 0}  IDS=${seen.size}`);

  // 3) Detalle por ID y filtro Charter
  const idList = [...seen];
  const details = new Map();
  await mapPool(idList, async (id)=>{ details.set(id, await getDetailsById(id)); return true; }, 8);

  const featsOut = [];
  for(const id of idList){
    const det = details.get(id) || {};
    const icon = det.icon || "";
    const text = `${det.name||""} ${det.desc||""}`;
    const isCharter = /charter/i.test(icon) || /\bcharter\b/i.test(text);
    const geom = det.geom;
    if(isCharter && geom && Array.isArray(geom.coordinates)){
      featsOut.push({
        type:"Feature",
        geometry: geom,
        properties:{ id, name: det.name||"", address: strip(det.desc||""), brand:"Charter", icon }
      });
    }
  }

  const fc = { type:"FeatureCollection", features: featsOut,
               metadata:{ source:"views/ajax + get-map/{id}", ids_total:idList.length, charter:featsOut.length, generated_at:new Date().toISOString() } };
  await fs.mkdir("docs",{recursive:true});
  await fs.writeFile(OUT, JSON.stringify(fc));
  console.log(`IDS=${idList.length}  CHARTER=${featsOut.length}  → ${OUT}`);
}
main().catch(e=>{ console.error(e); process.exit(1); });
