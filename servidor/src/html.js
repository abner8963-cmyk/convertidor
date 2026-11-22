// SPDX-License-Identifier: AGPL-3.0-or-later
import puppeteer from "@cloudflare/puppeteer";
import ipaddr from "ipaddr.js";
import { codificar, error, leerJson } from "./comun.js";

const papel = { carta: { format: "Letter" }, a4: { format: "A4" }, oficio: { width: "216mm", height: "340mm" } };
const margenes = { normal: "0.75in", chico: "0.35in", ninguno: "0in" };
const topeHtml = 2_000_000;

function esIpPublica(ip) {
  if (!ipaddr.isValid(ip)) return false;
  const direccion = ipaddr.process(ip);
  if (direccion.range() !== "unicast") return false;
  if (direccion.kind() === "ipv6") return direccion.match(ipaddr.parse("2000::"), 3)
    && !direccion.match(ipaddr.parse("2001::"), 23)
    && !direccion.match(ipaddr.parse("3fff::"), 20);
  return !direccion.match(ipaddr.parse("192.0.0.0"), 24)
    && !direccion.match(ipaddr.parse("198.18.0.0"), 15);
}

function urlPublica(texto) {
  let url;
  try { url = new URL(texto); } catch { /* se rechaza abajo */ }
  const host = url?.hostname.replace(/^\[|\]$|\.$/g, "");
  if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port
      || (ipaddr.isValid(host) ? !esIpPublica(host)
        : !host.includes(".") || /(?:^|\.)(localhost|local|internal|home\.arpa|localdomain|test|invalid|onion)$/.test(host))) {
    error(400, "Usa una dirección pública http o https, sin un puerto especial.");
  }
  return url;
}

async function validarDns(url, signal) {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (ipaddr.isValid(host)) return;
  const ips = await Promise.all(["A", "AAAA"].map(async (type) => {
    const dns = new URL("https://cloudflare-dns.com/dns-query");
    dns.search = new URLSearchParams({ name: host, type });
    const r = await fetch(dns, { headers: { Accept: "application/dns-json" }, signal, redirect: "manual" });
    if (!r.ok) error(502, "No pudimos revisar la dirección de la página.");
    const respuesta = await r.json();
    return (respuesta.Answer || []).filter((a) => a.type === 1 || a.type === 28).map((a) => a.data);
  }));
  const direcciones = ips.flat();
  if (!direcciones.length || direcciones.some((ip) => !esIpPublica(ip))) {
    error(400, "La dirección debe apuntar a un sitio público.");
  }
}

