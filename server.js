require('dotenv').config();

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const session = require('express-session');
const path = require('path');
const crypto = require('crypto');

const app = express();

const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';

const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'https://jakubbartczak-qiagen.github.io';
const DOCEBO_BASE_URL = (process.env.DOCEBO_BASE_URL || '').replace(/\/$/, '');
const BOOTSTRAP_SECRET = process.env.BOOTSTRAP_SECRET || '';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function bootstrapSig(username, time) {
  return crypto
    .createHmac('sha256', BOOTSTRAP_SECRET)
    .update(`${username}|${time}`)
    .digest('hex');
}

function firstDefined(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function normalizeEmail(v) {
  return String(v || '').trim().toLowerCase();
}

app.set('trust proxy', 1);

app.use(cors({
  origin: FRONTEND_ORIGIN,
  credentials: true
}));

app.use(express.json());

app.use(session({
  secret: required('SESSION_SECRET'),
  resave: false,
  saveUninitialized: false,
  proxy: IS_PROD,
  cookie: {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: IS_PROD ? 'none' : 'lax',
    maxAge: 1000 * 60 * 60 * 8
  }
}));

function requireAuth(req, res, next) {
  if (!req.session?.user) {
    return res.status(401).json({ success: false, error: 'Not authenticated' });
  }
  next();
}

async function loginToDocebo() {
  const params = new URLSearchParams();
  params.append('grant_type', 'password');
  params.append('client_id', required('DOCEBO_CLIENT_ID'));
  params.append('client_secret', required('DOCEBO_CLIENT_SECRET'));
  params.append('username', required('DOCEBO_USERNAME'));
  params.append('password', required('DOCEBO_PASSWORD'));

  const response = await axios.post(`${DOCEBO_BASE_URL}/oauth2/token`, params, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });

  return response.data.access_token;
}

