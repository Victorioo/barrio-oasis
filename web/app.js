import { CONFIG } from './config.js';
import * as db from './db.js';
import {
  normalizarPatente, formatearPatente, ordenarCasas, entradasPrevias, colorCss,
  turnoDelDia, fechaCorta, hhmm,
} from './logic.js';

const sb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- estado en memoria (espejo de IndexedDB) ----------
let casas = [];
let casasPorId = new Map();
let vehiculosPorPatente = new Map();
let movimientos = [];
let pendientesN = 0;
let sincronizando = false;
let actual = null; // { patente, vehiculos, previas }
let casaElegida = null;
let selMz = '', selLote = ''; // selección en curso de manzana y lote
let nuevaId = null; // último movimiento registrado (se resalta en la lista)
let pin = '';
let muni = { estado: 'idle', datos: null }; // consulta de datos del vehículo en el Portal Tributario
let datosVisita = { marca: '', color: '', detalles: '' }; // campos opcionales de un auto no registrado
let ultimaConsulta = { patente: '', t: 0 }; // evita registrar dos veces la misma consulta seguida
let retenidoId = null; // movimiento recién registrado: no se sube hasta que pase el plazo de "Deshacer"
const PLAZO_DESHACER = 5000;

const icono = (n, cls = '') => `<svg class="i ${cls}" aria-hidden="true"><use href="#i-${n}"/></svg>`;

const nuevoId = () =>
  crypto.randomUUID
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 3) | 8).toString(16);
      });

const infoCasa = (c) => String(c?.info_adicional ?? '').trim();
const nombreCasa = (c) => (c ? `Mz ${c.manzana} · Lote ${c.lote}${infoCasa(c) ? ' · ' + infoCasa(c) : ''}` : 'Casa sin datos');
const nombreCasaLargo = (c, conInfo = true) =>
  c ? `Manzana ${c.manzana} · Lote ${c.lote}${conInfo && infoCasa(c) ? ' · ' + infoCasa(c) : ''}` : 'Casa sin datos';
const nombreCasaCorto = (c) => (c ? `Mz ${c.manzana} · L ${c.lote}` : 'Casa sin datos');
const hora = (iso) => hhmm(new Date(iso));
const nombreGuardia = () => {
  try { return (localStorage.getItem('guardia') || '').trim(); } catch { return ''; }
};

// Chapa Mercosur: size 'l' (resultado) o 's' (lista)
const chapa = (patente, size) => {
  const num = formatearPatente(patente);
  return `<div class="patente patente-${size}" role="img" aria-label="Patente ${esc(num)}">
    <div class="patente-banda" aria-hidden="true"><span>REPÚBLICA ARGENTINA</span><span class="bandera"></span></div>
    <div class="patente-num">${esc(num)}</div>
  </div>`;
};

let toastTimer;
function avisar(titulo, sub = '', deshacerId = null) {
  const t = $('toast');
  t.innerHTML = `${icono('check-circle')}<div class="toast-cuerpo"><p class="toast-titulo">${esc(titulo)}</p>${sub ? `<p class="toast-sub">${esc(sub)}</p>` : ''}</div>${deshacerId ? '<button type="button" class="toast-deshacer" id="toast-deshacer">Deshacer</button>' : ''}`;
  t.hidden = false;
  if (deshacerId) $('toast-deshacer').onclick = () => deshacer(deshacerId);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.hidden = true;
    if (nuevaId) { nuevaId = null; pintarLista(); }
  }, deshacerId ? PLAZO_DESHACER : 2500);
}

async function deshacer(id) {
  await db.borrarMovimiento(id);
  retenidoId = null;
  nuevaId = null;
  await cargarCache();
  avisar('Registro deshecho');
}

// ---------- cache local ----------
async function cargarCache() {
  const [cs, vs, ms, pend, consultas] = await Promise.all([
    db.todos('casas'),
    db.todos('vehiculos'),
    db.todos('movimientos'),
    db.pendientes(),
    db.consultasPendientes(),
  ]);
  casas = cs;
  casasPorId = new Map(cs.map((c) => [c.id, c]));
  vehiculosPorPatente = new Map();
  for (const v of vs) {
    if (!vehiculosPorPatente.has(v.patente)) vehiculosPorPatente.set(v.patente, []);
    vehiculosPorPatente.get(v.patente).push(v);
  }
  movimientos = ms.filter((m) => !m.es_vecino); // la garita no ve movimientos de vecinos
  pendientesN = pend.filter((m) => m.id !== retenidoId).length + consultas.length; // el recién registrado no cuenta mientras se puede deshacer
  pintarEstado();
  pintarLista();
}

