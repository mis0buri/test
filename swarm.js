// ── Swarm連携機能 ──
const SWARM_DEFAULT_TEMPLATE = "I'm at {venue} in {area}, {state} {url}";
const SWARM_FOURSQUARE_API_VERSION = '20231010';

let _swarmAccount = null;       // { accessToken, clientId, proxyPrefix } Firestoreから読み込み
let _swarmCheckins = [];        // 直近に取得したチェックイン一覧
let _swarmVenueResults = [];    // チェックイン用の場所検索結果
let _swarmSelectedVenue = null; // チェックイン用に選択中の場所

// ── 初期化 ──
async function initAdminSwarm() {
  if (!_isAdmin) return;
  document.getElementById('swarm-redirect-uri').value = location.origin + location.pathname;
  document.getElementById('swarm-template-input').value = localStorage.getItem('swarm_template') || SWARM_DEFAULT_TEMPLATE;
  updateSwarmTemplatePreview();

  await _loadSwarmAccount();
  _renderSwarmAccountStatus();
  if (_swarmAccount && _swarmAccount.accessToken) {
    fetchSwarmCheckins();
  } else {
    _renderSwarmCheckinList();
  }
}

async function _loadSwarmAccount() {
  _swarmAccount = null;
  if (!_currentUser || !_db) return;
  try {
    const doc = await _db.collection('swarm_accounts').doc(_currentUser.uid).get();
    if (doc.exists) _swarmAccount = doc.data();
  } catch(e) {
    console.warn('Swarmアカウント読み込みエラー:', e);
  }
}

function _renderSwarmAccountStatus() {
  const statusEl = document.getElementById('swarm-account-status');
  const formEl = document.getElementById('swarm-setup-form');
  const linkedEl = document.getElementById('swarm-linked-info');
  if (!_currentUser) {
    statusEl.textContent = 'Swarmと連携するには、まずこのページにログインしてください';
    statusEl.style.display = '';
    formEl.style.display = 'none';
    linkedEl.style.display = 'none';
    return;
  }
  statusEl.style.display = 'none';
  if (_swarmAccount && _swarmAccount.accessToken) {
    formEl.style.display = 'none';
    linkedEl.style.display = '';
    document.getElementById('swarm-linked-user').textContent =
      '連携済み' + (_swarmAccount.clientId ? '（Client ID: ' + _swarmAccount.clientId + '）' : '');
  } else {
    formEl.style.display = '';
    linkedEl.style.display = 'none';
  }
}

// ── 連携（OAuth） ──
function connectSwarmAccount() {
  const statusEl = document.getElementById('swarm-status-settings');
  if (!requireLogin('Swarm連携')) return;
  const clientId = document.getElementById('swarm-client-id').value.trim();
  const proxyPrefix = document.getElementById('swarm-proxy-prefix').value.trim();
  if (!clientId) {
    statusEl.textContent = 'Client IDを入力してください';
    statusEl.className = 'admin-status error';
    return;
  }
  // リダイレクト後にページが再読み込みされるため、一時的にlocalStorageへ保存
  localStorage.setItem('swarm_pending_client_id', clientId);
  localStorage.setItem('swarm_pending_proxy_prefix', proxyPrefix);
  const redirectUri = encodeURIComponent(location.origin + location.pathname);
  location.href = `https://foursquare.com/oauth2/authenticate?client_id=${encodeURIComponent(clientId)}&response_type=token&redirect_uri=${redirectUri}`;
}

