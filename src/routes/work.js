// backend/routes/work.js
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { authMiddleware } = require('../middleware/auth');
const User = require('../models/User');
const WorkSession = require('../models/WorkSession');

/**
 * POST /api/work/start
 * Initialize a new entropy mining round
 */
router.post('/start', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Generate round parameters
    const roundId = crypto.randomBytes(16).toString('hex');
    const serverSalt = crypto.randomBytes(32).toString('hex');
    
    // Difficulty target (lower = harder)
    // Start with easy difficulty for MVP
    const target = '0000ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
    const windowMs = 20000; // 20 seconds
    
    // Store round in database (with TTL)
    const session = new WorkSession({
      roundId,
      userId,
      serverSalt,
      target,
      windowMs,
      status: 'started',
      startedAt: new Date(),
      expiresAt: new Date(Date.now() + windowMs + 10000) // +10s grace period
    });
    
    await session.save();
    
    res.json({
      round_id: roundId,
      server_salt: serverSalt,
      target: target,
      window_ms: windowMs
    });
    
  } catch (error) {
    console.error('Work start error:', error);
    res.status(500).json({ success: false, message: 'Failed to start round' });
  }
});

/**
 * POST /api/work/reveal
 * Submit completed entropy work for verification
 */
router.post('/reveal', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { roundId, trace, entropyBits, nonce, payloadHash } = req.body;
    
    // Validate input
    if (!roundId || !trace || entropyBits === undefined || nonce === undefined) {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing required fields' 
      });
    }
    
    // Find round session
    const session = await WorkSession.findOne({ roundId, userId });
    
    if (!session) {
      return res.status(404).json({ 
        success: false, 
        message: 'Round not found' 
      });
    }
    
    if (session.status !== 'started') {
      return res.status(400).json({ 
        success: false, 
        message: 'Round already completed or expired' 
      });
    }
    
    // Check if round expired
    if (new Date() > session.expiresAt) {
      session.status = 'expired';
      await session.save();
      return res.status(400).json({ 
        success: false, 
        message: 'Round expired' 
      });
    }
    
    // Verify proof-of-work
    const computedHash = crypto
      .createHash('sha256')
      .update(payloadHash + nonce.toString())
      .digest('hex');
    
    const hashValue = BigInt('0x' + computedHash);
    const targetValue = BigInt('0x' + session.target);
    
    if (hashValue >= targetValue) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid proof-of-work' 
      });
    }
    
    // Re-verify entropy from trace
    const verifiedBits = verifyEntropyTrace(trace);
    
    if (verifiedBits < 10) { // Minimum threshold
      return res.status(400).json({ 
        success: false, 
        message: 'Insufficient entropy quality' 
      });
    }
    
    // Detect bot patterns
    const botFlags = detectBotPatterns(trace);
    if (botFlags.length > 2) {
      return res.status(400).json({ 
        success: false, 
        message: `Bot detected: ${botFlags.join(', ')}` 
      });
    }
    
    // Calculate reward
    const baseReward = 10; // Base GGC per round
    const difficultyMultiplier = 1.0; // Could scale with difficulty
    const entropyMultiplier = Math.min(verifiedBits / 15, 1.2); // Bonus for high entropy
    
    const reward = Math.floor(baseReward * difficultyMultiplier * entropyMultiplier);
    
    // Update user balance
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found' 
      });
    }
    
    user.gambinoBalance = (user.gambinoBalance || 0) + reward;
    user.totalEntropyMined = (user.totalEntropyMined || 0) + verifiedBits;
    user.totalRoundsCompleted = (user.totalRoundsCompleted || 0) + 1;
    
    await user.save();
    
    // Update session
    session.status = 'completed';
    session.entropyBitsClient = entropyBits;
    session.entropyBitsVerified = verifiedBits;
    session.reward = reward;
    session.completedAt = new Date();
    session.botFlags = botFlags;
    
    await session.save();
    
    res.json({
      success: true,
      reward: reward,
      balance: user.gambinoBalance,
      verified_bits: verifiedBits,
      message: botFlags.length > 0 ? `Warnings: ${botFlags.join(', ')}` : undefined
    });
    
  } catch (error) {
    console.error('Work reveal error:', error);
    res.status(500).json({ success: false, message: 'Failed to verify work' });
  }
});

