const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 4599;

// ── Config ──────────────────────────────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const TTL_MS = 60 * 60 * 1000;          // 1 ora
const CLEANUP_INTERVAL_MS = 60 * 1000;   // ogni minuto

// Ensure uploads directory exists
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// ── In-memory metadata store ────────────────────────────────────────────────
// Map<fileId, { id, originalName, size, mimetype, storedName, createdAt, expiresAt }>
const files = new Map();

// ── Multer setup ────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const id = uuidv4();
    const ext = path.extname(file.originalname);
    const storedName = id + ext;
    // Store the id on the request so we can use it later
    _req.fileId = id;
    cb(null, storedName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    // Accept all file types
    cb(null, true);
  }
});

// ── Cleanup routine ─────────────────────────────────────────────────────────
function cleanupExpired() {
  const now = Date.now();
  for (const [id, meta] of files) {
    if (now >= meta.expiresAt) {
      // Delete file from disk
      const filePath = path.join(UPLOADS_DIR, meta.storedName);
      try { fs.unlinkSync(filePath); } catch (_) { /* already gone */ }
      files.delete(id);
    }
  }
}

// Clean up any leftover files from previous runs on startup
function cleanupOrphans() {
  const known = new Set();
  for (const [, meta] of files) known.add(meta.storedName);
  const onDisk = fs.readdirSync(UPLOADS_DIR);
  for (const f of onDisk) {
    if (!known.has(f)) {
      try { fs.unlinkSync(path.join(UPLOADS_DIR, f)); } catch (_) {}
    }
  }
}

// Start periodic cleanup
setInterval(cleanupExpired, CLEANUP_INTERVAL_MS);
cleanupOrphans();

// ── Serve static frontend ───────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── API Routes ──────────────────────────────────────────────────────────────

// Upload endpoint
app.post('/api/upload', (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({
            error: 'Il file supera il limite massimo di 10 MB.',
            code: 'FILE_TOO_LARGE'
          });
        }
        return res.status(400).json({
          error: 'Errore durante il caricamento: ' + err.message,
          code: 'UPLOAD_ERROR'
        });
      }
      return res.status(500).json({
        error: 'Errore interno del server.',
        code: 'INTERNAL_ERROR'
      });
    }

    if (!req.file) {
      return res.status(400).json({
        error: 'Nessun file ricevuto. Trascina un file o clicca per selezionarlo.',
        code: 'NO_FILE'
      });
    }

    const id = req.fileId || uuidv4();
    const now = Date.now();
    const meta = {
      id,
      originalName: req.file.originalname,
      size: req.file.size,
      mimetype: req.file.mimetype,
      storedName: req.file.filename,
      createdAt: now,
      expiresAt: now + TTL_MS
    };

    files.set(id, meta);

    const downloadUrl = `download/${id}`;

    res.json({
      id,
      downloadUrl,
      originalName: meta.originalName,
      size: meta.size,
      mimetype: meta.mimetype,
      expiresAt: meta.expiresAt,
      message: 'File caricato con successo. Il link scadrà tra 1 ora.'
    });
  });
});

// Get file metadata
app.get('/api/file/:id', (req, res) => {
  const { id } = req.params;
  const meta = files.get(id);

  if (!meta) {
    return res.status(404).json({
      error: 'File non trovato. Potrebbe essere già scaduto o il link non è valido.',
      code: 'NOT_FOUND'
    });
  }

  if (Date.now() >= meta.expiresAt) {
    // Clean up on access
    const filePath = path.join(UPLOADS_DIR, meta.storedName);
    try { fs.unlinkSync(filePath); } catch (_) {}
    files.delete(id);
    return res.status(410).json({
      error: 'Questo file non è più disponibile. I file vengono eliminati automaticamente dopo 1 ora dal caricamento.',
      code: 'EXPIRED'
    });
  }

  res.json({
    id: meta.id,
    originalName: meta.originalName,
    size: meta.size,
    mimetype: meta.mimetype,
    createdAt: meta.createdAt,
    expiresAt: meta.expiresAt
  });
});

// Download file
app.get('/api/file/:id/download', (req, res) => {
  const { id } = req.params;
  const meta = files.get(id);

  if (!meta) {
    return res.status(404).json({
      error: 'File non trovato.',
      code: 'NOT_FOUND'
    });
  }

  if (Date.now() >= meta.expiresAt) {
    const filePath = path.join(UPLOADS_DIR, meta.storedName);
    try { fs.unlinkSync(filePath); } catch (_) {}
    files.delete(id);
    return res.status(410).json({
      error: 'File scaduto.',
      code: 'EXPIRED'
    });
  }

  const filePath = path.join(UPLOADS_DIR, meta.storedName);
  if (!fs.existsSync(filePath)) {
    files.delete(id);
    return res.status(404).json({
      error: 'Il file non è più presente sul server.',
      code: 'FILE_MISSING'
    });
  }

  res.download(filePath, meta.originalName);
});

// ── HTML pages ──────────────────────────────────────────────────────────────
// The static middleware serves the upload page at /
// For download pages, serve index.html and let client-side JS handle routing

app.get('/download/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Robots.txt
app.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  res.send(`User-agent: *
Allow: /
Sitemap: https://github.com/bonciarello/fileeffimero/sitemap.xml
`);
});

// Sitemap.xml
app.get('/sitemap.xml', (req, res) => {
  res.type('application/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://github.com/bonciarello/fileeffimero/</loc>
    <changefreq>monthly</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>
`);
});

// ── Start server ────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`File Effimero in ascolto su http://0.0.0.0:${PORT}`);
});
