// Procesamiento local. Un worker por operación permite cancelar incluso durante WASM.
const etapa = (texto, avance) => postMessage({ texto, avance });
const url = (nombre) => new URL(nombre, import.meta.url).href;
const sha256 = async (bytes) => Array.from(
  new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  (b) => b.toString(16).padStart(2, "0"),
).join("");

async function recurso(nombre, avance, bytesEsperados) {
  const r = await fetch(url(nombre));
  if (!r.ok) throw new Error(`No se pudo cargar ${nombre}. Revisa tu conexión.`);
  const total = bytesEsperados || Number(r.headers.get("Content-Length"));
  if (!avance || !total || !r.body) return new Uint8Array(await r.arrayBuffer());
  const lector = r.body.getReader(), bloques = [];
  let cargado = 0;
  for (;;) {
    const { value, done } = await lector.read();
    if (done) break;
    bloques.push(value);
    cargado += value.length;
    avance(Math.min(1, cargado / total));
  }
  const bytes = new Uint8Array(cargado);
  let pos = 0;
  for (const bloque of bloques) {
    bytes.set(bloque, pos);
    pos += bloque.length;
  }
  return bytes;
}

async function modelo(tipo) {
  if (tipo !== "fondo") return recurso(tipo === "foto" ? "esrgan.onnx" : "yunet.onnx",
    (p) => etapa("Cargando el modelo…", 0.5 + p * 0.4), tipo === "foto" ? 4866417 : 232589);
  const datos = JSON.parse(new TextDecoder().decode(await recurso("modnet.partes.json")));
  const bytes = new Uint8Array(datos.bytes);
  let pos = 0;
  for (const parte of datos.partes) {
    const pieza = await recurso(parte.archivo, (p) =>
      etapa("Cargando MODNet…", 0.5 + 0.4 * (pos + p * parte.bytes) / datos.bytes), parte.bytes);
    if (pieza.length !== parte.bytes || await sha256(pieza) !== parte.sha256) {
      const cache = await caches.open("convertidor-fase4b-1");
      await cache.delete(url(parte.archivo));
      throw new Error("Una parte del modelo se dañó. Intenta cargarla de nuevo.");
    }
    bytes.set(pieza, pos);
    pos += pieza.length;
  }
  if (pos !== bytes.length || await sha256(bytes) !== datos.sha256) throw new Error("El modelo está incompleto.");
  return bytes;
}

async function motor(gpu) {
  const ort = gpu ? await import("./ort.webgpu.min.mjs") : await import("./ort.wasm.min.mjs");
  const nombre = gpu ? "ort-wasm-simd-threaded.jsep" : "ort-wasm-simd-threaded";
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = { mjs: url(nombre + ".mjs") };
  ort.env.wasm.wasmBinary = await recurso(nombre + ".wasm",
    (p) => etapa("Cargando el motor de imágenes…", p * 0.5), gpu ? 21872216 : 11210254);
  return ort;
}

function contexto(w, h) {
  return new OffscreenCanvas(w, h).getContext("2d", { willReadFrequently: true });
}

function tensor(ort, ctx, transformar, bgr = false) {
  const { width: w, height: h } = ctx.canvas;
  const { data } = ctx.getImageData(0, 0, w, h);
  const n = w * h, valores = new Float32Array(n * 3);
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < n; i++) valores[c * n + i] = transformar(data[i * 4 + (bgr ? 2 - c : c)]);
  }
  return new ort.Tensor("float32", valores, [1, 3, h, w]);
}

async function quitarFondo(ctx, ort, sesion) {
  const { width: w, height: h } = ctx.canvas;
  const escala = 512 / Math.max(w, h);
  const redondear = (v) => Math.max(32, Math.round(v * escala / 32) * 32);
  const reducida = contexto(redondear(w), redondear(h));
  const mw = reducida.canvas.width, mh = reducida.canvas.height;
  reducida.drawImage(ctx.canvas, 0, 0, mw, mh);
  const resultado = await sesion.run({ [sesion.inputNames[0]]: tensor(ort, reducida, (v) => v / 127.5 - 1) });
  const mascara = reducida.createImageData(mw, mh);
  const valores = resultado[sesion.outputNames[0]].data;
  for (let i = 0; i < valores.length; i++) mascara.data[4 * i + 3] = valores[i] * 255;
  reducida.putImageData(mascara, 0, 0);
  ctx.globalCompositeOperation = "destination-in";
  ctx.drawImage(reducida.canvas, 0, 0, w, h);
  return ctx.canvas.convertToBlob();
}

