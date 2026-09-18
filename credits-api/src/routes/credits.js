const express = require('express');
const rateLimit = require('express-rate-limit');
const pool = require('../db');

const router = express.Router();

const redeemLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false
});

// -------------------------------------------------
// GET /api/credits
// -------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT credits FROM players WHERE id = ?',
      [req.playerId]
    );

    if (!rows.length) {
      await pool.execute(
        'INSERT INTO players (id, credits) VALUES (?, 0)',
        [req.playerId]
      );

      return res.json({
        success: true,
        credits: 0
      });
    }

    res.json({
      success: true,
      credits: Number(rows[0].credits)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// -------------------------------------------------
// POST /api/credits/use
// -------------------------------------------------
router.post('/use', async (req, res) => {
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    const [rows] = await conn.execute(
      'SELECT credits FROM players WHERE id = ? FOR UPDATE',
      [req.playerId]
    );

    if (!rows.length || Number(rows[0].credits) <= 0) {
      await conn.rollback();

      return res.status(400).json({
        success: false,
        message: 'No credits available'
      });
    }

    const newCredits =
      Number(rows[0].credits) - 1;

    await conn.execute(
      'UPDATE players SET credits = ? WHERE id = ?',
      [newCredits, req.playerId]
    );

    await conn.execute(
      `INSERT INTO credit_ledger
        (player_id, change_amount, reason, meta)
       VALUES (?, ?, ?, ?)`,
      [
        req.playerId,
        -1,
        'use',
        JSON.stringify({})
      ]
    );

    await conn.commit();

    res.json({
      success: true,
      credits: newCredits
    });
  } catch (err) {
    await conn.rollback();

    console.error(err);

    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  } finally {
    conn.release();
  }
});

// -------------------------------------------------
// POST /api/credits/redeem
//
// A redeemed code carries:
//   - credit amount
//   - economy value
//   - duration
//
// The duration is intrinsic to the code.
// -------------------------------------------------
// -------------------------------------------------
// POST /api/credits/redeem
// -------------------------------------------------
router.post('/redeem', redeemLimiter, async (req, res) => {
  const code = (req.body.code || '').trim().toUpperCase();

  if (!code || code.length > 32) {
    return res.status(400).json({
      success: false,
      message: 'Invalid code'
    });
  }

  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    /*
     * Lock the code row so used_count cannot change underneath
     * this redemption transaction.
     *
     * IMPORTANT:
     * duration_seconds and economy_value come directly from
     * the codes table. They are returned to DrissNow so the
     * redeemed code can control the economy session.
     */
    const [codes] = await conn.execute(
      `
      SELECT
        amount,
        economy_value,
        duration_seconds,
        max_uses,
        used_count,
        active
      FROM codes
      WHERE code = ?
      FOR UPDATE
      `,
      [code]
    );

    /*
     * Code does not exist or has been disabled.
     */
    if (!codes.length || !codes[0].active) {
      await conn.rollback();

      return res.status(400).json({
        success: false,
        message: 'Invalid code'
      });
    }

    const c = codes[0];

    /*
     * Normalize the numeric database values before comparing them.
     */
    const usedCount = Number(c.used_count);
    const maxUses = Number(c.max_uses);
    const amount = Number(c.amount);
    const economyValue = Number(c.economy_value);
    const durationSeconds = Number(c.duration_seconds);

    /*
     * The code must have a valid usage limit.
     *
     * A malformed NULL/zero/negative max_uses is NOT considered
     * an available code.
     */
    if (
      !Number.isFinite(usedCount) ||
      !Number.isFinite(maxUses) ||
      maxUses <= 0
    ) {
      await conn.rollback();

      return res.status(400).json({
        success: false,
        message: 'This code has an invalid usage limit'
      });
    }

    /*
     * GLOBAL CODE VALIDITY:
     *
     * The code remains redeemable while:
     *
     *     used_count < max_uses
     *
     * Once used_count reaches max_uses, the code is exhausted.
     */
    if (usedCount >= maxUses) {
      await conn.rollback();

      return res.status(400).json({
        success: false,
        message: 'This code has reached its maximum number of uses',
        code: code,
        usedCount: usedCount,
        maxUses: maxUses
      });
    }

    /*
     * ECONOMY CODE VALIDITY:
     *
     * A code intended to control the economy must contain both
     * a valid economy value and a valid duration.
     *
     * If either is missing, do not consume the code.
     */
    if (
      !Number.isFinite(economyValue) ||
      economyValue <= 0 ||
      !Number.isFinite(durationSeconds) ||
      durationSeconds <= 0
    ) {
      await conn.rollback();

      return res.status(400).json({
        success: false,
        message: 'This code is missing a valid economy value or duration',
        code: code
      });
    }

    /*
     * PLAYER-SPECIFIC DUPLICATE PROTECTION.
     *
     * Even when max_uses allows multiple different players to
     * redeem the code, one player cannot redeem the same code twice.
     */
    const [already] = await conn.execute(
      `
      SELECT id
      FROM redeemed_codes
      WHERE player_id = ?
        AND code = ?
      LIMIT 1
      `,
      [req.playerId, code]
    );

    if (already.length) {
      await conn.rollback();

      return res.status(400).json({
        success: false,
        message: 'That code has already been redeemed by this player',
        code: code,
        usedCount: usedCount,
        maxUses: maxUses
      });
    }

    /*
     * Increment the global usage counter.
     *
     * The row is already locked by FOR UPDATE, so this update
     * cannot race with another redemption transaction.
     */
    const [usageUpdate] = await conn.execute(
      `
      UPDATE codes
      SET used_count = used_count + 1
      WHERE code = ?
        AND used_count < max_uses
      `,
      [code]
    );

    /*
     * Defensive race/validity check.
     */
    if (!usageUpdate.affectedRows) {
      await conn.rollback();

      return res.status(400).json({
        success: false,
        message: 'This code has reached its maximum number of uses',
        code: code
      });
    }

    /*
     * Record this player's redemption.
     */
    await conn.execute(
      `
      INSERT INTO redeemed_codes
        (code, player_id, amount)
      VALUES
        (?, ?, ?)
      `,
      [
        code,
        req.playerId,
        amount
      ]
    );

    /*
     * Add the purchased credits to the player's account.
     */
    await conn.execute(
      `
      UPDATE players
      SET credits = credits + ?
      WHERE id = ?
      `,
      [
        amount,
        req.playerId
      ]
    );

    /*
     * Record the redemption in the credit ledger.
     *
     * Store the economy parameters in meta as well so the
     * redemption is auditable later.
     */
    await conn.execute(
      `
      INSERT INTO credit_ledger
        (player_id, change_amount, reason, meta)
      VALUES
        (?, ?, ?, ?)
      `,
      [
        req.playerId,
        amount,
        'redeem',
        JSON.stringify({
          code: code,
          economyValue: economyValue,
          durationSeconds: durationSeconds,
          usedCountAfter: usedCount + 1,
          maxUses: maxUses
        })
      ]
    );

    await conn.commit();

    /*
     * Read the final credit balance.
     */
    const [updated] = await pool.execute(
      `
      SELECT credits
      FROM players
      WHERE id = ?
      `,
      [req.playerId]
    );

    /*
     * IMPORTANT:
     *
     * durationSeconds is now returned to the browser.
     *
     * This is the value that DrissNow will use to override
     * economy_config.duration_seconds for this redeemed session.
     */
    res.json({
      success: true,

      code: code,

      amount: amount,

      credits: Number(updated[0].credits),

      economyValue: economyValue,

      durationSeconds: durationSeconds,

      usedCount: usedCount + 1,

      maxUses: maxUses,

      remainingUses: Math.max(
        0,
        maxUses - (usedCount + 1)
      ),

      message:
        `Added ${amount} credit(s). Enjoy!`
    });

  } catch (err) {
    try {
      await conn.rollback();
    } catch (rollbackError) {
      console.error(
        'Redemption rollback error:',
        rollbackError
      );
    }

    console.error(
      'Code redemption error:',
      err
    );

    res.status(500).json({
      success: false,
      message: 'Server error'
    });

  } finally {
    conn.release();
  }
});
// -------------------------------------------------
// POST /api/credits/milestones
// -------------------------------------------------
router.post('/milestones', async (req, res) => {
  const value =
    Number(req.body.value);

  const milestoneBonuses = {
    16: 1,
    32: 1,
    64: 2,
    128: 2,
    256: 3,
    512: 5,
    1024: 8,
    2048: 15
  };

  const baseBonus =
    milestoneBonuses[value];

  if (!baseBonus) {
    return res.json({
      success: true,
      firstTime: false,
      bonus: 0
    });
  }

  const conn =
    await pool.getConnection();

  try {
    await conn.beginTransaction();

    const [existing] =
      await conn.execute(
        `SELECT player_id
           FROM milestones
          WHERE player_id = ?
            AND value = ?
          FOR UPDATE`,
        [
          req.playerId,
          value
        ]
      );

    if (existing.length) {
      await conn.rollback();

      const [credits] =
        await pool.execute(
          `SELECT credits
             FROM players
            WHERE id = ?`,
          [req.playerId]
        );

      return res.json({
        success: true,
        firstTime: false,
        bonus: 0,
        credits:
          Number(credits[0].credits)
      });
    }

    await conn.execute(
      `INSERT INTO milestones
        (player_id, value)
       VALUES (?, ?)`,
      [
        req.playerId,
        value
      ]
    );

    /*
     * Milestone bonus is server controlled.
     * The exact bonus may be changed here without
     * affecting the economy ticket system.
     */
    const bonus =
      baseBonus;

    await conn.execute(
      `UPDATE players
          SET credits = credits + ?
        WHERE id = ?`,
      [
        bonus,
        req.playerId
      ]
    );

    await conn.execute(
      `INSERT INTO credit_ledger
        (
          player_id,
          change_amount,
          reason,
          meta
        )
       VALUES (?, ?, ?, ?)`,
      [
        req.playerId,
        bonus,
        'milestone',
        JSON.stringify({
          value: value
        })
      ]
    );

    await conn.commit();

    const [credits] =
      await pool.execute(
        `SELECT credits
           FROM players
          WHERE id = ?`,
        [req.playerId]
      );

    res.json({
      success: true,
      firstTime: true,
      bonus: bonus,
      credits:
        Number(credits[0].credits)
    });
  } catch (err) {
    await conn.rollback();

    console.error(err);

    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  } finally {
    conn.release();
  }
});

