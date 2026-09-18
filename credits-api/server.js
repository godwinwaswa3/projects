require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const auth = require('./src/middleware/auth');
const creditsRouter = require('./src/routes/credits');
const featureRoutes = require('./src/routes/feature-api-routes');

const app = express();

app.use(helmet());
app.use(cors({
  origin: true,               // tighten this in production
  exposedHeaders: ['X-Player-Id']
}));
app.use(express.json({ limit: '10kb' }));

app.use('/api/credits', auth, creditsRouter);

app.use('/api/features', featureRoutes);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Credits API running on port ${PORT}`);
});