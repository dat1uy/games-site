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
};

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

async function extractZipIfNeeded(zipPath) {
  const zipName = path.basename(zipPath, '.zip');
  const targetDir = path.join(gamesDir, zipName);

  if (fs.existsSync(targetDir)) {
    return;
  }

  ensureDir(gamesDir);

  const zipStream = fs.createReadStream(zipPath);
  const zip = await unzipper.Open.file(zipPath);

  await Promise.all(
    zip.files.map(async (entry) => {
      if (entry.type === 'Directory') return;

      const destPath = path.join(gamesDir, zipName, entry.path);
      const destDir = path.dirname(destPath);
      ensureDir(destDir);

      const fileStream = entry.stream();
      const chunks = [];
      for await (const chunk of fileStream) {
        chunks.push(chunk);
      }
      fs.writeFileSync(destPath, Buffer.concat(chunks));
    })
  );
}

async function prepareGameFolders() {
  ensureDir(gamesDir);

  const files = fs.readdirSync(process.cwd());
  for (const file of files) {
    if (file.toLowerCase().endsWith('.zip')) {
      const zipPath = path.join(process.cwd(), file);
      await extractZipIfNeeded(zipPath);
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
    const part = pathname.replace(/^\/game\//, '').replace(/\/+$/, '');
    const gameIndex = path.join(gamesDir, part, 'index.html');

    fs.stat(gameIndex, (err) => {
      if (err) {
        const gameHint = `
          <html>
            <body style="font-family:Arial; background:#0d1321; color:#fff; display:grid; place-items:center; height:100vh; margin:0;">
              <div style="max-width:700px; text-align:center;">
                <h1 style="color:#7dd3fc;">Game not uploaded yet</h1>
                <p>Put your HTML game in <strong>public/games/${part}/index.html</strong></p>
                <p>Or upload a ZIP file named <strong>${part}.zip</strong> and it will extract automatically.</p>
              </div>
            </body>
          </html>
        `;
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(gameHint);
        return;
      }

      sendFile(res, gameIndex);
    });
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
    await prepareGameFolders();
    server.listen(PORT, () => {
      console.log(`Game portal running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start game portal:', error);
    process.exit(1);
  }
})();
