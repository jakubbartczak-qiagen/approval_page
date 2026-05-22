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

const DOCEBO_BASE_URL = process.env.DOCEBO_BASE_URL.replace(/\/$/, '');

// ─────────────────────────────────────────────────────────────
// SQLITE SESSION STORE
// ─────────────────────────────────────────────────────────────

const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: './sessions.db',
  logging: false
});

const sessionStore = new SequelizeStore({
  db: sequelize
});

sessionStore.sync();

// ─────────────────────────────────────────────────────────────
// TRUST PROXY
// ─────────────────────────────────────────────────────────────

app.set('trust proxy', 1);

// ─────────────────────────────────────────────────────────────
// SECURITY HEADERS
// ─────────────────────────────────────────────────────────────

app.use((req, res, next) => {

  res.setHeader(
    'Content-Security-Policy',
    "frame-ancestors 'self' https://*.docebosaas.com"
  );

  next();
});

// ─────────────────────────────────────────────────────────────
// CORS
// ─────────────────────────────────────────────────────────────

app.use(cors({
  origin: true,
  credentials: true
}));

// ─────────────────────────────────────────────────────────────
// BODY PARSER
// ─────────────────────────────────────────────────────────────

app.use(express.json());

// ─────────────────────────────────────────────────────────────
// SESSION
// ─────────────────────────────────────────────────────────────

