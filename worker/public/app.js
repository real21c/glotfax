const $ = (id) => document.getElementById(id);

// 상태 표시: [글자, .status 색]
const STATUS = {
  queued: ['대기 중', 'wait'],
  dispatched: ['대기 중', 'wait'],
  sending: ['보내는 중', 'run'],
  sent: ['완료', 'ok'],
  failed: ['실패', 'err'],
};
const FINAL = new Set(['sent', 'failed']);
const FAX_NUMBER_RE = /^[0-9][0-9,-]{2,40}$/;
const ALLOWED_RE = /\.(pdf|txt|jpe?g|png)$/i;
const ALLOWED_TYPES = ['application/pdf', 'text/plain', 'image/jpeg', 'image/png'];
const RECENT_KEY = 'glotfax.recentNumbers';
const HIDDEN_KEY = 'glotfax.hiddenNumbers';
const SHARE_CACHE = 'glotfax-share';

let selectedFiles = [];
const MAX_FILES = 10;
let maxFileMb = 10;
let pollTimer = null;
let numberPrefilled = false;
let lastStatus = new Map(); // 기록별 직전 상태 (바뀐 줄 표시용)
let lastJobsKey = '';

// ------------------------------------------------------------ API

// 홈 화면에 설치한 앱(PWA)으로 열렸는지. 브라우저 정보만으로는 크롬과 똑같아서 서버에 따로 알린다
const VIA = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true ? 'pwa' : 'browser';
// 기기 모델 코드(예: SM-S918N). 브라우저 정보에는 없어서 크롬 계열에 따로 물어본다 (안드로이드만 값이 있음)
const DEVICE = (navigator.userAgentData?.getHighEntropyValues?.(['model']) ?? Promise.resolve({}))
  .then((v) => (v.model || '').trim().slice(0, 60))
  .catch(() => '');
/** 요청마다 붙이는 머리글: 앱으로 열었는지, 기기 모델 */
async function clientHeaders() {
  const device = await DEVICE;
  return device ? { 'X-Glotfax-Via': VIA, 'X-Glotfax-Device': device } : { 'X-Glotfax-Via': VIA };
}

async function api(path, options = {}) {
  const headers = { ...(await clientHeaders()), ...options.headers };
  const res = await fetch(path, { credentials: 'same-origin', ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') {
    showLogin();
    throw new Error(data.error || '로그인이 필요합니다');
  }
  if (!res.ok) throw new Error(data.error || `요청 실패 (${res.status})`);
  return data;
}

// ------------------------------------------------------------ 화면 전환

function showLogin() {
  stopPolling();
  $('login-view').hidden = false;
  $('send-view').hidden = true;
  $('settings-view').hidden = true;
  $('menu').hidden = true;
  $('gateway-status').hidden = true;
  $('password').focus();
}

async function showMain() {
  await Promise.all([refreshMe(), refreshJobs()]);
  $('login-view').hidden = true;
  $('menu').hidden = false;
  renderRecentNumbers();
  showView();
}

/** 상단 메뉴: #settings 면 설정, 아니면 보내기. 설정은 #settings/<탭> 으로 항목 하나씩 */
// 보내기도 같은 구조: #send/<항목>. 주소가 그냥 # 이면 보내기 첫 항목
const TABS = { send: ['new', 'history', 'stats'], settings: ['fax', 'number', 'password', 'history', 'logout'] };

function showView() {
  const view = location.hash.startsWith('#settings') ? 'settings' : 'send';
  const tabName = location.hash.split('/')[1];
  $('send-view').hidden = view !== 'send';
  $('settings-view').hidden = view !== 'settings';
  for (const a of document.querySelectorAll('#menu a')) a.classList.toggle('active', a.dataset.view === view);

  const tab = TABS[view].includes(tabName) ? tabName : TABS[view][0];
  for (const a of document.querySelectorAll(`#${view}-tabs a`)) a.classList.toggle('active', a.dataset.tab === tab);
  for (const p of document.querySelectorAll(`#${view}-view .panel`)) p.hidden = p.dataset.panel !== tab;
  if (view === 'send' && tab === 'stats') refreshDailyStats().catch(() => {});
  if (view === 'settings' && tab === 'history') refreshAccessLogs().catch(() => {});
}

window.addEventListener('hashchange', () => {
  if (!$('menu').hidden) showView();
});

// ------------------------------------------------------------ 로그인

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').hidden = true;
  try {
    await api('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: $('password').value }),
    });
    $('password').value = '';
    await showMain();
  } catch (err) {
    $('login-error').textContent = err.message;
    $('login-error').hidden = false;
  }
});

$('logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST', headers: await clientHeaders() }).catch(() => {});
  history.replaceState(null, '', '/');
  showLogin();
});

$('logout-all').addEventListener('click', async () => {
  if (!confirm('이 기기를 포함해 로그인된 모든 기기에서 로그아웃할까요?')) return;
  try {
    await api('/api/logout-all', { method: 'POST' });
  } catch (err) {
    return alert(err.message);
  }
  history.replaceState(null, '', '/');
  showLogin();
});

// ------------------------------------------------------------ 로그인 기록

const ACCESS_EVENT = {
  login: ['로그인', ''],
  'login-failed': ['로그인 실패 (비밀번호 틀림)', 'err'],
  'login-blocked': ['로그인 막힘 (여러 번 틀림)', 'err'],
  logout: ['로그아웃', ''],
  'logout-all': ['모든 기기 로그아웃', ''],
};

async function refreshAccessLogs() {
  const { logs } = await api('/api/access-logs');
  $('access-empty').hidden = logs.length > 0;
  $('access-table').hidden = logs.length === 0;
  $('access-logs').replaceChildren(
    ...logs.map((l) => {
      const [label, tone] = ACCESS_EVENT[l.event] ?? [l.event, ''];
      const tr = document.createElement('tr');
      // 일시 | 내용 | 접속 환경(기기 · 브라우저 · IP). 좁은 화면에서는 접속 환경이 내용 밑으로 내려간다
      const what = cell(`event ${tone}`, label);
      what.append(whoLine(l.ip, l.userAgent, l.via, l.device)); // 좁은 화면용 (넓은 화면에서는 숨김)
      const who = cell('who');
      who.append(whoLine(l.ip, l.userAgent, l.via, l.device));
      tr.append(cell('time', formatTime(l.createdAt)), what, who);
      return tr;
    }),
  );
}

// IP 이름표 (서버 설정 IP_LABELS). 예: 특정 IP 옆에 [본사]
let ipLabels = {};

