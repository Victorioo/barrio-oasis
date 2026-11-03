-- =====================================================================
-- Migración "alertas_seguridad"
-- La garita (guardia o admin) puede mandar un aviso de seguridad, en 3 niveles, que llega por
-- notificación push a TODOS los vecinos que tengan la app y los avisos activados (no solo a una casa).
-- Pegar completo en Supabase > SQL Editor > New query > Run.
-- Requiere las mismas claves VAPID y el mismo secreto en Vault que ya usa "notificar-visita".
-- =====================================================================

create table if not exists public.alertas_seguridad (
  id          uuid primary key default gen_random_uuid(),
  nivel       text not null check (nivel in ('info', 'precaucion', 'emergencia')),
  mensaje     text not null check (char_length(btrim(mensaje)) between 1 and 140),
  creado_por  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists idx_alertas_created on public.alertas_seguridad (created_at desc);

alter table public.alertas_seguridad enable row level security;
revoke all on public.alertas_seguridad from anon, authenticated;

-- Solo admin puede leer el historial (trazabilidad). Guardia y vecino no leen esta tabla directo:
-- al guardia le alcanza con haber mandado el aviso, al vecino le llega por push.
grant select on public.alertas_seguridad to authenticated;
create policy alertas_admin_leer on public.alertas_seguridad
  for select to authenticated
  using (public.rol_actual() = 'admin');

-- dar_aviso: la garita (guardia o admin) manda un aviso. Queda la fila; un trigger dispara el push.
create or replace function public.dar_aviso(p_nivel text, p_mensaje text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mensaje text := btrim(p_mensaje);
begin
  if public.rol_actual() not in ('guardia', 'admin') then
    raise exception 'sin_permiso';
  end if;
  if p_nivel not in ('info', 'precaucion', 'emergencia') then
    raise exception 'nivel_invalido';
  end if;
  if char_length(v_mensaje) < 1 or char_length(v_mensaje) > 140 then
    raise exception 'mensaje_invalido';
  end if;
  insert into public.alertas_seguridad (nivel, mensaje, creado_por) values (p_nivel, v_mensaje, auth.uid());
end;
$$;
revoke all on function public.dar_aviso(text, text) from public, anon;
grant execute on function public.dar_aviso(text, text) to authenticated;

-- Al insertar un aviso, se llama por pg_net a la Edge Function "notificar-alerta" (mismo patrón que
-- notificar_entrada): un aviso que falla en mandarse nunca debe impedir que haya quedado guardado.
create or replace function public.notificar_alerta()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  secreto text;
begin
  select decrypted_secret into secreto from vault.decrypted_secrets where name = 'notif_secreto';
  if secreto is null then return null; end if;
  perform net.http_post(
    url := 'https://bbbqibmjkafmczqbfjhc.supabase.co/functions/v1/notificar-alerta',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-notif-secret', secreto),
    body := jsonb_build_object('alerta_id', new.id)
  );
  return null;
exception when others then
  return null;
end;
$$;

drop trigger if exists trg_alertas_notificar on public.alertas_seguridad;
create trigger trg_alertas_notificar
  after insert on public.alertas_seguridad
  for each row execute function public.notificar_alerta();

-- =====================================================================
-- Después de correr esto: desplegar la Edge Function "notificar-alerta"
-- (supabase/functions/notificar-alerta). No necesita secretos nuevos: usa
-- el mismo notif_secreto y las mismas claves VAPID que "notificar-visita".
-- =====================================================================
