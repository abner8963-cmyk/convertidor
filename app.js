const $ = (id) => document.getElementById(id);
const CACHE_LO = "convertidor-lo-2.7.2";       // igual que en sw.js
const base = new URL("./", document.baseURI);   // la raíz de la app (cada página trae su <base>)
const MB = (b) => (b / 1e6).toFixed(0);

function estado(titulo, texto = "", avance = null) {
  $("estadoTitulo").textContent = titulo;
  $("estadoTexto").textContent = texto;
  const barra = $("barra");
  barra.hidden = avance === null;
  barra.classList.toggle("indef", avance === "indef");
  if (typeof avance === "number") barra.firstElementChild.style.width = Math.round(avance * 100) + "%";
}

// ---------------------------------------------------------------- 1. service worker y aislamiento
async function asegurarAislamiento() {
  if (!("serviceWorker" in navigator) || !("DecompressionStream" in window)) {
    estado("Este navegador no sirve", "Ábrelo en Chrome, Edge, Brave, Firefox o Safari actualizados.");
    return false;
  }
  const reg = await navigator.serviceWorker.register("sw.js");
  await navigator.serviceWorker.ready;
  if (crossOriginIsolated) { sessionStorage.removeItem("recargado"); return true; }
  // La primera visita todavía no la controla el service worker: recargar una vez.
  if (!sessionStorage.getItem("recargado")) {
    sessionStorage.setItem("recargado", "1");
    if (!navigator.serviceWorker.controller) {
      await new Promise((ok) => {
        navigator.serviceWorker.addEventListener("controllerchange", ok, { once: true });
        setTimeout(ok, 3000);
      });
    }
    location.reload();
    return false;
  }
  estado("No se pudo activar el modo aislado",
         "El navegador no dejó usar la memoria compartida que necesita LibreOffice. Prueba recargar o usar otro navegador.");
  return false;
}

// ---------------------------------------------------------------- 2. bajar LibreOffice una vez
async function faltantes() {
  const cache = await caches.open(CACHE_LO);
  const partes = await (await fetch("partes.json")).json();
  const faltan = [];
  for (const [nombre, info] of Object.entries(partes)) {
    const r = await cache.match(new URL("lo/" + nombre, base).href);
    if (!r || Number(r.headers.get("Content-Length")) !== info.tam) faltan.push([nombre, info]);
  }
  return faltan;
}

