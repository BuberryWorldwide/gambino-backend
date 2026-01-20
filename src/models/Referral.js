// backend/src/models/Referral.js
const mongoose = require('mongoose');

/**
 * Referral Model
 * Tracks referral relationships, status, and reward distributions
 *
 * Status Flow:
 * pending -> verified -> distributed
 * pending -> pending_budget -> distributed (if monthly budget exhausted)
 * pending -> clawed_back (if new user doesn't complete first session in 14 days)
 * pending -> rejected (if abuse detected)
 */
const referralSchema = new mongoose.Schema({
  // Participants
  referrerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  newUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true  // Each user can only be referred once
  },
  venueId: {
    type: String,  // storeId where referral occurred
    index: true
  },

  // Status tracking
  status: {
    type: String,
    enum: ['pending', 'pending_budget', 'verified', 'distributed', 'clawed_back', 'rejected'],
    default: 'pending',
    index: true
  },

  // Reward amounts (calculated based on referrer tier at time of referral)
  amounts: {
    referrer: { type: Number, default: 0 },
    newUser: { type: Number, default: 0 },
    venue: { type: Number, default: 0 }
  },
  referrerTier: {
    type: String,
    enum: ['none', 'tier3', 'tier2', 'tier1', 'bronze', 'silver', 'gold'],
    default: 'none'
  },

  // Distribution tracking
  distributedAt: Date,
  txSignatures: {
    referrer: String,  // Solana tx signature for referrer payment
    newUser: String,   // Solana tx signature for new user payment
    venue: String      // Solana tx signature for venue payment
  },

  // Verification requirements
  firstSessionAt: Date,      // When new user completed first session
  kycCompletedAt: Date,      // When new user completed KYC

  // Clawback tracking
  clawbackReason: String,
  clawbackAt: Date,
  clawbackTxSignature: String,

  // Rejection tracking
  rejectionReason: String,
  rejectedAt: Date,

  // Metadata
  referralCode: String,  // The code used
  ipAddress: String,     // For abuse detection (hashed)
  deviceFingerprint: String,
  source: {              // Where the referral came from
    type: String,
    enum: ['qr', 'link', 'social', 'direct'],
    default: 'link'
  },

  // Budget queue tracking
  queuedAt: Date,        // When added to pending_budget queue
  queuePosition: Number, // Position in queue for next month

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, {
  timestamps: true
});

// Indexes for common queries
referralSchema.index({ status: 1, createdAt: -1 });
referralSchema.index({ referrerId: 1, status: 1 });
referralSchema.index({ referrerId: 1, createdAt: -1 });
referralSchema.index({ venueId: 1, status: 1 });
referralSchema.index({ createdAt: -1 });
referralSchema.index({ queuedAt: 1, queuePosition: 1 });

// Pre-save hook
referralSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

/**
 * Calculate rewards based on referrer tier
 * Tiers map to framework:
 * - gold/tier1: 350/100/50 = 500 total
 * - silver/tier2: 300/100/50 = 450 total
 * - bronze/tier3: 250/100/50 = 400 total
 * - none: 150/100/50 = 300 total
 */
referralSchema.statics.calculateRewards = function(tier) {
  const tierMap = {
    'gold': { referrer: 350, newUser: 100, venue: 50 },
    'tier1': { referrer: 350, newUser: 100, venue: 50 },
    'silver': { referrer: 300, newUser: 100, venue: 50 },
    'tier2': { referrer: 300, newUser: 100, venue: 50 },
    'bronze': { referrer: 250, newUser: 100, venue: 50 },
    'tier3': { referrer: 250, newUser: 100, venue: 50 },
    'none': { referrer: 150, newUser: 100, venue: 50 }
  };
  return tierMap[tier?.toLowerCase()] || tierMap.none;
};

/**
 * Get total reward amount for a referral
 */
referralSchema.methods.getTotalReward = function() {
  return (this.amounts.referrer || 0) + (this.amounts.newUser || 0) + (this.amounts.venue || 0);
};

/**
 * Check if referral is eligible for distribution
 * Requires: first session completed within 14 days
 */
