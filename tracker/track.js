/*!
 * Adoption tracker: reports "someone unlocked this app" and "someone used a
 * feature" to the collector. One identical file serves all ten bonus apps; the
 * app name and collector address come from the script tag:
 *
 *   <script defer src="track.js" data-app="landed"
 *           data-endpoint="https://adoption-collector.<you>.workers.dev"></script>
 *
 * Sends three event types:
 *   unlock  the access gate was opened with the right password (first login)
 *   open    the app was opened by a browser that is already unlocked (a return
 *           visit), at most once per browser tab session
 *   use     a tab or button was clicked, labelled with its visible text
 *
 * Privacy: the only identifier is a random id kept in this browser's
 * localStorage. Nothing the visitor types is ever read, and no cookies are set.
 * Do Not Track and Global Privacy Control are respected. Every failure is
 * swallowed: tracking must never be able to break the app.
 */
(function () {
  'use strict';
  try {
    var tag = document.currentScript;
    var APP = tag && tag.getAttribute('data-app');
    var ENDPOINT = tag && (tag.getAttribute('data-endpoint') || '').replace(/\/+$/, '');
    if (!APP || !ENDPOINT) return;
    if (navigator.doNotTrack === '1' || navigator.globalPrivacyControl === true) return;

    var MAX_USE_PER_PAGE = 100;
    var useCount = 0;

    function store(kind, key, value) {
      try {
        var s = kind === 'local' ? window.localStorage : window.sessionStorage;
        if (value === undefined) return s.getItem(key);
        s.setItem(key, value);
      } catch (e) { /* storage blocked: fall back to in-memory behaviour */ }
      return null;
    }

    function randomId() {
      if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
      var a = new Uint8Array(16);
      (window.crypto || window.msCrypto).getRandomValues(a);
      return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    }

    var vid = store('local', 'adoption_vid');
    if (!vid || !/^[A-Za-z0-9-]{8,64}$/.test(vid)) {
      vid = randomId();
      store('local', 'adoption_vid', vid);
    }

    function send(type, feature) {
      var payload = { app: APP, type: type, vid: vid };
      if (feature) payload.feature = feature;
      var body = JSON.stringify(payload);
      var url = ENDPOINT + '/e';
      // text/plain keeps this a "simple" cross-origin request: no preflight.
      try {
        if (navigator.sendBeacon && navigator.sendBeacon(url, new Blob([body], { type: 'text/plain;charset=UTF-8' }))) return;
      } catch (e) { /* fall through to fetch */ }
      try {
        fetch(url, { method: 'POST', body: body, keepalive: true, mode: 'cors', credentials: 'omit',
                     headers: { 'content-type': 'text/plain;charset=UTF-8' } }).catch(function () {});
      } catch (e) { /* ignore */ }
    }

    var gate = document.getElementById('gate');
    if (!gate) return;
    var isUnlocked = function () { return gate.classList.contains('is-unlocked'); };

    function labelOf(el) {
      var t = (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim();
      return t.slice(0, 40) || el.id || null;
    }

    if (isUnlocked()) {
      // Already unlocked on load: a return visit. Once per tab session.
      if (!store('session', 'adoption_open')) { store('session', 'adoption_open', '1'); send('open'); }
    } else if (window.MutationObserver) {
      var seen = false;
      new MutationObserver(function (_, obs) {
        if (!seen && isUnlocked()) { seen = true; obs.disconnect(); store('session', 'adoption_open', '1'); send('unlock'); }
      }).observe(gate, { attributes: true, attributeFilter: ['class'] });
    }

    document.addEventListener('click', function (e) {
      try {
        if (!isUnlocked() || useCount >= MAX_USE_PER_PAGE) return;
        var el = e.target && e.target.closest && e.target.closest('.tab-btn, .primary-btn');
        if (!el || gate.contains(el)) return;
        var label = labelOf(el);
        if (!label) return;
        useCount++;
        send('use', label);
      } catch (err) { /* ignore */ }
    }, true);
  } catch (e) { /* never break the host app */ }
})();
