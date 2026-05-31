const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: 'c:/Users/Abo Elias/medical/clinic-bot/backend/.env' });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function check() {
  const { data, error } = await supabase
    .from('appointments')
    .select('*')
    .limit(1);
    
  if (error) {
    console.error(error);
  } else {
    if (data.length > 0) {
      console.log('Columns:', Object.keys(data[0]));
    } else {
      console.log('Table empty, cannot infer columns easily without RPC. Trying to insert and fail...');
      const { error: e2 } = await supabase.from('appointments').insert({ id: 0 });
      console.log(e2);
    }
  }
}

check();
