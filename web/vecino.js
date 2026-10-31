// Vista de vecino: ve lo de su casa, avisa visitas y recibe notificaciones cuando entra un auto a su casa.
// Los permisos los da la base (RLS + funciones mis_visitas / mis_consultas): el celular solo recibe lo de su casa.
import { CONFIG } from './config.js';
import { normalizarPatente, formatearPatente, colorCss, fechaCorta, hhmm } from './logic.js';

const sb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ICONO = (n, c = '') => `<svg class="i ${c}"><use href="#i-${n}"/></svg>`;
const plural = (n, a, b) => `${n} ${n === 1 ? a : b}`;

let casa = null, autos = [], esperadas = [], llegadas = [], consultas = [];
let pin = '';

// ---------- fechas ----------
const aISO = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const delDia = (iso) => new Date(`${iso}T12:00:00`);
function etiquetaDia(iso) {
  const d = delDia(iso), hoy = new Date();
  const mismo = (a, b) => a.toDateString() === b.toDateString();
  if (mismo(d, hoy)) return 'Hoy';
  if (mismo(d, new Date(hoy.getTime() + 864e5))) return 'Mañana';
  return d.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'short' });
}

// ---------- avisos en pantalla ----------
let toastT;
function toast(titulo, error = false) {
  const t = $('toast');
  t.innerHTML = `${ICONO(error ? 'info' : 'check-circle')}<div class="toast-cuerpo"><p class="toast-titulo">${esc(titulo)}</p></div>`;
  t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => (t.hidden = true), 3200);
}

// ---------- login: teléfono + PIN ----------
// El teléfono (últimos 10 dígitos) es el "usuario": la administración crea las cuentas con scripts/crear-vecinos.mjs.
const emailDeTelefono = (tel) => {
  const d = String(tel).replace(/\D/g, '');
  return d.length >= 10 ? `${d.slice(-10)}@vecinos.garita.app` : null;
};

function armarTeclado() {
  const teclas = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'];
  $('teclado').innerHTML = teclas.map((k) =>
    k === '' ? '<span class="tecla-vacia"></span>'
    : k === 'del' ? `<button type="button" class="tecla tecla-borrar" data-k="del" aria-label="Borrar último número">${ICONO('backspace')}</button>`
    : `<button type="button" class="tecla" data-k="${k}">${k}</button>`).join('');
  $('teclado').addEventListener('click', (e) => {
    const b = e.target.closest('[data-k]');
    if (!b) return;
    $('login-error').textContent = '';
    if (b.dataset.k === 'del') pin = pin.slice(0, -1);
    else if (pin.length < 6) pin += b.dataset.k;
    pintarPin();
  });
}
function pintarPin() {
  $('pin-puntos').innerHTML = Array.from({ length: 6 }, (_, i) => `<span class="pin-punto ${i < pin.length ? 'lleno' : ''}"></span>`).join('');
  $('pin-puntos').setAttribute('aria-label', `${pin.length} de 6 números ingresados`);
}

function mostrarLogin(mensaje = '') {
  $('vista-app').hidden = true;
  $('vista-login').hidden = false;
  $('login-error').textContent = mensaje;
  pin = '';
  pintarPin();
}

async function entrar(e) {
  e.preventDefault();
  const email = emailDeTelefono($('l-tel').value);
  if (!email) { $('login-error').textContent = 'Escribí tu teléfono con característica (10 números).'; $('l-tel').focus(); return; }
  if (pin.length < 6) { $('login-error').textContent = 'Ingresá los 6 números del PIN.'; return; }
  if (!navigator.onLine) { $('login-error').textContent = 'Necesitás señal para ingresar.'; return; }
  $('btn-entrar').disabled = true;
  const { data, error } = await sb.auth.signInWithPassword({ email, password: pin });
  $('btn-entrar').disabled = false;
  if (error) {
    $('login-error').textContent = error.status === 0 || /fetch/i.test(error.message) ? 'No hay conexión con el servidor.' : 'Teléfono o PIN incorrectos.';
    pin = ''; pintarPin();
    return;
  }
  if (data.user?.app_metadata?.rol !== 'vecino') {
    await sb.auth.signOut();
    $('login-error').textContent = 'Esta cuenta no es de un vecino. Los guardias ingresan desde "Soy guardia".';
    pin = ''; pintarPin();
    return;
  }
  mostrarApp();
}

async function salir() {
  await sb.auth.signOut();
  casa = null; autos = []; esperadas = []; llegadas = []; consultas = [];
  mostrarLogin();
}

