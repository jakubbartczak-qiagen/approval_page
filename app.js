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

let currentManager = null;

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
    toast.remove();
  }, 3000);
}

function setLoading(v) {
  loadingBox.classList.toggle('hidden', !v);
}

function setEmpty(v) {
  emptyState.classList.toggle('hidden', !v);
}

function setTableVisible(v) {
  tableWrapper.classList.toggle('hidden', !v);
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function apiGet(path) {
  const response = await fetch(path, {
    credentials: 'include'
  });

  const data = await response.json();

  if (!response.ok || !data.success) {
    throw new Error(data.error || 'Request failed');
  }

  return data;
}

async function apiPost(path, body) {
  const response = await fetch(path, {
    method: 'POST',

    credentials: 'include',

    headers: {
      'Content-Type': 'application/json'
    },

    body: JSON.stringify(body)
  });

  const data = await response.json();

  if (!response.ok || !data.success) {
    throw new Error(data.error || 'Request failed');
  }

  return data;
}

function renderManager(manager) {
  const fullName =
    `${manager.firstname || ''} ${manager.lastname || ''}`.trim()
    || manager.username
    || '-';

  managerUsernameEl.textContent = fullName;
}

function buildRow(item) {
  const tr = document.createElement('tr');

  tr.innerHTML = `
    <td>${escapeHtml(item.fullname)}</td>

    <td>${escapeHtml(item.email)}</td>

    <td>${escapeHtml(item.course_name)}</td>

    <td>${escapeHtml(item.session_name)}</td>

    <td>${escapeHtml(item.session_start)}</td>

    <td>${escapeHtml(item.session_end)}</td>

    <td>
      <span class="status-badge">
        Pending Approval
      </span>
    </td>

    <td>
      <a
        class="course-link"
        href="${escapeHtml(item.course_url)}"
        target="_blank"
      >
        Open course
      </a>
    </td>

    <td>
      <div class="actions">
        <button class="btn btn-primary">
          Approve
        </button>

        <button class="btn btn-danger">
          Decline
        </button>
      </div>
    </td>
  `;

  const approveBtn = tr.querySelector('.btn-primary');

  const denyBtn = tr.querySelector('.btn-danger');

  approveBtn.addEventListener('click', async () => {
    try {
      approveBtn.disabled = true;
      denyBtn.disabled = true;

      await apiPost('/api/approve', {
        courseId: item.course_id,
        sessionId: item.session_id,
        userId: item.user_id
      });

      showToast('Enrollment approved');

      await loadTable();

    } catch (error) {
      showToast(error.message, 'error');

      approveBtn.disabled = false;
      denyBtn.disabled = false;
    }
  });

  denyBtn.addEventListener('click', async () => {
    try {
      approveBtn.disabled = true;
      denyBtn.disabled = true;

      await apiPost('/api/deny', {
        courseId: item.course_id,
        sessionId: item.session_id,
        userId: item.user_id
      });

      showToast('Enrollment declined');

      await loadTable();

    } catch (error) {
      showToast(error.message, 'error');

      approveBtn.disabled = false;
      denyBtn.disabled = false;
    }
  });

  return tr;
}

async function loadTable() {
  try {
    hideMessage();

    setLoading(true);

    const me = await apiGet('/api/me');

    currentManager = me.user;

    renderManager(currentManager);

    const data = await apiGet('/api/pending-items');

    subordinatesCountEl.textContent =
      data.subordinates_count || 0;

    pendingCountEl.textContent =
      data.items.length || 0;

    tableBody.innerHTML = '';

    if (!data.items.length) {
      setEmpty(true);
      setTableVisible(false);

      return;
    }

    setEmpty(false);

    const fragment = document.createDocumentFragment();

    data.items.forEach(item => {
      fragment.appendChild(buildRow(item));
    });

    tableBody.appendChild(fragment);

    setTableVisible(true);

  } catch (error) {

    console.error(error);

    showMessage(error.message, 'error');

    setEmpty(true);

  } finally {

    setLoading(false);
  }
}

refreshBtn.addEventListener('click', loadTable);

loadTable();
