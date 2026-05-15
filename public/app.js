var artStyle = 'High fantasy illustration';
var moments = [];
var characters = [
  {name:'Theron', cls:'Ranger / Half-elf', desc:'Silver hair, green cloak, wolf companion named Shadow. Stoic expression, weathered face.', i:'TH', bg:'#EEEDFE', fg:'#534AB7'},
  {name:'Zara', cls:'Rogue / Tiefling', desc:'Crimson skin, small black horns, always partially in shadow. Mischievous grin, twin daggers.', i:'ZA', bg:'#E1F5EE', fg:'#0F6E56'},
  {name:'Ruk', cls:'Barbarian / Half-orc', desc:'Enormous build, ritual scars, bear skull pauldron, warhammer.', i:'RU', bg:'#FAECE7', fg:'#993C1D'}
];

var styleMap = {
  'chip-fantasy': 'High fantasy illustration',
  'chip-gritty': 'Dark gritty comic book',
  'chip-watercolor': 'Watercolor painterly',
  'chip-anime': 'Anime manga style',
  'chip-ink': 'Classic pen and ink'
};

function init() {
  // Tab clicks
  document.getElementById('tab-transcript').addEventListener('click', function() { switchTab('transcript'); });
  document.getElementById('tab-characters').addEventListener('click', function() { switchTab('characters'); });
  document.getElementById('tab-storyboard').addEventListener('click', function() { switchTab('storyboard'); });
  document.getElementById('tab-novel').addEventListener('click', function() { switchTab('novel'); });

  // API key check
  document.getElementById('api-key').addEventListener('input', checkKey);

  // Style chips
  Object.keys(styleMap).forEach(function(id) {
    document.getElementById(id).addEventListener('click', function() {
      document.querySelectorAll('.chip').forEach(function(c) { c.classList.remove('sel'); });
      this.classList.add('sel');
      artStyle = styleMap[id];
    });
  });

  // Extract button
  document.getElementById('extract-btn').addEventListener('click', extractMoments);

  // Character form buttons
  document.getElementById('add-char-btn').addEventListener('click', addChar);
  document.getElementById('cancel-form-btn').addEventListener('click', toggleForm);

  // Nav buttons
  document.getElementById('goto-transcript-btn').addEventListener('click', function() { switchTab('transcript'); });
  document.getElementById('goto-novel-btn').addEventListener('click', function() { switchTab('novel'); });
  document.getElementById('print-btn').addEventListener('click', function() { alert('Print on demand coming soon!'); });
  document.getElementById('share-btn').addEventListener('click', function() { alert('Share link coming soon!'); });
  document.getElementById('pdf-btn').addEventListener('click', function() { alert('PDF export coming soon!'); });

  renderChars();
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

function switchTab(t) {
  var names = ['transcript', 'characters', 'storyboard', 'novel'];
  names.forEach(function(n) {
    document.getElementById('pane-' + n).classList.remove('active');
    document.getElementById('tab-' + n).classList.remove('active');
  });
  document.getElementById('pane-' + t).classList.add('active');
  document.getElementById('tab-' + t).classList.add('active');
}

function toggleForm() {
  document.getElementById('char-form').classList.toggle('open');
}

function renderChars() {
  var html = characters.map(function(c) {
    return '<div class="char-card">' +
      '<div class="char-avatar" style="background:' + c.bg + ';color:' + c.fg + ';">' + c.i + '</div>' +
      '<div class="char-name">' + c.name + '</div>' +
      '<div class="char-desc">' + c.desc + '</div>' +
      '<span class="char-badge">' + c.cls + '</span>' +
    '</div>';
  }).join('');
  html += '<div class="add-card" id="add-char-card"><div style="font-size:24px;">+</div><span>Add character</span></div>';
  document.getElementById('char-grid').innerHTML = html;
  document.getElementById('add-char-card').addEventListener('click', toggleForm);
}

function addChar() {
  var name = document.getElementById('new-name').value.trim();
  var cls = document.getElementById('new-class').value.trim();
  var desc = document.getElementById('new-desc').value.trim();
  if (!name) { alert('Please enter a character name.'); return; }
  var bgs = ['#EEEDFE','#E1F5EE','#FAECE7','#E6F1FB','#FAEEDA'];
  var fgs = ['#534AB7','#0F6E56','#993C1D','#185FA5','#854F0B'];
  var idx = characters.length % bgs.length;
  var initials = name.split(' ').map(function(w) { return w[0]; }).join('').slice(0,2).toUpperCase();
  characters.push({name:name, cls:cls||'Adventurer', desc:desc||'No description yet.', i:initials, bg:bgs[idx], fg:fgs[idx]});
  renderChars();
  document.getElementById('char-form').classList.remove('open');
  document.getElementById('new-name').value = '';
  document.getElementById('new-class').value = '';
  document.getElementById('new-desc').value = '';
}

function showError(msg) {
  var b = document.getElementById('error-box');
  b.textContent = msg;
  b.style.display = 'block';
}

function hideError() {
  document.getElementById('error-box').style.display = 'none';
}

function extractMoments() {
  var key = document.getElementById('api-key').value.trim();
  var transcript = document.getElementById('transcript-input').value.trim();
  hideError();

  if (!key || key.indexOf('sk-ant-') !== 0) {
    showError('Please enter your Anthropic API key in the field at the top first.');
    return;
  }
  if (transcript.length < 50) {
    showError('Please paste a longer transcript before extracting moments.');
    return;
  }

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
    pct = Math.min(pct + (Math.random() * 6), 88);
    fill.style.width = pct + '%';
  }, 400);

  var charList = characters.map(function(c) {
    return c.name + ' (' + c.cls + '): ' + c.desc;
  }).join('\n');

  fetch('/api/extract', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({key: key, transcript: transcript, artStyle: artStyle, charList: charList})
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    clearInterval(ticker);
    if (data.error) {
      showError('API error: ' + data.error);
      wrap.style.display = 'none';
      btn.disabled = false;
      return;
    }
    fill.style.width = '100%';
    msg.textContent = 'Moments found! Building your storyboard...';
    moments = data.moments || [];
    document.getElementById('novel-title').textContent = data.title || 'The Adventure';
    document.getElementById('novel-sub').textContent = data.subtitle || '';
    document.getElementById('moment-count').textContent = moments.length;
    renderStoryboard();
    renderNovel();
    setTimeout(function() {
      wrap.style.display = 'none';
      fill.style.width = '0%';
      btn.disabled = false;
      switchTab('storyboard');
    }, 1000);
  })
  .catch(function(e) {
    clearInterval(ticker);
    wrap.style.display = 'none';
    btn.disabled = false;
    showError('Connection error: ' + e.message);
  });
}

function renderStoryboard() {
  document.getElementById('sb-empty').style.display = 'none';
  document.getElementById('sb-content').style.display = 'block';
  var typeLabel = {combat:'Combat', drama:'Drama', discovery:'Discovery', humor:'Humor'};
  document.getElementById('moments-grid').innerHTML = moments.map(function(m, i) {
    return '<div class="moment-card">' +
      '<div class="moment-img"><div class="moment-img-text">' +
        '<div style="font-size:24px;margin-bottom:4px;">&#128444;</div>' +
        (m.prompt ? m.prompt.slice(0, 80) + '...' : 'Image prompt ready') +
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

function renderNovel() {
  if (!moments.length) return;
  document.getElementById('novel-panels').innerHTML = moments.map(function(m, i) {
    var wide = (i === 0 || i === Math.floor(moments.length / 2));
    return '<div class="novel-panel' + (wide ? ' wide' : '') + '">' +
      '<div class="novel-panel-inner"><span class="panel-icon">&#128444;</span>' + m.title + '</div>' +
      '<div class="novel-caption">' + m.description + '</div>' +
    '</div>';
  }).join('');
}

document.addEventListener('DOMContentLoaded', init);
