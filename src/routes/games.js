/**
 * Games Portal API Routes
 * Handles game token verification for entropy games
 */

const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();

/**
 * GET /api/games/verify
 * Verify a game token and return user wallet info
 * 
 * Query params:
 *   - token: JWT token from Gambino auth
 * 
 * Returns:
 *   - success: boolean
 *   - wallet: string (Solana wallet address)
 *   - userId: string
 */
router.get('/verify', (req, res) => {
  try {
    const { token } = req.query;
    
    if (!token) {
      return res.status(400).json({
        success: false,
        error: 'Token is required'
      });
    }
    
    // Verify the JWT token
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || 'fallback_secret',
      {
        issuer: 'gambino-admin',
        audience: 'gambino-users'
      }
    );
    
    // Check if wallet exists
    if (!decoded.walletAddress) {
      return res.status(400).json({
        success: false,
        error: 'No wallet associated with this account'
      });
    }
    
    // Return user info for game
    res.json({
      success: true,
      wallet: decoded.walletAddress,
      userId: decoded.userId,
      email: decoded.email,
      tier: decoded.tier
    });
    
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        error: 'Token expired. Please log in again.'
      });
    }
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        error: 'Invalid token'
      });
    }
    
    console.error('Games verify error:', error);
    res.status(500).json({
      success: false,
      error: 'Verification failed'
    });
  }
});

/**
 * POST /api/games/session
 * Create a game session token for authenticated user
 * Requires: Bearer token authentication
 * 
 * Returns:
 *   - success: boolean
 *   - gameToken: string (short-lived JWT for game)
 *   - wallet: string (user's wallet address)
 *   - expiresIn: number (seconds until expiry)
 */
router.post('/session', async (req, res) => {
  try {
    // Get auth token from header
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required'
      });
    }
    
    const authToken = authHeader.split(' ')[1];
    
    // Verify the auth token
    const decoded = jwt.verify(
      authToken,
      process.env.JWT_SECRET || 'fallback_secret'
    );
    
    if (!decoded.walletAddress) {
      return res.status(400).json({
        success: false,
        error: 'No wallet associated with this account. Please set up your wallet first.'
      });
    }
    
    // Create a short-lived game token (15 minutes)
    const gameToken = jwt.sign(
      {
        userId: decoded.userId,
        walletAddress: decoded.walletAddress,
        email: decoded.email,
        tier: decoded.tier || 'standard',
        purpose: 'game_session'
      },
      process.env.JWT_SECRET || 'fallback_secret',
      {
        expiresIn: '15m',
        issuer: 'gambino-admin',
        audience: 'gambino-users'
      }
    );
    
    res.json({
      success: true,
      gameToken,
      wallet: decoded.walletAddress,
      expiresIn: 900 // 15 minutes in seconds
    });
    
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        error: 'Session expired. Please log in again.'
      });
    }
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        error: 'Invalid session'
      });
    }
    
    console.error('Games session error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create game session'
    });
  }
});

module.exports = router;
