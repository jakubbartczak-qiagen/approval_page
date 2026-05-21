const refreshBtn = document.getElementById('refreshBtn');
const managerUsernameEl = document.getElementById('managerUsername');
const subordinatesCountEl = document.getElementById('subordinatesCount');
const pendingCountEl = document.getElementById('pendingCount');
const messageBox = document.getElementById('messageBox');
const loadingBox = document.getElementById('loadingBox');
const emptyState = document.getElementById('emptyState');
const tableWrapper = document.getElementById('tableWrapper');
const tableBody = document.getElementById('tableBody');
const toastContainer = document.getElementById('toastContainer');
const returnBtn = document.getElementById('returnBtn');

let currentManager = null;

const API_BASE = (window.APP_CONFIG?.API_BASE || 'https://approval-page.onrender.com').replace(/\/$/, '');
const RETURN_URL = window.APP_CONFIG?.RETURN_URL || 'https://qiagen.docebosaas.com/';

returnBtn.href = RETURN_URL;

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function showMessage(text, type = 'success') {
  messageBox.textContent = text;
  messageBox.className = `message ${type}`;
  messageBox.classList.remove('hidden');
}

function hideMessage() {
  messageBox.className = 'message hidden';
  messageBox.textContent = '';
}

function showToast(text, type = 'success') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = text;
  toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(18px) scale(0.98)';
    toast.style.transition = 'opacity 0.25s ease, transform 0.25s ease';
    setTimeout(() => toast.remove(), 250);
  }, 2800);
}

function setLoading(value) {
  loadingBox.classList.toggle('hidden', !value);
}

function setEmpty(value) {
  emptyState.classList.toggle('hidden', !value);
}

function setTableVisible(value) {
  tableWrapper.classList.toggle('hidden', !value);
}

function formatDateTime(value) {
  if (!value) return '-';
  return value;
}

function formatEnrollmentStatus(value) {
  if (!value) return '-';
  if (value === 'to_confirm') return 'Pending Approval';
  return String(value)
    .replaceAll('_', ' ')
    .replace(/\b\w/g, char => char.toUpperCase());
}

function renderManager(manager) {
  const fullName =
    [manager?.firstname, manager?.lastname].filter(Boolean).join(' ').trim() ||
    manager?.managerlabel ||
    manager?.username ||
    manager?.user_id ||
    '-';

  managerUsernameEl.textContent = fullName;
}

function getQueryParam(name) {
  const params = new URLSearchParams(window.location.search);
  return params.get(name);
}

function resolveUserId() {
  return getQueryParam('user_id') || getQueryParam('userId') || '';
}

function resolveUsername() {
  return getQueryParam('username') || getQueryParam('user') || getQueryParam('u') || '';
}

function resolveDebugMode() {
  return getQueryParam('debug') === '1' || getQueryParam('debug') === 'true';
}

function setDiagnosticState(text) {
  showMessage(text, 'error');
  showToast(text, 'error');
  setLoading(false);
  setEmpty(true);
  setTableVisible(false);
  pendingCountEl.textContent = '0';
  subordinatesCountEl.textContent = '0';
  managerUsernameEl.textContent = '-';
}

async function apiGet(path) {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    headers: { Accept: 'application/json' }
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data.success) {
    throw new Error(typeof data.error === 'string' ? data.error : 'Request failed');
  }

  return data;
}

async function apiPost(path, body) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(body)
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data.success) {
    throw new Error(typeof data.error === 'string' ? data.error : 'Request failed');
  }

  return data;
}

function buildBootstrapUrl() {
  const userId = resolveUserId();
  const username = resolveUsername();

  if (userId) {
    return `${API_BASE}/api/auth/bootstrap?user_id=${encodeURIComponent(userId)}`;
  }

  if (username) {
    return `${API_BASE}/api/auth/bootstrap?username=${encodeURIComponent(username)}`;
  }

  return '';
}

