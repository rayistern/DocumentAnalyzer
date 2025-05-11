import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import settings from '../config/settings.mjs';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

export default supabase; 