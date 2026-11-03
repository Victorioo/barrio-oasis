-- =====================================================================
-- Migración "alias_del_vecino"
-- El vecino puede elegir un alias (ej: "Javo") para que, cuando decide mostrarle
-- su nombre a la garita, el guardia vea el alias en vez del nombre completo.
-- Si no pone alias, todo sigue igual que antes (la garita ve el nombre completo).
-- Pegar completo en Supabase > SQL Editor > New query > Run.
-- =====================================================================

alter table public.casas
  add column if not exists alias text;

alter table public.casas
  add constraint casas_alias_formato check (alias is null or char_length(alias) between 1 and 24);

-- guardar_alias: el vecino logueado pone o borra su alias. Mandar '' lo borra (vuelve a null).
create or replace function public.guardar_alias(p_alias text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_casa_id bigint;
  v_alias text := trim(p_alias);
begin
  if public.rol_actual() <> 'vecino' then
    raise exception 'sin_permiso';
  end if;
  if v_alias <> '' and char_length(v_alias) > 24 then
    raise exception 'alias_muy_largo';
  end if;
  v_casa_id := (auth.jwt() -> 'app_metadata' ->> 'casa_id')::bigint;
  update public.casas set alias = case when v_alias = '' then null else v_alias end where id = v_casa_id;
end;
$$;
revoke all on function public.guardar_alias(text) from public, anon;
grant execute on function public.guardar_alias(text) to authenticated;

-- mi_casa cambia de forma (se agrega "alias"): hay que borrarla y recrearla.
drop function if exists public.mi_casa();
create function public.mi_casa()
returns table(id bigint, manzana text, lote text, info_adicional text, nombre text, telefono text, alias text,
              mostrar_nombre boolean, mostrar_telefono boolean, mostrar_vehiculo boolean, mostrar_casa boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c.manzana, c.lote, c.info_adicional, c.nombre, c.telefono, c.alias,
         c.mostrar_nombre, c.mostrar_telefono, c.mostrar_vehiculo, c.mostrar_casa
    from public.casas c
   where public.rol_actual() = 'vecino' and c.id = public.casa_actual()
$$;
revoke all on function public.mi_casa() from public, anon;
grant execute on function public.mi_casa() to authenticated;

-- vehiculos_garita: misma forma de siempre, pero ahora la garita ve el alias (si existe) en vez del nombre.
create or replace function public.vehiculos_garita()
returns table(id bigint, casa_id bigint, patente text, marca text, modelo text, color text, nombre text, telefono text)
language sql
stable
security definer
set search_path = ''
as $$
  select v.id,
         case when c.mostrar_casa then v.casa_id end,
         v.patente,
         case when c.mostrar_vehiculo then v.marca  end,
         case when c.mostrar_vehiculo then v.modelo end,
         case when c.mostrar_vehiculo then v.color  end,
         case when c.mostrar_nombre   then coalesce(c.alias, c.nombre) end,
         case when c.mostrar_telefono then c.telefono end
    from public.vehiculos_vecinos v
    join public.casas c on c.id = v.casa_id
   where public.rol_actual() in ('guardia', 'admin')
$$;