async function bajar(faltan) {
  const cache = await caches.open(CACHE_LO);
  const total = faltan.reduce((s, [, i]) => s + i.gz, 0);
  let llevo = 0;
  for (const [nombre, info] of faltan) {
    let i = 0, lector = null;
    const comprimido = new ReadableStream({
      async pull(ctrl) {
        for (;;) {
          if (!lector) {
            if (i >= info.partes.length) return ctrl.close();
            const r = await fetch("lo/partes/" + info.partes[i++], { cache: "no-cache" });
            if (!r.ok) throw new Error("no se pudo bajar " + info.partes[i - 1] + " (" + r.status + ")");
            lector = r.body.getReader();
          }
          const { done, value } = await lector.read();
          if (done) { lector = null; continue; }
          llevo += value.byteLength;
          estado("Bajando LibreOffice…", `${MB(llevo)} de ${MB(total)} MB. Solo la primera vez; después queda guardado.`, llevo / total);
          return ctrl.enqueue(value);
        }
      },
    });
    const cuerpo = comprimido.pipeThrough(new DecompressionStream("gzip"));
    await cache.put(new URL("lo/" + nombre, base).href, new Response(cuerpo, {
      headers: { "Content-Type": info.tipo, "Content-Length": String(info.tam) },
    }));
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
}

// ---------------------------------------------------------------- 3. arrancar LibreOffice
let conversor = null, listo = null, preparado = false;
let notaActual = null;          // el renglón del archivo que se está convirtiendo
const fuentes = [];             // fuentes sacadas de los archivos (se le pasan a LibreOffice al arrancar)
const fuentesVistas = new Set();

function arrancar(aviso = "La primera vez en esta visita tarda entre uno y dos minutos (en celular, algo más).") {
  if (listo) return listo;
  listo = (async () => {
    const t0 = performance.now();
    estado("Arrancando LibreOffice…", aviso, "indef");
    const { WorkerBrowserConverter, createWasmPaths } = await import("./lo/browser.js");
    conversor = new WorkerBrowserConverter({
      ...createWasmPaths(new URL("lo/", base).href),
      browserWorkerJs: new URL("lo/browser.worker.global.js", base).href,
      fonts: fuentes.map((f) => ({ filename: f.nombre, data: f.datos.slice() })),
      onProgress: (p) => {
        if (!p || typeof p.percent !== "number" || p.percent <= 0 || p.percent >= 100) return;
        // Ya arrancado, el avance es de una conversión: va en el renglón de su archivo.
        if (preparado) { if (notaActual) notaActual.textContent = `Convirtiendo… ${Math.round(p.percent)} %`; }
        else estado("Arrancando LibreOffice…", p.message || "", p.percent / 100);
      },
    });
    await conversor.initialize();
    // Una conversión mínima carga de verdad LibreOffice; así el primer archivo del usuario ya no espera.
    await conversor.convert(new TextEncoder().encode("ok"), { outputFormat: "pdf" }, "calentar.txt");
    preparado = true;
    const s = ((performance.now() - t0) / 1000).toFixed(0);
    estado("Listo", `LibreOffice arrancó en ${s} s. Elige tus archivos.`);
  })();
  listo.catch((e) => {
    estado("No arrancó LibreOffice", String(e && e.message || e) + ". Recarga la página para intentar otra vez.");
    listo = null;
  });
  return listo;
}

// LibreOffice solo conoce las fuentes que tiene al arrancar: para usar las de un archivo hay que
// apagarlo y volverlo a arrancar con ellas (ya bajado, tarda unos segundos).
async function reiniciar() {
  try { await listo; } catch {}
  preparado = false;
  // destroy() espera respuesta del worker y a veces nunca llega: máximo 3 s y luego se mata el worker.
  const viejo = conversor;
  try { await Promise.race([viejo?.destroy(), new Promise((ok) => setTimeout(ok, 3000))]); } catch {}
  try { viejo?.worker?.terminate(); } catch {}
  conversor = null; listo = null;
  return arrancar("Cargando las fuentes que trae el archivo…");
}

// ---------------------------------------------------------------- 3b. fuentes incrustadas
// PowerPoint (y Canva al exportar) guarda las fuentes dentro del .pptx en ppt/fonts/*.fntdata,
// en formato EOT. El LibreOffice de escritorio las lee; el del navegador no, y cambia la letra
// por otra más ancha (los textos se salen de sus cuadros). Aquí se sacan como .ttf normales.
async function archivosDelZip(bytes, quiero) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let fin = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65558); i--) {
    if (v.getUint32(i, true) === 0x06054b50) { fin = i; break; }
  }
  if (fin < 0) return [];
  const total = v.getUint16(fin + 10, true);
  let p = v.getUint32(fin + 16, true);
  const salida = [];
  for (let k = 0; k < total && v.getUint32(p, true) === 0x02014b50; k++) {
    const metodo = v.getUint16(p + 10, true), tam = v.getUint32(p + 20, true);
    const largoNombre = v.getUint16(p + 28, true), extra = v.getUint16(p + 30, true), coment = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const nombre = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + largoNombre));
    p += 46 + largoNombre + extra + coment;
    if (!quiero(nombre) || (metodo !== 0 && metodo !== 8)) continue;
    const ini = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const crudo = bytes.subarray(ini, ini + tam);
    const datos = metodo === 0 ? crudo.slice() : new Uint8Array(await new Response(
      new Blob([crudo]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
    salida.push({ nombre, datos });
  }
  return salida;
}

function eotATtf(b) {
  if (b.length < 16) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tamEot = v.getUint32(0, true), tamFuente = v.getUint32(4, true), banderas = v.getUint32(12, true);
  if (banderas & 0x4 || tamEot > b.length || tamFuente > tamEot) return null;   // comprimida (MTX): no se puede
  const ttf = b.slice(tamEot - tamFuente, tamEot);
  if (banderas & 0x10000000) for (let i = 0; i < ttf.length; i++) ttf[i] ^= 0x50;
  const firma = new DataView(ttf.buffer).getUint32(0);
  return firma === 0x00010000 || firma === 0x4f54544f || firma === 0x74727565 ? ttf : null;   // TrueType / OTTO / true
}

async function fuentesNuevas(bytes, nombreArchivo) {
  if (!/\.(pptx|ppsx|potx|pptm)$/i.test(nombreArchivo)) return 0;
  let n = 0;
  try {
    for (const { datos } of await archivosDelZip(bytes, (x) => /^ppt\/fonts\/.+\.fntdata$/i.test(x))) {
      const ttf = eotATtf(datos);
      if (!ttf) continue;
      const huella = [...new Uint8Array(await crypto.subtle.digest("SHA-256", ttf))]
        .slice(0, 8).map((x) => x.toString(16).padStart(2, "0")).join("");
      if (fuentesVistas.has(huella)) continue;
      fuentesVistas.add(huella);
      fuentes.push({ nombre: `incrustada-${huella}.ttf`, datos: ttf });
      n++;
    }
  } catch (e) { console.warn("No se pudieron leer las fuentes del archivo", e); }
  return n;
}

// ---------------------------------------------------------------- 3c. efectos difuminados
// El LibreOffice del navegador se queda trabado para siempre («Convirtiendo… 70 %») al dibujar
// efectos con difuminado: sombras con blurRad (PowerPoint, Canva, PptxGenJS) y resplandor (glow).
// El de escritorio no. Las sombras se dejan, pero con borde nítido (blurRad="0"), y el resplandor
// se quita; así convierte en un par de segundos. El borde suave (softEdge) sí funciona: no se toca.
// Probado 2026-11-08 con independencia.pptx (sombras) y «03 renovación y revocación de fiel» (glow).
const OOXML = /\.(pptx|ppsx|potx|pptm|docx|docm|dotx|xlsx|xlsm|xltx)$/i;
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

async function sinDifuminado(bytes, nombreArchivo) {
  if (!OOXML.test(nombreArchivo)) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let fin = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65558); i--) {
    if (v.getUint32(i, true) === 0x06054b50) { fin = i; break; }
  }
  if (fin < 0) return null;
  const total = v.getUint16(fin + 10, true);
  let p = v.getUint32(fin + 16, true);
  const entradas = [];
  let cambios = 0;
  for (let k = 0; k < total; k++) {
    if (v.getUint32(p, true) !== 0x02014b50) return null;
    const e = {
      hecho: v.getUint16(p + 4, true), necesita: v.getUint16(p + 6, true), banderas: v.getUint16(p + 8, true) & ~0x0008,
      metodo: v.getUint16(p + 10, true), hora: v.getUint16(p + 12, true), fecha: v.getUint16(p + 14, true),
      crc: v.getUint32(p + 16, true), comp: v.getUint32(p + 20, true), tam: v.getUint32(p + 24, true),
      interno: v.getUint16(p + 36, true), externo: v.getUint32(p + 38, true),
    };
    const largoNombre = v.getUint16(p + 28, true);
    e.nombreBytes = bytes.subarray(p + 46, p + 46 + largoNombre);
    const nombre = new TextDecoder().decode(e.nombreBytes);
    const local = v.getUint32(p + 42, true);
    const ini = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    e.datos = bytes.subarray(ini, ini + e.comp);
    p += 46 + largoNombre + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
    if (/^(ppt|word|xl)\/.+\.xml$/i.test(nombre) && (e.metodo === 0 || e.metodo === 8)) {
      const crudo = e.metodo === 0 ? e.datos : new Uint8Array(await new Response(
        new Blob([e.datos]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
      const xml = new TextDecoder().decode(crudo);
      if (/blurRad="[1-9]|<a:glow\b/.test(xml)) {
        const nuevo = new TextEncoder().encode(xml.replace(/blurRad="\d+"/g, 'blurRad="0"')
          .replace(/<a:glow\b[^>]*\/>|<a:glow\b[\s\S]*?<\/a:glow>/g, ""));
        Object.assign(e, { metodo: 0, datos: nuevo, crc: crc32(nuevo), comp: nuevo.length, tam: nuevo.length });
        cambios++;
      }
    }
    entradas.push(e);
  }
  if (!cambios) return null;
  // zip nuevo: lo que no cambió se copia tal cual (ya comprimido); lo cambiado va sin comprimir
  const largo = entradas.reduce((n, e) => n + 30 + e.nombreBytes.length + e.comp + 46 + e.nombreBytes.length, 22);
  const out = new Uint8Array(largo), w = new DataView(out.buffer);
  let q = 0;
  const cabecera = (e, central) => {
    w.setUint32(q, central ? 0x02014b50 : 0x04034b50, true); q += 4;
    if (central) { w.setUint16(q, e.hecho, true); q += 2; }
    for (const x of [e.necesita, e.banderas, e.metodo, e.hora, e.fecha]) { w.setUint16(q, x, true); q += 2; }
    for (const x of [e.crc, e.comp, e.tam]) { w.setUint32(q, x, true); q += 4; }
    w.setUint16(q, e.nombreBytes.length, true); w.setUint16(q + 2, 0, true); q += 4;
    if (central) {
      for (const x of [0, 0, e.interno]) { w.setUint16(q, x, true); q += 2; }
      w.setUint32(q, e.externo, true); w.setUint32(q + 4, e.local, true); q += 8;
    }
    out.set(e.nombreBytes, q); q += e.nombreBytes.length;
  };
  for (const e of entradas) { e.local = q; cabecera(e, false); out.set(e.datos, q); q += e.datos.length; }
  const inicioCentral = q;
  for (const e of entradas) cabecera(e, true);
  w.setUint32(q, 0x06054b50, true); w.setUint16(q + 8, entradas.length, true); w.setUint16(q + 10, entradas.length, true);
  w.setUint32(q + 12, q - inicioCentral, true); w.setUint32(q + 16, inicioCentral, true);
  return { bytes: out, cambios };
}

// ---------------------------------------------------------------- 4. convertir
const cola = [];
let trabajando = false;

function agregar(archivos) {
  $("resultados").hidden = false;
  for (const f of archivos) {
    const li = document.createElement("li");
    li.innerHTML = `<div class="nombre"><div></div><small>En espera…</small></div>`;
    li.querySelector(".nombre div").textContent = f.name;
    $("lista").prepend(li);
    cola.push({ f, li });
  }
  procesar();
}

async function procesar() {
  if (trabajando) return;
  trabajando = true;
  try {
    while (cola.length) {
      const { f, li } = cola.shift();
      const nota = li.querySelector("small");
      try {
        if (!listo) {
          nota.textContent = "Preparando LibreOffice…";
          await preparar();
        }
        nota.textContent = "Esperando a que LibreOffice esté listo…";
        await listo;
        const bytes = new Uint8Array(await f.arrayBuffer());
        const t = performance.now();
        if (await fuentesNuevas(bytes, f.name)) {
          nota.textContent = "Cargando las fuentes que trae el archivo…";
          await reiniciar();
        }
        let entrada = bytes, aviso = "";
        try {
          const limpio = await sinDifuminado(bytes, f.name);
          if (limpio) { entrada = limpio.bytes; aviso = " · sombras y brillos simplificados"; }
        } catch (e) { console.warn("No se pudieron revisar los efectos del archivo", e); }
        nota.textContent = "Convirtiendo…";
        notaActual = nota;
        const r = await conversor.convert(entrada, { outputFormat: "pdf" }, f.name);
        const blob = new Blob([r.data], { type: "application/pdf" });
        const nombre = f.name.replace(/\.[^.]+$/, "") + ".pdf";
        nota.textContent = `PDF de ${(blob.size / 1024).toFixed(0)} KB en ${((performance.now() - t) / 1000).toFixed(1)} s${aviso}`;
        const a = document.createElement("a");
        a.className = "bajar"; a.href = URL.createObjectURL(blob); a.download = nombre; a.textContent = "Descargar";
        li.append(a);
        notaActual = null;
      } catch (e) {
        notaActual = null;
        nota.textContent = "No se pudo convertir: " + (e && e.message || e);
        nota.classList.add("error");
      }
    }
  } finally {
    trabajando = false;
  }
}

// ---------------------------------------------------------------- arranque de la página
async function preparar() {
  const faltan = await faltantes();
  if (faltan.length) {
    $("preparar").hidden = true;
    try { await bajar(faltan); }
    catch (e) {
      estado("Se cortó la descarga", String(e.message || e) + ". Revisa tu internet y vuelve a intentar.");
      $("preparar").hidden = false;
      throw e;
    }
  }
  return arrancar();
}

const aislado = asegurarAislamiento();      // registra el service worker (también deja la app sin internet)
let officeIniciado = false;
async function iniciarOffice() {
  if (officeIniciado) return;
  officeIniciado = true;
  if (!(await aislado)) return;
  const faltan = await faltantes();
  if (faltan.length) {
    const mb = MB(faltan.reduce((s, [, i]) => s + i.gz, 0));
    estado("Falta preparar el convertidor", `La primera vez hay que bajar LibreOffice (unos ${mb} MB, conviene con Wi-Fi). Después funciona sin internet.`);
    $("preparar").hidden = false;
  } else {
    arrancar();
  }
}

// ---------------------------------------------------------------- 5. menú de herramientas
const VISTAS = ["inicio", "office", "unir", "dividir", "organizar", "imagenes", "aimagenes", "comprimir", "numeros", "marca", "proteger", "desbloquear", "ocr", "firmar", "editar",
  "comprimir-imagen", "cambiar-tamano", "recortar", "convertir-imagen", "girar-imagen", "escanear",
  "recortarpdf", "reparar", "formulario", "sacarimagenes", "pdfaword"];
// Cada herramienta tiene su propia dirección (…/unir-pdf/); las páginas las genera
// generar.py y todas traen la app completa, así que cambiar de herramienta no recarga.
const RUTAS = JSON.parse($("rutas").textContent);          // { "unir-pdf": { v: "unir", t: "título" }, "": {…} }
const PRINCIPAL = {};                                       // vista → su dirección principal
for (const [ruta, r] of Object.entries(RUTAS)) if (!(r.v in PRINCIPAL)) PRINCIPAL[r.v] = ruta;
function rutaDe(href) {
  const u = href.split(/[?#]/)[0];
  if (!u.startsWith(base.href)) return null;
  return u.slice(base.href.length).replace(/index\.html$/, "").replace(/\/$/, "");
}
const urlDe = (ruta) => new URL(ruta ? ruta + "/" : "./", base).href;
function verVista() {
  // Enlaces viejos (…/#unir) → su dirección nueva
  const viejo = location.hash.slice(1);
  if (viejo in PRINCIPAL) history.replaceState(null, "", urlDe(PRINCIPAL[viejo]));
  const ruta = rutaDe(location.href);
  const r = RUTAS[ruta] || RUTAS[""];
  const nombre = VISTAS.includes(r.v) ? r.v : "inicio";
  for (const v of VISTAS) $("vista-" + v).hidden = v !== nombre;
  const ayuda = $("ayuda");
  if (ayuda) ayuda.hidden = ayuda.dataset.ruta !== (ruta ?? "");
  document.title = r.t;
  if (nombre === "office") iniciarOffice();
  scrollTo(0, 0);
}
addEventListener("popstate", verVista);
document.addEventListener("click", (e) => {
  const a = e.target.closest("a[href]");
  if (!a || e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || a.target || a.hasAttribute("download")) return;
  if (a.href.includes("#")) return;
  const ruta = rutaDe(a.href);
  if (ruta === null || !(ruta in RUTAS)) return;
  e.preventDefault();
  if (a.href !== location.href) history.pushState(null, "", a.href);
  verVista();
});
verVista();

// ---- fotos HEIC (las del iPhone): casi ningún navegador las abre, así que en cuanto entran se
// pasan a JPG con libheif (compilado para el navegador, LGPL-3.0; se baja la primera vez que se usa)
async function esHeif(f) {
  const b = new Uint8Array(await f.slice(0, 12).arrayBuffer());
  return String.fromCharCode(...b.subarray(4, 12)).match(/^ftyp(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/) !== null;
}
let _heif = null;
function libHeif() {
  return _heif ||= (async () => {
    await new Promise((ok, mal) => {
      const s = document.createElement("script");
      s.src = new URL("lib/libheif.js", base).href;
      s.onload = ok; s.onerror = mal;
      document.head.append(s);
    });
    const wasmBinary = new Uint8Array(await (await fetch(new URL("lib/libheif.wasm", base))).arrayBuffer());
    return window.libheif({ wasmBinary });
  })().catch(() => { _heif = null; throw new Error("No se pudo cargar el lector de fotos HEIC. Revisa tu internet."); });
}
async function heicAJpg(f) {
  const m = await libHeif(), dec = new m.HeifDecoder();
  let imgs = [];
  try {
    imgs = dec.decode(new Uint8Array(await f.arrayBuffer())) || [];
    const im = imgs.find((i) => i.is_primary && i.is_primary()) || imgs[0];
    if (!im) throw 0;
    const w = im.get_width(), h = im.get_height(), datos = new ImageData(w, h);
    await new Promise((ok, mal) => im.display(datos, (x) => x ? ok() : mal()));
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    c.getContext("2d").putImageData(datos, 0, 0);
    // Con transparencia, PNG (el JPG la volvería negra); si no, JPG
    let alfa = false;
    for (let i = 3; i < datos.data.length; i += 4) if (datos.data[i] < 255) { alfa = true; break; }
    const tipo = alfa ? "image/png" : "image/jpeg";
    const blob = await new Promise((ok) => c.toBlob(ok, tipo, 0.95));
    c.width = 0;
    return new File([blob], f.name.replace(/\.(heic|heif|hif)$/i, "") + (alfa ? ".png" : ".jpg"), { type: tipo, lastModified: f.lastModified });
  } catch (e) {
    if (e instanceof Error && /HEIC/.test(e.message)) throw e;
    throw new Error(`«${f.name}» parece HEIC pero no se pudo leer.`);
  } finally {
    for (const i of imgs) try { i.free(); } catch { /* ya libre */ }
  }
}
// Devuelve la lista con las HEIC ya en JPG (las que fallen se dejan: la herramienta dirá que no las abre)
async function sinHeic(fs, avance = () => {}) {
  if (!fs.some((f) => /\.(heic|heif|hif)$/i.test(f.name) || /hei[cf]/.test(f.type))) {
    let alguna = false;
    for (const f of fs) if (f.size > 12 && await esHeif(f)) { alguna = true; break; }
    if (!alguna) return fs;
  }
  const out = [];
  for (const [k, f] of fs.entries()) {
    if (f.size > 12 && await esHeif(f)) {
      avance(fs.length > 1 ? `Abriendo fotos HEIC (${k + 1} de ${fs.length})…` : "Abriendo la foto HEIC…");
      try { out.push(await heicAJpg(f)); continue; } catch (e) { console.warn(e); }
    }
    out.push(f);
  }
  return out;
}
function zonaDeArchivos(zona, entrada, alRecibir) {
  const recibir = async (fs) => {
    const titulo = zona.querySelector("b"), antes = titulo && titulo.textContent;
    try { fs = await sinHeic(fs, (t) => { if (titulo) titulo.textContent = t; }); }
    finally { if (titulo) titulo.textContent = antes; }
    alRecibir(fs);
  };
  zona.onclick = () => entrada.click();
  zona.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); entrada.click(); } };
  entrada.onchange = (e) => { recibir([...e.target.files]); e.target.value = ""; };
  for (const ev of ["dragenter", "dragover"]) zona.addEventListener(ev, (e) => { e.preventDefault(); zona.classList.add("encima"); });
  for (const ev of ["dragleave", "drop"]) zona.addEventListener(ev, (e) => { e.preventDefault(); zona.classList.remove("encima"); });
  zona.addEventListener("drop", (e) => recibir([...e.dataTransfer.files]));
}
const esPdf = (f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name);
const sinExt = (n) => n.replace(/\.pdf$/i, "");

// pdf-lib se carga hasta que se usa (medio MB, guardado para usarse sin internet)
let _pdfLib = null;
function pdfLib() {
  return _pdfLib ||= new Promise((ok, mal) => {
    const s = document.createElement("script");
    s.src = new URL("lib/pdf-lib.min.js", base).href;
    s.onload = () => ok(window.PDFLib);
    s.onerror = () => { _pdfLib = null; mal(new Error("No se pudo cargar la herramienta de PDF. Revisa tu internet.")); };
    document.head.append(s);
  });
}
async function abrirPdf(f) {
  const { PDFDocument } = await pdfLib();
  try { return await PDFDocument.load(await f.arrayBuffer()); }
  catch (e) {
    if (/encrypt/i.test(String(e && e.message))) throw new Error(`«${f.name}» tiene contraseña; quítasela primero con «Quitar contraseña».`);
    throw new Error(`«${f.name}» no se pudo leer como PDF.`);
  }
}
function filaDescarga(lista, bytes, nombre, detalle, tipo = "application/pdf") {
  const li = document.createElement("li");
  li.innerHTML = `<div class="nombre"><div></div><small></small></div><a class="bajar">Descargar</a>`;
  li.querySelector(".nombre div").textContent = nombre;
  li.querySelector("small").textContent = `${detalle} · ${(bytes.length / 1024).toFixed(0)} KB`;
  const a = li.querySelector("a");
  a.href = URL.createObjectURL(new Blob([bytes], { type: tipo }));
  a.download = nombre;
  lista.prepend(li);
}
const paginasTxt = (n) => n === 1 ? "1 página" : n + " páginas";

// ---------------------------------------------------------------- 6. unir PDF
const porUnir = [];
function pintarUnir() {
  const ul = $("listaUnir");
  ul.textContent = "";
  porUnir.forEach((f, i) => {
    const li = document.createElement("li");
    li.innerHTML = `<div class="nombre"><div></div></div>
      <button class="chico" aria-label="Subir" data-m="-1">↑</button>
      <button class="chico" aria-label="Bajar" data-m="1">↓</button>
      <button class="chico" aria-label="Quitar" data-m="0">✕</button>`;
    li.querySelector(".nombre div").textContent = `${i + 1}. ${f.name}`;
    for (const b of li.querySelectorAll("button")) {
      const m = Number(b.dataset.m);
      b.disabled = (m === -1 && i === 0) || (m === 1 && i === porUnir.length - 1);
      b.onclick = () => {
        if (m === 0) porUnir.splice(i, 1);
        else [porUnir[i], porUnir[i + m]] = [porUnir[i + m], porUnir[i]];
        pintarUnir();
      };
    }
    ul.append(li);
  });
  $("botonUnir").disabled = porUnir.length < 2;
  $("botonUnir").textContent = porUnir.length < 2 ? "Unir" : `Unir ${porUnir.length} archivos`;
  $("limpiarUnir").hidden = !porUnir.length;
  aviso("avisoUnir", porUnir.length === 1 ? "Agrega al menos otro PDF." : "");
}
function aviso(id, texto, error = false) {
  $(id).textContent = texto;
  $(id).classList.toggle("error", error);
}
zonaDeArchivos($("zonaUnir"), $("archivosUnir"), (fs) => {
  const buenos = fs.filter(esPdf);
  porUnir.push(...buenos);
  pintarUnir();
  if (buenos.length < fs.length) aviso("avisoUnir", "Solo se agregan archivos PDF.", true);
});
$("limpiarUnir").onclick = () => { porUnir.length = 0; pintarUnir(); };
$("botonUnir").onclick = async () => {
  $("botonUnir").disabled = true;
  try {
    const { PDFDocument } = await pdfLib();
    const salida = await PDFDocument.create();
    let n = 0;
    for (const [i, f] of porUnir.entries()) {
      aviso("avisoUnir", `Uniendo ${i + 1} de ${porUnir.length}…`);
      const doc = await abrirPdf(f);
      for (const p of await salida.copyPages(doc, doc.getPageIndices())) { salida.addPage(p); n++; }
    }
    const bytes = await salida.save();
    filaDescarga($("salidaUnir"), bytes, sinExt(porUnir[0].name) + " (unido).pdf", `${porUnir.length} archivos, ${paginasTxt(n)}`);
    aviso("avisoUnir", "Listo.");
  } catch (e) {
    aviso("avisoUnir", String(e && e.message || e), true);
  } finally {
    $("botonUnir").disabled = porUnir.length < 2;
  }
};

// ---------------------------------------------------------------- 7. dividir PDF
let paraDividir = null;      // { f, doc, total }
// "1-3, 5, 8-" → [[0,1,2],[4],[7..fin]]; lanza Error con el pedazo que no se entiende
function leerRangos(texto, total) {
  const limpio = texto.trim();
  if (!limpio) return [Array.from({ length: total }, (_, i) => i)];
  return limpio.split(/[,;]+/).map((t) => t.trim()).filter(Boolean).map((t) => {
    const m = /^(\d+)?\s*(?:(-|–|a)\s*(\d+)?)?$/i.exec(t);
    if (!m || (!m[1] && !m[3])) throw new Error(`No entiendo «${t}». Ejemplo: 1-3, 5, 8-10`);
    const ini = m[1] ? Number(m[1]) : 1;
    const fin = m[2] ? (m[3] ? Number(m[3]) : total) : ini;
    if (ini < 1 || fin > total || ini > fin) throw new Error(`«${t}» se sale del documento: tiene ${paginasTxt(total)}.`);
    return Array.from({ length: fin - ini + 1 }, (_, i) => ini - 1 + i);
  });
}
zonaDeArchivos($("zonaDividir"), $("archivoDividir"), async (fs) => {
  const f = fs.find(esPdf);
  if (!f) { $("infoDividir").textContent = "Ese archivo no es un PDF."; return; }
  $("infoDividir").textContent = "Abriendo…";
  try {
    const doc = await abrirPdf(f);
    paraDividir = { f, doc, total: doc.getPageCount() };
    $("infoDividir").textContent = `${f.name} · ${paginasTxt(paraDividir.total)}`;
    $("opcionesDividir").hidden = false;
    aviso("avisoDividir", "");
  } catch (e) {
    paraDividir = null;
    $("opcionesDividir").hidden = true;
    $("infoDividir").textContent = String(e && e.message || e);
  }
});
$("botonDividir").onclick = async () => {
  if (!paraDividir) return;
  const { f, doc, total } = paraDividir;
  const modo = document.querySelector('input[name="modo"]:checked').value;
  $("botonDividir").disabled = true;
  try {
    const rangos = leerRangos($("paginas").value, total);
    let grupos = rangos;
    if (modo === "uno") grupos = [rangos.flat()];
    if (modo === "paginas") grupos = rangos.flat().map((i) => [i]);
    if (grupos.length > 200) throw new Error(`Saldrían ${grupos.length} archivos; elige menos páginas.`);
    const { PDFDocument } = await pdfLib();
    const nombre = sinExt(f.name);
    const hechos = [];
    for (const [k, g] of grupos.entries()) {
      aviso("avisoDividir", `Preparando ${k + 1} de ${grupos.length}…`);
      const salida = await PDFDocument.create();
      for (const p of await salida.copyPages(doc, g)) salida.addPage(p);
      const seguidas = g.every((x, j) => j === 0 || x === g[j - 1] + 1);
      const etiqueta = g.length === 1 ? `p${g[0] + 1}` : seguidas ? `p${g[0] + 1}-${g[g.length - 1] + 1}` : `${g.length} páginas`;
      hechos.push([await salida.save(), `${nombre} (${etiqueta}).pdf`, paginasTxt(g.length)]);
    }
    for (const h of hechos.reverse()) filaDescarga($("salidaDividir"), ...h);
    aviso("avisoDividir", grupos.length === 1 ? "Listo." : `Listo: ${grupos.length} archivos.`);
  } catch (e) {
    aviso("avisoDividir", String(e && e.message || e), true);
  } finally {
    $("botonDividir").disabled = false;
  }
};

// ---------------------------------------------------------------- 8. organizar páginas
// PDF.js dibuja las miniaturas; pdf-lib arma el PDF final con el orden y los giros elegidos.
let _pdfjs = null;
function pdfJs() {
  return _pdfjs ||= import(new URL("lib/pdf.min.mjs", base).href).then((m) => {
    m.GlobalWorkerOptions.workerSrc = new URL("lib/pdf.worker.min.mjs", base).href;
    return m;
  }).catch(() => { _pdfjs = null; throw new Error("No se pudo cargar el visor de páginas. Revisa tu internet."); });
}
const hojas = [];            // { fuente: {nombre, bytes, vista, lib}, i, giro, li }
let arrastrada = null;
let colaPintar = Promise.resolve();
const alVerse = new IntersectionObserver((vistas) => {
  for (const v of vistas) if (v.isIntersecting) { alVerse.unobserve(v.target); pintarHoja(v.target._hoja); }
}, { rootMargin: "400px" });
function pintarHoja(h) {       // una a la vez, para no trabar el celular
  colaPintar = colaPintar.then(async () => {
    if (!hojas.includes(h)) return;
    const lienzo0 = h.li.querySelector("canvas");
    if (h.fuente.blanca) {           // hoja en blanco: solo un rectángulo blanco de su forma
      const [w, hh] = h.fuente.tam, e = 240 / Math.max(w, hh);
      lienzo0.width = Math.round(w * e); lienzo0.height = Math.round(hh * e);
      const c = lienzo0.getContext("2d"); c.fillStyle = "#fff"; c.fillRect(0, 0, lienzo0.width, lienzo0.height);
      return;
    }
    const pagina = await h.fuente.vista.getPage(h.i + 1);
    const base1 = pagina.getViewport({ scale: 1 });
    const v = pagina.getViewport({ scale: 240 / Math.max(base1.width, base1.height) });
    const lienzo = h.li.querySelector("canvas");
    lienzo.width = Math.round(v.width); lienzo.height = Math.round(v.height);
    await pagina.render({ canvasContext: lienzo.getContext("2d"), viewport: v }).promise;
  }).catch((e) => console.warn("No se pudo dibujar una miniatura", e));
}
function moverHoja(de, a) {
  if (a < 0 || a >= hojas.length || de === a) return;
  hojas.splice(a, 0, hojas.splice(de, 1)[0]);
  acomodarOrg();
}
function crearHoja(fuente, i) {
  const h = { fuente, i, giro: 0 };
  const li = h.li = document.createElement("li");
  li._hoja = h;
  li.draggable = true;
  li.innerHTML = `<div class="hoja"><canvas width="85" height="110"></canvas></div><div class="num"></div>
    <div class="botones"><button data-a="izq" aria-label="Mover antes">←</button><button data-a="girar" aria-label="Girar">↻</button><button data-a="quitar" aria-label="Quitar">✕</button><button data-a="der" aria-label="Mover después">→</button></div>`;
  li.title = fuente.blanca ? "Hoja en blanco" : `${fuente.nombre}, página ${i + 1}`;
  li.onclick = (e) => {
    const a = e.target.closest("button")?.dataset.a;
    const k = hojas.indexOf(h);
    if (a === "izq") moverHoja(k, k - 1);
    else if (a === "der") moverHoja(k, k + 1);
    else if (a === "girar") { h.giro = (h.giro + 90) % 360; acomodarOrg(); }
    else if (a === "quitar") { hojas.splice(k, 1); li.remove(); acomodarOrg(); }
  };
  li.ondragstart = (e) => { arrastrada = h; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", ""); };
  li.ondragend = () => { arrastrada = null; };
  li.ondragover = (e) => { if (arrastrada && arrastrada !== h) { e.preventDefault(); li.classList.add("destino"); } };
  li.ondragleave = () => li.classList.remove("destino");
  li.ondrop = (e) => {
    e.preventDefault(); e.stopPropagation(); li.classList.remove("destino");
    if (arrastrada && arrastrada !== h) moverHoja(hojas.indexOf(arrastrada), hojas.indexOf(h));
  };
  alVerse.observe(li);
  return h;
}
function acomodarOrg() {
  const ul = $("paginasOrg");
  hojas.forEach((h, k) => {
    if (ul.children[k] !== h.li) ul.insertBefore(h.li, ul.children[k] || null);
    h.li.querySelector(".num").textContent = k + 1;
    h.li.querySelector("canvas").style.transform = h.giro ? `rotate(${h.giro}deg)` : "";
    h.li.querySelector('[data-a="izq"]').disabled = k === 0;
    h.li.querySelector('[data-a="der"]').disabled = k === hojas.length - 1;
  });
  $("guardarOrg").disabled = !hojas.length;
  $("girarTodasOrg").hidden = $("limpiarOrg").hidden = !hojas.length;
  aviso("avisoOrg", hojas.length ? `${paginasTxt(hojas.length)}. Arrastra una página para cambiarla de lugar, o usa las flechas.` : "");
}
zonaDeArchivos($("zonaOrg"), $("archivosOrg"), async (fs) => {
  const buenos = fs.filter(esPdf);
  if (!buenos.length) return aviso("avisoOrg", "Solo se pueden abrir archivos PDF.", true);
  aviso("avisoOrg", "Abriendo…");
  const fallas = [];
  for (const f of buenos) {
    try {
      const pdfjs = await pdfJs();
      const bytes = new Uint8Array(await f.arrayBuffer());
      const vista = await pdfjs.getDocument({ data: bytes.slice() }).promise;      // PDF.js se queda con su copia
      const fuente = { nombre: f.name, bytes, vista, lib: null };
      for (let i = 0; i < vista.numPages; i++) hojas.push(crearHoja(fuente, i));
    } catch (e) {
      fallas.push(e && e.name === "PasswordException" ? `«${f.name}» tiene contraseña; quítasela primero con «Quitar contraseña».`
        : /visor/.test(String(e && e.message)) ? e.message : `«${f.name}» no se pudo leer como PDF.`);
    }
  }
  acomodarOrg();
  if (fallas.length) aviso("avisoOrg", fallas.join(" "), true);
});
// Una hoja en blanco al final, del tamaño de la última (como se ve, ya girada); sin páginas, carta
$("blancaOrg").onclick = async () => {
  let tam = [612, 792];
  const ultima = hojas[hojas.length - 1];
  if (ultima) {
    if (ultima.fuente.blanca) tam = [...ultima.fuente.tam];
    else { const v = (await ultima.fuente.vista.getPage(ultima.i + 1)).getViewport({ scale: 1 }); tam = [v.width, v.height]; }
    if (ultima.giro % 180) tam.reverse();
  }
  const h = crearHoja({ blanca: true, tam, nombre: "Hoja en blanco" }, 0);
  hojas.push(h);
  acomodarOrg();
  aviso("avisoOrg", `Hoja en blanco agregada al final (página ${hojas.length}). Arrástrala o muévela con las flechas a donde la quieras.`);
  h.li.scrollIntoView({ block: "nearest", behavior: "smooth" });
};
$("girarTodasOrg").onclick = () => { for (const h of hojas) h.giro = (h.giro + 90) % 360; acomodarOrg(); };
$("limpiarOrg").onclick = () => { hojas.length = 0; $("paginasOrg").textContent = ""; acomodarOrg(); };
$("guardarOrg").onclick = async () => {
  $("guardarOrg").disabled = true;
  try {
    aviso("avisoOrg", "Armando el PDF…");
    const { PDFDocument, degrees } = await pdfLib();
    const salida = await PDFDocument.create();
    // Cada archivo se copia de una sola vez: así las letras e imágenes que comparten sus páginas no se repiten
    const copias = new Map();
    for (const fuente of new Set(hojas.map((h) => h.fuente))) {
      if (fuente.blanca) continue;
      try { fuente.lib ||= await PDFDocument.load(fuente.bytes); }
      catch { throw new Error(`«${fuente.nombre}» no se pudo procesar (puede estar protegido).`); }
      const suyas = hojas.filter((h) => h.fuente === fuente);
      const hechas = await salida.copyPages(fuente.lib, suyas.map((h) => h.i));
      suyas.forEach((h, k) => copias.set(h, hechas[k]));
    }
    for (const h of hojas) {
      if (h.fuente.blanca) { salida.addPage(h.fuente.tam).setRotation(degrees(h.giro)); continue; }
      const pagina = copias.get(h);
      if (h.giro) pagina.setRotation(degrees((pagina.getRotation().angle + h.giro) % 360));
      salida.addPage(pagina);
    }
    const bytes = await salida.save();
    filaDescarga($("salidaOrg"), bytes, sinExt((hojas.find((h) => !h.fuente.blanca) || hojas[0]).fuente.nombre) + " (organizado).pdf", paginasTxt(hojas.length));
    acomodarOrg();
    aviso("avisoOrg", "Listo. Puedes seguir cambiando y guardar otra versión.");
  } catch (e) {
    aviso("avisoOrg", String(e && e.message || e), true);
  } finally {
    $("guardarOrg").disabled = !hojas.length;
  }
};

// ---------------------------------------------------------------- 9. imágenes a PDF
const fotos = [];            // { f, url, giro, li }
// La orientación que la cámara anota en el JPG (1 = normal). pdf-lib no la aplica, así que
// solo se mete el JPG tal cual cuando no hay que girarlo; si no, se redibuja.
function orientacionJpeg(b) {
  if (b[0] !== 0xff || b[1] !== 0xd8) return 1;
  let p = 2;
  while (p + 4 < b.length && b[p] === 0xff) {
    const marca = b[p + 1], largo = (b[p + 2] << 8) | b[p + 3];
    if (marca === 0xda) return 1;
    if (marca === 0xe1 && b[p + 4] === 0x45 && b[p + 5] === 0x78 && b[p + 6] === 0x69 && b[p + 7] === 0x66) {
      const t = p + 10, le = b[t] === 0x49;
      const u16 = (o) => le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1];
      const u32 = (o) => (le ? b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24) : (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
      const ifd = t + u32(t + 4), n = u16(ifd);
      for (let i = 0; i < n; i++) if (u16(ifd + 2 + i * 12) === 0x0112) return u16(ifd + 2 + i * 12 + 8);
      return 1;
    }
    p += 2 + largo;
  }
  return 1;
}
function acomodarImg() {
  const ul = $("listaImg");
  fotos.forEach((x, k) => {
    if (ul.children[k] !== x.li) ul.insertBefore(x.li, ul.children[k] || null);
    x.li.querySelector(".num").textContent = k + 1;
    x.li.querySelector("img").style.transform = x.giro ? `rotate(${x.giro}deg)` : "";
    x.li.querySelector('[data-a="izq"]').disabled = k === 0;
    x.li.querySelector('[data-a="der"]').disabled = k === fotos.length - 1;
  });
  $("crearImg").disabled = !fotos.length;
  $("crearImg").textContent = fotos.length > 1 ? `Crear PDF de ${fotos.length} páginas` : "Crear PDF";
  $("limpiarImg").hidden = !fotos.length;
}
function crearFoto(f) {
  const x = { f, url: URL.createObjectURL(f), giro: 0 };
  const li = x.li = document.createElement("li");
  li.innerHTML = `<div class="hoja"><img alt=""></div><div class="num"></div>
    <div class="botones"><button data-a="izq" aria-label="Mover antes">←</button><button data-a="girar" aria-label="Girar">↻</button><button data-a="quitar" aria-label="Quitar">✕</button><button data-a="der" aria-label="Mover después">→</button></div>`;
  li.style.cursor = "default";
  li.title = f.name;
  li.querySelector("img").src = x.url;
  li.onclick = (e) => {
    const a = e.target.closest("button")?.dataset.a, k = fotos.indexOf(x);
    if (a === "izq" && k > 0) fotos.splice(k - 1, 0, fotos.splice(k, 1)[0]);
    else if (a === "der" && k < fotos.length - 1) fotos.splice(k + 1, 0, fotos.splice(k, 1)[0]);
    else if (a === "girar") x.giro = (x.giro + 90) % 360;
    else if (a === "quitar") { fotos.splice(k, 1); li.remove(); URL.revokeObjectURL(x.url); }
    else return;
    acomodarImg();
  };
  return x;
}
zonaDeArchivos($("zonaImg"), $("archivosImg"), (fs) => {
  const buenas = fs.filter((f) => f.type.startsWith("image/") || /\.(jpe?g|png|webp|gif|bmp)$/i.test(f.name));
  for (const f of buenas) fotos.push(crearFoto(f));
  acomodarImg();
  aviso("avisoImg", buenas.length < fs.length ? "Solo se agregan imágenes." : "", buenas.length < fs.length);
});
$("limpiarImg").onclick = () => { for (const x of fotos) URL.revokeObjectURL(x.url); fotos.length = 0; $("listaImg").textContent = ""; acomodarImg(); aviso("avisoImg", ""); };

// Devuelve la imagen ya metida en el PDF. JPG derecho: sus bytes tal cual (sin perder calidad).
// Lo demás se redibuja: PNG sigue PNG; WebP y otros pasan a JPG de buena calidad.
async function incrustar(doc, x) {
  const bytes = new Uint8Array(await x.f.arrayBuffer());
  const esJpg = bytes[0] === 0xff && bytes[1] === 0xd8;
  const esPng = bytes[0] === 0x89 && bytes[1] === 0x50;
  if (esJpg && !x.giro && orientacionJpeg(bytes) === 1) {
    try { return await doc.embedJpg(bytes); } catch { /* JPG raro: se redibuja abajo */ }
  }
  if (esPng && !x.giro) {
    try { return await doc.embedPng(bytes); } catch { /* PNG raro: se redibuja abajo */ }
  }
  let mapa;
  try { mapa = await createImageBitmap(x.f, { imageOrientation: "from-image" }); }
  catch { throw new Error(`«${x.f.name}» no se pudo abrir como imagen.`); }
  const deLado = x.giro === 90 || x.giro === 270;
  const lienzo = document.createElement("canvas");
  lienzo.width = deLado ? mapa.height : mapa.width;
  lienzo.height = deLado ? mapa.width : mapa.height;
  const c = lienzo.getContext("2d");
  if (!esPng) { c.fillStyle = "#fff"; c.fillRect(0, 0, lienzo.width, lienzo.height); }
  c.translate(lienzo.width / 2, lienzo.height / 2);
  c.rotate(x.giro * Math.PI / 180);
  c.drawImage(mapa, -mapa.width / 2, -mapa.height / 2);
  mapa.close();
  const blob = await new Promise((ok) => lienzo.toBlob(ok, esPng ? "image/png" : "image/jpeg", 0.92));
  const nuevos = new Uint8Array(await blob.arrayBuffer());
  return esPng ? doc.embedPng(nuevos) : doc.embedJpg(nuevos);
}
const HOJAS = { carta: [612, 792], a4: [595.28, 841.89], oficio: [612, 936] };
$("crearImg").onclick = async () => {
  $("crearImg").disabled = true;
  try {
    const { PDFDocument } = await pdfLib();
    const doc = await PDFDocument.create();
    const hoja = $("hojaImg").value, orienta = $("orientaImg").value, margen = Number($("margenImg").value);
    for (const [k, x] of fotos.entries()) {
      aviso("avisoImg", `Agregando ${k + 1} de ${fotos.length}…`);
      const img = await incrustar(doc, x);
      let ancho, alto;
      if (hoja === "imagen") {
        // 96 puntos por pulgada, pero sin pasar de una hoja de 20 pulgadas
        const e = Math.min(0.75, 1440 / Math.max(img.width, img.height));
        ancho = img.width * e + margen * 2; alto = img.height * e + margen * 2;
      } else {
        [ancho, alto] = HOJAS[hoja];
        const horizontal = orienta === "horizontal" || (orienta === "auto" && img.width > img.height);
        if (horizontal) [ancho, alto] = [alto, ancho];
      }
      const e = Math.min((ancho - margen * 2) / img.width, (alto - margen * 2) / img.height);
      const w = img.width * e, h = img.height * e;
      doc.addPage([ancho, alto]).drawImage(img, { x: (ancho - w) / 2, y: (alto - h) / 2, width: w, height: h });
    }
    const bytes = await doc.save();
    filaDescarga($("salidaImg"), bytes, fotos[0].f.name.replace(/\.[^.]+$/, "") + ".pdf", paginasTxt(fotos.length));
    aviso("avisoImg", "Listo.");
  } catch (e) {
    aviso("avisoImg", String(e && e.message || e), true);
  } finally {
    $("crearImg").disabled = !fotos.length;
  }
};

// ---------------------------------------------------------------- 10. PDF a imágenes
// Un .zip sin comprimir (las imágenes ya vienen comprimidas) para bajar todas de una vez
function zipSimple(archivos) {
  const cod = new TextEncoder();
  const items = archivos.map((a) => ({ n: cod.encode(a.nombre), d: a.bytes, crc: crc32(a.bytes) }));
  const out = new Uint8Array(items.reduce((t, it) => t + 76 + it.n.length * 2 + it.d.length, 22)), w = new DataView(out.buffer);
  let q = 0;
  const cabecera = (it, central) => {
    w.setUint32(q, central ? 0x02014b50 : 0x04034b50, true); q += 4;
    if (central) { w.setUint16(q, 20, true); q += 2; }
    for (const v of [20, 0x0800, 0, 0, 0x21]) { w.setUint16(q, v, true); q += 2; }      // 0x0800: nombres en UTF-8
    for (const v of [it.crc, it.d.length, it.d.length]) { w.setUint32(q, v, true); q += 4; }
    w.setUint16(q, it.n.length, true); q += 4;
    if (central) { q += 10; w.setUint32(q, it.local, true); q += 4; }
    out.set(it.n, q); q += it.n.length;
  };
  for (const it of items) { it.local = q; cabecera(it, false); out.set(it.d, q); q += it.d.length; }
  const inicio = q;
  for (const it of items) cabecera(it, true);
  w.setUint32(q, 0x06054b50, true); w.setUint16(q + 8, items.length, true); w.setUint16(q + 10, items.length, true);
  w.setUint32(q + 12, q - inicio, true); w.setUint32(q + 16, inicio, true);
  return out;
}
let paraImagenes = null;     // { f, vista, total }
zonaDeArchivos($("zonaAImg"), $("archivoAImg"), async (fs) => {
  const f = fs.find(esPdf);
  if (!f) { $("infoAImg").textContent = "Ese archivo no es un PDF."; return; }
  $("infoAImg").textContent = "Abriendo…";
  try {
    const pdfjs = await pdfJs();
    const vista = await pdfjs.getDocument({ data: new Uint8Array(await f.arrayBuffer()) }).promise;
    paraImagenes = { f, vista, total: vista.numPages };
    $("infoAImg").textContent = `${f.name} · ${paginasTxt(vista.numPages)}`;
    $("opcionesAImg").hidden = false;
    aviso("avisoAImg", "");
  } catch (e) {
    paraImagenes = null;
    $("opcionesAImg").hidden = true;
    $("infoAImg").textContent = e && e.name === "PasswordException" ? `«${f.name}» tiene contraseña; quítasela primero con «Quitar contraseña».`
      : /visor/.test(String(e && e.message)) ? e.message : `«${f.name}» no se pudo leer como PDF.`;
  }
});
$("botonAImg").onclick = async () => {
  if (!paraImagenes) return;
  const { f, vista, total } = paraImagenes;
  $("botonAImg").disabled = true;
  try {
    const paginas = [...new Set(leerRangos($("paginasAImg").value, total).flat())];
    if (paginas.length > 300) throw new Error(`Son ${paginas.length} imágenes; elige menos páginas.`);
    const png = $("formatoAImg").value === "png", ext = png ? "png" : "jpg";
    const escala = Number($("calidadAImg").value) / 72;
    const nombre = sinExt(f.name), cifras = String(total).length;
    const hechas = [];
    const lienzo = document.createElement("canvas");
    for (const [k, i] of paginas.entries()) {
      aviso("avisoAImg", `Página ${k + 1} de ${paginas.length}…`);
      const pagina = await vista.getPage(i + 1);
      let v = pagina.getViewport({ scale: escala });
      const tope = Math.sqrt(24e6 / (v.width * v.height));      // máximo 24 megapíxeles por imagen
      if (tope < 1) v = pagina.getViewport({ scale: escala * tope });
      lienzo.width = Math.round(v.width); lienzo.height = Math.round(v.height);
      const c = lienzo.getContext("2d");
      c.fillStyle = "#fff"; c.fillRect(0, 0, lienzo.width, lienzo.height);
      await pagina.render({ canvasContext: c, viewport: v }).promise;
      const blob = await new Promise((ok) => lienzo.toBlob(ok, png ? "image/png" : "image/jpeg", 0.9));
      hechas.push({ nombre: `${nombre} - página ${String(i + 1).padStart(cifras, "0")}.${ext}`, bytes: new Uint8Array(await blob.arrayBuffer()), px: `${lienzo.width} × ${lienzo.height} px` });
    }
    if (hechas.length <= 12) for (const h of [...hechas].reverse()) filaDescarga($("salidaAImg"), h.bytes, h.nombre, h.px, png ? "image/png" : "image/jpeg");
    if (hechas.length > 1) filaDescarga($("salidaAImg"), zipSimple(hechas), `${nombre} (imágenes).zip`, `${hechas.length} imágenes ${ext.toUpperCase()}`, "application/zip");
    aviso("avisoAImg", hechas.length === 1 ? "Listo." : `Listo: ${hechas.length} imágenes${hechas.length > 12 ? ", juntas en un .zip" : ""}.`);
  } catch (e) {
    aviso("avisoAImg", String(e && e.message || e), true);
  } finally {
    $("botonAImg").disabled = false;
  }
};

// ---------------------------------------------------------------- 11. comprimir PDF
// Casi todo el peso de un PDF son sus imágenes. Aquí se vuelven a guardar como JPG con menos
// calidad y, si traen más puntos de los que hacen falta, más chicas. El texto y los dibujos no
// se tocan. Lo que no se sabe tratar con seguridad (CMYK, paletas, máscaras, 1 bit) se deja igual.
const NIVELES = { ligera: { ppp: 220, calidad: 0.82 }, media: { ppp: 150, calidad: 0.68 }, maxima: { ppp: 96, calidad: 0.5 } };
const tamTxt = (b) => b >= 1e6 ? (b / 1e6).toFixed(b >= 1e7 ? 0 : 1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB";
const porTubo = async (b, tubo) => new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(tubo)).arrayBuffer());

// Deshace el «predictor» con que se guardan las imágenes sin pérdida (2 = TIFF, 10 o más = PNG)
function sinPredictor(d, pred, colores, columnas) {
  const fila = colores * columnas;
  if (pred === 2) {
    for (let s = 0; s + fila <= d.length; s += fila) for (let i = colores; i < fila; i++) d[s + i] += d[s + i - colores];
    return d;
  }
  const filas = Math.floor(d.length / (fila + 1)), out = new Uint8Array(filas * fila);
  for (let r = 0; r < filas; r++) {
    const tipo = d[r * (fila + 1)], e = r * (fila + 1) + 1, s = r * fila;
    for (let i = 0; i < fila; i++) {
      const a = i >= colores ? out[s + i - colores] : 0, b = r ? out[s + i - fila] : 0, c = r && i >= colores ? out[s + i - fila - colores] : 0;
      let p = 0;
      if (tipo === 1) p = a;
      else if (tipo === 2) p = b;
      else if (tipo === 3) p = (a + b) >> 1;
      else if (tipo === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[s + i] = d[e + i] + p;
    }
  }
  return out;
}
// Quita los datos de la cámara (Exif) de un JPG: el navegador giraría la imagen por ellos y el PDF no lo hace
function sinExif(b) {
  if (orientacionJpeg(b) === 1) return b;
  const partes = [b.subarray(0, 2)];
  let p = 2;
  while (p + 4 < b.length && b[p] === 0xff && b[p + 1] !== 0xda) {
    const largo = 2 + ((b[p + 2] << 8) | b[p + 3]);
    if (!(b[p + 1] === 0xe1 && b[p + 4] === 0x45 && b[p + 5] === 0x78)) partes.push(b.subarray(p, p + largo));
    p += largo;
  }
  partes.push(b.subarray(p));
  const out = new Uint8Array(partes.reduce((n, x) => n + x.length, 0));
  let q = 0;
  for (const x of partes) { out.set(x, q); q += x.length; }
  return out;
}

// Devuelve los bytes ahorrados (0 si la imagen se dejó como estaba)
async function reducirImagen(L, ctx, ref, obj, nivel, ladoMax) {
  const { PDFName, PDFArray, PDFRawStream } = L;
  const nom = (s) => PDFName.of(s), d = obj.dict, ver = (k) => d.lookup(nom(k));
  const num = (k) => { const x = ver(k); return x && typeof x.asNumber === "function" ? x.asNumber() : NaN; };
  const w = num("Width"), h = num("Height");
  if (!(w > 0 && h > 0) || num("BitsPerComponent") !== 8 || w * h < 10000 || obj.contents.length < 4096) return 0;
  if (String(ver("ImageMask")) === "true" || ver("Mask") instanceof PDFArray) return 0;
  if (ver("SMask")?.dict?.get(nom("Matte"))) return 0;
  const dec = ver("Decode");
  if (dec instanceof PDFArray) for (let i = 0; i < dec.size(); i++) if (dec.lookup(i).asNumber() !== i % 2) return 0;
  // colores: solo gris o RGB
  let cs = ver("ColorSpace"), n = 0;
  if (cs instanceof PDFArray) {
    const tipo = cs.lookup(0);
    if (tipo === nom("ICCBased")) { const k = cs.lookup(1)?.dict?.lookup(nom("N"))?.asNumber(); n = k === 1 || k === 3 ? k : 0; }
    else cs = tipo === nom("CalRGB") || tipo === nom("CalGray") ? tipo : null;
  }
  if (cs === nom("DeviceRGB") || cs === nom("CalRGB")) n = 3;
  if (cs === nom("DeviceGray") || cs === nom("CalGray")) n = 1;
  if (!n) return 0;
  let filtro = ver("Filter"), parms = ver("DecodeParms");
  if (filtro instanceof PDFArray) { if (filtro.size() !== 1) return 0; filtro = filtro.lookup(0); }
  if (parms instanceof PDFArray) parms = parms.size() ? parms.lookup(0) : undefined;

  const e = Math.min(1, ladoMax / Math.max(w, h));
  const lienzo = document.createElement("canvas");
  lienzo.width = Math.max(1, Math.round(w * e)); lienzo.height = Math.max(1, Math.round(h * e));
  const c = lienzo.getContext("2d");
  c.imageSmoothingQuality = "high";
  let origen;
  if (filtro === nom("DCTDecode")) {
    origen = await createImageBitmap(new Blob([sinExif(obj.contents)], { type: "image/jpeg" }));
    if (origen.width !== w || origen.height !== h) { origen.close(); return 0; }
  } else if (filtro === nom("FlateDecode")) {
    if (w * h > 40e6) return 0;
    let crudo = await porTubo(obj.contents, new DecompressionStream("deflate"));
    const pp = (k, def) => { const x = parms?.lookup?.(nom(k)); return x ? x.asNumber() : def; };
    const pred = pp("Predictor", 1);
    if (pred > 1) {
      if (pp("Colors", 1) !== n || pp("Columns", 1) !== w || pp("BitsPerComponent", 8) !== 8) return 0;
      crudo = sinPredictor(crudo, pred, n, w);
    }
    if (crudo.length < w * h * n) return 0;
    const px = new Uint8ClampedArray(w * h * 4);
    if (n === 3) for (let i = 0, j = 0; j < px.length; i += 3, j += 4) { px[j] = crudo[i]; px[j + 1] = crudo[i + 1]; px[j + 2] = crudo[i + 2]; px[j + 3] = 255; }
    else for (let i = 0, j = 0; j < px.length; i++, j += 4) { px[j] = px[j + 1] = px[j + 2] = crudo[i]; px[j + 3] = 255; }
    origen = document.createElement("canvas");
    origen.width = w; origen.height = h;
    origen.getContext("2d").putImageData(new ImageData(px, w, h), 0, 0);
  } else return 0;
  c.drawImage(origen, 0, 0, lienzo.width, lienzo.height);
  origen.close?.();
  const blob = await new Promise((ok) => lienzo.toBlob(ok, "image/jpeg", nivel.calidad));
  if (!blob || blob.size >= obj.contents.length * 0.9) return 0;
  const nuevos = new Uint8Array(await blob.arrayBuffer());
  d.set(nom("Filter"), nom("DCTDecode"));
  d.delete(nom("DecodeParms")); d.delete(nom("Decode"));
  d.set(nom("ColorSpace"), nom("DeviceRGB"));
  d.set(nom("Width"), ctx.obj(lienzo.width)); d.set(nom("Height"), ctx.obj(lienzo.height));
  ctx.assign(ref, PDFRawStream.of(d, nuevos));
  return obj.contents.length - nuevos.length;
}

async function comprimirPdf(f, nivel, avance) {
  const L = await pdfLib(), { PDFName, PDFRawStream } = L;
  const doc = await abrirPdf(f), ctx = doc.context, nom = (s) => PDFName.of(s);
  const ladoMax = Math.max(...doc.getPages().map((p) => Math.max(p.getWidth(), p.getHeight())), 72) / 72 * nivel.ppp;
  const flujos = ctx.enumerateIndirectObjects().filter(([, o]) => o instanceof PDFRawStream);
  const imagenes = flujos.filter(([, o]) => o.dict.get(nom("Subtype")) === nom("Image"));
  const mascaras = new Set(imagenes.flatMap(([, o]) => [o.dict.get(nom("SMask")), o.dict.get(nom("Mask"))]));
  let cambiadas = 0;
  for (const [k, [ref, obj]] of imagenes.entries()) {
    avance(`imagen ${k + 1} de ${imagenes.length}`);
    if (mascaras.has(ref)) continue;
    try { if (await reducirImagen(L, ctx, ref, obj, nivel, ladoMax)) cambiadas++; }
    catch (e) { console.warn("Una imagen se dejó como estaba", e); }
  }
  // Partes guardadas sin comprimir (pasa en PDF hechos por programas viejos)
  for (const [ref, obj] of flujos) {
    if (obj.dict.has(nom("Filter")) || obj.contents.length < 1024) continue;
    const z = await porTubo(obj.contents, new CompressionStream("deflate"));
    if (z.length >= obj.contents.length * 0.9) continue;
    obj.dict.set(nom("Filter"), nom("FlateDecode"));
    ctx.assign(ref, PDFRawStream.of(obj.dict, z));
  }
  avance("guardando");
  return { bytes: await doc.save(), imagenes: imagenes.length, cambiadas };
}

const porComprimir = [];
function pintarComp() {
  const ul = $("listaComp");
  ul.textContent = "";
  porComprimir.forEach((f, i) => {
    const li = document.createElement("li");
    li.innerHTML = `<div class="nombre"><div></div><small></small></div><button class="chico" aria-label="Quitar">✕</button>`;
    li.querySelector(".nombre div").textContent = f.name;
    li.querySelector("small").textContent = tamTxt(f.size);
    li.querySelector("button").onclick = () => { porComprimir.splice(i, 1); pintarComp(); };
    ul.append(li);
  });
  $("botonComp").disabled = !porComprimir.length;
  $("botonComp").textContent = porComprimir.length > 1 ? `Comprimir ${porComprimir.length} archivos` : "Comprimir";
  $("limpiarComp").hidden = !porComprimir.length;
}
zonaDeArchivos($("zonaComp"), $("archivosComp"), (fs) => {
  const buenos = fs.filter(esPdf);
  porComprimir.push(...buenos);
  pintarComp();
  aviso("avisoComp", buenos.length < fs.length ? "Solo se agregan archivos PDF." : "", buenos.length < fs.length);
});
$("limpiarComp").onclick = () => { porComprimir.length = 0; pintarComp(); aviso("avisoComp", ""); };
$("botonComp").onclick = async () => {
  const nivel = NIVELES[document.querySelector('input[name="nivel"]:checked').value];
  $("botonComp").disabled = true;
  const notas = [];
  let fallo = false;
  for (const [i, f] of porComprimir.entries()) {
    const cual = porComprimir.length > 1 ? `Archivo ${i + 1} de ${porComprimir.length}: ` : "Comprimiendo: ";
    try {
      const r = await comprimirPdf(f, nivel, (t) => aviso("avisoComp", cual + t + "…"));
      const menos = Math.round((1 - r.bytes.length / f.size) * 100);
      if (menos < 3) notas.push(`«${f.name}» ya no se puede reducir más${r.imagenes ? "" : " (no tiene imágenes)"}.`);
      else filaDescarga($("salidaComp"), r.bytes, sinExt(f.name) + " (comprimido).pdf", `Antes ${tamTxt(f.size)}, ${menos} % menos`);
    } catch (e) { fallo = true; notas.push(String(e && e.message || e)); }
  }
  aviso("avisoComp", notas.length ? notas.join(" ") : "Listo.", fallo);
  $("botonComp").disabled = !porComprimir.length;
};

// ---------------------------------------------------------------- 12. números de página y marca de agua
// Las dos escriben encima de las páginas con pdf-lib. Las medidas se piensan «como se ve la hoja»:
// colocar() las pasa a las del PDF aunque la página esté girada (Rotate) o recortada (CropBox).
function unPdf(s) {            // s = "Num" o "Marca"; devuelve una función que da { f, total } o null
  let actual = null;
  zonaDeArchivos($("zona" + s), $("archivo" + s), async (fs) => {
    const f = fs.find(esPdf);
    if (!f) { $("info" + s).textContent = "Ese archivo no es un PDF."; return; }
    $("info" + s).textContent = "Abriendo…";
    $("previa" + s).hidden = true;
    try {
      const doc = await abrirPdf(f);
      actual = { f, total: doc.getPageCount() };
      $("info" + s).textContent = `${f.name} · ${paginasTxt(actual.total)}`;
      $("opciones" + s).hidden = false;
      aviso("aviso" + s, "");
    } catch (e) {
      actual = null;
      $("opciones" + s).hidden = true;
      $("info" + s).textContent = String(e && e.message || e);
    }
  });
  return () => actual;
}
const giroDe = (p) => ((p.getRotation().angle % 360) + 360) % 360;
function tamVisible(p) { const c = p.getCropBox(); return giroDe(p) % 180 ? [c.height, c.width] : [c.width, c.height]; }
// Algo de ancho × alto, con su centro en (cx, cy) medido desde la esquina de abajo a la izquierda
// de la hoja como se ve, e inclinado «angulo» grados → dónde y cómo dibujarlo en el PDF
function colocar(L, p, cx, cy, ancho, alto, angulo) {
  const c = p.getCropBox(), r = giroDe(p), t = angulo * Math.PI / 180, co = Math.cos(t), se = Math.sin(t);
  const vx = cx - ancho / 2 * co + alto / 2 * se, vy = cy - ancho / 2 * se - alto / 2 * co;
  const [x, y] = r === 90 ? [c.x + c.width - vy, c.y + vx] : r === 180 ? [c.x + c.width - vx, c.y + c.height - vy]
    : r === 270 ? [c.x + vy, c.y + c.height - vx] : [c.x + vx, c.y + vy];
  return { x, y, rotate: L.degrees(angulo + r) };
}
// Encierra lo que ya tenía la página entre q y Q: hay PDF que dejan las medidas cambiadas al
// terminar de dibujar, y lo nuevo saldría movido o de otro tamaño
function envolver(doc, p) {
  p.node.normalize();
  const contenido = p.node.Contents();
  if (!contenido || typeof contenido.insert !== "function") return;
  contenido.insert(0, doc.context.register(doc.context.stream("q\n")));
  contenido.push(doc.context.register(doc.context.stream("\nQ\n")));
}
function medirTexto(fuente, texto, size) {
  try { return fuente.widthOfTextAtSize(texto, size); }
  catch { throw new Error("El texto tiene símbolos que no se pueden escribir (por ejemplo emojis). Usa letras, números y signos comunes."); }
}
async function mostrarPrevia(id, bytes, i) {
  try {
    const pdfjs = await pdfJs();
    const vista = await pdfjs.getDocument({ data: bytes.slice() }).promise;
    const pagina = await vista.getPage(i + 1);
    const b = pagina.getViewport({ scale: 1 });
    const v = pagina.getViewport({ scale: 640 / Math.max(b.width, b.height) });
    const lienzo = $(id).querySelector("canvas");
    lienzo.width = Math.round(v.width); lienzo.height = Math.round(v.height);
    await pagina.render({ canvasContext: lienzo.getContext("2d"), viewport: v }).promise;
    $(id).querySelector("small").textContent = `Así quedó la página ${i + 1}`;
    $(id).hidden = false;
    vista.destroy();
  } catch (e) { console.warn("No se pudo mostrar la vista previa", e); }
}
const enOrden = (texto, total) => [...new Set(leerRangos(texto, total).flat())].sort((a, b) => a - b);
function centroEn(pos, W, H, ancho, alto, m) {      // "arriba-izq", "abajo-centro"…
  const [v, h] = pos.split("-");
  return [h === "izq" ? m + ancho / 2 : h === "der" ? W - m - ancho / 2 : W / 2, v === "abajo" ? m + alto / 2 : H - m - alto / 2];
}

const pdfNum = unPdf("Num");
$("botonNum").onclick = async () => {
  const a = pdfNum();
  if (!a) return;
  $("botonNum").disabled = true;
  try {
    const cuales = enOrden($("paginasNum").value, a.total);
    aviso("avisoNum", "Poniendo los números…");
    const L = await pdfLib(), doc = await abrirPdf(a.f);
    const fuente = await doc.embedFont(L.StandardFonts.Helvetica);
    const primero = Math.max(0, parseInt($("primeroNum").value, 10) || 0), ultimo = primero + cuales.length - 1;
    const formato = $("formatoNum").value, size = Number($("letraNum").value), alto = size * 0.72;
    cuales.forEach((i, k) => {
      const p = doc.getPage(i), [W, H] = tamVisible(p);
      const texto = formato.replace("{n}", primero + k).replace("{t}", ultimo);
      const ancho = fuente.widthOfTextAtSize(texto, size);
      const [cx, cy] = centroEn($("posNum").value, W, H, ancho, alto, 30);
      envolver(doc, p);
      p.drawText(texto, { ...colocar(L, p, cx, cy, ancho, alto, 0), size, font: fuente, color: L.rgb(0, 0, 0) });
    });
    const bytes = await doc.save();
    filaDescarga($("salidaNum"), bytes, sinExt(a.f.name) + " (numerado).pdf", `${paginasTxt(cuales.length)} con número, del ${primero} al ${ultimo}`);
    aviso("avisoNum", "Listo.");
    await mostrarPrevia("previaNum", bytes, cuales[0]);
  } catch (e) {
    aviso("avisoNum", String(e && e.message || e), true);
  } finally {
    $("botonNum").disabled = false;
  }
};

const pdfMarca = unPdf("Marca");
for (const r of document.querySelectorAll('input[name="tipoMarca"]')) r.onchange = () => {
  const imagen = document.querySelector('input[name="tipoMarca"]:checked').value === "imagen";
  $("marcaTexto").hidden = imagen; $("marcaImagen").hidden = !imagen;
};
async function imagenParaPdf(doc, f) {
  f = (await sinHeic([f]))[0];
  const bytes = new Uint8Array(await f.arrayBuffer());
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && orientacionJpeg(bytes) === 1) return await doc.embedJpg(bytes);
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return await doc.embedPng(bytes);
  } catch { /* imagen rara: se redibuja abajo */ }
  let mapa;
  try { mapa = await createImageBitmap(f); } catch { throw new Error(`«${f.name}» no se pudo abrir como imagen.`); }
  const lienzo = document.createElement("canvas");
  lienzo.width = mapa.width; lienzo.height = mapa.height;
  lienzo.getContext("2d").drawImage(mapa, 0, 0);
  mapa.close();
  const blob = await new Promise((ok) => lienzo.toBlob(ok, "image/png"));
  return doc.embedPng(new Uint8Array(await blob.arrayBuffer()));
}
$("botonMarca").onclick = async () => {
  const a = pdfMarca();
  if (!a) return;
  $("botonMarca").disabled = true;
  try {
    const cuales = enOrden($("paginasMarca").value, a.total);
    const conImagen = document.querySelector('input[name="tipoMarca"]:checked').value === "imagen";
    const texto = $("textoMarca").value.trim() || "CONFIDENCIAL", archivoImagen = $("imagenMarca").files[0];
    if (conImagen && !archivoImagen) throw new Error("Elige la imagen que va encima.");
    aviso("avisoMarca", "Poniendo la marca…");
    const L = await pdfLib(), doc = await abrirPdf(a.f);
    const pos = $("posMarca").value, opacity = Number($("opacidadMarca").value);
    const fuente = conImagen ? null : await doc.embedFont(L.StandardFonts.HelveticaBold);
    const imagen = conImagen ? await imagenParaPdf(doc, archivoImagen) : null;
    const color = L.rgb(...$("colorMarca").value.split(",").map(Number));
    if (fuente) medirTexto(fuente, texto, 10);
    for (const i of cuales) {
      const p = doc.getPage(i), [W, H] = tamVisible(p);
      const angulo = imagen ? 0 : pos === "diagonal" ? Math.atan2(H, W) * 180 / Math.PI : pos === "mosaico" ? 30 : 0;
      const largoMax = (pos === "diagonal" ? Math.hypot(W, H) : W) * 0.86;      // que no se salga de la hoja
      let ancho, alto, size = 0;
      if (imagen) {
        ancho = Math.min(W * Number($("anchoMarca").value), largoMax);
        alto = ancho * imagen.height / imagen.width;
        if (alto > H * 0.86) { ancho *= H * 0.86 / alto; alto = H * 0.86; }
      } else {
        size = Number($("letraMarca").value);
        if (pos === "mosaico") size = Math.min(size, 40);
        ancho = fuente.widthOfTextAtSize(texto, size);
        if (ancho > largoMax) { size *= largoMax / ancho; ancho = largoMax; }
        alto = size * 0.72;
      }
      const centros = [];
      if (pos === "mosaico") {
        const pasoX = ancho + Math.max(60, ancho * 0.4), pasoY = Math.max(alto * 2.2, ancho * 0.6, 110);
        for (let y = pasoY / 2, fila = 0; y < H + pasoY / 2; y += pasoY, fila++)
          for (let x = fila % 2 ? pasoX / 2 : 0; x < W + pasoX / 2; x += pasoX) centros.push([x, y]);
      } else if (pos === "centro" || pos === "diagonal") centros.push([W / 2, H / 2]);
      else centros.push(centroEn(pos, W, H, ancho, alto, 36));
      envolver(doc, p);
      for (const [cx, cy] of centros) {
        const donde = colocar(L, p, cx, cy, ancho, alto, angulo);
        if (imagen) p.drawImage(imagen, { ...donde, width: ancho, height: alto, opacity });
        else p.drawText(texto, { ...donde, size, font: fuente, color, opacity });
      }
    }
    const bytes = await doc.save();
    filaDescarga($("salidaMarca"), bytes, sinExt(a.f.name) + " (con marca).pdf", `Marca en ${paginasTxt(cuales.length)}`);
    aviso("avisoMarca", "Listo. Puedes cambiar las opciones y probar otra vez.");
    await mostrarPrevia("previaMarca", bytes, cuales[0]);
  } catch (e) {
    aviso("avisoMarca", String(e && e.message || e), true);
  } finally {
    $("botonMarca").disabled = false;
  }
};

// ---------------------------------------------------------------- 13. proteger y quitar contraseña
// pdf-lib no cifra, así que esto lo hace qpdf (el programa de siempre, compilado para el navegador).
// Cada operación usa una copia nueva de qpdf: es un programa de consola y termina al acabar.
let _qpdf = null;
function qpdfListo() {
  return _qpdf ||= new Promise((ok, mal) => {
    const s = document.createElement("script");
    s.src = new URL("lib/qpdf.js", base).href;
    s.onload = () => ok(window.Module);
    s.onerror = () => { _qpdf = null; mal(new Error("No se pudo cargar la herramienta de contraseñas. Revisa tu internet.")); };
    document.head.append(s);
  });
}
// Corre qpdf con el PDF en /in.pdf; devuelve el código de salida, lo que dijo y, si lo hubo, /out.pdf
async function qpdf(args, entrada) {
  const crear = await qpdfListo();
  // qpdf escribe sus mensajes en la consola, y la toma en el momento de crearse: ahí se le pasa una lista
  const dicho = [], { log, error } = console;
  let creando;
  console.log = console.error = (x) => dicho.push(String(x));
  try { creando = crear({ locateFile: () => new URL("lib/qpdf.wasm", base).href }); }
  finally { console.log = log; console.error = error; }
  const m = await creando;
  m.FS.writeFile("/in.pdf", entrada);
  let codigo;
  try { codigo = m.callMain(args); }
  catch (e) { codigo = e && typeof e.status === "number" ? e.status : 2; }
  let salida = null;
  if (codigo === 0 || codigo === 3) try { salida = m.FS.readFile("/out.pdf"); } catch {}
  return { codigo, salida, dicho, malaClave: codigo === 2 && /invalid password/i.test(dicho.join("\n")) };
}
// 0 = pide contraseña (o la que se dio no es), 2 = no está protegido, 3 = protegido pero abre sin contraseña
async function pideClave(bytes, clave = "") {
  const r = await qpdf(["--password=" + clave, "--requires-password", "/in.pdf"], bytes);
  return r.malaClave ? 0 : r.codigo;
}
const pintar = () => new Promise((r) => setTimeout(r, 30));    // qpdf ocupa la página mientras trabaja: antes se deja ver el aviso
function unPdfConClave(s, alAbrir) {      // s = "Prot" o "Quitar"; alAbrir(estado, f) devuelve el texto de error o nada
  let actual = null;
  zonaDeArchivos($("zona" + s), $("archivo" + s), async (fs) => {
    const f = fs.find(esPdf);
    actual = null;
    $("opciones" + s).hidden = true;
    aviso("aviso" + s, "");
    if (!f) { $("info" + s).textContent = "Ese archivo no es un PDF."; return; }
    $("info" + s).textContent = "Abriendo…";
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      if (!new TextDecoder("latin1").decode(bytes.subarray(0, 1024)).includes("%PDF-")) throw new Error(`«${f.name}» no se pudo leer como PDF.`);
      const estado = await pideClave(bytes);
      const error = alAbrir(estado, f);
      if (error) throw new Error(error);
      actual = { f, bytes, estado };
      $("info" + s).textContent = `${f.name} · ${tamTxt(bytes.length)}`;
      $("opciones" + s).hidden = false;
    } catch (e) {
      $("info" + s).textContent = String(e && e.message || e);
    }
  });
  return () => actual;
}
function verClaves(casilla, ...campos) {
  $(casilla).onchange = () => { for (const c of campos) $(c).type = $(casilla).checked ? "text" : "password"; };
}

