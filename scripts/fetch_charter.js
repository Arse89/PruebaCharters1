// scripts/fetch_charter.js
import fs from 'node:fs/promises';

const OUT = 'docs/charter.geojson';

// Provincias iniciales. Puedes añadir más.
const PROVINCES = ['barcelona','valencia','alicante','castellon','murcia','albacete'];

// La web tiene versión ES y VA. Probamos ambas.
const BASES = ['https://www.consum.es', 'https://www.consum.es/va'];

const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
const stripHtml = (s='')=>s.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();

// 1) Descarga SIEMPRE como texto y luego JSON.parse (a veces el header no es JSON)
async function fetchJson(url){
  for(let attempt=1; attempt<=3; attempt++){
    try{
      const r = await fetch(url, { headers: { 'accept': '*/*' } });
      const txt = await r.text();
      return JSON.parse(txt);
    }catch(e){
      if(attempt===3) throw e;
      await sleep(500*attempt);
    }
  }
}

// 2) Encuentra "features" aunque estén anidadas en estructuras Drupal
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
const extractFeatures = (j)=> findFeatures(j) || [];

// 3) Intenta el feed por provincia en ES y VA
async function getProvince(slug){
  for(const base of BASES){
    const url = `${base}/get-map-list/block_supermercados_en_${slug}/`;
    try{
      const j = await fetchJson(url);
      const feats = extractFeatures(j);
      if(feats.length) return { url, feats };
    }catch{/* probar siguiente base */}
  }
  return { url:null, feats:[] };
}

// 4) Mapea item → Feature. Filtra Charter por icono.
//    Extrae coords de geometry o de WKT/latlon en field_coordenadas.
function toFeature(raw, slug, sourceUrl){
  const icon = String(raw?.properties?.icon || '').toLowerCase();
  const isCharter = icon.includes('charter');

  // coords
  let lon = null, lat = null;
  const coords = raw?.geometry?.coordinates;
  if(Array.isArray(coords) && coords.length>=2){
    lon = Number(coords[0]); lat = Number(coords[1]);
  }
  // WKT "POINT (lon lat)"
  if((lon==null || lat==null) && raw?.properties?.data?.field_coordenadas){
    const wkt = String(raw.properties.data.field_coordenadas);
    const m = /POINT\s*\(\s*(-?\d+\.?\d*)\s+(-?\d+\.?\d*)\s*\)/i.exec(wkt);
    if(m){ lon = Number(m[1]); lat = Number(m[2]); }
  }
  // "lat, lon"
  if((lon==null || lat==null) && raw?.properties?.data?.field_coordenadas){
    const m = String(raw.properties.data.field_coordenadas).match(/(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/);
    if(m){ lat = Number(m[1]); lon = Number(m[2]); }
  }

  const name = stripHtml(raw?.properties?.tooltip || raw?.properties?.title || raw?.properties?.data?.title || '');
  const addr = stripHtml(raw?.properties?.data?.field_domicilio || raw?.properties?.field_domicilio || raw?.properties?.description || '');
  const id = String(raw?.properties?.entity_id || `${name}|${addr}`.toLowerCase());

  if(!isCharter || lon==null || lat==null) return null;

  return {
    type:'Feature',
    geometry:{ type:'Point', coordinates:[lon,lat] },
    properties:{
      id, name, address: addr, province: slug,
      brand:'Charter', icon: raw?.properties?.icon || '',
      source: sourceUrl
    }
  };
}

function dedupe(features){
  const seen = new Map();
  for(const f of features){
    const k = f.properties.id;
    if(!seen.has(k)) seen.set(k,f);
  }
  return [...seen.values()];
}

// 5) Main
async function main(){
  const all = [];
  for(const slug of PROVINCES){
    const {url, feats} = await getProvince(slug);
    if(!feats.length){ console.warn('Sin datos en', slug); continue; }
    const mapped = feats.map(f=>toFeature(f, slug, url)).filter(Boolean);
    all.push(...mapped);
    await sleep(300);
  }
  const fc = { type:'FeatureCollection', features: dedupe(all) };

  // Sanity: si vacío, no sobrescribas el último bueno
  if(fc.features.length===0){
    console.error('Resultado vacío. Conservo el charter.geojson anterior si existe.');
    try{
      await fs.access(OUT); // existe → salir sin escribir
      process.exit(0);
    }catch{
      // no existe → escribir vacío
    }
  }
  await fs.mkdir('docs', {recursive:true});
  await fs.writeFile(OUT, JSON.stringify(fc));
  console.log('Charter features:', fc.features.length);
}
main().catch(err=>{ console.error(err); process.exit(1); });
