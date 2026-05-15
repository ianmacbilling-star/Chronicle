const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const DATA_FILE = path.join(__dirname, '../data/characters.json');
const UPLOADS_DIR = path.join(__dirname, '../uploads');

// Make sure uploads folder exists
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Multer config for image uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) { cb(null, UPLOADS_DIR); },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    cb(null, 'char-' + Date.now() + ext);
  }
});
const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
  fileFilter: function (req, file, cb) {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  }
});

function readCharacters() {
  try {
    const data = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(data);
  } catch (e) {
    return [];
  }
}

function writeCharacters(characters) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(characters, null, 2));
}

function generateId() {
  return Date.now().toString();
}

// GET all characters
router.get('/', function(req, res) {
  const characters = readCharacters();
  res.json(characters);
});

// POST create new character
router.post('/', upload.single('image'), function(req, res) {
  const characters = readCharacters();
  const newChar = {
    id: generateId(),
    name: req.body.name || 'Unknown',
    cls: req.body.cls || 'Adventurer',
    desc: req.body.desc || '',
    image: req.file ? '/uploads/' + req.file.filename : null
  };
  characters.push(newChar);
  writeCharacters(characters);
  res.json(newChar);
});

// PUT update character
router.put('/:id', upload.single('image'), function(req, res) {
  const characters = readCharacters();
  const idx = characters.findIndex(function(c) { return c.id === req.params.id; });
  if (idx === -1) return res.status(404).json({ error: 'Character not found' });

  // Update fields
  characters[idx].name = req.body.name || characters[idx].name;
  characters[idx].cls = req.body.cls || characters[idx].cls;
  characters[idx].desc = req.body.desc || characters[idx].desc;

  // Update image if a new one was uploaded
  if (req.file) {
    // Delete old image if it exists
    if (characters[idx].image) {
      const oldPath = path.join(__dirname, '..', characters[idx].image);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
    characters[idx].image = '/uploads/' + req.file.filename;
  }

  writeCharacters(characters);
  res.json(characters[idx]);
});

// DELETE character
router.delete('/:id', function(req, res) {
  var characters = readCharacters();
  const char = characters.find(function(c) { return c.id === req.params.id; });

  // Delete image file if exists
  if (char && char.image) {
    const imgPath = path.join(__dirname, '..', char.image);
    if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
  }

  characters = characters.filter(function(c) { return c.id !== req.params.id; });
  writeCharacters(characters);
  res.json({ success: true });
});

module.exports = router;
