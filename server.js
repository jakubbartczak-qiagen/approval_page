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

const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'http://localhost:5500';
const DOCEBO_BASE_URL = (process.env.DOCEBO_BASE_URL || '').replace(/\/$/, '');
const BOOTSTRAP_SECRET = process.env.BOOTSTRAP_SECRET;

function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function makeBootstrapSig(username, time) {
  return crypto
    .createHmac('sha256', BOOTSTRAP_SECRET || '')
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

app.set('trust proxy', 1);

app.use(cors({
  origin: FRONTEND_ORIGIN,
  credentials: true
}));

app.use(express.json());

app.use(session({
  secret: getRequiredEnv('SESSION_SECRET'),
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
  if (!req.session.user) {
    return res.status(401).json({ success: false, error: 'Not authenticated' });
  }
  next();
}

async function loginToDocebo() {
  const params = new URLSearchParams();
  params.append('grant_type', 'password');
  params.append('client_id', getRequiredEnv('DOCEBO_CLIENT_ID'));
  params.append('client_secret', getRequiredEnv('DOCEBO_CLIENT_SECRET'));
  params.append('username', getRequiredEnv('DOCEBO_USERNAME'));
  params.append('password', getRequiredEnv('DOCEBO_PASSWORD'));

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
    username: String(firstDefined(user, ['username']) || username || ''),
    firstname: String(firstDefined(user, ['first_name', 'firstname']) || ''),
    lastname: String(firstDefined(user, ['last_name', 'lastname']) || ''),
    email: String(firstDefined(user, ['email']) || ''),
    managerid: String(firstDefined(user, ['manager_id', 'managerid']) || ''),
    managerusername: String(firstDefined(user, ['manager_username', 'managerusername']) || ''),
    canManageSubordinates: Boolean(firstDefined(user, ['can_manage_subordinates', 'canmanagesubordinates']))
  };
}

async function getSubordinates(token, managerId) {
  const data = await doceboGet(token, `${DOCEBO_BASE_URL}/manage/v1/managers/${encodeURIComponent(managerId)}/subordinates`);
  const items = data?.data?.items || data?.items || [];

  return items.map(item => ({
    user_id: String(firstDefined(item, ['user_id', 'subordinate_id', 'userid']) || ''),
    username: String(firstDefined(item, ['username', 'subordinate_username']) || ''),
    fullname: String(firstDefined(item, ['fullname']) || ''),
    email: String(firstDefined(item, ['email']) || '')
  })).filter(item => item.user_id);
}

async function getPendingUsers(token) {
  const data = await doceboGet(token, `${DOCEBO_BASE_URL}/learn/v1/enrollment/pending_users`, {
    page: 1,
    page_size: 200
  });

  return data?.data?.items || data?.items || [];
}

function isPendingStatus(value) {
  return ['to_confirm', 'waiting', 'pending'].includes(String(value || '').toLowerCase());
}

function normalizePendingRow(row) {
  const courseId = String(firstDefined(row, ['course_id', 'id_course', 'id']) || '');
  const courseName = String(firstDefined(row, ['course_name', 'name_course', 'course_title', 'title']) || 'Unknown course');
  const sessionId = String(firstDefined(row, ['session_id']) || '');
  const sessionName = String(firstDefined(row, ['session_name', 'name_session']) || '-');

  return {
    user_id: String(firstDefined(row, ['user_id']) || ''),
    username: String(firstDefined(row, ['username']) || ''),
    fullname: String(firstDefined(row, ['fullname']) || ''),
    email: String(firstDefined(row, ['email']) || ''),
    course_id: courseId,
    course_name: courseName,
    course_url: courseId ? `${DOCEBO_BASE_URL}/course/view/${encodeURIComponent(courseId)}` : '#',
    session_id: sessionId,
    session_name: sessionName,
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
    subordinates_count: subordinates.length,
    items
  };
}

app.get('/api/auth/bootstrap', async (req, res) => {
  try {
    const username = String(req.query.username || req.query.user || '').trim().toLowerCase();
    const time = String(req.query.time || '').trim();
    const sig = String(req.query.sig || '').trim();

    if (!username || !time || !sig) {
      return res.status(400).json({ success: false, error: 'Missing username, time or sig' });
    }

    if (!BOOTSTRAP_SECRET) {
      return res.status(500).json({ success: false, error: 'Missing BOOTSTRAP_SECRET' });
    }

    const expected = makeBootstrapSig(username, time);
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

    return req.session.save(() => res.redirect('/'));
  } catch (error) {
    console.error('bootstrap error:', error.response?.data || error.message);
    return res.status(500).json({ success: false, error: 'Failed to bootstrap session' });
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

app.get('/api/pending-items', requireAuth, async (req, res) => {
  try {
    const token = req.session.doceboToken || await loginToDocebo();
    const data = await fetchDashboardData(token, req.session.user);
    req.session.doceboToken = token;
    res.json({ success: true, ...data });
  } catch (error) {
    console.error('pending-items error:', {
      message: error.message,
      status: error.response?.status,
      data: error.response?.data
    });
    res.status(500).json({ success: false, error: 'Failed to load pending items' });
  }
});

const frontendPath = __dirname;

app.use(express.static(frontendPath));

app.get('/frontend/index.html', (req, res) => {
  res.sendFile(path.join(frontendPath, 'index.html'));
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
