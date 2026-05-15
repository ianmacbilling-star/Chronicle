// ============================================================
// STATE
// ============================================================
var state = {
  user: null,
  campaigns: [],
  currentCampaign: null,
  currentSession: null,
  characters: [],
  sessions: [],
  moments: [],
  artStyle: 'High fantasy illustration'
};

// ============================================================
// INIT
// ============================================================
document.addEventListener('DOMContentLoaded', function() {
  checkAuth();
  document.getElementById('logout-btn').addEventListener('click', logout);
  document.getElementById('api-key').addEventListener('input', checkKey);
  document.getElementById('char-image-input').addEventListener('change', previewCharImage);
  document.getElementById('session-date').value = new Date().toISOString().split('T')[0];
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
      loadCampaigns();
    });
}

function logout() {
  fetch('/api/auth/logout', { method: 'POST' })
    .then(function() { window.location.href = '/'; });
}

function checkKey() {
  var k = document.getElementById('api-key').value.trim();
  var s = document.getElementById('key-status');
  if (!k) { s.textContent = ''; s.className = 'key-status'; return; }
  if (k.indexOf('sk-ant-') === 0 && k.length > 20) {
    s.textContent = 'Key looks good';
    s.className = 'key-status ok';
  } else {
    s.textContent = 'Should start with sk-ant-';
    s.className = 'key-status err';
  }
}

// ============================================================
// VIEW MANAGEMENT
// ============================================================
function showView(view) {
  var views = ['campaigns', 'campaign-detail', 'session-detail'];
  views.forEach(function(v) {
    document.getElementById('view-' + v).style.display = 'none';
  });
  document.getElementById('view-' + view).style.display = 'block';

  // Sidebar active state
  document.querySelectorAll('.sidebar-item').forEach(function(el) { el.classList.remove('active'); });
  if (view === 'campaigns') {
    document.getElementById('nav-campaigns').classList.add('active');
    document.getElementById('campaign-nav').style.display = 'none';
    state.currentCampaign = null;
    state.currentSession = null;
  }
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
      '<div class="campaign-card-icon"><svg viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg></div>' +
      '<div class="campaign-card-name">' + c.name + '</div>' +
      '<div class="campaign-card-desc">' + (c.description || 'No description') + '</div>' +
      '<div class="campaign-card-meta">Created ' + new Date(c.created_at).toLocaleDateString() + '</div>' +
    '</div>';
  }).join('');
  html += '<div class="add-campaign-card" onclick="openCampaignModal()">' +
    '<div class="plus">+</div><span>New campaign</span></div>';
  grid.innerHTML = html;
}

function selectCampaign(id) {
  state.currentCampaign = state.campaigns.find(function(c) { return c.id === id; });
  document.getElementById('campaign-nav').style.display = 'block';
  document.getElementById('sidebar-campaign-name').textContent = state.currentCampaign.name;
  document.getElementById('sessions-campaign-name').textContent = state.currentCampaign.name;
  document.getElementById('novel-cover-title').textContent = state.currentCampaign.name;
  document.getElementById('novel-cover-sub').textContent = state.currentCampaign.description || '';
  showView('campaign-detail');
  showCampaignTab('sessions');
  loadSessions();
}

