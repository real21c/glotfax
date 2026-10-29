# glotfax

휴대폰이나 다른 PC 에서 팩스를 보내는 **원격 팩스 발송 게이트웨이**입니다.

팩스 기능이 있는 복합기와 PC 한 대를 **게이트웨이**로 삼습니다. 브라우저에서 파일(PDF · TXT · JPG · PNG)을 올리면 게이트웨이의 에이전트가 받아서 복합기의 PC-FAX 기능으로 보냅니다. 받는 쪽에는 게이트웨이의 팩스 번호가 표시됩니다. 팩스 앱이나 인터넷 팩스 서비스 없이, 이미 있는 팩스 회선을 그대로 씁니다.

```
[휴대폰 · PC 브라우저]   파일 + 받는 번호
        │  안드로이드는 다른 앱에서 파일 공유 → glotfax
        ▼
[Cloudflare Worker]     웹 화면 · API
   ├─ R2               올린 파일 보관 (기본 3일)
   ├─ D1               작업 · 게이트웨이 · 설정
   └─ Durable Object   게이트웨이별 WebSocket — 새 작업을 바로 넘김
        │  게이트웨이 쪽에서 나가는 연결이라 포트를 열 필요 없음
        ▼
[게이트웨이]             PC 의 에이전트 — Node.js (Windows + WSL, 또는 Linux)
        │  제조사 백엔드 (Epson · HP)
        ▼
[복합기] ──── 팩스 회선 ────▶ 받는 쪽
```

## 할 수 있는 것

- 브라우저에서 파일을 끌어다 놓거나 골라서 팩스를 보냅니다 (여러 개면 하나씩 차례로 보냅니다). 파일을 고르는 순간 형식과 용량을 검사해, 안 되는 파일은 바로 알립니다
- 안드로이드: 홈 화면에 추가(PWA)하면 다른 앱의 **공유 메뉴**에서 바로 glotfax 로 보낼 수 있습니다
- 보낸 기록: 보내는 동안 지금 어느 단계인지(복합기 연결 확인 → 문서 변환 → 복합기가 거는 중 …) 보이고, 끝난 뒤에는 전송 기록에서 시도별로(1차 · 2차 …) 시각과 결과, 어느 기기 · 브라우저 · IP 에서 올렸는지 볼 수 있습니다. 실패한 건 다시 보내기, 올린 파일 열기(3일 보관)
- 통계: 오늘 보낸 건수와, 주를 골라 날짜별 보냄 · 완료 · 실패 건수를 봅니다
- 받는 번호를 자동으로 채웁니다 (마지막으로 보낸 번호 → 최근 번호 → 기본 번호)
- 설정: 게이트웨이 드라이버 고르기와 설치 안내, 기본 받는 번호, 비밀번호 바꾸기, 모든 기기에서 로그아웃
- 로그인 기록: 로그인 · 로그인 실패 · 로그아웃마다 일시, IP, 기기 · 브라우저를 남기고 설정 화면에서 보여 줍니다. 안드로이드 크롬 계열은 기기 모델 코드(예: SM-S918N)도 함께 남습니다. `wrangler.jsonc` 의 `IP_LABELS` 에 IP 별 이름을 적어 두면 IP 옆에 이름표가 붙습니다
- 같은 팩스를 두 번 보내지 않도록 (작업, 시도) 단위로 기록합니다

## 지원 복합기

