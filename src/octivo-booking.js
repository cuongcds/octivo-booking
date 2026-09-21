/**
 * Octivo Booking — embeddable booking widget for any `type=website`
 * channel. Self-contained: injects its own CSS + DOM into the host page,
 * so it can be dropped into any third-party site via a single <script>
 * tag served from the Octivo CDN.
 *
 * Flow: choose branch (skipped if the org has only one) -> choose service
 * -> choose staff (optional) -> choose date/time -> confirm, plus a list of
 * the guest's existing reservations with cancel.
 *
 * Display: on desktop, a modal centered on screen with a full-screen
 * toggle in the header; on mobile, always full-screen (no toggle).
 *
 * Usage:
 *   <script src="https://cdn.octivo.example/octivo-booking.js" data-channel="@abc123" async></script>
 *   // optional, any time after the script tag:
 *   window.OctivoBooking.init({
 *     name: 'Jane', phone: '0901234567',
 *     showBubble: false,        // hide the floating button; open() from your own UI instead
 *     onClose: function () {},  // fired whenever the popup is closed
 *   });
 *   document.querySelector('#my-booking-button').addEventListener('click', OctivoBooking.open);
 *   window.addEventListener('octivobooking:close', function (e) { ... });
 *
 * API host: defaults to https://octivo.shplinks.com. Override via
 * data-host="https://your-crm.example.com" on the <script> tag, or
 * init({ host: 'https://your-crm.example.com' }).
 */
