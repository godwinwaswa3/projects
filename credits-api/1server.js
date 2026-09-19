require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const auth = require('./src/middleware/auth');
const authRouter = require('./src/routes/auth');

const creditsRouter =
  require('./src/routes/credits');

const featureRoutes =
  require('./src/routes/feature-api-routes');


const app =
  express();


/*
 * --------------------------------------------------
 * SECURITY / BASIC MIDDLEWARE
 * --------------------------------------------------
 */

app.use(
  helmet()
);


app.use(
  cors({
    origin: true,
    exposedHeaders: [
      'X-Player-Id'
    ]
  })
);


app.use(
  express.json({
    limit: '10kb'
  })
);


/*
 * --------------------------------------------------
 * AUTHENTICATION API
 * --------------------------------------------------
 *
 * POST /api/auth/signup
 * POST /api/auth/signin
 * GET  /api/auth/me
 * POST /api/auth/signout
 *
 * Authentication routes do not use the
 * credits authentication middleware because
 * signin/signup must be accessible before
 * a session exists.
 */

app.use(
  '/api/auth',
  authRouter
);


/*
 * --------------------------------------------------
 * PEANUT CREDITS API
 * --------------------------------------------------
 *
 * These routes require authentication.
 */

app.use(
  '/api/credits',
  auth,
  creditsRouter
);


/*
 * --------------------------------------------------
 * FEATURE API
 * --------------------------------------------------
 */

app.use(
  '/api/features',
  featureRoutes
);


/*
 * --------------------------------------------------
 * HEALTH CHECK
 * --------------------------------------------------
 */

app.get(
  '/health',
  (req, res) => {

    res.json({
      status: 'ok'
    });

  }
);


/*
 * --------------------------------------------------
 * START SERVER
 * --------------------------------------------------
 */

const PORT =
  Number(
    process.env.PORT || 3000
  );


app.listen(
  PORT,
  '127.0.0.1',
  () => {

    console.log(
      `DrissNow backend running on ` +
      `http://127.0.0.1:${PORT}`
    );

    console.log(
      `Authentication API: ` +
      `http://127.0.0.1:${PORT}/api/auth`
    );

    console.log(
      `Credits API: ` +
      `http://127.0.0.1:${PORT}/api/credits`
    );

    console.log(
      `Feature API: ` +
      `http://127.0.0.1:${PORT}/api/features`
    );

  }
);