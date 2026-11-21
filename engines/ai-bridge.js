/* ============================================================
   ai-bridge.js  ·  내 구독 AI 원클릭 브리지  v1.0.0
   ------------------------------------------------------------
   의존성 없는 순수 JS(UMD). 브라우저에서는 window.AiBridge,
   node 에서는 require('./ai-bridge.js') 로 쓴다.

   이 모듈이 하는 일
   1) SEO 프롬프트를 ChatGPT · Claude · Gemini 새 창으로 넘기는 링크 생성
      (주소로 자동 입력할 수 있는 곳은 자동 입력, 안 되는 곳은 클립보드용)
   2) AI가 준 원고 한 덩어리에서 제목 · 본문 · 태그 · 키워드 분리
   3) 선택형 무료 Gemini API 키로 브라우저에서 바로 생성하는 요청/응답 처리

   이 파일에는 키를 넣지 않는다. 키는 사용자가 화면에서 넣고
   브라우저 저장소(localStorage)에만 남는다.
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AiBridge = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '1.0.0';

  /* ── 공통 유틸 ─────────────────────────────────────────── */

  function str(v) {
    if (v === null || v === undefined) return '';
    return String(v);
  }

  function codePoints(s) {
    return Array.from ? Array.from(str(s)).length : str(s).length;
  }

  function trimBlankLines(lines) {
    var out = lines.slice();
    while (out.length && !out[0].trim()) out.shift();
    while (out.length && !out[out.length - 1].trim()) out.pop();
    return out;
  }

  /* ── 1. AI 링크 ────────────────────────────────────────── */

  /**
   * prefilled: 주소의 q 파라미터로 입력창을 채울 수 있는가.
   * maxPrompt: 서비스가 받아 주는 대략의 글자수(넘으면 주소로 넘기지 않음).
   * 주소 파라미터 방식은 각 서비스가 공식 문서로 보장하지 않는 기능이라,
   * 자동 입력이 비어 있으면 붙여넣기로 끝낼 수 있게 클립보드를 항상 함께 쓴다.
   */
  var PROVIDERS = [
    {
      id: 'chatgpt', label: 'ChatGPT', host: 'chatgpt.com',
      base: 'https://chatgpt.com/', param: 'q', prefilled: true, maxPrompt: 6000, maxUrl: 7000,
      note: '입력창에 프롬프트가 채워집니다. 비어 있으면 Ctrl+V로 붙여넣으세요.'
    },
    {
      id: 'claude', label: 'Claude', host: 'claude.ai',
      base: 'https://claude.ai/new', param: 'q', prefilled: true, maxPrompt: 10000, maxUrl: 7000,
      note: '입력창에 프롬프트가 채워집니다. 비어 있으면 Ctrl+V로 붙여넣으세요.'
    },
    {
      id: 'gemini', label: 'Gemini', host: 'gemini.google.com',
      base: 'https://gemini.google.com/app', param: '', prefilled: false, maxPrompt: 0, maxUrl: 0,
      note: 'Gemini는 주소 자동 입력이 안 됩니다. 클립보드에 복사했으니 열린 창에 붙여넣으세요.'
    }
  ];

  var PROVIDER_INDEX = (function () {
    var m = {};
    PROVIDERS.forEach(function (p) { m[p.id] = p; });
    return m;
  })();

  function provider(id) {
    return PROVIDER_INDEX[String(id || '').toLowerCase()] || null;
  }

  function listProviders() {
    return PROVIDERS.map(function (p) {
      return { id: p.id, label: p.label, host: p.host, prefilled: p.prefilled, note: p.note };
    });
  }

  /**
   * 프롬프트를 넘길 링크.
   * @returns {{id,label,url,prefilled,fit,note}}
   */
  function linkFor(id, prompt) {
    var p = provider(id);
    if (!p) return { id: String(id || ''), label: '', url: '', prefilled: false, fit: false, note: '알 수 없는 AI예요.' };
    var text = str(prompt);
    var len = codePoints(text);

    if (!p.prefilled) {
      return { id: p.id, label: p.label, url: p.base, prefilled: false, fit: false, note: p.note };
    }
    if (!text.trim()) {
      return { id: p.id, label: p.label, url: p.base, prefilled: false, fit: false, note: '보낼 프롬프트가 비어 있어요.' };
    }
    if (len > p.maxPrompt) {
      return {
        id: p.id, label: p.label, url: p.base, prefilled: false, fit: false,
        note: '프롬프트가 ' + len.toLocaleString('ko-KR') + '자로 길어 주소에 담지 못했어요. 클립보드에 복사했으니 열린 창에 붙여넣으세요.'
      };
    }
    var encoded = encodeURIComponent(text).length;
    if (p.maxUrl && encoded > p.maxUrl) {
      return {
        id: p.id, label: p.label, url: p.base, prefilled: false, fit: false,
        note: '프롬프트가 길어(주소 ' + encoded.toLocaleString('ko-KR') + '자) 자동 입력 대신 붙여넣기로 안내해요.'
      };
    }
    var sep = p.base.indexOf('?') >= 0 ? '&' : '?';
    return {
      id: p.id, label: p.label,
      url: p.base + sep + p.param + '=' + encodeURIComponent(text),
      prefilled: true, fit: true, note: p.note
    };
  }

  function linksFor(prompt) {
    return PROVIDERS.map(function (p) { return linkFor(p.id, prompt); });
  }

  /* ── 2. AI 원고 → 제목·본문·태그 분리 ──────────────────── */

  var HASHTAG_RE = /#[^\s#,，]+/g;

  function hashtags(s) {
    var t = str(s);
    var found = t.match(HASHTAG_RE) || [];
    var out = found.map(function (x) { return x.slice(1).trim(); }).filter(Boolean);
    if (!out.length) {
      out = t.split(/[,\s·]+/).map(function (x) { return x.replace(/^#/, '').trim(); }).filter(Boolean);
    }
    var seen = {}, uniq = [];
    out.forEach(function (t2) { if (!seen[t2]) { seen[t2] = 1; uniq.push(t2); } });
    return uniq;
  }

  function cleanTitleLine(line) {
    var t = str(line).trim();
    t = t.replace(/^\s{0,3}#{1,6}\s*/, '');           // 마크다운 제목 기호
    t = t.replace(/^\*\*|\*\*$/g, '');                 // 굵게 표시
    t = t.replace(/^__|__$/g, '');
    t = t.replace(/^(?:제목|타이틀|title)\s*[:：]\s*/i, '');
    return t.trim();
  }

  function isHashOnly(line) {
    return /^(?:#[^\s#]+[\s,·]*)+$/.test(str(line).trim());
  }

  function isTitleish(line) {
    var t = cleanTitleLine(line);
    var len = codePoints(t);
    if (len < 4 || len > 100) return false;
    if (/^\s*(?:[-*•·✅☑✔]|\d+[.)])\s+/.test(t)) return false;   // 목록
    if (t.indexOf('|') >= 0) return false;                        // 표
    if (/[.。]$/.test(t)) return false;                            // 문장 끝
    if (/^(?:안녕하세요|반갑습니다|물론입니다|다음은)/.test(t)) return false;
    return true;
  }

  /**
   * AI가 준 답변 한 덩어리를 원고 진단에 넣을 수 있게 나눈다.
   * - ```코드블록``` 표시 제거
   * - "제목:" / 마크다운 # / 첫 줄 제목 인식
   * - "태그:" 줄과 마지막 해시태그 줄을 태그로 분리
   * - "키워드:" 줄은 키워드로 분리
   * @param {string} raw
   * @returns {{title,body,tags,keyword,stats,warnings,fences}}
   */
  function parseDraft(raw) {
    var text = str(raw).replace(/\r\n?/g, '\n');
    var fences = 0;
    var lines = text.split('\n').filter(function (line) {
      if (/^\s*```/.test(line)) { fences++; return false; }
      return true;
    });

    var title = '';
    var keyword = '';
    var tags = [];
    var bodyLines = [];
    var bodyStarted = false;
    var titleLocked = false;

    for (var i = 0; i < lines.length; i++) {
      var rawLine = lines[i];
      var l = rawLine.trim();

      if (!l) {
        if (bodyStarted) bodyLines.push('');
        continue;
      }

      var mTitle = l.match(/^(?:제목|타이틀|title)\s*[:：]\s*(.+)$/i);
      if (mTitle) {
        if (!title) { title = cleanTitleLine(mTitle[1]); titleLocked = true; }
        else bodyLines.push(rawLine);
        continue;
      }

      var mKeyword = l.match(/^(?:타깃\s*키워드|키워드|keyword)\s*[:：]\s*(.+)$/i);
      if (mKeyword) {
        if (!keyword) keyword = cleanTitleLine(mKeyword[1]);
        continue;
      }

      var mTags = l.match(/^(?:태그|해시태그|tags?)\s*[:：]\s*(.+)$/i);
      if (mTags) {
        tags = tags.concat(hashtags(mTags[1]));
        continue;
      }

      if (isHashOnly(l)) {
        tags = tags.concat(hashtags(l));
        continue;
      }

      if (!bodyStarted && !titleLocked && !title && isTitleish(l)) {
        title = cleanTitleLine(l);
        titleLocked = true;
        continue;
      }

      bodyLines.push(rawLine);
      bodyStarted = true;
    }

    bodyLines = trimBlankLines(bodyLines);
    var body = bodyLines.join('\n').trim();

    /* 제목 없이 짧은 한 줄만 온 경우(답변이 잘린 경우) */
    if (!title && body && !body.includes('\n') && isTitleish(body)) {
      title = cleanTitleLine(body);
      body = '';
    }

    var bodyNoSpaceCount = codePoints(body.replace(/\s+/g, ''));
    var stats = {
      titleChars: codePoints(title),
      bodyChars: codePoints(body),
      bodyNoSpace: bodyNoSpaceCount,
      paragraphs: body ? body.split(/\n\s*\n/).filter(function (p) { return p.trim(); }).length : 0,
      tags: tags.length
    };

    var warnings = [];
    if (!title) warnings.push('제목 줄을 찾지 못했어요. 첫 줄에 제목을 넣거나 진단 탭에서 직접 입력하세요.');
    if (!body) warnings.push('본문이 비어 있어요. AI 답변이 잘렸는지 확인하세요.');
    else if (bodyNoSpaceCount < 600) warnings.push('본문이 ' + bodyNoSpaceCount + '자(공백 제외)로 짧아요. 답변이 중간에 끊겼는지 확인하세요.');
    if (!tags.length) warnings.push('태그 줄이 없어요. 진단에는 지장이 없습니다.');
    if (fences) warnings.push('코드블록 표시(```)는 자동으로 지웠어요.');

    return {
      title: title,
      body: body,
      tags: tags.slice(0, 30),
      keyword: keyword,
      fences: fences,
      stats: stats,
      warnings: warnings
    };
  }

  /* ── 3. Gemini API (선택) ───────────────────────────────── */

  var GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
  var GEMINI_DEFAULT_MODEL = 'gemini-3.5-flash-lite';
  var GEMINI_MODELS = [
    'gemini-3.5-flash-lite',
    'gemini-3.8-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.5-flash'
  ];

  function geminiModel(model) {
    var m = str(model).trim();
    return m || GEMINI_DEFAULT_MODEL;
  }

  /**
   * 브라우저에서 바로 부를 요청. 키는 주소의 key 파라미터로만 나간다.
   * @returns {{url,init}}
   */
  function buildGeminiRequest(opts) {
    var o = opts || {};
    var key = str(o.apiKey).trim();
    if (!key) throw new Error('Gemini API 키가 비어 있어요.');
    var prompt = str(o.prompt);
    if (!prompt.trim()) throw new Error('보낼 프롬프트가 비어 있어요.');
    var model = geminiModel(o.model);
    var url = GEMINI_BASE + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(key);
    var body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: typeof o.temperature === 'number' ? o.temperature : 0.7,
        maxOutputTokens: typeof o.maxOutputTokens === 'number' ? o.maxOutputTokens : 4096
      }
    };
    return {
      url: url,
      model: model,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }
    };
  }

  function textFromParts(parts) {
    if (!Array.isArray(parts)) return '';
    return parts.map(function (p) {
      if (!p || typeof p !== 'object') return '';
      if (p.thought === true) return '';
      return str(p.text);
    }).filter(Boolean).join('');
  }

  /**
   * Gemini 응답 → 원고 텍스트.
   * generateContent(candidates)와 최신 interactions(output_text) 모양을 모두 받는다.
   * @returns {{ok,text,error,code,finishReason,warnings}}
   */
  function parseGeminiResponse(json) {
    var warnings = [];
    if (!json || typeof json !== 'object') {
      return { ok: false, text: '', error: '응답을 읽지 못했어요.', code: 'bad-json', warnings: warnings };
    }
    if (json.error) {
      return {
        ok: false, text: '', code: json.error.code || 'error',
        error: str(json.error.message) || 'Gemini가 오류를 돌려줬어요.',
        warnings: warnings
      };
    }

    var text = '';

    if (Array.isArray(json.candidates) && json.candidates.length) {
      var cand = json.candidates[0] || {};
      text = textFromParts(cand.content && cand.content.parts);
      if (cand.finishReason && cand.finishReason !== 'STOP') {
        warnings.push('응답이 ' + cand.finishReason + '로 끝났어요. 원고가 잘렸으면 이어서 요청하세요.');
      }
    } else if (typeof json.output_text === 'string') {
      text = json.output_text;
    } else if (Array.isArray(json.outputs)) {
      text = json.outputs.map(function (o) {
        if (typeof o === 'string') return o;
        if (o && typeof o.text === 'string') return o.text;
        if (o && o.content && Array.isArray(o.content.parts)) return textFromParts(o.content.parts);
        return '';
      }).filter(Boolean).join('\n');
    } else if (json.promptFeedback && json.promptFeedback.blockReason) {
      return {
        ok: false, text: '', code: 'blocked',
        error: '안전 필터에 걸려 답변이 오지 않았어요(' + json.promptFeedback.blockReason + '). 표현을 바꿔 다시 시도하세요.',
        warnings: warnings
      };
    }

    text = text.trim();
    if (!text) {
      return { ok: false, text: '', code: 'empty', error: '응답은 왔지만 원고가 비어 있어요. 모델명을 확인하거나 다시 시도하세요.', warnings: warnings };
    }
    return { ok: true, text: text, error: null, code: 200, finishReason: null, warnings: warnings };
  }

  /** HTTP 상태 → 사람이 읽는 안내 */
  function explainStatus(status, bodyText) {
    var detail = str(bodyText).slice(0, 160);
    if (status === 400) return '요청 형식이 거부됐어요. 모델명을 확인하세요. ' + detail;
    if (status === 401 || status === 403) return '키가 거부됐어요. 키 제한(IP·API)과 사용 설정을 확인하세요. ' + detail;
    if (status === 404) return '모델을 찾지 못했어요. 모델명을 다른 것으로 바꿔 보세요. ' + detail;
    if (status === 429) return '무료 한도를 넘었어요. 잠시 뒤 다시 시도하거나 다른 모델을 쓰세요. ' + detail;
    if (status >= 500) return 'Gemini 서버가 잠시 응답하지 못했어요. 잠시 뒤 다시 시도하세요. ' + detail;
    return 'Gemini 요청이 실패했어요(HTTP ' + status + '). ' + detail;
  }

  /** 원고에서 태그·제목 표시를 걷어낸 순수 본문 글자수(붙여넣기 전 확인용) */
  function quickStats(raw) {
    var p = parseDraft(raw);
    return {
      title: p.title,
      bodyChars: p.stats.bodyChars,
      paragraphs: p.stats.paragraphs,
      tags: p.tags.length,
      warnings: p.warnings
    };
  }

  return {
    VERSION: VERSION,
    PROVIDERS: listProviders(),
    GEMINI_DEFAULT_MODEL: GEMINI_DEFAULT_MODEL,
    GEMINI_MODELS: GEMINI_MODELS.slice(),
    provider: provider,
    listProviders: listProviders,
    linkFor: linkFor,
    linksFor: linksFor,
    parseDraft: parseDraft,
    quickStats: quickStats,
    hashtags: hashtags,
    geminiModel: geminiModel,
    buildGeminiRequest: buildGeminiRequest,
    parseGeminiResponse: parseGeminiResponse,
    explainStatus: explainStatus
  };
});