// ---------- sincronización ----------
async function traerTodo(tabla, columnas, filtro) {
  const filas = [];
  for (let desde = 0; ; desde += 1000) {
    let q = sb.from(tabla).select(columnas).order('id').range(desde, desde + 999);
    if (filtro) q = filtro(q);
    const { data, error } = await q;
    if (error) throw error;
    filas.push(...data);
    if (data.length < 1000) return filas;
  }
}

async function subirPendientes() {
  const pend = (await db.pendientes()).filter((m) => m.id !== retenidoId);
  for (let i = 0; i < pend.length; i += 100) {
    const lote = pend.slice(i, i + 100);
    const filas = lote.map(({ pendiente, ...m }) => m);
    // ignoreDuplicates: si ya se había subido (corte justo antes de confirmar), no duplica.
    const { error } = await sb.from('movimientos').upsert(filas, { onConflict: 'id', ignoreDuplicates: true });
    if (error) throw error;
    await db.marcarSubidos(lote.map((m) => m.id));
  }

  const consultas = await db.consultasPendientes();
  for (let i = 0; i < consultas.length; i += 100) {
    const lote = consultas.slice(i, i + 100);
    const filas = lote.map(({ pendiente, ...c }) => c);
    const { error } = await sb.from('consultas_vecinos').upsert(filas, { onConflict: 'id', ignoreDuplicates: true });
    if (error) throw error;
    await db.borrarConsultas(lote.map((c) => c.id));
  }
}

const HORA = 3600000;

// Para ahorrar datos: casas y vehículos se bajan completos al abrir la app o una vez por hora;
// los movimientos se bajan solo los nuevos desde la última vez (columna subido_at del servidor).
async function sincronizar(forzar = false) {
  if (sincronizando || !navigator.onLine || $('vista-app').hidden) return;
  sincronizando = true;
  pintarEstado();
  try {
    await subirPendientes();

    const maestrosAt = await db.leerMeta('maestrosAt');
    if (forzar || !maestrosAt || !casas.length || Date.now() - Date.parse(maestrosAt) > HORA) {
      // Lo que cada vecino decidió ocultar llega vacío desde el servidor (no se guarda en este celular).
      const [rc, rv] = await Promise.all([sb.rpc('casas_garita'), sb.rpc('vehiculos_garita')]);
      if (rc.error || rv.error) throw rc.error || rv.error;
      const [cs, vs] = [rc.data, rv.data];
      await db.reemplazar('casas', cs);
      await db.reemplazar('vehiculos', vs);
      await db.guardarMeta('maestrosAt', new Date().toISOString());
    }

    const desde = new Date(Date.now() - CONFIG.DIAS_HISTORIAL * 86400000).toISOString();
    const movHasta = await db.leerMeta('movHasta');
    const ahoraMenos2min = new Date(Date.now() - 120000).toISOString(); // margen por transacciones en vuelo
    const ms = await traerTodo('movimientos', 'id,patente,tipo,es_vecino,casa_destino_id,created_at,guardia,subido_at,marca,color,detalles', (q) =>
      movHasta ? q.gt('subido_at', movHasta) : q.gte('created_at', desde)
    );
    await db.fusionarMovimientos(ms, desde);
    const maxSubido = ms.reduce((mx, m) => (m.subido_at && m.subido_at > mx ? m.subido_at : mx), '');
    await db.guardarMeta('movHasta', maxSubido && maxSubido < ahoraMenos2min ? maxSubido : ahoraMenos2min);
    await db.guardarMeta('ultimaSync', new Date().toISOString());
    await cargarCache();
  } catch (err) {
    console.warn('Sincronización falló', err);
    if (err?.status === 401 || err?.code === 'PGRST301') mostrarLogin('Se venció la sesión. Ingresá el PIN de nuevo.');
  } finally {
    sincronizando = false;
    pintarEstado();
  }
}

