// ============================================================
// STATE
// ============================================================
var state = {
  user: null,
  userTier: null,
  campaigns: [],
  currentCampaign: null,
  layoutStyle: 'Classic',
  currentSession: null,
  characters: [],
  sessions: [],
  moments: [],
  artStyle: 'High fantasy illustration',
  currentView: 'campaigns'
};

// ============================================================
// TOKEN BALANCE — header label, refreshed on load and after any
// token-spending action. Defined once (guarded), called globally.
// ============================================================
function refreshTokenBalance() {
  fetch('/api/tokens/balance')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var el = document.getElementById('token-balance-value');
      if (el && data && typeof data.total === 'number') {
        el.textContent = data.total.toLocaleString();
      }
    })
    .catch(function() { /* non-fatal: keep last shown value */ });
}

// ----- ADMIN TESTING: set my own balance (temporary, deprecate later) -----
function adminSetMyBalance() {
  var input = document.getElementById('admin-set-balance-input');
  var msg = document.getElementById('admin-set-balance-msg');
  if (!input || !state.user || !state.user.id) return;
  var amt = parseInt(input.value, 10);
  if (!Number.isFinite(amt) || amt < 0) {
    showAdminBalanceMsg('Enter a non-negative whole number.', 'err');
    return;
  }
  fetch('/api/tokens/admin/set-balance', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ user_id: state.user.id, amount: amt })
  })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data && data.ok) {
        showAdminBalanceMsg('Balance set to ' + (data.balance && data.balance.total) + '.', 'ok');
        refreshTokenBalance();
      } else {
        showAdminBalanceMsg((data && data.error) || 'Could not set balance.', 'err');
      }
    })
    .catch(function() { showAdminBalanceMsg('Network error.', 'err'); });
}
function showAdminBalanceMsg(text, kind) {
  var el = document.getElementById('admin-set-balance-msg');
  if (!el) return;
  el.textContent = text;
  el.style.display = 'block';
  if (kind === 'ok') {
    el.style.background = 'rgba(15,110,86,0.25)';
    el.style.border = '1px solid rgba(134,212,186,0.4)';
    el.style.color = '#86d4ba';
  } else {
    el.style.background = 'rgba(139,26,26,0.35)';
    el.style.border = '1px solid rgba(240,149,149,0.4)';
    el.style.color = '#f09595';
  }
}

// ============================================================
// INIT
// ============================================================
document.addEventListener('DOMContentLoaded', function() {
  checkAuth();
  var charImageInput = document.getElementById('char-image-input');
  if (charImageInput) charImageInput.addEventListener('change', previewCharImage);
  var sessionDate = document.getElementById('session-date');
  if (sessionDate) sessionDate.value = new Date().toISOString().split('T')[0];

  // Close user menu when clicking outside
  document.addEventListener('click', function(e) {
    var menu = document.getElementById('user-menu');
    var btn = document.querySelector('.user-menu-btn');
    if (menu && btn && !menu.contains(e.target) && !btn.contains(e.target)) {
      menu.classList.remove('open');
    }
  });

  // CRITICAL: Prevent browser from opening dragged files as new pages
  document.addEventListener('dragover', function(e) { e.preventDefault(); });
  document.addEventListener('drop', function(e) { e.preventDefault(); });
});

// ============================================================
// AUTH
// ============================================================
function checkAuth() {
  fetch('/api/auth/me')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data.authenticated) { window.location.href = '/'; return; }
      state.user = data;
      // Tier info drives feature gates (prompt editing, watermark, export)
      state.userTier = data.tierFeatures || null;
      document.getElementById('user-name').textContent = data.name;
      document.getElementById('user-menu-email').textContent = data.email;
      var initials = data.name.split(' ').map(function(w) { return w[0]; }).join('').slice(0,2).toUpperCase();
      document.getElementById('user-avatar').textContent = initials;
      refreshTokenBalance();
      var adminBox = document.getElementById('account-admin-testing');
      if (adminBox) adminBox.style.display = data.is_admin ? 'block' : 'none';

      // Load saved API key into settings field
      fetch('/api/auth/apikey')
        .then(function(r) { return r.json(); })
        .then(function(k) {
          if (k.api_key) {
            var akEl = document.getElementById('settings-apikey');
            if (akEl) akEl.value = k.api_key;
          }
        });

      loadCampaigns();
    });
}

function logout() {
  fetch('/api/auth/logout', { method: 'POST' })
    .then(function() { window.location.href = '/'; });
}

function toggleUserMenu() {
  document.getElementById('user-menu').classList.toggle('open');
}

function closeUserMenu() {
  document.getElementById('user-menu').classList.remove('open');
}

// ============================================================
// MY ACCOUNT (read-only)
// ============================================================
function loadAccount() {
  // Pull current tier + plan info, then usage counts.
  fetch('/api/auth/me')
    .then(function(r) { return r.json(); })
    .then(function(me) {
      if (!me || !me.authenticated) return;
      renderAccountTier(me);
      renderAccountPlans(me);
      return fetch('/api/auth/usage').then(function(r) { return r.json(); });
    })
    .then(function(usage) {
      if (usage) renderAccountUsage(usage);
    })
    .catch(function(){});
}

var TIER_COLORS = {
  copper:   { bg:'#6b4a2f', fg:'#f0d8b8' },
  silver:   { bg:'#8a8d93', fg:'#1a1a1a' },
  gold:     { bg:'#c9a84c', fg:'#1a1a1a' },
  platinum: { bg:'#3a3d6b', fg:'#e8e8f0' }
};

function renderAccountTier(me) {
  var tierKey = (me.tier || 'copper');
  var feat = me.tierFeatures || {};
  var nameEl = document.getElementById('account-tier-name');
  if (nameEl) nameEl.textContent = (feat.name || tierKey) + ' Plan';

  var badge = document.getElementById('account-tier-badge');
  if (badge) {
    var col = TIER_COLORS[tierKey] || TIER_COLORS.copper;
    badge.textContent = (feat.name || tierKey).toUpperCase();
    badge.style.background = col.bg;
    badge.style.color = col.fg;
  }

  var desc = document.getElementById('account-tier-desc');
  if (desc) {
    var priceText = (feat.price ? ('$' + feat.price + '/month') : 'Free');
    desc.textContent = (feat.description || '') + ' \u2014 ' + priceText;
  }

  // Trial banner — only for copper with a trial running
  var banner = document.getElementById('account-trial-banner');
  if (banner) {
    if (tierKey === 'copper' && me.trialDaysLeft !== null && me.trialDaysLeft !== undefined) {
      if (me.trialExpired) {
        banner.textContent = 'Your free trial has expired. Upgrade to keep creating.';
      } else {
        banner.textContent = 'Free trial: ' + me.trialDaysLeft + ' day' +
          (me.trialDaysLeft === 1 ? '' : 's') + ' remaining.';
      }
      banner.style.display = 'block';
    } else {
      banner.style.display = 'none';
    }
  }

  // Feature grid
  var grid = document.getElementById('account-features');
  if (grid) {
    function row(label, ok) {
      var mark = ok
        ? '<span style="color:#7fae5f;">\u2713</span> '
        : '<span style="color:#9a6a5a;">\u2717</span> ';
      return '<div>' + mark + label + '</div>';
    }
    function val(label, v) {
      return '<div><span style="color:var(--gold);">' + v + '</span> ' + label + '</div>';
    }
    var campLimit = (feat.max_campaigns === null || feat.max_campaigns === undefined)
      ? 'Unlimited' : feat.max_campaigns;
    var sessLimit = (feat.max_sessions === null || feat.max_sessions === undefined)
      ? 'Unlimited' : feat.max_sessions;
    grid.innerHTML =
      val('campaigns', campLimit) +
      val('sessions per campaign', sessLimit) +
      row('Export to PDF', feat.can_export) +
      row('Print on demand', feat.can_print) +
      row('Prompt editing', feat.can_edit_prompts) +
      row('Watermark-free', !feat.watermark);
  }
}

function renderAccountUsage(usage) {
  var el = document.getElementById('account-usage');
  if (!el) return;
  function card(num, label) {
    return '<div style="background:rgba(201,168,76,0.06);border:1px solid rgba(201,168,76,0.18);' +
      'border-radius:var(--radius);padding:16px;text-align:center;">' +
      '<div style="font-family:var(--font-display);font-size:28px;color:var(--gold);">' + num + '</div>' +
      '<div style="font-size:11px;color:var(--text-light);letter-spacing:0.5px;margin-top:4px;">' +
      label + '</div></div>';
  }
  el.innerHTML =
    card(usage.campaigns || 0, 'ACTIVE CAMPAIGNS') +
    card(usage.sessions || 0, 'TOTAL SESSIONS') +
    card(usage.storyboards || 0, 'STORYBOARDS') +
    card(usage.imagesThisMonth || 0, 'IMAGES THIS MONTH') +
    card(usage.imagesAllTime || 0, 'IMAGES ALL TIME');
}

function renderAccountPlans(me) {
  var el = document.getElementById('account-plans');
  if (!el) return;
  var all = me.allTiers || {};
  var current = me.tier || 'copper';
  var order = ['copper','silver','gold','platinum'];

  el.innerHTML = order.map(function(key) {
    var t = all[key];
    if (!t) return '';
    var isCurrent = (key === current);
    var col = TIER_COLORS[key] || TIER_COLORS.copper;
    var priceText = t.price ? ('$' + t.price + '<span style="font-size:11px;color:var(--text-light);">/mo</span>') : 'Free';
    return '<div style="border:1px solid ' + (isCurrent ? 'var(--gold)' : 'rgba(201,168,76,0.2)') + ';' +
      'border-radius:var(--radius-lg);padding:16px;background:' +
      (isCurrent ? 'rgba(201,168,76,0.08)' : 'transparent') + ';">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;">' +
        '<span style="font-family:var(--font-display);font-size:14px;letter-spacing:1px;color:' + col.bg + ';">' +
          (t.name || key).toUpperCase() + '</span>' +
        (isCurrent ? '<span style="font-size:10px;color:var(--gold);font-weight:600;">CURRENT</span>' : '') +
      '</div>' +
      '<div style="font-family:var(--font-display);font-size:22px;color:var(--text);margin:8px 0;">' + priceText + '</div>' +
      '<div style="font-size:11px;color:var(--text-light);line-height:1.5;">' + (t.description || '') + '</div>' +
    '</div>';
  }).join('');
}

// Get API key — prefer settings field, fall back to nothing
function getApiKey() {
  var el = document.getElementById('settings-apikey');
  return el ? el.value.trim() : '';
}

// ============================================================
// BREADCRUMB
// ============================================================
function setBreadcrumb(items) {
  var bc = document.getElementById('breadcrumb');
  var html = '';
  items.forEach(function(item, i) {
    if (i > 0) html += '<span class="breadcrumb-sep">&#8250;</span>';
    if (item.action && i < items.length - 1) {
      html += '<span class="breadcrumb-link" onclick="' + item.action + '">' + item.label + '</span>';
    } else {
      html += '<span class="breadcrumb-current">' + item.label + '</span>';
    }
  });
  bc.innerHTML = html;
}

// ============================================================
// VIEW MANAGEMENT
// ============================================================
function showView(view) {
  var views = ['campaigns','sessions','characters','assets','novel','session-detail','account','settings'];
  views.forEach(function(v) {
    var el = document.getElementById('view-' + v);
    if (el) el.style.display = 'none';
  });

  var el = document.getElementById('view-' + view);
  if (el) el.style.display = 'block';
  state.currentView = view;

  // Update sidebar active states
  document.querySelectorAll('.sidebar-item').forEach(function(el) { el.classList.remove('active'); });

  if (view === 'campaigns') {
    var _sc=document.getElementById('snav-campaigns'); if(_sc)_sc.classList.add('active');
    var _cs=document.getElementById('campaign-subnav'); if(_cs)_cs.style.display='none';
    state.currentCampaign = null;
    state.currentSession = null;
    setBreadcrumb([{label:'My Campaigns'}]);
    loadCampaigns();
  } else if (view === 'account') {
    var sn = document.getElementById('snav-account');
    if (sn) sn.classList.add('active');
    var _cs=document.getElementById('campaign-subnav'); if(_cs)_cs.style.display='none';
    setBreadcrumb([
      {label:'My Campaigns', action:"showView('campaigns')"},
      {label:'My Account'}
    ]);
    loadAccount();
  } else if (view === 'settings') {
    var _ss=document.getElementById('snav-settings'); if(_ss)_ss.classList.add('active');
    var _cs=document.getElementById('campaign-subnav'); if(_cs)_cs.style.display='none';
    setBreadcrumb([
      {label:'My Campaigns', action:"showView('campaigns')"},
      {label:'Settings'}
    ]);
    loadSettingsForm();
  }
}

function showCampaignSection(section) {
  showView(section);

  // Show campaign subnav
  var _cs=document.getElementById('campaign-subnav'); if(_cs)_cs.style.display='block';
  var _scn=document.getElementById('sidebar-campaign-name'); if(_scn)_scn.textContent=state.currentCampaign.name;

  // Sidebar active — novel has no sidebar item so skip it
  if (section !== 'novel') {
    var navId = 'snav-' + section;
    var el = document.getElementById(navId);
    if (el) el.classList.add('active');
  }

  // Breadcrumb
  var sectionLabel = {sessions:'Sessions', characters:'Characters', assets:'Asset Library', novel:'Graphic Novel'}[section] || section;
  setBreadcrumb([
    {label:'My Campaigns', action:"showView('campaigns')"},
    {label:state.currentCampaign.name, action:"showCampaignSection('sessions')"},
    {label:sectionLabel}
  ]);

  if (section === 'sessions') loadSessions();
  if (section === 'characters') loadCharacters();
  if (section === 'novel') loadNovelSummary();
  if (section === 'assets') loadAssets();
}

// ============================================================
// CAMPAIGNS
// ============================================================
function loadCampaigns() {
  fetch('/api/campaigns')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      state.campaigns = Array.isArray(data) ? data : [];
      renderCampaigns();
    });
}

function renderCampaigns() {
  var grid = document.getElementById('campaigns-grid');
  var html = state.campaigns.map(function(c) {
    return '<div class="campaign-card" onclick="selectCampaign(' + c.id + ')">' +
      '<div class="campaign-card-icon"><img src="/images/Chronicle_Logo.png" alt="" /></div>' +
      '<div class="campaign-card-name">' + c.name + '</div>' +
      '<div class="campaign-card-desc">' + (c.description || 'No description') + '</div>' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-top:8px;">' +
        '<div class="campaign-card-meta">Created ' + new Date(c.created_at).toLocaleDateString() + '</div>' +
      '</div>' +
    '</div>';
  }).join('');
  html += '<div class="add-campaign-card" onclick="openCampaignModal()"><div class="plus">+</div><span>New campaign</span></div>';
  grid.innerHTML = html;
}

function setCampaignElements() {
  // sessions-title is owned by renderSessions() so it can include the session count
  var ct = document.getElementById('novel-cover-title');
  var cs = document.getElementById('novel-cover-sub');
  if (ct) ct.textContent = state.currentCampaign.name;
  if (cs) cs.textContent = state.currentCampaign.description || '';
}

function selectCampaign(id) {
  state.currentCampaign = state.campaigns.find(function(c) { return c.id === id; });
  setCampaignElements();
  showCampaignSection('sessions');
}

function selectCampaignNovel(id) {
  state.currentCampaign = state.campaigns.find(function(c) { return c.id === id; });
  setCampaignElements();
  var _cs=document.getElementById('campaign-subnav'); if(_cs)_cs.style.display='block';
  var _scn=document.getElementById('sidebar-campaign-name'); if(_scn)_scn.textContent=state.currentCampaign.name;
  showView('campaign-detail');
  showCampaignTab('novel');
}

function openCampaignModal(editId) {
  document.getElementById('campaign-edit-id').value = editId || '';
  document.getElementById('campaign-modal-title').textContent = editId ? 'Edit Campaign' : 'New Campaign';
  document.getElementById('campaign-save-btn').textContent = editId ? 'Save changes' : 'Create campaign';
  document.getElementById('campaign-name').value = editId && state.currentCampaign ? state.currentCampaign.name : '';
  document.getElementById('campaign-desc').value = editId && state.currentCampaign ? (state.currentCampaign.description || '') : '';
  document.getElementById('campaign-modal-error').classList.add('hidden');
  document.getElementById('campaign-modal').classList.remove('hidden');
}

function closeCampaignModal() { document.getElementById('campaign-modal').classList.add('hidden'); }

function saveCampaign() {
  var name = document.getElementById('campaign-name').value.trim();
  var desc = document.getElementById('campaign-desc').value.trim();
  var editId = document.getElementById('campaign-edit-id').value;
  if (!name) { showModalError('campaign-modal-error', 'Campaign name is required.'); return; }

  var url = editId ? '/api/campaigns/' + editId : '/api/campaigns';
  fetch(url, {
    method: editId ? 'PUT' : 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({name:name, description:desc})
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.error) { showModalError('campaign-modal-error', data.error); return; }
    closeCampaignModal();
    loadCampaigns();
  });
}

// ============================================================
// SESSIONS
// ============================================================

function formatSessionDate(dateVal) {
  if (!dateVal) return '';
  // PostgreSQL returns Date objects, SQLite returns strings
  var dateStr = typeof dateVal === 'string' ? dateVal : dateVal.toISOString();
  // Handle both 'YYYY-MM-DD' and full ISO strings
  var datePart = dateStr.split('T')[0];
  return new Date(datePart + 'T12:00:00').toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
}
function loadSessions() {
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      state.sessions = Array.isArray(data) ? data : [];
      renderSessions();
    });
}

function renderSessions() {
  var list = document.getElementById('sessions-list');

  // Update the page title with a session count, e.g. "The Hidden Pass (35 sessions)"
  var titleEl = document.getElementById('sessions-title');
  if (titleEl) {
    var campName = (state.currentCampaign && state.currentCampaign.name) ? state.currentCampaign.name : 'Sessions';
    var n = state.sessions.length;
    titleEl.innerHTML = campName +
      ' <span style="font-size:0.6em;font-weight:400;color:var(--text-light);">(' +
      n + ' session' + (n === 1 ? '' : 's') + ')</span>';
  }

  if (!state.sessions.length) {
    list.innerHTML = '<div class="empty-state"><div class="empty-state-icon">&#128203;</div>' +
      '<h3>No sessions yet</h3><p>Create your first session to start uploading transcripts and generating storyboards</p>' +
      '<button class="btn btn-primary" onclick="openSessionModal()">+ New session</button></div>';
    return;
  }

  // Newest first — sort by session date descending
  var ordered = state.sessions.slice().sort(function(a, b) {
    var da = (a.session_date || '').toString().split('T')[0];
    var db = (b.session_date || '').toString().split('T')[0];
    if (da < db) return 1;
    if (da > db) return -1;
    return 0;
  });

  list.innerHTML = ordered.map(function(s) {
    return '<div class="session-item" onclick="selectSession(' + s.id + ')">' +
      '<div class="session-item-left">' +
        '<div>' +
          '<div class="session-name">' + s.name + '</div>' +
          '<div class="session-date">' + formatSessionDate(s.session_date) + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="flex gap-1 items-center">' +
        (s.transcript ? '<span class="session-badge">Has transcript</span>' : '<span class="session-badge empty">No transcript</span>') +
        '<button class="btn btn-sm btn-danger" onclick="event.stopPropagation();deleteSession(' + s.id + ')">Delete</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

function openSessionModal() {
  document.getElementById('session-name').value = '';
  document.getElementById('session-date').value = new Date().toISOString().split('T')[0];
  document.getElementById('session-modal-error').classList.add('hidden');
  document.getElementById('session-modal').classList.remove('hidden');
}

function closeSessionModal() { document.getElementById('session-modal').classList.add('hidden'); }

function saveSession() {
  var name = document.getElementById('session-name').value.trim();
  var date = document.getElementById('session-date').value;
  if (!name) { showModalError('session-modal-error', 'Session name is required.'); return; }

  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({name:name, session_date:date})
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.error) { showModalError('session-modal-error', data.error); return; }
    closeSessionModal();
    loadSessions();
  });
}

function updateSessionDate(value) {
  if (!value || !state.currentCampaign || !state.currentSession) return;
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' + state.currentSession.id, {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ session_date: value })
  })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data && data.id) {
        state.currentSession = data;
        if (typeof loadSessions === 'function') loadSessions();
      }
    })
    .catch(function(){});
}

function deleteSession(id) {
  if (!confirm('Delete this session and all its moments? This cannot be undone.')) return;
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' + id, {method:'DELETE'})
    .then(function() { loadSessions(); });
}

function selectSession(id) {
  // Clear previous session state
  state.moments = [];
  state.narrativeData = { intro: '', sections: [], outro: '' };
  var sbEmpty = document.getElementById('sb-empty');
  var sbContent = document.getElementById('sb-content');
  if (sbEmpty) sbEmpty.style.display = 'block';
  if (sbContent) sbContent.style.display = 'none';

  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' + id)
    .then(function(r) { return r.json(); })
    .then(function(data) {
      state.currentSession = data;
      state.moments = data.moments || [];
      document.getElementById('session-detail-name').textContent = data.name;
      // Set editable date input
      var dateInput = document.getElementById('session-detail-date-input');
      if (dateInput && data.session_date) {
        var dateStr = typeof data.session_date === 'string'
          ? data.session_date.split('T')[0]
          : data.session_date.toISOString().split('T')[0];
        dateInput.value = dateStr;
      }
      // date now handled by session-detail-date-input

      // Load narrative data
      state.narrativeData = {
        intro: data.narrative_intro || '',
        sections: data.narrative_sections ? JSON.parse(data.narrative_sections) : [],
        outro: data.narrative_outro || ''
      };

      if (state.moments.length) renderStoryboard();

      // Load last used art style for this campaign
      if (typeof loadLastArtStyle === 'function') loadLastArtStyle(data.art_style, data.layout_style);

      // Show session detail view FIRST
      var views = ['campaigns','sessions','characters','novel','session-detail','settings'];
      views.forEach(function(v) {
        var el = document.getElementById('view-' + v);
        if (el) el.style.display = 'none';
      });
      document.getElementById('view-session-detail').style.display = 'block';

      // Now that view is visible, populate fields
      switchSessionTab('notes');
      setTimeout(function() {
        var transcriptEl = document.getElementById('transcript-input');
        var notesEl = document.getElementById('session-notes-input');
        if (transcriptEl) {
          transcriptEl.value = data.transcript || '';
          // Auto-save the transcript when the DM clicks away from the box.
          transcriptEl.onblur = function() {
            saveSessionField('transcript', transcriptEl.value.trim());
          };
        }
        if (notesEl) {
          notesEl.value = data.session_notes || '';
          // Auto-save the notes when the DM clicks away from the box.
          notesEl.onblur = function() {
            saveSessionField('session_notes', notesEl.value.trim());
          };
        }
      }, 50);

      // Update sidebar
      document.querySelectorAll('.sidebar-item').forEach(function(el) { el.classList.remove('active'); });
      var _sx=document.getElementById('snav-sessions'); if(_sx)_sx.classList.add('active');
      var _cs=document.getElementById('campaign-subnav'); if(_cs)_cs.style.display='block';
      var _scn=document.getElementById('sidebar-campaign-name'); if(_scn)_scn.textContent=state.currentCampaign.name;

      // Breadcrumb
      setBreadcrumb([
        {label:'My Campaigns', action:"showView('campaigns')"},
        {label:state.currentCampaign.name, action:"showCampaignSection('sessions')"},
        {label:'Sessions', action:"showCampaignSection('sessions')"},
        {label:data.name}
      ]);
    });
}

