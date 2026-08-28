/**
 * api.js
 * Polls a live Extingo backend instead of simulating one. This is
 * the shared contract other Extingo front ends (including Site B)
 * must also speak, so keep the event names and response shape
 * exactly as documented here if this file is ported elsewhere.
 *
 * Endpoint:   GET {serverUrl}/api/data
 * Response:   { telemetry, alert, status, command }
 *
 * Events (dispatched on `window`):
 *   'extingo:data'    detail = the parsed { telemetry, alert, status, command } payload
 *   'extingo:offline' detail = { error, attempt, nextRetryMs }
 *
 * Public API: window.ExtingoAPI.startPolling(serverUrl) -> { stop() }
 */
(function (global) {
  'use strict';

  var BASE_INTERVAL_MS = 2500;   // steady-state poll cadence
  var MAX_BACKOFF_MS = 10000;    // ceiling for retry backoff
  var REQUEST_TIMEOUT_MS = 8000; // give up on a single request after this long

  function dispatch(eventName, detail) {
    global.dispatchEvent(new CustomEvent(eventName, { detail: detail }));
  }

  /** Basic shape check so a malformed backend response fails loudly
   *  (as an offline/error event) instead of reaching the UI half-formed. */
  function isValidPayload(payload) {
    return !!payload && typeof payload === 'object' &&
      'telemetry' in payload &&
      'alert' in payload &&
      'status' in payload &&
      'command' in payload;
  }

  function fetchWithTimeout(url, timeoutMs) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, timeoutMs);
    return fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal
    }).finally(function () {
      clearTimeout(timer);
    });
  }

  /**
   * Begin polling {serverUrl}/api/data every ~2.5s.
   *
   * On each successful response, dispatches 'extingo:data' with the
   * parsed payload and resets the retry backoff. On any failure
   * (network error, non-2xx status, timeout, or a response that
   * doesn't match the expected shape), dispatches 'extingo:offline'
   * and retries after an exponentially increasing delay, capped at
   * MAX_BACKOFF_MS.
   *
   * @param {string} serverUrl - base URL of the backend, e.g. "https://panel.local:8080"
   * @returns {{ stop: function(): void }} handle to cancel polling
   */
  function startPolling(serverUrl) {
    if (!serverUrl) {
      throw new Error('startPolling(serverUrl) requires a server URL');
    }

    var endpoint = serverUrl.replace(/\/+$/, '') + '/api/data';
    var stopped = false;
    var failureCount = 0;
    var timeoutHandle = null;

    function nextBackoffDelay() {
      var delay = BASE_INTERVAL_MS * Math.pow(2, failureCount);
      return Math.min(delay, MAX_BACKOFF_MS);
    }

    function scheduleNext(delayMs) {
      if (stopped) return;
      timeoutHandle = setTimeout(poll, delayMs);
    }

    function poll() {
      if (stopped) return;

      fetchWithTimeout(endpoint, REQUEST_TIMEOUT_MS)
        .then(function (response) {
          if (!response.ok) {
            throw new Error('Request failed with status ' + response.status);
          }
          return response.json();
        })
        .then(function (payload) {
          if (!isValidPayload(payload)) {
            throw new Error('Response did not match the {telemetry, alert, status, command} shape');
          }
          failureCount = 0;
          dispatch('extingo:data', payload);
          scheduleNext(BASE_INTERVAL_MS);
        })
        .catch(function (err) {
          var delay = nextBackoffDelay();
          failureCount += 1;
          dispatch('extingo:offline', {
            error: err && err.message ? err.message : String(err),
            attempt: failureCount,
            nextRetryMs: delay
          });
          scheduleNext(delay);
        });
    }

    poll();

    return {
      stop: function stop() {
        stopped = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }
    };
  }

  global.ExtingoAPI = global.ExtingoAPI || {};
  global.ExtingoAPI.startPolling = startPolling;

})(window);
