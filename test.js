const http = require('http');
const fs = require('fs');
const path = require('path');

// We'll start the server in a child process for testing
const { spawn } = require('child_process');

const PORT = 4599;
const BASE = `http://localhost:${PORT}`;

let serverProcess;
let passed = 0;
let failed = 0;

function log(icon, msg) {
  console.log(`  ${icon} ${msg}`);
}

function pass(msg) { passed++; log('✅', msg); }
function fail(msg) { failed++; log('❌', msg); }

function assert(condition, msg) {
  if (condition) pass(msg);
  else fail(msg);
}

async function fetchJSON(url, opts = {}) {
  const res = await fetch(BASE + url, { redirect: 'manual', ...opts });
  let body;
  try { body = await res.json(); } catch (_) { body = null; }
  return { status: res.status, headers: res.headers, body };
}

async function fetchText(url) {
  const res = await fetch(BASE + url);
  return { status: res.status, text: await res.text() };
}

async function runTests() {
  console.log('\n🧪 File Effimero — Test Suite\n');
  console.log('═'.repeat(50));

  // ── Test 1: Homepage ──────────────────────────────────────
  console.log('\n📄 Test: Pagina principale\n');
  try {
    const { status, text } = await fetchText('/');
    assert(status === 200, 'GET / restituisce 200');
    assert(text.includes('File Effimero'), 'La pagina contiene il titolo');
    assert(text.includes('drag-and-drop') || text.includes('drop-zone') || text.includes('Trascina'), 'La pagina contiene la drop zone');
    assert(text.includes('<!DOCTYPE html>'), 'La pagina è HTML valido');
  } catch (e) {
    fail('GET / fallito: ' + e.message);
  }

  // ── Test 2: SEO files ─────────────────────────────────────
  console.log('\n📄 Test: File SEO\n');
  try {
    const { status: rStatus, text: rText } = await fetchText('/robots.txt');
    assert(rStatus === 200, 'GET /robots.txt restituisce 200');
    assert(rText.includes('User-agent'), 'robots.txt contiene User-agent');
    assert(rText.includes('Sitemap:'), 'robots.txt contiene Sitemap');
  } catch (e) {
    fail('GET /robots.txt fallito: ' + e.message);
  }

  try {
    const { status: sStatus, text: sText } = await fetchText('/sitemap.xml');
    assert(sStatus === 200, 'GET /sitemap.xml restituisce 200');
    assert(sText.includes('urlset'), 'sitemap.xml contiene urlset');
    assert(sText.includes('cristianporco.it'), 'sitemap.xml contiene l\'URL canonico');
  } catch (e) {
    fail('GET /sitemap.xml fallito: ' + e.message);
  }

  // ── Test 3: Upload file ───────────────────────────────────
  console.log('\n📄 Test: Caricamento file\n');

  // Create a temporary test file
  const testFileContent = Buffer.from('Questo è un file di test per File Effimero. ' + Date.now());
  const testFilePath = path.join(__dirname, 'test_upload.txt');
  fs.writeFileSync(testFilePath, testFileContent);

  try {
    const formData = new FormData();
    const blob = new Blob([testFileContent], { type: 'text/plain' });
    formData.append('file', blob, 'test_upload.txt');

    const { status, body } = await fetchJSON('/api/upload', {
      method: 'POST',
      body: formData
    });

    assert(status === 200, 'POST /api/upload restituisce 200');
    assert(body && body.id, 'La risposta contiene un ID');
    assert(body && body.downloadUrl, 'La risposta contiene downloadUrl');
    assert(body && body.originalName === 'test_upload.txt', 'La risposta contiene il nome originale');
    assert(body && body.size > 0, 'La risposta contiene la dimensione');

    const fileId = body.id;
    const downloadUrl = body.downloadUrl;

    // ── Test 4: Get file metadata ──────────────────────────────
    console.log('\n📄 Test: Metadati file\n');
    const { status: metaStatus, body: metaBody } = await fetchJSON('/api/file/' + fileId);
    assert(metaStatus === 200, 'GET /api/file/:id restituisce 200');
    assert(metaBody.originalName === 'test_upload.txt', 'I metadati contengono il nome originale');
    assert(metaBody.size === testFileContent.length, 'I metadati contengono la dimensione corretta');
    assert(metaBody.mimetype === 'text/plain', 'I metadati contengono il MIME type');

    // ── Test 5: Download file ──────────────────────────────────
    console.log('\n📄 Test: Download file\n');
    const dlRes = await fetch(BASE + '/api/file/' + fileId + '/download');
    assert(dlRes.status === 200, 'GET /api/file/:id/download restituisce 200');
    const dlBuffer = Buffer.from(await dlRes.arrayBuffer());
    assert(dlBuffer.equals(testFileContent), 'Il contenuto scaricato corrisponde all\'originale');
    const cdHeader = dlRes.headers.get('content-disposition');
    assert(cdHeader && cdHeader.includes('test_upload.txt'), 'Header Content-Disposition contiene il nome originale');

    // ── Test 6: Download page ──────────────────────────────────
    console.log('\n📄 Test: Pagina di download\n');
    const { status: pageStatus, text: pageText } = await fetchText('/download/' + fileId);
    assert(pageStatus === 200, 'GET /download/:id restituisce 200');
    assert(pageText.includes('Scarica file') || pageText.includes('Scarica'), 'La pagina contiene il pulsante di download');

    // ── Test 7: Non-existent file ─────────────────────────────
    console.log('\n📄 Test: File inesistente\n');
    const fakeId = '00000000-0000-0000-0000-000000000000';
    const { status: nfStatus, body: nfBody } = await fetchJSON('/api/file/' + fakeId);
    assert(nfStatus === 404, 'GET /api/file/:id (fake) restituisce 404');
    assert(nfBody && nfBody.error, 'La risposta contiene un messaggio di errore');

    // ── Test 8: File too large ────────────────────────────────
    console.log('\n📄 Test: File troppo grande\n');
    const largeContent = Buffer.alloc(11 * 1024 * 1024); // 11 MB
    const largeForm = new FormData();
    largeForm.append('file', new Blob([largeContent], { type: 'application/octet-stream' }), 'large.bin');
    const { status: largeStatus, body: largeBody } = await fetchJSON('/api/upload', {
      method: 'POST',
      body: largeForm
    });
    assert(largeStatus === 413, 'POST /api/upload con file >10MB restituisce 413');
    assert(largeBody && largeBody.code === 'FILE_TOO_LARGE', 'Il codice errore è FILE_TOO_LARGE');

    // ── Test 9: Two different uploads get different links ──────
    console.log('\n📄 Test: Due upload indipendenti\n');
    const formA = new FormData();
    formA.append('file', new Blob(['File A content'], { type: 'text/plain' }), 'file_a.txt');
    const { body: resA } = await fetchJSON('/api/upload', { method: 'POST', body: formA });

    const formB = new FormData();
    formB.append('file', new Blob(['File B content'], { type: 'text/plain' }), 'file_b.txt');
    const { body: resB } = await fetchJSON('/api/upload', { method: 'POST', body: formB });

    assert(resA.id !== resB.id, 'I due upload hanno ID diversi');
    assert(resA.downloadUrl !== resB.downloadUrl, 'I due upload hanno link diversi');
    assert(resA.originalName !== resB.originalName, 'I nomi originali sono diversi');

    // Clean up the temp files
    try { fs.unlinkSync(testFilePath); } catch (_) {}

    // Clean up remote files we created
    for (const id of [resA.id, resB.id]) {
      try { await fetch(BASE + '/api/file/' + id + '/download'); } catch (_) {}
    }

  } catch (e) {
    fail('Errore nei test: ' + e.message);
  }

  // ── Summary ────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(50));
  console.log(`\n📊 Risultati: ${passed} passati, ${failed} falliti su ${passed + failed} test\n`);

  // Clean up the test file if it still exists
  try { fs.unlinkSync(testFilePath); } catch (_) {}

  process.exit(failed > 0 ? 1 : 0);
}

