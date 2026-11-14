# Drive Screen

Google Drive의 MP4·MP3를 Discord 또는 웹 브라우저에서 재생하는 개인용 플레이어입니다. 재생목록, 순서 편집, 셔플, 한 편·전체 반복, 지원 브라우저의 PiP와 Media Session을 제공합니다. MP3마다 커버 이미지를 지정하고 작은 창에도 표시할 수 있습니다.

## 구조

```text
GitHub Pages ── 플레이어 HTML/CSS/JS
      │
      ├── Cloudflare Worker ── Discord 로그인·/시청·Drive 목록·임시 재생 인증
      │          └── D1 ── 계정별 재생목록·MP3 커버 이미지
      │
      └── Google Drive ── Authorization 헤더 + Range로 미디어 직접 읽기
```

Worker는 영상 파일을 중계하거나 저장하지 않습니다. Discord 안에서는 Discord의 Activity 네트워크 프록시를 거칩니다. PC에서 상시 실행할 프로그램은 필요하지 않습니다. GitHub Pages와 Worker 배포, Discord 설정이 모두 완료되어야 작동합니다.

## 재생 방식과 제한

- 첫 화면에는 재생목록 UI에 필요한 작은 코드만 불러옵니다. MP4 엔진은 목록이 준비되면 병렬로 준비하고, Discord SDK는 Discord 안에서만 불러옵니다. 공통 모듈은 선로드하며 공개 연결 설정은 HTML에 포함해 추가 왕복 요청을 줄입니다. 작은 아이콘과 기본 커버는 각각 별도 크기로 제공합니다.
- 로그인된 `/bootstrap` 요청 한 번으로 계정·목록·재생목록·임시 Google 읽기 인증을 준비합니다. 인증은 현재 페이지 메모리에만 두고 목록에서 확인된 파일에 재사용합니다. 만료 직전이나 Google의 401 응답에서는 재인증하고, 로그인 변경·401 시 캐시를 비웁니다. 새로고침한 목록에서 빠진 파일은 이 캐시로 재생 인증하지 않습니다.
- MP3는 같은 Drive 폴더에 넣고 보관함을 새로고침하면 나타납니다. 재생 후 ‘이미지 선택 / 변경’에서 JPG·PNG·WebP를 선택하세요. 이미지는 최대 768px·80 KiB JPEG로 줄여 계정별로 D1에 저장하며, GitHub에는 올리지 않습니다. 이미지를 지정하지 않으면 앱 기본 이미지를 표시합니다.
- MP3는 네이티브 오디오 재생기를 사용하며 재인코딩하지 않습니다. 플레이어 범위의 Service Worker가 브라우저의 구간 요청에 Google Authorization 헤더를 붙입니다. 토큰은 요청한 탭에만 확인하고 디스크·Cache API에 저장하지 않습니다. Worker 서버가 오디오를 중계하지 않습니다. 이 기능은 HTTPS와 Service Worker가 필요하며, Discord 내장 화면에서 제한되면 외부 Chrome·Safari로 이어재생해야 합니다.
- MP3의 작은 창에는 커버를 그린 무음 캔버스 영상만 보내고 원본 오디오는 그대로 재생합니다. MP3 사이를 이동할 때 작은 창을 유지합니다. 브라우저의 캔버스 스트림·PiP 지원이 필요하며, 실제 iPhone에서의 이 조합은 아직 검증하지 않았습니다.
- 브라우저가 최대 4 MiB씩 구간 요청하고, 응답을 받는 즉시 MP4Box로 짧은 MSE 조각을 공급합니다. 다운로드 조각 전체나 다음 키프레임까지 기다린 뒤 재생하는 방식을 피합니다. 파일 끝의 MP4 색인과 앞뒤 탐색을 지원합니다.
- 영상 비트레이트에 따라 최대 약 60초를 미리 받으며, 최근 다운로드 구간을 영상별 최대 16 MiB까지 메모리에 보관해 되감기에 재사용합니다. 영상을 바꾸면 이 캐시는 해제됩니다. 파일 전체를 내려받거나 디스크에 영상을 저장하지 않습니다.
- 일시적인 연결 오류·서버 오류는 이미 받은 구간을 재생하면서 재시도합니다. 받아 놓은 구간이 소진되거나 기기가 앱을 중단시키는 상황에서는 끊김을 완전히 막을 수 없습니다.
- 재생 토큰은 URL에 넣지 않습니다. 영상 요청의 Authorization 헤더에만 넣으며, 갱신이 필요하면 로그인된 API에서 다시 받습니다.
- Android Chrome·Discord의 MSE와 iPhone iOS 17.1 이상 Safari·Discord의 ManagedMediaSource를 사용합니다. H.264/AAC MP4를 권장하며, 지원하지 않는 코덱은 재생할 수 없습니다. Discord 모바일 실행은 개발자 포털에서 iOS·Android를 모두 활성화해야 합니다.
- 표준 PiP와 Safari의 작은 창 API를 지원합니다. Discord 앱이 해당 기능을 제한하면 ‘브라우저에서 열기’로 이동할 수 있습니다. 모바일 실기기의 최종 재생·PiP·백그라운드 동작은 각 기기에서 확인해야 합니다.
- Discord 안에서 PiP를 지원하지 않으면 ‘브라우저에서 PiP’ 또는 ‘브라우저로 이어재생’을 사용합니다. Chrome(Android)·Safari(iPhone)에서 로그인하면 선택한 영상·재생 위치·목록·반복·셔플을 이어갑니다. 영상 선택 전에는 브라우저의 PiP 버튼이 비활성화됩니다.
- 브라우저 이동 정보에는 파일 ID와 재생 설정만 포함합니다. URL의 fragment를 읽은 뒤 즉시 지우고, 로그인 중에는 탭의 sessionStorage에 최대 15분 보관합니다. 인증 토큰이나 파일 이름은 이동 URL에 넣지 않습니다.
- 절전·PC 종료·브라우저 종료 상태에서는 해당 기기에서 재생되지 않습니다. 다른 기기는 호스팅된 플레이어에 계속 접속할 수 있습니다.
- Drive 속도, 이용 제한, 네트워크에 따라 버퍼링이 생길 수 있습니다. 무버퍼링이나 무제한 전송을 보장하지 않습니다.
- 큰 파일의 색인 처리에 메모리가 필요합니다. 초기 색인 다운로드는 32 MiB로 제한하며, DRM/손상된 파일은 지원하지 않습니다.

