DRISSNOW UNIFIED SERVER
=======================

This server combines:
  1. Drissnow authentication/session API
  2. Peanut Credits curl proxy
  3. Feature API curl proxy
  4. Static web-file serving

START
-----
From the Drissnow project root:

  node backend/server.js

Open:

  http://127.0.0.1:3000/index.html

AUTH ENDPOINTS
--------------
POST /api/auth/signup
POST /api/auth/signin
GET  /api/auth/me
POST /api/auth/signout

CURL PROXY
----------
POST /curl

The browser sends JSON such as:

  {
    "path": "/use",
    "method": "POST",
    "playerId": "DRS-12345678",
    "body": {}
  }

For /game* paths the request is routed to DRISSNOW_FEATURE_API_URL.
All other supported paths are routed to PEANUT_CREDITS_API_URL.

UPSTREAM API PORTS
------------------
The unified server uses port 3000 by default.
The default upstreams are intentionally port 3002 so the proxy does not
call itself.

Set these if your real upstream APIs use different addresses:

  PEANUT_CREDITS_API_URL=http://localhost:3002/api/credits
  DRISSNOW_FEATURE_API_URL=http://localhost:3002/api/features

Example:

  PEANUT_CREDITS_API_URL=http://localhost:4000/api/credits \
  DRISSNOW_FEATURE_API_URL=http://localhost:4000/api/features \
  node backend/server.js

AUTHENTICATED REQUESTS
----------------------
If /curl receives an Authorization: Bearer <token> header, the server:
  - validates the Drissnow session
  - uses the session user's playerId instead of trusting a supplied playerId
  - forwards the Bearer token upstream
  - forwards X-Player-Id upstream

Anonymous requests can still use the original playerId contract.

DATA
----
Authentication data is stored in:
  backend/data/users.json
  backend/data/sessions.json

REQUIREMENT
-----------
The machine running the server must have the curl command available in PATH.
