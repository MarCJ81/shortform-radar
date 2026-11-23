#!/usr/bin/env node
/* ============================================================
   떡상 레이더 · test.js
   Unit tests for core.js + demo dataset integrity.
   Run:  node test.js
   ============================================================ */
'use strict';

const C = require('./core.js');
const D = require('./data.js');

const NOW = Date.parse('2026-11-21T09:00:00+09:00');
const iso = (hoursAgo) => new Date(NOW - hoursAgo * 3600000).toISOString();

let pass = 0;
const failures = [];
let currentGroup = '';

function group(name) { currentGroup = name; }

function ok(cond, label, detail) {
  if (cond) { pass++; return; }
  failures.push({ group: currentGroup, label, detail: detail === undefined ? '' : String(detail) });
}

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(a === e, label, 'expected ' + e + ' got ' + a);
}

function near(actual, expected, tol, label) {
  ok(Math.abs(actual - expected) <= tol, label, 'expected ~' + expected + ' got ' + actual);
}

function throws(fn, label) {
  let threw = false;
  try { fn(); } catch (e) { threw = true; }
  ok(threw, label);
}

/* ---------------------------------------------------------- */
group('formatCount');
eq(C.formatCount(0), '0', '0');
eq(C.formatCount(999), '999', '999');
eq(C.formatCount(1200), '1,200', '1,200');
eq(C.formatCount(9999), '9,999', '9,999');
eq(C.formatCount(25400), '2.5만', '2.5만');
eq(C.formatCount(540000), '54만', '54만');
eq(C.formatCount(12000000), '1,200만', '1,200만');
eq(C.formatCount(120000000), '1.2억', '1.2억');
eq(C.formatCount(1000000000), '10억', '10억');
eq(C.formatCount(null), '—', 'null → —');
eq(C.formatVph(56000), '5.6만/h', 'VPH 5.6만/h');
eq(C.formatMultiple(2.7), '2.7x', '2.7x');
eq(C.formatMultiple(13.54), '13.5x', '13.5x');
eq(C.formatMultiple(9.96), '10x', '9.96 → 10x');
eq(C.formatMultiple(0), '—', '0 → —');
eq(C.formatPercent(5.6261), '5.6%', '5.6%');

group('relativeTime');
eq(C.relativeTime(iso(0.008), NOW), '방금', '방금');
eq(C.relativeTime(iso(5 / 60), NOW), '5분 전', '5분 전');
eq(C.relativeTime(iso(3), NOW), '3시간 전', '3시간 전');
eq(C.relativeTime(iso(26), NOW), '1일 전', '1일 전');
eq(C.relativeTime(iso(8 * 24), NOW), '1주 전', '1주 전');
eq(C.relativeTime(iso(40 * 24), NOW), '1개월 전', '1개월 전');
eq(C.relativeTime(iso(800 * 24), NOW), '2년 전', '2년 전');
eq(C.relativeTime('nonsense', NOW), '—', '잘못된 날짜');

/* ---------------------------------------------------------- */
group('computeMetrics');
const base = {
  id: 't1', views: 540000, likes: 29200, comments: 1180,
  avgViews: 200000, postedAt: iso(18), platform: 'youtube', country: 'KR',
};
const m1 = C.computeMetrics(base, NOW);
near(m1.viralMultiple, 2.7, 1e-9, '배수 2.7');
near(m1.vph, 30000, 1e-6, 'VPH 3만');
near(m1.engagementRate, 5.626, 0.001, '참여율 5.626%');
eq(m1.score, 52, '떡상 점수 52');
eq(m1.tier, 'warm', '2.7x → warm');
eq(m1.pending, false, 'pending 아님');
eq(m1.parts.outlier + m1.parts.velocity + m1.parts.engagement + m1.parts.freshness > 50, true, '구성점수 합');

const future = C.computeMetrics(Object.assign({}, base, { postedAt: new Date(NOW + 3600000).toISOString() }), NOW);
near(future.vph, 540000 / 0.25, 1, '미래 게시 → 최소 0.25h로 계산');

const pending = C.computeMetrics(Object.assign({}, base, { views: null }), NOW);
eq(pending.score, null, '지표 없음 → 점수 null');
eq(pending.pending, true, 'pending true');
eq(C.formatMultiple(pending.viralMultiple), '—', 'pending 배수 —');

const zeroAvg = C.computeMetrics(Object.assign({}, base, { avgViews: 0 }), NOW);
eq(zeroAvg.viralMultiple, 0, '평균 0 → 배수 0');
ok(zeroAvg.score >= 0 && zeroAvg.score <= 100, '평균 0이어도 점수 범위');

const noViews = C.computeMetrics(Object.assign({}, base, { views: 0, likes: 0, comments: 0 }), NOW);
eq(noViews.score, 0, '조회 0 → 0점');
eq(noViews.engagementRate, 0, '조회 0 → 참여율 0');

group('computeScore');
eq(C.computeScore({ viralMultiple: 20, vph: 1000000, engagementRate: 12, hours: 6 }).score, 98, '만점 근처 98');
eq(C.computeScore({ viralMultiple: 100, vph: 10000000, engagementRate: 40, hours: 0 }).score, 100, '상한 100');
eq(C.computeScore({ viralMultiple: 0, vph: 0, engagementRate: 0, hours: 720 }).score, 0, '하한 0');
eq(C.computeScore({ viralMultiple: 5, vph: 100000, engagementRate: 6, hours: 24 }).score, 63, '중간값 63');
eq(C.computeScore({ viralMultiple: 1, vph: 1000, engagementRate: 3, hours: 168 }).score, 22, '저성과 22');
ok(C.computeScore({ viralMultiple: 6, vph: 1000, engagementRate: 3, hours: 24 }).score >
  C.computeScore({ viralMultiple: 3, vph: 1000, engagementRate: 3, hours: 24 }).score, '배수↑ → 점수↑');
ok(C.computeScore({ viralMultiple: 3, vph: 90000, engagementRate: 3, hours: 24 }).score >
  C.computeScore({ viralMultiple: 3, vph: 30000, engagementRate: 3, hours: 24 }).score, 'VPH↑ → 점수↑');
ok(C.computeScore({ viralMultiple: 3, vph: 30000, engagementRate: 9, hours: 24 }).score >
  C.computeScore({ viralMultiple: 3, vph: 30000, engagementRate: 1, hours: 24 }).score, '참여율↑ → 점수↑');
ok(C.computeScore({ viralMultiple: 3, vph: 30000, engagementRate: 5, hours: 2 }).score >
  C.computeScore({ viralMultiple: 3, vph: 30000, engagementRate: 5, hours: 400 }).score, '최신 → 점수↑');
