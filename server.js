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
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

function parseCsv(value) {
  return String(value || '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);
}

function firstDefined(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function normalizeStatus(value) {
  const raw = String(value || '').toLowerCase().trim();
  if (['to_confirm', 'waiting', 'pending'].includes(raw)) return 'to_confirm';
  if (['confirmed', 'approved', 'enrolled', 'subscribed'].includes(raw)) return 'confirmed';
  if (['denied', 'rejected'].includes(raw)) return 'denied';
  return raw || 'to_confirm';
}

function isPendingStatus(value) {
  return ['to_confirm', 'waiting', 'pending'].includes(String(value || '').toLowerCase());
}

function buildCourseUrl(courseId, courseSlug) {
  if (!courseId) return '#';
  if (courseSlug) return `${DOCEBO_BASE_URL}/course/${encodeURIComponent(courseSlug)}`;
  return `${DOCEBO_BASE_URL}/course/view/${encodeURIComponent(courseId)}`;
}

function makeBootstrapSig(username, time) {
  return crypto
    .createHmac('sha256', BOOTSTRAP_SECRET || '')
    .update(`${username}|${time}`)
    .digest('hex');
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
    return res.status(401).json({
      success: false,
      error: 'Not authenticated'
    });
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

async function doceboPut(token, url, body = {}) {
  const response = await axios.put(url, body, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  });
  return response.data;
}

async function doceboDelete(token, url) {
  const response = await axios.delete(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  });
  return response.data;
}

async function getUserById(token, userId) {
  const data = await doceboGet(token, `${DOCEBO_BASE_URL}/manage/v1/user/${encodeURIComponent(userId)}`);
  const user = data?.data?.user_data || data?.data || data || {};

  return {
    user_id: String(firstDefined(user, ['user_id', 'userid', 'id']) || userId),
    username: String(firstDefined(user, ['username']) || ''),
    firstname: String(firstDefined(user, ['first_name', 'firstname']) || ''),
    lastname: String(firstDefined(user, ['last_name', 'lastname']) || ''),
    email: String(firstDefined(user, ['email']) || ''),
    managerid: String(firstDefined(user, ['manager_id', 'managerid']) || ''),
    managerusername: String(firstDefined(user, ['manager_username', 'managerusername']) || ''),
    canManageSubordinates: Boolean(firstDefined(user, ['can_manage_subordinates', 'canmanagesubordinates']))
  };
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
    fullname: String(
      firstDefined(item, ['fullname', 'subordinate_fullname']) ||
      `${firstDefined(item, ['firstname', 'subordinate_firstname']) || ''} ${firstDefined(item, ['lastname', 'subordinate_lastname']) || ''}`.trim()
    ),
    email: String(firstDefined(item, ['email', 'subordinate_email']) || '')
  })).filter(item => item.user_id);
}

function normalizePendingRow(row) {
  const courseId = String(firstDefined(row, ['course_id', 'id_course', 'id']) || '');
  const sessionId = String(firstDefined(row, ['session_id']) || '');
  const courseSlug = String(firstDefined(row, ['course_slug', 'slug']) || '');
  const courseName = String(firstDefined(row, ['course_name', 'name_course', 'course_title', 'title']) || 'Unknown course');
  const sessionName = String(firstDefined(row, ['session_name', 'name_session']) || '-');

  return {
    user_id: String(firstDefined(row, ['user_id']) || ''),
    username: String(firstDefined(row, ['username']) || ''),
    fullname: String(firstDefined(row, ['fullname']) || ''),
    email: String(firstDefined(row, ['email']) || ''),
    course_id: courseId,
    course_name: courseName,
    course_url: buildCourseUrl(courseId, courseSlug),
    session_id: sessionId,
    session_name: sessionName,
    session_start: String(firstDefined(row, ['session_start', 'date_start', 'start_date', 'start_at']) || ''),
    session_end: String(firstDefined(row, ['session_end', 'date_end', 'end_date', 'end_at']) || ''),
    enrollment_status: normalizeStatus(firstDefined(row, ['enrollment_status', 'status', 'state']))
  };
}

