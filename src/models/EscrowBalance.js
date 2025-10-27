
// backend/src/models/EscrowBalance.js
const mongoose = require('mongoose');

const escrowBalanceSchema = new mongoose.Schema({
  // User reference
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true,
    index: true
  },
  
  // Financial tracking
  deposited: {
    type: Number,
    default: 0,
    min: 0,
    comment: 'Total USD deposited'
  },
  withdrawn: {
    type: Number,
    default: 0,
    min: 0,
    comment: 'Total USD withdrawn'
  },
  
  // Escrow holdings
  escrowGG: {
    type: Number,
    default: 0,
    min: 0,
    comment: 'GG tokens held in escrow'
  },
  pendingGG: {
    type: Number,
    default: 0,
    min: 0,
    comment: 'GG tokens pending settlement from mining'
  },
  
  // Credits for gameplay
  playableCredits: {
    type: Number,
    default: 0,
    min: 0,
    comment: 'Credits available for mining'
  },
  
  // Net position
  netDeposit: {
    type: Number,
    default: 0,
    comment: 'deposited - withdrawn'
  },
  
  // Transaction history (summarized)
  totalTransactions: {
    type: Number,
    default: 0,
    min: 0
  },
  lastTransactionAt: {
    type: Date,
    default: null
  },
  
  // Activity tracking
  lastActivity: {
    type: Date,
    default: Date.now
  },
  lastDepositAt: {
    type: Date,
    default: null
  },
  lastWithdrawalAt: {
    type: Date,
    default: null
  },
  
  // Status
  status: {
    type: String,
    enum: ['active', 'frozen', 'suspended', 'closed'],
    default: 'active',
    index: true
  },
  
  // Risk management
  dailyDepositLimit: {
    type: Number,
    default: 1000, // USD
    min: 0
  },
  dailyWithdrawalLimit: {
    type: Number,
    default: 1000, // USD
    min: 0
  },
  depositedToday: {
    type: Number,
    default: 0,
    min: 0
  },
  withdrawnToday: {
    type: Number,
    default: 0,
    min: 0
  },
  lastResetDate: {
    type: Date,
    default: Date.now
  },
  
  // Flags
  requiresKYC: {
    type: Boolean,
    default: false
  },
  kycVerified: {
    type: Boolean,
    default: false
  },
  suspiciousActivity: {
    type: Boolean,
    default: false
  },
  
  // Notes
  notes: [{
    message: String,
    createdAt: { type: Date, default: Date.now },
    createdBy: String
  }]
  
}, {
  timestamps: true
});

// Indexes
escrowBalanceSchema.index({ status: 1 });
escrowBalanceSchema.index({ lastActivity: -1 });
escrowBalanceSchema.index({ escrowGG: -1 });

// Virtual for available balance
escrowBalanceSchema.virtual('availableBalance').get(function() {
  return this.escrowGG - this.pendingGG;
});

// Instance methods
escrowBalanceSchema.methods.deposit = async function(amountUSD, amountGG) {
  // Check daily limit
  this.resetDailyLimitsIfNeeded();
  
  if (this.depositedToday + amountUSD > this.dailyDepositLimit) {
    throw new Error('Daily deposit limit exceeded');
  }
  
  this.deposited += amountUSD;
  this.escrowGG += amountGG;
  this.depositedToday += amountUSD;
  this.netDeposit = this.deposited - this.withdrawn;
  this.lastDepositAt = new Date();
  this.lastActivity = new Date();
  this.totalTransactions += 1;
  this.lastTransactionAt = new Date();
  
  return this.save();
};

escrowBalanceSchema.methods.withdraw = async function(amountUSD, amountGG) {
  // Check daily limit
  this.resetDailyLimitsIfNeeded();
  
  if (this.withdrawnToday + amountUSD > this.dailyWithdrawalLimit) {
    throw new Error('Daily withdrawal limit exceeded');
  }
  
  // Check available balance
  if (this.availableBalance < amountGG) {
    throw new Error('Insufficient balance');
  }
  
  this.withdrawn += amountUSD;
  this.escrowGG -= amountGG;
  this.withdrawnToday += amountUSD;
  this.netDeposit = this.deposited - this.withdrawn;
  this.lastWithdrawalAt = new Date();
  this.lastActivity = new Date();
  this.totalTransactions += 1;
  this.lastTransactionAt = new Date();
  
  return this.save();
};

escrowBalanceSchema.methods.addPendingReward = async function(amountGG) {
  this.pendingGG += amountGG;
  this.lastActivity = new Date();
  return this.save();
};

escrowBalanceSchema.methods.settlePendingReward = async function(amountGG) {
  if (this.pendingGG < amountGG) {
    throw new Error('Insufficient pending balance');
  }
  
  this.pendingGG -= amountGG;
  this.escrowGG += amountGG;
  this.lastActivity = new Date();
  this.totalTransactions += 1;
  this.lastTransactionAt = new Date();
  
  return this.save();
};

escrowBalanceSchema.methods.addCredits = async function(credits) {
  this.playableCredits += credits;
  this.lastActivity = new Date();
  return this.save();
};

escrowBalanceSchema.methods.useCredits = async function(credits) {
  if (this.playableCredits < credits) {
    throw new Error('Insufficient credits');
  }
  
  this.playableCredits -= credits;
  this.lastActivity = new Date();
  return this.save();
};

escrowBalanceSchema.methods.resetDailyLimitsIfNeeded = function() {
  const today = new Date().toDateString();
  const lastReset = new Date(this.lastResetDate).toDateString();
  
  if (today !== lastReset) {
    this.depositedToday = 0;
    this.withdrawnToday = 0;
    this.lastResetDate = new Date();
  }
};

escrowBalanceSchema.methods.freeze = async function(reason) {
  this.status = 'frozen';
  this.notes.push({
    message: `Account frozen: ${reason}`,
    createdAt: new Date(),
    createdBy: 'system'
  });
  return this.save();
};

escrowBalanceSchema.methods.unfreeze = async function() {
  this.status = 'active';
  this.notes.push({
    message: 'Account unfrozen',
    createdAt: new Date(),
    createdBy: 'system'
  });
  return this.save();
};

// Static methods
escrowBalanceSchema.statics.getOrCreate = async function(userId) {
  let escrow = await this.findOne({ userId });
  
  if (!escrow) {
    escrow = new this({ userId });
    await escrow.save();
  }
  
  return escrow;
};

escrowBalanceSchema.statics.getTotalEscrowHoldings = async function() {
  const result = await this.aggregate([
    { $match: { status: 'active' } },
    {
      $group: {
        _id: null,
        totalEscrowGG: { $sum: '$escrowGG' },
        totalPendingGG: { $sum: '$pendingGG' },
        totalUsers: { $sum: 1 }
      }
    }
  ]);
  
  return result[0] || { totalEscrowGG: 0, totalPendingGG: 0, totalUsers: 0 };
};

module.exports = mongoose.model('EscrowBalance', escrowBalanceSchema);
