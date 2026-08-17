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

      // Server domain card — GET /v1/domain. Tolerant: some roles cannot
      // read domain info; the dashboard must still render without it.
      var domainLabel = '';
      try {
        var dom = await global.Api.getDomain();
        domainLabel = global.Api.attr(dom, 'displayname') ||
          global.Api.attr(dom, 'name') || global.Api.attr(dom, 'domain_name') || '';
      } catch (e) { domainLabel = ''; }

      var cards = '<div class="stat-grid">' +
        statCard(t('dash.totalUsers'), stats.totalUsers) +
        statCard(t('dash.totalGroups'), stats.totalGroups) +
        statCard(t('dash.activeUsers'), active) +
        statCard(t('dash.passkeyOnly'), stats.passkeyOnlyUsers) +
        (domainLabel ? statCard(t('dash.domain'), domainLabel) : '') +
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
  var usersState = { q: '', group: '', page: 1, people: [], groups: [], selected: {} };

  Pages.users = async function (root) {
    usersState.page = 1;
    usersState.selected = {};
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
    var canGroup = global.Store.canManageGroups() || global.Store.canEditGroupMembers();
    var canBulk = canManage || canGroup;

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
      (canManage ? '<button class="btn" data-users-onboard>' + esc(t('users.onboard')) + '</button>' : '') +
      (canManage ? '<button class="btn" data-users-import-csv>' + esc(t('users.importCsv')) + '</button>' : '') +
      '<button class="btn" data-users-export-csv>' + esc(t('users.exportCsv')) + '</button>' +
      '<button class="btn" data-users-export-json>' + esc(t('users.exportJson')) + '</button>' +
      '</div>';

    // Bulk-action bar: visible only while at least one row is checked.
    var bulkbar = canBulk ? '<div class="bulkbar" data-bulkbar hidden>' +
      '<span class="bulkbar-count" data-bulk-count></span>' +
      (canGroup ? '<button class="btn btn-sm" data-bulk-add-group>' + esc(t('users.bulk.addGroup')) + '</button>' : '') +
      (canManage ? '<button class="btn btn-sm" data-bulk-expiry>' + esc(t('users.bulk.expiry')) + '</button>' : '') +
      '<button class="btn btn-sm btn-ghost" data-bulk-clear>' + esc(t('users.bulk.clear')) + '</button>' +
      '</div>' : '';

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

    var cols = [
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
    ];
    if (canBulk) cols.unshift(userSelCol(filtered.length));
    var table = global.Ui.tableHtml(cols, info.items, info, t('table.empty'));

    root.innerHTML = '<h1 class="page-title">' + esc(t('users.title')) + '</h1>' + toolbar + bulkbar + table;

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
    var onboardBtn = root.querySelector('[data-users-onboard]');
    if (onboardBtn) onboardBtn.addEventListener('click', function () { onboardWizard(root); });

    // Bulk selection wiring. Row checkboxes update the bar in place (no
    // re-render — re-rendering on every tick would steal focus); the
    // select-all box and the Clear button do re-render deliberately.
    if (canBulk) {
      var selAll = root.querySelector('[data-select-all]');
      if (selAll) {
        selAll.addEventListener('change', function () {
          if (selAll.checked) {
            for (var si = 0; si < filtered.length; si++) {
              var sn = global.Api.attr(filtered[si], 'name') || '';
              if (sn) usersState.selected[sn] = true;
            }
          } else {
            usersState.selected = {};
          }
          renderUsers(root);
        });
      }
      var boxes = root.querySelectorAll('[data-user-select]');
      for (var bx = 0; bx < boxes.length; bx++) {
        (function (box) {
          box.addEventListener('change', function () {
            var nm = box.getAttribute('data-user-select');
            if (box.checked) usersState.selected[nm] = true;
            else delete usersState.selected[nm];
            updateBulkBar(root);
          });
        })(boxes[bx]);
      }
      var bAdd = root.querySelector('[data-bulk-add-group]');
      if (bAdd) bAdd.addEventListener('click', function () { bulkAddGroupModal(root); });
      var bExp = root.querySelector('[data-bulk-expiry]');
      if (bExp) bExp.addEventListener('click', function () { bulkExpiryModal(root); });
      var bClr = root.querySelector('[data-bulk-clear]');
      if (bClr) bClr.addEventListener('click', function () {
        usersState.selected = {};
        renderUsers(root);
      });
      updateBulkBar(root);
    }
  }

  // ---- Bulk operations ----------------------------------------------------
  // Selection is a name->true map that survives pagination/filtering, so a
  // bulk action can span pages. Every bulk action is DRY-RUN FIRST: the
  // plan (adds / skips / per-user expiry changes) is computed purely by
  // reading server state and is shown for confirmation before any write.

  function userSelCol(filteredCount) {
    return {
      key: '_sel', className: 'col-check',
      label: t('users.select.all', { n: filteredCount }),
      labelHtml: '<input type="checkbox" data-select-all aria-label="' +
        esc(t('users.select.all', { n: filteredCount })) + '"/>',
      render: function (p) {
        var name = global.Api.attr(p, 'name') || '';
        return '<input type="checkbox" data-user-select="' + esc(name) + '"' +
          (usersState.selected[name] ? ' checked' : '') +
          ' aria-label="' + esc(t('users.select.row', { name: name })) + '"/>';
      }
    };
  }

  function selectedNames() {
    var out = [];
    for (var k in usersState.selected) {
      if (Object.prototype.hasOwnProperty.call(usersState.selected, k) && usersState.selected[k]) out.push(k);
    }
    out.sort();
    return out;
  }

  function updateBulkBar(root) {
    var bar = root.querySelector('[data-bulkbar]');
    if (!bar) return;
    var n = selectedNames().length;
    bar.hidden = n === 0;
    var cnt = bar.querySelector('[data-bulk-count]');
    if (cnt) cnt.textContent = t('users.selected', { n: n });
    var btns = bar.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) btns[i].disabled = n === 0;
  }

  function bulkReportsList(titleKey, items) {
    var h = '<h3 class="bulk-report-title">' + esc(t(titleKey, { n: items.length })) + '</h3>';
    if (!items.length) return h;
    h += '<ul class="bulk-report-list">';
    for (var i = 0; i < items.length; i++) h += '<li>' + esc(items[i]) + '</li>';
    return h + '</ul>';
  }

  function bulkAddGroupModal(root) {
    var names = selectedNames();
    if (!names.length) return;
    var options = ['<option value="">—</option>'];
    for (var i = 0; i < usersState.groups.length; i++) {
      var gn = global.Api.attr(usersState.groups[i], 'name') || '';
      // idm_* role groups change RBAC — those stay a deliberate per-group
      // action on the group page, never a bulk click.
      if (!gn || gn.indexOf('idm_') === 0) continue;
      options.push('<option value="' + esc(gn) + '">' + esc(gn) + '</option>');
    }
    var body = html`
      <p class="muted">${esc(t('bulk.dryRun.help'))}</p>
      ${global.Ui.fieldHtml({
        name: 'bulkGroup', label: t('bulk.addGroup.group'),
        input: '<select class="input" name="bulkGroup">' + options.join('') + '</select>'
      })}
      <div data-bulk-report></div>`;
    var foot = '<button class="btn" data-cancel>' + esc(t('common.cancel')) + '</button>' +
      '<button class="btn" data-dry>' + esc(t('bulk.dryRun')) + '</button>' +
      '<button class="btn btn-primary" data-apply disabled>' + esc(t('bulk.apply')) + '</button>';
    var plan = null;
    global.Ui.openModal({
      title: t('bulk.addGroup.title', { n: names.length }),
      body: body, footer: foot, wide: true,
      onMount: function (el, close) {
        el.querySelector('[data-cancel]').addEventListener('click', close);
        el.querySelector('[data-dry]').addEventListener('click', async function () {
          var group = el.querySelector('[name=bulkGroup]').value;
          var report = el.querySelector('[data-bulk-report]');
          if (!group) return;
          report.innerHTML = global.Ui.spinner();
          try {
            var g = await global.Api.getGroup(group);
            var memberSet = {};
            var members = global.Api.attrs(g, 'member');
            for (var i = 0; i < members.length; i++) memberSet[global.Store.stripDomain(members[i])] = true;
            var adds = [], skips = [];
            for (var j = 0; j < names.length; j++) {
              (memberSet[names[j]] ? skips : adds).push(names[j]);
            }
            plan = adds.length ? { group: group, adds: adds } : null;
            report.innerHTML = bulkReportsList('bulk.report.adds', adds) +
              bulkReportsList('bulk.report.skips', skips) +
              (adds.length ? '' : '<p class="muted">' + esc(t('bulk.report.noop')) + '</p>');
            el.querySelector('[data-apply]').disabled = !plan;
          } catch (err) {
            report.innerHTML = '';
            global.Ui.handleError(err, 'groups');
          }
        });
        el.querySelector('[data-apply]').addEventListener('click', async function () {
          var apply = el.querySelector('[data-apply]');
          if (!plan || apply.disabled) return;
          apply.disabled = true;
          try {
            // ONE request adds the whole batch (the _attr/member POST takes
            // a Vec<String> of values).
            await global.Api.addGroupMembers(plan.group, plan.adds);
            global.Ui.toast(t('bulk.done', { ok: plan.adds.length, fail: 0 }), 'ok');
            usersState.selected = {};
            close();
            Pages.users(root);
          } catch (err) {
            apply.disabled = false;
            global.Ui.handleError(err, 'groups');
          }
        });
      }
    });
  }

  function bulkExpiryModal(root) {
    var names = selectedNames();
    if (!names.length) return;
    var body = html`
      <p class="muted">${esc(t('bulk.dryRun.help'))}</p>
      ${global.Ui.fieldHtml({ name: 'bulkExpire', label: t('bulk.expiry.date'), type: 'date' })}
      <label class="check"><input type="checkbox" data-exp-clear/> ${esc(t('bulk.expiry.clear'))}</label>
      <div data-bulk-report></div>`;
    var foot = '<button class="btn" data-cancel>' + esc(t('common.cancel')) + '</button>' +
      '<button class="btn" data-dry>' + esc(t('bulk.dryRun')) + '</button>' +
      '<button class="btn btn-primary" data-apply disabled>' + esc(t('bulk.apply')) + '</button>';
    // plan items: { name, expire } where expire is [] (purge) or a RFC3339
    // string. PATCH semantics are purge-then-present per attribute
    // (ModifyList::from_patch, server/lib/src/modify.rs:149), so an EMPTY
    // array is exactly how account_expire is cleared — allowed by
    // idm_acp_people_manage (AccountExpire sits in both modify_present and
    // modify_removed attrs, dl14 + dl15).
    var plan = [];
    global.Ui.openModal({
      title: t('bulk.expiry.title', { n: names.length }),
      body: body, footer: foot, wide: true,
      onMount: function (el, close) {
        el.querySelector('[data-cancel]').addEventListener('click', close);
        el.querySelector('[data-exp-clear]').addEventListener('change', function (e) {
          el.querySelector('[name=bulkExpire]').disabled = e.target.checked;
        });
        el.querySelector('[data-dry]').addEventListener('click', function () {
          var clear = el.querySelector('[data-exp-clear]').checked;
          var dateVal = el.querySelector('[name=bulkExpire]').value;
          var report = el.querySelector('[data-bulk-report]');
          if (!clear && !dateVal) {
            report.innerHTML = '<p class="muted">' + esc(t('bulk.expiry.pick')) + '</p>';
            return;
          }
          var newVal = clear ? null : global.Ui.toRfc3339(dateVal, /* endOfDay */ false);
          var newMs = newVal ? Date.parse(newVal) : null;
          plan = [];
          var rows = '<table class="table"><thead><tr><th scope="col">' + esc(t('bulk.col.user')) + '</th>' +
            '<th scope="col">' + esc(t('bulk.col.current')) + '</th>' +
            '<th scope="col">' + esc(t('bulk.col.new')) + '</th></tr></thead><tbody>';
          for (var i = 0; i < names.length; i++) {
            var nm = names[i];
            var person = null;
            for (var k = 0; k < usersState.people.length; k++) {
              if ((global.Api.attr(usersState.people[k], 'name') || '') === nm) { person = usersState.people[k]; break; }
            }
            var cur = person ? global.Api.attr(person, 'account_expire') : undefined;
            var curMs = cur ? Date.parse(String(cur)) : null;
            var unchanged = (curMs == null && newMs == null) ||
              (curMs != null && newMs != null && curMs === newMs);
            if (!unchanged) plan.push({ name: nm, expire: clear ? [] : newVal });
            rows += '<tr><td>' + esc(nm) + '</td><td>' + esc(global.Ui.formatDate(cur)) + '</td>' +
              '<td>' + (unchanged ? '<span class="muted">' + esc(t('bulk.unchanged')) + '</span>'
                : esc(clear ? '—' : global.Ui.formatDate(newVal))) + '</td></tr>';
          }
          rows += '</tbody></table>';
          report.innerHTML = rows + (plan.length ? '' : '<p class="muted">' + esc(t('bulk.report.noop')) + '</p>');
          el.querySelector('[data-apply]').disabled = plan.length === 0;
        });
        el.querySelector('[data-apply]').addEventListener('click', async function () {
          var apply = el.querySelector('[data-apply]');
          if (!plan.length || apply.disabled) return;
          apply.disabled = true;
          var ok = 0;
          var failures = [];
          for (var i = 0; i < plan.length; i++) {
            try {
              await global.Api.updatePerson(plan[i].name, { expire: plan[i].expire });
              ok++;
            } catch (err) {
              failures.push(plan[i].name + ': ' + (err && err.message ? err.message : 'error'));
            }
          }
          global.Ui.toast(t('bulk.done', { ok: ok, fail: failures.length }), failures.length ? 'warn' : 'ok');
          if (failures.length) {
            el.querySelector('[data-bulk-report]').innerHTML =
              '<h3 class="bulk-report-title">' + esc(t('bulk.failures')) + '</h3><ul class="bulk-report-list">' +
              failures.map(function (f) { return '<li>' + esc(f) + '</li>'; }).join('') + '</ul>';
            apply.disabled = false;
          } else {
            usersState.selected = {};
            close();
            Pages.users(root);
          }
        });
      }
    });
  }

  // v1.3: guided onboarding — person → baseline groups → first-sign-in
  // link in ONE modal. Composes only already-verified endpoints
  // (POST /v1/person, group _attr/member, credential intent); re-renders
  // one step container instead of fake multi-page state.
  function onboardWizard(root) {
    var state = { name: '' };
    var m = global.Ui.openModal({
      title: t('users.onboard.title'),
      body: '<div data-onboard-step></div>',
      footer: '<div class="btn-row" data-onboard-foot></div>',
      wide: true
    });
    var stepEl = m.el.querySelector('[data-onboard-step]');
    var footEl = m.el.querySelector('[data-onboard-foot]');

    function step1() {
      stepEl.innerHTML = '<p class="muted">1/3 — ' + esc(t('users.onboard.step1')) + '</p>' +
        '<form data-onboard-person novalidate>' +
        global.Ui.fieldHtml({ name: 'name', label: t('users.field.username'), required: true }) +
        global.Ui.fieldHtml({ name: 'displayname', label: t('users.field.displayName'), required: true }) +
        global.Ui.fieldHtml({ name: 'mail', label: t('users.field.mail'), type: 'email' }) +
        '</form>';
      footEl.innerHTML = '<button class="btn btn-primary" data-onboard-next>' + esc(t('common.next')) + '</button>';
      footEl.querySelector('[data-onboard-next]').addEventListener('click', async function () {
        var formEl = stepEl.querySelector('[data-onboard-person]');
        var data = {
          name: formEl.querySelector('[name=name]').value.trim(),
          displayname: formEl.querySelector('[name=displayname]').value.trim(),
          mail: formEl.querySelector('[name=mail]').value.trim(),
          validFrom: '', expire: ''
        };
        var result = global.Validation.personForm(data, {});
        if (!result.ok) { global.Ui.showFieldErrors(stepEl, result.errors); return; }
        var btn = footEl.querySelector('[data-onboard-next]');
        btn.disabled = true;
        try {
          await global.Api.createPerson({
            name: data.name, displayname: data.displayname, mail: data.mail,
            validFrom: global.Ui.toRfc3339(data.validFrom), expire: global.Ui.toRfc3339(data.expire, true)
          });
          state.name = data.name;
          step2();
        } catch (err) {
          btn.disabled = false;
          global.Ui.handleError(err, 'people');
        }
      });
    }

    function step2() {
      var groups = (usersState.groups || [])
        .map(function (g) { return global.Api.attr(g, 'name') || ''; })
        .filter(function (n) { return n && n.indexOf('idm_') !== 0 && n !== 'domain_admins' && n !== 'system_admins'; })
        .sort();
      stepEl.innerHTML = '<p class="muted">2/3 — ' + esc(t('users.onboard.step2')) + '</p>' +
        (groups.length
          ? '<div class="chip-col">' + groups.map(function (g) {
              return '<label class="check"><input type="checkbox" data-onboard-group value="' + esc(g) + '" /> ' + esc(g) + '</label>';
            }).join('') + '</div>'
          : '<p class="muted">' + esc(t('common.none')) + '</p>');
      footEl.innerHTML = '<button class="btn" data-onboard-skip>' + esc(t('common.skip')) + '</button>' +
        '<button class="btn btn-primary" data-onboard-next>' + esc(t('common.next')) + '</button>';
      footEl.querySelector('[data-onboard-skip]').addEventListener('click', step3);
      footEl.querySelector('[data-onboard-next]').addEventListener('click', async function () {
        var btn = footEl.querySelector('[data-onboard-next]');
        btn.disabled = true;
        try {
          var checked = stepEl.querySelectorAll('[data-onboard-group]:checked');
          for (var i = 0; i < checked.length; i++) {
            await global.Api.addGroupMember(checked[i].value, state.name);
          }
          step3();
        } catch (err) {
          btn.disabled = false;
          global.Ui.handleError(err, 'groups');
        }
      });
    }

    function step3() {
      footEl.innerHTML = '';
      stepEl.innerHTML = '<p class="muted">3/3 — ' + esc(t('users.onboard.step3')) + '</p>' + global.Ui.spinner();
      (async function () {
        var res = await global.Api.resetPassword(state.name);
        var token = res && (res.token || res.intent_id || res.intentToken || '');
        var link = token
          ? global.ShenaConfig.oauthBase() + '/ui/reset?token=' + encodeURIComponent(String(token))
          : '';
        stepEl.innerHTML = '<p class="muted">3/3 — ' + esc(t('users.onboard.step3')) + '</p>' +
          (link
            ? '<p>' + esc(t('users.onboard.share')) + '</p>' +
              '<p><code class="break-all">' + esc(link) + '</code></p>' +
              '<button class="btn" data-copy-link>' + esc(t('common.copy')) + '</button>' +
              (qrSvg(link) ? '<p class="muted">' + esc(t('resetlink.scan')) + '</p><div class="qr-box">' + qrSvg(link) + '</div>' : '')
            : '<p>' + esc(t('users.onboard.created', { name: state.name })) + '</p>' +
              '<pre class="log-box">' + esc(JSON.stringify(res, null, 2)) + '</pre>');
        var copyBtn = stepEl.querySelector('[data-copy-link]');
        if (copyBtn) copyBtn.addEventListener('click', function () { global.Ui.copyText(link); });
        global.Ui.toast(t('users.onboard.created', { name: state.name }), 'success');
        if (root.getAttribute('data-page') !== 'user') Pages.users(root);
      })().catch(function (err) {
        global.Ui.handleError(err, 'people');
      });
    }

    step1();
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
        if (rows.length > 2000) rows = rows.slice(0, 2000);
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
      // Credential status needs the credential-reset ACPs — readers without
      // them would break the whole page on 403, so tolerate and hide.
      var credsP = global.Api.getCredentialStatus(name).catch(function (e) {
        if (e && e.status === 403) return 'restricted';
        throw e;
      });
      var results = await Promise.all([global.Api.getPerson(name), global.Api.listGroups(), credsP]);
      var person = results[0];
      var groups = results[1] || [];
      renderUserDetail(root, person, groups, results[2]);
    } catch (err) {
      loadError(root, err, 'people');
    }
  };

  // CredentialDetailType rendering (proto/src/internal/credupdate.rs —
  // serde externally-tagged, exact case, `type_` has no rename):
  // "Password" | "GeneratedPassword" | {Passkey:[labels]} |
  // {PasswordMfa:[[totpLabels],[securityKeyLabels],backupCodeCount]}.
  function credDetailRows(creds) {
    if (!creds || !creds.length) return '<p class="muted">' + esc(t('user.creds.none')) + '</p>';
    return creds.map(function (cd) {
      var type = cd ? cd.type_ : null;
      var uuid = cd && cd.uuid ? String(cd.uuid) : '';
      var badge = t('common.unknown');
      var detail = '';
      if (type === 'Password') badge = t('user.creds.password');
      else if (type === 'GeneratedPassword') badge = t('user.creds.generatedPassword');
      else if (type && type.Passkey) {
        badge = t('user.creds.passkey');
        detail = (type.Passkey || []).map(function (l) { return esc(String(l)); }).join(', ');
      } else if (type && type.PasswordMfa) {
        badge = t('user.creds.mfa');
        var pm = type.PasswordMfa || [];
        var parts = [];
        if (pm[0] && pm[0].length) parts.push(esc(t('user.creds.totp')) + ': ' + pm[0].map(function (l) { return esc(String(l)); }).join(', '));
        if (pm[1] && pm[1].length) parts.push(esc(t('user.creds.securityKey')) + ': ' + pm[1].map(function (l) { return esc(String(l)); }).join(', '));
        if (pm[2]) parts.push(esc(t('user.creds.backupCodes', { count: pm[2] })));
        detail = parts.join(' · ');
      }
      return '<div class="kv" data-cred-row><span class="kv-k">' + esc(badge) + '</span><span class="kv-v">' +
        (detail ? detail + ' ' : '') + '<code class="mono muted">' + esc(uuid) + '</code></span></div>';
    }).join('');
  }

  function renderUserDetail(root, person, groups, credStatus) {
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

    // v1.3: real credential status (GET _credential/_status) — hidden for
    // callers without the credential-reset ACPs ('restricted').
    var credsCard = null;
    if (credStatus === 'restricted') {
      credsCard = card(t('user.creds.title'), '<p class="muted">' + esc(t('user.creds.restricted')) + '</p>');
    } else if (credStatus && Array.isArray(credStatus.creds)) {
      credsCard = card(t('user.creds.title'), credDetailRows(credStatus.creds));
    }

    // v1.3: account recovery is user SELF-service at the IdP — upstream
    // exposes no admin "send recovery email" REST surface (verified:
    // v1.rs has no such route), so we link honestly instead of faking one.
    var recoverBase = global.ShenaConfig.oauthBase();
    var recoverHref = global.ShenaConfig.isSafeHttpUrl(recoverBase) ? recoverBase + '/ui/recover' : '#';
    var recoveryCard = canReset ? card(t('user.recovery.title'),
      '<p>' + esc(t('user.recovery.hint')) + '</p>' +
      '<p><a class="link" href="' + esc(recoverHref) + '" target="_blank" rel="noopener noreferrer">' +
      esc(t('user.recovery.open')) + '</a></p>') : '';

    root.innerHTML = '<p><a class="link" href="#/users">← ' + esc(t('common.back')) + '</a></p>' +
      title + '<div class="grid-2">' + infoCard + securityCard + '</div>' + groupsCard +
      (credsCard || '') + recoveryCard;

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
      (canManage ? '<button class="btn" data-groups-import-members>' + esc(t('groups.importMembers')) + '</button>' : '') +
      '<button class="btn" data-groups-export-json>' + esc(t('groups.exportJson')) + '</button>' +
      '</div>';

    var table = global.Ui.tableHtml([
      {
        key: 'name', label: t('groups.col.name'), render: function (g) {
          var name = global.Api.attr(g, 'name') || '';
          return '<a class="link" href="#/groups/' + encodeURIComponent(name) + '">' + esc(name) + '</a>';
        }
      },
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
    var gExport = root.querySelector('[data-groups-export-json]');
    if (gExport) gExport.addEventListener('click', exportGroupsJson);
    var gImport = root.querySelector('[data-groups-import-members]');
    if (gImport) gImport.addEventListener('click', function () { membershipImportModal(root); });
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

  // JSON export = the canonical input of the Reports-page membership diff.
  // Shape: { format, version, generatedAt, groups: [{ name, members }] }.
  function exportGroupsJson() {
    var out = {
      format: 'shenasa-group-export',
      version: 1,
      generatedAt: new Date().toISOString(),
      groups: []
    };
    for (var i = 0; i < groupsState.groups.length; i++) {
      var g = groupsState.groups[i];
      var name = global.Api.attr(g, 'name') || '';
      if (!name) continue;
      var members = global.Api.attrs(g, 'member').map(global.Store.stripDomain).sort();
      out.groups.push({ name: name, members: members });
    }
    out.groups.sort(function (a, b) { return a.name.localeCompare(b.name); });
    global.Ui.download('shenasa-groups.json', JSON.stringify(out, null, 2), 'application/json');
  }

  // Group-membership CSV import. Dry-run first: every row is classified as
  // add / remove / no-op / conflict from the CURRENT server state; only
  // effective changes are applied, batched to ONE request per group and
  // action (POST/DELETE _attr/member accept value arrays).
  function membershipImportPlan(rows, groups, people) {
    var groupSet = {};
    for (var i = 0; i < groups.length; i++) {
      var gn = global.Api.attr(groups[i], 'name') || '';
      if (gn) groupSet[gn] = groups[i];
    }
    var peopleSet = {};
    for (i = 0; i < people.length; i++) {
      var pn = global.Api.attr(people[i], 'name') || '';
      if (pn) peopleSet[pn] = true;
    }
    var plan = [];
    for (i = 0; i < rows.length; i++) {
      var group = String(rows[i][0] || '').trim();
      var member = global.Store.stripDomain(String(rows[i][1] || '').trim());
      var action = String(rows[i][2] || '').trim().toLowerCase() || 'add';
      var entry = { group: group, member: member, action: action, verdict: 'conflict', reason: 'gimport.reason.unknownGroup' };
      var g = groupSet[group];
      if (!group || !g) { plan.push(entry); continue; }
      if (!member || (!peopleSet[member] && !groupSet[member])) {
        entry.reason = 'gimport.reason.unknownMember';
        plan.push(entry); continue;
      }
      if (action !== 'add' && action !== 'remove') {
        entry.reason = 'gimport.reason.badAction';
        plan.push(entry); continue;
      }
      var isMember = false;
      var members = global.Api.attrs(g, 'member');
      for (var m = 0; m < members.length; m++) {
        if (global.Store.stripDomain(members[m]) === member) { isMember = true; break; }
      }
      if (action === 'add') {
        entry.verdict = isMember ? 'skip' : 'add';
        entry.reason = isMember ? 'gimport.reason.alreadyMember' : 'gimport.reason.okAdd';
      } else {
        entry.verdict = isMember ? 'remove' : 'skip';
        entry.reason = isMember ? 'gimport.reason.okRemove' : 'gimport.reason.notMember';
      }
      plan.push(entry);
    }
    return plan;
  }

  function membershipImportModal(root) {
    var fileInput = global.Ui.el('input', 'input');
    fileInput.type = 'file';
    fileInput.accept = '.csv,text/csv';
    var body = global.Ui.el('div');
    body.appendChild(global.Ui.el('p', 'help', t('gimport.help')));
    body.appendChild(fileInput);
    var parsed = null;
    var preview = global.Ui.el('div');
    body.appendChild(preview);

    var foot = '<button class="btn" data-cancel>' + esc(t('common.cancel')) + '</button>' +
      '<button class="btn" data-dry disabled>' + esc(t('bulk.dryRun')) + '</button>' +
      '<button class="btn btn-primary" data-apply disabled>' + esc(t('bulk.apply')) + '</button>';
    var plan = null;

    global.Ui.openModal({
      title: t('gimport.title'),
      body: body, footer: foot, wide: true,
      onMount: function (el, close) {
        fileInput.addEventListener('change', function () {
          var f = fileInput.files && fileInput.files[0];
          if (!f) return;
          var reader = new global.FileReader();
          reader.onload = function () {
            var rows = parseCsv(String(reader.result || ''));
            if (rows.length && String(rows[0][0]).toLowerCase() === 'group') rows.shift();
            if (rows.length > 2000) rows = rows.slice(0, 2000);
            parsed = rows;
            preview.innerHTML = '<p class="muted">' + esc(String(rows.length)) + ' row(s)</p>';
            el.querySelector('[data-dry]').disabled = rows.length === 0;
          };
          reader.readAsText(f);
        });
        el.querySelector('[data-cancel]').addEventListener('click', close);
        el.querySelector('[data-dry]').addEventListener('click', async function () {
          if (!parsed || !parsed.length) return;
          var dry = el.querySelector('[data-dry]');
          dry.disabled = true;
          try {
            // Groups are already loaded; people go through the in-flight
            // de-dupe so a simultaneous Users view never doubles requests.
            if (!groupsState.people.length) {
              groupsState.people = await global.Api.listPeople() || [];
            }
            plan = membershipImportPlan(parsed, groupsState.groups, groupsState.people);
            var counts = { add: 0, remove: 0, skip: 0, conflict: 0 };
            var rowsHtml = '';
            for (var i = 0; i < plan.length; i++) {
              var e = plan[i];
              counts[e.verdict]++;
              rowsHtml += '<tr><td>' + esc(e.group) + '</td><td>' + esc(e.member) + '</td>' +
                '<td>' + esc(t(e.action === 'add' ? 'gimport.add' : 'gimport.remove')) + '</td>' +
                '<td><span class="chip chip-' + e.verdict + '">' + esc(t('gimport.' + e.verdict)) + '</span> ' +
                '<span class="muted">' + esc(t(e.reason)) + '</span></td></tr>';
            }
            preview.innerHTML = '<p class="muted">' + esc(t('gimport.summary', {
              adds: counts.add, removes: counts.remove, skips: counts.skip, conflicts: counts.conflict
            })) + '</p>' +
              '<table class="table"><thead><tr><th scope="col">' + esc(t('gimport.col.group')) + '</th>' +
              '<th scope="col">' + esc(t('gimport.col.member')) + '</th><th scope="col">' + esc(t('gimport.col.action')) + '</th>' +
              '<th scope="col">' + esc(t('gimport.col.reason')) + '</th></tr></thead><tbody>' + rowsHtml + '</tbody></table>';
            el.querySelector('[data-apply]').disabled = (counts.add + counts.remove) === 0;
          } catch (err) {
            global.Ui.handleError(err, 'groups');
          } finally {
            dry.disabled = false;
          }
        });
        el.querySelector('[data-apply]').addEventListener('click', async function () {
          var apply = el.querySelector('[data-apply]');
          if (!plan || apply.disabled) return;
          apply.disabled = true;
          // Batch effective changes per (group, action).
          var byGroup = {};
          for (var i = 0; i < plan.length; i++) {
            var e = plan[i];
            if (e.verdict !== 'add' && e.verdict !== 'remove') continue;
            var k = e.group + '\u0000' + e.verdict;
            if (!byGroup[k]) byGroup[k] = { group: e.group, verdict: e.verdict, members: [] };
            byGroup[k].members.push(e.member);
          }
          var ok = 0;
          var failures = [];
          for (var key in byGroup) {
            if (!Object.prototype.hasOwnProperty.call(byGroup, key)) continue;
            var job = byGroup[key];
            try {
              if (job.verdict === 'add') await global.Api.addGroupMembers(job.group, job.members);
              else await global.Api.removeGroupMembers(job.group, job.members);
              ok++;
            } catch (err) {
              failures.push(job.group + ' (' + job.verdict + '): ' + (err && err.message ? err.message : 'error'));
            }
          }
          global.Ui.toast(t('gimport.applied', { ok: ok, fail: failures.length }), failures.length ? 'warn' : 'ok');
          if (failures.length) {
            preview.innerHTML = '<h3 class="bulk-report-title">' + esc(t('bulk.failures')) + '</h3><ul class="bulk-report-list">' +
              failures.map(function (f) { return '<li>' + esc(f) + '</li>'; }).join('') + '</ul>';
            apply.disabled = false;
          } else {
            close();
            Pages.groups(root);
          }
        });
      }
    });
  }

  function groupFormModal(root, group) {
    var isEdit = !!group;
    var name = isEdit ? global.Api.attr(group, 'name') || '' : '';
    var canManagedBy = global.Store.canSetManagedBy();
    var body = html`
      <form data-group-form novalidate>
        ${global.Ui.fieldHtml({ name: 'name', label: t('groups.col.name'), value: name, required: true, readonly: isEdit })}
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
              var payload = {};
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
  // Apps (OAuth2/OIDC clients) — GET/POST/PATCH/DELETE /v1/oauth2*
  // Route + payload shapes verified against server/core/src/https/v1.rs and
  // libs/client/src/oauth.rs (identical in 1.10.5 and 1.11.0). UI gate:
  // idm_oauth2_admins (server always re-authorises).
  // ======================================================================
  // OAuth2 scope/claim/sup maps are multi-valued attrs whose values map a
  // GROUP to scopes/values. Their serialized shape is server-versioned, so
  // we parse tolerantly: JSON object form first, then a
  // "group: [scope, scope…]" text form, else show the raw value and disable
  // row actions that would need a parsed group (never guess wrong at the
  // server).
  function parseMapRows(rawValues, twoKey) {
    var rows = [];
    for (var i = 0; i < rawValues.length; i++) {
      var raw = String(rawValues[i]);
      var claim = '', group = '', join = '';
      try {
        var j = JSON.parse(raw);
        var g = j && (j.group || j.spn || j.name || j.uuid);
        var sc = j && (j.scopes || j.values || j.claim_values);
        if (g) {
          group = String(g);
          claim = j && j.claim ? String(j.claim) : '';
          join = typeof sc === 'string' ? sc :
            (sc && typeof sc.length === 'number' ? sc.join(' ') : '');
        }
      } catch (e) { /* not JSON — try text forms */ }
      if (!group && twoKey) {
        // Claim maps serialize per claim+group: "claim: group: [values]".
        var m2 = /^\s*("?)([^:\s"]+)\1\s*:\s*("?)([^:\s"]+)\3\s*:\s*(\[[^\]]*\]|.+?)\s*$/.exec(raw);
        if (m2) {
          claim = m2[2]; group = m2[4];
          join = m2[5].replace(/[\[\]"]/g, ' ').replace(/\s+/g, ' ').trim();
        }
      }
      if (!group && !twoKey) {
        // Scope/sup maps serialize per group: "group: [scope, scope]".
        var m = /^\s*("?)([^:\s"]+)\1\s*:\s*(\[[^\]]*\]|.+?)\s*$/.exec(raw);
        if (m) { group = m[2]; join = m[3].replace(/[\[\]"]/g, ' ').replace(/\s+/g, ' ').trim(); }
      }
      // A row is only actionable when every key its endpoint needs was
      // parsed: scope/sup need the group; claims need claim AND group.
      var known = twoKey ? !!(claim && group) : !!group;
      rows.push({
        raw: raw,
        claim: claim,
        group: group,
        scopes: join || raw,   // display text (falls back to raw)
        known: known
      });
    }
    return rows;
  }

  function mapSectionHtml(title, hint, rows, sectionKey, canManage) {
    var body = '<p class="muted">' + esc(hint) + '</p>';
    if (!rows.length) {
      body += '<p class="muted">' + esc(t('common.none')) + '</p>';
    } else {
      body += '<div class="table-wrap"><table class="table"><thead><tr><th>' + esc(t('apps.group')) + '</th>' +
        '<th>' + esc(t('apps.values')) + '</th><th></th></tr></thead><tbody>';
      for (var i = 0; i < rows.length; i++) {
        body += '<tr><td><code>' + esc(rows[i].group || '—') + '</code></td>' +
          '<td class="break-all">' + esc(rows[i].scopes) + '</td>' +
          '<td class="row-actions">' +
          (canManage
            ? '<button class="btn btn-sm" data-map-edit="' + sectionKey + ':' + i + '"' + (rows[i].known ? '' : ' disabled title="' + esc(t('apps.map.unparsed')) + '"') + '>' + esc(t('common.edit')) + '</button> ' +
              '<button class="btn btn-sm btn-danger" data-map-del="' + sectionKey + ':' + i + '"' + (rows[i].known ? '' : ' disabled title="' + esc(t('apps.map.unparsed')) + '"') + '>' + esc(t('common.delete')) + '</button>'
            : '') +
          '</td></tr>';
      }
      body += '</tbody></table></div>';
    }
    if (canManage) {
      body += '<p><button class="btn" data-map-add="' + sectionKey + '">' + esc(t('apps.map.add')) + '</button></p>';
    }
    return card(title, body);
  }

  // Basic vs public is a class (oauth2_resource_server_basic) plus the
  // hidden secret attr. Kanidm never converts one into the other.
  function isOauth2Basic(en) {
    var classes = global.Api.attrs(en, 'class');
    return classes.indexOf('oauth2_resource_server_basic') >= 0 ||
      global.Api.attrs(en, 'oauth2_rs_basic_secret').length > 0;
  }

  // GET /v1/oauth2/{id}/_basic_secret returns the current secret as a JSON
  // string. Shown once after create, and later via Reveal. Never accepted
  // as an input on create — Kanidm generates it.
  function showOauth2SecretModal(secret) {
    var body = '<p>' + esc(t('apps.secret.warning')) + '</p>' +
      '<p><code class="break-all">' + esc(String(secret)) + '</code></p>' +
      '<button class="btn" data-copy-secret>' + esc(t('common.copy')) + '</button>';
    var m = global.Ui.openModal({ title: t('apps.secret'), body: body, wide: true });
    var b = m.el.querySelector('[data-copy-secret]');
    if (b) b.addEventListener('click', function () { global.Ui.copyText(String(secret)); });
    return m;
  }

  function oauthClientDialog(root, existing) {
    var isEdit = !!existing;
    var body = html`
      <form data-client-form novalidate>
        ${!isEdit ? '<div class="field"><label class="label" for="f-ctype">' + esc(t('apps.field.type')) + '</label>' +
          '<select class="input" id="f-ctype" name="clientType">' +
          '<option value="public">' + esc(t('apps.type.public')) + '</option>' +
          '<option value="basic">' + esc(t('apps.type.basic')) + '</option>' +
          '</select><p class="help" data-type-note>' + esc(t('apps.field.type.live.public')) + '</p></div>' : ''}
        ${global.Ui.fieldHtml({ name: 'name', label: t('apps.field.name'), value: isEdit ? existing.name : '', required: true, readonly: isEdit, help: isEdit ? t('apps.field.name.immutable') : t('apps.field.name.help') })}
        ${global.Ui.fieldHtml({ name: 'displayname', label: t('apps.field.displayName'), value: isEdit ? existing.displayname : '', required: true })}
        ${global.Ui.fieldHtml({ name: 'originLanding', label: t('apps.field.landing'), value: isEdit ? existing.landing : '', required: true, placeholder: 'https://app.example.com/oauth2/callback', help: t('apps.field.landing.help') })}
      </form>`;
    var foot = '<button class="btn" data-cancel>' + esc(t('common.cancel')) + '</button>' +
      '<button class="btn btn-primary" data-submit>' + esc(t('common.save')) + '</button>';
    global.Ui.openModal({
      title: isEdit ? t('apps.edit.title') : t('apps.create.title'),
      body: body,
      footer: foot,
      onMount: function (el, close) {
        el.querySelector('[data-cancel]').addEventListener('click', close);
        var typeSel = el.querySelector('[name=clientType]');
        var typeNote = el.querySelector('[data-type-note]');
        if (typeSel && typeNote) {
          typeSel.addEventListener('change', function () {
            typeNote.textContent = t(typeSel.value === 'basic'
              ? 'apps.field.type.live.basic' : 'apps.field.type.live.public');
          });
        }
        el.querySelector('[data-submit]').addEventListener('click', async function () {
          var form = el.querySelector('[data-client-form]');
          var data = {
            name: form.querySelector('[name=name]').value.trim(),
            displayname: form.querySelector('[name=displayname]').value.trim(),
            originLanding: form.querySelector('[name=originLanding]').value.trim()
          };
          var result = global.Validation.oauthClientForm(data, { skipName: isEdit });
          if (!result.ok) { global.Ui.showFieldErrors(el, result.errors); return; }
          try {
            if (isEdit) {
              await global.Api.updateOauth2Client(existing.name, {
                displayname: data.displayname,
                oauth2_rs_origin_landing: data.originLanding
              });
              close(); global.Ui.toast(t('common.saved'), 'success');
              Pages.appDetail(root, existing.name);
            } else {
              var kind = (form.querySelector('[name=clientType]') || {}).value || 'public';
              var fn = kind === 'basic' ? 'createOauth2BasicClient' : 'createOauth2PublicClient';
              await global.Api[fn](data);
              // Create never writes oauth2_rs_origin (verified
              // idm_oauth2_rs_{basic,public}_create). With
              // oauth2_strict_redirect_uri=true, SSO rejects the callback
              // until an origin exists — same PATCH bootstrap/integration use.
              try {
                await global.Api.updateOauth2Client(data.name, {
                  oauth2_rs_origin: [data.originLanding]
                });
              } catch (origErr) {
                global.Ui.toast(t('apps.origin.autoFailed'), 'warning');
              }
              var secret = null;
              if (kind === 'basic') {
                try { secret = await global.Api.getOauth2BasicSecret(data.name); }
                catch (secErr) { secret = null; }
              }
              close();
              global.Ui.toast(t('apps.created'), 'success');
              // Hash so refresh / back keep the detail page (the secret
              // card lives there, not as a tab on this form).
              if (global.location) {
                global.location.hash = '#/apps/' + encodeURIComponent(data.name);
              } else {
                Pages.appDetail(root, data.name);
              }
              if (secret != null && String(secret) !== '') showOauth2SecretModal(secret);
            }
          } catch (err) {
            if (err && err.status === 400 && err.message) global.Ui.toast(err.message, 'error');
            else global.Ui.handleError(err, 'oauth2');
          }
        });
      }
    });
  }

  Pages.apps = async function (root) {
    root.setAttribute('data-page', 'apps');
    if (!global.Store.canManageOauth2()) {
      root.innerHTML = '<h1 class="page-title">' + esc(t('apps.title')) + '</h1>' +
        card(null, '<p class="muted">' + esc(t('apps.denied')) + '</p>');
      return;
    }
    root.innerHTML = '<h1 class="page-title">' + esc(t('apps.title')) + '</h1>' + global.Ui.spinner();
    try {
      var items = (await global.Api.listOauth2Clients()) || [];
      items.sort(function (a, b) {
        return (global.Api.attr(a, 'name') || '').localeCompare(global.Api.attr(b, 'name') || '');
      });
      var body = '<div class="toolbar"><input class="input" type="search" data-filter placeholder="' +
        esc(t('apps.search')) + '" aria-label="' + esc(t('apps.search')) + '" />' +
        '<button class="btn btn-primary" data-new-client>' + esc(t('apps.new')) + '</button></div>';
      if (!items.length) {
        body += card(null, '<p class="muted">' + esc(t('apps.empty')) + '</p>');
      } else {
        body += '<div class="table-wrap"><table class="table" data-rows><thead><tr>' +
          '<th>' + esc(t('apps.field.name')) + '</th><th>' + esc(t('apps.field.displayName')) + '</th>' +
          '<th>' + esc(t('apps.field.type')) + '</th><th>' + esc(t('apps.field.landing')) + '</th>' +
          '<th>' + esc(t('apps.scopeMaps')) + '</th></tr></thead><tbody>';
        for (var i = 0; i < items.length; i++) {
          var en = items[i];
          var nm = global.Api.attr(en, 'name') || '';
          var dm = global.Api.attr(en, 'displayname') || '—';
          var landing = global.Api.attr(en, 'oauth2_rs_origin_landing') || '—';
          var sm = global.Api.attrs(en, 'oauth2_rs_scope_map');
          var isBasic = isOauth2Basic(en);
          body += '<tr data-name="' + esc((nm + ' ' + dm).toLowerCase()) + '">' +
            '<td><a href="#/apps/' + encodeURIComponent(nm) + '"><code>' + esc(nm) + '</code></a></td>' +
            '<td>' + esc(dm) + '</td>' +
            '<td><span class="badge ' + (isBasic ? 'badge-info' : 'badge-muted') + '">' + esc(isBasic ? t('apps.type.basic') : t('apps.type.public')) + '</span></td>' +
            '<td class="break-all">' + esc(landing) + '</td>' +
            '<td>' + sm.length + '</td></tr>';
        }
        body += '</tbody></table></div>';
      }
      body += '<p class="muted">' + esc(t('apps.note')) + '</p>';
      root.innerHTML = '<h1 class="page-title">' + esc(t('apps.title')) + '</h1>' + body;
      root.querySelector('[data-new-client]').addEventListener('click', function () {
        oauthClientDialog(root, null);
      });
      var filter = root.querySelector('[data-filter]');
      filter.addEventListener('input', global.Ui.debounce(function () {
        var q = filter.value.trim().toLowerCase();
        var rows = root.querySelectorAll('[data-rows] tbody tr');
        for (var i = 0; i < rows.length; i++) {
          rows[i].style.display = !q || rows[i].getAttribute('data-name').indexOf(q) >= 0 ? '' : 'none';
        }
      }, 120));
    } catch (err) {
      global.Ui.handleError(err, 'oauth2');
    }
  };

  Pages.appDetail = async function (root, name) {
    root.setAttribute('data-page', 'app');
    root.innerHTML = '<h1 class="page-title">' + esc(t('apps.detail.title')) + '</h1>' + global.Ui.spinner();
    if (!global.Store.canManageOauth2()) {
      root.innerHTML = '<h1 class="page-title">' + esc(t('apps.detail.title')) + '</h1>' +
        card(null, '<p class="muted">' + esc(t('apps.denied')) + '</p>');
      return;
    }
    try {
      var en = await global.Api.getOauth2Client(name);
      var canManage = true; // page itself is role-gated
      var isBasic = isOauth2Basic(en);
      var displayname = global.Api.attr(en, 'displayname') || '';
      var landing = global.Api.attr(en, 'oauth2_rs_origin_landing') || '';
      var strict = (global.Api.attr(en, 'oauth2_strict_redirect_uri') || 'false') === 'true';
      var origins = global.Api.attrs(en, 'oauth2_rs_origin');
      var uuid = global.Api.attr(en, 'uuid') || '';

      var head = '<div class="toolbar">' +
        '<button class="btn" data-edit-client>' + esc(t('common.edit')) + '</button>' +
        '<button class="btn btn-danger" data-del-client>' + esc(t('common.delete')) + '</button></div>';
      var info = '<dl class="detail-list">' +
        '<dt>' + esc(t('apps.field.name')) + '</dt><dd><code>' + esc(name) + '</code></dd>' +
        '<dt>' + esc(t('apps.field.displayName')) + '</dt><dd>' + esc(displayname || '—') + '</dd>' +
        '<dt>' + esc(t('apps.field.type')) + '</dt><dd><span class="badge ' + (isBasic ? 'badge-info' : 'badge-muted') + '">' + esc(isBasic ? t('apps.type.basic') : t('apps.type.public')) + '</span></dd>' +
        '<dt>' + esc(t('apps.field.landing')) + '</dt><dd class="break-all">' + esc(landing || '—') + '</dd>' +
        '<dt>' + esc(t('apps.field.strict')) + '</dt><dd>' +
        '<label class="check"><input type="checkbox" data-strict ' + (strict ? 'checked' : '') + ' /> ' + esc(t('apps.field.strict.on')) + '</label>' +
        '<p class="help">' + esc(t('apps.field.strict.help')) + '</p></dd>' +
        '<dt>' + esc(t('apps.field.uuid')) + '</dt><dd><code class="muted">' + esc(uuid || '—') + '</code></dd>' +
        '</dl>';
      var originsBody = '<p class="muted">' + esc(t('apps.origins.help')) + '</p>';
      if (origins.length) {
        originsBody += '<ul class="token-list">';
        for (var oi = 0; oi < origins.length; oi++) {
          originsBody += '<li><code class="break-all">' + esc(origins[oi]) + '</code> ' +
            '<button class="btn btn-sm btn-danger" data-origin-del="' + oi + '">×</button></li>';
        }
        originsBody += '</ul>';
      } else {
        originsBody += '<p class="muted">' + esc(t('apps.origins.empty')) + '</p>';
      }
      originsBody += '<div class="btn-row"><input class="input" data-origin-new placeholder="https://app.example.com/oauth2/callback" />' +
        '<button class="btn" data-origin-add>' + esc(t('apps.origins.add')) + '</button></div>';

      var scopeRows = parseMapRows(global.Api.attrs(en, 'oauth2_rs_scope_map'), false);
      var supRows = parseMapRows(global.Api.attrs(en, 'oauth2_rs_sup_scope_map'), false);
      var claimRows = parseMapRows(global.Api.attrs(en, 'oauth2_rs_claim_map'), true);

      var secretBody = isBasic
        ? '<p class="muted">' + esc(t('apps.secret.help')) + '</p>' +
          '<button class="btn" data-reveal-secret>' + esc(t('apps.secret.reveal')) + '</button>'
        : '<p class="muted">' + esc(t('apps.secret.public')) + '</p>';

      root.innerHTML = '<h1 class="page-title">' + esc(t('apps.detail.title')) + ': <code>' + esc(name) + '</code></h1>' +
        head +
        card(null, info) +
        card(t('apps.origins'), originsBody) +
        mapSectionHtml(t('apps.scopeMaps'), t('apps.scopeMaps.help'), scopeRows, 'scope', canManage) +
        mapSectionHtml(t('apps.supScopeMaps'), t('apps.supScopeMaps.help'), supRows, 'sup', canManage) +
        mapSectionHtml(t('apps.claimMaps'), t('apps.claimMaps.help'), claimRows, 'claim', canManage) +
        card(t('apps.secret'), secretBody);

      root.querySelector('[data-edit-client]').addEventListener('click', function () {
        oauthClientDialog(root, { name: name, displayname: displayname, landing: landing });
      });
      root.querySelector('[data-del-client]').addEventListener('click', function () {
        global.Ui.confirmDialog(t('apps.delete.confirm', { name: name }), async function () {
          await global.Api.deleteOauth2Client(name);
          global.Ui.toast(t('apps.deleted'), 'success');
          global.location.hash = '#/apps';
        }, { danger: true, confirmLabel: t('common.delete') });
      });
      root.querySelector('[data-strict]').addEventListener('change', async function (ev) {
        var on = !!ev.target.checked;
        ev.target.disabled = true;
        try {
          await global.Api.updateOauth2Client(name, { oauth2_strict_redirect_uri: on ? 'true' : 'false' });
          global.Ui.toast(t('common.saved'), 'success');
        } catch (err) {
          ev.target.checked = !on;
          global.Ui.handleError(err, 'oauth2');
        } finally { ev.target.disabled = false; }
      });

      async function saveOrigins(list) {
        var attrs = {};
        if (list.length) attrs.oauth2_rs_origin = list;
        await global.Api.updateOauth2Client(name, attrs);
        Pages.appDetail(root, name);
      }
      var addO = root.querySelector('[data-origin-add]');
      addO.addEventListener('click', async function () {
        var v = root.querySelector('[data-origin-new]').value.trim();
        var r = global.Validation.httpsUrl(v, 'Redirect URL');
        if (!r.ok) { global.Ui.toast(r.message, 'error'); return; }
        if (origins.indexOf(v) >= 0) { global.Ui.toast(t('apps.origins.duplicate'), 'error'); return; }
        try { await saveOrigins(origins.concat([v])); }
        catch (err) { global.Ui.handleError(err, 'oauth2'); }
      });
      var delBtns = root.querySelectorAll('[data-origin-del]');
      for (var db = 0; db < delBtns.length; db++) {
        delBtns[db].addEventListener('click', async function () {
          var idx = Number(this.getAttribute('data-origin-del'));
          var list = origins.slice(); list.splice(idx, 1);
          try { await saveOrigins(list); }
          catch (err) { global.Ui.handleError(err, 'oauth2'); }
        });
      }
      var rev = root.querySelector('[data-reveal-secret]');
      if (rev) rev.addEventListener('click', async function () {
        rev.disabled = true;
        try {
          showOauth2SecretModal(await global.Api.getOauth2BasicSecret(name));
        } catch (err) {
          global.Ui.handleError(err, 'oauth2');
        } finally { rev.disabled = false; }
      });

      // ---- map sections (scope / sup / claim) --------------------------
      var maps = { scope: scopeRows, sup: supRows, claim: claimRows };
      async function mapRemove(section, idx) {
        var row = maps[section][idx];
        if (!row || !row.known) return;
        global.Ui.confirmDialog(t('apps.map.remove.confirm', { group: section === 'claim' ? row.claim + ' / ' + row.group : row.group }), async function () {
          if (section === 'scope') await global.Api.deleteOauth2ScopeMap(name, row.group);
          else if (section === 'sup') await global.Api.deleteOauth2SupScopeMap(name, row.group);
          else await global.Api.deleteOauth2ClaimMap(name, row.claim, row.group);
          global.Ui.toast(t('common.deleted'), 'success');
          Pages.appDetail(root, name);
        }, { danger: true, confirmLabel: t('common.delete') });
      }
      function mapDialog(section, idx) {
        var editRow = idx != null ? maps[section][idx] : null;
        var isClaim = section === 'claim';
        var groupDefault = editRow && editRow.known ? editRow.group : '';
        var scopesDefault = editRow && editRow.known ? editRow.scopes : (isClaim ? '' : 'openid profile email groups');
        var body = html`
          <form data-map-form novalidate>
            ${isClaim ? global.Ui.fieldHtml({ name: 'claim', label: t('apps.claim'), value: editRow && editRow.claim ? editRow.claim : '', required: true, readonly: !!editRow, help: t('apps.claim.help') }) : ''}
            ${global.Ui.fieldHtml({ name: 'group', label: t('apps.group'), value: groupDefault, required: true, readonly: !!editRow, help: t('apps.group.help') })}
            ${global.Ui.fieldHtml({ name: 'values', label: t('apps.values'), value: scopesDefault, required: true, help: t('apps.values.help') })}
          </form>`;
        var foot = '<button class="btn" data-cancel>' + esc(t('common.cancel')) + '</button>' +
          '<button class="btn btn-primary" data-submit>' + esc(t('common.save')) + '</button>';
        global.Ui.openModal({
          title: isClaim ? t('apps.claim.add') : t('apps.map.add'),
          body: body, footer: foot,
          onMount: function (el, close) {
            el.querySelector('[data-cancel]').addEventListener('click', close);
            el.querySelector('[data-submit]').addEventListener('click', async function () {
              var form = el.querySelector('[data-map-form]');
              var group = form.querySelector('[name=group]').value.trim();
              var valuesRaw = form.querySelector('[name=values]').value.trim();
              var claim = isClaim ? form.querySelector('[name=claim]').value.trim() : '';
              var errs = {};
              var vres = global.Validation.tokenList(valuesRaw, t('apps.values'));
              if (!vres.ok) errs.values = vres.message;
              if (global.Validation.parseTokenList(group).length !== 1) errs.group = t('apps.group.invalid');
              if (isClaim && global.Validation.parseTokenList(claim).length !== 1) errs.claim = t('apps.claim.required');
              if (Object.keys(errs).length) { global.Ui.showFieldErrors(el, errs); return; }
              var values = global.Validation.parseTokenList(valuesRaw);
              try {
                if (section === 'scope') await global.Api.setOauth2ScopeMap(name, group, values);
                else if (section === 'sup') await global.Api.setOauth2SupScopeMap(name, group, values);
                else await global.Api.setOauth2ClaimMap(name, claim, group, values);
                close();
                global.Ui.toast(t('common.saved'), 'success');
                Pages.appDetail(root, name);
              } catch (err) {
                if (err && err.status === 400 && err.message) global.Ui.toast(err.message, 'error');
                else global.Ui.handleError(err, 'oauth2');
              }
            });
          }
        });
      }
      root.addEventListener('click', function (ev) {
        var tEl = ev.target && ev.target.closest ? ev.target.closest('[data-map-add],[data-map-del],[data-map-edit]') : null;
        if (!tEl) return;
        var spec = (tEl.getAttribute('data-map-add') || tEl.getAttribute('data-map-del') || tEl.getAttribute('data-map-edit')).split(':');
        var section = spec[0], idx = spec.length > 1 ? Number(spec[1]) : null;
        if (tEl.hasAttribute('data-map-add')) mapDialog(section, null);
        else if (tEl.hasAttribute('data-map-edit')) mapDialog(section, idx);
        else if (tEl.hasAttribute('data-map-del') && !tEl.disabled) mapRemove(section, idx);
      });
    } catch (err) {
      global.Ui.handleError(err, 'oauth2');
    }
  };

  // ======================================================================
  // Service accounts — /v1/service_account* incl. API tokens.
  // Shapes verified against libs/client/src/service_account.rs and
  // proto/src/{v1/mod.rs, internal/token.rs} (identical 1.10.5 / 1.11.0).
  // ======================================================================
  function svcAccountDialog(root) {
    var body = html`
      <form data-svc-form novalidate>
        ${global.Ui.fieldHtml({ name: 'name', label: t('svc.field.name'), required: true, help: t('svc.field.name.help') })}
        ${global.Ui.fieldHtml({ name: 'displayname', label: t('svc.field.displayName'), required: true })}
        ${global.Ui.fieldHtml({ name: 'entryManagedBy', label: t('svc.field.managedBy'), required: true, placeholder: 'svc-managers', help: t('svc.field.managedBy.help') })}
      </form>`;
    var foot = '<button class="btn" data-cancel>' + esc(t('common.cancel')) + '</button>' +
      '<button class="btn btn-primary" data-submit>' + esc(t('common.save')) + '</button>';
    global.Ui.openModal({
      title: t('svc.create.title'), body: body, footer: foot,
      onMount: function (el, close) {
        el.querySelector('[data-cancel]').addEventListener('click', close);
        el.querySelector('[data-submit]').addEventListener('click', async function () {
          var form = el.querySelector('[data-svc-form]');
          var data = {
            name: form.querySelector('[name=name]').value.trim(),
            displayname: form.querySelector('[name=displayname]').value.trim(),
            entryManagedBy: form.querySelector('[name=entryManagedBy]').value.trim()
          };
          var result = global.Validation.serviceAccountForm(data);
          if (!result.ok) { global.Ui.showFieldErrors(el, result.errors); return; }
          try {
            await global.Api.createServiceAccount(data);
            close();
            global.Ui.toast(t('svc.created'), 'success');
            Pages.serviceAccounts(root);
          } catch (err) {
            if (err && err.status === 400 && err.message) global.Ui.toast(err.message, 'error');
            else global.Ui.handleError(err, 'svcaccounts');
          }
        });
      }
    });
  }

  Pages.serviceAccounts = async function (root) {
    root.setAttribute('data-page', 'svcaccounts');
    if (!global.Store.canManageServiceAccounts()) {
      root.innerHTML = '<h1 class="page-title">' + esc(t('svc.title')) + '</h1>' +
        card(null, '<p class="muted">' + esc(t('svc.denied')) + '</p>');
      return;
    }
    root.innerHTML = '<h1 class="page-title">' + esc(t('svc.title')) + '</h1>' + global.Ui.spinner();
    try {
      var items = (await global.Api.listServiceAccounts()) || [];
      items.sort(function (a, b) {
        return (global.Api.attr(a, 'name') || '').localeCompare(global.Api.attr(b, 'name') || '');
      });
      var body = '<div class="toolbar"><button class="btn btn-primary" data-new-svc>' + esc(t('svc.new')) + '</button></div>';
      if (!items.length) {
        body += card(null, '<p class="muted">' + esc(t('svc.empty')) + '</p>');
      } else {
        body += '<div class="table-wrap"><table class="table"><thead><tr>' +
          '<th>' + esc(t('svc.field.name')) + '</th><th>' + esc(t('svc.field.displayName')) + '</th>' +
          '<th>' + esc(t('svc.field.managedBy')) + '</th></tr></thead><tbody>';
        for (var i = 0; i < items.length; i++) {
          var en = items[i];
          var nm = global.Api.attr(en, 'name') || global.Api.attr(en, 'uuid') || '';
          body += '<tr><td><a href="#/svcaccounts/' + encodeURIComponent(nm) + '"><code>' + esc(nm) + '</code></a></td>' +
            '<td>' + esc(global.Api.attr(en, 'displayname') || '—') + '</td>' +
            '<td><code>' + esc(global.Api.attr(en, 'entry_managed_by') || '—') + '</code></td></tr>';
        }
        body += '</tbody></table></div>';
      }
      body += '<p class="muted">' + esc(t('svc.note')) + '</p>';
      root.innerHTML = '<h1 class="page-title">' + esc(t('svc.title')) + '</h1>' + body;
      root.querySelector('[data-new-svc]').addEventListener('click', function () { svcAccountDialog(root); });
    } catch (err) {
      global.Ui.handleError(err, 'svcaccounts');
    }
  };

  Pages.serviceAccountDetail = async function (root, name) {
    root.setAttribute('data-page', 'svcaccount');
    root.innerHTML = '<h1 class="page-title">' + esc(t('svc.detail.title')) + '</h1>' + global.Ui.spinner();
    if (!global.Store.canManageServiceAccounts()) {
      root.innerHTML = '<h1 class="page-title">' + esc(t('svc.detail.title')) + '</h1>' +
        card(null, '<p class="muted">' + esc(t('svc.denied')) + '</p>');
      return;
    }
    try {
      var en = await global.Api.getServiceAccount(name);
      var tokens = (await global.Api.listApiTokens(name)) || [];
      var displayname = global.Api.attr(en, 'displayname') || '';
      var managedBy = global.Api.attr(en, 'entry_managed_by') || '';
      var uuid = global.Api.attr(en, 'uuid') || '';

      var head = '<div class="toolbar">' +
        '<button class="btn btn-danger" data-del-svc>' + esc(t('common.delete')) + '</button></div>';
      var info = '<dl class="detail-list">' +
        '<dt>' + esc(t('svc.field.name')) + '</dt><dd><code>' + esc(name) + '</code></dd>' +
        '<dt>' + esc(t('svc.field.displayName')) + '</dt><dd>' + esc(displayname || '—') + '</dd>' +
        '<dt>' + esc(t('svc.field.managedBy')) + '</dt><dd><code>' + esc(managedBy || '—') + '</code></dd>' +
        '<dt>' + esc(t('svc.field.uuid')) + '</dt><dd><code class="muted">' + esc(uuid || '—') + '</code></dd>' +
        '</dl>';

      var tk = '<p class="muted">' + esc(t('svc.tokens.help')) + '</p>';
      if (!tokens.length) {
        tk += '<p class="muted">' + esc(t('svc.tokens.empty')) + '</p>';
      } else {
        tk += '<div class="table-wrap"><table class="table"><thead><tr><th>' + esc(t('svc.tokens.label')) + '</th>' +
          '<th>' + esc(t('svc.tokens.scope')) + '</th><th>' + esc(t('svc.tokens.issued')) + '</th>' +
          '<th>' + esc(t('svc.tokens.expiry')) + '</th><th></th></tr></thead><tbody>';
        for (var i = 0; i < tokens.length; i++) {
          var tok = tokens[i] || {};
          var rw = /write/i.test(String(tok.purpose || '')) || tok.read_write === true;
          tk += '<tr><td>' + esc(String(tok.label || '—')) + '</td>' +
            '<td><span class="badge ' + (rw ? 'badge-warn' : 'badge-ok') + '">' + esc(rw ? t('svc.tokens.rw') : t('svc.tokens.ro')) + '</span></td>' +
            '<td>' + esc(tok.issued_at ? global.Ui.formatDateTime(Number(tok.issued_at) * 1000) : '—') + '</td>' +
            '<td>' + esc(tok.expiry ? global.Ui.formatDateTime(Number(tok.expiry) * 1000) : t('svc.tokens.never')) + '</td>' +
            '<td class="row-actions"><button class="btn btn-sm btn-danger" data-token-del="' + esc(String(tok.token_id || '')) + ':' + esc(String(tok.label || '')) + '">' + esc(t('common.delete')) + '</button></td></tr>';
        }
        tk += '</tbody></table></div>';
      }
      tk += '<p><button class="btn btn-primary" data-token-new>' + esc(t('svc.tokens.new')) + '</button></p>';

      root.innerHTML = '<h1 class="page-title">' + esc(t('svc.detail.title')) + ': <code>' + esc(name) + '</code></h1>' +
        head + card(null, info) + card(t('svc.tokens'), tk);

      root.querySelector('[data-del-svc]').addEventListener('click', function () {
        global.Ui.confirmDialog(t('svc.delete.confirm', { name: name }), async function () {
          await global.Api.deleteServiceAccount(name);
          global.Ui.toast(t('svc.deleted'), 'success');
          global.location.hash = '#/svcaccounts';
        }, { danger: true, confirmLabel: t('common.delete') });
      });
      var delTokBtns = root.querySelectorAll('[data-token-del]');
      for (var dt = 0; dt < delTokBtns.length; dt++) {
        delTokBtns[dt].addEventListener('click', function () {
          var parts = this.getAttribute('data-token-del').split(':');
          var tokenId = parts[0], label = parts.slice(1).join(':');
          if (!tokenId) return;
          global.Ui.confirmDialog(t('svc.tokens.delete.confirm', { label: label }), async function () {
            await global.Api.deleteApiToken(name, tokenId);
            global.Ui.toast(t('common.deleted'), 'success');
            Pages.serviceAccountDetail(root, name);
          }, { danger: true, confirmLabel: t('common.delete') });
        });
      }
      root.querySelector('[data-token-new]').addEventListener('click', function () {
        var body = html`
          <form data-token-form novalidate>
            ${global.Ui.fieldHtml({ name: 'label', label: t('svc.tokens.label'), required: true, placeholder: 'ci-deploy', help: t('svc.tokens.label.help') })}
            ${global.Ui.fieldHtml({ name: 'expiry', label: t('svc.tokens.expiry'), type: 'date', help: t('svc.tokens.expiry.help') })}
            <div class="field"><label class="check"><input type="checkbox" name="readWrite" /> ${esc(t('svc.tokens.rwAsk'))}</label>
              <p class="help">${esc(t('svc.tokens.rwHelp'))}</p></div>
            <div class="field"><label class="check"><input type="checkbox" name="compact" /> ${esc(t('svc.tokens.compact'))}</label>
              <p class="help">${esc(t('svc.tokens.compact.help'))}</p></div>
          </form>`;
        var foot = '<button class="btn" data-cancel>' + esc(t('common.cancel')) + '</button>' +
          '<button class="btn btn-primary" data-submit>' + esc(t('svc.tokens.issue')) + '</button>';
        global.Ui.openModal({
          title: t('svc.tokens.new'), body: body, footer: foot,
          onMount: function (el, close) {
            el.querySelector('[data-cancel]').addEventListener('click', close);
            el.querySelector('[data-submit]').addEventListener('click', async function () {
              var form = el.querySelector('[data-token-form]');
              var data = {
                label: form.querySelector('[name=label]').value.trim(),
                expiry: form.querySelector('[name=expiry]').value,
                readWrite: form.querySelector('[name=readWrite]').checked,
                compact: form.querySelector('[name=compact]').checked
              };
              var result = global.Validation.apiTokenForm(data);
              if (!result.ok) { global.Ui.showFieldErrors(el, result.errors); return; }
              var expirySecs = data.expiry
                ? Math.floor((new Date(data.expiry + 'T23:59:59').getTime()) / 1000) : null;
              try {
                var fullToken = await global.Api.generateApiToken(name, {
                  label: data.label, expiry: expirySecs,
                  readWrite: data.readWrite, compact: data.compact
                });
                close();
                var tok = String(fullToken || '');
                var shown = tok
                  ? '<p><strong>' + esc(t('svc.tokens.once')) + '</strong></p>' +
                    '<p><code class="break-all">' + esc(tok) + '</code></p>' +
                    '<button class="btn" data-copy-token>' + esc(t('common.copy')) + '</button>' +
                    (qrSvg(tok) ? '<p class="muted">' + esc(t('svc.tokens.scan')) + '</p><div class="qr-box">' + qrSvg(tok) + '</div>' : '')
                  : '<p class="error-text">' + esc(t('svc.tokens.emptyResponse')) + '</p>';
                var m = global.Ui.openModal({ title: t('svc.tokens.issued'), body: shown, wide: true, sticky: true });
                var cb = m.el.querySelector('[data-copy-token]');
                if (cb) cb.addEventListener('click', function () { global.Ui.copyText(tok); });
                Pages.serviceAccountDetail(root, name);
              } catch (err) {
                if (err && err.status === 400 && err.message) global.Ui.toast(err.message, 'error');
                else global.Ui.handleError(err, 'svcaccounts');
              }
            });
          }
        });
      });
    } catch (err) {
      global.Ui.handleError(err, 'svcaccounts');
    }
  };

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
        if (!global.ShenaConfig.isSafeHttpUrl(global.ShenaConfig.oauthBase())) {
          global.Ui.toast('Configure a valid https API URL first.', 'error');
          return;
        }
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
        var resetBase = global.ShenaConfig.oauthBase();
        var resetUrl = global.ShenaConfig.isSafeHttpUrl(resetBase) ? resetBase + '/ui/reset' : '';
        global.Ui.openModal({
          title: t('profile.changePassword'),
          body: '<p>Password changes are performed in Kanidm\u2019s own credential-update UI so credentials never pass through Shenasa:</p>' +
            (resetUrl
              ? '<p><a class="btn btn-primary" href="' + esc(resetUrl) + '" target="_blank" rel="noopener noreferrer">Open Kanidm credential reset</a></p>'
              : '<p class="error-text">Configure a valid https API URL first.</p>')
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

    // Live server compatibility (populated from X-KANIDM-VERSION once any
    // API call has happened; refreshed after the connection test too).
    var compat = global.Store.serverCompat();
    var compatBadge =
      compat === 'supported' ? '<span class="badge badge-ok">' + esc(t('settings.compat.supported')) + '</span>' :
      compat === 'unsupported' ? '<span class="badge badge-warn">' + esc(t('settings.compat.unsupported')) + '</span>' :
      '<span class="badge">' + esc(t('settings.compat.unknown')) + '</span>';
    var serverRow = '<div class="field" data-server-version-row><label class="label">' +
      esc(t('settings.serverVersion')) + '</label><div>' +
      '<code data-server-version>' + esc(global.Store.serverVersion || '—') + '</code> ' + compatBadge +
      '<p class="help">' + esc(t('settings.serverVersion.help')) + ' ' +
      esc(global.Store.SUPPORTED_KANIDM_LABEL) + '</p></div></div>';

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
        ${global.Ui.fieldHtml({ name: 'locale', label: t('settings.locale'), value: cfg.locale || '', help: t('settings.locale.help'),
          input: '<input class="input" type="text" name="locale" maxlength="20" value="' + esc(cfg.locale || '') + '" placeholder="en" />' })}
        ${global.App && global.App.localePackError && global.App.localePackError() ? '<p class="error-text">' + esc(t('settings.locale.missing')) + ' (' + esc(global.App.localePackError().message) + ')</p>' : ''}
        <p class="muted">${esc(t('settings.note'))}</p>
      </form>`;

    root.innerHTML = '<h1 class="page-title">' + esc(t('settings.title')) + '</h1>' +
      card(null, body + serverRow +
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
        idleTimeoutMin: form.querySelector('[name=idleTimeoutMin]').value.trim(),
        locale: form.querySelector('[name=locale]').value.trim()
      };
      if (!map.apiUrl) {
        global.Ui.toast('API URL is required.', 'error');
        return;
      }
      if (!global.ShenaConfig.isSafeHttpUrl(map.apiUrl) ||
          !global.ShenaConfig.isSafeHttpUrl(map.oidcRedirectUri)) {
        global.Ui.toast('API URL and redirect URI must be https (http://localhost is allowed).', 'error');
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
      // A locale change only takes effect at boot — reload so it applies.
      if (map.locale !== (cfg.locale || '') && global.location && global.location.reload) {
        global.location.reload();
      }
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
        // The version middleware stamps every response; refresh the
        // compatibility row with the freshest value.
        var kv2 = res.headers && typeof res.headers.get === 'function' ?
          res.headers.get('x-kanidm-version') : null;
        if (kv2) {
          global.Store.setServerVersion(kv2);
          var vrow = root.querySelector('[data-server-version]');
          if (vrow) vrow.textContent = global.Store.serverVersion;
          var vbadge = root.querySelector('[data-server-version-row] .badge');
          if (vbadge) {
            var c2 = global.Store.serverCompat();
            vbadge.textContent = t('settings.compat.' + c2);
            vbadge.className = 'badge ' + (c2 === 'supported' ? 'badge-ok' :
              c2 === 'unsupported' ? 'badge-warn' : '');
          }
        }
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

    // ---- v1.3: Domain settings (domain_admins ONLY) -------------------------
    // idm_acp_domain_admin receiver = UUID_DOMAIN_ADMINS (dl14/dl15
    // access.rs) — idm_admins is NOT a member. Writable attrs verified:
    // domain_display_name, domain_allow_account_recovery (PUT body is a
    // bare Vec<String>, booleans as "true"/"false").
    if (global.Store.canDomainAdmin && global.Store.canDomainAdmin()) {
      try {
        var dom = await global.Api.getDomain();
        var curName = global.Api.attr(dom, 'domain_display_name') || '';
        var curRecovery = String(global.Api.attr(dom, 'domain_allow_account_recovery') || '');
        var domCard = card(t('settings.domain.title'),
          '<form data-domain-form novalidate>' +
          global.Ui.fieldHtml({ name: 'domainDisplayName', label: t('settings.domain.displayName'), value: curName }) +
          '<label class="check"><input type="checkbox" name="allowRecovery"' + (curRecovery === 'true' ? ' checked' : '') + ' data-allow-recovery /> ' +
          esc(t('settings.domain.allowRecovery')) + '</label>' +
          '<p class="help">' + esc(t('settings.domain.allowRecovery.help')) + '</p>' +
          '<div class="btn-row"><button class="btn btn-primary" data-domain-save>' + esc(t('common.save')) + '</button></div>' +
          '</form>');
        root.insertAdjacentHTML('beforeend', domCard);

        root.querySelector('[data-domain-save]').addEventListener('click', async function () {
          var dForm = root.querySelector('[data-domain-form]');
          var newName = dForm.querySelector('[name=domainDisplayName]').value.trim();
          var newRecovery = dForm.querySelector('[data-allow-recovery]').checked ? 'true' : 'false';
          var check = global.Validation.domainSettingsForm({ domainDisplayName: newName });
          if (!check.ok) { global.Ui.showFieldErrors(dForm, check.errors); return; }
          try {
            if (newName !== curName) await global.Api.putDomainAttr('domain_display_name', [newName]);
            if (newRecovery !== curRecovery) await global.Api.putDomainAttr('domain_allow_account_recovery', [newRecovery]);
            curName = newName; curRecovery = newRecovery;
            global.Ui.toast(t('settings.domain.saved'), 'success');
          } catch (err) {
            global.Ui.handleError(err, 'domain');
          }
        });
      } catch (err) {
        // Domain read denied even to domain_admins lookups — silently omit
        // the card (same pattern as the dashboard domain stat).
      }
    }
  };


  // ======================================================================
  // Governance reports (all client-side over live API reads)
  // ======================================================================
  var reportsState = { people: null, groups: null };

  async function reportsData() {
    if (!reportsState.people) {
      var results = await Promise.all([global.Api.listPeople(), global.Api.listGroups()]);
      reportsState.people = results[0] || [];
      reportsState.groups = results[1] || [];
    }
    return reportsState;
  }

  // Pure helpers (exposed for tests via ShenaReports).
  function parseGroupExport(json, fileName) {
    var data = typeof json === 'string' ? JSON.parse(json) : json;
    var arr = data && data.groups ? data.groups : (Array.isArray(data) ? data : null);
    if (!arr) throw new Error(t('reports.diff.badFile', { file: fileName || 'file' }));
    var out = {};
    for (var i = 0; i < arr.length; i++) {
      var g = arr[i] || {};
      var name = g.name || (g.attrs && global.Api.attr(g, 'name')) || '';
      if (!name) continue;
      var members = g.members || (g.attrs ? global.Api.attrs(g, 'member') : []) || [];
      var set = {};
      for (var m = 0; m < members.length; m++) set[global.Store.stripDomain(String(members[m]))] = true;
      out[name] = set;
    }
    return out;
  }

  function diffGroupExports(oldExp, newExp) {
    var rows = [];
    var names = {};
    var n;
    for (n in oldExp) names[n] = true;
    for (n in newExp) names[n] = true;
    for (n in names) {
      if (!Object.prototype.hasOwnProperty.call(names, n)) continue;
      var added = [], removed = [];
      var o = oldExp[n] || {};
      var w = newExp[n] || {};
      var m;
      for (m in w) if (Object.prototype.hasOwnProperty.call(w, m) && !o[m]) added.push(m);
      for (m in o) if (Object.prototype.hasOwnProperty.call(o, m) && !w[m]) removed.push(m);
      var note = '';
      if (!oldExp[n]) note = 'reports.diff.groupOnlyNew';
      else if (!newExp[n]) note = 'reports.diff.groupOnlyOld';
      if (added.length || removed.length || note) {
        rows.push({ group: n, added: added.sort(), removed: removed.sort(), note: note });
      }
    }
    rows.sort(function (a, b) { return a.group.localeCompare(b.group); });
    return rows;
  }

  // Credential-status classification per the serde enum in
  // proto/src/internal/credupdate.rs: "Password" / "GeneratedPassword" /
  // { "Passkey": [...] } / { "PasswordMfa": [...] }.
  function credClass(credStatus) {
    var creds = credStatus && credStatus.creds ? credStatus.creds : [];
    if (!creds.length) return 'none';
    var passkeys = 0;
    for (var i = 0; i < creds.length; i++) {
      var ty = creds[i] && creds[i].type_;
      if (ty === 'Passkey' || (ty && typeof ty === 'object' && Object.prototype.hasOwnProperty.call(ty, 'Passkey'))) passkeys++;
    }
    if (passkeys === creds.length) return 'passkeyOnly';
    return passkeys > 0 ? 'withPasskey' : 'noPasskey';
  }

  Pages.reports = async function (root) {
    reportsState.people = null;
    root.innerHTML = '<h1 class="page-title">' + esc(t('reports.title')) + '</h1>' +
      '<p class="muted">' + esc(t('reports.help')) + '</p>' +
      '<div class="grid-2">' +
      card(t('reports.expiring.title'), html`
        <div class="report-controls">
          ${global.Ui.fieldHtml({ name: 'expDays', label: t('reports.expiring.days'), type: 'number', value: '30' })}
          <button class="btn btn-primary" data-exp-run>${esc(t('reports.expiring.run'))}</button>
          <button class="btn" data-exp-csv disabled>${esc(t('reports.expiring.export'))}</button>
        </div>
        <div data-exp-out></div>`) +
      card(t('reports.diff.title'), html`
        <p class="help">${esc(t('reports.diff.help'))}</p>
        ${global.Ui.fieldHtml({ name: 'diffOld', label: t('reports.diff.old'), input: '<input class="input" type="file" name="diffOld" accept=".json,application/json"/>' })}
        ${global.Ui.fieldHtml({ name: 'diffNew', label: t('reports.diff.new'), input: '<input class="input" type="file" name="diffNew" accept=".json,application/json"/>' })}
        <div class="btn-row"><button class="btn btn-primary" data-diff-run>${esc(t('reports.diff.run'))}</button></div>
        <div data-diff-out></div>`) +
      '</div>' +
      card(t('reports.passkey.title'), html`
        <p class="help">${esc(t('reports.passkey.help'))}</p>
        <div class="report-controls">
          <select class="input" data-pk-group aria-label="${esc(t('reports.passkey.group'))}"><option value="">—</option></select>
          <button class="btn btn-primary" data-pk-run>${esc(t('reports.passkey.run'))}</button>
          <span class="muted" data-pk-progress></span>
        </div>
        <div data-pk-out></div>`);

    function readFileText(input) {
      return new Promise(function (resolve, reject) {
        var f = input.files && input.files[0];
        if (!f) { reject(new Error('no file')); return; }
        var reader = new global.FileReader();
        reader.onload = function () { resolve(String(reader.result || '')); };
        reader.onerror = function () { reject(new Error('read error')); };
        reader.readAsText(f);
      });
    }

    // ---- Accounts expiring within N days --------------------------------
    var lastExpiring = [];
    root.querySelector('[data-exp-run]').addEventListener('click', async function () {
      var out = root.querySelector('[data-exp-out]');
      var days = parseInt(root.querySelector('[name=expDays]').value, 10);
      if (!isFinite(days) || days < 0 || days > 3650) days = 30;
      out.innerHTML = global.Ui.spinner();
      try {
        var data = await reportsData();
        var now = Date.now();
        lastExpiring = [];
        for (var i = 0; i < data.people.length; i++) {
          var p = data.people[i];
          var exp = global.Api.attr(p, 'account_expire');
          if (!exp) continue;
          var ms = Date.parse(String(exp));
          if (isNaN(ms)) continue;
          var daysLeft = Math.ceil((ms - now) / 86400000);
          if (daysLeft > days) continue;
          lastExpiring.push({ name: global.Api.attr(p, 'name') || '', expires: String(exp), daysLeft: daysLeft });
        }
        lastExpiring.sort(function (a, b) { return a.daysLeft - b.daysLeft; });
        if (!lastExpiring.length) {
          out.innerHTML = '<p class="muted">' + esc(t('reports.expiring.none', { n: days })) + '</p>';
        } else {
          var rowsH = '';
          for (var r = 0; r < lastExpiring.length; r++) {
            var e = lastExpiring[r];
            rowsH += '<tr><td><a class="link" href="#/users/' + encodeURIComponent(e.name) + '">' + esc(e.name) + '</a></td>' +
              '<td>' + esc(global.Ui.formatDate(e.expires)) + '</td>' +
              '<td>' + (e.daysLeft < 0 ? '<span class="chip chip-danger">' + esc(t('reports.expired')) + '</span>'
                : esc(String(e.daysLeft))) + '</td></tr>';
          }
          out.innerHTML = '<table class="table"><thead><tr>' +
            '<th scope="col">' + esc(t('reports.expiring.col.name')) + '</th>' +
            '<th scope="col">' + esc(t('reports.expiring.col.expires')) + '</th>' +
            '<th scope="col">' + esc(t('reports.expiring.col.daysLeft')) + '</th></tr></thead><tbody>' +
            rowsH + '</tbody></table>';
        }
        root.querySelector('[data-exp-csv]').disabled = lastExpiring.length === 0;
      } catch (err) {
        out.innerHTML = '';
        global.Ui.handleError(err, 'people');
      }
    });
    root.querySelector('[data-exp-csv]').addEventListener('click', function () {
      if (!lastExpiring.length) return;
      var lines = ['name,expires,days_left'];
      function csvCell(v) {
        v = String(v == null ? '' : v);
        if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;
        return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
      }
      for (var i = 0; i < lastExpiring.length; i++) {
        var e = lastExpiring[i];
        lines.push(csvCell(e.name) + ',' + csvCell(global.Ui.formatDate(e.expires)) + ',' + csvCell(e.daysLeft));
      }
      global.Ui.download('shenasa-expiring.csv', lines.join('\n'), 'text/csv');
    });

    // ---- Passkey-only adoption per group --------------------------------
    var pkSel = root.querySelector('[data-pk-group]');
    try {
      var d0 = await reportsData();
      var gnames = [];
      for (var gi = 0; gi < d0.groups.length; gi++) {
        var gnm = global.Api.attr(d0.groups[gi], 'name') || '';
        if (gnm) gnames.push(gnm);
      }
      gnames.sort();
      for (var go = 0; go < gnames.length; go++) {
        var opt = global.document.createElement('option');
        opt.value = gnames[go]; opt.textContent = gnames[go];
        pkSel.appendChild(opt);
      }
    } catch (e) { /* group list stays empty; Run will surface the error */ }

    root.querySelector('[data-pk-run]').addEventListener('click', async function () {
      var groupName = pkSel.value;
      if (!groupName) return;
      var out = root.querySelector('[data-pk-out]');
      var prog = root.querySelector('[data-pk-progress]');
      var run = root.querySelector('[data-pk-run]');
      run.disabled = true;
      out.innerHTML = global.Ui.spinner();
      try {
        var data = await reportsData();
        var grp = null;
        for (var i = 0; i < data.groups.length; i++) {
          if ((global.Api.attr(data.groups[i], 'name') || '') === groupName) { grp = data.groups[i]; break; }
        }
        if (!grp) throw new Error('group not found');
        var peopleSet = {};
        for (i = 0; i < data.people.length; i++) {
          var pn = global.Api.attr(data.people[i], 'name') || '';
          if (pn) peopleSet[pn] = true;
        }
        var members = global.Api.attrs(grp, 'member').map(global.Store.stripDomain);
        var persons = [], nonPerson = 0;
        for (i = 0; i < members.length; i++) {
          if (peopleSet[members[i]]) persons.push(members[i]); else nonPerson++;
        }
        var stats = { passkeyOnly: 0, withPasskey: 0, noPasskey: 0, none: 0, restricted: 0 };
        var perRow = [];
        var done = 0;
        prog.textContent = t('reports.passkey.progress', { done: 0, total: persons.length });
        // Bounded-concurrency fan-out (4 at a time) — one credential-status
        // read per person, exactly as the roadmap scoped this report.
        var idx = 0;
        async function worker() {
          while (idx < persons.length) {
            var my = idx++;
            var name = persons[my];
            try {
              var st = await global.Api.getCredentialStatus(name);
              var cls = credClass(st);
              stats[cls]++;
              perRow.push({ name: name, cls: cls });
            } catch (err) {
              if (err && err.status === 403) {
                stats.restricted++;
                perRow.push({ name: name, cls: 'restricted' });
              } else {
                throw err;
              }
            }
            done++;
            prog.textContent = t('reports.passkey.progress', { done: done, total: persons.length });
          }
        }
        await Promise.all([worker(), worker(), worker(), worker()]);
        perRow.sort(function (a, b) { return a.name.localeCompare(b.name); });
        var statKeys = ['passkeyOnly', 'withPasskey', 'noPasskey', 'none', 'restricted'];
        var chips = '';
        for (var sk = 0; sk < statKeys.length; sk++) {
          chips += '<span class="chip chip-stat">' + esc(t('reports.passkey.stat.' + statKeys[sk])) +
            ': <strong>' + stats[statKeys[sk]] + '</strong></span> ';
        }
        var rowsH = '';
        for (var pr = 0; pr < perRow.length; pr++) {
          rowsH += '<tr><td><a class="link" href="#/users/' + encodeURIComponent(perRow[pr].name) + '">' +
            esc(perRow[pr].name) + '</a></td>' +
            '<td>' + esc(t('reports.passkey.stat.' + perRow[pr].cls)) + '</td></tr>';
        }
        out.innerHTML = '<p class="muted">' + esc(t('reports.passkey.persons', { n: persons.length })) +
          (nonPerson ? ' ' + esc(t('reports.passkey.nonPerson', { n: nonPerson })) : '') + '</p>' +
          '<div class="chip-row">' + chips + '</div>' +
          (rowsH ? '<table class="table"><thead><tr><th scope="col">' + esc(t('gimport.col.member')) + '</th>' +
            '<th scope="col">' + esc(t('reports.passkey.col.class')) + '</th></tr></thead><tbody>' +
            rowsH + '</tbody></table>' : '');
        prog.textContent = '';
      } catch (err) {
        out.innerHTML = '';
        prog.textContent = '';
        global.Ui.handleError(err, 'people');
      } finally {
        run.disabled = false;
      }
    });

    // ---- Membership diff of two exports ---------------------------------
    root.querySelector('[data-diff-run]').addEventListener('click', async function () {
      var out = root.querySelector('[data-diff-out]');
      out.innerHTML = '';
      try {
        var oldIn = root.querySelector('[name=diffOld]');
        var newIn = root.querySelector('[name=diffNew]');
        var oldTxt = await readFileText(oldIn);
        var newTxt = await readFileText(newIn);
        var rows = diffGroupExports(
          parseGroupExport(oldTxt, oldIn.files[0].name),
          parseGroupExport(newTxt, newIn.files[0].name));
        if (!rows.length) {
          out.innerHTML = '<p class="muted">' + esc(t('reports.diff.noChanges')) + '</p>';
          return;
        }
        var rowsH = '';
        for (var i = 0; i < rows.length; i++) {
          var r = rows[i];
          rowsH += '<tr><td>' + esc(r.group) +
            (r.note ? ' <span class="muted">(' + esc(t(r.note)) + ')</span>' : '') + '</td>' +
            '<td>' + esc(r.added.join(', ') || '—') + '</td>' +
            '<td>' + esc(r.removed.join(', ') || '—') + '</td></tr>';
        }
        out.innerHTML = '<table class="table"><thead><tr><th scope="col">' + esc(t('reports.diff.col.group')) + '</th>' +
          '<th scope="col">' + esc(t('reports.diff.col.added')) + '</th>' +
          '<th scope="col">' + esc(t('reports.diff.col.removed')) + '</th></tr></thead><tbody>' +
          rowsH + '</tbody></table>';
      } catch (err) {
        global.Ui.toast(err && err.message ? err.message : String(err), 'error');
      }
    });
  };

  // Pure helpers, exported for the self-test suite (and embedders).
  global.ShenaReports = {
    parseGroupExport: parseGroupExport,
    diffGroupExports: diffGroupExports,
    credClass: credClass,
    membershipImportPlan: membershipImportPlan
  };

  global.Pages = Pages;
})(typeof window !== 'undefined' ? window : globalThis);
