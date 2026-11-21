# engines/ — 떡상 레이더에 실린 두 엔진

두 파일 모두 **의존성 없는 순수 JS(UMD)**. 브라우저에서는 `window.CopyPsych` · `window.AiBridge`,
node 테스트에서는 `require('./engines/copy-psych-engine.js')`로 그대로 쓴다. 빌드·번들러·npm 설치 없음.

| 파일 | 역할 | 크기 |
| --- | --- | --- |
| `copy-psych-engine.js` | 8대 심리 트리거 진단·점수화, PAS/BAB/AIDA/4U 카피 생성, 감점 표현 탐지·교정 | ~54KB |
| `ai-bridge.js` | ChatGPT·Claude·Gemini 링크 생성, 무료 Gemini API 요청/응답 처리 | ~16KB |

공용 원본은 `packages/`에 있고, 이 앱은 **폴더 독립성**을 위해 사본을 들고 있다.
엔진을 고칠 때는 `packages/` 원본과 이 사본을 함께 맞춘다.

---

## 1. copy-psych-engine.js

`core.js`가 이 엔진을 감싸서 앱에 맞는 형태로 노출한다.

```js
const C = require('./core.js');

const prof = C.psychProfile(item);      // 제목·훅·해시태그·CTA 진단
prof.coverage;                           // 40점 이상인 트리거 개수 (0~8)
prof.triggers;                           // 8개: { id, name, score, level }
prof.gaps;                               // 빈틈 (가중치 × 부족분 순)

const rw = C.psychRewrite(item, { product: '내 제품' });
rw.items;                                // PAS / BAB / AIDA / 4U 4종
rw.best;                                 // 자체 점검이 가장 높은 안
C.psychFrameworkText(item, 'PAS');       // 복사용 텍스트
```

- 수집한 **제목·훅 문구·해시태그·CTA·상품명**만 채점한다. 영상 자체의 성과와는 별개이며,
  UI에도 그렇게 표기한다. 제목은 짧아 종합 등급이 낮게 나오는 것이 정상이라
  화면은 등급보다 **트리거 커버리지(8개 중 몇 개를 쓰는가)**를 앞세운다.
- 리라이팅 초안의 `문제·해결`은 카테고리별 기본 문장에서 출발하고, `근거 숫자`는
  **비워 둔다**. 레퍼런스 영상의 조회수를 내 실적처럼 옮겨 쓰지 않기 위해서다.
  사용자가 자기 수치를 넣으면 권위·앵커 점수가 함께 오른다.
- 한국어 조사(은/는, 이/가, 을/를)를 받침으로 자동 선택한다.

## 2. ai-bridge.js

```js
const B = window.AiBridge;

B.linkFor('chatgpt', prompt);   // { url, prefilled:true, fit:true, note }
B.linkFor('gemini', prompt);    // Gemini는 주소 자동 입력 불가 → base URL + 붙여넣기 안내
B.buildGeminiRequest({ apiKey, model, prompt });
B.parseGeminiResponse(json);
B.explainStatus(429, body);
```

- ChatGPT·Claude는 `?q=`로 프롬프트가 입력창에 채워지고, Gemini는 클립보드 붙여넣기로 안내한다.
- 프롬프트가 너무 길면 주소에 담지 않고 기본 URL + 붙여넣기로 떨어진다(글자수 기준은 엔진 상수).
- Gemini API 키는 **사용자가 화면에서 넣고 localStorage에만** 남는다. 요청은
  `generativelanguage.googleapis.com` 한 곳으로만 나가며, 앱이 자동으로 호출하지 않는다.
  키가 없으면 버튼 3개(새 창)만으로 동작한다.

## 테스트

`../test.js`가 두 엔진을 실제로 불러 다음을 검증한다.

- 트리거 8종 순서·점수 범위·커버리지, 빈 문구 처리
- 카테고리별 기본 문장, 조사 처리, 내 제품 덮어쓰기
- 프레임워크 4종 생성·비교·복사 텍스트
- AI 브리지 프롬프트에 레퍼런스 수치·훅·심리 진단·규칙이 들어가는지
- Gemini 요청 URL·모델·본문, 응답 파싱(성공·에러·차단·빈 응답), 상태 코드 안내
