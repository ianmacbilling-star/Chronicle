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
      document.getElementById('user-name').textContent = data.name;
      document.getElementById('user-menu-email').textContent = data.email;
      var initials = data.name.split(' ').map(function(w) { return w[0]; }).join('').slice(0,2).toUpperCase();
      document.getElementById('user-avatar').textContent = initials;

      // Load saved API key into settings field
      fetch('/api/auth/apikey')
        .then(function(r) { return r.json(); })
        .then(function(k) {
          if (k.api_key) {
            document.getElementById('settings-apikey').value = k.api_key;
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
  return document.getElementById('settings-apikey').value.trim();
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
  var views = ['campaigns','sessions','characters','novel','session-detail','account','settings'];
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
    document.getElementById('snav-campaigns').classList.add('active');
    document.getElementById('campaign-subnav').style.display = 'none';
    state.currentCampaign = null;
    state.currentSession = null;
    setBreadcrumb([{label:'My Campaigns'}]);
    loadCampaigns();
  } else if (view === 'account') {
    var sn = document.getElementById('snav-account');
    if (sn) sn.classList.add('active');
    document.getElementById('campaign-subnav').style.display = 'none';
    setBreadcrumb([
      {label:'My Campaigns', action:"showView('campaigns')"},
      {label:'My Account'}
    ]);
  } else if (view === 'settings') {
    document.getElementById('snav-settings').classList.add('active');
    document.getElementById('campaign-subnav').style.display = 'none';
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
  document.getElementById('campaign-subnav').style.display = 'block';
  document.getElementById('sidebar-campaign-name').textContent = state.currentCampaign.name;

  // Sidebar active — novel has no sidebar item so skip it
  if (section !== 'novel') {
    var navId = 'snav-' + section;
    var el = document.getElementById(navId);
    if (el) el.classList.add('active');
  }

  // Breadcrumb
  var sectionLabel = {sessions:'Sessions', characters:'Characters', novel:'Graphic Novel'}[section] || section;
  setBreadcrumb([
    {label:'My Campaigns', action:"showView('campaigns')"},
    {label:state.currentCampaign.name, action:"showCampaignSection('sessions')"},
    {label:sectionLabel}
  ]);

  if (section === 'sessions') loadSessions();
  if (section === 'characters') loadCharacters();
  if (section === 'novel') loadNovelSummary();
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
  document.getElementById('campaign-subnav').style.display = 'block';
  document.getElementById('sidebar-campaign-name').textContent = state.currentCampaign.name;
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
        if (transcriptEl) transcriptEl.value = data.transcript || '';
        if (notesEl) {
          notesEl.value = data.session_notes || '';
          // Auto-save notes when DM types
          notesEl.oninput = function() {
            clearTimeout(notesEl._saveTimer);
            notesEl._saveTimer = setTimeout(function() {
              fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' + state.currentSession.id, {
                method: 'PUT',
                headers: {'Content-Type':'application/json'},
                body: JSON.stringify({session_notes: notesEl.value.trim()})
              }).catch(function(){});
            }, 1500);
          };
        }
      }, 50);

      // Update sidebar
      document.querySelectorAll('.sidebar-item').forEach(function(el) { el.classList.remove('active'); });
      document.getElementById('snav-sessions').classList.add('active');
      document.getElementById('campaign-subnav').style.display = 'block';
      document.getElementById('sidebar-campaign-name').textContent = state.currentCampaign.name;

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
  var tabs = ['notes', 'storyboard', 'export'];
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
    var primaryImg = c.image_portrait || c.image_fullbody || c.image_action || c.image_other || c.image;
    var portrait = primaryImg
      ? '<img src="' + primaryImg + '" style="width:100%;height:100%;object-fit:cover;cursor:zoom-in;" alt="' + c.name + '" onclick="openLightbox(this.src,this.alt)" title="Click to enlarge" />'
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
  loadSlotPreviews(char);
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
      closeCharModal();
      loadCharacters();
    });
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

  if (!key || key.indexOf('sk-ant-') !== 0) {
    errorEl.textContent = 'Please add your Anthropic API key in Settings first.';
    errorEl.classList.remove('hidden');
    return;
  }
  if (transcript.length < 50) {
    errorEl.textContent = 'Please paste a longer transcript first.';
    errorEl.classList.remove('hidden');
    return;
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
        switchSessionTab('storyboard');
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
        switchSessionTab('storyboard');
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
      document.getElementById('generate-error').textContent = 'Error: ' + data.error;
      document.getElementById('generate-error').classList.remove('hidden');
      btn.disabled = false;
      progressWrap.style.display = 'none';
      return;
    }

    fill.style.width = '100%';
    msg.textContent = data.count + ' of ' + data.total + ' images generated!';

    // Update moment images in state
    data.generated.forEach(function(result) {
      if (result.success) {
        var moment = state.moments.find(function(m) { return m.id === result.moment_id; });
        if (moment) moment.image = result.image_url;
      }
    });

    // Re-render storyboard with images
    renderStoryboard();
    renderNovelWithImages();

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
    if (data.error) { showAlert('Error: ' + data.error); renderStoryboard(); return; }
    moment.image = data.image_url;
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
function scrollNovelPreviewToTop() {
  var anchor = document.getElementById('novel-pager') ||
               document.getElementById('novel-preview-frame');
  if (!anchor) return;
  // Defer so the scroll is computed after loadNovelPreview has updated the
  // DOM (hiding the iframe / showing the loading box shifts page height).
  setTimeout(function() {
    var rect = anchor.getBoundingClientRect();
    var top = rect.top + (window.pageYOffset || document.documentElement.scrollTop || 0);
    // Small offset so the pager isn't flush against the very top edge
    top = Math.max(0, top - 12);
    window.scrollTo({ top: top, behavior: 'smooth' });
  }, 60);
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
      if (k.api_key) document.getElementById('settings-apikey').value = k.api_key;
      if (k.fal_key) document.getElementById('settings-falkey').value = k.fal_key;
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
  var key = document.getElementById('settings-apikey').value.trim();
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
  var key = document.getElementById('settings-falkey').value.trim();
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
      '<div class="moment-prompt-text">' + (m.prompt||'') + '</div>' +
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
      document.getElementById('user-name').textContent = data.name;
      document.getElementById('user-menu-email').textContent = data.email;
      var initials = data.name.split(' ').map(function(w) { return w[0]; }).join('').slice(0,2).toUpperCase();
      document.getElementById('user-avatar').textContent = initials;

      // Load saved API key into settings field
      fetch('/api/auth/apikey')
        .then(function(r) { return r.json(); })
        .then(function(k) {
          if (k.api_key) {
            document.getElementById('settings-apikey').value = k.api_key;
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
  return document.getElementById('settings-apikey').value.trim();
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
  var views = ['campaigns','sessions','characters','novel','session-detail','account','settings'];
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
    document.getElementById('snav-campaigns').classList.add('active');
    document.getElementById('campaign-subnav').style.display = 'none';
    state.currentCampaign = null;
    state.currentSession = null;
    setBreadcrumb([{label:'My Campaigns'}]);
    loadCampaigns();
  } else if (view === 'account') {
    var sn = document.getElementById('snav-account');
    if (sn) sn.classList.add('active');
    document.getElementById('campaign-subnav').style.display = 'none';
    setBreadcrumb([
      {label:'My Campaigns', action:"showView('campaigns')"},
      {label:'My Account'}
    ]);
  } else if (view === 'settings') {
    document.getElementById('snav-settings').classList.add('active');
    document.getElementById('campaign-subnav').style.display = 'none';
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
  document.getElementById('campaign-subnav').style.display = 'block';
  document.getElementById('sidebar-campaign-name').textContent = state.currentCampaign.name;

  // Sidebar active — novel has no sidebar item so skip it
  if (section !== 'novel') {
    var navId = 'snav-' + section;
    var el = document.getElementById(navId);
    if (el) el.classList.add('active');
  }

  // Breadcrumb
  var sectionLabel = {sessions:'Sessions', characters:'Characters', novel:'Graphic Novel'}[section] || section;
  setBreadcrumb([
    {label:'My Campaigns', action:"showView('campaigns')"},
    {label:state.currentCampaign.name, action:"showCampaignSection('sessions')"},
    {label:sectionLabel}
  ]);

  if (section === 'sessions') loadSessions();
  if (section === 'characters') loadCharacters();
  if (section === 'novel') loadNovelSummary();
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
  document.getElementById('campaign-subnav').style.display = 'block';
  document.getElementById('sidebar-campaign-name').textContent = state.currentCampaign.name;
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
        if (transcriptEl) transcriptEl.value = data.transcript || '';
        if (notesEl) {
          notesEl.value = data.session_notes || '';
          // Auto-save notes when DM types
          notesEl.oninput = function() {
            clearTimeout(notesEl._saveTimer);
            notesEl._saveTimer = setTimeout(function() {
              fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' + state.currentSession.id, {
                method: 'PUT',
                headers: {'Content-Type':'application/json'},
                body: JSON.stringify({session_notes: notesEl.value.trim()})
              }).catch(function(){});
            }, 1500);
          };
        }
      }, 50);

      // Update sidebar
      document.querySelectorAll('.sidebar-item').forEach(function(el) { el.classList.remove('active'); });
      document.getElementById('snav-sessions').classList.add('active');
      document.getElementById('campaign-subnav').style.display = 'block';
      document.getElementById('sidebar-campaign-name').textContent = state.currentCampaign.name;

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
  var tabs = ['notes', 'storyboard', 'export'];
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
    var primaryImg = c.image_portrait || c.image_fullbody || c.image_action || c.image_other || c.image;
    var portrait = primaryImg
      ? '<img src="' + primaryImg + '" style="width:100%;height:100%;object-fit:cover;cursor:zoom-in;" alt="' + c.name + '" onclick="openLightbox(this.src,this.alt)" title="Click to enlarge" />'
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

  if (!key || key.indexOf('sk-ant-') !== 0) {
    errorEl.textContent = 'Please add your Anthropic API key in Settings first.';
    errorEl.classList.remove('hidden');
    return;
  }
  if (transcript.length < 50) {
    errorEl.textContent = 'Please paste a longer transcript first.';
    errorEl.classList.remove('hidden');
    return;
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
        switchSessionTab('storyboard');
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
        switchSessionTab('storyboard');
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
      document.getElementById('generate-error').textContent = 'Error: ' + data.error;
      document.getElementById('generate-error').classList.remove('hidden');
      btn.disabled = false;
      progressWrap.style.display = 'none';
      return;
    }

    fill.style.width = '100%';
    msg.textContent = data.count + ' of ' + data.total + ' images generated!';

    // Update moment images in state
    data.generated.forEach(function(result) {
      if (result.success) {
        var moment = state.moments.find(function(m) { return m.id === result.moment_id; });
        if (moment) moment.image = result.image_url;
      }
    });

    // Re-render storyboard with images
    renderStoryboard();
    renderNovelWithImages();

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
    if (data.error) { showAlert('Error: ' + data.error); renderStoryboard(); return; }
    moment.image = data.image_url;
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
function scrollNovelPreviewToTop() {
  var anchor = document.getElementById('novel-pager') ||
               document.getElementById('novel-preview-frame');
  if (!anchor) return;
  // Defer so the scroll is computed after loadNovelPreview has updated the
  // DOM (hiding the iframe / showing the loading box shifts page height).
  setTimeout(function() {
    var rect = anchor.getBoundingClientRect();
    var top = rect.top + (window.pageYOffset || document.documentElement.scrollTop || 0);
    // Small offset so the pager isn't flush against the very top edge
    top = Math.max(0, top - 12);
    window.scrollTo({ top: top, behavior: 'smooth' });
  }, 60);
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
      if (k.api_key) document.getElementById('settings-apikey').value = k.api_key;
      if (k.fal_key) document.getElementById('settings-falkey').value = k.fal_key;
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
  var key = document.getElementById('settings-apikey').value.trim();
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
  var key = document.getElementById('settings-falkey').value.trim();
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