// Quietly save one session field (transcript or session_notes) — used by
// the auto-save-on-blur handlers. Shows a brief confirmation, fails silent.
function saveSessionField(field, value) {
  if (!state.currentCampaign || !state.currentSession) return;
  var body = {};
  body[field] = value;
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' + state.currentSession.id, {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify(body)
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data && data.id) state.currentSession = data;
    var saved = document.getElementById('notes-saved');
    if (saved) {
      saved.textContent = (field === 'transcript' ? 'Transcript saved' : 'Notes saved');
      saved.classList.remove('hidden');
      setTimeout(function() { saved.classList.add('hidden'); }, 1800);
    }
  })
  .catch(function(){});
}

function saveTranscript() {
  var transcript = document.getElementById('transcript-input').value.trim();
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' + state.currentSession.id, {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({transcript:transcript})
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    state.currentSession = data;
    showAlert('Transcript saved!');
  });
}

function saveNotes() {
  var notes = document.getElementById('session-notes-input').value.trim();
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' + state.currentSession.id, {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({session_notes:notes})
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    state.currentSession = data;
    var saved = document.getElementById('notes-saved');
    saved.classList.remove('hidden');
    setTimeout(function() { saved.classList.add('hidden'); }, 2500);
  });
}

// ---- Session character snapshots (Stage 2) ----
function loadSessionCharacters() {
  if (!state.currentCampaign || !state.currentSession) return;
  var empty = document.getElementById('sc-empty');
  var content = document.getElementById('sc-content');
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' +
        state.currentSession.id + '/characters')
    .then(function(r) { return r.json(); })
    .then(function(rows) {
      rows = Array.isArray(rows) ? rows : [];
      if (!rows.length) {
        if (empty) empty.style.display = 'block';
        if (content) content.style.display = 'none';
        return;
      }
      if (empty) empty.style.display = 'none';
      if (content) content.style.display = 'block';
      renderSessionCharacters(rows);
    })
    .catch(function(){});
}

function renderSessionCharacters(rows) {
  var canEdit = state.userTier && state.userTier.can_edit_prompts;
  var list = document.getElementById('sc-list');
  if (!list) return;
  list.innerHTML = rows.map(function(r) {
    var isNpc = (r.is_npc === true || r.is_npc === 1 || r.is_npc === '1');
    // Reference image is the preferred thumbnail.
    var img = r.reference_url || r.canonical_reference_url || r.image_portrait || r.image || r.image_fullbody;
    var thumb = img
      ? '<img src="' + img + '" class="sc-thumb" alt="' + r.name + '" ' +
        'style="cursor:zoom-in;" onclick="openLightbox(this.src,this.alt)" title="Click to enlarge" />'
      : '<div class="sc-thumb sc-thumb-empty">&#128100;</div>';

    // Stage 3: a pending change shows a review badge.
    var pendingChange = (r.change_flag === true || r.change_flag === 1 || r.change_flag === '1')
      && r.change_status === 'pending';
    // An accepted change shows a quieter badge that re-opens the review
    // screen — so the DM can adjust the moment, re-image, or un-approve.
    var acceptedChange = (r.change_status === 'accepted');
    var changeBadge = '';
    if (pendingChange) {
      changeBadge = '<div class="sc-change-badge" onclick="openChangeReview(' + r.character_id + ')">' +
        '&#9888; Change detected &mdash; review</div>';
    } else if (acceptedChange) {
      changeBadge = '<div class="sc-change-badge sc-change-badge-accepted" ' +
        'onclick="openChangeReview(' + r.character_id + ')">' +
        '&#10003; Change applied &mdash; edit</div>';
    }

    var editBtn = '';
    if (canEdit) {
      editBtn = '<button class="btn btn-sm" onclick="startEditSnapshot(' + r.character_id + ')">&#9998; Edit Description</button>';
      // "Amend appearance" — manually start the review flow even when the
      // AI flagged nothing. Hidden if a change is already pending/accepted
      // (the badge already opens the review screen for those).
      if (!pendingChange && !acceptedChange) {
        editBtn += '<button class="btn btn-sm" onclick="openChangeReview(' + r.character_id + ')">' +
          '&#10010; Amend appearance</button>';
      }
    }

    return '<div class="sc-card" id="sc-card-' + r.character_id + '">' +
      '<div class="sc-card-head">' +
        thumb +
        '<div class="sc-card-id">' +
          '<div class="sc-card-name">' + r.name +
            (isNpc ? ' <span class="char-badge char-badge-npc">NPC</span>' : '') + '</div>' +
          '<div class="sc-card-cls">' + (r.cls || '') + '</div>' +
        '</div>' +
        editBtn +
      '</div>' +
      changeBadge +
      '<div class="sc-card-prompt" id="sc-prompt-' + r.character_id + '">' +
        (r.prompt || '') + '</div>' +
    '</div>';
  }).join('');
  // Keep the rows available for the review screen.
  state.sessionCharacterRows = rows;
}

function startEditSnapshot(charId) {
  var card = document.getElementById('sc-card-' + charId);
  var promptEl = document.getElementById('sc-prompt-' + charId);
  if (!card || !promptEl) return;
  var current = promptEl.textContent;
  promptEl.outerHTML =
    '<textarea class="char-prompt-editor" id="sc-editor-' + charId + '">' + current + '</textarea>' +
    '<div class="char-prompt-actions" id="sc-actions-' + charId + '">' +
      '<button class="btn btn-sm btn-primary" onclick="saveSnapshot(' + charId + ')">Save</button>' +
      '<button class="btn btn-sm" onclick="loadSessionCharacters()">Cancel</button>' +
    '</div>';
}

function saveSnapshot(charId) {
  var ta = document.getElementById('sc-editor-' + charId);
  if (!ta) return;
  var newPrompt = ta.value;
  ta.disabled = true;
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' +
        state.currentSession.id + '/characters/' + charId, {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ prompt: newPrompt })
  })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data && data.success) {
        loadSessionCharacters();
      } else {
        ta.disabled = false;
        alert((data && data.error) || 'Could not save.');
      }
    })
    .catch(function() { ta.disabled = false; alert('Could not save.'); });
}

// ---- Stage 3: character change review screen ----
// Opens an in-card review: the AI's detected change + an editable text
// field. Regenerate / Approve buttons are wired in Piece 5.
function openChangeReview(charId) {
  var rows = state.sessionCharacterRows || [];
  var r = rows.find(function(x) { return x.character_id === charId; });
  if (!r) return;
  var card = document.getElementById('sc-card-' + charId);
  if (!card) return;

  var currentImg = r.reference_url || r.canonical_reference_url || '';
  var imgHtml = currentImg
    ? '<img src="' + currentImg + '" class="sc-review-img" id="sc-review-img-' + charId + '" alt="reference" />'
    : '<div class="sc-review-img sc-review-img-empty" id="sc-review-img-' + charId + '">No reference image yet</div>';

  // Moment selector — which panel the change first becomes visible at.
  // The character looks normal before it, changed from it onward.
  var moments = state.moments || [];
  var savedIdx = (typeof r.change_moment_index === 'number') ? r.change_moment_index : 0;
  var momentOptions = moments.map(function(m, i) {
    var label = 'Moment ' + (i + 1) + (m.title ? ': ' + m.title : '');
    var sel = (i === savedIdx) ? ' selected' : '';
    return '<option value="' + i + '"' + sel + '>' + label + '</option>';
  }).join('');
  var momentSelector = moments.length
    ? '<label class="sc-review-label">Change first appears at this moment ' +
        '(character looks normal before it):</label>' +
      '<select class="form-input sc-review-moment" id="sc-review-moment-' + charId + '">' +
        momentOptions +
      '</select>'
    : '';

  var isAccepted = (r.change_status === 'accepted');
  // A "manual amend" = the DM opened this with no AI-detected change.
  var isManual = !isAccepted && !r.change_detail;
  var titleText;
  if (isAccepted) {
    titleText = '&#10003; Change applied — adjust or un-approve';
  } else if (isManual) {
    titleText = '&#10010; Amend ' + r.name + '\u2019s appearance';
  } else {
    titleText = '&#9888; Permanent change detected';
  }
  // For an accepted change, the textarea holds the clean change_note
  // (the approved detail), not change_detail.
  var detailText = isAccepted
    ? (r.change_note || r.change_detail || '')
    : (r.change_detail || '');
  // Only show the "AI detected" line when the AI actually detected something.
  var detectedLine = (r.change_detail && !isManual)
    ? '<div class="sc-review-detected">The AI detected: <em>' + r.change_detail + '</em></div>'
    : (isManual
        ? '<div class="sc-review-detected">Describe a permanent change to this ' +
          'character — it will be applied from the chosen moment onward.</div>'
        : '');

  card.innerHTML =
    '<div class="sc-review">' +
      '<div class="sc-review-title">' + titleText + '</div>' +
      '<div class="sc-review-name">' + r.name + '</div>' +
      detectedLine +
      '<label class="sc-review-label">Amended appearance (edit if needed before approving):</label>' +
      '<textarea class="char-prompt-editor" id="sc-review-text-' + charId + '" ' +
        'placeholder="e.g. left horn broken off to a jagged stump">' +
        detailText + '</textarea>' +
      momentSelector +
      '<div class="sc-review-imgwrap">' + imgHtml + '</div>' +
      '<div class="sc-review-msg" id="sc-review-msg-' + charId + '"></div>' +
      '<div class="char-prompt-actions">' +
        '<button class="btn btn-sm" id="sc-regen-' + charId + '" ' +
          'onclick="regenerateReference(' + charId + ')">&#10227; Regenerate image</button>' +
        '<button class="btn btn-sm btn-primary" id="sc-approve-' + charId + '" ' +
          'onclick="approveChange(' + charId + ')">&#10003; ' +
          (isAccepted ? 'Save changes' : 'Approve change') + '</button>' +
        '<button class="btn btn-sm" id="sc-reject-' + charId + '" ' +
          'onclick="rejectChange(' + charId + ')">&#10005; ' +
          (isAccepted ? 'Un-approve' : 'Not a real change') + '</button>' +
        '<button class="btn btn-sm" onclick="loadSessionCharacters()">Cancel</button>' +
      '</div>' +
    '</div>';
}

// Piece 5: regenerate the reference image as a draft. The DM can do
// this repeatedly; the latest draft URL is held until Approve.
function regenerateReference(charId) {
  var msg = document.getElementById('sc-review-msg-' + charId);
  var btn = document.getElementById('sc-regen-' + charId);
  var textEl = document.getElementById('sc-review-text-' + charId);
  var detail = textEl ? textEl.value : '';
  if (btn) { btn.disabled = true; }
  if (msg) msg.textContent = 'Generating new reference image...';

  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' +
        state.currentSession.id + '/characters/' + charId + '/regenerate-reference', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ detail: detail })
  })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (btn) { btn.disabled = false; }
      if (data && data.success && data.image_url) {
        // Show the new draft image; hold the URL for Approve.
        var wrap = document.getElementById('sc-review-img-' + charId);
        if (wrap) {
          var fresh = '<img src="' + data.image_url + '" class="sc-review-img" ' +
            'id="sc-review-img-' + charId + '" alt="reference" />';
          wrap.outerHTML = fresh;
        }
        state.draftReference = state.draftReference || {};
        state.draftReference[charId] = data.image_url;
        if (msg) msg.textContent = 'New image ready. Regenerate again, or Approve to keep it.';
      } else {
        if (msg) msg.textContent = (data && data.error) || 'Could not regenerate.';
      }
    })
    .catch(function() {
      if (btn) { btn.disabled = false; }
      if (msg) msg.textContent = 'Could not regenerate.';
    });
}

// Piece 5: approve the change — locks the draft image + text into this
// session and writes it forward to later sessions.
function approveChange(charId) {
  var msg = document.getElementById('sc-review-msg-' + charId);
  var btn = document.getElementById('sc-approve-' + charId);
  var textEl = document.getElementById('sc-review-text-' + charId);
  var detail = textEl ? textEl.value : '';
  // The DM's chosen moment index (override of the AI's guess).
  var momentEl = document.getElementById('sc-review-moment-' + charId);
  var momentIndex = momentEl ? parseInt(momentEl.value, 10) : 0;
  if (isNaN(momentIndex) || momentIndex < 0) momentIndex = 0;

  // The image to lock in: a fresh draft if regenerated, otherwise the
  // existing reference (so editing an already-accepted change — e.g.
  // just moving the moment — doesn't force a regenerate).
  var row = (state.sessionCharacterRows || []).find(function(x) { return x.character_id === charId; });
  var existingUrl = row ? (row.reference_url || row.canonical_reference_url) : null;
  var draftUrl = (state.draftReference && state.draftReference[charId]) || existingUrl || null;

  if (!draftUrl) {
    if (msg) msg.textContent = 'Regenerate the image at least once before approving.';
    return;
  }
  if (btn) { btn.disabled = true; }
  if (msg) msg.textContent = 'Saving...';

  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' +
        state.currentSession.id + '/characters/' + charId + '/approve-change', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ detail: detail, image_url: draftUrl, moment_index: momentIndex })
  })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data && data.success) {
        if (state.draftReference) delete state.draftReference[charId];
        loadSessionCharacters();
      } else {
        if (btn) { btn.disabled = false; }
        if (msg) msg.textContent = (data && data.error) || 'Could not approve.';
      }
    })
    .catch(function() {
      if (btn) { btn.disabled = false; }
      if (msg) msg.textContent = 'Could not approve.';
    });
}

// Reject a detected change — it's not real, or the DM doesn't want it.
// Marks it rejected; re-extraction won't re-flag the SAME change.
function rejectChange(charId) {
  var msg = document.getElementById('sc-review-msg-' + charId);
  var btn = document.getElementById('sc-reject-' + charId);
  if (btn) { btn.disabled = true; }
  if (msg) msg.textContent = 'Rejecting...';

  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' +
        state.currentSession.id + '/characters/' + charId + '/reject-change', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({})
  })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data && data.success) {
        loadSessionCharacters();
      } else {
        if (btn) { btn.disabled = false; }
        if (msg) msg.textContent = (data && data.error) || 'Could not reject.';
      }
    })
    .catch(function() {
      if (btn) { btn.disabled = false; }
      if (msg) msg.textContent = 'Could not reject.';
    });
}

// Scroll a textarea so a character offset is visible. Uses a hidden
// "mirror" div that copies the textarea's exact styling, so we can
// measure where the offset actually lands — reliable with wrapped lines.
function scrollTextareaToOffset(box, offset) {
  try {
    var cs = window.getComputedStyle(box);
    var mirror = document.createElement('div');
    var props = ['fontFamily','fontSize','fontWeight','lineHeight','letterSpacing',
      'textTransform','wordSpacing','paddingTop','paddingRight','paddingBottom',
      'paddingLeft','borderTopWidth','borderRightWidth','borderBottomWidth','borderLeftWidth'];
    props.forEach(function(p) { mirror.style[p] = cs[p]; });
    mirror.style.position = 'absolute';
    mirror.style.visibility = 'hidden';
    mirror.style.whiteSpace = 'pre-wrap';
    mirror.style.wordWrap = 'break-word';
    mirror.style.width = box.clientWidth + 'px';
    mirror.style.boxSizing = 'border-box';
    // Text up to the match, then a marker span at the match position.
    mirror.textContent = box.value.substring(0, offset);
    var marker = document.createElement('span');
    marker.textContent = '\u200b';
    mirror.appendChild(marker);
    document.body.appendChild(mirror);
    var markerTop = marker.offsetTop;
    document.body.removeChild(mirror);
    // Centre the match in the visible area.
    box.scrollTop = Math.max(0, markerTop - box.clientHeight / 2);
  } catch (e) {
    // If anything goes wrong, fail quietly — selection is still set.
  }
}

// Find NEXT — steps through matches one at a time, selecting each.
// Searches the transcript first, then the notes; wraps around.
var _frLastBox = null;
function findNextSession() {
  var findEl = document.getElementById('fr-find');
  var resultEl = document.getElementById('fr-result');
  var find = findEl ? findEl.value : '';
  if (resultEl) resultEl.textContent = '';
  if (!find) {
    if (resultEl) resultEl.textContent = 'Enter text to find.';
    return;
  }

  var transcript = document.getElementById('transcript-input');
  var notes = document.getElementById('session-notes-input');
  var boxes = [transcript, notes].filter(function(b) { return b; });
  if (!boxes.length) return;

  var startBox = _frLastBox && boxes.indexOf(_frLastBox) !== -1 ? _frLastBox : boxes[0];
  var order = [startBox];
  boxes.forEach(function(b) { if (b !== startBox) order.push(b); });

  var lower = find.toLowerCase();
  for (var i = 0; i < order.length; i++) {
    var box = order[i];
    var from = (box === startBox) ? (box.selectionEnd || 0) : 0;
    var idx = box.value.toLowerCase().indexOf(lower, from);
    if (idx === -1 && box === startBox) {
      idx = box.value.toLowerCase().indexOf(lower, 0);
    }
    if (idx !== -1) {
      box.focus();
      box.setSelectionRange(idx, idx + find.length);
      scrollTextareaToOffset(box, idx);
      _frLastBox = box;
      if (resultEl) resultEl.textContent = 'Found in ' +
        (box === transcript ? 'transcript' : 'notes') + '.';
      return;
    }
  }
  _frLastBox = null;
  if (resultEl) resultEl.textContent = 'No matches found.';
}

// Replace just the currently-highlighted match, then advance to the next.
function replaceOneSession() {
  var findEl = document.getElementById('fr-find');
  var replEl = document.getElementById('fr-replace');
  var resultEl = document.getElementById('fr-result');
  var find = findEl ? findEl.value : '';
  var repl = replEl ? replEl.value : '';
  if (!find) {
    if (resultEl) resultEl.textContent = 'Enter text to find.';
    return;
  }

  var box = _frLastBox;
  // If the current selection matches the find text, replace it; then find next.
  if (box) {
    var selStart = box.selectionStart;
    var selEnd = box.selectionEnd;
    var selected = box.value.substring(selStart, selEnd);
    if (selected.toLowerCase() === find.toLowerCase()) {
      box.value = box.value.substring(0, selStart) + repl + box.value.substring(selEnd);
      // Put the cursor right after the replacement so Find next moves on.
      box.setSelectionRange(selStart + repl.length, selStart + repl.length);
      if (resultEl) resultEl.textContent = 'Replaced one.';
      findNextSession();
      return;
    }
  }
  // Nothing suitable selected — just jump to the next match first.
  findNextSession();
}

// Find & replace across BOTH the transcript and the session notes at once.
// Use case: a character's name is wrong throughout — fix it in one shot.
function findReplaceSession() {
  var findEl = document.getElementById('fr-find');
  var replEl = document.getElementById('fr-replace');
  var resultEl = document.getElementById('fr-result');
  var find = findEl ? findEl.value : '';
  var repl = replEl ? replEl.value : '';
  if (resultEl) resultEl.textContent = '';

  if (!find) {
    if (resultEl) resultEl.textContent = 'Enter text to find.';
    return;
  }

  var transcript = document.getElementById('transcript-input');
  var notes = document.getElementById('session-notes-input');

  // Escape regex special chars so the find text is treated literally.
  var safe = find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  var rx = new RegExp(safe, 'g');

  var count = 0;
  [transcript, notes].forEach(function(box) {
    if (!box || !box.value) return;
    var matches = box.value.match(rx);
    if (matches) {
      count += matches.length;
      box.value = box.value.replace(rx, repl);
    }
  });

  if (resultEl) {
    resultEl.textContent = count === 0
      ? 'No matches found.'
      : 'Replaced ' + count + ' occurrence' + (count === 1 ? '' : 's') + '. Click Generate Story to save.';
  }
}


// ============================================================
// REVIEW TAB — storyboard outline + per-panel matched characters/assets
// ============================================================
function loadReview() {
  var empty = document.getElementById('review-empty');
  var content = document.getElementById('review-content');
  var list = document.getElementById('review-list');
  if (list) list.innerHTML = '<div class="form-hint">Loading review...</div>';

  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' +
        state.currentSession.id + '/review')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var panels = (data && data.panels) || [];
      if (!panels.length) {
        if (empty) empty.style.display = 'block';
        if (content) content.style.display = 'none';
        return;
      }
      if (empty) empty.style.display = 'none';
      if (content) content.style.display = 'block';
      renderReview(data);
    })
    .catch(function() {
      if (list) list.innerHTML = '<div class="alert alert-error">Could not load the review.</div>';
    });
}

function escapeHtmlReview(s) {
  return String(s || '').replace(/[&<>]/g, function(c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c];
  });
}

// Render the Review tab as the actual READING ORDER of the finished comic:
// opening narrative → panel → bridge narrative → panel → bridge → ... → closing.
// All narrative text shown is a TERSE SUMMARY (~10–25 words) of the actual
// prose — the storyboard and graphic novel show the real text. Old
// sessions (generated before summaries existed) fall back to truncated
// prose, so the tab never goes blank.
function renderReview(data) {
  var list = document.getElementById('review-list');
  if (!list) return;
  var ASSET_CAT = { location: 'Location', npc: 'NPC', item: 'Item' };
  var panels = (data && data.panels) || [];

  // Truncate prose to a fallback summary for older sessions.
  function fallback(text, words) {
    if (!text) return '';
    var w = String(text).trim().split(/\s+/);
    if (w.length <= words) return w.join(' ');
    return w.slice(0, words).join(' ') + '\u2026';
  }
  var intro = (data && data.intro_summary) || fallback(data && data.intro, 25);
  var outro = (data && data.outro_summary) || fallback(data && data.outro, 25);

  var html = '';

  // Opening narrative summary.
  if (intro) {
    html += '<div class="review-nar review-nar-open">' +
      '<div class="review-nar-label">Opening</div>' +
      '<div class="review-nar-text">' + escapeHtmlReview(intro) + '</div>' +
    '</div>';
  }

  // Interleave: panel, then the bridge narrative summary after it.
  panels.forEach(function(p, i) {
    var num = (typeof p.panel_order === 'number' ? p.panel_order : i) + 1;

    var chars = (p.characters || []).length
      ? (p.characters || []).map(function(n) {
          return '<span class="review-chip">' + escapeHtmlReview(n) + '</span>';
        }).join('')
      : '<span class="review-none">none matched</span>';

    var assets = (p.assets || []).length
      ? (p.assets || []).map(function(a) {
          return '<span class="review-chip review-chip-asset">' +
            escapeHtmlReview(a.name) + ' \u00b7 ' + (ASSET_CAT[a.category] || a.category) +
            '</span>';
        }).join('')
      : '<span class="review-none">none matched</span>';

    html += '<div class="review-panel">' +
      '<div class="review-panel-head">' +
        '<span class="review-panel-num">' + num + '</span>' +
        '<span class="review-panel-title">' + escapeHtmlReview(p.title || 'Untitled panel') + '</span>' +
      '</div>' +
      (p.snippet ? '<div class="review-snippet">' + escapeHtmlReview(p.snippet) + '</div>' : '') +
      '<div class="review-row"><span class="review-label">Characters:</span> ' + chars + '</div>' +
      '<div class="review-row"><span class="review-label">Assets:</span> ' + assets + '</div>' +
    '</div>';

    // Bridge summary AFTER this panel (omit on the last — outro handles it).
    if (p.bridge && i < panels.length - 1) {
      html += '<div class="review-nar review-nar-bridge">' +
        '<div class="review-nar-text">' + escapeHtmlReview(p.bridge) + '</div>' +
      '</div>';
    }
  });

  // Closing narrative summary.
  if (outro) {
    html += '<div class="review-nar review-nar-close">' +
      '<div class="review-nar-label">Closing</div>' +
      '<div class="review-nar-text">' + escapeHtmlReview(outro) + '</div>' +
    '</div>';
  }

  list.innerHTML = html;
}


