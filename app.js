const DATA_URL = './data.json';
const COLORS = ['#c8a96e','#e63946','#4caf82','#42a5f5','#ab47bc','#ff7043','#26c6da','#d4e157','#ec407a','#26a69a'];
const COL_KEYS = ['総成績','4麻成績','3麻成績','総半荘数','4麻半荘数','3麻半荘数','総チップ','4麻チップ','3麻チップ','4麻飛び','3麻飛び','連対率','1着率','プレイ時間','来店回数','総収支'];
const COL_LABELS = {'総成績':'総成績','4麻成績':'4麻成績','3麻成績':'3麻成績','総半荘数':'半荘数(全)','4麻半荘数':'半荘数(4)','3麻半荘数':'半荘数(3)','総チップ':'チップ(全)','4麻チップ':'チップ(4)','3麻チップ':'チップ(3)','4麻飛び':'飛び(4)','3麻飛び':'飛び(3)','連対率':'連対率(4)','1着率':'1着率(3)','プレイ時間':'プレイ時間','来店回数':'来店','総収支':'収支'};

let DATA = null;
let filterStart = null;
let filterEnd   = null;
let activeMemberName = null;
let memberSortKey = 'allTotal';
let graphMembers = new Set();
let graphCol = '総成績';
let chartInstance = null;
let memberChartInstances = [];
let currentSection = 'top';

// ── ユーティリティ ──
const sc  = v => v > 0 ? 'pos' : v < 0 ? 'neg' : '';
const fmt = v => v > 0 ? '+'+v : String(v);
const fmtPct = v => (v*100).toFixed(1)+'%';
const toDate = s => new Date(s);
const dateStr = d => { const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,'0'), day=String(d.getDate()).padStart(2,'0'); return `${y}-${m}-${day}`; };
const rankBadge = r => { const c=r===1?'r1':r===2?'r2':r===3?'r3':'rn'; return `<span class="rank-badge ${c}">${r}</span>`; };
const _fmtRelTime = ts => {
  const diff = Date.now() - ts;
  if (diff < 60000) return 'たった今';
  if (diff < 3600000) return `${Math.floor(diff/60000)}分前`;
  if (diff < 86400000) return `${Math.floor(diff/3600000)}時間前`;
  if (diff < 7*86400000) return `${Math.floor(diff/86400000)}日前`;
  const d = new Date(ts);
  return `${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()}`;
};