// ---------- indicador de conexión ----------
function pintarEstado() {
  const offline = !navigator.onLine;
  let tipo, icon, texto;
  if (offline) { tipo = 'off'; icon = 'wifi-off'; texto = 'Sin conexión'; }
  else if (pendientesN) { tipo = 'pend'; icon = 'upload-cloud'; texto = `${pendientesN} por subir`; }
  else { tipo = 'ok'; icon = 'wifi'; texto = sincronizando ? 'Actualizando…' : 'En línea'; }
  document.querySelectorAll('[data-conexion]').forEach((el) => {
    el.dataset.estado = tipo;
    el.innerHTML = `${icono(icon)}${esc(texto)}`;
  });

  $('banner-offline').hidden = !offline;
  $('banner-titulo').textContent = pendientesN
    ? `Sin conexión · ${pendientesN} registro${pendientesN > 1 ? 's' : ''} pendiente${pendientesN > 1 ? 's' : ''} de subir`
    : 'Sin conexión';

  const n = nombreGuardia();
  $('turno').textContent = `Turno ${turnoDelDia()}${n ? ' · ' + n : ''}`;
  $('turno').setAttribute('aria-label', n ? `Turno, guardia ${n}. Tocá para cambiar el nombre` : 'Turno. Tocá para poner tu nombre');
}

// ---------- pantallas ----------
function mostrarPantalla(cual) {
  $('pantalla-principal').hidden = cual !== 'principal';
  $('pantalla-resultado').hidden = cual !== 'resultado';
  window.scrollTo(0, 0);
}

// ---------- búsqueda ----------
function buscar() {
  const patente = normalizarPatente($('patente').value);
  $('patente').value = patente;
  if (patente.length < 5) {
    $('patente').focus();
    avisarError('Escribí la patente completa');
    return;
  }
  casaElegida = null; selMz = ''; selLote = '';
  datosVisita = { marca: '', color: '', detalles: '' };
  muni = { estado: 'idle', datos: null };
  const vehiculos = vehiculosPorPatente.get(patente) ?? [];
  const previas = vehiculos.length ? [] : entradasPrevias(movimientos, patente, CONFIG.DIAS_HISTORIAL);
  actual = { patente, vehiculos, previas };
  if (vehiculos.length) registrarConsulta(patente, vehiculos[0].casa_id);
  pintarResultado();
  actualizarAcciones();
  document.activeElement?.blur();
  mostrarPantalla('resultado');
}

// Patente de vecino: no se registran entradas/salidas, solo queda guardado que el guardia la consultó.
async function registrarConsulta(patente, casaId) {
  const ahora = Date.now();
  if (ultimaConsulta.patente === patente && ahora - ultimaConsulta.t < 60000) return;
  ultimaConsulta = { patente, t: ahora };
  try {
    await db.guardarConsulta({
      id: nuevoId(),
      patente,
      casa_id: casaId ?? null,
      guardia: nombreGuardia() || null,
      created_at: new Date(ahora).toISOString(),
    });
    await cargarCache();
    sincronizar();
  } catch (err) {
    console.warn('No se pudo guardar la consulta', err);
  }
}

function avisarError(texto) {
  const t = $('toast');
  t.innerHTML = `${icono('info')}<div class="toast-cuerpo"><p class="toast-titulo">${esc(texto)}</p></div>`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2500);
}

