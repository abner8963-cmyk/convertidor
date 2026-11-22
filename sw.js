// Service worker del convertidor.
//
// 1. Pone en todas las respuestas los encabezados COOP/COEP que LibreOffice necesita
//    (SharedArrayBuffer) y que GitHub Pages no deja configurar.
// 2. Sirve soffice.wasm y soffice.data desde el almacenamiento del navegador. La página
//    los baja una vez, comprimidos y en pedazos (partes.json), y los guarda ya armados;
//    si por algo faltan, aquí se arman igual.
// 3. Guarda la página y sus scripts para que funcione sin internet.

const VERSION = "27";
const CACHE_COMPARTIDO = "convertidor-compartido";
const CACHE_APP = "convertidor-app-" + VERSION;
const CACHE_LO = "convertidor-lo-2.7.2";          // cambia solo si cambia LibreOffice
const CACHE_HEIC = "convertidor-heic-kvazaar-1";
const ARCHIVOS_HEIC = new Set(["lib/libheif.js", "lib/libheif.wasm", "lib/heic-enc.mjs", "lib/heic-enc.wasm"]);
const CACHE_FASE4 = "convertidor-fase4b-1";
const CACHE_OCR = "convertidor-ocr-7.0.0";        // cambia solo si cambia Tesseract o sus idiomas
const APP = ["./", "index.html", "app.js", "app.css", "manifest.webmanifest", "icono.svg", "icono-192.png", "icono-512.png", "partes.json",
             "comparar-pdf/", "pdf-a-markdown/", "pdf-a-powerpoint/", "pdf-a-excel/", "marca-de-agua-imagen/",
             "pdf-a-pdfa/", "quitar-fondo/", "mejorar-foto/", "difuminar-caras/",
             "lib/fase4/worker.js", "lib/pdf-lib.min.js", "lib/pdf.min.mjs", "lib/pdf.worker.min.mjs", "lib/qpdf.js", "lib/qpdf.wasm", "lo/soffice.js", "lo/soffice.worker.js", "lo/browser.js", "lo/browser.worker.global.js"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE_APP).then((c) => c.addAll(APP)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const nombre of await caches.keys()) {
      if (nombre !== CACHE_APP && nombre !== CACHE_LO && nombre !== CACHE_OCR && nombre !== CACHE_COMPARTIDO && nombre !== CACHE_HEIC && nombre !== CACHE_FASE4) await caches.delete(nombre);
    }
    await self.clients.claim();
  })());
});

function conCabeceras(resp) {
  if (!resp || resp.status === 0) return resp;
  const h = new Headers(resp.headers);
  h.set("Cross-Origin-Opener-Policy", "same-origin");
  h.set("Cross-Origin-Embedder-Policy", "require-corp");
  h.set("Cross-Origin-Resource-Policy", "same-origin");
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
}

// Arma un archivo de LibreOffice a partir de sus pedazos .gz y lo guarda descomprimido.
// La página hace lo mismo (con barra de avance); esto es solo el respaldo.
async function armar(nombre) {
  const partes = await (await fetch("partes.json", { cache: "no-cache" })).json();
  const info = partes[nombre];
  let i = 0, lector = null;
  const comprimido = new ReadableStream({
    async pull(ctrl) {
      for (;;) {
        if (!lector) {
          if (i >= info.partes.length) return ctrl.close();
          const r = await fetch("lo/partes/" + info.partes[i++], { cache: "no-cache" });
          if (!r.ok) throw new Error("No se pudo bajar " + info.partes[i - 1]);
          lector = r.body.getReader();
        }
        const { done, value } = await lector.read();
        if (done) { lector = null; continue; }
        return ctrl.enqueue(value);
      }
    },
  });
  const cuerpo = comprimido.pipeThrough(new DecompressionStream("gzip"));
  const cache = await caches.open(CACHE_LO);
  await cache.put(new URL("lo/" + nombre, self.registration.scope).href, new Response(cuerpo, {
    headers: { "Content-Type": info.tipo, "Content-Length": String(info.tam) },
  }));
}

async function deLibreOffice(peticion, nombre) {
  const cache = await caches.open(CACHE_LO);
  const clave = new URL("lo/" + nombre, self.registration.scope).href;
  let resp = await cache.match(clave);
  if (!resp) {
    await armar(nombre);
    resp = await cache.match(clave);
  }
  return conCabeceras(resp);
}

// Los archivos de OCR y HEIC se bajan al usarlos y se guardan aunque la app se actualice.
async function recursoBajoDemanda(peticion, nombreCache) {
  const cache = await caches.open(nombreCache);
  const guardada = await cache.match(peticion, { ignoreSearch: true });
  if (guardada) return conCabeceras(guardada);
  const resp = await fetch(peticion);
  if (resp.ok && peticion.method === "GET") await cache.put(peticion, resp.clone());
  return conCabeceras(resp);
}

