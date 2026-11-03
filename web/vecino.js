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
  $('vista-pin').hidden = true;
  $('vista-recuperar').hidden = true;
  $('vista-app').hidden = true;
  $('vista-login').hidden = false;
  $('login-error').textContent = mensaje;
  pin = '';
  pintarPin();
}

// ---------- login: alternar usuario / teléfono ----------
function modoTelefono() { return !$('campo-tel').hidden; }
function alternarModoLogin() {
  const aTelefono = !modoTelefono();
  $('campo-usuario').hidden = aTelefono;
  $('campo-tel').hidden = !aTelefono;
  $('btn-modo-login').textContent = aTelefono ? 'Usar tu usuario' : 'Usar tu teléfono';
  $('login-error').textContent = '';
  (aTelefono ? $('l-tel') : $('l-usuario')).focus();
}
$('btn-modo-login').addEventListener('click', alternarModoLogin);

async function entrar(e) {
  e.preventDefault();
  let email = null;
  if (modoTelefono()) {
    email = emailDeTelefono($('l-tel').value);
    if (!email) { $('login-error').textContent = 'Escribí tu teléfono con característica (10 números).'; $('l-tel').focus(); return; }
  } else {
    const usuario = $('l-usuario').value.trim();
    if (!usuario) { $('login-error').textContent = 'Escribí tu usuario.'; $('l-usuario').focus(); return; }
    if (pin.length < 6) { $('login-error').textContent = 'Ingresá los 6 números del PIN.'; return; }
    if (!navigator.onLine) { $('login-error').textContent = 'Necesitás señal para ingresar.'; return; }
    const { data: mail, error: errUsuario } = await sb.rpc('email_de_usuario', { p_usuario: usuario });
    if (errUsuario) { $('login-error').textContent = 'No hay conexión con el servidor.'; return; }
    if (!mail) { $('login-error').textContent = 'Usuario o PIN incorrectos.'; pin = ''; pintarPin(); return; }
    email = mail;
  }
  if (pin.length < 6) { $('login-error').textContent = 'Ingresá los 6 números del PIN.'; return; }
  if (!navigator.onLine) { $('login-error').textContent = 'Necesitás señal para ingresar.'; return; }
  $('btn-entrar').disabled = true;
  const { data, error } = await sb.auth.signInWithPassword({ email, password: pin });
  $('btn-entrar').disabled = false;
  if (error) {
    $('login-error').textContent = error.status === 0 || /fetch/i.test(error.message)
      ? 'No hay conexión con el servidor.'
      : (modoTelefono() ? 'Teléfono o PIN incorrectos.' : 'Usuario o PIN incorrectos.');
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

// ---------- primer ingreso: PIN nuevo, usuario y mail de recuperación ----------
// Las cuentas se crean todas con el mismo PIN; hasta que el vecino elige el suyo no pasa de esta pantalla.
// Después se le pide elegir un usuario (reemplaza al teléfono para entrar) y, opcionalmente, un mail
// para recuperar el PIN si lo llega a olvidar. Nada de esto se vuelve a pedir una vez guardado
// (pin_cambiado en user_metadata; usuario y email_recuperacion en la fila de la casa).
let nuevoPin = '', primerPin = '';
let paso = 'pin1'; // 'pin1' | 'pin2' | 'usuario' | 'email'

function pintarPinNuevo() {
  $('p-puntos').innerHTML = Array.from({ length: 6 }, (_, i) => `<span class="pin-punto ${i < nuevoPin.length ? 'lleno' : ''}"></span>`).join('');
  $('p-puntos').setAttribute('aria-label', `${nuevoPin.length} de 6 números ingresados`);
}

function tocarTeclaNueva(k) {
  $('p-error').textContent = '';
  if (k === 'del') nuevoPin = nuevoPin.slice(0, -1);
  else if (nuevoPin.length < 6) nuevoPin += k;
  pintarPinNuevo();
}

const pinDebil = (p) => /^(\d)\1{5}$/.test(p) || '01234567890'.includes(p) || '09876543210'.includes(p);
const emailValido = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

function mostrarVistaPinBase() {
  $('vista-login').hidden = true;
  $('vista-recuperar').hidden = true;
  $('vista-app').hidden = true;
  $('vista-pin').hidden = false;
  $('p-error').textContent = '';
  $('p-seguir').hidden = false;
}

function mostrarCambioPin() {
  mostrarVistaPinBase();
  paso = 'pin1';
  nuevoPin = ''; primerPin = '';
  $('p-campo-pin').hidden = false;
  $('p-campo-usuario').hidden = true;
  $('p-campo-email').hidden = true;
  $('p-saltar').hidden = true;
  $('p-titulo').textContent = 'Elegí tu nuevo PIN';
  $('p-sub').textContent = 'Al principio todos los vecinos tienen el mismo PIN. Elegí uno solo tuyo, de 6 números, para que nadie más pueda entrar a tu casa.';
  $('p-seguir').textContent = 'Continuar';
  pintarPinNuevo();
}

function mostrarPasoUsuario() {
  mostrarVistaPinBase();
  paso = 'usuario';
  $('p-campo-pin').hidden = true;
  $('p-campo-usuario').hidden = false;
  $('p-campo-email').hidden = true;
  $('p-saltar').hidden = true;
  $('p-titulo').textContent = 'Elegí tu usuario';
  $('p-sub').textContent = 'Lo vas a usar para entrar de ahora en más, en vez del teléfono.';
  $('p-seguir').textContent = 'Continuar';
  $('p-usuario').value = '';
  $('p-usuario').focus();
}

function mostrarPasoEmail() {
  mostrarVistaPinBase();
  paso = 'email';
  $('p-campo-pin').hidden = true;
  $('p-campo-usuario').hidden = true;
  $('p-campo-email').hidden = false;
  $('p-saltar').hidden = false;
  $('p-titulo').textContent = 'Mail para recuperar tu PIN';
  $('p-sub').textContent = 'Si alguna vez te olvidás el PIN, te mandamos un código a este mail para elegir uno nuevo.';
  $('p-seguir').textContent = 'Guardar';
  $('p-email').value = '';
  $('p-email').focus();
}

// Qué falta después de guardar el PIN: si no hay señal, se entra igual y se vuelve a pedir la próxima vez.
async function continuarDespuesDePin() {
  try {
    const { data } = await sb.rpc('mi_usuario');
    const info = data?.[0];
    if (info && !info.usuario) { mostrarPasoUsuario(); return; }
    if (info && !info.email_recuperacion) { mostrarPasoEmail(); return; }
  } catch { /* sin señal: seguimos */ }
  $('vista-pin').hidden = true;
  mostrarApp();
}

async function avanzarPin() {
  if (nuevoPin.length < 6) { $('p-error').textContent = 'Ingresá los 6 números.'; return; }
  if (paso === 'pin1') {
    if (pinDebil(nuevoPin)) { $('p-error').textContent = 'Ese PIN es muy fácil de adivinar. Elegí otro.'; nuevoPin = ''; pintarPinNuevo(); return; }
    primerPin = nuevoPin; nuevoPin = '';
    paso = 'pin2';
    $('p-titulo').textContent = 'Repetí tu nuevo PIN';
    $('p-seguir').textContent = 'Guardar PIN';
    pintarPinNuevo();
    return;
  }
  if (nuevoPin !== primerPin) {
    mostrarCambioPin(); $('p-error').textContent = 'No coinciden. Volvé a elegir tu PIN.';
    return;
  }
  if (!navigator.onLine) { $('p-error').textContent = 'Necesitás señal para guardar el PIN.'; return; }
  $('p-seguir').disabled = true;
  const { error } = await sb.auth.updateUser({ password: nuevoPin, data: { pin_cambiado: true } });
  $('p-seguir').disabled = false;
  if (error) {
    const igual = /different from the old|same/i.test(error.message);
    mostrarCambioPin();
    $('p-error').textContent = igual ? 'Tiene que ser distinto del PIN que te dieron. Elegí otro.' : 'No se pudo guardar el PIN. Probá de nuevo.';
    return;
  }
  await continuarDespuesDePin();
}

async function avanzarUsuario() {
  const usuario = $('p-usuario').value.trim().toLowerCase();
  if (!/^[a-z0-9_.]{3,20}$/.test(usuario)) { $('p-error').textContent = 'Usá entre 3 y 20 letras, números, puntos o guiones bajos (sin espacios ni acentos).'; return; }
  if (!navigator.onLine) { $('p-error').textContent = 'Necesitás señal para guardar el usuario.'; return; }
  $('p-seguir').disabled = true;
  const { error } = await sb.rpc('guardar_usuario', { p_usuario: usuario });
  $('p-seguir').disabled = false;
  if (error) {
    $('p-error').textContent = error.code === '23505' ? 'Ese usuario ya está en uso. Probá otro.' : 'No se pudo guardar. Probá de nuevo.';
    return;
  }
  mostrarPasoEmail();
}

async function avanzarEmail() {
  const email = $('p-email').value.trim();
  if (!email) { $('p-error').textContent = 'Escribí un mail, o tocá "Hacerlo más tarde".'; return; }
  if (!emailValido(email)) { $('p-error').textContent = 'Revisá el mail.'; return; }
  if (!navigator.onLine) { $('p-error').textContent = 'Necesitás señal para guardarlo.'; return; }
  $('p-seguir').disabled = true;
  const { error } = await sb.rpc('guardar_email_recuperacion', { p_email: email });
  $('p-seguir').disabled = false;
  if (error) { $('p-error').textContent = 'No se pudo guardar. Probá de nuevo.'; return; }
  $('vista-pin').hidden = true;
  mostrarApp();
}

function avanzarPaso() {
  if (paso === 'pin1' || paso === 'pin2') return avanzarPin();
  if (paso === 'usuario') return avanzarUsuario();
  if (paso === 'email') return avanzarEmail();
}

$('p-saltar').addEventListener('click', () => { $('vista-pin').hidden = true; mostrarApp(); });

function armarTecladoNuevo() {
  const teclas = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'];
  $('p-teclado').innerHTML = teclas.map((k) =>
    k === '' ? '<span class="tecla-vacia"></span>'
    : k === 'del' ? `<button type="button" class="tecla tecla-borrar" data-k="del" aria-label="Borrar último número">${ICONO('backspace')}</button>`
    : `<button type="button" class="tecla" data-k="${k}">${k}</button>`).join('');
  $('p-teclado').addEventListener('click', (e) => { const b = e.target.closest('[data-k]'); if (b) tocarTeclaNueva(b.dataset.k); });
  $('p-seguir').addEventListener('click', avanzarPaso);
  $('p-usuario').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); avanzarPaso(); } });
  $('p-email').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); avanzarPaso(); } });
  document.addEventListener('keydown', (e) => {
    if ($('vista-pin').hidden || e.metaKey || e.ctrlKey || paso === 'usuario' || paso === 'email') return;
    if (/^\d$/.test(e.key)) tocarTeclaNueva(e.key);
    else if (e.key === 'Backspace') tocarTeclaNueva('del');
    else if (e.key === 'Enter') avanzarPaso();
  });
}