async function ampliar(ctx, ort, sesion, escala, informar) {
  const { width: w, height: h } = ctx.canvas;
  const salida = contexto(w * escala, h * escala);
  const lado = 96, margen = 20;
  const total = Math.ceil(w / lado) * Math.ceil(h / lado);
  let hecho = 0;
  for (let y = 0; y < h; y += lado) {
    for (let x = 0; x < w; x += lado) {
      const izq = Math.max(0, x - margen), sup = Math.max(0, y - margen);
      const ancho = Math.min(w, x + lado + margen) - izq;
      const alto = Math.min(h, y + lado + margen) - sup;
      const mosaico = contexto(ancho, alto);
      mosaico.drawImage(ctx.canvas, izq, sup, ancho, alto, 0, 0, ancho, alto);
      const resultado = await sesion.run({ [sesion.inputNames[0]]: tensor(ort, mosaico, (v) => v / 255) });
      const valores = resultado[sesion.outputNames[0]].data;
      const tw = ancho * 4, th = alto * 4, n = tw * th;
      const pixeles = mosaico.createImageData(tw, th);
      // El modelo es ×4. Para ×2 se reduce cada región válida a la mitad.
      for (let i = 0; i < n; i++) {
        for (let c = 0; c < 3; c++) pixeles.data[4 * i + c] = valores[c * n + i] * 255;
        pixeles.data[4 * i + 3] = 255;
      }
      const grande = contexto(tw, th);
      grande.putImageData(pixeles, 0, 0);
      const cw = Math.min(lado, w - x), ch = Math.min(lado, h - y);
      salida.drawImage(grande.canvas, (x - izq) * 4, (y - sup) * 4, cw * 4, ch * 4,
        x * escala, y * escala, cw * escala, ch * escala);
      informar(++hecho / total);
    }
  }
  // Conserva el canal alfa de la imagen original.
  salida.globalCompositeOperation = "destination-in";
  salida.drawImage(ctx.canvas, 0, 0, salida.canvas.width, salida.canvas.height);
  return salida.canvas.convertToBlob();
}

async function detectar(ctx, ort, sesion) {
  const lado = 640, escala = lado / Math.max(ctx.canvas.width, ctx.canvas.height);
  const w = Math.max(1, Math.round(ctx.canvas.width * escala));
  const h = Math.max(1, Math.round(ctx.canvas.height * escala));
  const reducida = contexto(lado, lado);
  reducida.drawImage(ctx.canvas, 0, 0, w, h);
  const salida = await sesion.run({ [sesion.inputNames[0]]: tensor(ort, reducida, (v) => v, true) });
  const caras = [];
  for (const paso of [8, 16, 32]) {
    const cols = lado / paso;
    const cls = salida["cls_" + paso].data, obj = salida["obj_" + paso].data;
    const box = salida["bbox_" + paso].data;
    for (let i = 0; i < cls.length; i++) {
      const score = Math.sqrt(Math.min(1, Math.max(0, cls[i])) * Math.min(1, Math.max(0, obj[i])));
      if (score < 0.65) continue;
      const cx = (i % cols + box[4 * i]) * paso, cy = (Math.floor(i / cols) + box[4 * i + 1]) * paso;
      const bw = Math.exp(box[4 * i + 2]) * paso * 1.2, bh = Math.exp(box[4 * i + 3]) * paso * 1.2;
      const x = Math.max(0, (cx - bw / 2) / w), y = Math.max(0, (cy - bh / 2) / h);
      const rw = Math.min(1, (cx + bw / 2) / w) - x;
      const rh = Math.min(1, (cy + bh / 2) / h) - y;
      if (rw > 0 && rh > 0) caras.push({ x, y, w: rw, h: rh, score });
    }
  }
  const elegidas = [];
  for (const a of caras.sort((a, b) => b.score - a.score)) {
    if (elegidas.some((b) => {
      const area = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
        Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
      return area / (a.w * a.h + b.w * b.h - area) > 0.3;
    })) continue;
    elegidas.push(a);
  }
  return elegidas;
}

