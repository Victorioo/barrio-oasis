#!/usr/bin/env node
// Importa el CSV exportado de Tally a Supabase (casas + vehiculos_vecinos).
//
// Uso:
//   SUPABASE_URL=https://xxxx.supabase.co SUPABASE_SERVICE_KEY=eyJ... \
//     node scripts/importar-tally.mjs respuestas.csv [--dry-run]
//
// - Corre en TU compu. La service key nunca va al frontend ni a Git.
// - Se puede correr varias veces: no duplica casas (manzana+lote) ni patentes (por casa).
// - --dry-run muestra qué haría sin escribir nada.
// Requiere Node 18+. No tiene dependencias.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const esPrincipal = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const archivo = args.find((a) => !a.startsWith('--'));
const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;

if (esPrincipal && (!archivo || (!dryRun && (!SUPABASE_URL || !SUPABASE_SERVICE_KEY)))) {
  console.error('Uso: SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scripts/importar-tally.mjs archivo.csv [--dry-run]');
  process.exit(1);
}

// ---------- CSV (comillas, saltos de línea dentro de campos, coma o punto y coma) ----------
function parsearCsv(texto) {
  texto = texto.replace(/^﻿/, '');
  const primera = texto.split(/\r?\n/)[0] ?? '';
  const sep = (primera.match(/;/g) ?? []).length > (primera.match(/,/g) ?? []).length ? ';' : ',';
  const filas = [];
  let fila = [], campo = '', entreComillas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (entreComillas) {
      if (c === '"' && texto[i + 1] === '"') { campo += '"'; i++; }
      else if (c === '"') entreComillas = false;
      else campo += c;
    } else if (c === '"') entreComillas = true;
    else if (c === sep) { fila.push(campo); campo = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && texto[i + 1] === '\n') i++;
      fila.push(campo); campo = '';
      if (fila.some((x) => x.trim() !== '')) filas.push(fila);
      fila = [];
    } else campo += c;
  }
  fila.push(campo);
  if (fila.some((x) => x.trim() !== '')) filas.push(fila);
  return filas;
}

const limpiarClave = (s) =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

export const claveCasa = (manzana, lote, info) => `${manzana}|${lote}|${limpio(info).toUpperCase()}`;
export const normalizarPatente = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// Formatos argentinos: AB123CD (Mercosur), ABC123 (viejo), A123BCD y 123ABC (motos)
const PATENTE_AR = /^([A-Z]{2}\d{3}[A-Z]{2}|[A-Z]{3}\d{3}|[A-Z]\d{3}[A-Z]{3}|\d{3}[A-Z]{3})$/;

// ---------- limpieza de textos ----------
const limpio = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
// "MARIA PEREZ" -> "Maria Perez" (solo si viene todo en mayúsculas)
const ordenado = (s) => {
  const t = limpio(s);
  if (!t || t !== t.toUpperCase() || !/[A-ZÁÉÍÓÚÑ]/.test(t)) return t;
  return t.toLowerCase().replace(/(^|[\s.\-/])([a-záéíóúñ])/g, (_, a, b) => a + b.toUpperCase());
};

