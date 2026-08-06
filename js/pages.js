/*
 * pages.js — page renderers for Shenasa (one function per route).
 *
 * Every function receives the content root element and renders into it.
 * ALL user-supplied values injected into HTML pass through Ui.esc().
 * Buttons are gated with the Store RBAC helpers; the Kanidm server always
 * remains the authorisation authority.
 */
(function (global) {
  'use strict';

  var doc = function () { return global.document; };

  function html(strings) {
    var out = strings[0];
    for (var i = 1; i < arguments.length; i++) out += arguments[i] + strings[i];
    return out;
  }

  function esc(s) { return global.Ui.esc(s); }
  function t(k, v) { return global.t(k, v); }

  function card(title, innerHtml, extraClass) {
    return '<section class="card ' + (extraClass || '') + '">' +
      (title ? '<h2 class="card-title">' + esc(title) + '</h2>' : '') +
      innerHtml + '</section>';
  }

  function loadError(root, err, context) {
    global.Ui.handleError(err, context);
    root.innerHTML = global.Ui.emptyState(t('error.title'), err && err.message ? err.message : '');
  }

  function memberofMatches(memberof, groupName) {
    for (var i = 0; i < memberof.length; i++) {
      var m = String(memberof[i]);
      if (m === groupName || global.Store.stripDomain(m) === groupName) return true;
    }
    return false;
  }

  // Human-readable capability summary for Kanidm's built-in role groups,
  // derived from the builtin ACPs of v1.10.5
  // (server/lib/src/migration_data/dl14/access.rs). Custom groups get the
  // server's own `description` attribute instead; '' when both are absent.
  function roleDesc(name) {
    var key = 'role.desc.' + String(name || '');
    var s = t(key);
    return s === key ? '' : s;
  }
  function groupCapability(group) {
    var name = global.Api.attr(group, 'name') || '';
    return roleDesc(name) || global.Api.attr(group, 'description') || '';
  }

  var PAGE_SIZE = 15;

  var Pages = {};

  // ======================================================================
  // Dashboard
  // ======================================================================
  Pages.dashboard = async function (root) {
    root.innerHTML = '<h1 class="page-title">' + esc(t('dash.title')) + '</h1>' + global.Ui.spinner();
    try {
      var stats = await global.Api.stats();
      var analytics = await global.Api.analytics();
      var now = Date.now();
      var active = 0, expired = 0, pending = 0;
      for (var i = 0; i < stats.people.length; i++) {
        var s = global.Api.accountStatus(stats.people[i], now);
        if (s === 'active') active++;
        else if (s === 'expired') expired++;
        else pending++;
      }
      var user = global.Store.user || { roles: [] };

      var cards = '<div class="stat-grid">' +
        statCard(t('dash.totalUsers'), stats.totalUsers) +
        statCard(t('dash.totalGroups'), stats.totalGroups) +
        statCard(t('dash.activeUsers'), active) +
        statCard(t('dash.passkeyOnly'), stats.passkeyOnlyUsers) +
        '</div>';

      var charts = '<div class="grid-3">' +
        card(t('dash.statusChart'), global.Ui.svgPie([
          { label: t('status.active'), value: active, color: '#66916e' },
          { label: t('status.expired'), value: expired, color: '#b06060' },
          { label: t('status.notYetValid'), value: pending, color: '#c28547' }
        ], { label: t('dash.statusChart') })) +
        card(t('dash.groupChart'), global.Ui.svgBars(analytics.membersPerGroup.slice(0, 8), { label: t('dash.groupChart') })) +
        card(t('dash.passkeyChart'), global.Ui.svgRing(analytics.passkeyAdoption, {
          label: t('dash.passkeyChart'),
          caption: analytics.passkeyUsers + ' / ' + analytics.totalUsers + ' users'
        })) +
        '</div>';

      var rolesChips = user.roles && user.roles.length
        ? user.roles.map(function (r) { return '<span class="chip">' + esc(r) + '</span>'; }).join(' ')
        : '<span class="muted">' + esc(t('common.none')) + '</span>';

      root.innerHTML = '<h1 class="page-title">' + esc(t('dash.title')) + '</h1>' +
        cards + charts +
        '<div class="grid-2">' +
        card(t('dash.yourRoles'), '<div class="chip-row">' + rolesChips + '</div>') +
        // Kanidm 1.10 has NO REST endpoint for reading audit events
        // (verified: no /v1/audit route exists) — point admins to the
        // server's own log instead of showing an empty table.
        card(t('dash.auditLogs.title'),
          '<p class="muted">' + esc(t('dash.auditLogs.body')) + '</p>' +
          '<p><code>docker logs shenasa-kanidm</code></p>') +
        '</div>';
    } catch (err) {
      loadError(root, err, 'dashboard');
    }
  };

  function statCard(label, value) {
    return '<div class="stat-card"><div class="stat-value">' + esc(String(value)) + '</div>' +
      '<div class="stat-label">' + esc(label) + '</div></div>';
  }

  // ======================================================================
  // Users
  // ======================================================================
  var usersState = { q: '', group: '', page: 1, people: [], groups: [] };

  Pages.users = async function (root) {
    usersState.page = 1;
    root.innerHTML = '<h1 class="page-title">' + esc(t('users.title')) + '</h1>' + global.Ui.spinner();
    try {
      var results = await Promise.all([global.Api.listPeople(), global.Api.listGroups()]);
      usersState.people = results[0] || [];
      usersState.groups = results[1] || [];
      renderUsers(root);
    } catch (err) {
      loadError(root, err, 'people');
    }
  };

  function renderUsers(root) {
    var canManage = global.Store.canManagePeople();
    var canPii = global.Store.canReadPii();

    var groupOptions = ['<option value="">' + esc(t('common.all')) + '</option>'];
    for (var i = 0; i < usersState.groups.length; i++) {
      var gn = global.Api.attr(usersState.groups[i], 'name') || '';
      groupOptions.push('<option value="' + esc(gn) + '"' + (usersState.group === gn ? ' selected' : '') + '>' + esc(gn) + '</option>');
    }

    var toolbar = '<div class="toolbar">' +
      '<input class="input toolbar-search" type="search" data-users-search placeholder="' + esc(t('users.searchPlaceholder')) + '"' +
      ' value="' + esc(usersState.q) + '" aria-label="' + esc(t('users.searchPlaceholder')) + '"/>' +
      '<select class="input" data-users-group aria-label="' + esc(t('users.filterGroup')) + '">' + groupOptions.join('') + '</select>' +
      '<span class="toolbar-spacer"></span>' +
      (canManage ? '<button class="btn btn-primary" data-users-new>' + esc(t('users.new')) + '</button>' : '') +
      (canManage ? '<button class="btn" data-users-import-csv>' + esc(t('users.importCsv')) + '</button>' : '') +
      '<button class="btn" data-users-export-csv>' + esc(t('users.exportCsv')) + '</button>' +
      '<button class="btn" data-users-export-json>' + esc(t('users.exportJson')) + '</button>' +
      '</div>';

    // Filter
    var q = usersState.q.toLowerCase();
    var filtered = [];
    for (var j = 0; j < usersState.people.length; j++) {
      var p = usersState.people[j];
      var name = String(global.Api.attr(p, 'name') || '');
      var dn = String(global.Api.attr(p, 'displayname') || '');
      if (q && name.toLowerCase().indexOf(q) < 0 && dn.toLowerCase().indexOf(q) < 0) continue;
      if (usersState.group && !memberofMatches(global.Api.attrs(p, 'memberof'), usersState.group)) continue;
      filtered.push(p);
    }
    filtered.sort(function (a, b) {
      return String(global.Api.attr(a, 'name') || '').localeCompare(String(global.Api.attr(b, 'name') || ''));
    });

    var info = global.Ui.paginate(filtered, usersState.page, PAGE_SIZE);
    usersState.page = info.page;
    var now = Date.now();

    var table = global.Ui.tableHtml([
      {
        key: 'name', label: t('users.col.name'), render: function (p) {
          var name = global.Api.attr(p, 'name') || '';
          return '<a href="#/users/' + encodeURIComponent(name) + '" class="link">' + esc(name) + '</a>';
        }
      },
      { key: 'displayname', label: t('users.col.displayName'), render: function (p) { return esc(global.Api.attr(p, 'displayname') || ''); } },
      {
        key: 'mail', label: t('users.col.mail'), render: function (p) {
          if (!canPii) return '<span class="muted">' + esc(t('users.mail.restricted')) + '</span>';
          return esc(global.Api.attr(p, 'mail') || '—');
        }
      },
      { key: 'status', label: t('users.col.status'), render: function (p) { return global.Ui.statusBadge(global.Api.accountStatus(p, now)); } },
      { key: 'valid_from', label: t('users.col.validFrom'), render: function (p) { return esc(global.Ui.formatDate(global.Api.attr(p, 'account_valid_from'))); } },
      { key: 'expire', label: t('users.col.expires'), render: function (p) { return esc(global.Ui.formatDate(global.Api.attr(p, 'account_expire'))); } },
      {
        key: 'actions', label: t('common.actions'), className: 'col-actions', render: function (p) {
          var name = global.Api.attr(p, 'name') || '';
          var btns = '<a class="btn btn-sm" href="#/users/' + encodeURIComponent(name) + '">' + esc(t('common.edit')) + '</a>';
          if (canManage) {
            btns += ' <button class="btn btn-sm btn-danger" data-user-delete="' + esc(name) + '">' + esc(t('common.delete')) + '</button>';
          }
          return btns;
        }
      }
    ], info.items, info, filtered.length ? t('table.empty') : t('table.empty'));

    root.innerHTML = '<h1 class="page-title">' + esc(t('users.title')) + '</h1>' + toolbar + table;

    // Wire events
    var search = root.querySelector('[data-users-search]');
    if (search) {
      search.addEventListener('input', global.Ui.debounce(function () {
        usersState.q = search.value;
        usersState.page = 1;
        renderUsers(root);
      }, 200));
    }
    var groupSel = root.querySelector('[data-users-group]');
    if (groupSel) {
      groupSel.addEventListener('change', function () {
        usersState.group = groupSel.value;
        usersState.page = 1;
        renderUsers(root);
      });
    }
    global.Ui.bindPagination(root, info, function (p) {
      usersState.page = p;
      renderUsers(root);
    });
    var newBtn = root.querySelector('[data-users-new]');
    if (newBtn) newBtn.addEventListener('click', function () { userFormModal(root, null); });
    var delBtns = root.querySelectorAll('[data-user-delete]');
    for (var d = 0; d < delBtns.length; d++) {
      (function (btn) {
        btn.addEventListener('click', function () { confirmDeleteUser(root, btn.getAttribute('data-user-delete')); });
      })(delBtns[d]);
    }
    var exportCsv = root.querySelector('[data-users-export-csv]');
    if (exportCsv) exportCsv.addEventListener('click', function () { exportUsersCsv(filtered, canPii); });
    var exportJson = root.querySelector('[data-users-export-json]');
    if (exportJson) exportJson.addEventListener('click', function () { exportUsersJson(filtered); });
    var importCsv = root.querySelector('[data-users-import-csv]');
    if (importCsv) importCsv.addEventListener('click', function () { importCsvModal(root); });
  }

  function confirmDeleteUser(root, name) {
    global.Ui.confirmDialog(t('users.delete.confirm', { name: name }), async function () {
      try {
        await global.Api.deletePerson(name);
        global.Ui.toast(t('common.deleted'), 'success');
        Pages.users(root);
      } catch (err) {
        global.Ui.handleError(err, 'people');
      }
    }, { danger: true, confirmLabel: t('common.delete') });
  }

  function userFormModal(root, person) {
    var isEdit = !!person;
    var name = isEdit ? global.Api.attr(person, 'name') || '' : '';
    var errors = {};
    var body = html`
      <form data-user-form novalidate>
        ${global.Ui.fieldHtml({ name: 'name', label: t('users.field.username'), value: name, required: true, readonly: isEdit, error: errors.name, help: isEdit ? 'Username cannot be changed.' : '' })}
        ${global.Ui.fieldHtml({ name: 'displayname', label: t('users.field.displayName'), value: isEdit ? global.Api.attr(person, 'displayname') || '' : '', required: true })}
        ${global.Ui.fieldHtml({ name: 'mail', label: t('users.field.mail'), type: 'email', value: isEdit && global.Store.canReadPii() ? global.Api.attr(person, 'mail') || '' : '' })}
        ${global.Ui.fieldHtml({ name: 'validFrom', label: t('users.field.validFrom'), type: 'date', value: isEdit ? global.Ui.formatDate(global.Api.attr(person, 'account_valid_from')).replace('—', '') : '' })}
        ${global.Ui.fieldHtml({ name: 'expire', label: t('users.field.expire'), type: 'date', value: isEdit ? global.Ui.formatDate(global.Api.attr(person, 'account_expire')).replace('—', '') : '' })}
      </form>`;
    var foot = '<button class="btn" data-cancel>' + esc(t('common.cancel')) + '</button>' +
      '<button class="btn btn-primary" data-submit>' + esc(t('common.save')) + '</button>';
    var modal = global.Ui.openModal({
      title: isEdit ? t('users.edit.title') : t('users.create.title'),
      body: body,
      footer: foot,
      onMount: function (el, close) {
        el.querySelector('[data-cancel]').addEventListener('click', close);
        el.querySelector('[data-submit]').addEventListener('click', async function () {
          var form = el.querySelector('[data-user-form]');
          var data = {
            name: form.querySelector('[name=name]').value.trim(),
            displayname: form.querySelector('[name=displayname]').value.trim(),
            mail: form.querySelector('[name=mail]').value.trim(),
            validFrom: form.querySelector('[name=validFrom]').value,
            expire: form.querySelector('[name=expire]').value
          };
          var result = global.Validation.personForm(data, { skipUsername: isEdit });
          if (!result.ok) {
            global.Ui.showFieldErrors(el, result.errors);
            return;
          }
          var payload = {
            displayname: data.displayname,
            mail: data.mail,
            validFrom: global.Ui.toRfc3339(data.validFrom),
            expire: global.Ui.toRfc3339(data.expire, true)
          };
          try {
            if (isEdit) {
              await global.Api.updatePerson(name, payload);
            } else {
              payload.name = data.name;
              await global.Api.createPerson(payload);
            }
            close();
            global.Ui.toast(t('common.saved'), 'success');
            if (root.getAttribute('data-page') === 'user') {
              Pages.userDetail(root, isEdit ? name : data.name);
            } else {
              Pages.users(root);
            }
          } catch (err) {
            if (err && err.status === 400 && err.message) {
              global.Ui.toast(err.message, 'error');
            } else {
              global.Ui.handleError(err, 'people');
            }
          }
        });
      }
    });
  }

  function usersToCsv(filtered, canPii) {
    var lines = ['name,displayname,mail'];
    function csv(v) {
      v = String(v == null ? '' : v);
      // Spreadsheet formula-injection guard: a cell starting with =, +, -,
      // @ (or tab/CR) is executed as a FORMULA when the CSV is opened in
      // Excel/LibreOffice — a malicious display name would weaponise the
      // export. Prefix such cells with an apostrophe to force text.
      if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;
      return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    }
    for (var i = 0; i < filtered.length; i++) {
      var p = filtered[i];
      lines.push(csv(global.Api.attr(p, 'name')) + ',' + csv(global.Api.attr(p, 'displayname')) +
        ',' + csv(canPii ? global.Api.attr(p, 'mail') || '' : ''));
    }
    return lines.join('\n');
  }

  function exportUsersCsv(filtered, canPii) {
    global.Ui.download('shenasa-users.csv', usersToCsv(filtered, canPii), 'text/csv');
  }
  function exportUsersJson(filtered) {
    global.Ui.download('shenasa-users.json', JSON.stringify(filtered, null, 2), 'application/json');
  }

  // Naive but quoted-field-aware CSV line parser.
  function parseCsv(text) {
    var rows = [];
    var row = [];
    var field = '';
    var inQuotes = false;
    function endField() { row.push(field); field = ''; }
    function endRow() { endField(); rows.push(row); row = []; }
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += ch;
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        endField();
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        endRow();
      } else field += ch;
    }
    if (field !== '' || row.length) endRow();
    // drop trailing fully-empty rows
    return rows.filter(function (r) {
      return r.some(function (c) { return String(c).trim() !== ''; });
    });
  }

  function importCsvModal(root) {
    var fileInput = global.Ui.el('input', 'input');
    fileInput.type = 'file';
    fileInput.accept = '.csv,text/csv';
    var help = global.Ui.el('p', 'help', 'CSV with header: name,displayname,mail');
    var body = global.Ui.el('div');
    body.appendChild(help);
    body.appendChild(fileInput);
    var preview = global.Ui.el('div', 'csv-preview');
    body.appendChild(preview);

    var parsed = [];
    fileInput.addEventListener('change', function () {
      var f = fileInput.files && fileInput.files[0];
      if (!f) return;
      var reader = new global.FileReader();
      reader.onload = function () {
        var rows = parseCsv(String(reader.result || ''));
        if (rows.length && String(rows[0][0]).toLowerCase() === 'name') rows.shift();
        parsed = rows;
        var htmlStr = '<table class="table"><thead><tr><th>name</th><th>displayname</th><th>mail</th></tr></thead><tbody>';
        for (var i = 0; i < rows.length; i++) {
          htmlStr += '<tr><td>' + esc(rows[i][0]) + '</td><td>' + esc(rows[i][1]) + '</td><td>' + esc(rows[i][2]) + '</td></tr>';
        }
        preview.innerHTML = htmlStr + '</tbody></table>' + '<p class="muted">' + rows.length + ' row(s)</p>';
      };
      reader.readAsText(f);
    });

    var foot = '<button class="btn" data-cancel>' + esc(t('common.cancel')) + '</button>' +
      '<button class="btn btn-primary" data-submit disabled>' + esc(t('common.import')) + '</button>';
    global.Ui.openModal({
      title: t('users.importCsv'),
      body: body,
      footer: foot,
      wide: true,
      onMount: function (el, close) {
        var submit = el.querySelector('[data-submit]');
        fileInput.addEventListener('change', function () { submit.disabled = false; });
        el.querySelector('[data-cancel]').addEventListener('click', close);
        submit.addEventListener('click', async function () {
          submit.disabled = true;
          var ok = 0;
          var failures = [];
          for (var i = 0; i < parsed.length; i++) {
            try {
              await global.Api.createPerson({
                name: String(parsed[i][0] || '').trim(),
                displayname: String(parsed[i][1] || parsed[i][0] || '').trim(),
                mail: String(parsed[i][2] || '').trim()
              });
              ok++;
            } catch (err) {
              failures.push(String(parsed[i][0]) + ': ' + (err && err.message ? err.message : 'error'));
            }
          }
          close();
          global.Ui.toast('Imported ' + ok + ' of ' + parsed.length + ' users.' +
            (failures.length ? ' ' + failures.length + ' failed.' : ''), failures.length ? 'warning' : 'success', 8000);
          if (failures.length) {
            global.Ui.openModal({ title: 'Import failures', body: '<pre class="log-box">' + esc(failures.join('\n')) + '</pre>' });
          }
          Pages.users(root);
        });
      }
    });
  }

  // ======================================================================
  // User detail
  // ======================================================================
  Pages.userDetail = async function (root, name) {
    root.setAttribute('data-page', 'user');
    root.innerHTML = '<p><a class="link" href="#/users">← ' + esc(t('common.back')) + '</a></p>' + global.Ui.spinner();
    try {
      var results = await Promise.all([global.Api.getPerson(name), global.Api.listGroups()]);
      var person = results[0];
      var groups = results[1] || [];
      renderUserDetail(root, person, groups);
    } catch (err) {
      loadError(root, err, 'people');
    }
  };

  function renderUserDetail(root, person, groups) {
    var name = global.Api.attr(person, 'name') || '';
    var displayname = global.Api.attr(person, 'displayname') || '';
    var uuid = global.Api.attr(person, 'uuid') || '';
    var mail = global.Api.attr(person, 'mail') || '';
    var memberof = global.Api.attrs(person, 'memberof');
    var passkeys = global.Api.attrs(person, 'passkeys');
    var statusKey = global.Api.accountStatus(person);
    var passkeyOnly = String(global.Api.attr(person, 'credential_type_minimum') || '').toLowerCase() === 'passkey';

    var canManage = global.Store.canManagePeople();
    var canGroups = global.Store.canEditGroupMembers();
    var canPii = global.Store.canReadPii();
    var canReset = global.Store.canResetAnyPassword();
    var canImpersonate = global.Store.canImpersonate();

    var groupNames = groups.map(function (g) { return global.Api.attr(g, 'name') || ''; })
      .filter(function (n) { return !!n; }).sort();

    var chips = memberof.map(function (m) {
      var label = global.Store.stripDomain(m);
      return global.Ui.chip('<a class="link" href="#/groups/' + encodeURIComponent(label) + '">' + esc(label) + '</a>', {
        value: label,
        removable: canGroups
      });
    }).join(' ');
    if (!memberof.length) chips = '<span class="muted">' + esc(t('common.none')) + '</span>';

    var memberships = memberof.map(function (m) { return global.Store.stripDomain(m); });
    var addableGroups = groupNames.filter(function (g) { return memberships.indexOf(g) < 0; });
    var addGroupRow = canGroups && addableGroups.length
      ? '<div class="inline-form"><select class="input" data-add-group-select aria-label="' + esc(t('user.detail.addGroup')) + '">' +
        addableGroups.map(function (g) { return '<option value="' + esc(g) + '">' + esc(g) + '</option>'; }).join('') +
        '</select><button class="btn btn-sm" data-add-group>' + esc(t('common.create')) + '</button></div>'
      : '';

    var title = '<div class="page-head"><h1 class="page-title">' + esc(t('user.detail.title', { name: name })) + '</h1>' +
      global.Ui.statusBadge(statusKey) + '</div>';

    var infoCard = card(null, html`
      <div class="kv"><span class="kv-k">${esc(t('user.detail.uuid'))}</span><span class="kv-v mono">${esc(uuid)}</span></div>
      <div class="kv"><span class="kv-k">${esc(t('users.field.displayName'))}</span><span class="kv-v">${esc(displayname)}</span></div>
      <div class="kv"><span class="kv-k">${esc(t('users.field.mail'))}</span><span class="kv-v">${canPii ? esc(mail || '—') : esc(t('users.mail.restricted'))}</span></div>
      <div class="kv"><span class="kv-k">${esc(t('users.col.validFrom'))}</span><span class="kv-v">${esc(global.Ui.formatDate(global.Api.attr(person, 'account_valid_from')))}</span></div>
      <div class="kv"><span class="kv-k">${esc(t('users.col.expires'))}</span><span class="kv-v">${esc(global.Ui.formatDate(global.Api.attr(person, 'account_expire')))}</span></div>
      <div class="btn-row">
        ${canManage ? '<button class="btn" data-edit-user>' + esc(t('common.edit')) + '</button>' : ''}
        ${canManage ? '<button class="btn btn-danger" data-delete-user>' + esc(t('common.delete')) + '</button>' : ''}
      </div>`);

    var groupsCard = card(t('user.detail.groups'),
      '<div class="chip-row" data-group-chips>' + chips + '</div>' + addGroupRow);

    var passkeyCountText = passkeys.length ? String(passkeys.length) : '0';
    var securityCard = card(null, html`
      <div class="kv"><span class="kv-k">${esc(t('user.detail.passkeyCount'))}</span><span class="kv-v">${esc(passkeyCountText)}</span></div>
      <div class="btn-row">
        ${canManage ? '<button class="btn" data-register-passkey>' + esc(t('user.detail.registerPasskey')) + '</button>' : ''}
        ${canReset ? '<button class="btn" data-reset-password>' + esc(t('user.detail.resetPassword')) + '</button>' : ''}
        ${canImpersonate ? '<button class="btn" data-impersonate>' + esc(t('user.detail.impersonate')) + '</button>' : ''}
      </div>
      ${canManage ? '<label class="check"><input type="checkbox" data-passkey-only ' + (passkeyOnly ? 'checked' : '') + '/> ' +
        esc(t('user.detail.passkeyOnly')) + '</label>' : ''}`);

    root.innerHTML = '<p><a class="link" href="#/users">← ' + esc(t('common.back')) + '</a></p>' +
      title + '<div class="grid-2">' + infoCard + securityCard + '</div>' + groupsCard;

    // Wire
    var editBtn = root.querySelector('[data-edit-user]');
    if (editBtn) editBtn.addEventListener('click', function () { userFormModal(root, person); });
    var delBtn = root.querySelector('[data-delete-user]');
    if (delBtn) delBtn.addEventListener('click', function () {
      global.Ui.confirmDialog(t('users.delete.confirm', { name: name }), async function () {
        try {
          await global.Api.deletePerson(name);
          global.location.hash = '#/users';
        } catch (err) {
          global.Ui.handleError(err, 'people');
        }
      }, { danger: true, confirmLabel: t('common.delete') });
    });

    var chipX = root.querySelectorAll('[data-group-chips] [data-remove]');
    for (var i = 0; i < chipX.length; i++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          var group = btn.parentNode.getAttribute('data-value');
          global.Ui.confirmDialog(t('group.detail.removeMember.confirm', { member: name, group: group }), async function () {
            try {
              await global.Api.removePersonFromGroup(name, group);
              Pages.userDetail(root, name);
            } catch (err) {
              global.Ui.handleError(err, 'groups');
            }
          }, { danger: true, confirmLabel: t('common.revoke') });
        });
      })(chipX[i]);
    }
    var addBtn = root.querySelector('[data-add-group]');
    if (addBtn) {
      addBtn.addEventListener('click', async function () {
        var sel = root.querySelector('[data-add-group-select]');
        var group = sel ? sel.value : '';
        if (!group) return;
        try {
          await global.Api.addPersonToGroup(name, group);
          Pages.userDetail(root, name);
        } catch (err) {
          global.Ui.handleError(err, 'groups');
        }
      });
    }

    // Issues a one-time credential-reset intent and shows the link to share
    // with the user. The link opens Kanidm's own credential manager, where
    // the user resets their password and/or enrols passkeys. This is how
    // admins bootstrap another person's credentials — Kanidm has no API for
    // an admin to register a passkey onto another user's account directly
    // (by design, the private key never leaves the user's device).
    function issueResetLink(modalTitle) {
      return async function () {
        try {
          var res = await global.Api.resetPassword(name);
          var token = res && (res.token || res.intent_id || res.intentToken || '');
          var link = token
            ? global.ShenaConfig.oauthBase() + '/ui/reset?token=' + encodeURIComponent(String(token))
            : '';
          var body = link
            ? '<p>Share this one-time credential-reset link with the user:</p>' +
              '<p><code class="break-all">' + esc(link) + '</code></p>' +
              '<button class="btn" data-copy-link>' + esc(t('common.copy')) + '</button>' +
              (qrSvg(link) ? '<p class="muted">' + esc(t('resetlink.scan')) + '</p><div class="qr-box">' + qrSvg(link) + '</div>' : '')
            : '<p>Credential-reset intent created. Server response:</p><pre class="log-box">' + esc(JSON.stringify(res, null, 2)) + '</pre>';
          var m = global.Ui.openModal({ title: modalTitle, body: body, wide: true });
          var copyBtn = m.el.querySelector('[data-copy-link]');
          if (copyBtn) copyBtn.addEventListener('click', function () { global.Ui.copyText(link); });
        } catch (err) {
          if (err && (err.status === 404 || err.status === 501 || err.status === 405)) {
            global.Ui.openModal({
              title: modalTitle,
              body: '<p>This Kanidm version does not expose credential intents over the REST API. Use the CLI instead:</p>' +
                '<pre class="log-box">kanidm person credential reset ' + esc(name) + '</pre>'
            });
          } else {
            global.Ui.handleError(err, 'people');
          }
        }
      };
    }

    var regBtn = root.querySelector('[data-register-passkey]');
    if (regBtn) regBtn.addEventListener('click', issueResetLink(t('user.detail.registerPasskey')));

    var resetBtn = root.querySelector('[data-reset-password]');
    if (resetBtn) resetBtn.addEventListener('click', issueResetLink(t('user.detail.resetPassword')));

    var impBtn = root.querySelector('[data-impersonate]');
    if (impBtn) impBtn.addEventListener('click', function () {
      global.Ui.openModal({
        title: t('user.detail.impersonate'),
        body: '<p>Support access to this account is performed on the server, which audits every action. In Kanidm, support staff either issue a credential-reset intent (password reset flow) or use the CLI:</p>' +
          '<pre class="log-box">kanidm person credential reset ' + esc(name) + '</pre>'
      });
    });

    var pkOnly = root.querySelector('[data-passkey-only]');
    if (pkOnly) pkOnly.addEventListener('change', async function () {
      var enable = pkOnly.checked;
      pkOnly.disabled = true;
      function done() {
        pkOnly.disabled = false;
        Pages.userDetail(root, name);
      }
      try {
        if (enable && passkeys.length === 0) {
          // Avoid lockout: the user must enrol a passkey first — only they
          // can do it (the private key never leaves their device). Issue a
          // credential-reset link so they can enrol, then toggle this on.
          global.Ui.openModal({
            title: t('user.detail.passkeyOnly'),
            body: '<p>' + esc(t('user.detail.passkeyOnly.warn')) + '</p>'
          });
          done();
          return;
        }
        await global.Api.setUserPasskeyOnly(name, enable);
        global.Ui.toast(enable ? 'Passkey-only enabled.' : 'Passkey-only disabled.', 'success');
        done();
      } catch (err) {
        if (err && (err.status === 400 || err.status === 404 || err.status === 501)) {
          global.Ui.openModal({
            title: t('user.detail.passkeyOnly'),
            body: '<p>This Kanidm version manages the minimum credential type via group account policy. Use:</p>' +
              '<pre class="log-box">kanidm group search passkey_required</pre>' +
              '<p class="muted">Server message: ' + esc(err.message || '') + '</p>'
          });
        } else {
          global.Ui.handleError(err, 'people');
        }
        done();
      }
    });
  }

  // ======================================================================
  // Groups
  // ======================================================================
  var groupsState = { q: '', nestedOnly: false, page: 1, groups: [], people: [] };

  Pages.groups = async function (root) {
    groupsState.page = 1;
    root.innerHTML = '<h1 class="page-title">' + esc(t('groups.title')) + '</h1>' + global.Ui.spinner();
    try {
      groupsState.groups = await global.Api.listGroups() || [];
      renderGroups(root);
    } catch (err) {
      loadError(root, err, 'groups');
    }
  };

  function isNestedGroup(group, allMembers) {
    var members = global.Api.attrs(group, 'member');
    for (var i = 0; i < members.length; i++) {
      if (allMembers.groupSet[global.Store.stripDomain(members[i])]) return true;
    }
    return false;
  }

  function renderGroups(root) {
    var canManage = global.Store.canManageGroups();
    var groupSet = {};
    for (var i = 0; i < groupsState.groups.length; i++) {
      var n = global.Api.attr(groupsState.groups[i], 'name') || '';
      if (n) groupSet[n] = groupsState.groups[i];
    }
    var q = groupsState.q.toLowerCase();
    var filtered = [];
    for (i = 0; i < groupsState.groups.length; i++) {
      var g = groupsState.groups[i];
      var name = String(global.Api.attr(g, 'name') || '');
      var dn = String(global.Api.attr(g, 'displayname') || '');
      if (q && name.toLowerCase().indexOf(q) < 0 && dn.toLowerCase().indexOf(q) < 0) continue;
      if (groupsState.nestedOnly && !isNestedGroup(g, { groupSet: groupSet })) continue;
      filtered.push(g);
    }
    filtered.sort(function (a, b) {
      return String(global.Api.attr(a, 'name') || '').localeCompare(String(global.Api.attr(b, 'name') || ''));
    });

    var info = global.Ui.paginate(filtered, groupsState.page, PAGE_SIZE);
    groupsState.page = info.page;

    var toolbar = '<div class="toolbar">' +
      '<input class="input toolbar-search" type="search" data-groups-search placeholder="' + esc(t('groups.searchPlaceholder')) + '"' +
      ' value="' + esc(groupsState.q) + '" aria-label="' + esc(t('groups.searchPlaceholder')) + '"/>' +
      '<label class="check"><input type="checkbox" data-groups-nested ' + (groupsState.nestedOnly ? 'checked' : '') + '/> ' +
      esc(t('groups.filterNested')) + '</label>' +
      '<span class="toolbar-spacer"></span>' +
      (canManage ? '<button class="btn btn-primary" data-groups-new>' + esc(t('groups.new')) + '</button>' : '') +
      '</div>';

    var table = global.Ui.tableHtml([
      {
        key: 'name', label: t('groups.col.name'), render: function (g) {
          var name = global.Api.attr(g, 'name') || '';
          return '<a class="link" href="#/groups/' + encodeURIComponent(name) + '">' + esc(name) + '</a>';
        }
      },
      { key: 'displayname', label: t('groups.col.displayName'), render: function (g) { return esc(global.Api.attr(g, 'displayname') || ''); } },
      {
        key: 'capabilities', label: t('groups.col.capabilities'), render: function (g) {
          var cap = groupCapability(g);
          return cap ? esc(cap) : '<span class="muted">—</span>';
        }
      },
      { key: 'members', label: t('groups.col.members'), render: function (g) { return esc(String(global.Api.attrs(g, 'member').length)); } },
      {
        key: 'managed_by', label: t('groups.col.managedBy'), render: function (g) {
          return esc(global.Store.stripDomain(global.Api.attr(g, 'entry_managed_by') || '') || '—');
        }
      },
      {
        key: 'actions', label: t('common.actions'), className: 'col-actions', render: function (g) {
          var name = global.Api.attr(g, 'name') || '';
          var btns = '<a class="btn btn-sm" href="#/groups/' + encodeURIComponent(name) + '">' + esc(t('common.edit')) + '</a>';
          if (canManage) {
            btns += ' <button class="btn btn-sm btn-danger" data-group-delete="' + esc(name) + '">' + esc(t('common.delete')) + '</button>';
          }
          return btns;
        }
      }
    ], info.items, info, t('table.empty'));

    root.innerHTML = '<h1 class="page-title">' + esc(t('groups.title')) + '</h1>' + toolbar + table;

    var search = root.querySelector('[data-groups-search]');
    if (search) search.addEventListener('input', global.Ui.debounce(function () {
      groupsState.q = search.value;
      groupsState.page = 1;
      renderGroups(root);
    }, 200));
    var nested = root.querySelector('[data-groups-nested]');
    if (nested) nested.addEventListener('change', function () {
      groupsState.nestedOnly = nested.checked;
      groupsState.page = 1;
      renderGroups(root);
    });
    global.Ui.bindPagination(root, info, function (p) {
      groupsState.page = p;
      renderGroups(root);
    });
    var newBtn = root.querySelector('[data-groups-new]');
    if (newBtn) newBtn.addEventListener('click', function () { groupFormModal(root, null); });
    var delBtns = root.querySelectorAll('[data-group-delete]');
    for (var d = 0; d < delBtns.length; d++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          var name = btn.getAttribute('data-group-delete');
          global.Ui.confirmDialog(t('groups.delete.confirm', { name: name }), async function () {
            try {
              await global.Api.deleteGroup(name);
              Pages.groups(root);
            } catch (err) {
              global.Ui.handleError(err, 'groups');
            }
          }, { danger: true, confirmLabel: t('common.delete') });
        });
      })(delBtns[d]);
    }
  }

  function groupFormModal(root, group) {
    var isEdit = !!group;
    var name = isEdit ? global.Api.attr(group, 'name') || '' : '';
    var canManagedBy = global.Store.canSetManagedBy();
    var body = html`
      <form data-group-form novalidate>
        ${global.Ui.fieldHtml({ name: 'name', label: t('groups.col.name'), value: name, required: true, readonly: isEdit })}
        ${global.Ui.fieldHtml({ name: 'displayname', label: t('groups.col.displayName'), value: isEdit ? global.Api.attr(group, 'displayname') || '' : '', required: true })}
        ${global.Ui.fieldHtml({ name: 'description', label: t('groups.field.description'), value: isEdit ? global.Api.attr(group, 'description') || '' : '', help: t('groups.field.description.help') })}
        ${canManagedBy || !isEdit ? global.Ui.fieldHtml({ name: 'entryManagedBy', label: t('groups.col.managedBy'), value: isEdit ? global.Store.stripDomain(global.Api.attr(group, 'entry_managed_by') || '') : '', help: canManagedBy ? '' : 'Only access-control admins can change this.' }) : ''}
      </form>`;
    var foot = '<button class="btn" data-cancel>' + esc(t('common.cancel')) + '</button>' +
      '<button class="btn btn-primary" data-submit>' + esc(t('common.save')) + '</button>';
    global.Ui.openModal({
      title: isEdit ? t('groups.edit.title') : t('groups.create.title'),
      body: body,
      footer: foot,
      onMount: function (el, close) {
        el.querySelector('[data-cancel]').addEventListener('click', close);
        el.querySelector('[data-submit]').addEventListener('click', async function () {
          var form = el.querySelector('[data-group-form]');
          var managedByInput = form.querySelector('[name=entryManagedBy]');
          var data = {
            name: form.querySelector('[name=name]').value.trim(),
            displayname: form.querySelector('[name=displayname]').value.trim(),
            description: form.querySelector('[name=description]').value.trim(),
            entryManagedBy: managedByInput ? managedByInput.value.trim() : ''
          };
          var result = global.Validation.groupForm(data, { skipUsername: isEdit });
          if (!result.ok) {
            global.Ui.showFieldErrors(el, result.errors);
            return;
          }
          try {
            if (isEdit) {
              var payload = { displayname: data.displayname };
              if (data.description) payload.description = data.description;
              if (canManagedBy && data.entryManagedBy) payload.entryManagedBy = data.entryManagedBy;
              await global.Api.updateGroup(name, payload);
            } else {
              await global.Api.createGroup(data);
            }
            close();
            global.Ui.toast('Saved.', 'success');
            if (root.getAttribute('data-page') === 'group') Pages.groupDetail(root, name);
            else Pages.groups(root);
          } catch (err) {
            global.Ui.handleError(err, 'groups');
          }
        });
      }
    });
  }

  // ======================================================================
  // Group detail
  // ======================================================================
  Pages.groupDetail = async function (root, name) {
    root.setAttribute('data-page', 'group');
    root.innerHTML = '<p><a class="link" href="#/groups">← ' + esc(t('common.back')) + '</a></p>' + global.Ui.spinner();
    try {
      var results = await Promise.all([
        global.Api.getGroup(name),
        global.Api.listPeople().catch(function () { return []; }),
        global.Api.listGroups()
      ]);
      renderGroupDetail(root, results[0], results[1] || [], results[2] || []);
    } catch (err) {
      loadError(root, err, 'groups');
    }
  };

  function renderGroupDetail(root, group, people, allGroups) {
    var name = global.Api.attr(group, 'name') || '';
    var displayname = global.Api.attr(group, 'displayname') || '';
    var members = global.Api.attrs(group, 'member');
    var managedBy = global.Store.stripDomain(global.Api.attr(group, 'entry_managed_by') || '');
    var canManage = global.Store.canManageGroups();
    // Group SELF (edit/delete) needs idm_group_admins; MEMBERSHIP changes
    // additionally allow idm_admins (entry-manager of the idm_* groups).
    var canEditMembers = global.Store.canEditGroupMembers();

    var groupSet = {};
    for (var i = 0; i < allGroups.length; i++) {
      var gn = global.Api.attr(allGroups[i], 'name') || '';
      if (gn) groupSet[gn] = true;
    }
    var peopleNames = {};
    for (i = 0; i < people.length; i++) {
      var pn = global.Api.attr(people[i], 'name') || '';
      if (pn) peopleNames[pn] = true;
    }

    var memberRows = [];
    var nested = [];
    for (i = 0; i < members.length; i++) {
      var short = global.Store.stripDomain(members[i]);
      if (groupSet[short]) nested.push(short);
      else memberRows.push(short);
    }
    memberRows.sort();
    nested.sort();

    var membersInfo = global.Ui.paginate(memberRows, 1, 50);
    var membersTable = global.Ui.tableHtml([
      {
        key: 'member', label: t('group.detail.members'), render: function (m) {
          if (peopleNames[m]) return '<a class="link" href="#/users/' + encodeURIComponent(m) + '">' + esc(m) + '</a>';
          return esc(m);
        }
      },
      {
        key: 'actions', label: t('common.actions'), className: 'col-actions', render: function (m) {
          return canEditMembers
            ? '<button class="btn btn-sm btn-danger" data-member-remove="' + esc(m) + '">' + esc(t('common.revoke')) + '</button>'
            : '';
        }
      }
    ], membersInfo.items, membersInfo, t('table.empty'));

    // addable: people not already members + groups not already members/self
    var memberSet = {};
    for (i = 0; i < memberRows.length; i++) memberSet[memberRows[i]] = true;
    for (i = 0; i < nested.length; i++) memberSet[nested[i]] = true;
    var addablePeople = Object.keys(peopleNames).filter(function (n) { return !memberSet[n]; }).sort();
    var addableGroups = Object.keys(groupSet).filter(function (n) { return !memberSet[n] && n !== name; }).sort();

    var addOptions = '<optgroup label="Users">' +
      addablePeople.map(function (n) { return '<option value="' + esc(n) + '">' + esc(n) + '</option>'; }).join('') +
      '</optgroup><optgroup label="Groups">' +
      addableGroups.map(function (n) { return '<option value="' + esc(n) + '">' + esc(n) + '</option>'; }).join('') + '</optgroup>';

    var nestedChips = nested.length
      ? nested.map(function (n) {
          return global.Ui.chip('<a class="link" href="#/groups/' + encodeURIComponent(n) + '">' + esc(n) + '</a>', { value: n });
        }).join(' ')
      : '<span class="muted">' + esc(t('common.none')) + '</span>';

    var title = '<div class="page-head"><h1 class="page-title">' + esc(t('group.detail.title', { name: name })) + '</h1></div>';

    var capability = groupCapability(group);

    var infoCard = card(null, html`
      <div class="kv"><span class="kv-k">${esc(t('group.detail.displayName'))}</span><span class="kv-v">${esc(displayname)}</span></div>
      <div class="kv"><span class="kv-k">${esc(t('group.detail.description'))}</span><span class="kv-v">${esc(global.Api.attr(group, 'description') || '—')}</span></div>
      ${capability ? '<div class="kv"><span class="kv-k">' + esc(t('group.detail.capabilities')) + '</span><span class="kv-v">' + esc(capability) + '</span></div>' : ''}
      <div class="kv"><span class="kv-k">${esc(t('group.detail.managedBy'))}</span><span class="kv-v">${esc(managedBy || '—')}</span></div>
      <div class="kv"><span class="kv-k">${esc(t('group.detail.effectiveCount'))}</span><span class="kv-v">${members.length} direct ${nested.length ? '(+' + nested.length + ' nested group(s), expanded by the server)' : ''}</span></div>
      <div class="btn-row">
        ${canManage ? '<button class="btn" data-edit-group>' + esc(t('common.edit')) + '</button>' : ''}
        ${canManage ? '<button class="btn btn-danger" data-delete-group>' + esc(t('common.delete')) + '</button>' : ''}
      </div>`);

    var membersCard = card(t('group.detail.members'),
      membersTable +
      (canEditMembers && (addablePeople.length || addableGroups.length)
        ? '<div class="inline-form"><select class="input" data-add-member-select aria-label="' + esc(t('group.detail.addMember')) + '">' + addOptions + '</select>' +
          '<button class="btn btn-sm" data-add-member>' + esc(t('common.create')) + '</button></div>'
        : ''));

    root.innerHTML = '<p><a class="link" href="#/groups">← ' + esc(t('common.back')) + '</a></p>' +
      title + '<div class="grid-2">' + infoCard + card(t('group.detail.nested'), '<div class="chip-row">' + nestedChips + '</div>') + '</div>' +
      membersCard;

    var editBtn = root.querySelector('[data-edit-group]');
    if (editBtn) editBtn.addEventListener('click', function () { groupFormModal(root, group); });
    var delBtn = root.querySelector('[data-delete-group]');
    if (delBtn) delBtn.addEventListener('click', function () {
      global.Ui.confirmDialog(t('groups.delete.confirm', { name: name }), async function () {
        try {
          await global.Api.deleteGroup(name);
          global.location.hash = '#/groups';
        } catch (err) {
          global.Ui.handleError(err, 'groups');
        }
      }, { danger: true, confirmLabel: t('common.delete') });
    });

    var removeBtns = root.querySelectorAll('[data-member-remove]');
    for (i = 0; i < removeBtns.length; i++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          var member = btn.getAttribute('data-member-remove');
          global.Ui.confirmDialog(t('group.detail.removeMember.confirm', { member: member, group: name }), async function () {
            try {
              await global.Api.removeGroupMember(name, member);
              Pages.groupDetail(root, name);
            } catch (err) {
              global.Ui.handleError(err, 'groups');
            }
          }, { danger: true, confirmLabel: t('common.revoke') });
        });
      })(removeBtns[i]);
    }
    var addBtn = root.querySelector('[data-add-member]');
    if (addBtn) addBtn.addEventListener('click', async function () {
      var sel = root.querySelector('[data-add-member-select]');
      var member = sel ? sel.value : '';
      if (!member) return;
      try {
        await global.Api.addGroupMember(name, member);
        Pages.groupDetail(root, name);
      } catch (err) {
        global.Ui.handleError(err, 'groups');
      }
    });
  }

  // Renders a QR code SVG for a link (dependency-free qrcode.js). Used for
  // credential-reset links so an admin can hand them to a user's phone.
  function qrSvg(link) {
    try {
      return global.QRCode.toSVG(link, { ecl: 'M', moduleSize: 5, margin: 4 });
    } catch (e) {
      return '';
    }
  }

  // ======================================================================
  // Recycle bin (GET /v1/recycle_bin, POST /v1/recycle_bin/{uuid}/_revive
  // — the only recycle endpoints Kanidm 1.10 has; see v1.rs routes. There
  // is no purge endpoint: the server purges recycled entries on schedule.)
  // ======================================================================
  Pages.recycle = async function (root) {
    root.innerHTML = '<h1 class="page-title">' + esc(t('recycle.title')) + '</h1>' + global.Ui.spinner();
    var canRevive = global.Store.canRecycleBin();
    try {
      var items = (await global.Api.listRecycled()) || [];
      var rows = [];
      for (var i = 0; i < items.length; i++) {
        var en = items[i];
        var classes = global.Api.attrs(en, 'class');
        var type = 'entry';
        if (classes.indexOf('person') >= 0) type = 'person';
        else if (classes.indexOf('group') >= 0) type = 'group';
        else if (classes.indexOf('service_account') >= 0) type = 'service account';
        rows.push({
          name: global.Api.attr(en, 'name') || '',
          uuid: global.Api.attr(en, 'uuid') || '',
          type: type
        });
      }
      var info = { page: 1, pages: 1, total: rows.length };
      var table = global.Ui.tableHtml([
        { key: 'name', label: 'Name', render: function (r) { return esc(r.name || r.uuid || ''); } },
        { key: 'type', label: 'Type', render: function (r) { return global.Ui.badge(r.type, 'muted'); } },
        { key: 'uuid', label: 'UUID', render: function (r) { return '<code>' + esc(r.uuid) + '</code>'; } },
        {
          key: 'actions', label: t('common.actions'), className: 'col-actions', render: function (r) {
            return canRevive
              ? '<button class="btn btn-sm" data-recycle-revive="' + esc(r.uuid) + '" data-name="' + esc(r.name || r.uuid) + '">' + esc(t('common.restore')) + '</button>'
              : '';
          }
        }
      ], rows, info, t('table.empty'));
      root.innerHTML = '<h1 class="page-title">' + esc(t('recycle.title')) + '</h1>' +
        '<p class="muted">' + esc(t('recycle.rights')) + '</p>' +
        '<p class="muted" data-recycle-retention>' + esc(t('recycle.retention')) + '</p>' + table;
      var reviveBtns = root.querySelectorAll('[data-recycle-revive]');
      for (i = 0; i < reviveBtns.length; i++) {
        (function (btn) {
          btn.addEventListener('click', function () {
            var uuid = btn.getAttribute('data-recycle-revive');
            var label = btn.getAttribute('data-name');
            global.Ui.confirmDialog(t('recycle.restore.confirm', { name: label }), async function () {
              try {
                await global.Api.reviveRecycled(uuid);
                global.Ui.toast('Restored.', 'success');
                Pages.recycle(root);
              } catch (err) {
                global.Ui.handleError(err, 'recycle');
              }
            }, { confirmLabel: t('common.restore') });
          });
        })(reviveBtns[i]);
      }
    } catch (err) {
      loadError(root, err, 'recycle');
    }
  };

  // ======================================================================
  // Sessions — Kanidm 1.10 exposes only the CURRENT session's
  // UserAuthToken (GET /v1/self/_uat). There is no REST endpoint to list
  // or revoke other sessions, so this page shows real current-session
  // details instead of an empty table.
  // ======================================================================
  Pages.sessions = async function (root) {
    var user = global.Store.user || {};
    root.innerHTML = '<h1 class="page-title">' + esc(t('sessions.title')) + '</h1>' + global.Ui.spinner();
    try {
      var uat = (await global.Api.getSelfUat()) || {};
      var purpose = typeof uat.purpose === 'string'
        ? uat.purpose
        : (uat.purpose ? JSON.stringify(uat.purpose) : '—');
      var wexp = global.Store.parseUatPurpose(uat.purpose);
      global.Store.setWriteExpiry(wexp);
      var canW = global.Store.canWriteNow();
      var wrow = canW
        ? '<div class="kv"><span class="kv-k">' + esc(t('sessions.field.writes')) + '</span><span class="kv-v">' +
          global.Ui.badge(t('sessions.writes.enabled'), 'ok') + ' ' +
          '<span class="muted">' + esc(global.Ui.formatDateTime(wexp * 1000)) + '</span></span></div>'
        : '<div class="kv"><span class="kv-k">' + esc(t('sessions.field.writes')) + '</span><span class="kv-v">' +
          global.Ui.badge(t('sessions.writes.readonly'), 'warn') + '</span></div>';
      var body = html`
        <div class="kv"><span class="kv-k">${esc(t('profile.authMethod'))}</span><span class="kv-v">${global.Ui.badge(user.authMethod || '—', 'info')}</span></div>
        <div class="kv"><span class="kv-k">${esc(t('users.field.username'))}</span><span class="kv-v">${esc(uat.spn || user.name || '')}</span></div>
        <div class="kv"><span class="kv-k">${esc(t('sessions.field.sessionId'))}</span><span class="kv-v"><code>${esc(String(uat.session_id || '—'))}</code></span></div>
        <div class="kv"><span class="kv-k">${esc(t('sessions.field.issued'))}</span><span class="kv-v">${esc(global.Ui.formatDateTime(uat.issued_at))}</span></div>
        <div class="kv"><span class="kv-k">${esc(t('sessions.field.expiry'))}</span><span class="kv-v">${esc(global.Ui.formatDateTime(uat.expiry))}</span></div>
        <div class="kv"><span class="kv-k">${esc(t('sessions.field.purpose'))}</span><span class="kv-v">${global.Ui.badge(purpose, 'muted')}</span></div>` +
        wrow +
        (canW ? '' : '<p class="muted">' + esc(t('sessions.stepup.note')) + '</p>' +
          '<p><button class="btn btn-primary" data-stepup>' + esc(t('session.ro.unlock')) + '</button></p>') +
        '<p class="muted">' + esc(t('sessions.uat.note')) + '</p>';
      root.innerHTML = '<h1 class="page-title">' + esc(t('sessions.title')) + '</h1>' +
        card(t('sessions.current'), body);
      var su = root.querySelector('[data-stepup]');
      if (su) {
        su.addEventListener('click', async function () {
          su.disabled = true;
          try {
            await global.Auth.stepUp();
            global.Ui.toast(t('session.stepup.ok'), 'success');
            Pages.sessions(root);
          } catch (err) {
            su.disabled = false;
            global.Ui.toast((err && err.message) || t('session.stepup.fail'), 'error');
          }
        });
      }
    } catch (err) {
      loadError(root, err, 'sessions');
    }
  };

  // ======================================================================
  // Profile (self-service)
  // ======================================================================
  Pages.profile = async function (root) {
    root.innerHTML = '<h1 class="page-title">' + esc(t('profile.title')) + '</h1>' + global.Ui.spinner();
    try {
      var self = null;
      try {
        // /v1/self answers WhoamiResponse { youare: Entry } — unwrap.
        self = global.Api.selfEntry(await global.Api.getSelf());
      } catch (e) {
        self = null; // fall back to token claims already in Store
      }
      var user = global.Store.user || {};
      var name = self ? (global.Api.attr(self, 'name') || user.name || '') : (user.name || '');
      var displayname = self ? (global.Api.attr(self, 'displayname') || user.display_name || '') : (user.display_name || '');
      var mail = self ? (global.Api.attr(self, 'mail') || '') : (user.mail || '');
      var memberof = self ? global.Api.attrs(self, 'memberof') : [];
      var canMail = global.Store.canSelfEditMail();

      var groupsChips = memberof.length
        ? memberof.map(function (m) { return '<span class="chip">' + esc(global.Store.stripDomain(m)) + '</span>'; }).join(' ')
        : '<span class="muted">' + (self ? esc(t('common.none')) : '…') + '</span>';

      var infoCard = card(null, html`
        <div class="kv"><span class="kv-k">${esc(t('profile.authMethod'))}</span><span class="kv-v">${global.Ui.badge(user.authMethod || '—', 'info')}</span></div>
        <div class="kv"><span class="kv-k">${esc(t('users.field.username'))}</span><span class="kv-v">${esc(name)}</span></div>
        <div class="kv"><span class="kv-k">${esc(t('users.field.displayName'))}</span><span class="kv-v">${esc(displayname)}</span></div>
        <div class="kv"><span class="kv-k">${esc(t('profile.field.mail'))}</span><span class="kv-v" data-profile-mail>${esc(mail || '—')}</span></div>
        <div class="btn-row">
          ${canMail ? '<button class="btn" data-edit-mail>' + esc(t('common.edit')) + ' ' + esc(t('profile.field.mail')) + '</button>'
            : '<p class="muted">' + esc(t('profile.mail.gated')) + '</p>'}
        </div>`);

      var securityCard = card(null, '<div class="btn-row">' +
        '<button class="btn" data-register-own-passkey>' + esc(t('profile.registerPasskey')) + '</button>' +
        '<button class="btn" data-change-password>' + esc(t('profile.changePassword')) + '</button>' +
        '</div>');

      var groupsCard = card(t('profile.myGroups'), '<div class="chip-row">' + groupsChips + '</div>');

      root.innerHTML = '<h1 class="page-title">' + esc(t('profile.title')) + '</h1>' +
        '<div class="grid-2">' + infoCard + securityCard + '</div>' + groupsCard;

      var mailBtn = root.querySelector('[data-edit-mail]');
      if (mailBtn) mailBtn.addEventListener('click', function () {
        var body = '<form novalidate>' + global.Ui.fieldHtml({ name: 'mail', label: t('profile.field.mail'), type: 'email', value: mail }) + '</form>';
        var foot = '<button class="btn" data-cancel>' + esc(t('common.cancel')) + '</button>' +
          '<button class="btn btn-primary" data-submit>' + esc(t('common.save')) + '</button>';
        global.Ui.openModal({
          title: t('profile.field.mail'),
          body: body,
          footer: foot,
          onMount: function (el, close) {
            el.querySelector('[data-cancel]').addEventListener('click', close);
            el.querySelector('[data-submit]').addEventListener('click', async function () {
              var value = el.querySelector('[name=mail]').value.trim();
              var r = global.Validation.email(value, false);
              if (!r.ok) {
                global.Ui.showFieldErrors(el, { mail: r.message });
                return;
              }
              try {
                await global.Api.updatePerson(name, { mail: value });
                close();
                global.Ui.toast('Saved.', 'success');
                Pages.profile(root);
              } catch (err) {
                global.Ui.handleError(err, 'people');
              }
            });
          }
        });
      });

      var pkBtn = root.querySelector('[data-register-own-passkey]');
      if (pkBtn) pkBtn.addEventListener('click', function () {
        // Credential enrolment lives in Kanidm's own audited credential
        // manager (no plain webauthn REST endpoints exist in Kanidm 1.10).
        var url = global.Auth.credentialSelfServiceUrl();
        try {
          if (typeof global.open === 'function') {
            global.open(url, '_blank', 'noopener');
          } else {
            global.location.assign(url);
          }
        } catch (e) {
          global.location.assign(url);
        }
        global.Ui.toast('Complete passkey enrolment in Kanidm\'s credential manager (opened in a new tab).', 'success');
      });

      var pwBtn = root.querySelector('[data-change-password]');
      if (pwBtn) pwBtn.addEventListener('click', function () {
        var resetUrl = global.ShenaConfig.oauthBase() + '/ui/reset';
        global.Ui.openModal({
          title: t('profile.changePassword'),
          body: '<p>Password changes are performed in Kanidm\u2019s own credential-update UI so credentials never pass through Shenasa:</p>' +
            '<p><a class="btn btn-primary" href="' + esc(resetUrl) + '" target="_blank" rel="noopener noreferrer">Open Kanidm credential reset</a></p>'
        });
      });
    } catch (err) {
      loadError(root, err, 'profile');
    }
  };

  // ======================================================================
  // Settings
  // ======================================================================
  Pages.settings = async function (root) {
    var cfg = global.SHENASA_CONFIG;
    var themeOptions = ['light', 'dark', 'auto'].map(function (v) {
      return '<option value="' + v + '"' + (cfg.theme === v ? ' selected' : '') + '>' + esc(t('settings.theme.' + v)) + '</option>';
    }).join('');

    var body = html`
      <form data-settings-form novalidate>
        ${global.Ui.fieldHtml({ name: 'apiUrl', label: t('settings.api'), value: cfg.apiUrl || '', required: true, help: 'Override at runtime with ?apiUrl=' })}
        ${global.Ui.fieldHtml({ name: 'oauthBase', label: t('settings.oauthBase'), value: global.ShenaConfig.oauthBase(), readonly: true, help: 'Derived by stripping /v1 — OAuth/WebAuthn endpoints live at the origin root, never under /v1.' })}
        ${global.Ui.fieldHtml({ name: 'oidcClientId', label: t('settings.clientId'), value: cfg.oidcClientId || '', required: true })}
        ${global.Ui.fieldHtml({ name: 'oidcScope', label: t('settings.scope'), value: cfg.oidcScope || '', required: true })}
        ${global.Ui.fieldHtml({ name: 'oidcRedirectUri', label: t('settings.redirect'), value: cfg.oidcRedirectUri || '', required: true })}
        <div class="field"><label class="label" for="f-theme">${esc(t('settings.theme'))}</label>
          <select class="input" id="f-theme" name="theme">${themeOptions}</select></div>
        ${global.Ui.fieldHtml({ name: 'idleTimeoutMin', type: 'number', label: t('settings.idleTimeout'), value: String(cfg.idleTimeoutMin != null ? cfg.idleTimeoutMin : 0), help: t('settings.idleTimeout.help'),
          input: '<input class="input" type="number" min="0" max="1440" step="1" name="idleTimeoutMin" value="' + esc(String(cfg.idleTimeoutMin != null ? cfg.idleTimeoutMin : 0)) + '" />' })}
        <p class="muted">${esc(t('settings.note'))}</p>
      </form>`;

    root.innerHTML = '<h1 class="page-title">' + esc(t('settings.title')) + '</h1>' +
      card(null, body +
        '<div class="btn-row">' +
        '<button class="btn btn-primary" data-settings-save>' + esc(t('common.save')) + '</button>' +
        '<button class="btn" data-settings-test>' + esc(t('settings.test')) + '</button>' +
        '<button class="btn btn-danger" data-settings-reset>' + esc(t('settings.reset')) + '</button>' +
        '</div><div data-test-result></div>');

    var form = root.querySelector('[data-settings-form]');
    var themeSel = form.querySelector('[name=theme]');
    if (themeSel && global.App && global.App.applyTheme) {
      themeSel.addEventListener('change', function () {
        global.SHENASA_CONFIG.theme = themeSel.value;
        global.App.applyTheme(themeSel.value);
      });
    }

    root.querySelector('[data-settings-save]').addEventListener('click', function () {
      var map = {
        apiUrl: form.querySelector('[name=apiUrl]').value.trim(),
        oidcClientId: form.querySelector('[name=oidcClientId]').value.trim(),
        oidcScope: form.querySelector('[name=oidcScope]').value.trim(),
        oidcRedirectUri: form.querySelector('[name=oidcRedirectUri]').value.trim(),
        theme: form.querySelector('[name=theme]').value,
        idleTimeoutMin: form.querySelector('[name=idleTimeoutMin]').value.trim()
      };
      if (!map.apiUrl) {
        global.Ui.toast('API URL is required.', 'error');
        return;
      }
      var idleNum = parseFloat(map.idleTimeoutMin);
      if (!isFinite(idleNum) || idleNum < 0 || idleNum > 1440) {
        global.Ui.toast(t('settings.idleTimeout.invalid'), 'error');
        return;
      }
      map.idleTimeoutMin = String(Math.round(idleNum));
      global.ShenaConfig.save(map);
      for (var k in map) global.SHENASA_CONFIG[k] = map[k];
      // refresh derived display
      form.querySelector('[name=oauthBase]').value = global.ShenaConfig.oauthBase();
      // (Re)arm the idle watchdog with the new timeout.
      if (global.App && global.App.armIdleWatch) global.App.armIdleWatch();
      global.Ui.toast(t('settings.saved'), 'success');
    });

    root.querySelector('[data-settings-test]').addEventListener('click', async function () {
      var slot = root.querySelector('[data-test-result]');
      slot.innerHTML = global.Ui.spinner();
      try {
        // Per-client OIDC discovery on the origin root — proves the server is
        // reachable AND the OAuth2 client is provisioned.
        var url = global.ShenaConfig.oauthBase() + '/oauth2/openid/' +
          encodeURIComponent(global.ShenaConfig.clientId()) + '/.well-known/openid-configuration';
        var res = await global.fetch(url, {
          headers: { 'Accept': 'application/json' },
          credentials: 'omit'
        });
        if (res.status === 404) {
          throw new Error('HTTP 404 — the OAuth2 client "' + global.ShenaConfig.clientId() +
            '" was not found. Run deploy/bootstrap.sh to create it.');
        }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var discovery = await res.json();
        slot.innerHTML = '<p class="ok-text">' + esc(t('settings.test.ok')) +
          '</p><p class="muted">issuer: <code>' + esc(String(discovery.issuer || '—')) + '</code></p>';
      } catch (err) {
        slot.innerHTML = '<p class="error-text">' + esc(t('settings.test.fail')) + ' ' +
          esc(err && err.message ? err.message : String(err)) + '</p>';
      }
    });

    root.querySelector('[data-settings-reset]').addEventListener('click', function () {
      global.ShenaConfig.reset();
      global.Ui.toast(t('settings.saved'), 'success');
      global.location.reload();
    });
  };

  global.Pages = Pages;
})(typeof window !== 'undefined' ? window : globalThis);