/**
 * GET /api/work/stats
 * Get player statistics
 */
router.get('/stats', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await User.findById(userId);
    
    const completedSessions = await WorkSession.countDocuments({
      userId,
      status: 'completed'
    });
    
    const totalEntropy = user.totalEntropyMined || 0;
    const totalRewards = await WorkSession.aggregate([
      { $match: { userId: user._id, status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$reward' } } }
    ]);
    
    res.json({
      balance: user.gambinoBalance || 0,
      totalRounds: user.totalRoundsCompleted || 0,
      totalEntropy: totalEntropy.toFixed(2),
      totalRewards: totalRewards[0]?.total || 0,
      averageEntropyPerRound: completedSessions > 0 
        ? (totalEntropy / completedSessions).toFixed(2)
        : 0
    });
    
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch stats' });
  }
});

/**
 * GET /api/work/leaderboard
 * Get top miners
 */
router.get('/leaderboard', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    
    const topMiners = await User.find({ totalEntropyMined: { $gt: 0 } })
      .sort({ totalEntropyMined: -1 })
      .limit(limit)
      .select('username totalEntropyMined totalRoundsCompleted');
    
    res.json(topMiners.map((user, index) => ({
      rank: index + 1,
      username: user.username,
      totalEntropy: user.totalEntropyMined.toFixed(2),
      totalRounds: user.totalRoundsCompleted
    })));
    
  } catch (error) {
    console.error('Leaderboard error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch leaderboard' });
  }
});

// Helper functions

/**
 * Verify entropy trace and compute min-entropy
 */
function verifyEntropyTrace(trace) {
  const taps = trace.taps || [];
  
  if (taps.length < 12) return 0;
  
  // Compute ITIs
  const itis = [];
  for (let i = 1; i < taps.length; i++) {
    const iti = (taps[i].ts - taps[i - 1].ts) / 1000; // Convert to ms
    if (iti > 0 && iti < 3000) {
      itis.push(Math.floor(iti));
    }
  }
  
  if (itis.length === 0) return 0;
  
  // Quantize into bins
  const binSize = 15;
  const histogram = {};
  
  for (const iti of itis) {
    const bin = Math.floor(iti / binSize);
    histogram[bin] = (histogram[bin] || 0) + 1;
  }
  
  // Find most frequent bin
  const maxCount = Math.max(...Object.values(histogram));
  const pMax = maxCount / itis.length;
  
  // Min-entropy: -log2(pMax)
  const minEntropy = -Math.log2(pMax);
  const totalBits = minEntropy * itis.length;
  
  // Cap per-tap contribution
  const bitsPerTap = totalBits / itis.length;
  const cappedBitsPerTap = Math.min(Math.max(bitsPerTap, 0.8), 1.2);
  
  return cappedBitsPerTap * itis.length;
}

/**
 * Detect bot patterns
 */
function detectBotPatterns(trace) {
  const flags = [];
  const taps = trace.taps || [];
  
  if (taps.length < 2) return flags;
  
  // Compute ITIs
  const itis = [];
  for (let i = 1; i < taps.length; i++) {
    const iti = (taps[i].ts - taps[i - 1].ts) / 1000;
    itis.push(iti);
  }
  
  // Check for zero variance
  const uniqueItis = new Set(itis.map(i => Math.floor(i)));
  if (uniqueItis.size === 1) {
    flags.push('ZERO_VARIANCE');
  }
  
  // Check for monotonic pattern
  let increasing = 0;
  let decreasing = 0;
  for (let i = 1; i < itis.length; i++) {
    if (itis[i] > itis[i - 1]) increasing++;
    if (itis[i] < itis[i - 1]) decreasing++;
  }
  const monotonic = (increasing / itis.length > 0.9) || (decreasing / itis.length > 0.9);
  if (monotonic) {
    flags.push('STAIRCASE_PATTERN');
  }
  
  // Check for suspiciously low variance
  const mean = itis.reduce((a, b) => a + b, 0) / itis.length;
  const variance = itis.reduce((sum, iti) => sum + Math.pow(iti - mean, 2), 0) / itis.length;
  
  if (variance < 10) {
    flags.push('LOW_VARIANCE');
  }
  
  return flags;
}

module.exports = router;