// ---------- datos ----------
async function cargar() {
  const hoy = aISO(new Date());
  const [c, a, v, ll, co] = await Promise.all([
    sb.rpc('mi_casa'),
    sb.from('vehiculos_vecinos').select('id,patente,marca,modelo,color').order('id'),
    sb.from('visitas_esperadas').select('id,patente,nombre,motivo,dia').gte('dia', hoy).order('dia'),
    sb.rpc('mis_visitas'),
    sb.rpc('mis_consultas'),
  ]);
  if ([c, a, v, ll, co].some((r) => r.error)) toast('No se pudieron cargar los datos. Probá de nuevo.', true);
  casa = c.data?.[0] ?? null;
  autos = a.data ?? []; esperadas = v.data ?? []; llegadas = ll.data ?? []; consultas = co.data ?? [];
  pintarCasa(); pintarVisitas(); pintarConsultas();
}

// ---------- qué ve la garita ----------
const CAMPOS_PRIV = ['nombre', 'telefono', 'vehiculo', 'casa'];
function pintarPrivacidad() {
  if (!casa) { $('datos-casa').innerHTML = '<li class="vacio">Sin datos de la casa.</li>'; return; }
  const info = String(casa.info_adicional ?? '').trim();
  const resumenAutos = autos.map((a) => [a.marca, a.modelo, a.color].filter(Boolean).join(' ')).filter(Boolean).join(' · ') || '—';
  const valores = {
    nombre: ['Nombre', casa.nombre || '—'],
    telefono: ['Teléfono', casa.telefono || '—'],
    vehiculo: ['Vehículo (marca, modelo y color)', resumenAutos],
    casa: ['Casa', `Mz ${casa.manzana} · Lote ${casa.lote}${info ? ' · ' + info : ''}`],
  };
  const filas = CAMPOS_PRIV.map((k) => {
    const visible = !!casa[`mostrar_${k}`];
    return `<li><button type="button" class="priv-fila ${visible ? '' : 'priv-oculto'}" role="switch" aria-checked="${visible}" data-priv="${k}">
      <span class="priv-texto"><span class="priv-etiqueta">${esc(valores[k][0])}${visible ? '' : ' · oculto'}</span><span class="priv-valor">${esc(valores[k][1])}</span></span>
      <span class="interruptor" aria-hidden="true"></span></button></li>`;
  });
  const patentes = autos.map((a) => formatearPatente(a.patente)).join(' · ') || '—';
  filas.unshift(`<li><div class="priv-fila"><span class="priv-texto"><span class="priv-etiqueta">Patente</span><span class="priv-valor mono">${esc(patentes)}</span></span>
    <span class="priv-fija">${ICONO('lock')}Siempre visible</span></div></li>`);
  filas.push(`<li class="priv-nota">${ICONO('pencil')}<p>¿Cambió tu nombre, tu teléfono o tu casa? Avisale a la administración. Tus autos los editás vos desde acá.</p></li>`);
  $('datos-casa').innerHTML = filas.join('');
}

$('datos-casa').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-priv]');
  if (!b || !casa) return;
  const campo = b.dataset.priv, clave = `mostrar_${campo}`;
  casa[clave] = !casa[clave];
  pintarPrivacidad();
  const { error } = await sb.rpc('guardar_privacidad', {
    p_nombre: casa.mostrar_nombre, p_telefono: casa.mostrar_telefono, p_vehiculo: casa.mostrar_vehiculo, p_casa: casa.mostrar_casa,
  });
  if (error) { casa[clave] = !casa[clave]; pintarPrivacidad(); toast('No se pudo guardar. Probá de nuevo.', true); return; }
  toast(casa[clave] ? 'Ahora el guardia lo ve' : 'Ahora el guardia no lo ve');
});

