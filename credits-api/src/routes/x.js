const express = require('express');
const pool = require('../db');

const router = express.Router();

function getPlayerId(req) {
  return req.playerId || req.get('X-Player-Id');
}

function requirePlayerId(req, res) {
  const playerId = getPlayerId(req);
  if (!playerId) {
    res.status(400).json({ success: false, message: 'X-Player-Id is required' });
    return null;
  }
  return playerId;
}

// ---------- Player stats ----------
router.get('/stats', async (req, res) => {
  try {
    const playerId = requirePlayerId(req, res);
    if (!playerId) return;
    const [rows] = await pool.execute(
      'SELECT * FROM player_stats WHERE player_id = ?', [playerId]
    );
    res.json({ success: true, stats: rows[0] || null });
  } catch (err) {
    console.error('Feature stats GET error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/stats', async (req, res) => {
  try {
    const playerId = requirePlayerId(req, res);
    if (!playerId) return;
    const s = req.body || {};
    await pool.execute(
      `INSERT INTO player_stats
        (player_id, level, xp, high_score, games_played, games_won, best_combo)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
        level = VALUES(level), xp = VALUES(xp),
        high_score = GREATEST(high_score, VALUES(high_score)),
        games_played = VALUES(games_played), games_won = VALUES(games_won),
        best_combo = GREATEST(best_combo, VALUES(best_combo))`,
      [playerId, Number(s.level) || 1, Number(s.xp) || 0,
       Number(s.highScore) || 0, Number(s.games) || 0,
       Number(s.wins) || 0, Number(s.comboBest) || 0]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Feature stats POST error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ---------- Database-configured Peanut Unit compound economy ----------
async function getEconomyConfig() {
  const [rows] = await pool.execute(
    `SELECT initial_balance, interest_rate, compound_seconds,
            plot_interval_seconds, duration_seconds
       FROM economy_config
      WHERE id = 1`
  );
  if (!rows.length) {
    throw new Error('Economy configuration is missing. Run the migration SQL.');
  }
  return rows[0];
}

function publicConfig(config) {
  return {
    initialBalance: Number(config.initial_balance),
    interestRate: Number(config.interest_rate),
    compoundSeconds: Number(config.compound_seconds),
    plotIntervalSeconds: Number(config.plot_interval_seconds),
    durationSeconds: Number(config.duration_seconds)
  };
}

// Continuous-compounding model from the supplied reference material.
// We calibrate the continuous rate so a configured period gives exactly
// (1 + interestRate). Thus 15% per 60 seconds means A(60) = P * 1.15.
function calculateAmount(config, elapsedSeconds) {
  const initial = Number(config.initial_balance);
  const rate = Number(config.interest_rate);
  const period = Number(config.compound_seconds);
  const elapsed = Math.max(0, Number(elapsedSeconds) || 0);

  if (period <= 0) return initial;

  const continuousRate = Math.log(1 + rate) / period;
  return initial * Math.exp(continuousRate * elapsed);
}

async function getSession(sessionId, playerId) {
  const [rows] = await pool.execute(
    `SELECT id, player_id, started_at,
            UNIX_TIMESTAMP(started_at) * 1000 + MICROSECOND(started_at) / 1000 AS started_at_ms,
            status, base_balance, interest_rate, compound_seconds,
            plot_interval_seconds, duration_seconds, final_balance
       FROM economy_sessions
      WHERE id = ? AND player_id = ?
      LIMIT 1`,
    [sessionId, playerId]
  );
  return rows[0] || null;
}

function sessionConfig(session) {
  return {
    initial_balance: session.base_balance,
    interest_rate: session.interest_rate,
    compound_seconds: session.compound_seconds,
    plot_interval_seconds: session.plot_interval_seconds,
    duration_seconds: session.duration_seconds
  };
}

async function serverElapsed(session) {
  const [rows] = await pool.execute(
    `SELECT GREATEST(0,
              TIMESTAMPDIFF(MICROSECOND, started_at, NOW(6)) / 1000000.0
            ) AS elapsed_seconds
       FROM economy_sessions
      WHERE id = ?`,
    [session.id]
  );
  const raw = rows[0] ? Number(rows[0].elapsed_seconds) : 0;
  return Math.min(Number(session.duration_seconds), Math.max(0, raw));
}

router.get('/economy/config', async (req, res) => {
  try {
    const config = await getEconomyConfig();
    res.json({ success: true, config: publicConfig(config) });
  } catch (err) {
    console.error('Economy config GET error:', err);
    res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
});

router.post('/economy/start', async (req, res) => {
  try {
    const playerId = requirePlayerId(req, res);
    if (!playerId) return;

    await pool.execute(
      `INSERT IGNORE INTO players (id, credits) VALUES (?, 0)`,
      [playerId]
    );

    const config = await getEconomyConfig();
    const [result] = await pool.execute(
      `INSERT INTO economy_sessions
        (player_id, started_at, base_balance, interest_rate,
         compound_seconds, plot_interval_seconds, duration_seconds, status)
       VALUES (?, NOW(6), ?, ?, ?, ?, ?, 'active')`,
      [
        playerId,
        Number(config.initial_balance),
        Number(config.interest_rate),
        Number(config.compound_seconds),
        Number(config.plot_interval_seconds),
        Number(config.duration_seconds)
      ]
    );

    const session = await getSession(result.insertId, playerId);
    const [clock] = await pool.execute(`SELECT UNIX_TIMESTAMP(NOW(6)) * 1000 AS now_ms`);

    res.json({
      success: true,
      session: {
        id: session.id,
        startedAtMs: Number(session.started_at_ms),
        baseBalance: Number(session.base_balance)
      },
      serverNowMs: Number(clock[0].now_ms),
      config: publicConfig(config)
    });
  } catch (err) {
    console.error('Economy start error:', err);
    res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
});

router.post('/economy/resume', async (req, res) => {
  try {
    const playerId = requirePlayerId(req, res);
    if (!playerId) return;

    const sessionId = Number(req.body && req.body.sessionId);
    if (!sessionId) {
      return res.status(400).json({ success: false, message: 'sessionId is required' });
    }

    const session = await getSession(sessionId, playerId);
    if (!session) {
      return res.status(404).json({ success: false, message: 'Economy session not found' });
    }
    if (session.status !== 'active') {
      return res.status(409).json({ success: false, message: 'Economy session is already settled' });
    }

    const [clock] = await pool.execute(`SELECT UNIX_TIMESTAMP(NOW(6)) * 1000 AS now_ms`);
    res.json({
      success: true,
      session: {
        id: session.id,
        startedAtMs: Number(session.started_at_ms),
        baseBalance: Number(session.base_balance)
      },
      serverNowMs: Number(clock[0].now_ms),
      config: publicConfig(sessionConfig(session))
    });
  } catch (err) {
    console.error('Economy resume error:', err);
    res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
});

/*
 * Save the complete chart sent by the browser.
 *
 * The request body contains JSON like:
 * {
 *   sessionId: 123,
 *   progress: [
 *     { seconds: 0, amount: 100, compoundAmount: 100, score: 0 },
 *     { seconds: 5, amount: 100.2, compoundAmount: 100.1, score: 0.1 }
 *   ]
 * }
 *
 * The existing economy_snapshots table remains the persistent store.
 * The API replaces the session's previous snapshot set with the newest
 * complete chart state, so a refresh can reconstruct exactly what was saved.
 */
router.post('/economy/progress', async (req, res) => {
  let connection;

  try {
    const playerId = requirePlayerId(req, res);
    if (!playerId) return;

    const sessionId = Number(req.body && req.body.sessionId);
    if (!sessionId) {
      return res.status(400).json({ success: false, message: 'sessionId is required' });
    }

    const progress = req.body && req.body.progress;
    if (!Array.isArray(progress)) {
      return res.status(400).json({ success: false, message: 'progress must be an array' });
    }

    const session = await getSession(sessionId, playerId);
    if (!session) {
      return res.status(404).json({ success: false, message: 'Economy session not found' });
    }
    if (session.status !== 'active') {
      return res.status(409).json({ success: false, message: 'Economy session is already settled' });
    }

    connection = await pool.getConnection();
    await connection.beginTransaction();

    await connection.execute(
      `DELETE FROM economy_snapshots WHERE session_id = ?`,
      [sessionId]
    );

    for (const point of progress) {
      const seconds = Number(point && point.seconds);
      const amount = Number(point && point.amount);

      if (!Number.isFinite(seconds) || !Number.isFinite(amount)) {
        continue;
      }

      await connection.execute(
        `INSERT INTO economy_snapshots
          (session_id, elapsed_seconds, amount)
         VALUES (?, ?, ?)`,
        [sessionId, seconds, amount]
      );
    }

    await connection.commit();

    res.json({
      success: true,
      sessionId,
      savedPoints: progress.length
    });
  } catch (err) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error('Economy progress rollback error:', rollbackError);
      }
    }

    console.error('Economy progress POST error:', err);
    res.status(500).json({ success: false, message: err.message || 'Server error' });
  } finally {
    if (connection) connection.release();
  }
});

/*
 * Load the complete persisted chart for a session.
 */
router.post('/economy/snapshots', async (req, res) => {
  try {
    const playerId = requirePlayerId(req, res);
    if (!playerId) return;

    const sessionId = Number(req.body && req.body.sessionId);
    if (!sessionId) {
      return res.status(400).json({ success: false, message: 'sessionId is required' });
    }

    const session = await getSession(sessionId, playerId);
    if (!session) {
      return res.status(404).json({ success: false, message: 'Economy session not found' });
    }

    const [rows] = await pool.execute(
      `SELECT elapsed_seconds, amount
         FROM economy_snapshots
        WHERE session_id = ?
        ORDER BY elapsed_seconds ASC`,
      [sessionId]
    );

    res.json({
      success: true,
      sessionId,
      snapshots: rows.map((row) => ({
        elapsed_seconds: Number(row.elapsed_seconds),
        amount: Number(row.amount)
      }))
    });
  } catch (err) {
    console.error('Economy snapshots error:', err);
    res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
});

router.post('/economy/snapshot', async (req, res) => {
  try {
    const playerId = requirePlayerId(req, res);
    if (!playerId) return;

    const sessionId = Number(req.body && req.body.sessionId);
    if (!sessionId) {
      return res.status(400).json({ success: false, message: 'sessionId is required' });
    }

    const session = await getSession(sessionId, playerId);
    if (!session) {
      return res.status(404).json({ success: false, message: 'Economy session not found' });
    }
    if (session.status !== 'active') {
      return res.status(409).json({ success: false, message: 'Economy session is already settled' });
    }

    const elapsed = await serverElapsed(session);
    const interval = Math.max(1, Number(session.plot_interval_seconds));
    const slot = Math.min(
      Number(session.duration_seconds),
      Math.floor(elapsed / interval) * interval
    );
    const amount = calculateAmount(sessionConfig(session), slot);

    await pool.execute(
      `INSERT INTO economy_snapshots (session_id, elapsed_seconds, amount)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE amount = VALUES(amount)`,
      [sessionId, slot, amount]
    );

    const [clock] = await pool.execute(`SELECT UNIX_TIMESTAMP(NOW(6)) * 1000 AS now_ms`);
    res.json({
      success: true,
      serverNowMs: Number(clock[0].now_ms),
      snapshot: { elapsedSeconds: slot, amount }
    });
  } catch (err) {
    console.error('Economy snapshot error:', err);
    res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
});

router.post('/economy/settle', async (req, res) => {
  try {
    const playerId = requirePlayerId(req, res);
    if (!playerId) return;

    const sessionId = Number(req.body && req.body.sessionId);
    if (!sessionId) {
      return res.status(400).json({ success: false, message: 'sessionId is required' });
    }

    const session = await getSession(sessionId, playerId);
    if (!session) {
      return res.status(404).json({ success: false, message: 'Economy session not found' });
    }

    if (session.status === 'settled') {
      return res.json({
        success: true,
        finalAmount: Number(session.final_balance),
        elapsedSeconds: Number(session.duration_seconds),
        plotElapsedSeconds: Number(session.duration_seconds)
      });
    }

    const elapsed = await serverElapsed(session);
    const amount = calculateAmount(sessionConfig(session), elapsed);

    await pool.execute(
      `UPDATE economy_sessions
          SET final_balance = ?, ended_at = NOW(6), status = 'settled'
        WHERE id = ? AND player_id = ? AND status = 'active'`,
      [amount, sessionId, playerId]
    );

    const [clock] = await pool.execute(`SELECT UNIX_TIMESTAMP(NOW(6)) * 1000 AS now_ms`);
    const interval = Math.max(1, Number(session.plot_interval_seconds));
    const plotElapsed = Math.min(
      Number(session.duration_seconds),
      Math.floor(elapsed / interval) * interval
    );

    res.json({
      success: true,
      serverNowMs: Number(clock[0].now_ms),
      finalAmount: amount,
      elapsedSeconds: elapsed,
      plotElapsedSeconds: plotElapsed
    });
  } catch (err) {
    console.error('Economy settle error:', err);
    res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
});

// ---------- Leaderboard ----------
router.get('/leaderboard', async (req, res) => {
  try {
    const season = req.query.season || 'current';
    const [rows] = await pool.execute(
      `SELECT player_id, MAX(score) AS score FROM leaderboard_scores
       WHERE season_key = ? GROUP BY player_id ORDER BY score DESC LIMIT 100`, [season]
    );
    res.json({ success: true, leaderboard: rows });
  } catch (err) {
    console.error('Leaderboard GET error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/leaderboard', async (req, res) => {
  try {
    const playerId = requirePlayerId(req, res);
    if (!playerId) return;
    const season = req.body.season || 'current';
    const score = Math.max(0, Number(req.body.score) || 0);
    await pool.execute(
      `INSERT INTO leaderboard_scores (player_id, season_key, score) VALUES (?, ?, ?)`,
      [playerId, season, score]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Leaderboard POST error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ---------- Friends ----------
router.get('/friends', async (req, res) => {
  try {
    const playerId = requirePlayerId(req, res);
    if (!playerId) return;
    const [rows] = await pool.execute('SELECT friend_id FROM friends WHERE player_id = ?', [playerId]);
    res.json({ success: true, friends: rows });
  } catch (err) {
    console.error('Friends GET error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/friends', async (req, res) => {
  try {
    const playerId = requirePlayerId(req, res);
    if (!playerId) return;
    const friendId = req.body && req.body.friendId;
    if (!friendId) return res.status(400).json({ success: false, message: 'friendId is required' });
    if (friendId === playerId) return res.status(400).json({ success: false, message: 'You cannot add yourself' });
    await pool.execute(`INSERT IGNORE INTO friends (player_id, friend_id) VALUES (?, ?)`, [playerId, friendId]);
    res.json({ success: true });
  } catch (err) {
    console.error('Friends POST error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
