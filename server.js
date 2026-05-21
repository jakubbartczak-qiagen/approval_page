require('dotenv').config();

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const session = require('express-session');
const path = require('path');

const app = express();

const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';

const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'https://jakubbartczak-qiagen.github.io';
const DOCEBO_BASE_URL = (process.env.DOCEBO_BASE_URL || '').replace(/\/$/, '');

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function normalize(v) {
  return String(v || '').trim().toLowerCase();
}

function firstDefined(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function parseCsv(value) {
  return String(value || '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);
}

function normalizeStatus(value) {
  const raw = String(value || '').toLowerCase().trim();
  if (['to_confirm', 'waiting', 'pending', 'pending approval'].includes(raw)) return 'to_confirm';
  if (['confirmed', 'approved', 'enrolled', 'subscribed'].includes(raw)) return 'confirmed';
  if (['denied', 'rejected'].includes(raw)) return 'denied';
  return raw || 'to_confirm';
}

function isPendingStatus(v) {
  return ['to_confirm', 'waiting', 'pending', 'pending approval'].includes(String(v || '').toLowerCase());
}

function buildCourseUrl(courseId, courseSlug) {
  if (!courseId) return '#';
  if (courseSlug) return `${DOCEBO_BASE_URL}/course/${encodeURIComponent(courseSlug)}`;
  return `${DOCEBO_BASE_URL}/course/view/${encodeURIComponent(courseId)}`;
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

function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save(err => {
      if (err) return reject(err);
      resolve();
    });
  });
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

async function findUserById(token, userId) {
  const id = String(userId || '').trim();
  if (!id) return {};

  try {
    const byId = await doceboGet(token, `${DOCEBO_BASE_URL}/manage/v1/user/${encodeURIComponent(id)}`);
    return byId?.data?.user_data || byId?.data || byId || {};
  } catch (e) {
    try {
      const byQuery = await doceboGet(token, `${DOCEBO_BASE_URL}/manage/v1/user`, { user_id: id });
      return byQuery?.data?.user_data || byQuery?.data || byQuery || {};
    } catch (e2) {
      return {};
    }
  }
}

async function getUserById(token, userId) {
  const user = await findUserById(token, userId);

  const managerid = String(firstDefined(user, ['managerid', 'manager_id', 'managerId']) || '');
  const managerusername = normalize(firstDefined(user, ['managerusername', 'manager_username', 'managerUserName']) || '');
  const managerfirstname = String(firstDefined(user, ['managerfirstname', 'manager_first_name', 'managerFirstName']) || '');
  const managerlastname = String(firstDefined(user, ['managerlastname', 'manager_last_name', 'managerLastName']) || '');

  return {
    user_id: String(firstDefined(user, ['user_id', 'userid', 'id']) || userId || ''),
    username: normalize(firstDefined(user, ['username']) || ''),
    firstname: String(firstDefined(user, ['firstname', 'first_name']) || ''),
    lastname: String(firstDefined(user, ['lastname', 'last_name']) || ''),
    email: normalize(firstDefined(user, ['email']) || ''),
    managerid,
    managerusername,
    managerfirstname,
    managerlastname,
    managerlabel: [managerfirstname, managerlastname].filter(Boolean).join(' ').trim() || managerusername || managerid || ''
  };
}

async function getSubordinates(token, managerId) {
  const data = await doceboGet(
    token,
    `${DOCEBO_BASE_URL}/manage/v1/managers/${encodeURIComponent(managerId)}/subordinates`
  );

  const items = data?.data?.items || data?.items || [];

  return items
    .map(item => ({
      user_id: String(firstDefined(item, ['user_id', 'subordinate_id', 'userid']) || ''),
      username: normalize(firstDefined(item, ['username', 'subordinate_username']) || ''),
      fullname: String(
        firstDefined(item, ['fullname', 'subordinate_fullname']) ||
          `${firstDefined(item, ['firstname', 'subordinate_firstname']) || ''} ${firstDefined(item, ['lastname', 'subordinate_lastname']) || ''}`.trim()
      ),
      email: normalize(firstDefined(item, ['email', 'subordinate_email']) || '')
    }))
    .filter(x => x.user_id);
}

async function getPendingUsers(token) {
  const data = await doceboGet(
    token,
    `${DOCEBO_BASE_URL}/learn/v1/enrollment/pending_users`,
    { page: 1, page_size: 200 }
  );

  return data?.data?.items || data?.items || [];
}

function normalizePendingRow(row) {
  const courseId = String(firstDefined(row, ['course_id', 'id_course', 'id']) || '');
  const sessionId = String(firstDefined(row, ['session_id']) || '');
  const courseSlug = String(firstDefined(row, ['course_slug', 'slug']) || '');

  return {
    user_id: String(firstDefined(row, ['user_id']) || ''),
    username: normalize(firstDefined(row, ['username']) || ''),
    fullname: String(firstDefined(row, ['fullname']) || ''),
    email: normalize(firstDefined(row, ['email']) || ''),
    course_id: courseId,
    course_name: String(firstDefined(row, ['course_name', 'name_course', 'course_title', 'title']) || 'Unknown course'),
    course_url: buildCourseUrl(courseId, courseSlug),
    session_id: sessionId,
    session_name: String(firstDefined(row, ['session_name', 'name_session']) || '-'),
    session_start: String(firstDefined(row, ['session_start', 'date_start', 'start_date', 'start_at']) || '-'),
    session_end: String(firstDefined(row, ['session_end', 'date_end', 'end_date', 'end_at']) || '-'),
    enrollment_status: normalizeStatus(firstDefined(row, ['enrollment_status', 'status', 'state']))
  };
}

async function fetchDashboard(token, currentUser) {
  const excludedCourseIds = parseCsv(process.env.EXCLUDED_COURSE_IDS);
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

async function bootstrapSessionFromUserId(req, userId) {
  const token = await loginToDocebo();
  const user = await getUserById(token, userId);

  if (!user?.user_id) {
    throw new Error('User not found');
  }

  req.session.user = user;
  req.session.user_id = user.user_id;
  req.session.username = user.username || '';
  req.session.doceboToken = token;

  await saveSession(req);
  return { token, user };
}

app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/launch', async (req, res) => {
  try {
    const userId = String(req.query.user_id || req.query.userId || '').trim();

    if (!userId) {
      return res.status(400).json({ success: false, error: 'Missing user_id' });
    }

    await bootstrapSessionFromUserId(req, userId);
    return res.redirect(`/?user_id=${encodeURIComponent(userId)}`);
  } catch (error) {
    console.error('launch error:', error.response?.data || error.message);
    return res.status(500).json({ success: false, error: 'Failed to launch session' });
  }
});

