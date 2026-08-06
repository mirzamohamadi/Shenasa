#!/usr/bin/env node
/*
 * serve.js — zero-dependency static file server for local development.
 * (Kanidm itself must be reachable separately; configure ?apiUrl= or see
 * deploy/ for a full reverse-proxy setup that serves Shenasa from the same
 * origin as Kanidm.)
 *
 * Usage: node scripts/serve.js [port]
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.argv[2]) || 8080;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.yaml': 'text/yaml; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
};

// Development server: mirrors the production security headers plus CSP.
const HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer'
};

http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  let rel = path.normalize(urlPath).replace(/^([.][.][/\\])+/, '');
  let abs = path.join(ROOT, rel);
  if (!abs.startsWith(ROOT)) abs = ROOT;
  let stat;
  try {
    stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      abs = path.join(abs, 'index.html');
      stat = fs.statSync(abs);
    }
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...HEADERS });
    res.end('404 Not Found');
    return;
  }
  const ext = path.extname(abs).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', ...HEADERS });
  fs.createReadStream(abs).pipe(res);
}).listen(PORT, () => {
  console.log(`Shenasa dev server: http://localhost:${PORT}/`);
  console.log('Set the Kanidm API URL via Settings or ?apiUrl=https://idm.example.com/v1');
});
