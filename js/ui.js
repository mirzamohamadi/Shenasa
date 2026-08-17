/*
 * ui.js — UI primitives for Shenasa: toast, modal, confirm dialogs,
 * XSS-safe escaping, error handling, tables with pagination, and
 * dependency-free inline SVG charts. All functions attach to window.Ui.
 */
(function (global) {
  'use strict';

  // ---- HTML escaping: ALL user-provided content goes through esc() -------
  var ESC_MAP = {
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  };
  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, function (ch) { return ESC_MAP[ch]; });
  }

  function el(tag, className, text) {
    var node = global.document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  // ---- Toasts --------------------------------------------------------------
  function toastRoot() {
    var root = global.document.querySelector('.toast-root');
    if (!root) {
      root = el('div', 'toast-root');
      root.setAttribute('aria-live', 'polite');
      global.document.body.appendChild(root);
    }
    return root;
  }

  function toast(msg, type, timeoutMs) {
    type = type || 'info';
    var root = toastRoot();
    var item = el('div', 'toast toast-' + type);
    item.setAttribute('role', type === 'error' ? 'alert' : 'status');
    var icon = { info: 'i', success: '✓', error: '✕', warning: '!' }[type] || 'i';
    var badge = el('span', 'toast-icon', icon);
    var body = el('span', 'toast-msg');
    body.textContent = msg; // textContent => XSS-safe
    item.appendChild(badge);
    item.appendChild(body);
    var close = el('button', 'toast-close', '×');
    close.setAttribute('aria-label', 'Dismiss notification');
    item.appendChild(close);
    function dismiss() {
      if (item.parentNode) item.parentNode.removeChild(item);
    }
    close.addEventListener('click', dismiss);
    root.appendChild(item);
    setTimeout(function () {
      item.classList.add('toast-out');
      setTimeout(dismiss, 250);
    }, timeoutMs || 5200);
  }

  // ---- Modal ---------------------------------------------------------------
  // openModal({ title, body, footer, onMount, wide, dismissLabel })
  // body/footer may be HTML strings (escaped at call sites!) or DOM nodes.
  function openModal(opts) {
    opts = opts || {};
    var doc = global.document;
    var overlay = el('div', 'modal-overlay');
    var modal = el('div', 'modal' + (opts.wide ? ' modal-wide' : ''));
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', opts.title || 'Dialog');

    var head = el('div', 'modal-head');
    var title = el('h2', 'modal-title', opts.title || '');
    var x = el('button', 'btn btn-ghost btn-icon modal-x', '×');
    x.setAttribute('aria-label', 'Close dialog');
    head.appendChild(title);
    head.appendChild(x);

    var body = el('div', 'modal-body');
    if (opts.body instanceof global.Node) body.appendChild(opts.body);
    else if (typeof opts.body === 'string') body.innerHTML = opts.body;

    var foot = el('div', 'modal-foot');
    if (opts.footer instanceof global.Node) foot.appendChild(opts.footer);
    else if (typeof opts.footer === 'string') foot.innerHTML = opts.footer;
    else foot.style.display = 'none';

    modal.appendChild(head);
    modal.appendChild(body);
    modal.appendChild(foot);
    overlay.appendChild(modal);
    doc.body.appendChild(overlay);

    var prevFocus = doc.activeElement;
    function close() {
      doc.removeEventListener('keydown', onKey, true);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      if (prevFocus && prevFocus.focus) { try { prevFocus.focus(); } catch (e) {} }
      if (opts.onClose) opts.onClose();
    }
    function onKey(e) {
      if (e.key === 'Escape' || e.keyCode === 27) {
        e.stopPropagation();
        close();
      }
    }
    doc.addEventListener('keydown', onKey, true);
    overlay.addEventListener('mousedown', function (e) {
      if (e.target === overlay && !opts.sticky) close();
    });
    x.addEventListener('click', close);
    setTimeout(function () {
      var focusable = modal.querySelector('input, select, textarea, button:not(.modal-x)');
      (focusable || x).focus();
    }, 0);
    if (opts.onMount) opts.onMount(modal, close);
    return { close: close, el: modal };
  }

  // confirmDialog(message, onConfirm, { title, confirmLabel, danger })
  function confirmDialog(message, onConfirm, opts) {
    opts = opts || {};
    var doc = global.document;
    var body = el('div');
    var p = el('p', 'confirm-msg');
    p.textContent = message;
    body.appendChild(p);

    var foot = el('div', 'btn-row');
    var cancel = el('button', 'btn', opts.cancelLabel || global.t('common.cancel'));
    var ok = el('button', 'btn ' + (opts.danger ? 'btn-danger' : 'btn-primary'),
      opts.confirmLabel || global.t('common.confirm'));
    foot.appendChild(cancel);
    foot.appendChild(ok);

    var m = openModal({
      title: opts.title || global.t('common.confirm'),
      body: body,
      footer: foot
    });
    cancel.addEventListener('click', m.close);
    ok.addEventListener('click', function () {
      m.close();
      if (onConfirm) onConfirm();
    });
    // Enter triggers confirm for keyboard users.
    m.el.addEventListener('keydown', function (e) {
      if ((e.key === 'Enter' || e.keyCode === 13) && e.target.tagName !== 'TEXTAREA') {
        e.preventDefault();
        ok.click();
      }
    });
    return m;
  }

  // ---- Error handling --------------------------------------------------------
  function handleError(err, context) {
    var status = err && typeof err.status === 'number' ? err.status : null;
    var detail = err && err.message ? String(err.message) : '';
    if (status === null) {
      toast(context ? context + ': ' + (detail || t('error.generic')) : (detail || t('error.generic')), 'error');
      return;
    }
    switch (status) {
      case 401:
        toast(t('error.401'), 'warning', 6500);
        global.Store.clear();
        if (global.location.hash !== '#/login') global.location.hash = '#/login';
        break;
      case 403: {
        var msg = context === 'people' ? t('error.403.people')
          : context === 'groups' ? t('error.403.groups')
          : context === 'oauth2' ? t('error.403.oauth2')
          : context === 'svcaccounts' ? t('error.403.svcaccounts')
          : context === 'domain' ? t('error.403.domain')
          : t('error.403');
        // A read-only (privilege-capable, not yet stepped-up) session is
        // denied EVERY write before roles are checked — if that's our
        // state, the roles explanation would send the admin on a wild
        // goose chase, so lead with the session fix instead.
        if (global.Store && global.Store.isSignedIn() && !global.Store.canWriteNow()) {
          msg = t('error.403.readonly');
        } else if (context === 'groups') msg += ' ' + t('error.403.groups.hint');
        toast((context ? context + ': ' : '') + msg +
          (detail && detail !== 'Forbidden' ? ' (' + detail + ')' : ''), 'error');
        break;
      }
      case 409:
        toast(t('error.409'), 'error');
        break;
      case 404:
        toast(t('error.404'), 'error');
        break;
      case 400:
        toast(t('error.400') + (detail ? ' ' + detail : ''), 'error');
        break;
      case 501:
        toast(t('error.501'), 'warning', 7000);
        break;
      case 0:
        toast(t('error.0'), 'error', 8000);
        break;
      default:
        toast((context ? context + ': ' : '') + (detail || t('error.generic')), 'error');
    }
  }

  // ---- Loading / empty states ------------------------------------------------
  function spinner(label) {
    return '<div class="loading"><span class="spinner" aria-hidden="true"></span>' +
      '<span>' + esc(label || global.t('common.loading')) + '</span></div>';
  }

  function emptyState(title, text, actionHtml) {
    return '<div class="empty-state">' +
      '<div class="empty-icon" aria-hidden="true">○</div>' +
      '<h3>' + esc(title) + '</h3>' +
      (text ? '<p>' + esc(text) + '</p>' : '') +
      (actionHtml || '') +
      '</div>';
  }

  // ---- Badges / chips ---------------------------------------------------------
  function badge(text, kind) {
    return '<span class="badge badge-' + (kind || 'muted') + '">' + esc(text) + '</span>';
  }

  function statusBadge(statusKey) {
    var kinds = { active: 'ok', expired: 'danger', notYetValid: 'warn' };
    return badge(global.t('status.' + statusKey), kinds[statusKey] || 'muted');
  }

  function chip(labelHtml, opts) {
    opts = opts || {};
    return '<span class="chip" data-value="' + esc(opts.value != null ? opts.value : '') + '">' +
      labelHtml +
      (opts.removable
        ? '<button type="button" class="chip-x" aria-label="Remove" data-remove>×</button>'
        : '') +
      '</span>';
  }

  // ---- Pagination + tables ------------------------------------------------------
  // Pure: slices items for the given page (1-based).
  function paginate(items, page, pageSize) {
    var total = items.length;
    var pages = Math.max(1, Math.ceil(total / pageSize));
    var p = Math.min(Math.max(1, page), pages);
    return {
      page: p,
      pages: pages,
      total: total,
      items: items.slice((p - 1) * pageSize, p * pageSize)
    };
  }

  function paginationHtml(info) {
    if (info.pages <= 1) return '<div class="pagination-info">' + info.total + '</div>';
    return '<div class="pagination">' +
      '<button type="button" class="btn btn-sm" data-page-prev ' + (info.page <= 1 ? 'disabled' : '') + '>' +
      esc(global.t('table.page.prev')) + '</button>' +
      '<span class="pagination-info">' + info.page + ' ' + esc(global.t('table.page.of')) + ' ' + info.pages +
      ' · ' + info.total + '</span>' +
      '<button type="button" class="btn btn-sm" data-page-next ' + (info.page >= info.pages ? 'disabled' : '') + '>' +
      esc(global.t('table.page.next')) + '</button>' +
      '</div>';
  }

  // columns: [{ key, label, render(row) -> html, className, labelHtml }]
  // `label` is escaped; `labelHtml` is inserted RAW and is reserved for
  // self-authored control markup (e.g. the select-all checkbox).
  // Returns a HTML string; bindPagination wires the prev/next buttons.
  function tableHtml(columns, rows, info, emptyHtml) {
    var html = '<div class="table-wrap"><table class="table"><thead><tr>';
    for (var i = 0; i < columns.length; i++) {
      html += '<th scope="col"' + (columns[i].className ? ' class="' + columns[i].className + '"' : '') + '>' +
        (columns[i].labelHtml != null ? columns[i].labelHtml : esc(columns[i].label)) + '</th>';
    }
    html += '</tr></thead><tbody>';
    if (!rows.length) {
      html += '<tr><td colspan="' + columns.length + '" class="table-empty">' +
        (emptyHtml || esc(global.t('table.empty'))) + '</td></tr>';
    } else {
      for (var r = 0; r < rows.length; r++) {
        html += '<tr data-row="' + r + '">';
        for (var c = 0; c < columns.length; c++) {
          var cell = columns[c].render ? columns[c].render(rows[r], r) : esc(rows[r][columns[c].key]);
          html += '<td' + (columns[c].className ? ' class="' + columns[c].className + '"' : '') + '>' +
            cell + '</td>';
        }
        html += '</tr>';
      }
    }
    html += '</tbody></table></div>' + paginationHtml(info);
    return html;
  }

  function bindPagination(root, info, onPage) {
    var prev = root.querySelector('[data-page-prev]');
    var next = root.querySelector('[data-page-next]');
    if (prev) prev.addEventListener('click', function () { onPage(info.page - 1); });
    if (next) next.addEventListener('click', function () { onPage(info.page + 1); });
  }

  // ---- Inline SVG charts ---------------------------------------------------------
  var CHART_COLORS = ['#3b6ea5', '#5aa9a2', '#8597b8', '#c28547', '#7a6fae',
    '#b06060', '#66916e', '#4f7f9e'];

  // Donut/pie chart. segments: [{ label, value, color? }]
  function svgPie(segments, opts) {
    opts = opts || {};
    var size = opts.size || 180;
    var stroke = opts.stroke || 34;
    var r = (size - stroke) / 2;
    var cx = size / 2;
    var cy = size / 2;
    var total = 0;
    var i;
    for (i = 0; i < segments.length; i++) total += segments[i].value;
    var out = '<div class="chart chart-pie"><svg viewBox="0 0 ' + size + ' ' + size +
      '" width="' + size + '" height="' + size + '" role="img" aria-label="' + esc(opts.label || 'chart') + '">';
    var angle = -Math.PI / 2;
    var legend = '<ul class="chart-legend">';
    if (total === 0) {
      out += '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="var(--border)" stroke-width="' + stroke + '"/>';
    }
    for (i = 0; i < segments.length; i++) {
      var seg = segments[i];
      var color = seg.color || CHART_COLORS[i % CHART_COLORS.length];
      var frac = total ? seg.value / total : 0;
      var a0 = angle;
      var a1 = angle + frac * Math.PI * 2;
      angle = a1;
      if (frac > 0) {
        // arc on a stroked circle to form a donut segment
        var sweep = Math.min(frac, 0.9999);
        var endAngle = a0 + sweep * Math.PI * 2;
        var x0 = cx + r * Math.cos(a0);
        var y0 = cy + r * Math.sin(a0);
        var x1 = cx + r * Math.cos(endAngle);
        var y1 = cy + r * Math.sin(endAngle);
        var large = sweep > 0.5 ? 1 : 0;
        out += '<path d="M' + x0.toFixed(2) + ' ' + y0.toFixed(2) +
          ' A' + r + ' ' + r + ' 0 ' + large + ' 1 ' + x1.toFixed(2) + ' ' + y1.toFixed(2) +
          '" fill="none" stroke="' + color + '" stroke-width="' + stroke + '"/>';
      }
      // The swatch is an inline SVG rect with a `fill` ATTRIBUTE, not an
      // inline style — a style ATTRIBUTE in markup is blocked by the strict
      // style-src 'self' CSP, SVG presentation attributes are not.
      legend += '<li><svg class="dot" viewBox="0 0 10 10" aria-hidden="true">' +
        '<rect width="10" height="10" rx="2" fill="' + color + '"/></svg>' +
        esc(seg.label) + ' <strong>' + esc(String(seg.value)) + '</strong></li>';
    }
    out += '<text x="' + cx + '" y="' + cy + '" text-anchor="middle" dominant-baseline="central" class="chart-total">' +
      esc(String(total)) + '</text></svg>' + legend + '</ul></div>';
    return out;
  }

  // Horizontal bar chart. items: [{ label, count, color? }]
  function svgBars(items, opts) {
    opts = opts || {};
    var max = 0;
    for (var i = 0; i < items.length; i++) if (items[i].count > max) max = items[i].count;
    if (max === 0) max = 1;
    var rowH = 30;
    var labelW = 120;
    var barW = opts.width || 420;
    var height = items.length * rowH + 8;
    var out = '<div class="chart chart-bars"><svg viewBox="0 0 ' + (labelW + barW + 48) + ' ' + height +
      '" width="100%" height="' + height + '" role="img" aria-label="' + esc(opts.label || 'bar chart') + '">';
    for (i = 0; i < items.length; i++) {
      var it = items[i];
      var y = i * rowH + 4;
      var w = Math.max(2, Math.round((it.count / max) * barW));
      var color = it.color || CHART_COLORS[i % CHART_COLORS.length];
      out += '<text x="' + (labelW - 8) + '" y="' + (y + rowH / 2 + 2) + '" text-anchor="end" class="chart-label">' +
        esc(it.label) + '</text>' +
        '<rect x="' + labelW + '" y="' + y + '" width="' + w + '" height="' + (rowH - 10) +
        '" rx="3" fill="' + color + '"/>' +
        '<text x="' + (labelW + w + 6) + '" y="' + (y + rowH / 2 + 2) + '" class="chart-value">' +
        esc(String(it.count)) + '</text>';
    }
    out += '</svg></div>';
    return out;
  }

  // Progress ring. pct: 0..100
  function svgRing(pct, opts) {
    opts = opts || {};
    var size = opts.size || 132;
    var stroke = opts.stroke || 12;
    var r = (size - stroke) / 2;
    var cx = size / 2;
    var circ = 2 * Math.PI * r;
    var clamped = Math.max(0, Math.min(100, pct));
    var dash = (clamped / 100) * circ;
    return '<div class="chart chart-ring"><svg viewBox="0 0 ' + size + ' ' + size +
      '" width="' + size + '" height="' + size + '" role="img" aria-label="' + esc(opts.label || 'progress') + '">' +
      '<circle cx="' + cx + '" cy="' + cx + '" r="' + r + '" fill="none" stroke="var(--border)" stroke-width="' + stroke + '"/>' +
      '<circle cx="' + cx + '" cy="' + cx + '" r="' + r + '" fill="none" stroke="var(--accent)" stroke-width="' + stroke +
      '" stroke-linecap="round" stroke-dasharray="' + dash.toFixed(1) + ' ' + circ.toFixed(1) +
      '" transform="rotate(-90 ' + cx + ' ' + cx + ')"/>' +
      '<text x="' + cx + '" y="' + cx + '" text-anchor="middle" dominant-baseline="central" class="chart-total">' +
      esc(Math.round(clamped) + '%') + '</text></svg>' +
      (opts.caption ? '<div class="chart-caption">' + esc(opts.caption) + '</div>' : '') + '</div>';
  }

  // ---- Form helpers ---------------------------------------------------------------
  function fieldHtml(opts) {
    // opts: { name, label, type, value, placeholder, required, readonly, help, error, input }
    var input = opts.input ||
      '<input class="input" type="' + esc(opts.type || 'text') + '" name="' + esc(opts.name) + '"' +
      ' value="' + esc(opts.value != null ? opts.value : '') + '"' +
      (opts.placeholder ? ' placeholder="' + esc(opts.placeholder) + '"' : '') +
      (opts.required ? ' required aria-required="true"' : '') +
      (opts.readonly ? ' readonly aria-readonly="true"' : '') +
      (opts.autocomplete ? ' autocomplete="' + esc(opts.autocomplete) + '"' : '') + '/>';
    return '<div class="field' + (opts.error ? ' field-error' : '') + '">' +
      '<label class="label" for="f-' + esc(opts.name) + '">' + esc(opts.label) +
      (opts.required ? ' <span class="req">*</span>' : '') + '</label>' +
      input.replace('class="input"', 'class="input" id="f-' + esc(opts.name) + '"') +
      (opts.help ? '<div class="help">' + esc(opts.help) + '</div>' : '') +
      (opts.error ? '<div class="error-text">' + esc(opts.error) + '</div>' : '') +
      '</div>';
  }

  function showFieldErrors(modalEl, errors) {
    var fields = modalEl.querySelectorAll('.field');
    for (var i = 0; i < fields.length; i++) {
      fields[i].classList.remove('field-error');
      var old = fields[i].querySelector('.error-text');
      if (old) old.parentNode.removeChild(old);
    }
    for (var name in errors) {
      if (!Object.prototype.hasOwnProperty.call(errors, name)) continue;
      var input = modalEl.querySelector('[name="' + name + '"]');
      if (!input) continue;
      var field = input.closest('.field');
      if (!field) continue;
      field.classList.add('field-error');
      var msg = el('div', 'error-text', errors[name]);
      field.appendChild(msg);
    }
    var firstErr = modalEl.querySelector('.field-error .input');
    if (firstErr) firstErr.focus();
  }

  // ---- Misc ------------------------------------------------------------------------
  function formatDate(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toISOString().slice(0, 10);
  }

  // Date + time (UTC, minute precision) for session timestamps. Falls back
  // to the raw value when it is not parseable (e.g. exotic RFC3339 forms).
  function formatDateTime(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toISOString().slice(0, 16).replace('T', ' ') + 'Z';
  }

  function toRfc3339(dateStr, endOfDay) {
    if (!dateStr) return undefined;
    var s = String(dateStr).trim();
    if (s.indexOf('T') >= 0) return s; // assume already RFC 3339
    return s + (endOfDay ? 'T23:59:59Z' : 'T00:00:00Z');
  }

  function debounce(fn, ms) {
    var timer = null;
    return function () {
      var self = this;
      var args = arguments;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(self, args); }, ms || 250);
    };
  }

  function download(filename, content, mime) {
    var blob = new global.Blob([content], { type: mime || 'application/octet-stream' });
    var url = global.URL.createObjectURL(blob);
    var a = el('a');
    a.href = url;
    a.download = filename;
    global.document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      global.URL.revokeObjectURL(url);
      if (a.parentNode) a.parentNode.removeChild(a);
    }, 0);
  }

  function copyText(text) {
    function fallback() {
      var ta = el('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      global.document.body.appendChild(ta);
      ta.select();
      try { global.document.execCommand('copy'); toast(global.t('common.copied'), 'success'); }
      catch (e) { toast(String(e), 'error'); }
      if (ta.parentNode) ta.parentNode.removeChild(ta);
    }
    if (global.navigator.clipboard && global.navigator.clipboard.writeText) {
      global.navigator.clipboard.writeText(text).then(
        function () { toast(global.t('common.copied'), 'success'); },
        fallback);
    } else {
      fallback();
    }
  }

  global.Ui = {
    esc: esc,
    el: el,
    toast: toast,
    openModal: openModal,
    confirmDialog: confirmDialog,
    handleError: handleError,
    spinner: spinner,
    emptyState: emptyState,
    badge: badge,
    statusBadge: statusBadge,
    chip: chip,
    paginate: paginate,
    paginationHtml: paginationHtml,
    tableHtml: tableHtml,
    bindPagination: bindPagination,
    svgPie: svgPie,
    svgBars: svgBars,
    svgRing: svgRing,
    fieldHtml: fieldHtml,
    showFieldErrors: showFieldErrors,
    formatDate: formatDate,
    formatDateTime: formatDateTime,
    toRfc3339: toRfc3339,
    debounce: debounce,
    download: download,
    copyText: copyText,
    CHART_COLORS: CHART_COLORS
  };
})(typeof window !== 'undefined' ? window : globalThis);