const s1 = C.computeScore({ viralMultiple: 3, vph: 30000, engagementRate: 5, hours: 10 });
near(s1.parts.outlier + s1.parts.velocity + s1.parts.engagement + s1.parts.freshness, s1.score, 1.5, '구성 요소 합 ≈ 총점');

group('viralTier');
eq(C.viralTier(1.9), 'calm', '1.9 calm');
eq(C.viralTier(2), 'warm', '2 warm');
eq(C.viralTier(4.9), 'warm', '4.9 warm');
eq(C.viralTier(5), 'hot', '5 hot');
eq(C.viralTier(9.9), 'hot', '9.9 hot');
eq(C.viralTier(10), 'epic', '10 epic');
eq(C.viralTier(null), 'pending', 'null pending');

/* ---------------------------------------------------------- */
const demo = D.materializeDemo(NOW);

group('demo dataset');
eq(demo.length, 28, '데모 28건');
eq(new Set(demo.map((i) => i.id)).size, 28, 'id 중복 없음');
eq(Array.from(new Set(demo.map((i) => i.platform))).sort(), ['instagram', 'tiktok', 'youtube'], '플랫폼 3종');
eq(Array.from(new Set(demo.map((i) => i.country))).sort(), ['GL', 'KR'], '국가 2종');
eq(demo.filter((i) => i.product).length, 9, '커머스 9건');
ok(demo.every((i) => i.creator[0] === '@'), '모든 크리에이터 @핸들');
ok(demo.every((i) => i.views > i.likes && i.likes > i.comments), '조회 > 좋아요 > 댓글');
ok(demo.every((i) => i.avgViews > 0), '채널 평균 > 0');
ok(demo.every((i) => C.HOOK_TYPES.indexOf(i.hookType) !== -1), '훅 유형 유효');
ok(demo.every((i) => C.CATEGORIES.indexOf(i.category) !== -1), '카테고리 유효');
ok(demo.every((i) => i.hashtags.length > 0), '해시태그 존재');
ok(demo.every((i) => i.cover && D.PALETTES[i.cover.palette]), '팔레트 유효');
ok(demo.every((i) => i.cover.text.length >= 1 && i.cover.text.length <= 2), '커버 문구 1~2줄');
ok(demo.every((i) => i.durationSec > 0 && i.durationSec < 90), '길이 90초 미만');
ok(demo.every((i) => !isNaN(Date.parse(i.postedAt))), 'postedAt 유효');
ok(demo.every((i) => C.hoursSince(i.postedAt, NOW) <= 31), '모두 31시간 이내');
ok(demo.every((i) => C.computeMetrics(i, NOW).score > 0), '모든 데모 카드 점수 > 0');
ok(demo.filter((i) => C.computeMetrics(i, NOW).viralMultiple >= 10).length >= 2, '10x 이상 2건 이상');

/* ---------------------------------------------------------- */
group('filterItems');
const f = (o) => C.filterItems(demo, Object.assign({ platform: 'all', country: 'all', minMultiple: 0, period: 0, category: 'all' }, o), NOW);
eq(f({ platform: 'youtube' }).every((i) => i.platform === 'youtube'), true, '유튜브만');
eq(f({ platform: 'youtube' }).length, 9, '유튜브 9건');
eq(f({ platform: 'instagram' }).length, 12, '인스타 12건');
eq(f({ platform: 'tiktok' }).length, 7, '틱톡 7건');
eq(f({ country: 'GL' }).length, 5, 'GL 5건');
eq(f({ category: '푸드·맛집' }).every((i) => i.category === '푸드·맛집'), true, '카테고리 필터');
eq(f({ minMultiple: 5 }).every((i) => C.computeMetrics(i, NOW).viralMultiple >= 5), true, '5x+ 필터');
ok(f({ minMultiple: 10 }).length >= 2, '10x+ 2건 이상');
eq(f({ period: 24 }).every((i) => C.hoursSince(i.postedAt, NOW) <= 24), true, '24h 필터');
eq(f({ period: 24 }).length, demo.filter((i) => C.hoursSince(i.postedAt, NOW) <= 24).length, '24h 경계 포함');
eq(f({ period: 1 }).length, demo.filter((i) => C.hoursSince(i.postedAt, NOW) <= 1).length, '1h 필터');
eq(f({ commerceOnly: true }).every((i) => !!i.product), true, '커머스만');
eq(f({ platform: 'tiktok', country: 'KR' }).every((i) => i.platform === 'tiktok' && i.country === 'KR'), true, '복합 필터');
const exact5 = [{ id: 'e5', views: 500, avgViews: 100, likes: 10, comments: 1, postedAt: iso(2), platform: 'tiktok', country: 'KR', category: '기타' }];
eq(C.filterItems(exact5, { minMultiple: 5 }, NOW).length, 1, '정확히 5.0x 포함');
eq(C.filterItems(exact5, { minMultiple: 10 }, NOW).length, 0, '5.0x는 10x+ 제외');

group('실시간 수집만 (collectedOnly)');
const mkUser = (id, source) => ({
  id, source, platform: 'youtube', country: 'KR', category: '기타',
  creator: '@' + id, caption: id + ' 캡션', hashtags: [],
  views: 1000, likes: 50, comments: 5, avgViews: 200, postedAt: iso(5),
});
const userApi1 = mkUser('u-api-1', 'youtube-api');
const userApi2 = mkUser('u-api-2', 'youtube-api');
const userUrl = mkUser('u-url-1', 'url');
const userCsv = mkUser('u-csv-1', 'csv');
const userNone = mkUser('u-none', undefined);
const mixed = demo.concat([userApi1, userApi2, userUrl, userCsv, userNone]);
eq(mixed.filter(C.isCollected).map((i) => i.id), ['u-api-1', 'u-api-2', 'u-url-1', 'u-csv-1'], 'API·링크·CSV만 수집으로 인정');
ok(!C.isCollected(demo[0]), '데모 카드는 수집 아님');
ok(!C.isCollected(userNone), 'source 없으면 수집 아님');
ok(!C.isCollected(null), 'null/undefined 안전');
eq(C.COLLECTED_SOURCES, ['youtube-api', 'url', 'csv'], '수집 소스 3종');
eq(C.filterItems(mixed, { collectedOnly: true }, NOW).length, 4, '실시간 수집만 → 4건');
eq(C.filterItems(mixed, { collectedOnly: true }, NOW).filter((i) => !i.source).length, 0, '데모 28건 제외');
eq(C.filterItems(mixed, { collectedOnly: false }, NOW).length, mixed.length, '토글 off → 전체');
eq(C.filterItems(mixed, {}, NOW).length, mixed.length, '기본값 → 전체');
eq(C.filterItems(mixed, { collectedOnly: true, platform: 'youtube' }, NOW).length, 4, '플랫폼 조합');
eq(C.filterItems(mixed, { collectedOnly: true, platform: 'instagram' }, NOW).length, 0, '플랫폼 불일치 → 0');
eq(C.filterItems(mixed, { collectedOnly: true, minMultiple: 5 }, NOW).length, 4, '배수 5x 조합 (5.0x 포함)');
eq(C.filterItems(mixed, { collectedOnly: true, minMultiple: 10 }, NOW).length, 0, '배수 10x 조합 → 0');
eq(C.filterItems(mixed, { collectedOnly: true, country: 'KR', period: 24, category: 'all' }, NOW).length, 4, '국가·기간 조합');
eq(C.visibleItems(mixed, { filters: { collectedOnly: true }, query: '', sort: 'score' }, NOW).length, 4, 'visibleItems에도 동일 적용');
eq(C.visibleItems(mixed, { filters: {}, query: '', sort: 'score' }, NOW).length, mixed.length, 'visibleItems 기본은 전체');
ok(C.visibleItems(mixed, { filters: { collectedOnly: true }, query: '', sort: 'score' }, NOW).every(C.isCollected), '결과는 모두 수집 카드');

