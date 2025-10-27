// backend/src/models/MobileCredit.js
const mongoose = require('mongoose');

const mobileCreditSchema = new mongoose.Schema({
  // User reference
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  
  // Transaction details
  transactionId: {
    type: String,
    required: true,
    unique: true,
    default: () => `credit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  },
  
  // Type of credit transaction
  type: {
    type: String,
    enum: ['purchase', 'bonus', 'reward', 'refund', 'used', 'expired'],
    required: true,
    index: true
  },
  
  // Amount
  amount: {
    type: Number,
    required: true
  },
  
  // Cost (if purchased)
  costUSD: {
    type: Number,
    default: 0
  },
  costGG: {
    type: Number,
    default: 0
  },
  
  // Balance tracking
  balanceBefore: {
    type: Number,
    default: 0
  },
  balanceAfter: {
    type: Number,
    default: 0
  },
  
  // Related references
  miningSessionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'MiningSession',
    default: null
  },
  escrowTransactionId: {
    type: String,
    default: null
  },
  
  // Expiration (for purchased credits)
  expiresAt: {
    type: Date,
    default: null
  },
  expired: {
    type: Boolean,
    default: false
  },
  
  // Source tracking
  source: {
    type: String,
    enum: ['direct_purchase', 'deposit_bonus', 'daily_reward', 'achievement', 'referral', 'promo_code', 'admin_grant'],
    default: 'direct_purchase'
  },
  
  // Metadata
  description: String,
  metadata: mongoose.Schema.Types.Mixed,
  
  // Status
  status: {
    type: String,
    enum: ['pending', 'completed', 'failed', 'reversed'],
    default: 'completed',
    index: true
  }
  
}, {
  timestamps: true
});

// Indexes
mobileCreditSchema.index({ userId: 1, createdAt: -1 });
mobileCreditSchema.index({ type: 1, status: 1 });
mobileCreditSchema.index({ expiresAt: 1 });

// Static methods
mobileCreditSchema.statics.getUserBalance = async function(userId) {
  const credits = await this.find({
    userId,
    status: 'completed',
    type: { $in: ['purchase', 'bonus', 'reward', 'refund'] }
  });
  
  const used = await this.find({
    userId,
    status: 'completed',
    type: 'used'
  });
  
  const totalEarned = credits.reduce((sum, c) => sum + c.amount, 0);
  const totalUsed = used.reduce((sum, c) => sum + Math.abs(c.amount), 0);
  
  return totalEarned - totalUsed;
};

mobileCreditSchema.statics.recordPurchase = async function(userId, amount, costUSD, costGG) {
  const currentBalance = await this.getUserBalance(userId);
  
  const credit = new this({
    userId,
    type: 'purchase',
    amount,
    costUSD,
    costGG,
    balanceBefore: currentBalance,
    balanceAfter: currentBalance + amount,
    source: 'direct_purchase',
    status: 'completed'
  });
  
  return credit.save();
};

mobileCreditSchema.statics.recordUsage = async function(userId, amount, miningSessionId) {
  const currentBalance = await this.getUserBalance(userId);
  
  if (currentBalance < amount) {
    throw new Error('Insufficient credits');
  }
  
  const credit = new this({
    userId,
    type: 'used',
    amount: -amount, // Negative for usage
    balanceBefore: currentBalance,
    balanceAfter: currentBalance - amount,
    miningSessionId,
    status: 'completed'
  });
  
  return credit.save();
};

mobileCreditSchema.statics.grantBonus = async function(userId, amount, source, description) {
  const currentBalance = await this.getUserBalance(userId);
  
  const credit = new this({
    userId,
    type: 'bonus',
    amount,
    balanceBefore: currentBalance,
    balanceAfter: currentBalance + amount,
    source,
    description,
    status: 'completed'
  });
  
  return credit.save();
};

mobileCreditSchema.statics.getUserHistory = async function(userId, limit = 50) {
  return this.find({ userId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
};

mobileCreditSchema.statics.expireOldCredits = async function() {
  const now = new Date();
  
  const result = await this.updateMany(
    {
      expiresAt: { $lte: now },
      expired: false,
      status: 'completed',
      type: { $in: ['purchase', 'bonus', 'reward'] }
    },
    {
      $set: { expired: true, type: 'expired' }
    }
  );
  
  return result;
};


mobileCreditSchema.statics.getOrCreate = async function(userId) {
  const balance = await this.getUserBalance(userId);
  
  const history = await this.getUserHistory(userId, 10);
  
  const purchases = await this.find({
    userId,
    status: "completed",
    type: { $in: ["purchase", "bonus", "reward", "refund"] }
  });
  
  const usage = await this.find({
    userId,
    status: "completed",
    type: "used"
  });
  
  const lifetimePurchased = purchases.reduce((sum, c) => sum + c.amount, 0);
  const lifetimeSpent = usage.reduce((sum, c) => sum + Math.abs(c.amount), 0);
  
  const lastPurchase = purchases.length > 0 ? purchases[purchases.length - 1].createdAt : null;
  
  return {
    credits: balance,
    lifetimePurchased,
    lifetimeSpent,
    lastPurchase,
    recentTransactions: history
  };
};

module.exports = mongoose.model('MobileCredit', mobileCreditSchema);