// ── データ読み込み ──
async function loadData() {
  try {
    const res = await fetch(DATA_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    DATA = await res.json();
  } catch(e) {
    document.getElementById('error-msg').innerHTML = '⚠ data.json の読み込みに失敗しました。<br>'+e.message;
    document.getElementById('error-msg').style.display = 'block';
  } finally {
    const el = document.getElementById('loading');
    el.style.opacity = '0';
    setTimeout(()=>el.style.display='none', 400);
  }
  if (!DATA) return;
  initPeriod();
  initGraphControls();
  refresh();
  // data.json 読み込み完了後にハッシュルーティングが未適用なら再適用
  // （キャッシュ済みデータが DOMContentLoaded より先に返った場合の保険）
  if (location.hash === '#boshu' && currentSection !== 'boshu') {
    showSection('boshu');
  } else if (currentSection === 'top') {
    initTopPage();
  }
}

// ── 期間 ──
function initPeriod() {
  const dates = DATA.gathers.map(g=>g.date).sort();
  if (!dates.length) return;
  filterStart = toDate(dates[0]);
  filterEnd   = toDate(dates[dates.length-1]);
  document.getElementById('filter-start').value = dateStr(filterStart);
  document.getElementById('filter-end').value   = dateStr(filterEnd);

  const years = [...new Set(dates.map(d=>d.slice(0,4)))].sort();
  const btns = document.querySelector('.period-btns');
  years.forEach(y => {
    const b = document.createElement('button');
    b.className = 'period-preset';
    b.textContent = y+'年';
    b.onclick = () => setPeriod('year:'+y);
    btns.appendChild(b);
  });
}

function onPeriodChange() {
  const s = document.getElementById('filter-start').value;
  const e = document.getElementById('filter-end').value;
  filterStart = s ? toDate(s) : null;
  filterEnd   = e ? toDate(e) : null;
  refresh();
}

function setPeriod(preset) {
  const now = new Date();
  let start, end = now;
  if (preset==='all') {
    const dates = DATA.gathers.map(g=>g.date).sort();
    start = toDate(dates[0]); end = toDate(dates[dates.length-1]);
  } else if (preset.startsWith('year:')) {
    const y = preset.slice(5);
    start = new Date(y+'-01-01'); end = new Date(y+'-12-31');
  } else if (preset==='year') {
    start = new Date(now.getFullYear()+'-01-01');
  } else if (preset==='6m') {
    start = new Date(now.getFullYear(), now.getMonth()-6, now.getDate());
  } else if (preset==='3m') {
    start = new Date(now.getFullYear(), now.getMonth()-3, now.getDate());
  }
  filterStart = start; filterEnd = end;
  document.getElementById('filter-start').value = dateStr(filterStart);
  document.getElementById('filter-end').value   = dateStr(filterEnd);
  refresh();
}

function filteredGathers() {
  if (!DATA) return [];
  return DATA.gathers.filter(g => {
    const d = toDate(g.date);
    if (filterStart && d < filterStart) return false;
    if (filterEnd   && d > filterEnd)   return false;
    return true;
  });
}

// ── 集計（期間フィルター適用・JS側で計算） ──

// ── ナビ ──
// ── ナビ ──
const _STATS = ['ranking','member','graph','history'];
const _GALLERY = ['gallery','jare','jare-detail'];
const _ADMIN = ['admin-members','admin-gather','admin-score','admin-swarm'];
function showSection(id) {
  currentSection = id;
  document.querySelectorAll('.section').forEach(s=>s.classList.remove('active'));
  document.getElementById('sec-'+id).classList.add('active');

  const isStats = _STATS.includes(id);
  const isGallery = _GALLERY.includes(id);
  const isAdmin = _ADMIN.includes(id);

  // メインナビのアクティブ状態
  document.querySelectorAll('nav button').forEach(b=>b.classList.remove('active'));
  const navKey = isStats ? 'sensei' : isGallery ? 'gallery' : isAdmin ? 'admin' : id;
  const activeNavBtn = document.querySelector(`nav button[data-nav="${navKey}"]`);
  if (activeNavBtn) activeNavBtn.classList.add('active');

  // サブナビの表示・アクティブ状態
  const subnav = document.getElementById('subnav');
  const subnavGallery = document.getElementById('subnav-gallery');
  const subnavAdmin = document.getElementById('subnav-admin');
  subnav.style.display = isStats ? '' : 'none';
  subnavGallery.style.display = isGallery ? '' : 'none';
  subnavAdmin.style.display = isAdmin ? '' : 'none';
  if (isStats) {
    const subLabels = {ranking:'総合',member:'個人',graph:'グラフ',history:'履歴'};
    document.querySelectorAll('#subnav button').forEach(b=>b.classList.toggle('active', b.textContent===subLabels[id]));
  }
  if (isGallery) {
    const subLabels = {jare:'じゃれ本','jare-detail':'じゃれ本'};
    document.querySelectorAll('#subnav-gallery button').forEach(b=>b.classList.toggle('active', b.textContent===subLabels[id]));
  }
  if (isAdmin) {
    const subLabels = {'admin-members':'メンバー管理','admin-gather':'対局登録','admin-score':'スコア入力','admin-swarm':'Swarm連携'};
    document.querySelectorAll('#subnav-admin button').forEach(b=>b.classList.toggle('active', b.textContent===subLabels[id]));
    history.replaceState(null, '', location.pathname + location.search + '#admin/' + id.slice(6));
  }

  // 期間バーの表示
  document.querySelector('.period-bar').style.display = (id==='top'||id==='feedback'||id==='schedule'||id==='board'||id==='renban'||id==='boshu'||id==='stamp'||isGallery||isAdmin) ? 'none' : '';

  if (id==='graph') renderChart(filteredGathers());
  if (id==='member' && activeMemberName) renderMemberCharts(activeMemberName);
  if (id==='schedule') renderCalendar();
  if (id==='board') initBoard();
  if (id==='renban') initRenban();
  if (id==='boshu') initBoshu();
  if (id==='stamp') initStampCard();
  if (id==='jare') initJare();
  if (id==='top') initTopPage();
  if (id==='feedback' && _registeredName) {
    const fbName = document.getElementById('fb-name');
    if (fbName && !fbName.value) fbName.value = _registeredName;
  }
  if (id==='admin-members') initAdminMembers();
  if (id==='admin-gather') initAdminGather();
  if (id==='admin-score') initAdminScore();
  if (id==='admin-swarm') initAdminSwarm();
}

// 管理者ページへの直リンク（#admin/members 等）対応。管理者ログイン確定後にのみ開く
function _handleAdminHashRoute() {
  const m = location.hash.match(/^#admin\/(members|gather|score|swarm)$/);
  if (!m) return;
  if (_isAdmin) {
    showSection('admin-' + m[1]);
  } else {
    history.replaceState(null, '', location.pathname + location.search);
  }
}

// ── トップページ ──
let _topNextDate = null;

function goToNextDay() {
  if (!_topNextDate) return;
  const parts = _topNextDate.split('-');
  showSection('schedule');
  calYear = parseInt(parts[0]);
  calMonth = parseInt(parts[1]) - 1;
  renderCalendar().then(() => openDayDetail(_topNextDate));
}

async function renderTopSchedule() {
  // 日本時間（JST/UTC+9）で今日の日付を取得
  const todayStr = new Date().toLocaleDateString('en-CA', {timeZone: 'Asia/Tokyo'});
  const MARK_CSS = { '◎':'mark-open', '〇':'mark-half', '△':'mark-short', '×':'mark-closed' };
  const DOW = ['日','月','火','水','木','金','土'];

  const allDates = Object.keys(SCHEDULE_DATA).sort();
  const upcomingOpen = allDates.filter(d => d >= todayStr && SCHEDULE_DATA[d].mark !== '×');

  const nextEl = document.getElementById('top-next-day');
  if (nextEl) {
    if (upcomingOpen.length) {
      const nd = upcomingOpen[0];
      _topNextDate = nd;
      const entry = SCHEDULE_DATA[nd];
      const parts = nd.split('-');
      const label = `${parseInt(parts[1])}月${parseInt(parts[2])}日`;
      // 曜日：UTCDay を使うことで YYYY-MM-DD の暦日と一致させる
      const [y, mo, d] = parts.map(Number);
      const dow = DOW[new Date(Date.UTC(y, mo-1, d)).getUTCDay()];
      // 差分：JST午前0時同士で比較し、時刻のずれを排除
      const todayJST = new Date(todayStr + 'T00:00:00+09:00');
      const ndJST = new Date(nd + 'T00:00:00+09:00');
      const diffDays = Math.round((ndJST - todayJST) / 86400000);
      const untilStr = diffDays <= 0 ? '今日！' : diffDays === 1 ? '明日！' : `あと${diffDays}日`;
      nextEl.innerHTML = `
        <div class="top-next-mark"><span class="cal-mark ${MARK_CSS[entry.mark]||''}">${entry.mark}</span></div>
        <div class="top-next-date">${label}（${dow}）</div>
        ${entry.note ? `<div class="top-next-note">${entry.note}</div>` : ''}
        <div class="top-next-until">${untilStr}</div>
        <div class="top-next-rsv" id="top-next-rsv" style="color:var(--dim)">予約 ...</div>`;
      if (_db) {
        try {
          const snap = await _db.collection('reservations').where('date', '==', nd).get();
          const rsvEl = document.getElementById('top-next-rsv');
          if (rsvEl) {
            if (snap.size > 0) {
              rsvEl.textContent = `予約 ${snap.size}件`;
              rsvEl.style.color = 'var(--accent)';
            } else {
              rsvEl.textContent = '予約なし';
            }
          }
        } catch(e) {
          const rsvEl = document.getElementById('top-next-rsv');
          if (rsvEl) rsvEl.textContent = '';
        }
      } else {
        const rsvEl = document.getElementById('top-next-rsv');
        if (rsvEl) rsvEl.textContent = '';
      }
    } else {
      _topNextDate = null;
      nextEl.innerHTML = '<div class="empty">予定なし</div>';
    }
  }

  const listEl = document.getElementById('top-schedule-list');
  if (!listEl) return;
  const upcoming5 = upcomingOpen.slice(0, 5);
  if (!upcoming5.length) { listEl.innerHTML = '<div class="empty">予定なし</div>'; return; }

  // まず件数なしで即時描画
  const renderRows = (counts) => {
    listEl.innerHTML = upcoming5.map(d => {
      const entry = SCHEDULE_DATA[d];
      const parts = d.split('-');
      const label = `${parseInt(parts[1])}月${parseInt(parts[2])}日（${DOW[new Date(d).getDay()]}）`;
      const noteHtml = entry.note ? `<span style="font-size:11px;color:var(--dim);margin-left:4px">${entry.note}</span>` : '';
      const cnt = counts ? counts[d] : null;
      const cntHtml = cnt != null
        ? `<span style="font-size:11px;margin-left:6px;color:${cnt > 0 ? 'var(--accent)' : 'var(--dim)'}">${cnt > 0 ? `予約${cnt}件` : '予約なし'}</span>`
        : '';
      const onclick = `showSection('schedule');calYear=${parts[0]};calMonth=${parseInt(parts[1])-1};renderCalendar().then(()=>openDayDetail('${d}'))`;
      return `<div class="top-schedule-row top-update-link" onclick="${onclick}">
        <span class="top-schedule-date">${label}</span>
        <span><span class="cal-mark ${MARK_CSS[entry.mark]||''}" style="font-size:15px">${entry.mark}</span>${noteHtml}${cntHtml}</span>
      </div>`;
    }).join('');
  };

  renderRows(null);

  if (_db) {
    try {
      const snaps = await Promise.all(upcoming5.map(d => _db.collection('reservations').where('date', '==', d).get()));
      const counts = {};
      upcoming5.forEach((d, i) => { counts[d] = snaps[i].size; });
      renderRows(counts);
    } catch(e) { /* 取得失敗時はそのまま */ }
  }
}

let _topJareDocId = null;

function goToTopJare() {
  if (_topJareDocId) showJareDetail(_topJareDocId);
}

async function renderTopJare() {
  const el = document.getElementById('top-jare-content');
  if (!el) return;
  if (!_db) { el.innerHTML = '<div class="empty">読み込めませんでした</div>'; return; }
  try {
    const snap = await _db.collection('jare_stories').get();
    const docs = snap.docs.filter(d => d.data().title);
    if (!docs.length) { el.innerHTML = '<div class="empty">まだ作品がありません</div>'; return; }
    const dayNum = Math.floor((Date.now() + 4 * 3600000) / 86400000);
    const pick = docs[dayNum % docs.length];
    const data = pick.data();
    _topJareDocId = pick.id;
    const metaParts = [];
    if (data.date) metaParts.push(data.date.replace(/-/g, '/'));
    if (data.theme) metaParts.push(data.theme);
    el.innerHTML = `
      <div class="top-jare-title">${_escHtml(data.title)}</div>
      ${metaParts.length ? `<div class="top-jare-meta">${metaParts.map(_escHtml).join(' — ')}</div>` : ''}
      <div class="top-jare-footer">読む →</div>`;
  } catch(e) {
    el.innerHTML = '<div class="empty">読み込みに失敗しました</div>';
  }
}

async function initTopPage() {
  renderTopSchedule();
  renderTopJare();

  const listEl = document.getElementById('top-updates-list');
  if (!listEl) return;
  if (!_db) {
    listEl.innerHTML = '<div class="empty" style="font-size:12px;color:var(--dim)">更新情報を読み込めませんでした</div>';
    return;
  }
  listEl.innerHTML = '<div class="empty">読み込み中...</div>';
  try {
    const [rsvSnap, boardSnap, renbanSnap] = await Promise.all([
      _db.collection('reservations').orderBy('createdAt', 'desc').limit(5).get(),
      _db.collection('board_comments').orderBy('ts', 'desc').limit(3).get(),
      _db.collection('renban_events').orderBy('createdAt', 'desc').limit(3).get()
    ]);
    const items = [];
    rsvSnap.docs.forEach(doc => {
      const d = doc.data();
      const ts = d.createdAt ? (d.createdAt.toMillis ? d.createdAt.toMillis() : 0) : 0;
      items.push({ type: 'rsv', ts, date: d.date, name: d.name || '匿名' });
    });
    boardSnap.docs.forEach(doc => {
      const d = doc.data();
      const ts = d.ts ? (d.ts.toMillis ? d.ts.toMillis() : 0) : 0;
      items.push({ type: 'board', ts, name: d.name || '匿名', body: d.body || '' });
    });
    renbanSnap.docs.forEach(doc => {
      const d = doc.data();
      const ts = d.createdAt ? (d.createdAt.toMillis ? d.createdAt.toMillis() : 0) : 0;
      items.push({ type: 'renban', ts, id: doc.id, title: d.title || '(無題)', owner: d.owner || '匿名' });
    });
    items.sort((a, b) => b.ts - a.ts);
    if (!items.length) { listEl.innerHTML = '<div class="empty">更新はありません</div>'; return; }
    listEl.innerHTML = items.map(item => {
      const timeStr = item.ts ? _fmtRelTime(item.ts) : '';
      if (item.type === 'rsv') {
        const parts = item.date ? item.date.split('-') : [];
        const dLabel = parts.length === 3 ? `${parseInt(parts[1])}月${parseInt(parts[2])}日` : (item.date || '');
        const y = parts[0], m = parseInt(parts[1]) - 1;
        const onclick = `showSection('schedule');calYear=${y};calMonth=${m};renderCalendar().then(()=>openDayDetail('${item.date}'))`;
        return `<div class="top-update-item top-update-link" onclick="${onclick}">
          <span class="top-update-icon">📅</span>
          <div class="top-update-text"><strong>${_escHtml(item.name)}</strong> さんが <strong>${dLabel}</strong> に予約しました<div class="top-update-time">${timeStr}</div></div>
        </div>`;
      } else if (item.type === 'board') {
        const preview = item.body.length > 36 ? item.body.slice(0, 36) + '…' : item.body;
        return `<div class="top-update-item top-update-link" onclick="showSection('board')">
          <span class="top-update-icon">💬</span>
          <div class="top-update-text"><strong>${_escHtml(item.name)}</strong>：${_escHtml(preview)}<div class="top-update-time">${timeStr}</div></div>
        </div>`;
      } else {
        const onclick = `showSection('renban');initRenban().then(()=>openRenbanDetail('${item.id}'))`;
        return `<div class="top-update-item top-update-link" onclick="${onclick}">
          <span class="top-update-icon">📢</span>
          <div class="top-update-text"><strong>${_escHtml(item.owner)}</strong> さんが <strong>${_escHtml(item.title)}</strong> の連番を募集しました<div class="top-update-time">${timeStr}</div></div>
        </div>`;
      }
    }).join('');
  } catch(e) {
    listEl.innerHTML = '<div class="empty">読み込みに失敗しました</div>';
  }
}



loadData();

// ── ご意見 送信 ──
const WEBHOOK_URL = 'https://discord.com/api/webhooks/1485897903431221330/HkGtTtH24xS2EmdxlGK_CkSoCp1rl8JnALHU_XhLpXHr3tggH0FioGsumKFYvBuOc3Mc';

async function submitFeedback(e) {
  e.preventDefault();
  const name     = document.getElementById('fb-name').value.trim() || '匿名';
  const category = document.getElementById('fb-category').value;
  const message  = document.getElementById('fb-message').value.trim();
  const status  = document.getElementById('fb-status');
  const btn     = e.target.querySelector('.feedback-submit');
  if (!message) { status.style.color='var(--red)'; status.textContent='内容を入力してください。'; return; }

  btn.disabled = true;
  status.style.color = 'var(--dim)';
  status.textContent = '送信中...';

  try {
    const content = `**名前：** ${name}\n**種別：** ${category}\n**内容：** ${message}`;
    let res;
    if (fbFiles.length > 0) {
      const fd = new FormData();
      fd.append('payload_json', JSON.stringify({ content }));
      fbFiles.slice(0, 10).forEach((f, i) => fd.append(`files[${i}]`, f, f.name));
      res = await fetch(WEBHOOK_URL, { method:'POST', body: fd });
    } else {
      res = await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    status.style.color = 'var(--green)';
    status.textContent = '送信しました！';
    document.getElementById('fb-name').value = '';
    document.getElementById('fb-message').value = '';
    fbFiles = [];
    renderFbFiles();
  } catch(err) {
    status.style.color = 'var(--red)';
    status.textContent = '送信に失敗しました: ' + err.message;
  } finally {
    btn.disabled = false;
  }
}

// ── ご意見 ファイル添付 ──
let fbFiles = [];

function onFbFilesChange(input) {
  Array.from(input.files).forEach(f => { if (!fbFiles.find(x=>x.name===f.name&&x.size===f.size)) fbFiles.push(f); });
  input.value = '';
  renderFbFiles();
}

function removeFbFile(idx) {
  fbFiles.splice(idx, 1);
  renderFbFiles();
}

function renderFbFiles() {
  const previewWrap = document.getElementById('fb-preview-wrap');
  const listWrap = document.getElementById('fb-file-list');
  const imgs = fbFiles.filter(f=>f.type.startsWith('image/'));
  const others = fbFiles.filter(f=>!f.type.startsWith('image/'));

  previewWrap.innerHTML = imgs.map((f,i)=>{
    const url = URL.createObjectURL(f);
    const idx = fbFiles.indexOf(f);
    return `<div style="position:relative;display:inline-block;">
      <img class="fb-preview-img" src="${url}" alt="${f.name}">
      <span class="fb-file-remove" style="position:absolute;top:-4px;right:-4px;background:var(--surface);border-radius:50%;padding:1px 4px;" onclick="removeFbFile(${idx})">×</span>
    </div>`;
  }).join('');

  listWrap.innerHTML = others.map((f)=>{
    const idx = fbFiles.indexOf(f);
    return `<div class="fb-file-chip">
      <span>${f.name}</span>
      <span class="fb-file-remove" onclick="removeFbFile(${idx})">×</span>
    </div>`;
  }).join('');
}

// ── Firebase 予約機能 ──
// ★ 下記のFIREBASE_CONFIGにFirebaseコンソールで取得した値を入力してください ★
// https://console.firebase.google.com/ でプロジェクト作成 → Firestoreを有効化 →
// プロジェクト設定 → マイアプリ → ウェブアプリを追加 → SDK設定のconfigをコピー
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDG2F8MDiSpNZWfcISJVCI5kAWaJYF0B7k",
  authDomain: "syariodate.firebaseapp.com",
  projectId: "syariodate",
  storageBucket: "syariodate.firebasestorage.app",
  messagingSenderId: "494285110412",
  appId: "1:494285110412:web:ee00a71bd8866a68890fa9"
};

let _db = null;
let _auth = null;
let _currentUser = null; // ログイン中ユーザー (null = 未ログイン)
let _authResolved = false; // onAuthStateChanged が1度でも発火したか
let _registeredName = null; // マイページで設定した登録名
let _isAdmin = false;   // 管理者フラグ
let _isManager = false; // マネージャーフラグ

function initFirebase() {
  try {
    if (FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.projectId) {
      firebase.initializeApp(FIREBASE_CONFIG);
      _db = firebase.firestore();
      _auth = firebase.auth();
      _auth.onAuthStateChanged(user => {
        _currentUser = user;
        updateAuthUI(user);
        if (typeof _swarmHandleAuthReady === 'function') _swarmHandleAuthReady(user);
      });
    }
  } catch(e) {
    console.warn('Firebase init error:', e);
  }

  // SwarmのOAuth認証コールバック（#access_token=...）を検出して保持
  const swarmTokenMatch = location.hash.match(/access_token=([^&]+)/);
  if (swarmTokenMatch) {
    window._swarmPendingToken = decodeURIComponent(swarmTokenMatch[1]);
    history.replaceState(null, '', location.pathname + location.search);
  }

  // ハッシュルーティング
  const initHash = location.hash;
  if (initHash.startsWith('#renban/')) {
    const eventId = initHash.slice(8);
    showSection('renban');
    initRenban().then(() => openRenbanDetail(eventId));
  } else if (initHash.startsWith('#jare/')) {
    const docId = initHash.slice(6);
    showSection('jare');
    initJare();
    showJareDetail(docId);
  } else if (initHash.startsWith('#schedule/')) {
    const dateStr = initHash.slice(10);
    showSection('schedule');
    renderCalendar().then(() => openDayDetail(dateStr));
  } else if (initHash === '#boshu') {
    showSection('boshu');
  }

  // 同一ページ内でハッシュが変わったときも対応（共有リンクをクリックした場合など）
  window.addEventListener('hashchange', () => {
    const h = location.hash;
    if (h.startsWith('#renban/')) {
      showSection('renban');
      initRenban().then(() => openRenbanDetail(h.slice(8)));
    } else if (h.startsWith('#jare/')) {
      showSection('jare');
      initJare();
      showJareDetail(h.slice(6));
    } else if (h.startsWith('#schedule/')) {
      showSection('schedule');
      renderCalendar().then(() => openDayDetail(h.slice(10)));
    } else if (h === '#boshu') {
      showSection('boshu');
    }
  });
}

// ── 認証UI更新 ──
function updateAuthUI(user) {
  const wasResolved = _authResolved;
  _authResolved = true;
  const loginBtn = document.getElementById('auth-login-btn');
  const userInfo = document.getElementById('auth-user-info');
  if (!loginBtn || !userInfo) return;
  // 詳細ページを直リンクで開いた場合、認証確定後に再評価
  if (!wasResolved && currentSection === 'jare-detail' && _jareDetailDocId) {
    showJareDetail(_jareDetailDocId);
  }
  if (user) {
    loginBtn.style.display = 'none';
    userInfo.style.display = 'flex';
    _loadUserData(user).then(() => {
      if (!wasResolved) _handleAdminHashRoute();
    });
  } else {
    loginBtn.style.display = 'block';
    userInfo.style.display = 'none';
    _registeredName = null;
    _isAdmin   = false;
    _isManager = false;
    const _navAdminBtn = document.getElementById('nav-admin-btn');
    if (_navAdminBtn) _navAdminBtn.style.display = 'none';
    _refreshBoardIfActive();
    _refreshJareIfActive();
  }
  const rbHint = document.getElementById('rb-login-hint');
  if (rbHint) rbHint.style.display = user ? 'none' : 'inline';
}

// ── ログインモーダル ──
function openLoginModal() {
  document.getElementById('login-modal').classList.add('open');
}
function closeLoginModal() {
  document.getElementById('login-modal').classList.remove('open');
}

// ── Google ログイン ──
async function loginWithGoogle() {
  if (!_auth) return;
  try {
    const provider = new firebase.auth.GoogleAuthProvider();
    const result = await _auth.signInWithPopup(provider);
    _notifyDiscordLogin(result.user, 'Google');
    location.reload();
  } catch(e) {
    if (e.code !== 'auth/popup-closed-by-user') alert('ログインに失敗しました: ' + e.message);
  }
}

// ── X (Twitter) ログイン ──
async function loginWithTwitter() {
  if (!_auth) return;
  try {
    const provider = new firebase.auth.TwitterAuthProvider();
    const result = await _auth.signInWithPopup(provider);
    _notifyDiscordLogin(result.user, 'X');
    location.reload();
  } catch(e) {
    if (e.code !== 'auth/popup-closed-by-user') alert('ログインに失敗しました: ' + e.message);
  }
}

async function _notifyDiscordLogin(user, provider) {
  const key = 'syario_loggedin_' + user.uid;
  if (localStorage.getItem(key)) return;
  localStorage.setItem(key, '1');
  const name = user.displayName || '(名前なし)';
  const email = user.email || '(メールなし)';
  const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  await fetch('https://discord.com/api/webhooks/1486620241294397483/moDgwuhBw70TSEbnEvLqQhgc7t8cjPFeqUDmWPVawx00_-O2CUJ3lN027EVUG_7g_nwW', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: `🔑 初回ログイン\n👤 ${name}\n📧 ${email}\n🔗 ${provider}\n🕐 ${now}` })
  }).catch(() => {});
}

