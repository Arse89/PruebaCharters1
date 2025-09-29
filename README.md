# Charter Map — Starter

Dataset y web estática de Charters (Consum) con CI/CD en GitHub Actions.

## Qué incluye
- **GitHub Actions**: job nocturno que descarga feeds JSON provinciales, filtra **Charter** y publica `docs/charter.geojson` con **versionado por commits**.
- **Front estático** (MapLibre) en `docs/` listo para **GitHub Pages**.
- **Rollback** automático: si el feed falla, conserva la última versión válida.

## Empezar (paso a paso)
1. Crea un repositorio en GitHub y sube estos archivos tal cual.
2. Activa **GitHub Pages**: Settings → Pages → Source = `Deploy from a branch`, Branch = `main`, Folder = `/docs`.
3. Ve a **Actions** y habilita workflows si te lo pide.
4. Ejecuta el workflow **Build dataset** manualmente (Run workflow). Luego se ejecutará cada noche a las 02:00 (Europa/Madrid).
5. Abre tu web: `https://<tu_usuario>.github.io/<tu_repo>/`

## Configuración del dataset
- Provincias utilizadas por defecto: `barcelona`, `valencia`, `alicante`, `castellon`, `murcia`, `albacete`.
- Puedes editar `scripts/fetch_charter.js` para añadir/quitar provincias.
- El script intenta ambas rutas (`/` y `/va/`) y varios esquemas JSON.

## Notas
- Este proyecto **no** usa endpoints privados ni scraping pesado. Solo `GET` de endpoints públicos de mapa.
- Si un día el feed cambia de forma drástica, el workflow no sobrescribe el último `charter.geojson` válido y escribe un log de alerta.