group('sortItems');
const byScore = C.sortItems(demo, 'score', NOW).map((i) => C.computeMetrics(i, NOW).score);
ok(byScore.every((v, idx) => idx === 0 || byScore[idx - 1] >= v), '점수 내림차순');
const byMult = C.sortItems(demo, 'multiple', NOW).map((i) => C.computeMetrics(i, NOW).viralMultiple);
ok(byMult.every((v, idx) => idx === 0 || byMult[idx - 1] >= v), '배수 내림차순');
const byVph = C.sortItems(demo, 'vph', NOW).map((i) => C.computeMetrics(i, NOW).vph);
ok(byVph.every((v, idx) => idx === 0 || byVph[idx - 1] >= v), 'VPH 내림차순');
const byNew = C.sortItems(demo, 'newest', NOW).map((i) => Date.parse(i.postedAt));
ok(byNew.every((v, idx) => idx === 0 || byNew[idx - 1] >= v), '최신순');
const tieA = { id: 'aaa', views: 1000, likes: 10, comments: 1, avgViews: 500, postedAt: iso(3) };
const tieB = { id: 'bbb', views: 1000, likes: 10, comments: 1, avgViews: 500, postedAt: iso(3) };
eq(C.sortItems([tieB, tieA], 'score', NOW).map((i) => i.id), ['aaa', 'bbb'], '동점 → id 순 안정 정렬');
eq(C.sortItems(demo, 'score', NOW).length, demo.length, '정렬 후 개수 유지');

group('searchItems');
eq(C.searchItems(demo, '만두').map((i) => i.id), ['ig-kr-01'], '캡션 검색: 만두');
eq(C.searchItems(demo, '@tech.park').map((i) => i.id), ['yt-kr-01'], '핸들 검색');
eq(C.searchItems(demo, '냉동만두').length, 1, '해시태그 검색');
eq(C.searchItems(demo, '').length, demo.length, '빈 검색어 → 전체');
eq(C.searchItems(demo, '   ').length, demo.length, '공백 검색어 → 전체');
ok(C.searchItems(demo, '테크').length >= 3, '카테고리 검색');
eq(C.searchItems(demo, '없는키워드zzz').length, 0, '결과 없음');
eq(C.searchItems(demo, 'LISBON').map((i) => i.id), ['gl-ig-01'], '대소문자 무시');
ok(C.searchItems(demo, '자취 요리').length >= 2, '복수 토큰 AND');

group('visibleItems');
const vis = C.visibleItems(demo, { filters: { platform: 'youtube', country: 'KR', minMultiple: 2, period: 24, category: 'all' }, query: '', sort: 'score' }, NOW);
ok(vis.length > 0, '조합 필터 결과 존재');
ok(vis.every((i) => i.platform === 'youtube' && i.country === 'KR' && C.hoursSince(i.postedAt, NOW) <= 24 && C.computeMetrics(i, NOW).viralMultiple >= 2), '조합 필터 정확');
eq(C.visibleItems(demo, { filters: {}, query: '만두', sort: 'score' }, NOW).length, 1, '검색 + 정렬');

/* ---------------------------------------------------------- */
group('parseVideoUrl');
eq(C.parseVideoUrl('https://www.youtube.com/shorts/abcDEF12345').platform, 'youtube', '쇼츠 URL');
eq(C.parseVideoUrl('https://www.youtube.com/shorts/abcDEF12345').id, 'abcDEF12345', '쇼츠 ID');
eq(C.parseVideoUrl('https://youtu.be/abcDEF12345').id, 'abcDEF12345', 'youtu.be');
eq(C.parseVideoUrl('https://www.youtube.com/watch?v=abcDEF12345&t=3').id, 'abcDEF12345', 'watch?v=');
eq(C.parseVideoUrl('https://www.youtube.com/embed/abcDEF12345').id, 'abcDEF12345', 'embed');
eq(C.parseVideoUrl('www.youtube.com/shorts/abcDEF12345').platform, 'youtube', '스킴 없는 URL');
const tt = C.parseVideoUrl('https://www.tiktok.com/@hello.world/video/7300000000000000001');
eq(tt.platform, 'tiktok', '틱톡 URL');
eq(tt.id, '7300000000000000001', '틱톡 ID');
eq(tt.handle, '@hello.world', '틱톡 핸들');
eq(C.parseVideoUrl('https://www.instagram.com/reel/CxYz_12345/').platform, 'instagram', '릴스 URL');
eq(C.parseVideoUrl('https://www.instagram.com/reel/CxYz_12345/').id, 'CxYz_12345', '릴스 코드');
eq(C.parseVideoUrl('https://www.instagram.com/p/CxYz_12345/').platform, 'instagram', '피드 URL');
eq(C.parseVideoUrl('https://youtube.com.evil.com/shorts/abcDEF12345'), null, '사칭 도메인 거부');
eq(C.parseVideoUrl('https://vimeo.com/12345'), null, '미지원 도메인');
eq(C.parseVideoUrl(''), null, '빈 문자열');
eq(C.parseVideoUrl('그냥 텍스트'), null, 'URL 아님');

group('parseISODuration');
eq(C.parseISODuration('PT45S'), 45, '45초');
eq(C.parseISODuration('PT1M2S'), 62, '1분 2초');
eq(C.parseISODuration('PT1H'), 3600, '1시간');
eq(C.parseISODuration('P0D'), 0, '0');
eq(C.parseISODuration('garbage'), 0, '잘못된 값');

