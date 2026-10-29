// Lógica pura (sin DOM ni red) para poder probarla fácil.

// "ab 123-cd" -> "AB123CD"
export function normalizarPatente(s) {
  return String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

const cmp = (a, b) => String(a).localeCompare(String(b), 'es', { numeric: true });
export const ordenarCasas = (casas) =>
  [...casas].sort((a, b) => cmp(a.manzana, b.manzana) || cmp(a.lote, b.lote));

// Búsqueda por "manzana-lote": "5-12", "5 12", "5/12" o solo "5".
// Cada palabra tiene que ser el comienzo de la manzana o del lote.
export function filtrarCasas(casas, consulta) {
  const tokens = String(consulta ?? '').toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  if (!tokens.length) return ordenarCasas(casas);
  const ok = (c) => {
    const m = String(c.manzana).toUpperCase();
    const l = String(c.lote).toUpperCase();
    if (tokens.length === 1) return m.startsWith(tokens[0]) || l.startsWith(tokens[0]);
    return m.startsWith(tokens[0]) && l.startsWith(tokens[1]);
  };
  // coincidencia exacta de manzana primero
  return ordenarCasas(casas.filter(ok));
}

// Entradas anteriores de una patente dentro de la ventana de días (más nuevas primero).
export function entradasPrevias(movimientos, patente, dias, ahora = Date.now()) {
  const desde = ahora - dias * 86400000;
  return movimientos
    .filter((m) => m.patente === patente && m.tipo === 'entrada' && Date.parse(m.created_at) >= desde)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}

// Mapa de colores comunes (en español) para mostrar un círculo del color del auto.
const COLORES = {
  blanco: '#f8fafc', negro: '#111827', gris: '#9ca3af', plata: '#cbd5e1', plateado: '#cbd5e1',
  'gris oscuro': '#4b5563', 'gris claro': '#d1d5db', rojo: '#dc2626', azul: '#2563eb',
  'azul oscuro': '#1e3a8a', celeste: '#38bdf8', verde: '#16a34a', amarillo: '#facc15',
  naranja: '#f97316', marron: '#78350f', beige: '#d6c7a1', bordo: '#7f1d1d', dorado: '#ca8a04',
  violeta: '#7c3aed', rosa: '#ec4899',
};
export function colorCss(nombre) {
  const k = String(nombre ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  return COLORES[k] ?? COLORES[k.split(' ')[0]] ?? '#94a3b8';
}

// "AB123CD" -> "AB 123 CD", "ABC123" -> "ABC 123", "A123BCD" -> "A 123 BCD"
export function formatearPatente(p) {
  const s = normalizarPatente(p);
  let m;
  if ((m = s.match(/^([A-Z]{2})(\d{3})([A-Z]{2})$/))) return `${m[1]} ${m[2]} ${m[3]}`;
  if ((m = s.match(/^([A-Z]{3})(\d{3})$/))) return `${m[1]} ${m[2]}`;
  if ((m = s.match(/^([A-Z])(\d{3})([A-Z]{3})$/))) return `${m[1]} ${m[2]} ${m[3]}`;
  if ((m = s.match(/^(\d{3})([A-Z]{3})$/))) return `${m[1]} ${m[2]}`;
  return s;
}

export function turnoDelDia(fecha = new Date()) {
  const h = fecha.getHours();
  return h < 13 ? 'mañana' : h < 20 ? 'tarde' : 'noche';
}

// "Lun 26/10"
export function fechaCorta(fecha) {
  const dia = fecha.toLocaleDateString('es-AR', { weekday: 'short' }).replace('.', '');
  const dm = fecha.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' });
  return dia.charAt(0).toUpperCase() + dia.slice(1) + ' ' + dm;
}

const hhmm = (d) => d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });
export { hhmm };

// "Salió hoy a las 08:15" (o null si no hay movimientos guardados de esa patente)
export function textoUltimoMovimiento(movimientos, patente, ahora = new Date()) {
  const ult = movimientos
    .filter((m) => m.patente === patente)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
  if (!ult) return null;
  const d = new Date(ult.created_at);
  const dia0 = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((dia0(ahora) - dia0(d)) / 86400000);
  const cuando = diff === 0 ? 'hoy' : diff === 1 ? 'ayer' : `el ${fechaCorta(d)}`;
  return `${ult.tipo === 'entrada' ? 'Entró' : 'Salió'} ${cuando} a las ${hhmm(d)}`;
}
