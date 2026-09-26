#!/usr/bin/env node
// Historial semanal de precios de las cartas Pokémon que sigue Holo.
//
// Sin dependencias y sin IA: cada punto guardado es un valor tal cual lo
// devolvió una fuente pública. Si una fuente no responde, se repite el último
// valor conocido marcado con `carried: true` (línea plana en la gráfica).
//
// Fuentes (ver `FUENTES` más abajo):
//   TCGplayer  · tcgcsv.com (copia diaria de la API oficial de TCGplayer)
//                histórico: archivo diario de tcgcsv guardado sin modificar en
//                github.com/landonrroy/pokefolio-data (desde 2024-02-08)
//                respaldo: TCGdex y pokemontcg.io
//   Cardmarket · guía de precios oficial descargable de Cardmarket
//                histórico: github.com/ZyzyThePizi/pokemon-price-data (copia
//                diaria de esa misma guía, desde 2026-09-16)
//                respaldo: TCGdex y pokemontcg.io
//   EUR→USD    · api.frankfurter.dev (tasa de referencia del Banco Central Europeo)
//
// Uso:
//   node scripts/actualizar-precios.mjs                 # ejecución semanal normal
//   node scripts/actualizar-precios.mjs --max-semanas 6 # histórico corto (pruebas)
//   node scripts/actualizar-precios.mjs --solo sv3pt5-199,sv2-254
//   node scripts/actualizar-precios.mjs --raiz /otra/carpeta

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ------------------------------------------------------------------ configuración
const args = process.argv.slice(2);
const arg = (nombre) => { const i = args.indexOf(nombre); return i >= 0 ? args[i + 1] : undefined; };
const RAIZ = path.resolve(arg("--raiz") ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const MAX_SEMANAS = arg("--max-semanas") ? Number(arg("--max-semanas")) : Infinity;
const SOLO = arg("--solo")?.split(",").filter(Boolean);
const ARCHIVO_JSON = path.join(RAIZ, "data", "precios.json");
// holo.html (raíz, la publica GitHub Pages) y export/holo.html (copia para compartir) llevan los mismos datos.
const ARCHIVOS_HTML = [path.join(RAIZ, "holo.html"), path.join(RAIZ, "export", "holo.html")];

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
// Clave "publishable" de Supabase: pública por diseño (la seguridad la pone RLS).
const SUPABASE_URL = "https://vqcpqoedsyatxswdzqcy.supabase.co";
const SUPABASE_KEY = "sb_publishable_tDP2wsl-yvSv2egMu7QFtw_cTQ12NZg";
// Cartas de los anuncios de ejemplo (DEMO en holo.html).
const IDS_EJEMPLO = ["sv3pt5-199", "sv8-238", "swsh7-215", "sv3pt5-151", "sv2-254"];

const TCGDEX = "https://api.tcgdex.net/v2/en";
const POKEMONTCG = "https://api.pokemontcg.io/v2";
const TCGCSV = "https://tcgcsv.com";
const POKEFOLIO = "landonrroy/pokefolio-data";
const ESPEJO_CM = "ZyzyThePizi/pokemon-price-data";
const GUIA_CM = "https://downloads.s3.cardmarket.com/productCatalog/priceGuide/price_guide_6.json";
const INICIO_HISTORICO = "2024-02-08";

const FUENTES = {
  "tcgcsv": { nombre: "tcgcsv.com (TCGplayer)", url: "https://tcgcsv.com" },
  "tcgcsv-archivo": { nombre: "Archivo diario de tcgcsv.com (TCGplayer), copia sin modificar en pokefolio-data", url: `https://github.com/${POKEFOLIO}` },
  "cardmarket": { nombre: "Guía de precios oficial de Cardmarket", url: "https://www.cardmarket.com" },
  "cardmarket-espejo": { nombre: "Copia diaria de la guía de precios de Cardmarket (pokemon-price-data)", url: `https://github.com/${ESPEJO_CM}` },
  "tcgdex": { nombre: "TCGdex", url: "https://tcgdex.dev" },
  "pokemontcg": { nombre: "pokemontcg.io", url: "https://pokemontcg.io" },
  "frankfurter": { nombre: "Frankfurter (tasa de referencia del BCE)", url: "https://frankfurter.dev" },
};

// ------------------------------------------------------------------ utilidades
const log = (...m) => console.log(...m);
const aviso = (...m) => console.warn("AVISO:", ...m);
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
// Acepta también "2026-09-25T20:05:42+0000" (formato de tcgcsv/Cardmarket, sin ":" en la zona).
const aFecha = (f) => new Date(typeof f === "string" ? f.replace(/([+-]\d{2})(\d{2})$/, "$1:$2") : f);
const dia = (fecha) => aFecha(fecha).toISOString().slice(0, 10);
const sumarDias = (d, n) => dia(Date.parse(`${d}T00:00:00Z`) + n * 86400000);
/** Lunes (UTC) de la semana ISO de una fecha YYYY-MM-DD: la clave semanal. */
const lunes = (d) => { const t = new Date(`${d}T00:00:00Z`); return sumarDias(d, -((t.getUTCDay() + 6) % 7)); };
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
/** "Reverse Holofoil" → "reverseHolofoil" (mismas claves que pokemontcg.io y TCGdex). */
const claveVariante = (s) => s.trim().split(/\s+/).map((w, i) => (i ? w[0].toUpperCase() + w.slice(1) : w[0].toLowerCase() + w.slice(1))).join("");

/**
 * GET con reintentos. Devuelve null en 404 o si la fuente falla del todo
 * (nunca inventa datos: quien llama decide qué hacer sin respuesta).
 */
async function pedir(url, { tipo = "json", headers = {}, intentos = 3, timeout = 60000 } = {}) {
  for (let i = 1; i <= intentos; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA, ...headers }, signal: AbortSignal.timeout(timeout) });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      if (tipo === "buffer") return Buffer.from(await r.arrayBuffer());
      if (tipo === "text") return await r.text();
      return await r.json();
    } catch (e) {
      if (i === intentos) { aviso(`${url} → ${e.message}`); return null; }
      await dormir(1500 * i);
    }
  }
}