// app.jsのonAuthStateChangedから呼ばれる（OAuthコールバック後のトークンをFirestoreへ保存）
async function _swarmHandleAuthReady(user) {
  if (!user) {
    _swarmAccount = null;
    return;
  }
  if (!window._swarmPendingToken) return;
  const accessToken = window._swarmPendingToken;
  delete window._swarmPendingToken;
  const clientId = localStorage.getItem('swarm_pending_client_id') || '';
  const proxyPrefix = localStorage.getItem('swarm_pending_proxy_prefix') || '';
  localStorage.removeItem('swarm_pending_client_id');
  localStorage.removeItem('swarm_pending_proxy_prefix');
  try {
    await _db.collection('swarm_accounts').doc(user.uid).set({
      accessToken, clientId, proxyPrefix,
      linkedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    _swarmAccount = { accessToken, clientId, proxyPrefix };
    if (currentSection === 'admin-swarm') {
      _renderSwarmAccountStatus();
      fetchSwarmCheckins();
    }
  } catch(e) {
    console.warn('Swarmアカウント保存エラー:', e);
  }
}

async function unlinkSwarmAccount() {
  if (!_currentUser || !_db) return;
  if (!confirm('Swarmとの連携を解除しますか？')) return;
  try {
    await _db.collection('swarm_accounts').doc(_currentUser.uid).delete();
    _swarmAccount = null;
    _swarmCheckins = [];
    _renderSwarmAccountStatus();
    _renderSwarmCheckinList();
  } catch(e) {
    alert('解除に失敗しました: ' + e.message);
  }
}

function copySwarmRedirectUri() {
  const input = document.getElementById('swarm-redirect-uri');
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

async function searchSwarmVenues() {
  const statusEl = document.getElementById('swarm-status-checkin');
  if (!_swarmAccount || !_swarmAccount.accessToken) {
    statusEl.textContent = '先にSwarmと連携してください';
    statusEl.className = 'admin-status error';
    return;
  }
  const query = document.getElementById('swarm-venue-query').value.trim();
  const near = document.getElementById('swarm-venue-near').value.trim();
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
  const proxyPrefix = _swarmAccount.proxyPrefix || '';
  const apiUrl = `https://api.foursquare.com/v2/venues/search?oauth_token=${encodeURIComponent(_swarmAccount.accessToken)}&v=${SWARM_FOURSQUARE_API_VERSION}${queryParam}${locationParam}`;
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
    _swarmVenueResults = (json.response && json.response.venues) || [];
    statusEl.textContent = '';
    statusEl.className = 'admin-status';
    _renderSwarmVenueResults();
  } catch(e) {
    statusEl.textContent = '検索に失敗しました: ' + e.message + '（CORSの場合はプロキシの設定をお試しください）';
    statusEl.className = 'admin-status error';
  }
}

function _renderSwarmVenueResults() {
  const listEl = document.getElementById('swarm-venue-results');
  if (!_swarmVenueResults.length) {
    listEl.innerHTML = '<div class="admin-empty">該当する場所が見つかりません</div>';
    return;
  }
  listEl.innerHTML = _swarmVenueResults.map((v, idx) => {
    const loc = v.location || {};
    const addr = (loc.formattedAddress || []).join(' ');
    return `<div class="swarm-venue-item" onclick="selectSwarmVenue(${idx})">
      <div class="swarm-venue-name">${_esc(v.name || '')}</div>
      <div class="swarm-venue-addr">${_esc(addr)}</div>
    </div>`;
  }).join('');
}

function selectSwarmVenue(idx) {
  const venue = _swarmVenueResults[idx];
  if (!venue) return;
  _swarmSelectedVenue = venue;
  document.getElementById('swarm-selected-venue').textContent = venue.name || '';
  document.getElementById('swarm-checkin-form').style.display = '';
}

async function submitSwarmCheckin() {
  const statusEl = document.getElementById('swarm-status-checkin');
  if (!_swarmAccount || !_swarmAccount.accessToken) {
    statusEl.textContent = '先にSwarmと連携してください';
    statusEl.className = 'admin-status error';
    return;
  }
  if (!_swarmSelectedVenue) {
    statusEl.textContent = '場所を選択してください';
    statusEl.className = 'admin-status error';
    return;
  }
  const shout = document.getElementById('swarm-checkin-shout').value.trim();
  const proxyPrefix = _swarmAccount.proxyPrefix || '';
  statusEl.textContent = 'チェックイン中...';
  statusEl.className = 'admin-status';
  try {
    const res = await fetch(proxyPrefix + 'https://api.foursquare.com/v2/checkins/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        oauth_token: _swarmAccount.accessToken,
        v: SWARM_FOURSQUARE_API_VERSION,
        venueId: _swarmSelectedVenue.id,
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
      _swarmCheckins.unshift(newCheckin);
      _renderSwarmCheckinList();
    }
    document.getElementById('swarm-checkin-shout').value = '';
    document.getElementById('swarm-checkin-form').style.display = 'none';
    document.getElementById('swarm-venue-results').innerHTML = '';
    document.getElementById('swarm-venue-query').value = '';
    _swarmSelectedVenue = null;
  } catch(e) {
    statusEl.textContent = '失敗しました: ' + e.message;
    statusEl.className = 'admin-status error';
  }
}

// ── テンプレート編集 ──
function insertSwarmToken(token) {
  const ta = document.getElementById('swarm-template-input');
  const start = ta.selectionStart || ta.value.length;
  const end = ta.selectionEnd || ta.value.length;
  ta.value = ta.value.slice(0, start) + token + ta.value.slice(end);
  ta.focus();
  ta.selectionStart = ta.selectionEnd = start + token.length;
  updateSwarmTemplatePreview();
}

function updateSwarmTemplatePreview() {
  const template = document.getElementById('swarm-template-input').value;
  localStorage.setItem('swarm_template', template);
  const sample = {
    venue: { name: '雀荘シャリオ', location: { city: '渋谷区', state: '東京都', country: '日本', lat: 35.6595, lng: 139.7005 } },
    shout: '今日も連戦！',
    id: 'sample'
  };
  document.getElementById('swarm-template-preview').textContent = _buildSwarmPostText(sample, template);
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
async function fetchSwarmCheckins() {
  const statusEl = document.getElementById('swarm-status-fetch');
  if (!_swarmAccount || !_swarmAccount.accessToken) {
    statusEl.textContent = '先にSwarmと連携してください';
    statusEl.className = 'admin-status error';
    return;
  }
  const limit = document.getElementById('swarm-fetch-limit').value || '25';
  const proxyPrefix = _swarmAccount.proxyPrefix || '';
  const apiUrl = `https://api.foursquare.com/v2/users/self/checkins?oauth_token=${encodeURIComponent(_swarmAccount.accessToken)}&v=${SWARM_FOURSQUARE_API_VERSION}&limit=${encodeURIComponent(limit)}`;
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
    _swarmCheckins = (json.response && json.response.checkins && json.response.checkins.items) || [];
    statusEl.textContent = `${_swarmCheckins.length}件取得しました ✓`;
    statusEl.className = 'admin-status ok';
    _renderSwarmCheckinList();
  } catch(e) {
    statusEl.textContent = '取得に失敗しました: ' + e.message + '（CORSの場合はプロキシの設定をお試しください）';
    statusEl.className = 'admin-status error';
  }
}

function _renderSwarmCheckinList() {
  const listEl = document.getElementById('swarm-checkin-list');
  if (!_swarmCheckins.length) {
    listEl.innerHTML = '<div class="admin-empty">チェックインがありません</div>';
    return;
  }
  listEl.innerHTML = _swarmCheckins.map((c, idx) => {
    const venue = c.venue || {};
    const loc = venue.location || {};
    const dateStr = c.createdAt ? new Date(c.createdAt * 1000).toLocaleString('ja-JP') : '';
    const placeStr = [loc.city, loc.state].filter(Boolean).join(', ');
    return `<div class="swarm-checkin-card">
      <div class="swarm-checkin-venue">${_esc(venue.name || '(不明な場所)')}</div>
      <div class="swarm-checkin-meta">${_esc(dateStr)}${placeStr ? ' &nbsp;' + _esc(placeStr) : ''}</div>
      ${c.shout ? `<div class="swarm-checkin-shout">${_esc(c.shout)}</div>` : ''}
      <div class="swarm-checkin-actions">
        <button class="admin-btn sm primary" onclick="postSwarmCheckinToX(${idx})">Xに投稿</button>
        <button class="admin-btn sm" onclick="copySwarmCheckinText(${idx})">テキストをコピー</button>
      </div>
    </div>`;
  }).join('');
}

function postSwarmCheckinToX(idx) {
  const checkin = _swarmCheckins[idx];
  if (!checkin) return;
  const template = document.getElementById('swarm-template-input').value || SWARM_DEFAULT_TEMPLATE;
  const text = _buildSwarmPostText(checkin, template);
  window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`, '_blank');
}

function copySwarmCheckinText(idx) {
  const checkin = _swarmCheckins[idx];
  if (!checkin) return;
  const template = document.getElementById('swarm-template-input').value || SWARM_DEFAULT_TEMPLATE;
  const text = _buildSwarmPostText(checkin, template);
  navigator.clipboard.writeText(text).catch(() => {});
}
