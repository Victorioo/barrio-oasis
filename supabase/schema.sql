-- =====================================================================
-- Control de patentes - Garita
-- Pegar completo en Supabase > SQL Editor > New query > Run
-- =====================================================================

-- ---------- TABLAS ----------

create table if not exists public.casas (
  id          bigint generated always as identity primary key,
  manzana          text not null,
  lote             text not null,
  nombre           text,
  telefono         text,
  info_adicional   text not null default '',  -- "A", "Duplex 2", "PH 1"... (en un lote pueden vivir dos familias)
  created_at       timestamptz not null default now(),
  unique (manzana, lote, info_adicional)
);

create table if not exists public.vehiculos_vecinos (
  id        bigint generated always as identity primary key,
  casa_id   bigint not null references public.casas(id) on delete cascade,
  patente   text not null,
  marca     text,
  modelo    text,
  color     text,
  -- patente siempre normalizada: MAYÚSCULAS, sin espacios ni guiones
  constraint patente_normalizada check (patente ~ '^[A-Z0-9]{5,8}$'),
  unique (casa_id, patente)
);

-- id lo genera el celular (uuid) para que subir un movimiento dos veces no lo duplique
create table if not exists public.movimientos (
  id               uuid primary key default gen_random_uuid(),
  patente          text not null,
  tipo             text not null check (tipo in ('entrada', 'salida')),
  es_vecino        boolean not null,
  casa_destino_id  bigint references public.casas(id) on delete set null,
  created_at       timestamptz not null default now(),
  guardia          text,  -- nombre del guardia que lo registró
  -- auto de afuera (todo opcional): lo que ve el guardia y lo que pudo averiguar
  marca            text,
  color            text,
  detalles         text,  -- "¿se frenó en algún lado?", observaciones
  -- lo pone el servidor al insertar; permite bajar solo lo nuevo (created_at lo pone el celu, puede ser viejo)
  subido_at        timestamptz not null default now(),
  constraint mov_patente_normalizada check (patente ~ '^[A-Z0-9]{5,8}$')
);

-- Cada vez que el guardia consulta una patente de un VECINO queda acá (los movimientos de
-- vecinos no los registra ni los ve la garita; esto es solo el rastro de "quién consultó qué").
create table if not exists public.consultas_vecinos (
  id          uuid primary key default gen_random_uuid(),
  patente     text not null,
  casa_id     bigint references public.casas(id) on delete set null,
  guardia     text,
  created_at  timestamptz not null default now(),
  constraint consulta_patente_normalizada check (patente ~ '^[A-Z0-9]{5,8}$')
);

-- ---------- ÍNDICES ----------

create index if not exists idx_vehiculos_patente    on public.vehiculos_vecinos (patente);
create index if not exists idx_movimientos_patente  on public.movimientos (patente, created_at desc);
create index if not exists idx_movimientos_created  on public.movimientos (created_at desc);
create index if not exists idx_movimientos_subido   on public.movimientos (subido_at);
create index if not exists idx_consultas_created    on public.consultas_vecinos (created_at desc);
create index if not exists idx_consultas_patente    on public.consultas_vecinos (patente);

-- ---------- ROLES ----------
-- El rol ('guardia' o 'admin') vive en app_metadata del usuario de Supabase Auth.
-- app_metadata NO lo puede modificar el propio usuario (solo vos desde el panel / SQL).

create or replace function public.rol_actual()
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce(auth.jwt() -> 'app_metadata' ->> 'rol', '')
$$;

-- ---------- ROW LEVEL SECURITY ----------

alter table public.casas              enable row level security;
alter table public.vehiculos_vecinos  enable row level security;
alter table public.movimientos        enable row level security;
alter table public.consultas_vecinos  enable row level security;

-- Sin sesión (anon) no se ve ni se toca nada
revoke all on public.casas, public.vehiculos_vecinos, public.movimientos, public.consultas_vecinos from anon;
revoke all on public.casas, public.vehiculos_vecinos, public.movimientos, public.consultas_vecinos from authenticated;

-- CASAS: la garita ve solo manzana, lote e info adicional (nunca nombre ni teléfono: el vecino
-- los lee con mi_casa()). Las columnas se listan una por una a propósito:
-- si más adelante agregás otra columna a `casas`, la garita NO la ve hasta que la sumes acá.
grant select (id, manzana, lote, info_adicional) on public.casas to authenticated;

create policy casas_leer on public.casas
  for select to authenticated
  using (public.rol_actual() in ('guardia', 'admin'));

create policy casas_admin_escribir on public.casas
  for all to authenticated
  using (public.rol_actual() = 'admin')
  with check (public.rol_actual() = 'admin');
grant insert, update, delete on public.casas to authenticated;

-- VEHÍCULOS: guardia y admin leen; solo admin modifica
grant select on public.vehiculos_vecinos to authenticated;
grant insert, update, delete on public.vehiculos_vecinos to authenticated;

create policy vehiculos_leer on public.vehiculos_vecinos
  for select to authenticated
  using (public.rol_actual() in ('guardia', 'admin'));

create policy vehiculos_admin_escribir on public.vehiculos_vecinos
  for all to authenticated
  using (public.rol_actual() = 'admin')
  with check (public.rol_actual() = 'admin');

-- MOVIMIENTOS
--  · guardia: lee y registra SOLO movimientos de autos que no son de vecinos
--  · admin: ve todo y puede corregir o borrar
grant select, insert, update, delete on public.movimientos to authenticated;

