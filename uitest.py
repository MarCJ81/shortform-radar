#!/usr/bin/env python3
"""
떡상 레이더 · real-browser verification.

    python3 uitest.py

- Serves this folder over HTTP on 127.0.0.1 (never file://).
- Drives headless Chrome with a throwaway profile: no shared cookies or storage.
- Desktop 1440x900 and mobile 390x844 (DPR 3, touch).
- Checks: console errors, network 404/5xx, horizontal overflow, the 28-card radar,
  filters, sorting, search, detail modal, hook analysis, clipboard, team board
  (move / memo / persist / CSV / JSON / clear), account watchlist, AI tab,
  commerce tab, settings, the BYOK YouTube Data API flow against a mocked
  googleapis (request parameters, outlier maths, quota meter, 403/400 errors),
  the URL / CSV collectors and the reference download pack (9:16 PNG card,
  TXT/JSON analysis pack, source-link + yt-dlp clipboard, YouTube thumbnail).
- Saves preview-desktop.png, preview-mobile.png, preview-modal.png.
"""
import base64
import functools
import http.server
import io
import json
import os
import socket
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
CHROME = Path('/workspace/scratch/calc/bin/chrome-linux64/chrome')
LIBS = Path('/workspace/scratch/calc/libs')
# 헤드리스 Chrome은 실행 환경에 따라 sandbox 초기화에서 죽는다.
# --no-sandbox + 재시도로 한 번 실패해도 테스트가 멈추지 않게 한다.
CHROME_PROFILES = [
    ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--renderer-process-limit=2'],
    ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process', '--no-zygote', '--renderer-process-limit=1'],
    ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process', '--no-zygote',
     '--renderer-process-limit=1', '--js-flags=--single-threaded --max-old-space-size=192',
     '--disable-background-networking', '--disable-component-update', '--disable-extensions',
     '--disable-sync', '--disable-translate', '--metrics-recording-only', '--no-first-run'],
]
CHROME_ARGS = CHROME_PROFILES[0]
BASE = None
ok, fail = [], []


def launch_browser(playwright, tries=6, profiles=None):
    """Chrome 기동 재시도.

    이 실행 환경은 프로세스·스레드 한도(RLIMIT_NPROC)가 빠듯해
    보통 모드가 zygote/pthread 단계에서 죽는 일이 잨다.
    profiles 로 시도 순서를 바꿀 수 있다(0 일반 · 1 단일 · 2 단일+스레드 최소).
    """
    seq = profiles or [0, 0, 0, 1, 2, 2]
    last = None
    waits = [2, 3, 4, 5, 6]
    for i in range(tries):
        profile = seq[min(i, len(seq) - 1)]
        label = ['일반', '단일 프로세스', '단일 프로세스+스레드 최소'][profile]
        try:
            browser = playwright.chromium.launch(executable_path=str(CHROME), args=CHROME_PROFILES[profile])
            print(f'  · Chrome 기동 OK ({label} 모드, {i + 1}번째 시도)')
            return browser
        except Exception as exc:  # noqa: BLE001 - 브라우저 기동은 어떤 이유로든 실패할 수 있다
            last = exc
            msg = str(exc).splitlines()[0] if str(exc) else exc.__class__.__name__
            print(f'  ! Chrome 기동 실패 {i + 1}/{tries}: {msg}')
            time.sleep(waits[min(i, len(waits) - 1)])
    raise last


def check(label, cond, detail=''):
    if cond:
        ok.append(label)
        print(f'  PASS  {label}' + (f'  [{detail}]' if detail else ''))
    else:
        fail.append(f'{label}  [{detail}]')
        print(f'  FAIL  {label}  [{detail}]')


def section(name):
    print(f'\n■ {name}')


def free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    """정적 파일만 내보내는 조용한 핸들러 (요청 로그로 출력이 지저분해지지 않게)."""

    def log_message(self, fmt, *args):  # noqa: A003 - 부모 시그니처
        pass


class SerialServer(http.server.HTTPServer):
    """요청을 한 줄로 처리하는 서버.

    스레드 기반 서버는 이 환경의 프로세스/스레드 한도에서 'can't start new thread'로
    정적 파일 요청을 떨어뜨린다. 파일이 작으므로 순차 처리로 충분하다.
    """
    allow_reuse_address = True
    request_queue_size = 128


def start_server(port):
    """별도 프로세스 대신 이 프로세스 안에서 HTTP 서버를 띄운다(프로세스 수 절약)."""
    handler = functools.partial(QuietHandler, directory=str(HERE))
    srv = SerialServer(('127.0.0.1', port), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def overflow(page, ignore=('.tabs', '.chip-row', '.chip-scroll', '.summary', '.script-out', '.modal')):
    return page.evaluate("""(ignore) => {
        const w = document.documentElement.clientWidth;
        const bad = [];
        document.querySelectorAll('body *').forEach(el => {
            if (ignore.some(sel => el.closest(sel))) return;
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0 && (r.right > w + 1 || r.left < -1)) {
                bad.push((el.tagName + '.' + String(el.className || '')).slice(0, 60) + ' right=' + Math.round(r.right));
            }
        });
        return bad.slice(0, 6);
    }""", list(ignore))


def page_overflow(page):
    return page.evaluate("() => document.documentElement.scrollWidth - document.documentElement.clientWidth")


def settle(page, ms=120):
    """폰트·레이아웃이 끝난 뒤 다음 동작으로. 리로드 중 폰트 요청이 끊기는 경합을 줄인다."""
    try:
        page.evaluate("() => (document.fonts && document.fonts.ready) ? document.fonts.ready.then(() => true) : true")
    except Exception:
        pass
    page.wait_for_timeout(ms)


# ── mocked YouTube Data API ────────────────────────────────────────────────
PNG = base64.b64decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII='
)
CH_A = 'UCchanAAAAAAAAAAAAAAAA'
CH_B = 'UCchanBBBBBBBBBBBBBBBB'


def mock_thumbnail(w=640, h=360):
    """UI 테스트용 모의 YouTube 썸네일(16:9). 실제 hqdefault처럼 9:16 카드에서 가운데가 잘린다."""
    try:
        from PIL import Image, ImageDraw, ImageFont
    except Exception:
        return PNG
    img = Image.new('RGB', (w, h), (18, 20, 28))
    d = ImageDraw.Draw(img)
    for y in range(h):
        t = y / max(1, h - 1)
        d.line([(0, y), (w, y)], fill=(int(250 - 70 * t), int(96 - 30 * t), int(58 + 70 * t)))
    d.ellipse([w * 0.58, -h * 0.30, w * 1.10, h * 0.90], fill=(26, 24, 38))
    d.ellipse([w * 0.66, -h * 0.12, w * 0.94, h * 0.26], fill=(238, 236, 244))
    d.rounded_rectangle([w * 0.355, h * 0.53, w * 0.645, h * 0.81], radius=12, fill=(22, 20, 30))
    d.polygon([(w * 0.468, h * 0.585), (w * 0.468, h * 0.755), (w * 0.555, h * 0.67)], fill=(250, 60, 80))
    font_path = '/usr/local/lib/python3.12/site-packages/matplotlib/mpl-data/fonts/ttf/DejaVuSans-Bold.ttf'
    try:
        f1 = ImageFont.truetype(font_path, 15)
        f2 = ImageFont.truetype(font_path, 11)
    except Exception:
        f1 = f2 = ImageFont.load_default()
    d.text((w / 2, h * 0.27), 'MOCK THUMBNAIL', font=f1, fill=(255, 255, 255), anchor='mm')
    d.text((w / 2, h * 0.36), 'i.ytimg.com stand-in', font=f2, fill=(255, 226, 226), anchor='mm')
    buf = io.BytesIO()
    img.save(buf, 'PNG')
    return buf.getvalue()


THUMB = mock_thumbnail()

# Gemini 모의 응답: 5비트가 보이는 30초 대본
GEMINI_SCRIPT = '\n'.join([
    '[0~3초 · 훅] 냉동만두, 물 없이.',
    '| 3~8초 | 문제 | 저녁 30분이 사라진다 |',
    '| 8~15초 | 증거 | 팬 하나로 10분, 설거지 1개 |',
    '| 15~22초 | 반전 | 핵심은 물이 아니라 팬 예열이었다 |',
    '| 22~30초 | CTA | 저장해두고 이번 주에 한 번만 |',
    '',
    '촬영 컷: 1) 냉동만두 봉지 클로즈업 2) 팬 예열 3) 지글 소리 4) 접시에 담기 5) 한입',
    '첫 댓글: 물 없이 구워보신 분, 바닥 눌어붙었나요?',
])


# 무료 체험(Worker) 모의 응답: 같은 5비트 대본
FREE_SCRIPT = GEMINI_SCRIPT

def now_hours_ago(h):
    import datetime
    t = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=h)
    return t.strftime('%Y-%m-%dT%H:%M:%SZ')


def search_payload(n=4):
    titles = [
        ('VidA000001', CH_A, '자취 요리 10분 저녁, 재료 3개면 끝'),
        ('VidB000002', CH_A, '냉장고 정리 이렇게 하면 두 배'),
        ('VidC000003', CH_A, '3만원대 주방 꿀템 3주 써봤습니다'),
        ('VidD000004', CH_B, 'AI 툴 무료 3개만 남겼습니다'),
    ]
    items = []
    for vid, ch, title in titles[:n]:
        items.append({
            'id': {'kind': 'youtube#video', 'videoId': vid},
            'snippet': {
                'channelId': ch, 'channelTitle': '샘플 채널' if ch == CH_A else '샘플 채널B',
                'title': title, 'description': title + ' #자취 #꿀템',
                'publishedAt': now_hours_ago(10),
            },
        })
    return {'kind': 'youtube#searchListResponse', 'items': items}


def videos_payload(n=4):
    data = [
        ('VidA000001', CH_A, '자취 요리 10분 저녁, 재료 3개면 끝', 3000000, 140000, 5200, 'PT28S'),
        ('VidB000002', CH_A, '냉장고 정리 이렇게 하면 두 배', 300000, 12000, 400, 'PT41S'),
        ('VidC000003', CH_A, '3만원대 주방 꿀템 3주 써봤습니다', 600000, 31000, 1200, 'PT33S'),
        ('VidD000004', CH_B, 'AI 툴 무료 3개만 남겼습니다', 800000, 39000, 1600, 'PT25S'),
    ]
    items = []
    for vid, ch, title, views, likes, comments, dur in data[:n]:
        items.append({
            'id': vid,
            'snippet': {
                'channelId': ch, 'channelTitle': '샘플 채널' if ch == CH_A else '샘플 채널B',
                'title': title, 'description': title, 'publishedAt': now_hours_ago(10),
            },
            'statistics': {'viewCount': str(views), 'likeCount': str(likes), 'commentCount': str(comments)},
            'contentDetails': {'duration': dur},
        })
    return {'kind': 'youtube#videoListResponse', 'items': items}