// ── ログアウト ──
async function signOutUser() {
  if (!_auth) return;
  await _auth.signOut();
}

// ── マイページ ──
function openMyPage() {
  if (!_currentUser) return;
  _loadMyPageName();
  _renderProviders();
  document.getElementById('mypage-save-msg').textContent = '';
  const badge = document.getElementById('mypage-admin-badge');
  if (badge) badge.style.display = _isAdmin ? '' : 'none';
  const managerBadge = document.getElementById('mypage-manager-badge');
  if (managerBadge) managerBadge.style.display = _isManager ? '' : 'none';
  document.getElementById('mypage-modal').classList.add('open');
}
function closeMyPage() {
  document.getElementById('mypage-modal').classList.remove('open');
}
async function _loadMyPageName() {
  const input = document.getElementById('mypage-name-input');
  if (!input || !_currentUser) return;
  try {
    const doc = await _db.collection('users').doc(_currentUser.uid).get();
    input.value = (doc.exists && doc.data().displayName) ? doc.data().displayName : (_currentUser.displayName || '');
  } catch(e) {
    input.value = _currentUser.displayName || '';
  }
}
function _renderProviders() {
  const container = document.getElementById('mypage-providers');
  if (!container || !_currentUser) return;
  container.innerHTML = _currentUser.providerData.map(p => {
    if (p.providerId === 'google.com') {
      return `<div class="mypage-provider">
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
          <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
          <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
          <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
        </svg>
        Google（${p.displayName || p.email || ''}）
      </div>`;
    } else if (p.providerId === 'twitter.com') {
      return `<div class="mypage-provider">
        <svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
          <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
        </svg>
        X（${p.displayName || ''}）
      </div>`;
    }
    return `<div class="mypage-provider">${p.providerId}（${p.displayName || p.email || ''}）</div>`;
  }).join('');
}
async function saveMyPageName() {
  if (!_currentUser || !_db) return;
  const input = document.getElementById('mypage-name-input');
  const msg = document.getElementById('mypage-save-msg');
  const name = input.value.trim();
  if (!name) {
    msg.style.color = 'var(--red)';
    msg.textContent = '名前を入力してください';
    return;
  }
  try {
    await _db.collection('users').doc(_currentUser.uid).set({ displayName: name }, { merge: true });
    _registeredName = name;
    // 開きっぱなしのフィードバックフォームにも反映
    const fbName = document.getElementById('fb-name');
    if (fbName && fbName.value !== name) fbName.value = name;
    msg.style.color = 'var(--green)';
    msg.textContent = '保存しました';
    setTimeout(() => { msg.textContent = ''; }, 2000);
  } catch(e) {
    msg.style.color = 'var(--red)';
    msg.textContent = '保存に失敗しました';
  }
}
async function myPageSignOut() {
  if (!_auth) return;
  await _auth.signOut();
  closeMyPage();
}

