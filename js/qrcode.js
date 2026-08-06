/*
 * qrcode.js — dependency-free QR code generator for Shenasa.
 *
 * Byte-mode QR encoder, versions 1-10, error-correction levels L and M.
 * No dependencies; attaches `window.QRCode`.
 *
 *   QRCode.toModules(text, ecl) -> Array<Array<boolean>>  (true = dark)
 *   QRCode.toSVG(text, opts)    -> '<svg ...>' string
 *
 * Implemented from ISO/IEC 18004: GF(256) arithmetic, Reed-Solomon ECC,
 * block interleaving, function patterns, format/version information,
 * zig-zag data placement, masking applied to data modules only, and
 * mask selection by penalty scoring (format bits rewritten per mask).
 */
(function (global) {
  'use strict';

  // ------------------------------------------------------------------
  // Capacity + ECC block structure tables (versions 1..10, levels L/M)
  // Entry: [ecCodewordsPerBlock, g1Blocks, g1DataCw, (g2Blocks, g2DataCw)]
  // ------------------------------------------------------------------
  var EC = {
    L: [null,
      [7, 1, 19], [10, 1, 34], [15, 1, 55], [20, 1, 80], [26, 1, 108],
      [18, 2, 68], [20, 2, 78], [24, 2, 97], [30, 2, 116], [18, 2, 68, 2, 69]
    ],
    M: [null,
      [10, 1, 16], [16, 1, 28], [26, 1, 44], [18, 2, 32], [24, 2, 43],
      [16, 4, 27], [18, 4, 31], [22, 2, 38, 2, 39], [22, 3, 36, 2, 37], [26, 4, 43, 1, 44]
    ]
  };

  // Alignment pattern centre coordinates per version (index = version)
  var ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
    [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

  // Format-information EC level bits: M=00, L=01, H=10, Q=11
  var ECL_BITS = { M: 0, L: 1, H: 2, Q: 3 };

  var MAX_VERSION = 10;

  // ------------------------------------------------------------------
  // GF(256) arithmetic, primitive polynomial 0x11d
  // ------------------------------------------------------------------
  var EXP = new Array(512);
  var LOG = new Array(256);
  (function initGF() {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  // Polynomials are arrays of coefficients, highest degree first.
  function polyMul(p, q) {
    var out = new Array(p.length + q.length - 1);
    for (var i = 0; i < out.length; i++) out[i] = 0;
    for (var a = 0; a < p.length; a++) {
      for (var b = 0; b < q.length; b++) {
        out[a + b] ^= gfMul(p[a], q[b]);
      }
    }
    return out;
  }

  var genCache = {};
  function rsGenerator(degree) {
    if (genCache[degree]) return genCache[degree];
    var g = [1];
    for (var i = 0; i < degree; i++) g = polyMul(g, [1, EXP[i]]);
    genCache[degree] = g;
    return g;
  }

  // Reed-Solomon remainder (error-correction codewords) for data bytes.
  function rsEncode(data, ecLen) {
    var gen = rsGenerator(ecLen);
    var work = data.slice();
    for (var i = 0; i < ecLen; i++) work.push(0);
    for (var d = 0; d < data.length; d++) {
      var coef = work[d];
      if (coef === 0) continue;
      for (var j = 0; j < gen.length; j++) work[d + j] ^= gfMul(gen[j], coef);
    }
    return work.slice(data.length);
  }

  // ------------------------------------------------------------------
  // BCH codes for format (15,5) and version (18,6) information
  // ------------------------------------------------------------------
  function bitDegree(x) {
    var n = 0;
    while ((x >> n) !== 0) n++;
    return n - 1;
  }

  function bchFormatInfo(data5) {
    var g = 0x537; // 10100110111
    var d = data5 << 10;
    while (bitDegree(d) >= 10) d ^= g << (bitDegree(d) - 10);
    return ((data5 << 10) | d) ^ 0x5412; // mask 101010000010010
  }

  function bchVersionInfo(version) {
    var g = 0x1f25; // 1111100100101
    var d = version << 12;
    while (bitDegree(d) >= 12) d ^= g << (bitDegree(d) - 12);
    return (version << 12) | d;
  }

  // ------------------------------------------------------------------
  // UTF-8 byte encoding (ES5-friendly, no TextEncoder dependency)
  // ------------------------------------------------------------------
  function utf8Bytes(str) {
    var s = unescape(encodeURIComponent(str));
    var bytes = new Array(s.length);
    for (var i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff;
    return bytes;
  }

  function totalDataCodewords(version, ecl) {
    var row = EC[ecl][version];
    var total = 0;
    for (var i = 1; i < row.length; i += 2) total += row[i] * row[i + 1];
    return total;
  }

  function pickVersion(byteLen, ecl) {
    for (var v = 1; v <= MAX_VERSION; v++) {
      var countBits = v <= 9 ? 8 : 16; // byte-mode count indicator
      var need = 4 + countBits + byteLen * 8;
      if (need <= totalDataCodewords(v, ecl) * 8) return v;
    }
    return 0;
  }

  // ------------------------------------------------------------------
  // Bit-stream builder
  // ------------------------------------------------------------------
  function BitStream() { this.bytes = []; this.bitLen = 0; }
  BitStream.prototype.put = function (val, len) {
    for (var i = len - 1; i >= 0; i--) {
      var bit = ((val >> i) & 1) === 1;
      if (this.bitLen % 8 === 0) this.bytes.push(0);
      if (bit) this.bytes[this.bytes.length - 1] |= 0x80 >> (this.bitLen % 8);
      this.bitLen++;
    }
  };

  function buildDataCodewords(bytes, version, ecl) {
    var capacity = totalDataCodewords(version, ecl);
    var stream = new BitStream();
    stream.put(0x4, 4);                                    // byte mode
    stream.put(bytes.length, version <= 9 ? 8 : 16);       // count
    for (var i = 0; i < bytes.length; i++) stream.put(bytes[i], 8);
    // terminator: up to four zero bits
    var rem = capacity * 8 - stream.bitLen;
    stream.put(0, Math.min(4, rem));
    while (stream.bitLen % 8 !== 0) stream.put(0, 1);
    // alternating pad bytes
    var pads = [0xec, 0x11];
    for (var p = 0; stream.bytes.length < capacity; p++) {
      stream.put(pads[p % 2], 8);
    }
    return stream.bytes;
  }

  // ------------------------------------------------------------------
  // Block splitting, ECC, interleaving
  // ------------------------------------------------------------------
  function splitBlocks(codewords, version, ecl) {
    var row = EC[ecl][version];
    var ecLen = row[0];
    var blocks = [];
    var off = 0;
    for (var g = 1; g < row.length; g += 2) {
      var nBlocks = row[g];
      var dataLen = row[g + 1];
      for (var b = 0; b < nBlocks; b++) {
        var data = codewords.slice(off, off + dataLen);
        off += dataLen;
        blocks.push({ data: data, ecc: rsEncode(data, ecLen) });
      }
    }
    return blocks;
  }

  function interleave(blocks) {
    var out = [];
    var maxData = 0;
    var i, b;
    for (b = 0; b < blocks.length; b++) {
      if (blocks[b].data.length > maxData) maxData = blocks[b].data.length;
    }
    for (i = 0; i < maxData; i++) {
      for (b = 0; b < blocks.length; b++) {
        if (i < blocks[b].data.length) out.push(blocks[b].data[i]);
      }
    }
    for (i = 0; i < blocks[0].ecc.length; i++) {
      for (b = 0; b < blocks.length; b++) out.push(blocks[b].ecc[i]);
    }
    return out;
  }

  // ------------------------------------------------------------------
  // Matrix construction
  // ------------------------------------------------------------------
  function newMatrix(size) {
    var m = new Array(size);
    for (var r = 0; r < size; r++) {
      m[r] = new Array(size);
      for (var c = 0; c < size; c++) m[r][c] = false;
    }
    return m;
  }

  function drawFinder(mod, fn, row, col) {
    var size = mod.length;
    for (var r = -1; r <= 7; r++) {
      for (var c = -1; c <= 7; c++) {
        var rr = row + r;
        var cc = col + c;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        var dark = (r >= 0 && r <= 6 && c >= 0 && c <= 6) &&
          (r === 0 || r === 6 || c === 0 || c === 6 ||
            (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        mod[rr][cc] = dark;
        fn[rr][cc] = true;
      }
    }
  }

  function drawAlignment(mod, fn, row, col) {
    for (var r = -2; r <= 2; r++) {
      for (var c = -2; c <= 2; c++) {
        var dark = Math.max(Math.abs(r), Math.abs(c)) !== 1;
        mod[row + r][col + c] = dark;
        fn[row + r][col + c] = true;
      }
    }
  }

  // Reserve + (later) write format information. Encoding checked against
  // reference implementations: bit i of the 15-bit value (i=0 is LSB).
  function writeFormatInfo(mod, fn, eclBits, mask) {
    var size = mod.length;
    var bits = bchFormatInfo((eclBits << 3) | mask);
    for (var i = 0; i < 15; i++) {
      var dark = ((bits >> i) & 1) === 1;
      // Column 8 and bottom-left vertical copy.
      var r1 = i < 6 ? i : (i < 8 ? i + 1 : size - 15 + i);
      mod[r1][8] = dark;
      fn[r1][8] = true;
      // Row 8: top-right horizontal copy and top-left remnant.
      var c2 = i < 8 ? size - 1 - i : (i < 9 ? 7 : 15 - i - 1);
      mod[8][c2] = dark;
      fn[8][c2] = true;
    }
    // Dark module: always dark, at row 4*version+9 (== size-8), column 8.
    mod[size - 8][8] = true;
    fn[size - 8][8] = true;
  }

  function writeVersionInfo(mod, fn, version) {
    var size = mod.length;
    var bits = bchVersionInfo(version);
    for (var i = 0; i < 18; i++) {
      var dark = ((bits >> i) & 1) === 1;
      var a = size - 11 + (i % 3);
      var b = Math.floor(i / 3);
      mod[b][a] = dark;   // top-right block
      fn[b][a] = true;
      mod[a][b] = dark;   // bottom-left block
      fn[a][b] = true;
    }
  }

  function buildBase(version, eclBits) {
    var size = 17 + 4 * version;
    var mod = newMatrix(size);
    var fn = newMatrix(size);

    drawFinder(mod, fn, 0, 0);
    drawFinder(mod, fn, 0, size - 7);
    drawFinder(mod, fn, size - 7, 0);

    // Timing patterns (between finders).
    for (var i = 8; i < size - 8; i++) {
      var dark = i % 2 === 0;
      mod[6][i] = dark; fn[6][i] = true;
      mod[i][6] = dark; fn[i][6] = true;
    }

    // Alignment patterns (skip the three finder corners).
    var pos = ALIGN[version];
    for (var r = 0; r < pos.length; r++) {
      for (var c = 0; c < pos.length; c++) {
        var isCorner = (r === 0 && c === 0) ||
          (r === 0 && c === pos.length - 1) ||
          (r === pos.length - 1 && c === 0);
        if (!isCorner) drawAlignment(mod, fn, pos[r], pos[c]);
      }
    }

    // Reserve format/version information areas (real values per mask later).
    writeFormatInfo(mod, fn, eclBits, 0);
    if (version >= 7) writeVersionInfo(mod, fn, version);

    return { mod: mod, fn: fn, size: size };
  }

  // Zig-zag data placement, bottom-right, pairs of columns, skipping col 6.
  function placeData(mod, fn, codewords) {
    var size = mod.length;
    var bits = [];
    for (var i = 0; i < codewords.length; i++) {
      for (var b = 7; b >= 0; b--) bits.push(((codewords[i] >> b) & 1) === 1);
    }
    var idx = 0;
    var dir = -1;
    var row = size - 1;
    var total = bits.length;
    for (var col = size - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      while (true) {
        for (var c = 0; c < 2; c++) {
          var cc = col - c;
          if (!fn[row][cc]) {
            mod[row][cc] = idx < total ? bits[idx] : false;
            idx++;
          }
        }
        row += dir;
        if (row < 0 || row >= size) {
          row -= dir;
          dir = -dir;
          break;
        }
      }
    }
  }

  // Mask formulas; applied to data modules only.
  function maskBit(mask, r, c) {
    switch (mask) {
      case 0: return (r + c) % 2 === 0;
      case 1: return r % 2 === 0;
      case 2: return c % 3 === 0;
      case 3: return (r + c) % 3 === 0;
      case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
      case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
      case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
      case 7: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    }
    return false;
  }

  // Penalty scoring per ISO/IEC 18004 §8.8.2.
  function penalty(mod) {
    var size = mod.length;
    var score = 0;
    var r, c, i, runColor, runLen;

    // N1: runs of >= 5 same-colour modules in rows and columns.
    for (r = 0; r < size; r++) {
      runColor = mod[r][0]; runLen = 1;
      for (c = 1; c < size; c++) {
        if (mod[r][c] === runColor) { runLen++; }
        else { if (runLen >= 5) score += 3 + (runLen - 5); runColor = mod[r][c]; runLen = 1; }
      }
      if (runLen >= 5) score += 3 + (runLen - 5);
    }
    for (c = 0; c < size; c++) {
      runColor = mod[0][c]; runLen = 1;
      for (r = 1; r < size; r++) {
        if (mod[r][c] === runColor) { runLen++; }
        else { if (runLen >= 5) score += 3 + (runLen - 5); runColor = mod[r][c]; runLen = 1; }
      }
      if (runLen >= 5) score += 3 + (runLen - 5);
    }

    // N2: 2x2 blocks of the same colour.
    for (r = 0; r < size - 1; r++) {
      for (c = 0; c < size - 1; c++) {
        var v = mod[r][c];
        if (mod[r][c + 1] === v && mod[r + 1][c] === v && mod[r + 1][c + 1] === v) score += 3;
      }
    }

    // N3: finder-like 1:1:3:1:1 patterns with a 4-light guard band.
    var patA = [false, false, false, false, true, false, true, true, true, false, true];
    var patB = [true, false, true, true, true, false, true, false, false, false, false];
    function matchAt(line, start) {
      for (var k = 0; k < 11; k++) {
        var v = line[start + k];
        if (v !== patA[k] && v !== patB[k]) return false;
      }
      // both patterns must match exactly (patA/patB differ); re-check properly
      var a = true, b = true;
      for (k = 0; k < 11; k++) {
        if (line[start + k] !== patA[k]) a = false;
        if (line[start + k] !== patB[k]) b = false;
      }
      return a || b;
    }
    for (r = 0; r < size; r++) {
      for (c = 0; c <= size - 11; c++) if (matchAt(mod[r], c)) score += 40;
    }
    for (c = 0; c < size; c++) {
      var colLine = new Array(size);
      for (i = 0; i < size; i++) colLine[i] = mod[i][c];
      for (r = 0; r <= size - 11; r++) if (matchAt(colLine, r)) score += 40;
    }

    // N4: deviation of dark-module proportion from 50%.
    var dark = 0;
    for (r = 0; r < size; r++) for (c = 0; c < size; c++) if (mod[r][c]) dark++;
    var pct = (dark * 100) / (size * size);
    score += Math.floor(Math.abs(pct - 50) / 5) * 10;

    return score;
  }

  // ------------------------------------------------------------------
  // Public: module matrix
  // ------------------------------------------------------------------
  function toModules(text, ecl, forcedMask) {
    ecl = (ecl || 'L').toUpperCase();
    if (ecl !== 'L' && ecl !== 'M') {
      throw new Error('QRCode: unsupported error-correction level "' + ecl + '" (use L or M)');
    }
    if (typeof text !== 'string') text = String(text);
    var bytes = utf8Bytes(text);
    var version = pickVersion(bytes.length, ecl);
    if (!version) {
      throw new Error('QRCode: data too long for version 1-' + MAX_VERSION + ' (' + bytes.length + ' bytes)');
    }

    var codewords = buildDataCodewords(bytes, version, ecl);
    var blocks = splitBlocks(codewords, version, ecl);
    var final = interleave(blocks);

    var eclBits = ECL_BITS[ecl];
    var base = buildBase(version, eclBits);
    placeData(base.mod, base.fn, final);

    // Try every mask: apply to data modules only, rewrite the format bits
    // so they encode that mask, and keep the lowest-penalty result.
    if (typeof forcedMask === 'number') {
      return applyMask(base, eclBits, version, forcedMask);
    }
    var best = null;
    var bestScore = Infinity;
    for (var mask = 0; mask < 8; mask++) {
      var cand = applyMask(base, eclBits, version, mask);
      var score = penalty(cand);
      if (score < bestScore) { bestScore = score; best = cand; }
    }
    return best;
  }

  function applyMask(base, eclBits, version, mask) {
    var cand = newMatrix(base.size);
    for (var r = 0; r < base.size; r++) {
      for (var c = 0; c < base.size; c++) {
        var v = base.mod[r][c];
        if (!base.fn[r][c] && maskBit(mask, r, c)) v = !v;
        cand[r][c] = v;
      }
    }
    // Rebuild the format information so it encodes this mask pattern.
    var dummyFn = newMatrix(base.size);
    writeFormatInfo(cand, dummyFn, eclBits, mask);
    if (version >= 7) writeVersionInfo(cand, dummyFn, version);
    return cand;
  }

  // ------------------------------------------------------------------
  // Public: SVG rendering
  // ------------------------------------------------------------------
  function toSVG(text, opts) {
    opts = opts || {};
    var margin = opts.margin == null ? 4 : opts.margin;
    var scale = opts.moduleSize == null ? 4 : opts.moduleSize;
    var fg = opts.color || '#111827';
    var bg = opts.background || '#ffffff';
    var mod = toModules(text, opts.ecl || 'L');
    var size = mod.length;
    var dim = (size + margin * 2) * scale;
    var d = [];
    for (var r = 0; r < size; r++) {
      for (var c = 0; c < size; c++) {
        if (mod[r][c]) {
          d.push('M' + ((c + margin) * scale) + ' ' + ((r + margin) * scale) +
            'h' + scale + 'v' + scale + 'h-' + scale + 'z');
        }
      }
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + dim + '" height="' + dim +
      '" viewBox="0 0 ' + dim + ' ' + dim + '" role="img" aria-label="QR code">' +
      '<rect width="' + dim + '" height="' + dim + '" fill="' + bg + '"/>' +
      '<path d="' + d.join('') + '" fill="' + fg + '"/></svg>';
  }

  global.QRCode = {
    toModules: toModules,
    toSVG: toSVG,
    // exposed for tests / introspection
    _internals: {
      utf8Bytes: utf8Bytes,
      pickVersion: pickVersion,
      rsEncode: rsEncode,
      bchFormatInfo: bchFormatInfo,
      bchVersionInfo: bchVersionInfo,
      penalty: penalty
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
