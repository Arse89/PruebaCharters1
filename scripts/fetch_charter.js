import fs from 'node:fs/promises';

const OUT = 'docs/charter.geojson';
const PROVINCES = [
  'barcelona','valencia','alicante','castellon','murcia','albacete'
];
const BASES = ['https://www.consum.es', 'https://www.consum.es/va'];

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
function stripHtml(s=''){ return s.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim(); }

function mapFeature(raw, slug, sourceUrl){
  const icon = (raw?.properties?.icon || '').toLowerCase();
  const isCharter = icon.includes('charter');
  const coords = raw?.geometry?.coordinates;
  let lon = null, lat = null;
  if (Array.isArray(coords) && coords.length>=2){
    lon = Number(coords[0]); lat = Number(coords[1]);
  } else if (raw?.properties?.data?.field_coordenadas){
    // try "lat, lon" format
    const m = String(raw.properties.data.field_coordenadas).match(/(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/);
    if (m){ lat = Number(m[1]); lon = Number(m[2]); }
  }
  const name = raw?.properties?.tooltip || raw?.properties?.title || raw?.properties?.data?.title || '';
  const addr = raw?.properties?.data?.field_domicilio || raw?.properties?.field_domicilio || raw?.properties?.description || '';
  const id = String(raw?.properties?.entity_id || raw?.entity_id || `${name}|${addr}`).toLowerCase();

  return {
    isCharter, id, lon, lat, province: slug,
    properties: {
      id,
      name: stripHtml(name),
      address: stripHtml(addr),
      province: slug,
      brand: isCharter ? 'Charter' : 'Consum',
      icon: raw?.properties?.icon || '',
      source: sourceUrl
    },
    geometry: lon!=null && lat!=null ? { type:'Point', coordinates:[lon,lat] } : null
  };
}

async function fetchJson(url){
  for(let attempt=1; attempt<=3; attempt++){
    try{
      const r = await fetch(url, { headers: { 'accept':'application/json,text/plain,*/*' } });
      if(!r.ok) throw new Error(`HTTP ${r.status}`);
      const ct = r.headers.get('content-type') || '';
      if(!/json|javascript|geojson/i.test(ct)) {
        const t = await r.text();
        throw new Error('Not JSON: '+ t.slice(0,120));
      }
      const j = await r.json();
      return j;
    }catch(e){
      if(attempt===3) throw e;
      await sleep(500*attempt);
    }
  }
}

function extractFeatures(j){
  if(!j) return [];
  if (Array.isArray(j)) return j;
  if (j.data && Array.isArray(j.data.features)) return j.data.features;
  if (Array.isArray(j.features)) return j.features;
  // views/ajax style payloads sometimes have an array of commands; ignore here
  return [];
}

async function getProvince(slug){
  for(const base of BASES){
    const url = `${base}/get-map-list/block_supermercados_en_${slug}/`;
    try{
      const j = await fetchJson(url);
      const feats = extractFeatures(j);
      if(feats.length) return { url, feats };
    }catch{ /* try next base */ }
  }
  return { url: null, feats: [] };
}

function dedupe(items){
  const map = new Map();
  for(const it of items){
    const k = it.properties.id;
    if(!map.has(k)) map.set(k, it);
  }
  return [...map.values()];
}

async function main(){
  const all = [];
  for(const slug of PROVINCES){
    const {url, feats} = await getProvince(slug);
    if(!feats.length){ console.warn('Sin datos en', slug); continue; }
    const mapped = feats.map(f => mapFeature(f, slug, url)).filter(m => m.geometry && m.isCharter);
    all.push(...mapped);
    await sleep(300);
  }
  const deduped = dedupe(all);
  const fc = { type:'FeatureCollection', features: deduped.map(d => ({
    type:'Feature',
    geometry: d.geometry,
    properties: d.properties
  })) };

  // Basic sanity checks
  if (fc.features.length === 0){
    console.error('Resultado vacío. Conservo el último charter.geojson si existe.');
    try{
      const old = await fs.readFile(OUT,'utf-8');
      console.log('Old size:', old.length);
      process.exit(0);
    }catch{
      // no previous file; write empty
    }
  }
  await fs.mkdir('docs', {recursive:true});
  await fs.writeFile(OUT, JSON.stringify(fc));
  console.log('Charter features:', fc.features.length);
}
main().catch(err => { console.error(err); process.exit(1); });