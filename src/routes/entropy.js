// backend/src/routes/entropy.js
// Entropy work verification API

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const mongoose = require('mongoose');

// Dependencies will be injected from server.js
let authenticate, redisClient, User, EntropySession;

/**
 * Setup function - Call this from server.js to inject dependencies
 */
function setupEntropyRoutes(deps) {
  authenticate = deps.authenticate;
  redisClient = deps.redisClient;
  User = deps.User;
  EntropySession = deps.EntropySession;
}

/**
 * POST /api/entropy/spin
 * Consume 1 click and return a random win/loss result
 * NOW ACCEPTS ENTROPY DATA
 */
router.post('/spin', (req, res, next) => {
  authenticate(req, res, async () => {
    try {
      const userId = req.user.userId;
      const { entropyData } = req.body;
      
      // Check if user has clicks available
      const user = await User.collection.findOne(
        { _id: new mongoose.Types.ObjectId(userId) }
      );
      
      if (!user.clicksAvailable || user.clicksAvailable < 1) {
        return res.status(400).json({
          success: false,
          error: 'No clicks available',
          clicksAvailable: user.clicksAvailable || 0
        });
      }
      
      // Store entropy data if provided
      let entropyBytesContributed = 0;
      if (entropyData) {
        // Calculate entropy contribution (rough estimate)
        const dataString = JSON.stringify(entropyData);
        entropyBytesContributed = new TextEncoder().encode(dataString).length;
        
        // Log for now (we'll add Redis pool storage next)
        console.log(`📊 User ${userId} contributed ${entropyBytesContributed} bytes of entropy`);
      }
      
      // Simple RNG - random number 0-100
      const roll = Math.random() * 100;
      
      // Win probabilities
      let outcome, payout, gluckBonus;
      
      if (roll < 0.01) {
        outcome = 'mega';
        payout = 10000;
        gluckBonus = 5000;
      } else if (roll < 0.1) {
        outcome = 'major';
        payout = 1000;
        gluckBonus = 1000;
      } else if (roll < 1) {
        outcome = 'big';
        payout = 100;
        gluckBonus = 100;
      } else if (roll < 10) {
        outcome = 'small';
        payout = 2;
        gluckBonus = 10;
      } else {
        outcome = 'loss';
        payout = 0;
        gluckBonus = 0;
      }
      
      // Update user: consume click, add payout and gluckScore
      // ALSO track entropy contribution
      const result = await User.collection.findOneAndUpdate(
        { _id: new mongoose.Types.ObjectId(userId) },
        { 
          $inc: { 
            clicksAvailable: -1,
            gambinoBalance: payout,
            gluckScore: gluckBonus,
            gamesPlayed: 1,
            totalWon: payout,
            totalEntropyContributed: entropyBytesContributed
          }
        },
        { returnDocument: 'after' }
      );
      
      const updatedUser = result.value || result;
      
      console.log(`🎰 User ${userId} spun: ${outcome} (roll: ${roll.toFixed(2)}, payout: ${payout}, entropy: ${entropyBytesContributed}b)`);
      
      res.json({
        success: true,
        outcome,
        payout,
        gluckBonus,
        roll: roll.toFixed(2),
        entropyContributed: entropyBytesContributed,
        clicksAvailable: updatedUser.clicksAvailable,
        gambinoBalance: updatedUser.gambinoBalance,
        gluckScore: updatedUser.gluckScore
      });
      
    } catch (error) {
      console.error('Spin error:', error);
      res.status(500).json({ 
        success: false,
        error: error.message 
      });
    }
  });
});

/**
 * POST /api/entropy/work/start
 * Start a new entropy mining round
 */
