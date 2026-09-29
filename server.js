const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const MOVIEBOX_API_ORIGIN = 'https://moviebox-api-eight.vercel.app';
const MOVIEBOX_REFERER = 'https://moviebox.ph/';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, Accept, Origin, User-Agent');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges, Content-Type');
}

/**
 * Handle video stream proxying with Range headers and MovieBox Referer
 */
function handleStreamProxy(req, res, targetUrl) {
  if (!targetUrl) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing url parameter' }));
    return;
  }

  try {
    const parsedUrl = new URL(targetUrl);
    const isHttps = parsedUrl.protocol === 'https:';
    const client = isHttps ? https : http;

    const proxyHeaders = {
      'User-Agent': USER_AGENT,
      'Referer': MOVIEBOX_REFERER,
      'Origin': 'https://moviebox.ph',
      'Accept': '*/*'
    };

    if (req.headers.range) {
      proxyHeaders['Range'] = req.headers.range;
    }
    if (req.headers['if-range']) {
      proxyHeaders['If-Range'] = req.headers['if-range'];
    }

    const options = {
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      headers: proxyHeaders,
      timeout: 30000
    };

    const proxyReq = client.request(parsedUrl, options, (proxyRes) => {
      // Handle redirects
      if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
        return handleStreamProxy(req, res, proxyRes.headers.location);
      }

      setCorsHeaders(res);

      const responseHeaders = {
        'Content-Type': proxyRes.headers['content-type'] || 'video/mp4',
        'Accept-Ranges': proxyRes.headers['accept-ranges'] || 'bytes'
      };

      if (proxyRes.headers['content-length']) {
        responseHeaders['Content-Length'] = proxyRes.headers['content-length'];
      }
      if (proxyRes.headers['content-range']) {
        responseHeaders['Content-Range'] = proxyRes.headers['content-range'];
      }
      if (proxyRes.headers['last-modified']) {
        responseHeaders['Last-Modified'] = proxyRes.headers['last-modified'];
      }
      if (proxyRes.headers['etag']) {
        responseHeaders['ETag'] = proxyRes.headers['etag'];
      }

      res.writeHead(proxyRes.statusCode, responseHeaders);

      if (req.method === 'HEAD') {
        res.end();
        return;
      }

      proxyRes.pipe(res);

      proxyRes.on('error', (err) => {
        console.error('Error during video stream forwarding:', err.message);
        if (!res.headersSent) {
          res.writeHead(502);
          res.end('Stream Gateway Error');
        }
      });
    });

    proxyReq.on('error', (err) => {
      console.error('Error connecting to video CDN:', err.message);
      if (!res.headersSent) {
        setCorsHeaders(res);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Video CDN connection failed', details: err.message }));
      }
    });

    req.on('close', () => {
      proxyReq.destroy();
    });

    proxyReq.end();
  } catch (err) {
    console.error('Invalid stream target URL:', err.message);
    setCorsHeaders(res);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid URL provided', details: err.message }));
  }
}

/**
 * Handle Subtitle proxying (removes CORS restrictions and supplies proper content-type)
 */
function handleSubtitleProxy(req, res, targetUrl) {
  if (!targetUrl) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing url parameter' }));
    return;
  }

  try {
    const parsedUrl = new URL(targetUrl);
    const client = parsedUrl.protocol === 'https:' ? https : http;

    const options = {
      headers: {
        'User-Agent': USER_AGENT,
        'Referer': MOVIEBOX_REFERER,
        'Accept': '*/*'
      }
    };

    client.get(parsedUrl, options, (subRes) => {
      if (subRes.statusCode >= 300 && subRes.statusCode < 400 && subRes.headers.location) {
        return handleSubtitleProxy(req, res, subRes.headers.location);
      }

      setCorsHeaders(res);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.writeHead(subRes.statusCode);
      subRes.pipe(res);
    }).on('error', (err) => {
      setCorsHeaders(res);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Subtitle CDN fetch error', details: err.message }));
    });
  } catch (err) {
    setCorsHeaders(res);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid subtitle URL', details: err.message }));
  }
}

/**
 * Proxy API requests directly to MovieBox backend if needed
 */
function handleApiProxy(req, res, apiPath) {
  const targetUrl = new URL(apiPath, MOVIEBOX_API_ORIGIN);
  const client = https;

  const options = {
    method: req.method,
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'application/json, text/plain, */*'
    }
  };

  const proxyReq = client.request(targetUrl, options, (apiRes) => {
    setCorsHeaders(res);
    res.setHeader('Content-Type', apiRes.headers['content-type'] || 'application/json');
    res.writeHead(apiRes.statusCode);
    apiRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    setCorsHeaders(res);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'MovieBox API Gateway Error', details: err.message }));
  });

  proxyReq.end();
}

/**
 * Static File Server
 */
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4'
};

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    setCorsHeaders(res);
    res.writeHead(204);
    res.end();
    return;
  }

  const reqUrl = url.parse(req.url, true);
  const pathname = reqUrl.pathname;

  // Video Streaming Proxy Route
  if (pathname === '/proxy/stream' || pathname === '/api/proxy/stream' || pathname === '/proxy/video') {
    const target = reqUrl.query.url;
    handleStreamProxy(req, res, target);
    return;
  }

  // Subtitle Proxy Route
  if (pathname === '/proxy/sub' || pathname === '/api/proxy/subtitle') {
    const target = reqUrl.query.url;
    handleSubtitleProxy(req, res, target);
    return;
  }

  // API Proxy Route (optional fallback)
  if (pathname.startsWith('/api/mb/')) {
    const apiPath = pathname.replace('/api/mb', '') + (reqUrl.search || '');
    handleApiProxy(req, res, apiPath);
    return;
  }

  // Static File Serving
  let filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      filePath = path.join(__dirname, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = mimeTypes[ext] || 'application/octet-stream';

    fs.readFile(filePath, (readErr, content) => {
      if (readErr) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Server Internal Error');
        return;
      }

      setCorsHeaders(res);
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    });
  });
});

server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🚀 CineStream Pro MovieBox Server Running!`);
  console.log(`🌐 Local Web App: http://localhost:${PORT}`);
  console.log(`🎥 Video Stream Proxy: http://localhost:${PORT}/proxy/stream?url=...`);
  console.log(`💬 Subtitle Proxy: http://localhost:${PORT}/proxy/sub?url=...`);
  console.log(`📡 MovieBox Pure API: ${MOVIEBOX_API_ORIGIN}`);
  console.log(`======================================================\n`);
});