// Sin internet, una herramienta que no se ha abierto antes (…/unir-pdf/) se arma con la
// portada guardada: es la misma app, solo cambia el <base> porque está una carpeta abajo.
async function paginaDeRespaldo(peticion) {
  const portada = await caches.match(new URL("index.html", self.registration.scope).href);
  if (!portada) return null;
  const dentro = new URL(peticion.url).pathname.slice(new URL(self.registration.scope).pathname.length);
  if (!dentro.replace(/index\.html$/, "").includes("/")) return portada;
  const texto = (await portada.text()).replace('<base href="./">', '<base href="../">');
  return new Response(texto, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

async function deLaApp(peticion) {
  // Primero la red (para recibir las actualizaciones), pero sin esperarla más de 3 s si ya
  // hay copia guardada: en redes que no llegan a GitHub Pages (algunas de datos móviles)
  // la conexión se queda colgada en vez de fallar, y la app tardaría en abrir.
  const guardada = caches.open(CACHE_APP).then((c) => c.match(peticion, { ignoreSearch: true }))
    .then((r) => r || (peticion.mode === "navigate" ? paginaDeRespaldo(peticion) : null));
  const red = fetch(peticion).then((resp) => {
    if (resp.ok && peticion.method === "GET") {
      const copia = resp.clone();
      caches.open(CACHE_APP).then((c) => c.put(peticion, copia));
    }
    return resp;
  });
  red.catch(() => {});                       // si gana el plazo y luego la red falla, no es error
  const plazo = new Promise((ok) => setTimeout(ok, 3000, "plazo"));
  try {
    const primero = await Promise.race([red, plazo]);
    if (primero !== "plazo") return conCabeceras(primero);
    const copia = await guardada;
    if (copia) return conCabeceras(copia);
    return conCabeceras(await red);           // sin copia: no queda más que esperar a la red
  } catch (err) {
    const copia = await guardada;
    if (copia) return conCabeceras(copia);
    throw err;
  }
}

async function recibirCompartido(peticion) {
  const destino = new URL("./", self.registration.scope);
  try {
    const datos = await peticion.formData();
    const archivos = datos.getAll("archivos").filter((f) => f instanceof File && f.name && f.size);
    if (!archivos.length) throw new Error("No llegaron archivos");
    const cache = await caches.open(CACHE_COMPARTIDO), ahora = Date.now();
    const vencidas = (await cache.keys()).filter((r) => Number(r.url.split("/").pop().split("-")[0]) < ahora - 86400000);
    await Promise.all(vencidas.map((r) => cache.delete(r)));
    const id = `${ahora}-${crypto.randomUUID()}`;
    const guardados = new FormData();
    for (const f of archivos) guardados.append("archivos", f);
    await cache.put(new URL(`compartir/${id}`, destino), new Response(guardados));
    destino.searchParams.set("compartido", id);
  } catch {
    destino.searchParams.set("compartido", "error");
  }
  return Response.redirect(destino, 303);
}

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  if (e.request.method === "POST" && url.pathname === new URL("compartir/", self.registration.scope).pathname) {
    return e.respondWith(recibirCompartido(e.request));
  }
  if (url.pathname.endsWith("/lo/soffice.wasm")) return e.respondWith(deLibreOffice(e.request, "soffice.wasm"));
  if (url.pathname.endsWith("/lo/soffice.data")) return e.respondWith(deLibreOffice(e.request, "soffice.data"));
  if (url.pathname.includes("/ocr/")) return e.respondWith(recursoBajoDemanda(e.request, CACHE_OCR));
  const ruta = url.pathname.slice(new URL(self.registration.scope).pathname.length);
  if (ruta.startsWith("lib/fase4/") && ruta !== "lib/fase4/worker.js" && e.request.method === "GET") {
    const cache = caches.open(CACHE_FASE4);
    const respuesta = cache.then(async (c) => {
      const guardada = await c.match(e.request);
      if (guardada) return { resp: guardada };
      const resp = await fetch(e.request);
      return { resp, guardado: resp.ok ? c.put(e.request, resp.clone()).catch(() => {}) : undefined };
    });
    e.waitUntil(respuesta.then(({ guardado }) => guardado).catch(() => {}));
    return e.respondWith(respuesta.then(({ resp }) => conCabeceras(resp)));
  }
  if (ARCHIVOS_HEIC.has(ruta)) return e.respondWith(recursoBajoDemanda(e.request, CACHE_HEIC));
  if (url.pathname.includes("/lo/partes/")) return;      // los pedazos van directo a la red
  e.respondWith(deLaApp(e.request));
});