## 보안

공개 저장소에는 영상, 서비스 계정 키, Discord 비밀 키, 개인 재생목록을 넣지 마세요. `.gitignore`는 로컬 인증 파일을 제외합니다.

**이 앱 전용 Google 서비스 계정**을 만들고 필요한 Drive 폴더만 뷰어로 공유하세요. 브라우저에 발급하는 Google 읽기 토큰은 서비스 계정에 공유된 다른 파일에도 적용될 수 있습니다. 폴더 ID 검증은 Google 토큰 자체의 권한을 더 좁히지 않습니다. 앱 소유자만 로그인하도록 `DISCORD_ALLOWED_USERS`를 설정하세요.

앱 세션은 탭의 sessionStorage에 저장되며 8시간 후 만료됩니다. Drive 토큰은 플레이어 메모리에서만 사용합니다. Worker 응답에는 `private, no-store`를 적용합니다. CORS와 별도로 모든 비공개 API에서 세션과 허용 계정을 검증합니다. Discord 명령은 Ed25519 서명·시간·사용자·서버를 검증합니다.

## 개발

Node.js 24 이상을 사용합니다.

```sh
npm ci
npm test
npm run build
```

정적 배포 결과는 `docs/`입니다. 기본 설정은 빈 값이므로 서버가 준비되지 않았다는 안내가 나옵니다. 실제 공개 주소는 Git에서 제외되는 `config.local.json`에 설정한 뒤 다시 빌드합니다.

```json
{
  "apiBase": "https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev",
  "discordClientId": "YOUR_APPLICATION_ID"
}
```

이 두 값은 비밀이 아니며 빌드 시 `docs/config.json`에 공개됩니다. GitHub Pages는 `main` 브랜치의 `/docs` 폴더를 게시하도록 설정합니다.

