#!/usr/bin/env node
// Crea una cuenta de vecino por casa (usuario = teléfono, contraseña = PIN de 6 números) y deja
// la lista de PINs en un archivo local para que la administración se los entregue a cada vecino.
//
// Uso:
//   SUPABASE_URL=https://xxxx.supabase.co SUPABASE_SERVICE_KEY=eyJ... \
//     node scripts/crear-vecinos.mjs [pines-vecinos.csv] [--dry-run] [--pin=123456]
//
// Sin --pin, cada casa recibe un PIN distinto al azar. Con --pin=NNNNNN todas reciben el mismo
// (más cómodo, pero cualquiera que conozca ese PIN y el teléfono de un vecino puede entrar a su cuenta).
//
// - Corre en TU compu. La service key nunca va al frontend ni a Git.
// - Se puede correr de nuevo: las casas que ya tienen cuenta se saltean (su PIN no cambia).
// - El archivo de PINs queda en tu compu (*.csv está en .gitignore). Entregalos y borralo.
// Requiere Node 18+. No tiene dependencias.

import { writeFileSync } from 'node:fs';
import { randomInt } from 'node:crypto';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const salida = args.find((a) => !a.startsWith('--')) ?? 'pines-vecinos.csv';
const pinFijo = args.find((a) => a.startsWith('--pin='))?.slice(6) ?? null;
if (pinFijo !== null && !/^\d{6}$/.test(pinFijo)) { console.error('✖ --pin tiene que ser de 6 números, por ejemplo --pin=123456'); process.exit(1); }
const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Uso: SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scripts/crear-vecinos.mjs [salida.csv] [--dry-run] [--pin=123456]');
  process.exit(1);
}

const base = SUPABASE_URL.replace(/\/$/, '');
const cabeceras = { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' };

// Mismo criterio que la pantalla de ingreso: últimos 10 dígitos del teléfono.
const emailDe = (tel) => {
  const d = String(tel ?? '').replace(/\D/g, '');
  return d.length >= 10 ? `${d.slice(-10)}@vecinos.garita.app` : null;
};
const pinAzar = () => String(randomInt(0, 1_000_000)).padStart(6, '0');
const csv = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

const rc = await fetch(`${base}/rest/v1/casas?select=id,manzana,lote,info_adicional,nombre,telefono&order=manzana,lote`, { headers: cabeceras });
if (!rc.ok) { console.error('✖ No pude leer las casas:', rc.status, await rc.text()); process.exit(1); }
const casas = await rc.json();

const usados = new Map(); // email -> casa (para detectar teléfonos repetidos)
const filas = [['manzana', 'lote', 'dato_adicional', 'nombre', 'telefono', 'pin']];
let creadas = 0, existentes = 0, sinTel = 0, repetidos = 0, fallos = 0;

for (const c of casas) {
  const nombreCasa = `Mz ${c.manzana} Lote ${c.lote}${c.info_adicional ? ' (' + c.info_adicional + ')' : ''}`;
  const email = emailDe(c.telefono);
  if (!email) { console.warn(`⚠ ${nombreCasa}: sin teléfono válido (10 dígitos), se saltea.`); sinTel++; continue; }
  if (usados.has(email)) { console.warn(`⚠ ${nombreCasa}: el teléfono ${c.telefono} ya lo usa ${usados.get(email)}; se saltea.`); repetidos++; continue; }
  usados.set(email, nombreCasa);
  if (dryRun) { creadas++; continue; }

  const pin = pinFijo ?? pinAzar();
  const r = await fetch(`${base}/auth/v1/admin/users`, {
    method: 'POST',
    headers: cabeceras,
    body: JSON.stringify({ email, password: pin, email_confirm: true, app_metadata: { rol: 'vecino', casa_id: c.id } }),
  });
  if (r.ok) { creadas++; filas.push([c.manzana, c.lote, c.info_adicional, c.nombre, c.telefono, pin]); continue; }
  const cuerpo = await r.json().catch(() => ({}));
  if (r.status === 422 && /already|exists|registered/i.test(JSON.stringify(cuerpo))) { existentes++; continue; }
  console.error(`✖ ${nombreCasa}: ${r.status} ${JSON.stringify(cuerpo)}`);
  fallos++;
}

if (dryRun) console.log(`--dry-run: se crearían ${creadas} cuentas (${sinTel} sin teléfono, ${repetidos} con teléfono repetido). No se escribió nada.`);
else {
  if (filas.length > 1) writeFileSync(salida, filas.map((f) => f.map(csv).join(',')).join('\n') + '\n', { mode: 0o600 });
  console.log(`✔ ${creadas} cuentas creadas, ${existentes} ya existían, ${sinTel} sin teléfono, ${repetidos} teléfonos repetidos, ${fallos} con error.`);
  if (filas.length > 1) console.log(`PINs guardados en ${salida}. Entregalos a cada vecino y borrá el archivo.`);
}
