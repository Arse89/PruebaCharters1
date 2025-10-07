import fs from "node:fs/promises";
import { chromium } from "playwright";

const START = "https://www.consum.es/supermercados/";

async function main(){
  await fs.mkdir("docs/debug", { recursive: true });

  const browser = await chromium.launch({ args:["--no-sandbox"] });
  const page = await browser.newPage({
    viewport:{ width: 1366, height: 900 },
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari"
  });

  // Log básico
  page.on("console", m=>console.log("PAGE:", m.text()));

  await page.goto(START, { waitUntil: "domcontentloaded" });

  // 0) Cerrar cookies
  try {
    await page.waitForSelector('#onetrust-accept-btn-handler, #onetrust-reject-all-handler', { timeout: 6000 });
    await page.locator('#onetrust-reject-all-handler, #onetrust-accept-btn-handler').first().click({ force: true });
    await page.keyboard.press('Escape').catch(()=>{});
    await page.evaluate(()=>{ const sdk=document.getElementById('onetrust-consent-sdk'); if(sdk) sdk.remove(); });
  } catch {}

  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: "docs/debug/00_home.png", fullPage: true });
  await fs.writeFile("docs/debug/00_home.html", await page.content());

  // 1) Cambiar a “Listado”
  let listadoClicked = false;
  try {
    const tab = page.getByRole('tab', { name: /Listado/i }).first();
    if (await tab.isVisible()) { await tab.click({ force:true }); listadoClicked = true; }
  } catch {}
  if (!listadoClicked) {
    try {
      const txt = page.getByText(/Listado/i).first();
      if (await txt.isVisible()) { await txt.click({ force:true }); listadoClicked = true; }
    } catch {}
  }

  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: "docs/debug/01_listado.png", fullPage: true });
  await fs.writeFile("docs/debug/01_listado.html", await page.content());

  // 2) Abrir filtros
  try {
    const filtrosBtn = page.getByRole('button', { name: /Filtros|Filtrar|Filters|Filtrar resultats/i }).first();
    if (await filtrosBtn.isVisible()) await filtrosBtn.click({ force:true });
  } catch {}

  // 3) Activar “Charter”
  let charterClicked = false;
  try {
    const chk = page.getByLabel(/Charter/i).first();
    if (await chk.isVisible()) { await chk.check({ force:true }).catch(async()=>{ await chk.click({ force:true }); }); charterClicked = true; }
  } catch {}
  if (!charterClicked) {
    try {
      const chip = page.getByText(/^Charter$/i).first();
      if (await chip.isVisible()) { await chip.click({ force:true }); charterClicked = true; }
    } catch {}
  }

  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: "docs/debug/02_charter.png", fullPage: true });
  await fs.writeFile("docs/debug/02_charter.html", await page.content());

  // 4) Contar IDs actuales y enlaces /node/
  const stats = await page.evaluate(()=>{
    const ids = new Set();
    document.querySelectorAll('[data-entity-id]').forEach(el=>{
      const id = el.getAttribute('data-entity-id'); if(id) ids.add(id);
    });
    const nodeLinks = Array.from(document.querySelectorAll('a[href*="/node/"]'))
      .map(a => (a.getAttribute('href')||'').match(/\/node\/(\d+)/)?.[1])
      .filter(Boolean);
    return { idsCount: ids.size, nodeLinksCount: nodeLinks.length };
  });

  console.log("STATS:", stats);
  await page.screenshot({ path: "docs/debug/03_after_counts.png", fullPage: true });

  await browser.close();

  // marcador para el workflow
  await fs.writeFile("docs/debug/STATS.json", JSON.stringify(stats, null, 2));
  console.log("Listo → revisa docs/debug/*.png y *.html");
}

main().catch(e=>{ console.error(e); process.exit(1); });
