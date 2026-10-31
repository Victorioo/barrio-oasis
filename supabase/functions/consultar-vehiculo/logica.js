// Lógica pura de la función (sin red), para poder probarla con Node.

export const normalizarPatente = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// Mercosur AB123CD · vieja ABC123 · motos A123BCD y 123ABC
const PATENTE = /^([A-Z]{2}\d{3}[A-Z]{2}|[A-Z]{3}\d{3}|[A-Z]\d{3}[A-Z]{3}|\d{3}[A-Z]{3})$/;
export const patenteValida = (p) => PATENTE.test(p);

const sinEspacios = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const titulo = (s) => sinEspacios(s).toLowerCase().replace(/(^|[\s.\-/])([a-záéíóúñ])/g, (_, a, b) => a + b.toUpperCase());
const oracion = (s) => {
  const t = sinEspacios(s).toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

// Del JSON del Portal Tributario se toman SOLO los datos del vehículo.
// Deudas, titular, juicios, planes, etc. se descartan acá y no salen del servidor.
// "det" viene así: "N - PEUGEOT - SEDAN 5 PUERTAS - 206 XS PREMIUM HDI 5P"
export function extraerVehiculo(resp, patente) {
  const d = resp?.data ?? {};
  const detalle = sinEspacios(d.det);
  if (!resp?.status?.success || (!d.obj_id && !detalle)) return { encontrado: false, patente };

  const partes = detalle.split(/\s+-\s+/).map(sinEspacios).filter(Boolean);
  let marca = null, tipo = null, modelo = null;
  if (partes.length >= 4) {
    marca = titulo(partes[1]);
    tipo = oracion(partes[2]);
    modelo = partes.slice(3).join(' - ');
  }
  return {
    encontrado: true,
    patente: normalizarPatente(d.obj_dato) || patente,
    marca,
    tipo,
    modelo,
    estado: sinEspacios(d.est_nom) || null,
    detalle, // texto completo por si el formato cambia
  };
}
