/* ============================================================
   떡상 레이더 · app.js
   UI, persistence (localStorage only), YouTube Data API v3 (BYOK).
   ============================================================ */
(function () {
  'use strict';

  const C = window.RadarCore;
  const D = window.RadarData;
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));

  const KEY = {
    theme: 'radar.v1.theme',
    apiKey: 'radar.v1.apiKey',
    items: 'radar.v1.items',
    board: 'radar.v1.board',
    watch: 'radar.v1.watchlist',
    quota: 'radar.v1.quota',
  };

  /* ---------- storage ---------- */
  const store = {
    get(k, fallback) {
      try {
        const raw = localStorage.getItem(k);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (e) { return fallback; }
    },
    set(k, v) {
      try { localStorage.setItem(k, JSON.stringify(v)); return true; }
      catch (e) { return false; }
    },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} },
  };

  const state = {
    demo: D.materializeDemo(Date.now()),
    userItems: store.get(KEY.items, []) || [],
    board: store.get(KEY.board, {}) || {},
    watchlist: store.get(KEY.watch, []) || [],
    apiKey: store.get(KEY.apiKey, '') || '',
    quota: store.get(KEY.quota, null),
    theme: store.get(KEY.theme, 'light') === 'dark' ? 'dark' : 'light',
    filters: { platform: 'all', country: 'all', minMultiple: 0, period: 0, category: 'all', collectedOnly: false },
    query: '',
    sort: 'score',
    tab: 'radar',
    watchOnlyOutliers: false,
    now: Date.now(),
  };

  window.__radar = { state, C, refresh: () => renderAll() };

  function allItems() {
    return state.demo.concat(state.userItems);
  }

  function findItem(id) {
    return allItems().find((i) => i.id === id) || null;
  }

  function persistBoard() { store.set(KEY.board, state.board); }
  function persistItems() { store.set(KEY.items, state.userItems); }

  /* ---------- utils ---------- */
  const esc = (s) => String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const nf = (n) => (n === null || n === undefined || !isFinite(n)) ? '—' : C.formatCount(n);

  function icon(name, size) {
    const s = size || 14;
    const paths = {
      heart: '<path d="M10 16.6s-5.6-3.3-5.6-7.2A3.3 3.3 0 0 1 10 7.1a3.3 3.3 0 0 1 5.6 2.3c0 3.9-5.6 7.2-5.6 7.2z"/>',
      comment: '<path d="M16.4 11.6a2.6 2.6 0 0 1-2.6 2.6H8.2L4.6 16.6v-5a2.6 2.6 0 0 1 2.6-2.6h6.6a2.6 2.6 0 0 1 2.6 2.6z"/>',
      bolt: '<path d="M11 2.8L4.6 11h4.2l-1 6.2L14.4 9h-4.2z"/>',
      trophy: '<path d="M6.4 4h7.2v3.1a3.6 3.6 0 0 1-7.2 0z"/><path d="M6.4 5.4H4.2v1.2a2.4 2.4 0 0 0 2.2 2.4M13.6 5.4h2.2v1.2a2.4 2.4 0 0 1-2.2 2.4M10 10.7v3.1M7.4 16.8h5.2"/>',
      bookmark: '<path d="M6 3.6h8v13l-4-2.7-4 2.7z"/>',
      spark: '<path d="M10 2.6l1.6 4.2 4.2 1.6-4.2 1.6L10 14.2 8.4 10 4.2 8.4 8.4 6.8z"/><path d="M15.2 13.2l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>',
      copy: '<rect x="7" y="7" width="9" height="10" rx="2"/><path d="M12.6 4.6H5.8A1.8 1.8 0 0 0 4 6.4v7.2"/>',
      plus: '<path d="M10 4.5v11M4.5 10h11"/>',
      external: '<path d="M11.4 4.6H15V8.2M15 4.6l-5.4 5.4"/><path d="M14.4 11v4.2H4.6V5.6h4.2"/>',
      chevron: '<path d="M7.6 4.8L12.8 10l-5.2 5.2"/>',
      trash: '<path d="M4.6 6.4h10.8M8 6.4V4.6h4v1.8M6.4 6.4l.6 9h6l.6-9"/>',
      check: '<path d="M4.6 10.4l3.4 3.4 7.4-7.4"/>',
    };
    return '<svg viewBox="0 0 20 20" width="' + s + '" height="' + s + '" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + (paths[name] || '') + '</svg>';
  }

  function toast(msg, type) {
    const root = $('#toastRoot');
    while (root.children.length >= 3) root.removeChild(root.firstChild);
    const el = document.createElement('div');
    el.className = 'toast' + (type === 'warn' ? ' warn' : '');
    el.textContent = msg;
    root.appendChild(el);
    setTimeout(() => { el.style.transition = 'opacity .25s'; el.style.opacity = '0'; }, 1800);
    setTimeout(() => el.remove(), 2100);
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
      throw new Error('no clipboard');
    } catch (e) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch (err) { return false; }
    }
  }

  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function debounce(fn, ms) {
    let t = null;
    return function () {
      clearTimeout(t);
      const args = arguments;
      t = setTimeout(() => fn.apply(null, args), ms);
    };
  }

  /* ---------- cover art ---------- */
  const MOTIFS = {
    food: '<circle cx="186" cy="252" r="106" fill="none" stroke="rgba(255,255,255,.26)" stroke-width="13"/><circle cx="186" cy="252" r="66" fill="rgba(255,255,255,.16)"/><path d="M72 460c30-26 74-26 104 0" stroke="rgba(255,255,255,.3)" stroke-width="10" fill="none" stroke-linecap="round"/><circle cx="292" cy="150" r="26" fill="rgba(255,255,255,.2)"/>',
    beauty: '<rect x="152" y="168" width="72" height="180" rx="26" fill="rgba(255,255,255,.24)"/><rect x="174" y="140" width="28" height="34" rx="10" fill="rgba(255,255,255,.34)"/><circle cx="286" cy="212" r="34" fill="none" stroke="rgba(255,255,255,.3)" stroke-width="9"/><path d="M236 420c34 0 62 20 76 48" stroke="rgba(255,255,255,.26)" stroke-width="12" fill="none" stroke-linecap="round"/>',
    home: '<rect x="118" y="196" width="140" height="128" rx="14" fill="rgba(255,255,255,.2)"/><path d="M112 202l76-58 76 58" stroke="rgba(255,255,255,.4)" stroke-width="11" fill="none" stroke-linecap="round"/><rect x="162" y="252" width="52" height="72" rx="8" fill="rgba(255,255,255,.32)"/>',
    fitness: '<rect x="120" y="238" width="58" height="24" rx="9" fill="rgba(255,255,255,.28)"/><rect x="196" y="238" width="58" height="24" rx="9" fill="rgba(255,255,255,.28)"/><rect x="176" y="244" width="22" height="12" rx="5" fill="rgba(255,255,255,.4)"/><path d="M96 300c26 34 66 46 104 40" stroke="rgba(255,255,255,.26)" stroke-width="12" fill="none" stroke-linecap="round"/>',
    money: '<rect x="116" y="316" width="34" height="66" rx="7" fill="rgba(255,255,255,.22)"/><rect x="166" y="286" width="34" height="96" rx="7" fill="rgba(255,255,255,.3)"/><rect x="216" y="246" width="34" height="136" rx="7" fill="rgba(255,255,255,.4)"/><path d="M112 224l46-30 40 22 44-44" stroke="rgba(255,255,255,.45)" stroke-width="9" fill="none" stroke-linecap="round"/>',
    tech: '<rect x="112" y="196" width="148" height="104" rx="12" fill="rgba(255,255,255,.2)"/><rect x="128" y="212" width="116" height="72" rx="6" fill="rgba(0,0,0,.3)"/><path d="M150 330h72M186 300v30" stroke="rgba(255,255,255,.38)" stroke-width="10" stroke-linecap="round"/><circle cx="286" cy="182" r="22" fill="rgba(255,255,255,.26)"/>',
    pet: '<ellipse cx="186" cy="276" rx="46" ry="38" fill="rgba(255,255,255,.28)"/><circle cx="140" cy="222" r="19" fill="rgba(255,255,255,.28)"/><circle cx="178" cy="206" r="19" fill="rgba(255,255,255,.28)"/><circle cx="218" cy="208" r="19" fill="rgba(255,255,255,.28)"/><circle cx="250" cy="232" r="17" fill="rgba(255,255,255,.28)"/>',
    travel: '<circle cx="248" cy="190" r="36" fill="rgba(255,255,255,.3)"/><path d="M96 344l66-92 52 64 34-40 62 68z" fill="rgba(255,255,255,.22)"/><path d="M96 344h196" stroke="rgba(255,255,255,.3)" stroke-width="8" stroke-linecap="round"/>',
    default: '<circle cx="186" cy="252" r="86" fill="none" stroke="rgba(255,255,255,.26)" stroke-width="12"/><circle cx="186" cy="252" r="50" fill="none" stroke="rgba(255,255,255,.36)" stroke-width="9"/><path d="M186 252l54-40" stroke="rgba(255,255,255,.5)" stroke-width="9" stroke-linecap="round"/>',
  };

  const MOTIF_BY_CATEGORY = {
    '뷰티·패션': 'beauty',
    '푸드·맛집': 'food',
    '리빙·꿀템': 'home',
    '테크·AI': 'tech',
    '재테크·썰': 'money',
    '운동·헬스': 'fitness',
    '여행·일상': 'travel',
    '기타': 'default',
  };

  function coverSVG(item) {
    const cover = item.cover || {};
    const pal = D.PALETTES[cover.palette] || D.PALETTES.slate;
    const uid = 'cg' + String(item.id).replace(/[^a-zA-Z0-9_-]/g, '');
    const motif = MOTIFS[cover.motif] || MOTIFS[MOTIF_BY_CATEGORY[item.category]] || MOTIFS.default;
    const lines = (cover.text && cover.text.length ? cover.text : C.coverLines(item.caption || '레퍼런스')).slice(0, 2);
    const longest = Math.max.apply(null, lines.map((l) => String(l).length));
    const size = longest <= 5 ? 56 : longest <= 8 ? 45 : longest <= 11 ? 37 : 31;
    const gap = size * 1.2;
    const variant = Math.abs(hashCode(String(item.id))) % 3;
    const centerY = [312, 354, 258][variant];
    const firstY = centerY - ((lines.length - 1) * gap) / 2;
    const text = lines.map((line, i) => (
      '<text class="cover-text" x="186" y="' + (firstY + i * gap).toFixed(1) + '" text-anchor="middle" ' +
      'font-size="' + size + '" fill="#ffffff" stroke="rgba(10,7,12,.6)" stroke-width="' + Math.max(5, size * 0.15).toFixed(1) + '" ' +
      'stroke-linejoin="round" paint-order="stroke" letter-spacing="-1.6">' + esc(line) + '</text>'
    )).join('');
    const underlineY = firstY + (lines.length - 1) * gap + size * 0.66;
    const tag = cover.tag || '';
    const tagW = Math.min(230, tag.length * (tag.match(/[가-힣]/) ? 14 : 8.6) + 30);

    return '<svg viewBox="0 0 372 640" preserveAspectRatio="xMidYMid slice" role="img" aria-label="' + esc(lines.join(' ')) + ' 커버 이미지">' +
      '<defs>' +
      '<linearGradient id="' + uid + 'b" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="' + pal[0] + '"/><stop offset=".55" stop-color="' + pal[1] + '"/><stop offset="1" stop-color="' + pal[2] + '"/>' +
      '</linearGradient>' +
      '<radialGradient id="' + uid + 'r" cx="28%" cy="16%" r="82%">' +
      '<stop offset="0" stop-color="#ffffff" stop-opacity=".3"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/>' +
      '</radialGradient>' +
      '</defs>' +
      '<rect width="372" height="640" fill="url(#' + uid + 'b)"/>' +
      '<rect width="372" height="640" fill="url(#' + uid + 'r)"/>' +
      '<circle cx="330" cy="72" r="130" fill="rgba(255,255,255,.07)"/>' +
      '<circle cx="26" cy="596" r="168" fill="rgba(0,0,0,.16)"/>' +
      '<path d="M-30 470L372 120v84L50 640H-30z" fill="rgba(255,255,255,.05)"/>' +
      '<g opacity=".95">' + motif + '</g>' +
      '<rect x="11" y="11" width="350" height="618" rx="20" fill="none" stroke="rgba(255,255,255,.13)"/>' +
      (tag ? '<g><rect x="' + (186 - tagW / 2).toFixed(1) + '" y="98" width="' + tagW.toFixed(1) + '" height="26" rx="13" fill="rgba(8,7,12,.3)" stroke="rgba(255,255,255,.16)"/>' +
        '<text x="186" y="115" text-anchor="middle" font-size="12" font-weight="700" fill="rgba(255,255,255,.92)" letter-spacing="1.1">' + esc(tag) + '</text></g>' : '') +
      text +
      '<rect x="' + (186 - 36) + '" y="' + underlineY.toFixed(1) + '" width="72" height="6" rx="3" fill="rgba(255,255,255,.8)"/>' +
      '</svg>';
  }

  function thumbHTML(item) {
    const svg = coverSVG(item);
    if (item.thumbnail && item.platform === 'youtube') {
      return svg + '<img class="thumb" src="' + esc(item.thumbnail) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display=\'none\'">';
    }
    return svg;
  }

  /* ---------- card ---------- */
  function cardHTML(item, opts) {
    const o = opts || {};
    const m = C.computeMetrics(item, state.now);
    const saved = !!state.board[item.id];
    const tier = m.pending ? 'pending' : m.tier;
    const multiple = m.pending ? '미확인' : C.formatMultiple(m.viralMultiple);
    const platformLabel = C.PLATFORM_LABEL[item.platform] || item.platform;
    const product = item.product && o.showProduct
      ? '<div class="product-strip"><span aria-hidden="true">🛍</span><span class="p-name">' + esc(item.product.name) + '</span><span class="p-price">' + C.formatCount(item.product.price) + '원</span></div>'
      : '';

    return '<article class="card' + (saved ? ' is-saved' : '') + '" data-id="' + esc(item.id) + '" data-action="open-detail" tabindex="0" role="button" aria-label="' + esc(item.creator + ' · ' + C.itemTitle(item)) + '">' +
      '<div class="cover">' +
      thumbHTML(item) +
      '<span class="badge platform" data-p="' + esc(item.platform) + '"><i class="pdot"></i>' + esc(platformLabel) + '·' + esc(item.country) + '</span>' +
      '<span class="badge outlier tier-' + tier + '" title="채널 평균 조회수 대비 배수">' + esc(multiple) + '</span>' +
      '<div class="cover-meta"><span class="views">' + esc(m.pending ? '지표 없음' : nf(item.views)) + '</span><span class="sep"></span><span class="tagline">' + (item.durationSec ? '세로 · ' + item.durationSec + '초' : '세로') + '</span><span class="time">' + esc(C.relativeTime(item.postedAt, state.now)) + '</span></div>' +
      coverRail() +
      '</div>' +
      '<div class="card-body">' +
      '<div class="creator-row"><span class="star" aria-hidden="true">★</span><span class="creator" title="' + esc(item.creatorName || item.creator) + '">' + esc(item.creator) + '</span><span class="cat">' + esc(item.category) + '</span></div>' +
      '<p class="caption">' + esc(item.caption) + '</p>' +
      '<div class="hashtags">' + esc((item.hashtags || []).slice(0, 3).join(' ')) + '</div>' +
      product +
      '<div class="card-actions">' +
      '<button type="button" class="btn ' + (saved ? 'is-on' : 'btn-ghost') + '" data-action="toggle-save" data-id="' + esc(item.id) + '" aria-pressed="' + saved + '">' + icon('bookmark', 13) + '<span>' + (saved ? '저장됨' : '보드 저장') + '</span></button>' +
      '<button type="button" class="btn btn-ghost" data-action="open-hook" data-id="' + esc(item.id) + '">' + icon('spark', 13) + '<span>훅 분석</span></button>' +
      '</div>' +
      '<div class="kpis">' +
      kpi('heart', '좋아요', m.pending ? '—' : nf(item.likes), '') +
      kpi('comment', '댓글', m.pending ? '—' : nf(item.comments), '') +
      kpi('bolt', 'VPH', m.pending ? '—' : C.formatVph(m.vph), 'vph') +
      kpi('trophy', '점수', m.pending ? '—' : String(m.score), 'score') +
      '</div>' +
      '</div></article>';
  }

  function coverRail() {
    return '<div class="cover-rail" aria-hidden="true">' +
      '<span>' + icon('heart', 15) + '</span><span>' + icon('comment', 15) + '</span><span>' + icon('bookmark', 15) + '</span></div>';
  }

  function kpi(iconName, label, value, cls) {
    return '<div class="kpi ' + cls + '"><span class="k-label">' + icon(iconName, 10) + label + '</span><span class="k-value">' + esc(value) + '</span></div>';
  }

  /* ---------- filters ---------- */
  function chipGroup(label, options, activeValue, key) {
    return '<div class="chip-group" role="group" aria-label="' + esc(label) + '"><span class="chip-label">' + esc(label) + '</span>' +
      options.map((o) => (
        '<button type="button" class="chip' + (String(o.id) === String(activeValue) ? ' is-on' : '') + '" data-filter="' + key + '" data-value="' + esc(o.id) + '" aria-pressed="' + (String(o.id) === String(activeValue)) + '" title="' + esc(o.full || o.label) + '">' + esc(o.label) + '</button>'
      )).join('') + '</div>';
  }

  const CATEGORY_SHORT = {
    '뷰티·패션': '뷰티·패션', '푸드·맛집': '푸드·맛집', '리빙·꿀템': '리빙·꿀템', '테크·AI': '테크·AI',
    '재테크·썰': '재테크·썰', '운동·헬스': '운동', '여행·일상': '여행', '기타': '기타',
  };

  function renderChips() {
    const platformOpts = [{ id: 'all', label: '전체' }].concat(C.PLATFORMS.slice(1).map((p) => ({ id: p.id, label: p.label, full: p.label })));
    const categoryOpts = [{ id: 'all', label: '전체' }].concat(C.CATEGORIES.map((c) => ({ id: c, label: CATEGORY_SHORT[c] || c, full: c })));
    const collectedOn = !!state.filters.collectedOnly;
    const collectedN = state.userItems.length;
    const collectedToggle =
      '<button type="button" class="filter-toggle' + (collectedOn ? ' is-on' : '') + (collectedN ? '' : ' is-empty') + '" ' +
      'data-action="toggle-collected-only" aria-pressed="' + collectedOn + '" ' +
      'title="데모 ' + state.demo.length + '건을 빼고, YouTube API로 실시간 수집했거나 링크·CSV로 직접 넣은 영상만 봅니다">' +
      '<span class="ft-dot" aria-hidden="true"></span>실시간 수집만' +
      '<span class="ft-count">' + collectedN + '</span></button>';
    $('#filterChips').innerHTML =
      '<div class="chip-row">' +
      chipGroup('플랫폼', platformOpts, state.filters.platform, 'platform') +
      chipGroup('국가', C.COUNTRIES, state.filters.country, 'country') +
      chipGroup('배수', C.MULTIPLIERS, String(state.filters.minMultiple), 'minMultiple') +
      chipGroup('기간', C.PERIODS, String(state.filters.period), 'period') +
      '</div>' +
      '<div class="chip-row secondary">' +
      '<div class="chip-scroll">' + chipGroup('카테고리', categoryOpts, state.filters.category, 'category') + '</div>' +
      collectedToggle +
      '<button type="button" class="filter-reset" data-action="reset-filters" title="모든 필터 초기화">초기화</button>' +
      '<label class="sort" for="sortSelect"><span>정렬</span><select id="sortSelect">' +
      C.SORTS.map((s) => '<option value="' + s.id + '"' + (s.id === state.sort ? ' selected' : '') + '>' + esc(s.label) + '</option>').join('') +
      '</select></label>' +
      '</div>';
  }

  function renderSummary() {
    const items = C.visibleItems(allItems(), state, state.now);
    const s = C.summarize(items, state.now);
    $('#summary').innerHTML =
      stat(items.length, '모은 영상') +
      stat('평균 ' + (s.avgMultiple || 0) + 'x', '바이럴 배수') +
      stat(s.bestScore, '최고 점수', true) +
      stat(s.fresh + '건', '24시간 급상승');
  }

  function stat(v, label, hot) {
    return '<div class="stat' + (hot ? ' hot' : '') + '"><b>' + esc(v) + '</b><span>' + esc(label) + '</span></div>';
  }

  function renderSourceNote() {
    const apiItems = state.userItems.filter((i) => i.source === 'youtube-api').length;
    const urlItems = state.userItems.filter((i) => i.source === 'url').length;
    const csvItems = state.userItems.filter((i) => i.source === 'csv').length;
    const qty = state.quota && state.quota.date === C.quotaDateKey(state.now) ? state.quota : { search: 0, units: 0 };
    let html;
    const demoNote = (state.filters.collectedOnly ? '데모 ' + state.demo.length + '건 숨김' : '데모 수치는 시뮬레이션');
    if (state.apiKey) {
      html = '<span class="badge-live" style="color:var(--ok);font-weight:800">● 실시간 연결</span>' +
        '<b>YouTube API</b> 연결됨 · 오늘 검색 <b>' + qty.search + ' / ' + C.QUOTA.searchPerDay + '</b>회' +
        (apiItems ? ' · 실시간 수집 ' + apiItems + '건' : '') +
        '<span class="dot-sep">|</span><span class="note-sub">' + demoNote + '</span>' +
        '<button class="link" data-action="open-settings">키 관리</button>';
    } else {
      html = '<span aria-hidden="true">📡</span><span class="note-line"><b>' +
        (state.filters.collectedOnly ? '데모 ' + state.demo.length + '건 숨김' : '데모 ' + state.demo.length + '건') +
        '</b> · 수치는 시뮬레이션</span>' +
        '<span class="dot-sep">|</span><span class="note-sub">API 키를 넣으면 실제 쇼츠를 실시간 수집합니다</span>' +
        '<button class="link" data-action="open-settings">API 연결</button>';
    }
    if (urlItems || csvItems) {
      html += '<span class="dot-sep">|</span><span class="note-line">내가 추가 ' + (urlItems + csvItems) + '건</span>';
    }
    $('#sourceNote').innerHTML = html;
  }

  function renderGrid() {
    const items = C.visibleItems(allItems(), state, state.now);
    $('#grid').innerHTML = items.map((i) => cardHTML(i)).join('');
    const empty = items.length === 0;
    if (empty) {
      const hint = $('#empty .muted');
      if (hint) {
        hint.textContent = state.filters.collectedOnly && !state.userItems.length
          ? '데모 ' + state.demo.length + '건은 숨겨져 있습니다. YouTube API나 링크·CSV로 영상을 먼저 모으면 여기에 쌓입니다.'
          : '필터를 풀거나 새 키워드로 검색해 보세요.';
      }
    }
    $('#empty').hidden = !empty;
    $('#grid').hidden = empty;
  }

  function updateTabBadge() {
    const n = Object.keys(state.board).length;
    const el = $('#tabBoardCount');
    el.textContent = String(n);
    el.hidden = n === 0;
  }

  /* ---------- commerce ---------- */
  function renderCommerce() {
    const items = allItems().filter((i) => i.product);
    const gmvByCat = {};
    let total = 0;
    items.forEach((i) => {
      const g = i.product.gmv || 0;
      total += g;
      gmvByCat[i.category] = (gmvByCat[i.category] || 0) + g;
    });
    const cats = Object.keys(gmvByCat).sort((a, b) => gmvByCat[b] - gmvByCat[a]);
    const max = cats.length ? gmvByCat[cats[0]] : 1;

    $('#commerceSummary').innerHTML =
      stat(C.formatCount(total) + '원', '예상 GMV 합계', true) +
      stat(items.length + '개', '상품') +
      stat(items.length ? C.formatCount(Math.round(total / items.length)) + '원' : '—', '상품당 평균');

    $('#commerceCategories').innerHTML = '<div class="panel-head"><h2>카테고리별 예상 GMV</h2><span class="muted">데모 추정</span></div>' +
      cats.map((c) => (
        '<div class="bar-row"><span class="bl" title="' + esc(c) + '">' + esc(c) + '</span>' +
        '<span class="bar-track"><i class="bar-fill" style="width:' + Math.max(4, Math.round((gmvByCat[c] / max) * 100)) + '%"></i></span>' +
        '<span class="bv">' + esc(C.formatCount(gmvByCat[c])) + '원</span></div>'
      )).join('') || '<p class="muted">상품 데이터가 없습니다.</p>';

    const top = items.slice().sort((a, b) => (b.product.gmv || 0) - (a.product.gmv || 0)).slice(0, 6);
    $('#commerceTop').innerHTML = '<div class="panel-head"><h2>영상으로 팔린 상품 TOP</h2><span class="muted">' + items.length + '개 중</span></div>' +
      '<div class="top-list">' + top.map((i, idx) => (
        '<div class="top-item" role="button" tabindex="0" data-action="open-detail" data-id="' + esc(i.id) + '">' +
        '<span class="rank">' + (idx + 1) + '</span>' +
        '<span class="ti-main"><span class="ti-name">' + esc(i.product.name) + '</span><span class="ti-sub">' + esc(i.creator) + ' · ' + esc(C.formatCount(i.views)) + '회</span></span>' +
        '<span class="ti-gmv">' + esc(C.formatCount(i.product.gmv)) + '원</span></div>'
      )).join('') + '</div>';

    $('#commerceCount').textContent = items.length + '건';
    $('#commerceGrid').innerHTML = items.map((i) => cardHTML(i, { showProduct: true })).join('');
  }

  /* ---------- accounts ---------- */
  function normHandle(v) {
    let s = String(v || '').trim().toLowerCase().replace(/\s+/g, '');
    if (!s) return '';
    if (s[0] !== '@') s = '@' + s;
    return s;
  }

  function renderAccounts() {
    const list = state.watchlist;
    const all = allItems();
    const wrap = $('#accountList');
    $('#accountsSummary').innerHTML =
      stat(list.length + '개', '추적 계정') +
      stat(all.filter((i) => list.indexOf(i.creator) !== -1).length + '건', '모은 영상');

    if (!list.length) {
      const suggest = C.sortItems(all.filter((i) => !C.isPending(i)), 'score', state.now).slice(0, 3);
      wrap.innerHTML = '<div class="empty"><p><strong>아직 추적 중인 계정이 없습니다.</strong></p>' +
        '<p class="muted">핸들을 넣거나, 지금 떡상 중인 계정을 바로 추가해 보세요.</p>' +
        '<div style="display:flex;gap:6px;justify-content:center;flex-wrap:wrap">' +
        suggest.map((i) => '<button class="btn btn-ghost btn-sm" data-action="add-watch" data-handle="' + esc(i.creator) + '">+ ' + esc(i.creator) + '</button>').join('') +
        '</div></div>';
      return;
    }

    wrap.innerHTML = list.map((handle) => {
      let items = all.filter((i) => i.creator === handle);
      if (state.watchOnlyOutliers) {
        items = items.filter((i) => {
          const m = C.computeMetrics(i, state.now);
          return m.viralMultiple !== null && m.viralMultiple >= 2;
        });
      }
      const metrics = items.map((i) => C.computeMetrics(i, state.now)).filter((m) => !m.pending);
      const avg = metrics.length ? Math.round((metrics.reduce((a, m) => a + m.viralMultiple, 0) / metrics.length) * 10) / 10 : 0;
      const best = metrics.length ? Math.max.apply(null, metrics.map((m) => m.viralMultiple)) : 0;
      const hits = metrics.filter((m) => m.viralMultiple >= 2).length;
      const top = metrics.length ? items[metrics.indexOf(metrics.reduce((a, b) => (b.score > a.score ? b : a)))] : null;
      const ordered = C.sortItems(items, 'score', state.now).slice(0, 8);
      return '<div class="account">' +
        '<div class="account-head">' +
        '<span class="avatar">' + esc(handle.replace('@', '').slice(0, 1).toUpperCase()) + '</span>' +
        '<div><div class="account-name">' + esc(handle) + '</div><div class="account-sub">' + esc((items[0] && items[0].creatorName) || '추적 중') + ' · 영상 ' + items.length + '건</div></div>' +
        '<div class="account-stats">' +
        stat(metrics.length ? '평균 ' + avg + 'x' : '—', '배수') + stat(best ? C.formatMultiple(best) : '—', '최고') + stat(hits + '건', '떡상(2x+)') +
        '<button class="btn btn-ghost btn-sm" data-action="remove-watch" data-handle="' + esc(handle) + '" aria-label="' + esc(handle) + ' 추적 해제">' + icon('trash', 12) + '</button>' +
        '</div></div>' +
        (ordered.length
          ? '<div class="account-grid">' + ordered.map((i) => {
            const m = C.computeMetrics(i, state.now);
            return '<div class="mini-card" role="button" tabindex="0" data-action="open-detail" data-id="' + esc(i.id) + '">' +
              '<span class="mini-thumb">' + thumbHTML(i) + '</span>' +
              '<span class="mini-main"><span class="mini-title">' + esc(C.itemTitle(i)) + '</span>' +
              '<span class="mini-meta"><b>' + (m.pending ? '—' : C.formatMultiple(m.viralMultiple)) + '</b> · ' + (m.pending ? '지표 없음' : nf(i.views)) + '</span></span></div>';
          }).join('') + '</div>'
          : '<p class="muted" style="margin-top:10px;font-size:12px">' + (state.watchOnlyOutliers ? '2x 이상 영상이 없습니다.' : '수집된 영상이 없습니다. 새로 수집하면 여기에 쌓입니다.') + '</p>') +
        (top ? '<p class="muted" style="margin-top:10px;font-size:11.5px">최고 점수 영상: ' + esc(C.itemTitle(top)) + '</p>' : '') +
        '</div>';
    }).join('');
  }

  /* ---------- board ---------- */
  const COL_COLORS = { saved: '#94a3b8', scripting: '#f59e0b', shooting: '#3b82f6', done: '#16a34a' };

  function renderBoard() {
    const items = allItems();
    const groups = C.boardGroups(items, state.board);
    const total = groups.reduce((a, g) => a + g.items.length, 0);
    $('#boardEmpty').hidden = total > 0;
    $('#kanban').hidden = total === 0;
    $('#kanban').innerHTML = groups.map((g) => (
      '<section class="col" data-status="' + g.id + '">' +
      '<div class="col-head"><span class="col-dot" style="background:' + COL_COLORS[g.id] + '"></span><h3>' + esc(g.label) + '</h3><span class="col-count">' + g.items.length + '</span></div>' +
      '<div class="col-body" data-drop="' + g.id + '">' +
      (g.items.length ? g.items.map((i) => kcardHTML(i, g.id)).join('') : '<div class="col-empty">카드를 여기로 옮겨보세요</div>') +
      '</div></section>'
    )).join('');
    updateTabBadge();
  }

  function kcardHTML(item, status) {
    const entry = state.board[item.id] || {};
    const m = C.computeMetrics(item, state.now);
    return '<div class="kcard" draggable="true" data-id="' + esc(item.id) + '">' +
      '<span class="kthumb">' + thumbHTML(item) + '</span>' +
      '<div class="kmain">' +
      '<div class="ktitle" data-action="open-detail" data-id="' + esc(item.id) + '">' + esc(C.itemTitle(item)) + '</div>' +
      '<div class="kmeta"><b>' + (m.pending ? '—' : C.formatMultiple(m.viralMultiple)) + '</b><span>' + esc(item.creator) + '</span></div>' +
      ((entry.tags || []).length ? '<div class="ktags">' + entry.tags.map((t) => '<span class="ktag">#' + esc(t) + '</span>').join('') + '</div>' : '') +
      (entry.memo ? '<div class="kmemo">' + esc(entry.memo) + '</div>' : '') +
      '<div class="kbtns">' +
      '<button class="kbtn" data-action="kcard-prev" data-id="' + esc(item.id) + '" title="이전 단계">←</button>' +
      '<button class="kbtn" data-action="kcard-next" data-id="' + esc(item.id) + '" title="다음 단계">→</button>' +
      '<button class="kbtn" data-action="kcard-memo" data-id="' + esc(item.id) + '">메모</button>' +
      '<button class="kbtn" data-action="kcard-remove" data-id="' + esc(item.id) + '" title="보드에서 빼기">✕</button>' +
      '</div></div></div>';
  }

  function moveStatus(id, status) {
    const s = C.normalizeStatus(status);
    if (!s || !state.board[id]) return;
    state.board[id].status = s;
    persistBoard();
    renderBoard();
    renderGrid();
    renderSummary();
  }

  /* ---------- AI tab ---------- */
  function renderAI() {
    const items = allItems();
    const stats = C.hookStats(items, state.now);
    const maxScore = Math.max.apply(null, stats.map((s) => s.avgScore).concat([1]));
    $('#aiSummary').innerHTML =
      stat(stats[0] ? stats[0].type : '—', '최고 성과 훅', true) +
      stat(items.length + '건', '분석 대상');
    $('#aiRange').textContent = '평균 떡상 점수 기준';
    $('#hookStats').innerHTML = stats.map((s) => (
      '<div class="hook-row"><span class="hname">' + esc(s.type) + '</span>' +
      '<span class="hbar"><i style="width:' + Math.max(2, Math.round((s.avgScore / maxScore) * 100)) + '%"></i></span>' +
      '<span class="hval">' + s.avgScore + '점</span>' +
      '<span class="hcnt">' + s.count + '건</span></div>'
    )).join('');

    $('#hookLibrary').innerHTML = C.HOOK_LIBRARY.map((h) => (
      '<div class="hook-card"><h4>' + esc(h.type) + '</h4>' +
      '<p class="hformula">' + esc(h.formula) + '</p>' +
      '<button class="btn btn-ghost" data-action="copy-template" data-type="' + esc(h.type) + '">' + icon('copy', 12) + ' 템플릿 복사</button></div>'
    )).join('');

    const options = C.sortItems(items.filter((i) => !C.isPending(i)), 'score', state.now).slice(0, 40);
    const current = $('#studioSelect') ? $('#studioSelect').value : '';
    const fallback = options.find((i) => i.country === 'KR') || options[0];
    const selectedId = current && options.some((i) => i.id === current) ? current : (fallback && fallback.id);
    const item = options.find((i) => i.id === selectedId);
    const productVal = $('#studioProduct') ? $('#studioProduct').value : '';
    const script = item ? C.buildScript(item, { product: productVal || undefined }) : '';
    const prompt = item ? C.buildPrompt(item, { product: productVal || undefined }) : '';

    $('#studio').innerHTML = '<div class="panel-head"><h2>대본 스튜디오</h2><span class="muted">레퍼런스 구조 그대로, 내 제품 문장으로</span></div>' +
      '<div class="studio-grid"><div>' +
      '<div class="field"><label for="studioSelect">레퍼런스 영상</label><select id="studioSelect">' +
      options.map((i) => '<option value="' + esc(i.id) + '"' + (i.id === selectedId ? ' selected' : '') + '>' + esc(C.formatMultiple(C.computeMetrics(i, state.now).viralMultiple) + ' · ' + i.creator + ' · ' + C.itemTitle(i).slice(0, 26)) + '</option>').join('') +
      '</select></div>' +
      '<div class="field"><label for="studioProduct">내 제품·주제 (선택)</label><input id="studioProduct" type="text" placeholder="예: 무선 청소기, 우리 가게 점심 메뉴" value="' + esc(productVal) + '" /></div>' +
      '<p class="form-note">훅 유형 <b>' + esc(item ? item.hookType : '—') + '</b> · 구조 0~3초 훅 → 3~8초 문제 → 8~15초 증거 → 15~22초 반전 → 22~25초 CTA</p>' +
      '<div class="studio-actions">' +
      '<button class="btn btn-primary btn-sm" data-action="copy-script">' + icon('copy', 12) + ' 대본 복사</button>' +
      '<button class="btn btn-ghost btn-sm" data-action="copy-prompt">' + icon('spark', 12) + ' LLM 프롬프트 복사</button>' +
      '</div></div>' +
      '<div><pre class="script-out" id="studioScript">' + esc(script) + '</pre>' +
      '<details style="margin-top:8px"><summary class="muted" style="font-size:11.5px;cursor:pointer">프롬프트 미리보기</summary><pre class="script-out" id="studioPrompt" style="margin-top:6px;font-size:11px">' + esc(prompt) + '</pre></details>' +
      '</div></div>';
  }

  /* ---------- modal base ---------- */
  let lastFocus = null;
  let detailId = null;

  function openModal(html, size, label) {
    lastFocus = document.activeElement;
    const root = $('#modalRoot');
    root.innerHTML = '<div class="modal-backdrop" data-action="close-modal"></div>' +
      '<div class="modal ' + (size || '') + '" role="dialog" aria-modal="true" aria-label="' + esc(label || '창') + '">' + html + '</div>';
    root.hidden = false;
    document.body.style.overflow = 'hidden';
    const focusable = root.querySelector('button, input, select, textarea, [href]');
    if (focusable) setTimeout(() => focusable.focus(), 30);
  }

  function closeModal() {
    const root = $('#modalRoot');
    root.hidden = true;
    root.innerHTML = '';
    document.body.style.overflow = '';
    detailId = null;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  function modalHead(title, sub) {
    return '<div class="modal-head"><div><h2>' + esc(title) + '</h2>' + (sub ? '<p class="muted" style="font-size:11.5px;margin-top:2px">' + esc(sub) + '</p>' : '') + '</div>' +
      '<button class="modal-close" data-action="close-modal" aria-label="닫기">✕</button></div>';
  }

  /* ---------- detail ---------- */
  function openDetail(id) {
    const item = findItem(id);
    if (!item) return;
    detailId = id;
    const m = C.computeMetrics(item, state.now);
    const saved = state.board[item.id];
    const status = saved ? saved.status : null;
    const analysis = C.buildHookAnalysis(item);
    const script = C.buildScript(item, {});
    const prompt = C.buildPrompt(item, {});
    const tier = m.pending ? 'pending' : m.tier;

    const body = '<div class="modal-head"><div><h2>' + esc(item.creator) + '</h2>' +
      '<p class="muted" style="font-size:11.5px;margin-top:2px">' + esc(item.category + ' · ' + (C.PLATFORM_LABEL[item.platform] || item.platform) + ' · ' + item.country + ' · ' + C.relativeTime(item.postedAt, state.now)) + '</p></div>' +
      '<button class="modal-close" data-action="close-modal" aria-label="닫기">✕</button></div>' +
      '<div class="modal-body"><div class="detail-grid">' +
      '<div><div class="detail-cover">' + thumbHTML(item) +
      '<span class="badge platform" data-p="' + esc(item.platform) + '"><i class="pdot"></i>' + esc(C.PLATFORM_LABEL[item.platform] || item.platform) + '·' + esc(item.country) + '</span>' +
      '<span class="badge outlier tier-' + tier + '">' + esc(m.pending ? '미확인' : C.formatMultiple(m.viralMultiple)) + '</span>' +
      '<button type="button" class="play-btn" data-action="play-item" data-id="' + esc(item.id) + '" aria-label="미리보기 재생">' +
      '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg></button>' +
      '</div>' +
      '<div class="player-bar"><span>00:00</span><span class="bar"><i id="previewBar"></i></span><span>' + (item.durationSec || 25) + '초</span></div>' +
      '<div class="detail-actions">' +
      '<button class="btn ' + (saved ? 'is-on btn-ghost' : 'btn-primary') + ' btn-sm" data-action="toggle-save" data-id="' + esc(item.id) + '">' + icon('bookmark', 12) + (saved ? ' 보드에 있음' : ' 보드 저장') + '</button>' +
      '<button class="btn btn-ghost btn-sm" data-action="add-watch" data-handle="' + esc(item.creator) + '">추적</button>' +
      (item.url ? '<a class="btn btn-ghost btn-sm" href="' + esc(item.url) + '" target="_blank" rel="noopener noreferrer">원본 열기 ' + icon('external', 12) + '</a>' : '') +
      '</div>' +
      (item.url ? '' : '<p class="form-note" style="margin-top:8px">데모 카드에는 원본 링크가 없습니다. 실제 수집한 영상은 ‘원본 열기’로 연결됩니다.</p>') +
      '</div>' +

      '<div>' +
      '<h3 class="detail-title">' + esc(C.itemTitle(item)) + '</h3>' +
      '<div class="detail-meta"><span class="pill brand">' + esc(item.hookType) + ' 훅</span>' +
      '<span class="pill">' + esc(item.category) + '</span>' +
      '<span class="pill teal">' + esc(m.pending ? '지표 미확인' : C.formatVph(m.vph)) + '</span>' +
      (item.subscribers ? '<span class="pill">구독자 ' + esc(nf(item.subscribers)) + '</span>' : '') +
      '<span>★ ' + esc(item.creatorName || '') + '</span></div>' +

      '<div class="detail-stats">' +
      '<div class="dstat"><b>' + (m.pending ? '—' : nf(item.views)) + '</b><span>조회수</span></div>' +
      '<div class="dstat"><b>' + (m.pending ? '—' : nf(item.likes)) + '</b><span>좋아요</span></div>' +
      '<div class="dstat"><b>' + (m.pending ? '—' : nf(item.comments)) + '</b><span>댓글</span></div>' +
      '<div class="dstat"><b>' + (m.pending ? '—' : C.formatPercent(m.engagementRate)) + '</b><span>참여율</span></div>' +
      '</div>' +

      (m.pending ? pendingForm(item) : scoreBlock(item, m)) +

      '<div class="sec-title">첫 3초 훅 분해<span class="line"></span></div>' +
      '<p style="font-size:12.5px;line-height:1.6;color:var(--ink-2);margin-bottom:6px">“' + esc(analysis.hookText) + '”</p>' +
      '<p class="form-note">' + esc(analysis.lib.why) + '</p>' +
      '<div class="beats" style="margin-top:10px">' +
      analysis.beats.map((b) => '<div class="beat"><span class="br">' + esc(b.range) + '</span><span class="brole">' + esc(b.role) + '</span><span class="btext">' + esc(b.text) + '</span></div>').join('') +
      '</div>' +

      (item.product ? '<div class="sec-title">연결 상품<span class="line"></span></div><div class="product-strip"><span>🛍</span><span class="p-name">' + esc(item.product.name) + '</span><span class="p-price">' + C.formatCount(item.product.price) + '원</span></div>' : '') +

      '<div class="sec-title">바로 쓰는 대본 템플릿<span class="line"></span></div>' +
      '<pre class="script-out" style="max-height:200px">' + esc(script) + '</pre>' +
      '<div class="studio-actions">' +
      '<button class="btn btn-ghost btn-sm" data-action="copy-script" data-id="' + esc(item.id) + '">' + icon('copy', 12) + ' 대본 복사</button>' +
      '<button class="btn btn-ghost btn-sm" data-action="copy-prompt" data-id="' + esc(item.id) + '">' + icon('spark', 12) + ' 프롬프트 복사</button>' +
      '</div>' +

      (saved ? boardEditor(item, saved) : '') +
      '</div></div></div>';

    openModal(body, '', item.creator + ' 상세');

    // animate the preview bar
    const bar = $('#previewBar');
    if (bar) {
      bar.style.transition = 'width 6s linear';
      requestAnimationFrame(() => { bar.style.width = '92%'; });
    }
  }

  function scoreBlock(item, m) {
    return '<div class="sec-title">떡상 점수 ' + m.score + ' <span class="line"></span></div>' +
      '<div class="score-parts">' +
      '<span class="score-part">배수 <b>' + C.formatMultiple(m.viralMultiple) + '</b></span>' +
      '<span class="score-part">VPH <b>' + C.formatVph(m.vph) + '</b></span>' +
      '<span class="score-part">참여율 <b>' + C.formatPercent(m.engagementRate) + '</b></span>' +
      '<span class="score-part">경과 <b>' + C.relativeTime(item.postedAt, state.now) + '</b></span>' +
      '<span class="score-part">채널 기준 <b>' + nf(item.avgViews) + '</b></span>' +
      (item.baselineBasis ? '<span class="score-part">기준 방식 <b>' + esc(C.BASIS_LABEL[item.baselineBasis] || item.baselineBasis) + '</b></span>' : '') +
      '</div>' +
      '<div class="score-parts"><span class="score-part">배수 ' + m.parts.outlier + '/42</span>' +
      '<span class="score-part">속도 ' + m.parts.velocity + '/28</span>' +
      '<span class="score-part">반응 ' + m.parts.engagement + '/18</span>' +
      '<span class="score-part">신선도 ' + m.parts.freshness + '/12</span></div>';
  }

  function pendingForm(item) {
    return '<div class="sec-title">지표 입력<span class="line"></span></div>' +
      '<p class="form-note" style="margin-bottom:8px">링크만 넣은 카드는 조회수를 알 수 없습니다. 한 번만 채워두면 배수·VPH·점수가 계산됩니다.</p>' +
      '<form id="metricForm" data-id="' + esc(item.id) + '" class="form-row" style="flex-wrap:wrap;gap:6px">' +
      '<input class="input" name="views" placeholder="조회수" style="flex:1 1 100px" inputmode="numeric" />' +
      '<input class="input" name="likes" placeholder="좋아요" style="flex:1 1 90px" inputmode="numeric" />' +
      '<input class="input" name="comments" placeholder="댓글" style="flex:1 1 80px" inputmode="numeric" />' +
      '<input class="input" name="avgViews" placeholder="채널 평균 조회수" style="flex:1 1 130px" inputmode="numeric" />' +
      '<input class="input" name="hours" placeholder="경과 시간(기본 24h)" style="flex:1 1 120px" inputmode="numeric" />' +
      '<button class="btn btn-primary btn-sm" type="submit" style="flex:0 0 auto">계산</button>' +
      '</form>';
  }

  function boardEditor(item, entry) {
    return '<div class="sec-title">보드 메모<span class="line"></span></div>' +
      '<div class="form-row" style="align-items:center">' +
      '<select class="input" id="detailStatus" data-id="' + esc(item.id) + '" style="flex:0 0 150px">' +
      C.STATUSES.map((s) => '<option value="' + s.id + '"' + (s.id === entry.status ? ' selected' : '') + '>' + esc(s.label) + '</option>').join('') +
      '</select>' +
      '<input class="input" id="detailTags" data-id="' + esc(item.id) + '" placeholder="태그 (쉼표로 구분)" value="' + esc((entry.tags || []).join(', ')) + '" />' +
      '</div>' +
      '<textarea class="input" id="detailMemo" data-id="' + esc(item.id) + '" placeholder="각색 아이디어, 촬영 포인트, 담당자…">' + esc(entry.memo || '') + '</textarea>' +
      '<p class="form-note">입력하면 자동 저장됩니다. 보드에서 CSV/JSON으로 내보낼 수 있습니다.</p>';
  }

  /* ---------- settings ---------- */
  function openSettings() {
    const qty = state.quota && state.quota.date === C.quotaDateKey(state.now) ? state.quota : { search: 0, units: 0 };
    const pct = Math.min(100, Math.round((qty.search / C.QUOTA.searchPerDay) * 100));
    const body = modalHead('설정', 'API 키와 저장 데이터') + '<div class="modal-body">' +
      '<div class="sec-title" style="margin-top:0">YouTube Data API v3 (무료)<span class="line"></span></div>' +
      '<p class="form-note">키를 넣으면 실제 쇼츠를 검색해 채널 평균 대비 배수·VPH·점수를 실시간으로 계산합니다. 키는 <b>이 브라우저의 localStorage</b>에만 저장되고, 요청은 Google API로만 나갑니다.</p>' +
      '<label class="flabel" for="apiKeyInput">API 키</label>' +
      '<div class="form-row"><input class="input" id="apiKeyInput" type="password" placeholder="AIza…" value="' + esc(state.apiKey) + '" autocomplete="off" spellcheck="false" />' +
      '<button class="btn btn-primary" data-action="save-key" style="flex:0 0 auto">저장</button>' +
      (state.apiKey ? '<button class="btn btn-ghost" data-action="delete-key" style="flex:0 0 auto">삭제</button>' : '') +
      '</div>' +
      '<div class="kv"><span>오늘 검색 호출</span><b>' + qty.search + ' / ' + C.QUOTA.searchPerDay + '회</b></div>' +
      '<div class="meter"><i style="width:' + pct + '%"></i></div>' +
      '<p class="form-note" style="margin-bottom:12px">search.list는 2026년 6월부터 자체 할당량(기본 하루 100회)을 씁니다. 영상·채널 상세 조회는 1회당 1유닛(기본 1만 유닛)입니다. 할당량은 태평양시 자정에 초기화됩니다.</p>' +
      '<details><summary style="cursor:pointer;font-size:12px;font-weight:700;color:var(--ink-2)">키 발급 3분 가이드</summary><ol class="steps">' +
      '<li><a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noopener noreferrer">Google Cloud 콘솔</a>에서 프로젝트를 만듭니다.</li>' +
      '<li>API 라이브러리에서 <b>YouTube Data API v3</b>를 사용 설정합니다.</li>' +
      '<li>사용자 인증 정보 → 사용자 인증 정보 만들기 → <b>API 키</b>. 보안을 위해 ‘HTTP 리퍼러’ 제한에 이 앱 주소를 넣고 YouTube Data API만 허용하세요.</li>' +
      '</ol><p class="form-note">결제 수단 등록은 필요 없습니다. 무료 할당량 안에서 동작합니다.</p></details>' +

      '<div class="sec-title">이 브라우저에 저장된 것<span class="line"></span></div>' +
      '<div class="kv"><span>내가 추가한 영상</span><b>' + state.userItems.length + '건</b></div>' +
      '<div class="kv"><span>보드에 저장</span><b>' + Object.keys(state.board).length + '건</b></div>' +
      '<div class="kv"><span>추적 계정</span><b>' + state.watchlist.length + '개</b></div>' +
      '<div class="form-row" style="margin-top:12px">' +
      '<button class="btn btn-ghost" data-action="export-all-json">전체 백업(JSON)</button>' +
      '<button class="btn btn-ghost danger" data-action="reset-data">내 데이터 초기화</button>' +
      '</div>' +
      '<p class="form-note">초기화하면 추가한 영상·보드·추적 목록·API 키가 지워지고 데모 데이터만 남습니다. 서버에는 아무것도 저장되지 않습니다.</p>' +
      '</div>';
    openModal(body, 'small', '설정');
  }

  /* ---------- collect ---------- */
  function openCollect(mode) {
    const m = mode || 'link';
    const body = modalHead('숏폼 수집', '검색 · 링크 · CSV') + '<div class="modal-body">' +
      '<div class="seg" id="collectSeg">' +
      '<button data-mode="yt" class="' + (m === 'yt' ? 'is-on' : '') + '">YouTube 실시간</button>' +
      '<button data-mode="link" class="' + (m === 'link' ? 'is-on' : '') + '">링크 붙여넣기</button>' +
      '<button data-mode="csv" class="' + (m === 'csv' ? 'is-on' : '') + '">CSV</button>' +
      '</div><div id="collectPane" style="margin-top:14px">' + collectPane(m) + '</div></div>';
    openModal(body, 'medium', '숏폼 수집');
  }

  function collectPane(mode) {
    if (mode === 'yt') {
      if (!state.apiKey) {
        return '<p class="form-note">실시간 수집은 무료 YouTube API 키가 필요합니다. 키 없이도 링크·CSV로 카드를 만들 수 있습니다.</p>' +
          '<button class="btn btn-primary" data-action="open-settings" style="margin-top:10px">API 키 넣기</button>';
      }
      const qty = state.quota && state.quota.date === C.quotaDateKey(state.now) ? state.quota : { search: 0, units: 0 };
      return '<form id="ytForm">' +
        '<label class="flabel" for="ytQuery">키워드</label>' +
        '<input class="input" id="ytQuery" placeholder="예: 자취 요리, 다이어트, AI 툴" value="자취 요리" />' +
        '<div class="form-row" style="margin-top:10px">' +
        '<div><label class="flabel" for="ytRegion">국가</label><select class="input" id="ytRegion"><option value="KR">한국 (KR)</option><option value="GL">글로벌 (GL)</option></select></div>' +
        '<div><label class="flabel" for="ytPeriod">기간</label><select class="input" id="ytPeriod"><option value="1">24시간</option><option value="7" selected>7일</option><option value="30">30일</option></select></div>' +
        '<div><label class="flabel" for="ytMax">개수</label><select class="input" id="ytMax"><option value="10">10건</option><option value="25" selected>25건</option><option value="50">50건</option></select></div>' +
        '</div>' +
        '<p class="form-note">최신순·조회수순 쇼츠를 검색한 뒤, 채널 평균과 비교해 배수를 계산합니다. 호출은 검색 1회 + 상세 2회입니다. 오늘 검색 ' + qty.search + '/' + C.QUOTA.searchPerDay + '회 사용.</p>' +
        '<div id="ytError" class="form-note" style="color:#dc2626;margin-top:8px" role="alert"></div>' +
        '<div class="form-row" style="margin-top:12px"><button class="btn btn-primary" type="submit" style="flex:0 0 auto">실시간 수집</button>' +
        '<button class="btn btn-ghost" type="button" data-action="close-modal" style="flex:0 0 auto">닫기</button></div>' +
        '</form>';
    }
    if (mode === 'link') {
      return '<form id="linkForm">' +
        '<label class="flabel" for="linkInput">링크 (한 줄에 하나)</label>' +
        '<textarea class="input" id="linkInput" placeholder="https://www.youtube.com/shorts/…&#10;https://www.instagram.com/reel/…&#10;https://www.tiktok.com/@handle/video/…"></textarea>' +
        '<div class="form-row" style="margin-top:10px">' +
        '<input class="input" name="views" placeholder="조회수 (선택)" inputmode="numeric" />' +
        '<input class="input" name="likes" placeholder="좋아요 (선택)" inputmode="numeric" />' +
        '<input class="input" name="comments" placeholder="댓글 (선택)" inputmode="numeric" />' +
        '</div>' +
        '<div class="form-row">' +
        '<input class="input" name="avgViews" placeholder="채널 평균 조회수 (선택)" inputmode="numeric" />' +
        '<input class="input" name="hours" placeholder="게시 경과 시간 (선택)" inputmode="numeric" />' +
        '</div>' +
        '<p class="form-note">YouTube 링크 + API 키가 있으면 제목·조회수·채널 평균을 자동으로 가져옵니다. 인스타·틱톡은 공개 API가 없어 지표를 직접 넣거나 나중에 채웁니다.</p>' +
        '<div class="form-row" style="margin-top:12px"><button class="btn btn-primary" type="submit" style="flex:0 0 auto">카드로 추가</button></div>' +
        '</form>';
    }
    return '<form id="csvForm">' +
      '<label class="flabel" for="csvInput">CSV 붙여넣기</label>' +
      '<textarea class="input" id="csvInput" style="height:130px" placeholder="' + esc(C.SAMPLE_CSV) + '"></textarea>' +
      '<p class="form-note" style="margin-top:8px">헤더 예: <code>url, platform, creator, views, likes, comments, avg_views, hours_ago, category, caption, hashtags</code>. 한글 헤더(조회수·좋아요)도 인식합니다.</p>' +
      '<div class="form-row" style="margin-top:10px">' +
      '<button class="btn btn-primary" type="submit" style="flex:0 0 auto">가져오기</button>' +
      '<button class="btn btn-ghost" type="button" data-action="fill-sample-csv" style="flex:0 0 auto">예시 채우기</button>' +
      '<button class="btn btn-ghost" type="button" data-action="pick-csv-file" style="flex:0 0 auto">파일 선택</button>' +
      '<input type="file" id="csvFile" accept=".csv,text/csv" hidden />' +
      '</div></form>';
  }

  function switchCollect(mode) {
    const seg = $('#collectSeg');
    if (!seg) return;
    $$('button', seg).forEach((b) => b.classList.toggle('is-on', b.dataset.mode === mode));
    $('#collectPane').innerHTML = collectPane(mode);
  }

  /* ---------- memo modal / confirm ---------- */
  function openMemo(id) {
    const item = findItem(id);
    const entry = state.board[id];
    if (!item || !entry) return;
    const body = modalHead('메모 · 태그', C.itemTitle(item)) + '<div class="modal-body">' +
      '<label class="flabel" for="memoTags">태그 (쉼표로 구분)</label>' +
      '<input class="input" id="memoTags" value="' + esc((entry.tags || []).join(', ')) + '" placeholder="예: 훅강함, 3월 캠페인" />' +
      '<label class="flabel" for="memoText">메모</label>' +
      '<textarea class="input" id="memoText" placeholder="각색 방향, 촬영 장소, 담당자…">' + esc(entry.memo || '') + '</textarea>' +
      '<div class="form-row" style="margin-top:12px">' +
      '<button class="btn btn-primary" data-action="save-memo" data-id="' + esc(id) + '" style="flex:0 0 auto">저장</button>' +
      '<button class="btn btn-ghost" data-action="close-modal" style="flex:0 0 auto">취소</button>' +
      '</div></div>';
    openModal(body, 'small', '메모');
  }

  function openConfirm(title, message, action, payload) {
    const body = modalHead(title, '') + '<div class="modal-body"><p style="font-size:13px;color:var(--ink-2);line-height:1.6">' + esc(message) + '</p>' +
      '<div class="form-row" style="margin-top:16px">' +
      '<button class="btn btn-primary" data-action="' + action + '" ' + (payload ? 'data-id="' + esc(payload) + '"' : '') + '>확인</button>' +
      '<button class="btn btn-ghost" data-action="close-modal">취소</button></div></div>';
    openModal(body, 'small', title);
  }

  /* ---------- board actions ---------- */
  function toggleSave(id, silent) {
    const item = findItem(id);
    if (!item) return false;
    if (state.board[id]) {
      delete state.board[id];
      persistBoard();
      if (!silent) toast('보드에서 뺐습니다.');
      refreshAfterBoard(id);
      return false;
    }
    state.board[id] = { status: 'saved', memo: '', tags: [], addedAt: new Date().toISOString() };
    persistBoard();
    if (!silent) toast('팀 보드에 저장했습니다.');
    refreshAfterBoard(id);
    return true;
  }

  function refreshAfterBoard(changedId) {
    renderGrid();
    renderBoard();
    updateTabBadge();
    renderSummary();
    if (!$('#modalRoot').hidden) {
      if (detailId && detailId === changedId) openDetail(changedId);
    }
  }

  /* ---------- YouTube API ---------- */
  const API = 'https://www.googleapis.com/youtube/v3/';

  function apiMessage(status, message) {
    if (status === 400) return 'API 키가 올바르지 않거나 요청이 거부되었습니다 (400). 키를 다시 확인해 주세요.';
    if (status === 403) return '할당량 초과 또는 API 미사용 설정입니다 (403). 오늘 검색 100회를 다 썼거나 YouTube Data API v3가 꺼져 있습니다.';
    if (status === 404) return '요청한 영상을 찾을 수 없습니다 (404).';
    if (status === 429) return '요청이 너무 많습니다 (429). 잠시 후 다시 시도해 주세요.';
    return 'YouTube API 오류 (' + status + ')' + (message ? ': ' + message : '');
  }

  async function apiGet(path, params) {
    const url = API + path + '?' + new URLSearchParams(params).toString();
    let res;
    try {
      res = await fetch(url, { method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer' });
    } catch (e) {
      throw new Error('네트워크 오류 — 오프라인이거나 googleapis.com 요청이 차단되었습니다.');
    }
    if (!res.ok) {
      let msg = '';
      try { const j = await res.json(); msg = (j.error && j.error.message) || ''; } catch (e) {}
      const err = new Error(apiMessage(res.status, msg));
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  function bumpQuota(search, units) {
    state.quota = C.bumpQuota(state.quota, Date.now(), search, units);
    store.set(KEY.quota, state.quota);
  }

  function guessHook(title) {
    const t = String(title || '');
    if (/\bvs\b|VS|비교/i.test(t)) return '비교';
    if (/[0-9]/.test(t)) return '충격숫자';
    if (/\?|까\?|나요|을까/.test(t)) return '질문형';
    return '반전';
  }

  function creatorHandle(ch) {
    const custom = ch && ch.snippet && ch.snippet.customUrl;
    if (custom && custom[0] === '@') return custom.toLowerCase();
    const title = (ch && ch.snippet && ch.snippet.title) || 'youtube';
    return '@' + title.replace(/\s+/g, '').toLowerCase().slice(0, 24);
  }

  function ytItemFromVideo(video, channels, channelViews, region) {
    const sn = video.snippet || {};
    const st = video.statistics || {};
    const ch = channels[sn.channelId] || null;
    const base = C.channelBaseline(channelViews[sn.channelId] || [], ch ? {
      viewCount: Number(ch.statistics && ch.statistics.viewCount || 0),
      videoCount: Number(ch.statistics && ch.statistics.videoCount || 0),
      subscriberCount: Number(ch.statistics && ch.statistics.subscriberCount || 0),
    } : null);
    const views = Number(st.viewCount || 0);
    const title = sn.title || '(제목 없음)';
    const cat = C.guessCategory(title + ' ' + (sn.description || ''));
    const published = sn.publishedAt || new Date().toISOString();
    return {
      id: 'yt-' + video.id,
      source: 'youtube-api',
      platform: 'youtube',
      country: region,
      creator: creatorHandle(ch),
      creatorName: (ch && ch.snippet && ch.snippet.title) || sn.channelTitle || 'YouTube',
      channelTitle: sn.channelTitle || '',
      category: cat,
      caption: title,
      hashtags: (title.match(/#[^\s#]+/g) || []).slice(0, 4),
      views,
      likes: Number(st.likeCount || 0),
      comments: Number(st.commentCount || 0),
      shares: 0,
      saves: 0,
      avgViews: base.avgViews,
      baselineBasis: base.basis,
      subscribers: Number((ch && ch.statistics && ch.statistics.subscriberCount) || 0),
      postedAt: published,
      durationSec: C.parseISODuration(video.contentDetails && video.contentDetails.duration),
      hookType: guessHook(title),
      hookText: title,
      cta: '',
      url: 'https://www.youtube.com/shorts/' + video.id,
      videoId: video.id,
      thumbnail: 'https://i.ytimg.com/vi/' + video.id + '/hqdefault.jpg',
      cover: {
        text: C.coverLines(title),
        palette: ['sunset', 'cherry', 'violet', 'ocean', 'mint', 'lemon', 'ice', 'gold'][Math.abs(hashCode(video.id)) % 8],
        motif: MOTIF_BY_CATEGORY[cat] || 'default',
        tag: 'YOUTUBE',
      },
    };
  }

  function hashCode(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return h;
  }

  async function runYouTubeSearch(opts) {
    const key = state.apiKey;
    if (!key) throw new Error('API 키가 없습니다.');
    const period = Number(opts.period || 7);
    const max = Math.min(50, Number(opts.max || 25));
    const region = opts.region === 'GL' ? 'GL' : 'KR';

    const search = await apiGet('search', {
      part: 'snippet',
      type: 'video',
      videoDuration: 'short',
      order: 'viewCount',
      maxResults: String(max),
      regionCode: region === 'KR' ? 'KR' : 'US',
      q: opts.query || '',
      publishedAfter: new Date(Date.now() - period * 86400000).toISOString(),
      key,
    });
    bumpQuota(1, 0);

    const raw = (search.items || []).map((i) => i.id && i.id.videoId).filter(Boolean);
    const ids = [];
    raw.forEach((id) => { if (ids.indexOf(id) === -1) ids.push(id); });
    if (!ids.length) return { added: 0, items: [] };

    const vids = await apiGet('videos', {
      part: 'snippet,statistics,contentDetails',
      id: ids.slice(0, 50).join(','),
      key,
    });
    bumpQuota(0, 1);

    const chIds = [];
    (vids.items || []).forEach((v) => {
      const cid = v.snippet && v.snippet.channelId;
      if (cid && chIds.indexOf(cid) === -1) chIds.push(cid);
    });

    let channels = {};
    if (chIds.length) {
      const chRes = await apiGet('channels', { part: 'snippet,statistics', id: chIds.slice(0, 50).join(','), key });
      bumpQuota(0, 1);
      (chRes.items || []).forEach((c) => { channels[c.id] = c; });
    }

    const channelViews = {};
    (vids.items || []).forEach((v) => {
      const cid = v.snippet && v.snippet.channelId;
      if (!cid) return;
      channelViews[cid] = channelViews[cid] || [];
      channelViews[cid].push(Number(v.statistics && v.statistics.viewCount || 0));
    });

    const items = (vids.items || []).map((v) => ytItemFromVideo(v, channels, channelViews, region));
    return { added: mergeItems(items), items };
  }

  function mergeItems(newItems) {
    let added = 0;
    newItems.forEach((item) => {
      const i = state.userItems.findIndex((x) => x.id === item.id);
      if (i === -1) { state.userItems.unshift(item); added++; }
      else state.userItems[i] = Object.assign({}, state.userItems[i], item);
    });
    persistItems();
    return added;
  }

  /* 새로 수집하면 데모를 걷어내고 '실시간 수집만' 보기로 넘어간다.
     토글이 이미 켰거나 추가된 게 없으면 그대로 두고, 전환했을 때만 안내 문구를 돌려준다. */
  function focusCollected(added) {
    if (!added || state.filters.collectedOnly) return '';
    state.filters.collectedOnly = true;
    return ' · 실시간 수집만 보기로 전환(데모 숨김)';
  }

  async function fetchYoutubeById(videoId) {
    const key = state.apiKey;
    if (!key) return null;
    const vids = await apiGet('videos', { part: 'snippet,statistics,contentDetails', id: videoId, key });
    bumpQuota(0, 1);
    if (!vids.items || !vids.items.length) return null;
    const chId = vids.items[0].snippet.channelId;
    let channels = {};
    if (chId) {
      const chRes = await apiGet('channels', { part: 'snippet,statistics', id: chId, key });
      bumpQuota(0, 1);
      (chRes.items || []).forEach((c) => { channels[c.id] = c; });
    }
    const viewsMap = {};
    viewsMap[chId] = [Number(vids.items[0].statistics.viewCount || 0)];
    return ytItemFromVideo(vids.items[0], channels, viewsMap, 'KR');
  }

  async function addLinks(text, metrics) {
    const urls = String(text || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
    if (!urls.length) { toast('링크를 넣어주세요.', 'warn'); return; }
    let added = 0, pendingCount = 0, failed = 0;
    for (const raw of urls) {
      const parsed = C.parseVideoUrl(raw);
      if (!parsed) { failed++; continue; }
      try {
        if (parsed.platform === 'youtube' && state.apiKey) {
          const item = await fetchYoutubeById(parsed.id);
          if (item) {
            item.source = 'url';
            if (metrics && metrics.views) applyMetrics(item, metrics);
            added += mergeItems([item]) ? 1 : 0;
            continue;
          }
        }
        let title = '', author = '';
        if (parsed.platform === 'youtube') {
          try {
            const o = await fetch('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(parsed.url), { credentials: 'omit' });
            if (o.ok) { const j = await o.json(); title = j.title || ''; author = j.author_name || ''; }
          } catch (e) { /* offline / blocked */ }
        } else if (parsed.platform === 'tiktok') {
          try {
            const o = await fetch('https://www.tiktok.com/oembed?url=' + encodeURIComponent(parsed.url), { credentials: 'omit' });
            if (o.ok) { const j = await o.json(); title = j.title || ''; author = j.author_name || ''; }
          } catch (e) { /* CORS/blocked → manual metrics */ }
        }
        const label = C.PLATFORM_LABEL[parsed.platform] || parsed.platform;
        const item = {
          id: 'url-' + parsed.platform + '-' + parsed.id,
          source: 'url',
          platform: parsed.platform,
          country: 'KR',
          creator: parsed.handle || (author ? '@' + author.replace(/\s+/g, '').toLowerCase() : '@' + parsed.platform + '.creator'),
          creatorName: author || '직접 수집',
          category: C.guessCategory(title),
          caption: title || label + ' 링크로 추가한 레퍼런스 — 지표를 입력하세요',
          hashtags: [],
          views: null, likes: 0, comments: 0, avgViews: 0, subscribers: 0,
          postedAt: new Date().toISOString(),
          durationSec: 0,
          hookType: guessHook(title),
          hookText: title,
          cta: '',
          url: parsed.url,
          videoId: parsed.platform === 'youtube' ? parsed.id : null,
          thumbnail: parsed.platform === 'youtube' ? 'https://i.ytimg.com/vi/' + parsed.id + '/hqdefault.jpg' : '',
          cover: { text: title ? C.coverLines(title) : [label + ' 레퍼런스'], palette: 'slate', motif: 'default', tag: label.toUpperCase() },
        };
        if (metrics && metrics.views) applyMetrics(item, metrics);
        added += mergeItems([item]) ? 1 : 0;
        if (!item.views) pendingCount++;
      } catch (e) {
        failed++;
      }
    }
    const switched = focusCollected(added);
    renderAll();
    setTab('radar');
    if (added) toast('카드 ' + added + '건 추가' + (pendingCount ? ' · 지표 미입력 ' + pendingCount + '건' : '') + (failed ? ' · 실패 ' + failed : '') + switched);
    else toast(failed ? '추가하지 못했습니다 (' + failed + '건).' : '이미 있는 영상입니다.', 'warn');
  }

  function applyMetrics(item, metrics) {
    const num = C.normalizeNumber;
    const views = num(metrics.views);
    if (views === null) return;
    const wasPending = C.isPending(item);
    item.views = views;
    item.likes = num(metrics.likes) || 0;
    item.comments = num(metrics.comments) || 0;
    item.avgViews = num(metrics.avgViews) || item.avgViews || 0;
    const hours = num(metrics.hours);
    if (hours && hours > 0) item.postedAt = new Date(Date.now() - hours * 3600000).toISOString();
    else if (wasPending) item.postedAt = new Date(Date.now() - 24 * 3600000).toISOString();
  }

  /* ---------- actions ---------- */
  function handleAction(action, el, e) {
    const id = el.dataset.id;
    switch (action) {
      case 'open-detail': openDetail(id); break;
      case 'play-item': {
        const it = findItem(id);
        if (it && it.url) {
          window.open(it.url, '_blank', 'noopener');
        } else {
          toast('데모 카드에는 원본 영상이 없습니다. 실제 수집한 영상은 원본 링크로 열립니다.');
        }
        break;
      }
      case 'open-hook': openDetail(id); break;
      case 'toggle-save': {
        e.stopPropagation();
        toggleSave(id);
        break;
      }
      case 'clear-search': {
        state.query = '';
        $('#searchInput').value = '';
        $('#searchInput').dispatchEvent(new Event('input', { bubbles: true }));
        break;
      }
      case 'toggle-theme': {
        state.theme = state.theme === 'dark' ? 'light' : 'dark';
        applyTheme();
        break;
      }
      case 'open-settings': openSettings(); break;
      case 'open-collect': openCollect('link'); break;
      case 'close-modal': closeModal(); break;
      case 'toggle-collected-only': {
        state.filters.collectedOnly = !state.filters.collectedOnly;
        renderChips();
        renderGrid();
        renderSummary();
        renderSourceNote();
        break;
      }
      case 'reset-filters': {
        state.filters = { platform: 'all', country: 'all', minMultiple: 0, period: 0, category: 'all', collectedOnly: false };
        state.query = '';
        $('#searchInput').value = '';
        renderChips();
        renderAll();
        break;
      }
      case 'go-radar': setTab('radar'); break;
      case 'add-watch': {
        if (e) e.stopPropagation();
        addWatch(el.dataset.handle);
        break;
      }
      case 'remove-watch': removeWatch(el.dataset.handle); break;
      case 'save-key': {
        const key = $('#apiKeyInput').value.trim();
        if (!key) { toast('키를 입력해 주세요.', 'warn'); break; }
        state.apiKey = key;
        store.set(KEY.apiKey, key);
        renderAll();
        toast('API 키를 이 브라우저에만 저장했습니다.');
        openSettings();
        break;
      }
      case 'delete-key': {
        state.apiKey = '';
        store.del(KEY.apiKey);
        renderAll();
        toast('API 키를 삭제했습니다.');
        openSettings();
        break;
      }
      case 'reset-data': openConfirm('내 데이터 초기화', '추가한 영상, 보드, 추적 목록, API 키가 이 브라우저에서 지워집니다. 되돌릴 수 없습니다.', 'do-reset'); break;
      case 'do-reset': {
        state.userItems = []; state.board = {}; state.watchlist = []; state.apiKey = ''; state.quota = null;
        [KEY.items, KEY.board, KEY.watch, KEY.apiKey, KEY.quota].forEach(store.del);
        closeModal(); renderAll(); toast('초기화했습니다.');
        break;
      }
      case 'export-all-json': {
        const payload = { exportedAt: new Date().toISOString(), items: state.userItems, board: state.board, watchlist: state.watchlist };
        download('radar-backup-' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify(payload, null, 2), 'application/json');
        toast('백업 파일을 만들었습니다.');
        break;
      }
      case 'export-board-csv': {
        if (!Object.keys(state.board).length) { toast('보드가 비어 있습니다.', 'warn'); break; }
        const items = allItems().filter((i) => state.board[i.id]);
        download('radar-board-' + new Date().toISOString().slice(0, 10) + '.csv', '\uFEFF' + C.toBoardCsv(items, state.board, state.now), 'text/csv;charset=utf-8');
        toast('CSV를 내려받았습니다 (' + items.length + '건).');
        break;
      }
      case 'export-board-json': {
        if (!Object.keys(state.board).length) { toast('보드가 비어 있습니다.', 'warn'); break; }
        const items = allItems().filter((i) => state.board[i.id]).map((i) => ({
          ...i, metrics: C.computeMetrics(i, state.now), board: state.board[i.id],
        }));
        download('radar-board-' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify({ exportedAt: new Date().toISOString(), count: items.length, items }, null, 2), 'application/json');
        toast('JSON을 내려받았습니다.');
        break;
      }
      case 'clear-board': openConfirm('보드 비우기', '보드에서 카드 ' + Object.keys(state.board).length + '개를 모두 뺍니다. 영상 데이터는 레이더에 그대로 남습니다.', 'do-clear-board'); break;
      case 'do-clear-board': {
        state.board = {};
        persistBoard();
        closeModal();
        refreshAfterBoard();
        renderGrid();
        toast('보드를 비웠습니다.');
        break;
      }
      case 'kcard-next': moveStatus(id, C.nextStatus(state.board[id].status)); break;
      case 'kcard-prev': moveStatus(id, C.prevStatus(state.board[id].status)); break;
      case 'kcard-memo': openMemo(id); break;
      case 'kcard-remove': toggleSave(id); break;
      case 'save-memo': {
        const entry = state.board[id];
        if (entry) {
          entry.memo = $('#memoText').value.trim();
          entry.tags = $('#memoTags').value.split(',').map((s) => s.trim().replace(/^#/, '')).filter(Boolean).slice(0, 6);
          persistBoard();
          closeModal();
          renderBoard();
          toast('메모를 저장했습니다.');
        }
        break;
      }
      case 'copy-template': {
        const h = C.hookLibrary(el.dataset.type);
        copyText(h.template).then((ok) => toast(ok ? '훅 템플릿을 복사했습니다.' : '복사에 실패했습니다.'));
        break;
      }
      case 'copy-script': {
        const item = id ? findItem(id) : null;
        const text = item ? C.buildScript(item, { product: $('#studioProduct') ? $('#studioProduct').value : undefined })
          : $('#studioScript').textContent;
        copyText(text).then((ok) => toast(ok ? '대본을 복사했습니다.' : '복사에 실패했습니다.'));
        break;
      }
      case 'copy-prompt': {
        const item = id ? findItem(id) : null;
        const text = item ? C.buildPrompt(item, { product: $('#studioProduct') ? $('#studioProduct').value : undefined })
          : ($('#studioPrompt') ? $('#studioPrompt').textContent : '');
        copyText(text).then((ok) => toast(ok ? '프롬프트를 복사했습니다.' : '복사에 실패했습니다.'));
        break;
      }
      case 'fill-sample-csv': {
        $('#csvInput').value = C.SAMPLE_CSV;
        break;
      }
      case 'pick-csv-file': { $('#csvFile').click(); break; }
      default: break;
    }
  }

  /* ---------- watchlist ---------- */
  function addWatch(handle) {
    const h = normHandle(handle);
    if (!h) { toast('핸들을 입력해 주세요.', 'warn'); return; }
    if (state.watchlist.indexOf(h) === -1) {
      state.watchlist.push(h);
      store.set(KEY.watch, state.watchlist);
      toast(h + ' 추적을 시작합니다.');
    } else {
      toast('이미 추적 중인 계정입니다.');
    }
    renderAccounts();
    if (!$('#modalRoot').hidden && $('#detailStatus')) {
      /* keep detail modal open */
    }
  }

  function removeWatch(handle) {
    state.watchlist = state.watchlist.filter((h) => h !== handle);
    store.set(KEY.watch, state.watchlist);
    renderAccounts();
    toast('추적을 해제했습니다.');
  }

  /* ---------- theme / tabs ---------- */
  function applyTheme() {
    document.documentElement.setAttribute('data-theme', state.theme);
    store.set(KEY.theme, state.theme);
    const btn = $('[data-action="toggle-theme"]');
    if (btn) btn.setAttribute('aria-label', state.theme === 'dark' ? '라이트 모드로 전환' : '다크 모드로 전환');
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', state.theme === 'dark' ? '#080a0f' : '#ffffff');
  }

  function setTab(tab) {
    const views = { radar: '#view-radar', commerce: '#view-commerce', accounts: '#view-accounts', board: '#view-board', ai: '#view-ai' };
    if (!views[tab]) tab = 'radar';
    state.tab = tab;
    Object.keys(views).forEach((k) => {
      const el = $(views[k]);
      if (el) el.hidden = k !== tab;
    });
    $$('.tab').forEach((b) => {
      const on = b.dataset.tab === tab;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', String(on));
    });
    if (tab === 'board') renderBoard();
    if (tab === 'accounts') renderAccounts();
    if (tab === 'ai') renderAI();
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  /* ---------- render all ---------- */
  function renderAll() {
    state.now = Date.now();
    renderChips();
    renderSummary();
    renderSourceNote();
    renderGrid();
    renderCommerce();
    renderAccounts();
    renderBoard();
    renderAI();
    updateTabBadge();
    const dot = $('#apiDot');
    if (dot) dot.classList.toggle('on', !!state.apiKey);
    const lbl = $('#apiButtonLabel');
    if (lbl) lbl.textContent = state.apiKey ? 'API 연결됨' : 'YouTube API';
    $('#sortSelect').value = state.sort;
  }

  /* ---------- events ---------- */
  document.addEventListener('click', (e) => {
    const tabBtn = e.target.closest('.tab');
    if (tabBtn) { setTab(tabBtn.dataset.tab); return; }

    const filterBtn = e.target.closest('[data-filter]');
    if (filterBtn) {
      const key = filterBtn.dataset.filter;
      const val = filterBtn.dataset.value;
      state.filters[key] = key === 'minMultiple' || key === 'period' ? Number(val) : val;
      renderChips();
      renderGrid();
      renderSummary();
      return;
    }

    const modeBtn = e.target.closest('#collectSeg button');
    if (modeBtn) { switchCollect(modeBtn.dataset.mode); return; }

    const actionEl = e.target.closest('[data-action]');
    if (actionEl) {
      handleAction(actionEl.dataset.action, actionEl, e);
      return;
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#modalRoot').hidden) { closeModal(); return; }
    if ((e.key === 'Enter' || e.key === ' ') && document.activeElement && document.activeElement.dataset.action === 'open-detail') {
      e.preventDefault();
      openDetail(document.activeElement.dataset.id);
    }
  });

  // detail modal: board edits
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'detailStatus') {
      moveStatus(t.dataset.id, t.value);
      toast('상태를 변경했습니다.');
    }
    if (t.id === 'detailTags' || t.id === 'detailMemo') {
      const entry = state.board[t.dataset.id];
      if (!entry) return;
      if (t.id === 'detailTags') entry.tags = t.value.split(',').map((s) => s.trim().replace(/^#/, '')).filter(Boolean).slice(0, 6);
      else entry.memo = t.value.trim();
      persistBoard();
      renderBoard();
    }
    if (t.id === 'watchOnlyOutliers') {
      state.watchOnlyOutliers = t.checked;
      renderAccounts();
    }
  });

  document.addEventListener('input', debounce((e) => {
    const t = e.target;
    if (t.id === 'searchInput') {
      state.query = t.value;
      $('.search-clear').hidden = !t.value;
      renderGrid();
      renderSummary();
    }
  }, 120));

  document.addEventListener('input', (e) => {
    if (e.target.id === 'searchInput') {
      $('.search-clear').hidden = !e.target.value;
    }
    if (e.target.id === 'studioProduct') updateStudioScript();
  });

  function updateStudioScript() {
    const sel = $('#studioSelect');
    const out = $('#studioScript');
    const promptOut = $('#studioPrompt');
    if (!sel || !out) return;
    const item = findItem(sel.value);
    if (!item) return;
    const product = $('#studioProduct') ? $('#studioProduct').value.trim() : '';
    out.textContent = C.buildScript(item, { product: product || undefined });
    if (promptOut) promptOut.textContent = C.buildPrompt(item, { product: product || undefined });
  }

  document.addEventListener('submit', async (e) => {
    const f = e.target;
    if (f.id === 'ytForm') {
      e.preventDefault();
      const btn = f.querySelector('button[type="submit"]');
      const err = $('#ytError');
      err.textContent = '';
      btn.disabled = true;
      const old = btn.textContent;
      btn.textContent = '수집 중…';
      try {
        const res = await runYouTubeSearch({
          query: $('#ytQuery').value.trim() || '쇼츠',
          region: $('#ytRegion').value,
          period: $('#ytPeriod').value,
          max: $('#ytMax').value,
        });
        closeModal();
        setTab('radar');
        const switched = focusCollected(res.added);
        renderAll();
        toast(res.added ? '실시간 영상 ' + res.added + '건을 추가했습니다.' + switched : '새 영상이 없습니다 (이미 수집됨).');
      } catch (ex) {
        err.textContent = ex.message || '수집에 실패했습니다.';
        toast('수집 실패', 'warn');
      } finally {
        if (document.body.contains(btn)) { btn.disabled = false; btn.textContent = old; }
      }
      return;
    }
    if (f.id === 'linkForm') {
      e.preventDefault();
      const text = $('#linkInput').value;
      const metrics = {
        views: f.views.value, likes: f.likes.value, comments: f.comments.value,
        avgViews: f.avgViews.value, hours: f.hours.value,
      };
      closeModal();
      await addLinks(text, metrics);
      return;
    }
    if (f.id === 'csvForm') {
      e.preventDefault();
      const text = $('#csvInput').value;
      const res = C.csvToItems(text, { nowMs: Date.now() });
      if (!res.items.length) {
        toast(res.errors.length ? res.errors[0].message : '가져올 행이 없습니다.', 'warn');
        return;
      }
      const added = mergeItems(res.items);
      const switched = focusCollected(added);
      closeModal();
      renderAll();
      setTab('radar');
      toast('CSV에서 ' + added + '건을 추가했습니다' + (res.errors.length ? ' (건너뜀 ' + res.errors.length + '행)' : '') + switched);
      return;
    }
    if (f.id === 'metricForm') {
      e.preventDefault();
      const item = findItem(f.dataset.id);
      if (!item) return;
      applyMetrics(item, {
        views: f.views.value, likes: f.likes.value, comments: f.comments.value,
        avgViews: f.avgViews.value, hours: f.hours ? f.hours.value : '',
      });
      const idx = state.userItems.findIndex((x) => x.id === item.id);
      if (idx !== -1) { state.userItems[idx] = item; persistItems(); }
      closeModal();
      renderAll();
      toast('지표를 계산했습니다.');
      return;
    }
    if (f.id === 'trackForm') {
      e.preventDefault();
      const v = $('#trackInput').value;
      addWatch(v);
      $('#trackInput').value = '';
      return;
    }
  });

  document.addEventListener('change', async (e) => {
    if (e.target.id === 'csvFile') {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const text = await file.text();
      $('#csvInput').value = text;
      toast('파일을 불러왔습니다. 가져오기를 누르세요.');
    }
    if (e.target.id === 'sortSelect') {
      state.sort = e.target.value;
      renderGrid();
      renderSummary();
    }
    if (e.target.id === 'studioSelect') {
      renderAI();
    }
  });

  // kanban drag & drop
  document.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.kcard');
    if (!card) return;
    card.classList.add('dragging');
    try { e.dataTransfer.setData('text/plain', card.dataset.id); } catch (err) {}
    e.dataTransfer.effectAllowed = 'move';
  });
  document.addEventListener('dragend', (e) => {
    const card = e.target.closest('.kcard');
    if (card) card.classList.remove('dragging');
    $$('.col.is-over').forEach((c) => c.classList.remove('is-over'));
  });
  document.addEventListener('dragover', (e) => {
    const col = e.target.closest('.col');
    if (!col) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    $$('.col').forEach((c) => c.classList.toggle('is-over', c === col));
  });
  document.addEventListener('drop', (e) => {
    const col = e.target.closest('.col');
    if (!col) return;
    e.preventDefault();
    const id = e.dataTransfer.getData('text/plain');
    if (id) moveStatus(id, col.dataset.status);
    $$('.col.is-over').forEach((c) => c.classList.remove('is-over'));
  });

  /* ---------- boot ---------- */
  function boot() {
    applyTheme();
    // prune board entries whose item disappeared
    const ids = allItems().map((i) => i.id);
    let changed = false;
    Object.keys(state.board).forEach((id) => { if (ids.indexOf(id) === -1) { delete state.board[id]; changed = true; } });
    if (changed) persistBoard();
    renderAll();
    setTab('radar');
  }

  boot();
})();