app.get('/api/auth/bootstrap', async (req, res) => {
  try {
    const userId = String(req.query.user_id || req.query.userId || '').trim();

    if (!userId) {
      return res.status(400).json({ success: false, error: 'Missing user_id' });
    }

    const { user } = await bootstrapSessionFromUserId(req, userId);
    return res.json({ success: true, user });
  } catch (error) {
    console.error('bootstrap error:', error.response?.data || error.message);
    return res.status(500).json({ success: false, error: 'Failed to bootstrap session' });
  }
});

app.get('/api/me', async (req, res) => {
  try {
    if (!req.session?.user) {
      return res.status(401).json({ success: false, error: 'Not authenticated' });
    }

    const token = req.session.doceboToken || await loginToDocebo();
    const currentUserId = req.session.user_id || req.session.user.user_id;

    const fresh = await getUserById(token, currentUserId);
    req.session.user = fresh;
    req.session.user_id = fresh.user_id;
    req.session.username = fresh.username || req.session.username || '';
    req.session.doceboToken = token;

    return res.json({ success: true, user: fresh });
  } catch (error) {
    console.error('me error:', error.response?.data || error.message);
    return res.status(500).json({ success: false, error: 'Failed to load current user' });
  }
});

app.get('/api/pending-items', async (req, res) => {
  try {
    if (!req.session?.user) {
      return res.status(401).json({ success: false, error: 'Not authenticated' });
    }

    const token = req.session.doceboToken || await loginToDocebo();
    const currentUserId = req.session.user_id || req.session.user.user_id;

    const currentUser = await getUserById(token, currentUserId);
    req.session.user = currentUser;
    req.session.user_id = currentUser.user_id;
    req.session.username = currentUser.username || req.session.username || '';
    req.session.doceboToken = token;

    const dashboard = await fetchDashboard(token, currentUser);
    return res.json({ success: true, ...dashboard });
  } catch (error) {
    console.error('pending-items error:', error.response?.data || error.message);
    return res.status(500).json({ success: false, error: 'Failed to load pending items' });
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

    return res.json({ success: true, message: 'Enrollment approved successfully.' });
  } catch (error) {
    console.error('approve error:', error.response?.data || error.message);
    return res.status(500).json({ success: false, error: 'Failed to approve enrollment' });
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

    return res.json({ success: true, message: 'Enrollment declined successfully.' });
  } catch (error) {
    console.error('deny error:', error.response?.data || error.message);
    return res.status(500).json({ success: false, error: 'Failed to decline enrollment' });
  }
});

app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
