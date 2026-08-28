/**
 * dashboard.js
 * Wires the live backend feed (api.js, via `extingo:data` /
 * `extingo:offline` window events) and the rolling history store
 * (history.js) to the DOM: status banner, sensor tiles, Chart.js
 * history charts, the fire-prediction gauge, the action log, and
 * the manual override panel.
 *
 * --- Backend contract assumed here ---
 * `extingo:data` detail shape: { telemetry, alert, status, command }
 *   telemetry: { flame: bool, smoke: number, heat: number,
 *                motion: bool, pump: bool, mcb: bool, timestamp?: number }
 *   alert:     { event: string, reasons?: string[] }  // `event` is the
 *              discrete id the action log watches for changes, e.g.
 *              "CLEAR", "SMOKE_HIGH", "FLAME_DETECTED"
 *   status:    "NORMAL" | "EMERGENCY"                  // drives the banner
 *   command:   { spray: bool, mcb: bool }               // confirmed device
 *              state, used so the override buttons reflect reality rather
 *              than an optimistic guess
 * If Site B's backend uses different field names, adjust the small
 * set of `data.telemetry.*` / `data.alert.*` / `data.command.*`
 * reads below — everything else (charts, gauge, log) is unaffected.
 *
 * --- Resilience note ---
 * initCharts() used to be called directly in the DOMContentLoaded
 * handler with nothing to catch a thrown error. If the Chart.js CDN
 * script ever failed to load (blocked by an ad blocker, offline CDN,
 * bad network, etc.), `Chart` was undefined, initCharts() threw, and
 * — because JS errors abort the rest of a synchronous function —
 * every line after it (log setup, override panel wiring, the clock,
 * and ExtingoAPI.startPolling itself) silently never ran. The whole
 * panel looked dead with no obvious cause. initCharts() now fails
 * loudly into the action log instead of taking the rest of boot down
 * with it, and updateCharts() no-ops safely if charts were never
 * created. For a production panel, consider self-hosting Chart.js
 * under assets/js/ instead of depending on any external CDN.
 */
