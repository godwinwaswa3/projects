const express = require('express');
const crypto = require('crypto');
const pool = require('../db');

const router = express.Router();

const SESSION_DAYS = 30;


/*
 * --------------------------------------------------
 * HELPERS
 * --------------------------------------------------
 */

function normalizeEmail(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}


function hashToken(token) {
  return crypto
    .createHash('sha256')
    .update(token)
    .digest('hex');
}


function hashPassword(password) {
  return new Promise((resolve, reject) => {

    const salt = crypto.randomBytes(16);

    crypto.scrypt(
      password,
      salt,
      64,
      {
        N: 16384,
        r: 8,
        p: 1
      },
      (err, derivedKey) => {

        if (err) {
          reject(err);
          return;
        }

        resolve(
          'scrypt$' +
          salt.toString('hex') +
          '$' +
          derivedKey.toString('hex')
        );

      }
    );

  });
}


function verifyPassword(password, stored) {

  return new Promise((resolve, reject) => {

    const parts =
      String(stored || '').split('$');


    if (
      parts.length !== 3 ||
      parts[0] !== 'scrypt'
    ) {

      resolve(false);
      return;

    }


    const salt =
      Buffer.from(parts[1], 'hex');

    const expected =
      Buffer.from(parts[2], 'hex');


    crypto.scrypt(
      password,
      salt,
      expected.length,
      {
        N: 16384,
        r: 8,
        p: 1
      },
      (err, derivedKey) => {

        if (err) {
          reject(err);
          return;
        }


        if (
          derivedKey.length !==
          expected.length
        ) {

          resolve(false);
          return;

        }


        resolve(
          crypto.timingSafeEqual(
            derivedKey,
            expected
          )
        );

      }
    );

  });

}


function createToken() {

  return crypto
    .randomBytes(32)
    .toString('hex');

}


async function createSession(userId) {

  const token =
    createToken();

  const tokenHash =
    hashToken(token);


  await pool.execute(
    `INSERT INTO auth_sessions
      (user_id, token_hash, expires_at)
     VALUES
      (?, ?, DATE_ADD(NOW(), INTERVAL ? DAY))`,
    [
      userId,
      tokenHash,
      SESSION_DAYS
    ]
  );


  return token;

}


/*
 * --------------------------------------------------
 * POST /api/auth/signup
 * --------------------------------------------------
 */

router.post(
  '/signup',
  async (req, res) => {

    const email =
      normalizeEmail(
        req.body &&
        req.body.email
      );


    const password =
      String(
        req.body &&
        req.body.password ||
        ''
      );


    if (
      !email ||
      !email.includes('@')
    ) {

      return res.status(400).json({
        success: false,
        message: 'A valid email is required'
      });

    }


    if (password.length < 8) {

      return res.status(400).json({
        success: false,
        message:
          'Password must be at least 8 characters'
      });

    }


    const conn =
      await pool.getConnection();


    try {

      await conn.beginTransaction();


      const [existing] =
        await conn.execute(
          `SELECT id
           FROM users
           WHERE email = ?
           LIMIT 1`,
          [email]
        );


      if (existing.length) {

        await conn.rollback();


        return res.status(409).json({
          success: false,
          message:
            'An account with that email already exists'
        });

      }


      const userId =
        crypto.randomUUID();


      const passwordHash =
        await hashPassword(password);


      await conn.execute(
        `INSERT INTO users
          (id, email, password_hash)
         VALUES
          (?, ?, ?)`,
        [
          userId,
          email,
          passwordHash
        ]
      );


      /*
       * Every authenticated user receives
       * exactly one player record.
       */

      await conn.execute(
        `INSERT INTO players
          (id, user_id, credits)
         VALUES
          (?, ?, 0)`,
        [
          userId,
          userId
        ]
      );


      await conn.commit();


      const token =
        await createSession(userId);


      res.status(201).json({

        success: true,

        user: {
          id: userId,
          email: email,
          playerId: userId
        },

        token,

        expiresInDays:
          SESSION_DAYS

      });


    } catch (err) {

      try {
        await conn.rollback();
      } catch (rollbackError) {
        console.error(
          'Signup rollback error:',
          rollbackError
        );
      }


      console.error(
        'Signup error:',
        err
      );


      res.status(500).json({
        success: false,
        message: 'Server error'
      });


    } finally {

      conn.release();

    }

  }
);


