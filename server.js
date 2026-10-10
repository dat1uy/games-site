const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const query = parsedUrl.query;

  // Serve homepage
  if (pathname === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8'));
    return;
  }

  // Proxy endpoint
  if (pathname === '/proxy' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const targetUrl = data.url;

        if (!targetUrl) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'URL is required' }));
          return;
        }

        // Ensure URL has protocol
        let fetchUrl = targetUrl;
        if (!fetchUrl.startsWith('http://') && !fetchUrl.startsWith('https://')) {
          fetchUrl = 'https://' + fetchUrl;
        }

        const parsedTarget = url.parse(fetchUrl);
        const protocol = parsedTarget.protocol === 'https:' ? https : http;

        const options = {
          hostname: parsedTarget.hostname,
          port: parsedTarget.port,
          path: parsedTarget.path || '/',
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
          },
          timeout: 10000,
        };

        const proxyReq = protocol.request(options, (proxyRes) => {
          let responseBody = '';

          proxyRes.on('data', (chunk) => {
            responseBody += chunk;
          });

          proxyRes.on('end', () => {
            // Rewrite URLs in HTML to go through proxy
            let modifiedBody = responseBody;

            if (proxyRes.headers['content-type'] && proxyRes.headers['content-type'].includes('text/html')) {
              // Rewrite relative and absolute URLs
              const baseUrl = `${parsedTarget.protocol}//${parsedTarget.hostname}`;
              modifiedBody = modifiedBody.replace(/href=["'](\/[^"']*)["']/g, (match, path) => {
                return `href="/fetch?url=${encodeURIComponent(baseUrl + path)}"`;
              });
              modifiedBody = modifiedBody.replace(/src=["'](\/[^"']*)["']/g, (match, path) => {
                return `src="/fetch?url=${encodeURIComponent(baseUrl + path)}"`;
              });
              modifiedBody = modifiedBody.replace(/href=["'](https?:\/\/[^"']*)["']/g, (match, fullUrl) => {
                return `href="/fetch?url=${encodeURIComponent(fullUrl)}"`;
              });
              modifiedBody = modifiedBody.replace(/src=["'](https?:\/\/[^"']*)["']/g, (match, fullUrl) => {
                return `src="/fetch?url=${encodeURIComponent(fullUrl)}"`;
              });
            }

            res.writeHead(200, {
              'Content-Type': proxyRes.headers['content-type'] || 'text/html; charset=utf-8',
              'Access-Control-Allow-Origin': '*',
            });
            res.end(modifiedBody);
          });
        });

        proxyReq.on('error', (err) => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to fetch URL: ' + err.message }));
        });

        proxyReq.end();
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid request' }));
      }
    });
    return;
  }

  // Fetch endpoint for resources
  if (pathname === '/fetch') {
    const targetUrl = query.url;
    if (!targetUrl) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('URL is required');
      return;
    }

    const parsedTarget = url.parse(targetUrl);
    const protocol = parsedTarget.protocol === 'https:' ? https : http;

    const options = {
      hostname: parsedTarget.hostname,
      port: parsedTarget.port,
      path: parsedTarget.path || '/',
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      timeout: 10000,
    };

    const proxyReq = protocol.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, {
        'Content-Type': proxyRes.headers['content-type'] || 'application/octet-stream',
        'Access-Control-Allow-Origin': '*',
      });
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Error: ' + err.message);
    });

    proxyReq.end();
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Web proxy running on port ${PORT}`);
});
