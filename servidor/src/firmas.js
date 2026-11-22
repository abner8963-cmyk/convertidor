// SPDX-License-Identifier: AGPL-3.0-or-later
import { timingSafeEqual } from "node:crypto";
import { DurableObject } from "cloudflare:workers";
import { azar, codificar, error, hash, json, leerCuerpo, respuestaError } from "./comun.js";

const DIAS = 7 * 86400;
const MAXIMO = 24_000_000;
const cifrado = (bytes) => new Response(bytes, { headers: { "Content-Type": "application/octet-stream" } });

export async function firmas(req, env, url) {
  const crear = url.pathname === "/api/firmas";
  const ruta = url.pathname.match(/^\/api\/firmas\/([a-f0-9]{48})(?:\/(estado|firmado))?$/);
  if (!crear && !ruta) error(404, "No encontramos esa solicitud.");
  if (crear ? req.method !== "POST" : !(ruta[2] ? ["GET"] : ["GET", "PUT", "DELETE"]).includes(req.method)) {
    error(405, "Ese método no está disponible aquí.");
  }
  const id = crear ? azar() : ruta[1];
  const destino = new URL(url);
  destino.pathname = ruta?.[2] ? "/" + ruta[2] : "/";
  destino.searchParams.set("id", id);
  return env.SOLICITUD.getByName(id).fetch(new Request(destino, req));
}

export class Solicitud extends DurableObject {
  turno = Promise.resolve();

  async fetch(req) {
    try {
      const cuerpo = ["POST", "PUT"].includes(req.method) ? await leerCuerpo(req, MAXIMO) : null;
      if (cuerpo && cuerpo.size < 29) error(400, "Falta el PDF cifrado.");
      const tarea = this.turno.then(() => this.operar(req, cuerpo));
      this.turno = tarea.catch(() => {});
      return await tarea;
    } catch (e) {
      return respuestaError(e);
    }
  }

  async operar(req, cuerpo) {
    const url = new URL(req.url), id = url.searchParams.get("id");
    const kv = this.env.FIRMAS, almacen = this.ctx.storage;
    const original = id + ":original", firmado = id + ":firmado";
    if (req.method === "POST") {
      const tokenFirmante = azar(), tokenDueno = azar();
      const vence = Math.floor(Date.now() / 1000) + DIAS;
      const datos = { firmante: await hash(tokenFirmante), dueno: await hash(tokenDueno), vence, estado: "pendiente" };
      await almacen.setAlarm(vence * 1000);
      await kv.put(original, cuerpo.stream(), { expirationTtl: DIAS, metadata: datos });
      await almacen.put("datos", datos);
      return json({ id, tokenFirmante, tokenDueno, vence: new Date(vence * 1000).toISOString() }, { status: 201 });
    }
    const datos = await almacen.get("datos");
    if (!datos || datos.vence * 1000 <= Date.now()) error(404, "La solicitud venció o fue borrada.");
    const esDueno = url.pathname !== "/" || req.method === "DELETE";
    const token = url.searchParams.get("t") || "";
    if (!/^[a-f0-9]{48}$/.test(token)
        || !timingSafeEqual(codificar.encode(await hash(token)), codificar.encode(esDueno ? datos.dueno : datos.firmante))) {
      error(403, "El enlace no tiene permiso para esta solicitud.");
    }

    if (req.method === "DELETE") {
      await Promise.all([kv.delete(original), kv.delete(firmado)]);
      await almacen.delete("datos");
      await almacen.deleteAlarm();
      return json({ borrado: true });
    }
    if (url.pathname === "/estado") return json({ estado: datos.estado, vence: new Date(datos.vence * 1000).toISOString() });
    if (!esDueno && datos.estado === "firmado") error(409, "Este PDF ya fue firmado.");
    if (esDueno && datos.estado !== "firmado") error(409, "Todavía falta la firma.");
    if (req.method === "PUT") {
      if (datos.vence - Math.floor(Date.now() / 1000) < 60) error(410, "La solicitud está por vencer. Pide un enlace nuevo.");
      const nuevos = { ...datos, estado: "firmado" };
      await kv.put(firmado, cuerpo.stream(), { expiration: datos.vence, metadata: nuevos });
      await almacen.put("datos", nuevos);
      return json({ estado: "firmado" });
    }
    const bytes = await kv.get(esDueno ? firmado : original, "stream");
    if (!bytes) error(503, "El archivo todavía se está sincronizando. Intenta otra vez.");
    return cifrado(bytes);
  }

  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}
