// Completá estos dos datos con los de tu proyecto (Supabase > Project Settings > API).
// La "anon key" es pública por diseño: la seguridad la dan las políticas RLS.
// NUNCA pongas acá la "service_role key".
export const CONFIG = {
  SUPABASE_URL: 'https://TU-PROYECTO.supabase.co',
  SUPABASE_ANON_KEY: 'TU-ANON-KEY',
  // Mail del usuario "guardia" creado en Supabase Auth. El guardia solo tipea el PIN (su contraseña).
  GUARDIA_EMAIL: 'guardia@garita.app',
  DIAS_HISTORIAL: 15,
  ALERTA_MIN_ENTRADAS: 2,
};