/** "기기 · 브라우저 · IP" 글자에 IP 이름표 뱃지를 붙인다 */
function fillWho(el, ip, ua, via, device) {
  el.textContent = [describeAgent(ua, via, device), ip].filter(Boolean).join(' · ') || '알 수 없음';
  if (ip && ipLabels[ip]) {
    const badge = document.createElement('span');
    badge.className = 'ip-badge';
    badge.textContent = ipLabels[ip];
    el.append(badge);
  }
  return el;
}

/** IP · 기기 · 브라우저 한 줄 ("Android(PWA) · Chrome · IP"). 마우스를 올리면 브라우저 정보 원문 */
function whoLine(ip, ua, via, device) {
  const span = document.createElement('span');
  span.className = 'who-line';
  fillWho(span, ip, ua, via, device);
  if (ua) span.title = ua;
  return span;
}

/** 브라우저 정보(User-Agent)를 "Android · 삼성 인터넷" 처럼 짧게 */
function describeAgent(ua, via, model) {
  if (!ua) return '';
  const device = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Mac OS X|Macintosh/.test(ua)
            ? 'Mac'
            : /Linux/.test(ua)
              ? 'Linux'
              : '';
  const browser = /KAKAOTALK/i.test(ua)
    ? '카카오톡'
    : /SamsungBrowser/.test(ua)
      ? '삼성 인터넷'
      : /Whale/.test(ua)
        ? '네이버 웨일'
        : /NAVER/.test(ua)
          ? '네이버 앱'
          : /Edg\//.test(ua)
            ? 'Edge'
            : /Firefox|FxiOS/.test(ua)
              ? 'Firefox'
              : /Chrome|CriOS/.test(ua)
                ? 'Chrome'
                : /Safari/.test(ua)
                  ? 'Safari'
                  : '';
  // 설치한 앱으로 열었으면 기기 이름 뒤에 (PWA)
  const os = via === 'pwa' ? `${device || '기기'}(PWA)` : device;
  // 기기 모델 코드가 있으면 그대로 (예: Android(PWA) · SM-S918N · Chrome)
  // 예전 기록: 브라우저 정보 안에 모델명이 남아 있으면 그걸 쓴다 ("Android 13; SM-N981N Build/…"). 크롬이 숨긴 "K" 는 뺀다
  const fromUa = /Android [\d.]+; ([^;)]+?)(?: Build\/| wv|\))/.exec(ua)?.[1]?.trim();
  const shown = model || (fromUa && fromUa !== 'K' ? fromUa : '');
  return [os, shown, browser].filter(Boolean).join(' · ') || '기타 기기';
}

// ------------------------------------------------------------ 기본 받는 번호

$('default-number-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('default-number-msg');
  const show = (text, ok = false) => {
    msg.textContent = text;
    msg.classList.toggle('form-ok', ok);
    msg.hidden = false;
  };
  const number = $('default-number').value.replace(/\s/g, '');
  if (number && !FAX_NUMBER_RE.test(number)) return show('팩스 번호를 확인해 주세요 (숫자와 - 만)');
  try {
    await api('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultFaxNumber: number }),
    });
    show(number ? '저장했어요' : '기본 받는 번호를 지웠어요', true);
  } catch (err) {
    show(err.message);
  }
});

// ------------------------------------------------------------ 비밀번호 바꾸기

$('password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('password-msg');
  const show = (text, ok = false) => {
    msg.textContent = text;
    msg.classList.toggle('form-ok', ok);
    msg.hidden = false;
  };
  const current = $('current-password').value;
  const next = $('new-password').value;
  if (!current) return show('지금 비밀번호를 넣어 주세요');
  if (next.length < 4) return show('새 비밀번호는 4자 이상이어야 해요');
  if (next !== $('new-password-2').value) return show('새 비밀번호가 서로 달라요');
  if (next === current) return show('지금 비밀번호와 다른 비밀번호를 넣어 주세요');

  try {
    await api('/api/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current, next }),
    });
    e.target.reset();
    show('비밀번호를 바꿨어요. 다른 기기에서는 새 비밀번호로 다시 로그인해 주세요.', true);
  } catch (err) {
    show(err.message);
  }
});

// ------------------------------------------------------------ 게이트웨이 상태

async function refreshMe() {
  const me = await api('/api/me');
  maxFileMb = me.maxFileMb ?? 10;
  ipLabels = me.ipLabels ?? {};
  // 처음 열 때 한 번만: 받는 번호 칸 채우기 — 마지막에 보낸 번호 → 이 기기의 최근 번호 → 기본 받는 번호
  if (!numberPrefilled) {
    numberPrefilled = true;
    $('default-number').value = me.defaultFaxNumber ?? '';
    const hidden = loadHidden();
    const fallback = [me.lastFaxNumber, ...loadRecent()].find((n) => n && !hidden.includes(n)) || me.defaultFaxNumber;
    if (fallback && !$('fax-number').value) {
      $('fax-number').value = fallback;
      updateSummary();
    }
  }
  $('max-size').textContent = `${maxFileMb}MB`;

  const select = $('gateway');
  const current = select.value;
  select.replaceChildren(
    ...me.gateways.map((g) => {
      const o = document.createElement('option');
      o.value = g.id;
      o.textContent = `${g.name}${g.online ? '' : ' (꺼짐)'}`;
      return o;
    }),
  );
  if (current) select.value = current;
  $('gateway-field').hidden = me.gateways.length < 2;

  const chosen = me.gateways.find((g) => g.id === select.value) ?? me.gateways[0];
  const pill = $('gateway-status');
  pill.hidden = false;
  const testMode = chosen?.online && chosen.backend === 'mock';
  pill.className = `pill${!chosen?.online ? ' gray' : testMode ? ' warn' : ''}`;
  // 좁은 화면에서는 짧은 글자
  const [long, short] = !chosen
    ? ['게이트웨이 없음', '없음']
    : !chosen.online
      ? ['게이트웨이 꺼짐', '꺼짐']
      : testMode
        ? ['테스트 모드 · 실제로 안 보냄', '테스트']
        : ['게이트웨이 연결됨', '연결됨'];
  pill.querySelector('.label-long').textContent = long;
  pill.querySelector('.label-short').textContent = short;

  renderGatewaySettings(me.gateways);
}

$('gateway').addEventListener('change', () => refreshMe().catch(() => {}));

// ------------------------------------------------------------ 설정: 게이트웨이 백엔드

