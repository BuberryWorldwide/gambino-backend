// src/routes/token-refresh.js
const express = require('express');
const router = express.Router();
const Hub = require('../models/Hub');

/**
 * POST /api/token/refresh
 * Pi calls this to refresh its access token before expiration
 * Body: { refreshToken: string }
 */
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({ 
        error: 'Refresh token required',
        code: 'MISSING_REFRESH_TOKEN'
      });
    }

    // Find hub with this refresh token
    const hub = await Hub.findByRefreshToken(refreshToken);

    if (!hub) {
      return res.status(401).json({ 
        error: 'Invalid or expired refresh token',
        code: 'INVALID_REFRESH_TOKEN'
      });
    }

    // Generate new access token
    const tokens = hub.refreshAccessToken();
    await hub.save();

    console.log(`✅ Token refreshed for hub: ${hub.hubId}`);

    res.json({
      success: true,
      hubId: hub.hubId,
      accessToken: tokens.accessToken,
      expiresAt: tokens.expiresAt,
      expiresIn: tokens.expiresIn,
      message: 'Access token refreshed successfully'
    });

  } catch (error) {
    console.error('❌ Token refresh error:', error);
    
    if (error.message === 'Refresh token expired') {
      return res.status(401).json({ 
        error: 'Refresh token expired - please re-register hub',
        code: 'REFRESH_TOKEN_EXPIRED'
      });
    }

    res.status(500).json({ 
      error: 'Token refresh failed',
      code: 'REFRESH_FAILED'
    });
  }
});

/**
 * GET /api/token/status
 * Check token expiration status (for Pi health checks)
 * Header: Authorization: Bearer <accessToken>
 */
router.get('/status', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
      return res.status(400).json({ error: 'Token required' });
    }

    const jwt = require('jsonwebtoken');
    const decoded = jwt.decode(token); // Don't verify, just decode

    if (!decoded || !decoded.hubId) {
      return res.status(400).json({ error: 'Invalid token format' });
    }

    const hub = await Hub.findOne({ hubId: decoded.hubId });

    if (!hub) {
      return res.status(404).json({ error: 'Hub not found' });
    }

    const now = Date.now();
    const expiresIn = Math.floor((hub.accessTokenExpiresAt - now) / 1000);
    const needsRefresh = hub.needsRefresh();

    res.json({
      success: true,
      hubId: hub.hubId,
      expiresAt: hub.accessTokenExpiresAt,
      expiresIn: expiresIn,
      needsRefresh: needsRefresh,
      tokenVersion: hub.tokenVersion
    });

  } catch (error) {
    console.error('Token status check error:', error);
    res.status(500).json({ error: 'Status check failed' });
  }
});

module.exports = router;