group('normalizeNumber');
eq(C.normalizeNumber('1.2만'), 12000, '1.2만');
eq(C.normalizeNumber('54만'), 540000, '54만');
eq(C.normalizeNumber('1,200'), 1200, '콤마');
eq(C.normalizeNumber('2.5k'), 2500, 'k');
eq(C.normalizeNumber('1.3M'), 1300000, 'M');
eq(C.normalizeNumber('1.2억'), 120000000, '억');
eq(C.normalizeNumber(''), null, '빈 값');
eq(C.normalizeNumber('—'), null, '대시');
eq(C.normalizeNumber('12,345회'), 12345, '한글 단위');

group('parseCsv');
const rows = C.parseCsv('a,b,c\r\n1,"x,y",3\n4,"he said ""hi""",6');
eq(rows.length, 3, '3행');
eq(rows[1][1], 'x,y', '따옴표 안 콤마');
eq(rows[2][1], 'he said "hi"', '이중 따옴표');
const rows2 = C.parseCsv('\uFEFFh1,h2\n"line1\nline2",2');
eq(rows2[1][0], 'line1\nline2', '따옴표 안 줄바꿈');
eq(rows2[0][0], 'h1', 'BOM 제거');

group('csvToItems');
const parsed = C.csvToItems(C.SAMPLE_CSV, { nowMs: NOW });
eq(parsed.items.length, 2, '샘플 CSV 2건');
eq(parsed.items[0].views, 540000, '조회수 파싱');
eq(parsed.items[0].platform, 'youtube', '플랫폼 매핑');
eq(parsed.items[0].category, '푸드·맛집', '카테고리');
eq(parsed.items[0].caption, '냉동만두, 물 없이 굽는 법', '따옴표 캡션');
eq(parsed.items[0].hashtags, ['#냉동만두', '#자취요리'], '해시태그');
near(C.hoursSince(parsed.items[0].postedAt, NOW), 18, 0.01, '경과 시간');
eq(parsed.items[1].platform, 'tiktok', '틱톡 매핑');
eq(parsed.errors.length, 0, '오류 없음');
const kr = C.csvToItems('제목,조회수,좋아요,댓글,평균조회수,경과시간,카테고리\n테스트 영상,"1.2만",300,20,4000,5,테크·AI', { nowMs: NOW });
eq(kr.items.length, 1, '한글 헤더 1건');
eq(kr.items[0].views, 12000, '한글 헤더 조회수');
eq(kr.items[0].category, '테크·AI', '한글 카테고리');
const badRows = C.csvToItems('views,likes\n,5\n1000,10', { nowMs: NOW });
eq(badRows.items.length, 1, '빈 행 스킵');
ok(badRows.errors.length >= 1, '오류 보고');
eq(C.csvToItems('', { nowMs: NOW }).errors.length, 1, '빈 CSV 오류');
eq(C.csvToItems('zzz,qqq\n1,2', { nowMs: NOW }).items.length, 0, '헤더 인식 실패');
const unsafe = C.csvToItems('url,views\njavascript:alert(1),1000', { nowMs: NOW }).items[0];
eq(unsafe.url, '', 'javascript: 링크 차단');
const safeU = C.csvToItems('url,views\nhttps://youtu.be/abcdef12345,1000', { nowMs: NOW }).items[0];
ok(safeU.url.indexOf('https://') === 0, 'http 링크 유지');

group('toCsv');
const cols = [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }];
const csv = C.toCsv([{ a: 'x,y', b: 'he said "hi"' }, { a: 'line\nbreak', b: 3 }], cols);
eq(csv.split('\r\n')[0], 'A,B', '헤더');
eq(csv.indexOf('"x,y"') !== -1, true, '콤마 이스케이프');
eq(csv.indexOf('"he said ""hi"""') !== -1, true, '따옴표 이스케이프');
const round = C.parseCsv(csv);
eq(round.length, 3, '라운드트립 행 수');
eq(round[1][0], 'x,y', '라운드트립 값');
eq(round[2][0], 'line\nbreak', '줄바꿈 보존');

/* ---------------------------------------------------------- */
group('board');
eq(C.normalizeStatus('saved'), 'saved', '유효 상태');
eq(C.normalizeStatus('nope'), null, '잘못된 상태');
eq(C.nextStatus('saved'), 'scripting', '저장 → 각색');
eq(C.nextStatus('scripting'), 'shooting', '각색 → 촬영');
eq(C.nextStatus('shooting'), 'done', '촬영 → 업로드');
eq(C.nextStatus('done'), 'done', '마지막 단계 유지');
eq(C.nextStatus('nope'), 'saved', '잘못된 상태 → 첫 단계');
eq(C.prevStatus('done'), 'shooting', '역방향');
eq(C.prevStatus('saved'), 'saved', '첫 단계 유지');
const board = { 'ig-kr-01': { status: 'saved', memo: 'a,b', tags: ['훅'], addedAt: '2026-11-21T00:00:00Z' }, 'yt-kr-01': { status: 'done' }, 'gl-tt-01': { status: 'weird' } };
const groups = C.boardGroups(demo, board);
eq(groups.length, 4, '칸반 4열');
eq(groups[0].id, 'saved', '첫 열 saved');
eq(groups[0].items.length, 2, '이상한 상태 → saved로 집계');
eq(groups[3].items.length, 1, 'done 1건');
eq(C.boardRows(demo.filter((i) => board[i.id]), board, NOW)[0].statusLabel, '레퍼런스 저장', '상태 라벨');
const bCsv = C.toBoardCsv(demo.filter((i) => board[i.id]), board, NOW);
ok(bCsv.indexOf('"a,b"') !== -1, '메모 콤마 이스케이프');
ok(bCsv.split('\r\n').length === 4, '보드 CSV 행 수');
const radarCsv = C.toRadarCsv(demo, NOW);
eq(radarCsv.split('\r\n').length, 29, '레이더 CSV 28행 + 헤더');
ok(radarCsv.indexOf('바이럴 배수') !== -1, '레이더 CSV 헤더');