// "Generate Storyboard Images" from the Review tab. The generation flow
// (progress bar, panel shimmer) lives on the Storyboard tab and targets
// its DOM — so switch there first, then run the same generate-all.
function generateFromReview() {
  switchSessionTab('storyboard');
  // Let the storyboard pane render before the generation code touches it.
  setTimeout(function() {
    if (typeof generateAllImages === 'function') generateAllImages();
  }, 60);
}

function switchSessionTab(tab) {
  var tabs = ['notes', 'characters', 'review', 'storyboard', 'export'];
  tabs.forEach(function(t) {
    var pane = document.getElementById('session-tab-' + t);
    if (pane) pane.style.display = t === tab ? 'block' : 'none';
    var el = document.getElementById('stab-' + t);
    if (el) el.classList.toggle('active', t === tab);
  });
  // Auto-load preview when switching to publish tab
  if (tab === 'export' && state.currentSession && state.layoutStyle) {
    loadPreview(state.layoutStyle);
  }
  // Load character snapshots when switching to the characters tab
  if (tab === 'characters') {
    loadSessionCharacters();
  }
  if (tab === 'review') {
    loadReview();
  }
}

// ============================================================
// CHARACTERS
// ============================================================
// ============================================================
// CAMPAIGN ASSET LIBRARY
// ============================================================
function loadAssets() {
  var grid = document.getElementById('asset-grid');
  fetch('/api/campaigns/' + state.currentCampaign.id + '/assets')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      state.assets = Array.isArray(data) ? data : [];
      renderAssets();
    })
    .catch(function() {
      state.assets = [];
      renderAssets();
    });
}

var ASSET_CAT_LABEL = { location: 'Location', npc: 'NPC', item: 'Item' };

function renderAssets() {
  var grid = document.getElementById('asset-grid');
  if (!grid) return;
  var cards = (state.assets || []).map(function(a) {
    var img = a.image_url
      ? '<img src="' + a.image_url + '" class="sc-thumb" alt="' + a.name + '" ' +
        'style="cursor:zoom-in;" onclick="openLightbox(this.src,this.alt)" />'
      : '<div class="sc-thumb sc-thumb-empty">&#127912;</div>';
    var cat = ASSET_CAT_LABEL[a.category] || 'Location';
    return '<div class="sc-card">' +
      '<div class="sc-card-head">' +
        img +
        '<div class="sc-card-id">' +
          '<div class="sc-card-name">' + a.name + '</div>' +
          '<div class="sc-card-cls">' + cat + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="char-prompt-actions">' +
        '<button class="btn btn-sm" onclick="openAssetModal(' + a.id + ')">&#9998; Edit</button>' +
        '<button class="btn btn-sm" onclick="deleteAsset(' + a.id + ')">&#10005; Delete</button>' +
      '</div>' +
    '</div>';
  }).join('');
  grid.innerHTML =
    '<div class="add-char-card" onclick="openAssetModal()">' +
      '<div class="plus">+</div><span>Add asset</span>' +
    '</div>' + cards;
}

function openAssetModal(assetId) {
  var modal = document.getElementById('asset-modal');
  var title = document.getElementById('asset-modal-title');
  var saveBtn = document.getElementById('asset-save-btn');
  var nameEl = document.getElementById('asset-name');
  var catEl = document.getElementById('asset-category');
  var fileEl = document.getElementById('asset-image');
  var errEl = document.getElementById('asset-modal-error');
  if (errEl) errEl.classList.add('hidden');
  if (fileEl) fileEl.value = '';

  // Reset the picked-file holder each time the modal opens.
  state.assetPickedFile = null;

  if (assetId) {
    var a = (state.assets || []).find(function(x) { return x.id === assetId; });
    if (!a) return;
    state.editingAssetId = assetId;
    if (title) title.textContent = 'Edit Asset';
    if (saveBtn) saveBtn.textContent = 'Save asset';
    if (nameEl) nameEl.value = a.name || '';
    if (catEl) catEl.value = a.category || 'location';
    setAssetPreview(a.image_url || null);
  } else {
    state.editingAssetId = null;
    if (title) title.textContent = 'Add Asset';
    if (saveBtn) saveBtn.textContent = 'Add asset';
    if (nameEl) nameEl.value = '';
    if (catEl) catEl.value = 'location';
    setAssetPreview(null);
  }
  if (modal) modal.classList.remove('hidden');
}

// Show an image in the drop zone (existing URL or a freshly picked file),
// or the empty prompt when there is none. A shown image is click-to-enlarge.
function setAssetPreview(src) {
  var empty = document.getElementById('asset-drop-empty');
  var preview = document.getElementById('asset-drop-preview');
  if (!empty || !preview) return;
  if (src) {
    preview.src = src;
    preview.style.display = 'block';
    empty.style.display = 'none';
    preview.onclick = function(e) {
      e.stopPropagation();
      openLightbox(preview.src, 'Asset image');
    };
  } else {
    preview.removeAttribute('src');
    preview.style.display = 'none';
    empty.style.display = 'flex';
    preview.onclick = null;
  }
}

// A file was picked or dropped — hold it and show a local preview.
function acceptAssetFile(file) {
  if (!file) return;
  if (!file.type || !file.type.match('image.*')) {
    var errEl = document.getElementById('asset-modal-error');
    if (errEl) { errEl.textContent = 'Please choose an image file.'; errEl.classList.remove('hidden'); }
    return;
  }
  state.assetPickedFile = file;
  setAssetPreview(URL.createObjectURL(file));
}

function handleAssetFileSelect(e) {
  if (e.target.files && e.target.files[0]) acceptAssetFile(e.target.files[0]);
}
function handleAssetDragOver(e) {
  e.preventDefault(); e.stopPropagation();
  var z = document.getElementById('asset-drop');
  if (z) z.classList.add('drag-over');
}
function handleAssetDragLeave(e) {
  e.preventDefault(); e.stopPropagation();
  var z = document.getElementById('asset-drop');
  if (z) z.classList.remove('drag-over');
}
function handleAssetDrop(e) {
  e.preventDefault(); e.stopPropagation();
  var z = document.getElementById('asset-drop');
  if (z) z.classList.remove('drag-over');
  var files = e.dataTransfer && e.dataTransfer.files;
  if (files && files[0]) acceptAssetFile(files[0]);
}

function closeAssetModal() {
  var modal = document.getElementById('asset-modal');
  if (modal) modal.classList.add('hidden');
  state.editingAssetId = null;
}

function saveAsset() {
  var nameEl = document.getElementById('asset-name');
  var catEl = document.getElementById('asset-category');
  var fileEl = document.getElementById('asset-image');
  var errEl = document.getElementById('asset-modal-error');
  var saveBtn = document.getElementById('asset-save-btn');
  var name = nameEl ? nameEl.value.trim() : '';

  if (!name) {
    if (errEl) { errEl.textContent = 'Asset name is required.'; errEl.classList.remove('hidden'); }
    return;
  }

  var fd = new FormData();
  fd.append('name', name);
  fd.append('category', catEl ? catEl.value : 'location');
  if (state.assetPickedFile) fd.append('image', state.assetPickedFile);

  var editing = state.editingAssetId;
  var url = '/api/campaigns/' + state.currentCampaign.id + '/assets' + (editing ? '/' + editing : '');
  var method = editing ? 'PUT' : 'POST';
  if (saveBtn) saveBtn.disabled = true;

  fetch(url, { method: method, body: fd })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (saveBtn) saveBtn.disabled = false;
      if (data && data.error) {
        if (errEl) { errEl.textContent = data.error; errEl.classList.remove('hidden'); }
        return;
      }
      closeAssetModal();
      loadAssets();
    })
    .catch(function() {
      if (saveBtn) saveBtn.disabled = false;
      if (errEl) { errEl.textContent = 'Could not save the asset.'; errEl.classList.remove('hidden'); }
    });
}

function deleteAsset(assetId) {
  if (!confirm('Delete this asset? This cannot be undone.')) return;
  fetch('/api/campaigns/' + state.currentCampaign.id + '/assets/' + assetId, { method: 'DELETE' })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data && data.error) { alert(data.error); return; }
      loadAssets();
    })
    .catch(function() { alert('Could not delete the asset.'); });
}


function loadCharacters() {
  fetch('/api/campaigns/' + state.currentCampaign.id + '/characters')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      state.characters = Array.isArray(data) ? data : [];
      renderCharacters();
    });
}

// ---- Canonical character prompt (shown in the Edit Character modal) ----
// Renders into the modal's prompt section. charId may be null for a new
// (unsaved) character — in which case the prompt can't be built yet.
function renderCharModalPrompt(char) {
  var body = document.getElementById('char-modal-prompt-body');
  if (!body) return;

  if (!char || !char.id) {
    body.innerHTML = '<div class="char-prompt-empty">Save the character first, then you can build its prompt from the images.</div>';
    return;
  }

  var canEdit = state.userTier && state.userTier.can_edit_prompts;
  var hasPrompt = char.canonical_prompt && char.canonical_prompt.trim();
  var inner = hasPrompt
    ? '<div class="char-prompt-text" id="char-prompt-text-' + char.id + '">' + char.canonical_prompt + '</div>'
    : '<div class="char-prompt-empty" id="char-prompt-text-' + char.id + '">No character prompt yet \u2014 build one from the card info and images.</div>';

  var buttons = '<button class="btn btn-sm" id="char-prompt-rebuild-' + char.id + '" ' +
    'onclick="rebuildCharPrompt(' + char.id + ')">&#10227; ' +
    (hasPrompt ? 'Rebuild prompt' : 'Build character prompt') + '</button>';
  if (canEdit && hasPrompt) {
    buttons += '<button class="btn btn-sm" onclick="startEditCharPrompt(' + char.id + ')">&#9998; Edit</button>';
  }

  // Reference image — the generated picture, shown full under the button.
  var refImg = char.canonical_reference_url
    ? '<div class="char-ref-image" id="char-ref-image-' + char.id + '">' +
        '<div class="char-ref-label">Reference image</div>' +
        '<img src="' + char.canonical_reference_url + '" alt="' + char.name + ' reference" ' +
        'onclick="openLightbox(this.src,this.alt)" title="Click to enlarge" />' +
      '</div>'
    : '<div class="char-ref-image" id="char-ref-image-' + char.id + '"></div>';

  body.innerHTML = inner + '<div class="char-prompt-actions">' + buttons + '</div>' + refImg;
}

function rebuildCharPrompt(charId) {
  var btn = document.getElementById('char-prompt-rebuild-' + charId);
  var textEl = document.getElementById('char-prompt-text-' + charId);
  if (btn) { btn.disabled = true; btn.textContent = 'Building...'; }

  // Show an animated indeterminate progress bar with cycling status text.
  // The build is a single vision API call with no real progress signal,
  // so we use an indeterminate bar (conveys activity without faking a %).
  if (textEl) {
    textEl.innerHTML =
      '<div id="char-build-status-' + charId + '" style="font-size:13px;margin-bottom:6px;color:#c9a84c;">Analyzing character and images\u2026</div>' +
      '<div style="height:6px;border-radius:4px;background:rgba(201,168,76,0.15);overflow:hidden;">' +
        '<div id="char-build-bar-' + charId + '" style="height:100%;width:30%;border-radius:4px;background:#c9a84c;' +
        'animation:charBuildSlide 1.2s ease-in-out infinite;"></div>' +
      '</div>';
  }
  ensureCharBuildKeyframes();

  // Cycle through status messages so it feels alive during the wait.
  var steps = [
    'Analyzing character and images\u2026',
    'Studying facial features and outfit\u2026',
    'Writing the canonical description\u2026',
    'Generating the reference image\u2026',
    'Almost there\u2026'
  ];
  var stepIdx = 0;
  var statusEl = document.getElementById('char-build-status-' + charId);
  var ticker = setInterval(function() {
    stepIdx++;
    if (stepIdx < steps.length && statusEl) statusEl.innerHTML = steps[stepIdx];
  }, 4000);

  fetch('/api/campaigns/' + state.currentCampaign.id + '/characters/' + charId + '/rebuild-prompt', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({})
  })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      clearInterval(ticker);
      if (data && data.success) {
        var ch = (state.characters || []).find(function(c) { return c.id === charId; });
        if (ch) {
          ch.canonical_prompt = data.canonical_prompt;
          ch.canonical_prompt_at = data.canonical_prompt_at;
          if (data.canonical_reference_url) ch.canonical_reference_url = data.canonical_reference_url;
          renderCharModalPrompt(ch);
        }
      } else {
        if (textEl) textEl.textContent = (data && data.error) || 'Could not build the prompt.';
        if (btn) { btn.disabled = false; btn.textContent = '\u21BB Rebuild prompt'; }
      }
    })
    .catch(function() {
      clearInterval(ticker);
      if (textEl) textEl.textContent = 'Could not build the prompt.';
      if (btn) { btn.disabled = false; btn.textContent = '\u21BB Rebuild prompt'; }
    });
}

// Inject the keyframes for the indeterminate build bar once.
function ensureCharBuildKeyframes() {
  if (document.getElementById('char-build-keyframes')) return;
  var style = document.createElement('style');
  style.id = 'char-build-keyframes';
  style.textContent =
    '@keyframes charBuildSlide {' +
    '  0% { margin-left: -30%; }' +
    '  100% { margin-left: 100%; }' +
    '}';
  document.head.appendChild(style);
}

function startEditCharPrompt(charId) {
  var body = document.getElementById('char-modal-prompt-body');
  var ch = (state.characters || []).find(function(c) { return c.id === charId; });
  if (!body || !ch) return;
  body.innerHTML =
    '<textarea class="char-prompt-editor" id="char-prompt-editor-' + charId + '">' +
      (ch.canonical_prompt || '') + '</textarea>' +
    '<div class="char-prompt-actions">' +
      '<button class="btn btn-sm btn-primary" onclick="saveCharPrompt(' + charId + ')">Save</button>' +
      '<button class="btn btn-sm" onclick="renderCharModalPrompt(charById(' + charId + '))">Cancel</button>' +
    '</div>';
}

function charById(id) {
  return (state.characters || []).find(function(c) { return c.id === id; }) || null;
}

function saveCharPrompt(charId) {
  var ta = document.getElementById('char-prompt-editor-' + charId);
  if (!ta) return;
  var newPrompt = ta.value;
  ta.disabled = true;
  fetch('/api/campaigns/' + state.currentCampaign.id + '/characters/' + charId + '/canonical-prompt', {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ canonical_prompt: newPrompt })
  })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data && data.success) {
        var ch = (state.characters || []).find(function(c) { return c.id === charId; });
        if (ch) ch.canonical_prompt = newPrompt;
        renderCharModalPrompt(ch);
      } else {
        ta.disabled = false;
        alert((data && data.error) || 'Could not save.');
      }
    })
    .catch(function() { ta.disabled = false; alert('Could not save.'); });
}

function renderCharacters() {
  var colors = ['#EEEDFE','#E1F5EE','#FAECE7','#E6F1FB','#FAEEDA'];
  var fgs = ['#534AB7','#0F6E56','#993C1D','#185FA5','#854F0B'];
  var html = state.characters.map(function(c, i) {
    var initials = c.name.split(' ').map(function(w){return w[0];}).join('').slice(0,2).toUpperCase();
    var bg = colors[i % colors.length];
    var fg = fgs[i % fgs.length];
    // Canonical reference image is the preferred thumbnail (Stage 3 Piece 2).
    var refImg = c.canonical_reference_url;
    var primaryImg = refImg || c.image_portrait || c.image_fullbody || c.image_action || c.image_other || c.image;
    var imgPos = refImg ? 'center top' : 'center center';
    var portrait = primaryImg
      ? '<img src="' + primaryImg + '" style="width:100%;height:100%;object-fit:cover;object-position:' + imgPos + ';cursor:zoom-in;" alt="' + c.name + '" onclick="openLightbox(this.src,this.alt)" title="Click to enlarge" />'
      : '<span style="font-size:15px;font-weight:600;color:' + fg + ';">' + initials + '</span>';
    // Just show portrait on card - clean and simple
    var imgGridHtml = '';

    return '<div class="char-card char-card-drop" id="char-card-' + c.id + '">' +
      '<div class="char-card-header">' +
        '<div class="char-avatar" style="background:' + bg + ';">' + portrait + '</div>' +
        '<div class="char-actions">' +
          '<button class="char-btn" onclick="openCharModal(' + c.id + ')">Edit</button>' +
          '<button class="char-btn char-btn-delete" onclick="deleteChar(' + c.id + ')">Delete</button>' +
        '</div>' +
      '</div>' +
      '<div class="char-name">' + c.name + '</div>' +
      (c.player_name ? '<div class="char-player">Played by ' + c.player_name + '</div>' : '') +
      '<div class="char-desc">' + (c.description || '') + '</div>' +
      '<span class="char-badge">' + (c.cls || '') + '</span>' +
      ((c.is_npc === true || c.is_npc === 1 || c.is_npc === '1') ? '<span class="char-badge char-badge-npc">NPC</span>' : '') +
      imgGridHtml +
    '</div>';
  }).join('');
  html += '<div class="add-char-card" onclick="openCharModal()"><div class="plus">+</div><span>Add character</span></div>';
  document.getElementById('char-grid').innerHTML = html;
  setupCardDragDrop();
}

function openCharModal(editId) {
  var char = editId ? state.characters.find(function(c){return c.id===editId;}) : null;
  document.getElementById('char-edit-id').value = editId || '';
  document.getElementById('char-modal-title').textContent = editId ? 'Edit Character' : 'Add Character';
  document.getElementById('char-name').value = char ? char.name : '';
  document.getElementById('char-player').value = char ? (char.player_name || '') : '';
  document.getElementById('char-cls').value = char ? (char.cls || '') : '';
  document.getElementById('char-desc').value = char ? (char.description || '') : '';
  var npcEl = document.getElementById('char-is-npc');
  if (npcEl) npcEl.checked = !!(char && (char.is_npc === true || char.is_npc === 1 || char.is_npc === '1'));
  loadSlotPreviews(char);
  renderCharModalPrompt(char);
  var oldNudge = document.getElementById('char-prompt-nudge');
  if (oldNudge) oldNudge.remove();
  document.getElementById('char-modal-error').classList.add('hidden');
  document.getElementById('char-modal').classList.remove('hidden');
}

function closeCharModal() { document.getElementById('char-modal').classList.add('hidden'); }

function previewCharImage() {
  var input = document.getElementById('char-image-input');
  var preview = document.getElementById('char-image-preview');
  if (input.files && input.files[0]) {
    var reader = new FileReader();
    reader.onload = function(e) { preview.src = e.target.result; preview.style.display = 'block'; };
    reader.readAsDataURL(input.files[0]);
  }
}

function saveChar() {
  var name = document.getElementById('char-name').value.trim();
  var player = document.getElementById('char-player').value.trim();
  var cls = document.getElementById('char-cls').value.trim();
  var desc = document.getElementById('char-desc').value.trim();
  var editId = document.getElementById('char-edit-id').value;
  if (!name) { showModalError('char-modal-error', 'Character name is required.'); return; }

  var formData = new FormData();
  formData.append('name', name);
  formData.append('player_name', player);
  formData.append('cls', cls || 'Adventurer');
  formData.append('description', desc);
  var npcEl = document.getElementById('char-is-npc');
  formData.append('is_npc', (npcEl && npcEl.checked) ? 'true' : 'false');

  // Append all slot files
  var slots = ['image_portrait', 'image_fullbody', 'image_action', 'image_other'];
  slots.forEach(function(slot) {
    if (slotFiles[slot]) {
      formData.append(slot, slotFiles[slot]);
    }
    if (slotFiles[slot + '_clear']) {
      formData.append('clear_' + slot, 'true');
    }
  });

  var url = editId
    ? '/api/campaigns/' + state.currentCampaign.id + '/characters/' + editId
    : '/api/campaigns/' + state.currentCampaign.id + '/characters';

  fetch(url, {method: editId ? 'PUT' : 'POST', body: formData})
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.error) { showModalError('char-modal-error', data.error); return; }

      // If this was a NEW character that has no prompt yet, DON'T close —
      // the "Build character prompt" step is only available once the
      // character exists, so closing here would force a save-and-reopen.
      // Instead, transition the open dialog into edit mode for the just-
      // created character, reveal the Build button, and guide the user.
      var wasNew = !editId;
      var newChar = data && data.id ? data : null;
      var needsPrompt = newChar && !(newChar.canonical_prompt && String(newChar.canonical_prompt).trim());

      if (wasNew && newChar && needsPrompt) {
        // Make the new character available to the rest of the UI.
        loadCharacters();
        // Switch the dialog from "Add" to "Edit" mode in place.
        document.getElementById('char-edit-id').value = newChar.id;
        document.getElementById('char-modal-title').textContent = 'Edit Character';
        document.getElementById('char-modal-error').classList.add('hidden');
        // Re-render the prompt section so the Build button appears.
        renderCharModalPrompt(newChar);
        // Guided nudge: point the user at the now-available build step.
        showCharPromptNudge();
        return;
      }

      closeCharModal();
      loadCharacters();
    });
}

// Inline guided nudge shown after a new character is first saved, telling
// the user the next step (building the character prompt) is now available.
function showCharPromptNudge() {
  var body = document.getElementById('char-modal-prompt-body');
  if (!body) return;
  var existing = document.getElementById('char-prompt-nudge');
  if (existing) existing.remove();
  var nudge = document.createElement('div');
  nudge.id = 'char-prompt-nudge';
  nudge.style.cssText = 'margin:8px 0;padding:8px 12px;border-radius:6px;font-size:13px;' +
    'background:rgba(15,110,86,0.25);border:1px solid rgba(134,212,186,0.4);color:#86d4ba;';
  nudge.innerHTML = '&#10003; Character saved. Now build its character prompt below \u2014 ' +
    'this is what keeps the character looking consistent across your panels. ' +
    'You can close this window when you\u2019re done.';
  body.parentNode.insertBefore(nudge, body);
}

function deleteChar(id) {
  var char = state.characters.find(function(c){return c.id===id;});
  if (!confirm('Delete ' + (char ? char.name : 'this character') + '?')) return;
  fetch('/api/campaigns/' + state.currentCampaign.id + '/characters/' + id, {method:'DELETE'})
    .then(function() { loadCharacters(); });
}

// ============================================================
// EXTRACT MOMENTS
// ============================================================
function selStyle(el, style) {
  document.querySelectorAll('.style-row .chip').forEach(function(c){c.classList.remove('sel');});
  el.classList.add('sel');
  state.artStyle = style;

  if (state.currentSession && state.currentCampaign) {
    fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' + state.currentSession.id, {
      method: 'PUT',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({art_style: style})
    }).catch(function() {});
  }
}

function selLayout(el, layout) {
  document.querySelectorAll('#session-tab-export .chip').forEach(function(c){c.classList.remove('sel');});
  el.classList.add('sel');
  state.layoutStyle = layout;

  // Save to session
  if (state.currentSession && state.currentCampaign) {
    fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' + state.currentSession.id, {
      method: 'PUT',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({layout_style: layout})
    }).catch(function() {});
  }

  // Always show preview when layout is selected
  loadPreview(layout);
}

