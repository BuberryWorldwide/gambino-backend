// backend/src/routes/mining.js
// Mining routes for mobile app entropy generation
const express = require('express');
const router = express.Router();

// Will be injected by server.js
let MiningSession, EscrowBalance, authenticate;

function setupMiningRoutes(deps) {
  MiningSession = deps.MiningSession;
  EscrowBalance = deps.EscrowBalance;
  authenticate = deps.authenticate;
  return router;
}

/**
 * POST /api/mining/start-session
 * Start mining session from mobile app
 */
router.post('/start-session', async (req, res) => {
  try {
    await new Promise((resolve, reject) => {
      authenticate(req, res, (err) => err ? reject(err) : resolve());
    });

    const userId = req.user.userId;
    const { platform, deviceFingerprint, appVersion } = req.body;

    // Validate required fields
    if (!platform || !deviceFingerprint) {
      return res.status(400).json({ 
        error: 'Platform and deviceFingerprint are required' 
      });
    }

    if (!['ios', 'android'].includes(platform)) {
      return res.status(400).json({ 
        error: 'Platform must be ios or android' 
      });
    }

    // Check for existing active session
    const existingSession = await MiningSession.findOne({ 
      userId, 
      status: 'active' 
    });

    if (existingSession) {
      return res.status(400).json({
        success: false,
        error: 'You already have an active mining session',
        sessionId: existingSession.sessionId,
        session: {
          sessionId: existingSession.sessionId,
          startTime: existingSession.startTime,
          totalClicks: existingSession.totalClicks,
          totalSwipes: existingSession.totalSwipes,
          totalShakes: existingSession.totalShakes,
          entropyGenerated: existingSession.entropyGenerated
        }
      });
    }

    // Create new mining session
    const session = await MiningSession.create({
      userId,
      platform,
      deviceFingerprint,
      appVersion: appVersion || 'unknown',
      ipAddress: req.ip,
      userAgent: req.get('User-Agent')
    });

    console.log(`✅ Mining session started: ${session.sessionId} (${platform})`);

    res.json({
      success: true,
      sessionId: session.sessionId,
      startTime: session.startTime,
      message: 'Mining session started. Start generating entropy!'
    });

  } catch (error) {
    console.error('Start mining session error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to start mining session' 
    });
  }
});

/**
 * POST /api/mining/submit-entropy
 * Submit entropy data from mobile interactions
 */
router.post('/submit-entropy', async (req, res) => {
  try {
    await new Promise((resolve, reject) => {
      authenticate(req, res, (err) => err ? reject(err) : resolve());
    });

    const { sessionId, clicks, swipes, shakes, pattern } = req.body;
    const userId = req.user.userId;

    // Validate input
    if (!sessionId) {
      return res.status(400).json({ 
        success: false,
        error: 'sessionId is required' 
      });
    }

    // At least one interaction type must be provided
    const clickCount = clicks || 0;
    const swipeCount = swipes || 0;
    const shakeCount = shakes || 0;

    if (clickCount === 0 && swipeCount === 0 && shakeCount === 0) {
      return res.status(400).json({ 
        success: false,
        error: 'No entropy data provided' 
      });
    }

    // Find active session
    const session = await MiningSession.findOne({ 
      sessionId, 
      userId, 
      status: 'active' 
    });

    if (!session) {
      return res.status(404).json({ 
        success: false,
        error: 'Active session not found' 
      });
    }

    // Add entropy submission
    await session.addEntropySubmission({
      timestamp: new Date(),
      clickCount,
      swipeCount,
      shakeCount,
      pattern: pattern || 'unknown',
      deviceData: {
        platform: session.platform,
        appVersion: session.appVersion,
        timestamp: new Date()
      }
    });

    // Calculate pending reward (simple formula - adjust as needed)
    const totalInteractions = session.totalClicks + session.totalSwipes + session.totalShakes;
    const baseReward = 0.001; // Base reward per interaction
    const pendingReward = totalInteractions * baseReward;

    res.json({
      success: true,
      sessionId: session.sessionId,
      entropyGenerated: session.entropyGenerated,
      totalClicks: session.totalClicks,
      totalSwipes: session.totalSwipes,
      totalShakes: session.totalShakes,
      pendingReward: pendingReward.toFixed(6),
      message: 'Entropy submitted successfully'
    });

  } catch (error) {
    console.error('Submit entropy error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to submit entropy' 
    });
  }
});

/**
 * POST /api/mining/end-session
 * End mining session and calculate rewards
 */
