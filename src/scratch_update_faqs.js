const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: 'c:/Users/Abo Elias/medical/clinic-bot/backend/.env' });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function runUpdates() {
  console.log('Running FAQ keywords updates...');
  
  // First update
  const { error: e1 } = await supabase.rpc('execute_sql', { 
    sql: "UPDATE faqs SET keywords = array['دوام','ساعات','تفتح','تسكر','وقت','يمته','متى'] WHERE question LIKE '%دوام%';" 
  });
  // Since we might not have execute_sql rpc, we'll fetch and update in JS
  
  const { data: faqs, error } = await supabase.from('faqs').select('id, question, keywords');
  if (error) {
    console.error('Failed to fetch faqs:', error);
    return;
  }
  
  for (const faq of faqs) {
    const q = faq.question || '';
    let newKeywords = faq.keywords || [];
    let updated = false;
    
    if (q.includes('دوام')) {
      newKeywords = ['دوام','ساعات','تفتح','تسكر','وقت','يمته','متى'];
      updated = true;
    }
    else if (q.includes('عيادة') || q.includes('وين')) {
      newKeywords = ['وين','فين','موقع','عنوان','مكان','كيف اوصل','خارطة'];
      updated = true;
    }
    else if (q.includes('سعر') || q.includes('كم')) {
      newKeywords = ['سعر','كلفة','كم','فلوس','دينار','اجور','اسعار','كشف'];
      updated = true;
    }
    
    if (updated) {
      await supabase.from('faqs').update({ keywords: newKeywords }).eq('id', faq.id);
      console.log(`Updated FAQ ID ${faq.id}`);
    }
  }
  
  console.log('FAQ updates completed.');
}

runUpdates();
