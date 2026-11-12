# Drive Screen

Google Drive의 MP4를 Discord 또는 웹 브라우저에서 재생하는 개인용 플레이어입니다. 재생목록, 순서 편집, 셔플, 한 편·전체 반복, 지원 브라우저의 PiP와 Media Session을 제공합니다.

## 구조

```text
GitHub Pages ── 플레이어 HTML/CSS/JS
      │
      ├── Cloudflare Worker ── Discord 로그인·/시청·Drive 목록·임시 재생 인증
      │          └── D1 ── 계정별 재생목록
      │
      └── Google Drive ── Authorization 헤더 + Range로 영상 직접 읽기
```

Worker는 영상 파일을 중계하거나 저장하지 않습니다. Discord 안에서는 Discord의 Activity 네트워크 프록시를 거칩니다. PC에서 상시 실행할 프로그램은 필요하지 않습니다. GitHub Pages와 Worker 배포, Discord 설정이 모두 완료되어야 작동합니다.

## 재생 방식과 제한

- 브라우저가 1 MiB씩 구간 다운로드하고 MP4Box로 MSE 영상 조각을 만듭니다. 파일 전체를 받은 다음 재생하는 방식이 아닙니다. 파일 끝의 MP4 색인과 앞뒤 탐색을 지원합니다.
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

Worker 테스트는 위조·만료 세션 거부, 계정별 목록 격리, OAuth 일회용 티켓·재사용 거부, 명령 서명 검증, 비공유 파일 재생 인증 거부를 확인합니다. 별도 브라우저 검증에서 직접 생성한 2분 MP4로 파일 끝 색인, 1 MiB 구간 요청, 토큰 갱신, 앞뒤 탐색, 한 편 반복, PiP를 확인했습니다. 실서비스와 모바일에서의 최종 재생 확인은 배포 후 별도로 필요합니다.

ManagedMediaSource 생성 경로와 `disableRemotePlayback` 설정은 브라우저 테스트에서 대체 구현으로 확인했습니다. 이 검증은 실제 iPhone WebKit에서의 재생 테스트를 대신하지 않습니다.
