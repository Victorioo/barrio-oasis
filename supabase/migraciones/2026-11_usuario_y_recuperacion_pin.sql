-- =====================================================================
-- Migración "usuario_y_recuperacion_pin"
-- Agrega: login por usuario (en vez de teléfono) + recuperación de PIN por mail.
-- Pegar completo en Supabase > SQL Editor > New query > Run.
-- El teléfono sigue funcionando como entrada alternativa (no se borra ni se cambia nada de Auth).
-- =====================================================================

alter table public.casas
  add column if not exists usuario           text,
  add column if not exists email_recuperacion text,
  add column if not exists auth_user_id       uuid;

alter table public.casas
  add constraint casas_usuario_formato check (usuario is null or usuario ~ '^[a-z0-9_.]{3,20}$'),
  add constraint casas_email_formato   check (email_recuperacion is null or email_recuperacion ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  add constraint casas_usuario_unico   unique (usuario),
  add constraint casas_auth_user_unico unique (auth_user_id);

-- Códigos de recuperación de PIN (uno por intento; se descartan solos por expira_at, no hace falta cron).
create table if not exists public.recuperaciones_pin (
  id          uuid primary key default gen_random_uuid(),
  casa_id     bigint not null references public.casas(id) on delete cascade,
  codigo_hash text not null,
  intentos    int not null default 0,
  usado       boolean not null default false,
  expira_at   timestamptz not null,
  created_at  timestamptz not null default now()
);
create index if not exists idx_recuperaciones_casa on public.recuperaciones_pin (casa_id, created_at desc);

-- Solo la Edge Function (service role, ignora RLS) la toca; nadie más puede leerla ni escribirla.
alter table public.recuperaciones_pin enable row level security;
revoke all on public.recuperaciones_pin from anon, authenticated;

-- email_de_usuario: resuelve "usuario" -> el mail interno de Auth, para que el que todavía no
-- inició sesión (anon) pueda loguearse escribiendo su usuario en vez de su teléfono.
-- No expone nada más de la casa; si el usuario no existe, devuelve null.
create or replace function public.email_de_usuario(p_usuario text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select right(regexp_replace(c.telefono, '\D', '', 'g'), 10) || '@vecinos.garita.app'
  from public.casas c
  where c.usuario = lower(trim(p_usuario)) and c.telefono is not null
  limit 1
$$;
revoke all on function public.email_de_usuario(text) from public;
grant execute on function public.email_de_usuario(text) to anon, authenticated;

-- mi_usuario: el vecino logueado lee su propio usuario y mail de recuperación (para saber si ya los eligió).
create or replace function public.mi_usuario()
returns table (usuario text, email_recuperacion text)
language sql
stable
security definer
set search_path = ''
as $$
  select c.usuario, c.email_recuperacion
  from public.casas c
  where c.id = (auth.jwt() -> 'app_metadata' ->> 'casa_id')::bigint
$$;
revoke all on function public.mi_usuario() from public, anon;
grant execute on function public.mi_usuario() to authenticated;

-- guardar_usuario: el vecino logueado elige su nombre de usuario. De paso anota su auth_user_id
-- (lo necesita la Edge Function de recuperación para poder cambiarle el PIN).
create or replace function public.guardar_usuario(p_usuario text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_casa_id bigint;
  v_usuario text := lower(trim(p_usuario));
begin
  if public.rol_actual() <> 'vecino' then
    raise exception 'sin_permiso';
  end if;
  if v_usuario !~ '^[a-z0-9_.]{3,20}$' then
    raise exception 'usuario_invalido';
  end if;
  v_casa_id := (auth.jwt() -> 'app_metadata' ->> 'casa_id')::bigint;
  update public.casas set usuario = v_usuario, auth_user_id = auth.uid() where id = v_casa_id;
end;
$$;
revoke all on function public.guardar_usuario(text) from public, anon;
grant execute on function public.guardar_usuario(text) to authenticated;

-- guardar_email_recuperacion: el vecino logueado guarda o cambia el mail para recuperar su PIN.
-- Mandar '' lo borra (vuelve a null).
create or replace function public.guardar_email_recuperacion(p_email text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_casa_id bigint;
  v_email text := lower(trim(p_email));
begin
  if public.rol_actual() <> 'vecino' then
    raise exception 'sin_permiso';
  end if;
  if v_email <> '' and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'email_invalido';
  end if;
  v_casa_id := (auth.jwt() -> 'app_metadata' ->> 'casa_id')::bigint;
  update public.casas set email_recuperacion = case when v_email = '' then null else v_email end where id = v_casa_id;
end;
$$;
revoke all on function public.guardar_email_recuperacion(text) from public, anon;
grant execute on function public.guardar_email_recuperacion(text) to authenticated;

-- =====================================================================
-- Después de correr esto: desplegar la Edge Function "recuperar-pin"
-- (supabase/functions/recuperar-pin) y configurar el secreto RESEND_API_KEY.
-- Ver supabase/functions/recuperar-pin/index.ts y el README.
-- =====================================================================