router.post('/work/start', (req, res, next) => {
  // Call authenticate middleware
  authenticate(req, res, async () => {
    try {
      const { gameId } = req.body;
      const userId = req.user.userId;

      if (!gameId) {
        return res.status(400).json({ error: 'gameId is required' });
      }

      // Generate round data
      const roundId = crypto.randomUUID();
      const serverSalt = crypto.randomBytes(32).toString('hex');
      const targetDifficulty = 1000;
      const windowMs = 20000;

      // Store round data in Redis
      const roundData = {
        userId,
        gameId,
        serverSalt,
        targetDifficulty,
        startedAt: Date.now()
      };

      await redisClient.setEx(
        `entropy:round:${roundId}`,
        60,
        JSON.stringify(roundData)
      );

      console.log(`✅ Started entropy round ${roundId} for user ${userId}`);

      res.json({
        roundId,
        serverSalt,
        targetDifficulty,
        windowMs
      });

    } catch (error) {
      console.error('Entropy start error:', error);
      res.status(500).json({ error: 'Failed to start round' });
    }
  });
});

/**
 * POST /api/entropy/work/reveal
 * Submit completed work for verification
 */
router.post('/work/reveal', (req, res, next) => {
  authenticate(req, res, async () => {
    try {
      const { roundId, trace, nonce, proofHash } = req.body;
      const userId = req.user.userId;

      // 1. Validate input
      if (!roundId || !trace || !nonce) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      // 2. Load round from Redis
      const roundDataStr = await redisClient.get(`entropy:round:${roundId}`);
      if (!roundDataStr) {
        return res.status(400).json({ error: 'Round expired or invalid' });
      }

      const roundData = JSON.parse(roundDataStr);

      // 3. Verify ownership
      if (roundData.userId !== userId) {
        return res.status(403).json({ error: 'Round ownership mismatch' });
      }

      // 4. Verify timing
      const elapsed = Date.now() - roundData.startedAt;
      if (elapsed > 30000) {
        return res.status(400).json({ error: 'Round timeout' });
      }

      // 5. Re-calculate entropy from trace
      const verification = verifyEntropy(trace, roundData);

      if (!verification.valid) {
        await EntropySession.create({
          userId,
          roundId,
          gameId: roundData.gameId,
          trace,
          entropyBits: 0,
          reward: 0,
          flags: verification.flags,
          status: 'rejected',
          timestamp: new Date()
        });

        return res.status(400).json({
          error: 'Invalid entropy',
          flags: verification.flags
        });
      }

      // 6. Calculate reward
      const baseReward = 10;
      const entropyBonus = Math.floor(verification.entropyBits * 5);
      const reward = baseReward + entropyBonus;

      // 7. Save to database
      await EntropySession.create({
        userId,
        roundId,
        gameId: roundData.gameId,
        trace,
        entropyBits: verification.entropyBits,
        reward,
        flags: verification.flags,
        status: 'completed',
        timestamp: new Date()
      });

      // 8. Update user balance
      const user = await User.findByIdAndUpdate(
        userId,
        { $inc: { gluckScore: reward } },
        { new: true }
      );

      // 9. Delete round from Redis
      await redisClient.del(`entropy:round:${roundId}`);

      console.log(`✅ Verified entropy round ${roundId}: ${verification.entropyBits.toFixed(2)} bits, reward: ${reward}`);

      res.json({
        success: true,
        reward,
        entropyBits: verification.entropyBits,
        balance: user.gluckScore,
        flags: verification.flags
      });

    } catch (error) {
      console.error('Entropy reveal error:', error);
      res.status(500).json({ error: 'Failed to submit work' });
    }
  });
});

/**
 * GET /api/entropy/user-stats
 * Get user's game stats (clicks, gold, gluckScore)
 */
router.get('/user-stats', (req, res, next) => {
  authenticate(req, res, async () => {
    try {
      const userId = req.user.userId;
      const user = await User.collection.findOne({ _id: new mongoose.Types.ObjectId(userId) });
      
      if (!user) {
        return res.status(404).json({ success: false, error: 'User not found' });
      }
      console.log("🐛 User doc:", { id: userId, entropy: user.totalEntropyContributed, clicks: user.clicksAvailable, gluck: user.gluckScore });

      res.json({
        success: true,
        clicksAvailable: user.clicksAvailable || 0,
        gambinoBalance: user.gambinoBalance || 0,
        gluckScore: user.gluckScore || 0,
        totalEntropyContributed: user.totalEntropyContributed || 0
      });
    } catch (error) {
      console.error('User stats error:', error);
      res.status(500).json({ success: false, error: 'Failed to load user stats' });
    }
  });
});