function pintarResultado() {
  const { patente, vehiculos, previas } = actual;
  let html = '';

  if (vehiculos.length) {
    html += `<section class="estado estado-ok" role="status">
        <span class="estado-icono">${icono('check')}</span>
        <div><h2 class="estado-titulo">Es del barrio</h2><p class="estado-sub">Auto registrado por un vecino</p></div>
      </section>
      <div class="chapa-centro">${chapa(patente, 'l')}</div>`;
    for (const v of vehiculos) {
      const casa = casasPorId.get(v.casa_id);
      const tel = String(v.telefono ?? '').trim();
      const telHref = tel.replace(/[^\d+]/g, '');
      const auto = [v.marca, v.modelo].filter(Boolean).join(' ');
      const filas = [
        v.nombre ? `<div><dt>Nombre</dt><dd>${esc(v.nombre)}</dd></div>` : '',
        tel ? `<div><dt>Teléfono</dt><dd><a class="tel" href="tel:${esc(telHref)}">${icono('phone')}${esc(tel)}</a></dd></div>` : '',
        auto || v.color ? `<div><dt>Vehículo</dt><dd class="vehiculo-valor"><span class="swatch" style="background:${colorCss(v.color)}"></span>${esc(auto)}${auto && v.color ? ' · ' : ''}${esc(v.color ?? '')}</dd></div>` : '',
        casa ? `<div><dt>Casa</dt><dd>${esc(nombreCasaLargo(casa, false))}</dd></div>` : '',
        casa && infoCasa(casa) ? `<div><dt>Información adicional</dt><dd>${esc(infoCasa(casa))}</dd></div>` : '',
      ].filter(Boolean);
      html += filas.length
        ? `<dl class="card datos">${filas.join('')}</dl>`
        : `<p class="nota-consulta">${icono('info')}El vecino eligió no mostrar más datos.</p>`;
    }
  } else {
    const ambar = previas.length >= CONFIG.ALERTA_MIN_ENTRADAS;
    if (ambar) {
      html += `<section class="estado estado-alerta" role="alert">
          <span class="estado-icono">${icono('alert')}</span>
          <div><h2 class="estado-titulo">Atención</h2><p class="estado-sub">Esta patente ya vino ${previas.length} veces en ${CONFIG.DIAS_HISTORIAL} días</p></div>
        </section>`;
    } else {
      html += `<section class="estado estado-no" role="alert">
          <span class="estado-icono">${icono('x')}</span>
          <div><h2 class="estado-titulo">No registrada</h2><p class="estado-sub">Ningún vecino cargó esta patente.</p></div>
        </section>`;
    }
    html += `<div class="chapa-centro">${chapa(patente, 'l')}</div>`;
    html += `<div class="muni">
        <div class="casa-etiqueta">Datos oficiales del vehículo<span>Portal Municipal</span></div>
        <button id="btn-muni" type="button" class="btn btn-contorno">${icono('search')}Consultar datos del vehículo</button>
        <div id="muni-resultado" aria-live="polite"></div>
      </div>`;
    if (ambar) {
      html += `<div class="card previas">
          <div class="previas-titulo">${icono('history')}Visitas anteriores</div>
          <ul>${previas
            .map((m) => {
              const d = new Date(m.created_at);
              const casa = m.casa_destino_id ? nombreCasaCorto(casasPorId.get(m.casa_destino_id)) : 'Sin casa';
              const auto = [m.marca, m.color].filter(Boolean).join(' · ');
              const extra = [auto, m.detalles].filter(Boolean).join(' — ');
              return `<li><span class="p-fecha">${esc(fechaCorta(d))}</span><span class="p-hora">${esc(hhmm(d))}</span><span class="p-casa">${esc(casa)}</span>${extra ? `<span class="p-detalle">${esc(extra)}</span>` : ''}</li>`;
            })
            .join('')}</ul>
        </div>`;
    }
    html += `<div class="card visita-form">
        <div class="casa-etiqueta">Datos del vehículo<span>Opcional</span></div>
        <div class="form-fila">
          <div><label class="etiqueta" for="v-marca">Marca</label>
            <input id="v-marca" class="input" type="text" list="lista-marcas" autocomplete="off" autocapitalize="words" placeholder="Ej: Fiat"></div>
          <div><label class="etiqueta" for="v-color">Color</label>
            <input id="v-color" class="input" type="text" list="lista-colores" autocomplete="off" autocapitalize="words" placeholder="Ej: Blanco"></div>
        </div>
        <div><label class="etiqueta" for="v-detalles">¿Se frenó en algún lado?</label>
          <textarea id="v-detalles" class="input input-area" rows="2" maxlength="300" placeholder="Más detalles: dónde se detuvo, qué hizo…"></textarea></div>
      </div>
      <div class="casa-bloque" id="selector">
        <div class="casa-etiqueta">¿A qué casa va?<span>Opcional</span></div>
        <div id="casa-zona"></div>
      </div>`;
  }

  $('resultado').innerHTML = html;
  $('resultado').classList.toggle('compacto', !vehiculos.length);
  if (!vehiculos.length) {
    $('btn-muni').addEventListener('click', consultarVehiculo);
    for (const [id, campo] of [['v-marca', 'marca'], ['v-color', 'color'], ['v-detalles', 'detalles']])
      $(id).addEventListener('input', (e) => { datosVisita[campo] = e.target.value; });
    pintarSelector();
  }
}

