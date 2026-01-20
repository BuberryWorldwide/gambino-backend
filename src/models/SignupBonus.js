// backend/src/models/SignupBonus.js
const mongoose = require('mongoose');

/**
 * SignupBonus tracks welcome bonus rewards given to new users
 * upon completing signup + email verification + accepting terms.
 * 
 * This is separate from KYC bonuses - this is just for creating an account.
 */
const signupBonusSchema = new mongoose.Schema({
  // Who received the bonus
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true  // Ensures idempotency - one bonus per user
  },
  userEmail: { type: String },  // Denormalized for queries
  walletAddress: { type: String, required: true },

  // Bonus details
  amount: {
    type: Number,
    default: 50,  // Signup bonus in GG tokens
    min: 0
  },
  status: {
    type: String,
    enum: ['pending', 'processing', 'distributed', 'failed'],
    default: 'pending'
  },

  // What triggered the bonus
  trigger: {
    type: String,
    enum: ['email_verified', 'manual'],
    default: 'email_verified'
  },

  // Distribution tracking
  txSignature: { type: String },  // Solana transaction signature
  distributedAt: { type: Date },
  failureReason: { type: String },
  retryCount: { type: Number, default: 0 },

  // Referral tracking (if user was referred)
  referredBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  referralCode: { type: String },  // Code used at signup

  // Audit trail
  ipAddress: { type: String },
  userAgent: { type: String },
  signupSource: { type: String, default: 'web' },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Indexes
signupBonusSchema.index({ userId: 1 }, { unique: true });
signupBonusSchema.index({ status: 1, createdAt: 1 });
signupBonusSchema.index({ walletAddress: 1 });

// Pre-save middleware
signupBonusSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

// Static methods for reporting
signupBonusSchema.statics.getStats = async function(startDate, endDate) {
  const match = {};
  if (startDate || endDate) {
    match.createdAt = {};
    if (startDate) match.createdAt.$gte = new Date(startDate);
    if (endDate) match.createdAt.$lte = new Date(endDate);
  }

  return this.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        totalBonuses: { $sum: 1 },
        totalAmount: { $sum: '$amount' },
        distributedCount: {
          $sum: { $cond: [{ $eq: ['$status', 'distributed'] }, 1, 0] }
        },
        distributedAmount: {
          $sum: { $cond: [{ $eq: ['$status', 'distributed'] }, '$amount', 0] }
        },
        pendingCount: {
          $sum: { $cond: [{ $in: ['$status', ['pending', 'processing']] }, 1, 0] }
        },
        failedCount: {
          $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] }
        },
        withReferrals: {
          $sum: { $cond: [{ $ne: ['$referredBy', null] }, 1, 0] }
        }
      }
    }
  ]);
};

signupBonusSchema.statics.getPendingDistributions = function(limit = 100) {
  return this.find({ status: { $in: ['pending', 'processing'] } })
    .sort({ createdAt: 1 })
    .limit(limit)
    .populate('userId', 'firstName lastName email walletAddress');
};

module.exports = mongoose.model('SignupBonus', signupBonusSchema);
