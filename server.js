const http = require('http');
const net = require('net');
const httpProxy = require('http-proxy');

const CONFIG = {
  PORT: Number(process.env.PORT || 3000),
  MAX_BODY_SIZE: 10 * 1024 * 1024,
  REQUEST_TIMEOUT: 30000,
  ALLOW_LIST: (process.env.ALLOW_LIST || 'example.com').split(',').map(s => s.trim()).filter(Boolean),
  BLOCK_PRIVATE_NETWORKS: process.env.BLOCK_PRIVATE_NETWORKS !== 'false',
  RATE_LIMIT_ENABLED: process.env.RATE_LIMIT_ENABLED !== 'false',
  RATE_LIMIT_MAX_REQUESTS: Number(process.env.RATE_LIMIT_MAX_REQUESTS || 100),
  RATE_LIMIT_WINDOW_MS: 60000,
};

const rateLimitStore = new Map();

function isPrivateHostname(hostname) {
  const host = hostname.toLowerCase();
  if (!host) return true;

  const patterns = [
    /^localhost$/,
    /^127\./,
    /^10\./,
    /^172\.(1[6-9]|2[0-9]|3[01])\./,
    /^192\.168\./,
    /^0\.0\.0\.0$/,
    /^::1$/,
    /^\[::1\]$/,
    /^fc00:/,
    /^fe80:/,
  ];

  return patterns.some((pattern) => pattern.test(host)) || host === 'localhost';
}

function isAllowedDestination(hostname) {
  if (!hostname) return false;
  if (CONFIG.BLOCK_PRIVATE_NETWORKS && isPrivateHostname(hostname)) return false;

  const lower = hostname.toLowerCase();
  return CONFIG.ALLOW_LIST.some((allowed) => {
    const a = allowed.toLowerCase();
    return lower === a || lower.endsWith(`.${a}`);
  });
}

function checkRateLimit(clientIP) {
  if (!CONFIG.RATE_LIMIT_ENABLED) return true;

  const now = Date.now();
  const key = clientIP || 'unknown';
  const timestamps = rateLimitStore.get(key) || [];
  const valid = timestamps.filter((t) => now - t < CONFIG.RATE_LIMIT_WINDOW_MS);

  if (valid.length >= CONFIG.RATE_LIMIT_MAX_REQUESTS) {
    return false;
  }

  valid.push(now);
  rateLimitStore.set(key, valid);
  return true;
}

function filterHeaders(headers) {
  const dangerous = new Set([
    'host',
    'connection',
    'content-length',
    'transfer-encoding',
    'upgrade',
    'expect',
    'te',
    'trailer',
  ]);

  const result = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (!dangerous.has(key.toLowerCase())) {
      result[key] = value;
    }
  }
  return result;
}

function log(level, message, meta = {}) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
    ...meta,
  }));
}

const proxy = httpProxy.createProxyServer({
  timeout: CONFIG.REQUEST_TIMEOUT,
  changeOrigin: true,
  preserveHeaderKeyCase: true,
});

proxy.on('error', (err, req, res) => {
  log('error', 'Proxy error', {
    error: err && err.message ? err.message : String(err),
    url: req && req.url,
    clientIP: req && req.clientIP,
  });

  if (res && !res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Bad Gateway' }));
  }
});

const server = http.createServer((req, res) => {
  const clientIP = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
  req.clientIP = clientIP;

  if (req.url === '/_health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  const allowedMethods = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);
  if (!allowedMethods.has(req.method)) {
    log('warn', 'Invalid HTTP method', { method: req.method, clientIP });
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid HTTP method' }));
    return;
  }

  if (!checkRateLimit(clientIP)) {
    log('warn', 'Rate limit exceeded', { clientIP });
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Too Many Requests' }));
    return;
  }

  if (!req.url || (!req.url.startsWith('http://') && !req.url.startsWith('https://'))) {
    log('warn', 'Invalid target URL', { url: req.url, clientIP });
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Use a full absolute URL like http://example.com/path' }));
    return;
  }

  let targetUrl;
  try {
    targetUrl = new URL(req.url);
  } catch (error) {
    log('warn', 'Malformed URL', { url: req.url, clientIP });
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Malformed URL' }));
    return;
  }

  if (!isAllowedDestination(targetUrl.hostname)) {
    log('warn', 'Destination blocked', { hostname: targetUrl.hostname, clientIP });
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Forbidden', message: 'Destination not allowed' }));
    return;
  }

  const contentLength = Number(req.headers['content-length'] || 0);
  if (contentLength > CONFIG.MAX_BODY_SIZE) {
    log('warn', 'Payload too large', { size: contentLength, clientIP });
    res.writeHead(413, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Payload Too Large' }));
    return;
  }

  req.headers = filterHeaders(req.headers);
  req.headers['x-forwarded-for'] = clientIP;
  req.headers['x-forwarded-proto'] = targetUrl.protocol.replace(':', '');

  log('info', 'Proxy request', { method: req.method, url: req.url, clientIP });

  proxy.web(req, res, {
    target: targetUrl.origin,
    changeOrigin: true,
  });
});

server.on('connect', (req, clientSocket, head) => {
  const clientIP = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
  const target = req.url;

  if (!checkRateLimit(clientIP)) {
    log('warn', 'Rate limit exceeded on CONNECT', { clientIP });
    clientSocket.destroy();
    return;
  }

  const [hostname, portRaw] = target.split(':');
  const port = Number(portRaw || 443);

  if (!hostname || !isAllowedDestination(hostname)) {
    log('warn', 'CONNECT destination blocked', { hostname, clientIP });
    clientSocket.destroy();
    return;
  }

  const upstream = net.createConnection(port, hostname, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);

    if (head.length) {
      upstream.write(head);
    }
  });

  upstream.on('error', (err) => {
    log('error', 'CONNECT tunnel error', { error: err.message, hostname, clientIP });
    clientSocket.destroy();
  });

  clientSocket.on('error', (err) => {
    log('error', 'Client socket error', { error: err.message, clientIP });
    upstream.destroy();
  });
});

server.listen(CONFIG.PORT, () => {
  log('info', 'Secure proxy server started', {
    port: CONFIG.PORT,
    allowList: CONFIG.ALLOW_LIST,
  });
});

process.on('SIGTERM', () => {
  log('info', 'Shutting down');
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  log('info', 'Shutting down');
  server.close(() => process.exit(0));
});