// Datos del vehículo según el Portal Tributario (la consulta pasa por una función del servidor;
// el portal no se puede llamar directo desde el celular, y de él solo se traen los datos del vehículo).
async function consultarVehiculo() {
  if (!actual || actual.vehiculos.length) return;
  const patente = actual.patente;
  if (!navigator.onLine) {
    muni = { estado: 'offline', datos: null };
    pintarMuni();
    return;
  }
  muni = { estado: 'cargando', datos: null };
  pintarMuni();
  try {
    const { data, error } = await sb.functions.invoke('consultar-vehiculo', { body: { patente } });
    if (actual?.patente !== patente) return; // el guardia ya pasó a otra patente
    if (error) muni = { estado: error.context?.status === 422 ? 'formato' : 'error', datos: null };
    else if (!data?.encontrado) muni = { estado: 'nada', datos: null };
    else muni = { estado: 'ok', datos: data };
  } catch (err) {
    console.warn('Consulta al portal falló', err);
    if (actual?.patente !== patente) return;
    muni = { estado: 'error', datos: null };
  }
  pintarMuni();
}

function pintarMuni() {
  const btn = $('btn-muni');
  const caja = $('muni-resultado');
  if (!btn || !caja) return;
  const { estado, datos } = muni;
  btn.disabled = estado === 'cargando';
  btn.innerHTML = `${icono('search')}${estado === 'cargando' ? 'Consultando…' : estado === 'idle' ? 'Consultar datos del vehículo' : 'Volver a consultar'}`;

  const aviso = (txt) => `<p class="muni-aviso">${icono('info')}${esc(txt)}</p>`;
  if (estado === 'ok') {
    const filas = [['Marca', datos.marca], ['Tipo', datos.tipo], ['Modelo', datos.modelo], ['Estado', datos.estado]].filter(([, v]) => v);
    if (!datos.marca && datos.detalle) filas.unshift(['Detalle', datos.detalle]); // formato inesperado: se muestra el texto completo
    caja.innerHTML = `<dl class="card datos">${filas.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
      <p class="nota-consulta">${icono('check-circle')}Portal Tributario Municipal · ${esc(hhmm(new Date(datos.consultado_en || Date.now())))}</p>`;
  } else if (estado === 'nada') caja.innerHTML = aviso('No encontré esta patente en el Portal Tributario.');
  else if (estado === 'formato') caja.innerHTML = aviso('La patente tiene un formato inusual y no se puede consultar.');
  else if (estado === 'offline') caja.innerHTML = aviso('Sin conexión: no se puede consultar ahora.');
  else if (estado === 'error') caja.innerHTML = aviso('No se pudo consultar ahora. Probá de nuevo.');
  else caja.innerHTML = '';
}

function casasSugeridas() {
  const vistas = new Map();
  for (const m of actual.previas) {
    if (m.casa_destino_id && casasPorId.has(m.casa_destino_id)) vistas.set(m.casa_destino_id, casasPorId.get(m.casa_destino_id));
  }
  return [...vistas.values()].slice(0, 3);
}

function elegirCasa(c) {
  casaElegida = c;
  pintarSelector();
  actualizarAcciones();
}

