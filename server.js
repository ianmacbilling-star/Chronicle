const express = require('express');
const path = require('path');

const app = express();

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from public folder
app.use(express.static(path.join(__dirname, 'public')));

// Serve uploaded images
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Routes
app.use('/api/characters', require('./routes/characters'));
app.use('/api/extract', require('./routes/extract'));

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log('');
  console.log('  Chronicle is running!');
  console.log('  Open: http://localhost:' + PORT);
  console.log('  Press Ctrl+C to stop.');
  console.log('');
});