// -------------------------------------------------
// POST /api/credits/score-bonus
// -------------------------------------------------
router.post('/score-bonus', async (req, res) => {
  const score =
    Math.max(
      0,
      Number(req.body.score) || 0
    );

  /*
   * Server-controlled score bonus.
   */
  const rate = 300;
  const maxCredits = 25;

  const bonus =
    Math.min(
      maxCredits,
      Math.floor(score / rate)
    );

  const conn =
    await pool.getConnection();

  try {
    await conn.beginTransaction();

    const [creditsBefore] =
      await conn.execute(
        `SELECT credits
           FROM players
          WHERE id = ?
          FOR UPDATE`,
        [req.playerId]
      );

    if (!creditsBefore.length) {
      await conn.rollback();

      return res.status(400).json({
        success: false,
        message: 'Player not found'
      });
    }

    if (bonus > 0) {
      await conn.execute(
        `UPDATE players
            SET credits = credits + ?
          WHERE id = ?`,
        [
          bonus,
          req.playerId
        ]
      );

      await conn.execute(
        `INSERT INTO credit_ledger
          (
            player_id,
            change_amount,
            reason,
            meta
          )
         VALUES (?, ?, ?, ?)`,
        [
          req.playerId,
          bonus,
          'score-bonus',
          JSON.stringify({
            score: score
          })
        ]
      );
    }

    await conn.commit();

    const [credits] =
      await pool.execute(
        `SELECT credits
           FROM players
          WHERE id = ?`,
        [req.playerId]
      );

    res.json({
      success: true,
      bonus: bonus,
      credits:
        Number(credits[0].credits)
    });
  } catch (err) {
    await conn.rollback();

    console.error(err);

    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  } finally {
    conn.release();
  }
});

module.exports = router;