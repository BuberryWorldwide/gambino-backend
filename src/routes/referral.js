// backend/src/routes/referral.js
const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { authenticate } = require('../middleware/rbac');
const Referral = require('../models/Referral');

const router = express.Router();

// Rate limiting for referral validation (prevent enumeration)
const validateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // 30 attempts per IP
  message: { error: 'Too many validation attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiting for referral creation (prevent abuse)
const createLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 5, // 5 referrals per IP per day
  keyGenerator: (req) => req.ip,
  message: { error: 'Daily referral limit reached. Try again tomorrow.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiting for code regeneration (once per week)
const regenerateLimiter = rateLimit({
  windowMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  max: 1, // 1 regeneration per week
  keyGenerator: (req) => req.user?.userId || req.ip,
  message: { error: 'You can only regenerate your code once per week.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Generate a unique referral code
 */
function generateReferralCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Excluded confusing chars: I, O, 0, 1
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

/**
 * Hash IP address for privacy while still enabling abuse detection
 */
function hashIP(ip) {
  return crypto.createHash('sha256').update(ip + (process.env.IP_SALT || 'gambino')).digest('hex').slice(0, 16);
}

/**
 * Create referral routes with User model dependency
 */
function createReferralRoutes(User) {
  /**
   * POST /api/referral/validate
   * Validate a referral code (public endpoint)
   */
  router.post('/validate', validateLimiter, async (req, res) => {
    try {
      const { code } = req.body;

      if (!code || code.length < 6) {
        return res.status(400).json({
          valid: false,
          error: 'Invalid code format'
        });
      }

      const normalizedCode = code.toUpperCase().trim();

      const referrer = await User.findOne({
        referralCode: normalizedCode,
        isActive: true,
        isVerified: true
      }).select('firstName tier referralCode');

      if (!referrer) {
        return res.status(404).json({
          valid: false,
          error: 'Referral code not found'
        });
      }

      // Calculate rewards based on referrer's tier
      const rewards = Referral.calculateRewards(referrer.tier);

      console.log('✅ Referral code validated:', {
        code: normalizedCode,
        referrerId: referrer._id,
        tier: referrer.tier,
        timestamp: new Date()
      });

      return res.json({
        valid: true,
        referrer: {
          firstName: referrer.firstName,
          tier: referrer.tier
        },
        rewards: {
          newUser: rewards.newUser,
          total: rewards.referrer + rewards.newUser + rewards.venue
        }
      });
    } catch (error) {
      console.error('❌ Referral validation error:', error);
      return res.status(500).json({
        valid: false,
        error: 'Validation failed'
      });
    }
  });

  /**
   * GET /api/referral/stats
   * Get current user's referral statistics (authenticated)
   */
  router.get('/stats', authenticate, async (req, res) => {
    try {
      const userId = req.user.userId;

      // Get user's referral code
      const user = await User.findById(userId)
        .select('referralCode tier');

      if (!user) {
        return res.status(404).json({
          error: 'User not found'
        });
      }

      // Get referral statistics
      const stats = await Referral.getUserStats(userId);

      console.log('📊 Referral stats fetched:', {
        userId,
        totalReferrals: stats.totalReferrals,
        timestamp: new Date()
      });

      return res.json({
        code: user.referralCode,
        tier: user.tier,
        totalReferrals: stats.totalReferrals,
        pendingReferrals: stats.pendingReferrals,
        verifiedReferrals: stats.verifiedReferrals + stats.distributedReferrals,
        monthlyReferrals: stats.monthlyReferrals,
        totalRewards: stats.totalRewards
      });
    } catch (error) {
      console.error('❌ Referral stats error:', error);
      return res.status(500).json({
        error: 'Failed to fetch referral statistics'
      });
    }
  });

  /**
   * GET /api/referral/history
   * Get user's referral history (authenticated)
   */
  router.get('/history', authenticate, async (req, res) => {
    try {
      const userId = req.user.userId;
      const { page = 1, limit = 20 } = req.query;

      const pageNum = parseInt(page, 10);
      const limitNum = Math.min(parseInt(limit, 10), 100); // Max 100 per page

      const referrals = await Referral.find({ referrerId: userId })
        .populate('newUserId', 'firstName createdAt')
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean();

      const total = await Referral.countDocuments({ referrerId: userId });

      const formattedReferrals = referrals.map(r => ({
        id: r._id,
        newUserName: r.newUserId?.firstName || 'Anonymous',
        status: r.status,
        rewardAmount: r.amounts?.referrer || 0,
        source: r.source,
        createdAt: r.createdAt,
        distributedAt: r.distributedAt,
        firstSessionAt: r.firstSessionAt
      }));

      console.log('📜 Referral history fetched:', {
        userId,
        count: formattedReferrals.length,
        page: pageNum,
        timestamp: new Date()
      });

      return res.json({
        referrals: formattedReferrals,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total,
          pages: Math.ceil(total / limitNum)
        }
      });
    } catch (error) {
      console.error('❌ Referral history error:', error);
      return res.status(500).json({
        error: 'Failed to fetch referral history'
      });
    }
  });

  /**
   * GET /api/referral/leaderboard
   * Get referral leaderboard (public)
   */
  router.get('/leaderboard', async (req, res) => {
    try {
      const { timeframe = 'all' } = req.query;

      // Validate timeframe
      if (!['all', 'month', 'week'].includes(timeframe)) {
        return res.status(400).json({
          error: 'Invalid timeframe. Use: all, month, or week'
        });
      }

      const leaderboard = await Referral.getLeaderboard({
        timeframe,
        limit: 50
      });

      console.log('🏆 Referral leaderboard fetched:', {
        timeframe,
        count: leaderboard.length,
        timestamp: new Date()
      });

      return res.json({
        leaderboard,
        timeframe
      });
    } catch (error) {
      console.error('❌ Referral leaderboard error:', error);
      return res.status(500).json({
        error: 'Failed to fetch leaderboard'
      });
    }
  });

  /**
   * POST /api/referral/track-share
   * Track referral share event for analytics (authenticated)
   */
  router.post('/track-share', authenticate, async (req, res) => {
    try {
      const userId = req.user.userId;
      const { platform } = req.body;

      // Valid platforms
      const validPlatforms = ['copy', 'native', 'twitter', 'telegram', 'qr', 'other'];

      if (!platform || !validPlatforms.includes(platform)) {
        return res.status(400).json({
          error: 'Invalid platform'
        });
      }

      // Log share event (could be stored in analytics collection later)
      console.log('📤 Referral share tracked:', {
        userId,
        platform,
        timestamp: new Date(),
        ip: req.ip
      });

      return res.json({
        success: true,
        message: 'Share event tracked'
      });
    } catch (error) {
      console.error('❌ Track share error:', error);
      return res.status(500).json({
        error: 'Failed to track share event'
      });
    }
  });

  /**
   * POST /api/referral/regenerate
   * Regenerate user's referral code (authenticated, rate limited)
   */
  router.post('/regenerate', authenticate, regenerateLimiter, async (req, res) => {
    try {
      const userId = req.user.userId;

      // Find the user
      const user = await User.findById(userId);
      if (!user) {
        return res.status(404).json({
          error: 'User not found'
        });
      }

      const oldCode = user.referralCode;

      // Generate a new unique code
      let newCode;
      let attempts = 0;
      const maxAttempts = 10;

      while (attempts < maxAttempts) {
        newCode = generateReferralCode();
        const existing = await User.findOne({ referralCode: newCode });
        if (!existing) break;
        attempts++;
      }

      if (attempts >= maxAttempts) {
        return res.status(500).json({
          error: 'Failed to generate unique code. Please try again.'
        });
      }

      // Update user's referral code
      user.referralCode = newCode;
      await user.save();

      console.log('🔄 Referral code regenerated:', {
        userId,
        oldCode,
        newCode,
        timestamp: new Date()
      });

      return res.json({
        success: true,
        code: newCode,
        message: 'Referral code regenerated successfully'
      });
    } catch (error) {
      console.error('❌ Regenerate code error:', error);
      return res.status(500).json({
        error: 'Failed to regenerate referral code'
      });
    }
  });

  /**
   * POST /api/referral/apply
   * Apply referral code during registration (called by registration endpoint)
   * This is an internal helper, not directly exposed
   */
  router.applyReferral = async function(newUserId, referralCode, options = {}) {
    try {
      const { venueId, ipAddress, source = 'link' } = options;

      if (!referralCode) {
        return { success: false, error: 'No referral code provided' };
      }

      const normalizedCode = referralCode.toUpperCase().trim();

      // Find referrer
      const referrer = await User.findOne({
        referralCode: normalizedCode,
        isActive: true,
        isVerified: true
      }).select('_id tier referrals firstName');

      if (!referrer) {
        return { success: false, error: 'Invalid referral code' };
      }

      // Prevent self-referral
      if (referrer._id.toString() === newUserId.toString()) {
        return { success: false, error: 'Cannot use own referral code' };
      }

      // Check if user already has a referral
      const existingReferral = await Referral.findOne({ newUserId });
      if (existingReferral) {
        return { success: false, error: 'User already has a referral' };
      }

      // Calculate rewards based on referrer's tier
      const rewards = Referral.calculateRewards(referrer.tier);

      // Create referral record
      const referral = await Referral.create({
        referrerId: referrer._id,
        newUserId,
        venueId,
        referralCode: normalizedCode,
        referrerTier: referrer.tier,
        amounts: rewards,
        source,
        ipAddress: ipAddress ? hashIP(ipAddress) : undefined,
        status: 'pending'
      });

      // Update referrer's referrals array
      await User.findByIdAndUpdate(referrer._id, {
        $push: { referrals: newUserId }
      });

      // Update new user's referredBy field
      await User.findByIdAndUpdate(newUserId, {
        referredBy: referrer._id
      });

      console.log('✅ Referral applied:', {
        referralId: referral._id,
        referrerId: referrer._id,
        newUserId,
        rewards,
        timestamp: new Date()
      });

      return {
        success: true,
        referralId: referral._id,
        referrer: {
          firstName: referrer.firstName,
          tier: referrer.tier
        },
        rewards
      };
    } catch (error) {
      console.error('❌ Apply referral error:', error);
      return { success: false, error: 'Failed to apply referral' };
    }
  };

  /**
   * POST /api/referral/verify-session
   * Called when a referred user completes their first session
   * This triggers eligibility for reward distribution
   */
  router.verifySession = async function(userId) {
    try {
      // Find pending referral for this user
      const referral = await Referral.findOne({
        newUserId: userId,
        status: { $in: ['pending', 'pending_budget'] }
      });

      if (!referral) {
        return { success: false, error: 'No pending referral found' };
      }

      // Mark first session completed
      referral.firstSessionAt = new Date();
      referral.status = 'verified';
      await referral.save();

      console.log('✅ Referral verified (first session):', {
        referralId: referral._id,
        newUserId: userId,
        timestamp: new Date()
      });

      return {
        success: true,
        referralId: referral._id,
        message: 'Referral verified, distribution queued'
      };
    } catch (error) {
      console.error('❌ Verify session error:', error);
      return { success: false, error: 'Failed to verify session' };
    }
  };

  /**
   * GET /api/referral/budget-status
   * Get current month's budget status (admin only)
   */
  router.get('/budget-status', authenticate, async (req, res) => {
    try {
      // Only allow admin roles
      if (!['super_admin', 'gambino_ops'].includes(req.user.role)) {
        return res.status(403).json({
          error: 'Admin access required'
        });
      }

      const usage = await Referral.getMonthlyBudgetUsage();

      // TODO: Get actual pool balance from blockchain
      const communityPoolBalance = 33965000; // Placeholder
      const monthlyBudget = communityPoolBalance * 0.005;
      const remaining = monthlyBudget - usage.totalDistributed;

      return res.json({
        communityPoolBalance,
        monthlyBudget,
        totalDistributed: usage.totalDistributed,
        remaining,
        referralCount: usage.referralCount,
        capacityUsed: ((usage.totalDistributed / monthlyBudget) * 100).toFixed(1) + '%'
      });
    } catch (error) {
      console.error('❌ Budget status error:', error);
      return res.status(500).json({
        error: 'Failed to fetch budget status'
      });
    }
  });

  return router;
}

module.exports = createReferralRoutes;