function showCampaignTab(tab) {
  var tabs = ['sessions', 'characters', 'novel'];
  tabs.forEach(function(t) {
    document.getElementById('camp-tab-' + t).style.display = t === tab ? 'block' : 'none';
    var el = document.getElementById('ctab-' + t);
    if (el) el.classList.toggle('active', t === tab);
    var nav = document.getElementById('nav-' + t);
    if (nav) nav.classList.toggle('active', t === tab);
  });

  if (tab === 'characters') loadCharacters();
  if (tab === 'novel') loadNovelSummary();
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

function closeCampaignModal() {
  document.getElementById('campaign-modal').classList.add('hidden');
}

function saveCampaign() {
  var name = document.getElementById('campaign-name').value.trim();
  var desc = document.getElementById('campaign-desc').value.trim();
  var editId = document.getElementById('campaign-edit-id').value;
  if (!name) { showModalError('campaign-modal-error', 'Campaign name is required.'); return; }

  var url = editId ? '/api/campaigns/' + editId : '/api/campaigns';
  var method = editId ? 'PUT' : 'POST';

  fetch(url, {
    method: method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name, description: desc })
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
  if (!state.sessions.length) {
    list.innerHTML = '<div class="empty-state"><div class="empty-state-icon">&#128203;</div>' +
      '<h3>No sessions yet</h3>' +
      '<p>Create your first session to start uploading transcripts and generating storyboards</p>' +
      '<button class="btn btn-primary" onclick="openSessionModal()">+ New session</button></div>';
    return;
  }
  list.innerHTML = state.sessions.map(function(s, i) {
    return '<div class="session-item" onclick="selectSession(' + s.id + ')">' +
      '<div class="session-item-left">' +
        '<div class="session-num">' + (state.sessions.length - i) + '</div>' +
        '<div>' +
          '<div class="session-name">' + s.name + '</div>' +
          '<div class="session-date">' + new Date(s.session_date + 'T12:00:00').toLocaleDateString('en-US', {weekday:'long', year:'numeric', month:'long', day:'numeric'}) + '</div>' +
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

function closeSessionModal() {
  document.getElementById('session-modal').classList.add('hidden');
}

function saveSession() {
  var name = document.getElementById('session-name').value.trim();
  var date = document.getElementById('session-date').value;
  if (!name) { showModalError('session-modal-error', 'Session name is required.'); return; }

  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name, session_date: date })
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.error) { showModalError('session-modal-error', data.error); return; }
    closeSessionModal();
    loadSessions();
  });
}

function deleteSession(id) {
  if (!confirm('Delete this session and all its moments? This cannot be undone.')) return;
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' + id, { method: 'DELETE' })
    .then(function() { loadSessions(); });
}

function selectSession(id) {
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' + id)
    .then(function(r) { return r.json(); })
    .then(function(data) {
      state.currentSession = data;
      state.moments = data.moments || [];
      document.getElementById('session-detail-name').textContent = data.name;
      document.getElementById('session-detail-date').textContent = new Date(data.session_date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
      document.getElementById('transcript-input').value = data.transcript || '';

      if (state.moments.length) {
        renderStoryboard();
      }

      switchSessionTab('transcript');
      showView('session-detail');
    });
}

function backToCampaign() {
  showView('campaign-detail');
  loadSessions();
}

function saveTranscript() {
  var transcript = document.getElementById('transcript-input').value.trim();
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' + state.currentSession.id, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcript: transcript })
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    state.currentSession = data;
    showAlert('Transcript saved!');
  });
}

function switchSessionTab(tab) {
  var tabs = ['transcript', 'storyboard'];
  tabs.forEach(function(t) {
    document.getElementById('session-tab-' + t).style.display = t === tab ? 'block' : 'none';
    var el = document.getElementById('stab-' + t);
    if (el) el.classList.toggle('active', t === tab);
  });
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
  var colors = ['#EEEDFE', '#E1F5EE', '#FAECE7', '#E6F1FB', '#FAEEDA'];
  var fgs = ['#534AB7', '#0F6E56', '#993C1D', '#185FA5', '#854F0B'];

  var html = state.characters.map(function(c, i) {
    var initials = c.name.split(' ').map(function(w) { return w[0]; }).join('').slice(0, 2).toUpperCase();
    var bg = colors[i % colors.length];
    var fg = fgs[i % fgs.length];
    var portrait = c.image
      ? '<img src="' + c.image + '" style="width:100%;height:100%;object-fit:cover;" alt="' + c.name + '">'
      : '<span style="font-size:15px;font-weight:600;color:' + fg + ';">' + initials + '</span>';

    return '<div class="char-card">' +
      '<div class="char-card-header">' +
        '<div class="char-avatar" style="background:' + bg + ';">' + portrait + '</div>' +
        '<div class="char-actions">' +
          '<button class="char-btn" onclick="openCharModal(' + c.id + ')">Edit</button>' +
          '<button class="char-btn char-btn-delete" onclick="deleteChar(' + c.id + ')">Delete</button>' +
        '</div>' +
      '</div>' +
      '<div class="char-name">' + c.name + '</div>' +
      '<div class="char-desc">' + (c.description || '') + '</div>' +
      '<span class="char-badge">' + (c.cls || '') + '</span>' +
    '</div>';
  }).join('');

  html += '<div class="add-char-card" onclick="openCharModal()"><div class="plus">+</div><span>Add character</span></div>';
  document.getElementById('char-grid').innerHTML = html;
}