const gatewayMsg = new Map(); // 게이트웨이별 안내 문구 (다시 그려도 유지)
let gatewaySettingsKey = '';

/** 게이트웨이마다 [이름 · 상태] + [쓸 수 있는 드라이버 고르기] */
function renderGatewaySettings(gateways) {
  const box = $('gateway-settings');
  // 고르는 중에는 다시 그리지 않는다 (몇 초마다 갱신되면서 고른 값이 돌아가지 않게)
  if (box.contains(document.activeElement) && document.activeElement.tagName === 'SELECT') return;
  const key = JSON.stringify([gateways, [...gatewayMsg]]);
  if (key === gatewaySettingsKey) return;
  gatewaySettingsKey = key;

  if (!gateways.length) {
    box.innerHTML = '<p class="muted small">등록된 게이트웨이가 없어요</p>';
    return;
  }
  box.replaceChildren(
    ...gateways.map((g) => {
      const wrap = document.createElement('form');
      wrap.className = 'gw';

      const head = document.createElement('div');
      head.className = 'gw-head';
      const name = document.createElement('b');
      name.textContent = g.name;
      const right = document.createElement('span');
      right.className = 'right';
      const state = document.createElement('span');
      state.className = `status ${g.online ? 'ok' : 'err'}`;
      state.textContent = g.online ? '연결됨' : '꺼짐';
      right.append(state);
      if (g.online) {
        // 드라이버를 설치하거나 복합기를 등록한 뒤, 에이전트를 다시 켜지 않고 목록을 새로 받는다
        const recheck = document.createElement('button');
        recheck.type = 'button';
        recheck.className = 'btn sm';
        recheck.textContent = '다시 확인';
        recheck.addEventListener('click', async () => {
          recheck.disabled = true;
          try {
            await api(`/api/gateways/${g.id}/detect`, { method: 'POST' });
            gatewayMsg.set(g.id, { text: '게이트웨이의 드라이버와 복합기를 다시 확인했어요.', ok: true });
            setTimeout(() => {
              gatewaySettingsKey = '';
              refreshMe().catch(() => {});
            }, 2500);
          } catch (err) {
            gatewayMsg.set(g.id, { text: err.message, ok: false });
            gatewaySettingsKey = '';
            renderGatewaySettings(gateways);
          }
        });
        right.append(recheck);
      }
      head.append(name, right);
      wrap.append(head);

      const field = document.createElement('div');
      field.className = 'field';
      const label = document.createElement('label');
      label.textContent = '보낼 때 쓰는 복합기 드라이버';
      const select = document.createElement('select');
      select.name = 'backend';
      const options = g.online ? g.available ?? [] : [];
      // 쓸 수 없는 항목도 고를 수 있게 보여 주고, 고르면 무엇을 하면 되는지 모달로 안내한다
      for (const a of options) {
        const o = document.createElement('option');
        o.value = JSON.stringify({ backend: a.backend, printer: a.printer });
        const usable = a.enabled !== false;
        o.textContent = usable ? a.label : `${a.label} — ${SHORT_REASON[a.reasonCode] ?? '지금은 쓸 수 없어요'}`;
        if (!usable) o.dataset.unusable = '1';
        o.selected = usable && a.backend === g.backend && a.printer === (g.printer ?? '');
        select.append(o);
      }
      let lastUsable = select.value;
      select.addEventListener('change', () => {
        const picked = options[select.selectedIndex];
        if (picked && picked.enabled === false) {
          showGuide(picked);
          select.value = lastUsable; // 안내만 하고 원래 선택으로 돌린다
        } else {
          lastUsable = select.value;
        }
      });
      if (!options.length) {
        const o = document.createElement('option');
        o.textContent = g.online ? '확인 중…' : '게이트웨이가 켜지면 고를 수 있어요';
        select.append(o);
        select.disabled = true;
      }
      field.append(label, select);
      wrap.append(field);

      const msg = document.createElement('p');
      msg.className = 'form-err';
      const m = gatewayMsg.get(g.id) ?? (g.backendError ? { text: g.backendError, ok: false } : null);
      msg.hidden = !m;
      if (m) {
        msg.textContent = m.text;
        msg.classList.toggle('form-ok', m.ok);
      }
      wrap.append(msg);

      const button = document.createElement('button');
      button.type = 'submit';
      button.className = 'btn primary';
      button.textContent = '적용';
      button.disabled = !options.length;
      const actions = document.createElement('div');
      actions.className = 'actions';
      actions.append(button);
      wrap.append(actions);

      wrap.addEventListener('submit', async (e) => {
        e.preventDefault();
        button.disabled = true;
        try {
          await api(`/api/gateways/${g.id}/backend`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: select.value,
          });
          gatewayMsg.set(g.id, { text: '바꿨어요. 다음 팩스부터 이 드라이버로 보내요.', ok: true });
          // 에이전트가 바꾸고 알려 줄 시간을 준 뒤 다시 읽는다
          setTimeout(() => refreshMe().catch(() => {}), 1500);
        } catch (err) {
          gatewayMsg.set(g.id, { text: err.message, ok: false });
        }
        gatewaySettingsKey = '';
        renderGatewaySettings(gateways);
      });
      return wrap;
    }),
  );
}

// ------------------------------------------------------------ 안내 모달: 쓸 수 없는 드라이버

const SHORT_REASON = {
  'no-linux': '게이트웨이를 확인하지 못했어요',
  'no-driver': '드라이버 설치가 필요해요',
  'no-printer': '복합기 등록이 필요해요',
};
const SETUP_DOC = 'https://github.com/real21c/glotfax#2-게이트웨이-준비';

