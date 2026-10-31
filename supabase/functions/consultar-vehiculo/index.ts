// Edge Function: consulta de datos del vehículo en el Portal Tributario de la Municipalidad de Córdoba.
//
// Por qué existe: el portal no permite llamadas directas desde un navegador (no tiene CORS),
// y así además solo puede consultar quien esté logueado como guardia o admin.
// Devuelve ÚNICAMENTE los datos del vehículo; las deudas y el nombre del titular no salen de acá.

import { normalizarPatente, patenteValida, extraerVehiculo } from './logica.js';

const PORTAL = 'https://tributariomuni.cordoba.gob.ar/nextapi/proxy/deuda/consultar';
const CACHE_MS = 10 * 60 * 1000;
const cache = new Map<string, { t: number; cuerpo: unknown }>();

const cors = {
  'Access-Control-Allow-Origin': '*', // la seguridad la da el login (JWT), no el origen
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const responder = (status: number, cuerpo: unknown) =>
  new Response(JSON.stringify(cuerpo), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return responder(405, { ok: false, error: 'metodo_no_permitido' });

  // 1) Solo guardia o admin (el rol vive en app_metadata del usuario)
  const u = await fetch(`${Deno.env.get('SUPABASE_URL')}/auth/v1/user`, {
    headers: { Authorization: req.headers.get('Authorization') ?? '', apikey: Deno.env.get('SUPABASE_ANON_KEY') ?? '' },
  });
  if (!u.ok) return responder(401, { ok: false, error: 'no_autorizado' });
  const rol = (await u.json())?.app_metadata?.rol;
  if (rol !== 'guardia' && rol !== 'admin') return responder(403, { ok: false, error: 'sin_permiso' });

  // 2) Patente normalizada y validada
  let patente = '';
  try {
    patente = normalizarPatente((await req.json())?.patente);
  } catch { /* cuerpo inválido */ }
  if (!patenteValida(patente)) return responder(422, { ok: false, error: 'patente_invalida' });

  // 3) Caché corto: la misma patente no se vuelve a pedir al portal por 10 minutos
  const guardado = cache.get(patente);
  if (guardado && Date.now() - guardado.t < CACHE_MS) return responder(200, guardado.cuerpo);

  // 4) Consulta al portal (tipo 5 = rodado, tipo_busqueda 2 = por identificador)
  try {
    const r = await fetch(`${PORTAL}?tipo=5&tipo_busqueda=2&identificador=${encodeURIComponent(patente)}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error(`portal respondió ${r.status}`);
    const cuerpo = { ok: true, ...extraerVehiculo(await r.json(), patente), consultado_en: new Date().toISOString() };
    cache.set(patente, { t: Date.now(), cuerpo });
    return responder(200, cuerpo);
  } catch (err) {
    console.error('consultar-vehiculo falló:', String(err));
    return responder(502, { ok: false, error: 'servicio_no_disponible' });
  }
});
