// backend/src/models/User.js
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  // Basic Info
  firstName: { type: String, required: true, trim: true },
  lastName: { type: String, required: true, trim: true },
  email: { 
    type: String, 
    required: true, 
    unique: true, 
    lowercase: true,
    match: [/^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/, 'Please enter a valid email']
  },
  phone: { 
    type: String, 
    match: [/^\+?[\d\s\-\(\)]{10,}$/, 'Please enter a valid phone number'] 
  },
  dateOfBirth: { type: Date },
  
  // KYC Information
  kycStatus: { 
    type: String, 
    enum: ['pending', 'verified', 'rejected', 'expired'], 
    default: 'pending' 
  },
  kycDocuments: [{
    type: { type: String, enum: ['id', 'passport', 'license', 'utility_bill'] },
    url: String,
    uploadedAt: { type: Date, default: Date.now },
    verified: { type: Boolean, default: false }
  }],
  kycVerifiedAt: Date,
  
  // Wallet Information
  walletAddress: { type: String, required: true, unique: true },
  encryptedPrivateKey: { type: String, required: true },
  privateKeyIV: { type: String, required: true },
  tokenAccount: { type: String }, // Gambino SPL token account
  recoveryPhrase: { type: String }, // Encrypted
  recoveryPhraseIV: { type: String },
  
  // Balances
  gambinoBalance: { type: Number, default: 0, min: 0 },
  lockedBalance: { type: Number, default: 0, min: 0 }, // For staking/governance
  totalDeposited: { type: Number, default: 0, min: 0 },
  totalWithdrawn: { type: Number, default: 0, min: 0 },
  netProfit: { type: Number, default: 0 },
  
  // Gaming Stats
  gluckScore: { type: Number, default: 0, min: 0 },
  tier: { 
    type: String, 
    enum: ['none', 'tier3', 'tier2', 'tier1'], 
    default: 'none' 
  },
  totalJackpots: { type: Number, default: 0, min: 0 },
  majorJackpots: { type: Number, default: 0, min: 0 },
  minorJackpots: { type: Number, default: 0, min: 0 },
  megaJackpots: { type: Number, default: 0, min: 0 },
  gamesPlayed: { type: Number, default: 0, min: 0 },
  totalSpent: { type: Number, default: 0, min: 0 },
  totalWon: { type: Number, default: 0, min: 0 },
  winStreak: { type: Number, default: 0, min: 0 },
  maxWinStreak: { type: Number, default: 0, min: 0 },
  
  // Machine Interaction
  machinesPlayed: [{ 
    machineId: String,
    location: String,
    firstPlayed: { type: Date, default: Date.now },
    lastPlayed: { type: Date, default: Date.now },
    totalPlays: { type: Number, default: 0 },
    totalWins: { type: Number, default: 0 }
  }],
  favoriteLocation: String,
  
  // Lucky Events
  luckyEvents: [{
    type: { type: String, enum: ['minor', 'major', 'mega', 'special'] },
    amount: Number,
    machineId: String,
    location: String,
    gluckBonus: Number,
    timestamp: { type: Date, default: Date.now },
    verified: { type: Boolean, default: false }
  }],
  
  // Tier Rewards
  tierRewards: [{
    tier: String,
    amount: Number,
    period: String, // 'annual', 'monthly', 'bonus'
    paidAt: { type: Date, default: Date.now },
    txHash: String
  }],
  
  // Security & Access
  passwordHash: String, // Optional PIN for extra security
  twoFactorEnabled: { type: Boolean, default: false },
  twoFactorSecret: String,
  loginAttempts: { type: Number, default: 0 },
  lockUntil: Date,
  
  // Preferences
  preferences: {
    emailNotifications: { type: Boolean, default: true },
    smsNotifications: { type: Boolean, default: false },
    marketingEmails: { type: Boolean, default: true },
    language: { type: String, default: 'en' },
    timezone: { type: String, default: 'America/New_York' }
  },
  
  // Referral System
  referralCode: { type: String, unique: true, sparse: true },
  referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  referrals: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  referralRewards: { type: Number, default: 0 },
  
  // Status & Activity
  isActive: { type: Boolean, default: true },
  isVerified: { type: Boolean, default: false },
  isSuspended: { type: Boolean, default: false },
  suspensionReason: String,
  lastActivity: { type: Date, default: Date.now },
  lastLogin: { type: Date, default: Date.now },
  loginCount: { type: Number, default: 0 },
  
  // Metadata
  signupSource: { type: String, default: 'web' }, // 'web', 'mobile', 'kiosk'
  ipAddress: String,
  userAgent: String,
  
  // Timestamps
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Indexes for performance
userSchema.index({ email: 1 });
userSchema.index({ walletAddress: 1 });
userSchema.index({ gluckScore: -1 });
userSchema.index({ tier: 1 });
userSchema.index({ referralCode: 1 });
userSchema.index({ createdAt: -1 });
userSchema.index({ lastActivity: -1 });
userSchema.index({ kycStatus: 1 });