function openCharModal(editId) {
  var char = editId ? state.characters.find(function(c) { return c.id === editId; }) : null;
  document.getElementById('char-edit-id').value = editId || '';
  document.getElementById('char-modal-title').textContent = editId ? 'Edit Character' : 'Add Character';
  document.getElementById('char-name').value = char ? char.name : '';
  document.getElementById('char-cls').value = char ? (char.cls || '') : '';
  document.getElementById('char-desc').value = char ? (char.description || '') : '';
  document.getElementById('char-image-input').value = '';
  var preview = document.getElementById('char-image-preview');
  if (char && char.image) { preview.src = char.image; preview.style.display = 'block'; }
  else { preview.style.display = 'none'; }
  document.getElementById('char-modal-error').classList.add('hidden');
  document.getElementById('char-modal').classList.remove('hidden');
}

function closeCharModal() {
  document.getElementById('char-modal').classList.add('hidden');
}

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
  var cls = document.getElementById('char-cls').value.trim();
  var desc = document.getElementById('char-desc').value.trim();
  var editId = document.getElementById('char-edit-id').value;
  var imageInput = document.getElementById('char-image-input');

  if (!name) { showModalError('char-modal-error', 'Character name is required.'); return; }

  var formData = new FormData();
  formData.append('name', name);
  formData.append('cls', cls || 'Adventurer');
  formData.append('description', desc);
  if (imageInput.files[0]) formData.append('image', imageInput.files[0]);

  var url = editId
    ? '/api/campaigns/' + state.currentCampaign.id + '/characters/' + editId
    : '/api/campaigns/' + state.currentCampaign.id + '/characters';
  var method = editId ? 'PUT' : 'POST';

  fetch(url, { method: method, body: formData })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.error) { showModalError('char-modal-error', data.error); return; }
      closeCharModal();
      loadCharacters();
    });
}

function deleteChar(id) {
  var char = state.characters.find(function(c) { return c.id === id; });
  if (!confirm('Delete ' + (char ? char.name : 'this character') + '? This cannot be undone.')) return;
  fetch('/api/campaigns/' + state.currentCampaign.id + '/characters/' + id, { method: 'DELETE' })
    .then(function() { loadCharacters(); });
}

// ============================================================
// EXTRACT MOMENTS
// ============================================================
function selStyle(el, style) {
  document.querySelectorAll('.style-row .chip').forEach(function(c) { c.classList.remove('sel'); });
  el.classList.add('sel');
  state.artStyle = style;
}

function extractMoments() {
  var key = document.getElementById('api-key').value.trim();
  var transcript = document.getElementById('transcript-input').value.trim();
  var errorEl = document.getElementById('extract-error');
  errorEl.classList.add('hidden');

  if (!key || key.indexOf('sk-ant-') !== 0) {
    errorEl.textContent = 'Please enter your Anthropic API key at the top of the page.';
    errorEl.classList.remove('hidden');
    return;
  }
  if (transcript.length < 50) {
    errorEl.textContent = 'Please paste a longer transcript first.';
    errorEl.classList.remove('hidden');
    return;
  }

  // Auto save transcript
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' + state.currentSession.id, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcript: transcript })
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
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: key, artStyle: state.artStyle })
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
    fill.style.width = '100%';
    msg.textContent = 'Moments found! Building storyboard...';
    state.moments = data.moments || [];
    document.getElementById('moment-count').textContent = state.moments.length;
    renderStoryboard();
    setTimeout(function() {
      wrap.style.display = 'none';
      fill.style.width = '0%';
      btn.disabled = false;
      switchSessionTab('storyboard');
    }, 1000);
  })
  .catch(function(e) {
    clearInterval(ticker);
    wrap.style.display = 'none';
    btn.disabled = false;
    errorEl.textContent = 'Connection error: ' + e.message;
    errorEl.classList.remove('hidden');
  });
}