// ---------- armado de datos ----------
export function leer(texto) {
  const [cabecera, ...filas] = parsearCsv(texto);
  const cols = cabecera.map(limpiarClave);

  const idx = (...nombres) => cols.findIndex((c) => nombres.some((n) => c === n || c.startsWith(n)));
  const iTel = idx('numero de telefono', 'telefono');
  const iNombre = idx('nombre completo', 'nombre');
  const iInfo = idx('dato adicional', 'dato', 'info adicional', 'informacion adicional');
  const iMz = idx('numero de manzana', 'manzana');
  const iLote = idx('numero de lote', 'lote');
  if (iMz < 0 || iLote < 0) throw new Error(`No encuentro las columnas de manzana/lote. Cabecera leída: ${cabecera.join(' | ')}`);

  // "Patente 1".."Patente 5", y opcionalmente "Marca 1"/"Marca", "Modelo 1"/"Modelo", "Color 1"/"Color"
  const colDe = (base, n, alias = []) => {
    for (const b of [base, ...alias]) {
      const i = cols.findIndex((c) => c === `${b} ${n}`);
      if (i >= 0) return i;
    }
    return cols.findIndex((c) => [base, ...alias].includes(c));
  };
  const autos = [];
  for (let n = 1; n <= 5; n++) {
    const iPat = cols.findIndex((c) => c === `patente ${n}`);
    if (iPat >= 0) autos.push({ iPat, iMarca: colDe('marca', n), iModelo: colDe('modelo', n, ['modelo de auto']), iColor: colDe('color', n) });
  }
  if (!autos.length) throw new Error('No encuentro columnas "Patente 1" ... "Patente 5".');

  // Una casa por manzana + lote + dato adicional (en un dúplex conviven dos familias en el mismo lote)
  const casas = new Map(); // "MZ|LOTE|INFO" -> { manzana, lote, info, nombre, telefono, vehiculos: Map(patente -> datos) }
  const avisos = [];
  const get = (f, i) => (i >= 0 ? (f[i] ?? '').trim() : '');

  filas.forEach((f, n) => {
    const linea = n + 2;
    const manzana = get(f, iMz).toUpperCase();
    const lote = get(f, iLote).toUpperCase();
    if (!manzana || !lote) { avisos.push(`Línea ${linea}: sin manzana o lote, se saltea.`); return; }
    const info = limpio(get(f, iInfo));
    const clave = claveCasa(manzana, lote, info);
    if (!casas.has(clave)) casas.set(clave, { manzana, lote, info, nombre: null, telefono: null, vehiculos: new Map() });
    const casa = casas.get(clave);
    if (casa.filasOrigen) avisos.push(`Línea ${linea}: Mz ${manzana} Lote ${lote}${info ? ' (' + info + ')' : ''} repetida en el CSV, se combinan los datos.`);
    casa.filasOrigen = (casa.filasOrigen ?? 0) + 1;
    casa.nombre ??= ordenado(get(f, iNombre)) || null;
    casa.telefono ??= limpio(get(f, iTel)) || null;

    for (const a of autos) {
      const bruta = get(f, a.iPat);
      if (!bruta) continue;
      const patente = normalizarPatente(bruta);
      if (!/^[A-Z0-9]{5,8}$/.test(patente)) { avisos.push(`Línea ${linea}: patente "${bruta}" no es válida, se saltea.`); continue; }
      if (!PATENTE_AR.test(patente)) avisos.push(`Línea ${linea}: patente "${bruta}" (${patente}) no tiene formato argentino típico, se importa igual. Revisala.`);
      if (!casa.vehiculos.has(patente))
        casa.vehiculos.set(patente, {
          patente,
          marca: limpio(get(f, a.iMarca)) || null,
          modelo: ordenado(get(f, a.iModelo)) || null,
          color: ordenado(get(f, a.iColor)) || null,
        });
    }
  });

  // misma patente en casas distintas = probablemente error de tipeo del vecino
  const dueño = new Map();
  for (const c of casas.values())
    for (const p of c.vehiculos.keys()) {
      if (dueño.has(p)) avisos.push(`Patente ${p} figura en ${dueño.get(p)} y en Mz ${c.manzana} Lote ${c.lote}.`);
      else dueño.set(p, `Mz ${c.manzana} Lote ${c.lote}`);
    }

  return { casas: [...casas.values()], avisos };
}

// ---------- Supabase REST (con la service key) ----------
async function rest(ruta, cuerpo, prefer) {
  const r = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${ruta}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: prefer,
    },
    body: JSON.stringify(cuerpo),
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}

const en_lotes = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

async function main() {
  const { casas, avisos } = leer(readFileSync(archivo, 'utf8'));
  const totalAutos = casas.reduce((s, c) => s + c.vehiculos.size, 0);
  avisos.forEach((a) => console.warn('⚠', a));
  console.log(`CSV leído: ${casas.length} casas, ${totalAutos} vehículos.`);
  if (dryRun) { console.log('--dry-run: no se escribió nada.'); return; }

  // 1) casas (si ya existe manzana+lote+dato adicional, se completan nombre y teléfono solo cuando vienen)
  const idPorClave = new Map();
  const filasCasas = casas.map((c) => ({
    manzana: c.manzana,
    lote: c.lote,
    info_adicional: c.info,
    ...(c.nombre ? { nombre: c.nombre } : {}),
    ...(c.telefono ? { telefono: c.telefono } : {}),
  }));
  // PostgREST exige las mismas columnas en todas las filas de una llamada: se agrupan por forma
  const porForma = new Map();
  for (const f of filasCasas) {
    const k = Object.keys(f).join(',');
    porForma.set(k, [...(porForma.get(k) ?? []), f]);
  }
  for (const grupo of porForma.values())
    for (const lote of en_lotes(grupo, 200)) {
      const res = await rest('casas?on_conflict=manzana,lote,info_adicional&select=id,manzana,lote,info_adicional', lote, 'resolution=merge-duplicates,return=representation');
      res.forEach((c) => idPorClave.set(claveCasa(c.manzana, c.lote, c.info_adicional), c.id));
    }

  // 2) vehículos (si la patente ya está en esa casa, se deja como está)
  const vehiculos = casas.flatMap((c) =>
    [...c.vehiculos.values()].map((v) => ({ casa_id: idPorClave.get(claveCasa(c.manzana, c.lote, c.info)), ...v }))
  );
  for (const lote of en_lotes(vehiculos, 200))
    await rest('vehiculos_vecinos?on_conflict=casa_id,patente', lote, 'resolution=ignore-duplicates,return=minimal');

  console.log(`✔ Listo: ${casas.length} casas y ${vehiculos.length} vehículos procesados.`);
}

if (esPrincipal) main().catch((e) => { console.error('✖', e.message); process.exit(1); });