async function getPendingUsers(token) {
  const data = await doceboGet(token, `${DOCEBO_BASE_URL}/learn/v1/enrollment/pending_users`, {
    page: 1,
    page_size: 200
  });

  return data?.data?.items || data?.items || [];
}

async function fetchDashboardData(token, currentUser) {
  const excludedCourseIds = parseCsv(process.env.EXCLUDED_COURSE_IDS);
  const subordinates = await getSubordinates(token, currentUser.user_id);
  const subordinateIds = new Set(subordinates.map(s => String(s.user_id)));

  const rawPending = await getPendingUsers(token);
  const subordinateMap = new Map(subordinates.map(s => [String(s.user_id), s]));

  const items = rawPending
    .filter(row => subordinateIds.has(String(firstDefined(row, ['user_id']) || '')))
    .map(row => {
      const item = normalizePendingRow(row);
      const subordinate = subordinateMap.get(String(item.user_id));

      return {
        ...item,
        fullname: subordinate?.fullname || item.fullname || '',
        email: subordinate?.email || item.email || '',
        username: subordinate?.username || item.username || ''
      };
    })
    .filter(item => isPendingStatus(item.enrollment_status))
    .filter(item => !excludedCourseIds.includes(String(item.course_id)));

  return {
    manager: currentUser,
    subordinates_count: subordinates.length,
    items
  };
}

async function approveEnrollment(token, { courseId, sessionId, userId }) {
  const url = `${DOCEBO_BASE_URL}/learn/v1/enrollments/${encodeURIComponent(courseId)}/${encodeURIComponent(userId)}`;
  const body = { status: 0 };
  if (sessionId) body.session_id = Number(sessionId);
  await doceboPut(token, url, body);
}

async function denyEnrollment(token, { courseId, sessionId, userId }) {
  const url = sessionId
    ? `${DOCEBO_BASE_URL}/learn/v1/enrollments/${encodeURIComponent(courseId)}/${encodeURIComponent(userId)}?session_id=${encodeURIComponent(sessionId)}`
    : `${DOCEBO_BASE_URL}/learn/v1/enrollments/${encodeURIComponent(courseId)}/${encodeURIComponent(userId)}`;
  await doceboDelete(token, url);
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
    req.session.doceboToken = token;

    return req.session.save(() => {
      return res.redirect('/frontend/index.html');
    });
  } catch (error) {
    console.error('bootstrap error:', error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      error: 'Failed to bootstrap session'
    });
  }
});

app.get('/api/me', requireAuth, async (req, res) => {
  try {
    res.json({
      success: true,
      user: req.session.user
    });
  } catch (error) {
    console.error('me error:', error.message);
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
    console.error('pending-items error:', error.response?.data || error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to load pending items'
    });
  }
});

app.post('/api/approve', requireAuth, async (req, res) => {
  try {
    const { courseId, sessionId, userId } = req.body || {};
    if (!courseId || !userId) {
      return res.status(400).json({ success: false, error: 'courseId and userId are required' });
    }

    const token = req.session.doceboToken || await loginToDocebo();
    await approveEnrollment(token, { courseId, sessionId, userId });
    req.session.doceboToken = token;

    res.json({
      success: true,
      message: 'Enrollment approved successfully.'
    });
  } catch (error) {
    console.error('approve error:', error.response?.data || error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to approve enrollment'
    });
  }
});

app.post('/api/deny', requireAuth, async (req, res) => {
  try {
    const { courseId, sessionId, userId } = req.body || {};
    if (!courseId || !userId) {
      return res.status(400).json({ success: false, error: 'courseId and userId are required' });
    }

    const token = req.session.doceboToken || await loginToDocebo();
    await denyEnrollment(token, { courseId, sessionId, userId });
    req.session.doceboToken = token;

    res.json({
      success: true,
      message: 'Enrollment declined successfully.'
    });
  } catch (error) {
    console.error('deny error:', error.response?.data || error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to decline enrollment'
    });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/frontend', express.static(path.join(__dirname, '..', 'frontend')));

app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
