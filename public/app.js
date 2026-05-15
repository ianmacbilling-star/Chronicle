var artStyle = 'High fantasy illustration';
var moments = [];

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
    var el = document.getElementById(id);
    if (el) {
      el.addEventListener('click', function() {
        document.querySelectorAll('.chip').forEach(function(c) { c.classList.remove('sel'); });
        el.classList.add('sel');
        artStyle = styleMap[id];
      });
    }
  });

  // Extract button
  document.getElementById('extract-btn').addEventListener('click', extractMoments);

  // Novel buttons
  document.getElementById('print-btn').addEventListener('click', function() { alert('Print on demand coming soon!'); });
  document.getElementById('share-btn').addEventListener('click', function() { alert('Share link coming soon!'); });
  document.getElementById('pdf-btn').addEventListener('click', function() { alert('PDF export coming soon!'); });
  document.getElementById('goto-transcript-btn').addEventListener('click', function() { switchTab('transcript'); });
  document.getElementById('goto-novel-btn').addEventListener('click', function() { switchTab('novel'); });

  // Init characters module
  initCharacters();
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

  var charList = getCharacterList();

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