// ---------- recuperar PIN (vecino ya logueado alguna vez, con usuario y mail guardados) ----------
let pasoR = 'pedir'; // 'pedir' | 'confirmar'
let pinR = '', usuarioR = '';

async function llamarRecuperarPin(cuerpo) {
  const r = await fetch(`${CONFIG.SUPABASE_URL}/functions/v1/recuperar-pin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: CONFIG.SUPABASE_ANON_KEY, Authorization: `Bearer ${CONFIG.SUPABASE_ANON_KEY}` },
    body: JSON.stringify(cuerpo),
  });
  return r.json().catch(() => ({ ok: false, error: 'respuesta_invalida' }));
}

function pintarPinR() {
  $('r-puntos').innerHTML = Array.from({ length: 6 }, (_, i) => `<span class="pin-punto ${i < pinR.length ? 'lleno' : ''}"></span>`).join('');
  $('r-puntos').setAttribute('aria-label', `${pinR.length} de 6 números ingresados`);
}
function tocarTeclaR(k) {
  $('r-error').textContent = '';
  if (k === 'del') pinR = pinR.slice(0, -1);
  else if (pinR.length < 6) pinR += k;
  pintarPinR();
}

function mostrarRecuperar() {
  $('vista-login').hidden = true;
  $('vista-pin').hidden = true;
  $('vista-app').hidden = true;
  $('vista-recuperar').hidden = false;
  pasoR = 'pedir'; pinR = ''; usuarioR = '';
  $('r-titulo').textContent = 'Recuperar tu PIN';
  $('r-sub').textContent = 'Escribí tu usuario. Si guardaste un mail de recuperación, te mandamos un código.';
  $('r-campo-usuario').hidden = false;
  $('r-campo-codigo').hidden = true;
  $('r-campo-pin').hidden = true;
  $('r-seguir').textContent = 'Mandar código';
  $('r-error').textContent = '';
  $('r-usuario').value = '';
  pintarPinR();
  $('r-usuario').focus();
}

async function pedirCodigoRecuperacion() {
  usuarioR = $('r-usuario').value.trim();
  if (!usuarioR) { $('r-error').textContent = 'Escribí tu usuario.'; return; }
  if (!navigator.onLine) { $('r-error').textContent = 'Necesitás señal para pedir el código.'; return; }
  $('r-seguir').disabled = true;
  await llamarRecuperarPin({ paso: 'pedir', usuario: usuarioR }).catch(() => null);
  $('r-seguir').disabled = false;
  pasoR = 'confirmar';
  $('r-sub').textContent = 'Si tu usuario existe y tiene un mail guardado, te llega un código en los próximos minutos. Escribilo junto con tu PIN nuevo.';
  $('r-campo-usuario').hidden = true;
  $('r-campo-codigo').hidden = false;
  $('r-campo-pin').hidden = false;
  $('r-titulo').textContent = 'Elegí tu PIN nuevo';
  $('r-seguir').textContent = 'Guardar PIN nuevo';
  $('r-codigo').value = ''; pinR = ''; pintarPinR();
  $('r-codigo').focus();
}

async function confirmarCodigoRecuperacion() {
  const codigo = $('r-codigo').value.trim();
  if (!/^\d{6}$/.test(codigo)) { $('r-error').textContent = 'El código tiene 6 números.'; return; }
  if (pinR.length < 6) { $('r-error').textContent = 'Ingresá los 6 números de tu PIN nuevo.'; return; }
  if (!navigator.onLine) { $('r-error').textContent = 'Necesitás señal para guardar el PIN.'; return; }
  $('r-seguir').disabled = true;
  const resp = await llamarRecuperarPin({ paso: 'confirmar', usuario: usuarioR, codigo, nuevo_pin: pinR }).catch(() => ({ ok: false }));
  $('r-seguir').disabled = false;
  if (!resp?.ok) {
    const MENSAJES = { codigo_invalido: 'Código incorrecto, vencido o ya usado.', pin_debil: 'Ese PIN es muy fácil de adivinar. Elegí otro.' };
    $('r-error').textContent = MENSAJES[resp?.error] ?? 'No se pudo cambiar el PIN. Probá de nuevo.';
    pinR = ''; pintarPinR();
    return;
  }
  mostrarLogin('Listo: ya podés entrar con tu usuario y tu PIN nuevo.');
}

function avanzarRecuperar() { return pasoR === 'pedir' ? pedirCodigoRecuperacion() : confirmarCodigoRecuperacion(); }

function armarTecladoRecuperar() {
  const teclas = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'];
  $('r-teclado').innerHTML = teclas.map((k) =>
    k === '' ? '<span class="tecla-vacia"></span>'
    : k === 'del' ? `<button type="button" class="tecla tecla-borrar" data-k="del" aria-label="Borrar último número">${ICONO('backspace')}</button>`
    : `<button type="button" class="tecla" data-k="${k}">${k}</button>`).join('');
  $('r-teclado').addEventListener('click', (e) => { const b = e.target.closest('[data-k]'); if (b) tocarTeclaR(b.dataset.k); });
  $('r-seguir').addEventListener('click', avanzarRecuperar);
  $('r-volver').addEventListener('click', () => mostrarLogin());
  $('r-usuario').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); avanzarRecuperar(); } });
  $('r-codigo').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); avanzarRecuperar(); } });
  document.addEventListener('keydown', (e) => {
    if ($('vista-recuperar').hidden || e.metaKey || e.ctrlKey || pasoR !== 'confirmar' || document.activeElement === $('r-codigo')) return;
    if (/^\d$/.test(e.key)) tocarTeclaR(e.key);
    else if (e.key === 'Backspace') tocarTeclaR('del');
    else if (e.key === 'Enter') avanzarRecuperar();
  });
}

$('link-olvide-pin').addEventListener('click', (e) => { e.preventDefault(); mostrarRecuperar(); });

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
  pintarCasa(); pintarProximas(); pintarVisitas(); pintarConsultas();
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
    const fila = `<li><button type="button" class="priv-fila ${visible ? '' : 'priv-oculto'}" role="switch" aria-checked="${visible}" data-priv="${k}">
      <span class="priv-texto"><span class="priv-etiqueta">${esc(valores[k][0])}${visible ? '' : ' · oculto'}</span><span class="priv-valor">${esc(valores[k][1])}</span></span>
      <span class="interruptor" aria-hidden="true"></span></button></li>`;
    if (k !== 'nombre') return fila;
    return fila + `<li class="priv-alias-fila">
      <label class="etiqueta" for="input-alias">Alias para la garita (opcional)</label>
      <input id="input-alias" class="input" type="text" maxlength="24" placeholder="Ej: Javo" value="${esc(casa.alias ?? '')}">
      <p class="ayuda">Si lo completás, el guardia ve este alias en vez de tu nombre completo.</p>
    </li>`;
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

$('datos-casa').addEventListener('keydown', (e) => {
  if (e.target.id === 'input-alias' && e.key === 'Enter') e.target.blur();
});

$('datos-casa').addEventListener('change', async (e) => {
  if (e.target.id !== 'input-alias' || !casa) return;
  const anterior = casa.alias ?? null;
  const valor = e.target.value.trim();
  casa.alias = valor || null;
  const { error } = await sb.rpc('guardar_alias', { p_alias: valor });
  if (error) { casa.alias = anterior; pintarPrivacidad(); toast('No se pudo guardar el alias. Probá de nuevo.', true); return; }
  pintarPrivacidad();
  toast(valor ? 'Alias guardado' : 'Alias borrado');
});

// ---------- pintado ----------
const chapaTxt = (p) => esc(formatearPatente(p));
function saludoPrevio() {
  const h = new Date().getHours();
  return h < 12 ? 'Buenos días' : h < 20 ? 'Buenas tardes' : 'Buenas noches';
}
function pintarCasa() {
  if (!casa) {
    $('top-casa').textContent = '';
    $('saludo-previa').textContent = saludoPrevio();
    $('saludo').textContent = 'Hola';
    $('banner-texto').textContent = '';
    return;
  }
  const info = String(casa.info_adicional ?? '').trim();
  const lote = `Mz ${casa.manzana} · Lote ${casa.lote}${info ? ' · ' + info : ''}`;
  $('top-casa').textContent = lote;
  const apellido = casa.nombre ? casa.nombre.trim().split(/\s+/).pop() : '';
  $('saludo-previa').textContent = apellido ? `${saludoPrevio()}, familia ${apellido}` : saludoPrevio();
  $('saludo').textContent = `Hola, Manzana ${casa.manzana} · Lote ${casa.lote}`;
  pintarPrivacidad();

  const hoy = new Date().toDateString();
  const entradasHoy = llegadas.filter((m) => m.tipo === 'entrada' && new Date(m.created_at).toDateString() === hoy).length;
  $('banner-texto').textContent = entradasHoy
    ? `Hoy ${entradasHoy === 1 ? 'entró 1 visita' : `entraron ${entradasHoy} visitas`} a tu casa.`
    : 'Hoy no entraron visitas a tu casa.';

  $('acceso-autos-total').textContent = plural(autos.length, 'registrado', 'registrados');
  $('total-autos').textContent = plural(autos.length, 'auto', 'autos');
  $('lista-autos').innerHTML = autos.length ? autos.map((a) => `
    <li><span class="auto-icono">${ICONO('car')}</span>
      <div class="fila-datos">
        <p class="fila-quien">${esc([a.marca, a.modelo].filter(Boolean).join(' ') || 'Auto')}</p>
        <p class="fila-det">${a.color ? `<span class="swatch" style="display:inline-block;vertical-align:-2px;background:${colorCss(a.color)}"></span> ${esc(a.color)} · ` : ''}<b>${chapaTxt(a.patente)}</b></p>
      </div>
      <button class="btn-icono" type="button" data-editar="${esc(a.id)}" aria-label="Editar ${esc([a.marca, a.modelo].filter(Boolean).join(' ') || 'auto')} ${chapaTxt(a.patente)}">${ICONO('pencil')}</button></li>`).join('') : '<li class="vacio">No hay autos registrados.</li>';
}

function pintarProximas() {
  const proximas = esperadas.slice(0, 3);
  $('lista-proximas').innerHTML = proximas.length
    ? proximas.map((v) => `
      <li><span class="chip-patente">${v.patente ? chapaTxt(v.patente) : '—'}</span>
        <div class="fila-datos">
          <p class="fila-quien">${esc(v.nombre)}</p>
          <p class="fila-det">${esc(etiquetaDia(v.dia))}${etiquetaDia(v.dia) === 'Hoy' ? ' · esperando' : ''}${v.motivo ? ' · ' + esc(v.motivo) : ''}</p>
        </div></li>`).join('')
    : '<li class="vacio">No avisaste ninguna visita.</li>';
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
$('acceso-visita').addEventListener('click', () => { ir('visitas'); $('v-nombre').focus(); });
$('ver-todas-visitas').addEventListener('click', () => ir('visitas'));
$('acceso-autos').addEventListener('click', () => $('seccion-autos').scrollIntoView({ behavior: 'smooth', block: 'start' }));
$('btn-perfil').addEventListener('click', () => ir('perfil'));
$('btn-perfil-volver').addEventListener('click', () => ir('casa'));
$('btn-salir').addEventListener('click', salir);

async function mostrarApp() {
  // Primer ingreso: antes de ver nada tiene que elegir su PIN (si no hay señal para guardarlo, entra igual).
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (session?.user?.user_metadata?.pin_cambiado !== true && navigator.onLine) { mostrarCambioPin(); return; }
  } catch { /* sin sesión legible */ }
  // Cuentas que ya habían cambiado el PIN antes de que existiera el usuario/mail de recuperación:
  // se les pide una sola vez, igual que en el primer ingreso.
  if (navigator.onLine) {
    try {
      const { data } = await sb.rpc('mi_usuario');
      const info = data?.[0];
      if (info && !info.usuario) { mostrarPasoUsuario(); return; }
      if (info && !info.email_recuperacion) { mostrarPasoEmail(); return; }
    } catch { /* sin señal: se le vuelve a pedir la próxima vez */ }
  }
  $('vista-pin').hidden = true;
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
  armarTecladoNuevo();
  pintarPinNuevo();
  armarTecladoRecuperar();
  $('form-login').addEventListener('submit', entrar);
  document.addEventListener('keydown', (e) => {
    if ($('vista-login').hidden || e.metaKey || e.ctrlKey || e.target.id === 'l-tel' || e.target.id === 'l-usuario') return;
    if (/^\d$/.test(e.key) && pin.length < 6) { pin += e.key; pintarPin(); }
    else if (e.key === 'Backspace') { pin = pin.slice(0, -1); pintarPin(); }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && casa) cargar(); });
  sb.auth.onAuthStateChange((evento) => { if (evento === 'SIGNED_OUT' && !$('vista-app').hidden) mostrarLogin('Se cerró la sesión.'); });

  let sesion = null;
  try { ({ data: { session: sesion } } = await sb.auth.getSession()); } catch { /* sin señal */ }
  // Un guardia que abre vecino.html vuelve a su vista.
  if (sesion?.user?.app_metadata?.rol === 'guardia') {
    if (/[?&]entrar\b/.test(location.search)) { await sb.auth.signOut(); mostrarLogin(); return; }
    location.replace('index.html'); return;
  }
  if (sesion?.user?.app_metadata?.rol === 'vecino' || (!sesion && haySesionGuardada())) mostrarApp();
  else mostrarLogin();
}
iniciar();