/** 제조사·이유별 안내. 명령은 게이트웨이의 리눅스(Windows 는 WSL, 관리자 root)에서 실행한다 */
function guideFor(a) {
  const n = a.label; // Epson · HP
  const where = '게이트웨이의 리눅스에서 실행하세요. Windows 게이트웨이는 관리자 PowerShell 에서 <code>wsl -d Ubuntu-24.04 -u root</code> 로 들어가서 실행해요.';
  if (a.reasonCode === 'no-linux') {
    return {
      title: '게이트웨이를 확인하지 못했어요',
      html: `<p>게이트웨이에 이 드라이버가 있는지 물어봤는데 답을 받지 못했어요. 게이트웨이가 막 켜졌거나 바쁜 중이면 그럴 수 있어요.</p>
        <ol>
          <li>잠시 뒤 <b>다시 확인</b>을 눌러 주세요. 대부분 이걸로 돌아와요.</li>
          <li>계속 이렇게 나오면 게이트웨이의 에이전트 기록(<code>agent.log</code>)에서 "드라이버 확인 실패" 줄을 확인해 주세요.</li>
          <li>처음 설치하는 중이라면 리눅스(WSL)가 있어야 해요. glotfax 는 복합기 제조사의 <b>리눅스용 팩스 드라이버</b>로 팩스를 보내요.
            <ol>
              <li>관리자 PowerShell 에서 WSL 을 설치해요.<pre>wsl --install Ubuntu-24.04 --no-launch</pre></li>
              <li>에이전트 설정 파일(<code>.env</code>)에 배포판 이름을 넣어요.<pre>FAX_WSL_DISTRO=Ubuntu-24.04</pre></li>
              <li>에이전트를 다시 켜요.</li>
            </ol>
          </li>
        </ol>`,
    };
  }
  if (a.backend === 'hp' && a.reasonCode === 'no-driver') {
    return {
      title: 'HP 팩스 드라이버가 설치돼 있지 않아요',
      html: `<p>이 게이트웨이에는 HP 복합기로 팩스를 보내는 프로그램(<b>HPLIP</b>, HP 가 만든 리눅스용 드라이버)이 없어요.</p>
        <ol>
          <li>${where}</li>
          <li>드라이버를 설치하고, 팩스를 보낼 일반 사용자를 만들어요. (HP 팩스 프로그램은 관리자 계정으로는 실행되지 않아요)
            <pre>apt-get update
apt-get install -y --no-install-recommends hplip hplip-gui
useradd -m -s /bin/bash -G lpadmin,lp glotfax</pre></li>
          <li>이어서 HP 복합기를 등록해요. 등록 방법은 이 목록에서 HP 를 다시 고르면 나와요.</li>
          <li>다 하면 위의 <b>다시 확인</b>을 눌러요.</li>
        </ol>`,
    };
  }
  if (a.backend === 'hp') {
    return {
      title: '연결된 HP 복합기가 없어요',
      html: `<p>HP 팩스 드라이버는 있지만, 이 게이트웨이에 <b>HP 복합기가 등록돼 있지 않아요.</b> Windows 에서 '프린터 추가'를 하는 것과 같은 작업이에요.</p>
        <ol>
          <li>HP 복합기가 게이트웨이와 <b>같은 공유기(네트워크)</b>에 연결돼 있는지 확인해요. 복합기 화면의 네트워크 설정에서 IP 주소(예: 192.168.0.30)를 확인해 두세요.</li>
          <li>${where}</li>
          <li>HP 등록 프로그램(<code>hp-setup</code>)으로 복합기를 등록해요. 질문이 나오면 <b>팩스(Fax)도 등록</b>한다고 답해요.
            <pre>hp-setup -i &lt;복합기 IP&gt;</pre></li>
          <li>다 하면 위의 <b>다시 확인</b>을 눌러요. 목록에 "HP · 복합기 이름"이 나오면 고르고 적용하면 돼요.</li>
        </ol>`,
    };
  }
  if (a.backend === 'epson' && a.reasonCode === 'no-driver') {
    return {
      title: 'Epson 팩스 드라이버가 설치돼 있지 않아요',
      html: `<p>이 게이트웨이에는 Epson 복합기로 팩스를 보내는 프로그램(<b>Epson PC-Fax 2 Driver</b>, Epson 이 만든 리눅스용 드라이버)이 없어요.</p>
        <ol>
          <li>Epson 다운로드 센터에서 복합기 모델을 찾아 운영체제 <b>Linux Deb(x64)</b> → <b>Epson PC-Fax 2 Driver</b> 를 받아요. (사용권 동의가 필요해요)</li>
          <li>${where}</li>
          <li>받은 파일로 설치해요.<pre>apt-get update
apt-get install -y --no-install-recommends cups cups-client cups-filters fonts-nanum fonts-nanum-coding paps
dpkg -i epson-pc-fax2-&lt;버전&gt;.deb</pre></li>
          <li>이어서 Epson 복합기를 등록해요. 등록 방법은 이 목록에서 Epson 을 다시 고르면 나와요.</li>
          <li>다 하면 위의 <b>다시 확인</b>을 눌러요.</li>
        </ol>`,
    };
  }
  if (a.backend === 'epson') {
    return {
      title: '연결된 Epson 복합기가 없어요',
      html: `<p>Epson 팩스 드라이버는 있지만, 이 게이트웨이에 <b>Epson 복합기가 등록돼 있지 않아요.</b> Windows 에서 '프린터 추가'를 하는 것과 같은 작업이에요.</p>
        <ol>
          <li>Epson 복합기가 게이트웨이와 <b>같은 공유기(네트워크)</b>에 연결돼 있는지 확인해요. 복합기 화면의 네트워크 설정에서 IP 주소를 확인해 두세요. (USB 연결은 안 돼요)</li>
          <li>${where}</li>
          <li>복합기를 팩스 대기열로 등록해요.
            <pre>lpadmin -p EPSON_FAX2 -E -v epsonfax2://&lt;복합기 IP&gt; -P /usr/share/cups/model/Epson/Epson-PC-Fax2.ppd</pre></li>
          <li>다 하면 위의 <b>다시 확인</b>을 눌러요.</li>
        </ol>`,
    };
  }
  return { title: `${n} 을(를) 쓸 수 없어요`, html: `<p>${a.reason ?? ''}</p>` };
}

function showGuide(a) {
  const g = guideFor(a);
  $('modal-title').textContent = g.title;
  $('modal-body').innerHTML = `${g.html}<p class="muted">자세한 설치 방법: <a href="${SETUP_DOC}" target="_blank" rel="noopener">설치 안내</a></p>`;
  $('modal').hidden = false;
  $('modal-close').focus();
}

/** 보낸 기록 줄의 "전송 기록" · "진행 보기": 누르면 모달에 시간 순서 기록 */
function recordLink(label, j, attempts) {
  const a = document.createElement('button');
  a.type = 'button';
  a.className = 'record-link';
  a.textContent = label;
  a.addEventListener('click', () => {
    $('modal-title').textContent = label.replace(/ \(.*\)$/, '');
    // 위: 받는 번호 · 파일 / 업로드 일시 / 올린 곳(기기 · 브라우저 · IP)
    const info = document.createElement('div');
    info.className = 'record-info';
    const line = (label, text) => {
      const row = document.createElement('div');
      row.innerHTML = '<span class="k"></span><span></span>';
      row.firstChild.textContent = label;
      row.lastChild.textContent = text;
      return row;
    };
    info.append(line('받는 번호', j.faxNumber), line('파일', j.fileName), line('업로드', formatTime(j.createdAt)));
    if (j.clientIp || j.userAgent) {
      const row = line('올린 곳', '');
      fillWho(row.lastChild, j.clientIp, j.userAgent, j.via, j.device);
      info.append(row);
    }
    $('modal-body').replaceChildren(info, timelineOf(attempts));
    $('modal').hidden = false;
    $('modal-close').focus();
  });
  return a;
}

