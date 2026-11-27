/* ============================================================
   떡상 레이더 · core.js
   Pure, DOM-free logic: scoring, filtering, sorting, parsing, export.
   Shared by the browser app (window.RadarCore) and node test.js.
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RadarCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- constants ---------- */
  const PLATFORMS = [
    { id: 'all', label: '전체' },
    { id: 'instagram', label: '인스타 릴스', short: '인스타', memo: 'IG' },
    { id: 'youtube', label: '유튜브 쇼츠', short: '유튜브', memo: 'YT' },
    { id: 'tiktok', label: '틱톡', short: '틱톡', memo: 'TT' },
  ];

  const COUNTRIES = [
    { id: 'all', label: '전체' },
    { id: 'KR', label: 'KR' },
    { id: 'GL', label: 'GL' },
  ];

  const MULTIPLIERS = [
    { id: 0, label: '전체' },
    { id: 2, label: '2x+' },
    { id: 5, label: '5x+' },
    { id: 10, label: '10x+' },
  ];

  const PERIODS = [
    { id: 0, label: '전체' },
    { id: 24, label: '24h' },
    { id: 168, label: '7d' },
    { id: 720, label: '30d' },
  ];

  const CATEGORIES = ['뷰티·패션', '푸드·맛집', '리빙·꿀템', '테크·AI', '재테크·썰', '운동·헬스', '여행·일상', '기타'];

  const HOOK_TYPES = ['질문형', '충격숫자', '반전', '비교'];

  const SORTS = [
    { id: 'score', label: '떡상 점수순' },
    { id: 'multiple', label: '바이럴 배수순' },
    { id: 'vph', label: '시간당 조회(VPH)순' },
    { id: 'newest', label: '최신순' },
  ];

  const STATUSES = [
    { id: 'saved', label: '레퍼런스 저장' },
    { id: 'scripting', label: '대본 각색 중' },
    { id: 'shooting', label: '촬영/편집' },
    { id: 'done', label: '업로드 완료' },
  ];

  const PLATFORM_LABEL = { instagram: '인스타', youtube: '유튜브', tiktok: '틱톡' };

  /* ---------- small helpers ---------- */
  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

  function countChars(text) {
    const s = String(text === null || text === undefined ? '' : text);
    return Array.from ? Array.from(s).length : s.length;
  }

  function group3(n) {
    const s = String(Math.round(Math.abs(n)));
    const neg = n < 0 ? '-' : '';
    return neg + s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function trimNum(v, digits) {
    const p = Math.pow(10, digits);
    const r = Math.round(v * p) / p;
    return String(r);
  }

  /** 540000 -> '54만', 25000 -> '2.5만', 12000000 -> '1,200만', 120000000 -> '1.2억' */
  function formatCount(n) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    const abs = Math.abs(n);
    if (abs >= 1e8) {
      const v = n / 1e8;
      return trimNum(v, v < 10 ? 1 : 0).replace(/\.0$/, '') + '억';
    }
    if (abs >= 1e4) {
      const v = n / 1e4;
      if (v < 10) return trimNum(v, 1).replace(/\.0$/, '') + '만';
      if (v < 100) return String(Math.round(v)) + '만';
      return group3(v) + '만';
    }
    if (abs >= 1e3) return group3(n);
    return String(Math.round(n));
  }

  function formatVph(v) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    return formatCount(v) + '/h';
  }

  function formatMultiple(m) {
    if (m === null || m === undefined || !isFinite(m) || m <= 0) return '—';
    if (m >= 100) return String(Math.round(m)) + 'x';
    if (m >= 10) return trimNum(m, 1).replace(/\.0$/, '') + 'x';
    return trimNum(m, 1) + 'x';
  }

  function formatPercent(v, digits) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    return trimNum(v, digits === undefined ? 1 : digits) + '%';
  }

  function relativeTime(iso, nowMs) {
    const t = Date.parse(iso);
    if (!isFinite(t)) return '—';
    const diff = Math.max(0, nowMs - t);
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return '방금';
    if (mins < 60) return mins + '분 전';
    const hours = Math.floor(mins / 60);
    if (hours < 24) return hours + '시간 전';
    const days = Math.floor(hours / 24);
    if (days < 7) return days + '일 전';
    const weeks = Math.floor(days / 7);
    if (weeks < 5) return weeks + '주 전';
    const months = Math.floor(days / 30);
    if (months < 12) return months + '개월 전';
    return Math.floor(days / 365) + '년 전';
  }

  function hoursSince(iso, nowMs) {
    const t = Date.parse(iso);
    if (!isFinite(t)) return 0;
    return Math.max(0, (nowMs - t) / 3600000);
  }

  function isPending(item) {
    return item == null || item.views === null || item.views === undefined;
  }

  /* ---------- scoring ---------- */
  /**
   * 떡상 점수 0~100
   *  42점 배수(채널 평균 대비, log scale · 20x에서 만점)
   *  28점 속도(시간당 조회, log scale · 100만/h에서 만점)
   *  18점 반응(참여율 (좋아요+댓글)/조회, 12%에서 만점)
   *  12점 신선도(6시간 이내 만점 · 30일에서 0점)
   */
  function computeScore(input) {
    const multiple = Math.max(0, input.viralMultiple || 0);
    const vph = Math.max(0, input.vph || 0);
    const er = Math.max(0, input.engagementRate || 0);
    const hours = Math.max(0, input.hours || 0);

    const outlier = 42 * clamp(Math.log10(Math.max(1, multiple)) / Math.log10(20), 0, 1);
    const velocity = 28 * clamp(Math.log10(1 + vph) / Math.log10(1 + 1000000), 0, 1);
    const engagement = 18 * clamp(er / 12, 0, 1);
    const freshness = 12 * clamp(1 - Math.log10(1 + hours / 6) / Math.log10(121), 0, 1);

    const total = clamp(outlier + velocity + engagement + freshness, 0, 100);
    return {
      score: Math.round(total),
      parts: {
        outlier: Math.round(outlier * 10) / 10,
        velocity: Math.round(velocity * 10) / 10,
        engagement: Math.round(engagement * 10) / 10,
        freshness: Math.round(freshness * 10) / 10,
      },
    };
  }

  function computeMetrics(item, nowMs) {
    const now = nowMs || Date.now();
    const hours = Math.max(0.25, hoursSince(item.postedAt, now));
    if (isPending(item)) {
      return {
        pending: true,
        hours,
        viralMultiple: null,
        vph: null,
        engagementRate: null,
        score: null,
        parts: null,
        tier: 'pending',
      };
    }
    const viralMultiple = item.avgViews > 0 ? item.views / item.avgViews : 0;
    const vph = item.views / hours;
    const engagementRate = item.views > 0 ? ((item.likes || 0) + (item.comments || 0)) / item.views * 100 : 0;
    const s = computeScore({ viralMultiple, vph, engagementRate, hours });
    return {
      pending: false,
      hours,
      viralMultiple,
      vph,
      engagementRate,
      score: item.views > 0 ? s.score : 0,
      parts: s.parts,
      tier: viralTier(viralMultiple),
    };
  }

  function viralTier(m) {
    if (m === null || m === undefined) return 'pending';
    if (m >= 10) return 'epic';
    if (m >= 5) return 'hot';
    if (m >= 2) return 'warm';
    return 'calm';
  }

  function tierLabel(m) {
    const t = viralTier(m);
    return { epic: '초대형', hot: '핫', warm: '상승', calm: '평범', pending: '미확인' }[t];
  }

  /* ---------- search / filter / sort ---------- */
  // 사용자가 직접 모은 영상(YouTube API 실시간 수집 · 링크 · CSV)만 골라내는 기준.
  // 데모 28건은 source가 없으므로 여기서 걸러진다.
  const COLLECTED_SOURCES = ['youtube-api', 'url', 'csv'];

  function isCollected(item) {
    return !!item && COLLECTED_SOURCES.indexOf(item.source) !== -1;
  }

  function normalizeQuery(q) {
    return String(q || '').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  function haystack(item) {
    if (!item._hay) {
      item._hay = [
        item.caption || '',
        item.creator || '',
        item.creatorName || '',
        (item.hashtags || []).join(' '),
        item.hookText || '',
        item.category || '',
        item.product ? item.product.name : '',
        item.channelTitle || '',
        (item.searchTerms || []).join(' '),
      ].join(' ').toLowerCase();
    }
    return item._hay;
  }

  function searchItems(items, query) {
    const q = normalizeQuery(query);
    if (!q) return items.slice();
    const tokens = q.split(' ').filter(Boolean);
    return items.filter((item) => {
      const hay = haystack(item);
      return tokens.every((t) => hay.indexOf(t.replace(/^@/, '')) !== -1);
    });
  }

  function filterItems(items, filters, nowMs) {
    const f = filters || {};
    const now = nowMs || Date.now();
    return items.filter((item) => {
      if (f.platform && f.platform !== 'all' && item.platform !== f.platform) return false;
      if (f.country && f.country !== 'all' && item.country !== f.country) return false;
      if (f.category && f.category !== 'all' && item.category !== f.category) return false;
      if (f.period && f.period > 0 && hoursSince(item.postedAt, now) > f.period) return false;
      if (f.minMultiple && f.minMultiple > 0) {
        const m = computeMetrics(item, now).viralMultiple;
        if (m === null || m < f.minMultiple) return false;
      }
      if (f.commerceOnly && !item.product) return false;
      if (f.collectedOnly && !isCollected(item)) return false;
      return true;
    });
  }

  function sortItems(items, sortKey, nowMs) {
    const now = nowMs || Date.now();
    const decorated = items.map((item) => ({ item, m: computeMetrics(item, now), t: Date.parse(item.postedAt) || 0 }));
    const byId = (a, b) => (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0);
    decorated.sort((a, b) => {
      let d = 0;
      if (sortKey === 'newest') d = b.t - a.t;
      else if (sortKey === 'multiple') d = (b.m.viralMultiple || 0) - (a.m.viralMultiple || 0);
      else if (sortKey === 'vph') d = (b.m.vph || 0) - (a.m.vph || 0);
      else d = (b.m.score === null ? -1 : b.m.score) - (a.m.score === null ? -1 : a.m.score);
      if (d !== 0) return d;
      if (sortKey !== 'vph') {
        const dv = (b.item.views || 0) - (a.item.views || 0);
        if (dv !== 0) return dv;
      }
      return byId(a, b);
    });
    return decorated.map((d) => d.item);
  }

  function visibleItems(items, state, nowMs) {
    const filtered = filterItems(items, state.filters || {}, nowMs);
    const searched = searchItems(filtered, state.query);
    return sortItems(
      searched.filter((i) => (state.watchlistOnly && state.watchlistOnly.indexOf(i.creator) === -1 ? false : true)),
      state.sort || 'score',
      nowMs
    );
  }

  /* ---------- baseline ---------- */
  function median(list) {
    const arr = list.filter((v) => typeof v === 'number' && isFinite(v) && v > 0).sort((a, b) => a - b);
    if (!arr.length) return 0;
    const mid = Math.floor(arr.length / 2);
    return arr.length % 2 ? arr[mid] : Math.round((arr[mid - 1] + arr[mid]) / 2);
  }

  /**
   * 채널 기준 조회수. 수집 표본이 3개 이상이면 중앙값,
   * 아니면 채널 전체 평균(조회수/영상수), 그것도 없으면 구독자 기반 추정.
   */
  function channelBaseline(collectedViews, channel) {
    const arr = (collectedViews || []).filter((v) => typeof v === 'number' && v > 0);
    if (arr.length >= 3) return { avgViews: median(arr), basis: 'collected', samples: arr.length };
    if (channel && channel.viewCount > 0 && channel.videoCount > 0) {
      return { avgViews: Math.round(channel.viewCount / channel.videoCount), basis: 'channel-avg', samples: arr.length };
    }
    if (arr.length > 0) return { avgViews: median(arr), basis: 'collected-few', samples: arr.length };
    if (channel && channel.subscriberCount > 0) {
      return { avgViews: Math.round(channel.subscriberCount * 0.6), basis: 'subs-estimate', samples: 0 };
    }
    return { avgViews: 0, basis: 'none', samples: 0 };
  }

  const BASIS_LABEL = {
    collected: '수집 영상 중앙값',
    'collected-few': '수집 영상 평균(표본 적음)',
    'channel-avg': '채널 전체 평균 조회수',
    'subs-estimate': '구독자 기반 추정',
    none: '기준 없음',
  };

  /* ---------- URL / YouTube helpers ---------- */
  function parseVideoUrl(raw) {
    const url = String(raw || '').trim();
    if (!url || url.length > 500) return null;
    let u;
    try {
      u = new URL(url.indexOf('://') === -1 ? 'https://' + url : url);
    } catch (e) {
      return null;
    }
    const host = u.hostname.replace(/^www\./, '').replace(/^m\./, '');
    const path = u.pathname;

    if (host === 'youtube.com' || host === 'youtu.be' || host === 'music.youtube.com') {
      let id = null;
      if (host === 'youtu.be') id = path.split('/').filter(Boolean)[0];
      else if (path.indexOf('/shorts/') === 0) id = path.split('/')[2];
      else if (path === '/watch') id = u.searchParams.get('v');
      else if (path.indexOf('/embed/') === 0) id = path.split('/')[2];
      else if (path.indexOf('/live/') === 0) id = path.split('/')[2];
      if (id && /^[A-Za-z0-9_-]{6,20}$/.test(id)) return { platform: 'youtube', id: id, url: 'https://www.youtube.com/shorts/' + id };
      return null;
    }
    if (host === 'tiktok.com') {
      const m = path.match(/^\/@([\w.\-]+)\/video\/(\d+)/);
      if (m) return { platform: 'tiktok', id: m[2], handle: '@' + m[1], url: u.href };
      const vm = u.searchParams.get('url');
      if (vm) return parseVideoUrl(vm);
      return null;
    }
    if (host === 'instagram.com') {
      const m = path.match(/^\/(?:reel|reels|p)\/([A-Za-z0-9_-]{5,})/);
      if (m) return { platform: 'instagram', id: m[1], url: 'https://www.instagram.com/reel/' + m[1] + '/' };
      return null;
    }
    return null;
  }

  function parseISODuration(iso) {
    if (!iso) return 0;
    const m = String(iso).match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/);
    if (!m) return 0;
    return (parseInt(m[1] || 0, 10) * 86400) + (parseInt(m[2] || 0, 10) * 3600) +
      (parseInt(m[3] || 0, 10) * 60) + Math.round(parseFloat(m[4] || 0));
  }

  const CATEGORY_KEYWORDS = [
    ['뷰티·패션', ['뷰티', '화장', '메이크업', '스킨', '선크림', '크림', '향수', '패션', '코디', '옷', '헤어', '네일', '다이어트', 'beauty', 'makeup', 'skincare', 'outfit', 'fashion']],
    ['푸드·맛집', ['요리', '레시피', '맛집', '먹방', '음식', '커피', '디저트', '빵', '김치', '라면', '고기', 'food', 'recipe', 'cook', 'eat', 'mukbang', 'coffee']],
    ['테크·AI', ['ai', '테크', '노트북', '아이폰', '갤럭시', '앱', '프로그램', '코딩', '챗gpt', 'tech', 'iphone', 'gadget', 'software', 'chatgpt']],
    ['재테크·썰', ['재테크', '주식', '부동산', '적금', '월급', '투자', '돈', '수익', '세금', 'money', 'stock', 'invest', 'salary', 'finance']],
    ['운동·헬스', ['운동', '헬스', '홈트', '근육', '스트레칭', '요가', '러닝', 'workout', 'gym', 'fitness']],
    ['여행·일상', ['여행', '호텔', '캠핑', '브이로그', '일상', '산책', 'trip', 'travel', 'vlog', 'camping']],
  ];

  function guessCategory(text) {
    const t = String(text || '').toLowerCase();
    for (let i = 0; i < CATEGORY_KEYWORDS.length; i++) {
      const words = CATEGORY_KEYWORDS[i][1];
      for (let j = 0; j < words.length; j++) if (t.indexOf(words[j]) !== -1) return CATEGORY_KEYWORDS[i][0];
    }
    return '리빙·꿀템';
  }

  /* ---------- CSV ---------- */
  function parseCsvBuiltin(text) {
    const src = String(text || '').replace(/^\uFEFF/, '');
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (inQuotes) {
        if (ch === '"') {
          if (src[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += ch;
      } else if (ch === '"') inQuotes = true;
      else if (ch === ',') { row.push(field); field = ''; }
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
   * 공용 통계·CSV 엔진(engines/stats-engine.js: PapaParse·simple-statistics).
   * 페이지에서 window.RadarStats 를 넣어 주면 그 엔진으로 파싱·통계를 낸다.
   * 없으면 아래 내장 구현으로 그대로 동작한다(기존 동작 보존).
   */
  let STATS = null;
  function useStats(engine) {
    STATS = engine && typeof engine.parseCsv === 'function' ? engine : null;
    return !!STATS;
  }
  function statsEngine() { return STATS; }

  function parseCsv(text) {
    if (STATS && typeof STATS.parseCsv === 'function') {
      try { return STATS.parseCsv(text); } catch (e) { /* 내장으로 폴백 */ }
    }
    return parseCsvBuiltin(text);
  }

  /** 배수 배열과 분포 요약. 차트·이상치 표시에 쓴다. */
  function multiplesOf(items, now) {
    const out = [];
    (items || []).forEach((it) => {
      const m = computeMetrics(it, now);
      if (m && !m.pending && typeof m.viralMultiple === 'number' && m.viralMultiple > 0) out.push(m.viralMultiple);
    });
    return out;
  }

  function distributionOf(items, now, opts) {
    const values = multiplesOf(items, now);
    if (!values.length) return { values, stats: null, histogram: null };
    if (STATS && typeof STATS.statsOf === 'function') {
      const stats = STATS.statsOf(values);
      return {
        values,
        stats,
        histogram: typeof STATS.histogram === 'function' ? STATS.histogram(values, opts) : null,
        summary: typeof STATS.summaryKo === 'function' ? STATS.summaryKo(stats) : '',
      };
    }
    // 엔진이 없을 때를 위한 최소 통계(기존 화면이 비지 않게)
    const arr = values.slice().sort((a, b) => a - b);
    const med = median(arr);
    const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
    const sd = arr.length > 1 ? Math.sqrt(arr.reduce((s, v) => s + (v - mean) * (v - mean), 0) / (arr.length - 1)) : 0;
    const stats = { n: arr.length, mean, median: med, sd, min: arr[0], max: arr[arr.length - 1], outliers: [] };
    return { values, stats, histogram: null, summary: '중앙값 ' + formatMultiple(med) + ' · ' + arr.length + '건' };
  }

  function zScoreOf(value, items, now) {
    const d = distributionOf(items, now);
    if (!d.stats || !(d.stats.sd > 0)) return 0;
    if (STATS && typeof STATS.zScore === 'function') return STATS.zScore(value, d.stats);
    return (Number(value) - d.stats.mean) / d.stats.sd;
  }

  function normalizeNumber(v) {
    if (typeof v === 'number') return v;
    let s = String(v === undefined || v === null ? '' : v).trim();
    if (!s) return null;
    s = s.replace(/,/g, '').replace(/\s/g, '').replace(/\u00a0/g, '');
    const won = s.match(/^([\d.]+)(억|만|천|k|m|b)$/i);
    if (won) {
      const n = parseFloat(won[1]);
      const unit = won[2].toLowerCase();
      const mul = unit === '억' ? 1e8 : unit === '만' ? 1e4 : unit === '천' ? 1e3 : unit === 'k' ? 1e3 : unit === 'm' ? 1e6 : 1e9;
      return isFinite(n) ? Math.round(n * mul) : null;
    }
    const n = parseFloat(s.replace(/[^\d.\-]/g, ''));
    return isFinite(n) ? n : null;
  }

  const HEADER_ALIASES = {
    url: ['url', 'link', '링크', '주소', 'video_url'],
    platform: ['platform', '플랫폼', '채널'],
    country: ['country', '국가', '지역'],
    creator: ['creator', 'handle', '크리에이터', '계정', '핸들', '작성자'],
    category: ['category', '카테고리', '분야'],
    caption: ['caption', '제목', '설명', '캡션', 'title'],
    views: ['views', '조회수', 'view', '조회'],
    likes: ['likes', '좋아요', 'like', '하트'],
    comments: ['comments', '댓글', 'comment'],
    avgviews: ['avgviews', 'avg_views', '평균조회수', '채널평균', 'baseline', '평균'],
    hoursago: ['hoursago', 'hours_ago', '경과시간', '시간', 'hours'],
    postedat: ['postedat', 'posted_at', '게시일', '업로드일', 'date'],
    hook: ['hook', 'hooktype', '훅', '훅유형'],
    hooktext: ['hooktext', 'hook_text', '훅문구'],
    hashtags: ['hashtags', '해시태그', '태그'],
    duration: ['duration', '길이', '영상길이', 'seconds'],
    product: ['product', '상품', '제품'],
    price: ['price', '가격'],
  };

  function headerKey(cell) {
    const key = String(cell || '').trim().toLowerCase().replace(/[\s_\-]/g, '');
    for (const field in HEADER_ALIASES) {
      if (HEADER_ALIASES[field].some((a) => a.replace(/[\s_\-]/g, '') === key)) return field;
    }
    return null;
  }

  /**
   * CSV text -> { items, errors }
   * Rows without a recognizable URL or views are still imported (pending metrics).
   */
  function csvToItems(text, opts) {
    const now = (opts && opts.nowMs) || Date.now();
    const rows = parseCsv(text);
    const items = [];
    const errors = [];
    if (!rows.length) return { items, errors: [{ row: 0, message: '내용이 비어 있습니다.' }] };
    const headers = rows[0].map(headerKey);
    if (headers.every((h) => h === null)) {
      return { items, errors: [{ row: 1, message: '헤더를 인식하지 못했습니다. url, views, creator 같은 열 이름이 필요합니다.' }] };
    }
    for (let r = 1; r < rows.length; r++) {
      const cells = rows[r];
      if (cells.every((c) => String(c).trim() === '')) continue;
      const rec = {};
      headers.forEach((h, i) => { if (h) rec[h] = String(cells[i] === undefined ? '' : cells[i]).trim(); });
      if (!rec.caption && !rec.url && !rec.views) {
        errors.push({ row: r + 1, message: '제목·링크·조회수가 모두 없어 건너뛰었습니다.' });
        continue;
      }
      const parsed = parseVideoUrl(rec.url || '');
      const platform = (rec.platform || (parsed && parsed.platform) || 'instagram').toLowerCase();
      const platformId = platform.indexOf('you') === 0 ? 'youtube' : platform.indexOf('tik') === 0 ? 'tiktok' : 'instagram';
      const views = normalizeNumber(rec.views);
      const hours = rec.hoursago !== undefined ? normalizeNumber(rec.hoursago) : null;
      const postedAt = rec.postedat && isFinite(Date.parse(rec.postedat))
        ? new Date(rec.postedat).toISOString()
        : new Date(now - (hours !== null && hours > 0 ? hours : 24) * 3600000).toISOString();
      const item = {
        id: 'csv-' + r + '-' + Math.random().toString(36).slice(2, 7),
        source: 'csv',
        platform: platformId,
        country: (rec.country || 'KR').toUpperCase() === 'GL' ? 'GL' : 'KR',
        creator: rec.creator || (parsed && parsed.handle) || '@' + platformId + '.creator',
        creatorName: rec.creator || '수집 계정',
        category: CATEGORIES.indexOf(rec.category) !== -1 ? rec.category : guessCategory((rec.caption || '') + ' ' + (rec.hooktext || '')),
        caption: rec.caption || '(캡션 없음)',
        hashtags: (rec.hashtags || '').split(/[\s,]+/).filter(Boolean).map((h) => (h[0] === '#' ? h : '#' + h)),
        views: views,
        likes: normalizeNumber(rec.likes) || 0,
        comments: normalizeNumber(rec.comments) || 0,
        avgViews: normalizeNumber(rec.avgviews) || 0,
        subscribers: 0,
        postedAt,
        durationSec: normalizeNumber(rec.duration) || 0,
        hookType: HOOK_TYPES.indexOf(rec.hook) !== -1 ? rec.hook : '질문형',
        hookText: rec.hooktext || '',
        cta: '',
        url: (parsed && parsed.url) || rec.url || '',
        cover: { text: coverLines(rec.caption || '수집한 레퍼런스'), palette: 'slate', motif: 'default' },
      };
      if (rec.product) item.product = { name: rec.product, price: normalizeNumber(rec.price) || 0, gmv: 0, channel: 'video' };
      if (item.url && !/^https?:\/\//i.test(item.url)) item.url = (parsed && parsed.url) || '';
      items.push(item);
    }
    return { items, errors };
  }

  function coverLines(text) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    const words = clean.split(' ');
    if (words.length === 1) return [clean.slice(0, 12)];
    const mid = Math.ceil(words.length / 2);
    return [words.slice(0, mid).join(' ').slice(0, 14), words.slice(mid).join(' ').slice(0, 14)];
  }

  const SAMPLE_CSV = [
    'url,platform,creator,views,likes,comments,avg_views,hours_ago,category,caption,hashtags',
    'https://www.youtube.com/shorts/dQw4w9WgXcQ,youtube,@sample.creator,540000,29200,1180,200000,18,푸드·맛집,"냉동만두, 물 없이 굽는 법",#냉동만두 #자취요리',
    'https://www.tiktok.com/@sample/video/7300000000000000000,tiktok,@sample.tiktok,1200000,51000,2400,380000,30,뷰티·패션,3만원대 광채 루틴,#뷰티 #꿀템',
  ].join('\n');

  /* ---------- export ---------- */
  function csvEscape(v) {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function toCsv(rows, columns) {
    const head = columns.map((c) => csvEscape(c.label)).join(',');
    const body = rows.map((row) => columns.map((c) => csvEscape(typeof c.value === 'function' ? c.value(row) : row[c.key])).join(','));
    return [head].concat(body).join('\r\n');
  }

  const BOARD_COLUMNS = [
    { key: 'statusLabel', label: '상태' },
    { key: 'creator', label: '크리에이터' },
    { key: 'platformLabel', label: '플랫폼' },
    { key: 'countryLabel', label: '국가' },
    { key: 'category', label: '카테고리' },
    { key: 'caption', label: '캡션' },
    { key: 'views', label: '조회수' },
    { key: 'likes', label: '좋아요' },
    { key: 'comments', label: '댓글' },
    { key: 'multiple', label: '바이럴 배수' },
    { key: 'vph', label: 'VPH' },
    { key: 'score', label: '떡상 점수' },
    { key: 'tags', label: '태그' },
    { key: 'memo', label: '메모' },
    { key: 'url', label: '링크' },
    { key: 'addedAt', label: '저장일' },
  ];

  function boardRows(items, board, nowMs) {
    return items.map((item) => {
      const entry = board[item.id] || {};
      const m = computeMetrics(item, nowMs);
      return {
        id: item.id,
        statusLabel: (STATUSES.find((s) => s.id === entry.status) || STATUSES[0]).label,
        creator: item.creator,
        platformLabel: PLATFORM_LABEL[item.platform] || item.platform,
        countryLabel: item.country,
        category: item.category,
        caption: item.caption,
        views: item.views,
        likes: item.likes,
        comments: item.comments,
        multiple: m.viralMultiple === null ? '' : Math.round(m.viralMultiple * 10) / 10,
        vph: m.vph === null ? '' : Math.round(m.vph),
        score: m.score === null ? '' : m.score,
        tags: (entry.tags || []).join(' '),
        memo: entry.memo || '',
        url: item.url || '',
        addedAt: entry.addedAt || '',
      };
    });
  }

  function toBoardCsv(items, board, nowMs) {
    return toCsv(boardRows(items, board, nowMs), BOARD_COLUMNS);
  }

  function toRadarCsv(items, nowMs) {
    const cols = [
      { key: 'creator', label: '크리에이터' },
      { key: 'platformLabel', label: '플랫폼' },
      { key: 'countryLabel', label: '국가' },
      { key: 'category', label: '카테고리' },
      { key: 'caption', label: '캡션' },
      { key: 'views', label: '조회수' },
      { key: 'avgViews', label: '채널 평균' },
      { key: 'multiple', label: '바이럴 배수' },
      { key: 'vph', label: 'VPH' },
      { key: 'score', label: '떡상 점수' },
      { key: 'hookType', label: '훅 유형' },
      { key: 'hashtags', label: '해시태그' },
      { key: 'url', label: '링크' },
    ];
    const rows = items.map((item) => {
      const m = computeMetrics(item, nowMs);
      return {
        creator: item.creator, platformLabel: PLATFORM_LABEL[item.platform] || item.platform,
        countryLabel: item.country, category: item.category, caption: item.caption,
        views: item.views, avgViews: item.avgViews,
        multiple: m.viralMultiple === null ? '' : Math.round(m.viralMultiple * 10) / 10,
        vph: m.vph === null ? '' : Math.round(m.vph),
        score: m.score === null ? '' : m.score,
        hookType: item.hookType, hashtags: (item.hashtags || []).join(' '), url: item.url || '',
      };
    });
    return toCsv(rows, cols);
  }

  /* ---------- board ---------- */
  function normalizeStatus(id) {
    return STATUSES.some((s) => s.id === id) ? id : null;
  }

  function nextStatus(id) {
    const i = STATUSES.findIndex((s) => s.id === id);
    if (i === -1) return STATUSES[0].id;
    return STATUSES[Math.min(STATUSES.length - 1, i + 1)].id;
  }

  function prevStatus(id) {
    const i = STATUSES.findIndex((s) => s.id === id);
    if (i <= 0) return STATUSES[0].id;
    return STATUSES[i - 1].id;
  }

  function boardGroups(items, board) {
    const map = {};
    STATUSES.forEach((s) => { map[s.id] = []; });
    items.forEach((item) => {
      const entry = board[item.id];
      if (!entry) return;
      const status = normalizeStatus(entry.status) || 'saved';
      map[status].push(item);
    });
    return STATUSES.map((s) => ({ ...s, items: map[s.id] }));
  }

  /* ---------- hook / script / prompt ---------- */
  const HOOK_LIBRARY = [
    {
      type: '질문형',
      formula: '“혹시 ~ 때문에 ~한 적 있으세요?”',
      why: '내 문제인지 0.5초 만에 자각시켜 스크롤을 세운다. 댓글 유도에도 가장 강하다.',
      template: '혹시 {타깃}이라면 {문제상황} 때문에 {손실} 겪어본 적 있으세요?',
    },
    {
      type: '충격숫자',
      formula: '“{숫자}명이 ~했는데 결과는 ~”',
      why: '구체적 수치가 신뢰를 만들고 기대 격차를 만든다. 저장률이 높다.',
      template: '{숫자}번 해봤는데, {반직관적 결과}. 이유는 딱 하나였어요.',
    },
    {
      type: '반전',
      formula: '“다들 ~라고 하는데, 반대로 해봤더니”',
      why: '상식을 부정하는 첫 문장이 시청 지속을 만든다. 완주율에 강하다.',
      template: '다들 {상식}이라고 하는데, 저는 {기간} 동안 반대로 해봤습니다. 결과는요…',
    },
    {
      type: '비교',
      formula: '“A vs B, 기준 하나만 바꾸면”',
      why: '선택 장애를 자극해 비교 끝까지 보게 만든다. 커머스에 특히 강하다.',
      template: '{A} vs {B}, {기준} 하나만 보면 답이 완전히 달라집니다.',
    },
  ];

  function hookLibrary(type) {
    return HOOK_LIBRARY.find((h) => h.type === type) || HOOK_LIBRARY[0];
  }

  function hookStats(items, nowMs) {
    const now = nowMs || Date.now();
    const groups = {};
    HOOK_TYPES.forEach((t) => { groups[t] = { type: t, count: 0, scoreSum: 0, multipleSum: 0, best: null, bestScore: -1 }; });
    items.forEach((item) => {
      const m = computeMetrics(item, now);
      if (m.score === null) return;
      const g = groups[item.hookType] || groups['질문형'];
      g.count++;
      g.scoreSum += m.score;
      g.multipleSum += m.viralMultiple || 0;
      if (m.score > g.bestScore) { g.bestScore = m.score; g.best = item; }
    });
    return HOOK_TYPES.map((t) => {
      const g = groups[t];
      return {
        type: t,
        count: g.count,
        avgScore: g.count ? Math.round(g.scoreSum / g.count) : 0,
        avgMultiple: g.count ? Math.round((g.multipleSum / g.count) * 10) / 10 : 0,
        best: g.best,
      };
    }).sort((a, b) => b.avgScore - a.avgScore);
  }

  function shortCaption(item) {
    return String(item.caption || '').replace(/\s+/g, ' ').trim();
  }

  function keywordOf(item) {
    const tag = (item.hashtags || [])[0];
    if (tag) return tag.replace(/^#/, '');
    const words = shortCaption(item).split(' ');
    return words.slice(0, 2).join(' ') || '이 주제';
  }

  function buildHookAnalysis(item) {
    const lib = hookLibrary(item.hookType);
    const m = computeMetrics(item, Date.now());
    return {
      type: item.hookType,
      lib,
      hookText: item.hookText || (item.cover && item.cover.text ? item.cover.text.join(' ') : shortCaption(item).slice(0, 40)),
      beats: [
        { range: '0~3초', role: '훅', goal: '시선 고정', text: item.hookText || shortCaption(item).slice(0, 40) },
        { range: '3~8초', role: '문제 제기', goal: '공감·손실 자각', text: '“' + keywordOf(item) + '” 때문에 생기는 손실을 한 문장으로 짚어준다.' },
        { range: '8~15초', role: '증거·시연', goal: '신뢰', text: '직접 해보는 장면 1개 + 결과 수치 1개(예: ‘' + (m.viralMultiple ? formatMultiple(m.viralMultiple) : '2.4x') + ' 반응’).' },
        { range: '15~22초', role: '반전·정리', goal: '저장 유도', text: '“핵심은 ' + keywordOf(item) + ' 하나였습니다”로 한 줄 정리.' },
        { range: '22~25초', role: 'CTA', goal: '행동', text: item.cta || '저장해두고 이번 주에 한 번만 써보세요.' },
      ],
      strength: m.score === null ? 0 : m.score,
    };
  }

  function buildScript(item, opts) {
    const o = opts || {};
    const hook = item.hookText || (item.cover && item.cover.text ? item.cover.text[0] : '');
    const key = keywordOf(item);
    const target = o.target || '이 문제를 겪는 사람';
    const product = o.product || item.product ? (o.product || item.product.name) : '내 제품';
    const beat = {
      '질문형': '혹시 ' + target + '이라면, ' + key + ' 때문에 ' + (o.loss || '시간·돈을 두 번 쓰는 일') + ' 겪어본 적 있으세요?',
      '충격숫자': (o.number || '37') + '번 해봤는데 결과는 반대였습니다. ' + key + ', 이렇게 하면 달라집니다.',
      '반전': '다들 ' + key + '는 ' + (o.common || '비싼 장비가 필요하다') + '고 하는데, 저는 반대로 해봤습니다.',
      '비교': key + ' vs ' + (o.compare || '기존 방식') + ', 딱 하나만 보면 답이 달라집니다.',
    }[item.hookType] || hook;

    return [
      '[0~3초 · 훅] ' + beat,
      '[3~8초 · 문제] ' + target + '이 겪는 구체적 상황 1개: “' + key + ', 그냥 하면 ' + (o.loss || '두 번 일하게 됩니다') + '.”',
      '[8~15초 · 증거] ' + product + '로 직접 해보는 장면. 결과 수치 1개를 자막으로 고정(‘전: 12분 → 후: 3분’처럼).',
      '[15~22초 · 반전] 사실 핵심은 ' + key + ' 하나였습니다. 나머지는 다 빼도 됩니다.',
      '[22~25초 · CTA] ' + (item.cta || '저장해두고 이번 주에 한 번만 써보세요.') + ' (댓글에 ‘' + key + '’ 남겨주시면 순서대로 알려드릴게요.)',
      '',
      '※ 촬영 메모: 세로 9:16 · 첫 프레임에 얼굴/제품 클로즈업 · 자막은 한 줄 9자 이내 · 배경음은 비트 드롭을 3초에 맞추기',
    ].join('\n');
  }

  function buildPrompt(item, opts) {
    const o = opts || {};
    const m = computeMetrics(item, Date.now());
    const data = {
      reference: {
        platform: item.platform,
        creator: item.creator,
        category: item.category,
        caption: item.caption,
        hashtags: item.hashtags,
        views: item.views,
        likes: item.likes,
        comments: item.comments,
        viral_multiple: m.viralMultiple === null ? null : Math.round(m.viralMultiple * 10) / 10,
        vph: m.vph === null ? null : Math.round(m.vph),
        score: m.score,
        hook_type: item.hookType,
        hook_text: item.hookText,
      },
    };
    return [
      '너는 한국 숏폼(릴스·쇼츠·틱톡) 대본 작가다. 아래 레퍼런스의 훅 유형과 전개 구조를 유지하되 문장은 새로 써라.',
      '',
      '[레퍼런스 데이터]',
      JSON.stringify(data, null, 2),
      '',
      '[내 조건]',
      '- 제품/주제: ' + (o.product || (item.product ? item.product.name : '내 제품')) ,
      '- 타깃: ' + (o.target || '20~40대, 문제를 이미 겪고 있는 사람'),
      '- 목표: ' + (o.goal || '저장·댓글 유도'),
      '- 길이: 25초 내외, 5비트(훅-문제-증거-반전-CTA)',
      '',
      '[규칙]',
      '1) 첫 3초 안에 ' + item.hookType + ' 훅을 넣고, 숫자나 구체 상황을 반드시 포함한다.',
      '2) 말투는 반말 구어체. 번역체·AI 요약체·존댓말 금지.',
      '3) 자막은 한 줄 9자 이내, 화면에 띄울 문구와 나레이션을 구분해 표로 정리한다.',
      '4) 과장·허위 수치 금지. 확인되지 않은 효능은 쓰지 않는다.',
      '5) 마지막에 촬영 컷 리스트(장면 5개, 각 3~5초)를 붙인다.',
    ].join('\n');
  }

  /* ---------- 레퍼런스 저장(분석팩 · 썸네일 · yt-dlp) ---------- */
  const THUMB_QUALITIES = ['maxresdefault', 'sddefault', 'hqdefault', 'mqdefault', 'default'];
  const PACK_NOTE = '정적 웹앱(CORS·플랫폼 약관)에서는 원본 MP4를 브라우저로 직접 내려받을 수 없습니다. ' +
    '썸네일·분석팩은 바로 저장되고, 원본은 아래 yt-dlp 명령을 PC 터미널에 붙여넣으면 저장됩니다.';

  function youtubeVideoId(item) {
    if (!item) return '';
    const direct = String(item.videoId || '').trim();
    if (/^[A-Za-z0-9_-]{6,20}$/.test(direct)) return direct;
    const fromUrl = String(item.url || '')
      .match(/(?:youtube\.com\/(?:shorts|embed|live)\/|youtu\.be\/|[?&]v=)([A-Za-z0-9_-]{6,20})/);
    if (fromUrl) return fromUrl[1];
    const fromThumb = String(item.thumbnail || '').match(/\/vi\/([A-Za-z0-9_-]{6,20})\//);
    return fromThumb ? fromThumb[1] : '';
  }

  function youtubeThumbUrl(item, quality) {
    const id = youtubeVideoId(item);
    if (!id) return '';
    const q = THUMB_QUALITIES.indexOf(quality) === -1 ? 'hqdefault' : quality;
    return 'https://i.ytimg.com/vi/' + id + '/' + q + '.jpg';
  }

  function youtubeThumbUrls(item) {
    const id = youtubeVideoId(item);
    if (!id) return [];
    return THUMB_QUALITIES.map((q) => ({
      quality: q,
      url: 'https://i.ytimg.com/vi/' + id + '/' + q + '.jpg',
    }));
  }

  function ytdlpCommand(url) {
    const u = String(url || '').trim();
    if (!u || u.length > 500) return '';
    return 'yt-dlp -f "bv*+ba/b" --merge-output-format mp4 "' + u.replace(/"/g, '%22') + '"';
  }

  function fileSlug(text, max) {
    const s = String(text === undefined || text === null ? '' : text)
      .replace(/[\\/:*?"<>|#]/g, ' ')
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[.\-]+/, '')
      .replace(/[.\-]+$/, '');
    return s.slice(0, max || 24);
  }

  /** 다운로드 파일명: 떡상레이더_크리에이터_제목.ext (사람이 알아보게, 경로 문자 제거) */
  function packFilename(item, ext, opts) {
    const o = opts || {};
    const it = item || {};
    const handle = fileSlug(String(it.creator || '').replace(/^@/, ''), 20);
    const title = fileSlug(shortCaption(it), o.titleMax || 24);
    const base = [handle, title].filter(Boolean).join('_') || fileSlug(String(it.id || 'reference'), 24) || 'reference';
    return '떡상레이더_' + base + '.' + (ext || 'txt');
  }

  function packStamp(ms) {
    const d = new Date((ms || Date.now()) + 9 * 3600000);
    const p = (n) => (n < 10 ? '0' + n : String(n));
    return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' +
      p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ' (KST)';
  }

  const TIER_LABEL = { epic: '초대형', hot: '핫', warm: '상승', calm: '평범', pending: '미확인' };

  /**
   * 선택한 영상 하나를 TXT·JSON 분석팩으로 만든다.
   * 제목·크리에이터·플랫폼·조회수·바이럴 배수·훅·대본/구성·해시태그·원본 URL을 모두 담는다.
   */
  function buildReferencePack(item, opts) {
    const o = opts || {};
    const now = o.nowMs || Date.now();
    const m = computeMetrics(item, now);
    const hook = buildHookAnalysis(item);
    const title = shortCaption(item) || itemTitle(item) || '제목 없음';
    const platformLabel = PLATFORM_LABEL[item.platform] || item.platform || '—';
    const hashtags = (item.hashtags || []).slice();
    const videoId = youtubeVideoId(item);
    const thumb = youtubeThumbUrl(item, 'maxresdefault');
    const url = String(item.url || '');
    const command = ytdlpCommand(url);
    const tier = m.pending ? 'pending' : m.tier;
    const tierText = TIER_LABEL[tier] || '';
    const script = buildScript(item, { product: o.product });

    const data = {
      app: '떡상 레이더',
      kind: 'reference-pack',
      version: 1,
      generatedAt: new Date(now).toISOString(),
      reference: {
        id: item.id || '',
        title: title,
        caption: shortCaption(item),
        creator: item.creator || '',
        creatorName: item.creatorName || '',
        platform: item.platform || '',
        platformLabel: platformLabel,
        country: item.country || '',
        category: item.category || '',
        hashtags: hashtags,
        postedAt: item.postedAt || '',
        durationSec: item.durationSec || 0,
        url: url,
        videoId: videoId,
        thumbnailUrl: thumb,
        product: item.product ? {
          name: item.product.name || '',
          price: item.product.price || 0,
          gmv: item.product.gmv || null,
          channel: item.product.channel || '',
        } : null,
      },
      metrics: {
        views: item.views === undefined ? null : item.views,
        likes: item.likes === undefined ? null : item.likes,
        comments: item.comments === undefined ? null : item.comments,
        shares: item.shares === undefined ? null : item.shares,
        saves: item.saves === undefined ? null : item.saves,
        avgViews: item.avgViews === undefined ? null : item.avgViews,
        subscribers: item.subscribers === undefined ? null : item.subscribers,
        viralMultiple: m.viralMultiple,
        vph: m.vph,
        engagementRate: m.engagementRate,
        score: m.score,
        tier: tier,
        tierLabel: tierText,
        basis: item.baselineBasis || '',
      },
      hook: {
        type: item.hookType || '',
        text: hook.hookText,
        formula: hook.lib.formula,
        why: hook.lib.why,
        beats: hook.beats,
      },
      script: script,
      assets: {
        cardPng: { width: 1080, height: 1920, note: '앱의 PNG 저장 버튼 → 9:16 요약 카드' },
        youtubeThumbnail: thumb || null,
      },
      download: {
        method: url ? 'yt-dlp' : '',
        command: command,
        note: PACK_NOTE,
      },
    };

    const lines = [];
    lines.push('떡상 레이더 · 레퍼런스 분석팩');
    lines.push('생성 ' + packStamp(now));
    lines.push('────────────────────────────────────────');
    lines.push('[기본 정보]');
    lines.push('제목: ' + title);
    lines.push('크리에이터: ' + (item.creator || '—') + (item.creatorName && item.creatorName !== item.creator ? ' (' + item.creatorName + ')' : ''));
    lines.push('플랫폼: ' + platformLabel + (item.country ? ' · ' + item.country : ''));
    lines.push('카테고리: ' + (item.category || '—'));
    lines.push('게시: ' + (item.postedAt ? packStamp(Date.parse(item.postedAt)) + ' · ' + relativeTime(item.postedAt, now) : '—'));
    lines.push('길이: ' + (item.durationSec ? item.durationSec + '초' : '—'));
    lines.push('해시태그: ' + (hashtags.length ? hashtags.join(' ') : '없음'));
    lines.push('원본: ' + (url || '(데모 카드 — 원본 링크 없음)'));
    lines.push('');
    lines.push('[성과 지표]');
    lines.push('조회수: ' + (m.pending ? '미확인' : formatCount(item.views)) +
      ' · 좋아요: ' + (m.pending ? '미확인' : formatCount(item.likes || 0)) +
      ' · 댓글: ' + (m.pending ? '미확인' : formatCount(item.comments || 0)));
    lines.push('채널 평균: ' + formatCount(item.avgViews || 0) + ' · 바이럴 배수: ' + (m.pending ? '미확인' : formatMultiple(m.viralMultiple)) +
      (item.baselineBasis && BASIS_LABEL[item.baselineBasis] ? ' (' + BASIS_LABEL[item.baselineBasis] + ')' : ''));
    lines.push('VPH: ' + (m.pending ? '미확인' : formatVph(m.vph)) + ' · 참여율: ' + (m.pending ? '미확인' : formatPercent(m.engagementRate)));
    lines.push('떡상 점수: ' + (m.pending ? '미확인' : m.score + '/100') + (tierText ? ' (' + tierText + ')' : ''));
    lines.push('');
    lines.push('[첫 3초 훅]');
    lines.push('유형: ' + (item.hookType || '—'));
    lines.push('문구: ' + (hook.hookText || '—'));
    lines.push('공식: ' + hook.lib.formula);
    lines.push('왜 먹히나: ' + hook.lib.why);
    lines.push('');
    lines.push('[영상 구성 5비트]');
    hook.beats.forEach((b) => lines.push(b.range + ' | ' + b.role + ' | ' + b.text));
    lines.push('');
    lines.push('[바로 쓰는 대본 템플릿]');
    lines.push(script);
    lines.push('');
    if (item.product) {
      lines.push('[연결 상품]');
      lines.push(item.product.name + ' · ' + formatCount(item.product.price) + '원' +
        (item.product.gmv ? ' · 누적 GMV ' + formatCount(item.product.gmv) + '원' : ''));
      lines.push('');
    }
    lines.push('[이미지 · 원본]');
    lines.push('YouTube 썸네일: ' + (thumb || '없음 (YouTube 영상 ID 없음)'));
    lines.push('카드 PNG: 앱의 PNG 저장 → 1080×1920 9:16 레퍼런스 요약 카드');
    lines.push('원본 내려받기: ' + (command || '원본 링크 없음'));
    lines.push('');
    lines.push('※ ' + PACK_NOTE);

    return {
      txt: lines.join('\n') + '\n',
      json: JSON.stringify(data, null, 2),
      data: data,
      files: { txt: packFilename(item, 'txt', o), json: packFilename(item, 'json', o) },
    };
  }

  /* ---------- quota ---------- */
  function quotaDateKey(nowMs) {
    // YouTube quota resets at midnight Pacific (UTC-8 standard time).
    const shifted = new Date((nowMs || Date.now()) - 8 * 3600000);
    return shifted.toISOString().slice(0, 10);
  }

  function bumpQuota(quota, nowMs, searchCalls, unitCalls) {
    const key = quotaDateKey(nowMs);
    const base = quota && quota.date === key ? quota : { date: key, search: 0, units: 0 };
    return {
      date: key,
      search: base.search + (searchCalls || 0),
      units: base.units + (unitCalls || 0),
    };
  }

  const QUOTA = { searchPerDay: 100, unitsPerDay: 10000 };

  /* ---------- copy psychology engine (engines/copy-psych-engine.js) ---------- */
  // 브라우저에서는 index.html이 먼저 읽어 둔 window.CopyPsych,
  // node 테스트에서는 같은 폴더의 engines 사본을 require 한다.
  const CopyPsych = (typeof window !== 'undefined' && window.CopyPsych)
    ? window.CopyPsych
    : (typeof require === 'function' ? require('./engines/copy-psych-engine.js') : null);

  const PSY_AUDIENCE = {
    '뷰티·패션': '화장품 고르다 후기만 30분째 보는 20~30대',
    '푸드·맛집': '매일 저녁 뭐 먹을지 고민하는 자취·직장인',
    '리빙·꿀템': '정리해도 사흘 만에 다시 어질러지는 집에 사는 사람',
    '테크·AI': 'AI 툴을 결제해두고 한 달에 두 번 쓰는 직장인',
    '재테크·썰': '월급은 그대로인데 나가는 돈만 늘어난 사회초년생',
    '운동·헬스': '운동을 시작해도 사흘을 못 넘기는 직장인',
    '여행·일상': '주말 여행을 계획하다 하루를 다 쓰는 사람',
    '기타': '알고 있어도 매번 같은 자리에서 막히는 사람',
  };

  const PSY_PROBLEM = {
    '뷰티·패션': '후기만 30분째 보다가 결국 지난번 화장품을 다시 삽니다',
    '푸드·맛집': '저녁 메뉴를 고르다 30분을 쓰고 결국 배달을 시킵니다',
    '리빙·꿀템': '정리해도 사흘만 지나면 다시 어질러집니다',
    '테크·AI': 'AI 툴을 결제해두고 한 달에 두 번 씁니다',
    '재테크·썰': '카드값이 왜 이렇게 나왔는지 매달 확인하지 못합니다',
    '운동·헬스': '운동을 시작한 지 사흘 만에 다시 멈춥니다',
    '여행·일상': '주말 여행을 계획하다 하루를 다 쓰고 집에 남습니다',
    '기타': '알고 있는데도 매번 같은 자리에서 막힙니다',
  };

  const PSY_SOLUTION = {
    '뷰티·패션': '영상의 기준 하나만 적용하면 고르는 시간이 3분으로 줄어듭니다',
    '푸드·맛집': '영상의 순서 그대로 하면 저녁 준비가 10분에 끝납니다',
    '리빙·꿀템': '영상의 배치 한 곳만 바꾸면 정리 시간이 절반으로 줄어듭니다',
    '테크·AI': '영상의 3단계만 따라 하면 오늘 바로 결과가 나옵니다',
    '재테크·썰': '영상의 점검 순서대로 하면 새는 돈이 먼저 보입니다',
    '운동·헬스': '영상의 동작 하나만 매일 10분으로 바꿉니다',
    '여행·일상': '영상의 동선 그대로면 예약과 이동이 20분에 끝납니다',
    '기타': '영상의 순서를 그대로 따라 하면 한 번에 끝납니다',
  };

  function psychCategory(item) {
    return item && PSY_AUDIENCE[item.category] ? item.category : '기타';
  }

  /** 진단할 문구: 수집된 제목·훅·해시태그·CTA·상품명 (대본 본문은 수집되지 않는다) */
  function psychSourceText(item) {
    if (!item) return '';
    return [
      shortCaption(item),
      item.hookText || '',
      (item.hashtags || []).join(' '),
      item.cta || '',
      item.product ? item.product.name : '',
    ].map((s) => String(s).trim()).filter(Boolean).join('\n');
  }

  /**
   * 8대 트리거 진단.
   * @param {object} item
   * @param {object} [opts] { text: 직접 넣은 문구, nowMs }
   */
  function psychProfile(item, opts) {
    const o = opts || {};
    const text = (o.text !== undefined && o.text !== null) ? String(o.text) : psychSourceText(item);
    if (!CopyPsych) {
      return {
        ok: false, text: text, chars: countChars(text), total: 0, grade: null,
        triggers: [], strengths: [], gaps: [], recommendations: [], coverage: 0,
        strongCount: 0, weakCount: 0, flags: null, stats: null,
        note: '카피 심리학 엔진을 불러오지 못했습니다.',
      };
    }
    const d = CopyPsych.diagnose(text);
    const triggers = d.triggers.map((t) => ({
      id: t.id, name: t.name, en: t.en, weight: t.weight,
      score: t.score, level: t.level, claim: t.claim, fix: t.fix,
    }));
    return {
      ok: true,
      version: CopyPsych.VERSION,
      text: text,
      chars: d.stats.chars,
      total: d.total,
      grade: d.grade,
      triggers: triggers,
      strengths: d.strengths,
      gaps: d.gaps,
      recommendations: d.recommendations,
      coverage: triggers.filter((t) => t.score >= 40).length,
      strongCount: d.strengths.length,
      weakCount: d.weakCount,
      flags: d.flags,
      stats: d.stats,
    };
  }

  /**
   * 프레임워크 생성 입력값.
   * 문제·해결은 카테고리 기본 문장에서 출발하고, 근거 숫자는 비워 둔다.
   * (레퍼런스 영상의 조회수를 내 실적처럼 옮겨 쓰지 않기 위해서)
   */
  function psychInputFor(item, opts) {
    const o = opts || {};
    const cat = psychCategory(item);
    const keyword = item ? keywordOf(item) : '이 주제';
    const pick = (v, fallback) => (v === undefined || v === null || String(v).trim() === '') ? fallback : String(v).trim();
    return {
      product: pick(o.product, item && item.product ? item.product.name : keyword + ' 내 버전'),
      target: pick(o.target, PSY_AUDIENCE[cat]),
      problem: pick(o.problem, PSY_PROBLEM[cat]),
      solution: pick(o.solution, PSY_SOLUTION[cat]),
      proof: pick(o.proof, ''),
      cta: pick(o.cta, '저장해두고 오늘 한 번만 써보기'),
      urgency: pick(o.urgency, ''),
      guarantee: pick(o.guarantee, ''),
      priceBefore: pick(o.priceBefore, ''),
      priceAfter: pick(o.priceAfter, ''),
    };
  }

  /** 프레임워크 1종 + 자체 진단 */
  function psychFramework(item, id, opts) {
    const o = opts || {};
    const key = String(id || 'PAS').toUpperCase();
    if (!CopyPsych) return { ok: false, id: key, fw: null, input: null, error: 'engine-missing' };
    const input = psychInputFor(item, o);
    let fw;
    try {
      fw = CopyPsych.build(key, input, { variant: o.variant || 0 });
    } catch (e) {
      return { ok: false, id: key, fw: null, input: input, error: e.message };
    }
    const full = CopyPsych.diagnose(fw.title + '\n' + fw.body);
    return {
      ok: true,
      id: fw.id,
      input: input,
      fw: Object.assign({}, fw, {
        coverage: full.triggers.filter((t) => t.score >= 40).length,
        weakCount: full.weakCount,
        gapsFull: full.gaps.slice(0, 2).map((g) => ({ id: g.id, name: g.name, score: g.score, action: g.action })),
      }),
    };
  }

  /** 프레임워크 4종 동시 생성 + 비교 */
  function psychRewrite(item, opts) {
    const o = opts || {};
    if (!CopyPsych) {
      return { ok: false, input: null, items: [], best: null, comparison: [], recommendation: null, reason: 'engine-missing' };
    }
    const input = psychInputFor(item, o);
    const out = CopyPsych.generateAll(input, { variant: o.variant || 0 });
    const items = out.items.map((it) => {
      const full = CopyPsych.diagnose(it.title + '\n' + it.body);
      return Object.assign({}, it, {
        coverage: full.triggers.filter((t) => t.score >= 40).length,
        weakCount: full.weakCount,
      });
    });
    const best = items.filter((it) => it.id === out.best.id)[0] || items[0];
    return {
      ok: true,
      input: input,
      items: items,
      best: best,
      comparison: out.comparison,
      recommendation: out.recommendation,
    };
  }

  /** 복사용 카피 텍스트 */
  function frameworkText(fw) {
    if (!fw) return '';
    const lines = ['[' + fw.id + '] ' + fw.name, '제목: ' + fw.title, ''];
    (fw.sections || []).forEach((s) => lines.push('· ' + s.label + ': ' + s.text));
    lines.push('', '※ 초안입니다. 내 근거 숫자와 실제 조건으로 고쳐 쓰세요.');
    return lines.join('\n');
  }

  function psychFrameworkText(item, id, opts) {
    const r = psychFramework(item, id, opts);
    return r.ok ? frameworkText(r.fw) : '';
  }

  /* ---------- 내 구독 AI 브리지 프롬프트 ---------- */
  function buildBridgePrompt(item, opts) {
    const o = opts || {};
    if (!item) return '';
    const now = o.nowMs || Date.now();
    const m = computeMetrics(item, now);
    const prof = psychProfile(item, { nowMs: now });
    const input = psychInputFor(item, o);
    const strong = prof.triggers.slice().sort((a, b) => b.score - a.score)
      .filter((t) => t.score > 0).slice(0, 3).map((t) => t.name + ' ' + t.score);
    const gaps = prof.gaps.slice(0, 3).map((g) => g.name + ' ' + g.score);
    const platform = PLATFORM_LABEL[item.platform] || item.platform;

    const lines = [];
    lines.push('너는 한국 숏폼(릴스·쇼츠·틱톡) 대본 작가다.');
    lines.push('아래 레퍼런스는 이미 터진 영상이다. 구조와 심리 트리거만 가져오고, 문장은 내 채널·내 상품 버전으로 완전히 새로 써라.');
    lines.push('');
    lines.push('[레퍼런스]');
    lines.push('- 제목: ' + (item.caption || '(제목 없음)'));
    lines.push('- 크리에이터·카테고리: ' + (item.creator || '—') + ' · ' + (item.category || '—') + ' · ' + platform);
    if (!m.pending) {
      lines.push('- 성과: 조회 ' + formatCount(item.views) + ' · 좋아요 ' + formatCount(item.likes) + ' · 댓글 ' + formatCount(item.comments));
      lines.push('- 채널 평균 대비 ' + formatMultiple(m.viralMultiple) + ' · VPH ' + formatVph(m.vph) + ' · 참여율 ' + formatPercent(m.engagementRate));
    }
    lines.push('- 훅: ' + (item.hookType || '—') + ' — "' + (item.hookText || shortCaption(item)) + '"');
    if ((item.hashtags || []).length) lines.push('- 해시태그: ' + item.hashtags.join(' '));
    if (item.durationSec) lines.push('- 길이: ' + item.durationSec + '초');
    if (item.product) lines.push('- 연결 상품: ' + item.product.name);
    lines.push('');
    lines.push('[이 제목·훅의 심리 트리거] (' + prof.chars + '자 진단 · 커버리지 ' + prof.coverage + '/8)');
    lines.push('- 강한 축: ' + (strong.length ? strong.join(', ') : '없음'));
    lines.push('- 비어 있는 축: ' + (gaps.length ? gaps.join(', ') : '없음'));
    lines.push('※ 비어 있는 축은 내 상품에 사실이 있을 때만 채워라. 없는 수치는 만들지 마라.');
    lines.push('');
    lines.push('[내 조건]');
    lines.push('- 내 채널·상품: ' + input.product);
    lines.push('- 타깃: ' + input.target);
    lines.push('- 목표: ' + (o.goal || '저장·댓글 유도'));
    lines.push('- 길이: 30초 내외, 5비트(0~3초 훅 → 3~8초 문제 → 8~15초 증거 → 15~22초 반전 → 22~30초 CTA)');
    lines.push('- 톤: 반말 구어체');
    if (input.proof) lines.push('- 내 근거 숫자: ' + input.proof);
    lines.push('');
    lines.push('[출력 형식]');
    lines.push('1) 0~3초 훅 1문장 (자막용, 12자 이내)');
    lines.push('2) 5비트 표: 구간 | 자막 | 나레이션');
    lines.push('3) 촬영 컷 5개 (각 3~5초, 무엇을 어디에 두고 찍는지)');
    lines.push('4) 첫 댓글 1개 (질문형, 광고 문구 없이)');
    lines.push('');
    lines.push('[규칙]');
    lines.push('1) 첫 3초 안에 ' + (item.hookType || '훅') + ' 훅을 넣고, 숫자나 구체 상황을 반드시 포함한다.');
    lines.push('2) 말투는 반말 구어체. 번역체·AI 요약체·존댓말 금지.');
    lines.push('3) 자막은 한 줄 9자 이내. 자막과 나레이션을 구분해 표로 정리한다.');
    lines.push('4) 레퍼런스 수치를 내 실적처럼 쓰지 않는다. 과장·허위 수치·확인되지 않은 효능 금지.');
    lines.push('5) 마지막에 촬영 컷 리스트를 붙인다.');
    return lines.join('\n');
  }

  /* ---------- AI가 준 대본 읽기 ---------- */
  function scriptMeta(text) {
    const raw = String(text === null || text === undefined ? '' : text).replace(/\r\n?/g, '\n');
    const all = raw.split('\n');
    let fences = 0;
    const lines = all.filter((l) => {
      if (/^\s*```/.test(l)) { fences++; return false; }
      return true;
    });
    const body = lines.join('\n').trim();
    const ranges = [];
    lines.forEach((line) => {
      const m = line.match(/(\d{1,2})\s*[~\-–]\s*(\d{1,2})\s*초/);
      if (!m) return;
      const range = Number(m[1]) + '~' + Number(m[2]) + '초';
      if (ranges.indexOf(range) === -1) ranges.push(range);
    });
    const chars = countChars(body);
    const warnings = [];
    if (!body) {
      warnings.push('아직 대본이 비어 있습니다.');
    } else {
      if (chars < 80) warnings.push('대본이 ' + chars + '자로 짧습니다. 30초 대본이면 보통 400자 이상입니다.');
      if (ranges.length < 3) warnings.push('구간 표시(0~3초 등)를 ' + ranges.length + '개만 찾았습니다. 표 형태로 받으면 더 잘 읽힙니다.');
    }
    if (fences) warnings.push('코드블록 표시(```)는 지웠습니다.');
    return {
      chars: chars,
      lines: lines.filter((l) => l.trim()).length,
      beats: ranges.map((r) => ({ range: r })),
      hasHook: /훅/.test(body),
      hasCta: /(CTA|행동|마무리)/.test(body),
      warnings: warnings,
      text: body,
    };
  }

  /* ---------- misc ---------- */
  function summarize(items, nowMs) {
    const now = nowMs || Date.now();
    let sum = 0, n = 0, best = null, bestScore = -1, fresh = 0, epic = 0;
    items.forEach((item) => {
      const m = computeMetrics(item, now);
      if (m.score === null) return;
      sum += m.viralMultiple || 0; n++;
      if (m.score > bestScore) { bestScore = m.score; best = item; }
      if (m.hours <= 24) fresh++;
      if (m.tier === 'epic') epic++;
    });
    return {
      count: items.length,
      avgMultiple: n ? Math.round((sum / n) * 10) / 10 : 0,
      best,
      bestScore: n ? bestScore : 0,
      fresh,
      epic,
    };
  }

  function itemTitle(item) {
    const cap = shortCaption(item);
    return cap.length > 42 ? cap.slice(0, 40) + '…' : cap;
  }

  return {
    PLATFORMS, COUNTRIES, MULTIPLIERS, PERIODS, CATEGORIES, HOOK_TYPES, SORTS, STATUSES,
    PLATFORM_LABEL, HOOK_LIBRARY, BOARD_COLUMNS, SAMPLE_CSV, QUOTA,
    COLLECTED_SOURCES, isCollected,
    clamp, formatCount, formatVph, formatMultiple, formatPercent, relativeTime, hoursSince,
    computeScore, computeMetrics, viralTier, tierLabel,
    searchItems, filterItems, sortItems, visibleItems,
    median, channelBaseline, BASIS_LABEL,
    parseVideoUrl, parseISODuration, guessCategory,
    parseCsv, parseCsvBuiltin, normalizeNumber, csvToItems, coverLines,
    useStats, statsEngine, multiplesOf, distributionOf, zScoreOf,
    csvEscape, toCsv, boardRows, toBoardCsv, toRadarCsv,
    normalizeStatus, nextStatus, prevStatus, boardGroups,
    hookLibrary, hookStats, buildHookAnalysis, buildScript, buildPrompt,
    psychSourceText, psychProfile, psychInputFor, psychFramework, psychRewrite,
    frameworkText, psychFrameworkText, buildBridgePrompt, scriptMeta,
    PSY_AUDIENCE, PSY_PROBLEM, PSY_SOLUTION,
    youtubeVideoId, youtubeThumbUrl, youtubeThumbUrls, ytdlpCommand,
    packFilename, packStamp, buildReferencePack, PACK_NOTE,
    countChars,
    quotaDateKey, bumpQuota, summarize, itemTitle, isPending,
  };
});