function loadPreview(layout) {
  var loading = document.getElementById('session-preview-loading');
  var iframe = document.getElementById('session-preview-iframe');
  if (!iframe) return;

  var url = '/api/pdf/session/' + state.currentCampaign.id + '/' + state.currentSession.id +
    '?layout=' + encodeURIComponent(layout || state.layoutStyle || 'Classic');

  // Show loading state
  if (loading) loading.style.display = 'flex';
  iframe.style.display = 'none';
  iframe.src = '';

  // Load new preview
  iframe.onload = function() {
    if (loading) loading.style.display = 'none';
    iframe.style.display = 'block';
    resizePreviewIframe();
  };
  iframe.src = url;
}

// Grow the preview iframe to the full height of its content so there is
// no inner scrollbar — the user scrolls only the outer page.
function resizePreviewIframe() {
  var iframe = document.getElementById('session-preview-iframe');
  var frame = document.getElementById('session-preview-frame');
  if (!iframe) return;
  try {
    var doc = iframe.contentDocument || iframe.contentWindow.document;
    if (!doc || !doc.body) return;
    // Take the largest of several height measures to be safe across layouts
    var h = Math.max(
      doc.body.scrollHeight, doc.documentElement.scrollHeight,
      doc.body.offsetHeight, doc.documentElement.offsetHeight
    );
    if (h > 0) {
      iframe.style.height = h + 'px';
      if (frame) frame.style.height = 'auto';
    }
  } catch (e) {
    // If measurement fails for any reason, leave the iframe as-is
  }
}

// Re-measure on window resize — content reflow can change the height
window.addEventListener('resize', function() {
  var iframe = document.getElementById('session-preview-iframe');
  if (iframe && iframe.style.display !== 'none' && iframe.src) {
    resizePreviewIframe();
  }
});

// Map a layout value (including legacy names) to its chip id suffix
function layoutChipKey(layout) {
  var legacy = { cinematic: 'comicbook', dramatic: 'action' };
  var k = (layout || 'Classic').toLowerCase();
  return legacy[k] || k;
}

function applyLayoutStyle(layout) {
  state.layoutStyle = layout || 'Classic';
  document.querySelectorAll('#session-tab-export .chip').forEach(function(c){c.classList.remove('sel');});
  var el = document.getElementById('layout-' + layoutChipKey(layout));
  if (el) el.classList.add('sel');
}

function extractMoments() {
  var key = getApiKey();
  var transcript = document.getElementById('transcript-input').value.trim();
  var errorEl = document.getElementById('extract-error');
  errorEl.classList.add('hidden');

  if (transcript.length < 50) {
    errorEl.textContent = 'Please paste a longer transcript first.';
    errorEl.classList.remove('hidden');
    return;
  }

  // Warn before overwriting an existing storyboard
  if (state.moments && state.moments.length) {
    if (!confirm('This session already has a storyboard with ' + state.moments.length +
        ' panel' + (state.moments.length === 1 ? '' : 's') +
        '. Generating again will replace it — existing panels, narrative, and images will be lost. ' +
        'The character snapshots for this session will also be rebuilt. Continue?')) {
      return;
    }
  }

  // Auto save notes AND transcript
  var notesVal = document.getElementById('session-notes-input');
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' + state.currentSession.id, {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({
      transcript: transcript,
      session_notes: notesVal ? notesVal.value.trim() : ''
    })
  });

  var btn = document.getElementById('extract-btn');
  var wrap = document.getElementById('progress-wrap');
  var fill = document.getElementById('progress-fill');
  var msg = document.getElementById('progress-msg');

  btn.disabled = true;
  wrap.style.display = 'block';
  fill.style.width = '5%';
  msg.textContent = 'Reading your session transcript...';

  var pct = 5;
  var ticker = setInterval(function() {
    pct = Math.min(pct + Math.random() * 6, 88);
    fill.style.width = pct + '%';
  }, 400);

  fetch('/api/extract/' + state.currentCampaign.id + '/' + state.currentSession.id, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({key:key, artStyle:state.artStyle})
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    clearInterval(ticker);
    if (data.error) {
      errorEl.textContent = 'Error: ' + data.error;
      errorEl.classList.remove('hidden');
      wrap.style.display = 'none';
      btn.disabled = false;
      return;
    }
    fill.style.width = '60%';
    msg.textContent = 'Moments found! Writing your narrative...';
    state.moments = data.moments || [];
    state.pendingChanges = data.pendingChanges || 0;

    // Step 2 — Generate narrative then render everything together
    fetch('/api/narrative/generate/' + state.currentCampaign.id + '/' + state.currentSession.id, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({key: key})
    })
    .then(function(r) { return r.json(); })
    .then(function(narData) {
      // Set narrative BEFORE rendering storyboard
      state.narrativeData = {
        intro: narData.intro || '',
        sections: narData.sections || [],
        outro: narData.outro || ''
      };
      fill.style.width = '100%';
      msg.textContent = 'Your story is ready!';
      document.getElementById('moment-count').textContent = state.moments.length;
      renderStoryboard();
      setTimeout(function() {
        wrap.style.display = 'none';
        fill.style.width = '0%';
        btn.disabled = false;
        // If character changes were detected, send the DM to the
        // Characters tab to review them; otherwise go to Storyboard.
        if (state.pendingChanges && state.pendingChanges > 0) {
          switchSessionTab('characters');
        } else {
          // Land on Review so the DM can check the storyboard plan
          // before spending image-generation calls.
          switchSessionTab('review');
        }
      }, 800);
    })
    .catch(function() {
      // Narrative failed — still show storyboard with empty narrative
      state.narrativeData = { intro: '', sections: [], outro: '' };
      fill.style.width = '100%';
      msg.textContent = 'Moments extracted!';
      document.getElementById('moment-count').textContent = state.moments.length;
      renderStoryboard();
      setTimeout(function() {
        wrap.style.display = 'none';
        fill.style.width = '0%';
        btn.disabled = false;
        // If character changes were detected, send the DM to the
        // Characters tab to review them; otherwise go to Storyboard.
        if (state.pendingChanges && state.pendingChanges > 0) {
          switchSessionTab('characters');
        } else {
          // Land on Review so the DM can check the storyboard plan
          // before spending image-generation calls.
          switchSessionTab('review');
        }
      }, 800);
    });
  })
  .catch(function(e) {
    clearInterval(ticker);
    wrap.style.display = 'none';
    btn.disabled = false;
    errorEl.textContent = 'Connection error: ' + e.message;
    errorEl.classList.remove('hidden');
  });
}


// Auto-save narrative with debounce — saves 1.5 seconds after user stops typing
var narrativeSaveTimer = null;
function scheduleNarrativeSave() {
  if (narrativeSaveTimer) clearTimeout(narrativeSaveTimer);
  narrativeSaveTimer = setTimeout(function() {
    saveInlineNarrative(true); // true = silent save
  }, 1500);
}

function collectNarrativeState() {
  var intro = document.getElementById('narrative-intro-box');
  var outro = document.getElementById('narrative-outro-box');
  var sections = state.moments.slice(0, -1).map(function(m, i) {
    var box = document.getElementById('narrative-between-box-' + i);
    return { panel_index: i, before: '', after: box ? box.value.trim() : '' };
  });
  return {
    intro: intro ? intro.value.trim() : '',
    sections: sections,
    outro: outro ? outro.value.trim() : ''
  };
}

function saveNarrativeSection(type, panelIndex) {
  var data = collectNarrativeState();

  fetch('/api/narrative/save/' + state.currentCampaign.id + '/' + state.currentSession.id, {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify(data)
  })
  .then(function(r) { return r.json(); })
  .then(function(result) {
    if (result.error) { showAlert('Error: ' + result.error); return; }
    state.narrativeData = data;
    // Show brief saved indicator on the button
    var btnId = type === 'intro' ? 'narrative-opening'
      : type === 'outro' ? 'narrative-closing'
      : 'narrative-between-' + panelIndex;
    var block = document.getElementById(btnId);
    if (block) {
      var btn = block.querySelector('.narrative-save-btn');
      if (btn) {
        var orig = btn.textContent;
        btn.textContent = '✓ Saved!';
        btn.style.color = '#5dcaa5';
        setTimeout(function() { btn.textContent = orig; btn.style.color = ''; }, 1500);
      }
    }
  });
}

function saveInlineNarrative(silent) {
  var data = collectNarrativeState();
  fetch('/api/narrative/save/' + state.currentCampaign.id + '/' + state.currentSession.id, {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify(data)
  })
  .then(function(r) { return r.json(); })
  .then(function(result) {
    if (result.error) { if (!silent) showAlert('Error: ' + result.error); return; }
    state.narrativeData = data;
    if (!silent) showAlert('Narrative saved!');
  });
}

function regenNarrativeSection(type, panelIndex) {
  var key = getApiKey() || 'platform';  // Platform key used server-side

  // Save current state first
  saveInlineNarrative();

  // Show loading in the specific box
  var boxId = type === 'opening' ? 'narrative-intro-box'
    : type === 'closing' ? 'narrative-outro-box'
    : 'narrative-between-box-' + panelIndex;

  var box = document.getElementById(boxId);
  if (box) {
    box.value = 'Regenerating...';
    box.disabled = true;
  }

  // Regenerate full narrative and extract the relevant section
  fetch('/api/narrative/generate/' + state.currentCampaign.id + '/' + state.currentSession.id, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({key: key})
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.error) {
      if (box) { box.value = ''; box.disabled = false; }
      showAlert('Error: ' + data.error);
      return;
    }

    state.narrativeData = {
      intro: data.intro || '',
      sections: data.sections || [],
      outro: data.outro || ''
    };

    if (box) box.disabled = false;

    // Update just the relevant box
    if (type === 'opening' && box) box.value = data.intro || '';
    else if (type === 'closing' && box) box.value = data.outro || '';
    else if (type === 'between' && box) {
      var section = (data.sections||[]).find(function(s){return s.panel_index===panelIndex;});
      box.value = section ? (section.after || '') : '';
    }
  })
  .catch(function(e) {
    if (box) { box.value = ''; box.disabled = false; }
    showAlert('Error: ' + e.message);
  });
}

// Re-fetch the current session from the server and re-render the storyboard
// in place. Used after image generation so new images appear without a reload.
function refreshStoryboardImages() {
  if (!state.currentCampaign || !state.currentSession) return;
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' + state.currentSession.id)
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data || data.error) return;
      state.currentSession = data;
      state.moments = data.moments || [];
      renderStoryboard();
      if (typeof renderNovelWithImages === 'function') renderNovelWithImages();
    })
    .catch(function(){});
}

function generateAllImages() {
  var falKey = getFalKey() || 'platform';
  document.getElementById('generate-error').classList.add('hidden');

  // Warn if images already exist
  var hasImages = state.moments && state.moments.some(function(m) { return m.image; });
  if (hasImages) {
    if (!confirm('This will replace all existing panel images. Are you sure?')) {
      return;
    }
  }

  var btn = document.getElementById('generate-all-btn');
  var progressWrap = document.getElementById('generate-progress');
  var fill = document.getElementById('gen-progress-fill');
  var msg = document.getElementById('gen-progress-msg');

  btn.disabled = true;
  progressWrap.style.display = 'block';
  fill.style.width = '5%';
  msg.textContent = 'Generating ' + state.moments.length + ' images with Flux AI...';

  // Show shimmer on all panels
  state.moments.forEach(function(m) {
    var card = document.getElementById('moment-card-' + m.id);
    if (card) {
      var imgArea = card.querySelector('.moment-img, .moment-img-generated');
      if (imgArea) {
        imgArea.outerHTML = '<div class="moment-img-shimmer"><div class="moment-img-shimmer-text">&#10024; Generating...</div></div>';
      }
    }
  });

  fetch('/api/images/generate-all', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({
      session_id: state.currentSession.id,
      campaign_id: state.currentCampaign.id,
      style: state.artStyle,
      fal_key: falKey
    })
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.error) {
      // INSUFFICIENT_TOKENS carries a friendly message; show that.
      var emsg = (data.error === 'INSUFFICIENT_TOKENS' && data.message) ? data.message : ('Error: ' + data.error);
      document.getElementById('generate-error').textContent = emsg;
      document.getElementById('generate-error').classList.remove('hidden');
      btn.disabled = false;
      progressWrap.style.display = 'none';
      return;
    }

    fill.style.width = '100%';
    msg.textContent = data.count + ' of ' + data.total + ' images generated!';

    // Tokens were spent — update the header balance.
    if (typeof refreshTokenBalance === 'function') refreshTokenBalance();

    // Re-fetch the session fresh from the database so the storyboard
    // shows the newly generated images reliably (stays on this tab).
    refreshStoryboardImages();

    setTimeout(function() {
      btn.disabled = false;
      progressWrap.style.display = 'none';
      fill.style.width = '0%';
    }, 2000);
  })
  .catch(function(e) {
    document.getElementById('generate-error').textContent = 'Error: ' + e.message;
    document.getElementById('generate-error').classList.remove('hidden');
    btn.disabled = false;
    progressWrap.style.display = 'none';
  });
}

function regenImage(momentId, index) {
  var falKey = getFalKey() || 'platform';

  var moment = state.moments.find(function(m) { return m.id === momentId; });
  if (!moment) return;

  // Show shimmer on this card
  var card = document.getElementById('moment-card-' + momentId);
  if (card) {
    var imgArea = card.querySelector('.moment-img, .moment-img-generated, .moment-img-shimmer');
    if (imgArea) {
      imgArea.outerHTML = '<div class="moment-img-shimmer"><div class="moment-img-shimmer-text">&#10024; Regenerating...</div></div>';
    }
  }

  fetch('/api/images/generate-moment', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({
      moment_id: momentId,
      session_id: state.currentSession.id,
      campaign_id: state.currentCampaign.id,
      prompt: moment.prompt,
      style: state.artStyle,
      fal_key: falKey
    })
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.error) {
      var emsg = (data.error === 'INSUFFICIENT_TOKENS' && data.message) ? data.message : ('Error: ' + data.error);
      showAlert(emsg); renderStoryboard(); return;
    }
    moment.image = data.image_url;
    // A token was spent — update the header balance.
    if (typeof refreshTokenBalance === 'function') refreshTokenBalance();
    renderStoryboard();
    renderNovelWithImages();
  })
  .catch(function(e) { showAlert('Error: ' + e.message); renderStoryboard(); });
}

// ============================================================
// GRAPHIC NOVEL
// ============================================================
var novelLayoutStyle = 'Classic';

function switchNovelTab(tab) {
  ['sessions', 'preview'].forEach(function(t) {
    var pane = document.getElementById('novel-tab-' + t);
    if (pane) pane.style.display = t === tab ? 'block' : 'none';
    var el = document.getElementById('ntab-' + t);
    if (el) el.classList.toggle('active', t === tab);
  });
}

function selNovelLayout(el, layout) {
  document.querySelectorAll('#novel-tab-preview .chip').forEach(function(c){c.classList.remove('sel');});
  el.classList.add('sel');
  novelLayoutStyle = layout;
  loadNovelPreview(layout);
}

function loadNovelPreview(layout) {
  var loading = document.getElementById('novel-preview-loading');
  var iframe = document.getElementById('novel-preview-iframe');
  if (!iframe) return;

  if (layout) novelLayoutStyle = layout;

  // Build/refresh the session pager
  setupNovelPager();

  var total = (state.novelSessions || []).length;
  var url = '/api/pdf/novel/' + state.currentCampaign.id +
    '?layout=' + encodeURIComponent(novelLayoutStyle);
  // Paginate by session whenever there is more than one session
  if (total > 1) {
    url += '&page=' + novelPreviewPage;
  }

  if (loading) loading.style.display = 'flex';
  iframe.style.display = 'none';
  iframe.src = '';

  iframe.onload = function() {
    if (loading) loading.style.display = 'none';
    iframe.style.display = 'block';
    resizeNovelPreviewIframe();
  };
  iframe.src = url;
}

// ---- Novel preview pager ----
var novelPreviewPage = 1;

function setupNovelPager() {
  var warning = document.getElementById('novel-preview-warning');
  var sessions = state.novelSessions || [];
  var total = sessions.length;

  // Both pager bars: top and bottom. Suffix '' = top, '-bottom' = bottom.
  var suffixes = ['', '-bottom'];

  // Only show the pagers when there is more than one session
  if (total <= 1) {
    suffixes.forEach(function(sx) {
      var p = document.getElementById('novel-pager' + sx);
      if (p) p.style.display = 'none';
    });
    if (warning) warning.style.display = 'none';
    novelPreviewPage = 1;
    return;
  }

  // Clamp current page into range
  if (novelPreviewPage < 1) novelPreviewPage = 1;
  if (novelPreviewPage > total) novelPreviewPage = total;

  // Build dropdown options once, reuse for both bars
  var opts = '';
  for (var i = 0; i < total; i++) {
    var nm = sessions[i] && sessions[i].name ? sessions[i].name : ('Session ' + (i+1));
    var label = 'Session ' + (i+1) + ' of ' + total + '  —  ' + nm;
    opts += '<option value="' + (i+1) + '"' + ((i+1) === novelPreviewPage ? ' selected' : '') + '>' +
      label + '</option>';
  }

  suffixes.forEach(function(sx) {
    var pager = document.getElementById('novel-pager' + sx);
    if (!pager) return;
    var select = document.getElementById('novel-pager-select' + sx);
    if (select) select.innerHTML = opts;
    var prev = document.getElementById('novel-pager-prev' + sx);
    var next = document.getElementById('novel-pager-next' + sx);
    if (prev) prev.disabled = (novelPreviewPage <= 1);
    if (next) next.disabled = (novelPreviewPage >= total);
    pager.style.display = 'flex';
  });

  if (warning) warning.style.display = total > 15 ? 'block' : 'none';
}

// Scroll the preview area back to the top after navigating
// Find the nearest ancestor of `el` that actually has a vertical scrollbar.
function findScrollParent(el) {
  var node = el ? el.parentElement : null;
  while (node) {
    var style = window.getComputedStyle(node);
    var oy = style.overflowY;
    if ((oy === 'auto' || oy === 'scroll') && node.scrollHeight > node.clientHeight + 2) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

function scrollNovelPreviewToTop() {
  var anchor = document.getElementById('novel-pager') ||
               document.getElementById('novel-preview-frame');
  if (!anchor) { console.log('[pager-scroll] no anchor element found'); return; }

  function doScroll(label) {
    var scroller = findScrollParent(anchor);
    if (scroller) {
      var aRect = anchor.getBoundingClientRect();
      var sRect = scroller.getBoundingClientRect();
      var target = Math.max(0, scroller.scrollTop + (aRect.top - sRect.top) - 12);
      // Instant jump — a smooth scroll gets interrupted by the iframe resize.
      scroller.scrollTop = target;
      console.log('[pager-scroll ' + label + '] scrolled', scroller.className || scroller.tagName,
        'to', target);
    } else {
      // No scrollable ancestor found — fall back to window + documentElement.
      var rect = anchor.getBoundingClientRect();
      var top = Math.max(0, rect.top + (window.pageYOffset || 0) - 12);
      window.scrollTo(0, top);
      document.documentElement.scrollTop = top;
      document.body.scrollTop = top;
      console.log('[pager-scroll ' + label + '] no scroll parent — used window, top', top);
    }
  }

  // Scroll now, then re-assert after the iframe reloads/resizes the page.
  doScroll('immediate');
  setTimeout(function() { doScroll('settle-1'); }, 120);
  setTimeout(function() { doScroll('settle-2'); }, 500);
}

function novelPageJump(value) {
  var n = parseInt(value, 10);
  if (isNaN(n)) return;
  novelPreviewPage = n;
  loadNovelPreview(novelLayoutStyle);
  scrollNovelPreviewToTop();
}

function novelPagePrev() {
  if (novelPreviewPage > 1) {
    novelPreviewPage--;
    loadNovelPreview(novelLayoutStyle);
    scrollNovelPreviewToTop();
  }
}

function novelPageNext() {
  var total = (state.novelSessions || []).length;
  if (novelPreviewPage < total) {
    novelPreviewPage++;
    loadNovelPreview(novelLayoutStyle);
    scrollNovelPreviewToTop();
  }
}

// Grow the novel preview iframe to the full height of its content so there
// is no inner scrollbar — the user scrolls only the outer page.
function resizeNovelPreviewIframe() {
  var iframe = document.getElementById('novel-preview-iframe');
  var frame = document.getElementById('novel-preview-frame');
  if (!iframe) return;
  try {
    var doc = iframe.contentDocument || iframe.contentWindow.document;
    if (!doc || !doc.body) return;
    var h = Math.max(
      doc.body.scrollHeight, doc.documentElement.scrollHeight,
      doc.body.offsetHeight, doc.documentElement.offsetHeight
    );
    if (h > 0) {
      iframe.style.height = h + 'px';
      if (frame) frame.style.height = 'auto';
    }
  } catch (e) {
    // If measurement fails for any reason, leave the iframe as-is
  }
}

// Re-measure novel preview on window resize
window.addEventListener('resize', function() {
  var iframe = document.getElementById('novel-preview-iframe');
  if (iframe && iframe.style.display !== 'none' && iframe.src) {
    resizeNovelPreviewIframe();
  }
});

function previewNovelPDF() {
  novelPreviewPage = 1;
  switchNovelTab('preview');
  loadNovelPreview(novelLayoutStyle);
}

function exportNovelPDF() {
  var url = '/api/pdf/novel/' + state.currentCampaign.id + '?layout=' + encodeURIComponent(novelLayoutStyle);
  var win = window.open(url, '_blank');
  setTimeout(function() { if (win) win.print(); }, 5000);
}

function loadNovelSummary() {
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/novel/all')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      // Sort ascending by date (oldest first) using a normalized YYYY-MM-DD key
      var sessions = Array.isArray(data) ? data : [];
      function sessionDateKey(s) {
        if (!s.session_date) return '';
        if (typeof s.session_date === 'string') return s.session_date.split('T')[0];
        try { return s.session_date.toISOString().split('T')[0]; }
        catch (e) { return String(s.session_date); }
      }
      sessions.sort(function(a, b) {
        return sessionDateKey(a).localeCompare(sessionDateKey(b));
      });
      renderNovelSummary(sessions);
    });
}

function renderNovelSummary(sessions) {

  // Keep the ordered session list available for the preview pager
  state.novelSessions = sessions || [];

  var container = document.getElementById('novel-summary-list');
  if (!sessions.length) {
    container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">&#128213;</div>' +
      '<h3>No sessions yet</h3><p>Create sessions and extract moments to build your graphic novel</p></div>';
    return;
  }

  var totalMoments = 0;
  var html = sessions.map(function(s, i) {
    var moments = s.moments || [];
    totalMoments += moments.length;
    var momentsHtml = moments.length
      ? '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;padding:10px 14px;">' +
        moments.map(function(m, j) {
          return '<div style="position:relative;border-radius:6px;overflow:hidden;background:rgba(15,10,5,0.6);border:1px solid rgba(201,168,76,0.1);">' +
            (m.image
              ? '<img src="' + m.image + '" style="width:100%;aspect-ratio:4/3;object-fit:cover;display:block;cursor:zoom-in;" onclick="openLightbox(this.src,this.alt)" alt="' + m.title + '" />'
              : '<div style="width:100%;aspect-ratio:4/3;display:flex;align-items:center;justify-content:center;font-size:20px;opacity:0.2;">&#128444;</div>') +
            '<div style="padding:5px 7px;">' +
              '<div style="font-size:9px;color:rgba(201,168,76,0.4);">Panel ' + (j+1) + '</div>' +
              '<div style="font-size:10px;color:var(--gold-light);font-weight:600;line-height:1.3;">' + m.title + '</div>' +
            '</div>' +
          '</div>';
        }).join('') + '</div>'
      : '<div class="novel-empty">No moments extracted yet — open this session to generate storyboard panels</div>';

    return '<div class="novel-session-block">' +
      '<div class="novel-session-header">' +
        '<div><div class="novel-session-title">Session ' + (i+1) + ' &mdash; ' + s.name + '</div>' +
        '<div class="novel-session-date">' + formatSessionDate(s.session_date) + '</div></div>' +
        '<span class="session-badge' + (moments.length?'':' empty') + '">' + moments.length + ' panels</span>' +
      '</div>' +
      '<div class="novel-session-moments">' + momentsHtml + '</div>' +
    '</div>';
  }).join('');

  container.innerHTML = '<div style="font-size:12px;color:rgba(201,168,76,0.5);margin-bottom:14px;">' +
    sessions.length + ' sessions in chronological order &middot; ' + totalMoments + ' total panels</div>' + html;
}

