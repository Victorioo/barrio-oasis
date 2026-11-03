-- Permite que el vecino avise a la garita que NO reconoce un auto que entró a su casa.
-- Pegar completo en Supabase > SQL Editor > New query > Run.

alter table public.movimientos
  add column if not exists alerta_vecino    boolean not null default false,
  add column if not exists alerta_vecino_en timestamptz;

-- marcar_visita_desconocida: el vecino logueado marca que no reconoce el auto de una
-- ENTRADA a su propia casa. Pisa subido_at para que la garita lo baje en la próxima
-- sincronización (los movimientos solo bajan lo nuevo según esa columna).
create or replace function public.marcar_visita_desconocida(p_movimiento_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if public.rol_actual() <> 'vecino' then
    raise exception 'sin_permiso';
  end if;
  update public.movimientos
     set alerta_vecino = true, alerta_vecino_en = now(), subido_at = now()
   where id = p_movimiento_id
     and casa_destino_id = public.casa_actual()
     and es_vecino = false
     and tipo = 'entrada';
end;
$$;

revoke all on function public.marcar_visita_desconocida(uuid) from public, anon;
grant execute on function public.marcar_visita_desconocida(uuid) to authenticated;

-- mis_visitas() se recrea para devolver también si ya se avisó que no se reconoce el auto.
drop function if exists public.mis_visitas();
create function public.mis_visitas()
returns table(id uuid, patente text, tipo text, created_at timestamptz, marca text, color text, alerta_vecino boolean)
language sql
stable security definer
set search_path to ''
as $$
  select m.id, m.patente, m.tipo, m.created_at, m.marca, m.color, m.alerta_vecino
    from public.movimientos m
   where public.rol_actual() = 'vecino'
     and m.casa_destino_id = public.casa_actual()
     and m.es_vecino = false
     and m.created_at > now() - interval '15 days'
   order by m.created_at desc
$$;

revoke all on function public.mis_visitas() from public, anon;
grant execute on function public.mis_visitas() to authenticated;
