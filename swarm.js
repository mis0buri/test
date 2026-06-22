// ── Swarm連携機能 ──
const SWARM_DEFAULT_TEMPLATE = "I'm at {venue} in {area}, {state} {url}";
const SWARM_FOURSQUARE_API_VERSION = '20231010';

// ns（名前空間）ごとに別々のFoursquareアプリ／連携状態を持てるようにする
// main  = メインタブ「Swarm連携」（サイト全体で共有するClient ID。誰でも連携可能）
// admin = 管理者メニュー「Swarm連携」（管理者専用の別アプリ・別Client ID）
const SWARM_NS = {
  main:  { idPrefix: 'swarm',  configDoc: 'swarm',       accountCollection: 'swarm_accounts',       templateKey: 'swarm_template' },
  admin: { idPrefix: 'aswarm', configDoc: 'swarm_admin',  accountCollection: 'swarm_accounts_admin',  templateKey: 'swarm_template_admin' }
};

const _swarmState = {
  main:  { config: null, account: null, checkins: [], venueResults: [], selectedVenue: null },
  admin: { config: null, account: null, checkins: [], venueResults: [], selectedVenue: null }
};

// ── セクション開閉 ──
function toggleSwarmPanel(bodyId, arrowId) {
  const body = document.getElementById(bodyId);
  const arrow = document.getElementById(arrowId);
  const open = body.classList.toggle('open');
  arrow.classList.toggle('open', open);
}

// ── 初期化 ──
async function initSwarm(ns) {
  const cfg = SWARM_NS[ns];
  const st = _swarmState[ns];
  const pfx = cfg.idPrefix;
  document.getElementById(pfx+'-template-input').value = localStorage.getItem(cfg.templateKey) || SWARM_DEFAULT_TEMPLATE;
  updateSwarmTemplatePreview(ns);

  await _loadSwarmConfig(ns);
  if (ns !== 'main' || _isAdmin) {
    document.getElementById(pfx+'-redirect-uri').value = location.origin + location.pathname;
    if (st.config) {
      document.getElementById(pfx+'-client-id').value = st.config.clientId || '';
      document.getElementById(pfx+'-proxy-prefix').value = st.config.proxyPrefix || '';
    }
  }

  await _loadSwarmAccount(ns);
  _renderSwarmAccountStatus(ns);
  if (st.account && st.account.accessToken) {
    fetchSwarmCheckins(ns);
  } else {
    _renderSwarmCheckinList(ns);
  }
}

async function _loadSwarmConfig(ns) {
  const cfg = SWARM_NS[ns];
  const st = _swarmState[ns];
  st.config = null;
  if (!_db) return;
  try {
    const doc = await _db.collection('admin_config').doc(cfg.configDoc).get();
    if (doc.exists) st.config = doc.data();
  } catch(e) {
    console.warn('Swarm設定読み込みエラー:', e);
  }
}

async function _loadSwarmAccount(ns) {
  const cfg = SWARM_NS[ns];
  const st = _swarmState[ns];
  st.account = null;
  if (!_currentUser || !_db) return;
  try {
    const doc = await _db.collection(cfg.accountCollection).doc(_currentUser.uid).get();
    if (doc.exists) st.account = doc.data();
  } catch(e) {
    console.warn('Swarmアカウント読み込みエラー:', e);
  }
}

function _renderSwarmAccountStatus(ns) {
  const cfg = SWARM_NS[ns];
  const st = _swarmState[ns];
  const pfx = cfg.idPrefix;
  const statusEl = document.getElementById(pfx+'-account-status');
  const adminConfigEl = document.getElementById(pfx+'-admin-config'); // mainのみ存在
  const notConfiguredEl = document.getElementById(pfx+'-not-configured');
  const connectFormEl = document.getElementById(pfx+'-connect-form');
  const linkedEl = document.getElementById(pfx+'-linked-info');
  if (adminConfigEl) adminConfigEl.style.display = _isAdmin ? '' : 'none';
  if (!_currentUser) {
    statusEl.textContent = 'Swarmと連携するには、まずこのページにログインしてください';
    statusEl.style.display = '';
    notConfiguredEl.style.display = 'none';
    connectFormEl.style.display = 'none';
    linkedEl.style.display = 'none';
    return;
  }
  statusEl.style.display = 'none';
  if (st.account && st.account.accessToken) {
    notConfiguredEl.style.display = 'none';
    connectFormEl.style.display = 'none';
    linkedEl.style.display = '';
    document.getElementById(pfx+'-linked-user').textContent =
      '連携済み' + ((ns !== 'main' || _isAdmin) && st.config && st.config.clientId ? '（Client ID: ' + st.config.clientId + '）' : '');
  } else if (st.config && st.config.clientId) {
    notConfiguredEl.style.display = 'none';
    connectFormEl.style.display = '';
    linkedEl.style.display = 'none';
  } else {
    notConfiguredEl.style.display = '';
    connectFormEl.style.display = 'none';
    linkedEl.style.display = 'none';
  }
}

