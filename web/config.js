// Completá estos dos datos con los de tu proyecto (Supabase > Project Settings > API).
// La "anon key" es pública por diseño: la seguridad la dan las políticas RLS.
// NUNCA pongas acá la "service_role key".
export const CONFIG = {
  SUPABASE_URL: 'https://bbbqibmjkafmczqbfjhc.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJiYnFpYm1qa2FmbWN6cWJmamhjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMyMzE2OTUsImV4cCI6MjEwODgwNzY5NX0.wZq_9WQjuoJ3hW7ZhVEYHFMuHvdEu1a0_dMWdiWE0B8',
  // Mail del usuario "guardia" creado en Supabase Auth. El guardia solo tipea el PIN (su contraseña).
  GUARDIAS_DOMINIO: 'guardias.garita.app', // usuario "colazo" → colazo@guardias.garita.app
  // Clave pública para las notificaciones push (la privada vive en Supabase Vault, nunca acá).
  VAPID_PUBLICA: 'BEAPO8ZkwDycBS8wnTzLs776MMK1QiKX-D735IdnBwH7110UBTLDiciGCu9ZHdwym4R7N-dQC8yrgydknOeKFXc',
  DIAS_HISTORIAL: 15,
  ALERTA_MIN_ENTRADAS: 2,
};
