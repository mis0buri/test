// ── Swarm連携機能 ──
const SWARM_DEFAULT_TEMPLATE = "I'm at {venue} in {area}, {state} {url}";
const SWARM_FOURSQUARE_API_VERSION = '20231010';

let _swarmAccount = null;     // { accessToken, clientId, proxyPrefix } Firestoreから読み込み
let _swarmCheckins = [];      // 直近に取得したチェックイン一覧

// ── 設定パネルの開閉 ──
function toggleSwarmSettingsPanel() {
  const body = document.getElementById('swarm-settings-body');
  const arrow = document.getElementById('swarm-settings-arrow');
  const open = body.classList.toggle('open');
  arrow.classList.toggle('open', open);
}

// ── 初期化 ──
async function initAdminSwarm() {
  if (!_isAdmin) return;
  document.getElementById('swarm-redirect-uri').value = location.origin + location.pathname;
  document.getElementById('swarm-template-input').value = localStorage.getItem('swarm_template') || SWARM_DEFAULT_TEMPLATE;
  updateSwarmTemplatePreview();
  document.getElementById('swarm-settings-body').classList.add('open');
  document.getElementById('swarm-settings-arrow').classList.add('open');

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