(function (global, document) {
  'use strict';

  var DEFAULT_API_HOST = 'https://octivo.shplinks.com';
  var CSS_HREF = currentScriptBase() + 'octivo-booking.css';
  var API_BASE = currentScriptOrigin();
  var LS_PREFIX = 'octivo_booking_';

  // Slot generation — mirrors the server-rendered booking theme's defaults
  // (application/views/themes/booking/index.php), re-implemented here rather
  // than shared, since that theme's logic is inline and DOM-coupled.
  var WORK_START_MIN = 8 * 60;
  var WORK_END_MIN = 20 * 60;
  var LUNCH_START_MIN = 12 * 60;
  var LUNCH_END_MIN = 13 * 60;
  var SLOT_STEP_MIN = 30;
  var DAYS_AHEAD = 14;

  var state = {
    channelSourceId: '',
    orgId: '',
    config: null,
    appUserCode: '',
    chatId: '',
    accessToken: '',
    open: false,
    ready: false,
    showBubble: true,
    onClose: null,
    fullscreen: false,
    pendingInit: null,
    view: 'branch', // branch | service | staff | datetime | confirm | list
    branches: [],
    services: [],
    staff: [],
    selected: {
      branchId: '',
      serviceId: '',
      staffId: '',
      date: '',
      time: '',
    },
    reservations: [],
  };

  function currentScriptBase() {
    var src = document.currentScript ? document.currentScript.src : '';
    if (!src) return '';
    return src.slice(0, src.lastIndexOf('/') + 1);
  }

  function currentScriptOrigin() {
    var src = document.currentScript ? document.currentScript.src : '';
    if (!src) return '';
    try {
      return new URL(src).origin;
    } catch (e) {
      return '';
    }
  }

  /** data-host="https://your-crm.example.com" on the <script> tag, for sites that only use the auto-init (no manual init() call). */
  function readHostDataAttr() {
    var el = document.currentScript || document.querySelector('script[data-channel]');
    return el ? (el.getAttribute('data-host') || '') : '';
  }

  function resolveApiBase(options) {
    var host = (options && options.host) || readHostDataAttr() || API_BASE || DEFAULT_API_HOST;
    return String(host).replace(/\/+$/, '');
  }

  function $(sel, root) {
    return (root || document).querySelector(sel);
  }
  function $all(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }

  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatMoney(amount) {
    var n = Number(amount) || 0;
    return n.toLocaleString('vi-VN') + '₫';
  }

  function formatDateLabel(d) {
    var days = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
    return days[d.getDay()] + ' ' + String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0');
  }

  function formatMinutes(min) {
    var h = Math.floor(min / 60);
    var m = min % 60;
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  }

  /**
   * Black or white, whichever reads better on top of the given hex color.
   * Same relative-luminance approach as octivo-chat.js's contrastColorFor().
   */
  function contrastColorFor(hex) {
    var match = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!match) return '#fff';
    var value = match[1];
    var r = parseInt(value.slice(0, 2), 16) / 255;
    var g = parseInt(value.slice(2, 4), 16) / 255;
    var b = parseInt(value.slice(4, 6), 16) / 255;
    var luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return luminance > 0.6 ? '#182433' : '#fff';
  }

  // ---- localStorage helpers (namespaced per org, distinct from octivo_chat_* and GuestProfile's salon_*) ----

  function lsGet(key) {
    try { return localStorage.getItem(LS_PREFIX + key) || ''; } catch (e) { return ''; }
  }
  function lsSet(key, value) {
    try { localStorage.setItem(LS_PREFIX + key, value); } catch (e) { /* ignore */ }
  }

  function orgKey(suffix) {
    return 'org_' + state.orgId + '_' + suffix;
  }

  function loadStoredSession() {
    state.appUserCode = lsGet('app_user_code');
    state.chatId = lsGet(orgKey('chat_id'));
    state.accessToken = lsGet(orgKey('access_token'));
  }

  function storeSession() {
    if (state.appUserCode) lsSet('app_user_code', state.appUserCode);
    if (state.chatId) lsSet(orgKey('chat_id'), state.chatId);
    if (state.accessToken) lsSet(orgKey('access_token'), state.accessToken);
  }

  function hasStoredSession() {
    return !!(state.appUserCode && state.chatId && state.accessToken);
  }

  // ---- Validation (same rules as octivo-chat.js / assets/salon/js/guest-profile.js) ----

  function validateName(name) {
    var n = (name || '').trim();
    return n.length >= 2 && n.length <= 80;
  }

  function normalizePhone(raw) {
    var d = String(raw || '').replace(/\D/g, '').replace(/^84/, '0');
    return d.indexOf('0') === 0 ? d : '0' + d;
  }

  function validatePhone(phone) {
    return /^0[3-9]\d{8}$/.test(phone);
  }

  // ---- Network ----

  function apiUrl(path) {
    return (API_BASE || '') + path;
  }

  function authHeaders() {
    return state.accessToken ? { Authorization: 'Bearer ' + state.accessToken } : {};
  }

  function fetchConfig() {
    return fetch(apiUrl('/embed/@' + state.channelSourceId + '/booking-catalog'), { credentials: 'omit' })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data.success) throw new Error(data.error_message || 'Widget config not found');
        state.orgId = String(data.organization_id);
        state.config = data;
        state.branches = data.branches || [];
        state.services = data.services || [];
        return data;
      });
  }

  function saveInformation(name, phone) {
    var payload = new URLSearchParams();
    payload.set('name', name);
    payload.set('phone', phone);
    if (state.appUserCode) payload.set('code', state.appUserCode);
    return fetch(apiUrl('/save-information'), {
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: payload.toString(),
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok || !data.success) throw new Error(data.error_message || 'Could not save information');
        return data;
      });
    });
  }

  function touchOrganization() {
    var params = new URLSearchParams();
    params.set('app_user_code', state.appUserCode);
    params.set('organization_id', state.orgId);
    return fetch(apiUrl('/touch-organization') + '?' + params.toString(), { credentials: 'omit' })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data.success) throw new Error(data.error_message || 'Could not start session');
        state.chatId = data.chat_id || '';
        state.accessToken = data.access_token || '';
        storeSession();
        return data;
      });
  }

  function fetchStaff(branchId, serviceId) {
    var params = new URLSearchParams();
    params.set('branch', branchId);
    params.set('service', serviceId);
    return fetch(apiUrl('/salon-booking/staff') + '?' + params.toString(), { credentials: 'omit' })
      .then(function (res) { return res.json(); })
      .then(function (data) { return data.staff || []; })
      .catch(function () { return []; });
  }

  function fetchReservations() {
    var params = new URLSearchParams();
    params.set('app_user_code', state.appUserCode);
    params.set('organization_id', state.orgId);
    return fetch(apiUrl('/salon-booking/reservations') + '?' + params.toString(), {
      credentials: 'omit',
      headers: authHeaders(),
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data.success) throw new Error(data.error_message || 'Could not load reservations');
        return data.reservations || [];
      });
  }

  function createReservation() {
    var sel = state.selected;
    var bookedAt = Math.floor(new Date(sel.date + 'T' + sel.time + ':00').getTime() / 1000);
    return fetch(apiUrl('/salon-booking/reserve'), {
      method: 'POST',
      credentials: 'omit',
      headers: Object.assign({ 'Content-Type': 'application/json;charset=UTF-8' }, authHeaders()),
      body: JSON.stringify({
        app_user_code: state.appUserCode,
        organization_id: state.orgId,
        branch_id: sel.branchId,
        product_id: sel.serviceId,
        staff_id: sel.staffId || 0,
        booked_at: bookedAt,
      }),
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok || !data.success) throw new Error(data.error_message || 'Could not create reservation');
        return data.reservation;
      });
    });
  }

  function cancelReservation(id) {
    return fetch(apiUrl('/salon-booking/reservations/' + id + '/cancel'), {
      method: 'POST',
      credentials: 'omit',
      headers: Object.assign({ 'Content-Type': 'application/json;charset=UTF-8' }, authHeaders()),
      body: JSON.stringify({ app_user_code: state.appUserCode }),
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok || !data.success) throw new Error(data.error_message || 'Could not cancel reservation');
        return data.reservation;
      });
    });
  }

  // ---- Slot generation ----

  function buildDateOptions() {
    var days = [];
    var now = new Date();
    for (var i = 0; i < DAYS_AHEAD; i++) {
      var d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
      days.push(d);
    }
    return days;
  }

  function buildTimeSlots(date) {
    var slots = [];
    var now = new Date();
    var isToday = date.toDateString() === now.toDateString();
    var nowMin = now.getHours() * 60 + now.getMinutes();
    for (var min = WORK_START_MIN; min < WORK_END_MIN; min += SLOT_STEP_MIN) {
      if (min >= LUNCH_START_MIN && min < LUNCH_END_MIN) continue;
      if (isToday && min <= nowMin) continue;
      slots.push(min);
    }
    return slots;
  }

  // ---- DOM ----

  function injectCss() {
    if (document.querySelector('link[data-octivo-booking-css]')) return;
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = CSS_HREF;
    link.setAttribute('data-octivo-booking-css', '1');
    document.head.appendChild(link);
  }

  function buildDom() {
    if ($('.octivo-booking-root')) return;

    var root = document.createElement('div');
    root.className = 'octivo-booking-root';
    root.innerHTML =
      '<button type="button" class="octivo-booking-fab octivo-booking-fab--right octivo-booking-hidden" id="octivoBookingFab" aria-label="Đặt lịch">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>' +
      '</button>' +
      '<div class="octivo-booking-panel octivo-booking-hidden" id="octivoBookingPanel" aria-hidden="true">' +
        '<div class="octivo-booking-panel__backdrop" id="octivoBookingBackdrop"></div>' +
        '<div class="octivo-booking-panel__sheet" role="dialog" aria-label="Đặt lịch">' +
          '<header class="octivo-booking-panel__header">' +
            '<button type="button" class="octivo-booking-icon-btn octivo-booking-back-btn octivo-booking-hidden" id="octivoBookingBack" aria-label="Quay lại">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>' +
            '</button>' +
            '<div class="octivo-booking-panel__title-wrap"><h2 id="octivoBookingTitle">Đặt lịch</h2><p class="octivo-booking-panel__sub" id="octivoBookingSubtitle"></p></div>' +
            '<div class="octivo-booking-panel__header-actions">' +
              '<button type="button" class="octivo-booking-icon-btn octivo-booking-fullscreen-btn" id="octivoBookingFullscreen" aria-label="Full screen" title="Mở rộng toàn màn hình">' +
                '<svg class="octivo-booking-icon-expand" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 9V5a1 1 0 011-1h4M20 9V5a1 1 0 00-1-1h-4M4 15v4a1 1 0 001 1h4M20 15v4a1 1 0 01-1 1h-4"/></svg>' +
                '<svg class="octivo-booking-icon-collapse octivo-booking-hidden" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 4v4a1 1 0 01-1 1H4M15 4v4a1 1 0 001 1h4M9 20v-4a1 1 0 00-1-1H4M15 20v-4a1 1 0 011-1h4"/></svg>' +
              '</button>' +
              '<button type="button" class="octivo-booking-icon-btn" id="octivoBookingClose" aria-label="Đóng">' +
                '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>' +
              '</button>' +
            '</div>' +
          '</header>' +
          '<div class="octivo-booking-gate octivo-booking-hidden" id="octivoBookingGate">' +
            '<p id="octivoBookingGateGreeting"></p>' +
            '<div id="octivoBookingGateNameField">' +
              '<label for="octivoBookingGateName">Họ tên</label>' +
              '<input type="text" id="octivoBookingGateName" autocomplete="name" maxlength="80" placeholder="Nhập họ tên của bạn">' +
            '</div>' +
            '<div id="octivoBookingGatePhoneField">' +
              '<label for="octivoBookingGatePhone">Số điện thoại</label>' +
              '<input type="tel" id="octivoBookingGatePhone" autocomplete="tel" maxlength="15" placeholder="Nhập số điện thoại của bạn">' +
            '</div>' +
            '<div class="octivo-booking-gate__error" id="octivoBookingGateError"></div>' +
            '<button type="button" class="octivo-booking-btn" id="octivoBookingGateSubmit">Tiếp tục</button>' +
          '</div>' +
          '<div class="octivo-booking-body octivo-booking-hidden" id="octivoBookingBody"></div>' +
          '<div class="octivo-booking-footer octivo-booking-hidden" id="octivoBookingFooter">' +
            '<button type="button" class="octivo-booking-btn" id="octivoBookingNext">Tiếp tục</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="octivo-booking-toast" id="octivoBookingToast"></div>';
    document.body.appendChild(root);
  }

  function toast(message) {
    var el = $('#octivoBookingToast');
    if (!el) return;
    el.textContent = message;
    el.classList.add('octivo-booking-toast--show');
    setTimeout(function () { el.classList.remove('octivo-booking-toast--show'); }, 2200);
  }

  function applyConfigToDom() {
    var cfg = state.config;
    if (!cfg) return;

    var root = $('.octivo-booking-root');
    if (root) {
      var primary = (cfg.theme && cfg.theme.primary_color) || '#206bc4';
      root.style.setProperty('--ob-accent', primary);
      root.style.setProperty('--ob-accent-contrast', contrastColorFor(primary));
      root.style.setProperty('--ob-surface', (cfg.theme && cfg.theme.background_color) || '#fff');
      root.style.setProperty('--ob-text', (cfg.theme && cfg.theme.text_color) || '#182433');
    }

    var subtitle = $('#octivoBookingSubtitle');
    if (subtitle) subtitle.textContent = cfg.display_name || '';

    var greetingEl = $('#octivoBookingGateGreeting');
    if (greetingEl) greetingEl.textContent = cfg.widget_greeting || 'Vui lòng để lại thông tin để đặt lịch.';

    var nameField = $('#octivoBookingGateNameField');
    if (nameField) nameField.classList.toggle('octivo-booking-hidden', cfg.widget_require_name === false);
    var phoneField = $('#octivoBookingGatePhoneField');
    if (phoneField) phoneField.classList.toggle('octivo-booking-hidden', cfg.widget_require_phone === false);
  }

  // ---- View rendering ----

  function setTitle(title) {
    var el = $('#octivoBookingTitle');
    if (el) el.textContent = title;
  }

  function showBack(show) {
    var btn = $('#octivoBookingBack');
    if (btn) btn.classList.toggle('octivo-booking-hidden', !show);
  }

  function showFooter(show, label, disabled) {
    var footer = $('#octivoBookingFooter');
    var next = $('#octivoBookingNext');
    if (footer) footer.classList.toggle('octivo-booking-hidden', !show);
    if (next) {
      next.textContent = label || 'Tiếp tục';
      next.disabled = !!disabled;
    }
  }

  function renderBranchView() {
    setTitle('Chọn chi nhánh');
    showBack(false);
    var branches = state.branches;
    var body = $('#octivoBookingBody');
    if (!branches.length) {
      body.innerHTML = '<p class="octivo-booking-empty">Hiện chưa có chi nhánh khả dụng.</p>';
      showFooter(false);
      return;
    }
    body.innerHTML = '<div class="octivo-booking-list">' + branches.map(function (b) {
      return '<button type="button" class="octivo-booking-option-card" data-branch-id="' + escapeHtml(b.id) + '">' +
        '<div class="octivo-booking-option-card__title">' + escapeHtml(b.name) + '</div>' +
        (b.address ? '<div class="octivo-booking-option-card__meta">' + escapeHtml(b.address) + '</div>' : '') +
      '</button>';
    }).join('') + '</div>';
    showFooter(false);

    $all('[data-branch-id]', body).forEach(function (card) {
      card.addEventListener('click', function () {
        state.selected.branchId = card.getAttribute('data-branch-id');
        goToView('service');
      });
    });
  }

  function branchServiceIds() {
    var branch = state.branches.filter(function (b) { return b.id === state.selected.branchId; })[0];
    return branch ? branch.serviceIds : null;
  }

  function renderServiceView() {
    setTitle('Chọn dịch vụ');
    showBack(true);
    var allowedIds = branchServiceIds();
    var services = allowedIds ? state.services.filter(function (s) { return allowedIds.indexOf(s.id) !== -1; }) : state.services;
    var body = $('#octivoBookingBody');
    if (!services.length) {
      body.innerHTML = '<p class="octivo-booking-empty">Chi nhánh này chưa có dịch vụ khả dụng.</p>';
      showFooter(false);
      return;
    }
    body.innerHTML = '<div class="octivo-booking-list">' + services.map(function (s) {
      return '<button type="button" class="octivo-booking-option-card" data-service-id="' + escapeHtml(s.id) + '">' +
        (s.image ? '<img class="octivo-booking-option-card__img" src="' + escapeHtml(s.image) + '" alt="" loading="lazy">' : '') +
        '<div class="octivo-booking-option-card__body">' +
          '<div class="octivo-booking-option-card__title">' + escapeHtml(s.name) + '</div>' +
          '<div class="octivo-booking-option-card__meta">' + formatMoney(s.price) + (s.duration ? ' · ' + s.duration + ' phút' : '') + '</div>' +
        '</div>' +
      '</button>';
    }).join('') + '</div>';
    showFooter(false);

    $all('[data-service-id]', body).forEach(function (card) {
      card.addEventListener('click', function () {
        state.selected.serviceId = card.getAttribute('data-service-id');
        goToView('staff');
      });
    });
  }

  function renderStaffView() {
    setTitle('Chọn nhân viên');
    showBack(true);
    var body = $('#octivoBookingBody');
    body.innerHTML = '<p class="octivo-booking-empty">Đang tải…</p>';
    showFooter(false);

    fetchStaff(state.selected.branchId, state.selected.serviceId).then(function (staff) {
      state.staff = staff;
      var cards = '<div class="octivo-booking-list">' +
        '<button type="button" class="octivo-booking-option-card octivo-booking-option-card--any" data-staff-id="">' +
          '<div class="octivo-booking-option-card__title">Bất kỳ nhân viên nào</div>' +
        '</button>' +
        staff.map(function (member) {
          return '<button type="button" class="octivo-booking-option-card" data-staff-id="' + escapeHtml(member.id) + '">' +
            (member.photo ? '<img class="octivo-booking-option-card__img octivo-booking-option-card__img--round" src="' + escapeHtml(member.photo) + '" alt="" loading="lazy">' : '') +
            '<div class="octivo-booking-option-card__body">' +
              '<div class="octivo-booking-option-card__title">' + escapeHtml(member.name) + '</div>' +
              (member.levelLabel ? '<div class="octivo-booking-option-card__meta">' + escapeHtml(member.levelLabel) + '</div>' : '') +
            '</div>' +
          '</button>';
        }).join('') +
      '</div>';
      body.innerHTML = cards;
      $all('[data-staff-id]', body).forEach(function (card) {
        card.addEventListener('click', function () {
          state.selected.staffId = card.getAttribute('data-staff-id') || '';
          goToView('datetime');
        });
      });
    });
  }

  function renderDatetimeView() {
    setTitle('Chọn ngày & giờ');
    showBack(true);
    var body = $('#octivoBookingBody');
    var dates = buildDateOptions();
    if (!state.selected.date) {
      state.selected.date = dates[0].toISOString().slice(0, 10);
    }

    function renderSlots() {
      var selectedDate = new Date(state.selected.date + 'T00:00:00');
      var slots = buildTimeSlots(selectedDate);
      var slotsEl = $('#octivoBookingSlots');
      if (!slotsEl) return;
      if (!slots.length) {
        slotsEl.innerHTML = '<p class="octivo-booking-empty">Không còn khung giờ trống trong ngày này.</p>';
        showFooter(true, 'Xác nhận', true);
        return;
      }
      slotsEl.innerHTML = slots.map(function (min) {
        var label = formatMinutes(min);
        var active = state.selected.time === label;
        return '<button type="button" class="octivo-booking-slot' + (active ? ' octivo-booking-slot--active' : '') + '" data-time="' + label + '">' + label + '</button>';
      }).join('');
      $all('[data-time]', slotsEl).forEach(function (btn) {
        btn.addEventListener('click', function () {
          state.selected.time = btn.getAttribute('data-time');
          $all('.octivo-booking-slot', slotsEl).forEach(function (b) { b.classList.remove('octivo-booking-slot--active'); });
          btn.classList.add('octivo-booking-slot--active');
          showFooter(true, 'Xác nhận', false);
        });
      });
      showFooter(true, 'Xác nhận', !state.selected.time);
    }

    body.innerHTML =
      '<div class="octivo-booking-dates" id="octivoBookingDates">' +
        dates.map(function (d) {
          var iso = d.toISOString().slice(0, 10);
          var active = state.selected.date === iso;
          return '<button type="button" class="octivo-booking-date' + (active ? ' octivo-booking-date--active' : '') + '" data-date="' + iso + '">' + formatDateLabel(d) + '</button>';
        }).join('') +
      '</div>' +
      '<div class="octivo-booking-slots" id="octivoBookingSlots"></div>';

    $all('[data-date]', body).forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.selected.date = btn.getAttribute('data-date');
        state.selected.time = '';
        $all('.octivo-booking-date', body).forEach(function (b) { b.classList.remove('octivo-booking-date--active'); });
        btn.classList.add('octivo-booking-date--active');
        renderSlots();
      });
    });

    renderSlots();
  }

  function findService(id) {
    return state.services.filter(function (s) { return s.id === id; })[0];
  }
  function findBranch(id) {
    return state.branches.filter(function (b) { return b.id === id; })[0];
  }

  function renderConfirmView() {
    setTitle('Xác nhận đặt lịch');
    showBack(true);
    var sel = state.selected;
    var branch = findBranch(sel.branchId);
    var service = findService(sel.serviceId);
    var staffLabel = 'Bất kỳ nhân viên nào';
    var staffMember = state.staff.filter(function (s) { return s.id === sel.staffId; })[0];
    if (staffMember) staffLabel = staffMember.name;

    var body = $('#octivoBookingBody');
    body.innerHTML =
      '<div class="octivo-booking-summary">' +
        '<div class="octivo-booking-summary__row"><span>Chi nhánh</span><strong>' + escapeHtml(branch ? branch.name : '') + '</strong></div>' +
        '<div class="octivo-booking-summary__row"><span>Dịch vụ</span><strong>' + escapeHtml(service ? service.name : '') + '</strong></div>' +
        '<div class="octivo-booking-summary__row"><span>Nhân viên</span><strong>' + escapeHtml(staffLabel) + '</strong></div>' +
        '<div class="octivo-booking-summary__row"><span>Thời gian</span><strong>' + escapeHtml(sel.date) + ' ' + escapeHtml(sel.time) + '</strong></div>' +
        (service ? '<div class="octivo-booking-summary__row"><span>Giá</span><strong>' + formatMoney(service.price) + '</strong></div>' : '') +
      '</div>';
    showFooter(true, 'Xác nhận đặt lịch', false);
  }

  function renderListView() {
    setTitle('Lịch hẹn của bạn');
    showBack(false);
    var body = $('#octivoBookingBody');
    body.innerHTML = '<p class="octivo-booking-empty">Đang tải…</p>';
    showFooter(true, 'Đặt lịch mới', false);

    fetchReservations().then(function (rows) {
      state.reservations = rows;
      if (!rows.length) {
        body.innerHTML = '<p class="octivo-booking-empty">Bạn chưa có lịch hẹn nào.</p>';
        return;
      }
      body.innerHTML = '<div class="octivo-booking-list">' + rows.map(function (r) {
        var canCancel = r.status !== 'cancelled' && r.status !== 'completed';
        return '<div class="octivo-booking-reservation-card">' +
          '<div class="octivo-booking-reservation-card__body">' +
            '<div class="octivo-booking-option-card__title">' + escapeHtml(r.serviceName || '') + '</div>' +
            '<div class="octivo-booking-option-card__meta">' + escapeHtml(r.branchName || '') + ' · ' + escapeHtml((r.datetime || '').replace('T', ' ').slice(0, 16)) + '</div>' +
            '<div class="octivo-booking-status octivo-booking-status--' + escapeHtml(r.status) + '">' + escapeHtml(r.status) + '</div>' +
          '</div>' +
          (canCancel ? '<button type="button" class="octivo-booking-btn-outline" data-cancel-id="' + escapeHtml(r.id) + '">Hủy</button>' : '') +
        '</div>';
      }).join('') + '</div>';

      $all('[data-cancel-id]', body).forEach(function (btn) {
        btn.addEventListener('click', function () {
          btn.disabled = true;
          cancelReservation(btn.getAttribute('data-cancel-id'))
            .then(function () {
              toast('Đã hủy lịch hẹn');
              renderListView();
            })
            .catch(function (err) {
              toast(err.message || 'Không thể hủy lịch hẹn');
              btn.disabled = false;
            });
        });
      });
    }).catch(function (err) {
      body.innerHTML = '<p class="octivo-booking-empty">' + escapeHtml(err.message) + '</p>';
    });
  }

  var VIEW_ORDER = ['branch', 'service', 'staff', 'datetime', 'confirm'];
  var VIEW_RENDERERS = {
    branch: renderBranchView,
    service: renderServiceView,
    staff: renderStaffView,
    datetime: renderDatetimeView,
    confirm: renderConfirmView,
    list: renderListView,
  };

  function goToView(view) {
    state.view = view;
    var renderer = VIEW_RENDERERS[view];
    if (renderer) renderer();
  }

  function goBack() {
    if (state.view === 'list') {
      goToView(state.branches.length > 1 ? 'branch' : 'service');
      return;
    }
    var idx = VIEW_ORDER.indexOf(state.view);
    if (idx > 0) {
      goToView(VIEW_ORDER[idx - 1]);
    }
  }

  function bindNextButton() {
    var next = $('#octivoBookingNext');
    if (!next || next._bound) return;
    next._bound = true;
    next.addEventListener('click', function () {
      if (state.view === 'datetime') {
        goToView('confirm');
        return;
      }
      if (state.view === 'confirm') {
        next.disabled = true;
        createReservation()
          .then(function () {
            toast('Đặt lịch thành công!');
            state.selected = { branchId: '', serviceId: '', staffId: '', date: '', time: '' };
            goToView('list');
          })
          .catch(function (err) {
            toast(err.message || 'Không thể đặt lịch');
          })
          .finally(function () {
            next.disabled = false;
          });
        return;
      }
      if (state.view === 'list') {
        state.selected = { branchId: '', serviceId: '', staffId: '', date: '', time: '' };
        goToView(state.branches.length > 1 ? 'branch' : 'service');
      }
    });
  }

  function showBookingUi() {
    $('#octivoBookingGate').classList.add('octivo-booking-hidden');
    $('#octivoBookingBody').classList.remove('octivo-booking-hidden');
    $('#octivoBookingFooter').classList.remove('octivo-booking-hidden');
    goToView(state.branches.length > 1 ? 'branch' : (state.selected.serviceId ? 'staff' : 'service'));
    if (state.branches.length === 1 && !state.selected.branchId) {
      state.selected.branchId = state.branches[0].id;
    }
  }

  function showGateUi() {
    $('#octivoBookingGate').classList.remove('octivo-booking-hidden');
    $('#octivoBookingBody').classList.add('octivo-booking-hidden');
    $('#octivoBookingFooter').classList.add('octivo-booking-hidden');
  }

  // ---- Session bootstrap (reuse > mechanism 2 > mechanism 1) — same design as octivo-chat.js ----

  function startSessionWith(name, phone) {
    return saveInformation(name, phone).then(function (data) {
      state.appUserCode = data.code || state.appUserCode;
      return touchOrganization();
    });
  }

  function resolveSession(initOptions) {
    if (hasStoredSession()) {
      return touchOrganization().then(function () {
        state.ready = true;
        return { reused: true };
      });
    }

    var name = (initOptions && initOptions.name || '').trim();
    var phone = initOptions && initOptions.phone ? normalizePhone(initOptions.phone) : '';
    var cfg = state.config;
    var needsName = cfg.widget_require_name !== false;
    var needsPhone = cfg.widget_require_phone !== false;
    var nameOk = !needsName || validateName(name);
    var phoneOk = !needsPhone || validatePhone(phone);

    if (nameOk && phoneOk && (needsName || needsPhone) && (name || phone)) {
      return startSessionWith(name, phone).then(function () {
        state.ready = true;
        return { reused: false, auto: true };
      });
    }

    var nameInput = $('#octivoBookingGateName');
    var phoneInput = $('#octivoBookingGatePhone');
    if (nameInput && nameOk) nameInput.value = name;
    if (phoneInput && phoneOk) phoneInput.value = phone;
    state.ready = true;
    return Promise.resolve({ reused: false, auto: false });
  }

  function bindGate() {
    var submit = $('#octivoBookingGateSubmit');
    if (!submit || submit._bound) return;
    submit._bound = true;
    submit.addEventListener('click', function () {
      var cfg = state.config;
      var name = (($('#octivoBookingGateName') || {}).value || '').trim();
      var phone = normalizePhone((($('#octivoBookingGatePhone') || {}).value || ''));
      var errorEl = $('#octivoBookingGateError');

      if (cfg.widget_require_name !== false && !validateName(name)) {
        errorEl.textContent = 'Vui lòng nhập họ tên (ít nhất 2 ký tự)';
        return;
      }
      if (cfg.widget_require_phone !== false && !validatePhone(phone)) {
        errorEl.textContent = 'Vui lòng nhập số điện thoại hợp lệ';
        return;
      }
      errorEl.textContent = '';
      submit.disabled = true;
      startSessionWith(name, phone)
        .then(function () {
          showBookingUi();
        })
        .catch(function (err) {
          errorEl.textContent = err.message || 'Không thể tiếp tục';
        })
        .finally(function () {
          submit.disabled = false;
        });
    });
  }

  function bindChrome() {
    var fab = $('#octivoBookingFab');
    if (fab && !fab._bound) {
      fab._bound = true;
      fab.addEventListener('click', openPanel);
    }
    var close = $('#octivoBookingClose');
    if (close && !close._bound) {
      close._bound = true;
      close.addEventListener('click', closePanel);
    }
    var back = $('#octivoBookingBack');
    if (back && !back._bound) {
      back._bound = true;
      back.addEventListener('click', goBack);
    }
    var fullscreenBtn = $('#octivoBookingFullscreen');
    if (fullscreenBtn && !fullscreenBtn._bound) {
      fullscreenBtn._bound = true;
      fullscreenBtn.addEventListener('click', toggleFullscreen);
    }
    var backdrop = $('#octivoBookingBackdrop');
    if (backdrop && !backdrop._bound) {
      backdrop._bound = true;
      backdrop.addEventListener('click', closePanel);
    }
  }

  function openPanel() {
    var panel = $('#octivoBookingPanel');
    if (!panel) return;
    panel.classList.remove('octivo-booking-hidden');
    panel.setAttribute('aria-hidden', 'false');
    state.open = true;
    applyFullscreenState();
    if (hasStoredSession()) {
      showBookingUi();
      if (state.selected.branchId || state.branches.length <= 1) {
        // Returning guest with an existing session: show their reservations first.
        goToView('list');
      }
    } else {
      showGateUi();
    }
  }

  /** Desktop-only: expand the modal to fill the viewport, or shrink it back to the centered modal. Persists across close/reopen within the same page session (not across reloads). */
  function toggleFullscreen() {
    state.fullscreen = !state.fullscreen;
    applyFullscreenState();
  }

  function applyFullscreenState() {
    var panel = $('#octivoBookingPanel');
    var btn = $('#octivoBookingFullscreen');
    if (!panel || !btn) return;
    panel.classList.toggle('octivo-booking-panel--fullscreen', state.fullscreen);
    btn.setAttribute('aria-label', state.fullscreen ? 'Thu nhỏ' : 'Mở rộng toàn màn hình');
    btn.setAttribute('title', state.fullscreen ? 'Thu nhỏ' : 'Mở rộng toàn màn hình');
    var expandIcon = btn.querySelector('.octivo-booking-icon-expand');
    var collapseIcon = btn.querySelector('.octivo-booking-icon-collapse');
    if (expandIcon) expandIcon.classList.toggle('octivo-booking-hidden', state.fullscreen);
    if (collapseIcon) collapseIcon.classList.toggle('octivo-booking-hidden', !state.fullscreen);
  }

  function closePanel() {
    var panel = $('#octivoBookingPanel');
    if (!panel) return;
    var wasOpen = state.open;
    panel.classList.add('octivo-booking-hidden');
    panel.setAttribute('aria-hidden', 'true');
    state.open = false;
    if (wasOpen) {
      notifyClose();
    }
  }

  function notifyClose() {
    if (typeof state.onClose === 'function') {
      try {
        state.onClose();
      } catch (e) {
        if (global.console) console.error('[OctivoBooking] onClose callback threw', e);
      }
    }
    try {
      global.dispatchEvent(new CustomEvent('octivobooking:close', {
        detail: { channel: state.channelSourceId },
      }));
    } catch (e) {
      // Older browsers without CustomEvent constructor support — silently skip.
    }
  }

  function revealFab() {
    if (!state.showBubble) return;
    var fab = $('#octivoBookingFab');
    if (fab) fab.classList.remove('octivo-booking-hidden');
  }

  // ---- Public API ----

  function readDataAttr() {
    var el = document.currentScript || document.querySelector('script[data-channel]');
    return el ? (el.getAttribute('data-channel') || '') : '';
  }

  function readShowBubbleDataAttr() {
    var el = document.currentScript || document.querySelector('script[data-channel]');
    return el ? el.getAttribute('data-show-bubble') !== 'false' : true;
  }

  function init(options) {
    options = options || {};
    state.pendingInit = options;
    state.showBubble = options.showBubble !== false;
    state.onClose = typeof options.onClose === 'function' ? options.onClose : null;
    var channel = String(options.channel || readDataAttr() || '').replace(/^@/, '');
    if (!channel) {
      return Promise.reject(new Error('OctivoBooking.init: missing channel'));
    }
    state.channelSourceId = channel;
    API_BASE = resolveApiBase(options);

    injectCss();
    buildDom();
    bindChrome();
    bindGate();
    bindNextButton();

    return fetchConfig()
      .then(function () {
        loadStoredSession();
        applyConfigToDom();
        return resolveSession(options);
      })
      .then(function (result) {
        revealFab();
        if (options.autoOpen && (result.reused || result.auto)) {
          openPanel();
        }
        return result;
      })
      .catch(function (err) {
        // Widget stays hidden if config/session bootstrap fails (e.g. domain not
        // whitelisted, channel not found) — fail closed, never break the host page.
        if (global.console) console.error('[OctivoBooking]', err.message || err);
      });
  }

  global.OctivoBooking = {
    init: init,
    open: openPanel,
    close: closePanel,
  };

  // Auto-init when the script tag carries data-channel, mirroring the same
  // pattern as octivo-chat.js.
  if (readDataAttr()) {
    var autoInit = function () { init({ showBubble: readShowBubbleDataAttr() }); };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', autoInit);
    } else {
      autoInit();
    }
  }
})(typeof window !== 'undefined' ? window : this, document);