router.post('/end-session', async (req, res) => {
  try {
    await new Promise((resolve, reject) => {
      authenticate(req, res, (err) => err ? reject(err) : resolve());
    });

    const { sessionId } = req.body;
    const userId = req.user.userId;

    if (!sessionId) {
      return res.status(400).json({ 
        success: false,
        error: 'sessionId is required' 
      });
    }

    // Find active session
    const session = await MiningSession.findOne({ 
      sessionId, 
      userId, 
      status: 'active' 
    });

    if (!session) {
      return res.status(404).json({ 
        success: false,
        error: 'Active session not found' 
      });
    }

    // Calculate fraud score
    session.calculateFraudScore();

    // Calculate final reward
    const totalInteractions = session.totalClicks + session.totalSwipes + session.totalShakes;
    const baseReward = 0.001;
    let finalReward = totalInteractions * baseReward;

    // Apply fraud penalty
    const fraudPenalty = session.fraudScore / 100; // 0-1
    finalReward = finalReward * (1 - fraudPenalty);

    // Minimum reward
    finalReward = Math.max(finalReward, 0);

    // End session
    await session.endSession(finalReward);

    // Update escrow balance
    if (finalReward > 0) {
      const escrow = await EscrowBalance.getOrCreate(userId);
      await escrow.deposit(finalReward);
    }

    // === REFERRAL REWARD TRIGGER ===
    // Check if this is user's first completed session - triggers referral rewards
    try {
      const completedSessions = await MiningSession.countDocuments({ 
        userId, 
        status: 'completed' 
      });
      
      // First completed session triggers referral rewards for their referrer
      if (completedSessions === 1) {
        const Referral = require('../models/Referral');
        const User = require('mongoose').model('User');
        const { distributeReferralRewards } = require('../services/referralDistribution');
        
        // Find pending referral where this user is the referee
        const referral = await Referral.findOne({
          newUserId: userId,
          status: 'pending'
        });
        
        if (referral) {
          console.log(`🎯 First session completed by referred user ${userId}, triggering referral reward`);
          
          // Mark as verified
          await Referral.findByIdAndUpdate(referral._id, {
            status: 'verified',
            firstSessionAt: new Date(),
            firstSessionDuration: session.duration
          });
          
          // Get updated referral and distribute immediately
          const updatedReferral = await Referral.findById(referral._id);
          const distResult = await distributeReferralRewards(updatedReferral, User, Referral);
          
          if (distResult.success) {
            console.log(`✅ Referral rewards distributed: referrer=${distResult.amounts.referrer} GG, newUser=${distResult.amounts.newUser} GG`);
          } else {
            console.log(`⚠️ Referral distribution deferred: ${distResult.reason}`);
          }
        }
      }
    } catch (refError) {
      // Don't fail the session end if referral processing fails
      console.error('Referral processing error (non-fatal):', refError.message);
    }
    // === END REFERRAL TRIGGER ===

    console.log(`✅ Mining session ended: ${sessionId}, reward: ${finalReward.toFixed(6)}, fraud: ${session.fraudScore}%`);

    res.json({
      success: true,
      sessionId: session.sessionId,
      duration: session.duration,
      entropyGenerated: session.entropyGenerated,
      totalClicks: session.totalClicks,
      totalSwipes: session.totalSwipes,
      totalShakes: session.totalShakes,
      fraudScore: session.fraudScore,
      fraudFlags: session.validationFlags,
      finalReward: finalReward.toFixed(6),
      rewardPenalty: fraudPenalty.toFixed(4),
      message: session.fraudScore > 50 ? 
        'Session completed with high fraud score - reward reduced' :
        'Session completed successfully'
    });

  } catch (error) {
    console.error('End session error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to end session' 
    });
  }
});

/**
 * GET /api/mining/active-session
 * Get current active session details
 */
router.get('/active-session', async (req, res) => {
  try {
    await new Promise((resolve, reject) => {
      authenticate(req, res, (err) => err ? reject(err) : resolve());
    });

    const userId = req.user.userId;
    const session = await MiningSession.findOne({ 
      userId, 
      status: 'active' 
    });

    if (!session) {
      return res.json({
        success: true,
        session: null,
        message: 'No active session'
      });
    }

    // Calculate current pending reward
    const totalInteractions = session.totalClicks + session.totalSwipes + session.totalShakes;
    const pendingReward = totalInteractions * 0.001;

    res.json({
      success: true,
      session: {
        sessionId: session.sessionId,
        startTime: session.startTime,
        platform: session.platform,
        totalClicks: session.totalClicks,
        totalSwipes: session.totalSwipes,
        totalShakes: session.totalShakes,
        entropyGenerated: session.entropyGenerated,
        submissionCount: session.entropySubmissions.length,
        pendingReward: pendingReward.toFixed(6),
        fraudScore: session.fraudScore
      }
    });

  } catch (error) {
    console.error('Get active session error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to get active session' 
    });
  }
});

/**
 * GET /api/mining/stats
 * Get user mining statistics
 */
router.get('/stats', async (req, res) => {
  try {
    await new Promise((resolve, reject) => {
      authenticate(req, res, (err) => err ? reject(err) : resolve());
    });

    const userId = req.user.userId;
    const days = parseInt(req.query.days) || 30;

    const stats = await MiningSession.getUserStats(userId, days);

    res.json({
      success: true,
      stats: {
        ...stats,
        period: `Last ${days} days`
      }
    });

  } catch (error) {
    console.error('Get mining stats error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to get mining stats' 
    });
  }
});

/**
 * GET /api/mining/history
 * Get user's completed mining sessions
 */
router.get('/history', async (req, res) => {
  try {
    await new Promise((resolve, reject) => {
      authenticate(req, res, (err) => err ? reject(err) : resolve());
    });

    const userId = req.user.userId;
    const limit = parseInt(req.query.limit) || 20;
    const skip = parseInt(req.query.skip) || 0;

    const sessions = await MiningSession.find({ 
      userId, 
      status: 'completed' 
    })
    .sort({ createdAt: -1 })
    .limit(limit)
    .skip(skip)
    .select('sessionId startTime endTime duration platform entropyGenerated rewardAmount fraudScore totalClicks totalSwipes totalShakes');

    const total = await MiningSession.countDocuments({ 
      userId, 
      status: 'completed' 
    });

    res.json({
      success: true,
      sessions,
      pagination: {
        total,
        limit,
        skip,
        hasMore: (skip + limit) < total
      }
    });

  } catch (error) {
    console.error('Get mining history error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to get mining history' 
    });
  }
});

module.exports = { router, setupMiningRoutes };