// ---------- pintado ----------
const chapaTxt = (p) => esc(formatearPatente(p));
function pintarCasa() {
  if (!casa) {
    $('top-casa').textContent = '';
    $('saludo').textContent = 'Hola';
    return;
  }
  const info = String(casa.info_adicional ?? '').trim();
  const lote = `Mz ${casa.manzana} · Lote ${casa.lote}${info ? ' · ' + info : ''}`;
  $('top-casa').textContent = lote;
  $('saludo').textContent = casa.nombre ? `Hola, ${casa.nombre.split(' ')[0]}` : 'Hola';
  pintarPrivacidad();
  $('total-autos').textContent = plural(autos.length, 'auto', 'autos');
  $('lista-autos').innerHTML = autos.length ? autos.map((a) => `
    <li><span class="auto-icono">${ICONO('car')}</span>
      <div class="fila-datos">
        <p class="fila-quien">${esc([a.marca, a.modelo].filter(Boolean).join(' ') || 'Auto')}</p>
        <p class="fila-det">${a.color ? `<span class="swatch" style="display:inline-block;vertical-align:-2px;background:${colorCss(a.color)}"></span> ${esc(a.color)} · ` : ''}<b>${chapaTxt(a.patente)}</b></p>
      </div>
      <button class="btn-icono" type="button" data-editar="${esc(a.id)}" aria-label="Editar ${esc([a.marca, a.modelo].filter(Boolean).join(' ') || 'auto')} ${chapaTxt(a.patente)}">${ICONO('pencil')}</button></li>`).join('') : '<li class="vacio">No hay autos registrados.</li>';
}

function pintarVisitas() {
  $('total-esperadas').textContent = plural(esperadas.length, 'aviso', 'avisos');
  $('lista-esperadas').innerHTML = esperadas.length
    ? esperadas.map((v) => `
      <li><div class="fila-datos">
          <p class="fila-quien">${esc(v.nombre)}</p>
          <p class="fila-det">${v.patente ? `<b>${chapaTxt(v.patente)}</b> · ` : 'Sin patente · '}${esc(etiquetaDia(v.dia))}</p>
          ${v.motivo ? `<p class="fila-det">${esc(v.motivo)}</p>` : ''}
        </div>
        <button class="btn-icono" type="button" data-borrar="${esc(v.id)}" aria-label="Cancelar aviso de ${esc(v.nombre)}">${ICONO('trash')}</button></li>`).join('')
    : '<li class="vacio">No avisaste ninguna visita.</li>';

  $('lista-llegadas').innerHTML = llegadas.length
    ? llegadas.map((m) => {
      const d = new Date(m.created_at);
      const auto = [m.marca, m.color?.toLowerCase()].filter(Boolean).join(' ');
      return `<li><div class="fila-datos">
          <p class="fila-quien"><span class="mono">${chapaTxt(m.patente)}</span></p>
          <p class="fila-det">${esc(fechaCorta(d))}${auto ? ' · ' + esc(auto) : ''}</p>
        </div>
        <div class="fila-dir"><span class="dir ${m.tipo === 'entrada' ? 'entra' : 'sale'}">${ICONO(m.tipo === 'entrada' ? 'arrow-in' : 'arrow-out')}${m.tipo === 'entrada' ? 'Entrada' : 'Salida'}</span>
          <span class="fila-det mono">${esc(hhmm(d))}</span></div></li>`;
    }).join('')
    : '<li class="vacio">Sin visitas en los últimos 15 días.</li>';
}

function pintarConsultas() {
  $('total-consultas').textContent = plural(consultas.length, 'consulta', 'consultas');
  $('lista-consultas').innerHTML = consultas.length ? consultas.map((c) => {
    const d = new Date(c.created_at);
    return `<li><div class="fila-datos">
        <p class="fila-quien"><span class="mono">${chapaTxt(c.patente)}</span></p>
        <p class="fila-det">${esc(fechaCorta(d))}</p>
      </div>
      <span class="fila-det mono">${esc(hhmm(d))}</span></li>`;
  }).join('') : '<li class="vacio">Todavía no se consultó ninguna de tus patentes.</li>';
}

// ---------- editar mis autos ----------
let editando = null; // auto en edición (null = agregando uno nuevo)
const ERR_AUTO = {
  patente_no_disponible: 'No pudimos guardar esa patente. Revisala; si es tuya, hablá con la administración.',
  limite_de_autos: 'Llegaste al máximo de 6 autos.',
};
function abrirHoja(auto) {
  editando = auto;
  $('hoja-titulo').textContent = auto ? 'Editar auto' : 'Agregar un auto';
  $('a-patente').value = auto ? formatearPatente(auto.patente) : '';
  $('a-marca').value = auto?.marca ?? '';
  $('a-modelo').value = auto?.modelo ?? '';
  $('a-color').value = auto?.color ?? '';
  $('a-error').textContent = '';
  $('a-eliminar').hidden = !auto;
  $('hoja-auto').hidden = false;
  $('a-patente').focus();
}
const cerrarHoja = () => { $('hoja-auto').hidden = true; editando = null; };

