#!/usr/bin/env node
// Crea (o cambia el PIN de) guardias: usuario + PIN de 6 números.
//
// Uso:
//   SUPABASE_URL=https://xxxx.supabase.co SUPABASE_SERVICE_KEY=eyJ... \
//     node scripts/crear-guardias.mjs colazo:123456 perez:654321 [--borrar=guardia]
//
// - El usuario se normaliza igual que en la pantalla de ingreso (minúsculas, sin acentos ni espacios).
// - Si el guardia ya existe, se le cambia el PIN. --borrar=usuario da de baja a un guardia.
// - Corre en TU compu. La service key nunca va al frontend ni a Git.
// Requiere Node 18+. No tiene dependencias.

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
const args = process.argv.slice(2);
const pares = args.filter((a) => !a.startsWith('--'));
const borrar = args.filter((a) => a.startsWith('--borrar=')).map((a) => a.slice(9));
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || (!pares.length && !borrar.length)) {
  console.error('Uso: SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scripts/crear-guardias.mjs usuario:123456 [otro:654321] [--borrar=usuario]');
  process.exit(1);
}
const DOMINIO = 'guardias.garita.app';
const base = SUPABASE_URL.replace(/\/$/, '');
const h = { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' };
const normalizar = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9._-]/g, '');

async function buscar(email) {
  for (let pagina = 1; pagina < 50; pagina++) {
    const r = await fetch(`${base}/auth/v1/admin/users?page=${pagina}&per_page=200`, { headers: h });
    const { users = [] } = await r.json();
    const u = users.find((x) => x.email === email);
    if (u) return u;
    if (users.length < 200) return null;
  }
  return null;
}

for (const par of pares) {
  const [crudo, pin] = par.split(':');
  const usuario = normalizar(crudo ?? '');
  if (!usuario || !/^\d{6}$/.test(pin ?? '')) { console.error(`✖ "${par}": hace falta usuario:PIN de 6 números`); continue; }
  const email = `${usuario}@${DOMINIO}`;
  const existente = await buscar(email);
  const r = existente
    ? await fetch(`${base}/auth/v1/admin/users/${existente.id}`, { method: 'PUT', headers: h, body: JSON.stringify({ password: pin, app_metadata: { rol: 'guardia' } }) })
    : await fetch(`${base}/auth/v1/admin/users`, { method: 'POST', headers: h, body: JSON.stringify({ email, password: pin, email_confirm: true, app_metadata: { rol: 'guardia' } }) });
  console.log(r.ok ? `✔ ${usuario} ${existente ? 'PIN actualizado' : 'creado'}` : `✖ ${usuario}: ${r.status} ${await r.text()}`);
}

for (const crudo of borrar) {
  const u = await buscar(`${normalizar(crudo)}@${DOMINIO}`) ?? (crudo === 'guardia' ? await buscar('guardia@garita.app') : null);
  if (!u) { console.log(`– ${crudo}: no existe`); continue; }
  const r = await fetch(`${base}/auth/v1/admin/users/${u.id}`, { method: 'DELETE', headers: h });
  console.log(r.ok ? `✔ ${crudo} dado de baja` : `✖ ${crudo}: ${r.status}`);
}
