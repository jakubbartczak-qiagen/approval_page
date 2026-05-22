require('dotenv').config();

const express        = require('express');
const axios          = require('axios');
const cors           = require('cors');
const session        = require('express-session');
const { Sequelize }  = require('sequelize');
const SequelizeStore = require('connect-session-sequelize')(session.Store);
const path           = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

const DOCEBO_BASE_URL = (process.env.DOCEBO_BASE_URL || '').replace(/\/$/, '');

app.set('trust proxy', 1);

const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: './sessions.db',
  logging: false
});

const sessionStore = new SequelizeStore({ db: sequelize });
sessionStore.sync();

app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self' https://*.docebosaas.com");
  next();
});

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

app.use(session({
  name:              'qialearn.sid',
  secret:            process.env.SESSION_SECRET,
  store:             sessionStore,
  resave:            false,
  saveUninitialized: false,
  proxy:             true,
  rolling:           true,
  cookie: {
    httpOnly: true,
    secure:   true,
    sameSite: 'none',
    maxAge:   1000 * 60 * 60 * 8
  }
}));

// ─── Helpers ─────────────────────────────────────────────────

function normalize(v) {
  return String(v || '').trim().toLowerCase();
}

function mapUser(user = {}) {
  return {
    user_id:   String(user.user_id || user.id || ''),
    username:  normalize(user.username || ''),
    firstname: user.firstname || user.first_name || '',
    lastname:  user.lastname  || user.last_name  || '',
    email:     normalize(user.email || '')
  };
}

// ─── Docebo login ─────────────────────────────────────────────

