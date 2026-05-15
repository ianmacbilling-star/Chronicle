var characters = [];

function initCharacters() {
  loadCharacters();
  document.getElementById('add-char-btn').addEventListener('click', addCharacter);
  document.getElementById('cancel-form-btn').addEventListener('click', function() {
    document.getElementById('char-form').classList.remove('open');
  });
  document.getElementById('add-char-card').addEventListener('click', openAddForm);
  document.getElementById('char-image-input').addEventListener('change', previewImage);
}

function loadCharacters() {
  fetch('/api/characters')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      characters = data;
      renderChars();
    })
    .catch(function(e) { console.error('Failed to load characters:', e); });
}

function renderChars() {
  var grid = document.getElementById('char-grid');
  var html = characters.map(function(c) {
    var initials = c.name.split(' ').map(function(w) { return w[0]; }).join('').slice(0,2).toUpperCase();
    var colors = getCharColor(c.id);
    var portrait = c.image
      ? '<img src="' + c.image + '" alt="' + c.name + '" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">'
      : '<span style="font-size:15px;font-weight:600;color:' + colors.fg + ';">' + initials + '</span>';

    return '<div class="char-card" id="card-' + c.id + '">' +
      '<div class="char-card-header">' +
        '<div class="char-avatar" style="background:' + colors.bg + ';">' + portrait + '</div>' +
        '<div class="char-actions">' +
          '<button class="char-btn" onclick="openEditForm(\'' + c.id + '\')">Edit</button>' +
          '<button class="char-btn char-btn-delete" onclick="deleteCharacter(\'' + c.id + '\')">Delete</button>' +
        '</div>' +
      '</div>' +
      '<div class="char-name">' + c.name + '</div>' +
      '<div class="char-desc">' + c.desc + '</div>' +
      '<span class="char-badge">' + c.cls + '</span>' +
    '</div>';
  }).join('');

  html += '<div class="add-card" id="add-char-card" onclick="openAddForm()"><div style="font-size:24px;">+</div><span>Add character</span></div>';
  grid.innerHTML = html;
}

function getCharColor(id) {
  var palette = [
    {bg:'#EEEDFE', fg:'#534AB7'},
    {bg:'#E1F5EE', fg:'#0F6E56'},
    {bg:'#FAECE7', fg:'#993C1D'},
    {bg:'#E6F1FB', fg:'#185FA5'},
    {bg:'#FAEEDA', fg:'#854F0B'}
  ];
  var hash = 0;
  for (var i = 0; i < id.length; i++) hash += id.charCodeAt(i);
  return palette[hash % palette.length];
}

function openAddForm() {
  document.getElementById('char-form-title').textContent = 'New character card';
  document.getElementById('form-char-id').value = '';
  document.getElementById('new-name').value = '';
  document.getElementById('new-class').value = '';
  document.getElementById('new-desc').value = '';
  document.getElementById('char-image-input').value = '';
  document.getElementById('image-preview').style.display = 'none';
  document.getElementById('char-form').classList.add('open');
}

function openEditForm(id) {
  var char = characters.find(function(c) { return c.id === id; });
  if (!char) return;

  document.getElementById('char-form-title').textContent = 'Edit character';
  document.getElementById('form-char-id').value = char.id;
  document.getElementById('new-name').value = char.name;
  document.getElementById('new-class').value = char.cls;
  document.getElementById('new-desc').value = char.desc;
  document.getElementById('char-image-input').value = '';

  var preview = document.getElementById('image-preview');
  if (char.image) {
    preview.src = char.image;
    preview.style.display = 'block';
  } else {
    preview.style.display = 'none';
  }

  document.getElementById('char-form').classList.add('open');
}

function previewImage() {
  var input = document.getElementById('char-image-input');
  var preview = document.getElementById('image-preview');
  if (input.files && input.files[0]) {
    var reader = new FileReader();
    reader.onload = function(e) {
      preview.src = e.target.result;
      preview.style.display = 'block';
    };
    reader.readAsDataURL(input.files[0]);
  }
}

function addCharacter() {
  var name = document.getElementById('new-name').value.trim();
  var cls = document.getElementById('new-class').value.trim();
  var desc = document.getElementById('new-desc').value.trim();
  var editId = document.getElementById('form-char-id').value;
  var imageInput = document.getElementById('char-image-input');

  if (!name) { alert('Please enter a character name.'); return; }

  var formData = new FormData();
  formData.append('name', name);
  formData.append('cls', cls || 'Adventurer');
  formData.append('desc', desc || '');
  if (imageInput.files[0]) formData.append('image', imageInput.files[0]);

  var url = editId ? '/api/characters/' + editId : '/api/characters';
  var method = editId ? 'PUT' : 'POST';

  fetch(url, { method: method, body: formData })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.error) { alert('Error: ' + data.error); return; }
      document.getElementById('char-form').classList.remove('open');
      loadCharacters();
    })
    .catch(function(e) { alert('Error saving character: ' + e.message); });
}

function deleteCharacter(id) {
  var char = characters.find(function(c) { return c.id === id; });
  if (!char) return;
  if (!confirm('Delete ' + char.name + '? This cannot be undone.')) return;

  fetch('/api/characters/' + id, { method: 'DELETE' })
    .then(function(r) { return r.json(); })
    .then(function() { loadCharacters(); })
    .catch(function(e) { alert('Error deleting character: ' + e.message); });
}

function getCharacterList() {
  return characters.map(function(c) {
    return c.name + ' (' + c.cls + '): ' + c.desc;
  }).join('\n');
}
