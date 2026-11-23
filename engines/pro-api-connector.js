/* ============================================================
   pro-api-connector.js  ·  공용 Pro API·서버 연결 엔진  v1.1.0
   ------------------------------------------------------------
   의존성 없는 순수 JS(UMD). 브라우저에서는 window.ProConnector,
   node 에서는 require('./pro-api-connector.js') 로 쓴다.

   한 줄 원칙
   - 연결이 없으면 조용히 무료 모드로 돌려준다(에러를 던지지 않는다).
   - 연결하면 내가 고른 유료 API 로 브라우저에서 직접 요청한다.
     중간 서버는 없다. 키는 이 브라우저 밖으로 나가지 않는다.

   제공 기능
   1) 프로바이더 4종 + 무료 폴백
      OpenAI(1) → Google Gemini(2) → Anthropic Claude(3) → 자체 서버(4)
      · 텍스트 / 이미지 / 음성(TTS) 요청 계획·응답 파싱을 프로바이더별로 내장
      · 미연결 시 { mode:'free', ok:false, reason:'not_connected' }
   2) 보안 저장
      · 기본 sessionStorage(탭 닫으면 삭제) · '이 브라우저에 기억' 시에만 localStorage
      · 원클릭 연결 해제·키 삭제, 키 마스킹, 오류 문구에서 키 자동 가리기
   3) 공용 UI
      · renderBadge(): 무료 모드 ↔ Pro 연결됨 · OpenAI
      · mountModal(): 프로바이더 탭 4종(고정 순서)·연결 테스트·저장 방식·비용/개인정보 안내
      · 앱 CSS 변수(--bg/--surface/--ink/--accent)에 맞춰 스스로 물드는 스코프 CSS
   4) 고품질 프롬프트 빌더
      · buildProPrompt('blog'|'commerce'|'cardnews'|'reviewReply'|'shortform'|'image')
      · AI 티 제거·구어체·표시광고법/의료법 회피·JSON 구조화 규칙 내장
   5) 무료 AI 맛보기 서버 (v1.1.0)
      · generateFree() — 키 없이 https://free-ai-taste.goodday810202.workers.dev/v1/generate
      · 503 all_providers_busy 는 1회 자동 재시도
      · 429 free_quota_exceeded 등은 한국어 소진 안내 + '무료 Gemini 키 / 구독 AI 브리지' 전환 카드
      · 자체 서버에 같은 주소를 넣으면 기존 모달만으로도 동작
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.ProConnector = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var VERSION = '1.1.0';
  var STORAGE_KEY = 'proconnector.config.v1';
  var EVENT_NAME = 'proconnector:change';

  /* 무료 AI 맛보기(Cloudflare Worker) — 키 없이 몇 번 써 보고 Pro 로 넘기는 경로 */
  var FREE_TASTE_HOST = 'free-ai-taste.goodday810202.workers.dev';
  var FREE_TASTE_ENDPOINT = 'https://' + FREE_TASTE_HOST + '/v1/generate';
  var FREE_TASTE_PROMPT_LIMIT = 2000;
  var FREE_TASTE_TIMEOUT = 45000;
  var VISITOR_KEY = 'proconnector.visitor.v1';
  var FREE_KEY_URL = 'https://aistudio.google.com/apikey';

  /* ==========================================================
     0. 공통 유틸
     ========================================================== */

  function str(v) {
    if (v === null || v === undefined) return '';
    return String(v);
  }

  function trim(v) { return str(v).replace(/^\s+|\s+$/g, ''); }

  function now() { return Date.now(); }

  function isArr(v) { return Object.prototype.toString.call(v) === '[object Array]'; }

  function has(obj, key) {
    return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
  }

  function clone(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    var out = isArr(obj) ? [] : {};
    for (var k in obj) if (has(obj, k)) out[k] = clone(obj[k]);
    return out;
  }

  function firstOf() {
    for (var i = 0; i < arguments.length; i++) {
      var v = arguments[i];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return '';
  }

  function truncate(s, n) {
    var t = str(s);
    return t.length > n ? t.slice(0, n) + '…' : t;
  }

  /** 키를 화면·로그에 보여야 할 때. 앞자리는 절대 남기지 않는다. */
  function maskKey(key) {
    var k = trim(key);
    if (!k) return '';
    if (k.length <= 8) return '••••';
    return '••••' + k.slice(-4);
  }

  /** 오류 문구에 키가 섞여 나와도 그대로 두지 않는다. */
  function redact(text, secrets) {
    var out = str(text);
    for (var i = 0; i < (secrets || []).length; i++) {
      var s = trim(secrets[i]);
      if (s && s.length >= 6) out = out.split(s).join('••••');
    }
    return out;
  }

  /** 무료 맛보기 주소인지. 경로가 없거나 /v1/generate 면 같은 서버로 본다. */
  function isFreeTasteEndpoint(u) {
    var s = trim(u);
    if (!s) return false;
    var m = /^https?:\/\/([^\/?#]+)([^?#]*)/i.exec(s);
    if (!m) return false;
    var host = m[1].toLowerCase().replace(/:\d+$/, '');
    if (host !== FREE_TASTE_HOST) return false;
    var path = m[2] || '';
    if (!path || path === '/') return true;
    return path.indexOf('/v1/generate') === 0;
  }

  function isFreeTasteConfig(cfg) {
    return !!cfg && cfg.provider === 'custom' && isFreeTasteEndpoint(cfg.endpointUrl);
  }

  /**
   * 브라우저가 한 번 만드는 무작위 체험 ID.
   * 서버는 이 값을 '기기'로 세므로 같은 와이파이의 가족과 횟수를 나눠 쓰지 않는다.
   * 계정·기기 지문과 무관하고, 저장소를 지우면 새로 생긴다.
   */
  function freeVisitorId() {
    try {
      var ls = root.localStorage;
      if (!ls) return '';
      var saved = trim(ls.getItem(VISITOR_KEY));
      if (saved && /^[A-Za-z0-9_-]{8,64}$/.test(saved)) return saved;
      var made = '';
      if (root.crypto && typeof root.crypto.randomUUID === 'function') {
        made = root.crypto.randomUUID().replace(/-/g, '');
      } else {
        made = 'v' + now().toString(36) + Math.random().toString(36).slice(2, 12);
      }
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(made)) made = 'v' + now().toString(36);
      ls.setItem(VISITOR_KEY, made);
      return made;
    } catch (e) { return ''; }
  }

  function dataUrl(mime, b64) {
    if (!b64) return '';
    return 'data:' + (mime || 'application/octet-stream') + ';base64,' + b64;
  }

  function bytesToBase64(bytes) {
    var bin = '';
    var chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    if (typeof root.btoa === 'function') return root.btoa(bin);
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
    return '';
  }

  function base64ToBytes(b64) {
    var clean = str(b64).replace(/^data:[^,]*,/, '').replace(/\s/g, '');
    if (typeof root.atob === 'function') {
      var bin = root.atob(clean);
      var out = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(clean, 'base64'));
    return new Uint8Array(0);
  }

  /* ==========================================================
     1. 프로바이더 정의
     ----------------------------------------------------------
     표시 순서는 고정이다. 대중적인 공식 API 상위 3개가 1·2·3순위,
     자체 서버가 4순위. 모달·드롭다운·라디오 모두 이 배열 순서를 쓴다.
     ========================================================== */

  var PROVIDERS = [
    {
      id: 'openai',
      rank: 1,
      name: 'OpenAI',
      brand: 'GPT · 이미지 · TTS',
      tag: '가장 대중적',
      keyLabel: 'OpenAI API 키',
      keyPlaceholder: 'API 키 붙여넣기',
      keyUrl: 'https://platform.openai.com/api-keys',
      keyNote: 'ChatGPT Plus 구독과는 별개입니다. 결제 수단을 등록한 API 크레딧이 필요합니다.',
      badgeLabel: 'OpenAI',
      tasks: { text: true, image: true, tts: true },
      models: {
        text: [
          { id: 'gpt-4o-mini', label: 'gpt-4o-mini', note: '빠르고 저렴 · 기본값' },
          { id: 'gpt-4o', label: 'gpt-4o', note: '품질 우선' }
        ],
        image: [
          { id: 'gpt-image-1', label: 'gpt-image-1', note: '최신 이미지 모델 · 기본값' },
          { id: 'dall-e-3', label: 'dall-e-3', note: '구형·저렴' }
        ],
        tts: [
          { id: 'tts-1', label: 'tts-1', note: '빠름 · 기본값' },
          { id: 'tts-1-hd', label: 'tts-1-hd', note: '고음질' }
        ]
      },
      defaults: { text: 'gpt-4o-mini', image: 'gpt-image-1', tts: 'tts-1' }
    },
    {
      id: 'gemini',
      rank: 2,
      name: 'Google Gemini',
      brand: 'Gemini · Imagen · TTS',
      tag: '무료 키 지원',
      keyLabel: 'Google AI Studio API 키',
      keyPlaceholder: 'API 키 붙여넣기',
      keyUrl: 'https://aistudio.google.com/apikey',
      keyNote: 'Google AI Studio에서 무료로 발급받은 키로도 바로 쓸 수 있습니다. 무료 한도 안에서는 요금이 0원입니다.',
      badgeLabel: 'Gemini',
      tasks: { text: true, image: true, tts: true },
      models: {
        text: [
          { id: 'gemini-2.5-flash', label: 'gemini-2.5-flash', note: '빠르고 무료 한도 넉넉 · 기본값' },
          { id: 'gemini-2.5-pro', label: 'gemini-2.5-pro', note: '품질 우선' }
        ],
        image: [
          { id: 'imagen-3.0-generate-002', label: 'imagen-3.0-generate-002', note: 'Imagen · 기본값' },
          { id: 'gemini-2.5-flash-image', label: 'gemini-2.5-flash-image', note: 'Gemini 이미지 생성' }
        ],
        tts: [
          { id: 'gemini-2.5-flash-preview-tts', label: 'gemini-2.5-flash-preview-tts', note: '한국어 음성 지원' }
        ]
      },
      defaults: { text: 'gemini-2.5-flash', image: 'imagen-3.0-generate-002', tts: 'gemini-2.5-flash-preview-tts' }
    },
    {
      id: 'anthropic',
      rank: 3,
      name: 'Anthropic Claude',
      brand: 'Claude',
      tag: '긴 글 강점',
      keyLabel: 'Anthropic API 키',
      keyPlaceholder: 'API 키 붙여넣기',
      keyUrl: 'https://console.anthropic.com/settings/keys',
      keyNote: '텍스트 전용입니다. 이미지·음성은 OpenAI나 Gemini를 연결하세요.',
      badgeLabel: 'Claude',
      tasks: { text: true, image: false, tts: false },
      models: {
        text: [
          { id: 'claude-sonnet-4-20250514', label: 'claude-sonnet-4-20250514', note: '최신 Sonnet · 기본값' },
          { id: 'claude-3-5-sonnet-latest', label: 'claude-3-5-sonnet-latest', note: '이전 세대 Sonnet' }
        ],
        image: [],
        tts: []
      },
      defaults: { text: 'claude-sonnet-4-20250514', image: '', tts: '' }
    },
    {
      id: 'custom',
      rank: 4,
      name: '자체 API 서버',
      brand: '프록시 · B2B',
      tag: '내 서버 · 무료 체험',
      keyLabel: '서버 인증 토큰 (선택)',
      keyPlaceholder: 'Bearer 토큰 (선택)',
      keyUrl: '',
      keyNote: 'Cloudflare Workers 같은 프록시에 키를 숨기고 앱은 내 서버만 호출합니다. 아래 버튼을 누르면 무료 맛보기 서버가 채워집니다(키 없음).',
      badgeLabel: '자체 서버',
      presetEndpoint: FREE_TASTE_ENDPOINT,
      tasks: { text: true, image: true, tts: true },
      models: { text: [], image: [], tts: [] },
      defaults: { text: '', image: '', tts: '' }
    }
  ];

  var PROVIDER_BY_ID = {};
  for (var pi = 0; pi < PROVIDERS.length; pi++) PROVIDER_BY_ID[PROVIDERS[pi].id] = PROVIDERS[pi];

  var TASK_IDS = ['text', 'image', 'tts'];

  var TASK_LABELS = { text: '글쓰기', image: '이미지', tts: '음성(TTS)' };

  function listProviders() {
    var out = [];
    for (var i = 0; i < PROVIDERS.length; i++) {
      var p = PROVIDERS[i];
      out.push({
        id: p.id, rank: p.rank, name: p.name, brand: p.brand, tag: p.tag,
        badgeLabel: p.badgeLabel, keyUrl: p.keyUrl, keyNote: p.keyNote,
        keyPlaceholder: p.keyPlaceholder,
        presetEndpoint: p.presetEndpoint || '',
        tasks: { text: !!p.tasks.text, image: !!p.tasks.image, tts: !!p.tasks.tts },
        models: clone(p.models), defaults: clone(p.defaults)
      });
    }
    return out;
  }

  function providerById(id) { return PROVIDER_BY_ID[trim(id)] || null; }

  function normalizeTask(task) {
    var t = trim(task).toLowerCase();
    return TASK_IDS.indexOf(t) >= 0 ? t : '';
  }

  function normalizeProviderId(id) {
    var p = providerById(id);
    return p ? p.id : '';
  }

  function defaultModel(providerId, task) {
    var p = providerById(providerId);
    if (!p) return '';
    return p.defaults[normalizeTask(task)] || '';
  }

  /* ==========================================================
     2. 저장 계층
     ----------------------------------------------------------
     기본은 sessionStorage. remember=true 일 때만 localStorage.
     저장소가 막힌 브라우저(시크릿·file://)에서는 메모리로 떨어지고
     persisted:false 로 알려 준다. 어느 경우에도 조용히 실패하지 않는다.
     ========================================================== */

  var memorySession = {};

  function storageOf(kind) {
    try {
      var s = root[kind];
      if (s && typeof s.getItem === 'function' && typeof s.setItem === 'function') return s;
    } catch (e) { /* 접근 차단 */ }
    return null;
  }

  function readRaw(kind) {
    var s = storageOf(kind);
    if (!s) return kind === 'sessionStorage' ? (memorySession[STORAGE_KEY] || null) : null;
    try { return s.getItem(STORAGE_KEY); } catch (e) { return null; }
  }

  function writeRaw(kind, value) {
    var s = storageOf(kind);
    if (!s) {
      if (kind === 'sessionStorage') {
        if (value === null) delete memorySession[STORAGE_KEY];
        else memorySession[STORAGE_KEY] = value;
        return true;
      }
      return false;
    }
    try {
      if (value === null) s.removeItem(STORAGE_KEY);
      else s.setItem(STORAGE_KEY, value);
      return true;
    } catch (e) { return false; }
  }

  function parseStored(raw) {
    if (!raw) return null;
    var obj;
    try { obj = JSON.parse(raw); } catch (e) { return null; }
    if (!obj || typeof obj !== 'object') return null;
    var pid = normalizeProviderId(obj.provider);
    if (!pid) return null;
    var cfg = {
      v: 1,
      provider: pid,
      apiKey: trim(obj.apiKey),
      endpointUrl: trim(obj.endpointUrl),
      bearerToken: trim(obj.bearerToken),
      models: {
        text: trim(obj.models && obj.models.text) || trim(obj.model),
        image: trim(obj.models && obj.models.image),
        tts: trim(obj.models && obj.models.tts)
      },
      remember: !!obj.remember,
      savedAt: Number(obj.savedAt) || 0
    };
    if (!cfg.models.text) cfg.models.text = defaultModel(pid, 'text');
    if (!cfg.models.image) cfg.models.image = defaultModel(pid, 'image');
    if (!cfg.models.tts) cfg.models.tts = defaultModel(pid, 'tts');
    return cfg;
  }

  function loadConfig() {
    var fromSession = parseStored(readRaw('sessionStorage'));
    if (fromSession) return fromSession;
    // 기억 저장소는 읽기만 한다. 세션에 복사하면 “기억”과 “이 탭에서만”의 경계가 무너진다.
    return parseStored(readRaw('localStorage'));
  }

  function isConnectedConfig(cfg) {
    if (!cfg || !cfg.provider) return false;
    var p = providerById(cfg.provider);
    if (!p) return false;
    if (p.id === 'custom') return !!isHttpUrl(cfg.endpointUrl);
    return trim(cfg.apiKey).length >= 8;
  }

  function isHttpUrl(u) {
    var s = trim(u);
    if (!s || /\s/.test(s)) return false;
    return /^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(s);
  }

  /** 공개 상태 — 키는 절대 담지 않는다. */
  function publicState(cfg) {
    var c = cfg === undefined ? loadConfig() : cfg;
    var connected = isConnectedConfig(c);
    var p = connected ? providerById(c.provider) : null;
    var host = '';
    if (connected && p.id === 'custom') {
      var m = /^https?:\/\/([^/?#]+)/i.exec(trim(c.endpointUrl));
      host = m ? m[1] : '';
    }
    return {
      version: VERSION,
      connected: connected,
      mode: connected ? 'pro' : 'free',
      provider: connected ? p.id : null,
      providerName: connected ? p.name : '',
      badgeLabel: connected ? p.badgeLabel : '무료 모드',
      model: connected ? (c.models.text || defaultModel(p.id, 'text')) : '',
      models: connected ? clone(c.models) : { text: '', image: '', tts: '' },
      endpointHost: host,
      remember: connected ? !!c.remember : false,
      savedAt: connected ? c.savedAt : 0,
      keyMasked: connected && p.id !== 'custom' ? maskKey(c.apiKey) : '',
      hasKey: !!(connected && (c.apiKey || (p.id === 'custom' && c.endpointUrl)))
    };
  }

  function getState() { return publicState(); }

  function isConnected(cfg) {
    return isConnectedConfig(arguments.length ? cfg : loadConfig());
  }

  /* ── 구독 ─────────────────────────────────────────────── */
  var subscribers = [];

  function subscribe(fn) {
    if (typeof fn !== 'function') return function () {};
    subscribers.push(fn);
    return function () {
      var i = subscribers.indexOf(fn);
      if (i >= 0) subscribers.splice(i, 1);
    };
  }

  function emitChange(state) {
    var s = state || getState();
    for (var i = 0; i < subscribers.length; i++) {
      try { subscribers[i](s); } catch (e) { /* 구독자 오류가 엔진을 죽이지 않게 */ }
    }
    try {
      var doc = root.document;
      if (doc && typeof root.CustomEvent === 'function') {
        doc.dispatchEvent(new root.CustomEvent(EVENT_NAME, { detail: s }));
      }
    } catch (e) { /* ignore */ }
  }

  /* ── 설정 검증·저장 ───────────────────────────────────── */
  function normalizeConfigInput(input) {
    var src = input || {};
    var pid = normalizeProviderId(src.provider) || 'openai';
    var p = providerById(pid);
    var models = {
      text: trim(src.models && src.models.text) || trim(src.model) || defaultModel(pid, 'text'),
      image: trim(src.models && src.models.image) || defaultModel(pid, 'image'),
      tts: trim(src.models && src.models.tts) || defaultModel(pid, 'tts')
    };
    return {
      provider: pid,
      apiKey: trim(src.apiKey),
      endpointUrl: trim(src.endpointUrl),
      bearerToken: trim(src.bearerToken),
      models: models,
      remember: !!src.remember,
      savedAt: 0
    };
  }

  function validateConfig(cfg, opts) {
    var errors = [];
    var p = providerById(cfg.provider);
    if (!p) errors.push('지원하지 않는 프로바이더입니다.');
    if (p && p.id === 'custom') {
      if (!cfg.endpointUrl) errors.push('자체 서버 주소(https://…)를 입력하세요.');
      else if (!isHttpUrl(cfg.endpointUrl)) errors.push('서버 주소는 http(s)://로 시작하는 전체 URL이어야 합니다.');
    }
    if (p && p.id !== 'custom') {
      var key = cfg.apiKey;
      if (!key) {
        if (!(opts && opts.allowStoredKey)) errors.push(p.keyLabel + '를 입력하세요.');
      } else if (/^bearer\s/i.test(key)) {
        errors.push('“Bearer”를 빼고 키 값만 붙여넣으세요.');
      } else if (key.length < 8) {
        errors.push('키가 너무 짧습니다. 전체 키를 붙여넣었는지 확인하세요.');
      } else if (/\s/.test(key)) {
        errors.push('키에 공백이 있습니다. 한 번에 복사해 붙여넣어 주세요.');
      }
    }
    if (p && cfg.bearerToken && /\s{2,}/.test(cfg.bearerToken)) {
      errors.push('서버 토큰에 연속 공백이 있습니다.');
    }
    if (p && cfg.apiKey && p.id !== 'custom' && /\s/.test(cfg.apiKey)) {
      errors.push('키에 공백이 있습니다.');
    }
    return { ok: errors.length === 0, errors: errors };
  }

  function saveConfig(input) {
    if (input && trim(input.provider) && !normalizeProviderId(input.provider)) {
      return { ok: false, errors: ['지원하지 않는 프로바이더입니다.'], state: publicState(null) };
    }
    var cfg = normalizeConfigInput(input);
    var stored = loadConfig();
    // 키를 다시 붙여넣지 않아도, 같은 프로바이더의 저장된 키를 그대로 이어 쓴다.
    if (stored && stored.provider === cfg.provider) {
      if (cfg.provider !== 'custom' && !cfg.apiKey && stored.apiKey) cfg.apiKey = stored.apiKey;
      if (cfg.provider === 'custom') {
        if (!cfg.endpointUrl && stored.endpointUrl) cfg.endpointUrl = stored.endpointUrl;
        if (!cfg.bearerToken && stored.bearerToken) cfg.bearerToken = stored.bearerToken;
      }
    }
    var v = validateConfig(cfg, { allowStoredKey: false });
    if (!v.ok) return { ok: false, errors: v.errors, state: publicState(null) };

    cfg.savedAt = now();
    var json = JSON.stringify(cfg);
    var persisted = true;
    if (cfg.remember) {
      persisted = writeRaw('localStorage', json);
      if (persisted) {
        writeRaw('sessionStorage', null);
      } else {
        // 기억 저장이 막힌 브라우저에서는 이번 탭에라도 유지한다.
        cfg.remember = false;
        json = JSON.stringify(cfg);
        writeRaw('sessionStorage', json);
      }
    } else {
      persisted = writeRaw('sessionStorage', json);
      writeRaw('localStorage', null);
    }
    var state = publicState(cfg);
    emitChange(state);
    var res = { ok: true, errors: [], state: state, persisted: persisted };
    if (!persisted) {
      res.warning = '브라우저 저장소를 쓸 수 없어 이번 탭에만 유지됩니다.';
    }
    return res;
  }

  function clearConfig() {
    writeRaw('sessionStorage', null);
    writeRaw('localStorage', null);
    var state = publicState(null);
    emitChange(state);
    return { ok: true, state: state };
  }

  /* ==========================================================
     3. 요청 계획 (순수 함수 — 네트워크 없이 검증 가능)
     ========================================================== */

  function baseHeaders() {
    return { 'Content-Type': 'application/json' };
  }

  function pickModel(providerId, task, payload, cfg) {
    var t = normalizeTask(task);
    var explicit = trim(payload && payload.model) ||
      trim(payload && payload.options && payload.options.model);
    if (explicit) return explicit;
    var c = cfg || {};
    if (c.models && trim(c.models[t])) return trim(c.models[t]);
    if (t === 'text' && trim(c.model)) return trim(c.model);
    return defaultModel(providerId, t);
  }

  /**
   * buildRequest(providerId, task, payload, cfg)
   * payload: { prompt, system, options }
   * 반환: { provider, task, url, method, headers, body, model, init }
   * 지원하지 않는 조합은 throw 대신 null.
   */
  function buildRequest(providerId, task, payload, cfg) {
    var pid = normalizeProviderId(providerId);
    var t = normalizeTask(task);
    var p = providerById(pid);
    if (!p || !t || !p.tasks[t]) return null;

    var pay = payload || {};
    var options = pay.options || {};
    var prompt = str(pay.prompt);
    var system = str(pay.system);
    var model = pickModel(pid, t, pay, cfg);
    var c = cfg || {};
    var req = {
      provider: pid, task: t, method: 'POST', model: model,
      headers: baseHeaders(), body: null, url: ''
    };

    if (pid === 'openai') {
      req.headers.Authorization = 'Bearer ' + trim(c.apiKey);
      if (t === 'text') {
        var messages = [];
        if (system) messages.push({ role: 'system', content: system });
        messages.push({ role: 'user', content: prompt });
        req.url = 'https://api.openai.com/v1/chat/completions';
        req.body = {
          model: model,
          messages: messages,
          temperature: numberOr(options.temperature, 0.7),
          max_tokens: intOr(options.maxTokens, 2200)
        };
        if (options.json) req.body.response_format = { type: 'json_object' };
      } else if (t === 'image') {
        req.url = 'https://api.openai.com/v1/images/generations';
        req.body = {
          model: model,
          prompt: prompt,
          n: intOr(options.n, 1),
          size: trim(options.size) || '1024x1024'
        };
        if (trim(options.quality)) req.body.quality = trim(options.quality);
        // gpt-image-1 은 b64_json 기본, dall-e-3 는 URL 대신 b64 로 받아야 만료가 없다.
        if (model !== 'gpt-image-1') req.body.response_format = 'b64_json';
      } else if (t === 'tts') {
        req.url = 'https://api.openai.com/v1/audio/speech';
        req.body = {
          model: model,
          input: truncate(prompt, 4000),
          voice: trim(options.voice) || 'alloy',
          response_format: trim(options.format) || 'mp3'
        };
        if (options.speed !== undefined) req.body.speed = numberOr(options.speed, 1);
      }
    } else if (pid === 'anthropic') {
      req.url = 'https://api.anthropic.com/v1/messages';
      req.headers['x-api-key'] = trim(c.apiKey);
      req.headers['anthropic-version'] = '2023-06-01';
      // 브라우저에서 직접 호출하려면 Anthropic 이 요구하는 헤더.
      req.headers['anthropic-dangerous-direct-browser-access'] = 'true';
      req.body = {
        model: model,
        max_tokens: intOr(options.maxTokens, 2400),
        messages: [{ role: 'user', content: prompt }]
      };
      if (system) req.body.system = system;
      if (options.temperature !== undefined) req.body.temperature = numberOr(options.temperature, 0.7);
    } else if (pid === 'gemini') {
      var gbase = 'https://generativelanguage.googleapis.com/v1beta/models/';
      req.headers['x-goog-api-key'] = trim(c.apiKey);
      if (t === 'text') {
        req.url = gbase + encodeURIComponent(model) + ':generateContent';
        req.body = {
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: numberOr(options.temperature, 0.7),
            maxOutputTokens: intOr(options.maxTokens, 2400)
          }
        };
        if (system) req.body.systemInstruction = { parts: [{ text: system }] };
        if (options.json) req.body.generationConfig.responseMimeType = 'application/json';
      } else if (t === 'image') {
        if (/^imagen/i.test(model)) {
          req.url = gbase + encodeURIComponent(model) + ':predict';
          req.body = {
            instances: [{ prompt: prompt }],
            parameters: {
              sampleCount: intOr(options.n, 1),
              aspectRatio: trim(options.aspectRatio) || '1:1'
            }
          };
        } else {
          req.url = gbase + encodeURIComponent(model) + ':generateContent';
          req.body = {
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
          };
        }
      } else if (t === 'tts') {
        req.url = gbase + encodeURIComponent(model) + ':generateContent';
        req.body = {
          contents: [{ role: 'user', parts: [{ text: truncate(prompt, 3000) }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: trim(options.voice) || 'Kore' } }
            }
          }
        };
      }
    } else if (pid === 'custom') {
      req.url = trim(c.endpointUrl);
      if (trim(c.bearerToken)) {
        req.headers.Authorization = /^bearer\s/i.test(trim(c.bearerToken))
          ? trim(c.bearerToken)
          : 'Bearer ' + trim(c.bearerToken);
      }
      req.body = {
        task: t,
        prompt: prompt,
        system: system,
        options: clone(options)
      };
      if (model) req.body.model = model;
      var appName = trim(pay.app) || trim(c.app);
      if (appName) req.body.app = appName.replace(/[^A-Za-z0-9-]/g, '').slice(0, 32);
      // 무료 맛보기 서버는 '기기' 단위로 횟수를 세므로 방문자 ID 를 함께 보낸다.
      if (isFreeTasteEndpoint(req.url)) {
        var vid = freeVisitorId();
        if (vid) req.headers['x-free-ai-visitor'] = vid;
      }
    }

    if (!req.url || !req.body) return null;
    req.init = {
      method: 'POST',
      headers: req.headers,
      body: JSON.stringify(req.body)
    };
    return req;
  }

  function numberOr(v, fallback) {
    var n = Number(v);
    return isFinite(n) ? n : fallback;
  }

  function intOr(v, fallback) {
    var n = Math.round(Number(v));
    return isFinite(n) ? n : fallback;
  }

  /* ==========================================================
     4. 응답 파싱
     ========================================================== */

  function joinTexts(parts) {
    var out = [];
    for (var i = 0; i < (parts || []).length; i++) {
      var t = parts[i];
      if (typeof t === 'string') { if (trim(t)) out.push(trim(t)); continue; }
      if (t && typeof t.text === 'string' && trim(t.text)) out.push(trim(t.text));
    }
    return out.join('\n').replace(/^\s+|\s+$/g, '');
  }

  function usageOf(u) {
    if (!u || typeof u !== 'object') return null;
    return {
      input: numberOr(firstOf(u.input_tokens, u.prompt_tokens, u.promptTokenCount), 0),
      output: numberOr(firstOf(u.output_tokens, u.completion_tokens, u.candidatesTokenCount), 0)
    };
  }

  function imageFrom(item, mime) {
    if (!item) return null;
    if (typeof item === 'string') {
      if (/^https?:\/\//i.test(item) || /^data:image\//i.test(item)) return { url: item, mimeType: mime || '' };
      return { b64: item, mimeType: mime || 'image/png', dataUrl: dataUrl(mime || 'image/png', item) };
    }
    var b64 = firstOf(item.b64_json, item.b64, item.bytesBase64Encoded, item.base64, item.inlineData && item.inlineData.data);
    var url = firstOf(item.url, item.imageUrl, item.image_url, item.uri);
    var m = firstOf(item.mimeType, item.mime_type, item.inlineData && item.inlineData.mimeType, mime, 'image/png');
    if (b64) return { b64: b64, mimeType: m, dataUrl: dataUrl(m, b64) };
    if (url) return { url: url, mimeType: m };
    return null;
  }

  function audioFrom(b64, mime, format) {
    if (!b64) return null;
    var m = mime || 'audio/mpeg';
    return {
      base64: b64,
      mimeType: m,
      dataUrl: dataUrl(m, b64),
      format: format || (m.indexOf('wav') >= 0 ? 'wav' : (m.indexOf('mpeg') >= 0 || m.indexOf('mp3') >= 0 ? 'mp3' : '')),
      bytes: b64.length
    };
  }

  /** Gemini TTS 는 PCM(L16) 을 준다. 브라우저 <audio> 로 바로 재생되게 WAV 로 감싼다. */
  function pcm16ToWavBase64(pcmB64, sampleRate, channels) {
    var pcm = base64ToBytes(pcmB64);
    var rate = sampleRate || 24000;
    var ch = channels || 1;
    var dataLen = pcm.length;
    var buf = new Uint8Array(44 + dataLen);
    function writeStr(off, s) { for (var i = 0; i < s.length; i++) buf[off + i] = s.charCodeAt(i); }
    function writeU32(off, v) {
      buf[off] = v & 0xff; buf[off + 1] = (v >> 8) & 0xff;
      buf[off + 2] = (v >> 16) & 0xff; buf[off + 3] = (v >> 24) & 0xff;
    }
    function writeU16(off, v) { buf[off] = v & 0xff; buf[off + 1] = (v >> 8) & 0xff; }
    writeStr(0, 'RIFF');
    writeU32(4, 36 + dataLen);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    writeU32(16, 16);
    writeU16(20, 1);
    writeU16(22, ch);
    writeU32(24, rate);
    writeU32(28, rate * ch * 2);
    writeU16(32, ch * 2);
    writeU16(34, 16);
    writeStr(36, 'data');
    writeU32(40, dataLen);
    buf.set(pcm, 44);
    return bytesToBase64(buf);
  }

  function parsePcmMime(mime) {
    var m = str(mime);
    var rate = 24000, ch = 1;
    var rm = /rate=(\d+)/i.exec(m);
    if (rm) rate = Number(rm[1]) || 24000;
    var cm = /channels=(\d+)/i.exec(m);
    if (cm) ch = Number(cm[1]) || 1;
    return { rate: rate, channels: ch };
  }

  function errorMessageFrom(json) {
    if (!json) return '';
    if (typeof json === 'string') return truncate(json, 400);
    if (json.error) {
      if (typeof json.error === 'string') return truncate(json.error, 400);
      if (json.error.message) return truncate(json.error.message, 400);
    }
    if (json.message) return truncate(json.message, 400);
    if (json.promptFeedback && json.promptFeedback.blockReason) {
      return '요청이 차단되었습니다 (' + json.promptFeedback.blockReason + ')';
    }
    if (json.candidates && json.candidates[0] && json.candidates[0].finishReason) {
      return '응답이 중단되었습니다 (' + json.candidates[0].finishReason + ')';
    }
    return '';
  }

  /**
   * parseJson(providerId, task, json) → { ok, text?, image?, audio?, usage?, message? }
   * 모의 응답 단위 검증용으로 공개한다.
   */
  function parseJson(providerId, task, json) {
    var pid = normalizeProviderId(providerId);
    var t = normalizeTask(task);
    if (!json || typeof json !== 'object') {
      return { ok: false, reason: 'bad_response', message: '응답이 비어 있습니다.' };
    }

    if (pid === 'openai') {
      if (t === 'text') {
        var choice = json.choices && json.choices[0];
        var content = choice && choice.message ? choice.message.content : '';
        var text = isArr(content) ? joinTexts(content) : trim(content);
        if (!text) return { ok: false, reason: 'empty_response', message: errorMessageFrom(json) || '응답에 본문이 없습니다.' };
        return { ok: true, text: text, usage: usageOf(json.usage), finish: choice && choice.finish_reason };
      }
      if (t === 'image') {
        var img = imageFrom(json.data && json.data[0], 'image/png');
        if (!img) return { ok: false, reason: 'empty_response', message: errorMessageFrom(json) || '이미지 데이터가 없습니다.' };
        return { ok: true, image: img };
      }
    }

    if (pid === 'anthropic') {
      var blocks = json.content || [];
      var atext = joinTexts(blocks);
      if (!atext) return { ok: false, reason: 'empty_response', message: errorMessageFrom(json) || '응답에 본문이 없습니다.' };
      return { ok: true, text: atext, usage: usageOf(json.usage), stopReason: json.stop_reason };
    }

    if (pid === 'gemini') {
      var cand = json.candidates && json.candidates[0];
      if (cand) {
        var parts = (cand.content && cand.content.parts) || [];
        var texts = [], inline = null;
        for (var i = 0; i < parts.length; i++) {
          var part = parts[i] || {};
          if (typeof part.text === 'string' && trim(part.text)) texts.push(trim(part.text));
          if (part.inlineData && part.inlineData.data) inline = part.inlineData;
        }
        if (t === 'image') {
          if (inline) {
            var im = imageFrom({ inlineData: inline }, inline.mimeType || 'image/png');
            if (im) return { ok: true, image: im };
          }
          if (texts.length) {
            return { ok: true, image: null, text: texts.join('\n'), note: '이미지 대신 설명이 돌아왔습니다. 이미지 모델을 확인하세요.' };
          }
          return { ok: false, reason: 'empty_response', message: errorMessageFrom(json) || '이미지 데이터가 없습니다.' };
        }
        if (t === 'tts') {
          if (inline && inline.data) {
            var mime = inline.mimeType || 'audio/L16;codec=pcm;rate=24000';
            var pcm = inline.data;
            var pr = parsePcmMime(mime);
            var wav = pcm16ToWavBase64(pcm, pr.rate, pr.channels);
            return { ok: true, audio: audioFrom(wav, 'audio/wav', 'wav') };
          }
          return { ok: false, reason: 'empty_response', message: errorMessageFrom(json) || '음성 데이터가 없습니다.' };
        }
        var gtext = texts.join('\n');
        if (!gtext) return { ok: false, reason: 'empty_response', message: errorMessageFrom(json) || '응답에 본문이 없습니다.' };
        return { ok: true, text: gtext, usage: usageOf(json.usageMetadata), finish: cand.finishReason };
      }
      // Imagen 응답
      if (json.predictions && json.predictions.length) {
        var pim = imageFrom(json.predictions[0], 'image/png');
        if (pim) return { ok: true, image: pim };
      }
      return { ok: false, reason: 'empty_response', message: errorMessageFrom(json) || '응답을 해석하지 못했습니다.' };
    }

    if (pid === 'custom') {
      var src = json.data && typeof json.data === 'object' ? json.data : json;
      if (json.ok === false) {
        return { ok: false, reason: 'provider_error', message: errorMessageFrom(json) || '서버가 실패를 반환했습니다.' };
      }
      if (t === 'text') {
        var ctext = trim(firstOf(src.text, src.content, src.answer, src.output,
          typeof src.result === 'string' ? src.result : '',
          src.choices && src.choices[0] && src.choices[0].message && src.choices[0].message.content,
          src.candidates && src.candidates[0] && src.candidates[0].content &&
            joinTexts(src.candidates[0].content.parts)));
        if (!ctext) return { ok: false, reason: 'empty_response', message: errorMessageFrom(json) || '응답에 text 가 없습니다.' };
        return { ok: true, text: ctext, usage: usageOf(src.usage) };
      }
      if (t === 'image') {
        var isrc = src.image && typeof src.image === 'object' ? src.image : src;
        var cimg = imageFrom({
          b64_json: firstOf(isrc.b64, isrc.base64, isrc.b64_json),
          url: firstOf(isrc.imageUrl, isrc.url, isrc.image_url),
          mimeType: firstOf(isrc.mimeType, isrc.mime_type, 'image/png')
        }, 'image/png');
        if (cimg) return { ok: true, image: cimg };
        return { ok: false, reason: 'empty_response', message: errorMessageFrom(json) || '응답에 이미지가 없습니다.' };
      }
      if (t === 'tts') {
        var asrc = src.audio && typeof src.audio === 'object' ? src.audio : src;
        var ab64 = firstOf(asrc.b64, asrc.base64, asrc.audioB64);
        var aurl = firstOf(asrc.audioUrl, asrc.url);
        if (ab64) {
          var amime = firstOf(asrc.mimeType, asrc.mime_type, 'audio/mpeg');
          return { ok: true, audio: audioFrom(ab64, amime, asrc.format) };
        }
        if (aurl) return { ok: true, audio: { url: aurl, mimeType: '', dataUrl: '', format: '' } };
        return { ok: false, reason: 'empty_response', message: errorMessageFrom(json) || '응답에 음성이 없습니다.' };
      }
    }

    return { ok: false, reason: 'bad_response', message: '해석할 수 없는 응답 형식입니다.' };
  }

  /* ==========================================================
     5. 전송 계층
     ----------------------------------------------------------
     기본은 window.fetch. 데모·테스트는 setTransport() 로 갈아끼운다.
     transport(plan) → Response 유사 객체
       { ok, status, headers:{get(name)}, json(), text(), arrayBuffer() }
     ========================================================== */

  var customTransport = null;

  function setTransport(fn) {
    customTransport = typeof fn === 'function' ? fn : null;
    return !!customTransport;
  }

  function getTransport() { return customTransport; }

  function defaultTransport(plan) {
    if (typeof root.fetch !== 'function') {
      return Promise.reject(new Error('이 브라우저에서 fetch 를 쓸 수 없습니다.'));
    }
    return root.fetch(plan.url, plan.init);
  }

  function headerOf(res, name) {
    try {
      if (res && res.headers && typeof res.headers.get === 'function') return res.headers.get(name) || '';
    } catch (e) { /* ignore */ }
    return '';
  }

  function readText(res) {
    try {
      if (res && typeof res.text === 'function') return Promise.resolve(res.text());
      if (res && typeof res.json === 'function') {
        return Promise.resolve(res.json()).then(function (j) { return JSON.stringify(j); });
      }
    } catch (e) { /* ignore */ }
    return Promise.resolve('');
  }

  function readArrayBuffer(res) {
    try {
      if (res && typeof res.arrayBuffer === 'function') return Promise.resolve(res.arrayBuffer());
      if (res && typeof res.blob === 'function') {
        return Promise.resolve(res.blob()).then(function (b) {
          if (b && typeof b.arrayBuffer === 'function') return b.arrayBuffer();
          return new ArrayBuffer(0);
        });
      }
    } catch (e) { /* ignore */ }
    return Promise.resolve(new ArrayBuffer(0));
  }

  var DEFAULT_TIMEOUT = { text: 60000, image: 120000, tts: 90000 };

  function networkErrorResult(task) {
    return {
      mode: 'pro', ok: false, reason: 'network_error', task: task,
      message: '네트워크 오류로 연결하지 못했습니다. 주소·인터넷·CORS 설정을 확인하세요.'
    };
  }

  function safeSecrets(cfg) {
    return [cfg && cfg.apiKey, cfg && cfg.bearerToken];
  }

  function wait(ms) {
    return new Promise(function (resolve) {
      if (!(ms > 0)) { resolve(); return; }
      setTimeout(resolve, ms);
    });
  }

  /** 무료 체험 응답 헤더에서 남은 횟수를 꺼낸다. 없으면 null. */
  function freeQuotaFromHeaders(res) {
    var rem = headerOf(res, 'x-free-ai-remaining');
    if (rem === '') return null;
    return {
      remaining: numberOr(rem, 0),
      limit: numberOr(headerOf(res, 'x-free-ai-limit'), 0),
      resetAt: trim(headerOf(res, 'x-free-ai-reset')),
      engine: trim(headerOf(res, 'x-free-ai-provider')),
      degraded: trim(headerOf(res, 'x-free-ai-degraded')) === '1'
    };
  }

  /** 무료 체험 결과에 실제 엔진·남은 횟수를 붙인다. */
  function attachFreeMeta(result, res, json) {
    var q = freeQuotaFromHeaders(res);
    if (q) result.quota = q;
    var engine = trim(firstOf(json && json.provider, q && q.engine));
    if (engine) result.engine = engine;
    var used = trim(firstOf(json && json.model));
    if (used) result.engineModel = used;
    if (json && json.requestId) result.requestId = trim(json.requestId);
    return result;
  }

  /**
   * HTTP 오류를 사용자가 바로 이해하는 문장으로 바꾼다.
   * 무료 체험(free=true)일 때만 서버의 reason·cta 를 전환 안내로 해석한다.
   */
  function httpFailureInfo(status, json, bodyText, p, free) {
    var serverReason = trim(json && json.reason);
    var serverMsg = trim(json && json.message);
    var generic = errorMessageFrom(json) || truncate(trim(bodyText), 240) || ('HTTP ' + status);
    var out = { reason: 'http_error', message: generic, status: status };
    if (!free) return out;

    if (status === 429) {
      out.reason = serverReason || 'free_quota_exceeded';
      out.message = serverMsg || '오늘 무료 체험 횟수를 모두 쓰셨어요. 내 무료 Gemini 키를 연결하면 바로 이어서 쓸 수 있어요.';
      out.cta = (json && json.cta) || { kind: 'connect_key', label: '내 무료 키로 계속하기', provider: 'gemini', keyUrl: FREE_KEY_URL };
      out.alternatives = (json && isArr(json.alternatives)) ? json.alternatives : [
        { kind: 'subscription_bridge', label: '지금 쓰는 ChatGPT·Gemini 구독으로 이어서' },
        { kind: 'local', label: '내 PC의 Ollama에 연결 (무제한·무료)' }
      ];
      if (json && json.resetAt) out.resetAt = trim(json.resetAt);
      if (json && json.remaining !== undefined) out.remaining = numberOr(json.remaining, 0);
      if (json && json.limit !== undefined) out.limit = numberOr(json.limit, 0);
      if (json && json.retryAfter !== undefined) out.retryAfter = numberOr(json.retryAfter, 0);
      out.upgrade = true;
      return out;
    }

    if (status === 503) {
      if (serverReason === 'all_providers_busy') {
        out.reason = 'all_providers_busy';
        out.busy = true;
        out.message = '무료 체험 서버가 잠시 붐볐어요. 30초 뒤 다시 시도하거나, 내 무료 Gemini 키를 연결하면 바로 생성됩니다.';
        out.retryAfter = numberOr(json && json.retryAfter, 30);
        return out;
      }
      if (serverReason === 'free_taste_disabled') {
        out.reason = 'free_taste_disabled';
        out.message = '무료 체험을 잠시 닫았습니다. Pro API 를 연결하면 계속 쓸 수 있어요.';
        return out;
      }
      return out;
    }

    if (status === 403 && serverReason === 'origin_not_allowed') {
      out.reason = 'origin_not_allowed';
      out.message = '이 페이지 주소가 무료 체험 허용 목록에 없어요. Pro API 를 연결하면 어디서나 쓸 수 있습니다.';
      return out;
    }

    if (status === 413) {
      out.reason = serverReason || 'prompt_too_long';
      out.message = serverReason === 'body_too_large'
        ? '한 번에 보낼 수 있는 양을 넘었어요. 입력을 나눠 주세요.'
        : '무료 체험은 입력 2,000자까지입니다. Pro 를 연결하면 긴 요청도 한 번에 됩니다.';
      return out;
    }

    if (status === 501) {
      out.reason = 'unsupported_task';
      out.message = '무료 체험은 글쓰기만 됩니다. 이미지·음성은 Pro 를 연결하세요.';
      return out;
    }

    if (status === 400) {
      out.reason = serverReason || 'bad_request';
      out.message = serverMsg || '요청 형식이 올바르지 않습니다.';
      return out;
    }

    if (status === 500) {
      out.reason = 'internal_error';
      out.message = serverMsg || '무료 체험 서버에 일시적인 문제가 있었어요. 잠시 뒤 다시 시도해 주세요.';
      return out;
    }

    return out;
  }

  /** 한도 소진 결과를 화면 카드로 바꾼다. */
  function freeLimitCard(res) {
    var r = res || {};
    var href = r.cta && r.cta.keyUrl ? trim(r.cta.keyUrl) : FREE_KEY_URL;
    var label = r.cta && r.cta.label ? trim(r.cta.label) : '내 무료 Gemini 키로 계속하기';
    var secondary = [];
    var alts = isArr(r.alternatives) ? r.alternatives : [];
    for (var i = 0; i < alts.length; i++) {
      if (alts[i] && trim(alts[i].label)) secondary.push({ label: trim(alts[i].label), kind: trim(alts[i].kind) });
    }
    if (!secondary.length) {
      secondary = [
        { label: '지금 쓰는 ChatGPT·Gemini 구독으로 이어서', kind: 'subscription_bridge' },
        { label: '내 PC의 Ollama에 연결 (무제한·무료)', kind: 'local' }
      ];
    }
    return {
      title: '무료 체험을 다 쓰셨어요',
      body: trim(r.message) || '오늘 무료 체험 횟수를 모두 썼습니다.',
      primary: { label: label, href: href },
      secondary: secondary,
      resetAt: trim(r.resetAt)
    };
  }

  /**
   * generate({ task, prompt, system, options, model }, { config, timeoutMs, strict, transport })
   * - 절대 throw 하지 않는다(strict:true 제외).
   * - 미연결이면 { mode:'free', ok:false, reason:'not_connected' }.
   */
  function generate(request, opts) {
    opts = opts || {};
    var req = request || {};
    var task = normalizeTask(req.task);
    if (!task) {
      return Promise.resolve({
        mode: isConnected() ? 'pro' : 'free', ok: false, reason: 'unknown_task', task: '',
        message: 'task 는 text·image·tts 중 하나여야 합니다.'
      });
    }

    var cfg = opts.config ? normalizeConfigInput(opts.config) : loadConfig();
    if (opts.config && !opts.config.savedAt) cfg.savedAt = now();

    if (!isConnectedConfig(cfg)) {
      return Promise.resolve({
        mode: 'free', ok: false, reason: 'not_connected', task: task, provider: null,
        message: '무료 모드입니다. Pro API 를 연결하면 이 요청을 바로 생성합니다.'
      });
    }

    var p = providerById(cfg.provider);
    if (!p.tasks[task]) {
      return Promise.resolve({
        mode: 'pro', ok: false, reason: 'unsupported_task', task: task, provider: p.id,
        message: p.name + ' 은(는) ' + TASK_LABELS[task] + ' 생성을 지원하지 않습니다. OpenAI·Gemini·자체 서버를 연결하세요.'
      });
    }

    var plan;
    try {
      plan = buildRequest(p.id, task, req, cfg);
    } catch (e) {
      plan = null;
    }
    if (!plan) {
      return Promise.resolve({
        mode: 'pro', ok: false, reason: 'unsupported_task', task: task, provider: p.id,
        message: '이 조합으로는 요청을 만들 수 없습니다.'
      });
    }

    var timeoutMs = numberOr(opts.timeoutMs, DEFAULT_TIMEOUT[task] || 60000);
    var transport = typeof opts.transport === 'function' ? opts.transport : (customTransport || defaultTransport);
    var free = isFreeTasteConfig(cfg) || opts.free === true;
    var busyRetries = intOr(opts.busyRetries, free ? 1 : 0);
    if (busyRetries < 0) busyRetries = 0;
    if (busyRetries > 3) busyRetries = 3;
    var retryDelayMs = Math.max(0, numberOr(opts.busyRetryDelayMs, 1200));
    var t0 = now();
    var attemptNo = 0;

    function runOnce() {
      attemptNo += 1;
      var attemptStart = now();
      return new Promise(function (resolve) {
        var settled = false;
        var timer = null;
        var controller = null;

        function finish(result) {
          if (settled) return;
          settled = true;
          if (timer) { clearTimeout(timer); timer = null; }
          result.latencyMs = Math.max(0, now() - attemptStart);
          result.totalLatencyMs = Math.max(0, now() - t0);
          result.attempts = attemptNo;
          if (free) {
            // 무료 체험은 'Pro 연결'이 아니라 체험 경로다. 화면 분기는 mode 로 한다.
            result.mode = 'free';
            result.free = true;
            result.provider = 'free-taste';
            result.providerName = '무료 체험';
          }
          if (result.message) result.message = redact(result.message, safeSecrets(cfg));
          resolve(result);
        }

        function fail(reason, message, extra) {
          var out = { mode: 'pro', ok: false, reason: reason, task: task, provider: p.id, model: plan.model, message: message };
          if (extra) for (var k in extra) if (has(extra, k)) out[k] = extra[k];
          finish(out);
        }

        if (typeof root.AbortController === 'function' && !opts.noAbort) {
          try {
            controller = new root.AbortController();
            plan.init.signal = controller.signal;
          } catch (e) { controller = null; }
        }

        if (timeoutMs > 0) {
          timer = setTimeout(function () {
            if (controller) { try { controller.abort(); } catch (e) { /* ignore */ } }
            fail('timeout', '응답이 ' + Math.round(timeoutMs / 1000) + '초 안에 오지 않았습니다. 잠시 후 다시 시도하세요.');
          }, timeoutMs);
        }

        var pending;
        try {
          pending = transport(plan);
        } catch (e) {
          fail('network_error', networkErrorResult(task).message);
          return;
        }

        Promise.resolve(pending).then(function (res) {
          var status = res && typeof res.status === 'number' ? res.status : 200;
          var okFlag = res && res.ok === false ? false : (status >= 200 && status < 300);

          if (!okFlag) {
            readText(res).then(function (body) {
              var json = null;
              try { json = JSON.parse(body); } catch (e) { json = null; }
              var info = httpFailureInfo(status, json, body, p, free);
              var extra = { status: status };
              if (info.cta) extra.cta = info.cta;
              if (info.alternatives) extra.alternatives = info.alternatives;
              if (info.resetAt) extra.resetAt = info.resetAt;
              if (info.remaining !== undefined) extra.remaining = info.remaining;
              if (info.limit !== undefined) extra.limit = info.limit;
              if (info.retryAfter !== undefined) extra.retryAfter = info.retryAfter;
              if (info.upgrade) extra.upgrade = true;
              if (info.busy) extra._busy = true;
              fail(info.reason, info.message, extra);
            }, function () {
              fail('http_error', 'HTTP ' + status, { status: status });
            });
            return;
          }

          var ct = headerOf(res, 'content-type');
          var binary = task === 'tts' && (/^audio\//i.test(ct) || /octet-stream/i.test(ct) ||
            (p.id === 'openai' && !/json/i.test(ct)));

          if (binary) {
            readArrayBuffer(res).then(function (buf) {
              var bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf || 0);
              if (!bytes.length) { fail('empty_response', '음성 데이터가 비어 있습니다.'); return; }
              var mime = ct && /^audio\//i.test(ct) ? ct.split(';')[0] : 'audio/mpeg';
              var fmt = mime.indexOf('wav') >= 0 ? 'wav' : (mime.indexOf('mp3') >= 0 || mime.indexOf('mpeg') >= 0 ? 'mp3' : '');
              finish({
                mode: 'pro', ok: true, provider: p.id, model: plan.model, task: task,
                audio: {
                  base64: bytesToBase64(bytes), mimeType: mime, dataUrl: dataUrl(mime, bytesToBase64(bytes)),
                  format: fmt, bytes: bytes.length
                }
              });
            }, function () {
              fail('bad_response', '음성 응답을 읽지 못했습니다.');
            });
            return;
          }

          readText(res).then(function (body) {
            var json = null;
            try { json = JSON.parse(body); } catch (e) { json = null; }
            if (!json) {
              // JSON 이 아닌 순수 텍스트도 텍스트 답변으로 인정한다.
              if (task === 'text' && trim(body)) {
                var plain = { mode: 'pro', ok: true, provider: p.id, model: plan.model, task: task, text: trim(body) };
                if (free) attachFreeMeta(plain, res, null);
                finish(plain);
                return;
              }
              fail('bad_response', '응답을 해석하지 못했습니다. 서버 응답 형식을 확인하세요.');
              return;
            }
            var parsed = parseJson(p.id, task, json);
            if (!parsed.ok) {
              var reason = parsed.reason || 'provider_error';
              var out = { mode: 'pro', ok: false, reason: reason, task: task, provider: p.id, model: plan.model, status: status };
              if (parsed.message) out.message = parsed.message;
              finish(out);
              return;
            }
            var result = { mode: 'pro', ok: true, provider: p.id, model: plan.model, task: task };
            for (var k in parsed) if (has(parsed, k) && k !== 'ok') result[k] = parsed[k];
            if (free) attachFreeMeta(result, res, json);
            finish(result);
          }, function () {
            fail('bad_response', '응답 본문을 읽지 못했습니다.');
          });
        }, function (err) {
          var msg = err && err.message ? err.message : '';
          if (/abort/i.test(msg)) {
            fail('timeout', '요청이 중단되었습니다. 잠시 후 다시 시도하세요.');
            return;
          }
          fail('network_error', msg
            ? '요청을 보내지 못했습니다: ' + truncate(msg, 200)
            : networkErrorResult(task).message);
        });
      });
    }

    /* 503 all_providers_busy 만 1회 자동 재시도한다. 다른 오류는 바로 알린다. */
    function loop() {
      return runOnce().then(function (res) {
        var busy = !!res._busy;
        delete res._busy;
        if (res.ok || !busy || attemptNo > busyRetries) {
          if (busy) res.retried = attemptNo > 1;
          if (attemptNo > 1) res.retried = true;
          return res;
        }
        return wait(retryDelayMs).then(loop);
      });
    }

    return loop().then(function (res) {
      if (opts.strict && !res.ok) {
        var err = new Error(res.message || res.reason);
        err.result = res;
        throw err;
      }
      return res;
    });
  }

  function generateText(prompt, opts) {
    var o = opts || {};
    return generate({
      task: 'text', prompt: prompt, system: o.system, options: o.options, model: o.model
    }, o);
  }

  function generateImage(prompt, opts) {
    var o = opts || {};
    return generate({
      task: 'image', prompt: prompt, options: o.options, model: o.model
    }, o);
  }

  function generateTTS(text, opts) {
    var o = opts || {};
    return generate({
      task: 'tts', prompt: text, options: o.options, model: o.model
    }, o);
  }

  /**
   * generateFree({ task, prompt, system, options }, { app, transport, timeoutMs })
   * 키 없이 무료 체험 서버로 글을 생성한다. 저장된 설정과 무관하게 동작한다.
   * - 503 all_providers_busy 는 기본 1회 자동 재시도 (busyRetries, busyRetryDelayMs)
   * - 429 는 { reason, message, cta, alternatives, resetAt, upgrade:true }
   * - 결과는 mode:'free', provider:'free-taste', engine:'workersai'|'gemini'|'groq'
   */
  function generateFree(request, opts) {
    var o = opts || {};
    var req = request || {};
    var task = normalizeTask(req.task);
    var app = trim(o.app);
    if (!task) {
      return Promise.resolve({
        mode: 'free', free: true, ok: false, reason: 'unknown_task', task: '', provider: 'free-taste',
        message: 'task 는 text·image·tts 중 하나여야 합니다.'
      });
    }
    if (task !== 'text') {
      return Promise.resolve({
        mode: 'free', free: true, ok: false, reason: 'unsupported_task', task: task, provider: 'free-taste',
        message: '무료 체험은 글쓰기만 됩니다. 이미지·음성은 Pro 를 연결하세요.'
      });
    }
    var prompt = str(req.prompt);
    if (!trim(prompt)) {
      return Promise.resolve({
        mode: 'free', free: true, ok: false, reason: 'empty_prompt', task: task, provider: 'free-taste',
        message: '요청 내용이 비어 있습니다.'
      });
    }
    var truncated = false;
    if (prompt.length > FREE_TASTE_PROMPT_LIMIT) {
      if (!o.truncate) {
        return Promise.resolve({
          mode: 'free', free: true, ok: false, reason: 'prompt_too_long', task: task, provider: 'free-taste',
          limit: FREE_TASTE_PROMPT_LIMIT, length: prompt.length,
          message: '무료 체험은 입력 ' + FREE_TASTE_PROMPT_LIMIT.toLocaleString('ko-KR') + '자까지입니다(지금 ' +
            prompt.length.toLocaleString('ko-KR') + '자). Pro 를 연결하면 긴 요청도 한 번에 됩니다.'
        });
      }
      var note = '\n\n(무료 체험은 입력 ' + FREE_TASTE_PROMPT_LIMIT.toLocaleString('ko-KR') + '자 제한이라 뒷부분을 줄였습니다.)';
      prompt = prompt.slice(0, FREE_TASTE_PROMPT_LIMIT - note.length - 10) + note;
      truncated = true;
    }

    var cfg = { provider: 'custom', endpointUrl: FREE_TASTE_ENDPOINT, bearerToken: '', app: app, models: { text: '', image: '', tts: '' } };
    return generate({
      task: task, prompt: prompt, system: req.system, options: req.options, app: app
    }, {
      config: cfg,
      free: true,
      timeoutMs: numberOr(o.timeoutMs, FREE_TASTE_TIMEOUT),
      transport: o.transport,
      busyRetries: o.busyRetries === undefined ? 1 : o.busyRetries,
      busyRetryDelayMs: o.busyRetryDelayMs,
      noAbort: o.noAbort
    }).then(function (res) {
      if (truncated) res.truncated = true;
      return res;
    });
  }

  /** 지금 저장된 설정이 무료 체험 주소인지 — 화면 분기용 */
  function isFreeMode() {
    return isFreeTasteConfig(loadConfig());
  }

  /**
   * testConnection(formOrOpts)
   * 저장하지 않고 현재 입력값으로 짧은 텍스트 요청을 보낸다.
   * { config } 또는 { provider, apiKey, endpointUrl, bearerToken, model } 또는 빈 값(저장된 설정).
   */
  function testConnection(arg) {
    var o = arg || {};
    var cfg;
    if (o.config) cfg = normalizeConfigInput(o.config);
    else if (o.provider || o.apiKey || o.endpointUrl) cfg = normalizeConfigInput(o);
    else cfg = loadConfig();

    if (!isConnectedConfig(cfg)) {
      return Promise.resolve({
        ok: false, reason: 'not_connected', message: '연결 정보가 비어 있습니다. 키와 서버 주소를 확인하세요.'
      });
    }
    var p = providerById(cfg.provider);
    if (p.id !== 'custom' && !trim(cfg.apiKey) && !(cfg.remember && cfg.apiKey)) {
      return Promise.resolve({ ok: false, reason: 'not_connected', message: p.keyLabel + '가 비어 있습니다.' });
    }

    return generate({
      task: 'text',
      prompt: '연결 확인입니다. 다른 설명 없이 “연결됨”이라고만 답하세요.',
      system: '너는 API 연결 상태를 확인하는 도우미다. 한 단어로만 답한다.',
      options: { maxTokens: 16, temperature: 0 }
    }, { config: cfg, timeoutMs: o.timeoutMs || 25000, transport: o.transport, noAbort: true })
      .then(function (res) {
        if (res.ok) {
          return {
            ok: true, provider: p.id, providerName: p.name, model: res.model,
            latencyMs: res.latencyMs, sample: truncate(trim(res.text || ''), 40),
            message: p.name + ' 연결에 성공했습니다.' + (res.latencyMs ? ' (' + res.latencyMs + 'ms)' : '')
          };
        }
        return {
          ok: false, provider: p.id, providerName: p.name, reason: res.reason,
          status: res.status || 0, latencyMs: res.latencyMs || 0,
          message: res.message || '연결에 실패했습니다.'
        };
      });
  }

  /* ==========================================================
     6. 고품질 프롬프트 빌더
     ----------------------------------------------------------
     무료 모듈이 '뼈대'를 만들고, Pro 는 '완성 원고'를 만든다.
     두 모드의 결과가 같은 구조를 갖도록 JSON 스키마를 고정한다.
     ========================================================== */

  var SAFETY_RULES = [
    'AI 티를 완전히 뺀다. “~에 대해 알아보겠습니다”, “결론적으로”, “중요합니다”, “다양한”, “많은 분들이” 같은 번역체·설명체·상투어를 쓰지 않는다. 사람이 옆에서 말하듯 자연스러운 구어체로 쓴다.',
    '확인되지 않은 수치·후기·순위·인용·수상 이력·성분 함량을 절대 만들어 내지 않는다. 필요한 자리는 [확인 필요]로 남기고 사용자에게 확인을 요청한다.',
    '표시광고법을 지킨다. “최고”, “1위”, “완벽”, “무조건”, “부작용 없음” 같은 최상급·보증·단정 표현과 근거 없는 비교를 쓰지 않는다.',
    '의료·건강 제품이면 의료법을 지킨다. 질병의 예방·치료·완치를 단정하지 않고, “도움을 줄 수 있습니다” 수준으로 쓰며, 복용 전 전문가 상담 안내를 넣는다.',
    '과장 대신 구체로 쓴다. 형용사 대신 장면·행동·시간·조건을 적는다.',
    '문단은 2~4문장으로 끊고, 한 문단에 한 가지 주장만 담는다.',
    '같은 문장부호·같은 문장 길이를 반복하지 않는다. 사람은 다르게 쓴다.',
    '이모지·해시태그는 요청된 경우에만, 남용하지 않는다.'
  ];

  function rulesBlock() {
    var out = [];
    for (var i = 0; i < SAFETY_RULES.length; i++) out.push((i + 1) + '. ' + SAFETY_RULES[i]);
    return out.join('\n');
  }

  function toneLine(tone) {
    var t = trim(tone);
    if (!t) return '말투: 친근한 구어체. 존댓말이되 딱딱하지 않게, 실제로 말하듯.';
    return '말투: ' + t;
  }

  function inputLine(input, key, label, fallback) {
    var v = trim(input && input[key]);
    return '- ' + label + ': ' + (v || fallback || '(비어 있음)');
  }

  var PROMPT_KINDS = ['blog', 'commerce', 'cardnews', 'reviewReply', 'shortform', 'image'];

  function buildProPrompt(kind, input) {
    var k = trim(kind) || 'blog';
    if (PROMPT_KINDS.indexOf(k) < 0) k = 'generic';
    var inp = input || {};
    var tone = toneLine(inp.tone);
    var base = '너는 한국에서 실제로 돈을 받고 원고를 쓰는 실무 작가다. 읽는 사람은 광고 문구가 아니라 사람이 쓴 글을 기대한다.\n\n[지켜야 할 규칙]\n' + rulesBlock() + '\n\n' + tone;

    if (k === 'blog') {
      var system = base + '\n\n[이번 일]\n네이버 블로그에 올릴 완성 원고를 쓴다. 도입 3문장 안에 독자의 상황을 붙잡고, 소제목 4~5개로 나눠 실제 경험과 판단 기준을 담는다. 마지막은 다음 행동으로 닫는다. 결과는 설명 없이 JSON 하나로만 출력한다.';
      var prompt = [
        '[글 정보]',
        inputLine(inp, 'topic', '주제', '(주제 미입력 — 일반적인 뻔한 글 대신 구체적인 상황을 하나 골라라)'),
        inputLine(inp, 'target', '읽는 사람'),
        inputLine(inp, 'goal', '글의 목적'),
        inputLine(inp, 'experience', '내 경험 메모 (사실만, 이 내용을 중심으로)'),
        inputLine(inp, 'keywords', '넣고 싶은 키워드'),
        inputLine(inp, 'length', '분량', '1,800~2,400자'),
        '',
        '[출력 JSON]',
        '{',
        '  "titleCandidates": ["서로 다른 각도의 제목 5개"],',
        '  "metaDescription": "검색 결과에 보일 80~120자 요약",',
        '  "intro": "도입 3~4문장",',
        '  "sections": [{ "h2": "소제목", "paragraphs": ["문단1", "문단2"] }],',
        '  "photoGuide": [{ "afterSection": 1, "shot": "무엇을 어떻게 찍을지", "alt": "대체 텍스트" }],',
        '  "cta": "마지막 한 문단",',
        '  "hashtags": ["태그 5~8개"]',
        '}',
        '',
        '조건: 소제목은 4~5개. 각 소제목 아래 문단 2~3개. 경험 메모에 없는 사실을 지어내지 말 것. 경험 메모가 비어 있으면 [확인 필요] 표시를 남기고 사용자에게 물을 것. JSON 외의 텍스트를 출력하지 말 것.'
      ].join('\n');
      return {
        kind: k, label: '블로그 완성 원고', system: system, prompt: prompt,
        json: true, temperature: numberOr(inp.temperature, 0.8), maxTokens: 3200,
        schema: ['titleCandidates', 'metaDescription', 'intro', 'sections', 'photoGuide', 'cta', 'hashtags'],
        tips: ['경험 메모 2~3줄만 넣어도 결과가 완전히 달라집니다.', '제목 5개 중 1개를 골라 다시 다듬게 할 수 있습니다.']
      };
    }

    if (k === 'commerce') {
      var csystem = base + '\n\n[이번 일]\n상세페이지 세일즈 카피를 7단 설득 구조로 쓴다. 기능이 아니라 구매자가 겪는 장면과 결과를 쓴다. 근거 없는 순위·후기·할인율은 만들지 않는다. 결과는 JSON 하나로만 출력한다.';
      var cprompt = [
        '[상품 정보]',
        inputLine(inp, 'product', '상품명'),
        inputLine(inp, 'target', '구매자'),
        inputLine(inp, 'problem', '구매자가 겪는 불편'),
        inputLine(inp, 'benefit', '핵심 이득 (사실 기반)'),
        inputLine(inp, 'proof', '검증된 근거 (인증·실측·후기 수 등, 없으면 비움)'),
        inputLine(inp, 'price', '가격·구성'),
        inputLine(inp, 'objection', '구매 망설임'),
        '',
        '[7단 구조] 훅 → 문제 공감 → 원인 → 해결(상품) → 근거 → 망설임 제거(리스크 리버설) → 행동',
        '',
        '[출력 JSON]',
        '{',
        '  "headline": "한 줄 헤드라인",',
        '  "subheadline": "보조 한 줄",',
        '  "blocks": [{ "step": "hook|problem|cause|solution|proof|reversal|cta", "heading": "", "body": "", "bullet": ["", ""] }],',
        '  "specTable": [{ "label": "", "value": "" }],',
        '  "riskReversal": "환불·교환·보증 안내 문구(확인 필요 표시 가능)",',
        '  "faq": [{ "q": "", "a": "" }]',
        '}',
        '',
        '조건: blocks 는 7개, 순서 고정. proof 에 없는 수치를 만들지 말 것. 과장 최상급 금지. JSON 외 텍스트 금지.'
      ].join('\n');
      return {
        kind: k, label: '상세페이지 카피', system: csystem, prompt: cprompt,
        json: true, temperature: numberOr(inp.temperature, 0.75), maxTokens: 3000,
        schema: ['headline', 'subheadline', 'blocks', 'specTable', 'riskReversal', 'faq'],
        tips: ['구매 망설임을 한 줄이라도 적으면 전환 문구가 달라집니다.']
      };
    }

    if (k === 'cardnews') {
      var ksystem = base + '\n\n[이번 일]\n카드뉴스 6장을 설계한다. 첫 장은 3초 안에 멈추게 하는 한 문장, 마지막 장은 저장·공유를 부르는 한 문장. 카드당 글자 수를 지킨다. 결과는 JSON 하나로만 출력한다.';
      var kprompt = [
        '[주제]',
        inputLine(inp, 'topic', '주제'),
        inputLine(inp, 'target', '보는 사람'),
        inputLine(inp, 'point', '꼭 전달할 한 가지'),
        inputLine(inp, 'cta', '마지막에 할 행동'),
        '',
        '[출력 JSON]',
        '{',
        '  "cover": { "headline": "12자 내외", "sub": "20자 내외" },',
        '  "cards": [{ "no": 2, "headline": "18자 내외", "body": "40자 내외", "visual": "사진/도형 설명" }],',
        '  "last": { "headline": "행동 문장", "body": "한 줄" },',
        '  "caption": "인스타 캡션 3~5줄",',
        '  "hashtags": ["", ""]',
        '}',
        '',
        '조건: cards 는 2~5장(총 6장). 각 카드 headline 20자 이내, body 45자 이내. 한 카드에 한 메시지. JSON 외 텍스트 금지.'
      ].join('\n');
      return {
        kind: k, label: '카드뉴스 6장', system: ksystem, prompt: kprompt,
        json: true, temperature: numberOr(inp.temperature, 0.85), maxTokens: 1800,
        schema: ['cover', 'cards', 'last', 'caption', 'hashtags'],
        tips: ['카드 한 장에 메시지 두 개가 들어가면 아무것도 안 남습니다.']
      };
    }

    if (k === 'reviewReply') {
      var rsystem = base + '\n\n[이번 일]\n매장 리뷰에 답글을 쓴다. 변명하지 않고, 리뷰에 실제로 적힌 내용만 인정하고, 다음에 어떻게 달라질지 구체적으로 말한다. 3가지 톤(정중·친근·간결)으로 각각 쓴다. 결과는 JSON 하나로만 출력한다.';
      var rprompt = [
        '[리뷰]',
        inputLine(inp, 'review', '리뷰 원문'),
        inputLine(inp, 'store', '매장·브랜드'),
        inputLine(inp, 'facts', '실제로 확인된 사실 (주문·시간·조치)'),
        inputLine(inp, 'policy', '보상 가능 범위 (없으면 비움)'),
        '',
        '[출력 JSON]',
        '{',
        '  "detected": { "rating": 0, "issues": ["불만 핵심"], "emotion": "감정" },',
        '  "replies": [{ "tone": "정중|친근|간결", "text": "답글" }],',
        '  "privateNote": "공개 답글에 쓰면 안 되는 내부 메모",',
        '  "followUp": "다음에 할 일"',
        '}',
        '',
        '조건: 리뷰에 없는 사실을 인정하지 말 것. 보상은 policy 범위 안에서만. 사과는 한 번, 길게 늘이지 않는다. JSON 외 텍스트 금지.'
      ].join('\n');
      return {
        kind: k, label: '리뷰 답글', system: rsystem, prompt: rprompt,
        json: true, temperature: numberOr(inp.temperature, 0.6), maxTokens: 1400,
        schema: ['detected', 'replies', 'privateNote', 'followUp'],
        tips: ['확인된 사실을 적으면 답글이 훨씬 구체적이고 짧아집니다.']
      };
    }

    if (k === 'shortform') {
      var ssystem = base + '\n\n[이번 일]\n숏폼(30~60초) 대본을 쓴다. 첫 3초에 멈추게 하는 훅, 5~8개 비트, 마지막 행동 유도. 말하는 문장은 실제로 입에 붙는 짧은 구어체. 화면에 무엇이 보일지도 적는다. 결과는 JSON 하나로만 출력한다.';
      var sprompt = [
        '[영상 정보]',
        inputLine(inp, 'topic', '주제'),
        inputLine(inp, 'target', '보는 사람'),
        inputLine(inp, 'point', '핵심 한 가지'),
        inputLine(inp, 'length', '길이', '35~45초'),
        inputLine(inp, 'cta', '마지막 행동'),
        '',
        '[출력 JSON]',
        '{',
        '  "hook": { "line": "3초 훅", "onScreen": "첫 화면" },',
        '  "beats": [{ "t": "0-3s", "line": "말할 문장", "scene": "화면", "camera": "샷" }],',
        '  "cta": "마지막 문장",',
        '  "caption": "업로드 캡션",',
        '  "hashtags": ["", ""],',
        '  "ttsScript": "음성으로 읽을 전체 대본(자막 없이)"',
        '}',
        '',
        '조건: beats 는 5~8개, 시간 표기 필수. 한 비트에 한 문장. 읽었을 때 45초를 넘지 않게. JSON 외 텍스트 금지.'
      ].join('\n');
      return {
        kind: k, label: '숏폼 대본·장면', system: ssystem, prompt: sprompt,
        json: true, temperature: numberOr(inp.temperature, 0.9), maxTokens: 2200,
        schema: ['hook', 'beats', 'cta', 'caption', 'hashtags', 'ttsScript'],
        tips: ['ttsScript 를 그대로 음성 생성에 넣으면 자막과 음성이 어긋나지 않습니다.']
      };
    }

    if (k === 'image') {
      var isystem = base + '\n\n[이번 일]\n너는 이미지 생성 모델에 넣을 영어 프롬프트를 설계하는 아트 디렉터다. 인물·로고·브랜드명을 함부로 만들지 않고, 저작권·초상권 위험이 있는 유명인·캐릭터를 넣지 않는다. 결과는 영어 프롬프트 한 덩어리와 한국어 설명만 출력한다.';
      var iprompt = [
        '[만들 이미지]',
        inputLine(inp, 'subject', '무엇을 그릴지', '(비어 있음)'),
        inputLine(inp, 'purpose', '쓰일 곳 (썸네일·상세·SNS)'),
        inputLine(inp, 'mood', '분위기'),
        inputLine(inp, 'ratio', '비율', '1:1'),
        '',
        '[출력]',
        '영문 프롬프트 한 문단: 피사체, 구도, 렌즈/거리, 조명, 색, 질감, 배경, 스타일. 텍스트가 필요한 경우 “no text” 또는 정확히 넣을 문구만. Negative: blurry, text artifacts, extra fingers, watermark.',
        '그 아래에 한국어로 이 이미지가 무엇을 보여 주는지 2줄.'
      ].join('\n');
      return {
        kind: k, label: '이미지 프롬프트', system: isystem, prompt: iprompt,
        json: false, temperature: numberOr(inp.temperature, 0.7), maxTokens: 700,
        schema: ['prompt'],
        tips: ['같은 프롬프트라도 비율을 바꾸면 썸네일·상세에 바로 쓸 수 있습니다.']
      };
    }

    var gsystem = base + '\n\n[이번 일]\n요청한 작업을 완성 결과로 낸다. 설명을 덧붙이지 말고 결과만 낸다.';
    var gprompt = [
      '[요청]',
      inputLine(inp, 'instruction', '하고 싶은 일'),
      inputLine(inp, 'context', '맥락·자료'),
      inputLine(inp, 'format', '원하는 형식', '마크다운'),
      inputLine(inp, 'length', '분량')
    ].join('\n');
    return {
      kind: 'generic', label: '일반 요청', system: gsystem, prompt: gprompt,
      json: false, temperature: numberOr(inp.temperature, 0.7), maxTokens: 2000,
      schema: [], tips: []
    };
  }

  /* ==========================================================
     7. 공용 UI
     ----------------------------------------------------------
     앱의 CSS 변수에 물들고, 없으면 prefers-color-scheme 을 따른다.
     사용자 데이터는 textContent 로만 넣는다.
     ========================================================== */

  var CSS_ID = 'proconnector-css';
  var MODAL_CLASS = 'proconn-mode';
  var CSS = [
    '[data-proconn],.proconn-badge{',
    '  --pc-bg: var(--bg, #ffffff);',
    '  --pc-surface: var(--surface, #ffffff);',
    '  --pc-raised: var(--surface-2, var(--surface, #f6f7f9));',
    '  --pc-ink: var(--ink, #14181f);',
    '  --pc-muted: var(--muted, #5f6875);',
    '  --pc-line: var(--line, rgba(20,24,31,.14));',
    '  --pc-accent: var(--accent, #2563eb);',
    '  --pc-accent-ink: #ffffff;',
    '  --pc-good: #15935b;',
    '  --pc-radius: var(--radius, 14px);',
    '  --pc-font: var(--font-body, -apple-system, BlinkMacSystemFont, "Segoe UI", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif);',
    '}',
    '@media (prefers-color-scheme: dark){',
    '  [data-proconn],.proconn-badge{',
    '    --pc-bg: var(--bg, #101216);',
    '    --pc-surface: var(--surface, #171a21);',
    '    --pc-raised: var(--surface-2, var(--surface, #1e222b));',
    '    --pc-ink: var(--ink, #eef1f6);',
    '    --pc-muted: var(--muted, #9aa3b2);',
    '    --pc-line: var(--line, rgba(238,241,246,.14));',
    '  }',
    '}',
    '.proconn-badge{display:inline-flex;align-items:center;gap:8px;font:600 12.5px/1.25 var(--pc-font);color:var(--pc-ink);background:var(--pc-surface);border:1px solid var(--pc-line);border-radius:999px;padding:7px 12px;cursor:pointer;transition:border-color .15s, box-shadow .15s, transform .1s;max-width:100%;}',
    '.proconn-badge:hover{border-color:var(--pc-accent);box-shadow:0 0 0 3px color-mix(in srgb, var(--pc-accent) 14%, transparent);}',
    '.proconn-badge:active{transform:translateY(1px);}',
    '.proconn-badge:focus-visible{outline:2px solid var(--pc-accent);outline-offset:2px;}',
    '.proconn-badge .pc-dot{width:7px;height:7px;border-radius:50%;background:var(--pc-muted);flex:none;}',
    '.proconn-badge[data-mode="pro"] .pc-dot{background:var(--pc-good);box-shadow:0 0 0 3px color-mix(in srgb, var(--pc-good) 18%, transparent);}',
    '.proconn-badge .pc-sub{color:var(--pc-muted);font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '.proconn-badge[data-mode="pro"]{border-color:color-mix(in srgb, var(--pc-good) 42%, var(--pc-line));}',
    '.pc-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(8,10,14,.55);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);}',
    '.pc-overlay[hidden]{display:none;}',
    '.pc-panel{width:min(640px,100%);max-height:min(88vh,820px);overflow:auto;background:var(--pc-surface);color:var(--pc-ink);border:1px solid var(--pc-line);border-radius:calc(var(--pc-radius) + 4px);box-shadow:0 24px 70px rgba(0,0,0,.35);font:14px/1.55 var(--pc-font);-webkit-overflow-scrolling:touch;}',
    '.pc-panel *{box-sizing:border-box;}',
    '.pc-head{display:flex;align-items:flex-start;gap:12px;padding:18px 20px 12px;border-bottom:1px solid var(--pc-line);position:sticky;top:0;background:var(--pc-surface);z-index:2;}',
    '.pc-head h2{margin:0;font-size:17px;font-weight:700;letter-spacing:-.01em;}',
    '.pc-head p{margin:4px 0 0;font-size:12.5px;color:var(--pc-muted);}',
    '.pc-x{margin-left:auto;flex:none;width:32px;height:32px;border-radius:9px;border:1px solid transparent;background:transparent;color:var(--pc-muted);font-size:20px;line-height:1;cursor:pointer;}',
    '.pc-x:hover{background:var(--pc-raised);color:var(--pc-ink);}',
    '.pc-body{padding:16px 20px 16px;}',
    '.pc-tabs{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;margin-bottom:14px;}',
    '.pc-tab{display:flex;flex-direction:column;gap:3px;align-items:flex-start;text-align:left;padding:8px 9px;border-radius:10px;border:1px solid var(--pc-line);background:var(--pc-raised);color:var(--pc-ink);cursor:pointer;font:inherit;min-width:0;}',
    '.pc-tab .pc-rank{font-size:10px;font-weight:700;color:var(--pc-muted);letter-spacing:.04em;}',
    '.pc-tab .pc-name{font-size:12.5px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;}',
    '.pc-tab .pc-tag{font-size:10.5px;color:var(--pc-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;}',
    '.pc-tab[aria-selected="true"]{border-color:var(--pc-accent);background:color-mix(in srgb, var(--pc-accent) 12%, var(--pc-surface));}',
    '.pc-tab[aria-selected="true"] .pc-rank{color:var(--pc-accent);}',
    '.pc-tab:focus-visible{outline:2px solid var(--pc-accent);outline-offset:2px;}',
    '.pc-note{margin:0 0 12px;padding:9px 11px;border-radius:9px;background:var(--pc-raised);border:1px solid var(--pc-line);font-size:12px;color:var(--pc-muted);}',
    '.pc-note b{color:var(--pc-ink);font-weight:600;}',
    '.pc-field{display:block;margin-bottom:10px;}',
    '.pc-field > span{display:block;font-size:12px;font-weight:700;margin-bottom:5px;}',
    '.pc-field small{display:block;margin-top:5px;font-size:11.5px;color:var(--pc-muted);}',
    '.pc-input,.pc-select{width:100%;padding:10px 11px;border-radius:9px;border:1px solid var(--pc-line);background:var(--pc-bg);color:var(--pc-ink);font:13px/1.4 var(--pc-font);}',
    '.pc-input:focus,.pc-select:focus{outline:none;border-color:var(--pc-accent);box-shadow:0 0 0 3px color-mix(in srgb, var(--pc-accent) 18%, transparent);}',
    '.pc-row{display:flex;gap:10px;flex-wrap:wrap;}',
    '.pc-row > *{flex:1 1 180px;min-width:0;}',
    '.pc-check{display:flex;gap:9px;align-items:flex-start;margin:2px 0 12px;font-size:12.5px;color:var(--pc-muted);}',
    '.pc-check input{margin:2px 0 0;width:16px;height:16px;accent-color:var(--pc-accent);flex:none;}',
    '.pc-check b{color:var(--pc-ink);font-weight:600;}',
    '.pc-detail{border:1px solid var(--pc-line);border-radius:10px;padding:0 11px;margin-bottom:12px;background:var(--pc-raised);}',
    '.pc-detail summary{cursor:pointer;padding:10px 0;font-size:12.5px;font-weight:600;}',
    '.pc-detail .pc-field{margin-bottom:10px;}',
    '.pc-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:4px;}',
    '.pc-btn{appearance:none;border:1px solid var(--pc-line);background:var(--pc-raised);color:var(--pc-ink);font:600 13px/1 var(--pc-font);padding:11px 14px;border-radius:9px;cursor:pointer;min-height:40px;}',
    '.pc-btn:hover{border-color:var(--pc-accent);}',
    '.pc-btn:focus-visible{outline:2px solid var(--pc-accent);outline-offset:2px;}',
    '.pc-btn[disabled]{opacity:.55;cursor:progress;}',
    '.pc-btn-primary{background:var(--pc-accent);border-color:var(--pc-accent);color:var(--pc-accent-ink);}',
    '.pc-btn-primary:hover{filter:brightness(1.06);}',
    '.pc-btn-danger{margin-left:auto;background:transparent;border-color:transparent;color:#c0392b;}',
    '@media (prefers-color-scheme: dark){.pc-btn-danger{color:#ff8a7a;}}',
    '.pc-status{margin:10px 0 0;font-size:12.5px;min-height:19px;color:var(--pc-muted);}',
    '.pc-status[data-kind="ok"]{color:var(--pc-good);}',
    '.pc-status[data-kind="err"]{color:#c0392b;}',
    '@media (prefers-color-scheme: dark){.pc-status[data-kind="err"]{color:#ff8a7a;}}',
    '.pc-legal{margin:14px 0 0;padding-top:11px;border-top:1px solid var(--pc-line);font-size:11.5px;color:var(--pc-muted);}',
    '.pc-legal-line{margin:5px 0 0;line-height:1.6;}',
    '.pc-hint{font-size:11.5px;color:var(--pc-muted);word-break:break-all;}',
    '@media (max-width:520px){',
    '  .pc-overlay{padding:0;align-items:flex-end;}',
    '  .pc-panel{max-height:94dvh;border-radius:16px 16px 0 0;border-bottom:none;}',
    '  .pc-head{padding:14px 14px 10px;}',
    '  .pc-body{padding:12px 14px 18px;}',
    '  .pc-tabs{grid-template-columns:repeat(2,minmax(0,1fr));}',
    '  .pc-tab{padding:7px 8px;}',
    '  .pc-btn{flex:1 1 46%;}',
    '  .pc-btn-danger{margin-left:0;flex-basis:100%;}',
    '}',
    '@media (prefers-reduced-motion:reduce){.pc-overlay,.pc-panel{transition:none;}}'
  ].join('\n');

  function injectCSS() {
    var doc = root.document;
    if (!doc || !doc.head) return;
    if (doc.getElementById(CSS_ID)) return;
    var style = doc.createElement('style');
    style.id = CSS_ID;
    style.textContent = CSS;
    doc.head.appendChild(style);
  }

  function el(tag, attrs, kids) {
    var doc = root.document;
    var node = doc.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!has(attrs, k)) continue;
        var v = attrs[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === 'text') node.textContent = v;
        else if (k === 'class') node.className = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? '' : String(v));
      }
    }
    var list = kids || [];
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (c === null || c === undefined || c === false) continue;
      if (typeof c === 'string') node.appendChild(doc.createTextNode(c));
      else node.appendChild(c);
    }
    return node;
  }

  function clearNode(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  /* ── 배지 ─────────────────────────────────────────────── */

  var badgeEls = [];

  function paintBadge(node, state) {
    if (!node) return;
    var s = state || getState();
    node.setAttribute('data-mode', s.mode);
    node.setAttribute('title', s.connected
      ? s.providerName + ' 연결됨 · 클릭해서 관리'
      : '무료 모드 · 클릭해서 유료 API 연결');
    node.setAttribute('aria-label', s.connected
      ? 'Pro 연결됨: ' + s.providerName + '. 설정 열기'
      : '무료 모드. Pro API 연결 설정 열기');
    clearNode(node);
    node.appendChild(el('span', { class: 'pc-dot', 'aria-hidden': 'true' }));
    node.appendChild(el('span', { class: 'pc-label', text: s.connected ? 'Pro 연결됨' : '무료 모드' }));
    if (s.connected) {
      node.appendChild(el('span', { class: 'pc-sub', text: '· ' + s.badgeLabel }));
    } else {
      node.appendChild(el('span', { class: 'pc-sub', text: '· API 연결' }));
    }
  }

  function refreshBadges(state) {
    var s = state || getState();
    for (var i = 0; i < badgeEls.length; i++) {
      if (badgeEls[i]) paintBadge(badgeEls[i], s);
    }
  }

  /**
   * renderBadge(target, {onClick})
   * target: 요소 또는 CSS 선택자. 없으면 document.body 에 붙인다.
   */
  function renderBadge(target, options) {
    var doc = root.document;
    if (!doc) return null;
    injectCSS();
    var host = null;
    if (target) host = typeof target === 'string' ? doc.querySelector(target) : target;
    if (!host) host = doc.body;
    var existing = null;
    if (host && host.classList && host.classList.contains('proconn-badge')) existing = host;
    else if (host && host.querySelector) existing = host.querySelector('.proconn-badge');
    if (existing) {
      if (badgeEls.indexOf(existing) < 0) badgeEls.push(existing);
      paintBadge(existing);
      return existing;
    }
    var node = el('button', {
      type: 'button',
      class: 'proconn-badge',
      'data-proconn': '',
      'aria-haspopup': 'dialog'
    });
    node.addEventListener('click', function (e) {
      e.preventDefault();
      if (options && typeof options.onClick === 'function') options.onClick(e);
      else openModal();
    });
    paintBadge(node);
    badgeEls.push(node);
    host.appendChild(node);
    return node;
  }

  /* ── 모달 ─────────────────────────────────────────────── */

  var modal = null;

  function buildModal() {
    var doc = root.document;
    injectCSS();

    var state = getState();
    var activeProvider = state.connected ? state.provider : PROVIDERS[0].id;
    var overlay = el('div', { class: 'pc-overlay', 'data-proconn': '', hidden: true });
    var panel = el('div', {
      class: 'pc-panel', role: 'dialog', 'aria-modal': 'true',
      'aria-labelledby': 'pc-title', 'data-proconn': ''
    });

    var status = el('p', { class: 'pc-status', role: 'status', 'aria-live': 'polite' });
    var keyInputs = {};
    var modelSelects = {};
    var panels = {};
    var tabs = {};
    var rememberInput = null;
    var endpointInput = null;
    var tokenInput = null;
    var customModelInput = null;

    function setStatus(text, kind) {
      status.textContent = text || '';
      if (kind) status.setAttribute('data-kind', kind);
      else status.removeAttribute('data-kind');
    }

    function close() {
      overlay.hidden = true;
      doc.body.style.overflow = modal ? (modal.prevOverflow || '') : '';
      if (modal) modal.open = false;
      if (modal && modal.lastFocus && modal.lastFocus.focus) {
        try { modal.lastFocus.focus(); } catch (e) { /* ignore */ }
      }
    }

    function currentForm() {
      var pid = activeProvider;
      var key = '';
      if (pid !== 'custom' && keyInputs[pid]) key = trim(keyInputs[pid].value);
      if (pid !== 'custom' && !key && modal && modal.saved && modal.saved.provider === pid) key = modal.saved.apiKey;
      var models = { text: '', image: '', tts: '' };
      if (pid !== 'custom') {
        var ms = modelSelects[pid] || {};
        models.text = ms.text ? ms.text.value : '';
        models.image = ms.image ? ms.image.value : '';
        models.tts = ms.tts ? ms.tts.value : '';
      }
      return {
        provider: pid,
        apiKey: key,
        endpointUrl: pid === 'custom' ? trim(endpointInput.value) : '',
        bearerToken: pid === 'custom' ? trim(tokenInput.value) : '',
        models: models,
        model: models.text,
        remember: !!(rememberInput && rememberInput.checked)
      };
    }

    function selectProvider(pid, focus) {
      activeProvider = pid;
      for (var i = 0; i < PROVIDERS.length; i++) {
        var id = PROVIDERS[i].id;
        var on = id === pid;
        if (tabs[id]) {
          tabs[id].setAttribute('aria-selected', on ? 'true' : 'false');
          tabs[id].setAttribute('tabindex', on ? '0' : '-1');
        }
        if (panels[id]) panels[id].hidden = !on;
      }
      setStatus('');
      var p = providerById(pid);
      var saved = modal && modal.saved && modal.saved.provider === pid ? modal.saved : null;
      if (keyInputs[pid]) {
        keyInputs[pid].value = '';
        if (saved && saved.apiKey) {
          keyInputs[pid].placeholder = '저장된 키 사용 중 (' + maskKey(saved.apiKey) + ')';
        } else {
          keyInputs[pid].placeholder = p.keyPlaceholder;
        }
      }
      if (pid === 'custom' && saved) {
        endpointInput.value = saved.endpointUrl || '';
        tokenInput.value = '';
        if (saved.bearerToken) tokenInput.placeholder = '저장된 토큰 사용 중 (' + maskKey(saved.bearerToken) + ')';
        customModelInput.value = saved.models && saved.models.text ? saved.models.text : '';
      }
      if (focus && keyInputs[pid]) {
        try { keyInputs[pid].focus(); } catch (e) { /* ignore */ }
      }
    }

    /* 헤더 */
    var closeBtn = el('button', { class: 'pc-x', type: 'button', 'aria-label': '닫기', text: '×', onclick: close });
    panel.appendChild(el('div', { class: 'pc-head' }, [
      el('div', {}, [
        el('h2', { id: 'pc-title', text: 'Pro 연결' }),
        el('p', { text: '유료 API 키나 내 서버를 연결하면 완성 결과를 바로 만듭니다. 연결하지 않아도 무료 모드는 그대로 동작합니다.' })
      ]),
      closeBtn
    ]));

    var body = el('div', { class: 'pc-body' });

    /* 탭 */
    var tabWrap = el('div', { class: 'pc-tabs', role: 'tablist', 'aria-label': 'API 프로바이더' });
    for (var ti = 0; ti < PROVIDERS.length; ti++) {
      (function (p) {
        var tab = el('button', {
          type: 'button', role: 'tab', class: 'pc-tab',
          id: 'pc-tab-' + p.id, 'aria-controls': 'pc-panel-' + p.id,
          'aria-selected': 'false', tabindex: '-1',
          'data-provider': p.id,
          onclick: function () { selectProvider(p.id, true); }
        }, [
          el('span', { class: 'pc-rank', text: p.rank + '순위' }),
          el('span', { class: 'pc-name', text: p.name }),
          el('span', { class: 'pc-tag', text: p.tag })
        ]);
        tab.addEventListener('keydown', function (e) {
          var idx = -1;
          for (var i = 0; i < PROVIDERS.length; i++) if (PROVIDERS[i].id === p.id) idx = i;
          var next = null;
          if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = PROVIDERS[(idx + 1) % PROVIDERS.length];
          else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = PROVIDERS[(idx - 1 + PROVIDERS.length) % PROVIDERS.length];
          else if (e.key === 'Home') next = PROVIDERS[0];
          else if (e.key === 'End') next = PROVIDERS[PROVIDERS.length - 1];
          if (next) {
            e.preventDefault();
            selectProvider(next.id, false);
            try { tabs[next.id].focus(); } catch (err) { /* ignore */ }
          }
        });
        tabs[p.id] = tab;
        tabWrap.appendChild(tab);
      })(PROVIDERS[ti]);
    }
    body.appendChild(tabWrap);

    /* 패널 */
    for (var pj = 0; pj < PROVIDERS.length; pj++) {
      (function (p) {
        var pane = el('div', {
          role: 'tabpanel', id: 'pc-panel-' + p.id, 'aria-labelledby': 'pc-tab-' + p.id,
          'data-proconn': '', hidden: true
        });

        pane.appendChild(el('p', { class: 'pc-note' }, [
          el('b', { text: p.name + ' · ' + p.brand }),
          el('span', { text: ' — ' + p.keyNote })
        ]));

        if (p.id === 'custom') {
          endpointInput = el('input', {
            class: 'pc-input', type: 'url', inputmode: 'url', autocomplete: 'off',
            spellcheck: 'false', placeholder: 'https://내-서버.example.com/api/generate'
          });
          pane.appendChild(el('label', { class: 'pc-field' }, [
            el('span', { text: '서버 주소 (POST JSON)' }), endpointInput,
            el('small', { text: '앱은 이 주소로 { task, prompt, system, options } 를 보냅니다. 응답은 { text } · { imageUrl } · { audioUrl } 중 하나면 됩니다.' })
          ]));

          pane.appendChild(el('div', { class: 'pc-actions' }, [
            el('button', {
              type: 'button', class: 'pc-btn', text: '무료 맛보기 서버 채우기',
              onclick: function () {
                endpointInput.value = FREE_TASTE_ENDPOINT;
                setStatus('무료 맛보기 서버를 채웠습니다. 저장하면 키 없이 하루 몇 회 바로 쓸 수 있어요.', '');
                try { endpointInput.focus(); } catch (e) { /* ignore */ }
              }
            })
          ]));
          pane.appendChild(el('p', { class: 'pc-note' }, [
            el('b', { text: '무료 맛보기' }),
            el('span', { text: ' — 하루 몇 회(기기 기준)까지 글쓰기만 됩니다. 다 쓰면 서버가 한국어 안내와 함께 무료 Gemini 키·구독 AI 브리지로 넘기라고 알려 줍니다.' })
          ]));

          tokenInput = el('input', {
            class: 'pc-input', type: 'password', autocomplete: 'off',
            placeholder: p.keyPlaceholder
          });
          pane.appendChild(el('label', { class: 'pc-field' }, [
            el('span', { text: '인증 토큰 (선택)' }), tokenInput,
            el('small', { text: 'Authorization: Bearer 로 전송됩니다. 비워 두면 인증 없이 호출합니다.' })
          ]));

          customModelInput = el('input', {
            class: 'pc-input', type: 'text', autocomplete: 'off',
            placeholder: '모델 이름 (선택)'
          });
          pane.appendChild(el('label', { class: 'pc-field' }, [
            el('span', { text: '모델 이름 (선택)' }), customModelInput,
            el('small', { text: '서버가 여러 모델을 받을 때만 입력하세요.' })
          ]));
        } else {
          var keyInput = el('input', {
            class: 'pc-input', type: 'password', autocomplete: 'off', spellcheck: 'false',
            placeholder: p.keyPlaceholder, 'aria-label': p.keyLabel
          });
          keyInputs[p.id] = keyInput;
          var keyKids = [el('span', { text: p.keyLabel }), keyInput];
          if (p.keyUrl) {
            keyKids.push(el('small', {}, [
              el('a', { href: p.keyUrl, target: '_blank', rel: 'noopener noreferrer', text: '키 발급받기 ↗' })
            ]));
          }
          pane.appendChild(el('label', { class: 'pc-field' }, keyKids));

          var textSel = el('select', { class: 'pc-select', 'aria-label': p.name + ' 글쓰기 모델' });
          for (var m = 0; m < (p.models.text || []).length; m++) {
            var mo = p.models.text[m];
            textSel.appendChild(el('option', { value: mo.id, text: mo.label + ' — ' + mo.note }));
          }
          modelSelects[p.id] = { text: textSel };
          pane.appendChild(el('label', { class: 'pc-field' }, [
            el('span', { text: '글쓰기 모델' }), textSel
          ]));

          var hasImg = p.models.image && p.models.image.length;
          var hasTts = p.models.tts && p.models.tts.length;
          if (hasImg || hasTts) {
            var det = el('details', { class: 'pc-detail' });
            det.appendChild(el('summary', { text: '이미지 · 음성 모델 (선택)' }));
            if (hasImg) {
              var imgSel = el('select', { class: 'pc-select', 'aria-label': p.name + ' 이미지 모델' });
              for (var ii = 0; ii < p.models.image.length; ii++) {
                var im = p.models.image[ii];
                imgSel.appendChild(el('option', { value: im.id, text: im.label + ' — ' + im.note }));
              }
              modelSelects[p.id].image = imgSel;
              det.appendChild(el('label', { class: 'pc-field' }, [el('span', { text: '이미지 모델' }), imgSel]));
            }
            if (hasTts) {
              var ttsSel = el('select', { class: 'pc-select', 'aria-label': p.name + ' 음성 모델' });
              for (var si = 0; si < p.models.tts.length; si++) {
                var sm = p.models.tts[si];
                ttsSel.appendChild(el('option', { value: sm.id, text: sm.label + ' — ' + sm.note }));
              }
              modelSelects[p.id].tts = ttsSel;
              det.appendChild(el('label', { class: 'pc-field' }, [el('span', { text: '음성 모델' }), ttsSel]));
            }
            pane.appendChild(det);
          }
        }

        panels[p.id] = pane;
        body.appendChild(pane);
      })(PROVIDERS[pj]);
    }

    /* 저장 방식 */
    rememberInput = el('input', { type: 'checkbox', id: 'pc-remember' });
    body.appendChild(el('label', { class: 'pc-check', for: 'pc-remember' }, [
      rememberInput,
      el('span', {}, [
        el('b', { text: '이 브라우저에 기억' }),
        el('span', { text: ' — 켜면 localStorage 에 저장해 다음 방문에도 유지합니다. 끄면 이 탭에서만 쓰고 탭을 닫으면 사라집니다. 공용 PC 에서는 끄세요.' })
      ])
    ]));

    /* 버튼 */
    var testBtn = el('button', { type: 'button', class: 'pc-btn', text: '연결 테스트' });
    var saveBtn = el('button', { type: 'button', class: 'pc-btn pc-btn-primary', text: '저장하고 연결' });
    var clearBtn = el('button', { type: 'button', class: 'pc-btn pc-btn-danger', text: '연결 해제 및 키 삭제' });
    body.appendChild(el('div', { class: 'pc-actions' }, [testBtn, saveBtn, clearBtn]));
    body.appendChild(status);

    /* 고지 */
    body.appendChild(el('div', { class: 'pc-legal' }, [
      el('div', { text: '키와 요금, 개인정보' }),
      el('p', { class: 'pc-legal-line', text: '키는 이 브라우저에만 저장되고 우리 서버로 보내지 않습니다. 요청은 선택한 API 로 브라우저에서 직접 나가고, 요금은 각 서비스 계정에 청구됩니다. 입력한 내용은 해당 제공자 정책에 따라 처리되므로 민감한 개인정보는 넣지 마세요.' }),
      el('p', { class: 'pc-legal-line', text: '공용 PC 에서는 “이 브라우저에 기억”을 끄고, 사용 후 “연결 해제 및 키 삭제”를 눌러 주세요.' })
    ]));

    panel.appendChild(body);
    overlay.appendChild(panel);
    overlay.addEventListener('mousedown', function (e) {
      if (e.target === overlay) close();
    });

    function onKey(e) {
      if (overlay.hidden) return;
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key !== 'Tab') return;
      var focusables = panel.querySelectorAll('button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])');
      var list = [];
      for (var i = 0; i < focusables.length; i++) {
        var n = focusables[i];
        if (n.disabled || n.offsetParent === null) continue;
        list.push(n);
      }
      if (!list.length) return;
      var first = list[0], last = list[list.length - 1];
      if (e.shiftKey && doc.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && doc.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    doc.addEventListener('keydown', onKey);

    function applyState() {
      var s = getState();
      if (s.connected) {
        selectProvider(s.provider, false);
      } else {
        selectProvider(activeProvider || PROVIDERS[0].id, false);
      }
      var saved = loadConfig();
      if (modal.saved && saved && modal.saved.provider === saved.provider) {
        // 저장 후에도 같은 설정을 유지
      }
      rememberInput.checked = !!(saved && saved.remember);
      // 모델 선택 복원
      if (saved) {
        var ms = modelSelects[saved.provider];
        if (ms) {
          if (ms.text && saved.models.text) setSelect(ms.text, saved.models.text);
          if (ms.image && saved.models.image) setSelect(ms.image, saved.models.image);
          if (ms.tts && saved.models.tts) setSelect(ms.tts, saved.models.tts);
        }
        if (saved.provider === 'custom' && endpointInput) {
          endpointInput.value = saved.endpointUrl || '';
          customModelInput.value = saved.models.text || '';
        }
      }
      if (s.connected && s.provider === 'custom' && endpointInput) endpointInput.value = saved ? saved.endpointUrl : '';
    }

    function setSelect(sel, value) {
      for (var i = 0; i < sel.options.length; i++) {
        if (sel.options[i].value === value) { sel.selectedIndex = i; return; }
      }
    }

    testBtn.addEventListener('click', function () {
      var form = currentForm();
      setStatus('연결을 확인하는 중…', '');
      testBtn.disabled = true;
      testConnection(form).then(function (res) {
        testBtn.disabled = false;
        if (res.ok) setStatus(res.message, 'ok');
        else setStatus(res.message, 'err');
      }, function () {
        testBtn.disabled = false;
        setStatus('연결 확인 중 오류가 났습니다.', 'err');
      });
    });

    saveBtn.addEventListener('click', function () {
      var form = currentForm();
      var res = saveConfig(form);
      if (!res.ok) {
        setStatus(res.errors[0], 'err');
        return;
      }
      modal.saved = loadConfig();
      if (form.provider !== 'custom' && keyInputs[form.provider]) {
        keyInputs[form.provider].value = '';
        keyInputs[form.provider].placeholder = '저장된 키 사용 중 (' + maskKey(form.apiKey) + ')';
      }
      if (form.provider === 'custom') {
        tokenInput.value = '';
        if (form.bearerToken) tokenInput.placeholder = '저장된 토큰 사용 중 (' + maskKey(form.bearerToken) + ')';
      }
      setStatus('저장했습니다. ' + res.state.providerName + ' 로 연결됐습니다.' + (res.warning ? ' ' + res.warning : ''), 'ok');
      // 모달은 닫지 않는다 — 사용자가 테스트하거나 바로 쓸 수 있게.
    });

    clearBtn.addEventListener('click', function () {
      clearConfig();
      modal.saved = null;
      for (var id in keyInputs) if (has(keyInputs, id)) {
        keyInputs[id].value = '';
        keyInputs[id].placeholder = providerById(id).keyPlaceholder;
      }
      if (endpointInput) { endpointInput.value = ''; tokenInput.value = ''; tokenInput.placeholder = providerById('custom').keyPlaceholder; customModelInput.value = ''; }
      rememberInput.checked = false;
      setStatus('키를 삭제했습니다. 무료 모드로 돌아갑니다.', 'ok');
    });

    doc.body.appendChild(overlay);

    modal = {
      overlay: overlay, panel: panel, open: false, saved: loadConfig(),
      prevOverflow: '',
      close: close,
      refresh: function () { modal.saved = loadConfig(); applyState(); paintBadge(doc.querySelector('.proconn-badge')); },
      setStatus: setStatus
    };

    selectProvider(activeProvider, false);
    applyState();
    return modal;
  }

  function openModal(options) {
    if (!root.document) return null;
    if (!modal) buildModal();
    var doc = root.document;
    if (!modal.open) {
      modal.saved = loadConfig();
      modal.refresh();
      modal.prevOverflow = doc.body.style.overflow || '';
      doc.body.style.overflow = 'hidden';
      modal.lastFocus = doc.activeElement;
      modal.overlay.hidden = false;
      modal.open = true;
      var first = modal.panel.querySelector('.pc-tab[aria-selected="true"]') || modal.panel.querySelector('button');
      try { if (first) first.focus(); } catch (e) { /* ignore */ }
    }
    return modal;
  }

  function mountModal(target, options) {
    if (!root.document) return null;
    if (!modal) buildModal();
    if (target) {
      var btn = typeof target === 'string' ? root.document.querySelector(target) : target;
      if (btn && !btn.__pcBound) {
        btn.__pcBound = true;
        btn.addEventListener('click', function (e) {
          e.preventDefault();
          openModal(options);
        });
      }
    }
    return {
      open: openModal,
      close: function () { if (modal) modal.close(); },
      setStatus: function (text, kind) { if (modal) modal.setStatus(text, kind); },
      refresh: function () { if (modal) modal.refresh(); },
      el: modal ? modal.overlay : null
    };
  }

  /* 변경 알림 → 배지 자동 갱신 */
  subscribe(function (s) { refreshBadges(s); });

  /* ==========================================================
     8. 내보내기
     ========================================================== */

  return {
    VERSION: VERSION,
    STORAGE_KEY: STORAGE_KEY,
    EVENT_NAME: EVENT_NAME,
    FREE_TASTE_HOST: FREE_TASTE_HOST,
    FREE_TASTE_ENDPOINT: FREE_TASTE_ENDPOINT,
    FREE_TASTE_PROMPT_LIMIT: FREE_TASTE_PROMPT_LIMIT,
    PROVIDERS: listProviders(),
    TASKS: TASK_IDS.slice(),
    TASK_LABELS: clone(TASK_LABELS),
    PROMPT_KINDS: PROMPT_KINDS.slice(),
    SAFETY_RULES: SAFETY_RULES.slice(),

    /* 프로바이더 */
    providers: listProviders,
    providerById: providerById,
    defaultModel: defaultModel,

    /* 설정 */
    loadConfig: function () {
      var cfg = loadConfig();
      if (!cfg) return null;
      var out = clone(cfg);
      out.apiKey = cfg.apiKey ? maskKey(cfg.apiKey) : '';
      out.bearerToken = cfg.bearerToken ? maskKey(cfg.bearerToken) : '';
      out.hasKey = !!cfg.apiKey;
      return out;
    },
    getState: getState,
    isConnected: isConnected,
    saveConfig: saveConfig,
    clearConfig: clearConfig,
    maskKey: maskKey,

    /* 생성 */
    generate: generate,
    generateText: generateText,
    generateImage: generateImage,
    generateTTS: generateTTS,
    generateFree: generateFree,
    isFreeMode: isFreeMode,
    isFreeTasteEndpoint: isFreeTasteEndpoint,
    freeLimitCard: freeLimitCard,
    testConnection: testConnection,
    buildRequest: buildRequest,
    parseJson: parseJson,
    parseResponse: parseJson,

    /* 전송 계층 (데모·테스트용) */
    setTransport: setTransport,
    getTransport: getTransport,

    /* 프롬프트 */
    buildProPrompt: buildProPrompt,

    /* UI */
    renderBadge: renderBadge,
    mountModal: mountModal,
    openModal: openModal,
    injectCSS: injectCSS,

    /* 구독 */
    subscribe: subscribe,

    _util: {
      maskKey: maskKey,
      redact: redact,
      dataUrl: dataUrl,
      bytesToBase64: bytesToBase64,
      pcm16ToWavBase64: pcm16ToWavBase64,
      isHttpUrl: isHttpUrl,
      trim: trim,
      clone: clone
    }
  };
});
