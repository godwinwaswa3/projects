
const express = require('express');
const pool = require('../db');
const fs = require('fs');
const path = require('path');

const router = express.Router();

// ============================================================
// LOCAL JSON ECONOMY SESSION PERSISTENCE
// ============================================================

const ECONOMY_STATE_DIR = path.join(
  __dirname,
  '../data/economy'
);

function ensureEconomyStateDir() {
  if (!fs.existsSync(ECONOMY_STATE_DIR)) {
    fs.mkdirSync(
      ECONOMY_STATE_DIR,
      {
        recursive: true
      }
    );
  }
}

function economyStateFile(playerId) {
  /*
   * Prevent path traversal through player IDs.
   */
  const safePlayerId =
    String(playerId)
      .replace(/[^a-zA-Z0-9_-]/g, '_');

  return path.join(
    ECONOMY_STATE_DIR,
    safePlayerId + '.json'
  );
}

function writeEconomyState(playerId, state) {
  ensureEconomyStateDir();

  const file =
    economyStateFile(playerId);

  const temporaryFile =
    file + '.tmp';

  fs.writeFileSync(
    temporaryFile,
    JSON.stringify(
      state,
      null,
      2
    ),
    'utf8'
  );

  /*
   * Atomic replacement prevents a refresh from
   * seeing a half-written JSON file.
   */
  fs.renameSync(
    temporaryFile,
    file
  );
}

function readEconomyState(playerId) {
  try {
    const file =
      economyStateFile(playerId);

    if (!fs.existsSync(file)) {
      return null;
    }

    return JSON.parse(
      fs.readFileSync(
        file,
        'utf8'
      )
    );
  } catch (error) {
    console.error(
      'Economy JSON read error:',
      error
    );

    return null;
  }
}

function deleteEconomyState(playerId) {
  try {
    const file =
      economyStateFile(playerId);

    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  } catch (error) {
    console.error(
      'Economy JSON delete error:',
      error
    );
  }
}

function getPlayerId(req) {
  return req.playerId || req.get('X-Player-Id');
}

function requirePlayerId(req, res) {
  const playerId = getPlayerId(req);

  if (!playerId) {
    res.status(400).json({
      success: false,
      message: 'X-Player-Id is required'
    });

    return null;
  }

  return playerId;
}


// -------------------------------------------------
// General helpers
// -------------------------------------------------

async function ensurePlayer(playerId) {
  if (!playerId) {
    throw new Error('Player ID is required.');
  }

  await pool.execute(
    `INSERT IGNORE INTO players (id, credits)
     VALUES (?, 0)`,
    [playerId]
  );

  return playerId;
}


// -------------------------------------------------
// Economy helpers
// -------------------------------------------------

async function getEconomyConfig() {
  const [rows] = await pool.execute(
    `SELECT
       initial_balance,
       interest_rate,
       compound_seconds,
       plot_interval_seconds,
       duration_seconds
     FROM economy_config
     WHERE id = 1
     LIMIT 1`
  );

  if (!rows.length) {
    throw new Error('Economy configuration is missing.');
  }

  return rows[0];
}


function publicEconomyConfig(config) {
  return {
    initialBalance: Number(config.initial_balance),
    interestRate: Number(config.interest_rate),
    compoundSeconds: Number(config.compound_seconds),
    plotIntervalSeconds: Number(config.plot_interval_seconds),
    durationSeconds: Number(config.duration_seconds)
  };
}


function calculateEconomyAmount(
  baseBalance,
  interestRate,
  compoundSeconds,
  elapsedSeconds
) {
  const base = Number(baseBalance);
  const rate = Number(interestRate);
  const period = Number(compoundSeconds);
  const elapsed = Math.max(0, Number(elapsedSeconds));

  if (
    !Number.isFinite(base) ||
    !Number.isFinite(rate) ||
    !Number.isFinite(period) ||
    period <= 0
  ) {
    throw new Error('Invalid economy configuration.');
  }

  return base * Math.pow(
    1 + rate,
    elapsed / period
  );
}


/*
 * Retrieve one economy session belonging to the
 * requesting player.
 *
 * This helper was missing from the active route file.
 */