function closeModal() {
  $('modal').hidden = true;
}
$('modal-close').addEventListener('click', closeModal);
$('modal').addEventListener('click', (e) => {
  if (e.target === $('modal')) closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('modal').hidden) closeModal();
});

// ------------------------------------------------------------ 파일 고르기

/** 고른 파일 목록. 보내면 파일마다 팩스 한 통씩, 고른 순서대로 나간다 */
function setFiles(files) {
  selectedFiles = files.slice(0, MAX_FILES);
  const zone = $('dropzone');
  zone.classList.toggle('has-file', selectedFiles.length > 0);
  $('file-title').textContent = selectedFiles.length ? `파일 ${selectedFiles.length}개` : '파일 첨부';
  $('send-button').textContent = selectedFiles.length > 1 ? `팩스 ${selectedFiles.length}건 보내기` : '팩스 보내기';

  $('file-list').replaceChildren(
    ...selectedFiles.map((f, i) => {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = `${i + 1}. ${f.name}`;
      const size = document.createElement('span');
      size.className = 'size';
      size.textContent = formatSize(f.size);
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'chip-del';
      del.setAttribute('aria-label', `${f.name} 빼기`);
      del.title = '빼기';
      del.textContent = '×';
      del.addEventListener('click', () => setFiles(selectedFiles.filter((_, j) => j !== i)));
      li.append(name, size, del);
      return li;
    }),
  );
  $('file-list').hidden = selectedFiles.length === 0;
  if (files.length > MAX_FILES) showError(`한 번에 ${MAX_FILES}개까지 보낼 수 있어요`);
  else updateSummary();
}

/** 이미 고른 파일 뒤에 더한다 (같은 파일은 한 번만) */
function addFiles(list) {
  const key = (f) => `${f.name}|${f.size}|${f.lastModified}`;
  const seen = new Set(selectedFiles.map(key));
  // 고르는 순간에 거른다: 허용되지 않는 형식 · 용량 초과는 목록에 넣지 않고 바로 알린다
  const ok = [];
  const problems = [];
  for (const f of [...list].filter((f) => !seen.has(key(f)))) {
    if (!ALLOWED_RE.test(f.name) && !ALLOWED_TYPES.includes(f.type)) problems.push({ name: f.name, reason: 'PDF, TXT, JPG, PNG만 보낼 수 있어요' });
    else if (f.size > maxFileMb * 1024 * 1024) problems.push({ name: f.name, reason: `${maxFileMb}MB 까지 보낼 수 있어요 (${formatSize(f.size)})` });
    else ok.push(f);
  }
  setFiles([...selectedFiles, ...ok]);
  if (problems.length) showError(problems);
}

$('file').addEventListener('change', (e) => {
  addFiles(e.target.files);
  e.target.value = ''; // 같은 파일을 다시 골라도 change 가 오게
});

const zone = $('dropzone');
zone.addEventListener('dragover', (e) => {
  e.preventDefault();
  zone.classList.add('over');
});
zone.addEventListener('dragleave', () => zone.classList.remove('over'));
zone.addEventListener('drop', (e) => {
  e.preventDefault();
  zone.classList.remove('over');
  if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
});

/** 다른 앱의 공유 메뉴로 들어온 파일들 (서비스 워커가 캐시에 넣어 둠) */
async function takeSharedFile() {
  const params = new URLSearchParams(location.search);
  if (!params.has('shared') && !params.has('share')) return;
  history.replaceState(null, '', '/');
  if (params.get('share') === 'retry') {
    showError('공유한 파일을 받지 못했어요. 한 번 더 공유해 주세요.');
    return;
  }
  try {
    const cache = await caches.open(SHARE_CACHE);
    const files = [];
    for (const req of await cache.keys()) {
      if (!new URL(req.url).pathname.startsWith('/shared-file')) continue;
      const res = await cache.match(req);
      const name = decodeURIComponent(res.headers.get('X-File-Name') || 'document');
      const blob = await res.blob();
      files.push({ order: Number(res.headers.get('X-File-Order') || 0), file: new File([blob], name, { type: blob.type }) });
      await cache.delete(req);
    }
    if (!files.length) return;
    setFiles(files.sort((a, b) => a.order - b.order).map((f) => f.file));
    $('fax-number').focus();
  } catch {
    showError('공유한 파일을 읽지 못했어요');
  }
}

// ------------------------------------------------------------ 받는 번호

$('fax-number').addEventListener('input', updateSummary);

function loadList(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || '[]');
  } catch {
    return [];
  }
}

function saveList(key, list) {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {}
}

const loadRecent = () => loadList(RECENT_KEY);
// 지운 번호: 다음에 열 때 받는 번호 칸에 자동으로 채우지 않는다 (다시 보내면 풀림)
const loadHidden = () => loadList(HIDDEN_KEY);

function saveRecent(number) {
  saveList(RECENT_KEY, [number, ...loadRecent().filter((n) => n !== number)].slice(0, 6));
  saveList(HIDDEN_KEY, loadHidden().filter((n) => n !== number));
  renderRecentNumbers();
}

function removeRecent(number) {
  saveList(RECENT_KEY, loadRecent().filter((n) => n !== number));
  saveList(HIDDEN_KEY, [number, ...loadHidden().filter((n) => n !== number)].slice(0, 50));
  if ($('fax-number').value.trim() === number) {
    $('fax-number').value = '';
    updateSummary();
  }
  renderRecentNumbers();
}

function renderRecentNumbers() {
  $('recent-numbers').replaceChildren(
    ...loadRecent().map((n) => {
      const chip = document.createElement('span');
      chip.className = 'chip';

      const pick = document.createElement('button');
      pick.type = 'button';
      pick.className = 'chip-num';
      pick.textContent = n;
      pick.addEventListener('click', () => {
        $('fax-number').value = n;
        updateSummary();
      });

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'chip-del';
      del.setAttribute('aria-label', `${n} 지우기`);
      del.title = '지우기';
      del.textContent = '×';
      del.addEventListener('click', () => removeRecent(n));

      chip.append(pick, del);
      return chip;
    }),
  );
}