const pdfProt = unPdfConClave("Prot", (estado, f) =>
  estado !== 2 ? `«${f.name}» ya está protegido. Para cambiarle la contraseña, primero quítasela con «Quitar contraseña».` : "");
verClaves("verProt", "claveProt", "clave2Prot");
$("botonProt").onclick = async () => {
  const a = pdfProt();
  if (!a) return;
  const clave = $("claveProt").value;
  if (!clave) return aviso("avisoProt", "Escribe una contraseña.", true);
  if (clave !== $("clave2Prot").value) return aviso("avisoProt", "Las dos contraseñas no son iguales.", true);
  $("botonProt").disabled = true;
  try {
    aviso("avisoProt", "Protegiendo…");
    await pintar();
    const r = await qpdf(["--encrypt", "--user-password=" + clave, "--owner-password=" + clave, "--bits=256", "--", "/in.pdf", "/out.pdf"], a.bytes);
    if (!r.salida) throw new Error(`«${a.f.name}» no se pudo proteger; puede estar dañado.`);
    filaDescarga($("salidaProt"), r.salida, sinExt(a.f.name) + " (protegido).pdf", "Pide contraseña al abrirlo");
    aviso("avisoProt", "Listo. Prueba abrirlo antes de borrar el original.");
  } catch (e) {
    aviso("avisoProt", String(e && e.message || e), true);
  } finally {
    $("botonProt").disabled = false;
  }
};

const pdfQuitar = unPdfConClave("Quitar", (estado, f) => {
  if (estado === 2) return `«${f.name}» no tiene contraseña ni restricciones: no hay nada que quitar.`;
  const pide = estado === 0;
  $("campoQuitar").hidden = $("verCampoQuitar").hidden = !pide;
  $("claveQuitar").value = "";
  $("botonQuitar").textContent = pide ? "Quitar contraseña" : "Quitar restricciones";
  if (!pide) aviso("avisoQuitar", "Este PDF abre sin contraseña, pero tiene restricciones (imprimir, copiar o modificar).");
});
verClaves("verQuitar", "claveQuitar");
$("botonQuitar").onclick = async () => {
  const a = pdfQuitar();
  if (!a) return;
  const clave = a.estado === 0 ? $("claveQuitar").value : "";
  if (a.estado === 0 && !clave) return aviso("avisoQuitar", "Escribe la contraseña del PDF.", true);
  $("botonQuitar").disabled = true;
  try {
    aviso("avisoQuitar", "Quitando…");
    await pintar();
    const r = await qpdf(["--password=" + clave, "--decrypt", "/in.pdf", "/out.pdf"], a.bytes);
    if (!r.salida) {
      if (r.malaClave) throw new Error("Esa no es la contraseña de este PDF.");
      throw new Error(`«${a.f.name}» no se pudo desbloquear; puede estar dañado.`);
    }
    filaDescarga($("salidaQuitar"), r.salida, sinExt(a.f.name).replace(/ \(protegido\)$/, "") + " (sin contraseña).pdf", a.estado === 0 ? "Ya abre sin contraseña" : "Ya sin restricciones");
    aviso("avisoQuitar", "Listo.");
  } catch (e) {
    aviso("avisoQuitar", String(e && e.message || e), true);
  } finally {
    $("botonQuitar").disabled = false;
  }
};

// ---------------------------------------------------------------- 14. reconocer texto (OCR)
// Tesseract lee cada página (dibujada con PDF.js) y dice dónde está cada palabra. El PDF original no
// se toca: solo se le escribe encima el mismo texto, invisible, para poder buscarlo y copiarlo.
const esImagen = (f) => /^image\/(jpeg|png|webp)$/.test(f.type) || /\.(jpe?g|png|webp)$/i.test(f.name);
let _tess = null;
function tesseractListo() {
  return _tess ||= new Promise((ok, mal) => {
    const s = document.createElement("script");
    s.src = new URL("ocr/tesseract.min.js", base).href;
    s.onload = () => ok(window.Tesseract);
    s.onerror = () => { _tess = null; mal(new Error("No se pudo cargar el lector de texto. Revisa tu internet.")); };
    document.head.append(s);
  });
}
async function lectorOcr(idioma, alAvanzar) {
  const T = await tesseractListo(), carpeta = new URL("ocr", base).href;
  try {
    return await T.createWorker(idioma, 1, {
      workerPath: carpeta + "/worker.min.js", corePath: carpeta, langPath: carpeta,
      workerBlobURL: false, cacheMethod: "none", gzip: true,
      logger: (m) => { if (m.status === "recognizing text") alAvanzar(m.progress); },
      errorHandler: () => {},
    });
  } catch { throw new Error("No se pudo preparar el lector de texto. Revisa tu internet e intenta otra vez."); }
}
// Varias fotos → un PDF con una foto por hoja (el lado largo mide como una hoja carta)
async function pdfDeImagenes(fs) {
  const { PDFDocument } = await pdfLib(), doc = await PDFDocument.create();
  for (const f of fs) {
    const img = await imagenParaPdf(doc, f), k = 792 / Math.max(img.width, img.height);
    doc.addPage([img.width * k, img.height * k]).drawImage(img, { x: 0, y: 0, width: img.width * k, height: img.height * k });
  }
  return doc.save();
}
// Lee las páginas «cuales» → por cada una { texto, palabras, esc } (palabras = null si ya traía texto)
async function leerPaginas(bytes, cuales, idioma, avance) {
  const pdfjs = await pdfJs();
  const vista = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  const cuantos = Math.min(cuales.length, navigator.hardwareConcurrency >= 4 ? 2 : 1);
  const partes = new Array(cuantos).fill(0), paginas = new Array(cuales.length);
  let sigue = 0, hechas = 0;
  const avisar = () => avance(Math.min(cuales.length, hechas + partes.reduce((s, x) => s + x, 0)), cuales.length);
  const lectores = [];
  try {
    avance(-1);
    for (let n = 0; n < cuantos; n++) lectores.push(await lectorOcr(idioma, (x) => { partes[n] = x; avisar(); }));
    avisar();
    await Promise.all(lectores.map(async (lector, n) => {
      for (let k; (k = sigue++) < cuales.length;) {
        const pagina = await vista.getPage(cuales[k] + 1);
        const propio = (await pagina.getTextContent()).items.map((x) => x.str + (x.hasEOL ? "\n" : " ")).join("").trim();
        // Algunos PDF traen texto con la codificación rota («&02!08'$102+#!»): se ve bien pero al copiar
        // sale basura. Texto de verdad es casi todo letras (≥ 80 %); si no llega al 60 %, se lee con OCR
        const lleno = propio.replace(/\s/g, ""), letrasPropias = (lleno.match(/\p{L}/gu) || []).length;
        if (lleno.length > 30 && letrasPropias >= 0.6 * lleno.length) paginas[k] = { texto: propio, palabras: null };
        else {
          const b = pagina.getViewport({ scale: 1 });
          const esc = Math.min(200 / 72, 3000 / Math.max(b.width, b.height));
          const v = pagina.getViewport({ scale: esc });
          const lienzo = document.createElement("canvas");
          lienzo.width = Math.round(v.width); lienzo.height = Math.round(v.height);
          await pagina.render({ canvasContext: lienzo.getContext("2d"), viewport: v }).promise;
          const { data } = await lector.recognize(lienzo, {}, { text: true, blocks: true });
          // Si traía texto roto, la hoja se cambiará por su imagen (así ya no se copia la basura)
          const foto = lleno.length > 30 ? new Uint8Array(await (await new Promise((ok) => lienzo.toBlob(ok, "image/jpeg", 0.8))).arrayBuffer()) : null;
          lienzo.width = lienzo.height = 0;
          // Solo cuentan las palabras de las que el lector está seguro (en texto de verdad pasa de 90;
          // en fotos y manchas «ve» letras sueltas con 0 a 80), y una hoja sin tres palabras
          // de verdad se toma como hoja sin texto
          const letras = (w) => (w.text.match(/[\p{L}\p{N}]/gu) || []).length;
          const palabras = [], parrafos = [];
          for (const bl of data.blocks || []) for (const pa of bl.paragraphs) {
            const renglones = [];
            for (const li of pa.lines) {
              const buenas = li.words.filter((w) => w.text.trim() && (w.confidence >= 75 || (w.confidence >= 50 && letras(w) >= 4)));
              palabras.push(...buenas);
              if (buenas.length) renglones.push(buenas.map((w) => w.text).join(" "));
            }
            if (renglones.length) parrafos.push(renglones.join("\n"));
          }
          const hay = palabras.filter((w) => letras(w) >= 3).length >= 3;
          paginas[k] = { texto: hay ? parrafos.join("\n\n") : "", palabras: hay ? palabras : [], esc, foto: hay ? foto : null };
        }
        pagina.cleanup();
        partes[n] = 0; hechas++; avisar();
      }
    }));
    return paginas;
  } finally {
    for (const l of lectores) l.terminate().catch(() => {});
    vista.destroy();
  }
}
// Escribe las palabras, invisibles, en su lugar: cada una del ancho que ocupa en la hoja
function capaDeTexto(L, doc, fuente, p, palabras, esc) {
  const c = p.getCropBox(), r = giroDe(p), [, H] = tamVisible(p);
  const t = r * Math.PI / 180, co = Math.round(Math.cos(t)), se = Math.round(Math.sin(t));
  const ops = [L.pushGraphicsState(), L.beginText(), L.setTextRenderingMode(L.TextRenderingMode.Invisible)];
  let clave = null;
  for (const w of palabras) {
    const texto = [...w.text].filter((ch) => { try { fuente.encodeText(ch); return true; } catch { return false; } }).join("").trim();
    const ancho = (w.bbox.x1 - w.bbox.x0) / esc;
    if (!texto || !(ancho > 0)) continue;
    const size = Math.min(300, Math.max(1, ancho / fuente.widthOfTextAtSize(texto, 1)));
    const vx = w.bbox.x0 / esc, vy = H - (w.baseline && w.baseline.y0 > 0 ? Math.max(w.baseline.y0, w.baseline.y1) : w.bbox.y1) / esc;
    const [x, y] = r === 90 ? [c.x + c.width - vy, c.y + vx] : r === 180 ? [c.x + c.width - vx, c.y + c.height - vy]
      : r === 270 ? [c.x + vy, c.y + c.height - vx] : [c.x + vx, c.y + vy];
    clave ||= p.node.newFontDictionary("OCR", fuente.ref);
    ops.push(L.setFontAndSize(clave, size), L.setTextMatrix(co, se, -se, co, x, y), L.showText(fuente.encodeText(texto + " ")));
  }
  if (!clave) return 0;
  envolver(doc, p);
  p.pushOperators(...ops, L.endText(), L.popGraphicsState());
  return 1;
}

// ---------------------------------------------------------------- 14b. reparar el texto roto
// Hay PDF (p. ej. los que hacía Mac OS X 10.5) cuyas fuentes no dicen qué letra es cada código: se ven
// bien, pero al copiar sale basura. Cada dibujo de letra se repite miles de veces, así que basta leer
// con OCR unas cuantas hojas para saber qué letra es cada dibujo y escribir esa tabla (ToUnicode) en
// las fuentes. Las hojas quedan iguales y todo el libro se puede copiar, sin leerlo completo.
// Huella de 64 bits (dos FNV-1a de 32) de una lista de bytes/números
function huella(arr) {
  let a = 0x811c9dc5, b = 0x050c5d1f;
  for (let i = 0; i < arr.length; i++) { const x = arr[i] & 0xff; a = Math.imul(a ^ x, 16777619); b = Math.imul(b ^ x, 16777619) ^ (b >>> 13); }
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}
// Lee una fuente TrueType incrustada → código (0-255) → huella del dibujo y su ancho ("" = dibujo vacío, es espacio)
function dibujosTrueType(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), u16 = (o) => dv.getUint16(o), u32 = (o) => dv.getUint32(o);
  const t = {}, n = u16(4);
  for (let i = 0; i < n; i++) { const o = 12 + 16 * i; t[String.fromCharCode(...bytes.subarray(o, o + 4))] = { o: u32(o + 8), l: u32(o + 12) }; }
  if (!t.cmap || !t.glyf || !t.loca || !t.head) return null;
  const largo = u16(t.head.o + 50), nGlifos = t.maxp ? u16(t.maxp.o + 4) : 65535;
  const loca = (g) => largo ? u32(t.loca.o + 4 * g) : 2 * u16(t.loca.o + 2 * g);
  const nMet = t.hhea ? u16(t.hhea.o + 34) : 0;
  const ancho = (g) => !t.hmtx || !nMet ? 0 : u16(t.hmtx.o + 4 * Math.min(g, nMet - 1));
  // Las tablas cmap: (1,0) y (3,0)/(3,1), formatos 0, 4 y 6
  const tablas = [];
  for (let i = 0, k = u16(t.cmap.o + 2); i < k; i++) {
    const o = t.cmap.o + 4 + 8 * i, pl = u16(o), en = u16(o + 2), off = t.cmap.o + u32(o + 4);
    tablas.push({ pl, en, off, f: u16(off) });
  }
  const buscar = (tb, c) => {
    const o = tb.off;
    if (tb.f === 0) return c < 256 ? bytes[o + 6 + c] : 0;
    if (tb.f === 6) { const pri = u16(o + 6), cu = u16(o + 8); return c >= pri && c < pri + cu ? u16(o + 10 + 2 * (c - pri)) : 0; }
    if (tb.f === 4) {
      const seg = u16(o + 6) / 2, fin = o + 14, ini = fin + 2 * seg + 2, del = ini + 2 * seg, ran = del + 2 * seg;
      for (let s = 0; s < seg; s++) {
        if (c > u16(fin + 2 * s)) continue;
        if (c < u16(ini + 2 * s)) return 0;
        const r = u16(ran + 2 * s);
        if (!r) return (c + dv.getInt16(del + 2 * s)) & 0xffff;
        const g = u16(ran + 2 * s + r + 2 * (c - u16(ini + 2 * s)));
        return g ? (g + dv.getInt16(del + 2 * s)) & 0xffff : 0;
      }
    }
    return 0;
  };
  const glifoDe = (c) => {
    for (const tb of tablas) {
      const g = tb.pl === 1 ? buscar(tb, c) : tb.pl === 3 ? buscar(tb, c) || buscar(tb, 0xf000 | c) : 0;
      if (g && g < nGlifos) return g;
    }
    return 0;
  };
  const memo = new Map();
  const forma = (g, prof = 0) => {
    if (memo.has(g)) return memo.get(g);
    const a = loca(g), b = loca(g + 1);
    let h;
    if (b <= a) h = "";
    else if (dv.getInt16(t.glyf.o + a) >= 0) h = huella(bytes.subarray(t.glyf.o + a, t.glyf.o + b));
    else {      // compuesto (letras con acento): cada parte por su propia huella, no por su número
      const partes = [];
      let o = t.glyf.o + a + 10, fl;
      do {
        fl = u16(o); const gi = u16(o + 2);
        let l = 4 + (fl & 1 ? 4 : 2) + (fl & 8 ? 2 : fl & 0x40 ? 4 : fl & 0x80 ? 8 : 0);
        partes.push(fl & 0xffef, prof < 8 ? forma(gi, prof + 1) : gi, ...bytes.subarray(o + 4, o + l));
        o += l;
      } while (fl & 0x20 && o < t.glyf.o + b);
      h = "c" + huella(new TextEncoder().encode(partes.join(",")));
    }
    memo.set(g, h);
    return h;
  };
  const res = new Map();
  for (let c = 0; c < 256; c++) { const g = glifoDe(c); if (g) res.set(c, forma(g) === "" ? "" : forma(g) + "/" + ancho(g)); }
  return res;
}
// Fuentes con el texto roto: TrueType simples con su archivo incrustado y un ToUnicode vacío
function fuentesRotas(L, doc) {
  const { PDFName, PDFDict, PDFRawStream, decodePDFRawStream } = L, rotas = new Map(), vistas = new Set();
  const flujo = (s) => s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s.getContents ? s.getContents() : null;
  for (const p of doc.getPages()) {
    const fs = p.node.Resources()?.lookupMaybe(PDFName.of("Font"), PDFDict);
    if (!fs) continue;
    for (const [, ref] of fs.entries()) {
      const k = String(ref);
      if (vistas.has(k)) continue;
      vistas.add(k);
      try {
        const f = doc.context.lookup(ref, PDFDict);
        if (String(f.get(PDFName.of("Subtype"))) !== "/TrueType") continue;
        const tu = f.lookup(PDFName.of("ToUnicode"));
        if (tu && /bf(char|range)/.test(new TextDecoder("latin1").decode(flujo(tu)))) continue;
        const ff = f.lookup(PDFName.of("FontDescriptor"))?.lookup(PDFName.of("FontFile2"));
        const dib = ff && dibujosTrueType(flujo(ff));
        if (dib && dib.size) rotas.set(k, { dict: f, dib });
      } catch {}
    }
  }
  return rotas;
}
// Lee el contenido de una hoja → trozos de texto { x, y, letras: [huella] } en coordenadas de la hoja
function trozosDeTexto(L, doc, p, rotas) {
  const { PDFName, PDFDict, PDFArray, PDFRawStream, decodePDFRawStream } = L;
  const fs = p.node.Resources()?.lookupMaybe(PDFName.of("Font"), PDFDict), nombres = new Map();
  if (fs) for (const [n, ref] of fs.entries()) nombres.set(n.asString().replace(/^\//, ""), String(ref));
  let cont = p.node.Contents(), partes = [];
  if (cont instanceof PDFArray) for (let i = 0; i < cont.size(); i++) partes.push(cont.lookup(i));
  else if (cont) partes.push(cont);
  const trozos = [];
  for (const s of partes) {
    const b = s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s.getContents();
    leerFlujo(b, trozos, nombres, rotas);
  }
  return trozos;
}
const mult = (m, n) => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3], m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];
function leerFlujo(b, trozos, nombres, rotas) {
  const n = b.length, pila = [], ops = [];
  let ctm = [1, 0, 0, 1, 0, 0], tm = ctm, tlm = ctm, tl = 0, fuente = null, i = 0;
  const cadena = () => {        // (…) con escapes → bytes
    const r = []; let nivel = 1; i++;
    while (i < n) {
      let c = b[i++];
      if (c === 92) {
        c = b[i++];
        if (c >= 48 && c <= 55) { let v = c - 48; for (let k = 0; k < 2 && b[i] >= 48 && b[i] <= 55; k++) v = v * 8 + b[i++] - 48; r.push(v & 255); }
        else if (c === 110) r.push(10); else if (c === 114) r.push(13); else if (c === 116) r.push(9);
        else if (c === 98) r.push(8); else if (c === 102) r.push(12);
        else if (c === 13) { if (b[i] === 10) i++; } else if (c !== 10) r.push(c);
      } else if (c === 40) { nivel++; r.push(c); }
      else if (c === 41) { if (!--nivel) break; r.push(c); }
      else r.push(c);
    }
    return { s: r };
  };
  const mostrar = (cods) => {
    if (!fuente) return;
    const m = mult(tm, ctm);
    trozos.push({ x: m[4], y: m[5], letras: cods.map((c) => fuente.dib.get(c) ?? "?" + c) });
  };
  const delim = (c) => c <= 32 || "()<>[]{}/%".includes(String.fromCharCode(c));
  while (i < n) {
    const c = b[i];
    if (c <= 32) { i++; continue; }
    if (c === 37) { while (i < n && b[i] !== 10 && b[i] !== 13) i++; continue; }
    if (c === 40) { ops.push(cadena()); continue; }
    if (c === 60 && b[i + 1] !== 60) {
      let j = i + 1, h = ""; while (j < n && b[j] !== 62) { if (b[j] > 32) h += String.fromCharCode(b[j]); j++; }
      i = j + 1; if (h.length % 2) h += "0";
      ops.push({ s: Array.from({ length: h.length / 2 }, (_, k) => parseInt(h.substr(2 * k, 2), 16)) }); continue;
    }
    if (c === 60 || c === 62) { i += 2; ops.push({ d: 1 }); continue; }
    if (c === 91) { i++; ops.push({ abre: 1 }); continue; }
    if (c === 93) {
      i++; const arr = []; let x;
      while (ops.length && !(x = ops.pop()).abre) arr.unshift(x);
      ops.push({ arr }); continue;
    }
    let j = i + 1;
    if (c === 47) { while (j < n && !delim(b[j])) j++; ops.push({ nom: String.fromCharCode(...b.subarray(i + 1, j)) }); i = j; continue; }
    while (j < n && !delim(b[j])) j++;
    const w = String.fromCharCode(...b.subarray(i, j)); i = j;
    const num = Number(w);
    if (w !== "" && !Number.isNaN(num)) { ops.push(num); continue; }
    // un operador
    const nums = (k) => ops.slice(-k);
    switch (w) {
      case "q": pila.push(ctm); break;
      case "Q": ctm = pila.pop() || [1, 0, 0, 1, 0, 0]; break;
      case "cm": ctm = mult(nums(6), ctm); break;
      case "BT": tm = tlm = [1, 0, 0, 1, 0, 0]; break;
      case "Tm": tm = tlm = nums(6); break;
      case "Td": tm = tlm = mult([1, 0, 0, 1, ...nums(2)], tlm); break;
      case "TD": { const [x, y] = nums(2); tl = -y; tm = tlm = mult([1, 0, 0, 1, x, y], tlm); break; }
      case "TL": tl = ops[ops.length - 1]; break;
      case "T*": tm = tlm = mult([1, 0, 0, 1, 0, -tl], tlm); break;
      case "Tf": { const o = ops[ops.length - 2]; fuente = o && o.nom ? rotas.get(nombres.get(o.nom)) || null : null; break; }
      case "Tj": case "'": case '"': {
        if (w !== "Tj") tm = tlm = mult([1, 0, 0, 1, 0, -tl], tlm);
        const o = ops[ops.length - 1]; if (o && o.s) mostrar(o.s); break;
      }
      case "TJ": { const o = ops[ops.length - 1]; if (o && o.arr) mostrar(o.arr.flatMap((x) => x.s || [])); break; }
      case "ID": { while (i < n - 2 && !(b[i] === 69 && b[i + 1] === 73 && delim(b[i + 2]) && delim(b[i - 1]))) i++; i += 2; break; }
    }
    ops.length = 0;
  }
}
// Empata los renglones que leyó el OCR con los trozos de texto de la hoja y anota votos huella → letra
function votarHoja(trozos, vista, data, votos) {
  const pts = trozos.map((t) => { const [x, y] = vista.convertToViewportPoint(t.x, t.y); return { x, y, l: t.letras }; });
  let renglones = 0, usados = 0;
  for (const bl of data.blocks || []) for (const pa of bl.paragraphs) for (const li of pa.lines) {
    renglones++;
    const h = li.bbox.y1 - li.bbox.y0, base = li.baseline && li.baseline.y0 > 0 ? (li.baseline.y0 + li.baseline.y1) / 2 : li.bbox.y1;
    const mios = pts.filter((t) => Math.abs(t.y - base) < 0.35 * h && t.x > li.bbox.x0 - h && t.x < li.bbox.x1 + h / 2).sort((a, b) => a.x - b.x);
    const seq = [];
    for (const t of mios) for (const k of t.l) if (k !== "" || (seq.length && seq[seq.length - 1] !== "")) seq.push(k);
    while (seq.length && seq[seq.length - 1] === "") seq.pop();
    const txt = [...li.words.map((w) => w.text).join(" ")];
    if (seq.length !== txt.length || !seq.length) continue;
    if (seq.some((k, i) => (k === "") !== (txt[i] === " "))) continue;
    usados++;
    seq.forEach((k, i) => { if (k) { const v = votos.get(k) || new Map(); v.set(txt[i], (v.get(txt[i]) || 0) + 1); votos.set(k, v); } });
  }
  return { renglones, usados };
}
function letraDe(v, estricto) {
  if (!v) return null;
  let top = null, n = 0, suma = 0;
  for (const [c, k] of v) { suma += k; if (k > n) { n = k; top = c; } }
  return estricto ? (n >= 2 && n >= 0.8 * suma ? top : null) : (n >= 0.6 * suma ? top : null);
}

// Aprende las letras leyendo con OCR las hojas que más dibujos nuevos traen → PDF reparado (o null)
async function repararTexto(bytes, cuales, idioma, avance) {
  const L = await pdfLib(), doc = await L.PDFDocument.load(bytes);
  const rotas = fuentesRotas(L, doc);
  if (!rotas.size) return null;
  const pags = doc.getPages(), cuenta = new Map(), clavesHoja = new Map();
  for (const i of cuales) {
    const s = new Set();
    for (const t of trozosDeTexto(L, doc, pags[i], rotas)) for (const k of t.letras) if (k) { s.add(k); cuenta.set(k, (cuenta.get(k) || 0) + 1); }
    if (s.size) clavesHoja.set(i, s);
  }
  if (!clavesHoja.size) return null;
  const votos = new Map(), intentos = new Map(), hechas = new Set();
  const sabe = (k) => letraDe(votos.get(k), true) !== null;
  const avanzo = (relajado) => {
    let si = 0, todas = 0;
    for (const [k, n] of cuenta) { todas += n; if (relajado ? letraDe(votos.get(k), false) !== null : sabe(k)) si += n; }
    return si / todas;
  };
  // La hoja con más dibujos que aún no se saben (cada dibujo se intenta en 3 hojas como mucho:
  // el griego o el hebreo, por ejemplo, no los lee el OCR en español)
  const elegir = () => {
    let mejor = -1, pts = 0;
    for (const [i, s] of clavesHoja) {
      if (hechas.has(i)) continue;
      let n = 0;
      for (const k of s) if (!sabe(k) && (intentos.get(k) || 0) < 3) n++;
      if (n > pts) { pts = n; mejor = i; }
    }
    if (mejor >= 0) { hechas.add(mejor); for (const k of clavesHoja.get(mejor)) if (!sabe(k)) intentos.set(k, (intentos.get(k) || 0) + 1); }
    return mejor;
  };
  const pdfjs = await pdfJs(), vista = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  const lectores = [];
  let muestras = 0;
  try {
    const cuantos = navigator.hardwareConcurrency >= 4 ? 2 : 1;
    for (let n = 0; n < cuantos; n++) lectores.push(await lectorOcr(idioma, () => {}));
    avance(0, 0);
    await Promise.all(lectores.map(async (lector) => {
      for (let i; (i = elegir()) >= 0;) {
        const pagina = await vista.getPage(i + 1), b = pagina.getViewport({ scale: 1 });
        const v = pagina.getViewport({ scale: Math.min(200 / 72, 3000 / Math.max(b.width, b.height)) });
        const lienzo = document.createElement("canvas");
        lienzo.width = Math.round(v.width); lienzo.height = Math.round(v.height);
        await pagina.render({ canvasContext: lienzo.getContext("2d"), viewport: v }).promise;
        const { data } = await lector.recognize(lienzo, {}, { blocks: true });
        lienzo.width = lienzo.height = 0;
        votarHoja(trozosDeTexto(L, doc, pags[i], rotas), v, data, votos);
        pagina.cleanup();
        avance(avanzo(false), ++muestras);
      }
    }));
  } finally {
    for (const l of lectores) l.terminate().catch(() => {});
    vista.destroy();
  }
  const cobertura = avanzo(true);
  if (!cobertura) return null;
  // La tabla código → letra de cada fuente rota (en bloques de 100, como pide el formato)
  const hex = (n) => n.toString(16).toUpperCase().padStart(2, "0");
  for (const f of rotas.values()) {
    const pares = [];
    for (const [c, k] of f.dib) {
      const ch = k === "" ? " " : letraDe(votos.get(k), false);
      if (ch) pares.push(`<${hex(c)}> <${Array.from(ch, (_, j) => ch.charCodeAt(j).toString(16).toUpperCase().padStart(4, "0")).join("")}>`);
    }
    if (!pares.some((x) => !x.endsWith("<0020>"))) continue;
    let cmap = "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n"
      + "/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<00> <FF>\nendcodespacerange\n";
    for (let j = 0; j < pares.length; j += 100) {
      const t = pares.slice(j, j + 100);
      cmap += `${t.length} beginbfchar\n${t.join("\n")}\nendbfchar\n`;
    }
    cmap += "endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n";
    f.dict.set(L.PDFName.of("ToUnicode"), doc.context.register(doc.context.flateStream(cmap)));
  }
  return { bytes: await doc.save(), muestras, cobertura };
}

