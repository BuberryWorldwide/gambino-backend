// backend/src/models/MiningSession.js
const mongoose = require('mongoose');

const miningSessionSchema = new mongoose.Schema({
  // User reference
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  
  // Session identification
  sessionId: {
    type: String,
    required: true,
    unique: true,
    default: () => `mine_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  },
  
  // Timing
  startTime: {
    type: Date,
    required: true,
    default: Date.now
  },
  endTime: {
    type: Date,
    default: null
  },
  duration: {
    type: Number, // seconds
    default: 0
  },
  
  // Activity metrics
  totalClicks: {
    type: Number,
    default: 0,
    min: 0
  },
  totalSwipes: {
    type: Number,
    default: 0,
    min: 0
  },
  totalShakes: {
    type: Number,
    default: 0,
    min: 0
  },
  
  // Entropy data (batched submissions)
  entropySubmissions: [{
    timestamp: Date,
    clickCount: Number,
    swipeCount: Number,
    shakeCount: Number,
    pattern: String, // Pattern hash for validation
    deviceData: {
      platform: String, // 'ios' or 'android'
      appVersion: String,
      timestamp: Date
    }
  }],
  
  // Rewards
  entropyGenerated: {
    type: Number,
    default: 0,
    min: 0
  },
  rewardAmount: {
    type: Number,
    default: 0,
    min: 0
  },
  creditsUsed: {
    type: Number,
    default: 0,
    min: 0
  },
  
  // Status
  status: {
    type: String,
    enum: ['active', 'completed', 'abandoned', 'failed'],
    default: 'active',
    index: true
  },
  
  // Anti-bot validation
  fraudScore: {
    type: Number,
    default: 0,
    min: 0,
    max: 100
  },
  validationFlags: [{
    type: String,
    enum: ['bot_pattern', 'too_fast', 'too_consistent', 'device_mismatch', 'suspicious_timing']
  }],
  
  // Device info
  deviceFingerprint: {
    type: String,
    required: true
  },
  platform: {
    type: String,
    enum: ['ios', 'android'],
    required: true
  },
  appVersion: {
    type: String
  },
  
  // Network info
  ipAddress: String,
  userAgent: String,
  
  // Powerups used during session
  powerupsUsed: [{
    powerupId: mongoose.Schema.Types.ObjectId,
    powerupType: String,
    usedAt: Date,
    effect: String
  }],
  
  // Error tracking
  errorMessage: String,
  errorCode: String
  
}, {
  timestamps: true
});

// Indexes for performance
miningSessionSchema.index({ userId: 1, createdAt: -1 });
miningSessionSchema.index({ status: 1, userId: 1 });
miningSessionSchema.index({ startTime: 1, endTime: 1 });
miningSessionSchema.index({ deviceFingerprint: 1 });

// Instance methods
miningSessionSchema.methods.endSession = async function(rewardAmount = 0) {
  this.status = 'completed';
  this.endTime = new Date();
  this.duration = Math.floor((this.endTime - this.startTime) / 1000);
  this.rewardAmount = rewardAmount;
  return this.save();
};

miningSessionSchema.methods.addEntropySubmission = function(data) {
  this.entropySubmissions.push(data);
  this.totalClicks += data.clickCount || 0;
  this.totalSwipes += data.swipeCount || 0;
  this.totalShakes += data.shakeCount || 0;
  this.entropyGenerated = this.totalClicks + this.totalSwipes + this.totalShakes;
  return this.save();
};

miningSessionSchema.methods.calculateFraudScore = function() {
  let score = 0;
  
  // Check for bot patterns
  if (this.entropySubmissions.length > 0) {
    const intervals = [];
    for (let i = 1; i < this.entropySubmissions.length; i++) {
      const interval = this.entropySubmissions[i].timestamp - this.entropySubmissions[i-1].timestamp;
      intervals.push(interval);
    }
    
    // Too consistent intervals = bot
    const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const variance = intervals.reduce((sum, interval) => {
      return sum + Math.pow(interval - avgInterval, 2);
    }, 0) / intervals.length;
    
    if (variance < 100) score += 30; // Very consistent = suspicious
  }
  
  // Too fast clicking
  if (this.duration > 0) {
    const clickRate = this.totalClicks / this.duration;
    if (clickRate > 10) score += 20; // More than 10 clicks per second
  }
  
  // Check validation flags
  score += this.validationFlags.length * 10;
  
  this.fraudScore = Math.min(score, 100);
  return this.fraudScore;
};

// Static methods
miningSessionSchema.statics.getActiveSession = function(userId) {
  return this.findOne({ userId, status: 'active' });
};

miningSessionSchema.statics.getUserStats = async function(userId, days = 30) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  
  const sessions = await this.find({
    userId,
    status: 'completed',
    createdAt: { $gte: startDate }
  });
  
  return {
    totalSessions: sessions.length,
    totalClicks: sessions.reduce((sum, s) => sum + s.totalClicks, 0),
    totalRewards: sessions.reduce((sum, s) => sum + s.rewardAmount, 0),
    avgRewardPerSession: sessions.length > 0 
      ? sessions.reduce((sum, s) => sum + s.rewardAmount, 0) / sessions.length 
      : 0,
    totalDuration: sessions.reduce((sum, s) => sum + s.duration, 0)
  };
};

module.exports = mongoose.model('MiningSession', miningSessionSchema);
