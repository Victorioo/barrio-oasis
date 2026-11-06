-- =====================================================================
-- Migración "visitas_varios_dias" (ya aplicada en barrio-oasis)
-- Una visita se avisa para un RANGO de días (desde/hasta) además de un solo día,
-- y la base ya no deja avisar la misma visita (mismo nombre, misma casa) dos veces
-- si sus fechas se superponen con un aviso que ya existe.
-- Pegar completo en Supabase > SQL Editor > New query > Run.
-- =====================================================================

alter table public.visitas_esperadas
  add column if not exists desde date,
  add column if not exists hasta date;

update public.visitas_esperadas set desde = dia, hasta = dia where desde is null;

alter table public.visitas_esperadas
  alter column desde set not null,
  alter column hasta set not null,
  add constraint visitas_hasta_no_antes_de_desde check (hasta >= desde);

-- El front ya no manda "dia" al avisar una visita; si sigue siendo NOT NULL, todo insert
-- nuevo fallaría. La dejamos opcional en vez de borrarla (ver más abajo por qué no se borra).
alter table public.visitas_esperadas alter column dia drop not null;

-- La columna "dia" queda sin usar (reemplazada por desde/hasta) pero no se borra:
-- en barrio-oasis había un aviso duplicado viejo (casa 44, mismo nombre, mismo día,
-- avisado dos veces) y no se quiso borrar ese dato, así que en vez de una restricción
-- EXCLUDE (que exige que TODO el historial ya cumpla la regla al crearla, y ese
-- duplicado la rompía) se usa un trigger: valida solo los avisos nuevos hacia
-- adelante, sin tocar lo que ya existía.
--   Si en algún momento se borra el duplicado viejo, se puede reemplazar este
--   trigger por una restricción EXCLUDE (ver versión anterior de este archivo en el
--   historial de git) y recién ahí borrar la columna "dia".
create or replace function public.visitas_evitar_repetida()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1 from public.visitas_esperadas v
    where v.id <> new.id
      and v.casa_id = new.casa_id
      and lower(v.nombre) = lower(new.nombre)
      and daterange(v.desde, v.hasta, '[]') && daterange(new.desde, new.hasta, '[]')
  ) then
    raise exception 'visita_repetida' using errcode = '23P01';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_visitas_evitar_repetida on public.visitas_esperadas;
create trigger trg_visitas_evitar_repetida
  before insert or update on public.visitas_esperadas
  for each row execute function public.visitas_evitar_repetida();

-- el trigger no se debe poder llamar a mano desde la API pública
revoke execute on function public.visitas_evitar_repetida() from public, anon, authenticated;