let paraOcr = null;      // { nombre, bytes, total, fotos }
zonaDeArchivos($("zonaOcr"), $("archivosOcr"), async (fs) => {
  const pdf = fs.find(esPdf), fotos = fs.filter(esImagen);
  paraOcr = null;
  $("opcionesOcr").hidden = true;
  aviso("avisoOcr", "");
  if (!pdf && !fotos.length) { $("infoOcr").textContent = "Elige un PDF o fotos (JPG, PNG o WebP)."; return; }
  $("infoOcr").textContent = "Abriendo…";
  try {
    if (pdf) {
      const doc = await abrirPdf(pdf);
      paraOcr = { nombre: sinExt(pdf.name), bytes: new Uint8Array(await pdf.arrayBuffer()), total: doc.getPageCount(), fotos: false };
      $("infoOcr").textContent = `${pdf.name} · ${paginasTxt(paraOcr.total)}`;
    } else {
      paraOcr = { nombre: fotos[0].name.replace(/\.[^.]+$/, ""), bytes: await pdfDeImagenes(fotos), total: fotos.length, fotos: true };
      $("infoOcr").textContent = fotos.length === 1 ? fotos[0].name : `${fotos.length} fotos, una por página`;
    }
    $("campoPaginasOcr").hidden = paraOcr.fotos;
    $("paginasOcr").value = "";
    $("opcionesOcr").hidden = false;
  } catch (e) {
    paraOcr = null;
    $("infoOcr").textContent = String(e && e.message || e);
  }
});
$("botonOcr").onclick = async () => {
  const a = paraOcr;
  if (!a) return;
  $("botonOcr").disabled = true;
  try {
    const cuales = enOrden(a.fotos ? "" : $("paginasOcr").value, a.total);
    aviso("avisoOcr", "Preparando el lector de texto (la primera vez tarda: baja unos 9 MB)…");
    // Si las fuentes traen el texto roto, primero se reparan (basta leer unas cuantas hojas)
    const reparo = a.fotos ? null : await repararTexto(a.bytes, cuales, $("idiomaOcr").value, (parte, hojas) =>
      hojas && aviso("avisoOcr", `El texto de este PDF viene roto; aprendiendo sus letras (${hojas === 1 ? "1 hoja leída" : hojas + " hojas leídas"})… ${Math.floor(parte * 100)} %`));
    const bytes = reparo ? reparo.bytes : a.bytes;
    if (reparo) aviso("avisoOcr", "Revisando las hojas…");
    const paginas = await leerPaginas(bytes, cuales, $("idiomaOcr").value, (hechas, total) =>
      aviso("avisoOcr", hechas < 0 ? $("avisoOcr").textContent
        : total === 1 ? `Leyendo… ${Math.round(hechas * 100)} %` : `Leyendo ${paginasTxt(total)}… ${Math.floor(hechas * 100 / total)} %`));
    aviso("avisoOcr", "Armando el PDF…");
    const L = await pdfLib(), doc = await L.PDFDocument.load(bytes);
    const fuente = await doc.embedFont(L.StandardFonts.Helvetica);
    let leidas = 0, yaTenian = 0, cambiadas = 0;
    for (const [k, x] of paginas.entries()) {
      if (!x.palabras) { yaTenian++; continue; }
      let p = doc.getPage(cuales[k]);
      if (x.foto) {
        // Hoja con texto roto: se pone en su lugar una hoja nueva con la imagen de cómo se veía
        const [W, H] = tamVisible(p), img = await doc.embedJpg(x.foto);
        p = doc.insertPage(cuales[k], [W, H]);
        p.drawImage(img, { x: 0, y: 0, width: W, height: H });
        doc.removePage(cuales[k] + 1);
        cambiadas++;
      }
      leidas += capaDeTexto(L, doc, fuente, p, x.palabras, x.esc);
    }
    const texto = paginas.map((x) => x.texto).filter(Boolean).join("\n\n");
    if (!leidas && !yaTenian) throw new Error("No se encontró texto. Revisa que la hoja esté derecha y se lea bien.");
    const sinTexto = paginas.length - leidas - yaTenian;
    if (!leidas && !reparo) aviso("avisoOcr", "Este PDF ya tenía texto que se puede buscar y copiar; no hizo falta leerlo. Abajo queda el texto.");
    else {
      const datos = [];
      if (reparo) datos.push(`Texto reparado (se leyeron ${paginasTxt(reparo.muestras)} de muestra)`
        + (reparo.cobertura < 0.995 ? `; ${Math.max(1, Math.round((1 - reparo.cobertura) * 100))} % de las letras no se pudo leer (p. ej. griego o hebreo) y quedó como estaba` : ""));
      if (leidas) datos.push(`Texto reconocido en ${paginasTxt(leidas)}`);
      if (yaTenian && !reparo) datos.push(yaTenian === 1 ? "1 ya lo tenía" : yaTenian + " ya lo tenían");
      if (sinTexto) datos.push(`${sinTexto} sin texto`);
      if (cambiadas) datos.push(`${cambiadas === 1 ? "1 traía texto roto y se cambió" : cambiadas + " traían texto roto y se cambiaron"} por su imagen`);
      filaDescarga($("salidaOcr"), leidas ? await doc.save() : bytes, a.nombre + " (con texto).pdf", datos.join("; "));
      aviso("avisoOcr", "Listo.");
    }
    filaDescarga($("salidaOcr"), new TextEncoder().encode(texto.replace(/\n/g, "\r\n") + "\r\n"), a.nombre + ".txt", "Solo el texto", "text/plain;charset=utf-8");
  } catch (e) {
    aviso("avisoOcr", String(e && e.message || e), true);
  } finally {
    $("botonOcr").disabled = false;
  }
};

// ---------------------------------------------------------------- 15. firmar PDF
// La firma es un PNG con fondo transparente (dibujado aquí o sacado de una foto). PDF.js muestra la
// hoja; cada firma puesta guarda su lugar como fracción de la hoja visible (x, y de su esquina de
// arriba a la izquierda y w de ancho), y pdf-lib la dibuja ahí con colocar().
const entre = (v, a, b) => Math.min(Math.max(v, a), b);
// Deja solo la parte del lienzo que tiene tinta (con un margen chico); null si está vacío
function recortar(lienzo, umbral = 0) {
  const { width: W, height: H } = lienzo, d = lienzo.getContext("2d").getImageData(0, 0, W, H).data;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0, j = 3; y < H; y++) for (let x = 0; x < W; x++, j += 4) if (d[j] > umbral) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x1 < 0) return null;
  x0 = Math.max(0, x0 - 4); y0 = Math.max(0, y0 - 4); x1 = Math.min(W - 1, x1 + 4); y1 = Math.min(H - 1, y1 + 4);
  const r = document.createElement("canvas");
  r.width = x1 - x0 + 1; r.height = y1 - y0 + 1;
  r.getContext("2d").drawImage(lienzo, x0, y0, r.width, r.height, 0, 0, r.width, r.height);
  return r;
}
// Foto de una firma → lienzo recortado. Con quitarFondo, el papel (lo claro) se vuelve transparente:
// entre más oscuro que el papel es un punto, más tinta se le deja.
async function firmaDeImagen(f, quitarFondo) {
  let mapa;
  try { mapa = await createImageBitmap(f, { imageOrientation: "from-image" }); }
  catch { throw new Error(`«${f.name}» no se pudo abrir como imagen.`); }
  const k = Math.min(1, 1000 / Math.max(mapa.width, mapa.height));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(mapa.width * k)); c.height = Math.max(1, Math.round(mapa.height * k));
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(mapa, 0, 0, c.width, c.height);
  mapa.close();
  if (quitarFondo) {
    const img = ctx.getImageData(0, 0, c.width, c.height), d = img.data, n = d.length / 4;
    const W = c.width, H = c.height, luz = new Uint8Array(n);
    let conHuecos = 0;
    for (let j = 0; j < n; j++) {
      luz[j] = Math.round(0.299 * d[j * 4] + 0.587 * d[j * 4 + 1] + 0.114 * d[j * 4 + 2]);
      if (d[j * 4 + 3] < 250) conHuecos++;
    }
    if (conHuecos < n * 0.02) {             // si ya trae fondo transparente se deja como está
      // El papel no sale parejo en una foto (sombras, luz de lado): se mide por cuadros y cada
      // punto se compara con el papel de su zona
      const T = Math.max(16, Math.round(Math.max(W, H) / 40)), nx = Math.ceil(W / T), ny = Math.ceil(H / T);
      const papel = new Float32Array(nx * ny), cuenta = new Uint32Array(256);
      for (let ty = 0; ty < ny; ty++) for (let tx = 0; tx < nx; tx++) {
        cuenta.fill(0);
        const x1 = Math.min(W, (tx + 1) * T), y1 = Math.min(H, (ty + 1) * T);
        for (let y = ty * T; y < y1; y++) for (let x = tx * T; x < x1; x++) cuenta[luz[y * W + x]]++;
        const tope = (x1 - tx * T) * (y1 - ty * T) * 0.25;
        let v = 255;
        for (let suma = 0; v > 0; v--) { suma += cuenta[v]; if (suma >= tope) break; }
        papel[ty * nx + tx] = v;
      }
      const suave = new Float32Array(nx * ny);       // promedio con los cuadros vecinos
      for (let ty = 0; ty < ny; ty++) for (let tx = 0; tx < nx; tx++) {
        let suma = 0, k = 0;
        for (let b = Math.max(0, ty - 1); b <= Math.min(ny - 1, ty + 1); b++) for (let a = Math.max(0, tx - 1); a <= Math.min(nx - 1, tx + 1); a++) { suma += papel[b * nx + a]; k++; }
        suave[ty * nx + tx] = suma / k;
      }
      for (let y = 0, j = 0; y < H; y++) {
        const fy = entre(y / T - 0.5, 0, ny - 1), y0 = Math.floor(fy), y1 = Math.min(ny - 1, y0 + 1), py = fy - y0;
        for (let x = 0; x < W; x++, j++) {
          const fx = entre(x / T - 0.5, 0, nx - 1), x0 = Math.floor(fx), x1 = Math.min(nx - 1, x0 + 1), px = fx - x0;
          const local = (suave[y0 * nx + x0] * (1 - px) + suave[y0 * nx + x1] * px) * (1 - py) + (suave[y1 * nx + x0] * (1 - px) + suave[y1 * nx + x1] * px) * py;
          d[j * 4 + 3] = Math.round(d[j * 4 + 3] * entre((local - luz[j] - local * 0.12) / Math.max(1, local * 0.25), 0, 1));
        }
      }
      ctx.putImageData(img, 0, 0);
    }
  }
  const r = recortar(c, 24);
  if (!r) throw new Error("No se encontró la firma en esa imagen. Usa una foto de la firma sobre papel blanco.");
  return r;
}

const firmas = { dibujo: null, imagen: null };      // cada una { url, w, h }
let paraFirmar = null;                              // { f, vista, total, i }
const puestas = [];                                 // { i, x, y, w }
const tipoFirma = () => document.querySelector('input[name="tipoFirma"]:checked').value;
const firmaActual = () => firmas[tipoFirma()];
const mesa = $("mesaFirma"), lienzoMesa = mesa.querySelector("canvas");
const deLienzo = (c) => c ? { url: c.toDataURL("image/png"), w: c.width, h: c.height } : null;
// Alto de una firma de ancho w, las dos medidas como fracción de la hoja que se está viendo
const altoFirma = (w) => { const f = firmaActual(); return f && lienzoMesa.height ? w * f.h / f.w * lienzoMesa.width / lienzoMesa.height : 0; };

function arrastrar(el, alEmpezar, alMover, caja = mesa) {
  el.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button") || (e.target !== el && e.target.classList.contains("asa"))) return;
    e.preventDefault();
    const r = caja.getBoundingClientRect(), x0 = e.clientX, y0 = e.clientY, inicio = alEmpezar();
    el.setPointerCapture(e.pointerId);
    const mover = (ev) => alMover((ev.clientX - x0) / r.width, (ev.clientY - y0) / r.height, inicio);
    const fin = () => { el.removeEventListener("pointermove", mover); el.removeEventListener("pointerup", fin); el.removeEventListener("pointercancel", fin); };
    el.addEventListener("pointermove", mover); el.addEventListener("pointerup", fin); el.addEventListener("pointercancel", fin);
  });
}
function pintarPuestas() {
  for (const el of [...mesa.querySelectorAll(".puesta")]) el.remove();
  const a = paraFirmar, f = firmaActual();
  if (a) {
    const con = new Set(puestas.map((q) => q.i)).size;
    $("paginaFirma").textContent = `Página ${a.i + 1} de ${a.total}`;
    $("cuentaFirma").textContent = con && f ? `Hay firma en ${paginasTxt(con)}.` : "";
  }
  if (!a || !f) return;
  for (const q of puestas.filter((q) => q.i === a.i)) {
    const el = document.createElement("div");
    el.className = "puesta";
    el.innerHTML = `<img alt="Firma"><button type="button" aria-label="Quitar esta firma">✕</button><span class="asa"></span>`;
    el.querySelector("img").src = f.url;
    const acomodar = () => {
      q.w = entre(q.w, 0.03, 1);
      if (altoFirma(q.w) > 1) q.w /= altoFirma(q.w);
      q.x = entre(q.x, 0, 1 - q.w); q.y = entre(q.y, 0, 1 - altoFirma(q.w));
      el.style.left = q.x * 100 + "%"; el.style.top = q.y * 100 + "%"; el.style.width = q.w * 100 + "%";
    };
    acomodar();
    arrastrar(el, () => ({ x: q.x, y: q.y }), (dx, dy, ini) => { q.x = ini.x + dx; q.y = ini.y + dy; acomodar(); });
    arrastrar(el.querySelector(".asa"), () => q.w, (dx, dy, w) => { q.w = Math.min(Math.max(0.03, w + dx), 1 - q.x); acomodar(); });
    el.querySelector("button").onclick = () => { puestas.splice(puestas.indexOf(q), 1); pintarPuestas(); };
    mesa.append(el);
  }
}
let turnoMesa = 0;
async function pintarMesa() {
  const a = paraFirmar, turno = ++turnoMesa;
  if (!a) return;
  $("antesFirma").disabled = a.i === 0; $("despuesFirma").disabled = a.i === a.total - 1;
  const pagina = await a.vista.getPage(a.i + 1);
  const b = pagina.getViewport({ scale: 1 });
  const ancho = Math.min((mesa.clientWidth || 600) * Math.min(devicePixelRatio || 1, 2), 1600);
  const v = pagina.getViewport({ scale: ancho / b.width });
  const nuevo = document.createElement("canvas");
  nuevo.width = Math.round(v.width); nuevo.height = Math.round(v.height);
  await pagina.render({ canvasContext: nuevo.getContext("2d"), viewport: v }).promise;
  if (turno !== turnoMesa) return;              // ya se pidió otra página
  lienzoMesa.width = nuevo.width; lienzoMesa.height = nuevo.height;
  lienzoMesa.getContext("2d").drawImage(nuevo, 0, 0);
  pintarPuestas();
}

zonaDeArchivos($("zonaFirma"), $("archivoFirma"), async (fs) => {
  const f = fs.find(esPdf);
  if (!f) { $("infoFirma").textContent = "Ese archivo no es un PDF."; return; }
  $("infoFirma").textContent = "Abriendo…";
  try {
    const doc = await abrirPdf(f), pdfjs = await pdfJs();
    const vista = await pdfjs.getDocument({ data: await f.arrayBuffer() }).promise;
    if (paraFirmar) paraFirmar.vista.destroy();
    paraFirmar = { f, vista, total: doc.getPageCount(), i: 0 };
    puestas.length = 0;
    $("infoFirma").textContent = `${f.name} · ${paginasTxt(paraFirmar.total)}`;
    $("repetirFirma").hidden = paraFirmar.total === 1;
    $("opcionesFirma").hidden = false;
    aviso("avisoFirma", "");
    await pintarMesa();
  } catch (e) {
    paraFirmar = null;
    $("opcionesFirma").hidden = true;
    $("infoFirma").textContent = String(e && e.message || e);
  }
});
$("antesFirma").onclick = () => { if (paraFirmar && paraFirmar.i > 0) { paraFirmar.i--; pintarMesa(); } };
$("despuesFirma").onclick = () => { if (paraFirmar && paraFirmar.i < paraFirmar.total - 1) { paraFirmar.i++; pintarMesa(); } };
lienzoMesa.onclick = (e) => {
  const a = paraFirmar;
  if (!a) return;
  if (!firmaActual()) { aviso("avisoFirma", tipoFirma() === "dibujo" ? "Primero dibuja tu firma en el recuadro de arriba." : "Primero elige la imagen de tu firma.", true); return; }
  const r = lienzoMesa.getBoundingClientRect();
  let w = 0.3;
  if (altoFirma(w) > 0.2) w *= 0.2 / altoFirma(w);
  puestas.push({ i: a.i, x: (e.clientX - r.left) / r.width - w / 2, y: (e.clientY - r.top) / r.height - altoFirma(w) / 2, w });
  aviso("avisoFirma", "");
  pintarPuestas();
};
$("repetirFirma").onclick = () => {
  const a = paraFirmar, aqui = puestas.filter((q) => q.i === a.i);
  if (!aqui.length) { aviso("avisoFirma", "Primero pon la firma en esta página; se copiará igual en las demás.", true); return; }
  puestas.length = 0;
  for (let i = 0; i < a.total; i++) for (const q of aqui) puestas.push({ ...q, i });
  aviso("avisoFirma", `La firma quedó en las ${a.total} páginas, en el mismo lugar.`);
  pintarPuestas();
};

// El recuadro para dibujar: se guardan los trazos para poder deshacer y cambiar color o grosor
const lienzoFirma = $("lienzoFirma"), trazos = [];
function trazar() {
  const ctx = lienzoFirma.getContext("2d", { willReadFrequently: true }), grosor = Number($("grosorFirma").value);
  ctx.clearRect(0, 0, lienzoFirma.width, lienzoFirma.height);
  ctx.lineCap = ctx.lineJoin = "round"; ctx.lineWidth = grosor; ctx.strokeStyle = ctx.fillStyle = $("colorFirma").value;
  for (const t of trazos) {
    ctx.beginPath();
    if (t.length === 1) { ctx.arc(t[0][0], t[0][1], grosor / 2, 0, 7); ctx.fill(); continue; }
    ctx.moveTo(t[0][0], t[0][1]);
    for (let k = 1; k < t.length; k++) ctx.quadraticCurveTo(t[k - 1][0], t[k - 1][1], (t[k - 1][0] + t[k][0]) / 2, (t[k - 1][1] + t[k][1]) / 2);
    ctx.lineTo(t[t.length - 1][0], t[t.length - 1][1]);
    ctx.stroke();
  }
}
function firmaDibujada() {
  trazar();
  firmas.dibujo = trazos.length ? deLienzo(recortar(lienzoFirma)) : null;
  pintarPuestas();
}
lienzoFirma.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  lienzoFirma.setPointerCapture(e.pointerId);
  const r = lienzoFirma.getBoundingClientRect(), k = lienzoFirma.width / r.width, t = [];
  const punto = (ev) => [(ev.clientX - r.left) * k, (ev.clientY - r.top) * k];
  t.push(punto(e)); trazos.push(t); trazar();
  const mover = (ev) => { for (const c of ev.getCoalescedEvents ? ev.getCoalescedEvents() : [ev]) t.push(punto(c)); trazar(); };
  const fin = () => {
    lienzoFirma.removeEventListener("pointermove", mover); lienzoFirma.removeEventListener("pointerup", fin); lienzoFirma.removeEventListener("pointercancel", fin);
    firmaDibujada();
  };
  lienzoFirma.addEventListener("pointermove", mover); lienzoFirma.addEventListener("pointerup", fin); lienzoFirma.addEventListener("pointercancel", fin);
});
$("deshacerFirma").onclick = () => { trazos.pop(); firmaDibujada(); };
$("borrarFirma").onclick = () => { trazos.length = 0; firmaDibujada(); };
$("colorFirma").onchange = $("grosorFirma").onchange = firmaDibujada;

// La firma desde una imagen (o la guardada de otra vez)
let fotoFirma = null;
function mostrarFirmaImagen(nota) {
  const f = firmas.imagen;
  $("muestraFirma").hidden = !f;
  if (f) $("muestraFirma").src = f.url;
  $("notaImagenFirma").classList.remove("error");
  $("notaImagenFirma").textContent = nota;
  pintarPuestas();
}
async function leerFotoFirma() {
  if (!fotoFirma) return;
  try {
    firmas.imagen = deLienzo(await firmaDeImagen(fotoFirma, $("fondoFirma").checked));
    mostrarFirmaImagen("Así se va a ver sobre la hoja.");
  } catch (e) {
    firmas.imagen = null;
    mostrarFirmaImagen("");
    aviso("notaImagenFirma", String(e && e.message || e), true);
  }
}
$("imagenFirma").onchange = async (e) => { const f = e.target.files[0]; fotoFirma = f ? (await sinHeic([f]))[0] : null; leerFotoFirma(); };
$("fondoFirma").onchange = leerFotoFirma;
function verTipoFirma() {
  const imagen = tipoFirma() === "imagen";
  $("firmaDibujo").hidden = imagen; $("firmaImagen").hidden = !imagen;
  pintarPuestas();
}
for (const r of document.querySelectorAll('input[name="tipoFirma"]')) r.onchange = verTipoFirma;
try {
  const g = JSON.parse(localStorage.getItem("firmaGuardada") || "null");
  if (g && /^data:image\/png;base64,/.test(g.url) && g.w > 0 && g.h > 0) {
    firmas.imagen = { url: g.url, w: g.w, h: g.h };
    document.querySelector('input[name="tipoFirma"][value="imagen"]').checked = true;
    $("recordarFirma").checked = true;
    verTipoFirma();
    mostrarFirmaImagen("Es la firma que guardaste en este navegador. Para cambiarla, elige otra imagen o dibújala de nuevo.");
  }
} catch { /* sin almacenamiento: no pasa nada */ }
$("recordarFirma").onchange = () => { if (!$("recordarFirma").checked) try { localStorage.removeItem("firmaGuardada"); } catch {} };

$("botonFirma").onclick = async () => {
  const a = paraFirmar, f = firmaActual();
  if (!a) return;
  $("botonFirma").disabled = true;
  try {
    if (!f) throw new Error(tipoFirma() === "dibujo" ? "Primero dibuja tu firma en el recuadro de arriba." : "Primero elige la imagen de tu firma.");
    if (!puestas.length) throw new Error("Toca la hoja en el lugar donde va la firma.");
    aviso("avisoFirma", "Firmando…");
    const L = await pdfLib(), doc = await abrirPdf(a.f);
    const imagen = await doc.embedPng(Uint8Array.from(atob(f.url.split(",")[1]), (c) => c.charCodeAt(0)));
    const envueltas = new Set();
    for (const q of puestas) {
      const p = doc.getPage(q.i), [W, H] = tamVisible(p);
      let ancho = q.w * W, alto = ancho * f.h / f.w;
      if (alto > H) { ancho *= H / alto; alto = H; }          // hojas de otro tamaño (al repetir en todas)
      const x = entre(q.x * W, 0, W - ancho), y = entre(q.y * H, 0, H - alto);
      if (!envueltas.has(q.i)) { envolver(doc, p); envueltas.add(q.i); }
      p.drawImage(imagen, { ...colocar(L, p, x + ancho / 2, H - y - alto / 2, ancho, alto, 0), width: ancho, height: alto });
    }
    const bytes = await doc.save();
    filaDescarga($("salidaFirma"), bytes, sinExt(a.f.name) + " (firmado).pdf", `Firma en ${paginasTxt(envueltas.size)}`);
    try {
      if ($("recordarFirma").checked) localStorage.setItem("firmaGuardada", JSON.stringify(f));
      else localStorage.removeItem("firmaGuardada");
    } catch { /* sin espacio o sin permiso: la firma solo no se guarda */ }
    aviso("avisoFirma", "Listo. Descarga el PDF firmado aquí abajo.");
    $("salidaFirma").scrollIntoView({ block: "nearest", behavior: "smooth" });
  } catch (e) {
    aviso("avisoFirma", String(e && e.message || e), true);
  } finally {
    $("botonFirma").disabled = false;
  }
};

// ---------------------------------------------------------------- 16. editar PDF
// Cada cosa puesta sobre la hoja es un «objeto»: { t (qué es), i (página), x, y, w, h } con el lugar
// y el tamaño como fracción de la hoja visible, más color, grosor (pt), letra (pt) o imagen. En
// pantalla son elementos encima del dibujo de PDF.js (la variable --pt dice cuántos px mide un
// punto); al guardar, pdf-lib dibuja lo mismo en el PDF.
const mesaEd = $("mesaEd"), lienzoEd = mesaEd.querySelector("canvas");
let paraEditar = null;                    // { f, vista, total, i, W, H } (W y H: la hoja en puntos)
const objetos = [];
let armada = null, elegido = null, imagenArmada = null, zoomEd = 1;
const FORMAS = { borrar: [150, 18], rect: [150, 60], ovalo: [150, 60], tapar: [150, 18], resaltar: [150, 18], linea: [150, 14], paloma: [16, 16], cruz: [16, 16] };   // tamaño al ponerlas, en puntos
const TRAZOS = { paloma: [[[5, 55], [38, 90], [95, 10]]], cruz: [[[8, 8], [92, 92]], [[92, 8], [8, 92]]] };      // en un cuadro de 100 × 100
const CON_COLOR = ["texto", "rect", "ovalo", "linea", "paloma", "cruz", "trazo"], CON_GROSOR = ["rect", "ovalo", "linea", "paloma", "cruz", "trazo"];
const NOMBRES = { borrar: "el recuadro negro (lo de abajo se borra del archivo)", trazo: "tu dibujo", texto: "el texto", paloma: "la palomita", cruz: "la cruz", tapar: "el recuadro blanco", resaltar: "el resaltado", linea: "la línea", rect: "el rectángulo", ovalo: "el óvalo", imagen: "la imagen" };
// Un punto de la hoja como se ve (medido desde abajo a la izquierda) → sus coordenadas en el PDF
function aPdf(p, vx, vy) {
  const c = p.getCropBox(), r = giroDe(p);
  return r === 90 ? [c.x + c.width - vy, c.y + vx] : r === 180 ? [c.x + c.width - vx, c.y + c.height - vy]
    : r === 270 ? [c.x + vy, c.y + c.height - vx] : [c.x + vx, c.y + vy];
}
// Un dibujo a mano guarda sus puntos como 0–100 dentro de su propio recuadro (así se mueve y estira igual que una forma)
const caminoTrazo = (o) => "M" + o.puntos.map((q) => q[0].toFixed(2) + " " + q[1].toFixed(2)).join("L");
const lineasDe = (o) => { const l = o.texto.replace(/ |\t/g, " ").replace(/\r/g, "").split("\n"); while (l.length && !l[l.length - 1].trim()) l.pop(); return l; };

function armar(t) {
  armada = t;
  for (const b of $("herrEd").children) b.classList.toggle("armada", b.dataset.t === t);
  mesaEd.classList.toggle("dibujando", t === "trazo");
  aviso("avisoEd", t === "trazo" ? "Dibuja sobre la hoja con el dedo o el ratón. Cuando acabes, toca «✎ Dibujar» otra vez." : t ? `Toca la hoja donde va ${NOMBRES[t]}.` : "");
}
function elegir(o) {
  for (const v of objetos.filter((v) => v.t === "texto" && v !== o && !v.texto.trim())) objetos.splice(objetos.indexOf(v), 1);   // textos que se quedaron vacíos
  elegido = o;
  for (const el of [...mesaEd.querySelectorAll(".objeto")]) {
    if (!objetos.includes(el._o)) el.remove(); else el.classList.toggle("elegido", el._o === o);
  }
  if (!o) return;
  if (CON_COLOR.includes(o.t)) $("colorEd").value = o.color;
  if (CON_GROSOR.includes(o.t)) $("grosorEd").value = String(o.grosor);
  if (o.t === "texto") { $("letraEd").value = String(o.size); $("negritaEd").checked = o.negrita; }
}
function crearObjeto(o) {
  const a = paraEditar, el = document.createElement("div"), pt = (n) => `calc(var(--pt) * ${n})`;
  el.className = `objeto ${o.t}` + (o === elegido ? " elegido" : "");
  el._o = o;
  const dentro = o.t === "texto" ? `<span class="agarre" aria-hidden="true">✥</span><div class="texto"></div>`
    : o.t === "imagen" ? `<img alt="">` : o.t === "linea" ? `<i></i>`
    : o.t === "trazo" ? `<svg viewBox="0 0 100 100" preserveAspectRatio="none"><path fill="none" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" d="${caminoTrazo(o)}"/></svg>`
    : TRAZOS[o.t] ? `<svg viewBox="0 0 100 100" preserveAspectRatio="none"><path fill="none" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" d="${TRAZOS[o.t].map((t) => "M" + t.map((q) => q.join(" ")).join("L")).join("")}"/></svg>` : "";
  el.innerHTML = dentro + `<button type="button" aria-label="Quitar">✕</button>` + (o.t === "texto" ? "" : `<span class="asa"></span>`);
  const acomodar = () => {
    if (o.t === "texto") { o.x = entre(o.x, 0, 0.97); o.y = entre(o.y, 0, 0.97); }
    else {
      const fija = o.t === "imagen" ? o.img.h / o.img.w : TRAZOS[o.t] ? 1 : 0;     // alto ÷ ancho que no cambia
      o.w = entre(o.w, 4 / a.W, 1);
      if (fija) { o.h = o.w * fija * a.W / a.H; if (o.h > 1) { o.w /= o.h; o.h = 1; } }
      else o.h = o.t === "linea" ? 14 / a.H : entre(o.h, 4 / a.H, 1);
      o.x = entre(o.x, 0, 1 - o.w); o.y = entre(o.y, 0, 1 - o.h);
      el.style.width = o.w * 100 + "%"; el.style.height = o.h * 100 + "%";
    }
    el.style.left = o.x * 100 + "%"; el.style.top = o.y * 100 + "%";
  };
  acomodar();
  el.addEventListener("pointerdown", () => { if (elegido !== o) elegir(o); }, true);
  const mover = (dx, dy, ini) => { o.x = ini.x + dx; o.y = ini.y + dy; acomodar(); };
  if (o.t === "texto") {
    const t = el.querySelector(".texto");
    try { t.contentEditable = "plaintext-only"; } catch { t.contentEditable = "true"; }
    t.spellcheck = false;
    t.textContent = o.texto;
    t.style.fontSize = pt(o.size); t.style.color = o.color; t.style.fontWeight = o.negrita ? "700" : "400";
    t.oninput = () => { o.texto = t.innerText; };
    arrastrar(el.querySelector(".agarre"), () => ({ x: o.x, y: o.y }), mover, mesaEd);
  } else {
    if (o.t === "imagen") el.querySelector("img").src = o.img.url;
    if (o.t === "rect" || o.t === "ovalo") el.style.border = `${pt(o.grosor)} solid ${o.color}`;
    if (o.t === "linea") { const i = el.querySelector("i"); i.style.height = pt(o.grosor); i.style.background = o.color; }
    if (TRAZOS[o.t] || o.t === "trazo") { const c = el.querySelector("path"); c.style.stroke = o.color; c.style.strokeWidth = pt(o.grosor); }
    arrastrar(el, () => ({ x: o.x, y: o.y }), mover, mesaEd);
    arrastrar(el.querySelector(".asa"), () => ({ w: o.w, h: o.h }), (dx, dy, ini) => { o.w = ini.w + dx; o.h = ini.h + dy; acomodar(); }, mesaEd);
  }
  el.querySelector("button").onclick = () => { objetos.splice(objetos.indexOf(o), 1); if (elegido === o) elegido = null; el.remove(); };
  return el;
}
function pintarObjetos() {
  for (const el of [...mesaEd.querySelectorAll(".objeto")]) el.remove();
  const a = paraEditar;
  if (!a || !a.W) return;
  $("paginaEd").textContent = `Página ${a.i + 1} de ${a.total}`;
  mesaEd.style.setProperty("--pt", mesaEd.clientWidth / a.W + "px");
  for (const o of objetos.filter((o) => o.i === a.i)) mesaEd.append(crearObjeto(o));
}
new ResizeObserver(() => { if (paraEditar && paraEditar.W) mesaEd.style.setProperty("--pt", mesaEd.clientWidth / paraEditar.W + "px"); }).observe(mesaEd);
let turnoEd = 0;
async function pintarMesaEd() {
  const a = paraEditar, turno = ++turnoEd;
  if (!a) return;
  $("antesEd").disabled = a.i === 0; $("despuesEd").disabled = a.i === a.total - 1;
  const pagina = await a.vista.getPage(a.i + 1);
  const b = pagina.getViewport({ scale: 1 });
  const ancho = Math.min((mesaEd.clientWidth || 600) * Math.min(devicePixelRatio || 1, 2), 2400);
  const v = pagina.getViewport({ scale: ancho / b.width });
  const nuevo = document.createElement("canvas");
  nuevo.width = Math.round(v.width); nuevo.height = Math.round(v.height);
  await pagina.render({ canvasContext: nuevo.getContext("2d"), viewport: v }).promise;
  if (turno !== turnoEd) return;
  a.W = b.width; a.H = b.height;
  lienzoEd.width = nuevo.width; lienzoEd.height = nuevo.height;
  lienzoEd.getContext("2d").drawImage(nuevo, 0, 0);
  pintarObjetos();
}
function irPaginaEd(i) { const a = paraEditar; if (!a || i < 0 || i >= a.total) return; elegir(null); a.i = i; pintarMesaEd(); }
$("antesEd").onclick = () => irPaginaEd(paraEditar.i - 1);
$("despuesEd").onclick = () => irPaginaEd(paraEditar.i + 1);
function acercar(paso) {
  const niveles = [1, 1.5, 2, 3];
  zoomEd = niveles[entre(niveles.indexOf(zoomEd) + paso, 0, niveles.length - 1)];
  mesaEd.style.width = zoomEd * 100 + "%";
  $("zoomEd").textContent = zoomEd * 100 + " %";
  pintarMesaEd();
}
$("menosEd").onclick = () => acercar(-1);
$("masEd").onclick = () => acercar(1);

