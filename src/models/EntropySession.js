// backend/src/models/EntropySession.js
// MongoDB model for storing entropy work sessions

const mongoose = require('mongoose');

const entropySessionSchema = new mongoose.Schema({
  // User identification
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },

  // Round identification
  roundId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },

  // Game identification
  gameId: {
    type: String,
    required: true,
    index: true
  },

  // Entropy trace data (compressed)
  trace: {
    tapCount: {
      type: Number,
      required: true
    },
    duration: Number, // ms
    firstTap: Number,
    lastTap: Number,
    histogram: {
      type: Map,
      of: Number // bin -> count
    },
    motionSamples: Number,
    entropyBits: Number,
    metadata: {
      deviceType: String,
      timestamp: Number,
      sdkVersion: String
    },
    version: String
  },

  // Verification results
  entropyBits: {
    type: Number,
    required: true,
    min: 0
  },

  reward: {
    type: Number,
    required: true,
    min: 0
  },

  // Status and flags
  status: {
    type: String,
    enum: ['completed', 'rejected', 'suspicious'],
    default: 'completed',
    index: true
  },

  flags: [{
    type: String,
    enum: [
      'insufficient_taps',
      'low_variance',
      'regular_pattern',
      'impossible_timing',
      'invalid_histogram',
      'timeout'
    ]
  }],

  // Timestamps
  timestamp: {
    type: Date,
    default: Date.now,
    index: true
  }

}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Indexes for analytics queries
entropySessionSchema.index({ userId: 1, timestamp: -1 });
entropySessionSchema.index({ gameId: 1, timestamp: -1 });
entropySessionSchema.index({ status: 1, timestamp: -1 });
entropySessionSchema.index({ 'trace.entropyBits': -1 });

// Virtual field: entropy quality score
entropySessionSchema.virtual('qualityScore').get(function() {
  if (this.trace.tapCount === 0) return 0;
  return this.entropyBits / this.trace.tapCount;
});

// Statics for analytics
entropySessionSchema.statics.getUserStats = async function(userId) {
  const stats = await this.aggregate([
    { $match: { userId: mongoose.Types.ObjectId(userId), status: 'completed' } },
    {
      $group: {
        _id: null,
        totalSessions: { $sum: 1 },
        totalEntropy: { $sum: '$entropyBits' },
        totalRewards: { $sum: '$reward' },
        avgEntropyPerSession: { $avg: '$entropyBits' },
        avgRewardPerSession: { $avg: '$reward' }
      }
    }
  ]);

  return stats[0] || {
    totalSessions: 0,
    totalEntropy: 0,
    totalRewards: 0,
    avgEntropyPerSession: 0,
    avgRewardPerSession: 0
  };
};

entropySessionSchema.statics.getGameStats = async function(gameId) {
  const stats = await this.aggregate([
    { $match: { gameId, status: 'completed' } },
    {
      $group: {
        _id: null,
        totalSessions: { $sum: 1 },
        totalEntropy: { $sum: '$entropyBits' },
        avgEntropyPerSession: { $avg: '$entropyBits' },
        uniqueUsers: { $addToSet: '$userId' }
      }
    }
  ]);

  if (!stats[0]) {
    return {
      totalSessions: 0,
      totalEntropy: 0,
      avgEntropyPerSession: 0,
      uniqueUsers: 0
    };
  }

  return {
    ...stats[0],
    uniqueUsers: stats[0].uniqueUsers.length
  };
};

// Instance methods
entropySessionSchema.methods.isSuspicious = function() {
  return this.flags && this.flags.length > 0;
};

entropySessionSchema.methods.getEntropyPerTap = function() {
  if (!this.trace || this.trace.tapCount === 0) return 0;
  return this.entropyBits / this.trace.tapCount;
};

module.exports = mongoose.model('EntropySession', entropySessionSchema);