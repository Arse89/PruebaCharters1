// scripts/fetch_charter.js — autodiscovery de feeds y filtro Charter
import fs from 'node:fs/promises';

const OUT = 'docs/charter.geojson';
const BASES = ['https://www.consum.es/supermercados/', 'https://www.consum.es/va/supermercados/'];

const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
const stripHtml = (s='')=>String(s||'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();

async function getText(url){
  for(let i=1;i<=3;i++){
    try{
      const r = await fetch(url, { headers:{accept:'*/*'} });
      if(!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.text();
    }catch(e){ if(i===3) throw e; await sleep(400*i); }
  }
}

async function getJson(url){
  const txt = await getText(url);        // a veces responde JSON con content-type raro
  return JSON.parse(txt);
}

// Captura todos los endpoints .../get-map-list/... presentes en la página
async function discoverFeeds(){
  const urls = new Set();
  for(const base of BASES){
    const html = await getText(base);
    const re = /https?:\/\/[^"' ]+\/get-map-list\/[^"' )]+/gi;
    let m; while((m = re.exec(html))){ urls.add(m[0]); }
  }
  return [...urls];
}

function findFeatures(obj){
  if(!obj) return null;
  if(Array.isArray(obj)){
    for(const el of obj){ const f = findFeatures(el); if(f) return f; }
    return null;
  }
  if(typeof obj==='object'){
    if(Array.isArray(obj.features)) return obj.features;
    for(const k of Object.keys(obj)){
      const f = findFeatures(obj[k]); if(f) return f;
    }
  }
  return null;
}

function toFeature(raw, sourceUrl){
  const icon = String(raw?.properties?.icon || '');
  const name = stripHtml(raw?.properties?.tooltip || raw?.properties?.title || raw?.properties?.data?.title);
  const addr = stripHtml(raw?.properties?.data?.field_domicilio || raw?.properties?.field_domicilio || raw?.properties?.description);
  const isCharter = /charter/i.test(icon) || /\bcharter\b/i.test(name) || /\bcharter\b/i.test(addr);

  // coords
  let lon=null, lat=null;
  const c = raw?.geometry?.coordinates;
  if(Array.isArray(c) && c.length>=2){ lon=+c[0]; lat=+c[1]; }
  if((lon==null||lat==null) && raw?.properties?.data?.field_coordenadas){
    const wkt = String(raw.properties.data.field_coordenadas);
    let m = /POINT\s*\(\s*(-?\d+\.?\d*)\s+(-?\d+\.?\d*)\s*\)/i.exec(wkt);
    if(m){ lon=+m[1]; lat=+m[2]; }
    if(lon==null||lat==null){
      m = /(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/.exec(wkt); // lat, lon
      if(m){ lat=+m[1]; lon=+m[2]; }
    }
  }

  const id = String(raw?.properties?.entity_id || `${name}|${addr}`).toLowerCase();
  if(!isCharter || lon==null || lat==null) return null;

  return {
    type:'Feature',
    geometry:{ type:'Point', coordinates:[lon,lat] },
    properties:{ id, name, address: addr, brand:'Charter', icon, source: sourceUrl }
  };
}

function dedupe(features){
  const map = new Map();
  for(const f of features){
    const k = f.properties.id;
    if(!map.has(k)) map.set(k,f);
  }
  return [...map.values()];
}

async function main(){
  const feedUrls = await discoverFeeds();
  if(!feedUrls.length) throw new Error('No se descubrieron feeds get-map-list');

  console.log('Feeds detectados:', feedUrls.length);
  const all = [];
  for(const url of feedUrls){
    try{
      const j = await getJson(url);
      const feats = findFeatures(j) || [];
      const mapped = feats.map(f=>toFeature(f, url)).filter(Boolean);
      console.log(`OK ${url} → total=${feats.length} charter=${mapped.length}`);
      all.push(...mapped);
      await sleep(200);
    }catch(e){
      console.warn('Fallo en', url, String(e).slice(0,120));
    }
  }

  const deduped = dedupe(all);
  const fc = { type:'FeatureCollection', features: deduped };

  if(fc.features.length===0){
    console.error('Resultado vacío. Conservo charter.geojson anterior si existe.');
    try{ await fs.access(OUT); process.exit(0); }catch{}
  }
  await fs.mkdir('docs', {recursive:true});
  await fs.writeFile(OUT, JSON.stringify(fc));
  console.log('TOTAL Charter:', fc.features.length);
}
main().catch(err=>{ console.error(err); process.exit(1); });
