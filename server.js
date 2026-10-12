const http = require('http');
const fs = require('fs');
const path = require('path');
const unzipper = require('unzipper');

const PORT = Number(process.env.PORT || 3000);
const publicDir = path.join(__dirname, 'public');
const gamesDir = path.join(publicDir, 'games');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.zip': 'application/zip',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

async function extractZip(zipPath, targetDir) {
  ensureDir(targetDir);

  const zip = await unzipper.Open.file(zipPath);
  for (const file of zip.files) {
    if (file.type === 'Directory') continue;

    const relativePath = file.path;
    const destPath = path.join(targetDir, relativePath);
    const parentDir = path.dirname(destPath);
    ensureDir(parentDir);

    const content = await file.buffer();
    fs.writeFileSync(destPath, content);
  }
}

async function scanGamesDir() {
  ensureDir(gamesDir);
  const items = fs.readdirSync(gamesDir, { withFileTypes: true });

  for (const item of items) {
    if (!item.isFile()) continue;

    const lower = item.name.toLowerCase();
    if (!lower.endsWith('.zip')) continue;

    const zipPath = path.join(gamesDir, item.name);
    const targetName = item.name.replace(/\.zip$/i, '');
    const targetDir = path.join(gamesDir, targetName);

    if (!fs.existsSync(targetDir)) {
      await extractZip(zipPath, targetDir);
    }
  }
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const type = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = reqUrl.pathname;

  if (pathname === '/') {
    sendFile(res, path.join(publicDir, 'index.html'));
    return;
  }

  if (pathname.startsWith('/game/')) {
    const slug = pathname.replace(/^\/game\//, '').replace(/\/+$/, '');
    const gameDir = path.join(gamesDir, slug);
    const gameIndex = path.join(gameDir, 'index.html');

    fs.stat(gameIndex, (err) => {
      if (err) {
        const msg = `
          <html>
            <body style="font-family:Arial; background:#0d1321; color:#fff; display:grid; place-items:center; height:100vh; margin:0;">
              <div style="max-width:700px; text-align:center;">
                <h1 style="color:#7dd3fc;">Game not found</h1>
                <p>Put the game in <strong>public/games/${slug}/index.html</strong></p>
                <p>or upload a ZIP called <strong>${slug}.zip</strong> inside <strong>public/games/</strong>.</p>
              </div>
            </body>
          </html>
        `;
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(msg);
        return;
      }

      sendFile(res, gameIndex);
    });
    return;
  }

  if (pathname === '/games') {
    let list = '';
    const names = fs.existsSync(gamesDir) ? fs.readdirSync(gamesDir) : [];
    const gameLinks = names
      .filter((name) => fs.existsSync(path.join(gamesDir, name, 'index.html')) || name.toLowerCase().endsWith('.zip'))
      .map((name) => {
        const cleanName = name.replace(/\.zip$/i, '');
        return `<li><a href="/game/${encodeURIComponent(cleanName)}">${cleanName}</a></li>`;
      })
      .join('');

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
      <html>
        <head><title>Games</title></head>
        <body style="font-family:Arial; background:#0d1321; color:#fff; padding:40px;">
          <h1>Available Games</h1>
          <ul>
            ${gameLinks || '<li>No games uploaded yet.</li>'}
          </ul>
        </body>
      </html>
    `);
    return;
  }

  const safePath = path.normalize(path.join(publicDir, pathname.replace(/^\//, '')));
  if (safePath.startsWith(publicDir)) {
    fs.stat(safePath, (err, stats) => {
      if (err || !stats.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }

      sendFile(res, safePath);
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

(async () => {
  try {
    ensureDir(gamesDir);
    await scanGamesDir();
    server.listen(PORT, () => {
      console.log(`Game portal running on port ${PORT}`);
      console.log(`Games directory: ${gamesDir}`);
    });
  } catch (error) {
    console.error('Failed to start game portal:', error);
    process.exit(1);
  }
})();