// ── ユーザーデータ読み込み（登録名・管理者フラグ）──
async function _loadUserData(user) {
  if (!user || !_db) return;
  try {
    const [userDoc, adminDoc, managerDoc] = await Promise.all([
      _db.collection('users').doc(user.uid).get(),
      _db.collection('admins').doc(user.uid).get(),
      _db.collection('managers').doc(user.uid).get()
    ]);
    _registeredName = (userDoc.exists && userDoc.data().displayName)
      ? userDoc.data().displayName
      : (user.displayName || '');
    _isAdmin   = adminDoc.exists;
    _isManager = managerDoc.exists;
  } catch(e) {
    _registeredName = user.displayName || '';
    _isAdmin   = false;
    _isManager = false;
  }
  // 管理者ナビボタンの表示制御
  const navAdminBtn = document.getElementById('nav-admin-btn');
  if (navAdminBtn) navAdminBtn.style.display = _isAdmin ? '' : 'none';
  // ご意見フォームに名前を反映（既に入力済みの場合は上書きしない）
  const fbName = document.getElementById('fb-name');
  if (fbName && !fbName.value) fbName.value = _registeredName;
  // 掲示板・じゃれ本を再レンダリング（削除ボタン表示を反映）
  _refreshBoardIfActive();
  _refreshJareIfActive();
}

// ── ログイン必須ガード ──
// ログイン済みなら true、未ログインならモーダルを開いて false を返す
function requireLogin(actionLabel) {
  if (_currentUser) return true;
  openLoginModal();
  return false;
}


function _escHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function _esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// alias used by renban.js and boshu.js
const escHtml = _esc;

document.addEventListener('DOMContentLoaded', initFirebase);