// Virtual fields
userSchema.virtual('fullName').get(function() {
  return `${this.firstName} ${this.lastName}`;
});

userSchema.virtual('isLocked').get(function() {
  return !!(this.lockUntil && this.lockUntil > Date.now());
});

userSchema.virtual('uniqueMachinesCount').get(function() {
  return new Set(this.machinesPlayed.map(m => m.machineId)).size;
});

userSchema.virtual('totalRewardsEarned').get(function() {
  return this.tierRewards.reduce((sum, reward) => sum + reward.amount, 0);
});

// Pre-save middleware
userSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  
  // Generate referral code if not exists
  if (!this.referralCode && this.isVerified) {
    this.referralCode = this.generateReferralCode();
  }
  
  // Update net profit
  this.netProfit = this.totalWon - this.totalSpent;
  
  next();
});

// Instance methods
userSchema.methods.generateReferralCode = function() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = 'GMB';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
};

userSchema.methods.updateGluckScore = function() {
  let baseScore = (this.majorJackpots * 1000) + (this.minorJackpots * 100) + (this.megaJackpots * 5000);
  
  // Diversity multiplier
  const uniqueMachines = this.uniqueMachinesCount;
  let diversityMultiplier = 1.0;
  
  if (uniqueMachines >= 7) diversityMultiplier = 3.0;
  else if (uniqueMachines >= 5) diversityMultiplier = 2.5;
  else if (uniqueMachines >= 3) diversityMultiplier = 2.0;
  else if (uniqueMachines >= 2) diversityMultiplier = 1.5;
  
  this.gluckScore = Math.floor(baseScore * diversityMultiplier);
  this.updateTier();
  return this.gluckScore;
};

userSchema.methods.updateTier = function() {
  const uniqueMachines = this.uniqueMachinesCount;
  
  // Tier 1: 7+ major jackpots across 3+ machines
  if (this.majorJackpots >= 7 && uniqueMachines >= 3) {
    this.tier = 'tier1';
  }
  // Tier 2: 1-2 majors + multiple minors with machine spread
  else if ((this.majorJackpots >= 1 && this.minorJackpots >= 10 && uniqueMachines >= 2) || 
           (this.majorJackpots >= 2)) {
    this.tier = 'tier2';
  }
  // Tier 3: 50+ minor jackpots or consistent play
  else if (this.minorJackpots >= 50 || (this.minorJackpots >= 20 && uniqueMachines >= 2)) {
    this.tier = 'tier3';
  }
  else {
    this.tier = 'none';
  }
  
  return this.tier;
};

userSchema.methods.addMachinePlay = function(machineId, location, won = false) {
  const existing = this.machinesPlayed.find(m => m.machineId === machineId);
  
  if (existing) {
    existing.lastPlayed = new Date();
    existing.totalPlays += 1;
    if (won) existing.totalWins += 1;
  } else {
    this.machinesPlayed.push({
      machineId,
      location,
      totalPlays: 1,
      totalWins: won ? 1 : 0
    });
  }
};

userSchema.methods.toSafeObject = function() {
  const obj = this.toObject();
  delete obj.encryptedPrivateKey;
  delete obj.privateKeyIV;
  delete obj.recoveryPhrase;
  delete obj.recoveryPhraseIV;
  delete obj.passwordHash;
  delete obj.twoFactorSecret;
  return obj;
};

// Static methods
userSchema.statics.findByWallet = function(walletAddress) {
  return this.findOne({ walletAddress });
};

userSchema.statics.getLeaderboard = function(limit = 100) {
  return this.find({ isActive: true, isVerified: true })
    .sort({ gluckScore: -1 })
    .limit(limit)
    .select('firstName lastName email gluckScore tier totalJackpots majorJackpots minorJackpots machinesPlayed createdAt');
};

module.exports = mongoose.model('User', userSchema);