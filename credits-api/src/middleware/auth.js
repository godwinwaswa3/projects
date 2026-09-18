const { v4: uuidv4 } = require('uuid');
const pool = require('../db');

/**
 * Simple device-token auth.
 * Client must send header: X-Player-Id: <uuid>
 * If missing or unknown → create a new player.
 */
async function auth(req, res, next) {
  let playerId = req.headers['x-player-id'];

  if (!playerId || typeof playerId !== 'string' || playerId.length !== 36) {
    // Create a brand-new anonymous player
    playerId = uuidv4();
    try {
      await pool.execute(
        'INSERT INTO players (id, credits) VALUES (?, 0)',
        [playerId]
      );
    } catch (err) {
      console.error(err);
      return res.status(500).json({ success: false, message: 'Server error' });
    }
  } else {
    // Ensure player exists
    const [rows] = await pool.execute(
      'SELECT id FROM players WHERE id = ?',
      [playerId]
    );
    if (rows.length === 0) {
      await pool.execute(
        'INSERT INTO players (id, credits) VALUES (?, 0)',
        [playerId]
      );
    }
  }

  req.playerId = playerId;
  // Always return the playerId so the client can store it
  res.setHeader('X-Player-Id', playerId);
  next();
}

module.exports = auth;