// Start the server, wait for it, then run tests
console.log('Avvio del server per i test...');
serverProcess = spawn('node', ['server.js'], {
  cwd: __dirname,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, PORT: String(PORT) }
});

let serverOutput = '';
serverProcess.stdout.on('data', (d) => { serverOutput += d.toString(); });
serverProcess.stderr.on('data', (d) => { serverOutput += d.toString(); });

// Wait for server to be ready
async function waitForServer(retries = 20) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(BASE + '/');
      if (res.status === 200) return true;
    } catch (_) {
      // Server not ready yet
    }
    await new Promise(r => setTimeout(r, 500));
  }
  console.error('Server non avviato dopo vari tentativi.');
  console.error('Output server:', serverOutput);
  serverProcess.kill();
  process.exit(1);
}

waitForServer().then(() => {
  console.log('Server pronto, eseguo i test...\n');
  runTests().catch(e => {
    console.error('Errore fatale:', e);
    serverProcess.kill();
    process.exit(1);
  });
}).catch(e => {
  console.error('Errore:', e);
  process.exit(1);
});

// Cleanup on exit
process.on('exit', () => {
  if (serverProcess) serverProcess.kill();
});
process.on('SIGINT', () => {
  if (serverProcess) serverProcess.kill();
  process.exit();
});