// ------------------------------------------------------------ 보내기

function updateSummary() {
  // 하단 바 왼쪽은 오류가 있을 때만 쓴다. 평소엔 비운다
  const el = $('summary');
  el.classList.remove('err');
  el.textContent = '';
  el.hidden = true;
}

let toastTimer = null;
let toastLeft = 0; // 남은 시간(ms)
let toastSince = 0; // 마지막으로 다시 달리기 시작한 시각
const TOAST_MS = 6000;
/**
 * 토스트: 아래 가운데 검은 띠. × 로 닫을 수 있고, 아래 줄이 줄어들며 남은 시간을 보여 준다.
 * 마우스를 올리면 멈추고, 떼면 남은 시간부터 이어서 간다 (처음부터 다시 돌지 않음)
 */
function showError(message) {
  let el = $('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast err'; // 오류라 빨간 바탕
    el.setAttribute('role', 'alert');
    el.innerHTML = '<div class="toast-body"><svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg><p></p><button type="button" class="toast-close" aria-label="닫기">×</button></div><i class="toast-bar"></i>';
    el.querySelector('.toast-close').addEventListener('click', hideToast);
    el.addEventListener('mouseenter', () => {
      clearTimeout(toastTimer);
      toastLeft = Math.max(0, toastLeft - (Date.now() - toastSince));
      el.classList.add('hold');
    });
    el.addEventListener('mouseleave', () => {
      el.classList.remove('hold');
      toastSince = Date.now();
      toastTimer = setTimeout(hideToast, toastLeft);
    });
    document.body.append(el);
  }
  const body = el.querySelector('p');
  body.replaceChildren();
  for (const item of Array.isArray(message) ? message : [message]) {
    const row = document.createElement('span');
    row.className = 'toast-item';
    if (typeof item === 'string') row.textContent = item;
    else {
      const name = document.createElement('b');
      name.textContent = item.name;
      const reason = document.createElement('span');
      reason.textContent = item.reason;
      row.append(name, reason);
    }
    body.append(row);
  }
  el.classList.remove('hold');
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastLeft = TOAST_MS;
  toastSince = Date.now();
  toastTimer = setTimeout(hideToast, TOAST_MS);
  // 남은 시간 줄을 처음부터
  const bar = el.querySelector('.toast-bar');
  bar.style.animation = 'none';
  void bar.offsetWidth;
  bar.style.animation = '';
}

function hideToast() {
  clearTimeout(toastTimer);
  $('toast')?.classList.remove('show');
}
$('send-view').addEventListener('submit', async (e) => {
  e.preventDefault();
  const faxNumber = $('fax-number').value.replace(/\s/g, '');

  if (!selectedFiles.length) return showError('보낼 파일을 골라 주세요');
  const wrongType = selectedFiles.find((f) => !ALLOWED_RE.test(f.name) && !ALLOWED_TYPES.includes(f.type));
  if (wrongType) return showError(`${wrongType.name}: PDF, TXT, JPG, PNG만 보낼 수 있어요`);
  const tooBig = selectedFiles.find((f) => f.size > maxFileMb * 1024 * 1024);
  if (tooBig) return showError(`${tooBig.name}: 파일은 ${maxFileMb}MB까지 보낼 수 있어요`);
  if (!FAX_NUMBER_RE.test(faxNumber)) return showError('팩스 번호를 확인해 주세요 (숫자와 - 만)');

  const button = $('send-button');
  button.disabled = true;
  // 고른 순서대로 하나씩 올린다. 게이트웨이가 받은 순서대로 한 통씩 보낸다
  const files = [...selectedFiles];
  let done = 0;
  try {
    for (const file of files) {
      button.innerHTML = `<i class="spin"></i>${files.length > 1 ? `올리는 중 ${done + 1}/${files.length}` : '올리는 중'}`;
      const form = new FormData();
      form.append('file', file, file.name);
      form.append('faxNumber', faxNumber);
      if (!$('gateway-field').hidden) form.append('gatewayId', $('gateway').value);
      await api('/api/jobs', { method: 'POST', body: form });
      done++;
    }
    saveRecent(faxNumber);
    // 번호는 다음에 또 쓰도록 그대로 둔다
    setFiles([]);
    await refreshJobs();
    // 보낸 기록으로 넘어가 진행을 바로 보게
    location.hash = '#send/history';
  } catch (err) {
    // 올라간 것은 목록에서 빼고, 못 올린 것만 남긴다
    setFiles(files.slice(done));
    showError(done ? `${done}개는 올렸고, ${files[done].name}에서 멈췄어요: ${err.message}` : err.message);
    refreshJobs().catch(() => {});
  } finally {
    button.disabled = false;
    button.textContent = selectedFiles.length > 1 ? `팩스 ${selectedFiles.length}건 보내기` : '팩스 보내기';
  }
});

// ------------------------------------------------------------ 보낸 기록

async function refreshJobs() {
  const { jobs } = await api('/api/jobs');
  renderJobs(jobs);
  const busy = jobs.some((j) => !FINAL.has(j.status));
  // 보내는 중이면 왼쪽 메뉴 "보낸 기록" 오른쪽에 움직이는 팩스 표시
  const tab = document.querySelector('#send-tabs a[data-tab="history"]');
  tab.title = busy ? '보내는 중' : '';
  tab.querySelector('.dots')?.remove();
  if (busy) {
    const dots = document.createElement('span');
    dots.className = 'dots';
    dots.append(document.createElement('b'), document.createElement('b'), document.createElement('b'));
    tab.append(dots);
  }
  schedulePoll(busy ? 3000 : 15000);
}

function cell(className, text) {
  const td = document.createElement('td');
  td.className = className;
  if (text !== undefined) td.textContent = text;
  return td;
}

