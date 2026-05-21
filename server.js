require('dotenv').config();

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const session = require('express-session');
const path = require('path');

const app = express();

const PORT = process.env.PORT || 3000;

const DOCEBO_BASE_URL = process.env.DOCEBO_BASE_URL.replace(/\/$/, '');

app.set('trust proxy', 1);

app.use((req, res, next) => {

  res.setHeader(
    'Content-Security-Policy',
    "frame-ancestors 'self' https://*.docebosaas.com"
  );

  next();
});

app.use(cors({
  origin: true,
  credentials: true
}));

app.use(express.json());

app.use(session({

  name: 'qialearn.sid',

  secret: process.env.SESSION_SECRET,

  resave: false,

  saveUninitialized: false,

  proxy: true,

  rolling: true,

  cookie: {

    httpOnly: true,

    secure: true,

    sameSite: 'none',

    maxAge: 1000 * 60 * 60 * 8
  }
}));

function normalize(v) {

  return String(v || '')
    .trim()
    .toLowerCase();
}

async function loginToDocebo() {

  const params = new URLSearchParams();

  params.append('grant_type', 'password');
  params.append('client_id', process.env.DOCEBO_CLIENT_ID);
  params.append('client_secret', process.env.DOCEBO_CLIENT_SECRET);
  params.append('username', process.env.DOCEBO_USERNAME);
  params.append('password', process.env.DOCEBO_PASSWORD);

  const response = await axios.post(
    `${DOCEBO_BASE_URL}/oauth2/token`,
    params,
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    }
  );

  return response.data.access_token;
}

async function doceboGet(token, url, params = {}) {

  const response = await axios.get(url, {

    headers: {
      Authorization: `Bearer ${token}`
    },

    params
  });

  return response.data;
}

function mapUser(user = {}) {

  return {

    user_id: String(
      user.user_id
      || user.id
      || ''
    ),

    username: normalize(
      user.username || ''
    ),

    firstname:
      user.firstname
      || user.first_name
      || '',

    lastname:
      user.lastname
      || user.last_name
      || '',

    email: normalize(
      user.email || ''
    )
  };
}

async function getUserById(token, userId) {

  console.log('====================================');
  console.log('SEARCH USER ID:', userId);
  console.log('====================================');

  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {

    console.log(`CHECKING PAGE ${page}/${totalPages}`);

    const response = await doceboGet(
      token,
      `${DOCEBO_BASE_URL}/manage/v1/user`,
      {
        page,
        page_size: 200
      }
    );

    console.log(
      'RAW RESPONSE PAGE:',
      page,
      JSON.stringify(response).substring(0, 1000)
    );

    const data =
      response?.data
      || response;

    const users =
      data?.items
      || data?.users
      || response?.users
      || [];

    totalPages = Number(
      data?.total_page_count
      || data?.pagination?.total_page_count
      || 1
    );

    console.log(
      `USERS FOUND ON PAGE ${page}:`,
      users.length
    );

    const found = users.find(u => {

      const currentId = String(
        u.user_id
        || u.id
        || ''
      );

      return currentId === String(userId);
    });

    if (found) {

      console.log('====================================');
      console.log('USER FOUND');
      console.log(JSON.stringify(found));
      console.log('====================================');

      return mapUser(found);
    }

    page++;
  }

  console.log('====================================');
  console.log('USER NOT FOUND');
  console.log('====================================');

  return null;
}

async function getUserByUsername(token, username) {

  console.log('SEARCH USERNAME:', username);

  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {

    console.log(`USERNAME PAGE ${page}/${totalPages}`);

    const response = await doceboGet(
      token,
      `${DOCEBO_BASE_URL}/manage/v1/user`,
      {
        page,
        page_size: 200
      }
    );

    const data =
      response?.data
      || response;

    const users =
      data?.items
      || data?.users
      || [];

    totalPages = Number(
      data?.total_page_count
      || data?.pagination?.total_page_count
      || 1
    );

    const found = users.find(
      u =>
        normalize(u.username)
        === normalize(username)
    );

    if (found) {

      console.log('USERNAME FOUND');

      return mapUser(found);
    }

    page++;
  }

  return null;
}

async function getSubordinates(token, managerId) {

  console.log('GET SUBORDINATES FOR:', managerId);

  const response = await doceboGet(
    token,
    `${DOCEBO_BASE_URL}/manage/v1/managers/${managerId}/subordinates`
  );

  const data =
    response?.data
    || response;

  const items =
    data?.items
    || [];

  return items.map(item => ({

    user_id: String(item.user_id || ''),

    username: normalize(item.username || ''),

    fullname:
      item.fullname
      || `${item.firstname || ''} ${item.lastname || ''}`.trim(),

    email: normalize(item.email || '')
  }));
}

