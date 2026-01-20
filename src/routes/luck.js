// backend/src/routes/luck.js
// Proof of Luck routes - Gambino business layer

const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

// Dependencies injected from server.js
let authenticate, luckService, User;

/**
 * Setup function - Call this from server.js to inject dependencies
 */
function setupLuckRoutes(deps) {
  authenticate = deps.authenticate;
  luckService = deps.luckService;
  User = deps.User;
}

/**
 * GET /api/luck/stats
 * Get global luck statistics (public)
 */
router.get('/stats', async (req, res) => {
  try {
    const stats = await luckService.getGlobalStats();
    res.json({ success: true, stats });
  } catch (error) {
    console.error('Failed to get luck stats:', error);
    res.status(500).json({ success: false, error: 'Failed to get luck stats' });
  }
});

/**
 * GET /api/luck/state
 * Get current user's luck state (bits, eligibility, history)
 */
router.get('/state', (req, res, next) => {
  authenticate(req, res, async () => {
    try {
      const userId = req.user.userId;
      const state = luckService.getMinerState(userId);

      res.json({
        success: true,
        state: luckService.getPublicState(state)
      });
    } catch (error) {
      console.error('Failed to get luck state:', error);
      res.status(500).json({ success: false, error: 'Failed to get luck state' });
    }
  });
});

/**
 * GET /api/luck/history
 * Get current user's luck event history
 */
router.get('/history', (req, res, next) => {
  authenticate(req, res, async () => {
    try {
      const userId = req.user.userId;
      const limit = Math.min(parseInt(req.query.limit) || 20, 100);

      const history = await luckService.getUserLuckHistory(userId, limit);

      res.json({
        success: true,
        events: history
      });
    } catch (error) {
      console.error('Failed to get luck history:', error);
      res.status(500).json({ success: false, error: 'Failed to get luck history' });
    }
  });
});

/**
 * POST /api/luck/check
 * Record a contribution and perform luck check
 * Called after entropy contribution (e.g., game session end)
 *
 * Body:
 * - bitsContributed: number (required)
 * - gameContext: string (optional, default 'unknown')
 */
router.post('/check', (req, res, next) => {
  authenticate(req, res, async () => {
    try {
      const userId = req.user.userId;
      const { bitsContributed, gameContext = 'unknown' } = req.body;

      if (!bitsContributed || bitsContributed <= 0) {
        return res.status(400).json({
          success: false,
          error: 'bitsContributed is required and must be positive'
        });
      }

      const result = await luckService.recordContributionAndCheckLuck(
        userId,
        bitsContributed,
        gameContext
      );

      // Add helpful message
      let message;
      if (result.hit) {
        message = `${result.proof.rarityName}! You won ${result.proof.ggEmission} GG!`;
      } else if (result.checked) {
        message = 'No luck this time. Keep contributing!';
      } else if (result.reason === 'cooldown') {
        message = `Cooldown active. ${result.bitsUntilNextCheck} more bits needed.`;
      } else if (result.reason === 'below_milestone') {
        message = `${result.bitsUntilNextCheck} more bits until next luck check.`;
      } else {
        message = 'Contribution recorded.';
      }

      res.json({
        success: true,
        ...result,
        message
      });
    } catch (error) {
      console.error('Luck check failed:', error);
      res.status(500).json({ success: false, error: 'Luck check failed' });
    }
  });
});

/**
 * GET /api/luck/governance/leaderboard
 * Get top users by governance points (gluckScore)
 */
router.get('/governance/leaderboard', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const leaderboard = await luckService.getGovernanceLeaderboard(limit);

    res.json({
      success: true,
      leaderboard: leaderboard.map(user => ({
        firstName: user.firstName,
        lastName: user.lastName?.charAt(0) + '.', // Privacy: only show initial
        gluckScore: user.gluckScore,
        totalLuckHits: user.totalLuckHits || 0,
        luckHits: user.luckHits || {}
      }))
    });
  } catch (error) {
    console.error('Failed to get leaderboard:', error);
    res.status(500).json({ success: false, error: 'Failed to get leaderboard' });
  }
});

/**
 * POST /api/luck/test
 * Test endpoint to trigger luck with forced values
 * DEVELOPMENT/TESTING ONLY
 *
 * Body:
 * - forceTier: 'RARE' | 'EPIC' | 'LEGENDARY' (optional)
 * - forceRoll: number 0-49999 (optional)
 * - useRealDraw: boolean (optional, default false)
 * - gameContext: string (optional)
 */
router.post('/test', (req, res, next) => {
  authenticate(req, res, async () => {
    try {
      const userId = req.user.userId;
      const { forceTier, forceRoll, useRealDraw, gameContext } = req.body;

      console.log(`[TEST LUCK] User ${userId}: forceTier=${forceTier}, forceRoll=${forceRoll}, useRealDraw=${useRealDraw}`);

      const result = await luckService.testTriggerLuck(userId, {
        forceTier,
        forceRoll,
        useRealDraw,
        gameContext
      });

      res.json({
        success: true,
        result,
        message: result.hit
          ? `HIT! ${result.proof.rarityTier} - ${result.proof.ggEmission} GG`
          : `No hit (roll ${result.rollValue} >= 100)`
      });
    } catch (error) {
      console.error('Test luck failed:', error);
      res.status(500).json({ success: false, error: 'Test luck failed' });
    }
  });
});

/**
 * GET /api/luck/event/:eventId
 * Get a specific luck event (for verification/sharing)
 */
router.get('/event/:eventId', async (req, res) => {
  try {
    const { eventId } = req.params;
    const LuckEvent = mongoose.model('LuckEvent');

    const event = await LuckEvent.findOne({ eventId }).populate('userId', 'firstName lastName');

    if (!event) {
      return res.status(404).json({ success: false, error: 'Event not found' });
    }

    res.json({
      success: true,
      event: {
        eventId: event.eventId,
        rarityTier: event.rarityTier,
        ggEmission: event.ggEmission,
        rollValue: event.rollValue,
        threshold: event.threshold,
        arcaDrawId: event.arcaDrawId,
        gameContext: event.gameContext,
        winner: event.userId ? {
          firstName: event.userId.firstName,
          lastName: event.userId.lastName?.charAt(0) + '.'
        } : null,
        createdAt: event.createdAt
      }
    });
  } catch (error) {
    console.error('Failed to get luck event:', error);
    res.status(500).json({ success: false, error: 'Failed to get luck event' });
  }
});

module.exports = { router, setupLuckRoutes };