function renderJobs(jobs) {
  // 바뀐 게 없으면 다시 그리지 않는다 (진행 효과가 몇 초마다 처음부터 다시 시작되지 않게)
  const key = JSON.stringify(jobs);
  if (key === lastJobsKey) return;
  lastJobsKey = key;

  $('jobs-empty').hidden = jobs.length > 0;
  $('jobs-table').hidden = jobs.length === 0;
  $('jobs').replaceChildren(
    ...jobs.map((j) => {
      const [label, tone] = STATUS[j.status] ?? [j.status, 'wait'];
      const tr = document.createElement('tr');
      const state = cell('state');

      const status = document.createElement('span');
      status.className = `status ${tone}`;
      status.textContent = label;
      // 보내는 중: 점 세 개가 차례로 깜빡임 / 대기 중: 작은 네모가 천천히 깜빡임
      if (j.status === 'sending') {
        const dots = document.createElement('span');
        dots.className = 'dots';
        dots.append(document.createElement('b'), document.createElement('b'), document.createElement('b'));
        status.append(dots);
      } else if (j.status === 'queued' || j.status === 'dispatched') {
        const blink = document.createElement('i');
        blink.className = 'wait-blink';
        status.prepend(blink);
      }
      state.append(status);

      // 보내는 중: 지금 단계 한 줄 + "진행 보기"(모달에 전체). 좁은 화면에서도 칸이 깨지지 않게
      if (!FINAL.has(j.status) && j.detail) {
        const steps = timelineLines(j.detail);
        const now = document.createElement('span');
        now.className = 'detail step-now';
        now.textContent = steps.at(-1)?.[1] ?? '';
        state.append(now, recordLink('진행 보기', j, [{ status: j.status, detail: j.detail }]));
      }

      // 끝난 건: 실패 이유, 재다이얼 알림
      const lines = (j.detail ?? '').split('\n');
      const redialed = j.status === 'sent' && /Failed|걸었지만 실패/.test(j.detail ?? '');
      if (j.status === 'failed' || redialed) {
        const summary = document.createElement('span');
        summary.className = redialed ? 'detail note' : 'detail';
        summary.textContent = redialed
          ? '실패한 시도가 있었지만 복합기가 다시 걸어 보냈어요'
          : (lines.find((l) => l && !TIME_LINE.test(l) && l !== '— 진행 —') ?? '보내지 못했어요');
        state.append(summary);
      }
      // 전송 기록: 시도별로 (1차 · 2차 …), 시각과 한국어 문장 한 줄씩
      const attempts = j.attempts?.length ? j.attempts : j.detail ? [{ attempt: j.attempt, status: j.status, detail: j.detail }] : [];
      if (FINAL.has(j.status) && attempts.length) {
        state.append(recordLink(attempts.length > 1 ? `전송 기록 (${attempts.length}번 시도)` : '전송 기록', j, attempts));
      }
      if (j.canRetry) {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'btn sm';
        retry.textContent = '다시 보내기';
        retry.addEventListener('click', async () => {
          retry.disabled = true;
          try {
            await api(`/api/jobs/${j.id}/retry`, { method: 'POST' });
          } catch (err) {
            showError(err.message);
          }
          await refreshJobs();
        });
        state.append(document.createElement('br'), retry);
      }

      // 파일 이름: 보관 중이면 눌러서 열기. 좁은 화면에서는 번호 밑에 같이 보여 준다
      const fileLink = () => {
        if (!j.hasFile) {
          const span = document.createElement('span');
          span.textContent = j.fileName;
          span.title = '보관 기간이 지나 파일이 지워졌어요';
          return span;
        }
        const a = document.createElement('a');
        a.className = 'file-link';
        a.href = `/api/jobs/${j.id}/file`;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = j.fileName;
        return a;
      };
      const num = cell('num', j.faxNumber);
      const sub = document.createElement('span');
      sub.className = 'file-sub';
      sub.append(fileLink());
      num.append(sub);
      const file = cell('file');
      file.append(fileLink());

      // 보낸 일시 = 마지막 시도를 시작한 시각. 업로드 시각 · 시도 횟수 · 올린 곳은 "전송 기록" 모달에
      tr.append(cell('time', formatTime(j.sentAt ?? j.createdAt)), num, file, state);

      // 보내는 중인 줄 아래로 진행 막대가 흐른다
      if (j.status === 'sending') tr.classList.add('is-sending');
      // 처음 보는 기록은 올라오며 나타나고, 상태가 바뀐 줄은 잠깐 물든다
      const prev = lastStatus.get(j.id);
      if (lastStatus.size && prev === undefined) tr.classList.add('is-new');
      else if (prev && prev !== j.status) tr.classList.add(`flash-${tone}`);
      return tr;
    }),
  );
  lastStatus = new Map(jobs.map((j) => [j.id, j.status]));
}

function schedulePoll(ms) {
  stopPolling();
  pollTimer = setTimeout(async () => {
    if (document.hidden) return schedulePoll(ms);
    try {
      await Promise.all([refreshJobs(), refreshMe()]);
    } catch {
      schedulePoll(15000);
    }
  }, ms);
}

function stopPolling() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !$('send-view').hidden) refreshJobs().catch(() => {});
});

// ------------------------------------------------------------ 통계

/** '2026-10-29' → '10-29(수)' (연도는 주 머리글에) */
function dayLabel(day) {
  return `${day.slice(5)}(${'일월화수목금토'[new Date(`${day}T00:00:00`).getDay()]})`;
}

/** Date → 'YYYY-MM-DD' */
function dateKey(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 'YYYY-MM-DD' → 그 주 일요일(주의 시작) 'YYYY-MM-DD' */
function weekStartOf(day) {
  const d = new Date(`${day}T00:00:00`);
  d.setDate(d.getDate() - d.getDay());
  return dateKey(d);
}

/** '2026-10-25' → '2026-10-25(일) ~ 2026-10-31(토)' */
function weekLabel(start) {
  const end = new Date(`${start}T00:00:00`);
  end.setDate(end.getDate() + 6);
  const k = dateKey(end);
  return `${start}(일) ~ ${k}(토)`;
}

let statsByDay = new Map();

/** 고른 주의 7일을 토 → 일 순서로. 안 보낸 날도 줄은 보여 준다 (건수는 빈 칸) */
function renderWeek(start) {
  const todayKey = dateKey(new Date());
  const rows = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(`${start}T00:00:00`);
    d.setDate(d.getDate() + i);
    const key = dateKey(d);
    if (key > todayKey) continue; // 아직 안 온 날은 뺀다
    const r = statsByDay.get(key);
    const tr = document.createElement('tr');
    if (key === todayKey) tr.className = 'is-today';
    tr.append(cell('time', dayLabel(key)), cell('n', r ? r.total : ''), cell('n ok', r?.sent || ''), cell('n err', r?.failed || ''));
    rows.push(tr);
  }
  $('daily-rows').replaceChildren(...rows);
}