zonaDeArchivos($("zonaEd"), $("archivoEd"), async (fs) => {
  const f = fs.find(esPdf);
  if (!f) { $("infoEd").textContent = "Ese archivo no es un PDF."; return; }
  $("infoEd").textContent = "Abriendo…";
  try {
    const doc = await abrirPdf(f), pdfjs = await pdfJs();
    const vista = await pdfjs.getDocument({ data: await f.arrayBuffer() }).promise;
    if (paraEditar) paraEditar.vista.destroy();
    paraEditar = { f, vista, total: doc.getPageCount(), i: 0, W: 0, H: 0 };
    objetos.length = 0; elegido = null;
    $("infoEd").textContent = `${f.name} · ${paginasTxt(paraEditar.total)}`;
    $("opcionesEd").hidden = false;
    armar(null);
    await pintarMesaEd();
  } catch (e) {
    paraEditar = null;
    $("opcionesEd").hidden = true;
    $("infoEd").textContent = String(e && e.message || e);
  }
});
for (const b of $("herrEd").children) b.onclick = () => {
  const t = b.dataset.t;
  if (armada === t) armar(null);
  else if (t === "imagen") $("imagenEd").click();
  else armar(t);
};
$("imagenEd").onchange = async (e) => {
  let f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  f = (await sinHeic([f]))[0];
  try {
    const mapa = await createImageBitmap(f);
    imagenArmada = { f, url: URL.createObjectURL(f), w: mapa.width, h: mapa.height };
    mapa.close();
    armar("imagen");
  } catch { aviso("avisoEd", `«${f.name}» no se pudo abrir como imagen.`, true); }
};
// Dibujar a mano: mientras se arrastra se ve una línea provisional; al soltar queda como objeto
lienzoEd.addEventListener("pointerdown", (e) => {
  const a = paraEditar;
  if (armada !== "trazo" || !a || !a.W || (e.pointerType === "mouse" && e.button)) return;
  e.preventDefault();
  lienzoEd.setPointerCapture(e.pointerId);
  const r = lienzoEd.getBoundingClientRect(), puntos = [];
  const ns = "http://www.w3.org/2000/svg", svg = document.createElementNS(ns, "svg"), camino = document.createElementNS(ns, "path");
  svg.setAttribute("viewBox", "0 0 100 100"); svg.setAttribute("preserveAspectRatio", "none"); svg.classList.add("provisional");
  Object.assign(camino.style, { stroke: $("colorEd").value, strokeWidth: `calc(var(--pt) * ${$("grosorEd").value})` });
  camino.setAttribute("fill", "none"); camino.setAttribute("stroke-linecap", "round"); camino.setAttribute("stroke-linejoin", "round");
  camino.setAttribute("vector-effect", "non-scaling-stroke");
  svg.append(camino); mesaEd.append(svg);
  const sumar = (ev) => {
    const x = entre((ev.clientX - r.left) / r.width, 0, 1), y = entre((ev.clientY - r.top) / r.height, 0, 1), u = puntos[puntos.length - 1];
    if (u && Math.hypot((x - u[0]) * r.width, (y - u[1]) * r.height) < 1.5) return;      // menos de 1.5 px: no hace falta
    puntos.push([x, y]);
    camino.setAttribute("d", "M" + puntos.map((q) => q[0] * 100 + " " + q[1] * 100).join("L"));
  };
  const mover = (ev) => { for (const x of ev.getCoalescedEvents ? ev.getCoalescedEvents() : [ev]) sumar(x); };
  sumar(e);
  const fin = () => {
    lienzoEd.removeEventListener("pointermove", mover); lienzoEd.removeEventListener("pointerup", fin); lienzoEd.removeEventListener("pointercancel", fin);
    svg.remove();
    if (puntos.length === 1) puntos.push([puntos[0][0] + 0.5 / a.W, puntos[0][1]]);       // un toque: un punto
    // Recuadro del trazo, de al menos 4 puntos de lado (una raya derecha no tiene alto)
    const xs = puntos.map((q) => q[0]), ys = puntos.map((q) => q[1]);
    let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const mw = 4 / a.W, mh = 4 / a.H;
    if (x1 - x0 < mw) { const c = (x0 + x1) / 2; x0 = c - mw / 2; x1 = c + mw / 2; }
    if (y1 - y0 < mh) { const c = (y0 + y1) / 2; y0 = c - mh / 2; y1 = c + mh / 2; }
    const o = { t: "trazo", i: a.i, color: $("colorEd").value, grosor: Number($("grosorEd").value), x: x0, y: y0, w: x1 - x0, h: y1 - y0,
      puntos: puntos.map((q) => [(q[0] - x0) / (x1 - x0) * 100, (q[1] - y0) / (y1 - y0) * 100]) };
    objetos.push(o);
    mesaEd.append(crearObjeto(o));
    elegir(o);
  };
  lienzoEd.addEventListener("pointermove", mover); lienzoEd.addEventListener("pointerup", fin); lienzoEd.addEventListener("pointercancel", fin);
});
lienzoEd.onclick = (e) => {
  const a = paraEditar;
  if (!a || !a.W || armada === "trazo") return;
  if (!armada) {
    if (elegido) elegir(null); else aviso("avisoEd", "Elige arriba qué quieres poner (texto, palomita, tapar…) y luego toca la hoja.");
    return;
  }
  const r = lienzoEd.getBoundingClientRect(), tx = (e.clientX - r.left) / r.width, ty = (e.clientY - r.top) / r.height;
  const o = { t: armada, i: a.i, color: $("colorEd").value, grosor: Number($("grosorEd").value) };
  if (o.t === "texto") Object.assign(o, { texto: "", size: Number($("letraEd").value), negrita: $("negritaEd").checked, x: tx, y: ty - 0.6 * Number($("letraEd").value) / a.H, w: 0, h: 0 });
  else {
    if (o.t === "imagen") { o.img = imagenArmada; o.w = 0.3; o.h = o.w * o.img.h / o.img.w * a.W / a.H; if (o.h > 0.3) { o.w *= 0.3 / o.h; o.h = 0.3; } }
    else { o.w = FORMAS[o.t][0] / a.W; o.h = FORMAS[o.t][1] / a.H; }
    o.x = tx - o.w / 2; o.y = ty - o.h / 2;
  }
  objetos.push(o);
  const el = crearObjeto(o);
  mesaEd.append(el);
  elegir(o);
  aviso("avisoEd", "");
  if (o.t === "texto") el.querySelector(".texto").focus();
};
// Cambiar una opción la aplica a lo que está elegido (y queda para lo siguiente que se ponga)
function cambiarElegido(cambio, tipos) {
  const o = elegido;
  if (!o || !tipos.includes(o.t)) return;
  cambio(o);
  const viejo = [...mesaEd.querySelectorAll(".objeto")].find((el) => el._o === o);
  if (viejo) viejo.replaceWith(crearObjeto(o));
}
$("colorEd").onchange = () => cambiarElegido((o) => { o.color = $("colorEd").value; }, CON_COLOR);
$("grosorEd").onchange = () => cambiarElegido((o) => { o.grosor = Number($("grosorEd").value); }, CON_GROSOR);
$("letraEd").onchange = () => cambiarElegido((o) => { o.size = Number($("letraEd").value); }, ["texto"]);
$("negritaEd").onchange = () => cambiarElegido((o) => { o.negrita = $("negritaEd").checked; }, ["texto"]);
addEventListener("keydown", (e) => {
  if ((e.key !== "Delete" && e.key !== "Backspace") || !elegido || elegido.t === "texto" || $("vista-editar").hidden) return;
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement && document.activeElement.tagName || "")) return;
  e.preventDefault();
  objetos.splice(objetos.indexOf(elegido), 1);
  elegir(null);
});

// «Borrar de verdad»: la hoja se vuelve imagen con los recuadros negros encima (así lo de abajo deja de
// existir) y se le pone, invisible, el texto que quedó fuera de los recuadros, para seguir buscando y copiando.
async function borrarEnPagina(L, doc, vista, i, cajas, fuente) {
  const pdfjs = await pdfJs(), pagina = await vista.getPage(i + 1), b = pagina.getViewport({ scale: 1 });
  const esc = Math.min(200 / 72, Math.sqrt(30e6 / (b.width * b.height))), v = pagina.getViewport({ scale: esc });
  const c = lienzoNuevo(Math.round(v.width), Math.round(v.height)), ctx = c.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
  await pagina.render({ canvasContext: ctx, viewport: v }).promise;
  const px = cajas.map((o) => ({ x0: o.x * c.width - 1, y0: o.y * c.height - 1, x1: (o.x + o.w) * c.width + 1, y1: (o.y + o.h) * c.height + 1 }));
  ctx.fillStyle = "#000";
  for (const r of px) ctx.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
  const jpg = await guardarImagen(c, "jpg", 0.9);
  c.width = 0;
  const choca = (q) => px.some((r) => q.x0 < r.x1 && q.x1 > r.x0 && q.y0 < r.y1 && q.y1 > r.y0);
  const palabras = [];
  for (const it of (await pagina.getTextContent()).items) {
    if (!it.str || !it.str.trim()) continue;
    const m = pdfjs.Util.transform(v.transform, it.transform), size = Math.hypot(m[2], m[3]);
    if (!(size > 0) || m[0] <= 0 || Math.abs(m[1]) > size * 0.02) continue;      // solo texto derecho
    const cw = it.width * esc / it.str.length;
    for (const w of it.str.matchAll(/\S+/g)) {
      const q = { x0: m[4] + w.index * cw, x1: m[4] + (w.index + w[0].length) * cw, y0: m[5] - size * 0.85, y1: m[5] + size * 0.2 };
      if (!choca(q)) palabras.push({ text: w[0], bbox: q, baseline: { y0: m[5], y1: m[5] } });
    }
  }
  const viejo = doc.getPage(i).ref, nueva = doc.insertPage(i, [b.width, b.height]);
  doc.removePage(i + 1);
  nueva.drawImage(await doc.embedJpg(jpg), { x: 0, y: 0, width: b.width, height: b.height });
  capaDeTexto(L, doc, fuente, nueva, palabras, esc);
  return [viejo, nueva.ref];
}
// Quita del archivo todo lo que ya no se usa (la hoja vieja, su texto, sus imágenes) y cambia las
// referencias a la hoja vieja (marcadores, enlaces) por la nueva
function limpiarHuerfanos(L, doc, cambia) {
  const { PDFRef, PDFDict, PDFArray } = L, ctx = doc.context, vistos = new Set(), cola = [];
  const valor = (v) => {
    if (v instanceof PDFRef) { if (!vistos.has(v)) { vistos.add(v); const o = ctx.lookup(v); if (o) cola.push(o); } }
    else if (v instanceof PDFDict || v instanceof PDFArray) cola.push(v);
  };
  const recorrer = (o) => {
    if (o instanceof PDFDict) for (const [k, v] of o.entries()) { if (cambia.has(v)) o.set(k, cambia.get(v)); valor(o.get(k)); }
    else if (o instanceof PDFArray) for (let k = 0; k < o.size(); k++) { const v = o.get(k); if (cambia.has(v)) o.set(k, cambia.get(v)); valor(o.get(k)); }
    else if (o && o.dict instanceof PDFDict) recorrer(o.dict);
  };
  for (const v of Object.values(ctx.trailerInfo)) if (v) valor(v);
  while (cola.length) recorrer(cola.pop());
  for (const [ref] of ctx.enumerateIndirectObjects()) if (!vistos.has(ref)) ctx.delete(ref);
}
$("botonEd").onclick = async () => {
  const a = paraEditar;
  if (!a) return;
  $("botonEd").disabled = true;
  try {
    const utiles = objetos.filter((o) => o.t !== "texto" || o.texto.trim());
    if (!utiles.length) throw new Error("Todavía no has puesto nada en la hoja.");
    aviso("avisoEd", "Guardando…");
    const L = await pdfLib(), doc = await abrirPdf(a.f);
    const fuentes = {}, imagenes = new Map(), envueltas = new Set(), reemplazos = new Map();
    const borrados = utiles.filter((o) => o.t === "borrar");
    if (borrados.length) {
      const fuenteCapa = await doc.embedFont(L.StandardFonts.Helvetica);
      for (const i of new Set(borrados.map((o) => o.i))) {
        aviso("avisoEd", `Borrando de verdad en la página ${i + 1}…`);
        await pintar();
        const [viejo, nuevo] = await borrarEnPagina(L, doc, a.vista, i, borrados.filter((o) => o.i === i), fuenteCapa);
        reemplazos.set(viejo, nuevo);
      }
    }
    const color = (h) => L.rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);
    for (const o of utiles) {
      if (o.t === "borrar") continue;
      const p = doc.getPage(o.i), [W, H] = tamVisible(p), giro = L.degrees(giroDe(p));
      if (!envueltas.has(o.i)) { envolver(doc, p); envueltas.add(o.i); }
      const en = (vx, vy) => { const [x, y] = aPdf(p, vx, vy); return { x, y }; };
      if (o.t === "texto") {
        const fuente = fuentes[o.negrita] ||= await doc.embedFont(o.negrita ? L.StandardFonts.HelveticaBold : L.StandardFonts.Helvetica);
        lineasDe(o).forEach((linea, k) => {
          if (!linea.trim()) return;
          medirTexto(fuente, linea, o.size);
          // 0.945: de la orilla de arriba del renglón a la línea donde se apoyan las letras (interlínea de 1.2)
          p.drawText(linea, { ...en(o.x * W, H - o.y * H - (0.945 + 1.2 * k) * o.size), size: o.size, font: fuente, color: color(o.color), rotate: giro });
        });
        continue;
      }
      let ancho = o.w * W, alto = o.h * H;
      if (o.t === "imagen") {
        if (!imagenes.has(o.img.f)) imagenes.set(o.img.f, await imagenParaPdf(doc, o.img.f));
        alto = ancho * o.img.h / o.img.w;
      } else if (TRAZOS[o.t]) alto = ancho;
      if (o.t === "trazo") {
        const izq = o.x * W, arriba = H - o.y * H;
        const punto = (q) => en(izq + q[0] / 100 * ancho, arriba - q[1] / 100 * alto);
        for (let k = 1; k < o.puntos.length; k++)
          p.drawLine({ start: punto(o.puntos[k - 1]), end: punto(o.puntos[k]), thickness: o.grosor, color: color(o.color), lineCap: L.LineCapStyle.Round });
        continue;
      }
      const izq = o.x * W, abajo = H - o.y * H - alto, cx = izq + ancho / 2, cy = abajo + alto / 2, g = o.grosor;
      if (o.t === "imagen") p.drawImage(imagenes.get(o.img.f), { ...colocar(L, p, cx, cy, ancho, alto, 0), width: ancho, height: alto });
      else if (o.t === "tapar") p.drawRectangle({ ...colocar(L, p, cx, cy, ancho, alto, 0), width: ancho, height: alto, color: L.rgb(1, 1, 1) });
      else if (o.t === "resaltar") p.drawRectangle({ ...colocar(L, p, cx, cy, ancho, alto, 0), width: ancho, height: alto, color: L.rgb(1, 0.914, 0.302), blendMode: L.BlendMode.Multiply });
      else if (o.t === "rect") {
        const w = Math.max(0.1, ancho - g), h = Math.max(0.1, alto - g);
        p.drawRectangle({ ...colocar(L, p, cx, cy, w, h, 0), width: w, height: h, borderColor: color(o.color), borderWidth: g });
      } else if (o.t === "ovalo") {
        const rx = Math.max(0.1, (ancho - g) / 2), ry = Math.max(0.1, (alto - g) / 2), acostada = giroDe(p) % 180 !== 0;
        p.drawEllipse({ ...en(cx, cy), xScale: acostada ? ry : rx, yScale: acostada ? rx : ry, borderColor: color(o.color), borderWidth: g });
      } else if (o.t === "linea") p.drawLine({ start: en(izq, cy), end: en(izq + ancho, cy), thickness: g, color: color(o.color) });
      else for (const t of TRAZOS[o.t]) for (let k = 1; k < t.length; k++) {
        const punto = (q) => en(izq + q[0] / 100 * ancho, abajo + alto - q[1] / 100 * alto);
        p.drawLine({ start: punto(t[k - 1]), end: punto(t[k]), thickness: g, color: color(o.color), lineCap: L.LineCapStyle.Round });
      }
    }
    if (reemplazos.size) limpiarHuerfanos(L, doc, reemplazos);
    const bytes = await doc.save();
    filaDescarga($("salidaEd"), bytes, sinExt(a.f.name) + " (editado).pdf", `${utiles.length === 1 ? "1 cambio" : utiles.length + " cambios"} en ${paginasTxt(envueltas.size)}`);
    aviso("avisoEd", "Listo. Descarga el PDF aquí abajo; puedes seguir editando y guardar otra vez.");
    $("salidaEd").scrollIntoView({ block: "nearest", behavior: "smooth" });
  } catch (e) {
    aviso("avisoEd", String(e && e.message || e), true);
  } finally {
    $("botonEd").disabled = false;
  }
};

// ---------------------------------------------------------------- 17. herramientas de imagen
// Todo con el propio navegador: createImageBitmap abre la imagen (ya derecha, según la orientación
// que anotó la cámara), un canvas la gira, recorta o cambia de tamaño, y toBlob la guarda en JPG,
// PNG o WebP. Al volver a guardarla se pierden los datos de la cámara (fecha, ubicación).
const MIME = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };
const sabeWebp = (() => { const c = document.createElement("canvas"); c.width = c.height = 1; return c.toDataURL("image/webp").startsWith("data:image/webp"); })();
const sinExtImg = (n) => n.replace(/\.[^.]+$/, "") || n;
const pareceImagen = (f) => f.type.startsWith("image/") || /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif)$/i.test(f.name);
const esHeic = (f) => /\.hei[cf]$/i.test(f.name) || /hei[cf]/.test(f.type);
const pxTxt = (w, h) => `${w} × ${h} px`;
async function formatoDe(f) {
  const b = new Uint8Array(await f.slice(0, 12).arrayBuffer());
  if (b[0] === 0xff && b[1] === 0xd8) return "jpg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e) return "png";
  if (b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "webp";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "gif";
  if (b[0] === 0x42 && b[1] === 0x4d) return "bmp";
  return "otro";            // AVIF, HEIC… cuando el navegador sabe abrirlos
}
// Formato de salida cuando no se pide otro: JPG, PNG y WebP siguen igual; GIF y BMP pasan a PNG; lo demás, a JPG
const mismoFormato = (fmt) => fmt === "webp" ? (sabeWebp ? "webp" : "jpg") : fmt === "jpg" || fmt === "png" ? fmt : fmt === "gif" || fmt === "bmp" ? "png" : "jpg";
async function abrirImagen(f) {
  try { return await createImageBitmap(f, { imageOrientation: "from-image" }); }
  catch {
    throw new Error(esHeic(f) ? `«${f.name}» es HEIC (de iPhone) y no se pudo leer. En el iPhone puedes cambiarlo en Ajustes → Cámara → Formatos → «Más compatible».`
      : `«${f.name}» no se pudo abrir como imagen.`);
  }
}
const lienzoNuevo = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
// La imagen girada (0, 90, 180 o 270 grados a la derecha) y recortada a r (en píxeles de la imagen derecha)
function transformar(mapa, giro = 0, r = null) {
  r ||= { x: 0, y: 0, w: mapa.width, h: mapa.height };
  const deLado = giro % 180 !== 0, c = lienzoNuevo(deLado ? r.h : r.w, deLado ? r.w : r.h), ctx = c.getContext("2d");
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate(giro * Math.PI / 180);
  ctx.drawImage(mapa, r.x, r.y, r.w, r.h, -r.w / 2, -r.h / 2, r.w, r.h);
  return c;
}
// A otro tamaño. Para achicar mucho se va a la mitad varias veces: de un solo golpe salen dientes
function escalar(fuente, W, H) {
  let src = fuente;
  while (src.width / 2 >= W && src.height / 2 >= H) {
    const m = lienzoNuevo(Math.round(src.width / 2), Math.round(src.height / 2)), ctx = m.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, 0, 0, m.width, m.height);
    if (src !== fuente) src.width = 0;           // suelta la memoria del paso anterior
    src = m;
  }
  if (src.width === W && src.height === H) return src;
  const c = lienzoNuevo(W, H), ctx = c.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, W, H);
  if (src !== fuente) src.width = 0;
  return c;
}
async function guardarImagen(c, fmt, calidad = 0.92) {
  if (fmt === "jpg") {               // el JPG no tiene transparencia: lo transparente queda blanco
    const ctx = c.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "destination-over";
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    ctx.globalCompositeOperation = "source-over";
  }
  const blob = await new Promise((ok) => c.toBlob(ok, MIME[fmt], calidad));
  if (!blob || !blob.size) throw new Error(`La imagen de ${pxTxt(c.width, c.height)} es demasiado grande para este navegador.`);
  if (blob.type !== MIME[fmt]) throw new Error(`Este navegador no sabe guardar en ${fmt.toUpperCase()}.`);
  return new Uint8Array(await blob.arrayBuffer());
}

// PNG de hasta 256 colores, como hacen TinyPNG o pngquant. Si la imagen ya tiene 256 colores o
// menos (capturas sencillas, dibujos) se guardan exactos. Si no, se eligen por «corte en la
// mediana» y el error de cada punto se reparte a sus vecinos (Floyd-Steinberg), para que los
// degradados no salgan a rayas.
function cuantizar(d, W, H, maxColores) {
  const n = W * H, d32 = new Uint32Array(d.buffer, d.byteOffset, n);    // cada punto: R | G<<8 | B<<16 | A<<24
  const exactos = new Map();
  let caben = true;
  for (let j = 0; j < n; j++) {
    const v = d32[j] >>> 24 ? d32[j] : 0;        // todo lo transparente cuenta como un solo color
    if (!exactos.has(v)) { if (exactos.size === 256) { caben = false; break; } exactos.set(v, exactos.size); }
  }
  if (caben) {
    const paleta = new Uint8Array(exactos.size * 4), idx = new Uint8Array(n);
    for (const [v, i] of exactos) { paleta[i * 4] = v & 255; paleta[i * 4 + 1] = (v >>> 8) & 255; paleta[i * 4 + 2] = (v >>> 16) & 255; paleta[i * 4 + 3] = v >>> 24; }
    for (let j = 0; j < n; j++) idx[j] = exactos.get(d32[j] >>> 24 ? d32[j] : 0);
    return { paleta, idx };
  }
  // Histograma: 5 bits por color y 4 para la transparencia, con la suma exacta para sacar promedios
  const B = 1 << 19, cuenta = new Uint32Array(B), suma = new Float64Array(B * 4);
  let transparentes = 0;
  for (let i = 0; i < n * 4; i += 4) {
    const a = d[i + 3];
    if (!a) { transparentes++; continue; }
    const k = (d[i] >> 3) << 14 | (d[i + 1] >> 3) << 9 | (d[i + 2] >> 3) << 4 | a >> 4;
    cuenta[k]++; suma[k * 4] += d[i]; suma[k * 4 + 1] += d[i + 1]; suma[k * 4 + 2] += d[i + 2]; suma[k * 4 + 3] += a;
  }
  let m = 0;
  for (let k = 0; k < B; k++) if (cuenta[k]) m++;
  const cnt = new Float64Array(m), col = new Float32Array(m * 4);
  for (let k = 0, q = 0; k < B; k++) if (cuenta[k]) { cnt[q] = cuenta[k]; for (let t = 0; t < 4; t++) col[q * 4 + t] = suma[k * 4 + t] / cuenta[k]; q++; }
  const orden = new Uint32Array(m).map((_, i) => i);
  const caja = (lo, hi) => {         // promedio, eje más disperso y error total de los colores orden[lo..hi)
    let c = 0; const s = [0, 0, 0, 0], s2 = [0, 0, 0, 0];
    for (let p = lo; p < hi; p++) { const q = orden[p], w = cnt[q]; c += w; for (let t = 0; t < 4; t++) { const v = col[q * 4 + t]; s[t] += w * v; s2[t] += w * v * v; } }
    const media = s.map((v) => v / c), varz = s2.map((v, t) => Math.max(0, v / c - media[t] ** 2));
    return { lo, hi, c, media, eje: varz.indexOf(Math.max(...varz)), error: hi - lo > 1 ? (varz[0] + varz[1] + varz[2] + varz[3]) * c : -1 };
  };
  const cajas = [caja(0, m)], lugares = maxColores - (transparentes ? 1 : 0);
  while (cajas.length < lugares) {
    let mejor = 0;
    for (let i = 1; i < cajas.length; i++) if (cajas[i].error > cajas[mejor].error) mejor = i;
    const b = cajas[mejor];
    if (b.error <= 0) break;
    const t = b.eje;
    orden.subarray(b.lo, b.hi).sort((x, y) => col[x * 4 + t] - col[y * 4 + t]);
    let acum = 0, corte = b.hi - 1;
    for (let p = b.lo; p < b.hi - 1; p++) { acum += cnt[orden[p]]; if (acum >= b.c / 2) { corte = p + 1; break; } }
    cajas.splice(mejor, 1, caja(b.lo, corte), caja(corte, b.hi));
  }
  const k = cajas.length, transparente = k, paleta = new Uint8Array((k + (transparentes ? 1 : 0)) * 4);    // el transparente va al final (0, 0, 0, 0)
  cajas.forEach((b, i) => { for (let t = 0; t < 4; t++) paleta[i * 4 + t] = Math.round(b.media[t]); });
  // Cada punto, al color más cercano de la paleta; se recuerda por cuadritos de color para no buscar siempre
  const memoria = new Int16Array(1 << 22).fill(-1);
  const cercano = (r, g, b, a) => {
    const clave = (r >> 2) << 16 | (g >> 2) << 10 | (b >> 2) << 4 | a >> 4;
    let i = memoria[clave];
    if (i < 0) {
      let menor = Infinity;
      for (let p = 0; p < k; p++) {
        const dr = paleta[p * 4] - r, dg = paleta[p * 4 + 1] - g, db = paleta[p * 4 + 2] - b, da = paleta[p * 4 + 3] - a;
        const dist = dr * dr + dg * dg + db * db + da * da;
        if (dist < menor) { menor = dist; i = p; }
      }
      memoria[clave] = i;
    }
    return i;
  };
  const idx = new Uint8Array(n), F = 0.8;       // F: cuánto error se reparte (como pngquant, no todo)
  let esta = new Float32Array((W + 2) * 4), sig = new Float32Array((W + 2) * 4);
  const a255 = (v) => v < 0 ? 0 : v > 255 ? 255 : v | 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const j = y * W + x, i = j * 4, e = (x + 1) * 4;
      if (!d[i + 3]) { idx[j] = transparente; continue; }
      // la transparencia también se reparte, pero solo entre puntos semitransparentes (lo opaco sigue opaco)
      const r = a255(d[i] + esta[e]), g = a255(d[i + 1] + esta[e + 1]), b = a255(d[i + 2] + esta[e + 2]);
      const a = d[i + 3] === 255 ? 255 : Math.max(1, a255(d[i + 3] + esta[e + 3]));
      const p = cercano(r, g, b, a);
      idx[j] = p;
      const er = (r - paleta[p * 4]) * F, eg = (g - paleta[p * 4 + 1]) * F, eb = (b - paleta[p * 4 + 2]) * F, ea = d[i + 3] === 255 ? 0 : (a - paleta[p * 4 + 3]) * F;
      esta[e + 4] += er * 0.4375; esta[e + 5] += eg * 0.4375; esta[e + 6] += eb * 0.4375; esta[e + 7] += ea * 0.4375;   // 7/16 a la derecha
      sig[e - 4] += er * 0.1875; sig[e - 3] += eg * 0.1875; sig[e - 2] += eb * 0.1875; sig[e - 1] += ea * 0.1875;       // 3/16 abajo a la izquierda
      sig[e] += er * 0.3125; sig[e + 1] += eg * 0.3125; sig[e + 2] += eb * 0.3125; sig[e + 3] += ea * 0.3125;           // 5/16 abajo
      sig[e + 4] += er * 0.0625; sig[e + 5] += eg * 0.0625; sig[e + 6] += eb * 0.0625; sig[e + 7] += ea * 0.0625;       // 1/16 abajo a la derecha
    }
    [esta, sig] = [sig, esta];
    sig.fill(0);
  }
  return { paleta, idx };
}
function trozoPng(tipo, datos) {
  const out = new Uint8Array(12 + datos.length), v = new DataView(out.buffer);
  v.setUint32(0, datos.length);
  for (let i = 0; i < 4; i++) out[4 + i] = tipo.charCodeAt(i);
  out.set(datos, 8);
  v.setUint32(8 + datos.length, crc32(out.subarray(4, 8 + datos.length)));
  return out;
}
async function png8(c, maxColores) {
  const W = c.width, H = c.height, { paleta, idx } = cuantizar(c.getContext("2d").getImageData(0, 0, W, H).data, W, H, maxColores);
  const k = paleta.length / 4;
  // Los colores con transparencia van primero, para que la tabla tRNS sea corta
  const orden = [...Array(k).keys()].sort((x, y) => (paleta[x * 4 + 3] === 255) - (paleta[y * 4 + 3] === 255));
  const nuevo = new Uint8Array(k), plte = new Uint8Array(k * 3), trns = [];
  orden.forEach((v, i) => { nuevo[v] = i; plte.set(paleta.subarray(v * 4, v * 4 + 3), i * 3); if (paleta[v * 4 + 3] < 255) trns.push(paleta[v * 4 + 3]); });
  const crudo = new Uint8Array((W + 1) * H);          // cada renglón: filtro 0 y un byte por punto
  for (let y = 0, j = 0; y < H; y++) { let q = y * (W + 1) + 1; for (let x = 0; x < W; x++) crudo[q++] = nuevo[idx[j++]]; }
  const ihdr = new Uint8Array(13), v = new DataView(ihdr.buffer);
  v.setUint32(0, W); v.setUint32(4, H); ihdr[8] = 8; ihdr[9] = 3;          // 8 bits, con paleta
  const partes = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), trozoPng("IHDR", ihdr), trozoPng("PLTE", plte)];
  if (trns.length) partes.push(trozoPng("tRNS", new Uint8Array(trns)));
  partes.push(trozoPng("IDAT", await porTubo(crudo, new CompressionStream("deflate"))), trozoPng("IEND", new Uint8Array(0)));
  return new Uint8Array(await new Blob(partes).arrayBuffer());
}

// Lista de imágenes con miniatura, para las herramientas que trabajan con varias a la vez
// (s: el final de los id de esa vista; dato(x): el texto chico de cada una)
function listaImagenes(s, { girar = false, dato = (x) => `${pxTxt(x.w, x.h)} · ${tamTxt(x.f.size)}`, alCambiar = () => {} } = {}) {
  const items = [], ul = $("lista" + s);
  const yo = {
    items,
    pintar() {
      for (const x of items) {
        x.li.querySelector("small").textContent = x.mala ? (esHeic(x.f) ? "HEIC: este navegador no lo abre" : "No se pudo abrir") : x.w ? dato(x) : "Abriendo…";
        x.li.querySelector("img").style.transform = x.giro ? `rotate(${x.giro}deg)` : "";
      }
      $("boton" + s).disabled = !items.some((x) => !x.mala);
      $("limpiar" + s).hidden = !items.length;
      alCambiar();
    },
  };
  zonaDeArchivos($("zona" + s), $("archivos" + s), (fs) => {
    const buenas = fs.filter(pareceImagen);
    for (const f of buenas) {
      const x = { f, url: URL.createObjectURL(f), giro: 0, w: 0, h: 0, mala: false };
      const li = x.li = document.createElement("li");
      li.innerHTML = `<div class="hoja"><img alt="" decoding="async"></div><div class="dato"><b></b><small></small></div>
        <div class="botones">${girar ? '<button data-a="izq" aria-label="Girar a la izquierda">↺</button><button data-a="der" aria-label="Girar a la derecha">↻</button>' : ""}<button data-a="quitar" aria-label="Quitar">✕</button></div>`;
      li.title = f.name;
      li.querySelector("b").textContent = f.name;
      const img = li.querySelector("img");
      img.onload = () => { x.w = img.naturalWidth; x.h = img.naturalHeight; yo.pintar(); };
      img.onerror = () => { x.mala = true; li.classList.add("mala"); yo.pintar(); };
      img.src = x.url;
      li.onclick = (e) => {
        const a = e.target.closest("button")?.dataset.a;
        if (a === "izq" || a === "der") { x.giro = (x.giro + (a === "izq" ? 270 : 90)) % 360; aviso("aviso" + s, ""); }
        else if (a === "quitar") { items.splice(items.indexOf(x), 1); li.remove(); URL.revokeObjectURL(x.url); }
        else return;
        yo.pintar();
      };
      items.push(x);
      ul.append(li);
    }
    yo.pintar();
    aviso("aviso" + s, buenas.length < fs.length ? "Solo se agregan imágenes." : "", buenas.length < fs.length);
  });
  $("limpiar" + s).onclick = () => {
    for (const x of items) URL.revokeObjectURL(x.url);
    items.length = 0; ul.textContent = ""; $("salida" + s).textContent = "";
    yo.pintar(); aviso("aviso" + s, "");
  };
  return yo;
}
// Hace hacer(x) con cada imagen y entrega lo hecho: una fila por imagen (hasta 12) y, si son
// varias, un .zip con todas. hacer devuelve { nombre, bytes, tipo, detalle }.
async function procesarLista(s, lista, hacer, nombreZip, resumen = null) {
  const boton = $("boton" + s), salida = $("salida" + s), buenas = lista.items.filter((x) => !x.mala);
  const hechas = [], fallas = lista.items.filter((x) => x.mala).map((x) => `«${x.f.name}» no se pudo abrir.`), usados = new Set();
  boton.disabled = true;
  salida.textContent = "";
  try {
    for (const [k, x] of buenas.entries()) {
      aviso("aviso" + s, buenas.length > 1 ? `Imagen ${k + 1} de ${buenas.length}…` : "Trabajando…");
      await pintar();
      try {
        const h = await hacer(x);
        let nombre = h.nombre, i = 2;
        while (usados.has(nombre.toLowerCase())) nombre = h.nombre.replace(/(\.[^.]+)$/, ` (${i++})$1`);
        usados.add(nombre.toLowerCase());
        hechas.push({ ...h, nombre });
      } catch (e) { fallas.push(String(e && e.message || e)); }
    }
    if (hechas.length <= 12) for (const h of [...hechas].reverse()) filaDescarga(salida, h.bytes, h.nombre, h.detalle, h.tipo);
    if (hechas.length > 1) filaDescarga(salida, zipSimple(hechas), nombreZip, `${hechas.length} imágenes`, "application/zip");
    const n = hechas.length;
    const bien = !n ? "" : resumen ? resumen(hechas) : n === 1 ? "Listo." : `Listo: ${n} imágenes${n > 12 ? ", juntas en un .zip" : ""}.`;
    aviso("aviso" + s, [bien, fallas.length ? `No se pudo con ${fallas.length === 1 ? "una" : fallas.length}: ${fallas.join(" ")}` : ""].filter(Boolean).join(" "), fallas.length > 0);
    if (n) salida.scrollIntoView({ block: "nearest", behavior: "smooth" });
  } finally {
    boton.disabled = !lista.items.some((x) => !x.mala);
  }
}

// ---- comprimir imagen
const NIVELES_IMG = { ligera: { calidad: 0.85, colores: 256, lado: 0 }, media: { calidad: 0.72, colores: 192, lado: 0 }, maxima: { calidad: 0.55, colores: 96, lado: 2048 } };
const listaCI = listaImagenes("CI");
$("botonCI").onclick = () => {
  const nivel = NIVELES_IMG[document.querySelector('input[name="nivelCI"]:checked').value];
  let antes = 0, despues = 0;
  procesarLista("CI", listaCI, async (x) => {
    const fmt = mismoFormato(await formatoDe(x.f)), mapa = await abrirImagen(x.f);
    let c = transformar(mapa);
    mapa.close();
    const e = nivel.lado ? Math.min(1, nivel.lado / Math.max(c.width, c.height)) : 1;
    if (e < 1) c = escalar(c, Math.max(1, Math.round(c.width * e)), Math.max(1, Math.round(c.height * e)));
    let bytes = fmt === "png" ? await png8(c, nivel.colores) : await guardarImagen(c, fmt, nivel.calidad);
    const px = pxTxt(c.width, c.height);
    c.width = 0;
    const igual = e === 1 && bytes.length > x.f.size * 0.95;       // casi no bajó: se deja la original
    if (igual) bytes = new Uint8Array(await x.f.arrayBuffer());
    antes += x.f.size; despues += bytes.length;
    return igual ? { nombre: x.f.name, bytes, tipo: x.f.type || MIME[fmt], detalle: "Ya estaba comprimida; se deja igual" }
      : { nombre: `${sinExtImg(x.f.name)} (comprimida).${fmt}`, bytes, tipo: MIME[fmt], detalle: `${px} · antes ${tamTxt(x.f.size)}, ${Math.min(99, Math.round((1 - bytes.length / x.f.size) * 100))} % menos` };
  }, "imágenes comprimidas.zip", () => `Listo: de ${tamTxt(antes)} a ${tamTxt(despues)} (${Math.max(0, Math.round((1 - despues / antes) * 100))} % menos).`);
};