app.use(session({

  name: 'qialearn.sid',

  secret: process.env.SESSION_SECRET,

  store: sessionStore,

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

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function normalize(v) {

  return String(v || '')
    .trim()
    .toLowerCase();
}

function mapUser(user = {}) {

  return {

    user_id:
      String(user.user_id || user.id || ''),

    username:
      normalize(user.username || ''),

    firstname:
      user.firstname || user.first_name || '',

    lastname:
      user.lastname || user.last_name || '',

    email:
      normalize(user.email || '')
  };
}

// ─────────────────────────────────────────────────────────────
// DOCEBO LOGIN
// ─────────────────────────────────────────────────────────────

async function loginToDocebo() {

  const params = new URLSearchParams();

  params.append(
    'grant_type',
    'password'
  );

  params.append(
    'client_id',
    process.env.DOCEBO_CLIENT_ID
  );

  params.append(
    'client_secret',
    process.env.DOCEBO_CLIENT_SECRET
  );

  params.append(
    'username',
    process.env.DOCEBO_USERNAME
  );

  params.append(
    'password',
    process.env.DOCEBO_PASSWORD
  );

  const response = await axios.post(

    `${DOCEBO_BASE_URL}/oauth2/token`,

    params,

    {
      headers: {
        'Content-Type':
          'application/x-www-form-urlencoded'
      }
    }
  );

  return response.data.access_token;
}

// ─────────────────────────────────────────────────────────────
// GENERIC GET
// ─────────────────────────────────────────────────────────────

async function doceboGet(token, url, params = {}) {

  const response = await axios.get(url, {

    headers: {
      Authorization: `Bearer ${token}`
    },

    params
  });

  return response.data;
}

// ─────────────────────────────────────────────────────────────
// FIND USER BY ID
// ─────────────────────────────────────────────────────────────

async function getUserById(token, userId) {

  let page = 1;

  while (page <= 500) {

    console.log(`SEARCH PAGE ${page}`);

    const response = await doceboGet(

      token,

      `${DOCEBO_BASE_URL}/manage/v1/user`,

      {
        page,
        page_size: 50
      }
    );

    const users =
      response?.data?.items ||
      response?.data?.users ||
      response?.users ||
      [];

    const found = users.find(u =>
      String(u.user_id || u.id || '') === String(userId)
    );

    if (found) {

      console.log('FOUND USER:', found.username);

      return mapUser(found);
    }

    const totalPages =
      Number(response?.data?.total_page_count || 0);

    if (totalPages && page >= totalPages) {
      break;
    }

    page++;
  }

  return {};
}

// ─────────────────────────────────────────────────────────────
// FIND USER BY USERNAME
// ─────────────────────────────────────────────────────────────

async function getUserByUsername(token, username) {

  const response = await doceboGet(

    token,

    `${DOCEBO_BASE_URL}/manage/v1/user`,

    {
      page: 1,
      page_size: 50,
      search_text: username
    }
  );

  const users =
    response?.data?.items ||
    response?.data?.users ||
    response?.users ||
    [];

  const exact = users.find(
    u => normalize(u.username) === normalize(username)
  );

  return mapUser(exact || users[0] || {});
}

// ─────────────────────────────────────────────────────────────
// SUBORDINATES
// ─────────────────────────────────────────────────────────────

async function getSubordinates(token, managerId) {

  const response = await doceboGet(

    token,

    `${DOCEBO_BASE_URL}/manage/v1/managers/${managerId}/subordinates`
  );

  const items =
    response?.data?.items ||
    response?.items ||
    [];

  return items.map(item => ({

    user_id:
      String(item.user_id || ''),

    username:
      normalize(item.username || ''),

    fullname:
      item.fullname ||
      `${item.firstname || ''} ${item.lastname || ''}`.trim(),

    email:
      normalize(item.email || '')
  }));
}

// ─────────────────────────────────────────────────────────────
// PENDING USERS
// ─────────────────────────────────────────────────────────────

async function getPendingUsers(token) {

  const response = await doceboGet(

    token,

    `${DOCEBO_BASE_URL}/learn/v1/enrollment/pending_users`,

    {
      page: 1,
      page_size: 200
    }
  );

  return response?.data?.items ||
         response?.items ||
         [];
}

// ─────────────────────────────────────────────────────────────
// COURSE URL
// ─────────────────────────────────────────────────────────────

function buildCourseUrl(courseId, slug) {

  if (slug) {
    return `${DOCEBO_BASE_URL}/course/${slug}`;
  }

  return `${DOCEBO_BASE_URL}/course/view/${courseId}`;
}

// ─────────────────────────────────────────────────────────────
// DASHBOARD
// ─────────────────────────────────────────────────────────────

async function loadDashboard(token, manager) {

  const subordinates =
    await getSubordinates(token, manager.user_id);

  const subordinateIds =
    new Set(subordinates.map(x => String(x.user_id)));

  const pending =
    await getPendingUsers(token);

  const items = pending

    .filter(item =>
      subordinateIds.has(String(item.user_id))
    )

    .map(item => ({

      user_id:
        String(item.user_id || ''),

      fullname:
        item.fullname || '',

      email:
        item.email || '',

      course_id:
        String(item.course_id || ''),

      course_name:
        item.course_name || '',

      session_id:
        String(item.session_id || ''),

      session_name:
        item.session_name || '-',

      session_start:
        item.session_start || '-',

      session_end:
        item.session_end || '-',

      enrollment_status:
        item.enrollment_status || '',

      course_url:
        buildCourseUrl(
          item.course_id,
          item.course_slug
        )
    }));

  return {

    manager,

    subordinates_count:
      subordinates.length,

    items
  };
}

// ─────────────────────────────────────────────────────────────
// APPROVE
// ─────────────────────────────────────────────────────────────

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

      Authorization:
        `Bearer ${token}`,

      'Content-Type':
        'application/json'
    }
  });
}

// ─────────────────────────────────────────────────────────────
// DENY
// ─────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {

  res.json({
    ok: true
  });
});

// ─────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────