create policy movimientos_leer on public.movimientos
  for select to authenticated
  using (
    public.rol_actual() = 'admin'
    or (public.rol_actual() = 'guardia' and es_vecino = false)
  );

create policy movimientos_insertar on public.movimientos
  for insert to authenticated
  with check (public.rol_actual() in ('guardia', 'admin'));

create policy movimientos_admin_modificar on public.movimientos
  for update to authenticated
  using (public.rol_actual() = 'admin')
  with check (public.rol_actual() = 'admin');

create policy movimientos_admin_borrar on public.movimientos
  for delete to authenticated
  using (public.rol_actual() = 'admin');

-- No se confía en lo que dice el celular: el servidor decide si la patente es de un vecino.
-- Si lo es y quien inserta no es admin, el movimiento se descarta en silencio
-- (así un movimiento viejo en cola no traba la subida de los demás).
create or replace function public.movimientos_antes_de_insertar()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.es_vecino := exists (select 1 from public.vehiculos_vecinos v where v.patente = new.patente);
  if new.es_vecino and public.rol_actual() <> 'admin' then
    return null;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_movimientos_antes_insert on public.movimientos;
create trigger trg_movimientos_antes_insert
  before insert on public.movimientos
  for each row execute function public.movimientos_antes_de_insertar();

-- el trigger no se debe poder llamar a mano desde la API pública
revoke execute on function public.movimientos_antes_de_insertar() from public, anon, authenticated;

-- CONSULTAS DE VECINOS: la garita solo puede AGREGAR (no puede leerlas); el admin ve todo
grant select, insert, update, delete on public.consultas_vecinos to authenticated;

create policy consultas_insertar on public.consultas_vecinos
  for insert to authenticated
  with check (public.rol_actual() in ('guardia', 'admin'));

create policy consultas_admin on public.consultas_vecinos
  for all to authenticated
  using (public.rol_actual() = 'admin')
  with check (public.rol_actual() = 'admin');

-- =====================================================================
-- DESPUÉS de crear los usuarios en Authentication > Users, correr esto
-- (cambiá los mails por los que hayas usado):
--
--   update auth.users
--      set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"rol":"guardia"}'
--    where email = 'guardia@garita.app';
--
--   update auth.users
--      set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"rol":"admin"}'
--    where email = 'tumail@gmail.com';
-- =====================================================================

-- =====================================================================
-- VISTA DE VECINO + AVISO DE ENTRADAS  (migración "vista_vecino_y_avisos", ya aplicada)
-- Cada vecino es un usuario de Auth con app_metadata {"rol":"vecino","casa_id":N}
-- (los crea scripts/crear-vecinos.mjs). Ve solo lo de su casa.
-- =====================================================================
-- create extension if not exists pg_net with schema extensions;
--
-- casa_actual()            -> casa_id del vecino logueado (sale de app_metadata)
-- casas_vecino_leer / vehiculos_vecino_leer  -> el vecino lee solo su casa y sus autos
-- visitas_esperadas        -> visitas que el vecino avisa (RLS: solo su casa; admin todo)
-- push_suscripciones       -> un registro por celular del vecino (RLS: solo las suyas)
-- mis_visitas()/mis_consultas() -> funciones que devuelven SOLO patente, hora, marca y color
--                             (nunca el guardia ni las observaciones del guardia)
-- trigger trg_movimientos_notificar -> al insertar una ENTRADA con casa, llama por pg_net a la
--                             Edge Function notificar-visita con un secreto guardado en Vault
-- notif_config()           -> la lee la función con la service key (secreto + claves VAPID)
--
-- Secretos en Vault (Project Settings > Vault, o vault.create_secret):
--   notif_secreto   texto largo al azar
--   vapid_privada / vapid_publica   par de claves VAPID (la pública también va en web/config.js)
-- Ver la migración completa en el historial de Supabase.

-- Migración "ocultar_nombre_telefono_a_la_garita" (ya aplicada):
--   revoke select on public.casas from authenticated;
--   grant select (id, manzana, lote, info_adicional) on public.casas to authenticated;
--   mi_casa() -> función security definer que devuelve al vecino los datos de SU casa (con nombre y teléfono).

-- Migración "vecino_edita_sus_autos" (ya aplicada):
--   políticas vehiculos_vecino_insertar / _modificar / _borrar: el vecino toca solo los autos de SU casa
--   trigger trg_vehiculos_controlar: una patente no puede estar en dos casas; máximo 6 autos por casa
--   tabla vehiculos_historial + trigger trg_vehiculos_anotar: cada alta, cambio de patente o baja hecha
--   por un vecino queda anotada (solo el admin la lee)

-- Migraciones "privacidad_del_vecino_ante_la_garita", "garita_recibe_nombre_y_telefono_por_vehiculo" y
-- "visitas_nombre_obligatorio_patente_opcional" (ya aplicadas):
--   casas.mostrar_nombre / mostrar_telefono (por defecto NO) y mostrar_vehiculo / mostrar_casa (por defecto SÍ)
--   guardar_privacidad(...)  -> el vecino cambia sus preferencias (la patente nunca se puede ocultar)
--   mi_casa()                -> datos y preferencias de la casa del vecino
--   casas_garita() / vehiculos_garita() -> lo que baja al celular de la garita; lo oculto llega vacío (null)
--   la garita ya no lee vehiculos_vecinos directamente (solo admin y el vecino)
--   trigger trg_consultas_antes_insert -> el servidor pone la casa de cada consulta según la patente
--   visitas_esperadas: nombre obligatorio, patente opcional
--   visitas_esperadas.motivo (opcional, hasta 120 caracteres)
