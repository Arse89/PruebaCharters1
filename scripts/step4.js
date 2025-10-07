import fs from "node:fs/promises";

const ORIGIN = "https://www.consum.es";
const ROBOTS = `${ORIGIN}/robots.txt`;

async function get(u){ const r=await fetch(u,{headers:{accept:"*/*"}}); return await r.text(); }
function pickSitemaps(txt){
  return [...txt.matchAll(/(?<=^|\s)Sitemap:\s*(\S+)/gmi)].map(m=>m[1]);
}
function extractUrls(xml){
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/gmi)].map(m=>m[1]);
}
function looksStore(u){
  return /\/(supermercados|supermercats|node)\//i.test(u);
}

async function main(){
  const robots = await get(ROBOTS);
  const sitemaps = pickSitemaps(robots);
  if(!sitemaps.length){ console.log("No sitemap en robots.txt"); return; }

  const urls = new Set();
  for(const sm of sitemaps){
    try{
      const xml = await get(sm);
      for(const u of extractUrls(xml)){
        if(looksStore(u)) urls.add(u);
        if(urls.size>5000) break;
      }
    }catch{}
  }

  await fs.mkdir("docs/debug",{recursive:true});
  await fs.writeFile("docs/debug/sitemap_urls.json", JSON.stringify([...urls].slice(0,5000), null, 2));
  console.log("SITEMAP_URLS:", urls.size);
}
main().catch(e=>{ console.error(e); process.exit(1); });
