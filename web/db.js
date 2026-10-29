// Capa mínima sobre IndexedDB: cache local de casas, vehículos y movimientos.
const DB_NAME = 'garita';
const DB_VERSION = 2;

let dbPromise = null;

function abrir() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const crear = (nombre, opciones) => (db.objectStoreNames.contains(nombre) ? null : db.createObjectStore(nombre, opciones));
      crear('casas', { keyPath: 'id' });
      crear('vehiculos', { keyPath: 'id' });
      crear('movimientos', { keyPath: 'id' })?.createIndex('pendiente', 'pendiente'); // 1 = todavía no subido
      crear('meta', { keyPath: 'clave' });
      crear('consultas', { keyPath: 'id' }); // consultas de patentes de vecinos, en cola hasta subirse
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

const pedir = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const terminar = (tx) =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

export async function todos(store) {
  const db = await abrir();
  return pedir(db.transaction(store).objectStore(store).getAll());
}

export async function pendientes() {
  const db = await abrir();
  const idx = db.transaction('movimientos').objectStore('movimientos').index('pendiente');
  return pedir(idx.getAll(IDBKeyRange.only(1)));
}

export async function guardarMovimiento(mov) {
  const db = await abrir();
  const tx = db.transaction('movimientos', 'readwrite');
  tx.objectStore('movimientos').put(mov);
  return terminar(tx);
}

export async function marcarSubidos(ids) {
  const db = await abrir();
  const tx = db.transaction('movimientos', 'readwrite');
  const store = tx.objectStore('movimientos');
  for (const id of ids) {
    const r = store.get(id);
    r.onsuccess = () => {
      if (r.result) store.put({ ...r.result, pendiente: 0 });
    };
  }
  return terminar(tx);
}

// Reemplaza todo el contenido de un store (casas / vehículos).
export async function reemplazar(store, filas) {
  const db = await abrir();
  const tx = db.transaction(store, 'readwrite');
  const s = tx.objectStore(store);
  s.clear();
  for (const f of filas) s.put(f);
  return terminar(tx);
}

// Reemplaza los movimientos ya sincronizados por los del servidor,
// sin tocar los que todavía están pendientes de subir.
export async function reemplazarMovimientosSincronizados(filas) {
  const db = await abrir();
  const tx = db.transaction('movimientos', 'readwrite');
  const s = tx.objectStore('movimientos');
  const cur = s.index('pendiente').openCursor(IDBKeyRange.only(0));
  cur.onsuccess = () => {
    const c = cur.result;
    if (c) {
      c.delete();
      c.continue();
    } else {
      for (const f of filas) {
        const r = s.get(f.id);
        r.onsuccess = () => {
          if (!r.result) s.put({ ...f, pendiente: 0 });
        };
      }
    }
  };
  return terminar(tx);
}

// Suma los movimientos nuevos del servidor (sin pisar los pendientes de subir)
// y descarta los ya sincronizados que quedaron fuera de la ventana de días.
export async function fusionarMovimientos(filas, desdeISO) {
  const db = await abrir();
  const limite = Date.parse(desdeISO);
  const tx = db.transaction('movimientos', 'readwrite');
  const s = tx.objectStore('movimientos');
  for (const f of filas) {
    const r = s.get(f.id);
    r.onsuccess = () => {
      if (!r.result || r.result.pendiente === 0) s.put({ ...f, pendiente: 0 });
    };
  }
  const cur = s.openCursor();
  cur.onsuccess = () => {
    const c = cur.result;
    if (!c) return;
    if (c.value.pendiente === 0 && Date.parse(c.value.created_at) < limite) c.delete();
    c.continue();
  };
  return terminar(tx);
}

// Borra un movimiento solo si todavía no se subió (lo usa "Deshacer").
export async function borrarMovimiento(id) {
  const db = await abrir();
  const tx = db.transaction('movimientos', 'readwrite');
  const s = tx.objectStore('movimientos');
  const r = s.get(id);
  r.onsuccess = () => {
    if (r.result && r.result.pendiente === 1) s.delete(id);
  };
  return terminar(tx);
}

export async function leerMeta(clave) {
  const db = await abrir();
  const r = await pedir(db.transaction('meta').objectStore('meta').get(clave));
  return r ? r.valor : null;
}

export async function guardarMeta(clave, valor) {
  const db = await abrir();
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put({ clave, valor });
  return terminar(tx);
}

// ---------- consultas de patentes de vecinos (solo se suben; la garita no las lee) ----------
export async function guardarConsulta(c) {
  const db = await abrir();
  const tx = db.transaction('consultas', 'readwrite');
  tx.objectStore('consultas').put(c);
  return terminar(tx);
}

export async function consultasPendientes() {
  const db = await abrir();
  return pedir(db.transaction('consultas').objectStore('consultas').getAll());
}

export async function borrarConsultas(ids) {
  const db = await abrir();
  const tx = db.transaction('consultas', 'readwrite');
  for (const id of ids) tx.objectStore('consultas').delete(id);
  return terminar(tx);
}

export async function borrarTodo() {
  const db = await abrir();
  const nombres = ['casas', 'vehiculos', 'movimientos', 'meta', 'consultas'];
  const tx = db.transaction(nombres, 'readwrite');
  for (const n of nombres) tx.objectStore(n).clear();
  return terminar(tx);
}
