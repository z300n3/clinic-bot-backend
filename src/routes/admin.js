'use strict';

const express = require('express');
const router  = express.Router();
const { supabase } = require('../services/supabase');

// ── Credentials (hardcoded) ───────────────────────────────────────────────────

const ADMIN_EMAIL    = 'elias@elias.com';
const ADMIN_PASSWORD = 'elias@elias';

// ── Session middleware ────────────────────────────────────────────────────────

function requireAdmin(req, res, next) {
  if (req.cookies.admin_session === 'true') return next();
  res.redirect('/admin/login');
}

// ── GET /admin/login ──────────────────────────────────────────────────────────

router.get('/login', (_req, res) => {
  res.send(loginHTML(_req.query.error === '1'));
});

// ── POST /admin/login ─────────────────────────────────────────────────────────

router.post('/login', express.urlencoded({ extended: false }), (req, res) => {
  const { email, password } = req.body;
  if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
    res.cookie('admin_session', 'true', {
      httpOnly: true,
      maxAge:   7 * 24 * 60 * 60 * 1000, // 7 days
    });
    return res.redirect('/admin');
  }
  res.redirect('/admin/login?error=1');
});

// ── GET /admin/logout ─────────────────────────────────────────────────────────

router.get('/logout', (_req, res) => {
  res.clearCookie('admin_session');
  res.redirect('/admin/login');
});

// ── GET /admin ────────────────────────────────────────────────────────────────

router.get('/', requireAdmin, async (_req, res) => {
  try {
    const { data: clinics, error } = await supabase
      .from('clinics')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Fetch auth user emails via admin API (service-role key required)
    let emailMap = {};
    try {
      const { data: { users } } = await supabase.auth.admin.listUsers({ perPage: 1000 });
      if (users) users.forEach(u => { emailMap[u.id] = u.email; });
    } catch (_) { /* silently skip if admin API unavailable */ }

    res.send(mainHTML(clinics || [], emailMap));
  } catch (err) {
    res.status(500).send(`<h1 style="font-family:sans-serif;padding:40px">خطأ: ${escHtml(err.message)}</h1>`);
  }
});

// ── PATCH /admin/clinics/:id/activate ────────────────────────────────────────

router.patch('/clinics/:id/activate', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { phone_number_id, access_token } = req.body;

  if (!phone_number_id || !access_token) {
    return res.status(400).json({ success: false, error: 'phone_number_id and access_token are required' });
  }

  const { error } = await supabase
    .from('clinics')
    .update({
      whatsapp_phone_number_id: phone_number_id,
      meta_access_token:        access_token,
      whatsapp_setup_status:    'completed',
    })
    .eq('id', id);

  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('ar-IQ', {
      year: 'numeric', month: 'short', day: 'numeric',
    });
  } catch { return iso; }
}

// ── Login HTML ────────────────────────────────────────────────────────────────

function loginHTML(showError) {
  return /* html */`<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>لوحة تحكم المدير — دخول</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#F8FAFC;font-family:'Segoe UI',Tahoma,Arial,sans-serif;direction:rtl;
         min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px}
    .card{background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.09);
          padding:40px 36px;width:100%;max-width:400px}
    .logo{text-align:center;margin-bottom:28px}
    .logo-icon{font-size:52px;display:block;margin-bottom:12px}
    h1{font-size:22px;font-weight:700;color:#1E293B;margin-bottom:4px}
    .sub{color:#64748B;font-size:14px}
    .alert{background:#FEF2F2;border:1px solid #FECACA;color:#DC2626;
           padding:12px 16px;border-radius:8px;font-size:14px;
           margin-bottom:20px;text-align:center}
    .group{margin-bottom:16px}
    label{display:block;font-size:14px;font-weight:500;color:#374151;margin-bottom:6px}
    input{width:100%;padding:12px 14px;border:1px solid #D1D5DB;border-radius:10px;
          font-size:14px;font-family:inherit;outline:none;
          transition:border-color .2s,box-shadow .2s}
    input:focus{border-color:#2563EB;box-shadow:0 0 0 3px rgba(37,99,235,.12)}
    .btn{width:100%;background:#2563EB;color:#fff;border:none;padding:14px;
         border-radius:10px;font-size:15px;font-weight:600;cursor:pointer;
         font-family:inherit;margin-top:6px;transition:background .2s}
    .btn:hover{background:#1D4ED8}
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <span class="logo-icon">🏥</span>
      <h1>لوحة تحكم المدير</h1>
      <p class="sub">تسجيل الدخول للمتابعة</p>
    </div>

    ${showError ? `<div class="alert">البريد أو كلمة المرور غير صحيحة</div>` : ''}

    <form method="POST" action="/admin/login">
      <div class="group">
        <label for="em">البريد الإلكتروني</label>
        <input id="em" type="email" name="email" placeholder="البريد الإلكتروني" required autofocus>
      </div>
      <div class="group">
        <label for="pw">كلمة المرور</label>
        <input id="pw" type="password" name="password" placeholder="كلمة المرور" required>
      </div>
      <button type="submit" class="btn">دخول</button>
    </form>
  </div>
</body>
</html>`;
}