// ---- cambiar tamaño
function medidasTI(w, h) {
  let W, H;
  if ($("modoTI").value === "porcentaje") {
    const p = Number($("porcTI").value) / 100;
    if (!(p > 0)) return null;
    W = w * p; H = h * p;
  } else {
    const a = Number($("anchoTI").value) || 0, b = Number($("altoTI").value) || 0, prop = $("propTI").checked;
    if (a <= 0 && b <= 0) return null;
    if (prop) { const e = Math.min(a > 0 ? a / w : Infinity, b > 0 ? b / h : Infinity); W = w * e; H = h * e; }
    else { W = a > 0 ? a : w; H = b > 0 ? b : h; }
    if ($("noAgrandarTI").checked && (W > w || H > h)) [W, H] = prop ? [w, h] : [Math.min(W, w), Math.min(H, h)];
  }
  return [Math.max(1, Math.round(W)), Math.max(1, Math.round(H))];
}
const listaTI = listaImagenes("TI", { dato: (x) => { const m = medidasTI(x.w, x.h); return m ? `${x.w}×${x.h} → ${m[0]}×${m[1]}` : pxTxt(x.w, x.h); } });
function verModoTI() {
  const pct = $("modoTI").value === "porcentaje";
  $("campoPorcTI").hidden = !pct;
  $("campoAnchoTI").hidden = $("campoAltoTI").hidden = $("casillasTI").hidden = pct;
  listaTI.pintar();
}
$("modoTI").onchange = verModoTI;
for (const id of ["anchoTI", "altoTI", "porcTI", "propTI", "noAgrandarTI"]) $(id).addEventListener("input", () => listaTI.pintar());
$("botonTI").onclick = () => {
  if (!medidasTI(100, 100)) { aviso("avisoTI", $("modoTI").value === "porcentaje" ? "Escribe el porcentaje." : "Escribe el ancho, el alto o los dos.", true); return; }
  procesarLista("TI", listaTI, async (x) => {
    const fmt = mismoFormato(await formatoDe(x.f)), mapa = await abrirImagen(x.f);
    const [W, H] = medidasTI(mapa.width, mapa.height);
    if (W * H > 1e8 || W > 30000 || H > 30000) { mapa.close(); throw new Error(`«${x.f.name}» quedaría de ${pxTxt(W, H)}: es demasiado grande.`); }
    let c = transformar(mapa);
    mapa.close();
    c = escalar(c, W, H);
    const bytes = await guardarImagen(c, fmt);
    c.width = 0;
    return { nombre: `${sinExtImg(x.f.name)} (${W}×${H}).${fmt}`, bytes, tipo: MIME[fmt], detalle: pxTxt(W, H) };
  }, "imágenes (nuevo tamaño).zip");
};

// ---- recortar imagen
// El recuadro se guarda como fracción de la imagen (x, y de su esquina de arriba a la izquierda)
let paraRecortar = null;                        // { f, w, h, url } (w y h: la imagen derecha, en píxeles)
const rec = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 }, MIN_REC = 0.03;
function proporcionRI() {                        // ancho ÷ alto del recuadro, medidos en fracciones de la imagen (0 = libre)
  const v = $("formaRI").value;
  if (v === "libre" || !paraRecortar) return 0;
  const [a, b] = v.split(":").map(Number);
  return a / b * paraRecortar.h / paraRecortar.w;
}
function pintarRecorte() {
  for (const el of [$("cajaRI"), $("huecoRI")]) Object.assign(el.style, { left: rec.x * 100 + "%", top: rec.y * 100 + "%", width: rec.w * 100 + "%", height: rec.h * 100 + "%" });
  if (paraRecortar) $("medidaRI").textContent = pxTxt(Math.round(rec.w * paraRecortar.w), Math.round(rec.h * paraRecortar.h));
}
function recuadroInicial() {
  const k = proporcionRI(), w = k ? Math.min(0.8, 0.8 * k) : 0.8, h = k ? w / k : 0.8;
  Object.assign(rec, { w, h, x: (1 - w) / 2, y: (1 - h) / 2 });
  pintarRecorte();
}
$("formaRI").onchange = recuadroInicial;
arrastrar($("cajaRI"), () => ({ ...rec }), (dx, dy, ini) => {
  rec.x = entre(ini.x + dx, 0, 1 - rec.w); rec.y = entre(ini.y + dy, 0, 1 - rec.h);
  pintarRecorte();
}, $("mesaRI"));
for (const asa of $("cajaRI").querySelectorAll(".asa")) {
  const izq = asa.dataset.e.includes("w"), arriba = asa.dataset.e.includes("n");
  arrastrar(asa, () => ({ ...rec }), (dx, dy, ini) => {
    const fx = izq ? ini.x + ini.w : ini.x, fy = arriba ? ini.y + ini.h : ini.y;      // la esquina contraria no se mueve
    const maxW = izq ? fx : 1 - fx, maxH = arriba ? fy : 1 - fy, k = proporcionRI();
    let w = izq ? ini.w - dx : ini.w + dx, h = arriba ? ini.h - dy : ini.h + dy;
    if (k) {
      if (Math.abs(w - ini.w) / ini.w >= Math.abs(h - ini.h) / ini.h) h = w / k; else w = h * k;    // manda el lado que más se movió
      if (w < MIN_REC) { w = MIN_REC; h = w / k; }
      if (h < MIN_REC) { h = MIN_REC; w = h * k; }
      if (w > maxW) { w = maxW; h = w / k; }
      if (h > maxH) { h = maxH; w = h * k; }
    } else {
      w = entre(w, MIN_REC, maxW); h = entre(h, MIN_REC, maxH);
    }
    Object.assign(rec, { w, h, x: izq ? fx - w : fx, y: arriba ? fy - h : fy });
    pintarRecorte();
  }, $("mesaRI"));
}
zonaDeArchivos($("zonaRI"), $("archivoRI"), async (fs) => {
  const f = fs.find(pareceImagen);
  if (!f) { $("infoRI").textContent = "Ese archivo no es una imagen."; return; }
  $("infoRI").textContent = "Abriendo…";
  try {
    const mapa = await abrirImagen(f), w = mapa.width, h = mapa.height;
    mapa.close();
    if (paraRecortar) URL.revokeObjectURL(paraRecortar.url);
    paraRecortar = { f, w, h, url: URL.createObjectURL(f) };
    $("imgRI").src = paraRecortar.url;
    await $("imgRI").decode().catch(() => {});
    $("infoRI").textContent = `${f.name} · ${pxTxt(w, h)}`;
    $("opcionesRI").hidden = false;
    aviso("avisoRI", "");
    recuadroInicial();
  } catch (e) {
    paraRecortar = null;
    $("opcionesRI").hidden = true;
    $("infoRI").textContent = String(e && e.message || e);
  }
});
$("botonRI").onclick = async () => {
  const a = paraRecortar;
  if (!a) return;
  $("botonRI").disabled = true;
  try {
    aviso("avisoRI", "Recortando…");
    await pintar();
    const fmt = mismoFormato(await formatoDe(a.f)), mapa = await abrirImagen(a.f);
    const x = Math.round(rec.x * mapa.width), y = Math.round(rec.y * mapa.height);
    const r = { x, y, w: entre(Math.round(rec.w * mapa.width), 1, mapa.width - x), h: entre(Math.round(rec.h * mapa.height), 1, mapa.height - y) };
    const c = transformar(mapa, 0, r);
    mapa.close();
    const bytes = await guardarImagen(c, fmt);
    c.width = 0;
    filaDescarga($("salidaRI"), bytes, `${sinExtImg(a.f.name)} (recortada).${fmt}`, pxTxt(r.w, r.h), MIME[fmt]);
    aviso("avisoRI", "Listo. Puedes mover el recuadro y recortar otra vez.");
    $("salidaRI").scrollIntoView({ block: "nearest", behavior: "smooth" });
  } catch (e) {
    aviso("avisoRI", String(e && e.message || e), true);
  } finally {
    $("botonRI").disabled = false;
  }
};

// ---- convertir imagen
if (!sabeWebp) { const o = $("formatoVI").querySelector('[value="webp"]'); o.disabled = true; o.textContent += " (no en este navegador)"; }
const listaVI = listaImagenes("VI");
$("botonVI").onclick = () => {
  const fmt = $("formatoVI").value;
  procesarLista("VI", listaVI, async (x) => {
    const mapa = await abrirImagen(x.f), c = transformar(mapa);
    mapa.close();
    const bytes = await guardarImagen(c, fmt), px = pxTxt(c.width, c.height);
    c.width = 0;
    return { nombre: `${sinExtImg(x.f.name)}.${fmt}`, bytes, tipo: MIME[fmt], detalle: px };
  }, `imágenes en ${fmt.toUpperCase()}.zip`);
};

// ---- girar imagen
const LADOS = { 90: "a la derecha", 180: "de cabeza", 270: "a la izquierda" };
const listaGI = listaImagenes("GI", { girar: true, dato: (x) => x.giro ? `Girada ${LADOS[x.giro]}` : pxTxt(x.w, x.h), alCambiar: () => { $("todasGI").hidden = !listaGI.items.length; } });
for (const [id, paso] of [["todasIzqGI", 270], ["todasDerGI", 90]]) $(id).onclick = () => { for (const x of listaGI.items) x.giro = (x.giro + paso) % 360; listaGI.pintar(); aviso("avisoGI", ""); };
$("botonGI").onclick = () => {
  if (!listaGI.items.some((x) => x.giro && !x.mala)) { aviso("avisoGI", "Primero gira al menos una imagen con ↺ o ↻.", true); return; }
  procesarLista("GI", listaGI, async (x) => {
    if (!x.giro) return { nombre: x.f.name, bytes: new Uint8Array(await x.f.arrayBuffer()), tipo: x.f.type, detalle: "Sin cambios" };
    const fmt = mismoFormato(await formatoDe(x.f)), mapa = await abrirImagen(x.f), c = transformar(mapa, x.giro);
    mapa.close();
    const bytes = await guardarImagen(c, fmt), px = pxTxt(c.width, c.height);
    c.width = 0;
    return { nombre: `${sinExtImg(x.f.name)} (girada).${fmt}`, bytes, tipo: MIME[fmt], detalle: `${px} · girada ${LADOS[x.giro]}` };
  }, "imágenes giradas.zip");
};

// ---------------------------------------------------------------- 18. escanear documento
// Como Adobe Scan: en una foto de una hoja se buscan sus orillas, se endereza (perspectiva) y se
// «blanquea» el papel. Todo con los pixeles de un canvas (px = RGBA, w × h).

// Las 4 esquinas de la hoja [arriba-izq, arriba-der, abajo-der, abajo-izq] como fracción de la foto,
// o null si no se encontró. Se busca en una foto chica (unos 500 px): el papel es la mancha clara y
// sin color que está en el centro; luego cada orilla es la recta que mejor sigue su borde.
function detectarHoja(px, w, h) {
  const n = w * h, L = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = (px[i * 4] + px[i * 4 + 1] + px[i * 4 + 2]) / 3;
  // color del papel: lo más claro del centro de la foto
  const cen = [];
  for (let y = Math.floor(h * 0.3); y < h * 0.7; y++) for (let x = Math.floor(w * 0.3); x < w * 0.7; x++) cen.push(y * w + x);
  const orden = cen.map((i) => L[i]).sort((a, b) => a - b), corte = orden[Math.floor(orden.length * 0.6)];
  let R = 0, G = 0, B = 0, k = 0;
  for (const i of cen) if (L[i] >= corte) { R += px[i * 4]; G += px[i * 4 + 1]; B += px[i * 4 + 2]; k++; }
  R /= k; G /= k; B /= k;
  const refL = (R + G + B) / 3, sR = R / (R + G + B), sG = G / (R + G + B), sB = B / (R + G + B);
  if (refL < 60) return null;
  const papel = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2], s = r + g + b + 1;
    const d = Math.abs(r / s - sR) + Math.abs(g / s - sG) + Math.abs(b / s - sB);
    papel[i] = L[i] > refL * 0.55 && d < 0.075 ? 1 : 0;
  }
  // la mancha de papel que toca el centro
  const hoja = new Uint8Array(n), cola = new Int32Array(n);
  let ini = 0, fin = 0;
  for (let y = Math.floor(h * 0.45); y < h * 0.55; y++) for (let x = Math.floor(w * 0.45); x < w * 0.55; x++) {
    const i = y * w + x;
    if (papel[i] && !hoja[i]) { hoja[i] = 1; cola[fin++] = i; }
  }
  while (ini < fin) {
    const i = cola[ini++], x = i % w;
    for (const j of [i - w, i + w, x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1]) if (j >= 0 && j < n && papel[j] && !hoja[j]) { hoja[j] = 1; cola[fin++] = j; }
  }
  // tapar sus agujeros (letras, sellos): es hoja todo lo que no se alcanza desde la orilla de la foto
  const fuera = new Uint8Array(n);
  ini = fin = 0;
  for (let x = 0; x < w; x++) for (const i of [x, (h - 1) * w + x]) if (!hoja[i] && !fuera[i]) { fuera[i] = 1; cola[fin++] = i; }
  for (let y = 0; y < h; y++) for (const i of [y * w, y * w + w - 1]) if (!hoja[i] && !fuera[i]) { fuera[i] = 1; cola[fin++] = i; }
  while (ini < fin) {
    const i = cola[ini++], x = i % w;
    for (const j of [i - w, i + w, x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1]) if (j >= 0 && j < n && !hoja[j] && !fuera[j]) { fuera[j] = 1; cola[fin++] = j; }
  }
  let area = 0;
  for (let i = 0; i < n; i++) if (!fuera[i]) area++;
  if (area < n * 0.12) return null;
  const dentro = (x, y) => !fuera[y * w + x];
  // esquinas aproximadas: los puntos más lejanos en diagonal
  let e = [[0, 0, Infinity], [0, 0, -Infinity], [0, 0, -Infinity], [0, 0, Infinity]];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (dentro(x, y)) {
    if (x + y < e[0][2]) e[0] = [x, y, x + y];
    if (x - y > e[1][2]) e[1] = [x, y, x - y];
    if (x + y > e[2][2]) e[2] = [x, y, x + y];
    if (x - y < e[3][2]) e[3] = [x, y, x - y];
  }
  // cada orilla: el primer pixel de hoja visto desde afuera, en el tramo de en medio entre sus esquinas
  const recta = (puntos) => {          // v = a·u + b, quitando los puntos que se salen (dobleces, dedos)
    let usar = puntos, a = 0, b = 0;
    for (let vuelta = 0; vuelta < 4; vuelta++) {
      if (usar.length < 5) break;
      let su = 0, sv = 0, suu = 0, suv = 0;
      for (const [u, v] of usar) { su += u; sv += v; suu += u * u; suv += u * v; }
      const m = usar.length, det = m * suu - su * su;
      a = det ? (m * suv - su * sv) / det : 0; b = (sv - a * su) / m;
      const res = puntos.map(([u, v]) => Math.abs(v - a * u - b)), med = [...res].sort((p, q) => p - q)[Math.floor(res.length / 2)];
      usar = puntos.filter((_, j) => res[j] <= Math.max(1.5, med * 2.5));
    }
    return [a, b];
  };
  const tramo = (p, q) => { const lo = Math.min(p, q), hi = Math.max(p, q), m = (hi - lo) * 0.12; return [Math.ceil(lo + m), Math.floor(hi - m)]; };
  const lados = [];
  { const [a, b] = tramo(e[0][0], e[1][0]), pts = []; for (let x = a; x <= b; x++) for (let y = 0; y < h; y++) if (dentro(x, y)) { pts.push([x, y]); break; } lados.push(recta(pts)); }
  { const [a, b] = tramo(e[1][1], e[2][1]), pts = []; for (let y = a; y <= b; y++) for (let x = w - 1; x >= 0; x--) if (dentro(x, y)) { pts.push([y, x + 1]); break; } lados.push(recta(pts)); }
  { const [a, b] = tramo(e[3][0], e[2][0]), pts = []; for (let x = a; x <= b; x++) for (let y = h - 1; y >= 0; y--) if (dentro(x, y)) { pts.push([x, y + 1]); break; } lados.push(recta(pts)); }
  { const [a, b] = tramo(e[0][1], e[3][1]), pts = []; for (let y = a; y <= b; y++) for (let x = 0; x < w; x++) if (dentro(x, y)) { pts.push([y, x]); break; } lados.push(recta(pts)); }
  // cruce de una orilla horizontal (y = a·x + b) con una vertical (x = c·y + d)
  const cruce = ([a, b], [c, d]) => { const x = (c * b + d) / (1 - a * c); return [x, a * x + b]; };
  const [arr, der, aba, izq] = lados;
  let esq = [cruce(arr, izq), cruce(arr, der), cruce(aba, der), cruce(aba, izq)];
  // un poquito hacia adentro, para no dejar una rayita de lo que hay debajo de la hoja
  const cx = esq.reduce((s, p) => s + p[0], 0) / 4, cy = esq.reduce((s, p) => s + p[1], 0) / 4;
  esq = esq.map(([x, y]) => [x + (cx - x) * 0.008, y + (cy - y) * 0.008]);
  return esq.map(([x, y]) => [Math.min(1, Math.max(0, x / w)), Math.min(1, Math.max(0, y / h))]);
}

// La homografía que lleva los 4 puntos «de» a los 4 puntos «a» (matriz de 3 × 3 en un arreglo de 9)
function homografia(de, a) {
  const M = [], v = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = de[i], [u, w] = a[i];
    M.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); v.push(u);
    M.push([0, 0, 0, x, y, 1, -w * x, -w * y]); v.push(w);
  }
  for (let c = 0; c < 8; c++) {          // Gauss con pivote
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]]; [v[c], v[p]] = [v[p], v[c]];
    for (let r = 0; r < 8; r++) if (r !== c) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k < 8; k++) M[r][k] -= f * M[c][k];
      v[r] -= f * v[c];
    }
  }
  return [...v.map((x, i) => x / M[i][i]), 1];
}

// Medida natural de la hoja enderezada (en pixeles de la foto) a partir de sus esquinas en pixeles
function medidaHoja(q) {
  const d = (p, r) => Math.hypot(p[0] - r[0], p[1] - r[1]);
  return [Math.max(d(q[0], q[1]), d(q[3], q[2])), Math.max(d(q[0], q[3]), d(q[1], q[2]))];
}

// La hoja enderezada: cada pixel de salida (ow × oh) se toma de la foto (sw × sh) con interpolación bilineal
function enderezar(src, sw, sh, q, ow, oh) {
  const H = homografia([[0, 0], [ow, 0], [ow, oh], [0, oh]], q), out = new Uint8ClampedArray(ow * oh * 4);
  for (let y = 0; y < oh; y++) {
    const yy = y + 0.5;
    for (let x = 0; x < ow; x++) {
      const xx = x + 0.5, z = H[6] * xx + H[7] * yy + 1;
      let fx = (H[0] * xx + H[1] * yy + H[2]) / z - 0.5, fy = (H[3] * xx + H[4] * yy + H[5]) / z - 0.5;
      fx = fx < 0 ? 0 : fx > sw - 1.001 ? sw - 1.001 : fx; fy = fy < 0 ? 0 : fy > sh - 1.001 ? sh - 1.001 : fy;
      const x0 = fx | 0, y0 = fy | 0, ax = fx - x0, ay = fy - y0, i = (y0 * sw + x0) * 4, j = i + sw * 4, o = (y * ow + x) * 4;
      for (let c = 0; c < 3; c++) {
        const s = src[i + c] + (src[i + 4 + c] - src[i + c]) * ax, t = src[j + c] + (src[j + 4 + c] - src[j + c]) * ax;
        out[o + c] = s + (t - s) * ay;
      }
      out[o + 3] = 255;
    }
  }
  return out;
}

// Filtro de documento: se calcula de qué color se ve el papel en cada zona (la luz nunca es pareja)
// y se divide entre él, así el papel queda blanco y la tinta conserva su color; luego más contraste.
// modo: "color", "gris", "bn" (blanco y negro) o "" (sin filtro)
function filtroDocumento(px, w, h, modo) {
  if (!modo) return;
  const B = Math.max(8, Math.round(Math.max(w, h) / 80)), bw = Math.ceil(w / B), bh = Math.ceil(h / B);
  const fondo = [new Float32Array(bw * bh), new Float32Array(bw * bh), new Float32Array(bw * bh)];
  const hist = new Uint32Array(256);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    hist.fill(0);
    const x1 = Math.min(w, bx * B + B), y1 = Math.min(h, by * B + B);
    let m = 0;
    for (let y = by * B; y < y1; y++) for (let x = bx * B; x < x1; x++) { const i = (y * w + x) * 4; hist[(px[i] + px[i + 1] + px[i + 2]) / 3 | 0]++; m++; }
    let corte = 255, acum = 0;
    while (corte > 0 && (acum += hist[corte]) < m * 0.1) corte--;          // lo más claro: el papel
    let r = 0, g = 0, b = 0, k = 0;
    for (let y = by * B; y < y1; y++) for (let x = bx * B; x < x1; x++) {
      const i = (y * w + x) * 4;
      if ((px[i] + px[i + 1] + px[i + 2]) / 3 >= corte) { r += px[i]; g += px[i + 1]; b += px[i + 2]; k++; }
    }
    const j = by * bw + bx;
    fondo[0][j] = r / k; fondo[1][j] = g / k; fondo[2][j] = b / k;
  }
  // las zonas sin papel (logotipos, sellos, tablas llenas) son más oscuras que una superficie suave
  // que pasa por las demás: se ajusta una superficie de grado 2 quitando las que quedan muy abajo
  const nb = bw * bh, usa = new Uint8Array(nb).fill(1), sup = [new Float32Array(nb), new Float32Array(nb), new Float32Array(nb)];
  const base = (j) => { const x = (j % bw) / bw - 0.5, y = Math.floor(j / bw) / bh - 0.5; return [1, x, y, x * x, x * y, y * y]; };
  for (let vuelta = 0; vuelta < 5; vuelta++) {
    for (let c = 0; c < 3; c++) {
      const A = Array.from({ length: 6 }, () => new Float64Array(7));
      for (let j = 0; j < nb; j++) if (usa[j]) {
        const f = base(j);
        for (let p = 0; p < 6; p++) { for (let q = 0; q < 6; q++) A[p][q] += f[p] * f[q]; A[p][6] += f[p] * fondo[c][j]; }
      }
      for (let p = 0; p < 6; p++) A[p][p] += 1e-6;
      for (let p = 0; p < 6; p++) for (let r = 0; r < 6; r++) if (r !== p) { const f = A[r][p] / A[p][p]; for (let q = p; q < 7; q++) A[r][q] -= f * A[p][q]; }
      const co = A.map((fila, p) => fila[6] / fila[p]);
      for (let j = 0; j < nb; j++) { const f = base(j); let s = 0; for (let p = 0; p < 6; p++) s += co[p] * f[p]; sup[c][j] = s; }
    }
    for (let j = 0; j < nb; j++) {
      const l = (fondo[0][j] + fondo[1][j] + fondo[2][j]) / 3, s = (sup[0][j] + sup[1][j] + sup[2][j]) / 3;
      usa[j] = l > s * 0.9 ? 1 : 0;
    }
  }
  // zona con papel: su propio color (sigue sombras locales); sin papel: la superficie. Luego se suaviza.
  for (let c = 0; c < 3; c++) {
    const t = new Float32Array(nb);
    for (let j = 0; j < nb; j++) t[j] = usa[j] ? Math.max(fondo[c][j], sup[c][j] * 0.9) : sup[c][j];
    for (let j = 0; j < nb; j++) {
      const bx = j % bw, by = Math.floor(j / bw);
      let s = 0, k = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const x = bx + dx, y = by + dy;
        if (x >= 0 && y >= 0 && x < bw && y < bh) { s += t[y * bw + x]; k++; }
      }
      fondo[c][j] = Math.max(30, s / k);
    }
  }
  // curva: el papel (≥ 93 % de su fondo) queda blanco; lo que baje de 30 %, negro; en medio, oscurecido
  // (así las marcas de agua tenues se siguen viendo)
  const curva = new Uint8Array(1001);
  for (let i = 0; i <= 1000; i++) { const t = Math.min(1, Math.max(0, (i / 1000 - 0.3) / (0.93 - 0.3))); curva[i] = Math.round(255 * Math.pow(t, 1.35)); }
  const val = (v) => curva[v >= 1 ? 1000 : v <= 0 ? 0 : (v * 1000) | 0];
  const f0 = fondo[0], f1 = fondo[1], f2 = fondo[2];
  for (let y = 0; y < h; y++) {
    const gy = Math.min(bh - 1, Math.max(0, (y + 0.5) / B - 0.5)), y0 = Math.min(bh - 2, gy | 0), ay = bh > 1 ? gy - y0 : 0, r0 = Math.max(0, y0) * bw, r1 = Math.min(bh - 1, y0 + 1) * bw;
    for (let x = 0; x < w; x++) {
      const gx = Math.min(bw - 1, Math.max(0, (x + 0.5) / B - 0.5)), x0 = Math.min(bw - 2, gx | 0), ax = bw > 1 ? gx - x0 : 0, c0 = Math.max(0, x0), c1 = Math.min(bw - 1, x0 + 1);
      const fb = (f) => (f[r0 + c0] * (1 - ax) + f[r0 + c1] * ax) * (1 - ay) + (f[r1 + c0] * (1 - ax) + f[r1 + c1] * ax) * ay;
      const i = (y * w + x) * 4, r = px[i] / fb(f0), g = px[i + 1] / fb(f1), b = px[i + 2] / fb(f2);
      if (modo === "color") {
        // la tinta de color (firmas azules, sellos) se aviva un poco
        const Y = 0.299 * r + 0.587 * g + 0.114 * b, k = 1.5;
        px[i] = val(Y + (r - Y) * k); px[i + 1] = val(Y + (g - Y) * k); px[i + 2] = val(Y + (b - Y) * k);
      } else {
        const Y = 0.299 * r + 0.587 * g + 0.114 * b, v = modo === "bn" ? (Y < 0.68 ? 0 : 255) : val(Y);
        px[i] = px[i + 1] = px[i + 2] = v;
      }
    }
  }
}

// ---- la herramienta
// Cada foto: se abre una vez para hacer su vista (≤ 1400 px, para el editor) y buscar la hoja en
// una copia de 500 px. Al crear el PDF se vuelve a abrir y se achica solo lo necesario para que la
// hoja enderezada salga de ≤ 3300 px de lado (unos 300 ppp en carta, como Adobe Scan).
const ESQ_TODA = [[0, 0], [1, 0], [1, 1], [0, 1]], ESQ_DEFECTO = [[0.06, 0.06], [0.94, 0.06], [0.94, 0.94], [0.06, 0.94]];
let selES = null, buscandoES = false;
const listaES = listaImagenes("ES", {
  girar: true,
  dato: (x) => x.falla ? x.falla : !x.esq ? "Buscando la hoja…" : x.encontrada ? (x.giro ? `Hoja encontrada · girada ${LADOS[x.giro]}` : "Hoja encontrada") : "Acomoda las esquinas",
  alCambiar: () => {
    if (selES && !listaES.items.includes(selES)) selES = null;
    if (!selES && listaES.items.length) elegirES(listaES.items.find((x) => x.esq) || null);
    for (const x of listaES.items) x.li.classList.toggle("elegida", x === selES);
    $("editorES").hidden = !selES;
    $("opcionesES").hidden = !listaES.items.length;
    buscarHojas();
  },
});
async function buscarHojas() {
  if (buscandoES) return;
  buscandoES = true;
  try {
    for (let x; (x = listaES.items.find((y) => !y.esq && !y.mala && !y.falla));) {
      try {
        const mapa = await abrirImagen(x.f);
        x.W = mapa.width; x.H = mapa.height;
        const e = Math.min(1, 1400 / Math.max(x.W, x.H)), vista = escalar(mapa, Math.round(x.W * e), Math.round(x.H * e));
        const lienzo = vista instanceof HTMLCanvasElement ? vista : (() => { const c = lienzoNuevo(vista.width, vista.height); c.getContext("2d").drawImage(vista, 0, 0); return c; })();
        mapa.close();
        x.vista = URL.createObjectURL(await new Promise((ok) => lienzo.toBlob(ok, "image/jpeg", 0.85)));
        const e2 = Math.min(1, 500 / Math.max(lienzo.width, lienzo.height)), chico = escalar(lienzo, Math.max(1, Math.round(lienzo.width * e2)), Math.max(1, Math.round(lienzo.height * e2)));
        const datos = chico.getContext("2d").getImageData(0, 0, chico.width, chico.height).data;
        const esq = detectarHoja(datos, chico.width, chico.height);
        lienzo.width = 0; if (chico !== lienzo) chico.width = 0;
        x.encontrada = !!esq;
        x.esq = esq || ESQ_DEFECTO.map((p) => [...p]);
        x.esqAuto = x.esq.map((p) => [...p]);
      } catch (e) {
        x.falla = String(e && e.message || e).length > 60 ? "No se pudo abrir" : String(e && e.message || e);
      }
      if (!selES && x.esq) elegirES(x);
      listaES.pintar();
      await pintar();
    }
  } finally { buscandoES = false; }
}
function elegirES(x) {
  selES = x;
  if (!x) return;
  if ($("imgES").dataset.url !== x.vista) { $("imgES").src = x.vista; $("imgES").dataset.url = x.vista; }
  $("ayudaES").textContent = x.encontrada ? "Revisa que los 4 puntos estén en las esquinas de la hoja; si no, arrástralos." : "No encontré la orilla de la hoja: arrastra los 4 puntos a sus esquinas.";
  pintarEsqES();
}
function pintarEsqES() {
  if (!selES) return;
  const q = selES.esq, pts = q.map(([x, y]) => `${x} ${y}`);
  $("fueraES").setAttribute("d", `M0 0H1V1H0Z M${pts.join(" L")} Z`);
  $("bordeES").setAttribute("points", pts.join(" "));
  $("mesaES").querySelectorAll(".escaner-esquina").forEach((el, i) => { el.style.left = q[i][0] * 100 + "%"; el.style.top = q[i][1] * 100 + "%"; });
}
$("listaES").addEventListener("click", (e) => {
  const li = e.target.closest("li");
  if (!li || e.target.closest("button")) return;
  const x = listaES.items.find((y) => y.li === li);
  if (x && x.esq) { elegirES(x); listaES.pintar(); $("editorES").scrollIntoView({ block: "nearest", behavior: "smooth" }); }
});
$("mesaES").querySelectorAll(".escaner-esquina").forEach((el) => {
  const i = Number(el.dataset.i);
  arrastrar(el, () => [...selES.esq[i]], (dx, dy, ini) => { selES.esq[i] = [entre(ini[0] + dx, 0, 1), entre(ini[1] + dy, 0, 1)]; pintarEsqES(); }, $("mesaES"));
});
$("todaES").onclick = () => { if (selES) { selES.esq = ESQ_TODA.map((p) => [...p]); pintarEsqES(); } };
$("buscarES").onclick = () => { if (selES) { selES.esq = selES.esqAuto.map((p) => [...p]); pintarEsqES(); } };

// La hoja de la foto x enderezada y con el filtro, en un canvas
async function escanearFoto(x, modo) {
  const mapa = await abrirImagen(x.f), w = mapa.width, h = mapa.height, q = x.esq.map(([a, b]) => [a * w, b * h]);
  let [ow, oh] = medidaHoja(q);
  const k = Math.min(1, 3300 / Math.max(ow, oh));
  ow = Math.max(8, Math.round(ow * k)); oh = Math.max(8, Math.round(oh * k));
  const s = Math.min(1, k * 1.15), W = Math.round(w * s), H = Math.round(h * s);
  let fuente = escalar(mapa, W, H);
  if (!(fuente instanceof HTMLCanvasElement)) { const c = lienzoNuevo(W, H); c.getContext("2d").drawImage(fuente, 0, 0); fuente = c; }
  mapa.close();
  const src = fuente.getContext("2d").getImageData(0, 0, W, H).data;
  fuente.width = 0;
  const out = enderezar(src, W, H, q.map(([a, b]) => [a * W / w, b * H / h]), ow, oh);
  filtroDocumento(out, ow, oh, modo);
  let c = lienzoNuevo(ow, oh);
  c.getContext("2d").putImageData(new ImageData(out, ow, oh), 0, 0);
  if (x.giro) { const g = transformar(c, x.giro); c.width = 0; c = g; }
  return c;
}
$("botonES").onclick = async () => {
  const fotos = listaES.items.filter((x) => !x.mala && !x.falla);
  if (fotos.some((x) => !x.esq)) { aviso("avisoES", "Espera a que termine de buscar las hojas.", true); return; }
  if (!fotos.length) return;
  $("botonES").disabled = true;
  $("salidaES").textContent = "";
  try {
    const { PDFDocument } = await pdfLib();
    const doc = await PDFDocument.create(), modo = $("filtroES").value, hoja = $("hojaES").value;
    for (const [k, x] of fotos.entries()) {
      aviso("avisoES", fotos.length > 1 ? `Hoja ${k + 1} de ${fotos.length}…` : "Trabajando…");
      await pintar();
      const c = await escanearFoto(x, modo), horiz = c.width > c.height;
      const img = await doc.embedJpg(await guardarImagen(c, "jpg", 0.8));
      let pw, ph;
      if (hoja === "documento") [pw, ph] = horiz ? [612 * c.width / c.height, 612] : [612, 612 * c.height / c.width];
      else { [pw, ph] = HOJAS[hoja]; if (horiz) [pw, ph] = [ph, pw]; }
      c.width = 0;
      doc.addPage([pw, ph]).drawImage(img, { x: 0, y: 0, width: pw, height: ph });
    }
    filaDescarga($("salidaES"), await doc.save(), `${sinExtImg(fotos[0].f.name)} (escaneado).pdf`, paginasTxt(fotos.length));
    aviso("avisoES", "Listo. Si quieres que se pueda buscar el texto, pásalo después por «Reconocer texto».");
    $("salidaES").scrollIntoView({ block: "nearest", behavior: "smooth" });
  } catch (e) {
    aviso("avisoES", String(e && e.message || e), true);
  } finally {
    $("botonES").disabled = false;
  }
};

$("botonPreparar").onclick = () => preparar().catch(() => {});
$("zona").onclick = () => $("archivos").click();
$("zona").onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("archivos").click(); } };
$("archivos").onchange = (e) => { agregar([...e.target.files]); e.target.value = ""; };
for (const ev of ["dragenter", "dragover"]) $("zona").addEventListener(ev, (e) => { e.preventDefault(); $("zona").classList.add("encima"); });
for (const ev of ["dragleave", "drop"]) $("zona").addEventListener(ev, (e) => { e.preventDefault(); $("zona").classList.remove("encima"); });
$("zona").addEventListener("drop", (e) => agregar([...e.dataTransfer.files]));