group('hook analysis');
const hStats = C.hookStats(demo, NOW);
eq(hStats.length, 4, '훅 4종');
eq(hStats.reduce((a, s) => a + s.count, 0), demo.length, '훅 통계 합계');
ok(hStats.every((s, i) => i === 0 || hStats[i - 1].avgScore >= s.avgScore), '평균 점수 정렬');
const item1 = demo.find((i) => i.id === 'ig-kr-01');
const ana = C.buildHookAnalysis(item1);
eq(ana.beats.length, 5, '5비트');
eq(ana.beats[0].range, '0~3초', '첫 비트 0~3초');
eq(ana.beats[4].range, '22~25초', '마지막 22~25초');
eq(ana.type, '충격숫자', '훅 유형');
const script = C.buildScript(item1, { product: '테스트 제품' });
ok(script.indexOf('[0~3초 · 훅]') !== -1, '대본 훅');
ok(script.indexOf('테스트 제품') !== -1, '대본에 제품 반영');
ok(script.indexOf('CTA') !== -1, '대본 CTA');
ok(script.indexOf('촬영 메모') !== -1, '촬영 메모');
const prompt = C.buildPrompt(item1, {});
ok(prompt.indexOf('"hook_type": "충격숫자"') !== -1, '프롬프트 훅 유형');
ok(prompt.indexOf('[규칙]') !== -1, '프롬프트 규칙');
ok(prompt.indexOf('AI 요약체') !== -1, '말투 규칙');
eq(C.hookLibrary('없는유형').type, '질문형', '알 수 없는 훅 → 기본');
eq(C.hookLibrary('비교').type, '비교', '훅 라이브러리 조회');

group('channelBaseline');
eq(C.channelBaseline([100, 200, 300], null).avgViews, 200, '중앙값 3개');
eq(C.channelBaseline([100, 200, 300], null).basis, 'collected', 'basis collected');
eq(C.channelBaseline([100, 200, 300, 400], null).avgViews, 250, '짝수 중앙값');
eq(C.channelBaseline([100, 200], { viewCount: 9000, videoCount: 3 }).avgViews, 3000, '표본 2개 → 채널 평균');
eq(C.channelBaseline([100, 200], { viewCount: 9000, videoCount: 3 }).basis, 'channel-avg', 'basis channel-avg');
eq(C.channelBaseline([100, 200], null).basis, 'collected-few', '표본 부족');
eq(C.channelBaseline([], { viewCount: 0, videoCount: 0, subscriberCount: 1000 }).avgViews, 600, '구독자 추정');
eq(C.channelBaseline([], null).avgViews, 0, '기준 없음');
eq(C.median([]), 0, '빈 중앙값');
eq(C.median([5, 1, 3]), 3, '정렬 없는 중앙값');

group('quota');
eq(C.quotaDateKey(NOW), '2026-11-20', 'KST 09시 → PT 전날');
eq(C.quotaDateKey(Date.parse('2026-11-21T08:00:00Z')), '2026-11-21', 'UTC 08시 → PT 같은 날');
const q1 = C.bumpQuota(null, NOW, 1, 0);
eq(q1.search, 1, '첫 검색');
eq(q1.units, 0, '유닛 0');
const q2 = C.bumpQuota(q1, NOW, 1, 2);
eq(q2.search, 2, '검색 누적');
eq(q2.units, 2, '유닛 누적');
const q3 = C.bumpQuota(q2, NOW + 86400000, 1, 0);
eq(q3.search, 1, '다음 날 리셋');

group('summarize / itemTitle');
const sum = C.summarize(demo, NOW);
eq(sum.count, 28, '요약 개수');
ok(sum.avgMultiple > 1 && sum.avgMultiple < 10, '평균 배수 범위');
ok(sum.bestScore >= 75, '최고 점수 75+');
ok(sum.best && sum.best.id, '최고 영상 존재');
ok(sum.fresh > 0 && sum.fresh <= 28, '24시간 급상승');
eq(sum.epic, demo.filter((i) => C.computeMetrics(i, NOW).tier === 'epic').length, 'epic 개수');
eq(C.itemTitle({ caption: '짧은 캡션' }), '짧은 캡션', '짧은 제목 유지');
eq(C.itemTitle({ caption: 'a'.repeat(60) }).length, 41, '긴 제목 자름');

/* ---------------------------------------------------------- */
group('카피 심리학 엔진');
const CP = require('./engines/copy-psych-engine.js');
ok(!!CP, 'engines/copy-psych-engine.js 로드');
eq(CP.VERSION, '1.0.0', '엔진 버전');
ok(typeof C.psychProfile === 'function', 'core: psychProfile 노출');
ok(typeof C.psychRewrite === 'function', 'core: psychRewrite 노출');
ok(typeof C.buildBridgePrompt === 'function', 'core: buildBridgePrompt 노출');

const psyItem = demo.find((i) => i.id === 'ig-kr-01');
const prof = C.psychProfile(psyItem);
eq(prof.ok, true, '진단 ok');
eq(prof.triggers.length, 8, '트리거 8개');
eq(prof.triggers.map((t) => t.id), ['loss', 'anchor', 'curiosity', 'interrupt', 'social', 'scarcity', 'authority', 'cta'], '트리거 순서');
ok(prof.text.indexOf('냉동만두') !== -1, '진단 대상 = 제목·훅');
ok(prof.text.indexOf('레시피 저장') !== -1, 'CTA 포함');
ok(prof.total >= 0 && prof.total <= 100, '총점 범위');
ok(prof.coverage >= 1 && prof.coverage <= 8, '커버리지 범위');
ok(prof.gaps.length > 0, '빈틈 존재');
ok(prof.gaps[0].impact >= prof.gaps[1].impact, '빈틈은 영향도 순');
ok(prof.gaps.some((g) => g.id === 'loss'), '손실 회피 빈틈');
eq(prof.grade.id, CP.gradeOf(prof.total).id, '등급 일치');
eq(C.psychProfile(psyItem).total, prof.total, '결정적(같은 입력 → 같은 점수)');
ok(prof.triggers.every((t) => t.score >= 0 && t.score <= 100 && t.weight > 0), '트리거 점수·가중치 범위');
ok(prof.triggers.every((t) => t.name && t.fix), '트리거 이름·교정안');

const emptyProf = C.psychProfile(null, { text: '' });
eq(emptyProf.ok, true, '빈 문구도 안전');
eq(emptyProf.total, 0, '빈 문구 0점');
eq(emptyProf.flags.empty, true, '빈 문구 플래그');
eq(emptyProf.coverage, 0, '빈 문구 커버리지 0');

C.CATEGORIES.forEach((cat) => {
  ok(C.PSY_AUDIENCE[cat] && C.PSY_PROBLEM[cat] && C.PSY_SOLUTION[cat], '카테고리 기본 문장 ' + cat);
});
eq(C.psychProfile({ ...psyItem, category: '없는분류' }).ok, true, '알 수 없는 카테고리도 안전');