function renderStoryboard() {
  document.getElementById('sb-empty').style.display = 'none';
  document.getElementById('sb-content').style.display = 'block';
  var typeLabel = { combat: 'Combat', drama: 'Drama', discovery: 'Discovery', humor: 'Humor' };
  document.getElementById('moments-grid').innerHTML = state.moments.map(function(m, i) {
    return '<div class="moment-card">' +
      '<div class="moment-img"><div class="moment-img-inner">' +
        '<div style="font-size:28px;margin-bottom:4px;">&#128444;</div>' +
        (m.prompt ? m.prompt.slice(0, 80) + '...' : '') +
      '</div></div>' +
      '<div class="moment-body">' +
        '<div class="moment-num">Panel ' + (i + 1) + '</div>' +
        '<div class="moment-title">' + m.title + '</div>' +
        '<div class="moment-desc">' + m.description + '</div>' +
        '<span class="moment-type type-' + m.type + '">' + (typeLabel[m.type] || m.type) + '</span>' +
        '<div class="moment-prompt">' + (m.prompt || '') + '</div>' +
      '</div>' +
    '</div>';
  }).join('');
}

// ============================================================
// GRAPHIC NOVEL
// ============================================================
function loadNovelSummary() {
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/novel/all')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      renderNovelSummary(Array.isArray(data) ? data : []);
    });
}

function renderNovelSummary(sessions) {
  var container = document.getElementById('novel-summary-list');
  document.getElementById('novel-preview-section').style.display = 'none';
  document.getElementById('preview-novel-btn').style.display = 'inline-flex';

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
      ? moments.map(function(m, j) {
          return '<div class="novel-moment-row">' +
            '<div class="novel-moment-num">' + (j + 1) + '</div>' +
            '<div class="novel-moment-info">' +
              '<div class="novel-moment-title">' + m.title + '</div>' +
              '<div class="novel-moment-desc">' + m.description + '</div>' +
            '</div>' +
          '</div>';
        }).join('')
      : '<div class="novel-empty">No moments extracted yet — open this session to generate storyboard panels</div>';

    return '<div class="novel-session-block">' +
      '<div class="novel-session-header">' +
        '<div>' +
          '<div class="novel-session-title">Session ' + (i + 1) + ' &mdash; ' + s.name + '</div>' +
          '<div class="novel-session-date">' + new Date(s.session_date + 'T12:00:00').toLocaleDateString('en-US', {weekday:'long', year:'numeric', month:'long', day:'numeric'}) + '</div>' +
        '</div>' +
        '<span class="session-badge' + (moments.length ? '' : ' empty') + '">' + moments.length + ' panels</span>' +
      '</div>' +
      '<div class="novel-session-moments">' + momentsHtml + '</div>' +
    '</div>';
  }).join('');

  container.innerHTML = '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">' +
    '<div style="font-size:13px;color:var(--text-muted);">' + sessions.length + ' sessions &middot; ' + totalMoments + ' total panels</div>' +
  '</div>' + html;
}

function showNovelPreview() {
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/novel/all')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var sessions = Array.isArray(data) ? data : [];
      renderNovelPreview(sessions);
    });
}

function renderNovelPreview(sessions) {
  document.getElementById('novel-summary-list').innerHTML = '';
  document.getElementById('preview-novel-btn').style.display = 'none';
  document.getElementById('novel-preview-section').style.display = 'block';

  var allPanelsHtml = sessions.map(function(s, si) {
    var moments = s.moments || [];
    if (!moments.length) return '';

    var panelsHtml = '<div class="novel-grid" style="grid-template-columns:1fr 1fr;gap:2px;background:#222;padding:2px;">' +
      moments.map(function(m, i) {
        var wide = (i === 0 || i === Math.floor(moments.length / 2));
        return '<div class="novel-panel' + (wide ? ' wide' : '') + '">' +
          '<div class="novel-panel-inner"><div style="font-size:20px;margin-bottom:4px;">&#128444;</div>' + m.title + '</div>' +
          '<div class="novel-caption">' + m.description + '</div>' +
        '</div>';
      }).join('') +
    '</div>';

    return '<div class="novel-chapter">' +
      '<div class="novel-chapter-header">Session ' + (si + 1) + ' &mdash; ' + s.name + '</div>' +
      panelsHtml +
    '</div>';
  }).join('');

  document.getElementById('novel-all-panels').innerHTML = allPanelsHtml ||
    '<div class="empty-state" style="padding:2rem;"><p>No moments extracted yet. Go to your sessions and extract key moments first.</p></div>';
}

function hideNovelPreview() {
  loadNovelSummary();
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
  el.style.cssText = 'position:fixed;top:16px;right:16px;z-index:999;min-width:200px;';
  document.body.appendChild(el);
  setTimeout(function() { el.remove(); }, 2500);
}