// ---------------------------------------------------------------- 19. recortar PDF
// Recortar es cambiar el recuadro visible de cada página (CropBox y MediaBox): el contenido no se
// toca, solo cambia el pedazo de hoja que se ve y se imprime. «Quitar márgenes» dibuja cada hoja
// chica con PDF.js y busca dónde empieza y dónde acaba lo que no es blanco.
let paraRecortarPdf = null;                  // { f, vista, total, i }
const recP = { x: 0.08, y: 0.08, w: 0.84, h: 0.84 };     // fracción de la hoja como se ve, desde arriba a la izquierda
const modoRP = () => document.querySelector('input[name="modoRP"]:checked').value;
function pintarRecorteP() {
  for (const el of [$("cajaRP"), $("huecoRP")]) Object.assign(el.style, { left: recP.x * 100 + "%", top: recP.y * 100 + "%", width: recP.w * 100 + "%", height: recP.h * 100 + "%" });
}
arrastrar($("cajaRP"), () => ({ ...recP }), (dx, dy, ini) => {
  recP.x = entre(ini.x + dx, 0, 1 - recP.w); recP.y = entre(ini.y + dy, 0, 1 - recP.h);
  pintarRecorteP();
}, $("mesaRP"));
for (const asa of $("cajaRP").querySelectorAll(".asa")) {
  const izq = asa.dataset.e.includes("w"), arriba = asa.dataset.e.includes("n");
  arrastrar(asa, () => ({ ...recP }), (dx, dy, ini) => {
    const fx = izq ? ini.x + ini.w : ini.x, fy = arriba ? ini.y + ini.h : ini.y;      // la esquina contraria no se mueve
    const w = entre(izq ? ini.w - dx : ini.w + dx, 0.03, izq ? fx : 1 - fx), h = entre(arriba ? ini.h - dy : ini.h + dy, 0.03, arriba ? fy : 1 - fy);
    Object.assign(recP, { w, h, x: izq ? fx - w : fx, y: arriba ? fy - h : fy });
    pintarRecorteP();
  }, $("mesaRP"));
}
let turnoRP = 0;
async function pintarHojaRP() {
  const a = paraRecortarPdf, turno = ++turnoRP;
  if (!a) return;
  $("antesRP").disabled = a.i === 0; $("despuesRP").disabled = a.i === a.total - 1;
  $("paginaRP").textContent = `Página ${a.i + 1} de ${a.total}`;
  const pagina = await a.vista.getPage(a.i + 1), b = pagina.getViewport({ scale: 1 });
  const v = pagina.getViewport({ scale: Math.min(1600, 700 * Math.min(devicePixelRatio || 1, 2)) / Math.max(b.width, b.height) });
  const nuevo = lienzoNuevo(Math.round(v.width), Math.round(v.height));
  await pagina.render({ canvasContext: nuevo.getContext("2d"), viewport: v }).promise;
  if (turno !== turnoRP) return;
  const c = $("lienzoRP");
  c.width = nuevo.width; c.height = nuevo.height;
  c.getContext("2d").drawImage(nuevo, 0, 0);
  pintarRecorteP();
}
$("antesRP").onclick = () => { paraRecortarPdf.i--; pintarHojaRP(); };
$("despuesRP").onclick = () => { paraRecortarPdf.i++; pintarHojaRP(); };
for (const r of document.querySelectorAll('input[name="modoRP"]')) r.onchange = () => {
  const mano = modoRP() === "mano";
  $("manoRP").hidden = !mano; $("campoMargenRP").hidden = mano;
  if (mano) pintarHojaRP();
};
zonaDeArchivos($("zonaRP"), $("archivoRP"), async (fs) => {
  const f = fs.find(esPdf);
  if (!f) { $("infoRP").textContent = "Ese archivo no es un PDF."; return; }
  $("infoRP").textContent = "Abriendo…";
  try {
    await abrirPdf(f);                       // para avisar a tiempo si tiene contraseña o no es PDF
    const vista = await (await pdfJs()).getDocument({ data: new Uint8Array(await f.arrayBuffer()) }).promise;
    if (paraRecortarPdf) paraRecortarPdf.vista.destroy();
    paraRecortarPdf = { f, vista, total: vista.numPages, i: 0 };
    Object.assign(recP, { x: 0.08, y: 0.08, w: 0.84, h: 0.84 });
    $("infoRP").textContent = `${f.name} · ${paginasTxt(vista.numPages)}`;
    $("opcionesRP").hidden = false;
    aviso("avisoRP", "");
    if (modoRP() === "mano") await pintarHojaRP();
  } catch (e) {
    paraRecortarPdf = null;
    $("opcionesRP").hidden = true;
    $("infoRP").textContent = String(e && e.message || e);
  }
});
// Dónde hay algo que no es blanco en la hoja → { x0, y0, x1, y1 } como fracción (desde arriba a la izquierda), o null si está en blanco
const lienzoMargen = document.createElement("canvas");
async function tintaDe(pagina) {
  const b = pagina.getViewport({ scale: 1 }), v = pagina.getViewport({ scale: Math.min(3, 1400 / Math.max(b.width, b.height)) });
  const W = lienzoMargen.width = Math.max(1, Math.round(v.width)), H = lienzoMargen.height = Math.max(1, Math.round(v.height));
  const ctx = lienzoMargen.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
  await pagina.render({ canvasContext: ctx, viewport: v }).promise;
  const d = ctx.getImageData(0, 0, W, H).data, filas = new Uint32Array(H), cols = new Uint32Array(W);
  for (let y = 0, i = 0; y < H; y++) for (let x = 0; x < W; x++, i += 4)
    if (d[i] < 232 || d[i + 1] < 232 || d[i + 2] < 232) { filas[y]++; cols[x]++; }
  // Un renglón o columna cuenta si tiene al menos 2 puntos con tinta (así no manda una mota suelta)
  const primero = (a) => a.findIndex((n) => n >= 2), ultimo = (a) => a.length - 1 - [...a].reverse().findIndex((n) => n >= 2);
  const y0 = primero(filas), x0 = primero(cols);
  if (y0 < 0 || x0 < 0) return null;
  return { x0: x0 / W, y0: y0 / H, x1: (ultimo(cols) + 1) / W, y1: (ultimo(filas) + 1) / H };
}
// Pone el recuadro visible de la página; r en puntos de la hoja como se ve (desde abajo a la izquierda)
function ponerRecorte(L, p, r) {
  const [ax, ay] = aPdf(p, r.izq, r.abajo), [bx, by] = aPdf(p, r.der, r.arriba);
  const x = Math.min(ax, bx), y = Math.min(ay, by), w = Math.abs(bx - ax), h = Math.abs(by - ay);
  p.setCropBox(x, y, w, h);
  p.setMediaBox(x, y, w, h);
  for (const k of ["BleedBox", "TrimBox", "ArtBox"]) p.node.delete(L.PDFName.of(k));
}
$("botonRP").onclick = async () => {
  const a = paraRecortarPdf;
  if (!a) return;
  $("botonRP").disabled = true;
  try {
    const cuales = [...new Set(leerRangos($("paginasRP").value, a.total).flat())];
    const L = await pdfLib(), doc = await abrirPdf(a.f), mano = modoRP() === "mano", m = Number($("margenRP").value);
    let hechas = 0, blancas = 0;
    for (const [k, i] of cuales.entries()) {
      if (!mano && k % 5 === 0) { aviso("avisoRP", `Buscando los márgenes: página ${k + 1} de ${cuales.length}…`); await pintar(); }
      const p = doc.getPage(i), [W, H] = tamVisible(p);
      let r;
      if (mano) r = { izq: recP.x * W, der: (recP.x + recP.w) * W, arriba: H - recP.y * H, abajo: H - (recP.y + recP.h) * H };
      else {
        const t = await tintaDe(await a.vista.getPage(i + 1));
        if (!t) { blancas++; continue; }
        r = { izq: Math.max(0, t.x0 * W - m), der: Math.min(W, t.x1 * W + m), arriba: Math.min(H, H - t.y0 * H + m), abajo: Math.max(0, H - t.y1 * H - m) };
        if (r.der - r.izq > W - 2 && r.arriba - r.abajo > H - 2) continue;      // ya no tiene márgenes que quitar
      }
      if (r.der - r.izq < 4 || r.arriba - r.abajo < 4) continue;
      ponerRecorte(L, p, r);
      hechas++;
    }
    if (!hechas) throw new Error(mano ? "El recuadro es demasiado chico." : "No encontré márgenes blancos que quitar en esas páginas.");
    filaDescarga($("salidaRP"), await doc.save(), sinExt(a.f.name) + " (recortado).pdf", `${paginasTxt(hechas)} recortada${hechas === 1 ? "" : "s"}`);
    aviso("avisoRP", "Listo." + (blancas ? ` ${blancas === 1 ? "Una hoja estaba" : blancas + " hojas estaban"} en blanco y se dejó igual.` : ""));
  } catch (e) {
    aviso("avisoRP", String(e && e.message || e), true);
  } finally {
    $("botonRP").disabled = false;
  }
};

// ---------------------------------------------------------------- 20. reparar PDF
// Del mejor intento al último recurso: (1) qpdf lo vuelve a escribir (sirve si el archivo se puede
// leer pero otros programas se atoran); (2) pdf-lib lo lee objeto por objeto sin hacer caso del
// índice dañado; (3) si se perdió el final (descarga a medias) o el índice de páginas, se buscan
// las páginas sueltas en el archivo —también dentro de los flujos de objetos comprimidos— y se les
// arma un índice nuevo; (4) PDF.js, que abre casi todo, dibuja cada página y se arma un PDF de
// imágenes (se ve igual, pero el texto ya no se puede copiar).
// (El qpdf del navegador no sabe reconstruir por su cuenta: se detiene en el primer error.)
async function paginasQueAbre(bytes, estricto) {
  try {
    const v = await (await pdfJs()).getDocument({ data: bytes.slice(), stopAtErrors: estricto }).promise;
    const n = v.numPages;
    await v.getPage(1);
    v.destroy();
    return n;
  } catch (e) {
    if (e && e.name === "PasswordException") throw new Error("Este PDF tiene contraseña; quítasela primero con «Quitar contraseña».");
    return 0;
  }
}
// Busca en el texto del archivo los objetos «n g obj» (y los que van dentro de flujos ObjStm)
async function objetosSueltos(bytes) {
  const txt = new TextDecoder("latin1").decode(bytes), re = /(\d+)\s+(\d+)\s+obj\b/g, objs = [];
  let m;
  while ((m = re.exec(txt))) {
    const ini = m.index + m[0].length, finObj = txt.indexOf("endobj", ini), finFlujo = txt.indexOf("stream", ini);
    const fin = Math.min(...[finObj, finFlujo, ini + 20000].filter((x) => x > 0));
    objs.push({ n: Number(m[1]), g: Number(m[2]), cuerpo: txt.slice(ini, fin), pos: m.index, conFlujo: finFlujo > 0 && finFlujo === fin });
  }
  const dentro = [];
  for (const o of objs) {
    if (!o.conFlujo || !/\/Type\s*\/ObjStm\b/.test(o.cuerpo)) continue;
    try {
      let a = o.pos + txt.slice(o.pos).indexOf("stream") + 6;
      if (txt[a] === "\r") a++;
      if (txt[a] === "\n") a++;
      const z = txt.indexOf("endstream", a), n = Number(/\/N\s+(\d+)/.exec(o.cuerpo)[1]), primero = Number(/\/First\s+(\d+)/.exec(o.cuerpo)[1]);
      if (!/\/Filter\s*\/FlateDecode/.test(o.cuerpo) || z < 0) continue;
      // Si el flujo quedó cortado, DecompressionStream falla al final: se toma lo que alcanzó a salir
      const partes = [], lector = new Blob([bytes.subarray(a, z)]).stream().pipeThrough(new DecompressionStream("deflate")).getReader();
      try { for (;;) { const { done, value } = await lector.read(); if (done) break; partes.push(value); } } catch { /* lo que alcanzó */ }
      const d = new TextDecoder("latin1").decode(new Uint8Array(await new Blob(partes).arrayBuffer()));
      const cab = d.slice(0, primero).trim().split(/\s+/).map(Number);
      for (let k = 0; k < n && 2 * k + 1 < cab.length; k++) {
        const ini = primero + cab[2 * k + 1], fin = 2 * k + 3 < cab.length ? primero + cab[2 * k + 3] : d.length;
        dentro.push({ n: cab[2 * k], g: 0, cuerpo: d.slice(ini, fin), pos: o.pos + k / 1e4 });
      }
    } catch (e) { console.warn("Flujo de objetos ilegible", e); }
  }
  // Si un objeto aparece varias veces (archivos editados), vale la última versión
  const porNum = new Map();
  for (const o of [...objs, ...dentro].sort((x, y) => x.pos - y.pos)) porNum.set(o.n, o);
  return { txt, todos: [...porNum.values()].sort((x, y) => x.pos - y.pos) };
}
// Le arma un índice nuevo: catálogo y árbol de páginas con las páginas encontradas, en el orden del archivo
async function reconstruir(bytes) {
  const { todos } = await objetosSueltos(bytes);
  const paginas = todos.filter((o) => /\/Type\s*\/Page(?![a-zA-Z])/.test(o.cuerpo));
  if (!paginas.length) return null;
  const max = Math.max(...todos.map((o) => o.n)), arbol = max + 1, cat = max + 2;
  const kids = paginas.map((o) => `${o.n} ${o.g} R`).join(" ");
  const extra = `\nendstream\nendobj\n${arbol} 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${paginas.length} >>\nendobj\n`
    + `${cat} 0 obj\n<< /Type /Catalog /Pages ${arbol} 0 R >>\nendobj\ntrailer\n<< /Size ${cat + 1} /Root ${cat} 0 R >>\nstartxref\n0\n%%EOF\n`;
  const { PDFDocument, PDFName, PDFArray } = await pdfLib();
  const unido = new Uint8Array(bytes.length + extra.length);
  unido.set(bytes); unido.set(new TextEncoder().encode(extra), bytes.length);     // extra es solo ASCII
  const doc = await PDFDocument.load(unido, { ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false });
  if (doc.isEncrypted) return null;
  // Las páginas apuntan a su índice viejo (que se perdió): ahora cuelgan del nuevo, con hoja carta si no dicen su tamaño
  const ref = doc.catalog.get(PDFName.of("Pages")), nodo = doc.context.lookup(ref), hijos = nodo.lookup(PDFName.of("Kids"), PDFArray);
  let perdidas = 0;
  for (let k = hijos.size() - 1; k >= 0; k--) {
    const p = hijos.lookup(k);
    if (!p || typeof p.set !== "function") { hijos.remove(k); continue; }
    // Sin su contenido (quedó en la parte que se perdió) sería una hoja en blanco: se quita
    const c = p.get(PDFName.of("Contents")), partes = c instanceof PDFArray ? c.asArray() : c ? [c] : [];
    if (partes.length && partes.every((x) => !doc.context.lookup(x))) { hijos.remove(k); perdidas++; continue; }
    p.set(PDFName.of("Parent"), ref);
    if (!p.lookup(PDFName.of("MediaBox"))) p.set(PDFName.of("MediaBox"), doc.context.obj([0, 0, 612, 792]));
    if (!p.lookup(PDFName.of("Resources"))) p.set(PDFName.of("Resources"), doc.context.obj({}));
  }
  nodo.set(PDFName.of("Count"), doc.context.obj(hijos.size()));
  if (!hijos.size()) return null;
  return { bytes: await doc.save(), perdidas };
}
async function rescatarComoImagenes(bytes, avance) {
  const { PDFDocument } = await pdfLib(), vista = await (await pdfJs()).getDocument({ data: bytes.slice(), stopAtErrors: false }).promise;
  const doc = await PDFDocument.create(), lienzo = document.createElement("canvas");
  let fallidas = 0;
  for (let i = 1; i <= vista.numPages; i++) {
    avance(`Rescatando la página ${i} de ${vista.numPages}…`);
    try {
      const pagina = await vista.getPage(i), b = pagina.getViewport({ scale: 1 }), v = pagina.getViewport({ scale: Math.min(150 / 72, Math.sqrt(16e6 / (b.width * b.height))) });
      lienzo.width = Math.round(v.width); lienzo.height = Math.round(v.height);
      const c = lienzo.getContext("2d");
      c.fillStyle = "#fff"; c.fillRect(0, 0, lienzo.width, lienzo.height);
      await pagina.render({ canvasContext: c, viewport: v }).promise;
      const img = await doc.embedJpg(await guardarImagen(lienzo, "jpg", 0.85));
      doc.addPage([b.width, b.height]).drawImage(img, { x: 0, y: 0, width: b.width, height: b.height });
    } catch (e) { fallidas++; console.warn("Página que no se pudo rescatar", i, e); }
  }
  vista.destroy();
  if (!doc.getPageCount()) throw new Error("No se pudo rescatar ninguna página.");
  return { bytes: await doc.save(), paginas: doc.getPageCount(), fallidas };
}
zonaDeArchivos($("zonaRep"), $("archivoRep"), async (fs) => {
  const f = fs[0];
  if (!f) return;
  const decir = (t, error) => aviso("avisoRep", t, error);
  try {
    decir(`Revisando «${f.name}»…`);
    await pintar();
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (!bytes.length) throw new Error(`«${f.name}» está vacío (0 bytes): no queda nada que reparar. Si te lo mandaron, pide que lo vuelvan a enviar.`);
    if (!new TextDecoder("latin1").decode(bytes.subarray(0, 4096)).includes("%PDF")) throw new Error(`«${f.name}» no parece un PDF por dentro. Si lo bajaste de un correo o de WhatsApp, vuelve a descargarlo.`);
    const nombre = sinExt(f.name) + " (reparado).pdf";
    const maximo = await paginasQueAbre(bytes, false);        // las que PDF.js alcanza a ver, aunque esté dañado
    const listo = (salida, n, texto) => { filaDescarga($("salidaRep"), salida, nombre, paginasTxt(n)); decir(texto); };
    // 1. qpdf: solo si lee el archivo sin errores
    decir("Revisando la estructura…");
    await pintar();
    const r = await qpdf(["/in.pdf", "/out.pdf"], bytes);
    if (r.malaClave) throw new Error("Este PDF tiene contraseña; quítasela primero con «Quitar contraseña».");
    if (r.codigo === 0 && r.salida) {
      const n = await paginasQueAbre(r.salida, true);
      if (n && n >= maximo) return listo(r.salida, n, "Este PDF no tenía errores en su estructura; igual se guardó una copia reescrita. Si un programa no lo abre, prueba con esta copia.");
    }
    // 2. pdf-lib, objeto por objeto
    decir("Reparando…");
    await pintar();
    const { PDFDocument } = await pdfLib();
    let n2 = 0, salida2 = null;
    try {
      const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false });
      if (!doc.isEncrypted && doc.getPageCount()) { salida2 = await doc.save(); n2 = await paginasQueAbre(salida2, true); }
    } catch (e) { console.warn("pdf-lib no pudo leerlo tal cual", e); }
    if (n2 && n2 >= maximo) return listo(salida2, n2, "Listo: el archivo estaba dañado y se volvió a armar.");
    // 3. índice nuevo con las páginas que se encuentren
    let n3 = 0, salida3 = null, perdidas = 0;
    try { const x = await reconstruir(bytes); if (x) { salida3 = x.bytes; perdidas = x.perdidas; n3 = await paginasQueAbre(salida3, true); } }
    catch (e) { console.warn("No se pudo reconstruir", e); }
    const nota3 = `Listo: se perdió el índice del archivo (pasa con descargas a medias) y se rearmó con ${paginasTxt(n3)}.`
      + (perdidas ? ` Otras ${perdidas} se perdieron: su contenido estaba en la parte dañada o que no se descargó.` : "") + " Revisa que estén completas y en orden.";
    if (n3 && n3 >= Math.max(maximo, n2)) return listo(salida3, n3, nota3);
    if (n2 && n2 >= maximo) return listo(salida2, n2, "Listo: el archivo estaba dañado y se volvió a armar.");
    // 4. rescate como imágenes
    if (!maximo) {
      if (n3 || n2) return n3 >= n2 ? listo(salida3, n3, nota3) : listo(salida2, n2, "Listo: se recuperó lo que se pudo.");
      throw new Error(`«${f.name}» está demasiado dañado: no se encontró ninguna página que recuperar.`);
    }
    const x = await rescatarComoImagenes(bytes, decir);
    filaDescarga($("salidaRep"), x.bytes, nombre, `${paginasTxt(x.paginas)} rescatadas como imagen`);
    decir(`Listo, pero se rescató como imágenes: se ve igual, aunque el texto ya no se puede copiar (pásalo por «Reconocer texto» si lo necesitas).`
      + (x.fallidas ? ` ${x.fallidas === 1 ? "Una página no se pudo" : x.fallidas + " páginas no se pudieron"} recuperar.` : ""));
  } catch (e) {
    decir(String(e && e.message || e), true);
  }
});

// ---------------------------------------------------------------- 21. llenar formularios
// PDF.js dice dónde está cada campo del formulario (y de qué tipo es); encima de cada hoja se ponen
// recuadros de escribir, casillas y listas en ese lugar. Al guardar, pdf-lib escribe los valores en
// los campos del PDF (siguen siendo campos: se pueden cambiar después, salvo que se deje fijo).
let paraForm = null;            // { f, bytes, vista, campos: Map nombre → { tipo, valor, cambiado, controles: [] } }
const alVerseFo = new IntersectionObserver((vistas) => {
  for (const v of vistas) if (v.isIntersecting) { alVerseFo.unobserve(v.target); v.target._pintar(); }
}, { rootMargin: "600px" });
const tamFo = new ResizeObserver((cambios) => { for (const c of cambios) c.target.style.setProperty("--pt", c.target.clientWidth / c.target._ancho + "px"); });
function controlDeCampo(a, campo, nombreGrupo) {
  let el;
  if (campo.tipo === "texto") {
    el = document.createElement(a.multiLine ? "textarea" : "input");
    if (!a.multiLine) el.type = "text";
    if (a.maxLen) el.maxLength = a.maxLen;
    el.value = campo.valor;
    el.oninput = () => { campo.valor = el.value; campo.cambiado = true; for (const o of campo.controles) if (o !== el) o.value = el.value; };
  } else if (campo.tipo === "casilla") {
    el = document.createElement("input"); el.type = "checkbox";
    el.checked = campo.valor;
    el.onchange = () => { campo.valor = el.checked; campo.cambiado = true; for (const o of campo.controles) o.checked = el.checked; };
  } else if (campo.tipo === "opcion") {
    el = document.createElement("input"); el.type = "radio"; el.name = nombreGrupo; el.value = a.buttonValue;
    el.checked = campo.valor === a.buttonValue;
    el.onchange = () => { if (el.checked) { campo.valor = a.buttonValue; campo.cambiado = true; } };
    // Tocar la opción ya marcada la desmarca (en papel también se puede dejar en blanco)
    el.onclick = () => { if (el._antes) { el.checked = false; campo.valor = ""; campo.cambiado = true; } };
    el.onpointerdown = el.onkeydown = () => { el._antes = el.checked; };
  } else {
    el = document.createElement("select");
    if (a.multiSelect) el.multiple = true; else el.append(new Option("", ""));
    for (const o of a.options || []) el.append(new Option(o.displayValue, o.exportValue));
    const actual = [].concat(campo.valor);
    for (const o of el.options) o.selected = actual.includes(o.value);
    el.onchange = () => {
      campo.valor = el.multiple ? [...el.selectedOptions].map((o) => o.value) : el.value; campo.cambiado = true;
      for (const o of campo.controles) if (o !== el) for (const x of o.options) x.selected = [].concat(campo.valor).includes(x.value);
    };
  }
  el.className = "campo-pdf";
  el.title = a.alternativeText || a.fieldName;
  if (a.readOnly) el.disabled = true;
  campo.controles.push(el);
  return el;
}
zonaDeArchivos($("zonaFo"), $("archivoFo"), async (fs) => {
  const f = fs.find(esPdf);
  if (!f) { $("infoFo").textContent = "Ese archivo no es un PDF."; return; }
  $("infoFo").textContent = "Abriendo…";
  $("opcionesFo").hidden = true;
  try {
    const bytes = new Uint8Array(await f.arrayBuffer()), doc = await abrirPdf(f), form = doc.getForm();
    const conXfa = form.hasXFA(), nombres = form.getFields().map((c) => c.getName());
    if (!nombres.length) throw new Error(`«${f.name}» no tiene campos para llenar. Para escribir encima de cualquier PDF usa «Editar PDF».`);
    const vista = await (await pdfJs()).getDocument({ data: bytes.slice() }).promise;
    if (paraForm) paraForm.vista.destroy();
    paraForm = { f, bytes, vista, campos: new Map() };
    const caja = $("hojasFo");
    caja.textContent = "";
    let puestos = 0;
    for (let n = 1; n <= vista.numPages; n++) {
      const pagina = await vista.getPage(n), v = pagina.getViewport({ scale: 1 });
      const anotaciones = (await pagina.getAnnotations()).filter((a) => a.subtype === "Widget" && a.fieldName && !a.pushButton && a.fieldType !== "Sig" && !a.hidden);
      if (!anotaciones.length) continue;
      const hoja = document.createElement("div"), lienzo = document.createElement("canvas");
      hoja.className = "hoja-form";
      hoja.style.aspectRatio = `${v.width} / ${v.height}`;
      hoja.append(lienzo);
      const etiqueta = document.createElement("p");
      etiqueta.className = "aviso"; etiqueta.textContent = `Página ${n}`;
      caja.append(etiqueta, hoja);
      for (const a of anotaciones) {
        const tipo = a.fieldType === "Tx" ? "texto" : a.fieldType === "Btn" ? (a.checkBox ? "casilla" : a.radioButton ? "opcion" : null) : a.fieldType === "Ch" ? "lista" : null;
        if (!tipo) continue;
        let campo = paraForm.campos.get(a.fieldName);
        if (!campo) {
          const fv = a.fieldValue;
          campo = { tipo, cambiado: false, controles: [], opciones: a.options,
            valor: tipo === "texto" ? (typeof fv === "string" ? fv : "") : tipo === "casilla" ? !!fv && fv !== "Off" && (fv === a.exportValue || !a.exportValue)
              : tipo === "opcion" ? (fv && fv !== "Off" ? fv : "") : (a.multiSelect ? [].concat(fv || []) : [].concat(fv || [""])[0]) };
          paraForm.campos.set(a.fieldName, campo);
        }
        const [x1, y1, x2, y2] = v.convertToViewportRectangle(a.rect);
        const el = controlDeCampo(a, campo, "fo-" + [...paraForm.campos.keys()].indexOf(a.fieldName));
        const alto = Math.abs(y2 - y1), da = a.defaultAppearanceData && a.defaultAppearanceData.fontSize;
        const letra = a.multiLine ? Math.min(da || 10, 14) : Math.min(da || 12, alto * 0.75);
        Object.assign(el.style, { left: Math.min(x1, x2) / v.width * 100 + "%", top: Math.min(y1, y2) / v.height * 100 + "%",
          width: Math.abs(x2 - x1) / v.width * 100 + "%", height: alto / v.height * 100 + "%", fontSize: `calc(var(--pt) * ${letra})` });
        if (a.comb && a.maxLen) el.style.letterSpacing = `calc(var(--pt) * ${Math.max(0, Math.abs(x2 - x1) / a.maxLen - letra * 0.6)})`;
        if (a.textAlignment === 1) el.style.textAlign = "center"; else if (a.textAlignment === 2) el.style.textAlign = "right";
        hoja.append(el);
        puestos++;
      }
      hoja._pintar = async () => {
        const e = Math.min(1600, (hoja.clientWidth || 700) * Math.min(devicePixelRatio || 1, 2)) / v.width, vv = pagina.getViewport({ scale: e });
        lienzo.width = Math.round(vv.width); lienzo.height = Math.round(vv.height);
        // annotationMode 0: sin los campos dibujados por PDF.js (se ven los nuestros encima)
        await pagina.render({ canvasContext: lienzo.getContext("2d"), viewport: vv, annotationMode: 0 }).promise;
      };
      hoja._ancho = v.width;
      alVerseFo.observe(hoja);
      tamFo.observe(hoja);
    }
    if (!puestos) {
      paraForm = null;
      throw new Error(conXfa ? `«${f.name}» es un formulario XFA (de los que solo llena Adobe Reader) y aquí no se puede llenar.` : `«${f.name}» no tiene campos que se puedan llenar.`);
    }
    $("infoFo").textContent = `${f.name} · ${paraForm.campos.size === 1 ? "1 campo" : paraForm.campos.size + " campos"}`;
    $("opcionesFo").hidden = false;
    aviso("avisoFo", "");
  } catch (e) {
    $("infoFo").textContent = String(e && e.message || e);
  }
});
$("limpiarFo").onclick = () => {
  if (!paraForm) return;
  for (const c of paraForm.campos.values()) {
    if (c.controles[0]?.disabled) continue;
    c.valor = c.tipo === "casilla" ? false : c.tipo === "lista" && c.controles[0]?.multiple ? [] : "";
    c.cambiado = true;
    for (const el of c.controles) {
      if (el.type === "checkbox" || el.type === "radio") el.checked = false;
      else if (el.tagName === "SELECT") for (const o of el.options) o.selected = false;
      else el.value = "";
    }
  }
  aviso("avisoFo", "Se borró lo escrito. Guarda para tener el formulario en blanco.");
};
$("botonFo").onclick = async () => {
  const a = paraForm;
  if (!a) return;
  $("botonFo").disabled = true;
  try {
    aviso("avisoFo", "Guardando…");
    const L = await pdfLib(), doc = await L.PDFDocument.load(a.bytes), form = doc.getForm();
    if (form.hasXFA()) form.deleteXFA();       // si no, Acrobat mostraría los datos viejos del XFA
    const helv = await doc.embedFont(L.StandardFonts.Helvetica);
    // Listas: pdf-lib conoce las opciones por el texto que se ve; botones de opción con /Opt, por número
    const opcionDe = (campo, c, v) => {
      const validas = campo.getOptions();
      if (validas.includes(v)) return v;
      const o = (c.opciones || []).find((o) => o.exportValue === v);
      if (o && validas.includes(o.displayValue)) return o.displayValue;
      return /^\d+$/.test(v) && validas[Number(v)] !== undefined ? validas[Number(v)] : v;
    };
    let cambios = 0;
    for (const [nombre, c] of a.campos) {
      if (!c.cambiado) continue;
      let campo;
      try { campo = form.getField(nombre); } catch { continue; }
      try {
        if (campo instanceof L.PDFTextField) {
          const max = campo.getMaxLength();
          medirTexto(helv, c.valor.replace(/\n/g, " "), 10);
          // Tamaño «automático» en varias líneas: pdf-lib agrandaría la letra hasta llenar el recuadro
          if (campo.isMultiline() && /(^|\s)0(\.0*)?\s+Tf/.test(campo.acroField.getDefaultAppearance() || "")) campo.setFontSize(10);
          campo.setText(max !== undefined ? c.valor.slice(0, max) : c.valor);
        } else if (campo instanceof L.PDFCheckBox) c.valor ? campo.check() : campo.uncheck();
        else if (campo instanceof L.PDFRadioGroup) c.valor ? campo.select(opcionDe(campo, c, c.valor)) : campo.clear();
        else if (campo instanceof L.PDFDropdown) c.valor ? campo.select(opcionDe(campo, c, c.valor)) : campo.clear();
        else if (campo instanceof L.PDFOptionList) c.valor.length ? campo.select(c.valor.map((v) => opcionDe(campo, c, v))) : campo.clear();
        else continue;
        cambios++;
      } catch (e) {
        if (/símbolos/.test(String(e && e.message))) throw new Error(`En «${nombre}» hay símbolos que no se pueden escribir (por ejemplo emojis). Usa letras, números y signos comunes.`);
        console.warn("Campo que no se pudo llenar", nombre, e);
      }
    }
    form.updateFieldAppearances(helv);
    const fijo = $("aplanarFo").checked;
    if (fijo) {
      form.flatten();
      // pdf-lib borra los campos pero a veces deja su referencia en la lista de la hoja (Annots): el archivo quedaría con huecos
      for (const p of doc.getPages()) {
        const an = p.node.lookup(L.PDFName.of("Annots"));
        if (an instanceof L.PDFArray) for (let k = an.size() - 1; k >= 0; k--) { const r = an.get(k); if (r instanceof L.PDFRef && !doc.context.lookup(r)) an.remove(k); }
      }
    }
    const bytes = await doc.save();
    filaDescarga($("salidaFo"), bytes, sinExt(a.f.name) + (fijo ? " (lleno, fijo).pdf" : " (lleno).pdf"), cambios === 1 ? "1 campo llenado" : `${cambios} campos llenados`);
    aviso("avisoFo", "Listo. Ábrelo para revisarlo antes de enviarlo.");
    $("salidaFo").scrollIntoView({ block: "nearest", behavior: "smooth" });
  } catch (e) {
    aviso("avisoFo", String(e && e.message || e), true);
  } finally {
    $("botonFo").disabled = false;
  }
};