group('리라이팅 입력');
const pin = C.psychInputFor(psyItem);
eq(pin.product, '프리미엄 왕교자 1.05kg', '상품명 자동');
eq(pin.target, C.PSY_AUDIENCE['푸드·맛집'], '타깃 자동');
ok(pin.problem.length > 5 && pin.solution.length > 5, '문제·해결 초안');
eq(pin.proof, '', '근거 숫자는 비움(레퍼런스 수치 도용 금지)');
ok(pin.cta.length > 0, 'CTA 초안');
eq(pin.urgency, '', '기한은 지어내지 않음');
const noProd = demo.find((i) => !i.product);
eq(C.psychInputFor(noProd, { product: '테스트 청소기' }).product, '테스트 청소기', '내 제품 덮어쓰기');
ok(C.psychInputFor(noProd).product.indexOf('내 버전') !== -1, '상품 없으면 키워드 기반');
eq(C.psychInputFor(psyItem, { problem: '   ' }).problem, C.PSY_PROBLEM['푸드·맛집'], '공백은 기본 문장으로');

group('프레임워크 4종');
const rw = C.psychRewrite(psyItem);
eq(rw.ok, true, 'generateAll ok');
eq(rw.items.length, 4, '4종 생성');
eq(rw.items.map((i) => i.id).sort(), ['4U', 'AIDA', 'BAB', 'PAS'], '4종 id');
ok(rw.best && rw.best.psych, 'best 존재');
eq(rw.best.id, rw.comparison[0].id, 'best = 비교 1위');
ok(rw.items.every((i) => i.psych.total <= rw.best.psych.total), 'best가 최고 점수');
const pas = C.psychFramework(psyItem, 'PAS');
eq(pas.ok, true, 'PAS 생성');
eq(pas.fw.sections.length, 3, 'PAS 3단');
eq(pas.fw.sections.map((s) => s.label), ['문제', '자극', '해결'], 'PAS 라벨');
const aida = C.psychFramework(psyItem, 'aida');
eq(aida.ok, true, '소문자 id 허용');
eq(aida.fw.sections.length, 4, 'AIDA 4단');
eq(C.psychFramework(psyItem, 'NOPE').ok, false, '알 수 없는 프레임워크');
ok(pas.fw.coverage >= 0 && pas.fw.coverage <= 8, '초안 커버리지 범위');
ok(pas.fw.title.length > 0 && pas.fw.body.length > 50, '제목·본문 생성');
ok(pas.fw.body.indexOf('프리미엄 왕교자') !== -1, '본문에 내 제품');
const rwCustom = C.psychRewrite(psyItem, { product: '내 무선 청소기', proof: '4주 실측 62명, 재구매 68%', urgency: '금요일 23시 마감' });
ok(rwCustom.items.every((i) => (i.body + i.title).indexOf('내 무선 청소기') !== -1), '모든 안에 내 제품');
ok(rwCustom.items.some((i) => /62명|68%/.test(i.body)), '근거 숫자 반영');
ok(rwCustom.items.some((i) => i.body.indexOf('금요일 23시') !== -1), '기한 반영');
const fwText = C.psychFrameworkText(psyItem, 'BAB');
ok(fwText.indexOf('[BAB]') === 0, '복사 텍스트 헤더');
ok(fwText.indexOf('제목:') !== -1 && fwText.indexOf('· 이전:') !== -1, '복사 텍스트 섹션');
ok(fwText.indexOf('초안입니다') !== -1, '복사 텍스트 주의');
eq(C.psychFrameworkText(psyItem, 'NOPE'), '', '없는 프레임워크 → 빈 문자열');
const allBodies = ['PAS', 'BAB', 'AIDA', '4U'].map((id) => C.psychFramework(psyItem, id).fw.body).join(' ');
ok(allBodies.indexOf('는는') === -1 && allBodies.indexOf('을를') === -1, '조사 중복 없음');
ok(allBodies.indexOf('수납함는') === -1, '번역체 조사 없음');

/* ---------------------------------------------------------- */
group('AI 브리지 프롬프트');
const bp = C.buildBridgePrompt(psyItem, { product: '내 무선 청소기' });
ok(bp.indexOf('[레퍼런스]') !== -1, '레퍼런스 블록');
ok(bp.indexOf('냉동만두') !== -1, '제목 포함');
ok(bp.indexOf('2.7x') !== -1, '바이럴 배수 포함');
ok(bp.indexOf('조회 254만') !== -1, '조회수 포함');
ok(bp.indexOf('[이 제목·훅의 심리 트리거]') !== -1, '심리 진단 포함');
ok(bp.indexOf('커버리지') !== -1, '커버리지 표기');
ok(bp.indexOf('내 무선 청소기') !== -1, '내 제품 포함');
ok(bp.indexOf('[출력 형식]') !== -1 && bp.indexOf('[규칙]') !== -1, '출력·규칙 블록');
ok(bp.indexOf('레퍼런스 수치를 내 실적처럼 쓰지 않는다') !== -1, '수치 도용 금지');
ok(bp.indexOf('반말 구어체') !== -1, '말투 규칙');
ok(bp.indexOf('30초') !== -1, '30초 대본');
ok(bp.length > 600 && bp.length < 4000, '프롬프트 길이');
const bpPending = C.buildBridgePrompt({ ...psyItem, views: null });
ok(bpPending.indexOf('- 성과:') === -1, '지표 없으면 성과 줄 생략');
ok(bpPending.indexOf('[레퍼런스]') !== -1, '지표 없어도 프롬프트 생성');
ok(bpPending.indexOf('미확인') !== -1 || bpPending.indexOf('커버리지') !== -1, '지표 없어도 진단');

/* ---------------------------------------------------------- */
group('AI 대본 읽기 (scriptMeta)');
const sampleScript = [
  '[0~3초 · 훅] 냉동만두, 물 없이.',
  '| 3~8초 | 문제 | 저녁 30분이 사라진다 |',
  '| 8~15초 | 증거 | 팬 하나로 10분 |',
  '| 15~22초 | 반전 | 핵심은 물이 아니었다 |',
  '| 22~30초 | CTA | 저장하고 한 번만 |',
  '가'.repeat(120),
].join('\n');
const sm = C.scriptMeta(sampleScript);
eq(sm.beats.length, 5, '비트 5개');
eq(sm.beats[0].range, '0~3초', '첫 비트');
eq(sm.hasHook, true, '훅 감지');
eq(sm.hasCta, true, 'CTA 감지');
ok(sm.chars > 100, '글자수 계산');
eq(sm.warnings.length, 0, '경고 없음');
eq(C.scriptMeta('[0~3초 훅] 짧음').warnings.length >= 1, true, '짧은 대본 경고');
const smFence = C.scriptMeta('```\n[0~3초] 훅\n' + '가'.repeat(100) + '\n```');
ok(smFence.text.indexOf('```') === -1, '코드블록 제거');
ok(smFence.warnings.some((w) => w.indexOf('코드블록') !== -1), '코드블록 경고');
eq(C.scriptMeta('').warnings.length, 1, '빈 대본 경고');
eq(C.scriptMeta('').chars, 0, '빈 대본 0자');