// ── Foursquareアプリ設定（管理者のみ） ──
async function saveSwarmConfig(ns) {
  const cfg = SWARM_NS[ns];
  const st = _swarmState[ns];
  const pfx = cfg.idPrefix;
  const statusEl = document.getElementById(pfx+'-status-settings');
  if (!_isAdmin) return;
  const clientId = document.getElementById(pfx+'-client-id').value.trim();
  const proxyPrefix = document.getElementById(pfx+'-proxy-prefix').value.trim();
  if (!clientId) {
    statusEl.textContent = 'Client IDを入力してください';
    statusEl.className = 'admin-status error';
    return;
  }
  try {
    await _db.collection('admin_config').doc(cfg.configDoc).set({ clientId, proxyPrefix }, { merge: true });
    st.config = { clientId, proxyPrefix };
    statusEl.textContent = '保存しました ✓';
    statusEl.className = 'admin-status ok';
    _renderSwarmAccountStatus(ns);
  } catch(e) {
    statusEl.textContent = '保存に失敗しました: ' + e.message;
    statusEl.className = 'admin-status error';
  }
}

// ── 連携（OAuth） ──
function connectSwarmAccount(ns) {
  const cfg = SWARM_NS[ns];
  const st = _swarmState[ns];
  const statusEl = document.getElementById(cfg.idPrefix+'-status-connect');
  if (!requireLogin('Swarm連携')) return;
  if (!st.config || !st.config.clientId) {
    statusEl.textContent = 'サイト管理者がまだ設定していません';
    statusEl.className = 'admin-status error';
    return;
  }
  localStorage.setItem('swarm_pending_ns', ns);
  const redirectUri = encodeURIComponent(location.origin + location.pathname);
  location.href = `https://foursquare.com/oauth2/authenticate?client_id=${encodeURIComponent(st.config.clientId)}&response_type=token&redirect_uri=${redirectUri}`;
}