## Worker와 D1 배포

`wrangler.jsonc`의 D1 데이터베이스 ID를 실제 ID로 바꾸고 다음 설정을 Worker에 등록하세요. 개발용 비밀은 `.dev.vars`에만 저장하세요.

| 이름 | 종류 | 용도 |
| --- | --- | --- |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Secret | 전용 서비스 계정 JSON 전체 |
| `DISCORD_CLIENT_SECRET` | Secret | Discord OAuth 비밀 키 |
| `SESSION_SECRET` | Secret | 무작위 32바이트 이상의 세션 서명 키 |
| `DISCORD_CLIENT_ID` | 변수 | 앱 ID |
| `DISCORD_PUBLIC_KEY` | 변수 | 명령 검증 공개 키 |
| `DISCORD_ALLOWED_USERS` | 변수 | 허용 사용자 ID, 쉼표 구분 |
| `DISCORD_GUILD_ID` | 변수 | 허용 서버 ID |
| `DRIVE_FOLDER_ID` | 변수 | 공유한 폴더 ID |
| `FRONTEND_URL` | 변수 | `https://OWNER.github.io/drive-screen/` |
| `PUBLIC_API_URL` | 변수 | Worker의 HTTPS 주소, 끝 슬래시 제외 |

```sh
npx wrangler login --scopes account:read user:read workers_scripts:write d1:write
npx wrangler d1 create drive-screen
npm run db:remote
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON
npx wrangler secret put DISCORD_CLIENT_SECRET
npx wrangler secret put SESSION_SECRET
npm run api:deploy
```

데이터베이스 바인딩 이름은 `DB`입니다. 운영 배포에 `DEV_ORIGIN`을 넣지 마세요. 유료 요금제로 전환하지 않아도 되며, 무료 한도 소진 시 API가 제한될 수 있습니다.

## Discord 설정

OAuth Redirect에 `https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/auth/callback`을 추가합니다. Interactions Endpoint는 같은 Worker의 `/interactions`입니다. Activity를 활성화하고 `/시청`을 Primary Entry Point 명령으로 등록합니다.

Activity URL Mappings는 구체적인 경로를 먼저, `/`를 마지막에 둡니다.

| Prefix | Target |
| --- | --- |
| `/api` | `YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev` |
| `/gdrive` | `www.googleapis.com` |
| `/` | `OWNER.github.io/drive-screen` |

Discord 프록시는 prefix를 제거하므로 Worker는 `/api/library`와 `/library`를 모두 처리합니다. 영상 요청은 `/gdrive/drive/v3/files/ID?alt=media`로 보냅니다.

## 검증 범위

Worker 테스트는 위조·만료 세션 거부, 계정별 목록 격리, OAuth 일회용 티켓·재사용 거부, 명령 서명 검증, 비공유 파일 재생 인증 거부를 확인합니다. 별도 브라우저 검증에서 직접 생성한 2분 MP4로 파일 끝 색인, 구간 스트리밍, 토큰 갱신, 앞뒤 탐색, 한 편 반복, PiP, 브라우저 이어재생을 확인했습니다. 긴 키프레임 간격·B 프레임 샘플과 연결 끊김 복구도 검증했습니다. 휴대폰의 실제 성능은 회선·Drive 응답·기기 정책에 따라 달라집니다.

MP3는 직접 생성한 2분 VBR 파일로 실제 Chromium Service Worker와 네이티브 오디오를 검증했습니다. 앞뒤 탐색, 401 인증 갱신, Safari식 두 바이트·suffix 구간 요청, 탭 사이 인증 격리, 커버 압축·저장·복원·삭제, 이미지 PiP 중 오디오 진행, MP3 간 PiP 유지, MP4 전환, 반복 재생을 확인했습니다. Safari식 요청의 검증은 실제 iPhone 테스트를 대신하지 않습니다.

ManagedMediaSource 생성 경로와 `disableRemotePlayback` 설정은 브라우저 테스트에서 대체 구현으로 확인했습니다. 이 검증은 실제 iPhone WebKit에서의 재생 테스트를 대신하지 않습니다.
