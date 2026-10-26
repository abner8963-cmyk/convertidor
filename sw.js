// Service worker del convertidor.
//
// 1. Pone en todas las respuestas los encabezados COOP/COEP que LibreOffice necesita
//    (SharedArrayBuffer) y que GitHub Pages no deja configurar.
// 2. Sirve soffice.wasm y soffice.data desde el almacenamiento del navegador. La página
//    los baja una vez, comprimidos y en pedazos (partes.json), y los guarda ya armados;
//    si por algo faltan, aquí se arman igual.
// 3. Guarda la página y sus scripts para que funcione sin internet.

const VERSION = "2";
const CACHE_APP = "convertidor-app-" + VERSION;
const CACHE_LO = "convertidor-lo-2.7.2";          // cambia solo si cambia LibreOffice
const APP = ["./", "index.html", "manifest.webmanifest", "icono.svg", "partes.json",
             "lo/soffice.js", "lo/soffice.worker.js", "lo/browser.js", "lo/browser.worker.global.js"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE_APP).then((c) => c.addAll(APP)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const nombre of await caches.keys()) {
      if (nombre !== CACHE_APP && nombre !== CACHE_LO) await caches.delete(nombre);
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

async function deLaApp(peticion) {
  // Primero la red (para recibir las actualizaciones); sin internet, lo guardado.
  try {
    const resp = await fetch(peticion);
    if (resp.ok && peticion.method === "GET") {
      const copia = resp.clone();
      caches.open(CACHE_APP).then((c) => c.put(peticion, copia));
    }
    return conCabeceras(resp);
  } catch (err) {
    const guardada = await caches.match(peticion, { ignoreSearch: true })
      || (peticion.mode === "navigate" ? await caches.match("index.html") : null);
    if (guardada) return conCabeceras(guardada);
    throw err;
  }
}

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.endsWith("/lo/soffice.wasm")) return e.respondWith(deLibreOffice(e.request, "soffice.wasm"));
  if (url.pathname.endsWith("/lo/soffice.data")) return e.respondWith(deLibreOffice(e.request, "soffice.data"));
  if (url.pathname.includes("/lo/partes/")) return;      // los pedazos van directo a la red
  e.respondWith(deLaApp(e.request));
});