/** Ejecuta `fn` sobre `items` con `n` tareas a la vez. */
async function enParalelo(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}

/** Lector mínimo de .tar (ustar/GNU/pax), suficiente para los archivos de pokefolio-data. */
function* entradasTar(buf) {
  let o = 0, nombreLargo = null;
  const texto = (a, b) => buf.toString("utf8", a, b).replace(/\0[\s\S]*$/, "");
  while (o + 512 <= buf.length && buf[o] !== 0) {
    const tam = parseInt(texto(o + 124, o + 136).trim() || "0", 8), tipo = String.fromCharCode(buf[o + 156]);
    const prefijo = buf.toString("utf8", o + 257, o + 263).startsWith("ustar") ? texto(o + 345, o + 500) : "";
    let nombre = nombreLargo ?? (prefijo ? `${prefijo}/${texto(o, o + 100)}` : texto(o, o + 100));
    nombreLargo = null;
    const datos = buf.subarray(o + 512, o + 512 + tam);
    o += 512 + Math.ceil(tam / 512) * 512;
    if (tipo === "L") { nombreLargo = datos.toString("utf8").replace(/\0[\s\S]*$/, ""); continue; }
    if (tipo === "x") { const m = datos.toString("utf8").match(/\d+ path=([^\n]*)\n/); if (m) nombreLargo = m[1]; continue; }
    if (tipo === "0" || tipo === "\0") yield { nombre: nombre.replace(/^\.\//, ""), datos };
  }
}

/** Agrega un punto a una serie semanal: uno por semana ISO, el más reciente gana; lo repetido nunca pisa un dato real. */
function agregar(serie, punto) {
  const semana = lunes(punto.d), i = serie.findIndex((p) => lunes(p.d) === semana);
  if (i < 0) serie.push(punto);
  else if (punto.carried) return false;
  else if (serie[i].carried || punto.d >= serie[i].d) serie[i] = punto;
  else return false;
  serie.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  return true;
}
/** Si esta semana no hubo dato, repite el último conocido (marcado `carried`). */
function arrastrar(serie, hoy) {
  const ultimo = serie.at(-1);
  if (!ultimo || lunes(ultimo.d) === lunes(hoy)) return false;
  serie.push({ ...ultimo, d: hoy, carried: true, desde: ultimo.carried ? ultimo.desde : ultimo.d });
  return true;
}

// ------------------------------------------------------------------ identificación de cartas
/** Ids de pokemontcg.io (sv3pt5-199, swsh12pt5-160) → ids de TCGdex (sv03.5-199, swsh12.5-160). */
function tcgdexId(id) {
  const i = id.lastIndexOf("-"), set = id.slice(0, i);
  const m = set.match(/^([a-z]+)(\d+)(pt5)?$/);
  if (!m) return id;
  return `${m[1]}${m[1] === "sv" ? m[2].padStart(2, "0") : m[2]}${m[3] ? ".5" : ""}-${id.slice(i + 1)}`;
}

async function cartasSeguidas(datos) {
  const ids = new Set(IDS_EJEMPLO);
  const filas = await pedir(`${SUPABASE_URL}/rest/v1/listings?select=catalog_id&status=eq.active&catalog_id=not.is.null`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (filas) log(`Supabase: ${filas.length} anuncios activos con carta del catálogo.`);
  else aviso("Supabase no respondió; se siguen las cartas de ejemplo y las ya registradas.");
  for (const f of filas ?? []) if (/^[a-z0-9.]+-[a-z0-9]+$/i.test(f.catalog_id ?? "")) ids.add(f.catalog_id);
  // Las cartas que ya tienen historial se siguen actualizando aunque el anuncio se haya cerrado.
  for (const id of Object.keys(datos.cartas)) ids.add(id);
  return [...ids].filter((id) => !SOLO || SOLO.includes(id)).sort();
}

const setsTcgdex = new Map();
const setTcgdex = (id) => { if (!setsTcgdex.has(id)) setsTcgdex.set(id, pedir(`${TCGDEX}/sets/${encodeURIComponent(id)}`)); return setsTcgdex.get(id); };

/** Lee TCGdex (y pokemontcg.io si hace falta) para saber nombre, set y productIds. */
async function identificar(id, carta) {
  const dex = await pedir(`${TCGDEX}/cards/${encodeURIComponent(tcgdexId(id))}`);
  let ptcg = null;
  if (dex) {
    carta.nombre = dex.name;
    carta.set = dex.set?.name ?? carta.set;
    const tp = dex.pricing?.tcgplayer ?? {};
    const pid = Object.values(tp).find((v) => v && typeof v === "object" && v.productId)?.productId
      ?? dex.variants_detailed?.find((v) => v.thirdParty?.tcgplayer)?.thirdParty.tcgplayer;
    if (pid) carta.tcgplayer = { ...carta.tcgplayer, productId: pid };
    const cm = dex.pricing?.cardmarket?.idProduct ?? dex.variants_detailed?.find((v) => v.thirdParty?.cardmarket)?.thirdParty.cardmarket;
    if (cm) carta.cardmarket = { ...carta.cardmarket, idProduct: cm };
  }
  if (!carta.tcgplayer?.productId || !carta.nombre) {
    ptcg = (await pedir(`${POKEMONTCG}/cards/${encodeURIComponent(id)}`, { intentos: 4 }))?.data ?? null;
    if (ptcg) { carta.nombre ??= ptcg.name; carta.set ??= ptcg.set?.name; }
    if (!carta.tcgplayer?.productId) {
      // prices.pokemontcg.io redirige a la página del producto: el productId va en la URL.
      const r = await fetch(`https://prices.pokemontcg.io/tcgplayer/${encodeURIComponent(id)}`, { redirect: "manual", headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) }).catch(() => null);
      const m = decodeURIComponent(r?.headers.get("location") ?? "").match(/product\/(\d+)/);
      if (m) carta.tcgplayer = { ...carta.tcgplayer, productId: Number(m[1]) };
    }
  }
  return { dex, ptcg };
}

let gruposTcgcsv = null;
const productosGrupo = new Map();
/** Busca el grupo (set) de tcgcsv que contiene el productId, verificándolo contra su lista de productos. */
async function resolverGrupo(carta, dex) {
  if (!carta.tcgplayer?.productId || carta.tcgplayer.groupId) return;
  gruposTcgcsv ??= (await pedir(`${TCGCSV}/tcgplayer/3/groups`))?.results ?? [];
  const set = dex?.set?.id ? await setTcgdex(dex.set.id) : null;
  const abrev = set?.abbreviation?.official?.toUpperCase(), fecha = set?.releaseDate, nombre = (set?.name ?? carta.set ?? "").toLowerCase();
  const puntaje = (g) => (abrev && g.abbreviation?.toUpperCase() === abrev ? 4 : 0) + (fecha && g.publishedOn?.startsWith(fecha) ? 2 : 0) + (nombre && g.name.toLowerCase().endsWith(nombre) ? 1 : 0);
  const candidatos = gruposTcgcsv.map((g) => [puntaje(g), g]).filter(([p]) => p > 0).sort((a, b) => b[0] - a[0]).slice(0, 8).map(([, g]) => g);
  for (const g of candidatos) {
    if (!productosGrupo.has(g.groupId)) productosGrupo.set(g.groupId, pedir(`${TCGCSV}/tcgplayer/3/${g.groupId}/products`));
    const prods = (await productosGrupo.get(g.groupId))?.results ?? [];
    if (prods.some((p) => p.productId === carta.tcgplayer.productId)) { carta.tcgplayer.groupId = g.groupId; carta.tcgplayer.grupo = g.name; return; }
  }
  aviso(`No encontré el grupo de tcgcsv para el producto ${carta.tcgplayer.productId} (${carta.nombre}).`);
}

// ------------------------------------------------------------------ TCGplayer
const puntoTcgplayer = (d, fila, fuente) => {
  const p = { d, market: num(fila.marketPrice), low: num(fila.lowPrice), mid: num(fila.midPrice), high: num(fila.highPrice), fuente };
  return p.market ?? p.low ?? p.mid ? p : null;
};

/** Días disponibles en el archivo de pokefolio-data (lista de carpetas vía API de GitHub). */
async function diasArchivo() {
  const headers = process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {};
  const dias = [];
  const hoy = new Date().getUTCFullYear();
  for (let anio = 2024; anio <= hoy; anio++) {
    const lista = await pedir(`https://api.github.com/repos/${POKEFOLIO}/contents/data/${anio}`, { headers });
    for (const f of lista ?? []) { const m = f.name.match(/^prices-(\d{4}-\d{2}-\d{2})\.tar\.gz$/); if (m) dias.push(m[1]); }
  }
  return dias.sort();
}

/** Histórico semanal de TCGplayer desde el archivo diario de tcgcsv (un día por semana, el primero disponible). */
async function historicoTcgplayer(cartas) {
  const pendientes = cartas.filter(([, c]) => c.tcgplayer?.groupId && !c.tcgplayer.historico);
  if (!pendientes.length) return;
  const dias = await diasArchivo();
  if (!dias.length) { aviso("No pude listar el archivo histórico de TCGplayer; se reintenta la próxima semana."); return; }
  const porSemana = new Map();
  for (const d of dias) if (d >= INICIO_HISTORICO && !porSemana.has(lunes(d))) porSemana.set(lunes(d), d);
  const elegidos = [...porSemana.values()].slice(-MAX_SEMANAS);
  log(`TCGplayer histórico: ${pendientes.length} cartas, ${elegidos.length} semanas (${elegidos[0]} → ${elegidos.at(-1)}).`);
  const grupos = new Set(pendientes.map(([, c]) => c.tcgplayer.groupId));
  let ok = 0;
  await enParalelo(elegidos, 4, async (d) => {
    const tgz = await pedir(`https://raw.githubusercontent.com/${POKEFOLIO}/main/data/${d.slice(0, 4)}/prices-${d}.tar.gz`, { tipo: "buffer" });
    if (!tgz) return;
    const filasPorGrupo = new Map();
    for (const { nombre, datos } of entradasTar(gunzipSync(tgz))) {
      const m = nombre.match(/^[\d-]+\/3\/(\d+)\/prices$/);
      if (m && grupos.has(Number(m[1]))) filasPorGrupo.set(Number(m[1]), JSON.parse(datos.toString("utf8")).results ?? []);
    }
    for (const [, c] of pendientes) {
      for (const fila of filasPorGrupo.get(c.tcgplayer.groupId) ?? []) {
        if (fila.productId !== c.tcgplayer.productId || !fila.subTypeName) continue;
        const p = puntoTcgplayer(d, fila, "tcgcsv-archivo");
        if (p) agregar((c.series.tcgplayer[claveVariante(fila.subTypeName)] ??= []), p);
      }
    }
    ok++;
  });
  log(`TCGplayer histórico: ${ok}/${elegidos.length} días leídos.`);
  // Sólo se marca como hecho con el histórico completo (no en pruebas con --max-semanas).
  if (MAX_SEMANAS === Infinity && ok >= elegidos.length * 0.9) for (const [, c] of pendientes) c.tcgplayer.historico = dia(Date.now());
}

/** Precio de esta semana: tcgcsv → TCGdex → pokemontcg.io → repetir el último. */
async function semanaTcgplayer(cartas, contexto, hoy) {
  const actualizado = (await pedir(`${TCGCSV}/last-updated.txt`, { tipo: "text" }))?.trim();
  const dTcgcsv = actualizado && !Number.isNaN(aFecha(actualizado).getTime()) ? dia(actualizado) : hoy;
  const precios = new Map();
  for (const g of new Set(cartas.map(([, c]) => c.tcgplayer?.groupId).filter(Boolean))) {
    // tcgcsv pide no bajar el mismo archivo de precios más de una vez al día: una vez por semana está bien.
    precios.set(g, (await pedir(`${TCGCSV}/tcgplayer/3/${g}/prices`))?.results ?? null);
  }
  const resumen = { tcgcsv: 0, tcgdex: 0, pokemontcg: 0, repetido: 0 };
  for (const [id, c] of cartas) {
    const s = c.series.tcgplayer;
    const filas = (precios.get(c.tcgplayer?.groupId) ?? []).filter((f) => f.productId === c.tcgplayer?.productId && f.subTypeName);
    let puntos = filas.map((f) => [claveVariante(f.subTypeName), puntoTcgplayer(dTcgcsv, f, "tcgcsv")]).filter(([, p]) => p);
    let fuente = "tcgcsv";
    if (!puntos.length) {
      const tp = contexto.get(id)?.dex?.pricing?.tcgplayer;
      if (tp) {
        const d = tp.updated ? dia(tp.updated) : hoy;
        puntos = Object.entries(tp).filter(([, v]) => v && typeof v === "object").map(([k, v]) => [k, puntoTcgplayer(d, v, "tcgdex")]).filter(([, p]) => p);
        fuente = "tcgdex";
      }
    }
    if (!puntos.length) {
      const ptcg = contexto.get(id)?.ptcg ?? (await pedir(`${POKEMONTCG}/cards/${encodeURIComponent(id)}`, { intentos: 4 }))?.data;
      const tp = ptcg?.tcgplayer;
      if (tp?.prices) {
        const d = tp.updatedAt ? tp.updatedAt.replaceAll("/", "-") : hoy;
        puntos = Object.entries(tp.prices).map(([k, v]) => [k, { d, market: num(v.market), low: num(v.low), mid: num(v.mid), high: num(v.high), fuente: "pokemontcg" }]).filter(([, p]) => p.market ?? p.low ?? p.mid);
        fuente = "pokemontcg";
      }
    }
    if (puntos.length) { for (const [k, p] of puntos) agregar((s[k] ??= []), p); resumen[fuente]++; }
    let repetidos = 0;
    for (const k of Object.keys(s)) if (!puntos.some(([kk]) => kk === k) && arrastrar(s[k], hoy)) repetidos++;
    if (repetidos) resumen.repetido++;
  }
  log(`TCGplayer esta semana (cartas por fuente):`, resumen);
  return resumen;
}

// ------------------------------------------------------------------ Cardmarket
const CAMPOS_CM = ["avg", "low", "trend", "avg1", "avg7", "avg30"];
const puntoCardmarket = (d, o, fuente) => {
  const p = { d };
  for (const k of CAMPOS_CM) p[k] = num(o[k]);
  p.fuente = fuente;
  return CAMPOS_CM.some((k) => p[k] != null && p[k] > 0) ? p : null;
};

/** Histórico semanal desde la copia diaria de la guía de Cardmarket (existe desde 2026-09-16). */
async function historicoCardmarket(cartas) {
  const pendientes = cartas.filter(([, c]) => c.cardmarket?.idProduct && !c.cardmarket.historico);
  if (!pendientes.length) return;
  const manifiesto = await pedir(`https://raw.githubusercontent.com/${ESPEJO_CM}/main/prices/manifest.json`);
  const campos = manifiesto?.historyFields;
  if (!campos) { aviso("La copia de Cardmarket no respondió; se reintenta la próxima semana."); return; }
  const fragmentos = new Map();
  for (const [, c] of pendientes) {
    const f = c.cardmarket.idProduct % 1000;
    if (!fragmentos.has(f)) fragmentos.set(f, await pedir(`https://raw.githubusercontent.com/${ESPEJO_CM}/main/history/${f}.json`));
    const filas = fragmentos.get(f)?.[String(c.cardmarket.idProduct)] ?? [];
    const porSemana = new Map();
    for (const fila of filas) {
      const o = Object.fromEntries(campos.map((k, i) => [k, fila[i]]));
      if (!porSemana.has(lunes(o.date))) porSemana.set(lunes(o.date), o);
    }
    for (const o of porSemana.values()) { const p = puntoCardmarket(o.date, o, "cardmarket-espejo"); if (p) agregar(c.series.cardmarket, p); }
    if (fragmentos.get(f)) c.cardmarket.historico = dia(Date.now());
  }
  log(`Cardmarket histórico: ${pendientes.length} cartas revisadas en la copia diaria.`);
}

/** Precio de esta semana: guía oficial → TCGdex → pokemontcg.io → repetir el último. */
async function semanaCardmarket(cartas, contexto, hoy) {
  const guia = await pedir(GUIA_CM, { timeout: 120000 });
  const dGuia = guia?.createdAt ? dia(guia.createdAt) : hoy;
  const porProducto = new Map((guia?.priceGuides ?? []).map((g) => [g.idProduct, g]));
  const resumen = { cardmarket: 0, tcgdex: 0, pokemontcg: 0, repetido: 0 };
  for (const [id, c] of cartas) {
    let p = null, fuente = "cardmarket";
    const g = porProducto.get(c.cardmarket?.idProduct);
    if (g) p = puntoCardmarket(dGuia, g, "cardmarket");
    if (!p) {
      const cm = contexto.get(id)?.dex?.pricing?.cardmarket;
      if (cm) { p = puntoCardmarket(cm.updated ? dia(cm.updated) : hoy, cm, "tcgdex"); fuente = "tcgdex"; }
    }
    if (!p) {
      const ptcg = contexto.get(id)?.ptcg;
      const pr = ptcg?.cardmarket?.prices;
      if (pr) {
        p = puntoCardmarket(ptcg.cardmarket.updatedAt?.replaceAll("/", "-") ?? hoy,
          { avg: pr.averageSellPrice, low: pr.lowPrice, trend: pr.trendPrice, avg1: pr.avg1, avg7: pr.avg7, avg30: pr.avg30 }, "pokemontcg");
        fuente = "pokemontcg";
      }
    }
    if (p) { agregar(c.series.cardmarket, p); resumen[fuente]++; }
    else if (arrastrar(c.series.cardmarket, hoy)) resumen.repetido++;
  }
  log(`Cardmarket esta semana (cartas por fuente):`, resumen);
  return resumen;
}

/** Pone a cada punto de Cardmarket la tasa EUR→USD del BCE de su fecha (o del último día hábil anterior). */
async function tasasCambio(cartas) {
  const faltan = cartas.flatMap(([, c]) => c.series.cardmarket).filter((p) => p.eurUsd == null);
  if (!faltan.length) return;
  const desde = sumarDias(faltan.map((p) => p.d).sort()[0], -7), hasta = faltan.map((p) => p.d).sort().at(-1);
  const r = await pedir(`https://api.frankfurter.dev/v1/${desde}..${hasta}?base=EUR&symbols=USD`);
  const fechas = Object.keys(r?.rates ?? {}).sort();
  if (!fechas.length) { aviso("Frankfurter no respondió; la conversión a USD se completa la próxima semana."); return; }
  for (const p of faltan) {
    const f = fechas.filter((x) => x <= p.d).at(-1) ?? fechas[0];
    p.eurUsd = r.rates[f].USD;
    p.fechaTasa = f;
  }
}

// ------------------------------------------------------------------ guardar
/** JSON legible para git: un punto por línea. */
function formatear(datos) {
  return JSON.stringify(datos, null, 2).replace(/\{\n\s+"d": [^{}]*?\}/g, (m) => m.replace(/\n\s*/g, " ").replace(/\{ /, "{").replace(/ \}$/, "}")) + "\n";
}

async function incrustarEnHtml(datos, archivo) {
  const html = await readFile(archivo, "utf8");
  const inicio = "<!-- PRECIOS:INICIO -->", fin = "<!-- PRECIOS:FIN -->";
  const a = html.indexOf(inicio), b = html.indexOf(fin);
  if (a < 0 || b < a) throw new Error(`${path.relative(RAIZ, archivo)} no tiene los marcadores ${inicio} … ${fin}`);
  // "<" escapado para que ningún texto pueda cerrar la etiqueta <script>.
  const json = JSON.stringify(datos).replace(/</g, "\\u003c");
  const bloque = `${inicio}\n<script id="precios-data" type="application/json">${json}</script>\n`;
  await writeFile(archivo, html.slice(0, a) + bloque + html.slice(b));
}

// ------------------------------------------------------------------ principal
async function main() {
  const hoy = dia(Date.now());
  const datos = await readFile(ARCHIVO_JSON, "utf8").then(JSON.parse).catch(() => ({ version: 1, cartas: {} }));
  datos.fuentes = FUENTES;
  const ids = await cartasSeguidas(datos);
  log(`Cartas a seguir (${ids.length}): ${ids.join(", ")}`);

  const contexto = new Map(), cartas = [];
  await enParalelo(ids, 4, async (id) => {
    const c = datos.cartas[id] ?? { series: {} };
    c.series.tcgplayer ??= {};
    c.series.cardmarket ??= [];
    contexto.set(id, await identificar(id, c));
    await resolverGrupo(c, contexto.get(id).dex);
    if (!c.tcgplayer?.productId && !c.cardmarket?.idProduct && !datos.cartas[id]) { aviso(`${id}: no la encontré en TCGdex ni en pokemontcg.io; se omite.`); return; }
    datos.cartas[id] = c;
    cartas.push([id, c]);
  });
  cartas.sort((a, b) => (a[0] < b[0] ? -1 : 1));

  await historicoTcgplayer(cartas);
  await historicoCardmarket(cartas);
  const estado = { tcgplayer: await semanaTcgplayer(cartas, contexto, hoy), cardmarket: await semanaCardmarket(cartas, contexto, hoy) };
  await tasasCambio(cartas);

  datos.actualizado = new Date().toISOString();
  datos.estado = estado;
  datos.cartas = Object.fromEntries(Object.entries(datos.cartas).sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([id, { nombre, set, tcgplayer, cardmarket, series, ...resto }]) => [id, { nombre, set, tcgplayer, cardmarket, ...resto, series }]));
  await mkdir(path.dirname(ARCHIVO_JSON), { recursive: true });
  await writeFile(ARCHIVO_JSON, formatear(datos));
  const htmls = [];
  for (const f of ARCHIVOS_HTML) if (await readFile(f).then(() => true, () => false)) { await incrustarEnHtml(datos, f); htmls.push(path.relative(RAIZ, f)); }
  if (!htmls.length) throw new Error("No encontré holo.html");

  for (const [id, c] of cartas) {
    const tp = Object.entries(c.series.tcgplayer).map(([k, s]) => `${k} ${s.length}`).join(", ") || "—";
    log(`  ${id} ${c.nombre ?? ""}: TCGplayer [${tp}] · Cardmarket ${c.series.cardmarket.length}`);
  }
  log(`Listo: ${path.relative(RAIZ, ARCHIVO_JSON)} y ${htmls.join(", ")} actualizados.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