function showNovelPreview() {
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/novel/all')
    .then(function(r) { return r.json(); })
    .then(function(data) { renderNovelPreview(Array.isArray(data) ? data : []); });
}

function renderNovelWithImages() {
  // Re-render novel panels for current session with updated images
  if (!state.moments.length) return;
  var panels = document.getElementById('novel-panels');
  if (panels) {
    panels.innerHTML = state.moments.map(function(m, i) {
      var wide = (i === 0 || i === Math.floor(state.moments.length / 2));
      var imgContent = m.image
        ? '<img src="' + m.image + '" style="width:100%;height:100%;object-fit:cover;cursor:zoom-in;" alt="' + m.title + '" onclick="openLightbox(this.src,this.alt)" title="Click to enlarge" />'
        : '<div class="novel-panel-inner"><div style="font-size:20px;margin-bottom:4px;">&#128444;</div>' + m.title + '</div>';
      return '<div class="novel-panel' + (wide ? ' wide' : '') + '">' +
        imgContent +
        '<div class="novel-caption">' + m.description + '</div>' +
      '</div>';
    }).join('');
  }
}

function renderNovelPreview(sessions) {
  document.getElementById('novel-summary-list').innerHTML = '';
  document.getElementById('preview-novel-btn').style.display = 'none';
  document.getElementById('novel-preview-section').style.display = 'block';

  var html = sessions.map(function(s, si) {
    var moments = s.moments || [];
    if (!moments.length) return '';
    return '<div>' +
      '<div class="novel-chapter-header">Session ' + (si+1) + ' &mdash; ' + s.name + '</div>' +
      '<div class="novel-grid" style="grid-template-columns:1fr 1fr;gap:2px;background:#222;padding:2px;">' +
      moments.map(function(m, i) {
        var wide = (i===0 || i===Math.floor(moments.length/2));
        var imgContent = m.image
          ? '<img src="' + m.image + '" style="width:100%;height:100%;object-fit:cover;cursor:zoom-in;" alt="' + m.title + '" onclick="openLightbox(this.src,this.alt)" title="Click to enlarge" />'
          : '<div class="novel-panel-inner"><div style="font-size:20px;margin-bottom:4px;">&#128444;</div>' + m.title + '</div>';
        return '<div class="novel-panel' + (wide?' wide':'') + '">' +
          imgContent +
          '<div class="novel-caption">' + m.description + '</div>' +
        '</div>';
      }).join('') + '</div></div>';
  }).join('');

  document.getElementById('novel-all-panels').innerHTML = html ||
    '<div class="empty-state" style="padding:2rem;"><p>No moments extracted yet.</p></div>';
}

function hideNovelPreview() { loadNovelSummary(); }

// ============================================================
// SETTINGS
// ============================================================
function loadSettingsForm() {
  document.getElementById('settings-name').value = state.user.name || '';
  document.getElementById('settings-email').value = state.user.email || '';
  // Load stored keys
  fetch('/api/auth/apikey')
    .then(function(r) { return r.json(); })
    .then(function(k) {
      var sk = document.getElementById('settings-apikey');
      if (k.api_key && sk) sk.value = k.api_key;
      var fk = document.getElementById('settings-falkey');
      if (k.fal_key && fk) fk.value = k.fal_key;
    });
  // Load the current global image-generation model
  fetch('/api/auth/image-model')
    .then(function(r) { return r.json(); })
    .then(function(d) {
      var el = document.getElementById('settings-image-model');
      if (el && d.model) el.value = d.model;
    });
}

function saveImageModel() {
  var el = document.getElementById('settings-image-model');
  if (!el) return;
  fetch('/api/auth/image-model', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: el.value })
  })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (d.error) {
        showSettingsError('model-error', d.error);
      } else {
        var ok = document.getElementById('model-success');
        if (ok) {
          ok.textContent = 'Image model saved.';
          ok.classList.remove('hidden');
          setTimeout(function() { ok.classList.add('hidden'); }, 2500);
        }
      }
    })
    .catch(function() {
      showSettingsError('model-error', 'Could not save. Please try again.');
    });
}

function saveProfile() {
  var name = document.getElementById('settings-name').value.trim();
  var email = document.getElementById('settings-email').value.trim();
  document.getElementById('profile-error').classList.add('hidden');
  document.getElementById('profile-success').classList.add('hidden');
  if (!name || !email) { showSettingsError('profile-error', 'Name and email are required.'); return; }

  fetch('/api/auth/profile', {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({name:name, email:email})
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.error) { showSettingsError('profile-error', data.error); return; }
    state.user.name = name;
    state.user.email = email;
    document.getElementById('user-name').textContent = name;
    document.getElementById('user-menu-email').textContent = email;
    var initials = name.split(' ').map(function(w){return w[0];}).join('').slice(0,2).toUpperCase();
    document.getElementById('user-avatar').textContent = initials;
    document.getElementById('profile-success').textContent = 'Profile updated!';
    document.getElementById('profile-success').classList.remove('hidden');
    setTimeout(function() { document.getElementById('profile-success').classList.add('hidden'); }, 2500);
  });
}

function saveApiKey() {
  var apiEl = document.getElementById('settings-apikey');
  if (!apiEl) return;
  var key = apiEl.value.trim();
  document.getElementById('apikey-success').classList.add('hidden');
  fetch('/api/auth/apikey', {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({api_key:key})
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.error) { alert(data.error); return; }
    document.getElementById('apikey-success').textContent = 'API key saved!';
    document.getElementById('apikey-success').classList.remove('hidden');
    setTimeout(function() { document.getElementById('apikey-success').classList.add('hidden'); }, 2500);
  });
}

function saveFalKey() {
  var falEl = document.getElementById('settings-falkey');
  if (!falEl) return;
  var key = falEl.value.trim();
  document.getElementById('falkey-success').classList.add('hidden');
  fetch('/api/auth/apikey', {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({fal_key:key})
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.error) { alert(data.error); return; }
    document.getElementById('falkey-success').textContent = 'fal.ai key saved!';
    document.getElementById('falkey-success').classList.remove('hidden');
    setTimeout(function() { document.getElementById('falkey-success').classList.add('hidden'); }, 2500);
  });
}

function getFalKey() {
  var el = document.getElementById('settings-falkey');
  return el ? el.value.trim() : '';
}

function changePassword() {
  var current = document.getElementById('settings-current-password').value;
  var newpw = document.getElementById('settings-new-password').value;
  document.getElementById('password-error').classList.add('hidden');
  document.getElementById('password-success').classList.add('hidden');
  if (!current || !newpw) { showSettingsError('password-error', 'Both fields are required.'); return; }
  if (newpw.length < 8) { showSettingsError('password-error', 'New password must be at least 8 characters.'); return; }

  fetch('/api/auth/password', {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({current_password:current, new_password:newpw})
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.error) { showSettingsError('password-error', data.error); return; }
    document.getElementById('settings-current-password').value = '';
    document.getElementById('settings-new-password').value = '';
    document.getElementById('password-success').textContent = 'Password changed successfully!';
    document.getElementById('password-success').classList.remove('hidden');
    setTimeout(function() { document.getElementById('password-success').classList.add('hidden'); }, 2500);
  });
}

function showSettingsError(id, msg) {
  var el = document.getElementById(id);
  el.textContent = msg;
  el.classList.remove('hidden');
}

// ============================================================
// DRAG AND DROP — Character portraits
// ============================================================

// Image slot handlers — modal upload areas
var slotFiles = {}; // Tracks new files selected for each slot

function handleSlotDragOver(e, slot) {
  e.preventDefault();
  e.stopPropagation();
  document.getElementById('drop-' + slot).classList.add('drag-over');
}

function handleSlotDragLeave(e, slot) {
  e.preventDefault();
  e.stopPropagation();
  document.getElementById('drop-' + slot).classList.remove('drag-over');
}

function handleSlotDrop(e, slot) {
  e.preventDefault();
  e.stopPropagation();
  document.getElementById('drop-' + slot).classList.remove('drag-over');
  var files = e.dataTransfer.files;
  if (!files || !files[0]) return;
  if (!files[0].type.match('image.*')) { showAlert('Please drop an image file'); return; }
  setSlotFile(slot, files[0]);
}

function handleSlotFileSelect(e, slot) {
  if (e.target.files && e.target.files[0]) {
    setSlotFile(slot, e.target.files[0]);
  }
}

function setSlotFile(slot, file) {
  slotFiles[slot] = file;
  var reader = new FileReader();
  reader.onload = function(ev) {
    var preview = document.getElementById('preview-' + slot);
    var placeholder = document.getElementById('placeholder-' + slot);
    var clearBtn = document.getElementById('clear-' + slot);
    preview.src = ev.target.result;
    preview.classList.remove('hidden');
    preview.onclick = function() { openLightbox(ev.target.result, slot.replace('image_', '').replace('_', ' ')); };
    if (placeholder) placeholder.style.display = 'none';
    if (clearBtn) clearBtn.style.display = 'inline-flex';
  };
  reader.readAsDataURL(file);
}

function clearSlot(slot) {
  slotFiles[slot] = null;
  var preview = document.getElementById('preview-' + slot);
  var placeholder = document.getElementById('placeholder-' + slot);
  var clearBtn = document.getElementById('clear-' + slot);
  var input = document.getElementById('input-' + slot);
  preview.src = '';
  preview.classList.add('hidden');
  if (placeholder) placeholder.style.display = 'flex';
  if (clearBtn) clearBtn.style.display = 'none';
  if (input) input.value = '';
  // Mark for clearing on save
  slotFiles[slot + '_clear'] = true;
}

function loadSlotPreviews(char) {
  var slots = ['image_portrait', 'image_fullbody', 'image_action', 'image_other'];
  slots.forEach(function(slot) {
    var preview = document.getElementById('preview-' + slot);
    var placeholder = document.getElementById('placeholder-' + slot);
    var clearBtn = document.getElementById('clear-' + slot);
    var url = char ? char[slot] : null;
    slotFiles[slot] = null;
    slotFiles[slot + '_clear'] = false;

    if (url) {
      preview.src = url;
      preview.classList.remove('hidden');
      preview.onclick = function() { openLightbox(url, slot.replace('image_', '').replace('_', ' ')); };
      if (placeholder) placeholder.style.display = 'none';
      if (clearBtn) clearBtn.style.display = 'inline-flex';
    } else {
      preview.src = '';
      preview.classList.add('hidden');
      if (placeholder) placeholder.style.display = 'flex';
      if (clearBtn) clearBtn.style.display = 'none';
    }
  });
}

// Drag and drop directly onto character cards
function setupCardDragDrop() {
  var grid = document.getElementById('char-grid');
  if (!grid) return;

  grid.addEventListener('dragenter', function(e) {
    e.preventDefault();
    e.stopPropagation();
    var card = e.target.closest('.char-card-drop');
    if (card) card.classList.add('drag-over');
  });

  grid.addEventListener('dragover', function(e) {
    e.preventDefault();
    e.stopPropagation();
    var card = e.target.closest('.char-card-drop');
    // Remove drag-over from all cards first
    grid.querySelectorAll('.char-card-drop').forEach(function(c) { c.classList.remove('drag-over'); });
    if (card) card.classList.add('drag-over');
  });

  grid.addEventListener('dragleave', function(e) {
    e.preventDefault();
    e.stopPropagation();
    // Only remove if leaving the grid entirely
    if (!grid.contains(e.relatedTarget)) {
      grid.querySelectorAll('.char-card-drop').forEach(function(c) { c.classList.remove('drag-over'); });
    }
  });

  grid.addEventListener('drop', function(e) {
    e.preventDefault();
    e.stopPropagation();
    grid.querySelectorAll('.char-card-drop').forEach(function(c) { c.classList.remove('drag-over'); });

    var card = e.target.closest('.char-card-drop');
    if (!card) return;

    var files = e.dataTransfer.files;
    if (!files || !files[0]) return;

    var file = files[0];
    if (!file.type.match('image.*')) {
      showAlert('Please drop an image file (JPG, PNG, WebP)');
      return;
    }

    var charId = parseInt(card.id.replace('char-card-', ''));
    if (!charId) return;

    uploadPortraitToChar(charId, file);
  });
}

function uploadPortraitToChar(charId, file) {
  var formData = new FormData();
  formData.append('image', file);

  // Get existing char data to preserve it
  var char = state.characters.find(function(c) { return c.id === charId; });
  if (!char) return;

  formData.append('name', char.name);
  formData.append('cls', char.cls || '');
  formData.append('description', char.description || '');
  formData.append('player_name', char.player_name || '');

  // Show uploading indicator on the card
  var card = document.getElementById('char-card-' + charId);
  if (card) {
    var avatar = card.querySelector('.char-avatar');
    if (avatar) avatar.style.opacity = '0.5';
  }

  fetch('/api/campaigns/' + state.currentCampaign.id + '/characters/' + charId, {
    method: 'PUT',
    body: formData
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.error) { showAlert('Error uploading portrait: ' + data.error); return; }
    showAlert('Portrait updated for ' + char.name + '!');
    loadCharacters();
  })
  .catch(function(e) { showAlert('Error: ' + e.message); });
}

// ============================================================
// NARRATIVE
// ============================================================

var narrativeData = { intro: '', sections: [], outro: '' };

function loadNarrative() {
  fetch('/api/narrative/' + state.currentCampaign.id + '/' + state.currentSession.id)
    .then(function(r) { return r.json(); })
    .then(function(data) {
      narrativeData = data;
      if (data.intro || (data.sections && data.sections.length) || data.outro) {
        renderNarrativeEditor(data);
        document.getElementById('narrative-empty').style.display = 'none';
        document.getElementById('narrative-content').style.display = 'block';
      } else {
        document.getElementById('narrative-empty').style.display = 'block';
        document.getElementById('narrative-content').style.display = 'none';
      }
    });
}

function generateNarrative() {
  var key = getApiKey() || 'platform';  // Platform key used server-side

  var btn = document.getElementById('regen-narrative-btn');
  var progress = document.getElementById('narrative-progress');
  var fill = document.getElementById('narrative-progress-fill');
  var msg = document.getElementById('narrative-progress-msg');
  var errorEl = document.getElementById('narrative-error');

  if (btn) btn.disabled = true;
  if (errorEl) errorEl.classList.add('hidden');
  document.getElementById('narrative-empty').style.display = 'none';
  document.getElementById('narrative-content').style.display = 'block';
  if (progress) progress.style.display = 'block';

  var pct = 5;
  var ticker = setInterval(function() {
    pct = Math.min(pct + Math.random() * 5, 88);
    if (fill) fill.style.width = pct + '%';
  }, 500);

  if (msg) msg.textContent = 'Writing your story narrative...';

  fetch('/api/narrative/generate/' + state.currentCampaign.id + '/' + state.currentSession.id, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({key: key})
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    clearInterval(ticker);
    if (progress) progress.style.display = 'none';
    if (btn) btn.disabled = false;

    if (data.error) {
      if (errorEl) { errorEl.textContent = 'Error: ' + data.error; errorEl.classList.remove('hidden'); }
      return;
    }

    narrativeData = data;
    renderNarrativeEditor(data);
    if (fill) fill.style.width = '0%';
  })
  .catch(function(e) {
    clearInterval(ticker);
    if (progress) progress.style.display = 'none';
    if (btn) btn.disabled = false;
    if (errorEl) { errorEl.textContent = 'Error: ' + e.message; errorEl.classList.remove('hidden'); }
  });
}

function renderNarrativeEditor(data) {
  var editor = document.getElementById('narrative-editor');
  var html = '';

  // Intro section
  html += '<div class="narrative-section">' +
    '<div class="narrative-section-header">Opening — before first panel</div>' +
    '<textarea class="narrative-textarea" id="narrative-intro" placeholder="Opening paragraph that sets the scene...">' +
    (data.intro || '') + '</textarea>' +
  '</div>';

  // Per-moment sections
  state.moments.forEach(function(m, i) {
    var section = (data.sections || []).find(function(s) { return s.panel_index === i; }) || {};

    html += '<div class="narrative-section">' +
      '<div class="narrative-section-header">' +
        (m.image ? '<img class="narrative-section-img" src="' + m.image + '" alt="' + m.title + '" onclick="openLightbox(this.src,this.alt)" />' : '') +
        'Panel ' + (i+1) + ' — ' + m.title +
      '</div>' +
      '<textarea class="narrative-textarea" id="narrative-before-' + i + '" placeholder="Prose leading into this panel...">' +
      (section.before || '') + '</textarea>' +
      (i < state.moments.length - 1
        ? '<div style="padding:4px 14px;font-size:10px;color:rgba(201,168,76,0.3);font-style:italic;">— panel image appears here —</div>' +
          '<textarea class="narrative-textarea" id="narrative-after-' + i + '" placeholder="Prose bridging from this panel to the next...">' +
          (section.after || '') + '</textarea>'
        : '<div style="padding:4px 14px;font-size:10px;color:rgba(201,168,76,0.3);font-style:italic;">— final panel image appears here —</div>') +
    '</div>';
  });

  // Outro section
  html += '<div class="narrative-section">' +
    '<div class="narrative-section-header">Closing — after final panel</div>' +
    '<textarea class="narrative-textarea" id="narrative-outro" placeholder="Closing paragraph — what this session meant, what comes next...">' +
    (data.outro || '') + '</textarea>' +
  '</div>';

  editor.innerHTML = html;
}

function collectNarrativeFromEditor() {
  var intro = document.getElementById('narrative-intro');
  var outro = document.getElementById('narrative-outro');
  var sections = state.moments.map(function(m, i) {
    var before = document.getElementById('narrative-before-' + i);
    var after = document.getElementById('narrative-after-' + i);
    return {
      panel_index: i,
      before: before ? before.value.trim() : '',
      after: after ? after.value.trim() : ''
    };
  });
  return {
    intro: intro ? intro.value.trim() : '',
    sections: sections,
    outro: outro ? outro.value.trim() : ''
  };
}

function saveNarrative() {
  var data = collectNarrativeFromEditor();
  fetch('/api/narrative/save/' + state.currentCampaign.id + '/' + state.currentSession.id, {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify(data)
  })
  .then(function(r) { return r.json(); })
  .then(function(result) {
    if (result.error) { showAlert('Error saving: ' + result.error); return; }
    narrativeData = data;
    showAlert('Narrative saved!');
  });
}

// ============================================================
// PDF EXPORT
// ============================================================

// Preview inline below the buttons (toggles)
function previewSessionInline() {
  loadPreview(state.layoutStyle || 'Classic');
}

// Also keep old name working
function toggleSessionPreview() { previewSessionInline(); }

// Export - opens PDF page, waits for full render, then prints
function exportSessionPDF() {
  if (state.userTier && !state.userTier.can_export) {
    showAlert('Export is not available on the Copper plan. Upgrade to Silver or higher to export PDFs!');
    return;
  }
  var url = '/api/pdf/session/' + state.currentCampaign.id + '/' + state.currentSession.id +
    '?layout=' + encodeURIComponent(state.layoutStyle || 'Classic');
  var win = window.open(url, '_blank');
  setTimeout(function() { if (win) win.print(); }, 4000);
}

function exportNovelPDF() {
  var url = '/api/pdf/novel/' + state.currentCampaign.id;
  var win = window.open(url, '_blank');
  setTimeout(function() { if (win) win.print(); }, 5000);
}

function previewNovelPDF() {
  var url = '/api/pdf/novel/' + state.currentCampaign.id;
  window.open(url, '_blank');
}

// ============================================================
// LIGHTBOX
// ============================================================

function openLightbox(src, caption) {
  if (!src) return;

  // Remove any existing lightbox
  closeLightbox();

  var overlay = document.createElement('div');
  overlay.className = 'lightbox-overlay';
  overlay.id = 'lightbox';
  overlay.onclick = function(e) {
    if (e.target === overlay || e.target.classList.contains('lightbox-close')) {
      closeLightbox();
    }
  };

  var close = document.createElement('div');
  close.className = 'lightbox-close';
  close.innerHTML = '&times;';
  close.onclick = closeLightbox;

  var img = document.createElement('img');
  img.className = 'lightbox-img';
  img.src = src;
  img.alt = caption || '';

  overlay.appendChild(close);
  overlay.appendChild(img);

  if (caption) {
    var cap = document.createElement('div');
    cap.className = 'lightbox-caption';
    cap.textContent = caption;
    overlay.appendChild(cap);
  }

  document.body.appendChild(overlay);

  // Close on escape key
  document.addEventListener('keydown', handleLightboxKey);
}

function handleLightboxKey(e) {
  if (e.key === 'Escape') closeLightbox();
}

function closeLightbox() {
  var existing = document.getElementById('lightbox');
  if (existing) existing.remove();
  document.removeEventListener('keydown', handleLightboxKey);
}

// ============================================================
// UTILITIES
// ============================================================
function showModalError(id, msg) {
  var el = document.getElementById(id);
  el.textContent = msg;
  el.classList.remove('hidden');
}

function showAlert(msg) {
  var el = document.createElement('div');
  el.className = 'alert alert-success';
  el.textContent = msg;
  el.style.cssText = 'position:fixed;top:16px;right:16px;z-index:999;min-width:200px;box-shadow:0 4px 12px rgba(0,0,0,0.15);';
  document.body.appendChild(el);
  setTimeout(function() { el.remove(); }, 2500);
}

// Prompt block for a storyboard panel. Platinum users get an Edit button;
// everyone else sees read-only text.
function buildPromptBlock(m) {
  var canEdit = state.userTier && state.userTier.can_edit_prompts;
  var safe = (m.prompt || '');
  if (!canEdit) {
    return '<div class="moment-prompt-text" id="prompt-text-' + m.id + '">' + safe + '</div>';
  }
  return '<div class="moment-prompt-wrap" id="prompt-wrap-' + m.id + '">' +
    '<div class="moment-prompt-text" id="prompt-text-' + m.id + '">' + safe + '</div>' +
    '<button class="moment-prompt-edit-btn" onclick="startEditPrompt(' + m.id + ')">' +
      '&#9998; Edit prompt</button>' +
  '</div>';
}

