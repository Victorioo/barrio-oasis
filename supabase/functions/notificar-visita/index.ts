// Avisa por notificación push al vecino cuando la garita registra la ENTRADA de un auto a su casa.
// Lo llama el trigger `trg_movimientos_notificar` (pg_net) con un secreto compartido guardado en Vault;
// no lo llama ningún usuario, por eso va sin verify_jwt y se autentica con ese secreto.
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

const formatearPatente = (p: string) =>
  /^[A-Z]{2}\d{3}[A-Z]{2}$/.test(p) ? `${p.slice(0, 2)} ${p.slice(2, 5)} ${p.slice(5)}`
  : /^[A-Z]{3}\d{3}$/.test(p) ? `${p.slice(0, 3)} ${p.slice(3)}` : p;

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

  const { movimiento_id } = await req.json().catch(() => ({}));
  if (typeof movimiento_id !== 'string') return json({ error: 'falta movimiento_id' }, 400);

  // Se lee el movimiento de la base: no se confía en lo que llega en el cuerpo.
  const { data: mov } = await sb.from('movimientos')
    .select('id, patente, tipo, es_vecino, casa_destino_id, created_at, marca, color')
    .eq('id', movimiento_id).maybeSingle();
  if (!mov || mov.tipo !== 'entrada' || mov.es_vecino || !mov.casa_destino_id) return json({ enviadas: 0 });

  const { data: subs } = await sb.from('push_suscripciones')
    .select('id, endpoint, p256dh, auth').eq('casa_id', mov.casa_destino_id);
  if (!subs?.length) return json({ enviadas: 0 });

  webpush.setVapidDetails('mailto:garita@barriooasis.app', cfg.vapid_publica, cfg.vapid_privada);

  const hora = new Date(mov.created_at).toLocaleTimeString('es-AR', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Argentina/Cordoba',
  });
  const auto = [mov.marca, mov.color?.toLowerCase()].filter(Boolean).join(' ');
  const payload = JSON.stringify({
    titulo: 'Entró un auto a tu casa',
    cuerpo: [formatearPatente(mov.patente), auto, hora].filter(Boolean).join(' · '),
    url: '/vecino.html?tab=visitas',
    tag: `visita-${mov.id}`,
  });

  let enviadas = 0;
  const caducadas: number[] = [];
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 3600 });
      enviadas++;
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) caducadas.push(s.id); // el celular ya no recibe: se limpia
      else console.warn('push falló', status);
    }
  }));
  if (caducadas.length) await sb.from('push_suscripciones').delete().in('id', caducadas);

  return json({ enviadas, caducadas: caducadas.length });
});
