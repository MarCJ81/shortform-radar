/* ============================================================
   떡상 레이더 · engines/stats-engine.js
   ------------------------------------------------------------
   붙인 오픈소스 (모두 상업 배포 가능 라이선스)
     · PapaParse 5.4.1      MIT        robust CSV (따옴표·줄바꿈·BOM·구분자 자동)
     · simple-statistics 7.8.7 ISC     중앙값·사분위·표준편차·분위
     · Chart.js 4.4.6       MIT        바이럴 배수 분포 히스토그램

   의존성 없는 순수 JS(UMD). 브라우저에서는 window.RadarStats,
   node 에서는 require('./engines/stats-engine.js') 로 쓴다.
   라이브러리가 없어도 같은 함수가 내장 계산으로 동작한다(그래프만 생략).
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root, function (p) {
      try { return require(p); } catch (e) { return null; }
    });
  } else {
    root.RadarStats = factory(root, null);
  }
})(typeof self !== 'undefined' ? self : this, function (root, req) {
  'use strict';

  var VERSION = '1.0.0';

  var Papa = (root && root.Papa) || (req ? req('../assets/vendor/papaparse.min.js') : null) || null;
  var ss = (root && root.ss) || (req ? req('../assets/vendor/simple-statistics.min.js') : null) || null;

  var hasPapa = !!(Papa && typeof Papa.parse === 'function');
  var hasSS = !!(ss && typeof ss.median === 'function');

  function str(v) {
    return v === null || v === undefined ? '' : String(v);
  }

  function numbers(values) {
    var out = [];
    for (var i = 0; i < (values || []).length; i++) {
      var n = values[i];
      if (typeof n === 'string') n = Number(n.replace(/[,\s]/g, ''));
      if (typeof n === 'number' && isFinite(n) && n > 0) out.push(n);
    }
    return out;
  }

  /* ---------- 1. CSV (PapaParse) ---------- */

  function splitFallback(text) {
    var src = str(text).replace(/^\uFEFF/, '');
    var rows = [], row = [], field = '', inQuotes = false;
    for (var i = 0; i < src.length; i++) {
      var ch = src[i];
      if (inQuotes) {
        if (ch === '"') {
          if (src[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += ch;
      } else if (ch === '"') inQuotes = true;
      else if (ch === ',' || ch === ';') { row.push(field); field = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && src[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.length > 1 || row[0] !== '') rows.push(row);
        row = [];
      } else field += ch;
    }
    row.push(field);
    if (row.length > 1 || row[0] !== '') rows.push(row);
    return rows;
  }

  /**
   * parseCsv(text) → string[][]  (PapaParse 가 있으면 그 결과, 없으면 내장 파서)
   * - BOM·따옴표 안 줄바꿈·천 단위 쉼표·세미콜론 구분자를 처리한다.
   */
  function parseCsv(text, opts) {
    var src = str(text).replace(/^\uFEFF/, '');
    if (!src.trim()) return [];
    if (hasPapa) {
      var res = Papa.parse(src, Object.assign({
        skipEmptyLines: 'greedy',
        delimiter: '' // 자동 감지
      }, opts || {}));
      var rows = [];
      for (var i = 0; i < (res.data || []).length; i++) {
        var r = res.data[i];
        if (!r) continue;
        rows.push(r.map(function (c) { return c === null || c === undefined ? '' : String(c); }));
      }
      return rows;
    }
    return splitFallback(src);
  }

  /** 진단용: 어떤 파서·구분자를 썼고 오류가 있었는지 */
  function parseCsvDetailed(text, opts) {
    var src = str(text).replace(/^\uFEFF/, '');
    if (!hasPapa) return { rows: splitFallback(src), parser: 'builtin', delimiter: ',', errors: [] };
    var res = Papa.parse(src, Object.assign({ skipEmptyLines: 'greedy' }, opts || {}));
    var rows = [];
    for (var i = 0; i < (res.data || []).length; i++) {
      var r = res.data[i];
      if (!r) continue;
      rows.push(r.map(function (c) { return c === null || c === undefined ? '' : String(c); }));
    }
    return {
      rows: rows,
      parser: 'papaparse',
      delimiter: res.meta && res.meta.delimiter ? res.meta.delimiter : ',',
      errors: (res.errors || []).map(function (e) { return { row: e.row, message: e.message }; })
    };
  }

  /* ---------- 2. 분포 통계 (simple-statistics) ---------- */

  function sortedCopy(v) {
    return v.slice().sort(function (a, b) { return a - b; });
  }

  function quantileFallback(sorted, q) {
    if (!sorted.length) return 0;
    if (sorted.length === 1) return sorted[0];
    var pos = (sorted.length - 1) * q;
    var base = Math.floor(pos);
    var rest = pos - base;
    if (sorted[base + 1] !== undefined) return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
    return sorted[base];
  }

  function meanOf(v) {
    var sum = 0;
    for (var i = 0; i < v.length; i++) sum += v[i];
    return v.length ? sum / v.length : 0;
  }

  function sdOf(v, mean) {
    if (v.length < 2) return 0;
    var sum = 0;
    for (var i = 0; i < v.length; i++) {
      var d = v[i] - mean;
      sum += d * d;
    }
    return Math.sqrt(sum / (v.length - 1));
  }

  var r2 = function (n) { return Math.round(n * 100) / 100; };

  /**
   * statsOf(values) → { n, mean, median, q1, q3, iqr, sd, min, max, p90,
   *                      upperFence, outlierOf, outliers }
   * 값은 0보다 큰 유한수만 쓴다(조회수·배수).
   */
  function statsOf(values) {
    var v = numbers(values);
    if (!v.length) return null;
    var sorted = sortedCopy(v);
    var mean = hasSS ? ss.mean(v) : meanOf(v);
    var median = hasSS ? ss.median(v) : quantileFallback(sorted, 0.5);
    var q1 = hasSS ? ss.quantile(sorted, 0.25) : quantileFallback(sorted, 0.25);
    var q3 = hasSS ? ss.quantile(sorted, 0.75) : quantileFallback(sorted, 0.75);
    var sd = hasSS ? ss.standardDeviation(v) : sdOf(v, mean);
    var min = hasSS ? ss.min(v) : sorted[0];
    var max = hasSS ? ss.max(v) : sorted[sorted.length - 1];
    var p90 = hasSS ? ss.quantile(sorted, 0.9) : quantileFallback(sorted, 0.9);
    var iqr = q3 - q1;
    var upperFence = q3 + 1.5 * iqr;
    var outliers = [];
    for (var i = 0; i < sorted.length; i++) if (sorted[i] > upperFence) outliers.push(sorted[i]);
    return {
      n: v.length,
      mean: mean,
      median: median,
      q1: q1,
      q3: q3,
      iqr: iqr,
      sd: sd,
      min: min,
      max: max,
      p90: p90,
      upperFence: upperFence,
      outliers: outliers,
      engine: hasSS ? 'simple-statistics' : 'builtin'
    };
  }

  function zScore(value, st) {
    if (!st || !(st.sd > 0)) return 0;
    return (Number(value) - st.mean) / st.sd;
  }

  /** 값 배열 → 균등 폭 히스토그램 */
  function histogram(values, opts) {
    var v = numbers(values);
    if (!v.length) return { labels: [], counts: [], bins: [] };
    var o = opts || {};
    var binCount = Math.max(3, Math.min(24, Math.round(o.bins || Math.ceil(Math.sqrt(v.length)) + 1)));
    var min = Math.min.apply(null, v);
    var max = Math.max.apply(null, v);
    if (min === max) {
      return { labels: [fmt(min) + 'x'], counts: [v.length], bins: [{ from: min, to: max, count: v.length }] };
    }
    var width = (max - min) / binCount;
    var counts = new Array(binCount).fill(0);
    var labels = [];
    var bins = [];
    for (var b = 0; b < binCount; b++) {
      var from = min + width * b;
      var to = b === binCount - 1 ? max : min + width * (b + 1);
      labels.push(fmt(from) + '~' + fmt(to));
      bins.push({ from: from, to: to, count: 0 });
    }
    for (var i = 0; i < v.length; i++) {
      var idx = Math.floor((v[i] - min) / width);
      if (idx >= binCount) idx = binCount - 1;
      if (idx < 0) idx = 0;
      counts[idx] += 1;
      bins[idx].count += 1;
    }
    return { labels: labels, counts: counts, bins: bins, min: min, max: max, width: width };
  }

  function fmt(n) {
    var v = Math.round(n * 10) / 10;
    if (v >= 10000) return Math.round(v / 1000) + 'k';
    return String(v);
  }

  /** 사람이 읽는 한 줄 요약 */
  function summaryKo(st) {
    if (!st) return '배수 데이터가 아직 없습니다.';
    return '중앙값 ' + fmt(st.median) + 'x · Q1 ' + fmt(st.q1) + 'x · Q3 ' + fmt(st.q3) +
      'x · 표준편차 ' + fmt(st.sd) + ' · 이상치 ' + st.outliers.length + '건';
  }

  /* ---------- 3. Chart.js 히스토그램 ---------- */

  function cssVar(name, fallback) {
    try {
      if (root && root.getComputedStyle && root.document) {
        var v = root.getComputedStyle(root.document.documentElement).getPropertyValue(name);
        if (v && v.trim()) return v.trim();
      }
    } catch (e) { /* ignore */ }
    return fallback;
  }

  var charts = {};

  /**
   * drawDistribution(canvas, values, opts)
   * canvas: <canvas> 요소. Chart.js 가 없으면 null (패널은 숨긴다).
   * 반환: Chart 인스턴스 또는 null.
   */
  function drawDistribution(canvas, values, opts) {
    var Chart = root && root.Chart ? root.Chart : null;
    if (!Chart || !canvas) return null;
    var o = opts || {};
    var hist = histogram(values, o);
    if (!hist.counts.length) return null;
    var key = canvas.id || 'radar-dist';
    if (charts[key]) { charts[key].destroy(); delete charts[key]; }
    var accent = cssVar('--accent', '#7c3aed');
    var ink = cssVar('--ink', '#14181f');
    var line = cssVar('--line', 'rgba(20,24,31,.12)');
    charts[key] = new Chart(canvas.getContext('2d'), {
      type: 'bar',
      data: {
        labels: hist.labels,
        datasets: [{
          label: o.label || '영상 수',
          data: hist.counts,
          backgroundColor: accent + 'cc',
          borderColor: accent,
          borderWidth: 1,
          borderRadius: 4,
          maxBarThickness: 46
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 260 },
        plugins: {
          legend: { display: false },
          tooltip: {
            displayColors: false,
            callbacks: {
              title: function (items) { return '배수 ' + items[0].label; },
              label: function (item) { return item.parsed.y + '건'; }
            }
          }
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { color: ink, maxRotation: 0, autoSkip: true, font: { size: 10 } }
          },
          y: {
            beginAtZero: true,
            ticks: { color: ink, precision: 0, font: { size: 10 } },
            grid: { color: line }
          }
        }
      }
    });
    return charts[key];
  }

  function destroy(chartId) {
    if (charts[chartId]) { charts[chartId].destroy(); delete charts[chartId]; }
  }

  return {
    VERSION: VERSION,
    hasPapa: hasPapa,
    hasSS: hasSS,
    hasChart: !!(root && root.Chart),
    parseCsv: parseCsv,
    parseCsvDetailed: parseCsvDetailed,
    statsOf: statsOf,
    zScore: zScore,
    histogram: histogram,
    summaryKo: summaryKo,
    drawDistribution: drawDistribution,
    destroy: destroy
  };
});