async function getSession(sessionId, playerId) {
  const [rows] = await pool.execute(
    `SELECT
       id,
       player_id,
       started_at,
       UNIX_TIMESTAMP(started_at) * 1000 +
         MICROSECOND(started_at) / 1000 AS started_at_ms,
       status,
       base_balance,
       interest_rate,
       compound_seconds,
       plot_interval_seconds,
       duration_seconds,
       final_balance
     FROM economy_sessions
     WHERE id = ?
       AND player_id = ?
     LIMIT 1`,
    [sessionId, playerId]
  );

  return rows[0] || null;
}


function sessionConfig(session) {
  return {
    initial_balance: Number(session.base_balance),
    interest_rate: Number(session.interest_rate),
    compound_seconds: Number(session.compound_seconds),
    plot_interval_seconds: Number(session.plot_interval_seconds),
    duration_seconds: Number(session.duration_seconds)
  };
}


function publicSessionConfig(session) {
  return {
    initialBalance: Number(session.base_balance),
    interestRate: Number(session.interest_rate),
    compoundSeconds: Number(session.compound_seconds),
    plotIntervalSeconds: Number(session.plot_interval_seconds),
    durationSeconds: Number(session.duration_seconds)
  };
}


async function getServerElapsed(session) {
  const [rows] = await pool.execute(
    `SELECT
       GREATEST(
         0,
         TIMESTAMPDIFF(
           MICROSECOND,
           started_at,
           NOW(6)
         ) / 1000000.0
       ) AS elapsed_seconds
     FROM economy_sessions
     WHERE id = ?
     LIMIT 1`,
    [session.id]
  );

  const raw = rows[0]
    ? Number(rows[0].elapsed_seconds)
    : 0;

  return Math.min(
    Number(session.duration_seconds),
    Math.max(0, raw)
  );
}


async function getEconomyCode(code) {
  if (!code) {
    return null;
  }

  const [rows] = await pool.execute(
    `SELECT
       code,
       amount,
       economy_value,
       max_uses,
       used_count,
       active
     FROM codes
     WHERE code = ?
     LIMIT 1`,
    [code]
  );

  if (!rows.length) {
    return null;
  }

  return rows[0];
}


// -------------------------------------------------
// GET /api/features/economy/config
// -------------------------------------------------