/*
 * --------------------------------------------------
 * POST /api/auth/signin
 * --------------------------------------------------
 */

router.post(
  '/signin',
  async (req, res) => {

    const email =
      normalizeEmail(
        req.body &&
        req.body.email
      );


    const password =
      String(
        req.body &&
        req.body.password ||
        ''
      );


    if (!email || !password) {

      return res.status(400).json({
        success: false,
        message:
          'Email and password are required'
      });

    }


    try {

      const [users] =
        await pool.execute(
          `SELECT
             u.id,
             u.email,
             u.password_hash,
             p.id AS player_id
           FROM users u
           INNER JOIN players p
             ON p.user_id = u.id
           WHERE u.email = ?
           LIMIT 1`,
          [email]
        );


      if (!users.length) {

        return res.status(401).json({
          success: false,
          message:
            'Invalid email or password'
        });

      }


      const user =
        users[0];


      const valid =
        await verifyPassword(
          password,
          user.password_hash
        );


      if (!valid) {

        return res.status(401).json({
          success: false,
          message:
            'Invalid email or password'
        });

      }


      const token =
        await createSession(
          user.id
        );


      res.json({

        success: true,

        user: {
          id: user.id,
          email: user.email,
          playerId: user.player_id
        },

        token,

        expiresInDays:
          SESSION_DAYS

      });


    } catch (err) {

      console.error(
        'Signin error:',
        err
      );


      res.status(500).json({
        success: false,
        message: 'Server error'
      });

    }

  }
);


/*
 * --------------------------------------------------
 * GET /api/auth/me
 *
 * Returns the authenticated user's account
 * directly from the database.
 *
 * Sensitive information such as password_hash
 * and token_hash is NEVER returned.
 * --------------------------------------------------
 */

router.get(
  '/me',
  async (req, res) => {

    const header =
      String(
        req.get('Authorization') || ''
      );


    if (
      !header.startsWith('Bearer ')
    ) {

      return res.status(401).json({
        success: false,
        message:
          'Authentication required'
      });

    }


    const token =
      header
        .slice(7)
        .trim();


    if (!token) {

      return res.status(401).json({
        success: false,
        message:
          'Authentication required'
      });

    }


    try {

      const tokenHash =
        hashToken(token);


      const [rows] =
        await pool.execute(
          `SELECT
             u.id AS user_id,
             u.email AS email,
             p.id AS player_id,
             p.credits AS credits
           FROM auth_sessions s
           INNER JOIN users u
             ON u.id = s.user_id
           INNER JOIN players p
             ON p.user_id = u.id
           WHERE s.token_hash = ?
             AND s.expires_at > NOW()
           LIMIT 1`,
          [tokenHash]
        );


      if (!rows.length) {

        return res.status(401).json({
          success: false,
          message:
            'Invalid or expired session'
        });

      }


      const account =
        rows[0];


      res.json({

        success: true,

        account: {

          id:
            account.user_id,

          email:
            account.email,

          playerId:
            account.player_id,

          credits:
            Number(account.credits) || 0

        }

      });


    } catch (err) {

      console.error(
        'Account lookup error:',
        err
      );


      res.status(500).json({
        success: false,
        message:
          'Server error'
      });

    }

  }
);


/*
 * --------------------------------------------------
 * POST /api/auth/signout
 * --------------------------------------------------
 */

router.post(
  '/signout',
  async (req, res) => {

    const header =
      String(
        req.get('Authorization') || ''
      );


    /*
     * Signing out without a token is harmless.
     */

    if (
      !header.startsWith('Bearer ')
    ) {

      return res.json({
        success: true
      });

    }


    const token =
      header
        .slice(7)
        .trim();


    if (token) {

      try {

        await pool.execute(
          `DELETE
           FROM auth_sessions
           WHERE token_hash = ?`,
          [hashToken(token)]
        );

      } catch (err) {

        console.error(
          'Signout error:',
          err
        );

        return res.status(500).json({
          success: false,
          message:
            'Server error'
        });

      }

    }


    res.json({
      success: true
    });

  }
);


module.exports = router;