function startEditPrompt(momentId) {
  var wrap = document.getElementById('prompt-wrap-' + momentId);
  if (!wrap) return;
  var moment = (state.moments || []).find(function(m) { return m.id === momentId; });
  var current = moment ? (moment.prompt || '') : '';
  wrap.innerHTML =
    '<textarea class="moment-prompt-editor" id="prompt-editor-' + momentId + '">' +
      current + '</textarea>' +
    '<div class="moment-prompt-actions">' +
      '<button class="btn btn-sm btn-primary" onclick="savePrompt(' + momentId + ')">Save</button>' +
      '<button class="btn btn-sm" onclick="cancelEditPrompt(' + momentId + ')">Cancel</button>' +
    '</div>';
  var ta = document.getElementById('prompt-editor-' + momentId);
  if (ta) ta.focus();
}

function cancelEditPrompt(momentId) {
  var moment = (state.moments || []).find(function(m) { return m.id === momentId; });
  var wrap = document.getElementById('prompt-wrap-' + momentId);
  if (wrap && moment) {
    wrap.innerHTML =
      '<div class="moment-prompt-text" id="prompt-text-' + momentId + '">' + (moment.prompt || '') + '</div>' +
      '<button class="moment-prompt-edit-btn" onclick="startEditPrompt(' + momentId + ')">' +
        '&#9998; Edit prompt</button>';
  }
}

function savePrompt(momentId) {
  var ta = document.getElementById('prompt-editor-' + momentId);
  if (!ta) return;
  var newPrompt = ta.value;
  if (!state.currentCampaign || !state.currentSession) return;
  ta.disabled = true;
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' +
        state.currentSession.id + '/moments/' + momentId, {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ prompt: newPrompt })
  })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data && data.success) {
        var moment = (state.moments || []).find(function(m) { return m.id === momentId; });
        if (moment) moment.prompt = newPrompt;
        cancelEditPrompt(momentId);
      } else {
        ta.disabled = false;
        alert((data && data.error) || 'Could not save the prompt.');
      }
    })
    .catch(function() {
      ta.disabled = false;
      alert('Could not save the prompt.');
    });
}

function renderStoryboard() {
  document.getElementById('sb-empty').style.display = 'none';
  document.getElementById('sb-content').style.display = 'block';

  var narrative = state.narrativeData || { intro: '', sections: [], outro: '' };
  var typeLabel = {combat:'Combat',drama:'Drama',discovery:'Discovery',humor:'Humor'};

  // True alternating grid — narrative and image panels flow together
  // [Opening] [Panel 1] [Between 1-2] [Panel 2] [Between 2-3] [Panel 3] ...

  function buildPanel(m, i) {
    var needsWatermark = state.userTier && state.userTier.watermark;
    var imgHtml = m.image
      ? '<div class="' + (needsWatermark ? 'watermarked' : '') + '"><img class="moment-img-generated" src="' + m.image + '" alt="' + m.title + '" onclick="openLightbox(this.src,this.alt)" title="Click to enlarge" /></div>'
      : '<div class="moment-img-placeholder">' +
          '<div style="font-size:32px;opacity:0.3;">&#128444;</div>' +
          '<div style="font-size:11px;color:rgba(201,168,76,0.3);margin-top:6px;">No image yet</div>' +
        '</div>';
    return '<div class="storyboard-panel" id="moment-card-' + m.id + '">' +
      '<div class="storyboard-panel-img">' +
        imgHtml +
        '<button class="moment-regen-btn" onclick="regenImage(' + m.id + ', ' + i + ')">&#8635; Regenerate image</button>' +
      '</div>' +
      '<div class="storyboard-panel-meta">' +
        '<span class="moment-num">Panel ' + (i+1) + '</span>' +
        '<span class="moment-title">' + m.title + '</span>' +
        '<span class="moment-type type-' + m.type + '">' + (typeLabel[m.type]||m.type) + '</span>' +
      '</div>' +
      buildPromptBlock(m) +
    '</div>';
  }

  function buildNarrative(id, label, textareaId, placeholder, value, regenCall, autosave) {
    return '<div class="narrative-panel" id="' + id + '">' +
      '<div class="narrative-block-header">' +
        '<span>&#9998; ' + label + '</span>' +
        '<button class="narrative-regen-btn" onclick="' + regenCall + '">&#8635; Regen</button>' +
      '</div>' +
      '<textarea class="narrative-inline-box" id="' + textareaId + '" placeholder="' + placeholder + '"' +
        (autosave ? ' oninput="scheduleNarrativeSave()"' : '') + '>' +
      (value || '') + '</textarea>' +
    '</div>';
  }

  // Build alternating array: opening, panel0, between0-1, panel1, between1-2, panel2, ..., closing
  var cells = [];

  // Opening narrative
  cells.push(buildNarrative('narrative-opening', 'Opening', 'narrative-intro-box',
    'Opening paragraph...', narrative.intro, 'regenNarrativeSection(\"opening\")', true));

  // Alternate panels and between-narratives
  state.moments.forEach(function(m, i) {
    cells.push(buildPanel(m, i));
    if (i < state.moments.length - 1) {
      var section = (narrative.sections||[]).find(function(s){return s.panel_index===i;}) || {};
      cells.push(buildNarrative(
        'narrative-between-' + i,
        'Panel ' + (i+1) + ' → ' + (i+2),
        'narrative-between-box-' + i,
        'Bridge the story...', section.after || '',
        'regenNarrativeSection(\"between\",' + i + ')', false
      ));
    }
  });

  // Closing narrative
  cells.push(buildNarrative('narrative-closing', 'Closing', 'narrative-outro-box',
    'Closing paragraph...', narrative.outro, 'regenNarrativeSection(\"closing\")', true));

  document.getElementById('moments-grid').innerHTML = '<div class="panels-grid">' + cells.join('') + '</div>';
}

// STATE
// ============================================================
var state = {
  user: null,
  userTier: null,
  campaigns: [],
  currentCampaign: null,
  layoutStyle: 'Classic',
  currentSession: null,
  characters: [],
  sessions: [],
  moments: [],
  artStyle: 'High fantasy illustration',
  currentView: 'campaigns'
};

// ============================================================
// INIT
// ============================================================
document.addEventListener('DOMContentLoaded', function() {
  checkAuth();
  var charImageInput = document.getElementById('char-image-input');
  if (charImageInput) charImageInput.addEventListener('change', previewCharImage);
  var sessionDate = document.getElementById('session-date');
  if (sessionDate) sessionDate.value = new Date().toISOString().split('T')[0];

  // Close user menu when clicking outside
  document.addEventListener('click', function(e) {
    var menu = document.getElementById('user-menu');
    var btn = document.querySelector('.user-menu-btn');
    if (menu && btn && !menu.contains(e.target) && !btn.contains(e.target)) {
      menu.classList.remove('open');
    }
  });

  // CRITICAL: Prevent browser from opening dragged files as new pages
  document.addEventListener('dragover', function(e) { e.preventDefault(); });
  document.addEventListener('drop', function(e) { e.preventDefault(); });
});

// ============================================================
// AUTH
// ============================================================
function checkAuth() {
  fetch('/api/auth/me')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data.authenticated) { window.location.href = '/'; return; }
      state.user = data;
      // Tier info drives feature gates (prompt editing, watermark, export)
      state.userTier = data.tierFeatures || null;
      document.getElementById('user-name').textContent = data.name;
      document.getElementById('user-menu-email').textContent = data.email;
      var initials = data.name.split(' ').map(function(w) { return w[0]; }).join('').slice(0,2).toUpperCase();
      document.getElementById('user-avatar').textContent = initials;
      refreshTokenBalance();
      var adminBox = document.getElementById('account-admin-testing');
      if (adminBox) adminBox.style.display = data.is_admin ? 'block' : 'none';

      // Load saved API key into settings field
      fetch('/api/auth/apikey')
        .then(function(r) { return r.json(); })
        .then(function(k) {
          if (k.api_key) {
            var akEl = document.getElementById('settings-apikey');
            if (akEl) akEl.value = k.api_key;
          }
        });

      loadCampaigns();
    });
}

function logout() {
  fetch('/api/auth/logout', { method: 'POST' })
    .then(function() { window.location.href = '/'; });
}

function toggleUserMenu() {
  document.getElementById('user-menu').classList.toggle('open');
}

function closeUserMenu() {
  document.getElementById('user-menu').classList.remove('open');
}

// Get API key — prefer settings field, fall back to nothing
function getApiKey() {
  var el = document.getElementById('settings-apikey');
  return el ? el.value.trim() : '';
}

// ============================================================
// BREADCRUMB
// ============================================================
function setBreadcrumb(items) {
  var bc = document.getElementById('breadcrumb');
  var html = '';
  items.forEach(function(item, i) {
    if (i > 0) html += '<span class="breadcrumb-sep">&#8250;</span>';
    if (item.action && i < items.length - 1) {
      html += '<span class="breadcrumb-link" onclick="' + item.action + '">' + item.label + '</span>';
    } else {
      html += '<span class="breadcrumb-current">' + item.label + '</span>';
    }
  });
  bc.innerHTML = html;
}

// ============================================================
// VIEW MANAGEMENT
// ============================================================
function showView(view) {
  var views = ['campaigns','sessions','characters','assets','novel','session-detail','account','settings'];
  views.forEach(function(v) {
    var el = document.getElementById('view-' + v);
    if (el) el.style.display = 'none';
  });

  var el = document.getElementById('view-' + view);
  if (el) el.style.display = 'block';
  state.currentView = view;

  // Update sidebar active states
  document.querySelectorAll('.sidebar-item').forEach(function(el) { el.classList.remove('active'); });

  if (view === 'campaigns') {
    var _sc=document.getElementById('snav-campaigns'); if(_sc)_sc.classList.add('active');
    var _cs=document.getElementById('campaign-subnav'); if(_cs)_cs.style.display='none';
    state.currentCampaign = null;
    state.currentSession = null;
    setBreadcrumb([{label:'My Campaigns'}]);
    loadCampaigns();
  } else if (view === 'account') {
    var sn = document.getElementById('snav-account');
    if (sn) sn.classList.add('active');
    var _cs=document.getElementById('campaign-subnav'); if(_cs)_cs.style.display='none';
    setBreadcrumb([
      {label:'My Campaigns', action:"showView('campaigns')"},
      {label:'My Account'}
    ]);
    loadAccount();
  } else if (view === 'settings') {
    var _ss=document.getElementById('snav-settings'); if(_ss)_ss.classList.add('active');
    var _cs=document.getElementById('campaign-subnav'); if(_cs)_cs.style.display='none';
    setBreadcrumb([
      {label:'My Campaigns', action:"showView('campaigns')"},
      {label:'Settings'}
    ]);
    loadSettingsForm();
  }
}

function showCampaignSection(section) {
  showView(section);

  // Show campaign subnav
  var _cs=document.getElementById('campaign-subnav'); if(_cs)_cs.style.display='block';
  var _scn=document.getElementById('sidebar-campaign-name'); if(_scn)_scn.textContent=state.currentCampaign.name;

  // Sidebar active — novel has no sidebar item so skip it
  if (section !== 'novel') {
    var navId = 'snav-' + section;
    var el = document.getElementById(navId);
    if (el) el.classList.add('active');
  }

  // Breadcrumb
  var sectionLabel = {sessions:'Sessions', characters:'Characters', assets:'Asset Library', novel:'Graphic Novel'}[section] || section;
  setBreadcrumb([
    {label:'My Campaigns', action:"showView('campaigns')"},
    {label:state.currentCampaign.name, action:"showCampaignSection('sessions')"},
    {label:sectionLabel}
  ]);

  if (section === 'sessions') loadSessions();
  if (section === 'characters') loadCharacters();
  if (section === 'novel') loadNovelSummary();
  if (section === 'assets') loadAssets();
}

// ============================================================
// CAMPAIGNS
// ============================================================
function loadCampaigns() {
  fetch('/api/campaigns')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      state.campaigns = Array.isArray(data) ? data : [];
      renderCampaigns();
    });
}

function renderCampaigns() {
  var grid = document.getElementById('campaigns-grid');
  var html = state.campaigns.map(function(c) {
    return '<div class="campaign-card" onclick="selectCampaign(' + c.id + ')">' +
      '<div class="campaign-card-icon"><img src="/images/Chronicle_Logo.png" alt="" /></div>' +
      '<div class="campaign-card-name">' + c.name + '</div>' +
      '<div class="campaign-card-desc">' + (c.description || 'No description') + '</div>' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-top:8px;">' +
        '<div class="campaign-card-meta">Created ' + new Date(c.created_at).toLocaleDateString() + '</div>' +
      '</div>' +
    '</div>';
  }).join('');
  html += '<div class="add-campaign-card" onclick="openCampaignModal()"><div class="plus">+</div><span>New campaign</span></div>';
  grid.innerHTML = html;
}

function setCampaignElements() {
  // sessions-title is owned by renderSessions() so it can include the session count
  var ct = document.getElementById('novel-cover-title');
  var cs = document.getElementById('novel-cover-sub');
  if (ct) ct.textContent = state.currentCampaign.name;
  if (cs) cs.textContent = state.currentCampaign.description || '';
}

function selectCampaign(id) {
  state.currentCampaign = state.campaigns.find(function(c) { return c.id === id; });
  setCampaignElements();
  showCampaignSection('sessions');
}

function selectCampaignNovel(id) {
  state.currentCampaign = state.campaigns.find(function(c) { return c.id === id; });
  setCampaignElements();
  var _cs=document.getElementById('campaign-subnav'); if(_cs)_cs.style.display='block';
  var _scn=document.getElementById('sidebar-campaign-name'); if(_scn)_scn.textContent=state.currentCampaign.name;
  showView('campaign-detail');
  showCampaignTab('novel');
}

function openCampaignModal(editId) {
  document.getElementById('campaign-edit-id').value = editId || '';
  document.getElementById('campaign-modal-title').textContent = editId ? 'Edit Campaign' : 'New Campaign';
  document.getElementById('campaign-save-btn').textContent = editId ? 'Save changes' : 'Create campaign';
  document.getElementById('campaign-name').value = editId && state.currentCampaign ? state.currentCampaign.name : '';
  document.getElementById('campaign-desc').value = editId && state.currentCampaign ? (state.currentCampaign.description || '') : '';
  document.getElementById('campaign-modal-error').classList.add('hidden');
  document.getElementById('campaign-modal').classList.remove('hidden');
}

function closeCampaignModal() { document.getElementById('campaign-modal').classList.add('hidden'); }

function saveCampaign() {
  var name = document.getElementById('campaign-name').value.trim();
  var desc = document.getElementById('campaign-desc').value.trim();
  var editId = document.getElementById('campaign-edit-id').value;
  if (!name) { showModalError('campaign-modal-error', 'Campaign name is required.'); return; }

  var url = editId ? '/api/campaigns/' + editId : '/api/campaigns';
  fetch(url, {
    method: editId ? 'PUT' : 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({name:name, description:desc})
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.error) { showModalError('campaign-modal-error', data.error); return; }
    closeCampaignModal();
    loadCampaigns();
  });
}

// ============================================================
// SESSIONS
// ============================================================

function formatSessionDate(dateVal) {
  if (!dateVal) return '';
  // PostgreSQL returns Date objects, SQLite returns strings
  var dateStr = typeof dateVal === 'string' ? dateVal : dateVal.toISOString();
  // Handle both 'YYYY-MM-DD' and full ISO strings
  var datePart = dateStr.split('T')[0];
  return new Date(datePart + 'T12:00:00').toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
}
function loadSessions() {
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      state.sessions = Array.isArray(data) ? data : [];
      renderSessions();
    });
}

function renderSessions() {
  var list = document.getElementById('sessions-list');

  // Update the page title with a session count, e.g. "The Hidden Pass (35 sessions)"
  var titleEl = document.getElementById('sessions-title');
  if (titleEl) {
    var campName = (state.currentCampaign && state.currentCampaign.name) ? state.currentCampaign.name : 'Sessions';
    var n = state.sessions.length;
    titleEl.innerHTML = campName +
      ' <span style="font-size:0.6em;font-weight:400;color:var(--text-light);">(' +
      n + ' session' + (n === 1 ? '' : 's') + ')</span>';
  }

  if (!state.sessions.length) {
    list.innerHTML = '<div class="empty-state"><div class="empty-state-icon">&#128203;</div>' +
      '<h3>No sessions yet</h3><p>Create your first session to start uploading transcripts and generating storyboards</p>' +
      '<button class="btn btn-primary" onclick="openSessionModal()">+ New session</button></div>';
    return;
  }

  // Newest first — sort by session date descending
  var ordered = state.sessions.slice().sort(function(a, b) {
    var da = (a.session_date || '').toString().split('T')[0];
    var db = (b.session_date || '').toString().split('T')[0];
    if (da < db) return 1;
    if (da > db) return -1;
    return 0;
  });

  list.innerHTML = ordered.map(function(s) {
    return '<div class="session-item" onclick="selectSession(' + s.id + ')">' +
      '<div class="session-item-left">' +
        '<div>' +
          '<div class="session-name">' + s.name + '</div>' +
          '<div class="session-date">' + formatSessionDate(s.session_date) + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="flex gap-1 items-center">' +
        (s.transcript ? '<span class="session-badge">Has transcript</span>' : '<span class="session-badge empty">No transcript</span>') +
        '<button class="btn btn-sm btn-danger" onclick="event.stopPropagation();deleteSession(' + s.id + ')">Delete</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

function openSessionModal() {
  document.getElementById('session-name').value = '';
  document.getElementById('session-date').value = new Date().toISOString().split('T')[0];
  document.getElementById('session-modal-error').classList.add('hidden');
  document.getElementById('session-modal').classList.remove('hidden');
}

function closeSessionModal() { document.getElementById('session-modal').classList.add('hidden'); }

function saveSession() {
  var name = document.getElementById('session-name').value.trim();
  var date = document.getElementById('session-date').value;
  if (!name) { showModalError('session-modal-error', 'Session name is required.'); return; }

  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({name:name, session_date:date})
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.error) { showModalError('session-modal-error', data.error); return; }
    closeSessionModal();
    loadSessions();
  });
}

function updateSessionDate(value) {
  if (!value || !state.currentCampaign || !state.currentSession) return;
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' + state.currentSession.id, {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ session_date: value })
  })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data && data.id) {
        state.currentSession = data;
        if (typeof loadSessions === 'function') loadSessions();
      }
    })
    .catch(function(){});
}

function deleteSession(id) {
  if (!confirm('Delete this session and all its moments? This cannot be undone.')) return;
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' + id, {method:'DELETE'})
    .then(function() { loadSessions(); });
}

function selectSession(id) {
  // Clear previous session state
  state.moments = [];
  state.narrativeData = { intro: '', sections: [], outro: '' };
  var sbEmpty = document.getElementById('sb-empty');
  var sbContent = document.getElementById('sb-content');
  if (sbEmpty) sbEmpty.style.display = 'block';
  if (sbContent) sbContent.style.display = 'none';

  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' + id)
    .then(function(r) { return r.json(); })
    .then(function(data) {
      state.currentSession = data;
      state.moments = data.moments || [];
      document.getElementById('session-detail-name').textContent = data.name;
      // Set editable date input
      var dateInput = document.getElementById('session-detail-date-input');
      if (dateInput && data.session_date) {
        var dateStr = typeof data.session_date === 'string'
          ? data.session_date.split('T')[0]
          : data.session_date.toISOString().split('T')[0];
        dateInput.value = dateStr;
      }
      // date now handled by session-detail-date-input

      // Load narrative data
      state.narrativeData = {
        intro: data.narrative_intro || '',
        sections: data.narrative_sections ? JSON.parse(data.narrative_sections) : [],
        outro: data.narrative_outro || ''
      };

      if (state.moments.length) renderStoryboard();

      // Load last used art style for this campaign
      if (typeof loadLastArtStyle === 'function') loadLastArtStyle(data.art_style, data.layout_style);

      // Show session detail view FIRST
      var views = ['campaigns','sessions','characters','novel','session-detail','settings'];
      views.forEach(function(v) {
        var el = document.getElementById('view-' + v);
        if (el) el.style.display = 'none';
      });
      document.getElementById('view-session-detail').style.display = 'block';

      // Now that view is visible, populate fields
      switchSessionTab('notes');
      setTimeout(function() {
        var transcriptEl = document.getElementById('transcript-input');
        var notesEl = document.getElementById('session-notes-input');
        if (transcriptEl) {
          transcriptEl.value = data.transcript || '';
          // Auto-save the transcript when the DM clicks away from the box.
          transcriptEl.onblur = function() {
            saveSessionField('transcript', transcriptEl.value.trim());
          };
        }
        if (notesEl) {
          notesEl.value = data.session_notes || '';
          // Auto-save the notes when the DM clicks away from the box.
          notesEl.onblur = function() {
            saveSessionField('session_notes', notesEl.value.trim());
          };
        }
      }, 50);

      // Update sidebar
      document.querySelectorAll('.sidebar-item').forEach(function(el) { el.classList.remove('active'); });
      var _sx=document.getElementById('snav-sessions'); if(_sx)_sx.classList.add('active');
      var _cs=document.getElementById('campaign-subnav'); if(_cs)_cs.style.display='block';
      var _scn=document.getElementById('sidebar-campaign-name'); if(_scn)_scn.textContent=state.currentCampaign.name;

      // Breadcrumb
      setBreadcrumb([
        {label:'My Campaigns', action:"showView('campaigns')"},
        {label:state.currentCampaign.name, action:"showCampaignSection('sessions')"},
        {label:'Sessions', action:"showCampaignSection('sessions')"},
        {label:data.name}
      ]);
    });
}

function saveTranscript() {
  var transcript = document.getElementById('transcript-input').value.trim();
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' + state.currentSession.id, {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({transcript:transcript})
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    state.currentSession = data;
    showAlert('Transcript saved!');
  });
}

function saveNotes() {
  var notes = document.getElementById('session-notes-input').value.trim();
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' + state.currentSession.id, {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({session_notes:notes})
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    state.currentSession = data;
    var saved = document.getElementById('notes-saved');
    saved.classList.remove('hidden');
    setTimeout(function() { saved.classList.add('hidden'); }, 2500);
  });
}

function switchSessionTab(tab) {
  var tabs = ['notes', 'characters', 'review', 'storyboard', 'export'];
  tabs.forEach(function(t) {
    var pane = document.getElementById('session-tab-' + t);
    if (pane) pane.style.display = t === tab ? 'block' : 'none';
    var el = document.getElementById('stab-' + t);
    if (el) el.classList.toggle('active', t === tab);
  });
  // Auto-load preview when switching to publish tab
  if (tab === 'export' && state.currentSession && state.layoutStyle) {
    loadPreview(state.layoutStyle);
  }
  // Load character snapshots when switching to the characters tab
  if (tab === 'characters') {
    loadSessionCharacters();
  }
  if (tab === 'review') {
    loadReview();
  }
}

// ============================================================
// CHARACTERS
// ============================================================
function loadCharacters() {
  fetch('/api/campaigns/' + state.currentCampaign.id + '/characters')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      state.characters = Array.isArray(data) ? data : [];
      renderCharacters();
    });
}

