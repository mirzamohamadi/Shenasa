#!/usr/bin/env node
/*
 * check-syntax.js — dependency-free lint for Shenasa.
 *
 *  1. Runs `node --check` on every JavaScript file (js/, scripts/, test/).
 *  2. Verifies index.html references every file in js/ and css/styles.css.
 *
 * Exits non-zero on any failure. Usage: node scripts/check-syntax.js
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let failures = 0;

function jsFiles(dir) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs)
    .filter((f) => f.endsWith('.js'))
    .map((f) => path.join(dir, f));
}

const targets = [...jsFiles('js'), ...jsFiles('scripts'), ...jsFiles('test')];

console.log(`syntax: checking ${targets.length} JavaScript files`);
for (const file of targets) {
  const abs = path.join(ROOT, file);
  try {
    execFileSync(process.execPath, ['--check', abs], { stdio: 'pipe' });
    console.log(`  ok    ${file}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL  ${file}`);
    console.error(String(err.stderr || err.message));
  }
}

// index.html reference check.
const indexPath = path.join(ROOT, 'index.html');
const html = fs.readFileSync(indexPath, 'utf8');

for (const file of jsFiles('js')) {
  const ref = file.replace(/\\/g, '/');
  if (!html.includes(`src="${ref}"`) && !html.includes(`src="./${ref}"`)) {
    failures++;
    console.error(`  FAIL  index.html does not reference ${ref}`);
  } else {
    console.log(`  ok    index.html references ${ref}`);
  }
}
if (!html.includes('href="css/styles.css"') && !html.includes('href="./css/styles.css"')) {
  failures++;
  console.error('  FAIL  index.html does not reference css/styles.css');
} else {
  console.log('  ok    index.html references css/styles.css');
}

// No inline <script> bodies (CSP script-src 'self' forbids them).
const inlineScript = /<script(?![^>]*\bsrc=)[^>]*>/i.exec(html);
if (inlineScript) {
  failures++;
  console.error('  FAIL  index.html contains an inline <script> (forbidden by CSP script-src \'self\')');
} else {
  console.log('  ok    no inline <script> in index.html');
}

if (failures) {
  console.error(`\ncheck-syntax: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\ncheck-syntax: all checks passed');