async function bootstrapSession() {
  const url = buildBootstrapUrl();
  if (!url) {
    throw new Error('Missing Docebo payload in URL');
  }

  const response = await fetch(url, {
    method: 'GET',
    credentials: 'include',
    headers: { Accept: 'application/json' }
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data.success) {
    throw new Error(typeof data.error === 'string' ? data.error : 'Bootstrap failed');
  }

  currentManager = data.user;
  renderManager(currentManager);
  return data;
}

async function loadCurrentUser() {
  const data = await apiGet('/api/me');
  currentManager = data.user;
  renderManager(currentManager);
}

function buildRow(item) {
  const tr = document.createElement('tr');

  tr.innerHTML = `
    <td>${escapeHtml(item.fullname || item.username || '-')}</td>
    <td>${escapeHtml(item.email || '-')}</td>
    <td>${escapeHtml(item.course_name || '-')}</td>
    <td>${escapeHtml(item.session_name || '-')}</td>
    <td>${escapeHtml(formatDateTime(item.session_start))}</td>
    <td>${escapeHtml(formatDateTime(item.session_end))}</td>
    <td><span class="status-badge">${escapeHtml(formatEnrollmentStatus(item.enrollment_status))}</span></td>
    <td>
      <a class="course-link" href="${escapeHtml(item.course_url || '#')}" target="_blank" rel="noopener noreferrer">
        Open course
      </a>
    </td>
    <td>
      <div class="actions">
        <button class="btn btn-primary" type="button">Approve</button>
        <button class="btn btn-danger" type="button">Decline</button>
      </div>
    </td>
  `;

  const [approveBtn, denyBtn] = tr.querySelectorAll('button');
  approveBtn.addEventListener('click', () => handleDecision('approve', item.course_id, item.session_id, item.user_id, tr));
  denyBtn.addEventListener('click', () => handleDecision('deny', item.course_id, item.session_id, item.user_id, tr));

  return tr;
}

async function loadTable() {
  hideMessage();
  setLoading(true);
  setEmpty(false);
  setTableVisible(false);
  tableBody.innerHTML = '';

  try {
    if (!currentManager) {
      await bootstrapSession();
    } else {
      await loadCurrentUser();
    }

    const data = await apiGet('/api/pending-items');

    currentManager = data.manager || currentManager;
    renderManager(currentManager);

    subordinatesCountEl.textContent = data.subordinates_count ?? 0;
    pendingCountEl.textContent = data.items?.length ?? 0;

    const items = data.items || [];

    if (items.length === 0) {
      setEmpty(true);
      showMessage('No pending approvals found for this manager.', 'success');
      return;
    }

    const fragment = document.createDocumentFragment();
    items.forEach(item => fragment.appendChild(buildRow(item)));

    tableBody.appendChild(fragment);
    setTableVisible(true);
  } catch (error) {
    const msg = String(error.message || 'Unknown error');

    if (msg.includes('Missing Docebo payload')) {
      setDiagnosticState('Brak payloadu z Docebo. Aplikacja została otwarta poza launcherem albo Docebo nie przekazało user context.');
      return;
    }

    if (msg.includes('Not authenticated')) {
      setDiagnosticState('Brak sesji. Najpierw musi przyjść poprawny launch z Docebo.');
      return;
    }

    showMessage(`Load error: ${msg}`, 'error');
    showToast(`Load error: ${msg}`, 'error');
    setEmpty(true);
    setTableVisible(false);
  } finally {
    setLoading(false);
  }
}

async function handleDecision(action, courseId, sessionId, userId, rowEl) {
  hideMessage();

  const buttons = rowEl.querySelectorAll('button');
  buttons.forEach(btn => btn.disabled = true);

  try {
    const data = await apiPost(`/api/${action}`, { courseId, sessionId, userId });
    showMessage(data.message || 'Action completed successfully.', 'success');
    showToast(data.message || 'Success', 'success');
    await loadTable();
  } catch (error) {
    showMessage(`Action error: ${error.message}`, 'error');
    showToast(`Action error: ${error.message}`, 'error');
    buttons.forEach(btn => btn.disabled = false);
  }
}

async function showLaunchDiagnostics() {
  if (!resolveDebugMode()) return;

  try {
    const data = await fetch(`${API_BASE}/debug/launch${window.location.search}`, {
      credentials: 'include',
      headers: { Accept: 'application/json' }
    }).then(r => r.json());

    console.log('launch diagnostics:', data);
  } catch (e) {}
}

refreshBtn.addEventListener('click', loadTable);
showLaunchDiagnostics();
loadTable();
