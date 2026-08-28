/**
 * history.js
 * Rolling in-memory store of recent sensor readings, plus the trend /
 * rate-of-rise math the fire-prediction gauge and sensor tiles in
 * dashboard.js depend on.
 *
 * --- Contract exposed as window.ExtingoHistory (consumed by dashboard.js) ---
 *   pushReading({flame, smoke, heat, motion, timestamp})
 *       Appends a reading, evicting the oldest once the buffer exceeds
 *       MAX_READINGS.
 *   trend(field, n)            -> 'up' | 'down' | 'flat'
 *       Direction of `field` ('smoke' | 'heat') over the last n readings.
 *   rateOfRise(field, n)       -> number (field units per minute)
 *       Slope of `field` over the last n readings, in units/min.
 *   getLabels(field)           -> string[]
 *       Formatted timestamps (HH:MM:SS) for the x-axis, oldest first.
 *   getValues(field)           -> number[]
 *       Raw values for `field`, oldest first — same order/length as
 *       getLabels(), so index i of one matches index i of the other.
 *
 * dashboard.js owns the DOM (canvases, log list, tiles); this module
 * only owns data + the two Chart.js instances that read from it.
 */
(function () {
  'use strict';

  var MAX_READINGS = 40;

  /* Ignore no-op jitter below these deltas when deciding trend
     direction, so flat-but-noisy readings don't flicker ▲/▼. */
  var TREND_EPSILON = { smoke: 3, heat: 0.3 };

  var readings = [];

  function pushReading(reading) {
    readings.push({
      flame: !!reading.flame,
      smoke: Number(reading.smoke) || 0,
      heat: Number(reading.heat) || 0,
      motion: !!reading.motion,
      timestamp: reading.timestamp || Date.now()
    });
    if (readings.length > MAX_READINGS) {
      readings.splice(0, readings.length - MAX_READINGS);
    }
  }

  function windowOf(n) {
    if (!n || n >= readings.length) return readings;
    return readings.slice(readings.length - n);
  }

  function trend(field, n) {
    var win = windowOf(n);
    if (win.length < 2) return 'flat';

    var half = Math.max(1, Math.floor(win.length / 2));
    var earlier = win.slice(0, half);
    var later = win.slice(win.length - half);

    var avg = function (arr) {
      var sum = 0;
      for (var i = 0; i < arr.length; i++) sum += arr[i][field];
      return sum / arr.length;
    };

    var delta = avg(later) - avg(earlier);
    var epsilon = TREND_EPSILON[field] != null ? TREND_EPSILON[field] : 0;

    if (delta > epsilon) return 'up';
    if (delta < -epsilon) return 'down';
    return 'flat';
  }

  function rateOfRise(field, n) {
    var win = windowOf(n);
    if (win.length < 2) return 0;

    var first = win[0];
    var last = win[win.length - 1];
    var elapsedMs = last.timestamp - first.timestamp;
    if (elapsedMs <= 0) return 0;

    var deltaValue = last[field] - first[field];
    var elapsedMinutes = elapsedMs / 60000;
    return deltaValue / elapsedMinutes;
  }

  function formatLabel(timestamp) {
    return new Date(timestamp).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  }

  function getLabels() {
    return readings.map(function (r) { return formatLabel(r.timestamp); });
  }

  function getValues(field) {
    return readings.map(function (r) { return r[field]; });
  }

  window.ExtingoHistory = {
    pushReading: pushReading,
    trend: trend,
    rateOfRise: rateOfRise,
    getLabels: getLabels,
    getValues: getValues
  };
})();