async function refreshDailyStats() {
  const { days } = await api('/api/jobs/daily');
  statsByDay = new Map(days.map((d) => [d.day, d]));
  // 오늘(한국 시간) 건수를 맨 위에 크게
  const todayKey = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const today = statsByDay.get(todayKey);
  $('stats-today-count').textContent = today?.total ?? 0;
  $('stats-today-sub').textContent = today ? `완료 ${today.sent} · 실패 ${today.failed}` : '';
  $('stats-today').hidden = false;

  $('daily-empty').hidden = days.length > 0;
  $('daily-table').hidden = days.length === 0;
  $('week-field').hidden = days.length === 0;
  if (!days.length) return $('daily-rows').replaceChildren();

  // 셀렉트: 기록이 있는 주만, 최근 주부터
  const weeks = [...new Set(days.map((d) => weekStartOf(d.day)))].sort().reverse();
  const select = $('week-select');
  const picked = weeks.includes(select.value) ? select.value : weeks[0];
  select.replaceChildren(
    ...weeks.map((w) => {
      const o = document.createElement('option');
      o.value = w;
      o.textContent = weekLabel(w);
      o.selected = w === picked;
      return o;
    }),
  );
  renderWeek(picked);
}

$('week-select').addEventListener('change', () => renderWeek($('week-select').value));

// ------------------------------------------------------------ 표시

function formatSize(bytes) {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))}KB` : `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

// "11:49:22  복합기가 … 걸기 시작" 같은 진행 줄
const TIME_LINE = /^(\d\d:\d\d:\d\d)\s+(.*)$/;

/** 시도별 기록 → 시간 순서 목록. 시도가 여럿이면 "1차 · 11:17  실패" 머리글을 붙인다 */
function timelineOf(attempts) {
  const RESULT = { sent: ['완료', 'ok'], failed: ['실패', 'err'], sending: ['보내는 중', 'run'] };
  const box = document.createElement('div');
  box.className = 'timeline';
  for (const a of attempts) {
    if (attempts.length > 1) {
      const head = document.createElement('div');
      head.className = 'tl-head';
      const [label, tone] = RESULT[a.status] ?? [a.status, ''];
      head.innerHTML = `<span>${a.attempt}차${a.startedAt ? ` · ${clockOf(a.startedAt).slice(0, 5)}` : ''}</span><b class="${tone}">${label}</b>`;
      box.append(head);
    }
    for (const [t, text] of timelineLines(a.detail ?? '')) {
      const row = document.createElement('div');
      row.className = `tl-row${/실패|못함|못했|취소|끊겨|응답하지/.test(text) ? ' err' : /성공/.test(text) ? ' ok' : ''}`;
      const time = document.createElement('span');
      time.className = 't';
      time.textContent = t;
      const what = document.createElement('span');
      what.textContent = text;
      row.append(time, what);
      box.append(row);
    }
  }
  // 여러 번 시도한 건: 1차 시작부터 마지막 시도가 끝날 때까지 전체 시간
  const first = attempts[0]?.startedAt;
  const last = attempts.at(-1);
  if (attempts.length > 1 && first && last?.finishedAt) {
    const total = document.createElement('div');
    total.className = `tl-total${last.status === 'sent' ? ' ok' : last.status === 'failed' ? ' err' : ''}`;
    total.innerHTML = `<span class="t">전체</span><span>${durationOf(last.finishedAt - first)} 걸림 (${attempts.length}번 시도)</span>`;
    box.append(total);
  }
  return box;
}

/** 저장된 기록 → [시각, 문장] 목록. 예전에 원문으로 저장된 Epson 드라이버 기록도 같은 모양으로 바꾼다 */
function timelineLines(text) {
  const out = [];
  const lines = text.split('\n');
  // 예전 기록: 드라이버 원문(Start Fax …)
  const raw = text.split(/(?=^\s*Start Fax\s*:)/m).filter((e) => /Start Fax\s*:/.test(e));
  const at = (e, label) => {
    const d = new Date(new RegExp(`${label}\\s*:\\s*(.+)`).exec(e)?.[1]?.trim() ?? '');
    return Number.isNaN(d.getTime()) ? null : d.getTime();
  };
  // 시각 없는 첫 줄(실패 이유)은 "보내지 못함 — …" 줄이 있으면 겹치므로 뺀다
  const hasEnd = lines.some((l) => TIME_LINE.test(l) && l.includes('보내지 못함'));
  for (const l of lines) {
    const m = TIME_LINE.exec(l);
    if (m) out.push([m[1], m[2]]);
    else if (!hasEnd && l && l !== '— 진행 —' && !/^\s*(Start Fax|fax-number|End send Fax|Status)\s*:/.test(l)) out.push(['', l]);
  }
  const first = raw.length ? at(raw[0], 'Start Fax') : null;
  raw.forEach((e, i) => {
    const number = /fax-number\s*:\s*(.+)/.exec(e)?.[1]?.trim();
    const st = /Status\s*:\s*(.+)/.exec(e)?.[1]?.trim();
    const start = at(e, 'Start Fax');
    const t = (ms) => (ms ? clockOf(ms) : '');
    out.push([t(start), !number && !st ? '복합기로 넘기지 못함' : i === 0 ? `복합기가 ${number ?? ''} 로 걸기 시작` : '복합기가 다시 걸기 시작']);
    if (st) {
      const end = at(e, 'End send Fax');
      const took = first && end ? ` · ${durationOf(end - first)} 걸림` : '';
      out.push([t(end), /success/i.test(st) ? `전송 끝 — 성공${took}` : `걸었지만 실패 (${st.replace(/^Failed\.?\s*/i, '') || '복합기 응답 없음'})`]);
    }
  });
  return out;
}

/** 4분 10초 */
function durationOf(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}분 ${s % 60}초` : `${s}초`;
}

/** 11:49:22 */
function clockOf(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function formatTime(ms) {
  // 예: 2026-10-26(월), 15:58
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  const day = '일월화수목금토'[d.getDay()];
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}(${day}), ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ------------------------------------------------------------ 푸터 숫자

async function refreshStats() {
  try {
    const s = await fetch('/api/stats').then((r) => r.json());
    $('stat-today').textContent = Number(s.today).toLocaleString('ko-KR');
    $('stat-total').textContent = Number(s.total).toLocaleString('ko-KR');
    $('stat-sent').textContent = Number(s.sent).toLocaleString('ko-KR');
  } catch {}
}

// ------------------------------------------------------------ 시작

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

refreshStats();

(async () => {
  try {
    await showMain();
    await takeSharedFile();
  } catch {
    showLogin();
  }
})();