function pdfDePrueba() {
  const texto = "BT /F1 18 Tf 72 700 Td (Navaja PDF - modo pruebas) Tj ET";
  const objetos = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${texto.length} >>\nstream\n${texto}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const pos = objetos.map((obj, i) => {
    const inicio = pdf.length;
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
    return inicio;
  });
  const xref = pdf.length;
  return codificar.encode(pdf + "xref\n0 6\n0000000000 65535 f \n"
    + pos.map((n) => String(n).padStart(10, "0") + " 00000 n \n").join("")
    + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

async function renderizar(env, url, html, opciones) {
  if (url) await validarDns(url, AbortSignal.timeout(5000));
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    await page.setJavaScriptEnabled(Boolean(url));
    await page.setBypassServiceWorker(true);
    await page.setRequestInterception(true);
    const csp = "script-src 'none'; object-src 'none'; frame-src 'none'; connect-src 'none'; form-action 'none'";
    // El navegador aislado de Cloudflare carga la página directamente (así funcionan
    // las páginas con JavaScript sin gastar subsolicitudes del Worker). Solo dejamos
    // pasar http/https hacia nombres o IP públicos, y data:/blob:; lo demás se corta.
    let solicitudes = 0;
    page.on("request", (r) => {
      const destino = r.url();
      if (/^(data|blob):/i.test(destino)) return r.continue().catch(() => {});
      if (!url || ++solicitudes > 400) return r.abort().catch(() => {});
      try {
        urlPublica(destino);
      } catch {
        return r.abort().catch(() => {});
      }
      return r.continue().catch(() => {});
    });
    try {
      if (url) {
        await page.setUserAgent((await browser.userAgent()).replace("HeadlessChrome", "Chrome"));
        await page.emulateMediaType("screen");
        await page.setViewport({ width: 1280, height: 900 });
        await page.setExtraHTTPHeaders({ "Accept-Language": "es-MX,es;q=0.9,en;q=0.8" });
        const resp = await page.goto(url.href, { waitUntil: "networkidle2", timeout: 20_000 });
        if (resp && !resp.ok()) error(422, "La página no se pudo abrir (respondió " + resp.status() + "). Revisa la dirección.");
        const tipo = resp?.headers()["content-type"] || "";
        if (tipo && !/^(text\/html|application\/xhtml\+xml)(;|$)/i.test(tipo)) error(422, "Esa dirección no devuelve una página HTML.");
        // Bajar la página poco a poco para que carguen las imágenes diferidas.
        await page.evaluate(async () => {
          const fin = Date.now() + 4000;
          for (let y = 0; y < document.body.scrollHeight && Date.now() < fin; y += innerHeight) {
            scrollTo(0, y);
            await new Promise((listo) => setTimeout(listo, 150));
          }
          scrollTo(0, 0);
        }).catch(() => {});
        await page.waitForNetworkIdle({ idleTime: 500, timeout: 4000 }).catch(() => {});
      } else {
        await page.setContent('<meta http-equiv="Content-Security-Policy" content="default-src data: blob:; style-src \'unsafe-inline\' data:; ' + csp + '">' + html,
          { waitUntil: "networkidle0", timeout: 20_000 });
      }
    } catch (e) {
      console.error("html-a-pdf carga:", e?.name, e?.message);
      if (e.status) throw e;
      if (e.name === "TimeoutError") error(504, "La página tardó más de 20 segundos en cargar.");
      error(422, "No pudimos abrir la página para convertirla.");
    }
    return await page.pdf({ ...opciones, timeout: 8000 });
  } finally {
    await browser.close().catch(() => {});
  }
}

export async function htmlAPdf(req, env) {
  const { url, html, tamano = "carta", horizontal = false, margen = "normal", fondo = false } = await leerJson(req, 12_001_000);
  if ((typeof url === "string") === (typeof html === "string") || (url !== undefined && typeof url !== "string")
      || (html !== undefined && (typeof html !== "string" || !html.trim()))
      || !Object.hasOwn(papel, tamano) || !Object.hasOwn(margenes, margen)
      || typeof horizontal !== "boolean" || typeof fondo !== "boolean") error(400, "Envía una dirección o un archivo HTML y elige opciones válidas.");
  if (html && codificar.encode(html).length > topeHtml) error(413, "El archivo HTML debe pesar hasta 2 MB.");
  if (url?.length > 4096) error(400, "La dirección de la página es demasiado larga.");
  const destino = url !== undefined ? urlPublica(url) : null;
  const m = margenes[margen];
  try {
    const pdf = env.MODO_PRUEBAS === "1" ? pdfDePrueba() : await renderizar(env, destino, html, {
      ...papel[tamano], landscape: horizontal, printBackground: fondo, margin: { top: m, right: m, bottom: m, left: m },
    });
    return new Response(pdf, { headers: { "Content-Type": "application/pdf" } });
  } catch (e) {
    console.error("html-a-pdf:", e?.name, e?.message);
    if (e.status === 429 || /\b429\b/.test(e.message)) error(429, "El convertidor está ocupado o se acabó el tiempo gratis de hoy. Espera un minuto e intenta otra vez.");
    if (e.status) throw e;
    error(502, "No se pudo generar el PDF. Intenta otra vez.");
  }
}