function pintarSelector() {
  const zona = $('casa-zona');
  if (!zona) return;
  if (casaElegida) {
    zona.innerHTML = `<div class="elegida">${icono('home')}<span>${esc(nombreCasaLargo(casaElegida))}</span>
      <button type="button" id="casa-cambiar">Cambiar</button></div>`;
    $('casa-cambiar').onclick = () => {
      casaElegida = null; selMz = ''; selLote = '';
      pintarSelector();
      actualizarAcciones();
    };
    return;
  }

  const unicos = (a) => [...new Set(a)];
  const ordenadas = ordenarCasas(casas);
  const manzanas = unicos(ordenadas.map((c) => c.manzana));
  const lotes = selMz ? unicos(ordenadas.filter((c) => c.manzana === selMz).map((c) => c.lote)) : [];
  const familias = selMz && selLote ? ordenadas.filter((c) => c.manzana === selMz && c.lote === selLote) : [];
  const opciones = (vals, sel, vacio) => `<option value="">${vacio}</option>` + vals.map((v) => `<option value="${esc(v)}"${v === sel ? ' selected' : ''}>${esc(v)}</option>`).join('');

  const sugeridas = casasSugeridas();
  zona.innerHTML = `
    ${sugeridas.length ? `<div class="sugeridas">${sugeridas
      .map((c) => `<button type="button" class="sugerida" data-id="${c.id}">${icono('history')}${esc(nombreCasa(c))}</button>`)
      .join('')}</div>` : ''}
    <div class="form-fila">
      <div><label class="etiqueta" for="sel-mz">Manzana</label>
        <select id="sel-mz" class="input">${opciones(manzanas, selMz, 'Elegir')}</select></div>
      <div><label class="etiqueta" for="sel-lote">Lote</label>
        <select id="sel-lote" class="input"${selMz ? '' : ' disabled'}>${opciones(lotes, selLote, 'Elegir')}</select></div>
    </div>
    <div><label class="etiqueta" for="sel-info">Dato adicional</label>
      <select id="sel-info" class="input"${familias.length > 1 ? '' : ' disabled'}>
        <option value="">${familias.length > 1 ? 'Elegir (hay más de una familia)' : '—'}</option>
        ${familias.length > 1 ? familias.map((c) => `<option value="${c.id}">${esc(infoCasa(c) || 'Sin dato adicional')}</option>`).join('') : ''}
      </select></div>`;

  zona.onchange = (e) => {
    if (e.target.id === 'sel-mz') { selMz = e.target.value; selLote = ''; pintarSelector(); }
    else if (e.target.id === 'sel-lote') {
      selLote = e.target.value;
      const fam = ordenadas.filter((c) => c.manzana === selMz && c.lote === selLote);
      if (fam.length === 1) elegirCasa(fam[0]); // un solo grupo en ese lote: queda elegida
      else pintarSelector();
      $('sel-info')?.focus();
    } else if (e.target.id === 'sel-info' && e.target.value) elegirCasa(casasPorId.get(Number(e.target.value)));
  };
  zona.onclick = (e) => {
    const b = e.target.closest('[data-id]');
    if (b) elegirCasa(casasPorId.get(Number(b.dataset.id)));
  };
}

// ---------- acciones (entrada / salida) ----------
function actualizarAcciones() {
  const esVecino = !!actual && actual.vehiculos.length > 0;
  $('acciones').hidden = esVecino; // de un vecino la garita no registra entradas ni salidas
  $('btn-nueva').hidden = !esVecino;
  $('btn-entrada').disabled = false; // la casa, la marca, el color y los detalles son opcionales
}

async function registrar(tipo) {
  if (!actual || actual.vehiculos.length > 0) return; // vecinos: no se registran movimientos
  const esVecino = false;
  const texto = (v) => String(v ?? '').trim() || null;
  const mov = {
    id: nuevoId(),
    patente: actual.patente,
    tipo,
    es_vecino: esVecino,
    casa_destino_id: esVecino ? null : casaElegida?.id ?? null,
    created_at: new Date().toISOString(),
    guardia: nombreGuardia() || null,
    marca: texto(datosVisita.marca),
    color: texto(datosVisita.color),
    detalles: texto(datosVisita.detalles),
    pendiente: 1,
  };
  $('btn-entrada').disabled = $('btn-salida').disabled = true;
  try {
    await db.guardarMovimiento(mov);
    nuevaId = mov.id;
    retenidoId = mov.id;
    setTimeout(async () => {
      if (retenidoId === mov.id) retenidoId = null;
      await cargarCache();
      sincronizar();
    }, PLAZO_DESHACER);
    const casaTxt = casaElegida ? nombreCasaLargo(casaElegida) : [mov.marca, mov.color].filter(Boolean).join(' ');
    const resumen = [formatearPatente(mov.patente), casaTxt].filter(Boolean).join(' · ');
    await cargarCache();
    limpiar();
    avisar(`${tipo === 'entrada' ? 'Entrada' : 'Salida'} registrada · ${hhmm(new Date(mov.created_at))}`, resumen, mov.id);
    // la subida arranca cuando vence el plazo de "Deshacer"; si no hay señal queda en cola
  } catch (err) {
    console.error(err);
    avisarError('No se pudo guardar. Probá de nuevo.');
  } finally {
    $('btn-salida').disabled = false;
    actualizarAcciones();
  }
}