/* ---------------------------------------------------------- */
group('레퍼런스 분석팩 · yt-dlp');
const ytDemo = demo.find((i) => i.id === 'yt-kr-01');
const pack = C.buildReferencePack(ytDemo, { nowMs: NOW });
ok(pack.txt.indexOf('떡상 레이더 · 레퍼런스 분석팩') === 0, 'TXT 헤더');
ok(pack.txt.indexOf('생성 2026-11-21 09:00 (KST)') !== -1, 'TXT 생성 시각(KST)');
ok(pack.txt.indexOf('제목: ' + ytDemo.caption) !== -1, 'TXT 제목');
ok(pack.txt.indexOf('크리에이터: @tech.park (테크박)') !== -1, 'TXT 크리에이터');
ok(pack.txt.indexOf('플랫폼: 유튜브 · KR') !== -1, 'TXT 플랫폼');
ok(pack.txt.indexOf('13.5x') !== -1, 'TXT 바이럴 배수');
ok(pack.txt.indexOf('조회수: 840만') !== -1, 'TXT 조회수');
ok(pack.txt.indexOf(ytDemo.hookText) !== -1, 'TXT 훅 문구');
ok(pack.txt.indexOf('유형: 충격숫자') !== -1, 'TXT 훅 유형');
eq((pack.txt.match(/\| (훅|문제 제기|증거·시연|반전·정리|CTA) \|/g) || []).length, 5, 'TXT 5비트 구성');
ok(pack.txt.indexOf('[바로 쓰는 대본 템플릿]') !== -1 && pack.txt.indexOf('[0~3초 · 훅]') !== -1, 'TXT 대본/구성');
ok(pack.txt.indexOf('#노트북추천 #가성비 #테크리뷰') !== -1, 'TXT 해시태그');
ok(pack.txt.indexOf('원본: (데모 카드') !== -1, 'TXT 데모 카드 원본 안내');
ok(pack.txt.indexOf('CORS') !== -1 && pack.txt.indexOf('yt-dlp') !== -1, 'TXT 기술 한계 안내');
ok(pack.txt.indexOf('카드 PNG') !== -1, 'TXT 카드 PNG 안내');
const pj = JSON.parse(pack.json);
eq(pj.kind, 'reference-pack', 'JSON kind');
eq(pj.version, 1, 'JSON 버전');
eq(pj.reference.title, ytDemo.caption, 'JSON 제목');
eq(pj.reference.creator, '@tech.park', 'JSON 크리에이터');
eq(pj.reference.platform, 'youtube', 'JSON 플랫폼');
eq(pj.reference.hashtags, ['#노트북추천', '#가성비', '#테크리뷰'], 'JSON 해시태그');
eq(pj.reference.url, '', 'JSON 데모 URL 없음');
eq(pj.metrics.views, 8400000, 'JSON 조회수');
near(pj.metrics.viralMultiple, 13.54, 0.05, 'JSON 바이럴 배수');
ok(pj.metrics.score > 0 && pj.metrics.score <= 100, 'JSON 점수 범위');
eq(pj.hook.type, '충격숫자', 'JSON 훅 유형');
eq(pj.hook.beats.length, 5, 'JSON 5비트');
ok(pj.script.indexOf('[0~3초 · 훅]') !== -1, 'JSON 대본');
eq(pj.download.command, '', 'URL 없으면 명령 없음');
eq(pj.assets.youtubeThumbnail, null, '데모는 썸네일 없음');
ok(pack.files.txt.endsWith('.txt') && pack.files.json.endsWith('.json'), '파일명 확장자');
eq(pack.files.txt, C.packFilename(ytDemo, 'txt'), '파일명 = packFilename');
ok(pack.files.txt.indexOf('/') === -1 && pack.files.txt.indexOf(':') === -1, '파일명에 경로 문자 없음');
eq(C.buildReferencePack(ytDemo, { nowMs: NOW }).txt, pack.txt, '결정적(같은 입력 → 같은 팩)');

const ytReal = {
  id: 'url-youtube-VidA000001', platform: 'youtube', country: 'KR', creator: '@sample.ch', creatorName: '샘플 채널',
  category: '푸드·맛집', caption: '자취 요리 10분 저녁, 재료 3개면 끝', hashtags: ['#자취', '#요리'],
  views: 3000000, likes: 140000, comments: 5200, avgViews: 600000, postedAt: iso(10), durationSec: 28,
  hookType: '충격숫자', hookText: '재료 3개로 10분 저녁',
  url: 'https://www.youtube.com/shorts/VidA000001', videoId: 'VidA000001',
  thumbnail: 'https://i.ytimg.com/vi/VidA000001/hqdefault.jpg',
};
const rp = C.buildReferencePack(ytReal, { nowMs: NOW });
ok(rp.txt.indexOf('yt-dlp -f "bv*+ba/b" --merge-output-format mp4 "https://www.youtube.com/shorts/VidA000001"') !== -1, 'TXT yt-dlp 명령');
ok(rp.txt.indexOf('https://i.ytimg.com/vi/VidA000001/maxresdefault.jpg') !== -1, 'TXT 고해상도 썸네일');
ok(rp.txt.indexOf('조회수: 300만') !== -1 && rp.txt.indexOf('5x') !== -1, 'TXT 실측 수치');
eq(C.ytdlpCommand(''), '', 'URL 없으면 빈 명령');
eq(C.ytdlpCommand('https://a.b'), 'yt-dlp -f "bv*+ba/b" --merge-output-format mp4 "https://a.b"', '명령 형식');
eq(C.youtubeVideoId(ytReal), 'VidA000001', 'videoId 직접 추출');
eq(C.youtubeVideoId({ url: 'https://youtu.be/abcDEF12345' }), 'abcDEF12345', '짧은 URL에서 추출');
eq(C.youtubeVideoId({ url: 'https://www.youtube.com/watch?v=WatchID1234' }), 'WatchID1234', 'watch URL에서 추출');
eq(C.youtubeVideoId({ thumbnail: 'https://i.ytimg.com/vi/ThumbID1234/hqdefault.jpg' }), 'ThumbID1234', '썸네일에서 추출');
eq(C.youtubeVideoId(ytDemo), '', '데모 카드는 ID 없음');
eq(C.youtubeVideoId(null), '', 'null 안전');
eq(C.youtubeThumbUrl(ytDemo, 'maxresdefault'), '', 'ID 없으면 썸네일 URL 없음');
eq(C.youtubeThumbUrl(ytReal, 'maxresdefault'), 'https://i.ytimg.com/vi/VidA000001/maxresdefault.jpg', '썸네일 URL 형식');
eq(C.youtubeThumbUrl(ytReal, 'nope'), 'https://i.ytimg.com/vi/VidA000001/hqdefault.jpg', '알 수 없는 화질 → hq');
eq(C.youtubeThumbUrls(ytReal).length, 5, '화질 5종');
eq(C.youtubeThumbUrls(ytDemo).length, 0, 'ID 없으면 0종');
const rj = JSON.parse(rp.json);
eq(rj.reference.videoId, 'VidA000001', 'JSON videoId');
eq(rj.reference.url, 'https://www.youtube.com/shorts/VidA000001', 'JSON 원본 URL');
eq(rj.download.command.indexOf('yt-dlp'), 0, 'JSON 명령 시작');
eq(rj.assets.youtubeThumbnail, 'https://i.ytimg.com/vi/VidA000001/maxresdefault.jpg', 'JSON 썸네일');
const packPending = C.buildReferencePack(Object.assign({}, ytReal, { views: null }), { nowMs: NOW });
ok(packPending.txt.indexOf('조회수: 미확인') !== -1, '지표 없으면 미확인');
eq(JSON.parse(packPending.json).metrics.score, null, 'JSON 점수 null');
eq(C.packStamp(NOW), '2026-11-21 09:00 (KST)', '팩 시각 표기');