/**
 * GET /api/entropy/stats
 * Get user's entropy mining stats
 */
router.get('/stats', (req, res, next) => {
  authenticate(req, res, async () => {
    try {
      const userId = req.user.userId;

      const sessions = await EntropySession.find({ userId })
        .sort({ timestamp: -1 })
        .limit(10);

      const totalSessions = await EntropySession.countDocuments({ userId, status: 'completed' });
      const totalEntropy = await EntropySession.aggregate([
        { $match: { userId, status: 'completed' } },
        { $group: { _id: null, total: { $sum: '$entropyBits' } } }
      ]);

      res.json({
        recentSessions: sessions,
        totalSessions,
        totalEntropyBits: totalEntropy[0]?.total || 0
      });

    } catch (error) {
      console.error('Entropy stats error:', error);
      res.status(500).json({ error: 'Failed to load stats' });
    }
  });
});

/**
 * POST /api/entropy/test/give-clicks
 * Give user free test clicks (DEVELOPMENT ONLY)
 */
router.post('/test/give-clicks', (req, res, next) => {
  authenticate(req, res, async () => {
    try {
      const userId = req.user.userId;
      
      // Use raw MongoDB to bypass Mongoose schema caching
      const result = await User.collection.findOneAndUpdate(
        { _id: new mongoose.Types.ObjectId(userId) },
        { $inc: { clicksAvailable: 100 } },
        { returnDocument: 'after' }
      );
      
      const user = result.value || result;
      
      console.log(`✅ Gave 100 test clicks to user ${userId}, total: ${user.clicksAvailable}`);
      
      res.json({
        success: true,
        message: 'Added 100 test clicks!',
        clicksAvailable: user.clicksAvailable || 0,
        gambinoBalance: user.gambinoBalance || 0,
        gluckScore: user.gluckScore || 0
      });
      
    } catch (error) {
      console.error('Error giving test clicks:', error);
      res.status(500).json({ 
        success: false,
        error: error.message 
      });
    }
  });
});

/**
 * Verify entropy from trace data
 * Server-side re-calculation to prevent cheating
 */
function verifyEntropy(trace, roundData) {
  const flags = [];
  
  // 1. Check minimum taps
  if (trace.tapCount < 12) {
    flags.push('insufficient_taps');
    return { valid: false, flags, entropyBits: 0 };
  }

  // 2. Re-calculate entropy from histogram
  let totalCount = 0;
  let maxCount = 0;

  for (const [bin, count] of Object.entries(trace.histogram)) {
    totalCount += count;
    maxCount = Math.max(maxCount, count);
  }

  if (totalCount === 0) {
    flags.push('invalid_histogram');
    return { valid: false, flags, entropyBits: 0 };
  }

  // 3. Calculate min-entropy: -log2(p_max)
  const pMax = maxCount / totalCount;
  let temporalEntropy = pMax >= 1 ? 0 : -Math.log2(pMax);

  // 4. Check for bot patterns
  if (pMax > 0.8) {
    flags.push('low_variance');
  }

  if (Object.keys(trace.histogram).length < 3) {
    flags.push('regular_pattern');
  }

  // 5. Cap entropy per tap
  const maxTapEntropy = 1.2;
  temporalEntropy = Math.min(temporalEntropy, maxTapEntropy);

  // 6. Total entropy
  const entropyBits = temporalEntropy * trace.tapCount;

  // 7. Final validation
  const valid = flags.length === 0 && entropyBits > 0;

  return {
    valid,
    entropyBits,
    flags
  };
}

module.exports = { router, setupEntropyRoutes };