async function getPendingUsers(token) {

  const response = await doceboGet(
    token,
    `${DOCEBO_BASE_URL}/learn/v1/enrollment/pending_users`,
    {
      page: 1,
      page_size: 200
    }
  );

  const data =
    response?.data
    || response;

  return (
    data?.items
    || []
  );
}

function buildCourseUrl(courseId, slug) {

  if (slug) {
    return `${DOCEBO_BASE_URL}/course/${slug}`;
  }

  return `${DOCEBO_BASE_URL}/course/view/${courseId}`;
}

async function loadDashboard(token, manager) {

  const subordinates = await getSubordinates(
    token,
    manager.user_id
  );

  const subordinateIds = new Set(
    subordinates.map(x => String(x.user_id))
  );

  const pending = await getPendingUsers(token);

  const items = pending

    .filter(item =>
      subordinateIds.has(
        String(item.user_id)
      )
    )

    .map(item => ({

      user_id: String(item.user_id || ''),

      fullname: item.fullname || '',

      email: item.email || '',

      course_id: String(item.course_id || ''),

      course_name: item.course_name || '',

      session_id: String(item.session_id || ''),

      session_name: item.session_name || '-',

      session_start: item.session_start || '-',

      session_end: item.session_end || '-',

      enrollment_status: item.enrollment_status || '',

      course_url: buildCourseUrl(
        item.course_id,
        item.course_slug
      )
    }));

  return {

    manager,

    subordinates_count: subordinates.length,

    items
  };
}

async function approveEnrollment(
  token,
  courseId,
  userId,
  sessionId
) {

  const url =
    `${DOCEBO_BASE_URL}/learn/v1/enrollments/${courseId}/${userId}`;

  const body = {
    status: 0
  };

  if (sessionId) {
    body.session_id = Number(sessionId);
  }

  await axios.put(url, body, {

    headers: {

      Authorization: `Bearer ${token}`,

      'Content-Type': 'application/json'
    }
  });
}

async function denyEnrollment(
  token,
  courseId,
  userId,
  sessionId
) {

  let url =
    `${DOCEBO_BASE_URL}/learn/v1/enrollments/${courseId}/${userId}`;

  if (sessionId) {
    url += `?session_id=${sessionId}`;
  }

  await axios.delete(url, {

    headers: {
      Authorization: `Bearer ${token}`
    }
  });
}

app.get('/health', (req, res) => {

  res.json({
    ok: true
  });
});

app.get('/debug/launch', (req, res) => {

  res.json({

    query: req.query,

    cookies: req.headers.cookie || null,

    session: req.session || null
  });
});

app.get('/debug/users', async (req, res) => {

  try {

    const token = await loginToDocebo();

    const response = await doceboGet(
      token,
      `${DOCEBO_BASE_URL}/manage/v1/user`,
      {
        page: Number(req.query.page || 1),
        page_size: 200
      }
    );

    return res.json(response);

  }
  catch (error) {

    return res.status(500).json({

      success: false,

      error: error.message,

      details: error.response?.data || null
    });
  }
});

https://approval-page.onrender.com/launch?user_id=43600
app.get('/api/pending-items', async (req, res) => {

  try {

    if (!req.session.user) {

      return res.status(401).json({

        success: false,

        error: 'Not authenticated'
      });
    }

    const dashboard = await loadDashboard(
      req.session.doceboToken,
      req.session.user
    );

    res.json({

      success: true,

      ...dashboard
    });

  }
  catch (error) {

    console.error(
      error.response?.data || error.message
    );

    res.status(500).json({

      success: false,

      error: 'Failed loading dashboard'
    });
  }
});

app.post('/api/approve', async (req, res) => {

  try {

    const {
      courseId,
      sessionId,
      userId
    } = req.body;

    await approveEnrollment(
      req.session.doceboToken,
      courseId,
      userId,
      sessionId
    );

    res.json({

      success: true,

      message: 'Enrollment approved successfully.'
    });

  }
  catch (error) {

    console.error(
      error.response?.data || error.message
    );

    res.status(500).json({

      success: false,

      error: 'Approval failed'
    });
  }
});

app.post('/api/deny', async (req, res) => {

  try {

    const {
      courseId,
      sessionId,
      userId
    } = req.body;

    await denyEnrollment(
      req.session.doceboToken,
      courseId,
      userId,
      sessionId
    );

    res.json({

      success: true,

      message: 'Enrollment declined successfully.'
    });

  }
  catch (error) {

    console.error(
      error.response?.data || error.message
    );

    res.status(500).json({

      success: false,

      error: 'Decline failed'
    });
  }
});

app.use(express.static(__dirname));

app.get('/', (req, res) => {

  res.sendFile(
    path.join(__dirname, 'index.html')
  );
});

app.listen(PORT, () => {

  console.log(
    `Server running on port ${PORT}`
  );
});
