// SPDX-License-Identifier: AGPL-3.0-or-later
import { DurableObject } from "cloudflare:workers";
import { azar, codificar, error, hex, json, leerJson, respuestaError } from "./comun.js";
import { firmas } from "./firmas.js";
import { htmlAPdf } from "./html.js";
import { ia } from "./ia.js";

export { Solicitud } from "./firmas.js";

const HORA = 3600;
const cuotas = { HTML: 25, IA: 200_000, FIRMAS: 350, PASE: 1500 };
const cuota = (env, tipo, unidades = 1) => env.CUOTA.getByName(tipo).consumir(cuotas[tipo], unidades);
export class Cuota extends DurableObject {
  consumir(maximo, unidades) {
    const dia = new Date().toISOString().slice(0, 10);
    return this.ctx.storage.transaction(async (tx) => {
      const anterior = await tx.get("consumo");
      const total = (anterior?.dia === dia ? anterior.total : 0) + unidades;
      if (total > maximo) return false;
      await tx.put("consumo", { dia, total });
      return true;
    });
  }
}

async function limitar(req, env, tipo) {
  const ip = req.headers.get("CF-Connecting-IP") || "local";
  if (!(await env["LIMITE_" + tipo].limit({ key: ip })).success) error(429, "Demasiadas solicitudes. Espera un minuto e intenta otra vez.");
}

async function clavePase(env) {
  const material = env.PASE_SECRET ? codificar.encode(env.PASE_SECRET)
    : await crypto.subtle.digest("SHA-256", codificar.encode("navaja-pase-v1:" + (env.TURNSTILE_SECRET || "pruebas-locales")));
  return crypto.subtle.importKey("raw", material, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function emitirPase(req, env, url, origen) {
  await limitar(req, env, "PASE");
  if (env.TURNSTILE_SECRET) {
    const { token } = await leerJson(req, 4096);
    if (typeof token !== "string" || !token || token.length > 2048) error(400, "Falta la verificación de Turnstile.");
    const datos = { secret: env.TURNSTILE_SECRET, response: token };
    const ip = req.headers.get("CF-Connecting-IP");
    if (ip) datos.remoteip = ip;
    const verificado = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(datos), signal: AbortSignal.timeout(8000),
    });
    const resultado = await verificado.json();
    if (!resultado.success || (env.TURNSTILE_SECRET !== "1x0000000000000000000000000000000AA"
        && (resultado.hostname !== url.hostname || resultado.action !== "navaja"))) {
      error(403, "Turnstile no pudo verificarte. Intenta otra vez.");
    }
  }
  if (!await cuota(env, "PASE")) error(429, "Se alcanzó el límite de hoy. Intenta mañana.");
  const vence = Math.floor(Date.now() / 1000) + HORA;
  const datos = vence + "." + azar();
  const firma = await crypto.subtle.sign("HMAC", await clavePase(env), codificar.encode(datos + "|" + origen));
  return json({ pase: datos + "." + hex(new Uint8Array(firma)), vence });
}

async function revisarPase(req, env, origen) {
  const pase = req.headers.get("X-Navaja-Pase") || "";
  const partes = pase.match(/^(\d{10}\.[a-f0-9]{48})\.([a-f0-9]{64})$/);
  if (!partes || Number(pase.slice(0, 10)) <= Date.now() / 1000
      || !await crypto.subtle.verify("HMAC", await clavePase(env), Uint8Array.from(partes[2].match(/../g), (n) => parseInt(n, 16)),
        codificar.encode(partes[1] + "|" + origen))) {
    error(401, "Tu pase venció o no es válido. Verifícate otra vez.");
  }
}

function verificar(url, env, origenes) {
  const vuelta = url.searchParams.get("vuelta");
  const canal = url.searchParams.get("canal");
  const sitekey = env.TURNSTILE_SITEKEY || "";
  const permitidos = origenes.map((o) => o + (o === "https://abner8963-cmyk.github.io" ? "/convertidor/" : "/"));
  if (!permitidos.includes(vuelta) || !/^[a-f0-9-]{36}$/.test(canal || "") || !/^[\w-]+$/.test(sitekey)) {
    error(400, "No se pudo abrir la verificación.");
  }
  const nonce = azar();
  return new Response(`<!doctype html><html lang="es-MX"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Verificación · Navaja PDF</title><h1>Verificación de Navaja PDF</h1>
<p id="aviso" role="status">Completa la verificación para regresar a Navaja PDF.</p><div id="reto"></div>
<script nonce="${nonce}">
function iniciar() {
  turnstile.render("#reto", { sitekey: ${JSON.stringify(sitekey)}, action: "navaja",
    callback(token) { location.replace(${JSON.stringify(vuelta + "#verificado=" + canal + ".")} + encodeURIComponent(token)); },
    "error-callback": () => { document.getElementById("aviso").textContent = "No se pudo cargar la verificación. Cierra esta ventana e intenta otra vez."; }
  });
}
</script><script src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=iniciar&render=explicit" async defer></script></html>`, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; frame-ancestors 'none'; base-uri 'none'`,
    },
  });
}

async function ruta(req, env, url, origen, origenes) {
  const path = url.pathname;
  if (path === "/api/verificar" && req.method === "GET") return verificar(url, env, origenes);
  if (path === "/api/config" && req.method === "GET") {
    if (env.TURNSTILE_SECRET && !env.TURNSTILE_SITEKEY) error(503, "La verificación todavía no está configurada.");
    return json({ sitekey: env.TURNSTILE_SECRET ? env.TURNSTILE_SITEKEY : null });
  }
  if (path === "/api/pase" && req.method === "POST") return emitirPase(req, env, url, origen);
  const tipo = { "/api/html-a-pdf": "HTML", "/api/ia/traducir": "IA", "/api/ia/resumir": "IA" }[path]
    || (/^\/api\/firmas(?:\/|$)/.test(path) ? "FIRMAS" : null);
  if (!tipo) error(404, "No encontramos esa herramienta.");
  if (tipo !== "FIRMAS" && req.method !== "POST") error(405, "Ese método no está disponible aquí.");
  await revisarPase(req, env, origen);
  await limitar(req, env, tipo);
  const consumir = async (unidades = 1) => {
    if (!await cuota(env, tipo, unidades)) error(429, "Se alcanzó el límite de hoy. Intenta mañana.");
  };
  if (tipo === "IA") return ia(req, env, path, consumir);
  await consumir();
  return tipo === "HTML" ? htmlAPdf(req, env) : firmas(req, env, url);
}

export default {
  async fetch(req, env) {
    const origen = req.headers.get("Origin") || "";
    const origenes = env.ORIGENES.split(",").map((o) => o.trim());
    const permitido = origenes.includes(origen);
    let resp;
    try {
      if (origen && !permitido) error(403, "Este sitio no puede usar Navaja PDF.");
      resp = req.method === "OPTIONS" ? new Response(null, { status: 204 })
        : await ruta(req, env, new URL(req.url), origen, origenes);
    } catch (e) {
      resp = respuestaError(e);
    }
    const headers = new Headers(resp.headers);
    headers.set("Vary", "Origin");
    headers.set("Cache-Control", "no-store");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("Cross-Origin-Resource-Policy", "cross-origin");
    if (permitido) {
      headers.set("Access-Control-Allow-Origin", origen);
      headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      headers.set("Access-Control-Allow-Headers", "Content-Type, X-Navaja-Pase");
    }
    return new Response(resp.body, { status: resp.status, headers });
  },
};