// ── Clinic card HTML ──────────────────────────────────────────────────────────

function clinicCard(c, emailMap) {
  const email     = (c.auth_user_id && emailMap[c.auth_user_id]) || '—';
  const status    = c.whatsapp_setup_status || 'pending';
  const isPending = status !== 'completed';

  const badgeStyle = isPending
    ? 'background:#FEF9C3;color:#854D0E'
    : 'background:#F0FDF4;color:#16A34A';
  const badgeText = isPending ? '⏳ في الانتظار' : '✅ مفعّل';

  const nameEsc  = escHtml(c.name || '').replace(/'/g, '&#39;');
  const phoneEsc = escHtml(c.phone_number || '').replace(/'/g, '&#39;');

  const btnStyle = isPending
    ? 'background:#2563EB;color:#fff;cursor:pointer'
    : 'background:#94A3B8;color:#fff;cursor:not-allowed';
  const btnOnClick = isPending
    ? `onclick="openModal('${c.id}','${nameEsc}','${phoneEsc}')"`
    : 'disabled';

  return `
<div class="card">
  <div class="card-top">
    <div style="min-width:0">
      <div class="clinic-name">${escHtml(c.name || '—')}</div>
      <div class="doctor-name">${escHtml(c.doctor_name || '—')}</div>
    </div>
    <span class="specialty-pill">${escHtml(c.specialty || '—')}</span>
  </div>
  <div class="info-rows">
    <div class="row"><span class="icon">📧</span><span>${escHtml(email)}</span></div>
    <div class="row"><span class="icon">📱</span><span dir="ltr">${escHtml(c.phone_number || '—')}</span></div>
    <div class="row"><span class="icon">📅</span><span>${fmtDate(c.created_at)}</span></div>
    <div class="row"><span class="icon">💰</span><span>${
      c.consultation_price
        ? Number(c.consultation_price).toLocaleString('ar-IQ') + ' دينار'
        : '—'
    }</span></div>
    <div class="row"><span class="icon">📍</span><span>${escHtml(c.address || '—')}</span></div>
  </div>
  <div class="card-foot">
    <span class="status-badge" id="badge-${c.id}" style="${badgeStyle}">${badgeText}</span>
    <button class="action-btn" id="btn-${c.id}" style="${btnStyle}" ${btnOnClick}>
      ${isPending ? 'تفعيل واتساب 🔗' : 'تم التفعيل ✓'}
    </button>
  </div>
</div>`;
}

// ── Main page HTML ────────────────────────────────────────────────────────────

function mainHTML(clinics, emailMap) {
  const total   = clinics.length;
  const pending = clinics.filter(c => (c.whatsapp_setup_status || 'pending') !== 'completed').length;
  const active  = total - pending;

  const gridContent = clinics.length === 0
    ? `<div class="empty">لا توجد عيادات مسجلة بعد 🏥</div>`
    : clinics.map(c => clinicCard(c, emailMap)).join('\n');

  return /* html */`<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>لوحة تحكم المدير</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#F1F5F9;font-family:'Segoe UI',Tahoma,Arial,sans-serif;direction:rtl;min-height:100vh}

    /* ── Header ── */
    .header{background:#1E293B;color:#fff;padding:0 24px;min-height:60px;
            display:flex;align-items:center;justify-content:space-between;
            flex-wrap:wrap;gap:10px}
    .brand{font-size:18px;font-weight:700;display:flex;align-items:center;gap:8px}
    .logout{color:#CBD5E1;border:1px solid #475569;background:transparent;
            padding:8px 16px;border-radius:8px;font-size:13px;cursor:pointer;
            font-family:inherit;text-decoration:none;transition:all .2s}
    .logout:hover{background:#334155;color:#fff}

    /* ── Stats ── */
    .stats{background:#fff;border-bottom:1px solid #E2E8F0;padding:14px 24px;
           display:flex;align-items:center;gap:24px;flex-wrap:wrap}
    .stat{display:flex;align-items:center;gap:8px;font-size:14px;color:#475569}
    .stat strong{font-size:22px;font-weight:700;color:#1E293B}
    .pill-y{background:#FEF9C3;color:#854D0E;padding:3px 10px;border-radius:20px;font-size:13px;font-weight:600}
    .pill-g{background:#F0FDF4;color:#16A34A;padding:3px 10px;border-radius:20px;font-size:13px;font-weight:600}

    /* ── Grid ── */
    .content{padding:24px;max-width:1400px;margin:0 auto}
    .grid{display:grid;gap:20px;grid-template-columns:repeat(3,1fr)}
    @media(max-width:1200px){.grid{grid-template-columns:repeat(2,1fr)}}
    @media(max-width:640px) {.grid{grid-template-columns:1fr}}
    .empty{text-align:center;padding:80px 20px;color:#94A3B8;font-size:16px;
           grid-column:1/-1}

    /* ── Card ── */
    .card{background:#fff;border-radius:14px;border:1px solid #E2E8F0;
          box-shadow:0 1px 4px rgba(0,0,0,.05);display:flex;flex-direction:column}
    .card-top{display:flex;align-items:flex-start;justify-content:space-between;
              padding:18px 18px 12px;gap:12px}
    .clinic-name{font-size:17px;font-weight:700;color:#1E293B;margin-bottom:3px;
                 overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .doctor-name{font-size:13px;color:#64748B}
    .specialty-pill{background:#EFF6FF;color:#1D4ED8;padding:4px 10px;
                    border-radius:20px;font-size:12px;font-weight:600;
                    white-space:nowrap;flex-shrink:0}
    .info-rows{padding:0 18px 14px;flex:1;display:flex;flex-direction:column;gap:7px}
    .row{display:flex;align-items:flex-start;gap:8px;font-size:13px;
         color:#374151;line-height:1.5}
    .icon{flex-shrink:0;width:20px;text-align:center}
    .card-foot{padding:12px 18px;border-top:1px solid #F1F5F9;
               display:flex;align-items:center;justify-content:space-between;
               gap:10px;flex-wrap:wrap}
    .status-badge{padding:5px 12px;border-radius:20px;font-size:13px;font-weight:600}
    .action-btn{padding:9px 14px;border-radius:8px;border:none;font-size:13px;
                font-weight:600;font-family:inherit;transition:opacity .2s}
    .action-btn:not([disabled]):hover{opacity:.85}

    /* ── Modal overlay ── */
    #modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);
                   z-index:200;align-items:center;justify-content:center;padding:16px}
    .modal{background:#fff;border-radius:16px;width:100%;max-width:480px;
           box-shadow:0 20px 60px rgba(0,0,0,.2);overflow:hidden;
           max-height:calc(100vh - 32px);overflow-y:auto}
    .modal-hd{background:#1E293B;color:#fff;padding:18px 20px;
              display:flex;align-items:center;justify-content:space-between;
              position:sticky;top:0;z-index:1}
    .modal-hd h2{font-size:15px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .close-btn{background:transparent;border:none;color:#94A3B8;
               font-size:22px;cursor:pointer;padding:0 4px;line-height:1;flex-shrink:0}
    .close-btn:hover{color:#fff}
    .modal-bd{padding:20px}
    .info-box{background:#EFF6FF;border:1px solid #BFDBFE;border-radius:10px;
              padding:14px;margin-bottom:20px;font-size:13px;color:#1D4ED8;line-height:1.8}
    .m-group{margin-bottom:16px}
    .m-group label{display:block;font-size:13px;font-weight:600;color:#374151;margin-bottom:6px}
    .m-input{width:100%;padding:11px 14px;border:1px solid #D1D5DB;border-radius:9px;
             font-size:14px;font-family:inherit;outline:none;
             transition:border-color .2s,box-shadow .2s}
    .m-input:focus{border-color:#2563EB;box-shadow:0 0 0 3px rgba(37,99,235,.1)}
    .m-help{font-size:12px;color:#9CA3AF;margin-top:4px}
    .pw-wrap{position:relative}
    .pw-wrap .m-input{padding-left:42px}
    .eye-btn{position:absolute;left:12px;top:50%;transform:translateY(-50%);
             background:none;border:none;cursor:pointer;color:#9CA3AF;
             font-size:17px;line-height:1;padding:2px}
    .eye-btn:hover{color:#374151}
    .m-err{background:#FEF2F2;border:1px solid #FECACA;color:#DC2626;
           padding:10px 14px;border-radius:8px;font-size:13px;
           margin-bottom:14px;display:none}
    .modal-ft{padding:0 20px 20px;display:flex;flex-direction:column;gap:10px}
    .btn-act{background:#2563EB;color:#fff;border:none;padding:14px;
             border-radius:10px;font-size:14px;font-weight:700;cursor:pointer;
             font-family:inherit;display:flex;align-items:center;
             justify-content:center;gap:8px;transition:background .2s;width:100%}
    .btn-act:hover:not(:disabled){background:#1D4ED8}
    .btn-act:disabled{opacity:.6;cursor:not-allowed}
    .btn-cxl{background:transparent;color:#64748B;border:1px solid #D1D5DB;
             padding:12px;border-radius:10px;font-size:14px;font-weight:600;
             cursor:pointer;font-family:inherit;transition:all .2s;width:100%}
    .btn-cxl:hover{background:#F8FAFC}
    .spinner{width:18px;height:18px;border:2px solid rgba(255,255,255,.3);
             border-top-color:#fff;border-radius:50%;
             animation:spin .7s linear infinite;display:none;flex-shrink:0}
    @keyframes spin{to{transform:rotate(360deg)}}
  </style>
</head>
<body>

<!-- Header -->
<div class="header">
  <div class="brand">🏥 لوحة تحكم المدير</div>
  <a href="/admin/logout" class="logout">خروج 🚪</a>
</div>

<!-- Stats bar -->
<div class="stats">
  <div class="stat"><strong>${total}</strong> إجمالي العيادات</div>
  <div class="stat"><span class="pill-y">⏳ ${pending}</span> في الانتظار</div>
  <div class="stat"><span class="pill-g">✅ ${active}</span> مفعّل</div>
</div>

<!-- Clinic grid -->
<div class="content">
  <div class="grid">
    ${gridContent}
  </div>
</div>

<!-- Activation modal -->
<div id="modal-overlay" onclick="overlayClick(event)">
  <div class="modal">
    <div class="modal-hd">
      <h2>تفعيل واتساب — <span id="modal-clinic-name"></span></h2>
      <button class="close-btn" onclick="closeModal()">✕</button>
    </div>
    <div class="modal-bd">
      <input type="hidden" id="current-clinic-id">

      <div class="info-box">
        📱 رقم الهاتف المسجل: <strong id="modal-phone"></strong><br>
        استخدم هذا الرقم عند إعداد Meta Business
      </div>

      <div id="modal-error" class="m-err"></div>

      <div class="m-group">
        <label>Phone Number ID</label>
        <input id="phone-number-id" class="m-input" type="text"
               placeholder="مثال: 123456789012345" dir="ltr" autocomplete="off">
        <p class="m-help">احصل عليه من Meta Developer Console</p>
      </div>

      <div class="m-group">
        <label>Access Token</label>
        <div class="pw-wrap">
          <input id="access-token" class="m-input" type="password"
                 placeholder="EAAxxxxx..." dir="ltr" autocomplete="off">
          <button class="eye-btn" type="button" onclick="toggleToken()" id="eye-toggle">👁</button>
        </div>
        <p class="m-help">Permanent Token من Meta Business Manager</p>
      </div>
    </div>

    <div class="modal-ft">
      <button class="btn-act" id="activate-btn" onclick="activateClinic()">
        <div class="spinner" id="act-spinner"></div>
        <span id="act-label">تفعيل العيادة</span>
      </button>
      <button class="btn-cxl" onclick="closeModal()">إلغاء</button>
    </div>
  </div>
</div>

<script>
  let tokenVisible = false;

  function openModal(clinicId, clinicName, phoneNumber) {
    document.getElementById('modal-clinic-name').textContent = clinicName;
    document.getElementById('modal-phone').textContent        = phoneNumber;
    document.getElementById('current-clinic-id').value        = clinicId;
    document.getElementById('phone-number-id').value          = '';
    document.getElementById('access-token').value             = '';
    document.getElementById('modal-error').style.display      = 'none';
    tokenVisible = false;
    document.getElementById('access-token').type  = 'password';
    document.getElementById('eye-toggle').textContent = '👁';
    document.getElementById('modal-overlay').style.display = 'flex';
    setTimeout(() => document.getElementById('phone-number-id').focus(), 100);
  }

  function closeModal() {
    document.getElementById('modal-overlay').style.display = 'none';
  }

  function overlayClick(e) {
    if (e.target === document.getElementById('modal-overlay')) closeModal();
  }

  function toggleToken() {
    tokenVisible = !tokenVisible;
    document.getElementById('access-token').type          = tokenVisible ? 'text'    : 'password';
    document.getElementById('eye-toggle').textContent     = tokenVisible ? '🙈' : '👁';
  }

  function setLoading(on) {
    const btn     = document.getElementById('activate-btn');
    const spinner = document.getElementById('act-spinner');
    const label   = document.getElementById('act-label');
    btn.disabled             = on;
    spinner.style.display    = on ? 'block' : 'none';
    label.textContent        = on ? 'جاري التفعيل...' : 'تفعيل العيادة';
  }

  function showError(msg) {
    const el = document.getElementById('modal-error');
    el.textContent    = msg;
    el.style.display  = 'block';
  }

  async function activateClinic() {
    const id            = document.getElementById('current-clinic-id').value;
    const phoneNumberId = document.getElementById('phone-number-id').value.trim();
    const accessToken   = document.getElementById('access-token').value.trim();

    document.getElementById('modal-error').style.display = 'none';

    if (!phoneNumberId || !accessToken) {
      showError('يرجى ملء جميع الحقول');
      return;
    }

    setLoading(true);
    try {
      const res  = await fetch('/admin/clinics/' + id + '/activate', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ phone_number_id: phoneNumberId, access_token: accessToken }),
      });
      const data = await res.json();

      if (data.success) {
        closeModal();
        showToast('تم تفعيل العيادة بنجاح ✅');

        const badge = document.getElementById('badge-' + id);
        if (badge) {
          badge.textContent        = '✅ مفعّل';
          badge.style.background   = '#F0FDF4';
          badge.style.color        = '#16A34A';
        }
        const btn = document.getElementById('btn-' + id);
        if (btn) {
          btn.textContent          = 'تم التفعيل ✓';
          btn.disabled             = true;
          btn.style.background     = '#94A3B8';
          btn.style.cursor         = 'not-allowed';
          btn.removeAttribute('onclick');
        }
      } else {
        showError(data.error || 'فشل التفعيل، تحقق من البيانات');
      }
    } catch {
      showError('فشل الاتصال بالخادم');
    }
    setLoading(false);
  }

  function showToast(msg) {
    const t = document.createElement('div');
    t.style.cssText = [
      'position:fixed', 'top:20px', 'left:50%', 'transform:translateX(-50%)',
      'background:#16A34A', 'color:#fff', 'padding:12px 24px',
      'border-radius:8px', 'font-size:14px', 'z-index:9999',
      'box-shadow:0 4px 12px rgba(0,0,0,.15)', 'white-space:nowrap',
    ].join(';');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 4000);
  }
</script>
</body>
</html>`;
}

module.exports = router;