function limpiar() {
  actual = null;
  casaElegida = null; selMz = ''; selLote = '';
  $('resultado').innerHTML = '';
  $('patente').value = '';
  mostrarPantalla('principal');
}

// ---------- lista de hoy ----------
function pintarLista() {
  const inicio = new Date();
  inicio.setHours(0, 0, 0, 0);
  const deHoy = movimientos
    .filter((m) => !m.es_vecino && Date.parse(m.created_at) >= inicio.getTime())
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  $('total-hoy').textContent = `${deHoy.length} en total`;

  if (!deHoy.length) {
    $('lista').innerHTML = '<li class="vacio">Todavía no hay movimientos hoy</li>';
    return;
  }
  $('lista').innerHTML = deHoy
    .slice(0, 20)
    .map((m) => {
      const casa = casasPorId.get(m.casa_destino_id);
      const veh = [m.marca, m.color].filter(Boolean).join(' ');
      const quien = casa ? nombreCasa(casa) : veh || 'Sin casa indicada';
      const entra = m.tipo === 'entrada';
      return `<li class="${m.id === nuevaId ? 'nueva' : ''}">
        ${chapa(m.patente, 's')}
        <div class="fila-datos">
          <span class="fila-quien">${esc(quien)}</span>
          <span class="fila-det"><b>${esc(hora(m.created_at))}</b> · Visita${casa && veh ? ' · ' + esc(veh) : ''}</span>
        </div>
        <div class="fila-dir">
          <span class="dir ${entra ? 'entra' : 'sale'}">${icono(entra ? 'arrow-in' : 'arrow-out', 'i-sm')}${entra ? 'Entró' : 'Salió'}</span>
          ${m.pendiente && m.id !== retenidoId ? `<span class="sin-subir">${icono('clock')}Sin subir</span>` : ''}
        </div>
      </li>`;
    })
    .join('');
}

// ---------- login con PIN ----------
function armarTeclado() {
  const teclas = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'];
  $('teclado').innerHTML = teclas
    .map((k) =>
      k === '' ? '<span class="tecla-vacia"></span>'
      : k === 'del' ? `<button type="button" class="tecla tecla-borrar" data-k="del" aria-label="Borrar último número">${icono('backspace')}</button>`
      : `<button type="button" class="tecla" data-k="${k}">${k}</button>`)
    .join('');
  $('teclado').addEventListener('click', (e) => {
    const b = e.target.closest('[data-k]');
    if (b) tocarTecla(b.dataset.k);
  });
}

// Mismo criterio que scripts/crear-guardias.mjs: minúsculas, sin acentos ni espacios.
const normalizarUsuario = (s) =>
  String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9._-]/g, '');