referralSchema.methods.isEligibleForDistribution = function() {
  if (this.status !== 'pending' && this.status !== 'pending_budget') {
    return false;
  }

  // Must have completed first session
  if (!this.firstSessionAt) {
    return false;
  }

  // Check 14-day window
  const daysSinceCreation = (Date.now() - this.createdAt.getTime()) / (1000 * 60 * 60 * 24);
  if (daysSinceCreation > 14 && !this.firstSessionAt) {
    return false;
  }

  return true;
};

/**
 * Check if referral should be clawed back
 */
referralSchema.methods.shouldClawback = function() {
  if (this.status !== 'pending') {
    return false;
  }

  const daysSinceCreation = (Date.now() - this.createdAt.getTime()) / (1000 * 60 * 60 * 24);
  return daysSinceCreation > 14 && !this.firstSessionAt;
};

/**
 * Get referral statistics for a user
 */
referralSchema.statics.getUserStats = async function(userId) {
  const stats = await this.aggregate([
    { $match: { referrerId: new mongoose.Types.ObjectId(userId) } },
    {
      $group: {
        _id: null,
        totalReferrals: { $sum: 1 },
        pendingReferrals: {
          $sum: { $cond: [{ $in: ['$status', ['pending', 'pending_budget']] }, 1, 0] }
        },
        verifiedReferrals: {
          $sum: { $cond: [{ $eq: ['$status', 'verified'] }, 1, 0] }
        },
        distributedReferrals: {
          $sum: { $cond: [{ $eq: ['$status', 'distributed'] }, 1, 0] }
        },
        totalRewards: {
          $sum: {
            $cond: [
              { $eq: ['$status', 'distributed'] },
              '$amounts.referrer',
              0
            ]
          }
        }
      }
    }
  ]);

  // Get this month's count
  const thisMonth = new Date();
  thisMonth.setDate(1);
  thisMonth.setHours(0, 0, 0, 0);

  const monthlyCount = await this.countDocuments({
    referrerId: userId,
    createdAt: { $gte: thisMonth }
  });

  const result = stats[0] || {
    totalReferrals: 0,
    pendingReferrals: 0,
    verifiedReferrals: 0,
    distributedReferrals: 0,
    totalRewards: 0
  };

  return {
    ...result,
    monthlyReferrals: monthlyCount
  };
};

/**
 * Get referral leaderboard
 */
referralSchema.statics.getLeaderboard = async function(options = {}) {
  const { timeframe = 'all', limit = 50 } = options;

  let dateFilter = {};
  if (timeframe === 'month') {
    const thisMonth = new Date();
    thisMonth.setDate(1);
    thisMonth.setHours(0, 0, 0, 0);
    dateFilter = { createdAt: { $gte: thisMonth } };
  } else if (timeframe === 'week') {
    const lastWeek = new Date();
    lastWeek.setDate(lastWeek.getDate() - 7);
    dateFilter = { createdAt: { $gte: lastWeek } };
  }

  const leaderboard = await this.aggregate([
    { $match: { status: 'distributed', ...dateFilter } },
    {
      $group: {
        _id: '$referrerId',
        referralCount: { $sum: 1 },
        totalRewards: { $sum: '$amounts.referrer' }
      }
    },
    { $sort: { referralCount: -1, totalRewards: -1 } },
    { $limit: limit },
    {
      $lookup: {
        from: 'users',
        localField: '_id',
        foreignField: '_id',
        as: 'user'
      }
    },
    { $unwind: '$user' },
    {
      $project: {
        _id: 0,
        userId: '$_id',
        firstName: '$user.firstName',
        tier: '$user.tier',
        referralCount: 1,
        totalRewards: 1
      }
    }
  ]);

  return leaderboard.map((entry, index) => ({
    rank: index + 1,
    ...entry
  }));
};

/**
 * Get monthly budget usage
 */
referralSchema.statics.getMonthlyBudgetUsage = async function() {
  const thisMonth = new Date();
  thisMonth.setDate(1);
  thisMonth.setHours(0, 0, 0, 0);

  const result = await this.aggregate([
    {
      $match: {
        status: 'distributed',
        distributedAt: { $gte: thisMonth }
      }
    },
    {
      $group: {
        _id: null,
        totalDistributed: {
          $sum: {
            $add: ['$amounts.referrer', '$amounts.newUser', '$amounts.venue']
          }
        },
        referralCount: { $sum: 1 }
      }
    }
  ]);

  return result[0] || { totalDistributed: 0, referralCount: 0 };
};

module.exports = mongoose.model('Referral', referralSchema);