$('btn-agregar-auto').addEventListener('click', () => {
  if (autos.length >= 6) { toast('Llegaste al máximo de 6 autos.', true); return; }
  abrirHoja(null);
});
$('lista-autos').addEventListener('click', (e) => {
  const b = e.target.closest('[data-editar]');
  if (b) abrirHoja(autos.find((a) => String(a.id) === b.dataset.editar) ?? null);
});
$('auto-cerrar').addEventListener('click', cerrarHoja);
$('hoja-auto').addEventListener('click', (e) => { if (e.target === $('hoja-auto')) cerrarHoja(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('hoja-auto').hidden) cerrarHoja(); });
$('a-patente').addEventListener('input', () => { $('a-error').textContent = ''; });

$('form-auto').addEventListener('submit', async (e) => {
  e.preventDefault();
  const patente = normalizarPatente($('a-patente').value);
  if (!/^[A-Z0-9]{5,8}$/.test(patente)) { $('a-error').textContent = 'Revisá la patente: tiene que tener entre 5 y 8 letras o números.'; $('a-patente').focus(); return; }
  const texto = (id) => $(id).value.trim() || null;
  const fila = { patente, marca: texto('a-marca'), modelo: texto('a-modelo'), color: texto('a-color') };
  $('a-guardar').disabled = true;
  const { error } = editando
    ? await sb.from('vehiculos_vecinos').update(fila).eq('id', editando.id)
    : await sb.from('vehiculos_vecinos').insert({ ...fila, casa_id: casa?.id });
  $('a-guardar').disabled = false;
  if (error) {
    $('a-error').textContent = error.code === '23505' ? 'Ya cargaste esa patente.'
      : Object.entries(ERR_AUTO).find(([k]) => error.message?.includes(k))?.[1] ?? 'No se pudo guardar. Probá de nuevo.';
    return;
  }
  cerrarHoja();
  toast(editando ? 'Auto actualizado' : 'Auto agregado');
  cargar();
});

$('a-eliminar').addEventListener('click', async () => {
  if (!editando || !confirm(`¿Eliminar ${formatearPatente(editando.patente)}? La garita lo va a tratar como un auto que no es del barrio.`)) return;
  const { error } = await sb.from('vehiculos_vecinos').delete().eq('id', editando.id);
  if (error) { $('a-error').textContent = 'No se pudo eliminar. Probá de nuevo.'; return; }
  cerrarHoja();
  toast('Auto eliminado');
  cargar();
});

// ---------- avisar visitas ----------
function llenarDias() {
  $('v-dia').innerHTML = [0, 1, 2, 3, 4, 5, 6].map((n) => {
    const iso = aISO(new Date(Date.now() + n * 864e5));
    return `<option value="${iso}">${esc(etiquetaDia(iso))}</option>`;
  }).join('');
}

$('form-visita').addEventListener('submit', async (e) => {
  e.preventDefault();
  const nombre = $('v-nombre').value.trim().replace(/\s+/g, ' ');
  if (nombre.split(' ').length < 2 || nombre.length < 4) { $('v-error').textContent = 'Escribí el nombre y el apellido de la visita.'; $('v-nombre').focus(); return; }
  const patente = normalizarPatente($('v-patente').value) || null; // la patente es opcional
  if (patente && !/^[A-Z0-9]{5,8}$/.test(patente)) { $('v-error').textContent = 'Revisá la patente: tiene que tener entre 5 y 8 letras o números. Si no la sabés, dejala vacía.'; $('v-patente').focus(); return; }
  if (patente && autos.some((a) => a.patente === patente)) { $('v-error').textContent = 'Esa patente ya es de uno de tus autos.'; return; }
  $('v-error').textContent = '';
  const { error } = await sb.from('visitas_esperadas').insert({ nombre, patente, motivo: $('v-motivo').value.trim() || null, dia: $('v-dia').value });
  if (error) { toast('No se pudo avisar. Probá de nuevo.', true); return; }
  $('v-patente').value = ''; $('v-nombre').value = ''; $('v-motivo').value = '';
  toast('Visita avisada a la garita');
  cargar();
});
$('v-nombre').addEventListener('input', () => { $('v-error').textContent = ''; });
$('v-patente').addEventListener('input', () => { $('v-error').textContent = ''; });

$('lista-esperadas').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-borrar]');
  if (!b) return;
  const { error } = await sb.from('visitas_esperadas').delete().eq('id', b.dataset.borrar);
  if (error) { toast('No se pudo cancelar. Probá de nuevo.', true); return; }
  toast('Aviso cancelado');
  cargar();
});