router.get('/economy/config', async (req, res) => {
  try {
    const config = await getEconomyConfig();

    res.json({
      success: true,
      config: publicEconomyConfig(config)
    });
  } catch (err) {
    console.error(
      'Economy config GET error:',
      err
    );

    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});


// -------------------------------------------------
// POST /api/features/economy/start
// -------------------------------------------------

router.post('/economy/start', async (req, res) => {
  try {
    const playerId = requirePlayerId(req, res);

    if (!playerId) {
      return;
    }

    await ensurePlayer(playerId);

    const config = await getEconomyConfig();

    const body = req.body || {};
    const code = body.code
      ? String(body.code).trim()
      : '';

    let baseBalance = Number(
      config.initial_balance
    );

    let codeValue = null;

    /*
     * If a supplied economy code exists, use its
     * economy_value to determine the starting balance.
     *
     * Example:
     *
     * economy_value 1.50 -> 15 Bob
     * economy_value 2.00 -> 20 Bob
     * economy_value 3.50 -> 35 Bob
     * economy_value 5.50 -> 55 Bob
     */
    if (code) {
      const economyCode =
        await getEconomyCode(code);

      if (
        !economyCode ||
        Number(economyCode.active) !== 1 ||
        economyCode.economy_value === null ||
        !Number.isFinite(
          Number(economyCode.economy_value)
        ) ||
        Number(economyCode.economy_value) <= 0
      ) {
        return res.status(400).json({
          success: false,
          message: 'Invalid or inactive economy code'
        });
      }

      codeValue =
        Number(economyCode.economy_value);

      baseBalance = codeValue * 10;
    }

    /*
     * Cancel any previous active session for this
     * player before starting a new one.
     */
    await pool.execute(
      `UPDATE economy_sessions
          SET status = 'cancelled',
              ended_at = NOW(6)
        WHERE player_id = ?
          AND status = 'active'`,
      [playerId]
    );

    const [result] = await pool.execute(
      `INSERT INTO economy_sessions
        (
          player_id,
          started_at,
          base_balance,
          interest_rate,
          compound_seconds,
          plot_interval_seconds,
          duration_seconds,
          status
        )
       VALUES (?, NOW(6), ?, ?, ?, ?, ?, 'active')`,
      [
        playerId,
        baseBalance,
        Number(config.interest_rate),
        Number(config.compound_seconds),
        Number(config.plot_interval_seconds),
        Number(config.duration_seconds)
      ]
    );

    const sessionId =
      Number(result.insertId);

    /*
     * Store the initial zero-second snapshot.
     */
    await pool.execute(
      `INSERT INTO economy_snapshots
        (
          session_id,
          elapsed_seconds,
          amount
        )
       VALUES (?, 0, ?)`,
      [
        sessionId,
        baseBalance
      ]
    );

    const session =
      await getSession(
        sessionId,
        playerId
      );

    if (!session) {
      throw new Error(
        'Economy session could not be loaded after creation.'
      );
    }

    res.json({
      success: true,
      sessionId: session.id,
      playerId: playerId,
      startedAt: session.started_at,
      startedAtMs:
        Number(session.started_at_ms),
      elapsedSeconds: 0,
      amount: baseBalance,
      baseBalance: baseBalance,
      interestRate:
        Number(session.interest_rate),
      compoundSeconds:
        Number(session.compound_seconds),
      plotIntervalSeconds:
        Number(session.plot_interval_seconds),
      durationSeconds:
        Number(session.duration_seconds),
      code: code || null,
      economyValue: codeValue,
      config:
        publicSessionConfig(session)
    });
  } catch (err) {
    console.error(
      'Economy start POST error:',
      err
    );

    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});


// -------------------------------------------------
// POST /api/features/economy/resume
// -------------------------------------------------

router.post('/economy/resume', async (req, res) => {
  try {
    const playerId = requirePlayerId(req, res);

    if (!playerId) {
      return;
    }

    const sessionId =
      Number(
        req.body &&
        req.body.sessionId
      );

    if (
      !Number.isInteger(sessionId) ||
      sessionId <= 0
    ) {
      return res.status(400).json({
        success: false,
        message: 'Valid sessionId is required'
      });
    }

    const session =
      await getSession(
        sessionId,
        playerId
      );

    if (!session) {
      return res.status(404).json({
        success: false,
        message: 'Economy session not found'
      });
    }

    const elapsed =
      await getServerElapsed(session);

    const amount =
      calculateEconomyAmount(
        session.base_balance,
        session.interest_rate,
        session.compound_seconds,
        elapsed
      );

    res.json({
      success: true,
      sessionId: session.id,
      playerId: playerId,
      startedAt: session.started_at,
      startedAtMs:
        Number(session.started_at_ms),
      status: session.status,
      elapsedSeconds: elapsed,
      amount: amount,
      baseBalance:
        Number(session.base_balance),
      interestRate:
        Number(session.interest_rate),
      compoundSeconds:
        Number(session.compound_seconds),
      plotIntervalSeconds:
        Number(session.plot_interval_seconds),
      durationSeconds:
        Number(session.duration_seconds),
      config:
        publicSessionConfig(session)
    });
  } catch (err) {
    console.error(
      'Economy resume POST error:',
      err
    );

    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});


// -------------------------------------------------
// POST /api/features/economy/session
// -------------------------------------------------

router.post('/economy/session', async (req, res) => {
  try {
    const playerId = requirePlayerId(req, res);

    if (!playerId) {
      return;
    }

    const sessionId =
      Number(
        req.body &&
        req.body.sessionId
      );

    if (
      !Number.isInteger(sessionId) ||
      sessionId <= 0
    ) {
      return res.status(400).json({
        success: false,
        message: 'Valid sessionId is required'
      });
    }

    const session =
      await getSession(
        sessionId,
        playerId
      );

    if (!session) {
      return res.status(404).json({
        success: false,
        message: 'Economy session not found'
      });
    }

    const elapsed =
      session.status === 'active'
        ? await getServerElapsed(session)
        : Number(session.duration_seconds);

    const effectiveElapsed =
      Math.max(
        0,
        Math.min(
          elapsed,
          Number(session.duration_seconds)
        )
      );

    const amount =
      session.final_balance !== null
        ? Number(session.final_balance)
        : calculateEconomyAmount(
            session.base_balance,
            session.interest_rate,
            session.compound_seconds,
            effectiveElapsed
          );

    res.json({
      success: true,
      sessionId: session.id,
      playerId: playerId,
      startedAt: session.started_at,
      startedAtMs:
        Number(session.started_at_ms),
      status: session.status,
      elapsedSeconds:
        effectiveElapsed,
      amount: amount,
      finalBalance:
        session.final_balance === null
          ? null
          : Number(session.final_balance),
      baseBalance:
        Number(session.base_balance),
      interestRate:
        Number(session.interest_rate),
      compoundSeconds:
        Number(session.compound_seconds),
      plotIntervalSeconds:
        Number(session.plot_interval_seconds),
      durationSeconds:
        Number(session.duration_seconds),
      config:
        publicSessionConfig(session)
    });
  } catch (err) {
    console.error(
      'Economy session POST error:',
      err
    );

    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});


// -------------------------------------------------
// POST /api/features/economy/snapshots
// -------------------------------------------------

router.post('/economy/snapshots', async (req, res) => {
  try {
    const playerId = requirePlayerId(req, res);

    if (!playerId) {
      return;
    }

    const sessionId =
      Number(
        req.body &&
        req.body.sessionId
      );

    if (
      !Number.isInteger(sessionId) ||
      sessionId <= 0
    ) {
      return res.status(400).json({
        success: false,
        message: 'Valid sessionId is required'
      });
    }

    const session =
      await getSession(
        sessionId,
        playerId
      );

    if (!session) {
      return res.status(404).json({
        success: false,
        message: 'Economy session not found'
      });
    }

    const [rows] = await pool.execute(
      `SELECT
         session_id,
         elapsed_seconds,
         amount,
         created_at
       FROM economy_snapshots
       WHERE session_id = ?
       ORDER BY elapsed_seconds ASC`,
      [sessionId]
    );

    res.json({
      success: true,
      sessionId: sessionId,
      snapshots: rows.map(function(row) {
        return {
          sessionId:
            Number(row.session_id),
          elapsedSeconds:
            Number(row.elapsed_seconds),
          amount:
            Number(row.amount),
          createdAt:
            row.created_at
        };
      })
    });
  } catch (err) {
    console.error(
      'Economy snapshots POST error:',
      err
    );

    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});


// -------------------------------------------------
// POST /api/features/economy/snapshot
// -------------------------------------------------

router.post('/economy/snapshot', async (req, res) => {
  try {
    const playerId = requirePlayerId(req, res);

    if (!playerId) {
      return;
    }

    const sessionId =
      Number(
        req.body &&
        req.body.sessionId
      );

    if (
      !Number.isInteger(sessionId) ||
      sessionId <= 0
    ) {
      return res.status(400).json({
        success: false,
        message: 'Valid sessionId is required'
      });
    }

    const session =
      await getSession(
        sessionId,
        playerId
      );

    if (!session) {
      return res.status(404).json({
        success: false,
        message: 'Economy session not found'
      });
    }

    if (session.status !== 'active') {
      return res.status(400).json({
        success: false,
        message: 'Economy session is not active'
      });
    }

    const elapsed =
      await getServerElapsed(session);

    const interval =
      Math.max(
        1,
        Number(
          session.plot_interval_seconds
        )
      );

    const plotElapsed =
      Math.floor(
        elapsed / interval
      ) * interval;

    const amount =
      calculateEconomyAmount(
        session.base_balance,
        session.interest_rate,
        session.compound_seconds,
        plotElapsed
      );

    await pool.execute(
      `INSERT INTO economy_snapshots
        (
          session_id,
          elapsed_seconds,
          amount
        )
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE
         amount = VALUES(amount)`,
      [
        sessionId,
        plotElapsed,
        amount
      ]
    );

    res.json({
      success: true,
      sessionId: sessionId,
      elapsedSeconds: elapsed,
      plotElapsedSeconds:
        plotElapsed,
      amount: amount
    });
  } catch (err) {
    console.error(
      'Economy snapshot POST error:',
      err
    );

    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});


// ============================================================
// SAVE ECONOMY SESSION TO JSON
// ============================================================

router.post('/economy/json-save', async (req, res) => {
  try {
    const playerId =
      requirePlayerId(req, res);

    if (!playerId) return;

    const body =
      req.body || {};

    const state = {
      version: 1,

      playerId:
        playerId,

      sessionId:
        body.sessionId || null,

      startedAt:
        Number(body.startedAt) || null,

      roundEndTime:
        Number(body.roundEndTime) || null,

      durationSeconds:
        Number(body.durationSeconds) || 0,

      units:
        Number(body.units) || 0,

      scoreAtLastSnapshot:
        Number(body.scoreAtLastSnapshot) || 0,

      lastSnapshotSlot:
        Number(body.lastSnapshotSlot),

      points:
        Array.isArray(body.points)
          ? body.points
          : [],

      savedAt:
        Date.now()
    };

    writeEconomyState(
      playerId,
      state
    );

    res.json({
      success: true,
      savedAt: state.savedAt
    });

  } catch (err) {
    console.error(
      'Economy JSON save error:',
      err
    );

    res.status(500).json({
      success: false,
      message:
        err.message ||
        'Unable to save economy JSON'
    });
  }
});


// ============================================================
// LOAD ECONOMY SESSION FROM JSON
// ============================================================

router.post('/economy/json-load', async (req, res) => {
  try {
    const playerId =
      requirePlayerId(req, res);

    if (!playerId) return;

    const state =
      readEconomyState(playerId);

    if (!state) {
      return res.json({
        success: true,
        found: false,
        state: null
      });
    }

    res.json({
      success: true,
      found: true,
      state: state
    });

  } catch (err) {
    console.error(
      'Economy JSON load error:',
      err
    );

    res.status(500).json({
      success: false,
      message:
        err.message ||
        'Unable to load economy JSON'
    });
  }
});

// -------------------------------------------------
// POST /api/features/economy/settle
// -------------------------------------------------

router.post('/economy/settle', async (req, res) => {
  try {
    const playerId = requirePlayerId(req, res);

    if (!playerId) {
      return;
    }

    const sessionId =
      Number(
        req.body &&
        req.body.sessionId
      );

    if (
      !Number.isInteger(sessionId) ||
      sessionId <= 0
    ) {
      return res.status(400).json({
        success: false,
        message: 'Valid sessionId is required'
      });
    }

    const conn =
      await pool.getConnection();

    try {
      await conn.beginTransaction();

      const [rows] =
        await conn.execute(
          `SELECT
             id,
             base_balance,
             interest_rate,
             compound_seconds,
             duration_seconds,
             started_at,
             status,
             final_balance,
             TIMESTAMPDIFF(
               MICROSECOND,
               started_at,
               NOW(6)
             ) / 1000000 AS elapsed_seconds
           FROM economy_sessions
           WHERE id = ?
             AND player_id = ?
           FOR UPDATE`,
          [
            sessionId,
            playerId
          ]
        );

      if (!rows.length) {
        await conn.rollback();

        return res.status(404).json({
          success: false,
          message: 'Economy session not found'
        });
      }

      const session = rows[0];

      if (session.status === 'settled') {
        await conn.rollback();


        deleteEconomyState(playerId);

        return res.json({
          success: true,
          alreadySettled: true,
          sessionId: sessionId,
          finalBalance:
            Number(
              session.final_balance
            )
        });
        
      }

      if (session.status !== 'active') {
        await conn.rollback();

        return res.status(400).json({
          success: false,
          message:
            'Economy session is not active'
        });
      }

      const duration =
        Number(
          session.duration_seconds
        );

      const elapsed =
        Math.max(
          0,
          Math.min(
            Number(
              session.elapsed_seconds
            ),
            duration
          )
        );

      const finalBalance =
        calculateEconomyAmount(
          session.base_balance,
          session.interest_rate,
          session.compound_seconds,
          elapsed
        );

      await conn.execute(
        `INSERT INTO economy_snapshots
          (
            session_id,
            elapsed_seconds,
            amount
          )
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE
           amount = VALUES(amount)`,
        [
          sessionId,
          Math.floor(elapsed),
          finalBalance
        ]
      );

      await conn.execute(
        `UPDATE economy_sessions
            SET ended_at = NOW(6),
                final_balance = ?,
                status = 'settled'
          WHERE id = ?
            AND player_id = ?`,
        [
          finalBalance,
          sessionId,
          playerId
        ]
      );

      await conn.commit();

      res.json({
        success: true,
        alreadySettled: false,
        sessionId: sessionId,
        elapsedSeconds: elapsed,
        finalBalance: finalBalance
      });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (err) {
    console.error(
      'Economy settle POST error:',
      err
    );

    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});


// -------------------------------------------------
// GET /api/features/stats
// -------------------------------------------------

router.get('/stats', async (req, res) => {
  try {
    const playerId =
      requirePlayerId(req, res);

    if (!playerId) {
      return;
    }

    const [rows] =
      await pool.execute(
        `SELECT *
         FROM player_stats
         WHERE player_id = ?`,
        [playerId]
      );

    res.json({
      success: true,
      stats: rows[0] || null
    });
  } catch (err) {
    console.error(
      'Feature stats GET error:',
      err
    );

    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});


// -------------------------------------------------
// POST /api/features/stats
// -------------------------------------------------

router.post('/stats', async (req, res) => {
  try {
    const playerId =
      requirePlayerId(req, res);

    if (!playerId) {
      return;
    }

    const s = req.body || {};

    await pool.execute(
      `INSERT INTO player_stats
        (
          player_id,
          level,
          xp,
          high_score,
          games_played,
          games_won,
          best_combo
        )
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         level = VALUES(level),
         xp = VALUES(xp),
         high_score =
           GREATEST(
             high_score,
             VALUES(high_score)
           ),
         games_played =
           VALUES(games_played),
         games_won =
           VALUES(games_won),
         best_combo =
           GREATEST(
             best_combo,
             VALUES(best_combo)
           )`,
      [
        playerId,
        Number(s.level) || 1,
        Number(s.xp) || 0,
        Number(s.highScore) || 0,
        Number(s.games) || 0,
        Number(s.wins) || 0,
        Number(s.comboBest) || 0
      ]
    );

    res.json({
      success: true
    });
  } catch (err) {
    console.error(
      'Feature stats POST error:',
      err
    );

    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});


// -------------------------------------------------
// GET /api/features/leaderboard
// -------------------------------------------------

router.get('/leaderboard', async (req, res) => {
  try {
    const season =
      req.query.season || 'current';

    const [rows] =
      await pool.execute(
        `SELECT
           player_id,
           MAX(score) AS score
         FROM leaderboard_scores
         WHERE season_key = ?
         GROUP BY player_id
         ORDER BY score DESC
         LIMIT 100`,
        [season]
      );

    res.json({
      success: true,
      leaderboard: rows
    });
  } catch (err) {
    console.error(
      'Leaderboard GET error:',
      err
    );

    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});


// -------------------------------------------------
// POST /api/features/leaderboard
// -------------------------------------------------

router.post('/leaderboard', async (req, res) => {
  try {
    const playerId =
      requirePlayerId(req, res);

    if (!playerId) {
      return;
    }

    const season =
      req.body.season ||
      'current';

    const score =
      Math.max(
        0,
        Number(req.body.score) || 0
      );

    await pool.execute(
      `INSERT INTO leaderboard_scores
        (
          player_id,
          season_key,
          score
        )
       VALUES (?, ?, ?)`,
      [
        playerId,
        season,
        score
      ]
    );

    res.json({
      success: true
    });
  } catch (err) {
    console.error(
      'Leaderboard POST error:',
      err
    );

    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});


// -------------------------------------------------
// GET /api/features/friends
// -------------------------------------------------

router.get('/friends', async (req, res) => {
  try {
    const playerId =
      requirePlayerId(req, res);

    if (!playerId) {
      return;
    }

    const [rows] =
      await pool.execute(
        `SELECT friend_id
         FROM friends
         WHERE player_id = ?`,
        [playerId]
      );

    res.json({
      success: true,
      friends: rows
    });
  } catch (err) {
    console.error(
      'Friends GET error:',
      err
    );

    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});


// -------------------------------------------------
// POST /api/features/friends
// -------------------------------------------------

router.post('/friends', async (req, res) => {
  try {
    const playerId =
      requirePlayerId(req, res);

    if (!playerId) {
      return;
    }

    const friendId =
      req.body &&
      req.body.friendId;

    if (!friendId) {
      return res.status(400).json({
        success: false,
        message: 'friendId is required'
      });
    }

    if (friendId === playerId) {
      return res.status(400).json({
        success: false,
        message:
          'You cannot add yourself'
      });
    }

    await pool.execute(
      `INSERT IGNORE INTO friends
        (
          player_id,
          friend_id
        )
       VALUES (?, ?)`,
      [
        playerId,
        friendId
      ]
    );

    res.json({
      success: true
    });
  } catch (err) {
    console.error(
      'Friends POST error:',
      err
    );

    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});


module.exports = router;