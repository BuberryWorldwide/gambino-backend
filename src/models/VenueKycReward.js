// backend/src/models/VenueKycReward.js
const mongoose = require('mongoose');

/**
 * VenueKycReward tracks rewards given to venues for KYC-verifying users.
 * This is separate from referral rewards - venues get a base reward
 * for every user they KYC verify in person.
 */
const venueKycRewardSchema = new mongoose.Schema({
  // Who was KYC'd
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  userWalletAddress: { type: String },  // Denormalized for easy queries

  // Who verified
  verifiedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  verifierName: { type: String },  // Denormalized: staff name at time of verification

  // Where
  venueId: {
    type: String,
    required: true,
    index: true
  },
  venueName: { type: String },  // Denormalized for reporting

  // Reward details
  rewardAmount: {
    type: Number,
    default: 25,  // Base KYC reward in GG tokens
    min: 0
  },
  status: {
    type: String,
    enum: ['pending', 'queued', 'distributed', 'failed'],
    default: 'pending'
  },

  // Distribution tracking
  txSignature: { type: String },  // Solana transaction signature
  distributedAt: { type: Date },
  failureReason: { type: String },
  retryCount: { type: Number, default: 0 },

  // Linked referral (if user was referred)
  linkedReferralId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Referral'
  },
  hasLinkedReferral: { type: Boolean, default: false },

  // Audit trail
  ipAddress: { type: String },
  userAgent: { type: String },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Prevent duplicate rewards for same user
venueKycRewardSchema.index({ userId: 1 }, { unique: true });

// Indexes for queries
venueKycRewardSchema.index({ venueId: 1, createdAt: -1 });
venueKycRewardSchema.index({ status: 1, createdAt: 1 });
venueKycRewardSchema.index({ verifiedBy: 1, createdAt: -1 });

// Pre-save middleware
venueKycRewardSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

// Static methods for reporting
venueKycRewardSchema.statics.getVenueStats = async function(venueId, startDate, endDate) {
  const match = { venueId };
  if (startDate || endDate) {
    match.createdAt = {};
    if (startDate) match.createdAt.$gte = new Date(startDate);
    if (endDate) match.createdAt.$lte = new Date(endDate);
  }

  return this.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$venueId',
        totalVerifications: { $sum: 1 },
        totalRewards: { $sum: '$rewardAmount' },
        distributedRewards: {
          $sum: {
            $cond: [{ $eq: ['$status', 'distributed'] }, '$rewardAmount', 0]
          }
        },
        pendingRewards: {
          $sum: {
            $cond: [{ $in: ['$status', ['pending', 'queued']] }, '$rewardAmount', 0]
          }
        },
        withReferrals: {
          $sum: {
            $cond: ['$hasLinkedReferral', 1, 0]
          }
        }
      }
    }
  ]);
};

venueKycRewardSchema.statics.getPendingDistributions = function(limit = 100) {
  return this.find({ status: { $in: ['pending', 'queued'] } })
    .sort({ createdAt: 1 })
    .limit(limit)
    .populate('userId', 'firstName lastName walletAddress')
    .populate('verifiedBy', 'firstName lastName');
};

module.exports = mongoose.model('VenueKycReward', venueKycRewardSchema);
