import { createClient } from '@supabase/supabase-js';
import settings from '../config/settings.mjs';

export default createClient(settings.supabase.url, settings.supabase.key, {
  auth: { persistSession: false },
}); 