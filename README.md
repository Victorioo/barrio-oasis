# Garita – Control de patentes (MVP)

PWA para el guardia: busca una patente, dice si es del barrio, alerta visitas repetidas y registra entradas/salidas. Funciona sin señal.

```
garita/
├── supabase/schema.sql          ← tablas, índices y RLS
├── web/                         ← la app (esta carpeta es la que se publica)
│   ├── index.html, styles.css, app.js, logic.js, db.js, sw.js, config.js
│   └── manifest.webmanifest, icons/, vendor/supabase.js
└── scripts/
    ├── importar-tally.mjs       ← importador del CSV
    └── ejemplo-tally.csv
```

Sin build, sin `npm install`: son archivos estáticos.

## 1. Configurar Supabase

1. Entrá a [supabase.com](https://supabase.com) → **New project** (plan Free). Guardá la contraseña de la base. Región: São Paulo (la más cercana a Córdoba).
2. **SQL Editor → New query**: pegá todo `supabase/schema.sql` y tocá **Run**.
3. **Authentication → Sign In / Providers** (o *Providers → Email*):
   - Desactivá **Allow new users to sign up**.
   - Desactivá **Confirm email**.
4. **Authentication → Users → Add user → Create new user** (tildá *Auto Confirm User*):
   - Guardias: cada uno entra con **usuario + PIN de 6 dígitos** (ej. `colazo` / PIN). Se crean o se les cambia el PIN con `node scripts/crear-guardias.mjs colazo:NNNNNN otro:NNNNNN` (con `SUPABASE_URL` y `SUPABASE_SERVICE_KEY`); `--borrar=usuario` da de baja. Internamente el mail es `usuario@guardias.garita.app`.
   - Admin: tu mail real y una contraseña larga.
5. De vuelta en **SQL Editor**, asigná los roles (cambiá los mails si usaste otros):

   ```sql
   update auth.users set raw_app_meta_data = coalesce(raw_app_meta_data,'{}'::jsonb) || '{"rol":"guardia"}' where email = 'guardia@garita.app';
   update auth.users set raw_app_meta_data = coalesce(raw_app_meta_data,'{}'::jsonb) || '{"rol":"admin"}'   where email = 'tumail@gmail.com';
   ```
6. **Project Settings → API**: copiá la **Project URL** y la **anon public key** (para el paso 3) y la **service_role key** (solo para el paso 2, no la compartas ni la subas a ningún lado).

## 2. Cargar los datos de Tally

1. En Tally: **Submissions → Export → CSV**. Las columnas esperadas: `Nombre completo`, `Número de teléfono`, `Número de manzana`, `Número de lote`, `Dato adicional (Opcional)`, `Patente 1` … `Patente 5`; opcionales `Modelo de auto 1/Color 1` (también acepta `Marca 1/Modelo 1/Color 1`).
2. Desde la carpeta `garita/` (necesitás Node 18+), primero un ensayo que no escribe nada:

   ```bash
   node scripts/importar-tally.mjs ~/Downloads/respuestas.csv --dry-run
   ```
   Revisá los avisos (patentes inválidas, casas repetidas, patente en dos casas).
3. Importación real:

   ```bash
   SUPABASE_URL="https://xxxx.supabase.co" SUPABASE_SERVICE_KEY="eyJ..." node scripts/importar-tally.mjs ~/Downloads/respuestas.csv
   ```
   Se crea una casa por familia: manzana + lote + "Dato adicional" (así, en un dúplex, las dos familias del mismo lote quedan separadas). Se puede repetir con CSV nuevos: no duplica casas ni patentes, y si la misma familia respondió dos veces, se combinan sus patentes.

Después podés corregir cualquier cosa a mano en **Table Editor**.

## 3. Publicar la app

1. Editá `web/config.js` con tu `SUPABASE_URL` y `SUPABASE_ANON_KEY` (la **anon**, nunca la service).
2. **Netlify** (lo más fácil): [app.netlify.com/drop](https://app.netlify.com/drop) → arrastrá la carpeta **`web`**. Te da una URL `https://algo.netlify.app` (podés cambiarle el nombre en *Site settings*).
   Alternativa: Vercel → importar el repo con *Root Directory* = `web`, sin build.
3. En el celular del guardia (Chrome en Android / Safari en iPhone) abrí la URL con señal, ingresá el PIN y esperá a que diga **"En línea"** (es cuando bajó los datos). Luego:
   - Android: menú ⋮ → **Instalar aplicación**.
   - iPhone: Compartir → **Agregar a pantalla de inicio**.
4. **Probalo sin señal**: modo avión, abrí la app, buscá una patente y registrá una entrada. Debe mostrar "Sin conexión · 1 por subir"; al desactivar el modo avión se sube sola.

Para actualizar la app: reemplazá los archivos, subí el número de `CACHE` en `web/sw.js` (`garita-v2`…) y publicá. El celular toma la versión nueva al abrirla dos veces.

## Cómo funciona (y decisiones que tomé)

- **Sin señal**: el celular guarda en IndexedDB casas, vehículos y movimientos de 15 días. Casas y vehículos se bajan completos al abrir la app y como mucho una vez por hora; los movimientos, solo los nuevos (por eso el celu consulta cada 5 min gastando casi nada de datos). También se refresca al volver la conexión. Los movimientos nuevos se guardan primero en el celu con un `id` único y se suben solos; si se corta justo al subir, no se duplican.
- **Colores**: verde = vecino; rojo = no registrada; amarillo = no vecino con 2+ entradas en 15 días, con el historial de visitas anteriores. En ambos casos el guardia puede (todo opcional) cargar marca, color, "¿se frenó en algún lado?" con más detalles, y a qué casa va; nada de eso bloquea el registro de la entrada o la salida.
- **Datos oficiales del vehículo**: en un auto no registrado, el botón "Consultar datos del vehículo" trae marca, tipo, modelo y estado desde el Portal Tributario de la Municipalidad de Córdoba. El portal no se puede llamar directo desde el celular (no admite CORS), así que la consulta pasa por la función `consultar-vehiculo` (`supabase/functions/consultar-vehiculo/`), que solo atiende a usuarios con rol guardia o admin y devuelve únicamente los datos del vehículo: las deudas y el nombre del titular se descartan en el servidor. Requiere conexión. Para volver a desplegarla: `supabase functions deploy consultar-vehiculo` (o desde el panel, en Edge Functions). Ojo: el portal es una API pública sin documentación ni garantías; si la Municipalidad la cambia o la restringe, el botón avisará "No se pudo consultar" y el resto de la app sigue funcionando.
- **Autos de vecinos (privacidad)**: la garita no registra entradas ni salidas de vecinos y no ve sus movimientos. Al consultar una patente de vecino solo queda guardado que el guardia la consultó (tabla `consultas_vecinos`, que la garita puede agregar pero no leer; la ves vos desde el panel). Esto se aplica también en la base: aunque alguien modifique la app, el servidor descarta los movimientos de vecinos y no se los devuelve al guardia.
- **Qué ve la garita de un vecino**: nombre, teléfono (tocable para llamar), vehículo y color, manzana, lote e información adicional. En la base, el permiso de lectura de la tabla `casas` se da columna por columna (`grant select (id, manzana, lote, nombre, telefono, info_adicional)`), así que si agregás otra columna a esa tabla, la garita no la ve hasta que la sumes ahí. Ojo: para funcionar sin señal, el celular del guardia guarda esos nombres y teléfonos; al tocar "Cerrar turno" se borran.
- **Permisos**: guardia = leer casas y vehículos + leer y registrar movimientos de autos de afuera + agregar consultas de vecinos. Admin = además modificar casas, vehículos y movimientos. (El guardia no puede editar vecinos: es más seguro que lo que pedía el enunciado de “leer y escribir”, y el MVP no lo necesita.)
- **Seguridad del PIN**: es la contraseña de un usuario real de Supabase Auth; Supabase limita los intentos por IP, pero un PIN corto es débil. Usá 6 dígitos que no sean obvios y cambialo si el guardia cambia (Authentication → Users). Si pierden el celular, cambiá el PIN y listo.
- **Cerrar sesión** borra los datos del celu (avisa si hay movimientos sin subir). Si se vence la sesión pide el PIN de nuevo sin borrar nada.
- **Límites del plan Free**: 500 MB de base (sobra: son texto); el proyecto se pausa tras 7 días sin actividad, cosa que no pasa con uso diario.

## Para más adelante (no incluido)

Cuentas de vecinos, visitas autorizadas, panel de sospechosos y fotos de patentes. La base ya quedó lista: `movimientos.casa_destino_id` y `es_vecino` alcanzan para armar los reportes.


## Vista de vecino y aviso de entradas

- **Ingreso del vecino:** `vecino.html` (desde "Soy vecino" en el login). Usuario = teléfono, contraseña = PIN de 6 números.
  Las cuentas las crea la administración con `scripts/crear-vecinos.mjs` (una por casa, usa el teléfono del censo) y el script
  deja un archivo local con los PINs para entregárselos. Los últimos 10 dígitos del teléfono son el usuario.
- **Qué ve el vecino:** su casa y autos, las visitas que llegaron a su casa (patente, hora, marca y color; nunca el guardia ni
  las observaciones), quién consultó sus patentes (sin nombre de guardia ni turno) y las visitas que avisó.
- **Aviso:** cuando el guardia registra una ENTRADA y eligió la casa, un trigger de la base llama a la Edge Function
  `notificar-visita`, que manda una notificación push a los celulares de ese vecino. Si el guardia no elige casa, no se avisa a nadie.
- **iPhone:** las notificaciones solo funcionan si el vecino instala la app ("Compartir > Agregar a inicio") y la abre desde el ícono.
- **Pendiente:** la garita todavía no muestra las visitas que el vecino avisó (tabla `visitas_esperadas`).
- Demo sin conexión: `demo-vecino.html` (datos inventados; no se publica).
- **Autos del vecino:** el vecino agrega, edita (patente, marca, modelo, color) y borra sus autos. La base impide que una patente
  esté en dos casas y limita a 6 autos por casa; cada alta, cambio de patente o baja queda en `vehiculos_historial` (solo admin).
  La garita ve el cambio la próxima vez que sincroniza (al abrir la app o una vez por hora).
- **Qué ve la garita (lo decide cada vecino):** en "Mi casa" el vecino activa o apaga nombre, teléfono, vehículo y casa. La patente
  siempre se ve. Por defecto la garita ve vehículo y casa, y NO ve nombre ni teléfono. Lo que el vecino oculta no llega al celular
  de la garita (no se descarga), y el cambio se aplica en la próxima sincronización (menos de una hora).
- **Visitas avisadas:** nombre y apellido obligatorios, patente opcional.