// ---------- notificaciones push ----------
const b64aBytes = (s) => {
  const b = atob((s + '='.repeat((4 - (s.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};
const esIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
const instalada = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const soportaPush = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function pintarAvisos(estado) {
  const b = $('btn-avisos'), nota = $('avisos-nota');
  nota.hidden = true;
  b.disabled = false;
  b.classList.remove('activo');
  b.innerHTML = `${ICONO('bell')}Activar notificaciones`;
  const bloquear = (txt) => { b.disabled = true; nota.hidden = false; nota.textContent = txt; };
  if (estado === 'activas') { b.classList.add('activo'); b.innerHTML = `${ICONO('check-circle')}Notificaciones activadas`; }
  else if (estado === 'instalar') bloquear('En iPhone primero instalá la app: tocá Compartir y elegí "Agregar a inicio". Después abrila desde el ícono y activá los avisos.');
  else if (estado === 'sinsoporte') bloquear('Este navegador no permite notificaciones.');
  else if (estado === 'bloqueadas') bloquear('Bloqueaste las notificaciones. Habilitalas desde los ajustes del navegador o del celular.');
}

async function estadoAvisos() {
  if (esIOS && !instalada) return 'instalar';
  if (!soportaPush) return 'sinsoporte';
  if (Notification.permission === 'denied') return 'bloqueadas';
  try {
    const reg = await navigator.serviceWorker.ready;
    if (Notification.permission === 'granted' && (await reg.pushManager.getSubscription())) return 'activas';
  } catch { /* sin service worker */ }
  return 'inactivas';
}

async function activarAvisos() {
  try {
    const permiso = await Notification.requestPermission();
    if (permiso !== 'granted') { pintarAvisos(await estadoAvisos()); return; }
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription())
      ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64aBytes(CONFIG.VAPID_PUBLICA) }));
    const j = sub.toJSON();
    // La tabla no permite UPDATE (solo INSERT/SELECT/DELETE): se reemplaza en vez de hacer upsert.
    await sb.from('push_suscripciones').delete().eq('endpoint', j.endpoint);
    const { error } = await sb.from('push_suscripciones').insert(
      { endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth });
    if (error) throw error;
    pintarAvisos('activas');
    toast('Listo: te vamos a avisar cuando entre un auto a tu casa');
  } catch (err) {
    console.warn('No se pudieron activar los avisos', err);
    pintarAvisos(await estadoAvisos());
    toast('No se pudieron activar los avisos. Probá de nuevo.', true);
  }
}
$('btn-avisos').addEventListener('click', () => { if (!$('btn-avisos').classList.contains('activo')) activarAvisos(); });

// ---------- pestañas ----------
function ir(tab) {
  document.querySelectorAll('[data-tab]').forEach((m) => (m.hidden = m.id !== `tab-${tab}`));
  document.querySelectorAll('.tabbar button').forEach((b) => (b.dataset.ir === tab ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
  window.scrollTo(0, 0);
}
document.querySelector('.tabbar').addEventListener('click', (e) => { const b = e.target.closest('[data-ir]'); if (b) ir(b.dataset.ir); });
$('btn-salir').addEventListener('click', salir);

async function mostrarApp() {
  $('vista-login').hidden = true;
  $('vista-app').hidden = false;
  llenarDias();
  ir(new URLSearchParams(location.search).get('tab') || 'casa');
  pintarAvisos(await estadoAvisos());
  cargar();
}

// Sin señal getSession puede no poder renovar el token: si ya había una sesión guardada, seguimos.
function haySesionGuardada() {
  try { return Object.keys(localStorage).some((k) => /^sb-.*-auth-token$/.test(k)); } catch { return false; }
}

async function iniciar() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(console.warn);
  armarTeclado();
  pintarPin();
  $('form-login').addEventListener('submit', entrar);
  document.addEventListener('keydown', (e) => {
    if ($('vista-login').hidden || e.metaKey || e.ctrlKey || e.target.id === 'l-tel') return;
    if (/^\d$/.test(e.key) && pin.length < 6) { pin += e.key; pintarPin(); }
    else if (e.key === 'Backspace') { pin = pin.slice(0, -1); pintarPin(); }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && casa) cargar(); });
  sb.auth.onAuthStateChange((evento) => { if (evento === 'SIGNED_OUT' && !$('vista-app').hidden) mostrarLogin('Se cerró la sesión.'); });

  let sesion = null;
  try { ({ data: { session: sesion } } = await sb.auth.getSession()); } catch { /* sin señal */ }
  if (sesion?.user?.app_metadata?.rol === 'vecino' || (!sesion && haySesionGuardada())) mostrarApp();
  else mostrarLogin();
}
iniciar();