function renderCharacters() {
  var colors = ['#EEEDFE','#E1F5EE','#FAECE7','#E6F1FB','#FAEEDA'];
  var fgs = ['#534AB7','#0F6E56','#993C1D','#185FA5','#854F0B'];
  var html = state.characters.map(function(c, i) {
    var initials = c.name.split(' ').map(function(w){return w[0];}).join('').slice(0,2).toUpperCase();
    var bg = colors[i % colors.length];
    var fg = fgs[i % fgs.length];
    // Canonical reference image is the preferred thumbnail (Stage 3 Piece 2).
    var refImg = c.canonical_reference_url;
    var primaryImg = refImg || c.image_portrait || c.image_fullbody || c.image_action || c.image_other || c.image;
    var imgPos = refImg ? 'center top' : 'center center';
    var portrait = primaryImg
      ? '<img src="' + primaryImg + '" style="width:100%;height:100%;object-fit:cover;object-position:' + imgPos + ';cursor:zoom-in;" alt="' + c.name + '" onclick="openLightbox(this.src,this.alt)" title="Click to enlarge" />'
      : '<span style="font-size:15px;font-weight:600;color:' + fg + ';">' + initials + '</span>';
    // Just show portrait on card - clean and simple
    var imgGridHtml = '';

    return '<div class="char-card char-card-drop" id="char-card-' + c.id + '">' +
      '<div class="char-card-header">' +
        '<div class="char-avatar" style="background:' + bg + ';">' + portrait + '</div>' +
        '<div class="char-actions">' +
          '<button class="char-btn" onclick="openCharModal(' + c.id + ')">Edit</button>' +
          '<button class="char-btn char-btn-delete" onclick="deleteChar(' + c.id + ')">Delete</button>' +
        '</div>' +
      '</div>' +
      '<div class="char-name">' + c.name + '</div>' +
      (c.player_name ? '<div class="char-player">Played by ' + c.player_name + '</div>' : '') +
      '<div class="char-desc">' + (c.description || '') + '</div>' +
      '<span class="char-badge">' + (c.cls || '') + '</span>' +
      ((c.is_npc === true || c.is_npc === 1 || c.is_npc === '1') ? '<span class="char-badge char-badge-npc">NPC</span>' : '') +
      imgGridHtml +
    '</div>';
  }).join('');
  html += '<div class="add-char-card" onclick="openCharModal()"><div class="plus">+</div><span>Add character</span></div>';
  document.getElementById('char-grid').innerHTML = html;
  setupCardDragDrop();
}


// ============================================================
// EXTRACT MOMENTS
// ============================================================
function selStyle(el, style) {
  document.querySelectorAll('.style-row .chip').forEach(function(c){c.classList.remove('sel');});
  el.classList.add('sel');
  state.artStyle = style;

  if (state.currentSession && state.currentCampaign) {
    fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' + state.currentSession.id, {
      method: 'PUT',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({art_style: style})
    }).catch(function() {});
  }
}

function selLayout(el, layout) {
  document.querySelectorAll('#session-tab-export .chip').forEach(function(c){c.classList.remove('sel');});
  el.classList.add('sel');
  state.layoutStyle = layout;

  // Save to session
  if (state.currentSession && state.currentCampaign) {
    fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' + state.currentSession.id, {
      method: 'PUT',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({layout_style: layout})
    }).catch(function() {});
  }

  // Always show preview when layout is selected
  loadPreview(layout);
}

function loadPreview(layout) {
  var loading = document.getElementById('session-preview-loading');
  var iframe = document.getElementById('session-preview-iframe');
  if (!iframe) return;

  var url = '/api/pdf/session/' + state.currentCampaign.id + '/' + state.currentSession.id +
    '?layout=' + encodeURIComponent(layout || state.layoutStyle || 'Classic');

  // Show loading state
  if (loading) loading.style.display = 'flex';
  iframe.style.display = 'none';
  iframe.src = '';

  // Load new preview
  iframe.onload = function() {
    if (loading) loading.style.display = 'none';
    iframe.style.display = 'block';
    resizePreviewIframe();
  };
  iframe.src = url;
}

// Grow the preview iframe to the full height of its content so there is
// no inner scrollbar — the user scrolls only the outer page.
function resizePreviewIframe() {
  var iframe = document.getElementById('session-preview-iframe');
  var frame = document.getElementById('session-preview-frame');
  if (!iframe) return;
  try {
    var doc = iframe.contentDocument || iframe.contentWindow.document;
    if (!doc || !doc.body) return;
    // Take the largest of several height measures to be safe across layouts
    var h = Math.max(
      doc.body.scrollHeight, doc.documentElement.scrollHeight,
      doc.body.offsetHeight, doc.documentElement.offsetHeight
    );
    if (h > 0) {
      iframe.style.height = h + 'px';
      if (frame) frame.style.height = 'auto';
    }
  } catch (e) {
    // If measurement fails for any reason, leave the iframe as-is
  }
}

// Re-measure on window resize — content reflow can change the height
window.addEventListener('resize', function() {
  var iframe = document.getElementById('session-preview-iframe');
  if (iframe && iframe.style.display !== 'none' && iframe.src) {
    resizePreviewIframe();
  }
});

// Map a layout value (including legacy names) to its chip id suffix
function layoutChipKey(layout) {
  var legacy = { cinematic: 'comicbook', dramatic: 'action' };
  var k = (layout || 'Classic').toLowerCase();
  return legacy[k] || k;
}

function applyLayoutStyle(layout) {
  state.layoutStyle = layout || 'Classic';
  document.querySelectorAll('#session-tab-export .chip').forEach(function(c){c.classList.remove('sel');});
  var el = document.getElementById('layout-' + layoutChipKey(layout));
  if (el) el.classList.add('sel');
}

function extractMoments() {
  var key = getApiKey();
  var transcript = document.getElementById('transcript-input').value.trim();
  var errorEl = document.getElementById('extract-error');
  errorEl.classList.add('hidden');

  if (transcript.length < 50) {
    errorEl.textContent = 'Please paste a longer transcript first.';
    errorEl.classList.remove('hidden');
    return;
  }

  // Warn before overwriting an existing storyboard
  if (state.moments && state.moments.length) {
    if (!confirm('This session already has a storyboard with ' + state.moments.length +
        ' panel' + (state.moments.length === 1 ? '' : 's') +
        '. Generating again will replace it — existing panels, narrative, and images will be lost. ' +
        'The character snapshots for this session will also be rebuilt. Continue?')) {
      return;
    }
  }

  // Auto save notes AND transcript
  var notesVal = document.getElementById('session-notes-input');
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' + state.currentSession.id, {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({
      transcript: transcript,
      session_notes: notesVal ? notesVal.value.trim() : ''
    })
  });

  var btn = document.getElementById('extract-btn');
  var wrap = document.getElementById('progress-wrap');
  var fill = document.getElementById('progress-fill');
  var msg = document.getElementById('progress-msg');

  btn.disabled = true;
  wrap.style.display = 'block';
  fill.style.width = '5%';
  msg.textContent = 'Reading your session transcript...';

  var pct = 5;
  var ticker = setInterval(function() {
    pct = Math.min(pct + Math.random() * 6, 88);
    fill.style.width = pct + '%';
  }, 400);

  fetch('/api/extract/' + state.currentCampaign.id + '/' + state.currentSession.id, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({key:key, artStyle:state.artStyle})
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    clearInterval(ticker);
    if (data.error) {
      errorEl.textContent = 'Error: ' + data.error;
      errorEl.classList.remove('hidden');
      wrap.style.display = 'none';
      btn.disabled = false;
      return;
    }
    fill.style.width = '60%';
    msg.textContent = 'Moments found! Writing your narrative...';
    state.moments = data.moments || [];
    state.pendingChanges = data.pendingChanges || 0;

    // Step 2 — Generate narrative then render everything together
    fetch('/api/narrative/generate/' + state.currentCampaign.id + '/' + state.currentSession.id, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({key: key})
    })
    .then(function(r) { return r.json(); })
    .then(function(narData) {
      // Set narrative BEFORE rendering storyboard
      state.narrativeData = {
        intro: narData.intro || '',
        sections: narData.sections || [],
        outro: narData.outro || ''
      };
      fill.style.width = '100%';
      msg.textContent = 'Your story is ready!';
      document.getElementById('moment-count').textContent = state.moments.length;
      renderStoryboard();
      setTimeout(function() {
        wrap.style.display = 'none';
        fill.style.width = '0%';
        btn.disabled = false;
        // If character changes were detected, send the DM to the
        // Characters tab to review them; otherwise go to Storyboard.
        if (state.pendingChanges && state.pendingChanges > 0) {
          switchSessionTab('characters');
        } else {
          // Land on Review so the DM can check the storyboard plan
          // before spending image-generation calls.
          switchSessionTab('review');
        }
      }, 800);
    })
    .catch(function() {
      // Narrative failed — still show storyboard with empty narrative
      state.narrativeData = { intro: '', sections: [], outro: '' };
      fill.style.width = '100%';
      msg.textContent = 'Moments extracted!';
      document.getElementById('moment-count').textContent = state.moments.length;
      renderStoryboard();
      setTimeout(function() {
        wrap.style.display = 'none';
        fill.style.width = '0%';
        btn.disabled = false;
        // If character changes were detected, send the DM to the
        // Characters tab to review them; otherwise go to Storyboard.
        if (state.pendingChanges && state.pendingChanges > 0) {
          switchSessionTab('characters');
        } else {
          // Land on Review so the DM can check the storyboard plan
          // before spending image-generation calls.
          switchSessionTab('review');
        }
      }, 800);
    });
  })
  .catch(function(e) {
    clearInterval(ticker);
    wrap.style.display = 'none';
    btn.disabled = false;
    errorEl.textContent = 'Connection error: ' + e.message;
    errorEl.classList.remove('hidden');
  });
}


// Auto-save narrative with debounce — saves 1.5 seconds after user stops typing
var narrativeSaveTimer = null;
function scheduleNarrativeSave() {
  if (narrativeSaveTimer) clearTimeout(narrativeSaveTimer);
  narrativeSaveTimer = setTimeout(function() {
    saveInlineNarrative(true); // true = silent save
  }, 1500);
}

function collectNarrativeState() {
  var intro = document.getElementById('narrative-intro-box');
  var outro = document.getElementById('narrative-outro-box');
  var sections = state.moments.slice(0, -1).map(function(m, i) {
    var box = document.getElementById('narrative-between-box-' + i);
    return { panel_index: i, before: '', after: box ? box.value.trim() : '' };
  });
  return {
    intro: intro ? intro.value.trim() : '',
    sections: sections,
    outro: outro ? outro.value.trim() : ''
  };
}

function saveNarrativeSection(type, panelIndex) {
  var data = collectNarrativeState();

  fetch('/api/narrative/save/' + state.currentCampaign.id + '/' + state.currentSession.id, {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify(data)
  })
  .then(function(r) { return r.json(); })
  .then(function(result) {
    if (result.error) { showAlert('Error: ' + result.error); return; }
    state.narrativeData = data;
    // Show brief saved indicator on the button
    var btnId = type === 'intro' ? 'narrative-opening'
      : type === 'outro' ? 'narrative-closing'
      : 'narrative-between-' + panelIndex;
    var block = document.getElementById(btnId);
    if (block) {
      var btn = block.querySelector('.narrative-save-btn');
      if (btn) {
        var orig = btn.textContent;
        btn.textContent = '✓ Saved!';
        btn.style.color = '#5dcaa5';
        setTimeout(function() { btn.textContent = orig; btn.style.color = ''; }, 1500);
      }
    }
  });
}

function saveInlineNarrative(silent) {
  var data = collectNarrativeState();
  fetch('/api/narrative/save/' + state.currentCampaign.id + '/' + state.currentSession.id, {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify(data)
  })
  .then(function(r) { return r.json(); })
  .then(function(result) {
    if (result.error) { if (!silent) showAlert('Error: ' + result.error); return; }
    state.narrativeData = data;
    if (!silent) showAlert('Narrative saved!');
  });
}

function regenNarrativeSection(type, panelIndex) {
  var key = getApiKey() || 'platform';  // Platform key used server-side

  // Save current state first
  saveInlineNarrative();

  // Show loading in the specific box
  var boxId = type === 'opening' ? 'narrative-intro-box'
    : type === 'closing' ? 'narrative-outro-box'
    : 'narrative-between-box-' + panelIndex;

  var box = document.getElementById(boxId);
  if (box) {
    box.value = 'Regenerating...';
    box.disabled = true;
  }

  // Regenerate full narrative and extract the relevant section
  fetch('/api/narrative/generate/' + state.currentCampaign.id + '/' + state.currentSession.id, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({key: key})
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.error) {
      if (box) { box.value = ''; box.disabled = false; }
      showAlert('Error: ' + data.error);
      return;
    }

    state.narrativeData = {
      intro: data.intro || '',
      sections: data.sections || [],
      outro: data.outro || ''
    };

    if (box) box.disabled = false;

    // Update just the relevant box
    if (type === 'opening' && box) box.value = data.intro || '';
    else if (type === 'closing' && box) box.value = data.outro || '';
    else if (type === 'between' && box) {
      var section = (data.sections||[]).find(function(s){return s.panel_index===panelIndex;});
      box.value = section ? (section.after || '') : '';
    }
  })
  .catch(function(e) {
    if (box) { box.value = ''; box.disabled = false; }
    showAlert('Error: ' + e.message);
  });
}

function generateAllImages() {
  var falKey = getFalKey() || 'platform';
  document.getElementById('generate-error').classList.add('hidden');

  // Warn if images already exist
  var hasImages = state.moments && state.moments.some(function(m) { return m.image; });
  if (hasImages) {
    if (!confirm('This will replace all existing panel images. Are you sure?')) {
      return;
    }
  }

  var btn = document.getElementById('generate-all-btn');
  var progressWrap = document.getElementById('generate-progress');
  var fill = document.getElementById('gen-progress-fill');
  var msg = document.getElementById('gen-progress-msg');

  btn.disabled = true;
  progressWrap.style.display = 'block';
  fill.style.width = '5%';
  msg.textContent = 'Generating ' + state.moments.length + ' images with Flux AI...';

  // Show shimmer on all panels
  state.moments.forEach(function(m) {
    var card = document.getElementById('moment-card-' + m.id);
    if (card) {
      var imgArea = card.querySelector('.moment-img, .moment-img-generated');
      if (imgArea) {
        imgArea.outerHTML = '<div class="moment-img-shimmer"><div class="moment-img-shimmer-text">&#10024; Generating...</div></div>';
      }
    }
  });

  fetch('/api/images/generate-all', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({
      session_id: state.currentSession.id,
      campaign_id: state.currentCampaign.id,
      style: state.artStyle,
      fal_key: falKey
    })
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.error) {
      // INSUFFICIENT_TOKENS carries a friendly message; show that.
      var emsg = (data.error === 'INSUFFICIENT_TOKENS' && data.message) ? data.message : ('Error: ' + data.error);
      document.getElementById('generate-error').textContent = emsg;
      document.getElementById('generate-error').classList.remove('hidden');
      btn.disabled = false;
      progressWrap.style.display = 'none';
      return;
    }

    fill.style.width = '100%';
    msg.textContent = data.count + ' of ' + data.total + ' images generated!';

    // Tokens were spent — update the header balance.
    if (typeof refreshTokenBalance === 'function') refreshTokenBalance();

    // Re-fetch the session fresh from the database so the storyboard
    // shows the newly generated images reliably (stays on this tab).
    refreshStoryboardImages();

    setTimeout(function() {
      btn.disabled = false;
      progressWrap.style.display = 'none';
      fill.style.width = '0%';
    }, 2000);
  })
  .catch(function(e) {
    document.getElementById('generate-error').textContent = 'Error: ' + e.message;
    document.getElementById('generate-error').classList.remove('hidden');
    btn.disabled = false;
    progressWrap.style.display = 'none';
  });
}

function regenImage(momentId, index) {
  var falKey = getFalKey() || 'platform';

  var moment = state.moments.find(function(m) { return m.id === momentId; });
  if (!moment) return;

  // Show shimmer on this card
  var card = document.getElementById('moment-card-' + momentId);
  if (card) {
    var imgArea = card.querySelector('.moment-img, .moment-img-generated, .moment-img-shimmer');
    if (imgArea) {
      imgArea.outerHTML = '<div class="moment-img-shimmer"><div class="moment-img-shimmer-text">&#10024; Regenerating...</div></div>';
    }
  }

  fetch('/api/images/generate-moment', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({
      moment_id: momentId,
      session_id: state.currentSession.id,
      campaign_id: state.currentCampaign.id,
      prompt: moment.prompt,
      style: state.artStyle,
      fal_key: falKey
    })
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.error) {
      var emsg = (data.error === 'INSUFFICIENT_TOKENS' && data.message) ? data.message : ('Error: ' + data.error);
      showAlert(emsg); renderStoryboard(); return;
    }
    moment.image = data.image_url;
    // A token was spent — update the header balance.
    if (typeof refreshTokenBalance === 'function') refreshTokenBalance();
    renderStoryboard();
    renderNovelWithImages();
  })
  .catch(function(e) { showAlert('Error: ' + e.message); renderStoryboard(); });
}

// ============================================================
// GRAPHIC NOVEL
// ============================================================
var novelLayoutStyle = 'Classic';

function switchNovelTab(tab) {
  ['sessions', 'preview'].forEach(function(t) {
    var pane = document.getElementById('novel-tab-' + t);
    if (pane) pane.style.display = t === tab ? 'block' : 'none';
    var el = document.getElementById('ntab-' + t);
    if (el) el.classList.toggle('active', t === tab);
  });
}

function selNovelLayout(el, layout) {
  document.querySelectorAll('#novel-tab-preview .chip').forEach(function(c){c.classList.remove('sel');});
  el.classList.add('sel');
  novelLayoutStyle = layout;
  loadNovelPreview(layout);
}

function loadNovelPreview(layout) {
  var loading = document.getElementById('novel-preview-loading');
  var iframe = document.getElementById('novel-preview-iframe');
  if (!iframe) return;

  if (layout) novelLayoutStyle = layout;

  // Build/refresh the session pager
  setupNovelPager();

  var total = (state.novelSessions || []).length;
  var url = '/api/pdf/novel/' + state.currentCampaign.id +
    '?layout=' + encodeURIComponent(novelLayoutStyle);
  // Paginate by session whenever there is more than one session
  if (total > 1) {
    url += '&page=' + novelPreviewPage;
  }

  if (loading) loading.style.display = 'flex';
  iframe.style.display = 'none';
  iframe.src = '';

  iframe.onload = function() {
    if (loading) loading.style.display = 'none';
    iframe.style.display = 'block';
    resizeNovelPreviewIframe();
  };
  iframe.src = url;
}

// ---- Novel preview pager ----
var novelPreviewPage = 1;

function setupNovelPager() {
  var warning = document.getElementById('novel-preview-warning');
  var sessions = state.novelSessions || [];
  var total = sessions.length;

  // Both pager bars: top and bottom. Suffix '' = top, '-bottom' = bottom.
  var suffixes = ['', '-bottom'];

  // Only show the pagers when there is more than one session
  if (total <= 1) {
    suffixes.forEach(function(sx) {
      var p = document.getElementById('novel-pager' + sx);
      if (p) p.style.display = 'none';
    });
    if (warning) warning.style.display = 'none';
    novelPreviewPage = 1;
    return;
  }

  // Clamp current page into range
  if (novelPreviewPage < 1) novelPreviewPage = 1;
  if (novelPreviewPage > total) novelPreviewPage = total;

  // Build dropdown options once, reuse for both bars
  var opts = '';
  for (var i = 0; i < total; i++) {
    var nm = sessions[i] && sessions[i].name ? sessions[i].name : ('Session ' + (i+1));
    var label = 'Session ' + (i+1) + ' of ' + total + '  —  ' + nm;
    opts += '<option value="' + (i+1) + '"' + ((i+1) === novelPreviewPage ? ' selected' : '') + '>' +
      label + '</option>';
  }

  suffixes.forEach(function(sx) {
    var pager = document.getElementById('novel-pager' + sx);
    if (!pager) return;
    var select = document.getElementById('novel-pager-select' + sx);
    if (select) select.innerHTML = opts;
    var prev = document.getElementById('novel-pager-prev' + sx);
    var next = document.getElementById('novel-pager-next' + sx);
    if (prev) prev.disabled = (novelPreviewPage <= 1);
    if (next) next.disabled = (novelPreviewPage >= total);
    pager.style.display = 'flex';
  });

  if (warning) warning.style.display = total > 15 ? 'block' : 'none';
}

// Scroll the preview area back to the top after navigating
// Find the nearest ancestor of `el` that actually has a vertical scrollbar.
function findScrollParent(el) {
  var node = el ? el.parentElement : null;
  while (node) {
    var style = window.getComputedStyle(node);
    var oy = style.overflowY;
    if ((oy === 'auto' || oy === 'scroll') && node.scrollHeight > node.clientHeight + 2) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

function scrollNovelPreviewToTop() {
  var anchor = document.getElementById('novel-pager') ||
               document.getElementById('novel-preview-frame');
  if (!anchor) { console.log('[pager-scroll] no anchor element found'); return; }

  function doScroll(label) {
    var scroller = findScrollParent(anchor);
    if (scroller) {
      var aRect = anchor.getBoundingClientRect();
      var sRect = scroller.getBoundingClientRect();
      var target = Math.max(0, scroller.scrollTop + (aRect.top - sRect.top) - 12);
      // Instant jump — a smooth scroll gets interrupted by the iframe resize.
      scroller.scrollTop = target;
      console.log('[pager-scroll ' + label + '] scrolled', scroller.className || scroller.tagName,
        'to', target);
    } else {
      // No scrollable ancestor found — fall back to window + documentElement.
      var rect = anchor.getBoundingClientRect();
      var top = Math.max(0, rect.top + (window.pageYOffset || 0) - 12);
      window.scrollTo(0, top);
      document.documentElement.scrollTop = top;
      document.body.scrollTop = top;
      console.log('[pager-scroll ' + label + '] no scroll parent — used window, top', top);
    }
  }

  // Scroll now, then re-assert after the iframe reloads/resizes the page.
  doScroll('immediate');
  setTimeout(function() { doScroll('settle-1'); }, 120);
  setTimeout(function() { doScroll('settle-2'); }, 500);
}

function novelPageJump(value) {
  var n = parseInt(value, 10);
  if (isNaN(n)) return;
  novelPreviewPage = n;
  loadNovelPreview(novelLayoutStyle);
  scrollNovelPreviewToTop();
}

function novelPagePrev() {
  if (novelPreviewPage > 1) {
    novelPreviewPage--;
    loadNovelPreview(novelLayoutStyle);
    scrollNovelPreviewToTop();
  }
}

function novelPageNext() {
  var total = (state.novelSessions || []).length;
  if (novelPreviewPage < total) {
    novelPreviewPage++;
    loadNovelPreview(novelLayoutStyle);
    scrollNovelPreviewToTop();
  }
}

// Grow the novel preview iframe to the full height of its content so there
// is no inner scrollbar — the user scrolls only the outer page.
function resizeNovelPreviewIframe() {
  var iframe = document.getElementById('novel-preview-iframe');
  var frame = document.getElementById('novel-preview-frame');
  if (!iframe) return;
  try {
    var doc = iframe.contentDocument || iframe.contentWindow.document;
    if (!doc || !doc.body) return;
    var h = Math.max(
      doc.body.scrollHeight, doc.documentElement.scrollHeight,
      doc.body.offsetHeight, doc.documentElement.offsetHeight
    );
    if (h > 0) {
      iframe.style.height = h + 'px';
      if (frame) frame.style.height = 'auto';
    }
  } catch (e) {
    // If measurement fails for any reason, leave the iframe as-is
  }
}

// Re-measure novel preview on window resize
window.addEventListener('resize', function() {
  var iframe = document.getElementById('novel-preview-iframe');
  if (iframe && iframe.style.display !== 'none' && iframe.src) {
    resizeNovelPreviewIframe();
  }
});

function previewNovelPDF() {
  novelPreviewPage = 1;
  switchNovelTab('preview');
  loadNovelPreview(novelLayoutStyle);
}

function exportNovelPDF() {
  var url = '/api/pdf/novel/' + state.currentCampaign.id + '?layout=' + encodeURIComponent(novelLayoutStyle);
  var win = window.open(url, '_blank');
  setTimeout(function() { if (win) win.print(); }, 5000);
}

function loadNovelSummary() {
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/novel/all')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      // Sort ascending by date (oldest first) using a normalized YYYY-MM-DD key
      var sessions = Array.isArray(data) ? data : [];
      function sessionDateKey(s) {
        if (!s.session_date) return '';
        if (typeof s.session_date === 'string') return s.session_date.split('T')[0];
        try { return s.session_date.toISOString().split('T')[0]; }
        catch (e) { return String(s.session_date); }
      }
      sessions.sort(function(a, b) {
        return sessionDateKey(a).localeCompare(sessionDateKey(b));
      });
      renderNovelSummary(sessions);
    });
}

