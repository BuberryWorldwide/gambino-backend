// backend/src/services/MiningService.js
const MiningSession = require('../models/MiningSession');
const EscrowBalance = require('../models/EscrowBalance');
const MobileCredit = require('../models/MobileCredit');
const User = require('../models/User');

class MiningService {
  constructor(gambinoTokenService) {
    this.gambinoTokenService = gambinoTokenService;
    
    // Mining reward configuration
    this.REWARD_CONFIG = {
      BASE_RATE: 0.01, // GG per click
      CLICK_MULTIPLIER: 1.0,
      SWIPE_MULTIPLIER: 1.5,
      SHAKE_MULTIPLIER: 2.0,
      
      // Tier bonuses
      TIER_BONUS: {
        none: 1.0,
        tier3: 1.1,
        tier2: 1.25,
        tier1: 1.5
      },
      
      // Credit cost per mining session
      CREDIT_COST_PER_SESSION: 1,
      
      // Session limits
      MAX_SESSION_DURATION: 3600, // 1 hour in seconds
      MIN_SESSION_DURATION: 30, // 30 seconds
      
      // Anti-bot thresholds
      MAX_FRAUD_SCORE: 50,
      
      // Jackpot mechanics
      JACKPOT_CHANCE: 0.001, // 0.1% chance per session
      JACKPOT_MIN: 100,
      JACKPOT_MAX: 1000
    };
  }
  
  /**
   * Start a new mining session
   */
  async startSession(userId, deviceData) {
    try {
      // Check for existing active session
      const existing = await MiningSession.getActiveSession(userId);
      if (existing) {
        throw new Error('Active session already exists');
      }
      
      // Check credits
      const escrow = await EscrowBalance.getOrCreate(userId);
      if (escrow.playableCredits < this.REWARD_CONFIG.CREDIT_COST_PER_SESSION) {
        throw new Error('Insufficient credits');
      }
      
      // Deduct credits
      await escrow.useCredits(this.REWARD_CONFIG.CREDIT_COST_PER_SESSION);
      
      // Record credit usage
      const session = new MiningSession({
        userId,
        deviceFingerprint: deviceData.fingerprint,
        platform: deviceData.platform,
        appVersion: deviceData.appVersion,
        ipAddress: deviceData.ipAddress,
        userAgent: deviceData.userAgent,
        status: 'active',
        creditsUsed: this.REWARD_CONFIG.CREDIT_COST_PER_SESSION
      });
      
      await session.save();
      
      await MobileCredit.recordUsage(
        userId, 
        this.REWARD_CONFIG.CREDIT_COST_PER_SESSION, 
        session._id
      );
      
      return {
        success: true,
        sessionId: session.sessionId,
        session: session.toObject()
      };
      
    } catch (error) {
      console.error('Start session error:', error);
      throw error;
    }
  }
  
  /**
   * Submit entropy data to active session
   */
  async submitEntropy(userId, sessionId, entropyData) {
    try {
      const session = await MiningSession.findOne({ sessionId, userId, status: 'active' });
      
      if (!session) {
        throw new Error('Active session not found');
      }
      
      // Validate session duration
      const duration = (Date.now() - session.startTime) / 1000;
      if (duration > this.REWARD_CONFIG.MAX_SESSION_DURATION) {
        await this.endSession(userId, sessionId, 'timeout');
        throw new Error('Session expired');
      }
      
      // Add entropy submission
      await session.addEntropySubmission({
        timestamp: new Date(),
        clickCount: entropyData.clicks || 0,
        swipeCount: entropyData.swipes || 0,
        shakeCount: entropyData.shakes || 0,
        pattern: entropyData.pattern,
        deviceData: entropyData.deviceData
      });
      
      return {
        success: true,
        totalEntropy: session.entropyGenerated,
        currentReward: this.calculatePendingReward(session)
      };
      
    } catch (error) {
      console.error('Submit entropy error:', error);
      throw error;
    }
  }
  
