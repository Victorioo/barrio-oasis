// Edge Function: recuperación de PIN por mail, para vecinos que ya eligieron usuario + mail de
// recuperación desde la app (ver vecino.js / guardar_usuario / guardar_email_recuperacion en la base).
//
// Dos pasos, en el mismo endpoint (body.paso):
//   "pedir"     -> { usuario }                       manda un código de 6 números al mail guardado
//   "confirmar" -> { usuario, codigo, nuevo_pin }     valida el código y cambia el PIN
//
// El paso "pedir" SIEMPRE responde { ok: true }, exista o no el usuario y tenga o no mail guardado:
// así nadie puede usar este endpoint para averiguar qué usuarios existen en el barrio.
//
// Requiere el secreto RESEND_API_KEY (Project Settings > Edge Functions > Secrets, o
// `supabase secrets set RESEND_API_KEY=re_...`). Sin ese secreto, "pedir" no manda nada pero
// igual responde ok (para no romper la app); queda un aviso en los logs de la función.

import { createClient } from 'npm:@supabase/supabase-js@2';

const CODIGO_VIGENCIA_MIN = 15;
const MAX_INTENTOS = 5;
const DESDE = 'Barrio Oasis <onboarding@resend.dev>'; // dominio de prueba de Resend; cambiar cuando haya dominio propio verificado

const cors = {
  'Access-Control-Allow-Origin': '*', // la seguridad la da el código + el PIN nuevo, no el origen
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (cuerpo: unknown, status = 200) =>
  new Response(JSON.stringify(cuerpo), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const pinDebil = (p: string) => /^(\d)\1{5}$/.test(p) || '01234567890'.includes(p) || '09876543210'.includes(p);

function iguales(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function hashCodigo(codigo: string) {
  const datos = new TextEncoder().encode(`${codigo}:${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`);
  const buf = await crypto.subtle.digest('SHA-256', datos);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function mandarCodigo(mail: string, codigo: string) {
  const apiKey = Deno.env.get('RESEND_API_KEY');
  if (!apiKey) { console.error('falta configurar el secreto RESEND_API_KEY'); return; }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: DESDE,
        to: mail,
        subject: 'Código para recuperar tu PIN · Barrio Oasis',
        text: `Tu código para elegir un PIN nuevo es ${codigo}.\n\nVale por ${CODIGO_VIGENCIA_MIN} minutos. Si no lo pediste vos, ignorá este mail: tu PIN actual sigue funcionando.`,
      }),
    });
    if (!r.ok) console.error('Resend respondió', r.status, await r.text());
  } catch (err) {
    console.error('no se pudo mandar el mail de recuperación', String(err));
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'metodo_no_permitido' }, 405);

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });

  let cuerpo: Record<string, unknown> = {};
  try { cuerpo = await req.json(); } catch { /* vacío */ }

  const usuario = String(cuerpo.usuario ?? '').trim().toLowerCase();
  if (!/^[a-z0-9_.]{3,20}$/.test(usuario)) return json({ ok: false, error: 'usuario_invalido' }, 400);

  const { data: casa } = await sb.from('casas')
    .select('id, auth_user_id, email_recuperacion')
    .eq('usuario', usuario).maybeSingle();

  // ---------- paso 1: pedir el código ----------
  if (cuerpo.paso === 'pedir') {
    if (casa?.auth_user_id && casa.email_recuperacion) {
      const codigo = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0');
      await sb.from('recuperaciones_pin').insert({
        casa_id: casa.id,
        codigo_hash: await hashCodigo(codigo),
        expira_at: new Date(Date.now() + CODIGO_VIGENCIA_MIN * 60_000).toISOString(),
      });
      await mandarCodigo(casa.email_recuperacion, codigo);
    }
    return json({ ok: true });
  }

  // ---------- paso 2: confirmar el código y cambiar el PIN ----------
  if (cuerpo.paso === 'confirmar') {
    const codigo = String(cuerpo.codigo ?? '').trim();
    const nuevoPin = String(cuerpo.nuevo_pin ?? '').trim();
    if (!/^\d{6}$/.test(codigo)) return json({ ok: false, error: 'codigo_invalido' }, 400);
    if (!/^\d{6}$/.test(nuevoPin)) return json({ ok: false, error: 'pin_invalido' }, 400);
    if (pinDebil(nuevoPin)) return json({ ok: false, error: 'pin_debil' }, 400);
    if (!casa?.auth_user_id) return json({ ok: false, error: 'codigo_invalido' }, 400);

    const { data: fila } = await sb.from('recuperaciones_pin')
      .select('id, codigo_hash, intentos, usado, expira_at')
      .eq('casa_id', casa.id).order('created_at', { ascending: false }).limit(1).maybeSingle();

    if (!fila || fila.usado || new Date(fila.expira_at) < new Date() || fila.intentos >= MAX_INTENTOS) {
      return json({ ok: false, error: 'codigo_invalido' }, 400);
    }
    if (!iguales(fila.codigo_hash, await hashCodigo(codigo))) {
      await sb.from('recuperaciones_pin').update({ intentos: fila.intentos + 1 }).eq('id', fila.id);
      return json({ ok: false, error: 'codigo_invalido' }, 400);
    }
    await sb.from('recuperaciones_pin').update({ usado: true }).eq('id', fila.id);

    const { error } = await sb.auth.admin.updateUserById(casa.auth_user_id, {
      password: nuevoPin,
      user_metadata: { pin_cambiado: true },
    });
    if (error) { console.error('no se pudo cambiar el PIN', error.message); return json({ ok: false, error: 'no_se_pudo_cambiar' }, 500); }
    return json({ ok: true });
  }

  return json({ ok: false, error: 'paso_invalido' }, 400);
});
