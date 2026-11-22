// SPDX-License-Identifier: AGPL-3.0-or-later
export const codificar = new TextEncoder();
export const hex = (bytes) => Array.from(bytes, (n) => n.toString(16).padStart(2, "0")).join("");
export const azar = () => hex(crypto.getRandomValues(new Uint8Array(24)));
export const hash = async (texto) => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", codificar.encode(texto))));
export const json = Response.json.bind(Response);

export class ErrorApi extends Error {
  constructor(status, mensaje) {
    super(mensaje);
    this.status = status;
  }
}

export function error(status, mensaje) {
  throw new ErrorApi(status, mensaje);
}

export function respuestaError(e) {
  return json({ error: e instanceof ErrorApi ? e.message : "No se pudo completar la operación. Intenta otra vez." },
    { status: e instanceof ErrorApi ? e.status : 500 });
}

export async function leerCuerpo(req, maximo) {
  if (Number(req.headers.get("Content-Length")) > maximo) error(413, "El archivo o texto rebasa el tamaño permitido.");
  if (!req.body) error(400, "Falta el contenido.");
  const lector = req.body.getReader();
  const partes = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await lector.read();
      if (done) break;
      total += value.length;
      if (total > maximo) {
        await lector.cancel();
        error(413, "El archivo o texto rebasa el tamaño permitido.");
      }
      partes.push(value);
    }
  } finally {
    lector.releaseLock();
  }
  return new Blob(partes);
}

export async function leerJson(req, maximo) {
  const cuerpo = await leerCuerpo(req, maximo);
  try {
    const datos = JSON.parse(await cuerpo.text());
    if (datos && typeof datos === "object" && !Array.isArray(datos)) return datos;
  } catch { /* JSON inválido */ }
  error(400, "El contenido debe ser un objeto JSON.");
}