function renderNovelSummary(sessions) {

  // Keep the ordered session list available for the preview pager
  state.novelSessions = sessions || [];

  var container = document.getElementById('novel-summary-list');
  if (!sessions.length) {
    container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">&#128213;</div>' +
      '<h3>No sessions yet</h3><p>Create sessions and extract moments to build your graphic novel</p></div>';
    return;
  }

  var totalMoments = 0;
  var html = sessions.map(function(s, i) {
    var moments = s.moments || [];
    totalMoments += moments.length;
    var momentsHtml = moments.length
      ? '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;padding:10px 14px;">' +
        moments.map(function(m, j) {
          return '<div style="position:relative;border-radius:6px;overflow:hidden;background:rgba(15,10,5,0.6);border:1px solid rgba(201,168,76,0.1);">' +
            (m.image
              ? '<img src="' + m.image + '" style="width:100%;aspect-ratio:4/3;object-fit:cover;display:block;cursor:zoom-in;" onclick="openLightbox(this.src,this.alt)" alt="' + m.title + '" />'
              : '<div style="width:100%;aspect-ratio:4/3;display:flex;align-items:center;justify-content:center;font-size:20px;opacity:0.2;">&#128444;</div>') +
            '<div style="padding:5px 7px;">' +
              '<div style="font-size:9px;color:rgba(201,168,76,0.4);">Panel ' + (j+1) + '</div>' +
              '<div style="font-size:10px;color:var(--gold-light);font-weight:600;line-height:1.3;">' + m.title + '</div>' +
            '</div>' +
          '</div>';
        }).join('') + '</div>'
      : '<div class="novel-empty">No moments extracted yet — open this session to generate storyboard panels</div>';

    return '<div class="novel-session-block">' +
      '<div class="novel-session-header">' +
        '<div><div class="novel-session-title">Session ' + (i+1) + ' &mdash; ' + s.name + '</div>' +
        '<div class="novel-session-date">' + formatSessionDate(s.session_date) + '</div></div>' +
        '<span class="session-badge' + (moments.length?'':' empty') + '">' + moments.length + ' panels</span>' +
      '</div>' +
      '<div class="novel-session-moments">' + momentsHtml + '</div>' +
    '</div>';
  }).join('');

  container.innerHTML = '<div style="font-size:12px;color:rgba(201,168,76,0.5);margin-bottom:14px;">' +
    sessions.length + ' sessions in chronological order &middot; ' + totalMoments + ' total panels</div>' + html;
}

function showNovelPreview() {
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/novel/all')
    .then(function(r) { return r.json(); })
    .then(function(data) { renderNovelPreview(Array.isArray(data) ? data : []); });
}

function renderNovelWithImages() {
  // Re-render novel panels for current session with updated images
  if (!state.moments.length) return;
  var panels = document.getElementById('novel-panels');
  if (panels) {
    panels.innerHTML = state.moments.map(function(m, i) {
      var wide = (i === 0 || i === Math.floor(state.moments.length / 2));
      var imgContent = m.image
        ? '<img src="' + m.image + '" style="width:100%;height:100%;object-fit:cover;cursor:zoom-in;" alt="' + m.title + '" onclick="openLightbox(this.src,this.alt)" title="Click to enlarge" />'
        : '<div class="novel-panel-inner"><div style="font-size:20px;margin-bottom:4px;">&#128444;</div>' + m.title + '</div>';
      return '<div class="novel-panel' + (wide ? ' wide' : '') + '">' +
        imgContent +
        '<div class="novel-caption">' + m.description + '</div>' +
      '</div>';
    }).join('');
  }
}

function renderNovelPreview(sessions) {
  document.getElementById('novel-summary-list').innerHTML = '';
  document.getElementById('preview-novel-btn').style.display = 'none';
  document.getElementById('novel-preview-section').style.display = 'block';

  var html = sessions.map(function(s, si) {
    var moments = s.moments || [];
    if (!moments.length) return '';
    return '<div>' +
      '<div class="novel-chapter-header">Session ' + (si+1) + ' &mdash; ' + s.name + '</div>' +
      '<div class="novel-grid" style="grid-template-columns:1fr 1fr;gap:2px;background:#222;padding:2px;">' +
      moments.map(function(m, i) {
        var wide = (i===0 || i===Math.floor(moments.length/2));
        var imgContent = m.image
          ? '<img src="' + m.image + '" style="width:100%;height:100%;object-fit:cover;cursor:zoom-in;" alt="' + m.title + '" onclick="openLightbox(this.src,this.alt)" title="Click to enlarge" />'
          : '<div class="novel-panel-inner"><div style="font-size:20px;margin-bottom:4px;">&#128444;</div>' + m.title + '</div>';
        return '<div class="novel-panel' + (wide?' wide':'') + '">' +
          imgContent +
          '<div class="novel-caption">' + m.description + '</div>' +
        '</div>';
      }).join('') + '</div></div>';
  }).join('');

  document.getElementById('novel-all-panels').innerHTML = html ||
    '<div class="empty-state" style="padding:2rem;"><p>No moments extracted yet.</p></div>';
}

function hideNovelPreview() { loadNovelSummary(); }

// ============================================================
// SETTINGS
// ============================================================
function loadSettingsForm() {
  document.getElementById('settings-name').value = state.user.name || '';
  document.getElementById('settings-email').value = state.user.email || '';
  // Load stored keys
  fetch('/api/auth/apikey')
    .then(function(r) { return r.json(); })
    .then(function(k) {
      var sk = document.getElementById('settings-apikey');
      if (k.api_key && sk) sk.value = k.api_key;
      var fk = document.getElementById('settings-falkey');
      if (k.fal_key && fk) fk.value = k.fal_key;
    });
  // Load the current global image-generation model
  fetch('/api/auth/image-model')
    .then(function(r) { return r.json(); })
    .then(function(d) {
      var el = document.getElementById('settings-image-model');
      if (el && d.model) el.value = d.model;
    });
}

function saveImageModel() {
  var el = document.getElementById('settings-image-model');
  if (!el) return;
  fetch('/api/auth/image-model', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: el.value })
  })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (d.error) {
        showSettingsError('model-error', d.error);
      } else {
        var ok = document.getElementById('model-success');
        if (ok) {
          ok.textContent = 'Image model saved.';
          ok.classList.remove('hidden');
          setTimeout(function() { ok.classList.add('hidden'); }, 2500);
        }
      }
    })
    .catch(function() {
      showSettingsError('model-error', 'Could not save. Please try again.');
    });
}

function saveProfile() {
  var name = document.getElementById('settings-name').value.trim();
  var email = document.getElementById('settings-email').value.trim();
  document.getElementById('profile-error').classList.add('hidden');
  document.getElementById('profile-success').classList.add('hidden');
  if (!name || !email) { showSettingsError('profile-error', 'Name and email are required.'); return; }

  fetch('/api/auth/profile', {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({name:name, email:email})
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.error) { showSettingsError('profile-error', data.error); return; }
    state.user.name = name;
    state.user.email = email;
    document.getElementById('user-name').textContent = name;
    document.getElementById('user-menu-email').textContent = email;
    var initials = name.split(' ').map(function(w){return w[0];}).join('').slice(0,2).toUpperCase();
    document.getElementById('user-avatar').textContent = initials;
    document.getElementById('profile-success').textContent = 'Profile updated!';
    document.getElementById('profile-success').classList.remove('hidden');
    setTimeout(function() { document.getElementById('profile-success').classList.add('hidden'); }, 2500);
  });
}

function saveApiKey() {
  var apiEl = document.getElementById('settings-apikey');
  if (!apiEl) return;
  var key = apiEl.value.trim();
  document.getElementById('apikey-success').classList.add('hidden');
  fetch('/api/auth/apikey', {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({api_key:key})
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.error) { alert(data.error); return; }
    document.getElementById('apikey-success').textContent = 'API key saved!';
    document.getElementById('apikey-success').classList.remove('hidden');
    setTimeout(function() { document.getElementById('apikey-success').classList.add('hidden'); }, 2500);
  });
}

function saveFalKey() {
  var falEl = document.getElementById('settings-falkey');
  if (!falEl) return;
  var key = falEl.value.trim();
  document.getElementById('falkey-success').classList.add('hidden');
  fetch('/api/auth/apikey', {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({fal_key:key})
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.error) { alert(data.error); return; }
    document.getElementById('falkey-success').textContent = 'fal.ai key saved!';
    document.getElementById('falkey-success').classList.remove('hidden');
    setTimeout(function() { document.getElementById('falkey-success').classList.add('hidden'); }, 2500);
  });
}

function getFalKey() {
  var el = document.getElementById('settings-falkey');
  return el ? el.value.trim() : '';
}

function changePassword() {
  var current = document.getElementById('settings-current-password').value;
  var newpw = document.getElementById('settings-new-password').value;
  document.getElementById('password-error').classList.add('hidden');
  document.getElementById('password-success').classList.add('hidden');
  if (!current || !newpw) { showSettingsError('password-error', 'Both fields are required.'); return; }
  if (newpw.length < 8) { showSettingsError('password-error', 'New password must be at least 8 characters.'); return; }

  fetch('/api/auth/password', {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({current_password:current, new_password:newpw})
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.error) { showSettingsError('password-error', data.error); return; }
    document.getElementById('settings-current-password').value = '';
    document.getElementById('settings-new-password').value = '';
    document.getElementById('password-success').textContent = 'Password changed successfully!';
    document.getElementById('password-success').classList.remove('hidden');
    setTimeout(function() { document.getElementById('password-success').classList.add('hidden'); }, 2500);
  });
}

function showSettingsError(id, msg) {
  var el = document.getElementById(id);
  el.textContent = msg;
  el.classList.remove('hidden');
}

// ============================================================
// DRAG AND DROP — Character portraits
// ============================================================

// Image slot handlers — modal upload areas
var slotFiles = {}; // Tracks new files selected for each slot

function handleSlotDragOver(e, slot) {
  e.preventDefault();
  e.stopPropagation();
  document.getElementById('drop-' + slot).classList.add('drag-over');
}

function handleSlotDragLeave(e, slot) {
  e.preventDefault();
  e.stopPropagation();
  document.getElementById('drop-' + slot).classList.remove('drag-over');
}

function handleSlotDrop(e, slot) {
  e.preventDefault();
  e.stopPropagation();
  document.getElementById('drop-' + slot).classList.remove('drag-over');
  var files = e.dataTransfer.files;
  if (!files || !files[0]) return;
  if (!files[0].type.match('image.*')) { showAlert('Please drop an image file'); return; }
  setSlotFile(slot, files[0]);
}

function handleSlotFileSelect(e, slot) {
  if (e.target.files && e.target.files[0]) {
    setSlotFile(slot, e.target.files[0]);
  }
}

function setSlotFile(slot, file) {
  slotFiles[slot] = file;
  var reader = new FileReader();
  reader.onload = function(ev) {
    var preview = document.getElementById('preview-' + slot);
    var placeholder = document.getElementById('placeholder-' + slot);
    var clearBtn = document.getElementById('clear-' + slot);
    preview.src = ev.target.result;
    preview.classList.remove('hidden');
    preview.onclick = function() { openLightbox(ev.target.result, slot.replace('image_', '').replace('_', ' ')); };
    if (placeholder) placeholder.style.display = 'none';
    if (clearBtn) clearBtn.style.display = 'inline-flex';
  };
  reader.readAsDataURL(file);
}

function clearSlot(slot) {
  slotFiles[slot] = null;
  var preview = document.getElementById('preview-' + slot);
  var placeholder = document.getElementById('placeholder-' + slot);
  var clearBtn = document.getElementById('clear-' + slot);
  var input = document.getElementById('input-' + slot);
  preview.src = '';
  preview.classList.add('hidden');
  if (placeholder) placeholder.style.display = 'flex';
  if (clearBtn) clearBtn.style.display = 'none';
  if (input) input.value = '';
  // Mark for clearing on save
  slotFiles[slot + '_clear'] = true;
}

function loadSlotPreviews(char) {
  var slots = ['image_portrait', 'image_fullbody', 'image_action', 'image_other'];
  slots.forEach(function(slot) {
    var preview = document.getElementById('preview-' + slot);
    var placeholder = document.getElementById('placeholder-' + slot);
    var clearBtn = document.getElementById('clear-' + slot);
    var url = char ? char[slot] : null;
    slotFiles[slot] = null;
    slotFiles[slot + '_clear'] = false;

    if (url) {
      preview.src = url;
      preview.classList.remove('hidden');
      preview.onclick = function() { openLightbox(url, slot.replace('image_', '').replace('_', ' ')); };
      if (placeholder) placeholder.style.display = 'none';
      if (clearBtn) clearBtn.style.display = 'inline-flex';
    } else {
      preview.src = '';
      preview.classList.add('hidden');
      if (placeholder) placeholder.style.display = 'flex';
      if (clearBtn) clearBtn.style.display = 'none';
    }
  });
}

// Drag and drop directly onto character cards
function setupCardDragDrop() {
  var grid = document.getElementById('char-grid');
  if (!grid) return;

  grid.addEventListener('dragenter', function(e) {
    e.preventDefault();
    e.stopPropagation();
    var card = e.target.closest('.char-card-drop');
    if (card) card.classList.add('drag-over');
  });

  grid.addEventListener('dragover', function(e) {
    e.preventDefault();
    e.stopPropagation();
    var card = e.target.closest('.char-card-drop');
    // Remove drag-over from all cards first
    grid.querySelectorAll('.char-card-drop').forEach(function(c) { c.classList.remove('drag-over'); });
    if (card) card.classList.add('drag-over');
  });

  grid.addEventListener('dragleave', function(e) {
    e.preventDefault();
    e.stopPropagation();
    // Only remove if leaving the grid entirely
    if (!grid.contains(e.relatedTarget)) {
      grid.querySelectorAll('.char-card-drop').forEach(function(c) { c.classList.remove('drag-over'); });
    }
  });

  grid.addEventListener('drop', function(e) {
    e.preventDefault();
    e.stopPropagation();
    grid.querySelectorAll('.char-card-drop').forEach(function(c) { c.classList.remove('drag-over'); });

    var card = e.target.closest('.char-card-drop');
    if (!card) return;

    var files = e.dataTransfer.files;
    if (!files || !files[0]) return;

    var file = files[0];
    if (!file.type.match('image.*')) {
      showAlert('Please drop an image file (JPG, PNG, WebP)');
      return;
    }

    var charId = parseInt(card.id.replace('char-card-', ''));
    if (!charId) return;

    uploadPortraitToChar(charId, file);
  });
}

function uploadPortraitToChar(charId, file) {
  var formData = new FormData();
  formData.append('image', file);

  // Get existing char data to preserve it
  var char = state.characters.find(function(c) { return c.id === charId; });
  if (!char) return;

  formData.append('name', char.name);
  formData.append('cls', char.cls || '');
  formData.append('description', char.description || '');
  formData.append('player_name', char.player_name || '');

  // Show uploading indicator on the card
  var card = document.getElementById('char-card-' + charId);
  if (card) {
    var avatar = card.querySelector('.char-avatar');
    if (avatar) avatar.style.opacity = '0.5';
  }

  fetch('/api/campaigns/' + state.currentCampaign.id + '/characters/' + charId, {
    method: 'PUT',
    body: formData
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.error) { showAlert('Error uploading portrait: ' + data.error); return; }
    showAlert('Portrait updated for ' + char.name + '!');
    loadCharacters();
  })
  .catch(function(e) { showAlert('Error: ' + e.message); });
}

// ============================================================
// NARRATIVE
// ============================================================

var narrativeData = { intro: '', sections: [], outro: '' };

function loadNarrative() {
  fetch('/api/narrative/' + state.currentCampaign.id + '/' + state.currentSession.id)
    .then(function(r) { return r.json(); })
    .then(function(data) {
      narrativeData = data;
      if (data.intro || (data.sections && data.sections.length) || data.outro) {
        renderNarrativeEditor(data);
        document.getElementById('narrative-empty').style.display = 'none';
        document.getElementById('narrative-content').style.display = 'block';
      } else {
        document.getElementById('narrative-empty').style.display = 'block';
        document.getElementById('narrative-content').style.display = 'none';
      }
    });
}

function generateNarrative() {
  var key = getApiKey() || 'platform';  // Platform key used server-side

  var btn = document.getElementById('regen-narrative-btn');
  var progress = document.getElementById('narrative-progress');
  var fill = document.getElementById('narrative-progress-fill');
  var msg = document.getElementById('narrative-progress-msg');
  var errorEl = document.getElementById('narrative-error');

  if (btn) btn.disabled = true;
  if (errorEl) errorEl.classList.add('hidden');
  document.getElementById('narrative-empty').style.display = 'none';
  document.getElementById('narrative-content').style.display = 'block';
  if (progress) progress.style.display = 'block';

  var pct = 5;
  var ticker = setInterval(function() {
    pct = Math.min(pct + Math.random() * 5, 88);
    if (fill) fill.style.width = pct + '%';
  }, 500);

  if (msg) msg.textContent = 'Writing your story narrative...';

  fetch('/api/narrative/generate/' + state.currentCampaign.id + '/' + state.currentSession.id, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({key: key})
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    clearInterval(ticker);
    if (progress) progress.style.display = 'none';
    if (btn) btn.disabled = false;

    if (data.error) {
      if (errorEl) { errorEl.textContent = 'Error: ' + data.error; errorEl.classList.remove('hidden'); }
      return;
    }

    narrativeData = data;
    renderNarrativeEditor(data);
    if (fill) fill.style.width = '0%';
  })
  .catch(function(e) {
    clearInterval(ticker);
    if (progress) progress.style.display = 'none';
    if (btn) btn.disabled = false;
    if (errorEl) { errorEl.textContent = 'Error: ' + e.message; errorEl.classList.remove('hidden'); }
  });
}

function renderNarrativeEditor(data) {
  var editor = document.getElementById('narrative-editor');
  var html = '';

  // Intro section
  html += '<div class="narrative-section">' +
    '<div class="narrative-section-header">Opening — before first panel</div>' +
    '<textarea class="narrative-textarea" id="narrative-intro" placeholder="Opening paragraph that sets the scene...">' +
    (data.intro || '') + '</textarea>' +
  '</div>';

  // Per-moment sections
  state.moments.forEach(function(m, i) {
    var section = (data.sections || []).find(function(s) { return s.panel_index === i; }) || {};

    html += '<div class="narrative-section">' +
      '<div class="narrative-section-header">' +
        (m.image ? '<img class="narrative-section-img" src="' + m.image + '" alt="' + m.title + '" onclick="openLightbox(this.src,this.alt)" />' : '') +
        'Panel ' + (i+1) + ' — ' + m.title +
      '</div>' +
      '<textarea class="narrative-textarea" id="narrative-before-' + i + '" placeholder="Prose leading into this panel...">' +
      (section.before || '') + '</textarea>' +
      (i < state.moments.length - 1
        ? '<div style="padding:4px 14px;font-size:10px;color:rgba(201,168,76,0.3);font-style:italic;">— panel image appears here —</div>' +
          '<textarea class="narrative-textarea" id="narrative-after-' + i + '" placeholder="Prose bridging from this panel to the next...">' +
          (section.after || '') + '</textarea>'
        : '<div style="padding:4px 14px;font-size:10px;color:rgba(201,168,76,0.3);font-style:italic;">— final panel image appears here —</div>') +
    '</div>';
  });

  // Outro section
  html += '<div class="narrative-section">' +
    '<div class="narrative-section-header">Closing — after final panel</div>' +
    '<textarea class="narrative-textarea" id="narrative-outro" placeholder="Closing paragraph — what this session meant, what comes next...">' +
    (data.outro || '') + '</textarea>' +
  '</div>';

  editor.innerHTML = html;
}

function collectNarrativeFromEditor() {
  var intro = document.getElementById('narrative-intro');
  var outro = document.getElementById('narrative-outro');
  var sections = state.moments.map(function(m, i) {
    var before = document.getElementById('narrative-before-' + i);
    var after = document.getElementById('narrative-after-' + i);
    return {
      panel_index: i,
      before: before ? before.value.trim() : '',
      after: after ? after.value.trim() : ''
    };
  });
  return {
    intro: intro ? intro.value.trim() : '',
    sections: sections,
    outro: outro ? outro.value.trim() : ''
  };
}

function saveNarrative() {
  var data = collectNarrativeFromEditor();
  fetch('/api/narrative/save/' + state.currentCampaign.id + '/' + state.currentSession.id, {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify(data)
  })
  .then(function(r) { return r.json(); })
  .then(function(result) {
    if (result.error) { showAlert('Error saving: ' + result.error); return; }
    narrativeData = data;
    showAlert('Narrative saved!');
  });
}

// ============================================================
// PDF EXPORT
// ============================================================


// ============================================================
// LIGHTBOX
// ============================================================

function openLightbox(src, caption) {
  if (!src) return;

  // Remove any existing lightbox
  closeLightbox();

  var overlay = document.createElement('div');
  overlay.className = 'lightbox-overlay';
  overlay.id = 'lightbox';
  overlay.onclick = function(e) {
    if (e.target === overlay || e.target.classList.contains('lightbox-close')) {
      closeLightbox();
    }
  };

  var close = document.createElement('div');
  close.className = 'lightbox-close';
  close.innerHTML = '&times;';
  close.onclick = closeLightbox;

  var img = document.createElement('img');
  img.className = 'lightbox-img';
  img.src = src;
  img.alt = caption || '';

  overlay.appendChild(close);
  overlay.appendChild(img);

  if (caption) {
    var cap = document.createElement('div');
    cap.className = 'lightbox-caption';
    cap.textContent = caption;
    overlay.appendChild(cap);
  }

  document.body.appendChild(overlay);

  // Close on escape key
  document.addEventListener('keydown', handleLightboxKey);
}

function handleLightboxKey(e) {
  if (e.key === 'Escape') closeLightbox();
}

function closeLightbox() {
  var existing = document.getElementById('lightbox');
  if (existing) existing.remove();
  document.removeEventListener('keydown', handleLightboxKey);
}

// ============================================================
// UTILITIES
// ============================================================
function showModalError(id, msg) {
  var el = document.getElementById(id);
  el.textContent = msg;
  el.classList.remove('hidden');
}

function showAlert(msg) {
  var el = document.createElement('div');
  el.className = 'alert alert-success';
  el.textContent = msg;
  el.style.cssText = 'position:fixed;top:16px;right:16px;z-index:999;min-width:200px;box-shadow:0 4px 12px rgba(0,0,0,0.15);';
  document.body.appendChild(el);
  setTimeout(function() { el.remove(); }, 2500);
}