async function exportarImagen(ctx, tipo, opciones) {
  if (tipo === "color") {
    ctx.globalCompositeOperation = "destination-over";
    ctx.fillStyle = opciones.color;
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  } else {
    for (const r of opciones.regiones) {
      const x = Math.floor(r.x * ctx.canvas.width), y = Math.floor(r.y * ctx.canvas.height);
      const w = Math.ceil((r.x + r.w) * ctx.canvas.width) - x;
      const h = Math.ceil((r.y + r.h) * ctx.canvas.height) - y;
      const fuerza = Math.max(2, Math.min(w, h) * opciones.intensidad / 100 * 0.24);
      const copia = contexto(w, h);
      copia.drawImage(ctx.canvas, x, y, w, h, 0, 0, w, h);
      if (opciones.efecto === "pixelar") {
        const chica = contexto(Math.max(1, Math.round(w / fuerza)), Math.max(1, Math.round(h / fuerza)));
        chica.drawImage(copia.canvas, 0, 0, chica.canvas.width, chica.canvas.height);
        ctx.clearRect(x, y, w, h);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(chica.canvas, x, y, w, h);
      } else {
        // Extiende los bordes para que el filtro no vuelva translúcido el recuadro.
        const borde = Math.ceil(fuerza * 3);
        const relleno = contexto(w + 2 * borde, h + 2 * borde);
        for (let v = -1; v <= 1; v++) {
          for (let u = -1; u <= 1; u++) {
            const sx = u < 0 ? 0 : u > 0 ? w - 1 : 0;
            const sy = v < 0 ? 0 : v > 0 ? h - 1 : 0;
            relleno.drawImage(copia.canvas, sx, sy, u ? 1 : w, v ? 1 : h,
              u < 0 ? 0 : u > 0 ? borde + w : borde, v < 0 ? 0 : v > 0 ? borde + h : borde,
              u ? borde : w, v ? borde : h);
          }
        }
        copia.clearRect(0, 0, w, h);
        copia.filter = `blur(${fuerza}px)`;
        copia.drawImage(relleno.canvas, -borde, -borde);
        ctx.clearRect(x, y, w, h);
        ctx.drawImage(copia.canvas, x, y);
      }
    }
  }
  return ctx.canvas.convertToBlob();
}

async function pdfa(f, nivel) {
  const { default: crear } = await import("./gs.mjs");
  const [wasmBinary, perfil, prefijo] = await Promise.all([
    recurso("gs.wasm", (p) => etapa("Cargando Ghostscript…", p * 0.9), 15533045),
    recurso("srgb.icc"), recurso("PDFA_def.ps"),
  ]);
  etapa("Convirtiendo a PDF/A…");
  const mensajes = [];
  const m = await crear({ wasmBinary, print: (t) => mensajes.push(t), printErr: (t) => mensajes.push(t) });
  m.FS.writeFile("/entrada.pdf", new Uint8Array(await f.arrayBuffer()));
  m.FS.writeFile("/srgb.icc", perfil);
  m.FS.writeFile("/PDFA_def.ps", prefijo);
  // PDF/A-1 aplana transparencias. Acota la resolución y favorece el búfer en memoria.
  const aplanar = nivel === 1 ? ["-r150", "-dMaxBitmap=67108864"] : [];
  const codigo = m.callMain([
    "-dSAFER", "--permit-file-read=/srgb.icc", "-dBATCH", "-dNOPAUSE", "-sDEVICE=pdfwrite",
    `-dPDFA=${nivel}`, "-dPDFACompatibilityPolicy=1", "-sColorConversionStrategy=RGB",
    "-sOutputFile=/salida.pdf", ...aplanar, "/PDFA_def.ps", "/entrada.pdf",
  ]);
  if (codigo || mensajes.some((t) => /PDF\/A processing aborted|PDF\/A .*reverting/i.test(t))) {
    if (mensajes.some((t) => /password|encrypted/i.test(t))) throw new Error("El PDF tiene contraseña. Quítasela primero.");
    throw new Error("Ghostscript no pudo convertir este archivo a PDF/A.");
  }
  const bytes = m.FS.readFile("/salida.pdf");
  const texto = new TextDecoder().decode(bytes);
  const campo = (n, v) => new RegExp(`(?:<pdfaid:${n}>\\s*${v}\\s*</pdfaid:${n}>|pdfaid:${n}=["']${v}["'])`).test(texto);
  if (!/\/OutputIntents\b/.test(texto) || !campo("part", nivel) || !campo("conformance", "B")) {
    throw new Error("La salida no contiene el perfil y los metadatos PDF/A solicitados.");
  }
  return new Blob([bytes], { type: "application/pdf" });
}

