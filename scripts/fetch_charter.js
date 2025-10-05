// scripts/fetch_charter.js — feeds fijos + fallback por tienda
import fs from 'node:fs/promises';

const OUT = 'docs/charter.geojson';

// Feeds conocidos que devuelven features (añade más si hace falta)
const FEEDS = [
  'https://www.consum.es/get-map-list/block_supermercados_en_barcelona/',
  'https://www.consum.es/va/get-map-list/block_supermercados_en_alicante/',
  'https://www.consum.es/va/get-map-list/block_supermercados_en_valencia/',
  'https://www.consum.es/get-map-list/block_supermercados_en_castellon/',
  'https://www.consum.es/get-map-list/block_supermercados_en_murcia/',
  'https://www.consum.es/get-map-list/block_supermercados_en_albacete/'
];

const sleep = ms => new Promise(r=>setTimeout(r,ms));
const stripHtml = s => String(s||'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();

async function getText(url){
  for(let i=1;i<=3;i++){
    try{
      const r = await fetch(url, { headers:{accept:'*/*'} });
      const t = await r.text();
      return t;
    }catch(e){ if(i===3) throw e; await sleep(400*i); }
  }
}
async function getJson(url){ return JSON.parse(await getText(url)); }

// Busca array "features" aunque venga anidado (payload Drupal)
function findFeatures(obj){
  if(!obj) return null;
  if(Array.isArray(obj)){ for(const el of obj){ const f=findFeatures(el); if(f) return f; } return null; }
  if(typeof obj==='object'){
    if(Array.isArray(obj.features)) return obj.features;
    for(const k of Object.keys(obj)){ const f=findFeatures(obj[k]); if(f) return f; }
  }
  return null;
}

// Llama /get-map/{id} para obtener icon (marca) si no vino en el feed
async function getIconById(id){
  try{
    const j = await getJson(`https://www.consum.es/get-map/${id}/`);
    const f = findFeatures(j)?.[0];
    const icon = String(f?.properties?.icon || '');
    return icon;
  }catch{ return ''; }
}

async function mapFeature(raw, sourceUrl){
  // coords
  let lon=null, lat=null;
  const c = raw?.geometry?.coordinates;
  if(Array.isArray(c) && c.length>=2){ lon=+c[0]; lat=+c[1]; }
  if((lon==null||lat==null) && raw?.properties?.data?.field_coordenadas){
    const wkt = String(raw.properties.data.field_coordenadas);
    let m = /POINT\s*\(\s*(-?\d+\.?\d*)\s+(-?\d+\.?\d*)\s*\)/i.exec(wkt);
    if(m){ lon=+m[1]; lat=+m[2]; }
    if(lon==null||lat==null){ m = /(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/.exec(wkt); if(m){ lat=+m[1]; lon=+m[2]; } }
  }
  if(lon==null||lat==null) return null;

  const id = String(raw?.properties?.entity_id || '').trim() ||
             String(stripHtml(raw?.properties?.tooltip)+'|'+stripHtml(raw?.properties?.description)).toLowerCase();

  let icon = String(raw?.properties?.icon || '');
  if(!icon && id) { icon = await getIconById(id); await sleep(120); } // rate-limit ligero

  const isCharter = /charter/i.test(icon) ||
                    /\bcharter\b/i.test(stripHtml(raw?.properties?.tooltip)) ||
                    /\bcharter\b/i.test(stripHtml(raw?.properties?.description));

  if(!isCharter) return null;

  const name = stripHtml(raw?.properties?.tooltip || raw?.properties?.title || raw?.properties?.data?.title);
  const addr = stripHtml(raw?.properties?.data?.field_domicilio || raw?.properties?.field_domicilio || raw?.properties?.description);

  return {
    type:'Feature',
    geometry:{ type:'Point', coordinates:[lon,lat] },
    properties:{ id, name, address: addr, brand:'Charter', icon, source: sourceUrl }
  };
}

function dedupe(features){
  const map = new Map();
  for(const f of features){
    const k = f.properties.id || JSON.stringify(f.geometry.coordinates);
    if(!map.has(k)) map.set(k,f);
  }
  return [...map.values()];
}

async function main(){
  const all = [];
  for(const url of FEEDS){
    try{
      const j = await getJson(url);
      const feats = findFeatures(j) || [];
      const mapped = [];
      for(const f of feats){
        const g = await mapFeature(f, url);
        if(g) mapped.push(g);
      }
      console.log(`OK ${url} → total=${feats.length} charter=${mapped.length}`);
      all.push(...mapped);
      await sleep(200);
    }catch(e){
      console.warn('Fallo en', url, String(e).slice(0,160));
    }
  }
  const fc = { type:'FeatureCollection', features: dedupe(all) };
  if(fc.features.length===0){
    console.error('Vacío. Conservo el charter.geojson anterior si existe.');
    try{ await fs.access(OUT); process.exit(0); }catch{}
  }
  await fs.mkdir('docs', {recursive:true});
  await fs.writeFile(OUT, JSON.stringify(fc));
  console.log('TOTAL Charter:', fc.features.length);
}
main().catch(e=>{ console.error(e); process.exit(1); });
