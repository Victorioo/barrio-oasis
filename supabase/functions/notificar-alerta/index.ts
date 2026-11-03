// Avisa por notificación push a TODOS los vecinos (no solo a una casa) cuando la garita da un
// aviso de seguridad. Lo llama el trigger `trg_alertas_notificar` (pg_net) con el mismo secreto
// compartido que usa "notificar-visita"; no lo llama ningún usuario, por eso va sin verify_jwt.
import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const json = (cuerpo: unknown, status = 200) =>
  new Response(JSON.stringify(cuerpo), { status, headers: { 'Content-Type': 'application/json' } });

function iguales(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// El nombre de la app ("Seguridad Oasis") ya lo muestra el sistema arriba de la notificación;
// repetirlo acá queda duplicado.
const TITULOS: Record<string, string> = {
  info: 'Aviso de la garita',
  precaucion: '⚠️ Precaución',
  emergencia: '🚨 Emergencia',
};
// Emergencia vibra más fuerte y más tiempo que un aviso informativo.
const VIBRACIONES: Record<string, number[]> = {
  info: [200],
  precaucion: [200, 100, 200],
  emergencia: [300, 100, 300, 100, 300],
};

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'método no permitido' }, 405);

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });

  const { data: cfg } = await sb.rpc('notif_config');
  const dado = req.headers.get('x-notif-secret') ?? '';
  if (!cfg?.notif_secreto || !cfg.vapid_privada || !cfg.vapid_publica || !iguales(dado, cfg.notif_secreto)) {
    return json({ error: 'no autorizado' }, 401);
  }

  const { alerta_id } = await req.json().catch(() => ({}));
  if (typeof alerta_id !== 'string') return json({ error: 'falta alerta_id' }, 400);

  const { data: alerta } = await sb.from('alertas_seguridad')
    .select('id, nivel, mensaje').eq('id', alerta_id).maybeSingle();
  if (!alerta) return json({ enviadas: 0 });

  // Sin filtro de casa_id: le llega a todas las suscripciones que haya, sea cual sea la casa.
  const { data: subs } = await sb.from('push_suscripciones').select('id, endpoint, p256dh, auth');
  if (!subs?.length) return json({ enviadas: 0 });

  webpush.setVapidDetails('mailto:garita@barriooasis.app', cfg.vapid_publica, cfg.vapid_privada);

  const payload = JSON.stringify({
    titulo: TITULOS[alerta.nivel] ?? TITULOS.info,
    cuerpo: alerta.mensaje,
    url: '/vecino.html',
    tag: `alerta-${alerta.id}`,
    vibrar: VIBRACIONES[alerta.nivel] ?? VIBRACIONES.info,
  });

  let enviadas = 0;
  const caducadas: number[] = [];
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 3600 });
      enviadas++;
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) caducadas.push(s.id);
      else console.warn('push falló', status);
    }
  }));
  if (caducadas.length) await sb.from('push_suscripciones').delete().in('id', caducadas);

  return json({ enviadas, caducadas: caducadas.length });
});
