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
// SHENASA_ALLOW_FRAME=1 drops X-Frame-Options / frame-ancestors so the
// UI can be previewed inside a local iframe (never used in production).
const allowFrame = process.env.SHENASA_ALLOW_FRAME === '1';
const HEADERS = {
  'Content-Security-Policy': allowFrame
    ? "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https:; object-src 'none'; base-uri 'self'; form-action 'self'"
    : "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
};
if (!allowFrame) HEADERS['X-Frame-Options'] = 'DENY';

function resolveSafe(urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath); } catch (e) { return null; }
  let rel = path.normalize(decoded).replace(/^([.][.][/\\])+/, '');
  if (rel.startsWith('/')) rel = rel.slice(1);
  const parts = rel.split(/[/\\]/);
  // Never serve VCS / hidden files from the dev server (.git, .env, …).
  if (parts.some((p) => p === '.git' || (p && p.charAt(0) === '.'))) return null;
  const abs = path.join(ROOT, rel);
  const rootPrefix = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
  if (abs !== ROOT && !abs.startsWith(rootPrefix)) return null;
  return abs;
}

http.createServer((req, res) => {
  const urlPath = (req.url || '/').split('?')[0];
  let abs = resolveSafe(urlPath);
  if (!abs) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...HEADERS });
    res.end('404 Not Found');
    return;
  }
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