def channels_payload():
    return {'kind': 'youtube#channelListResponse', 'items': [
        {'id': CH_A, 'snippet': {'title': '샘플 채널', 'customUrl': '@sample.kr'},
         'statistics': {'subscriberCount': '500000', 'viewCount': '100000000', 'videoCount': '1000'}},
        {'id': CH_B, 'snippet': {'title': '샘플 채널B', 'customUrl': '@sample.b'},
         'statistics': {'subscriberCount': '120000', 'viewCount': '50000000', 'videoCount': '500'}},
    ]}


def free_port_ok():
    return True


def main():
    global BASE
    port = free_port()
    BASE = f'http://127.0.0.1:{port}'
    srv = start_server(port)
    lib_dirs = [str(LIBS)]
    arch_libs = LIBS / 'x86_64-linux-gnu'
    if arch_libs.exists():
        lib_dirs.append(str(arch_libs))
    os.environ['LD_LIBRARY_PATH'] = ':'.join(lib_dirs) + ':' + os.environ.get('LD_LIBRARY_PATH', '')
    fontconf = Path('/workspace/scratch/fonts.conf')
    if fontconf.exists():
        os.environ['FONTCONFIG_FILE'] = str(fontconf)
        os.environ['FONTCONFIG_PATH'] = str(fontconf.parent)

    api_calls, api_queries = [], []

    def handle_api(route):
        url = route.request.url
        parsed = urllib.parse.urlparse(url)
        api_calls.append(url)
        q = urllib.parse.parse_qs(parsed.query)
        api_queries.append(q)
        if parset_query(q, 'q', '').startswith('__quota__'):
            route.fulfill(status=403, content_type='application/json', body=json.dumps(
                {'error': {'code': 403, 'message': 'The request cannot be completed because you have exceeded your quota.'}}))
            return
        if parset_query(q, 'q', '').startswith('__badkey__'):
            route.fulfill(status=400, content_type='application/json', body=json.dumps(
                {'error': {'code': 400, 'message': 'API key not valid. Please pass a valid API key.'}}))
            return
        if parsed.path.endswith('/search'):
            route.fulfill(status=200, content_type='application/json', body=json.dumps(search_payload()))
        elif parsed.path.endswith('/videos'):
            route.fulfill(status=200, content_type='application/json', body=json.dumps(videos_payload()))
        elif parsed.path.endswith('/channels'):
            route.fulfill(status=200, content_type='application/json', body=json.dumps(channels_payload()))
        else:
            route.fulfill(status=404, content_type='application/json', body='{}')

    with sync_playwright() as p:
        # 브라우저가 떠도 첫 페이지(렌더러)가 죽는 일이 있다. 한두 번은 다시 띄워 본다.
        browser, ctx, page = None, None, None
        boot_profiles = [[0, 0, 0, 1, 2, 2], [1, 1, 2, 2, 0, 0], [2, 2, 2, 2, 1, 0]]
        for attempt in range(3):
            browser = launch_browser(p, profiles=boot_profiles[attempt])
            try:
                ctx = browser.new_context(viewport={'width': 1440, 'height': 900}, device_scale_factor=1)
                ctx.grant_permissions(['clipboard-read', 'clipboard-write'], origin=BASE)
                page = ctx.new_page()
                break
            except Exception as exc:  # noqa: BLE001 - 렌더러 기동 실패
                print(f'  ! 첫 페이지 생성 실패 {attempt + 1}/3: {str(exc).splitlines()[0]}')
                try:
                    browser.close()
                except Exception:
                    pass
                time.sleep(3)
        if page is None:
            raise RuntimeError('Chrome 렌더러를 시작하지 못했습니다 (환경 자원 부족).')
        console_errors, page_errors, bad_responses, requests, net_console = [], [], [], [], []

        def on_console(m):
            if m.type != 'error':
                return
            if 'Failed to load resource' in m.text:
                net_console.append(m.text)      # expected only for the mocked 403/400
            else:
                console_errors.append(m.text)

        page.on('console', on_console)
        page.on('pageerror', lambda e: page_errors.append(str(e)))
        page.on('response', lambda r: bad_responses.append((r.status, r.url))
                if r.status >= 400 and '/youtube/v3/' not in r.url else None)
        page.on('request', lambda r: requests.append(r.url))
        page.on('requestfailed', lambda r: bad_responses.append(('failed', r.url)))

        # ── boot ──────────────────────────────────────────────
        section('부팅 · 데모 레이더')
        page.goto(BASE + '/', wait_until='networkidle')
        settle(page, 300)
        check('콘솔 JS 에러 0건', not console_errors, str(console_errors[:2]))
        check('페이지 에러 0건', not page_errors, str(page_errors[:2]))
        check('외부 요청 0건 (데모 모드)', all(u.startswith(BASE) for u in requests),
              str([u for u in requests if not u.startswith(BASE)][:2]))
        check('네트워크 실패·4xx 0건', not bad_responses, str(bad_responses[:3]))
        check('가로 넘침 없음 (1440)', page_overflow(page) == 0, page_overflow(page))
        check('타이틀', '떡상 레이더' in page.title(), page.title())

        cards = page.locator('#grid .card')
        check('레이더 카드 28건', cards.count() == 28, cards.count())
        check('요약 카운터 28', page.locator('#summary .stat b').first.inner_text().strip() == '28',
              page.locator('#summary .stat b').first.inner_text())

        cover_svg = page.evaluate("() => Array.from(document.querySelectorAll('#grid .card > .cover > svg')).length")
        check('커버 SVG 28개 (깨진 이미지 0)', cover_svg == 28, cover_svg)
        broken = page.evaluate("""() => Array.from(document.images).filter(i => i.complete && i.naturalWidth === 0).length""")
        check('깨진 <img> 0개', broken == 0, broken)
        empty_covers = page.evaluate("""() => Array.from(document.querySelectorAll('#grid .cover svg text')).length""")
        check('커버 후킹 자막 렌더', empty_covers >= 40, empty_covers)

        badges = page.evaluate("""() => {
            const out = {};
            document.querySelectorAll('#grid .card').forEach(c => {
                const p = c.querySelector('.badge.platform').getAttribute('data-p');
                out[p] = (out[p] || 0) + 1;
            });
            return out;
        }""")
        check('플랫폼 분포 12/9/7', badges.get('instagram') == 12 and badges.get('youtube') == 9 and badges.get('tiktok') == 7, badges)

        # metrics wiring: DOM values must equal the app's own computation
        m = page.evaluate("""() => {
            const s = window.__radar.state;
            const item = s.demo.find(i => i.id === 'ig-kr-01');
            const mm = window.RadarCore.computeMetrics(item, s.now);
            const card = document.querySelector('.card[data-id="ig-kr-01"]');
            return {
                views: item.views, multiple: card.querySelector('.badge.outlier').textContent,
                kpis: Array.from(card.querySelectorAll('.kpi .k-value')).map(e => e.textContent.trim()),
                score: mm.score, vph: window.RadarCore.formatVph(mm.vph),
                mult: window.RadarCore.formatMultiple(mm.viralMultiple),
            };
        }""")
        check('배수 배지 = 계산값', m['multiple'] == m['mult'], f"{m['multiple']} vs {m['mult']}")
        check('VPH KPI = 계산값', m['kpis'][2] == m['vph'], f"{m['kpis'][2]} vs {m['vph']}")
        check('점수 KPI = 계산값', m['kpis'][3] == str(m['score']), f"{m['kpis'][3]} vs {m['score']}")

        scores = page.evaluate("""() => Array.from(document.querySelectorAll('#grid .card'))
            .map(c => parseInt(c.querySelector('.kpi.score .k-value').textContent, 10))""")
        check('기본 정렬 = 떡상 점수 내림차순', scores == sorted(scores, reverse=True), scores[:6])

        section('필터 · 정렬 · 검색')
        page.click('[data-filter="platform"][data-value="instagram"]')
        page.wait_for_timeout(150)
        check('인스타 필터 12건', page.locator('#grid .card').count() == 12, page.locator('#grid .card').count())
        platforms = page.evaluate("""() => Array.from(document.querySelectorAll('#grid .badge.platform'))
            .map(e => e.getAttribute('data-p'))""")
        check('인스타 필터 결과만 노출', set(platforms) == {'instagram'}, set(platforms))

        page.click('[data-filter="platform"][data-value="all"]')
        page.click('[data-filter="minMultiple"][data-value="5"]')
        page.wait_for_timeout(150)
        mults = page.evaluate("""() => Array.from(document.querySelectorAll('#grid .badge.outlier'))
            .map(e => parseFloat(e.textContent))""")
        check('5x+ 필터: 모든 배지 ≥ 5', all(v >= 5 for v in mults) and len(mults) > 0, mults)

        page.click('[data-filter="minMultiple"][data-value="0"]')
        page.click('[data-filter="period"][data-value="24"]')
        page.wait_for_timeout(150)
        expected24 = page.evaluate("""() => {
            const s = window.__radar.state;
            return window.RadarCore.filterItems(s.demo, {period: 24}, s.now).length;
        }""")
        check('24h 필터 카운트 일치', page.locator('#grid .card').count() == expected24,
              f"{page.locator('#grid .card').count()} vs {expected24}")

        page.click('[data-filter="period"][data-value="0"]')
        page.click('[data-filter="category"][data-value="재테크·썰"]')
        page.wait_for_timeout(150)
        cats = page.evaluate("""() => Array.from(document.querySelectorAll('#grid .card .cat')).map(e => e.textContent)""")
        check('카테고리 필터', len(cats) > 0 and all(c == '재테크·썰' for c in cats), cats)

        page.click('#filterChips [data-action="reset-filters"]')
        page.wait_for_timeout(150)
        check('필터 초기화 28건', page.locator('#grid .card').count() == 28, page.locator('#grid .card').count())

        # ── '실시간 수집만' 토글 (수집 전) ──
        toggle = page.locator('[data-action="toggle-collected-only"]')
        check('실시간 수집만 토글 존재', toggle.count() == 1, toggle.count())
        check('토글 라벨', '실시간 수집만' in toggle.inner_text(), toggle.inner_text().replace('\n', ' '))
        check('토글 초기 off', toggle.get_attribute('aria-pressed') == 'false', toggle.get_attribute('aria-pressed'))
        check('토글 카운트 0', toggle.locator('.ft-count').inner_text().strip() == '0', toggle.locator('.ft-count').inner_text())
        toggle.click()
        page.wait_for_timeout(200)
        check('수집 전 토글 → 카드 0건', page.locator('#grid .card').count() == 0, page.locator('#grid .card').count())
        check('토글 on 상태', toggle.get_attribute('aria-pressed') == 'true', toggle.get_attribute('aria-pressed'))
        check('토글 is-on 클래스', 'is-on' in (toggle.get_attribute('class') or ''), toggle.get_attribute('class'))
        check('빈 상태 노출', page.locator('#empty').is_visible())
        check('빈 상태 수집 안내', '데모 28건은 숨겨져' in page.locator('#empty .muted').inner_text(),
              page.locator('#empty .muted').inner_text()[:60])
        toggle.click()
        page.wait_for_timeout(200)
        check('토글 off → 28건 복귀', page.locator('#grid .card').count() == 28, page.locator('#grid .card').count())

        page.fill('#searchInput', '만두')
        page.wait_for_timeout(250)
        check('캡션 검색 (만두) 1건', page.locator('#grid .card').count() == 1, page.locator('#grid .card').count())
        check('검색 결과 id', page.locator('#grid .card').first.get_attribute('data-id') == 'ig-kr-01',
              page.locator('#grid .card').first.get_attribute('data-id'))

        page.fill('#searchInput', '@tech.park')
        page.wait_for_timeout(250)
        check('핸들 검색 1건', page.locator('#grid .card').count() == 1, page.locator('#grid .card').count())

        page.fill('#searchInput', 'zzz없는키워드')
        page.wait_for_timeout(250)
        check('결과 없음 → 빈 상태', page.locator('#empty').is_visible(), page.locator('#empty').is_visible())

        page.click('#empty [data-action="reset-filters"]')
        page.wait_for_timeout(200)
        check('빈 상태에서 복귀 28건', page.locator('#grid .card').count() == 28, page.locator('#grid .card').count())

        page.select_option('#sortSelect', 'vph')
        page.wait_for_timeout(200)
        vph = page.evaluate("""() => {
            const s = window.__radar.state;
            return Array.from(document.querySelectorAll('#grid .card')).map(c => {
                const item = s.demo.find(i => i.id === c.dataset.id);
                return window.RadarCore.computeMetrics(item, s.now).vph;
            });
        }""")
        check('VPH 정렬 내림차순', vph == sorted(vph, reverse=True), [round(v) for v in vph[:4]])
        page.select_option('#sortSelect', 'score')
        page.wait_for_timeout(200)

        section('카드 상세 · 훅 분석')
        page.click('.card[data-id="yt-kr-01"] .cover')
        page.wait_for_timeout(350)
        check('상세 모달 열림', page.locator('.modal[role="dialog"]').is_visible())
        check('모달 제목 = 크리에이터', '@tech.park' in page.locator('.modal-head h2').inner_text(),
              page.locator('.modal-head h2').inner_text())
        check('훅 유형 pill', '충격숫자' in page.locator('.detail-meta .pill').first.inner_text(),
              page.locator('.detail-meta .pill').first.inner_text())
        beats = page.locator('.beat').count()
        check('영상 구조 5비트', beats == 5, beats)
        check('0~3초 훅 표시', '0~3초' in page.locator('.beat').first.inner_text(),
              page.locator('.beat').first.inner_text()[:40])
        script_txt = page.locator('.script-out').first.inner_text()
        check('대본 템플릿 생성', '[0~3초 · 훅]' in script_txt and 'CTA' in script_txt, script_txt[:40])
        check('점수 구성 요소', page.locator('.score-part').count() >= 9, page.locator('.score-part').count())
        dl_demo = page.locator('.dl-panel [data-action]').evaluate_all('els => els.map(e => e.dataset.action)')
        check('데모 모달 저장 패널 (PNG·TXT·JSON)',
              all(a in dl_demo for a in ['download-card-png', 'download-pack-txt', 'download-pack-json']), dl_demo)
        check('데모 모달엔 원본·yt-dlp·썸네일 버튼 없음',
              all(a not in dl_demo for a in ['copy-source-url', 'copy-ytdlp', 'open-youtube-thumb', 'download-youtube-thumb']), dl_demo)
        demo_modal_txt = page.locator('.modal').inner_text()
        check('CORS 기술 한계 안내', 'CORS' in demo_modal_txt and 'yt-dlp' in demo_modal_txt, 'CORS/yt-dlp')
        check('데모 카드 원본 없음 안내', '원본 URL이 없어' in demo_modal_txt, demo_modal_txt[-120:].replace('\n', ' '))
        page.click('.modal [data-action="copy-script"]')
        page.wait_for_timeout(250)
        clip = page.evaluate('() => navigator.clipboard.readText()')
        check('대본 클립보드 복사', '[0~3초 · 훅]' in clip, clip[:30])
        page.keyboard.press('Escape')
        page.wait_for_timeout(200)
        check('ESC로 모달 닫힘', not page.locator('.modal[role="dialog"]').is_visible())

        # preview play button + demo notice
        page.click('.card[data-id="ig-kr-02"] .cover')
        page.wait_for_timeout(300)
        check('상세 모달 재생 버튼', page.locator('.play-btn').count() == 1)
        page.click('.play-btn')
        page.wait_for_timeout(250)
        check('데모 카드 재생 안내', '데모 카드' in page.locator('.toast').last.inner_text(),
              page.locator('.toast').last.inner_text()[:40])
        page.keyboard.press('Escape')
        page.wait_for_timeout(200)

        section('팀 보드')
        for cid in ['ig-kr-01', 'yt-kr-01', 'tt-kr-03']:
            page.click(f'.card[data-id="{cid}"] [data-action="toggle-save"]')
            page.wait_for_timeout(120)
        check('보드 저장 배지 3', page.locator('.tab[data-tab="board"] .tab-count').inner_text() == '3',
              page.locator('.tab[data-tab="board"] .tab-count').inner_text())
        page.click('.tab[data-tab="board"]')
        page.wait_for_timeout(250)
        check('칸반 4열', page.locator('.col').count() == 4, page.locator('.col').count())
        check('첫 열에 카드 3', page.locator('.col[data-status="saved"] .kcard').count() == 3,
              page.locator('.col[data-status="saved"] .kcard').count())

        page.click('.col[data-status="saved"] .kcard[data-id="ig-kr-01"] [data-action="kcard-next"]')
        page.wait_for_timeout(200)
        check('다음 단계 이동 (대본 각색 중)', page.locator('.col[data-status="scripting"] .kcard').count() == 1,
              page.locator('.col[data-status="scripting"] .kcard').count())

        page.click('.kcard[data-id="ig-kr-01"] [data-action="kcard-memo"]')
        page.wait_for_timeout(250)
        page.fill('#memoTags', '훅강함, 3월캠페인')
        page.fill('#memoText', '첫 3초 자막만 바꿔서 재촬영')
        page.click('[data-action="save-memo"]')
        page.wait_for_timeout(250)
        memo_text = page.locator('.col[data-status="scripting"] .kcard').first.inner_text()
        check('메모 저장 표시', '재촬영' in memo_text, memo_text.replace('\n', ' ')[:50])
        check('태그 저장 표시', '훅강함' in memo_text, memo_text.replace('\n', ' ')[:50])

        # 보드 카드에서도 바로 저장된다(브리프: 레퍼런스 보드에서 동작)
        check('보드 카드 PNG·TXT 버튼',
              page.locator('.kcard [data-action="download-card-png"]').count() == 3 and
              page.locator('.kcard [data-action="download-pack-txt"]').count() == 3,
              page.locator('.kcard [data-action="download-card-png"]').count())
        with page.expect_download() as db:
            page.locator('.col[data-status="scripting"] .kcard [data-action="download-card-png"]').first.click()
        board_png = db.value
        check('보드에서 PNG 저장', board_png.suggested_filename.endswith('.png'), board_png.suggested_filename)
        with page.expect_download() as dbt:
            page.locator('.col[data-status="scripting"] .kcard [data-action="download-pack-txt"]').first.click()
        board_txt = Path(dbt.value.path()).read_text(encoding='utf-8')
        check('보드에서 분석팩 TXT 저장', '레퍼런스 분석팩' in board_txt, board_txt[:24].replace('\n', ' '))

        # HTML5 drag & drop: saved -> done
        page.evaluate("""() => {
            const card = document.querySelector('.col[data-status="saved"] .kcard');
            const col = document.querySelector('.col[data-status="done"]');
            const dt = new DataTransfer();
            card.dispatchEvent(new DragEvent('dragstart', {bubbles: true, dataTransfer: dt}));
            col.dispatchEvent(new DragEvent('dragover', {bubbles: true, cancelable: true, dataTransfer: dt}));
            col.dispatchEvent(new DragEvent('drop', {bubbles: true, cancelable: true, dataTransfer: dt}));
        }""")
        page.wait_for_timeout(300)
        check('드래그로 업로드 완료 이동', page.locator('.col[data-status="done"] .kcard').count() == 1,
              page.locator('.col[data-status="done"] .kcard').count())

        board_state = page.evaluate("() => JSON.parse(localStorage.getItem('radar.v1.board'))")
        check('보드 상태 localStorage 저장', len(board_state) == 3, len(board_state))

        page.reload(wait_until='networkidle')
        page.wait_for_timeout(300)
        page.click('.tab[data-tab="board"]')
        page.wait_for_timeout(250)
        check('새로고침 후 보드 유지', page.locator('.kcard').count() == 3, page.locator('.kcard').count())
        check('새로고침 후 메모 유지', '재촬영' in page.locator('.kcard').first.inner_text() or
              '재촬영' in page.locator('.col[data-status="scripting"]').inner_text())

        with page.expect_download() as dl:
            page.click('[data-action="export-board-csv"]')
        download = dl.value
        csv_path = download.path()
        csv_text = Path(csv_path).read_text(encoding='utf-8-sig')
        check('CSV 다운로드', csv_text.splitlines()[0].startswith('상태,'), csv_text.splitlines()[0][:40])
        check('CSV 3행 + 헤더', len(csv_text.strip().splitlines()) == 4, len(csv_text.strip().splitlines()))
        check('CSV에 메모 포함', '재촬영' in csv_text)
        check('CSV 상태 라벨', ('대본 각색 중' in csv_text) and ('업로드 완료' in csv_text))

        with page.expect_download() as dj:
            page.click('[data-action="export-board-json"]')
        j = json.loads(Path(dj.value.path()).read_text(encoding='utf-8'))
        check('JSON 다운로드 3건', j.get('count') == 3 and len(j.get('items', [])) == 3, j.get('count'))

        page.click('[data-action="clear-board"]')
        page.wait_for_timeout(200)
        page.click('[data-action="do-clear-board"]')
        page.wait_for_timeout(300)
        check('보드 비우기', page.locator('#boardEmpty').is_visible(), page.locator('#boardEmpty').is_visible())

        section('계정 추적')
        page.click('.tab[data-tab="accounts"]')
        page.wait_for_timeout(200)
        page.fill('#trackInput', '@tech.park')
        page.click('#trackForm button[type="submit"]')
        page.wait_for_timeout(300)
        check('계정 추가', page.locator('.account').count() == 1, page.locator('.account').count())
        acc = page.locator('.account').first.inner_text()
        check('계정 통계 표시', '13.5x' in acc and '최고' in acc, acc.replace('\n', ' ')[:60])
        check('계정 영상 미니카드', page.locator('.account .mini-card').count() >= 1, page.locator('.account .mini-card').count())
        page.check('#watchOnlyOutliers')
        page.wait_for_timeout(200)
        check('2x 이상만 보기', page.locator('.account .mini-card').count() >= 1)
        page.uncheck('#watchOnlyOutliers')
        page.fill('#trackInput', '@unknown.person')
        page.click('#trackForm button[type="submit"]')
        page.wait_for_timeout(300)
        check('영상 없는 계정도 추가', page.locator('.account').count() == 2, page.locator('.account').count())
        page.locator('.account').nth(1).locator('[data-action="remove-watch"]').click()
        page.wait_for_timeout(200)
        check('추적 해제', page.locator('.account').count() == 1, page.locator('.account').count())

        section('쇼핑/커머스')
        page.click('.tab[data-tab="commerce"]')
        page.wait_for_timeout(300)
        check('커머스 카드 9건', page.locator('#commerceGrid .card').count() == 9, page.locator('#commerceGrid .card').count())
        check('상품 스트립 표시', page.locator('#commerceGrid .product-strip').count() == 9,
              page.locator('#commerceGrid .product-strip').count())
        bar_w = page.evaluate("() => document.querySelector('.bar-fill').getBoundingClientRect().width")
        check('GMV 막대 렌더', bar_w > 10, bar_w)
        top_rows = page.locator('.top-item').count()
        check('상품 TOP 6', top_rows == 6, top_rows)
        top_txt = page.locator('.top-item').first.inner_text().replace('\n', ' | ')
        check('상품명/크리에이터 분리', '|' in top_txt and '@' in top_txt, top_txt[:60])

        section('AI 훅·대본')
        page.click('.tab[data-tab="ai"]')
        page.wait_for_timeout(300)
        check('훅 유형 4종', page.locator('.hook-row').count() == 4, page.locator('.hook-row').count())
        check('훅 라이브러리 4장', page.locator('.hook-card').count() == 4, page.locator('.hook-card').count())
        check('대본 스튜디오', page.locator('#studioScript').count() == 1)
        first_script = page.locator('#studioScript').inner_text()
        page.select_option('#studioSelect', 'yt-kr-04')
        page.wait_for_timeout(250)
        second_script = page.locator('#studioScript').inner_text()
        check('레퍼런스 변경 시 대본 갱신', first_script != second_script)
        page.fill('#studioProduct', '무선 청소기')
        page.wait_for_timeout(250)
        typed_script = page.locator('#studioScript').inner_text()
        check('내 제품 입력 → 대본 반영', '무선 청소기' in typed_script)
        page.click('#hookLibrary [data-action="copy-template"]')
        page.wait_for_timeout(200)
        clip2 = page.evaluate('() => navigator.clipboard.readText()')
        check('훅 템플릿 복사', len(clip2) > 5, clip2[:30])
        page.click('#studio [data-action="copy-prompt"]')
        page.wait_for_timeout(200)
        clip3 = page.evaluate('() => navigator.clipboard.readText()')
        check('프롬프트 복사', 'hook_type' in clip3 and '[규칙]' in clip3, clip3[:40])

        section('카피 심리학 · 8대 트리거')
        page.select_option('#studioSelect', 'ig-kr-01')
        page.wait_for_timeout(400)
        check('심리 패널 렌더', page.locator('#psychPanel .psy').count() == 1, page.locator('#psychPanel .psy').count())
        check('트리거 바 8개', page.locator('#psychPanel .psy-bar').count() == 8,
              page.locator('#psychPanel .psy-bar').count())
        check('커버리지 표시', '/8' in page.locator('#psychPanel .psy-score b').inner_text(),
              page.locator('#psychPanel .psy-score b').inner_text())
        check('빈틈 3개', page.locator('#psychPanel .psy-gaps li').count() == 3,
              page.locator('#psychPanel .psy-gaps li').count())
        check('프레임워크 탭 4개', page.locator('#psychPanel .psy-tab').count() == 4,
              page.locator('#psychPanel .psy-tab').count())
        first_fw = page.locator('#psyOut-a .psy-fw').inner_text()
        check('첫 초안 생성', len(first_fw) > 2 and '·' in first_fw, first_fw)
        check('초안 진단 표시', '점' in page.locator('#psyOut-a .psy-fw-meta').inner_text(),
              page.locator('#psyOut-a .psy-fw-meta').inner_text())

        page.click('#psychPanel .psy-tab[data-fw="4U"]')
        page.wait_for_timeout(250)
        check('4U 탭 전환', page.locator('#psyOut-a .psy-fw').inner_text().startswith('4U'),
              page.locator('#psyOut-a .psy-fw').inner_text())
        check('4U 항목 표시', '유용' in page.locator('#psyOut-a').inner_text())
        check('4U 탭 활성', 'is-on' in (page.locator('#psychPanel .psy-tab[data-fw="4U"]').get_attribute('class') or ''))

        page.fill('#psy-a [data-psy="product"]', '내 무선 청소기')
        page.wait_for_timeout(400)
        check('내 제품 → 초안 반영', '내 무선 청소기' in page.locator('#psyOut-a').inner_text(),
              page.locator('#psyOut-a').inner_text()[:60])
        page.click('#psychPanel [data-action="copy-psy"]')
        page.wait_for_timeout(300)
        clip_psy = page.evaluate('() => navigator.clipboard.readText()')
        check('카피 문구 복사', clip_psy.startswith('[4U]') and '제목:' in clip_psy, clip_psy[:40])

        section('내 구독 AI 원클릭 브리지')
        page.evaluate("""() => {
            window.__opened = [];
            window.open = (u) => { window.__opened.push(u); return { opener: null }; };
        }""")
        check('AI 버튼 3개', page.locator('#bridgePanel .bridge-btn').count() == 3,
              page.locator('#bridgePanel .bridge-btn').count())
        providers = page.evaluate("""() => Array.from(document.querySelectorAll('#bridgePanel .bridge-btn'))
            .map(b => b.dataset.provider)""")
        check('ChatGPT·Claude·Gemini', providers == ['chatgpt', 'claude', 'gemini'], providers)
        check('Gemini는 붙여넣기 안내', page.locator('#bridgePanel .bridge-btn[data-provider="gemini"] .b-tag').inner_text() == '붙여넣기',
              page.locator('#bridgePanel .bridge-btn[data-provider="gemini"] .b-tag').inner_text())

        page.click('#bridgePanel .bridge-btn[data-provider="chatgpt"]')
        page.wait_for_timeout(400)
        opened = page.evaluate('() => window.__opened')
        check('ChatGPT 새 창 열기', len(opened) == 1 and opened[0].startswith('https://chatgpt.com/?q='), str(opened)[:80])
        clip_prompt = page.evaluate('() => navigator.clipboard.readText()')
        check('프롬프트 클립보드 복사', '[레퍼런스]' in clip_prompt and '2.7x' in clip_prompt, clip_prompt[:50])
        check('프롬프트에 심리 진단', '[이 제목·훅의 심리 트리거]' in clip_prompt)
        check('프롬프트에 내 제품', '내 무선 청소기' in clip_prompt)
        check('프롬프트에 도용 금지 규칙', '레퍼런스 수치를 내 실적처럼 쓰지 않는다' in clip_prompt)

        page.click('#bridgePanel .bridge-btn[data-provider="gemini"]')
        page.wait_for_timeout(350)
        opened2 = page.evaluate('() => window.__opened')
        check('Gemini 새 창 열기', len(opened2) == 2 and opened2[1].startswith('https://gemini.google.com/app'), str(opened2)[:100])

        gemini_calls = []

        def handle_gemini(route):
            gemini_calls.append({'url': route.request.url, 'body': json.loads(route.request.post_data or '{}')})
            if len(gemini_calls) >= 2:
                body = {'error': {'code': 429, 'message': 'Quota exceeded for quota metric'}}
            else:
                body = {'candidates': [{'content': {'parts': [{'text': GEMINI_SCRIPT}]}, 'finishReason': 'STOP'}]}
            route.fulfill(status=200, content_type='application/json', body=json.dumps(body))

        page.route('https://generativelanguage.googleapis.com/**', handle_gemini)
        page.click('#bridgePanel .bridge-gemini summary')
        page.wait_for_timeout(200)
        page.fill('#geminiKey-a', 'AIzaGEMINI_TEST_KEY')
        page.click('#bridgePanel [data-action="save-gemini-key"]')
        page.wait_for_timeout(250)
        gkey = page.evaluate("() => localStorage.getItem('radar.v1.geminiKey')")
        check('Gemini 키 저장', 'AIzaGEMINI_TEST_KEY' in (gkey or ''), gkey)
        page.click('#bridgePanel [data-action="gemini-generate"]')
        page.wait_for_timeout(1200)
        ta_val = page.input_value('#aiOut-a')
        check('Gemini 대본 수신', '0~3초' in ta_val and 'CTA' in ta_val, ta_val[:40])
        check('Gemini 호출 1회', len(gemini_calls) == 1, len(gemini_calls))
        gurl = gemini_calls[0]['url'] if gemini_calls else ''
        check('Gemini 모델·키 경로', 'gemini-3.5-flash-lite' in gurl and 'key=AIzaGEMINI_TEST_KEY' in gurl, gurl[:90])
        gbody = gemini_calls[0]['body'] if gemini_calls else {}
        gprompt = gbody.get('contents', [{}])[0].get('parts', [{}])[0].get('text', '')
        check('Gemini 요청에 프롬프트', '[레퍼런스]' in gprompt and '내 무선 청소기' in gprompt, gprompt[:40])
        check('Gemini 상태 문구', '저장' in page.locator('#geminiStatus-a').inner_text(),
              page.locator('#geminiStatus-a').inner_text()[:50])
        check('대본 비트 칩', '비트 5개' in page.locator('#aiMeta-a').inner_text(),
              page.locator('#aiMeta-a').inner_text())

        page.click('#bridgePanel [data-action="save-ai-script"]')
        page.wait_for_timeout(300)
        saved_scripts = page.evaluate("() => JSON.parse(localStorage.getItem('radar.v1.aiScripts') || '{}')")
        check('AI 대본 저장', saved_scripts.get('ig-kr-01', {}).get('text', '').startswith('[0~3초'), list(saved_scripts.keys()))
        check('저장 안내 표시', '저장됨' in page.locator('#bridge-a .bridge-saved').inner_text(),
              page.locator('#bridge-a .bridge-saved').inner_text())

        page.click('#bridgePanel [data-action="gemini-generate"]')
        page.wait_for_timeout(900)
        check('Gemini 오류 안내', 'Quota' in page.locator('#geminiStatus-a').inner_text(),
              page.locator('#geminiStatus-a').inner_text()[:60])
        check('오류 시 기존 대본 유지', '0~3초' in page.input_value('#aiOut-a'))

        page.reload(wait_until='networkidle')
        settle(page, 300)
        page.wait_for_selector('.card[data-id="ig-kr-01"] .cover', timeout=8000)
        page.click('.card[data-id="ig-kr-01"] .cover')
        page.wait_for_timeout(500)
        check('상세 모달 심리 패널', page.locator('#psy-m .psy-bar').count() == 8,
              page.locator('#psy-m .psy-bar').count())
        check('상세 모달 AI 버튼 3개', page.locator('#bridge-m .bridge-btn').count() == 3,
              page.locator('#bridge-m .bridge-btn').count())
        check('저장한 AI 대본 복원', '0~3초' in page.input_value('#aiOut-m'), page.input_value('#aiOut-m')[:30])
        page.keyboard.press('Escape')
        settle(page, 200)

        section('무료 AI 맛보기 · 분포 차트')
        page.click('.tab[data-tab="radar"]')
        settle(page, 200)
        oss = page.evaluate("""() => ({
            papa: typeof window.Papa === 'object' && typeof window.Papa.parse === 'function',
            ss: typeof window.ss === 'object' && typeof window.ss.median === 'function',
            chart: typeof window.Chart === 'function',
            stats: !!window.RadarStats,
            pro: !!window.ProConnector
        })""")
        check('PapaParse 로드', oss['papa'], oss)
        check('simple-statistics 로드', oss['ss'], oss)
        check('Chart.js 로드', oss['chart'], oss)
        check('stats-engine 로드', oss['stats'], oss)
        check('pro-api-connector 로드', oss['pro'], oss)
        check('분포 패널 노출', page.locator('#distPanel').is_visible())
        dist_meta = page.locator('#distMeta').inner_text()
        check('분포 요약에 중앙값', '중앙값' in dist_meta, dist_meta)
        chart_ok = page.evaluate("""() => {
            const c = document.getElementById('distChart');
            if (!c || !window.Chart) return false;
            const inst = Chart.getChart(c);
            return !!(inst && inst.data && inst.data.datasets[0].data.length);
        }""")
        check('Chart.js 인스턴스·막대 데이터', chart_ok)
        check('분포 설명에 이상치 기준', '1.5×IQR' in page.locator('#distNote').inner_text(),
              page.locator('#distNote').inner_text()[:60])
        page.evaluate("""() => {
            const el = document.querySelector('#distPanel');
            if (el) { el.scrollIntoView({ block: 'center' }); }
        }""")
        page.wait_for_timeout(500)
        dist_shot = True
        try:
            page.screenshot(path=str(HERE / 'preview-distribution.png'), timeout=20000)
        except Exception as exc:
            dist_shot = False
            print(f'  ! 분포 스크린샷 실패: {exc}')
        check('preview-distribution.png (배수 분포)', dist_shot)
        page.click('.tab[data-tab="ai"]')
        settle(page, 300)
        page.wait_for_selector('#bridgePanel [data-action="free-generate"]', state='visible', timeout=8000)

        free_calls = []
        free_mode = {'mode': 'ok'}

        def handle_free(route):
            req = route.request
            cors = {
                'access-control-allow-origin': '*',
                'access-control-allow-headers': 'content-type, x-free-ai-visitor',
                'access-control-expose-headers': 'X-Free-AI-Remaining, X-Free-AI-Limit, X-Free-AI-Reset, X-Free-AI-Provider',
                'content-type': 'application/json',
            }
            if req.method == 'OPTIONS':
                route.fulfill(status=204, headers=cors, body='')
                return
            try:
                body = json.loads(req.post_data or '{}')
            except Exception:  # noqa: BLE001
                body = {}
            free_calls.append({'body': body, 'headers': req.headers})
            if free_mode['mode'] == 'ok':
                route.fulfill(status=200, headers=dict(cors, **{
                    'x-free-ai-remaining': '4', 'x-free-ai-limit': '5',
                    'x-free-ai-reset': '2026-11-24T15:00:00.000Z', 'x-free-ai-provider': 'workersai',
                }), body=json.dumps({'ok': True, 'text': FREE_SCRIPT, 'provider': 'workersai',
                                     'model': '@cf/openai/gpt-oss-20b', 'remaining': 4, 'limit': 5}))
            elif free_mode['mode'] == 'quota':
                route.fulfill(status=429, headers=cors, body=json.dumps({
                    'ok': False, 'reason': 'free_quota_exceeded',
                    'message': '오늘 무료 체험 5회를 모두 쓰셨어요. 내 Gemini 무료 키(카드 등록 없음)를 연결하면 무제한으로 이어서 쓸 수 있어요.',
                    'remaining': 0, 'limit': 5, 'resetAt': '2026-11-24T15:00:00.000Z',
                    'cta': {'kind': 'connect_key', 'label': '내 무료 키로 계속하기', 'provider': 'gemini',
                            'keyUrl': 'https://aistudio.google.com/apikey'},
                    'alternatives': [{'kind': 'subscription_bridge', 'label': '지금 쓰는 ChatGPT·Gemini 구독으로 이어서'}]}))
            else:
                route.fulfill(status=503, headers=cors, body=json.dumps({
                    'ok': False, 'reason': 'all_providers_busy', 'message': '지금 무료 체험 줄이 길어요.', 'retryAfter': 30}))

        page.route('https://free-ai-taste.goodday810202.workers.dev/**', handle_free)
        check('무료 생성 버튼', page.locator('#bridgePanel [data-action="free-generate"]').count() == 1,
              page.locator('#bridgePanel [data-action="free-generate"]').count())
        check('무료 버튼 활성', page.locator('#bridgePanel [data-action="free-generate"]').is_enabled())

        page.click('#bridgePanel [data-action="free-generate"]')
        page.wait_for_timeout(1500)
        free_val = page.input_value('#aiOut-a')
        check('무료 체험 대본 수신', '0~3초' in free_val, free_val[:40])
        check('무료 체험 호출 1회', len(free_calls) == 1, len(free_calls))
        check('무료 호출 app 이름', free_calls[0]['body'].get('app') == 'shortform-radar',
              free_calls[0]['body'].get('app'))
        check('무료 호출 task=text', free_calls[0]['body'].get('task') == 'text')
        check('무료 호출에 인증 헤더 없음',
              'authorization' not in {k.lower() for k in free_calls[0]['headers']},
              list(free_calls[0]['headers'].keys()))
        check('방문자 ID 헤더', len(free_calls[0]['headers'].get('x-free-ai-visitor', '')) >= 8,
              free_calls[0]['headers'].get('x-free-ai-visitor'))
        check('무료 남은 횟수 표시', '남은 4/5' in page.locator('#freeStatus-a').inner_text(),
              page.locator('#freeStatus-a').inner_text()[:60])

        free_mode['mode'] = 'quota'
        free_calls.clear()
        page.click('#bridgePanel [data-action="free-generate"]')
        page.wait_for_timeout(900)
        card_txt = page.locator('#freeCard-a').inner_text()
        check('한도 소진 카드', '무료 체험을 다 쓰셨어요' in card_txt, card_txt[:50])
        check('무료 키 연결 링크', page.locator('#freeCard-a a').get_attribute('href') == 'https://aistudio.google.com/apikey',
              page.locator('#freeCard-a a').get_attribute('href'))
        check('구독 브리지 대안', '구독' in card_txt, card_txt[:80])
        check('소진 시 기존 대본 유지', '0~3초' in page.input_value('#aiOut-a'))

        free_mode['mode'] = 'busy'
        free_calls.clear()
        page.click('#bridgePanel [data-action="free-generate"]')
        page.wait_for_timeout(2600)
        check('503 은 1회만 재시도', len(free_calls) == 2, len(free_calls))
        check('붐빔 안내', '붐볐' in page.locator('#freeStatus-a').inner_text() and '30초' in page.locator('#freeStatus-a').inner_text(),
              page.locator('#freeStatus-a').inner_text()[:60])
        page.unroute('https://free-ai-taste.goodday810202.workers.dev/**')

        section('설정 · YouTube API 키')
        page.click('[data-action="open-settings"]')
        page.wait_for_timeout(250)
        check('설정 모달', page.locator('#apiKeyInput').is_visible())
        check('할당량 안내', '검색 호출' in page.locator('.modal').inner_text())
        page.fill('#apiKeyInput', 'AIzaTESTKEY_1234567890')
        page.click('[data-action="save-key"]')
        page.wait_for_timeout(300)
        stored = page.evaluate("() => localStorage.getItem('radar.v1.apiKey')")
        check('API 키 localStorage 저장', 'AIzaTESTKEY' in (stored or ''), stored)
        check('API 연결 상태 표시', page.locator('#apiDot').get_attribute('class').find('on') >= 0,
              page.locator('#apiDot').get_attribute('class'))
        page.keyboard.press('Escape')
        page.wait_for_timeout(150)
        page.route('https://www.googleapis.com/youtube/v3/**', handle_api)
        page.route('https://i.ytimg.com/**', lambda r: r.fulfill(status=200, content_type='image/png', body=THUMB))
        page.route('https://www.tiktok.com/oembed**', lambda r: r.fulfill(
            status=200, content_type='application/json',
            body=json.dumps({'title': '테스트 틱톡 요리 영상', 'author_name': '샘플 테스터'})))

        section('실시간 수집 (모의 API)')
        before = page.locator('#grid .card').count()
        page.click('[data-action="open-collect"]')
        page.wait_for_timeout(250)
        page.click('#collectSeg [data-mode="yt"]')
        page.wait_for_timeout(200)
        check('검색 폼 표시 (키 있음)', page.locator('#ytForm').is_visible())
        page.fill('#ytQuery', '자취 요리')
        page.select_option('#ytRegion', 'KR')
        page.select_option('#ytPeriod', '7')
        page.select_option('#ytMax', '10')
        page.click('#ytForm button[type="submit"]')
        page.wait_for_timeout(800)
        after = page.locator('#grid .card').count()
        check('모의 API 수집 후 실시간 수집만 4건', before == 28 and after == 4, f'{before} → {after}')
        check('수집 후 토글 자동 on',
              page.locator('[data-action="toggle-collected-only"]').get_attribute('aria-pressed') == 'true',
              page.locator('[data-action="toggle-collected-only"]').get_attribute('aria-pressed'))
        check('수집 후 토글 카운트 4',
              page.locator('[data-action="toggle-collected-only"] .ft-count').inner_text().strip() == '4',
              page.locator('[data-action="toggle-collected-only"] .ft-count').inner_text())
        live_ids = page.evaluate("""() => {
            const demo = new Set(window.__radar.state.demo.map(i => i.id));
            const cards = Array.from(document.querySelectorAll('#grid .card'));
            return { ids: cards.map(c => c.dataset.id), demo: cards.filter(c => demo.has(c.dataset.id)).length };
        }""")
        check('수집 후 데모 카드 숨김', len(live_ids['ids']) == 4 and live_ids['demo'] == 0, live_ids)

        sq = next((q for q in api_queries if '/search' in '' or True and 'videoDuration' in q), None)
        first_search = api_queries[0] if api_queries else {}
        check('search.list 파라미터: videoDuration=short',
              first_search.get('videoDuration', [''])[0] == 'short', first_search.get('videoDuration'))
        check('search.list 파라미터: type=video', first_search.get('type', [''])[0] == 'video')
        check('search.list 파라미터: regionCode=KR', first_search.get('regionCode', [''])[0] == 'KR')
        check('search.list 파라미터: order=viewCount', first_search.get('order', [''])[0] == 'viewCount')
        check('search.list 파라미터: publishedAfter', 'publishedAfter' in first_search)
        check('search.list 파라미터: 키워드', first_search.get('q', [''])[0] == '자취 요리', first_search.get('q'))
        check('API 호출 3회 (검색+영상+채널)', len(api_calls) == 3, len(api_calls))

        card_a = page.locator('.card[data-id="yt-VidA000001"]')
        check('실시간 카드 렌더', card_a.count() == 1, card_a.count())
        check('채널 중앙값 기준 5x 계산', card_a.locator('.badge.outlier').inner_text() == '5x',
              card_a.locator('.badge.outlier').inner_text())
        kpis_a = card_a.locator('.kpi .k-value').all_inner_texts()
        check('VPH 30만/h 계산', kpis_a[2] == '30만/h', kpis_a[2])
        check('실제 썸네일 로드', card_a.locator('img.thumb').count() == 1)
        thumb_w = page.evaluate("""() => { const i = document.querySelector('.card[data-id="yt-VidA000001"] img.thumb'); return i ? i.naturalWidth : -1; }""")
        check('썸네일 naturalWidth > 0', thumb_w > 0, thumb_w)
        quota = page.evaluate("() => JSON.parse(localStorage.getItem('radar.v1.quota') || '{}')")
        check('할당량 미터: 검색 1회', quota.get('search') == 1, quota)
        check('할당량 미터: 유닛 2', quota.get('units') == 2, quota)
        check('소스 안내 실시간 표시', '실시간 연결' in page.locator('#sourceNote').inner_text(),
              page.locator('#sourceNote').inner_text()[:40])

        # ── 토글 끄기/켜기로 데모 왕복 ──
        page.locator('[data-action="toggle-collected-only"]').click()
        page.wait_for_timeout(250)
        check('토글 off → 데모 포함 32건', page.locator('#grid .card').count() == 32, page.locator('#grid .card').count())
        demo_shown = page.evaluate("""() => {
            const demo = new Set(window.__radar.state.demo.map(i => i.id));
            return Array.from(document.querySelectorAll('#grid .card')).filter(c => demo.has(c.dataset.id)).length;
        }""")
        check('토글 off → 데모 28건 다시 노출', demo_shown == 28, demo_shown)
        page.locator('[data-action="toggle-collected-only"]').click()
        page.wait_for_timeout(250)
        check('토글 on → 수집 4건만', page.locator('#grid .card').count() == 4, page.locator('#grid .card').count())
        check('소스 안내 데모 숨김 표기', '데모 28건 숨김' in page.locator('#sourceNote').inner_text(),
              page.locator('#sourceNote').inner_text()[:60])

        # ── 상세 모달의 실제 썸네일 레이어링(핵심 수정) ──
        section('상세 모달 썸네일 표시')
        card_a.locator('.cover').click()
        page.wait_for_timeout(600)
        geom = page.evaluate("""() => {
            const box = document.querySelector('.detail-cover');
            if (!box) return null;
            const img = box.querySelector('img');
            const svg = box.querySelector('svg');
            const b = box.getBoundingClientRect();
            const i = img ? img.getBoundingClientRect() : null;
            const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height * 0.25);
            const center = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
            return {
                boxW: Math.round(b.width), boxH: Math.round(b.height),
                imgW: i ? Math.round(i.width) : -1, imgH: i ? Math.round(i.height) : -1,
                imgTop: i ? Math.round(i.top - b.top) : -1, imgLeft: i ? Math.round(i.left - b.left) : -1,
                natural: img ? img.naturalWidth : -1,
                display: img ? getComputedStyle(img).display : null,
                hit: hit ? hit.tagName : null,
                center: center ? (center.closest('.play-btn') ? 'play' : center.tagName) : null,
                imgZ: img ? getComputedStyle(img).zIndex : null,
                svgZ: svg ? getComputedStyle(svg).zIndex : null,
            };
        }""")
        check('모달 커버 DOM', geom is not None, geom)
        check('실제 썸네일 자연 크기 로드', geom['natural'] > 0, geom['natural'])
        check('썸네일이 커버 영역을 꽉 채움', geom['imgW'] == geom['boxW'] and geom['imgH'] == geom['boxH'],
              f"cover {geom['boxW']}×{geom['boxH']} · img {geom['imgW']}×{geom['imgH']}")
        check('썸네일 위치 = 커버 좌상단', geom['imgTop'] == 0 and geom['imgLeft'] == 0, geom)
        check('썸네일이 SVG 위에 그림 (hit-test)', geom['hit'] == 'IMG', geom['hit'])
        check('썸네일 z-index > SVG', float(geom['imgZ'] or 0) >= 1, f"img {geom['imgZ']} svg {geom['svgZ']}")
        check('재생 버튼은 썸네일 위', geom['center'] == 'play', geom['center'])
        page.keyboard.press('Escape')
        page.wait_for_timeout(200)

        # 403 quota error
        page.click('[data-action="open-collect"]')
        page.wait_for_timeout(200)
        page.click('#collectSeg [data-mode="yt"]')
        page.fill('#ytQuery', '__quota__ 403')
        page.click('#ytForm button[type="submit"]')
        page.wait_for_timeout(600)
        err_txt = page.locator('#ytError').inner_text()
        check('403 할당량 오류 안내', '403' in err_txt or '할당량' in err_txt, err_txt[:60])
        check('403 후 카드 추가 없음', page.locator('#grid .card').count() == after, page.locator('#grid .card').count())
        page.keyboard.press('Escape')
        page.wait_for_timeout(200)

        # 400 invalid key
        page.click('[data-action="open-collect"]')
        page.wait_for_timeout(200)
        page.click('#collectSeg [data-mode="yt"]')
        page.fill('#ytQuery', '__badkey__ 400')
        page.click('#ytForm button[type="submit"]')
        page.wait_for_timeout(600)
        err2 = page.locator('#ytError').inner_text()
        check('400 잘못된 키 안내', '400' in err2 or '키' in err2, err2[:60])
        page.keyboard.press('Escape')
        page.wait_for_timeout(150)

        section('URL · CSV 수집')
        page.click('[data-action="open-collect"]')
        page.wait_for_timeout(200)
        page.click('#collectSeg [data-mode="link"]')
        page.wait_for_timeout(150)
        page.fill('#linkInput', 'https://www.tiktok.com/@sample.tester/video/7300000000000000099')
        page.fill('#linkForm [name="views"]', '100000')
        page.fill('#linkForm [name="likes"]', '4000')
        page.fill('#linkForm [name="comments"]', '150')
        page.fill('#linkForm [name="avgViews"]', '40000')
        page.fill('#linkForm [name="hours"]', '5')
        page.click('#linkForm button[type="submit"]')
        page.wait_for_timeout(500)
        url_card = page.locator('.card[data-id="url-tiktok-7300000000000000099"]')
        check('링크 카드 추가', url_card.count() == 1, url_card.count())
        check('링크 카드 배수 계산(2.5x)', url_card.locator('.badge.outlier').inner_text() == '2.5x',
              url_card.locator('.badge.outlier').inner_text())

        page.click('[data-action="open-collect"]')
        page.wait_for_timeout(200)
        page.click('#collectSeg [data-mode="csv"]')
        page.wait_for_timeout(150)
        page.click('[data-action="fill-sample-csv"]')
        page.wait_for_timeout(150)
        # 토글을 꺼 둔 상태에서 CSV를 넣으면 다시 '실시간 수집만'으로 돌아오는지
        page.keyboard.press('Escape')
        page.wait_for_timeout(200)
        page.locator('[data-action="toggle-collected-only"]').click()
        page.wait_for_timeout(250)
        check('CSV 전 토글 off → 데모 포함 33건', page.locator('#grid .card').count() == 33, page.locator('#grid .card').count())
        page.click('[data-action="open-collect"]')
        page.wait_for_timeout(250)
        page.click('#collectSeg [data-mode="csv"]')
        page.wait_for_timeout(150)
        page.click('[data-action="fill-sample-csv"]')
        page.wait_for_timeout(150)
        page.click('#csvForm button[type="submit"]')
        page.wait_for_timeout(600)
        n_after = page.locator('#grid .card').count()
        check('CSV 2건 추가 + 자동 실시간 수집만 (7건)', n_after == 7, n_after)
        check('CSV 후 토글 자동 on',
              page.locator('[data-action="toggle-collected-only"]').get_attribute('aria-pressed') == 'true',
              page.locator('[data-action="toggle-collected-only"]').get_attribute('aria-pressed'))
        check('CSV 카드 조회수 반영', '54만' in page.locator('.card').first.inner_text() or
              page.locator('.card[data-id^="csv-"]').count() == 2,
              page.locator('.card[data-id^="csv-"]').count())

        page.click('[data-action="open-collect"]')
        page.wait_for_timeout(200)
        page.click('#collectSeg [data-mode="csv"]')
        page.fill('#csvInput', 'zzz,qqq\n1,2')
        page.click('#csvForm button[type="submit"]')
        page.wait_for_timeout(300)
        check('잘못된 CSV → 경고', page.locator('.toast').count() >= 1 and
              '헤더' in page.locator('.toast').last.inner_text(), page.locator('.toast').last.inner_text()[:40])
        page.keyboard.press('Escape')
        page.wait_for_timeout(150)

        # pending item -> metric form
        page.click('[data-action="open-collect"]')
        page.wait_for_timeout(200)
        page.click('#collectSeg [data-mode="link"]')
        page.wait_for_timeout(150)
        page.fill('#linkInput', 'https://www.instagram.com/reel/CxPend12345/')
        page.click('#linkForm button[type="submit"]')
        page.wait_for_timeout(500)
        pend = page.locator('.card[data-id="url-instagram-CxPend12345"]')
        check('링크만 추가 → 지표 없음 카드', pend.count() == 1 and '지표 없음' in pend.inner_text(),
              pend.inner_text().replace('\n', ' ')[:50] if pend.count() else 'missing')
        pend.locator('.cover').click()
        page.wait_for_timeout(300)
        check('지표 입력 폼 노출', page.locator('#metricForm').is_visible())
        page.fill('#metricForm [name="views"]', '100000')
        page.fill('#metricForm [name="likes"]', '4000')
        page.fill('#metricForm [name="comments"]', '120')
        page.fill('#metricForm [name="avgViews"]', '40000')
        page.click('#metricForm button[type="submit"]')
        page.wait_for_timeout(400)
        pend2 = page.locator('.card[data-id="url-instagram-CxPend12345"]')
        check('지표 입력 후 배수 계산', pend2.locator('.badge.outlier').inner_text() == '2.5x',
              pend2.locator('.badge.outlier').inner_text())
        check('지표 입력 후 저장', page.evaluate(
            "() => JSON.parse(localStorage.getItem('radar.v1.items')).some(i => i.id === 'url-instagram-CxPend12345' && i.views === 100000)"))

        section('레퍼런스 저장 · yt-dlp 복사')
        yt_card = page.locator('.card[data-id="yt-VidA000001"]')
        check('카드에 PNG 저장 버튼', yt_card.locator('[data-action="download-card-png"]').count() == 1,
              yt_card.locator('[data-action="download-card-png"]').count())
        yt_card.locator('.cover').click()
        page.wait_for_timeout(450)
        dl_actions = page.locator('.dl-panel [data-action]').evaluate_all('els => els.map(e => e.dataset.action)')
        check('실시간 카드 저장 패널 7종',
              all(a in dl_actions for a in ['download-card-png', 'download-pack-txt', 'download-pack-json',
                                            'copy-source-url', 'copy-ytdlp', 'open-youtube-thumb', 'download-youtube-thumb']),
              dl_actions)
        check('모달 상태에서도 빈 원본 없음', '원본 URL이 없어' not in page.locator('.modal').inner_text())

        # 1) 9:16 레퍼런스 카드 PNG(1080×1920)
        with page.expect_download() as dpng:
            page.click('.dl-panel [data-action="download-card-png"]')
        png_dl = dpng.value
        png_bytes = Path(png_dl.path()).read_bytes()
        check('PNG 파일명 .png', png_dl.suggested_filename.endswith('.png'), png_dl.suggested_filename)
        check('PNG 파일 시그니처', png_bytes[:8] == b'\x89PNG\r\n\x1a\n', png_bytes[:8])
        png_w = int.from_bytes(png_bytes[16:20], 'big')
        png_h = int.from_bytes(png_bytes[20:24], 'big')
        check('PNG 1080×1920 (9:16)', (png_w, png_h) == (1080, 1920), f'{png_w}×{png_h}')
        check('PNG 실제 그림 (20KB+)', len(png_bytes) > 20000, len(png_bytes))
        page.wait_for_timeout(200)
        check('PNG 저장 토스트', 'PNG' in page.locator('.toast').last.inner_text(),
              page.locator('.toast').last.inner_text()[:40])

        # 2) 분석팩 TXT / JSON
        with page.expect_download() as dtxt:
            page.click('.dl-panel [data-action="download-pack-txt"]')
        txt_dl = dtxt.value
        txt_body = Path(txt_dl.path()).read_text(encoding='utf-8')
        check('TXT 파일명 .txt', txt_dl.suggested_filename.endswith('.txt'), txt_dl.suggested_filename)
        check('TXT 제목 포함', '자취 요리 10분 저녁' in txt_body, txt_body[:40].replace('\n', ' '))
        check('TXT 크리에이터 포함', '@sample.kr' in txt_body, '@sample.kr' in txt_body)
        check('TXT 플랫폼·배수', '유튜브 · KR' in txt_body and '5x' in txt_body, '유튜브/5x')
        check('TXT 훅·대본·해시태그 블록',
              '[첫 3초 훅]' in txt_body and '[바로 쓰는 대본 템플릿]' in txt_body and '[영상 구성 5비트]' in txt_body)
        check('TXT 원본 URL + yt-dlp 명령',
              'https://www.youtube.com/shorts/VidA000001' in txt_body and
              'yt-dlp -f "bv*+ba/b" --merge-output-format mp4' in txt_body)
        check('TXT 한계 안내', 'CORS' in txt_body, 'CORS')

        with page.expect_download() as djson:
            page.click('.dl-panel [data-action="download-pack-json"]')
        json_dl = djson.value
        pack_json = json.loads(Path(json_dl.path()).read_text(encoding='utf-8'))
        check('JSON 파일명 .json', json_dl.suggested_filename.endswith('.json'), json_dl.suggested_filename)
        check('JSON kind·버전', pack_json.get('kind') == 'reference-pack' and pack_json.get('version') == 1,
              pack_json.get('kind'))
        check('JSON videoId', pack_json['reference']['videoId'] == 'VidA000001')
        check('JSON 원본 URL', pack_json['reference']['url'] == 'https://www.youtube.com/shorts/VidA000001')
        check('JSON 바이럴 배수 5x', abs(pack_json['metrics']['viralMultiple'] - 5) < 1e-9,
              pack_json['metrics']['viralMultiple'])
        check('JSON 훅 5비트', pack_json['hook']['type'] and len(pack_json['hook']['beats']) == 5,
              pack_json['hook'].get('type'))
        check('JSON 썸네일·명령', 'maxresdefault' in (pack_json['assets']['youtubeThumbnail'] or '') and
              pack_json['download']['command'].startswith('yt-dlp'), pack_json['download']['command'][:30])

        # 3) 원본 링크 · yt-dlp 클립보드
        page.click('.dl-panel [data-action="copy-source-url"]')
        page.wait_for_timeout(250)
        clip_url = page.evaluate('() => navigator.clipboard.readText()')
        check('원본 링크 복사', clip_url == 'https://www.youtube.com/shorts/VidA000001', clip_url)
        check('원본 링크 복사 토스트', '원본 링크' in page.locator('.toast').last.inner_text(),
              page.locator('.toast').last.inner_text()[:30])
        page.click('.dl-panel [data-action="copy-ytdlp"]')
        page.wait_for_timeout(250)
        clip_cmd = page.evaluate('() => navigator.clipboard.readText()')
        check('yt-dlp 명령 복사',
              clip_cmd == 'yt-dlp -f "bv*+ba/b" --merge-output-format mp4 "https://www.youtube.com/shorts/VidA000001"',
              clip_cmd)
        check('yt-dlp 복사 토스트', 'yt-dlp' in page.locator('.toast').last.inner_text(),
              page.locator('.toast').last.inner_text()[:40])

        # 4) YouTube 썸네일 열기 / 저장 (i.ytimg.com은 모의 응답으로)
        with page.context.expect_page() as thumb_pop:
            page.click('.dl-panel [data-action="open-youtube-thumb"]')
        popup = thumb_pop.value
        check('썸네일 새 창 URL', 'i.ytimg.com/vi/VidA000001/maxresdefault.jpg' in popup.url, popup.url)
        popup.close()

        thumb_1px = base64.b64decode(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==')
        page.route('**/i.ytimg.com/**', lambda r: r.fulfill(
            status=200, body=thumb_1px, content_type='image/png',
            headers={'access-control-allow-origin': '*'}))
        with page.expect_download() as dthumb:
            page.click('.dl-panel [data-action="download-youtube-thumb"]')
        thumb_dl = dthumb.value
        check('썸네일 파일명 .jpg', thumb_dl.suggested_filename.endswith('.jpg'), thumb_dl.suggested_filename)
        check('썸네일 저장 성공', Path(thumb_dl.path()).stat().st_size > 0, Path(thumb_dl.path()).stat().st_size)
        page.wait_for_timeout(200)
        check('썸네일 저장 토스트', '썸네일' in page.locator('.toast').last.inner_text(),
              page.locator('.toast').last.inner_text()[:40])
        page.unroute('**/i.ytimg.com/**')
        page.keyboard.press('Escape')
        page.wait_for_timeout(200)

        section('테마 · 데이터')
        page.click('[data-action="toggle-theme"]')
        page.wait_for_timeout(250)
        check('다크 모드 전환', page.get_attribute('html', 'data-theme') == 'dark', page.get_attribute('html', 'data-theme'))
        page.reload(wait_until='networkidle')
        page.wait_for_timeout(300)
        check('테마 새로고침 유지', page.get_attribute('html', 'data-theme') == 'dark', page.get_attribute('html', 'data-theme'))
        page.click('[data-action="toggle-theme"]')
        page.wait_for_timeout(200)

        persisted = page.evaluate("() => JSON.parse(localStorage.getItem('radar.v1.items') || '[]').length")
        check('수집 항목 새로고침 유지', persisted >= 7, persisted)

        section('수집기 UI 요소')
        page.click('[data-action="open-settings"]')
        page.wait_for_timeout(200)
        check('키 삭제 버튼 존재', page.locator('[data-action="delete-key"]').count() == 1)
        check('키 발급 가이드', page.locator('.steps li').count() == 3, page.locator('.steps li').count())
        page.click('[data-action="delete-key"]')
        page.wait_for_timeout(300)
        check('키 삭제', page.evaluate("() => localStorage.getItem('radar.v1.apiKey')") is None)
        page.keyboard.press('Escape')
        page.wait_for_timeout(150)
        check('키 삭제 후 버튼 라벨', 'YouTube API' in page.locator('#apiButtonLabel').inner_text(),
              page.locator('#apiButtonLabel').inner_text())

        check('최종 콘솔 JS 에러 0건', not console_errors, str(console_errors[:2]))
        # 의도한 오류: YouTube 모의 403·400, 무료 체험 모의 429·503(재시도 포함)
        def intended_net(text):
            return any(code in text for code in ('403', '400', '429', '503'))
        unexpected_net = [t for t in net_console if not intended_net(t)]
        check('예상 밖 네트워크 콘솔 오류 0건', not unexpected_net, str(unexpected_net[:2]))
        check('의도한 API 오류 로그만 존재', len(net_console) == 5, net_console)
        check('최종 페이지 에러 0건', not page_errors, str(page_errors[:2]))
        real_fail = [r for r in bad_responses if 'free-ai-taste' not in str(r[1]) and '/youtube/v3/' not in str(r[1])]
        check('최종 4xx/실패 0건 (모의 API 제외)', not real_fail, str(real_fail[:3]))

        # ── mobile functional checks (DPR 2 keeps memory tame) ──
        section('모바일 390×844')
        def new_mobile_context(br):
            c = br.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2,
                               is_mobile=True, has_touch=True)
            return c, c.new_page()

        try:
            mctx, mp = new_mobile_context(browser)
        except Exception as exc:  # noqa: BLE001 - 단일 프로세스 모드에서 두 번째 컨텍스트가 죽을 수 있다
            print(f'  ! 모바일 컨텍스트 실패({str(exc).splitlines()[0]}), 브라우저를 새로 띄운다')
            try:
                browser.close()
            except Exception:
                pass
            browser = launch_browser(p, profiles=[2, 2, 2, 1, 1, 0])
            mctx, mp = new_mobile_context(browser)
        m_errors = []
        mp.on('console', lambda m: m_errors.append(m.text) if m.type == 'error' else None)
        mp.on('pageerror', lambda e: m_errors.append(str(e)))
        mp.goto(BASE + '/', wait_until='networkidle')
        mp.wait_for_timeout(400)
        check('모바일 콘솔 에러 0건', not m_errors, str(m_errors[:2]))
        check('모바일 가로 넘침 없음', page_overflow(mp) == 0, page_overflow(mp))
        cols = mp.evaluate("() => getComputedStyle(document.querySelector('#grid')).gridTemplateColumns")
        check('모바일 2열 그리드', cols.count('px') == 2, cols)
        check('모바일 실시간 수집만 토글 노출', mp.locator('[data-action="toggle-collected-only"]').is_visible())
        mp.locator('[data-action="toggle-collected-only"]').click()
        mp.wait_for_timeout(250)
        check('모바일 토글 → 수집 전 0건·빈 상태', mp.locator('#grid .card').count() == 0 and mp.locator('#empty').is_visible(),
              mp.locator('#grid .card').count())
        mp.locator('[data-action="toggle-collected-only"]').click()
        mp.wait_for_timeout(250)
        mp.click('.tab[data-tab="board"]')
        mp.wait_for_timeout(250)
        check('모바일 탭 전환', mp.locator('#view-board').is_visible())
        mp.click('.tab[data-tab="radar"]')
        mp.wait_for_timeout(150)
        mp.click('.card .cover')
        mp.wait_for_timeout(350)
        dlg = mp.locator('.modal[role="dialog"]').bounding_box()
        check('모바일 모달 뷰포트 내', dlg is not None and dlg['width'] <= 390 and dlg['x'] >= 0, dlg)
        check('모바일 저장 패널 노출', mp.locator('.dl-panel [data-action="download-card-png"]').is_visible())
        check('모바일 저장 패널 가로 넘침 없음', mp.evaluate("""() => {
            const e = document.querySelector('.dl-panel');
            if (!e) return -1;
            const r = e.getBoundingClientRect();
            return Math.round(r.right - document.documentElement.clientWidth);
        }""") <= 1)
        check('모바일 모달 가로 넘침 없음', page_overflow(mp) <= 1, page_overflow(mp))
        mp.keyboard.press('Escape')
        mp.wait_for_timeout(150)

        # AI 탭(대본 스튜디오·심리 패널·AI 브리지)도 가로 넘침 0 이어야 한다.
        # studio 의 <select> 처럼 긴 옵션 텍스트를 가진 폼 요소가 그리드 칸을 밀어내는 경우를 잡는다.
        mp.click('.tab[data-tab="ai"]')
        mp.wait_for_timeout(400)
        for label, sel in [('대본 스튜디오', '#studio'), ('심리 패널', '#psychPanel'), ('AI 브리지', '#bridgePanel')]:
            box = mp.evaluate("""(sel) => { const e = document.querySelector(sel); if (!e) return null;
                const r = e.getBoundingClientRect();
                return {w: Math.round(r.width), right: Math.round(r.right), vw: document.documentElement.clientWidth}; }""", sel)
            check(f'모바일 AI 탭 {label} 가로 넘침 없음', box is not None and box['right'] <= box['vw'] + 1, box)
        check('모바일 AI 탭 가로 넘침 없음', page_overflow(mp) == 0, page_overflow(mp))
        mp.click('.tab[data-tab="radar"]')
        mp.wait_for_timeout(150)

        browser.close()

    # ── screenshots in their own browser process (DPR 2/3) ──
    section('스크린샷')
    with sync_playwright() as p:
        shot_browser = launch_browser(p)

        def snap(path, width, height, dsf, mobile=False, modal=False):
            """한 장을 찍는다. 렌더러가 죽으면 컨텍스트를 새로 열고 한 번 더 시도한다."""
            for outer in range(2):
                context = shot_browser.new_context(
                    viewport={'width': width, 'height': height}, device_scale_factor=dsf,
                    is_mobile=mobile, has_touch=mobile,
                )
                pg = context.new_page()
                try:
                    pg.goto(BASE + '/', wait_until='networkidle')
                    pg.wait_for_timeout(600)
                    if modal:
                        pg.click('.card[data-id="yt-kr-01"] .cover')
                        pg.wait_for_timeout(700)
                    for attempt in range(2):
                        try:
                            pg.screenshot(path=str(path), timeout=20000)
                            context.close()
                            return True
                        except Exception:
                            pg.wait_for_timeout(800)
                except Exception as exc:
                    print(f'  ! 스크린샷 실패 {path.name}: {exc}')
                context.close()
                time.sleep(1)
            return False

        check('preview-desktop.png', snap(HERE / 'preview-desktop.png', 1440, 900, 2))
        # 모달은 내용이 많아 DPR 2로 그리면 이 환경의 메모리에서 렌더러가 죽는다. DPR 1로 찍는다.
        check('preview-modal.png', snap(HERE / 'preview-modal.png', 1440, 900, 1, modal=True))
        check('preview-mobile.png', snap(HERE / 'preview-mobile.png', 390, 844, 3, mobile=True))

        # ── 실시간 수집 상태 + 상세 모달 썸네일 스크린샷 ──
        def snap_live():
            """모의 API로 4건을 실제로 수집해 '실시간 수집만' 화면과 상세 모달 썸네일을 찍는다."""
            context = shot_browser.new_context(viewport={'width': 1440, 'height': 900}, device_scale_factor=1.5)
            pg = context.new_page()

            def api(route):
                path = urllib.parse.urlparse(route.request.url).path
                if path.endswith('/search'):
                    body = search_payload()
                elif path.endswith('/videos'):
                    body = videos_payload()
                elif path.endswith('/channels'):
                    body = channels_payload()
                else:
                    route.fulfill(status=404, content_type='application/json', body='{}')
                    return
                route.fulfill(status=200, content_type='application/json', body=json.dumps(body))

            pg.route('https://www.googleapis.com/youtube/v3/**', api)
            pg.route('https://i.ytimg.com/**', lambda r: r.fulfill(status=200, content_type='image/png', body=THUMB))
            radar_ok = detail_ok = False
            try:
                pg.goto(BASE + '/', wait_until='networkidle')
                pg.evaluate("() => localStorage.setItem('radar.v1.apiKey', JSON.stringify('ui-test-preview-key'))")
                pg.reload(wait_until='networkidle')
                pg.wait_for_timeout(500)
                pg.click('[data-action="open-collect"]')
                pg.wait_for_timeout(350)
                pg.click('#collectSeg [data-mode="yt"]')
                pg.wait_for_timeout(250)
                pg.fill('#ytQuery', '자취 요리')
                pg.click('#ytForm button[type="submit"]')
                pg.wait_for_timeout(1600)
                pg.wait_for_function("() => document.querySelectorAll('#grid .card img.thumb').length >= 3", timeout=8000)
                pg.wait_for_timeout(600)
                pg.screenshot(path=str(HERE / 'preview-live-yt.png'), timeout=20000)
                radar_ok = True
                pg.click('.card[data-id="yt-VidA000001"] .cover')
                pg.wait_for_timeout(800)
                pg.wait_for_function("() => { const i = document.querySelector('.detail-cover img'); return i && i.complete && i.naturalWidth > 0; }", timeout=8000)
                pg.wait_for_timeout(500)
                pg.screenshot(path=str(HERE / 'preview-live-yt-detail.png'), timeout=20000)
                detail_ok = True
            except Exception as exc:
                print(f'  ! 실시간 스크린샷 실패: {exc}')
            context.close()
            return radar_ok, detail_ok

        live_radar, live_detail = snap_live()
        check('preview-live-yt.png', live_radar)
        check('preview-live-yt-detail.png', live_detail)

        def snap_upgraded():
            """카피 심리학 + AI 브리지가 붙은 업그레이드 화면.

            다른 미리보기(DPR 2)와 달리 DPR 1로 찍는다. 긴 패널 + 배경 그리드를
            DPR 2로 한 번에 그리면 이 환경의 메모리에서 렌더러가 죽는다.
            """
            context = shot_browser.new_context(viewport={'width': 1440, 'height': 1500}, device_scale_factor=1)
            pg = context.new_page()
            tab_ok = False
            try:
                pg.goto(BASE + '/', wait_until='networkidle')
                settle(pg, 400)
                pg.click('.tab[data-tab="ai"]')
                pg.wait_for_timeout(700)
                pg.evaluate("""() => {
                    const el = document.querySelector('#psychPanel');
                    if (el) { el.scrollIntoView({ block: 'start' }); window.scrollBy(0, -150); }
                }""")
                pg.wait_for_timeout(500)
                for attempt in range(2):
                    try:
                        pg.screenshot(path=str(HERE / 'preview-upgraded.png'), timeout=20000)
                        tab_ok = True
                        break
                    except Exception as exc:
                        print(f'  ! preview-upgraded 재시도 {attempt + 1}: {exc}')
                        pg.wait_for_timeout(800)
            except Exception as exc:
                print(f'  ! 업그레이드 스크린샷 실패: {exc}')
            context.close()
            return tab_ok

        up_tab = snap_upgraded()
        check('preview-upgraded.png (AI 탭 심리+브리지)', up_tab)
        shot_browser.close()

    srv.shutdown()
    print('\n' + '─' * 56)
    print(f'  PASS  {len(ok)}')
    print(f'  FAIL  {len(fail)}')
    if fail:
        print('')
        for f in fail:
            print('  ✗ ' + f)
        sys.exit(1)
    print('  ALL BROWSER CHECKS PASSED')


def parset_query(q, key, default):
    return q.get(key, [default])[0]


if __name__ == '__main__':
    main()