app.post('/api/init', async (req, res) => {

  try {

    console.log('================ INIT START ================');

    const userId =
      String(req.body.user_id || '').trim();

    const username =
      normalize(req.body.username || '');

    console.log('USER ID:', userId);
    console.log('USERNAME:', username);

    // NAJWAŻNIEJSZY CHECK

   if (!userId || userId.includes('[') || userId.includes('{')) {
  return res.status(400).json({
    success: false,
    error: 'Docebo did not replace user_id placeholder',
    received_user_id: userId
  });
}

const authCode  = String(req.body.auth_code || '').trim();
const saltSecret = process.env.IFRAME_SALT_SECRET || '';

if (saltSecret && !authCode) {
  console.warn('WARNING: salt secret configured but no auth_code received');
}

console.log('AUTH CODE:', authCode ? 'present' : 'missing');

    // LOGIN

    const token =
      await loginToDocebo();

    console.log('TOKEN OK');

    // USER BY ID

    let user =
      await getUserById(token, userId);

    // FALLBACK USERNAME

    if (!user.user_id && username) {

      console.log(
        'USER NOT FOUND BY ID -> TRY USERNAME'
      );

      user =
        await getUserByUsername(token, username);
    }

    if (!user.user_id) {

      return res.status(404).json({

        success: false,

        error:
          'User not found in Docebo'
      });
    }

    console.log('USER OK:', user);

    // SAVE SESSION

    req.session.user =
      user;

    req.session.user_id =
      user.user_id;

    req.session.doceboToken =
      token;

    await new Promise((resolve, reject) => {

      req.session.save(err => {

        if (err) reject(err);
        else resolve();
      });
    });

    console.log('SESSION SAVED');

    return res.json({

      success: true,

      user
    });

  } catch (error) {

    console.error(
      'INIT ERROR:',
      error.response?.data || error.message
    );

    return res.status(500).json({

      success: false,

      error:
        error.message,

      details:
        error.response?.data || null
    });
  }
});

// ─────────────────────────────────────────────────────────────
// ME
// ─────────────────────────────────────────────────────────────

app.get('/api/me', async (req, res) => {

  try {

    if (!req.session.user) {

      return res.status(401).json({

        success: false,

        error: 'Not authenticated'
      });
    }

    return res.json({

      success: true,

      user: req.session.user
    });

  } catch (error) {

    return res.status(500).json({

      success: false,

      error: 'Failed'
    });
  }
});

// ─────────────────────────────────────────────────────────────
// PENDING ITEMS
// ─────────────────────────────────────────────────────────────

app.get('/api/pending-items', async (req, res) => {

  try {

    if (!req.session.user) {

      return res.status(401).json({

        success: false,

        error: 'Not authenticated'
      });
    }

    const dashboard =
      await loadDashboard(
        req.session.doceboToken,
        req.session.user
      );

    return res.json({

      success: true,

      ...dashboard
    });

  } catch (error) {

    console.error(
      error.response?.data || error.message
    );

    return res.status(500).json({

      success: false,

      error:
        'Failed loading dashboard'
    });
  }
});

// ─────────────────────────────────────────────────────────────
// APPROVE
// ─────────────────────────────────────────────────────────────

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

    return res.json({

      success: true,

      message:
        'Enrollment approved successfully.'
    });

  } catch (error) {

    console.error(
      error.response?.data || error.message
    );

    return res.status(500).json({

      success: false,

      error:
        'Approval failed'
    });
  }
});

// ─────────────────────────────────────────────────────────────
// DENY
// ─────────────────────────────────────────────────────────────

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

    return res.json({

      success: true,

      message:
        'Enrollment declined successfully.'
    });

  } catch (error) {

    console.error(
      error.response?.data || error.message
    );

    return res.status(500).json({

      success: false,

      error:
        'Decline failed'
    });
  }
});

// ─────────────────────────────────────────────────────────────
// STATIC FILES
// ─────────────────────────────────────────────────────────────

app.use(express.static(__dirname));

app.get('/', (req, res) => {

  res.sendFile(
    path.join(__dirname, 'index.html')
  );
});

// ─────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────

app.listen(PORT, () => {

  console.log(
    `Server running on port ${PORT}`
  );
});