// app.jsのonAuthStateChangedから呼ばれる（OAuthコールバック後のトークンをFirestoreへ保存）
async function _swarmHandleAuthReady(user) {
  if (!user) {
    Object.keys(_swarmState).forEach(ns => { _swarmState[ns].account = null; });
    return;
  }
  if (!window._swarmPendingToken) return;
  const accessToken = window._swarmPendingToken;
  const ns = SWARM_NS[window._swarmPendingNs] ? window._swarmPendingNs : 'main';
  delete window._swarmPendingToken;
  delete window._swarmPendingNs;
  const cfg = SWARM_NS[ns];
  const st = _swarmState[ns];
  try {
    await _db.collection(cfg.accountCollection).doc(user.uid).set({
      accessToken,
      linkedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    st.account = { accessToken };
    const activeSectionId = ns === 'main' ? 'swarm' : 'admin-swarm';
    if (currentSection === activeSectionId) {
      _renderSwarmAccountStatus(ns);
      fetchSwarmCheckins(ns);
    }
  } catch(e) {
    console.warn('Swarmアカウント保存エラー:', e);
  }
}

async function unlinkSwarmAccount(ns) {
  if (!_currentUser || !_db) return;
  if (!confirm('Swarmとの連携を解除しますか？')) return;
  await _unlinkSwarmAccountSilent(ns);
}

// 別アカウントへの切り替え: Foursquareは既存のログイン状態を使って再連携してしまうため、
// ログアウト用ページを別タブで開いてから連携解除する
function switchSwarmAccount(ns) {
  if (!_currentUser || !_db) return;
  if (!confirm('別のSwarmアカウントに切り替えますか？\n新しいタブでFoursquareのログアウトページを開きます。ログアウト後、このタブで再度「Swarmと連携する」を押してください。')) return;
  window.open('https://foursquare.com/logout', '_blank');
  _unlinkSwarmAccountSilent(ns);
}

async function _unlinkSwarmAccountSilent(ns) {
  const cfg = SWARM_NS[ns];
  const st = _swarmState[ns];
  try {
    await _db.collection(cfg.accountCollection).doc(_currentUser.uid).delete();
    st.account = null;
    st.checkins = [];
    _renderSwarmAccountStatus(ns);
    _renderSwarmCheckinList(ns);
  } catch(e) {
    alert('解除に失敗しました: ' + e.message);
  }
}

function copySwarmRedirectUri(ns) {
  const input = document.getElementById(SWARM_NS[ns].idPrefix + '-redirect-uri');
  input.select();
  navigator.clipboard.writeText(input.value).catch(() => {});
}

// ── チェックイン作成 ──
function _getSwarmGeolocation() {
  return new Promise(resolve => {
    if (!navigator.geolocation) { resolve(null); return; }
    navigator.geolocation.getCurrentPosition(
      pos => resolve(pos.coords),
      () => resolve(null),
      { timeout: 5000 }
    );
  });
}

async function searchSwarmVenues(ns) {
  const cfg = SWARM_NS[ns];
  const st = _swarmState[ns];
  const statusEl = document.getElementById(cfg.idPrefix+'-status-checkin');
  if (!st.account || !st.account.accessToken) {
    statusEl.textContent = '先にSwarmと連携してください';
    statusEl.className = 'admin-status error';
    return;
  }
  const query = document.getElementById(cfg.idPrefix+'-venue-query').value.trim();
  const near = document.getElementById(cfg.idPrefix+'-venue-near').value.trim();
  let locationParam = '';
  if (near) {
    locationParam = `&near=${encodeURIComponent(near)}`;
  } else {
    const coords = await _getSwarmGeolocation();
    if (coords) {
      locationParam = `&ll=${coords.latitude},${coords.longitude}`;
    } else if (!query) {
      statusEl.textContent = '検索キーワードか場所を入力するか、位置情報の利用を許可してください';
      statusEl.className = 'admin-status error';
      return;
    }
  }
  const queryParam = query ? `&query=${encodeURIComponent(query)}` : '';
  const proxyPrefix = (st.config && st.config.proxyPrefix) || '';
  const apiUrl = `https://api.foursquare.com/v2/venues/search?oauth_token=${encodeURIComponent(st.account.accessToken)}&v=${SWARM_FOURSQUARE_API_VERSION}${queryParam}${locationParam}`;
  statusEl.textContent = '検索中...';
  statusEl.className = 'admin-status';
  try {
    const res = await fetch(proxyPrefix + apiUrl);
    const json = await res.json();
    if (!res.ok || (json.meta && json.meta.code !== 200)) {
      statusEl.textContent = 'エラー: ' + (json.meta ? json.meta.errorDetail : res.statusText);
      statusEl.className = 'admin-status error';
      return;
    }
    st.venueResults = (json.response && json.response.venues) || [];
    statusEl.textContent = '';
    statusEl.className = 'admin-status';
    _renderSwarmVenueResults(ns);
  } catch(e) {
    statusEl.textContent = '検索に失敗しました: ' + e.message + '（CORSの場合はプロキシの設定をお試しください）';
    statusEl.className = 'admin-status error';
  }
}

function _renderSwarmVenueResults(ns) {
  const cfg = SWARM_NS[ns];
  const st = _swarmState[ns];
  const listEl = document.getElementById(cfg.idPrefix+'-venue-results');
  if (!st.venueResults.length) {
    listEl.innerHTML = '<div class="admin-empty">該当する場所が見つかりません</div>';
    return;
  }
  listEl.innerHTML = st.venueResults.map((v, idx) => {
    const loc = v.location || {};
    const addr = (loc.formattedAddress || []).join(' ');
    return `<div class="swarm-venue-item" onclick="selectSwarmVenue('${ns}', ${idx})">
      <div class="swarm-venue-name">${_esc(v.name || '')}</div>
      <div class="swarm-venue-addr">${_esc(addr)}</div>
    </div>`;
  }).join('');
}

function selectSwarmVenue(ns, idx) {
  const cfg = SWARM_NS[ns];
  const st = _swarmState[ns];
  const venue = st.venueResults[idx];
  if (!venue) return;
  st.selectedVenue = venue;
  document.getElementById(cfg.idPrefix+'-selected-venue').textContent = venue.name || '';
  document.getElementById(cfg.idPrefix+'-checkin-form').style.display = '';
}

async function submitSwarmCheckin(ns) {
  const cfg = SWARM_NS[ns];
  const st = _swarmState[ns];
  const statusEl = document.getElementById(cfg.idPrefix+'-status-checkin');
  if (!st.account || !st.account.accessToken) {
    statusEl.textContent = '先にSwarmと連携してください';
    statusEl.className = 'admin-status error';
    return;
  }
  if (!st.selectedVenue) {
    statusEl.textContent = '場所を選択してください';
    statusEl.className = 'admin-status error';
    return;
  }
  const shout = document.getElementById(cfg.idPrefix+'-checkin-shout').value.trim();
  const proxyPrefix = (st.config && st.config.proxyPrefix) || '';
  statusEl.textContent = 'チェックイン中...';
  statusEl.className = 'admin-status';
  try {
    const res = await fetch(proxyPrefix + 'https://api.foursquare.com/v2/checkins/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        oauth_token: st.account.accessToken,
        v: SWARM_FOURSQUARE_API_VERSION,
        venueId: st.selectedVenue.id,
        shout,
        broadcast: 'private'
      })
    });
    const json = await res.json();
    if (!res.ok || (json.meta && json.meta.code !== 200)) {
      statusEl.textContent = 'エラー: ' + (json.meta ? json.meta.errorDetail : res.statusText);
      statusEl.className = 'admin-status error';
      return;
    }
    statusEl.textContent = 'チェックインしました ✓';
    statusEl.className = 'admin-status ok';
    const newCheckin = json.response && json.response.checkin;
    if (newCheckin) {
      st.checkins.unshift(newCheckin);
      _renderSwarmCheckinList(ns);
    }
    document.getElementById(cfg.idPrefix+'-checkin-shout').value = '';
    document.getElementById(cfg.idPrefix+'-checkin-form').style.display = 'none';
    document.getElementById(cfg.idPrefix+'-venue-results').innerHTML = '';
    document.getElementById(cfg.idPrefix+'-venue-query').value = '';
    st.selectedVenue = null;
  } catch(e) {
    statusEl.textContent = '失敗しました: ' + e.message;
    statusEl.className = 'admin-status error';
  }
}