async function loginToDocebo() {
  const params = new URLSearchParams();
  params.append('grant_type',    'password');
  params.append('client_id',     process.env.DOCEBO_CLIENT_ID);
  params.append('client_secret', process.env.DOCEBO_CLIENT_SECRET);
  params.append('username',      process.env.DOCEBO_USERNAME);
  params.append('password',      process.env.DOCEBO_PASSWORD);

  const response = await axios.post(
    `${DOCEBO_BASE_URL}/oauth2/token`,
    params,
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  return response.data.access_token;
}

async function doceboGet(token, url, params = {}) {
  const response = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` },
    params
  });
  return response.data;
}

// ─── Find user by ID ──────────────────────────────────────────

async function getUserById(token, userId) {
  let page = 1;

  while (page <= 500) {
    console.log(`SEARCH PAGE ${page}`);
    const response = await doceboGet(token, `${DOCEBO_BASE_URL}/manage/v1/user`, { page, page_size: 50 });
    const users = response?.data?.items || response?.data?.users || response?.users || [];
    const found = users.find(u => String(u.user_id || u.id || '') === String(userId));

    if (found) {
      console.log('FOUND USER:', found.username);
      return mapUser(found);
    }

    const totalPages = Number(response?.data?.total_page_count || 0);
    if (totalPages && page >= totalPages) break;
    page++;
  }

  return {};
}

// ─── Find user by username ────────────────────────────────────

async function getUserByUsername(token, username) {
  const response = await doceboGet(token, `${DOCEBO_BASE_URL}/manage/v1/user`, {
    page: 1, page_size: 50, search_text: username
  });
  const users = response?.data?.items || response?.data?.users || response?.users || [];
  const exact = users.find(u => normalize(u.username) === normalize(username));
  return mapUser(exact || users[0] || {});
}

// ─── Subordinates ─────────────────────────────────────────────

async function getSubordinates(token, managerId, managerUsername) {
  let page     = 1;
  let allItems = [];

  while (true) {
    const response = await doceboGet(
      token,
      `${DOCEBO_BASE_URL}/manage/v1/managers/subordinates`,
      { page, page_size: 200 }
    );

    const items = response?.data?.items || response?.items || [];

    if (page === 1) {
      console.log('SUBORDINATES FIRST ITEM:', JSON.stringify(items[0] || {}));
      console.log('SUBORDINATES TOTAL:', response?.data?.total_count || 'unknown');
    }

    allItems = allItems.concat(items);

    const totalPages = Number(response?.data?.total_page_count || 1);
    if (page >= totalPages || items.length === 0) break;
    page++;
  }

  console.log('SUBORDINATES ALL COUNT:', allItems.length);

  const filtered = allItems.filter(item => {
    const itemManagerId = String(item.manager_id || item.managerid || item.manager?.user_id || '');
    return itemManagerId === String(managerId);
  });

  console.log('SUBORDINATES FILTERED COUNT:', filtered.length);

  if (filtered.length === 0 && allItems.length > 0) {
    console.log('SUBORDINATES KEYS:', Object.keys(allItems[0]));
  }

  return filtered.map(item => ({
    user_id:  String(item.subordinate_id  || item.user_id  || ''),
    username: normalize(item.subordinate_username || item.username || ''),
    fullname: item.subordinate_fullname   || item.fullname ||
              `${item.subordinate_firstname || ''} ${item.subordinate_lastname || ''}`.trim(),
    email:    normalize(item.subordinate_email || item.email || '')
  }));
}

// ─── Pending users ────────────────────────────────────────────

async function getPendingUsers(token) {
  const response = await doceboGet(
    token,
    `${DOCEBO_BASE_URL}/learn/v1/enrollment/pending_users`,
    { page: 1, page_size: 200 }
  );
  return response?.data?.items || response?.items || [];
}

// ─── Course URL ───────────────────────────────────────────────

function buildCourseUrl(courseId, slug) {
  if (slug) return `${DOCEBO_BASE_URL}/course/${slug}`;
  return `${DOCEBO_BASE_URL}/course/view/${courseId}`;
}

// ─── Dashboard ────────────────────────────────────────────────

async function loadDashboard(token, manager) {
  const subordinates   = await getSubordinates(token, manager.user_id, manager.username);
  const subordinateIds = new Set(subordinates.map(x => String(x.user_id)));

  const subordinateMap = {};
  subordinates.forEach(s => { subordinateMap[String(s.user_id)] = s; });

  const pending = await getPendingUsers(token);

  const items = pending
    .filter(item => subordinateIds.has(String(item.user_id)))
    .map(item => {
      const sub = subordinateMap[String(item.user_id)] || {};
      return {
        user_id:           String(item.user_id || ''),
        fullname:          sub.fullname || item.fullname || item.username || '',
        email:             sub.email    || item.email    || item.username || '',
        course_id:         String(item.course_id || ''),
        course_name:       item.course_name || '',
        session_id:        String(item.session_id || ''),
        session_name:      item.session_name || (item.session_id ? `Session ${item.session_id}` : '-'),
        session_start:     item.session_start || '-',
        session_end:       item.session_end   || '-',
        enrollment_status: item.enrollment_status || '',
        course_url:        buildCourseUrl(item.course_id, item.course_slug)
      };
    });

  return { manager, subordinates_count: subordinates.length, items };
}

// ─── Approve ──────────────────────────────────────────────────

async function approveEnrollment(token, courseId, userId, sessionId) {
  const url  = `${DOCEBO_BASE_URL}/learn/v1/enrollments/${courseId}/${userId}`;
  const body = { status: 0 };
  if (sessionId) body.session_id = Number(sessionId);
  await axios.put(url, body, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  });
}

// ─── Deny ─────────────────────────────────────────────────────

async function denyEnrollment(token, courseId, userId, sessionId) {
  let url = `${DOCEBO_BASE_URL}/learn/v1/enrollments/${courseId}/${userId}`;
  if (sessionId) url += `?session_id=${sessionId}`;
  await axios.delete(url, { headers: { Authorization: `Bearer ${token}` } });
}

// ─── Routes ───────────────────────────────────────────────────

app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/api/init', async (req, res) => {
  try {
    console.log('================ INIT START ================');

    const userId   = String(req.body.user_id  || '').trim();
    const username = normalize(req.body.username || '');
    const authCode = String(req.body.auth_code || '').trim();

    console.log('USER ID:', userId);
    console.log('USERNAME:', username);
    console.log('AUTH CODE:', authCode ? 'present' : 'missing');

    if (!userId || userId.includes('[') || userId.includes('{')) {
      return res.status(400).json({
        success: false,
        error:   'Docebo did not replace user_id placeholder',
        received_user_id: userId
      });
    }

    const token = await loginToDocebo();
    console.log('TOKEN OK');

    let user = await getUserById(token, userId);

    if (!user.user_id && username) {
      console.log('USER NOT FOUND BY ID -> TRY USERNAME');
      user = await getUserByUsername(token, username);
    }

    if (!user.user_id) {
      return res.status(404).json({ success: false, error: 'User not found in Docebo' });
    }

    console.log('USER OK:', user);

    req.session.user        = user;
    req.session.user_id     = user.user_id;
    req.session.doceboToken = token;

    await new Promise((resolve, reject) => {
      req.session.save(err => err ? reject(err) : resolve());
    });

    console.log('SESSION SAVED');
    return res.json({ success: true, user });

  } catch (error) {
    console.error('INIT ERROR:', error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      error:   error.message,
      details: error.response?.data || null
    });
  }
});

app.get('/api/me', async (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ success: false, error: 'Not authenticated' });
  }
  return res.json({ success: true, user: req.session.user });
});

app.get('/api/pending-items', async (req, res) => {
  try {
    if (!req.session.user) {
      return res.status(401).json({ success: false, error: 'Not authenticated' });
    }

    console.log('DASHBOARD START for user_id:', req.session.user.user_id);

    let subordinates = [];
    try {
      subordinates = await getSubordinates(req.session.doceboToken, req.session.user.user_id, req.session.user.username);
      console.log('SUBORDINATES COUNT:', subordinates.length);
    } catch (e) {
      console.error('SUBORDINATES ERROR:', e.response?.status, JSON.stringify(e.response?.data || e.message));
      return res.status(500).json({ success: false, error: 'Failed fetching subordinates', details: e.response?.data || e.message });
    }

    let pending = [];
    try {
      pending = await getPendingUsers(req.session.doceboToken);
      console.log('PENDING COUNT:', pending.length);
    } catch (e) {
      console.error('PENDING ERROR:', e.response?.status, JSON.stringify(e.response?.data || e.message));
      return res.status(500).json({ success: false, error: 'Failed fetching pending users', details: e.response?.data || e.message });
    }

    const subordinateIds = new Set(subordinates.map(x => String(x.user_id)));
    const subordinateMap = {};
    subordinates.forEach(s => { subordinateMap[String(s.user_id)] = s; });

    const items = pending
      .filter(item => subordinateIds.has(String(item.user_id)))
      .map(item => {
        const sub = subordinateMap[String(item.user_id)] || {};
        return {
          user_id:           String(item.user_id || ''),
          fullname:          sub.fullname || item.fullname || item.username || '',
          email:             sub.email    || item.email    || item.username || '',
          course_id:         String(item.course_id || ''),
          course_name:       item.course_name || '',
          session_id:        String(item.session_id || ''),
          session_name:      item.session_name || (item.session_id ? `Session ${item.session_id}` : '-'),
          session_start:     item.session_start || '-',
          session_end:       item.session_end   || '-',
          enrollment_status: item.enrollment_status || '',
          course_url:        buildCourseUrl(item.course_id, item.course_slug)
        };
      });

    console.log('MATCHED ITEMS:', items.length);

    return res.json({
      success: true,
      manager: req.session.user,
      subordinates_count: subordinates.length,
      items
    });

  } catch (error) {
    console.error('DASHBOARD ERROR:', error.response?.status, error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      error:   'Failed loading dashboard',
      details: error.response?.data || error.message
    });
  }
});

app.post('/api/approve', async (req, res) => {
  try {
    const { courseId, sessionId, userId } = req.body;
    console.log('APPROVE:', { courseId, sessionId, userId });
    await approveEnrollment(req.session.doceboToken, courseId, userId, sessionId);
    return res.json({ success: true, message: 'Enrollment approved successfully.' });
  } catch (error) {
    console.error('APPROVE ERROR STATUS:', error.response?.status);
    console.error('APPROVE ERROR DATA:', JSON.stringify(error.response?.data || error.message));
    return res.status(500).json({
      success: false,
      error:   'Approval failed',
      details: error.response?.data || error.message
    });
  }
});

app.post('/api/deny', async (req, res) => {
  try {
    const { courseId, sessionId, userId } = req.body;
    console.log('DENY:', { courseId, sessionId, userId });
    await denyEnrollment(req.session.doceboToken, courseId, userId, sessionId);
    return res.json({ success: true, message: 'Enrollment declined successfully.' });
  } catch (error) {
    console.error('DENY ERROR STATUS:', error.response?.status);
    console.error('DENY ERROR DATA:', JSON.stringify(error.response?.data || error.message));
    return res.status(500).json({
      success: false,
      error:   'Decline failed',
      details: error.response?.data || error.message
    });
  }
});

app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