async function imagenes(tipo, archivos, opciones) {
  const requiereModelo = ["fondo", "foto", "caras"].includes(tipo);
  const adaptador = tipo === "fondo" ? await self.navigator.gpu?.requestAdapter().catch(() => null) : null;
  // Un adaptador de software puede tardar mucho más que WASM con este modelo.
  const gpu = !!adaptador && !adaptador.info?.isFallbackAdapter;
  let ort, sesion, pesos;
  async function iniciar(usarGpu) {
    ort = await motor(usarGpu);
    pesos ??= await modelo(tipo);
    etapa("Preparando el modelo…");
    sesion = await ort.InferenceSession.create(pesos, { executionProviders: [usarGpu ? "webgpu" : "wasm"] });
  }
  let enGpu = gpu;
  if (requiereModelo) {
    try { await iniciar(enGpu); }
    catch (error) {
      if (!enGpu) throw error;
      enGpu = false;
      await iniciar(false);
    }
  }
  const resultados = [], errores = [];
  try {
    for (const [i, f] of archivos.entries()) {
      const informar = (p) => etapa(`Imagen ${i + 1} de ${archivos.length}…`, (i + p) / archivos.length);
      informar(0);
      try {
        if (tipo === "copiar") {
          resultados.push({ ...opciones.dimensiones[i], i, blob: f });
          continue;
        }
        const mapa = await createImageBitmap(f, { imageOrientation: "from-image" });
        let ctx;
        try {
          const { width: w, height: h } = mapa;
          if (tipo === "foto" && (w * h > 1_000_000 || Math.max(w, h) > 1600)) {
            throw new Error("El límite es 1 megapíxel y 1600 px por lado.");
          }
          if (w * h > 20_000_000 || Math.max(w, h) > 8192) throw new Error("La imagen excede el límite de 20 megapíxeles o 8192 px por lado.");
          ctx = contexto(w, h);
          ctx.drawImage(mapa, 0, 0);
        } finally { mapa.close(); }
        let blob, regiones;
        if (tipo === "fondo") {
          try { blob = await quitarFondo(ctx, ort, sesion); }
          catch (error) {
            if (!enGpu) throw error;
            enGpu = false;
            await sesion.release();
            await iniciar(false);
            blob = await quitarFondo(ctx, ort, sesion);
          }
        } else if (tipo === "foto") blob = await ampliar(ctx, ort, sesion, opciones.escala, informar);
        else if (tipo === "caras") regiones = await detectar(ctx, ort, sesion);
        else blob = await exportarImagen(ctx, tipo, { ...opciones, regiones: opciones.regiones?.[i] });
        const escala = opciones.escala || 1;
        resultados.push({ i, blob, regiones, w: ctx.canvas.width * escala, h: ctx.canvas.height * escala });
      } catch (e) { errores.push(`«${f.name}» ${e.message}`); }
    }
  } finally { await sesion?.release(); }
  return { resultados, errores };
}

self.onmessage = async ({ data: { tipo, archivos, opciones } }) => {
  try {
    const valor = tipo === "pdfa" ? await pdfa(archivos[0], opciones.nivel) : await imagenes(tipo, archivos, opciones);
    postMessage({ valor });
  } catch (e) {
    postMessage({ error: e instanceof WebAssembly.RuntimeError
      ? "El motor se detuvo al procesar el archivo. Prueba con un archivo más pequeño."
      : e.message || "No se pudo terminar el procesamiento." });
  }
};