| 제조사 | 방식 | 확인 |
|---|---|---|
| **Epson** | [Epson PC-Fax 2 Driver for Linux](https://download-center.epson.com/) 의 `epfax2` | 실제 복합기(L6490)로 전송을 확인했습니다 |
| **HP** | HPLIP 의 `hp-sendfax -n` | 드라이버 설치와 명령까지 확인했습니다. 실제 HP 복합기로는 아직 테스트하지 않았습니다 |
| 그 외 | `agent/src/backends/` 에 `FaxBackend`(`send()` 하나)를 구현해 추가할 수 있습니다 | — |

Windows 용 팩스 드라이버(인쇄할 때 번호 입력 창이 뜨는 방식)는 쓰지 않습니다. **리눅스 드라이버**를 쓰며, Windows PC 에서는 WSL 안에서 돌립니다.

다른 복합기로 확인해 보셨다면 이슈로 알려 주세요.

## 준비물

- Cloudflare 계정 (Workers · D1 · R2 · Durable Objects, 무료 플랜으로 충분합니다)
- Node.js 24 이상
- 게이트웨이로 쓸 PC: 복합기와 같은 네트워크에 있는 **Windows(WSL 2) 또는 Linux(x64)** PC
  - 복합기는 네트워크로 연결돼 있어야 합니다 (Epson 리눅스 드라이버는 USB 연결을 지원하지 않습니다)

## 1. 서버 배포 (Cloudflare)

```bash
git clone https://github.com/real21c/glotfax.git
cd glotfax
npm install

cd worker
npx wrangler login                          # Windows PowerShell 은 npx.cmd
npx wrangler d1 create glotfax              # 나온 database_id 를 wrangler.jsonc 에
npx wrangler r2 bucket create glotfax-files
npx wrangler secret put SESSION_SECRET      # 긴 임의 문자열
npx wrangler secret put ADMIN_TOKEN         # 관리용 긴 임의 문자열
npm run db:migrate:remote
npm run deploy
```

- 임의 문자열 만들기: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`
- 내 도메인을 쓰려면 `wrangler.jsonc` 의 `routes` 주석을 풀고 주소를 바꿔 주세요. 없으면 `glotfax.<계정>.workers.dev` 로 열립니다
- 보관 기간과 파일 크기는 `wrangler.jsonc` 의 `RETENTION_DAYS`(기본 3), `MAX_FILE_MB`(기본 10)로 정합니다
- 푸터의 이용약관 · 개인정보처리방침 · 신고·문의 페이지(`worker/public/terms.html`, `privacy.html`, `help.html`)에 있는 `<운영자>`, `<책임자 이름>`, `<메일>` 을 직접 운영하시는 분의 정보로 바꿔 주세요. 개인정보처리방침에는 운영자와 연락처가 꼭 들어가야 합니다. 내용은 기본 설정 기준이므로, 보관 기간 등을 바꿨다면 함께 고쳐 주세요

### 보내는 사람 비밀번호 · 게이트웨이 등록

```bash
curl -X POST https://<주소>/api/admin/password \
  -H "Authorization: Bearer <ADMIN_TOKEN>" -H "Content-Type: application/json" \
  -d '{"password":"<4자 이상>"}'

curl -X POST https://<주소>/api/admin/gateways \
  -H "Authorization: Bearer <ADMIN_TOKEN>" -H "Content-Type: application/json" \
  -d '{"name":"gateway-1"}'
# → {"id":"...","token":"gfg_..."}  게이트웨이 토큰은 이때 한 번만 나옵니다
```

비밀번호는 로그인한 뒤 **설정** 화면에서 바꿀 수 있습니다 (바꾸면 다른 기기는 로그아웃됩니다).

## 2. 게이트웨이 준비

### Windows: WSL 설치

관리자 PowerShell 에서 실행합니다.

```powershell
wsl --install Ubuntu-24.04 --no-launch
```

메모리가 빠듯한 PC 는 `%USERPROFILE%\.wslconfig` 로 WSL 메모리를 줄여 두면 안정적입니다.

```
[wsl2]
memory=2GB
swap=1GB
```

이후 명령은 `wsl -d Ubuntu-24.04 -u root` 로 들어가서 실행합니다. Linux PC 는 바로 실행하면 됩니다.

### 공통 패키지

```bash
apt-get update
apt-get install -y --no-install-recommends cups cups-client cups-filters fonts-nanum fonts-nanum-coding paps poppler-utils
```

- `paps` 와 한글 글꼴은 TXT 파일을 팩스로 보낼 때 한글이 깨지지 않게 해 줍니다 (CUPS 기본 변환은 한글을 그리지 못합니다)
- `poppler-utils` 의 `pdfinfo` 로 장수를 세어, 장수가 많은 문서는 더 오래 기다립니다

### Epson

Epson 다운로드 센터에서 복합기 모델 → OS `Linux Deb(x64)` → **Epson PC-Fax 2 Driver** 를 골라, 사용권에 동의하고 받습니다.

```bash
dpkg -i epson-pc-fax2-<버전>.deb
lpadmin -p EPSON_FAX2 -E -v epsonfax2://<복합기 IP> -P /usr/share/cups/model/Epson/Epson-PC-Fax2.ppd
```

### HP

```bash
apt-get install -y --no-install-recommends hplip hplip-gui     # hp-sendfax 는 hplip-gui 에 들어 있음
useradd -m -s /bin/bash -G lpadmin,lp glotfax                 # hp-sendfax 는 root 로 실행되지 않음
hp-setup                                                       # 복합기를 찾아 팩스 대기열 등록
```

## 3. 에이전트

```bash
cp agent/.env.example agent/.env
```

| 설정 | 내용 |
|---|---|
| `GLOTFAX_SERVER` | 서버 주소 (`https://<주소>`) |
| `GLOTFAX_TOKEN` | 게이트웨이를 등록할 때 받은 토큰 |
| `GLOTFAX_BACKEND` | 처음 쓸 백엔드 `epson` · `hp` · `mock`(실제로 보내지 않음). 이후에는 설정 화면에서 바꿉니다 |
| `FAX_WSL_DISTRO` | Windows 에서 돌릴 때 WSL 배포판 이름 (예: `Ubuntu-24.04`). Linux 면 비워 둡니다 |
| `EPSON_PRINTER` · `HP_PRINTER` · `HP_USER` | CUPS 대기열 이름, hp-sendfax 를 실행할 사용자 |

```bash
npm run agent
```

웹 화면 위에 **게이트웨이 연결됨**이 뜨면 준비가 끝난 것입니다. 에이전트는 켜질 때 그 PC 의 드라이버와 팩스 대기열을 찾아 알려 주고, **설정 → 게이트웨이** 에서 쓸 드라이버를 고를 수 있습니다.

### 자동 실행

- **Windows**: `agent/.env.production` 에 설정을 넣고, 시작프로그램 폴더(`shell:startup`)에 바로 가기를 만듭니다.
  `wscript.exe "<에이전트 폴더>\run-hidden.vbs"` — 창 없이 실행하고, 꺼지면 10초 뒤 다시 켜며, 이미 떠 있으면 아무것도 하지 않습니다. 로그는 `agent/data/production/agent.log` 에 남습니다
- **Linux**: `agent/glotfax-agent.service` (systemd) 를 씁니다

## 로컬 개발

```bash
npm install
cp worker/.dev.vars.example worker/.dev.vars    # SESSION_SECRET, ADMIN_TOKEN
npm run db:migrate:local -w worker
npm run dev                                      # http://localhost:8787
```

에이전트를 `GLOTFAX_BACKEND=mock` 으로 띄우면 실제 팩스 없이 흐름을 확인할 수 있습니다 (번호가 `000` 으로 시작하면 실패로 처리합니다).

## 동작 방식

- 작업 상태는 `queued` → `dispatched` → `sending` → `sent` | `failed` 로 바뀝니다
- 에이전트가 꺼져 있으면 작업은 대기로 남았다가, 에이전트가 연결되는 순간 넘어갑니다
- 전송 도중 에이전트가 꺼졌던 건 이미 나갔을 수 있어서, 자동으로 다시 보내지 않고 실패로 표시합니다
- 보내기 전에 게이트웨이에서 복합기에 연결되는지 먼저 확인합니다. 안 되면 리눅스(WSL)를 한 번 다시 켜서 다시 확인하고, 그래도 안 되면 바로 "복합기에 연결하지 못했어요"로 실패 처리합니다. 보내는 동안에도 30초마다 연결을 확인해, 끊기면 취소합니다
- Epson: `epfax2` 는 CUPS 대기열에 넣고 바로 끝나기 때문에, 대기열에서 빠질 때까지 기다린 뒤 드라이버 로그로 결과를 판정합니다. 기다리는 시간은 15분, 장수가 많으면 3분 + 장당 2분입니다. 복합기가 자동으로 재다이얼하면 마지막 시도로 판정하고, 드라이버 로그 원문은 게이트웨이의 `agent/data/<환경>/epson-fax.log` 에만 남기고 서버에는 시각과 한국어 문장으로 정리한 기록만 보냅니다
- 드라이버 · 복합기 확인이 실패하면 5초 간격으로 3번까지 다시 확인하고, 그래도 안 되면 이유를 `agent.log` 에 남깁니다. 전에 정상이었다면 일시적인 실패로 목록을 바꾸지 않습니다
- HP: `hp-sendfax` 는 실패해도 종료 코드가 0 이라서 출력 문구로 결과를 판정합니다

## 라이선스

[MIT](LICENSE) © 2026 now100k

- 개인과 회사 모두 무료로 쓸 수 있습니다. 고쳐 쓰거나, 다른 서비스에 넣거나, 판매해도 됩니다
- 조건은 하나입니다. 복사하거나 고쳐서 배포할 때 [`LICENSE`](LICENSE) 파일(저작권 표시와 허가 문구)을 함께 넣어 주세요
- 보증하지 않습니다. 팩스가 잘못 가거나 가지 않아서 생긴 손해는 만든 사람이 책임지지 않습니다. 중요한 문서는 받는 쪽에 도착했는지 꼭 확인해 주세요
- 팩스 드라이버는 이 저장소에 들어 있지 않습니다. Epson · HP 드라이버는 각 제조사에서 받아 설치하며, 그 드라이버의 사용 조건(HPLIP 은 GPL 등, Epson 은 Epson 사용권 계약)을 따릅니다