(function () {
  'use strict';

  /* Point this at the live panel. Override by setting
     window.EXTINGO_SERVER_URL before this script runs. */
  var SERVER_URL = window.EXTINGO_SERVER_URL || 'http://localhost:8080';

  var CONTACT_STORAGE_KEY = 'extingo.emergencyContact';
  var MAX_LOG_ENTRIES = 40;

  /* Fire-prediction weighting — heat rate-of-rise counts for more than
     the smoke trend, per spec. Kept as named constants so the balance
     can be tuned without touching the calculation logic. */
  var PREDICTION_HEAT_ROR_WEIGHT = 60;     // points contributed at full heat rate-of-rise
  var PREDICTION_SMOKE_TREND_WEIGHT = 30;  // points contributed at full smoke trend
  var PREDICTION_FLAME_WEIGHT = 40;        // flat points added when flame is detected
  var PREDICTION_MOTION_WEIGHT = 8;        // flat points added when motion is detected
  var PREDICTION_HEAT_ROR_SCALE = 20;      // °C/min that counts as "full scale" heat rise
  var PREDICTION_SMOKE_TREND_SCALE = 300;  // ppm/min that counts as "full scale" smoke rise

  var GAUGE_ARC_LENGTH = 283;
  var SENT_CONFIRMATION_MS = 1400;

  var els = {};
  var charts = { smoke: null, heat: null };
  var logEntries = [];
  var bootTime = Date.now();
  var lastStatusLevel = null;
  var lastAlertEvent = null;
  var lastKnownCommand = { spray: false, mcb: true };

  function $(id) { return document.getElementById(id); }

  function cacheElements() {
    els.statusBanner = $('status-banner');
    els.statusText = $('status-text');
    els.statusDetail = $('status-detail');

    els.flameValue = $('flame-value');
    els.flameTrend = $('flame-trend');
    els.flameState = $('flame-state');
    els.flameTile = document.querySelector('.sensor-tile[data-sensor="flame"]');

    els.smokeValue = $('smoke-value');
    els.smokeTrend = $('smoke-trend');
    els.smokeState = $('smoke-state');
    els.smokeTile = document.querySelector('.sensor-tile[data-sensor="smoke"]');

    els.heatValue = $('heat-value');
    els.heatTrend = $('heat-trend');
    els.heatState = $('heat-state');
    els.heatTile = document.querySelector('.sensor-tile[data-sensor="heat"]');

    els.motionValue = $('motion-value');
    els.motionTrend = $('motion-trend');
    els.motionState = $('motion-state');

    els.pumpValue = $('pump-value');
    els.pumpTrend = $('pump-trend');
    els.pumpState = $('pump-state');
    els.pumpTile = document.querySelector('.sensor-tile[data-sensor="pump"]');

    els.predictionPercent = $('prediction-percent');
    els.predictionCaption = $('prediction-caption');
    els.predictionSummary = $('prediction-summary');
    els.factorHeatRor = $('factor-heat-ror');
    els.factorSmokeTrend = $('factor-smoke-trend');
    els.factorFlameMotion = $('factor-flame-motion');
    els.gaugeFill = $('gauge-fill');
    els.gaugeNeedle = $('gauge-needle');

    els.logToggle = $('log-toggle');
    els.logList = $('log-list');

    els.sprayBtn = $('spray-btn');
    els.sprayStateLabel = $('spray-state-label');
    els.mcbBtn = $('mcb-btn');
    els.contactInput = $('contact-input');

    els.uptime = $('uptime');
    els.clock = $('clock');
  }

  /* ---------------------------------------------------------
     Formatting helpers
     --------------------------------------------------------- */

  var TREND_GLYPH = { up: '▲', down: '▼', flat: '▬' };

  function setTrend(el, direction) {
    el.textContent = TREND_GLYPH[direction] || TREND_GLYPH.flat;
    el.setAttribute('data-trend', direction);
  }

  function pad2(n) { return String(n).padStart(2, '0'); }

  function formatUptime(ms) {
    var totalSeconds = Math.floor(ms / 1000);
    var h = Math.floor(totalSeconds / 3600);
    var m = Math.floor((totalSeconds % 3600) / 60);
    var s = totalSeconds % 60;
    return pad2(h) + ':' + pad2(m) + ':' + pad2(s);
  }

  function clampNum(v, min, max) { return Math.max(min, Math.min(max, v)); }

  /* ---------------------------------------------------------
     Action log
     --------------------------------------------------------- */

  function addLogEntry(message, level) {
    var entry = { time: new Date(), message: message, level: level || 'info' };
    logEntries.unshift(entry);
    if (logEntries.length > MAX_LOG_ENTRIES) logEntries.pop();
    renderLog();
  }

  function renderLog() {
    els.logList.innerHTML = '';
    logEntries.forEach(function (entry) {
      var li = document.createElement('li');
      li.className = 'log-entry';
      li.setAttribute('data-level', entry.level);

      var time = document.createElement('span');
      time.className = 'log-time';
      time.textContent = entry.time.toLocaleTimeString();

      var msg = document.createElement('span');
      msg.className = 'log-message';
      msg.textContent = entry.message;

      li.appendChild(time);
      li.appendChild(msg);
      els.logList.appendChild(li);
    });
  }

  function setupLogToggle() {
    els.logToggle.addEventListener('click', function () {
      var expanded = els.logToggle.getAttribute('aria-expanded') === 'true';
      els.logToggle.setAttribute('aria-expanded', String(!expanded));
    });
  }

  /* ---------------------------------------------------------
     Status banner — driven directly by data.status
     --------------------------------------------------------- */

  function updateStatusBanner(data) {
    var level = String(data.status || 'NORMAL').toUpperCase();
    var isEmergency = level === 'EMERGENCY';

    els.statusBanner.classList.toggle('status-emergency', isEmergency);
    els.statusBanner.classList.toggle('status-normal', !isEmergency);
    els.statusText.textContent = level;

    var reasons = (data.alert && data.alert.reasons) || [];
    els.statusDetail.textContent = reasons.length
      ? 'Attention: ' + reasons.join(', ')
      : 'All zones reporting within safe range';

    if (level !== lastStatusLevel) {
      addLogEntry(
        isEmergency
          ? 'System status changed to EMERGENCY' + (reasons.length ? ' — ' + reasons.join(', ') : '')
          : 'System status returned to NORMAL',
        isEmergency ? 'alert' : 'info'
      );
      lastStatusLevel = level;
    }
  }

  /* Append a log line whenever the discrete alert event id changes,
     independent of the NORMAL/EMERGENCY level above (an alert can
     change kind — e.g. SMOKE_HIGH -> FLAME_DETECTED — without the
     overall level flipping). */
  function trackAlertEvent(data) {
    var event = data.alert && data.alert.event;
    if (!event || event === lastAlertEvent) return;
    addLogEntry('Alert event: ' + event, event === 'CLEAR' ? 'info' : 'warn');
    lastAlertEvent = event;
  }

  /* ---------------------------------------------------------
     Sensor tiles
     --------------------------------------------------------- */

  function updateTiles(telemetry) {
    // Flame
    els.flameValue.textContent = telemetry.flame ? 'DETECTED' : 'CLEAR';
    els.flameState.textContent = telemetry.flame ? 'Alert' : 'Clear';
    els.flameTile.setAttribute('data-alert', String(!!telemetry.flame));
    setTrend(els.flameTrend, telemetry.flame ? 'up' : 'flat');

    // Smoke
    els.smokeValue.textContent = telemetry.smoke;
    setTrend(els.smokeTrend, ExtingoHistory.trend('smoke', 6));
    els.smokeState.textContent = ExtingoHistory.trend('smoke', 6) === 'up' ? 'Rising' : 'Clear';
    els.smokeTile.setAttribute('data-alert', String(telemetry.smoke >= 400));

    // Heat
    els.heatValue.textContent = Number(telemetry.heat).toFixed(1);
    setTrend(els.heatTrend, ExtingoHistory.trend('heat', 6));
    els.heatState.textContent = ExtingoHistory.trend('heat', 6) === 'up' ? 'Rising' : 'Nominal';
    els.heatTile.setAttribute('data-alert', String(telemetry.heat >= 60));

    // Motion
    els.motionValue.textContent = telemetry.motion ? 'DETECTED' : 'CLEAR';
    els.motionState.textContent = telemetry.motion ? 'Occupied' : 'Unoccupied';
    setTrend(els.motionTrend, telemetry.motion ? 'up' : 'flat');

    // Pump / exhaust
    els.pumpValue.textContent = telemetry.pump ? 'ON' : 'OFF';
    els.pumpTile.setAttribute('data-active', String(!!telemetry.pump));
    els.pumpState.textContent = !telemetry.mcb ? 'No power (MCB off)' : telemetry.pump ? 'Running' : 'Standby';
    setTrend(els.pumpTrend, 'flat');
  }

  /* ---------------------------------------------------------
     Charts
     --------------------------------------------------------- */

  function buildChartConfig(label, color) {
    return {
      type: 'line',
      data: {
        labels: [],
        datasets: [{
          label: label,
          data: [],
          borderColor: color,
          backgroundColor: color + '33',
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.3,
          fill: true
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        scales: {
          x: {
            ticks: { color: '#5d6d73', maxTicksLimit: 6 },
            grid: { color: '#232c30' }
          },
          y: {
            ticks: { color: '#5d6d73' },
            grid: { color: '#232c30' }
          }
        },
        plugins: {
          legend: { display: false }
        }
      }
    };
  }

  /* Throws if Chart.js never loaded (e.g. blocked script) — the
     caller in the boot sequence catches this so a missing chart
     library degrades gracefully instead of halting everything. */
  function initCharts() {
    if (typeof Chart === 'undefined') {
      throw new Error('Chart.js failed to load — charts will be unavailable');
    }
    var smokeCtx = $('smoke-chart').getContext('2d');
    var heatCtx = $('heat-chart').getContext('2d');
    charts.smoke = new Chart(smokeCtx, buildChartConfig('Smoke (ppm)', '#f39c12'));
    charts.heat = new Chart(heatCtx, buildChartConfig('Heat (°C)', '#e74c3c'));
  }

  /* Safe no-op if charts were never created (Chart.js missing/blocked)
     so the rest of the data pipeline (tiles, gauge, log) keeps working. */
  function updateCharts() {
    if (!charts.smoke || !charts.heat) return;

    charts.smoke.data.labels = ExtingoHistory.getLabels('smoke');
    charts.smoke.data.datasets[0].data = ExtingoHistory.getValues('smoke');
    charts.smoke.update('none');

    charts.heat.data.labels = ExtingoHistory.getLabels('heat');
    charts.heat.data.datasets[0].data = ExtingoHistory.getValues('heat');
    charts.heat.update('none');
  }

  /* ---------------------------------------------------------
     Fire prediction gauge
     Heat rate-of-rise is weighted more heavily than the smoke
     trend (see the PREDICTION_* constants above) — this is a live
     computation that moves every polling cycle, not a static figure.
     --------------------------------------------------------- */

  function computePrediction(telemetry) {
    var heatRoR = ExtingoHistory.rateOfRise('heat', 6);   // °C per minute
    var smokeRoR = ExtingoHistory.rateOfRise('smoke', 6); // ppm per minute

    var heatNorm = clampNum(heatRoR / PREDICTION_HEAT_ROR_SCALE, 0, 1);
    var smokeNorm = clampNum(smokeRoR / PREDICTION_SMOKE_TREND_SCALE, 0, 1);

    var flameMotionWeight =
      (telemetry.flame ? PREDICTION_FLAME_WEIGHT : 0) +
      (telemetry.motion ? PREDICTION_MOTION_WEIGHT : 0);

    var score = clampNum(
      heatNorm * PREDICTION_HEAT_ROR_WEIGHT +
      smokeNorm * PREDICTION_SMOKE_TREND_WEIGHT +
      flameMotionWeight,
      0,
      100
    );

    return {
      score: Math.round(score),
      heatRoR: heatRoR,
      smokeRoR: smokeRoR,
      flameMotionWeight: flameMotionWeight
    };
  }

  function updateGauge(prediction, telemetry) {
    var percent = prediction.score;

    els.predictionPercent.textContent = percent + '%';
    els.factorHeatRor.textContent =
      (prediction.heatRoR >= 0 ? '+' : '') + prediction.heatRoR.toFixed(1) + ' °C/min';
    els.factorSmokeTrend.textContent =
      (prediction.smokeRoR >= 0 ? '+' : '') + Math.round(prediction.smokeRoR) + ' ppm/min';
    els.factorFlameMotion.textContent =
      'Flame: ' + (telemetry.flame ? 'yes' : 'no') + ' · Motion: ' + (telemetry.motion ? 'yes' : 'no') +
      ' (+' + prediction.flameMotionWeight + ')';

    var offset = GAUGE_ARC_LENGTH - (GAUGE_ARC_LENGTH * percent) / 100;
    els.gaugeFill.style.strokeDashoffset = offset;

    var color = percent >= 66 ? '#e74c3c' : percent >= 34 ? '#f39c12' : '#2ecc71';
    els.gaugeFill.style.stroke = color;
    els.predictionPercent.style.color = color;

    var rotateDeg = -90 + (percent / 100) * 180;
    els.gaugeNeedle.setAttribute('transform', 'rotate(' + rotateDeg + ' 110 110)');

    if (percent >= 66) {
      els.predictionSummary.textContent =
        'Rapid heat and smoke rise detected — index in the high band. Treat as a likely developing fire.';
    } else if (percent >= 34) {
      els.predictionSummary.textContent =
        'Readings are trending upward faster than baseline. Worth a physical check of the zone.';
    } else {
      els.predictionSummary.textContent =
        'Heat and smoke trends are within normal drift. No early-warning signal at this time.';
    }
  }

  /* ---------------------------------------------------------
     Manual override panel — POSTs a command, waits for the next
     `extingo:data` event to confirm the actual device state, and
     shows a brief "sent" acknowledgement in the meantime.
     --------------------------------------------------------- */

  function sendCommand(command) {
    return fetch(SERVER_URL.replace(/\/+$/, '') + '/api/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: command })
    }).then(function (res) {
      if (!res.ok) throw new Error('Command failed with status ' + res.status);
      return true;
    });
  }

  function flashSent(buttonEl) {
    var flag = document.createElement('span');
    flag.className = 'btn-sent-flag';
    flag.textContent = 'Sent';
    buttonEl.appendChild(flag);
    setTimeout(function () {
      if (flag.parentNode) flag.parentNode.removeChild(flag);
    }, SENT_CONFIRMATION_MS);
  }

  function setupOverridePanel() {
    els.sprayBtn.addEventListener('click', function () {
      var command = lastKnownCommand.spray ? 'spray_off' : 'spray_on';
      flashSent(els.sprayBtn);
      sendCommand(command)
        .then(function () {
          addLogEntry('Manual override: sent ' + command, 'warn');
        })
        .catch(function (err) {
          addLogEntry('Spray command failed to send: ' + err.message, 'alert');
        });
    });

    els.mcbBtn.addEventListener('click', function () {
      flashSent(els.mcbBtn);
      sendCommand('mcb_toggle')
        .then(function () {
          addLogEntry('Manual override: sent mcb_toggle', 'warn');
        })
        .catch(function (err) {
          addLogEntry('MCB command failed to send: ' + err.message, 'alert');
        });
    });

    els.contactInput.addEventListener('change', function () {
      try {
        window.localStorage.setItem(CONTACT_STORAGE_KEY, els.contactInput.value.trim());
        addLogEntry('Emergency contact number updated', 'info');
      } catch (err) {
        // Storage unavailable (private browsing, etc.) — the field
        // still works for the current session, just isn't persisted.
      }
    });

    try {
      var saved = window.localStorage.getItem(CONTACT_STORAGE_KEY);
      if (saved) els.contactInput.value = saved;
    } catch (err) {
      /* no-op */
    }
  }

  /* Reflect the backend's confirmed command state (never optimistic —
     the buttons only change once the server has echoed it back). */
  function updateOverrideButtons(command) {
    if (!command) return;
    lastKnownCommand = { spray: !!command.spray, mcb: !!command.mcb };

    els.sprayBtn.setAttribute('data-active', String(lastKnownCommand.spray));
    els.sprayStateLabel.textContent = lastKnownCommand.spray ? 'ON' : 'OFF';
    els.mcbBtn.setAttribute('data-active', String(lastKnownCommand.mcb));
  }

  /* ---------------------------------------------------------
     Clock / uptime
     --------------------------------------------------------- */

  function tickClock() {
    els.clock.textContent = new Date().toLocaleTimeString();
    els.uptime.textContent = formatUptime(Date.now() - bootTime);
  }

  /* ---------------------------------------------------------
     Main feed handlers
     --------------------------------------------------------- */

  function handleData(event) {
    var data = event.detail || {};
    var telemetry = data.telemetry || {};

    ExtingoHistory.pushReading({
      flame: !!telemetry.flame,
      smoke: Number(telemetry.smoke) || 0,
      heat: Number(telemetry.heat) || 0,
      motion: !!telemetry.motion,
      timestamp: telemetry.timestamp || Date.now()
    });

    updateStatusBanner(data);
    trackAlertEvent(data);
    updateTiles(telemetry);
    updateCharts();
    updateOverrideButtons(data.command);

    var prediction = computePrediction(telemetry);
    updateGauge(prediction, telemetry);
  }

  function handleOffline(event) {
    var detail = event.detail || {};
    els.statusDetail.textContent = 'Connection lost — retrying…';
    addLogEntry(
      'Lost connection to panel (' + (detail.error || 'unknown error') + '), retrying in ' +
        Math.round((detail.nextRetryMs || 0) / 1000) + 's',
      'alert'
    );
  }

  /* ---------------------------------------------------------
     Boot
     --------------------------------------------------------- */

  document.addEventListener('DOMContentLoaded', function () {
    cacheElements();

    // Wired first so initCharts() failures below still have somewhere
    // to report to, and so a chart problem can't block log/override
    // setup or the live data feed from starting.
    setupLogToggle();
    addLogEntry('Control center initialized', 'info');

    try {
      initCharts();
    } catch (err) {
      addLogEntry('Chart rendering unavailable: ' + err.message, 'alert');
      // charts.smoke / charts.heat stay null; updateCharts() no-ops safely.
    }

    setupOverridePanel();

    window.addEventListener('extingo:data', handleData);
    window.addEventListener('extingo:offline', handleOffline);

    ExtingoAPI.startPolling(SERVER_URL);

    tickClock();
    setInterval(tickClock, 1000);
  });

})();