  /**
   * End mining session and calculate rewards
   */
  async endSession(userId, sessionId, reason = 'user_ended') {
    try {
      const session = await MiningSession.findOne({ sessionId, userId });
      
      if (!session) {
        throw new Error('Session not found');
      }
      
      if (session.status !== 'active') {
        throw new Error('Session already ended');
      }
      
      // Calculate fraud score
      const fraudScore = session.calculateFraudScore();
      
      // Check if session is valid
      const duration = (Date.now() - session.startTime) / 1000;
      if (duration < this.REWARD_CONFIG.MIN_SESSION_DURATION) {
        await session.endSession(0);
        return {
          success: false,
          reason: 'Session too short',
          reward: 0
        };
      }
      
      if (fraudScore > this.REWARD_CONFIG.MAX_FRAUD_SCORE) {
        await session.endSession(0);
        return {
          success: false,
          reason: 'Suspicious activity detected',
          reward: 0,
          fraudScore
        };
      }
      
      // Calculate reward
      const user = await User.findById(userId);
      const reward = this.calculateReward(session, user);
      
      // Check for jackpot
      const jackpot = this.checkJackpot();
      const totalReward = reward + jackpot;
      
      // End session
      await session.endSession(totalReward);
      
      // Add to escrow as pending
      const escrow = await EscrowBalance.getOrCreate(userId);
      await escrow.addPendingReward(totalReward);
      
      // Update user stats
      user.gluckScore = (user.gluckScore || 0) + Math.floor(session.entropyGenerated / 100);
      await user.save();
      
      return {
        success: true,
        reward: totalReward,
        breakdown: {
          baseReward: reward,
          jackpot,
          totalEntropy: session.entropyGenerated,
          duration: session.duration,
          fraudScore
        },
        session: session.toObject()
      };
      
    } catch (error) {
      console.error('End session error:', error);
      throw error;
    }
  }
  
  /**
   * Calculate reward based on entropy and user tier
   */
  calculateReward(session, user) {
    const clicks = session.totalClicks * this.REWARD_CONFIG.CLICK_MULTIPLIER;
    const swipes = session.totalSwipes * this.REWARD_CONFIG.SWIPE_MULTIPLIER;
    const shakes = session.totalShakes * this.REWARD_CONFIG.SHAKE_MULTIPLIER;
    
    const totalWeightedEntropy = clicks + swipes + shakes;
    
    let reward = totalWeightedEntropy * this.REWARD_CONFIG.BASE_RATE;
    
    // Apply tier bonus
    const tierBonus = this.REWARD_CONFIG.TIER_BONUS[user.tier || 'none'];
    reward *= tierBonus;
    
    // Round to 2 decimals
    return Math.round(reward * 100) / 100;
  }
  
  /**
   * Calculate pending reward without ending session
   */
  calculatePendingReward(session) {
    const clicks = session.totalClicks * this.REWARD_CONFIG.CLICK_MULTIPLIER;
    const swipes = session.totalSwipes * this.REWARD_CONFIG.SWIPE_MULTIPLIER;
    const shakes = session.totalShakes * this.REWARD_CONFIG.SHAKE_MULTIPLIER;
    
    const totalWeightedEntropy = clicks + swipes + shakes;
    const reward = totalWeightedEntropy * this.REWARD_CONFIG.BASE_RATE;
    
    return Math.round(reward * 100) / 100;
  }
  
  /**
   * Random jackpot check
   */
  checkJackpot() {
    const random = Math.random();
    
    if (random < this.REWARD_CONFIG.JACKPOT_CHANCE) {
      const jackpot = Math.floor(
        Math.random() * 
        (this.REWARD_CONFIG.JACKPOT_MAX - this.REWARD_CONFIG.JACKPOT_MIN + 1) + 
        this.REWARD_CONFIG.JACKPOT_MIN
      );
      
      console.log(`🎰 JACKPOT HIT: ${jackpot} GG`);
      return jackpot;
    }
    
    return 0;
  }
  
  /**
   * Get user mining stats
   */
  async getUserStats(userId, days = 30) {
    const stats = await MiningSession.getUserStats(userId, days);
    const escrow = await EscrowBalance.getOrCreate(userId);
    const creditBalance = await MobileCredit.getUserBalance(userId);
    
    return {
      ...stats,
      escrowBalance: escrow.escrowGG,
      pendingBalance: escrow.pendingGG,
      availableCredits: creditBalance
    };
  }
  
  /**
   * Settle pending rewards to main escrow balance
   */
  async settlePendingRewards(userId) {
    try {
      const escrow = await EscrowBalance.getOrCreate(userId);
      
      if (escrow.pendingGG === 0) {
        return {
          success: false,
          message: 'No pending rewards to settle'
        };
      }
      
      const amount = escrow.pendingGG;
      await escrow.settlePendingReward(amount);
      
      return {
        success: true,
        settled: amount,
        newBalance: escrow.escrowGG
      };
      
    } catch (error) {
      console.error('Settle rewards error:', error);
      throw error;
    }
  }
}

module.exports = MiningService;