// ── テンプレート編集 ──
function insertSwarmToken(ns, token) {
  const cfg = SWARM_NS[ns];
  const ta = document.getElementById(cfg.idPrefix+'-template-input');
  const start = ta.selectionStart || ta.value.length;
  const end = ta.selectionEnd || ta.value.length;
  ta.value = ta.value.slice(0, start) + token + ta.value.slice(end);
  ta.focus();
  ta.selectionStart = ta.selectionEnd = start + token.length;
  updateSwarmTemplatePreview(ns);
}

function updateSwarmTemplatePreview(ns) {
  const cfg = SWARM_NS[ns];
  const template = document.getElementById(cfg.idPrefix+'-template-input').value;
  localStorage.setItem(cfg.templateKey, template);
  const sample = {
    venue: { name: '雀荘シャリオ', location: { city: '渋谷区', state: '東京都', country: '日本', lat: 35.6595, lng: 139.7005 } },
    shout: '今日も連戦！',
    id: 'sample'
  };
  document.getElementById(cfg.idPrefix+'-template-preview').textContent = _buildSwarmPostText(sample, template);
}

function _buildSwarmPostText(checkin, template) {
  const venue = checkin.venue || {};
  const loc = venue.location || {};
  const url = checkin.id ? `https://www.swarmapp.com/checkin/${checkin.id}` : '';
  const tokenMap = {
    '{venue}': venue.name || '',
    '{area}': loc.city || '',
    '{state}': loc.state || '',
    '{country}': loc.country || '',
    '{lat}': (loc.lat !== undefined && loc.lat !== null) ? loc.lat : '',
    '{lng}': (loc.lng !== undefined && loc.lng !== null) ? loc.lng : '',
    '{shout}': checkin.shout || '',
    '{url}': url
  };
  let text = template;
  Object.keys(tokenMap).forEach(key => { text = text.split(key).join(tokenMap[key]); });
  return text;
}