async function doceboGet(token, url, params = {}) {
  const response = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` },
    params
  });
  return response.data;
}

async function getUserByUsername(token, username) {
  const data = await doceboGet(token, `${DOCEBO_BASE_URL}/manage/v1/user`, { username });
  const user = data?.data?.user_data || data?.data || data || {};

  return {
    user_id: String(firstDefined(user, ['user_id', 'userid', 'id']) || ''),
    username: normalizeEmail(firstDefined(user, ['username']) || username),
    firstname: String(firstDefined(user, ['first_name', 'firstname']) || ''),
    lastname: String(firstDefined(user, ['last_name', 'lastname']) || ''),
    email: normalizeEmail(firstDefined(user, ['email']) || ''),
    managerid: String(firstDefined(user, ['manager_id', 'managerid']) || ''),
    managerusername: normalizeEmail(firstDefined(user, ['manager_username', 'managerusername']) || ''),
    canManageSubordinates: Boolean(firstDefined(user, ['can_manage_subordinates', 'canmanagesubordinates']))
  };
}

async function getSubordinates(token, managerId) {
  const data = await doceboGet(token, `${DOCEBO_BASE_URL}/manage/v1/managers/${encodeURIComponent(managerId)}/subordinates`);
  const items = data?.data?.items || data?.items || [];
  return items.map(item => ({
    user_id: String(firstDefined(item, ['user_id', 'subordinate_id', 'userid']) || ''),
    username: normalizeEmail(firstDefined(item, ['username', 'subordinate_username']) || ''),
    fullname: String(firstDefined(item, ['fullname']) || ''),
    email: normalizeEmail(firstDefined(item, ['email']) || '')
  })).filter(x => x.user_id);
}

async function getPendingUsers(token) {
  const data = await doceboGet(token, `${DOCEBO_BASE_URL}/learn/v1/enrollment/pending_users`, {
    page: 1,
    page_size: 200
  });
  return data?.data?.items || data?.items || [];
}

function isPendingStatus(v) {
  return ['to_confirm', 'waiting', 'pending', 'pending approval'].includes(String(v || '').toLowerCase());
}

function normalizePendingRow(row) {
  const courseId = String(firstDefined(row, ['course_id', 'id_course', 'id']) || '');
  const courseName = String(firstDefined(row, ['course_name', 'name_course', 'course_title', 'title']) || 'Unknown course');

  return {
    user_id: String(firstDefined(row, ['user_id']) || ''),
    username: normalizeEmail(firstDefined(row, ['username']) || ''),
    fullname: String(firstDefined(row, ['fullname']) || ''),
    email: normalizeEmail(firstDefined(row, ['email']) || ''),
    course_id: courseId,
    course_name: courseName,
    course_url: courseId ? `${DOCEBO_BASE_URL}/course/view/${encodeURIComponent(courseId)}` : '#',
    session_name: String(firstDefined(row, ['session_name', 'name_session']) || '-'),
    session_start: String(firstDefined(row, ['session_start', 'start_date']) || '-'),
    session_end: String(firstDefined(row, ['session_end', 'end_date']) || '-'),
    enrollment_status: String(firstDefined(row, ['enrollment_status', 'status', 'state']) || '').toLowerCase()
  };
}

async function fetchDashboardData(token, currentUser) {
  const subordinates = await getSubordinates(token, currentUser.user_id);
  const subordinateIds = new Set(subordinates.map(s => String(s.user_id)));
  const subordinateMap = new Map(subordinates.map(s => [String(s.user_id), s]));
  const rawPending = await getPendingUsers(token);

  const items = rawPending
    .filter(row => subordinateIds.has(String(firstDefined(row, ['user_id']) || '')))
    .map(row => {
      const item = normalizePendingRow(row);
      const subordinate = subordinateMap.get(String(item.user_id));
      return {
        ...item,
        fullname: subordinate?.fullname || item.fullname,
        email: subordinate?.email || item.email,
        username: subordinate?.username || item.username
      };
    })
    .filter(item => isPendingStatus(item.enrollment_status));

  return {
    manager: currentUser,
    directEmployees: subordinates.length,
    pendingItems: items.length,
    items
  };
}

app.get('/api/auth/bootstrap', async (req, res) => {
  try {
    const username = normalizeEmail(req.query.username || req.query.user || '');
    const time = String(req.query.time || '').trim();
    const sig = String(req.query.sig || '').trim();

    if (!username || !time || !sig) {
      return res.status(400).json({ success: false, error: 'Missing username, time or sig' });
    }

    if (!BOOTSTRAP_SECRET) {
      return res.status(500).json({ success: false, error: 'Missing BOOTSTRAP_SECRET' });
    }

    const expected = bootstrapSig(username, time);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(403).json({ success: false, error: 'Invalid signature' });
    }

    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - Number(time)) > 300) {
      return res.status(403).json({ success: false, error: 'Expired link' });
    }

    const token = await loginToDocebo();
    const user = await getUserByUsername(token, username);

    req.session.user = user;
    req.session.username = username;
    req.session.doceboToken = token;

    req.session.save(() => res.redirect('/'));
  } catch (error) {
    console.error('bootstrap error:', error.response?.data || error.message);
    res.status(500).json({ success: false, error: 'Failed to bootstrap session' });
  }
});

app.get('/api/me', requireAuth, async (req, res) => {
  try {
    const token = req.session.doceboToken || await loginToDocebo();
    const fresh = await getUserByUsername(token, req.session.username || req.session.user.username);
    req.session.user = fresh;
    req.session.doceboToken = token;
    res.json({ success: true, user: fresh });
  } catch (error) {
    console.error('me error:', error.response?.data || error.message);
    res.status(500).json({ success: false, error: 'Failed to load current user' });
  }
});

app.get('/api/dashboard', requireAuth, async (req, res) => {
  try {
    const token = req.session.doceboToken || await loginToDocebo();
    const currentUser = await getUserByUsername(token, req.session.username || req.session.user.username);
    req.session.user = currentUser;
    req.session.doceboToken = token;

    const dashboard = await fetchDashboardData(token, currentUser);
    res.json({ success: true, ...dashboard });
  } catch (error) {
    console.error('dashboard error:', error.response?.data || error.message);
    res.status(500).json({ success: false, error: 'Failed to load dashboard' });
  }
});

app.post('/api/pending-items/:id/approve', requireAuth, async (req, res) => {
  res.json({ success: true });
});

app.post('/api/pending-items/:id/decline', requireAuth, async (req, res) => {
  res.json({ success: true });
});

const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));

app.get(['/', '/index.html', '/approval_page/', '/approval_page/index.html'], (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.use((req, res) => {
  res.status(404).send('Not Found');
});

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