// ---------------------------------------------------------------- 22. sacar las imágenes
// Se recorren los recursos de cada página (y de los dibujos que llevan dentro) buscando objetos
// imagen. Los JPG se sacan tal cual (sus bytes, sin perder nada); los demás se decodifican aquí
// —gris, RGB, CMYK, con paleta, de 1 a 16 bits, con o sin transparencia— y se guardan en PNG.
// Los de fax (CCITT) y JBIG2, típicos de escaneos en blanco y negro, no se saben leer aquí.
let paraSacar = null;           // { f, total }
zonaDeArchivos($("zonaSI"), $("archivoSI"), async (fs) => {
  const f = fs.find(esPdf);
  if (!f) { $("infoSI").textContent = "Ese archivo no es un PDF."; return; }
  $("infoSI").textContent = "Abriendo…";
  try {
    const doc = await abrirPdf(f);
    paraSacar = { f, total: doc.getPageCount() };
    $("infoSI").textContent = `${f.name} · ${paginasTxt(paraSacar.total)}`;
    $("opcionesSI").hidden = false;
    aviso("avisoSI", "");
  } catch (e) {
    paraSacar = null;
    $("opcionesSI").hidden = true;
    $("infoSI").textContent = String(e && e.message || e);
  }
});
// Espacio de color → { n (componentes), aRgb(comps 0–1, salida, j) } o { paleta } o null si no se sabe
function espacioDe(L, cs, prof = 0) {
  const { PDFName, PDFArray } = L, nom = (s) => PDFName.of(s);
  const gris = { n: 1, aRgb: (c, o, j) => { o[j] = o[j + 1] = o[j + 2] = c[0] * 255; } };
  const rgb = { n: 3, aRgb: (c, o, j) => { o[j] = c[0] * 255; o[j + 1] = c[1] * 255; o[j + 2] = c[2] * 255; } };
  const cmyk = { n: 4, aRgb: (c, o, j) => { const k = 1 - c[3]; o[j] = 255 * (1 - c[0]) * k; o[j + 1] = 255 * (1 - c[1]) * k; o[j + 2] = 255 * (1 - c[2]) * k; } };
  if (!cs || prof > 3) return null;
  if (cs === nom("DeviceGray") || cs === nom("CalGray") || cs === nom("G")) return gris;
  if (cs === nom("DeviceRGB") || cs === nom("CalRGB") || cs === nom("RGB")) return rgb;
  if (cs === nom("DeviceCMYK") || cs === nom("CMYK")) return cmyk;
  if (!(cs instanceof PDFArray)) return null;
  const tipo = cs.lookup(0);
  if (tipo === nom("CalGray")) return gris;
  if (tipo === nom("CalRGB")) return rgb;
  if (tipo === nom("ICCBased")) { const k = cs.lookup(1)?.dict?.lookup(nom("N"))?.asNumber(); return k === 1 ? gris : k === 3 ? rgb : k === 4 ? cmyk : null; }
  if (tipo === nom("Separation")) return { n: 1, aRgb: (c, o, j) => { o[j] = o[j + 1] = o[j + 2] = 255 * (1 - c[0]); } };     // una tinta: 1 = toda la tinta
  if (tipo === nom("Indexed") || tipo === nom("I")) {
    const baseCs = espacioDe(L, cs.lookup(1), prof + 1), tope = cs.lookup(2)?.asNumber?.(), t = cs.lookup(3);
    if (!baseCs || baseCs.paleta || !(tope >= 0)) return null;
    let tabla = t && typeof t.asBytes === "function" ? t.asBytes() : null;
    if (!tabla && t?.contents) tabla = t;           // en un flujo: se descomprime después
    return tabla ? { paleta: { base: baseCs, tope, tabla } } : null;
  }
  return null;
}
async function contenidoDe(L, obj) {     // los bytes ya sin el filtro (FlateDecode o ninguno), o null si es otro filtro
  const { PDFName, PDFArray } = L, nom = (s) => PDFName.of(s), d = obj.dict;
  let filtro = d.lookup(nom("Filter")), parms = d.lookup(nom("DecodeParms"));
  if (filtro instanceof PDFArray) { if (filtro.size() > 1) return null; filtro = filtro.size() ? filtro.lookup(0) : undefined; }
  if (parms instanceof PDFArray) parms = parms.size() ? parms.lookup(0) : undefined;
  if (!filtro) return obj.contents;
  if (filtro !== nom("FlateDecode") && filtro !== nom("Fl")) return null;
  let b = await porTubo(obj.contents, new DecompressionStream("deflate")).catch(() => null);
  if (!b) return null;
  const pp = (k, def) => { const x = parms?.lookup?.(nom(k)); return x ? x.asNumber() : def; };
  const pred = pp("Predictor", 1);
  if (pred > 1) {
    if (pp("BitsPerComponent", 8) !== 8) return null;
    b = sinPredictor(b, pred, pp("Colors", 1), pp("Columns", 1));
  }
  return b;
}
// Lee muestras de «bits» bits, renglón por renglón (cada renglón empieza en un byte nuevo) → valores 0–1
function muestras(b, w, h, n, bits, decode) {
  const fila = Math.ceil(w * n * bits / 8), out = new Float32Array(w * h * n), max = (1 << Math.min(bits, 16)) - 1;
  const lo = [], an = [];
  for (let c = 0; c < n; c++) { const a = decode ? decode[c * 2] : 0, z = decode ? decode[c * 2 + 1] : 1; lo.push(a); an.push(z - a); }
  for (let y = 0, q = 0; y < h; y++) {
    const s = y * fila;
    for (let i = 0; i < w * n; i++, q++) {
      let v;
      if (bits === 8) v = b[s + i];
      else if (bits === 16) v = (b[s + 2 * i] << 8) | b[s + 2 * i + 1];
      else { const bit = i * bits; v = (b[s + (bit >> 3)] >> (8 - bits - (bit & 7))) & max; }
      const c = i % n;
      out[q] = lo[c] + an[c] * (v || 0) / max;
    }
  }
  return out;
}
// Objeto imagen → RGBA (Uint8ClampedArray) de w × h, o null si no se sabe leer
async function pixelesDe(L, obj, tamano) {
  const { PDFName, PDFArray } = L, nom = (s) => PDFName.of(s), d = obj.dict, ver = (k) => d.lookup(nom(k));
  const num = (k) => { const x = ver(k); return x && typeof x.asNumber === "function" ? x.asNumber() : NaN; };
  const w = num("Width"), h = num("Height");
  if (!(w > 0 && h > 0) || w * h > 30e6) return null;
  let filtro = ver("Filter");
  if (filtro instanceof PDFArray) filtro = filtro.size() === 1 ? filtro.lookup(0) : null;
  const px = new Uint8ClampedArray(w * h * 4);
  const decArr = ver("Decode") instanceof PDFArray ? ver("Decode").asArray().map((x) => x.asNumber()) : null;
  if (filtro === nom("DCTDecode") || filtro === nom("DCT")) {
    const mapa = await createImageBitmap(new Blob([sinExif(obj.contents)], { type: "image/jpeg" })).catch(() => null);
    if (!mapa) return null;
    const c = lienzoNuevo(w, h), ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(mapa, 0, 0, w, h); mapa.close();
    px.set(ctx.getImageData(0, 0, w, h).data);
  } else {
    const b = await contenidoDe(L, obj);
    if (!b) return null;
    if (String(ver("ImageMask")) === "true") {          // máscara de 1 bit: lo pintado en negro, lo demás transparente
      const m = muestras(b, w, h, 1, 1, decArr);
      for (let i = 0; i < w * h; i++) px[i * 4 + 3] = m[i] < 0.5 ? 255 : 0;
      return { w, h, px };
    }
    const bits = num("BitsPerComponent"), cs = espacioDe(L, ver("ColorSpace"));
    if (!cs || ![1, 2, 4, 8, 16].includes(bits)) return null;
    if (cs.paleta) {
      const { base: bc, tope, tabla } = cs.paleta;
      const t = tabla.contents ? await contenidoDe(L, tabla) : tabla;
      if (!t) return null;
      const m = muestras(b, w, h, 1, bits, null), max = (1 << bits) - 1, comps = new Float32Array(bc.n), rgbT = new Uint8ClampedArray((tope + 1) * 4);
      for (let k = 0; k <= tope; k++) { for (let c = 0; c < bc.n; c++) comps[c] = (t[k * bc.n + c] || 0) / 255; bc.aRgb(comps, rgbT, k * 4); }
      for (let i = 0; i < w * h; i++) { const k = Math.min(tope, Math.round(m[i] * max)); px[i * 4] = rgbT[k * 4]; px[i * 4 + 1] = rgbT[k * 4 + 1]; px[i * 4 + 2] = rgbT[k * 4 + 2]; px[i * 4 + 3] = 255; }
    } else {
      const m = muestras(b, w, h, cs.n, bits, decArr && decArr.length >= cs.n * 2 ? decArr : null), comps = new Float32Array(cs.n);
      for (let i = 0; i < w * h; i++) { for (let c = 0; c < cs.n; c++) comps[c] = m[i * cs.n + c]; cs.aRgb(comps, px, i * 4); px[i * 4 + 3] = 255; }
    }
  }
  if (tamano) return { w, h, px };
  // Transparencia: SMask (gris) o Mask (máscara de 1 bit)
  const sm = ver("SMask"), mk = ver("Mask");
  const mascara = sm?.dict ? sm : mk?.dict ? mk : null;
  if (mascara) {
    const m = await pixelesDe(L, mascara, true);
    if (m) {
      let alfa = m.px;
      if (m.w !== w || m.h !== h) {      // otro tamaño: se estira
        const c = lienzoNuevo(m.w, m.h); c.getContext("2d").putImageData(new ImageData(m.px, m.w, m.h), 0, 0);
        const c2 = lienzoNuevo(w, h), ctx = c2.getContext("2d", { willReadFrequently: true }); ctx.drawImage(c, 0, 0, w, h);
        alfa = ctx.getImageData(0, 0, w, h).data;
      }
      const esMascara = mascara === mk;          // de 1 bit: ya viene como transparencia (canal 3)
      for (let i = 0; i < w * h; i++) px[i * 4 + 3] = esMascara ? alfa[i * 4 + 3] : alfa[i * 4];
    }
  }
  return { w, h, px };
}
$("botonSI").onclick = async () => {
  const a = paraSacar;
  if (!a) return;
  $("botonSI").disabled = true;
  try {
    const cuales = [...new Set(leerRangos($("paginasSI").value, a.total).flat())].sort((x, y) => x - y);
    aviso("avisoSI", "Buscando las imágenes…");
    await pintar();
    const L = await pdfLib(), { PDFName, PDFDict, PDFRawStream } = L, nom = (s) => PDFName.of(s);
    const doc = await abrirPdf(a.f), chicas = $("chicasSI").checked;
    const vistas = new Set(), lista = [];          // { obj, pagina }
    const recorrer = (recursos, pagina, prof) => {
      const xo = recursos instanceof PDFDict ? recursos.lookup(nom("XObject")) : null;
      if (!(xo instanceof PDFDict)) return;
      for (const [, ref] of xo.entries()) {
        const obj = doc.context.lookup(ref);
        if (!(obj instanceof PDFRawStream) || vistas.has(obj)) continue;
        vistas.add(obj);
        const sub = obj.dict.get(nom("Subtype"));
        if (sub === nom("Image")) lista.push({ obj, pagina });
        else if (sub === nom("Form") && prof < 10) recorrer(obj.dict.lookup(nom("Resources")), pagina, prof + 1);
      }
    };
    for (const i of cuales) recorrer(doc.getPage(i).node.Resources(), i, 0);
    const nombre = sinExt(a.f.name), cifras = String(a.total).length, hechas = [];
    let saltadas = 0, noSe = 0, porPagina = 0, anterior = -1;
    for (const [k, x] of lista.entries()) {
      if (k % 10 === 0) { aviso("avisoSI", `Imagen ${k + 1} de ${lista.length}…`); await pintar(); }
      const d = x.obj.dict, num = (s) => d.lookup(nom(s))?.asNumber?.() ?? 0, w = num("Width"), h = num("Height");
      if (chicas && (Math.min(w, h) < 32 || w * h < 6000)) { saltadas++; continue; }
      porPagina = x.pagina === anterior ? porPagina + 1 : 1; anterior = x.pagina;
      const base1 = `${nombre} - pág ${String(x.pagina + 1).padStart(cifras, "0")} - ${porPagina}`;
      let filtro = d.lookup(nom("Filter"));
      if (filtro instanceof L.PDFArray) filtro = filtro.size() === 1 ? filtro.lookup(0) : null;
      const sinTransparencia = !d.lookup(nom("SMask")) && !(d.lookup(nom("Mask"))?.dict);
      try {
        if ((filtro === nom("DCTDecode") || filtro === nom("DCT")) && sinTransparencia) {
          hechas.push({ nombre: base1 + ".jpg", bytes: x.obj.contents, tipo: "image/jpeg", px: pxTxt(w, h) });
          continue;
        }
        if (filtro === nom("JPXDecode") && sinTransparencia) {
          hechas.push({ nombre: base1 + ".jp2", bytes: x.obj.contents, tipo: "image/jp2", px: pxTxt(w, h) });
          continue;
        }
        const r = await pixelesDe(L, x.obj);
        if (!r) { noSe++; porPagina--; continue; }
        const c = lienzoNuevo(r.w, r.h);
        c.getContext("2d").putImageData(new ImageData(r.px, r.w, r.h), 0, 0);
        hechas.push({ nombre: base1 + ".png", bytes: await guardarImagen(c, "png"), tipo: "image/png", px: pxTxt(r.w, r.h) });
        c.width = 0;
      } catch (e) { console.warn("Imagen que no se pudo sacar", e); noSe++; porPagina--; }
    }
    const notas = [];
    if (saltadas) notas.push(`${saltadas === 1 ? "Se saltó 1 imagen muy chica" : `Se saltaron ${saltadas} imágenes muy chicas`}.`);
    if (noSe) notas.push(`${noSe === 1 ? "1 imagen está" : noSe + " imágenes están"} en un formato que aquí no se sabe leer (típico de escaneos en blanco y negro); para esas usa «PDF a imágenes».`);
    if (!hechas.length) throw new Error((lista.length ? "No se pudo sacar ninguna imagen. " : "Ese PDF (o esas páginas) no trae imágenes. ") + notas.join(" "));
    if (hechas.length <= 12) for (const h of [...hechas].reverse()) filaDescarga($("salidaSI"), h.bytes, h.nombre, h.px, h.tipo);
    if (hechas.length > 1) filaDescarga($("salidaSI"), zipSimple(hechas), `${nombre} (imágenes sacadas).zip`, `${hechas.length} imágenes`, "application/zip");
    aviso("avisoSI", `Listo: ${hechas.length === 1 ? "1 imagen" : hechas.length + " imágenes"}${hechas.length > 12 ? ", juntas en un .zip" : ""}. ` + notas.join(" "));
  } catch (e) {
    aviso("avisoSI", String(e && e.message || e), true);
  } finally {
    $("botonSI").disabled = false;
  }
};

// ---------------------------------------------------------------- 23. PDF a Word
// PDF.js da cada trozo de texto con su lugar, tamaño y fuente. Se juntan en renglones (en el orden en
// que el PDF los escribe, que casi siempre es el de lectura, también con columnas), los renglones en
// párrafos (por el espacio entre ellos, la sangría, el tamaño y si el renglón anterior acaba corto con
// punto), y se escribe un .docx a mano: XML de Word dentro de un .zip. Las imágenes se recortan de la
// hoja dibujada, en el lugar que dice la lista de operaciones de la página.
let paraWord = null;            // { f, vista, total }
zonaDeArchivos($("zonaPW"), $("archivoPW"), async (fs) => {
  const f = fs.find(esPdf);
  if (!f) { $("infoPW").textContent = "Ese archivo no es un PDF."; return; }
  $("infoPW").textContent = "Abriendo…";
  try {
    const vista = await (await pdfJs()).getDocument({ data: new Uint8Array(await f.arrayBuffer()) }).promise;
    if (paraWord) paraWord.vista.destroy();
    paraWord = { f, vista, total: vista.numPages };
    $("infoPW").textContent = `${f.name} · ${paginasTxt(vista.numPages)}`;
    $("opcionesPW").hidden = false;
    aviso("avisoPW", "");
  } catch (e) {
    paraWord = null;
    $("opcionesPW").hidden = true;
    $("infoPW").textContent = e && e.name === "PasswordException" ? `«${f.name}» tiene contraseña; quítasela primero con «Quitar contraseña».`
      : /visor/.test(String(e && e.message)) ? e.message : `«${f.name}» no se pudo leer como PDF.`;
  }
});
// Nombre de la fuente del PDF («ABCDEF+TimesNewRomanPS-BoldItalicMT») → { familia, negrita, cursiva }
const FAMILIAS = [[/timesnewroman|times/i, "Times New Roman"], [/arial|helvetica|liberationsans|arimo/i, "Arial"], [/calibri|carlito/i, "Calibri"],
  [/cambria|caladea/i, "Cambria"], [/garamond/i, "Garamond"], [/georgia/i, "Georgia"], [/verdana/i, "Verdana"], [/tahoma/i, "Tahoma"],
  [/courier|liberationmono|cousine/i, "Courier New"], [/trebuchet/i, "Trebuchet MS"], [/bookantiqua|palatino/i, "Book Antiqua"], [/century/i, "Century Gothic"],
  [/segoe/i, "Segoe UI"], [/montserrat/i, "Montserrat"], [/roboto/i, "Roboto"], [/opensans/i, "Open Sans"], [/lato/i, "Lato"], [/symbol/i, "Symbol"]];
function estiloDeFuente(fuente, estilos) {
  const nombre = String(fuente && fuente.name || "").replace(/^[A-Z]{6}\+/, "");
  const negrita = !!(fuente && (fuente.bold || fuente.black)) || /bold|black|heavy|semibold|demi|negrita/i.test(nombre);
  const cursiva = !!(fuente && fuente.italic) || /italic|oblique|kursiv|cursiva/i.test(nombre);
  let familia = (FAMILIAS.find(([re]) => re.test(nombre.replace(/[\s,_-]/g, ""))) || [])[1];
  if (!familia) {
    const limpio = nombre.split(/[-,]/)[0].replace(/(PS)?MT$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
    familia = limpio && limpio.length < 40 ? limpio : /serif/i.test(estilos && estilos.fontFamily || "") && !/sans/i.test(estilos.fontFamily) ? "Times New Roman" : "Arial";
  }
  return { familia, negrita, cursiva };
}
const mediana = (xs) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
// Una página → { bloques: [ párrafo | imagen ], sinTexto }  (medidas en puntos, desde arriba a la izquierda)
async function leerPaginaWord(pdfjs, pagina, conImagenes) {
  const v = pagina.getViewport({ scale: 1 }), W = v.width, H = v.height;
  const ops = await pagina.getOperatorList();                 // de paso, carga las fuentes (nombre, negrita, cursiva)
  const tc = await pagina.getTextContent();
  const fuenteDe = new Map();
  const estiloDe = (id) => {
    if (!fuenteDe.has(id)) { let f = null; try { if (pagina.commonObjs.has(id)) f = pagina.commonObjs.get(id); } catch { /* sin datos */ } fuenteDe.set(id, estiloDeFuente(f, tc.styles[id])); }
    return fuenteDe.get(id);
  };
  // 1. trozos → renglones
  const renglones = [];
  let r = null;
  for (const it of tc.items) {
    if (typeof it.str !== "string") continue;
    const m = pdfjs.Util.transform(v.transform, it.transform), size = Math.hypot(m[2], m[3]);
    if (!it.str.length) { if (it.hasEOL && r) r.fin = true; continue; }
    if (!(size > 0.5) || Math.abs(m[1]) > size * 0.1 || m[0] <= 0) continue;     // texto girado o vertical: se omite
    const x = m[4], base = m[5], ancho = it.width, e = estiloDe(it.fontName);
    const nuevo = !r || r.fin || Math.abs(base - r.base) > Math.max(size, r.size) * 0.45 || x < r.x1 - Math.max(size, r.size) * 1.2;
    if (nuevo) { r = { x0: x, x1: x, base, size, trozos: [], fin: false }; renglones.push(r); }
    let texto = it.str.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "");
    const hueco = x - r.x1;
    if (r.trozos.length && hueco > size * 0.18 && !/\s$/.test(r.trozos[r.trozos.length - 1].t) && !/^\s/.test(texto))
      texto = (hueco > size * 3 ? "\t" : " ") + texto;
    const ult = r.trozos[r.trozos.length - 1], tam = Math.round(size * 2) / 2;
    if (ult && ult.familia === e.familia && ult.negrita === e.negrita && ult.cursiva === e.cursiva && ult.size === tam) ult.t += texto;
    else r.trozos.push({ t: texto, ...e, size: tam });
    r.x1 = Math.max(r.x1, x + ancho);
    r.size = Math.max(r.size, size);
    if (it.hasEOL) r.fin = true;
  }
  const llenos = renglones.filter((x) => x.trozos.some((t) => t.t.trim()));
  // Tamaño de letra del cuerpo (el más común, pesado por letras) y espacio normal entre renglones
  const porTam = new Map();
  for (const x of llenos) for (const t of x.trozos) porTam.set(t.size, (porTam.get(t.size) || 0) + t.t.length);
  const cuerpo = [...porTam].sort((a, b) => b[1] - a[1])[0]?.[0] || 11;
  const saltos = [];
  for (let k = 1; k < llenos.length; k++) { const d = llenos[k].base - llenos[k - 1].base; if (d > 0 && Math.abs(llenos[k].size - llenos[k - 1].size) < 1) saltos.push(d / llenos[k].size); }
  const interlinea = Math.min(2.2, Math.max(1, mediana(saltos) || 1.2));
  const izq = Math.min(...llenos.map((x) => x.x0), W), der = Math.max(...llenos.map((x) => x.x1), 0);
  // 2. renglones → párrafos
  const VINETA = /^\s*([a-zA-Z0-9]{1,3}[).]|[•·▪●○■◦\-–—*➢►✓])\s/;
  const textoDe = (x) => x.trozos.map((t) => t.t).join("");
  const todoNegrita = (x) => x.trozos.every((t) => t.negrita || !t.t.trim());
  const parrafos = [];
  let p = null;
  for (const x of llenos) {
    const ant = p && p.renglones[p.renglones.length - 1];
    let corta = !p;
    if (ant) {
      const d = x.base - ant.base, s = Math.max(x.size, ant.size);
      const textoAnt = textoDe(ant).trimEnd(), primeroConVineta = p.renglones.length === 1 && VINETA.test(textoDe(ant));
      corta = d < -s * 0.3 || d > s * (interlinea + 0.3)                     // subió (otra columna) o hay hueco
        || Math.abs(x.size - ant.size) > 1                                  // cambia el tamaño
        || (ant.x1 < der - s * 2.5 && /[.:!?»"”)]$/.test(textoAnt))          // el anterior acabó corto y con punto
        || (ant.x1 < der - s * 4 && todoNegrita(ant) !== todoNegrita(x))     // título corto en negrita y luego texto normal
        || VINETA.test(textoDe(x))                                           // empieza una viñeta o un inciso
        || (x.x0 > ant.x0 + s * 1.2 && !primeroConVineta)                   // sangría al empezar (no la francesa de una lista)
        || (ant.x1 < der - s * 6 && x.x0 < ant.x0 - s * 4);                  // renglón corto y el nuevo empieza mucho más a la izquierda
    }
    if (corta) { p = { renglones: [], x0: x.x0, x1: x.x1, top: x.base - x.size, hueco: ant ? x.base - ant.base : null }; parrafos.push(p); }
    p.renglones.push(x);
    p.x0 = Math.min(p.x0, x.x0); p.x1 = Math.max(p.x1, x.x1);
  }
  const bloques = parrafos.map((q) => {
    const rs = q.renglones, size = Math.max(...rs.map((x) => x.size));
    const trozos = [];
    rs.forEach((x, k) => {
      for (const t of x.trozos) {
        const ult = trozos[trozos.length - 1];
        if (ult && ult.familia === t.familia && ult.negrita === t.negrita && ult.cursiva === t.cursiva && ult.size === t.size) ult.t += t.t; else trozos.push({ ...t });
      }
      if (k < rs.length - 1) {          // unir con el siguiente renglón: «pala-» + «bra» → «palabra»
        const ult = trozos[trozos.length - 1], sig = rs[k + 1].trozos[0]?.t.trimStart() || "";
        if (/[a-záéíóúñü]-$/i.test(ult.t) && /^[a-záéíóúñü]/.test(sig)) ult.t = ult.t.slice(0, -1);
        else if (!/\s$/.test(ult.t)) ult.t += " ";
      }
    });
    if (trozos.length) trozos[0].t = trozos[0].t.trimStart();
    const centros = rs.map((x) => (x.x0 + x.x1) / 2);
    const centrado = centros.every((c) => Math.abs(c - (izq + der) / 2) < Math.max(12, (der - izq) * 0.04)) && q.x0 > izq + size * 2;
    const justificado = !centrado && rs.length > 2 && rs.slice(0, -1).filter((x) => x.x1 > der - size * 1.5).length >= (rs.length - 1) * 0.8;
    const derecha = !centrado && rs.length <= 2 && q.x0 > izq + (der - izq) * 0.45 && rs.every((x) => x.x1 > der - size);
    const titulo = size >= cuerpo * 1.6 ? 1 : size >= cuerpo * 1.25 && rs.length <= 3 ? 2 : 0;
    const texto = trozos.map((t) => t.t).join("").trim();
    const margen = rs.length <= 2 && texto.length < 90 && (q.top < H * 0.08 || rs[rs.length - 1].base > H * 0.92) ? texto.replace(/\d+/g, "#").toLowerCase() : null;
    return { tipo: "p", top: q.top, margen, trozos, sangria: centrado || derecha ? 0 : Math.max(0, rs.length > 1 ? Math.min(...rs.slice(1).map((x) => x.x0)) - izq : q.x0 - izq),
      primera: rs.length > 1 ? rs[0].x0 - Math.min(...rs.slice(1).map((x) => x.x0)) : 0,
      antes: q.hueco === null ? 0 : Math.max(0, q.hueco - size * interlinea), alin: centrado ? "center" : derecha ? "right" : justificado ? "both" : null,
      titulo, interlinea, renglones: rs.length, size: Math.max(...trozos.map((t) => t.size), 1) };
  });
  // 3. imágenes: dónde se pinta cada una (siguiendo los cambios de posición de la lista de operaciones)
  const sinTexto = llenos.reduce((n, x) => n + x.trozos.reduce((m, t) => m + t.t.trim().length, 0), 0) < 20;
  if (conImagenes) {
    const O = pdfjs.OPS, pila = [];
    let ctm = v.transform.slice();
    const cajas = [];
    for (let k = 0; k < ops.fnArray.length; k++) {
      const fn = ops.fnArray[k], a = ops.argsArray[k];
      if (fn === O.save) pila.push(ctm);
      else if (fn === O.restore) ctm = pila.pop() || ctm;
      else if (fn === O.transform) ctm = pdfjs.Util.transform(ctm, a);
      else if (fn === O.paintFormXObjectBegin) { pila.push(ctm); if (a && a[0]) ctm = pdfjs.Util.transform(ctm, a[0]); }
      else if (fn === O.paintFormXObjectEnd) ctm = pila.pop() || ctm;
      else if (fn === O.paintImageXObject || fn === O.paintInlineImageXObject || fn === O.paintImageXObjectRepeat) {
        const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => pdfjs.Util.applyTransform([x, y], ctm));
        const x0 = Math.max(0, Math.min(...pts.map((q) => q[0]))), x1 = Math.min(W, Math.max(...pts.map((q) => q[0])));
        const y0 = Math.max(0, Math.min(...pts.map((q) => q[1]))), y1 = Math.min(H, Math.max(...pts.map((q) => q[1])));
        if (x1 - x0 < 24 || y1 - y0 < 24) continue;                                     // adornos y rayitas
        if (!sinTexto && (x1 - x0) * (y1 - y0) > W * H * 0.6) continue;                  // fondo de la hoja detrás del texto
        if (cajas.some((c) => x0 >= c.x0 - 2 && x1 <= c.x1 + 2 && y0 >= c.y0 - 2 && y1 <= c.y1 + 2)) continue;   // ya dentro de otra
        cajas.push({ x0, x1, y0, y1 });
      }
    }
    if (cajas.length) {
      const esc = Math.min(150 / 72, Math.sqrt(20e6 / (W * H))), vv = pagina.getViewport({ scale: esc });
      const c = lienzoNuevo(Math.round(vv.width), Math.round(vv.height)), ctx = c.getContext("2d");
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
      await pagina.render({ canvasContext: ctx, viewport: vv }).promise;
      for (const q of cajas) {
        const w = Math.max(1, Math.round((q.x1 - q.x0) * esc)), h = Math.max(1, Math.round((q.y1 - q.y0) * esc));
        const r2 = lienzoNuevo(w, h);
        r2.getContext("2d").drawImage(c, Math.round(q.x0 * esc), Math.round(q.y0 * esc), w, h, 0, 0, w, h);
        bloques.push({ tipo: "img", top: q.y0, x0: q.x0 - izq, ancho: q.x1 - q.x0, alto: q.y1 - q.y0, bytes: await guardarImagen(r2, "jpg", 0.88) });
        r2.width = 0;
      }
      c.width = 0;
    }
  }
  // Las imágenes van antes del primer párrafo que empieza más abajo que ellas
  const final = bloques.filter((b) => b.tipo === "p");
  for (const im of bloques.filter((b) => b.tipo === "img").sort((a, b) => a.top - b.top)) {
    const k = final.findIndex((b) => b.tipo === "p" && b.top > im.top);
    final.splice(k < 0 ? final.length : k, 0, im);
  }
  return { bloques: final, sinTexto, W, H, izq: llenos.length ? izq : 72, der: llenos.length ? der : W - 72,
    arriba: llenos.length ? Math.min(...llenos.map((x) => x.base - x.size)) : 72, abajo: llenos.length ? Math.max(...llenos.map((x) => x.base)) : H - 72 };
}
const xml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const tw = (pt) => Math.round(pt * 20);           // puntos → veinteavos de punto (medida de Word)
function docxDe(paginas, saltos) {
  const media = [];
  let cuerpoXml = "", nImg = 0;
  const p0 = paginas[0];
  const margenIzq = Math.max(36, Math.min(p0.izq, 108)), margenDer = Math.max(36, Math.min(p0.W - p0.der, 108));
  const margenArr = Math.max(36, Math.min(p0.arriba - 6, 90)), margenAba = Math.max(36, Math.min(p0.H - p0.abajo - 6, 90));
  const anchoTexto = p0.W - margenIzq - margenDer;
  paginas.forEach((pg, k) => {
    pg.bloques.forEach((b, j) => {
      const nueva = saltos && k > 0 && j === 0;
      if (b.tipo === "img") {
        nImg++;
        media.push({ nombre: `imagen${nImg}.jpg`, bytes: b.bytes });
        const f = Math.min(1, anchoTexto / b.ancho), cx = Math.round(b.ancho * f * 12700), cy = Math.round(b.alto * f * 12700);
        const ind = b.x0 > 12 && b.ancho * f + b.x0 < anchoTexto ? `<w:ind w:left="${tw(b.x0)}"/>` : "";
        cuerpoXml += `<w:p><w:pPr>${nueva ? "<w:pageBreakBefore/>" : ""}<w:spacing w:before="60" w:after="60"/>${ind}</w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${nImg}" name="Imagen ${nImg}"/>`
          + `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">`
          + `<pic:nvPicPr><pic:cNvPr id="${nImg}" name="imagen${nImg}.jpg"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rImg${nImg}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
          + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
        return;
      }
      let ppr = b.titulo ? `<w:pStyle w:val="Titulo${b.titulo}"/>` : "";
      if (nueva) ppr += "<w:pageBreakBefore/>";
      // Interlineado exacto como en el PDF (con «automático», Word le suma el alto propio de cada fuente)
      const linea = b.renglones > 1 ? ` w:line="${tw(b.interlinea * b.size)}" w:lineRule="exact"` : "";
      ppr += `<w:spacing w:before="${Math.min(tw(b.antes), 720)}" w:after="0"${linea}/>`;
      const sangria = Math.min(b.sangria, anchoTexto * 0.6), primera = Math.max(-sangria, Math.min(b.primera, anchoTexto * 0.4));
      if (sangria > 3 || Math.abs(primera) > 3) ppr += `<w:ind w:left="${tw(sangria)}"${primera > 3 ? ` w:firstLine="${tw(primera)}"` : primera < -3 ? ` w:hanging="${tw(-primera)}"` : ""}/>`;
      if (b.alin) ppr += `<w:jc w:val="${b.alin}"/>`;
      let runs = "";
      for (const t of b.trozos) {
        if (!t.t) continue;
        const rpr = `<w:rPr><w:rFonts w:ascii="${xml(t.familia)}" w:hAnsi="${xml(t.familia)}" w:cs="${xml(t.familia)}"/>${t.negrita ? "<w:b/>" : ""}${t.cursiva ? "<w:i/>" : ""}<w:sz w:val="${Math.round(t.size * 2)}"/><w:szCs w:val="${Math.round(t.size * 2)}"/></w:rPr>`;
        runs += t.t.split("\t").map((s, i) => (i ? `<w:r>${rpr}<w:tab/></w:r>` : "") + (s ? `<w:r>${rpr}<w:t xml:space="preserve">${xml(s)}</w:t></w:r>` : "")).join("");
      }
      cuerpoXml += `<w:p><w:pPr>${ppr}</w:pPr>${runs}</w:p>`;
    });
  });
  const sect = `<w:sectPr><w:pgSz w:w="${tw(p0.W)}" w:h="${tw(p0.H)}"${p0.W > p0.H ? ' w:orient="landscape"' : ""}/><w:pgMar w:top="${tw(margenArr)}" w:right="${tw(margenDer)}" w:bottom="${tw(margenAba)}" w:left="${tw(margenIzq)}" w:header="360" w:footer="360" w:gutter="0"/></w:sectPr>`;
  const documento = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body>${cuerpoXml}${sect}</w:body></w:document>`;
  const estilos = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">`
    + `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial" w:eastAsia="Arial"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="es-MX"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>`
    + `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>`
    + `<w:style w:type="paragraph" w:styleId="Titulo1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:outlineLvl w:val="0"/></w:pPr></w:style>`
    + `<w:style w:type="paragraph" w:styleId="Titulo2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:outlineLvl w:val="1"/></w:pPr></w:style></w:styles>`;
  const relsDoc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rEstilos" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
    + media.map((m, i) => `<Relationship Id="rImg${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${m.nombre}"/>`).join("") + `</Relationships>`;
  const tipos = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpg" ContentType="image/jpeg"/>`
    + `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rDoc" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  const cod = new TextEncoder();
  return zipSimple([
    { nombre: "[Content_Types].xml", bytes: cod.encode(tipos) }, { nombre: "_rels/.rels", bytes: cod.encode(rels) },
    { nombre: "word/document.xml", bytes: cod.encode(documento) }, { nombre: "word/styles.xml", bytes: cod.encode(estilos) },
    { nombre: "word/_rels/document.xml.rels", bytes: cod.encode(relsDoc) },
    ...media.map((m) => ({ nombre: "word/media/" + m.nombre, bytes: m.bytes })),
  ]);
}
$("botonPW").onclick = async () => {
  const a = paraWord;
  if (!a) return;
  $("botonPW").disabled = true;
  try {
    const cuales = [...new Set(leerRangos($("paginasPW").value, a.total).flat())].sort((x, y) => x - y);
    const pdfjs = await pdfJs(), paginas = [];
    let escaneadas = 0;
    for (const [k, i] of cuales.entries()) {
      aviso("avisoPW", `Leyendo la página ${k + 1} de ${cuales.length}…`);
      await pintar();
      const pg = await leerPaginaWord(pdfjs, await a.vista.getPage(i + 1), $("imagenesPW").checked);
      if (pg.sinTexto) escaneadas++;
      paginas.push(pg);
    }
    // Encabezados y pies de página (lo que se repite arriba o abajo, y los números de página): fuera
    const veces = new Map();
    for (const pg of paginas) for (const m of new Set(pg.bloques.map((b) => b.margen).filter(Boolean))) veces.set(m, (veces.get(m) || 0) + 1);
    const esPie = (m) => m && ((veces.get(m) >= 2 && paginas.length >= 2) || /^(p[aá]g(ina|\.)?\s*)?#(\s*(de|\/|of)\s*#)?$|^[-–—]\s*#\s*[-–—]$/.test(m));
    for (const pg of paginas) pg.bloques = pg.bloques.filter((b) => !esPie(b.margen));
    if (escaneadas === paginas.length && !paginas.some((p) => p.bloques.length))
      throw new Error("Este PDF no tiene texto (parece escaneado). Pásalo primero por «Reconocer texto» y luego conviértelo.");
    aviso("avisoPW", "Armando el documento de Word…");
    await pintar();
    const bytes = docxDe(paginas, $("saltosPW").checked);
    filaDescarga($("salidaPW"), bytes, sinExt(a.f.name) + ".docx", paginasTxt(paginas.length), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    aviso("avisoPW", "Listo." + (escaneadas ? ` ${escaneadas === 1 ? "Una página no tiene" : escaneadas + " páginas no tienen"} texto (parece${escaneadas === 1 ? "" : "n"} escaneada${escaneadas === 1 ? "" : "s"}): para que salga como texto, pasa el PDF antes por «Reconocer texto».` : ""));
    $("salidaPW").scrollIntoView({ block: "nearest", behavior: "smooth" });
  } catch (e) {
    aviso("avisoPW", String(e && e.message || e), true);
  } finally {
    $("botonPW").disabled = false;
  }
};