// ── チェックイン取得 ──
async function fetchSwarmCheckins(ns) {
  const cfg = SWARM_NS[ns];
  const st = _swarmState[ns];
  const statusEl = document.getElementById(cfg.idPrefix+'-status-fetch');
  if (!st.account || !st.account.accessToken) {
    statusEl.textContent = '先にSwarmと連携してください';
    statusEl.className = 'admin-status error';
    return;
  }
  const limit = document.getElementById(cfg.idPrefix+'-fetch-limit').value || '25';
  const proxyPrefix = (st.config && st.config.proxyPrefix) || '';
  const apiUrl = `https://api.foursquare.com/v2/users/self/checkins?oauth_token=${encodeURIComponent(st.account.accessToken)}&v=${SWARM_FOURSQUARE_API_VERSION}&limit=${encodeURIComponent(limit)}`;
  statusEl.textContent = '取得中...';
  statusEl.className = 'admin-status';
  try {
    const res = await fetch(proxyPrefix + apiUrl);
    const json = await res.json();
    if (!res.ok || (json.meta && json.meta.code !== 200)) {
      const code = json.meta ? json.meta.code : res.status;
      if (code === 401) {
        statusEl.textContent = '認証の有効期限が切れました。再度連携してください';
      } else {
        statusEl.textContent = 'エラー: ' + (json.meta ? json.meta.errorDetail : res.statusText);
      }
      statusEl.className = 'admin-status error';
      return;
    }
    st.checkins = (json.response && json.response.checkins && json.response.checkins.items) || [];
    statusEl.textContent = `${st.checkins.length}件取得しました ✓`;
    statusEl.className = 'admin-status ok';
    _renderSwarmCheckinList(ns);
  } catch(e) {
    statusEl.textContent = '取得に失敗しました: ' + e.message + '（CORSの場合はプロキシの設定をお試しください）';
    statusEl.className = 'admin-status error';
  }
}

function _renderSwarmCheckinList(ns) {
  const cfg = SWARM_NS[ns];
  const st = _swarmState[ns];
  const listEl = document.getElementById(cfg.idPrefix+'-checkin-list');
  if (!st.checkins.length) {
    listEl.innerHTML = '<div class="admin-empty">チェックインがありません</div>';
    return;
  }
  listEl.innerHTML = st.checkins.map((c, idx) => {
    const venue = c.venue || {};
    const loc = venue.location || {};
    const dateStr = c.createdAt ? new Date(c.createdAt * 1000).toLocaleString('ja-JP') : '';
    const placeStr = [loc.city, loc.state].filter(Boolean).join(', ');
    return `<div class="swarm-checkin-card">
      <div class="swarm-checkin-venue">${_esc(venue.name || '(不明な場所)')}</div>
      <div class="swarm-checkin-meta">${_esc(dateStr)}${placeStr ? ' &nbsp;' + _esc(placeStr) : ''}</div>
      ${c.shout ? `<div class="swarm-checkin-shout">${_esc(c.shout)}</div>` : ''}
      <div class="swarm-checkin-actions">
        <button class="admin-btn sm primary" onclick="postSwarmCheckinToX('${ns}', ${idx})">Xに投稿</button>
        <button class="admin-btn sm" onclick="copySwarmCheckinText('${ns}', ${idx})">テキストをコピー</button>
      </div>
    </div>`;
  }).join('');
}

function postSwarmCheckinToX(ns, idx) {
  const cfg = SWARM_NS[ns];
  const st = _swarmState[ns];
  const checkin = st.checkins[idx];
  if (!checkin) return;
  const template = document.getElementById(cfg.idPrefix+'-template-input').value || SWARM_DEFAULT_TEMPLATE;
  const text = _buildSwarmPostText(checkin, template);
  window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`, '_blank');
}

function copySwarmCheckinText(ns, idx) {
  const cfg = SWARM_NS[ns];
  const st = _swarmState[ns];
  const checkin = st.checkins[idx];
  if (!checkin) return;
  const template = document.getElementById(cfg.idPrefix+'-template-input').value || SWARM_DEFAULT_TEMPLATE;
  const text = _buildSwarmPostText(checkin, template);
  navigator.clipboard.writeText(text).catch(() => {});
}
