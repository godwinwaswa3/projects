require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const authRoutes = require('./src/routes/auth');
const authMiddleware = require('./src/middleware/auth');
const creditsRouter = require('./src/routes/credits');
const featureRoutes = require('./src/routes/feature-api-routes');

const app = express();

app.use(helmet());

app.use(cors({
  origin: true,
  exposedHeaders: ['X-Player-Id']
}));

app.use(express.json({ limit: '10kb' }));

// ===============================
// AUTH API — PORT 3000
// ===============================
app.use('/api/auth', authRoutes);

// ===============================
// PROTECTED CREDITS API
// ===============================
app.use('/api/credits', authMiddleware, creditsRouter);

// ===============================
// FEATURES API
// ===============================
app.use('/api/features', featureRoutes);

// ===============================
// HEALTH
// ===============================
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'DrissNow Backend',
    port: 3000
  });
});

// ===============================
// START BACKEND
// ===============================
const PORT = 3000;

app.listen(PORT, '127.0.0.1', () => {
  console.log('======================================');
  console.log('DrissNow Backend API');
  console.log(`Listening: http://127.0.0.1:${PORT}`);
  console.log('Auth:     /api/auth');
  console.log('Credits:  /api/credits');
  console.log('Features: /api/features');
  console.log('======================================');
});