function tocarTecla(k) {
  $('login-error').textContent = '';
  if (k === 'del') pin = pin.slice(0, -1);
  else if (pin.length < 6) pin += k;
  pintarPin();
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

async function mostrarApp() {
  $('vista-login').hidden = true;
  $('vista-app').hidden = false;
  mostrarPantalla('principal');
  await cargarCache();
  sincronizar(true);
}

async function entrar(e) {
  e.preventDefault();
  const usuario = normalizarUsuario($('l-usuario').value);
  if (!usuario) {
    $('login-error').textContent = 'Ingresá tu usuario.';
    $('l-usuario').focus();
    return;
  }
  if (pin.length < 6) {
    $('login-error').textContent = 'Ingresá los 6 números del PIN.';
    return;
  }
  if (!navigator.onLine) {
    $('login-error').textContent = 'Necesitás señal para ingresar el PIN.';
    return;
  }
  $('login-error').textContent = '';
  const { error } = await sb.auth.signInWithPassword({ email: `${usuario}@${CONFIG.GUARDIAS_DOMINIO}`, password: pin });
  if (error) {
    $('login-error').textContent = error.status === 0 || /fetch/i.test(error.message) ? 'No hay conexión con el servidor.' : 'Usuario o PIN incorrecto.';
    pin = '';
    pintarPin();
    return;
  }
  recordarRol('guardia');
  try { localStorage.setItem('guardia', usuario.charAt(0).toUpperCase() + usuario.slice(1)); } catch {}
  mostrarApp();
}

async function salir() {
  const pend = (await db.pendientes()).length + (await db.consultasPendientes()).length;
  const aviso = pend
    ? `Hay ${pend} registro(s) sin subir y se perderían. ¿Salir igual?`
    : 'Al salir se borran los datos guardados en este celu. ¿Salir?';
  if (!confirm(aviso)) return;
  await db.borrarTodo();
  await sb.auth.signOut();
  casas = []; casasPorId = new Map(); vehiculosPorPatente = new Map(); movimientos = [];
  limpiar();
  mostrarLogin();
}

// Sin señal getSession puede no poder renovar el token: si ya había una sesión guardada, seguimos.
function haySesionGuardada() {
  try {
    return Object.keys(localStorage).some((k) => /^sb-.*-auth-token$/.test(k));
  } catch {
    return false;
  }
}

// Último rol que inició sesión en este celular (para abrir la vista que corresponde sin señal).
const recordarRol = (rol) => {
  try { if (rol) localStorage.setItem('rol', rol); return localStorage.getItem('rol'); } catch { return null; }
};

async function iniciar() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(console.warn);

  armarTeclado();
  pintarPin();
  $('turno').addEventListener('click', () => {
    const nuevo = prompt('¿Cómo te llamás? (aparece en tu turno y en cada registro)', nombreGuardia());
    if (nuevo === null) return;
    try { localStorage.setItem('guardia', nuevo.trim()); } catch {}
    pintarEstado();
  });
  $('form-login').addEventListener('submit', entrar);
  $('l-usuario').addEventListener('input', (e) => { e.target.value = normalizarUsuario(e.target.value); $('login-error').textContent = ''; });
  const modoLogin = (guardia) => {
    $('seg-guardia').setAttribute('aria-pressed', String(guardia));
    $('seg-vecino').setAttribute('aria-pressed', String(!guardia));
    $('form-login').hidden = !guardia;
  };
  $('seg-guardia').addEventListener('click', () => modoLogin(true));
  $('seg-vecino').addEventListener('click', () => { location.href = 'vecino.html'; });
  document.addEventListener('keydown', (e) => {
    if ($('vista-login').hidden || e.metaKey || e.ctrlKey || e.target.id === 'l-usuario') return;
    if (/^\d$/.test(e.key)) tocarTecla(e.key);
    else if (e.key === 'Backspace') tocarTecla('del');
  });

  $('form-buscar').addEventListener('submit', (e) => { e.preventDefault(); buscar(); });
  $('patente').addEventListener('input', (e) => { e.target.value = normalizarPatente(e.target.value); });
  $('btn-volver').addEventListener('click', limpiar);
  $('btn-nueva').addEventListener('click', limpiar);
  $('btn-entrada').addEventListener('click', () => registrar('entrada'));
  $('btn-salida').addEventListener('click', () => registrar('salida'));
  $('btn-salir').addEventListener('click', salir);

  window.addEventListener('online', () => { pintarEstado(); sincronizar(); });
  window.addEventListener('offline', pintarEstado);
  sb.auth.onAuthStateChange((evento) => {
    if (evento === 'SIGNED_OUT' && !$('vista-app').hidden) mostrarLogin('Se cerró la sesión.');
  });

  let sesion = null;
  try {
    ({ data: { session: sesion } } = await sb.auth.getSession());
  } catch { /* sin señal */ }

  // Si hay una sesión guardada y no se pudo renovar por falta/mala señal, se entra igual (no se pide el PIN de nuevo).
  const rolSesion = sesion?.user?.app_metadata?.rol ?? recordarRol();
  if (rolSesion === 'vecino' && (sesion || haySesionGuardada())) { location.replace('vecino.html'); return; }
  if (sesion || haySesionGuardada()) mostrarApp();
  else mostrarLogin();

  setInterval(() => { if (!$('vista-app').hidden) sincronizar(); }, 300000);
  setInterval(() => { if (pendientesN) sincronizar(); }, 20000);
}

iniciar();