/* ---------------------------------------------------------- */
/* 오픈소스 엔진: PapaParse(MIT) · simple-statistics(ISC) · Chart.js(MIT) */
/* ---------------------------------------------------------- */
group('stats-engine · CSV (PapaParse)');
const S = require('./engines/stats-engine.js');
ok(S.hasPapa === true, 'PapaParse 로드');
ok(S.hasSS === true, 'simple-statistics 로드');
eq(S.hasChart, false, 'node 에서 Chart.js 는 없음(브라우저 전용)');
eq(S.parseCsv('\uFEFFurl,views\n"a,b",1200\n"줄\n바꿈",3400\n').length, 3, 'BOM + 따옴표 쉼표 + 따옴표 줄바꿈');
eq(S.parseCsv('')[0], undefined, '빈 문자열은 빈 배열');
const det = S.parseCsvDetailed('url;views\nx;10\ny;20\n');
eq(det.parser, 'papaparse', '상세 파서 표시');
eq(det.delimiter, ';', '세미콜론 자동 감지');
eq(det.rows.length, 3, '세미콜론 3행');
eq(S.parseCsvDetailed('url,views\nx,1\n').errors.length, 0, '정상 CSV 오류 0');
eq(S.parseCsv('a,b\n1,2\n3').length, 3, '열 수가 다른 행도 버리지 않음');

group('stats-engine · 분포 통계 (simple-statistics)');
const st5 = S.statsOf([1, 2, 3, 4, 100]);
eq(st5.n, 5, '표본 수');
eq(st5.median, 3, '중앙값');
eq(st5.q1, 2, 'Q1');
eq(st5.q3, 4, 'Q3');
eq(st5.iqr, 2, 'IQR');
eq(st5.upperFence, 7, '상자 밖 경계');
eq(st5.outliers, [100], '이상치');
eq(st5.engine, 'simple-statistics', '엔진 표기');
eq(S.statsOf([0, -1, null, '', 'x']), null, '쓸 값이 없으면 null');
eq(S.statsOf([0, 0]), null, '0 은 조회수가 아니므로 제외');
near(S.statsOf(['1,200', '2,400']).mean, 1800, 0.01, '쉼표 문자열도 숫자로');
near(S.zScore(100, st5), (100 - 22) / st5.sd, 1e-9, 'z-score');
eq(S.zScore(3, { sd: 0 }), 0, '표준편차 0 이면 z=0');
const h = S.histogram([1, 2, 2, 3, 9, 10]);
eq(h.counts.reduce((a, b) => a + b, 0), 6, '히스토그램 합계 = 표본 수');
eq(h.labels.length, h.counts.length, '라벨 수 = 막대 수');
eq(S.histogram([5, 5, 5]).counts, [3], '모든 값이 같으면 한 칸');
eq(S.histogram([]).counts, [], '빈 배열');
ok(S.summaryKo(st5).indexOf('중앙값') === 0, '요약 문장');

group('stats-engine · core 연결');
eq(C.useStats(S), true, 'core 에 엔진 주입');
eq(C.statsEngine(), S, '엔진 보관');
eq(C.parseCsv('a,b\n"x\ny",2\n').length, 2, 'core parseCsv 가 PapaParse 사용');
const dNow = Date.parse('2026-11-21T09:00:00+09:00');
const demoItems = D.materializeDemo(dNow);
const dist = C.distributionOf(demoItems, dNow);
ok(dist.values.length >= 20, '데모 배수 표본 20건 이상', dist.values.length);
eq(dist.stats.engine, 'simple-statistics', '분포는 엔진으로 계산');
ok(dist.stats.median > 0, '중앙값 > 0');
ok(dist.histogram.counts.reduce((a, b) => a + b, 0) === dist.values.length, '분포 막대 합계 = 표본');
ok(dist.summary.indexOf('중앙값') === 0, '분포 요약');
ok(Math.abs(C.zScoreOf(dist.values[0], demoItems, dNow)) >= 0, 'z-score 계산');
eq(C.distributionOf([], dNow).stats, null, '표본 없으면 null');
const csvQuoted = C.csvToItems('\uFEFFurl,views,creator\n"https://www.youtube.com/shorts/Qq12345678",1000,"@a"\n"https://www.youtube.com/shorts/Qq12345679","2,000","@b"\n', { nowMs: dNow });
eq(csvQuoted.items.length, 2, '따옴표·쉼표 CSV 2건 수집');
eq(csvQuoted.items[1].views, 2000, '천 단위 쉼표 파싱');
ok(csvQuoted.items[0].id.indexOf('csv-') === 0, 'csv id 유지');
C.useStats(null);
const fallback = C.distributionOf(demoItems, dNow);
eq(fallback.stats.engine, undefined, '엔진 없으면 내장 통계');
ok(fallback.stats.median > 0, '엔진 없어도 중앙값');
eq(fallback.histogram, null, '엔진 없으면 히스토그램 없음');
C.useStats(S);

/* ---------------------------------------------------------- */
console.log('');
console.log('떡상 레이더 · core tests');
console.log('─'.repeat(52));
console.log('  PASS  ' + pass);
console.log('  FAIL  ' + failures.length);
if (failures.length) {
  console.log('');
  failures.forEach((f) => console.log('  ✗ [' + f.group + '] ' + f.label + (f.detail ? '  → ' + f.detail : '')));
  console.log('');
  process.exit(1);
}
console.log('  ALL TESTS PASSED');
