// backend/models/WorkSession.js
const mongoose = require('mongoose');

const workSessionSchema = new mongoose.Schema({
  // Round identification
  roundId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  
  // User reference
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  
  // Round parameters
  serverSalt: {
    type: String,
    required: true
  },
  target: {
    type: String,
    required: true
  },
  windowMs: {
    type: Number,
    required: true
  },
  
  // Status tracking
  status: {
    type: String,
    enum: ['started', 'completed', 'expired', 'rejected'],
    default: 'started',
    index: true
  },
  
  // Timing
  startedAt: {
    type: Date,
    required: true,
    default: Date.now
  },
  completedAt: {
    type: Date
  },
  expiresAt: {
    type: Date,
    required: true,
    index: true
  },
  
  // Entropy data
  entropyBitsClient: {
    type: Number  // What client claimed
  },
  entropyBitsVerified: {
    type: Number  // What server verified
  },
  
  // Reward
  reward: {
    type: Number,
    default: 0
  },
  
  // Bot detection
  botFlags: {
    type: [String],
    default: []
  },
  
  // Metadata
  clientVersion: String,
  deviceInfo: String,
  
  // Timestamps
  createdAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Indexes for queries
workSessionSchema.index({ userId: 1, status: 1 });
workSessionSchema.index({ createdAt: -1 });
workSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // TTL index

// Virtual for duration
workSessionSchema.virtual('duration').get(function() {
  if (this.completedAt && this.startedAt) {
    return this.completedAt - this.startedAt;
  }
  return null;
});

// Static method to get user stats
workSessionSchema.statics.getUserStats = async function(userId) {
  const stats = await this.aggregate([
    { $match: { userId: mongoose.Types.ObjectId(userId), status: 'completed' } },
    {
      $group: {
        _id: null,
        totalRounds: { $sum: 1 },
        totalEntropy: { $sum: '$entropyBitsVerified' },
        totalRewards: { $sum: '$reward' },
        avgEntropy: { $avg: '$entropyBitsVerified' }
      }
    }
  ]);
  
  return stats[0] || {
    totalRounds: 0,
    totalEntropy: 0,
    totalRewards: 0,
    avgEntropy: 0
  };
};

// Static method to clean up expired sessions
workSessionSchema.statics.cleanupExpired = async function() {
  const result = await this.updateMany(
    {
      status: 'started',
      expiresAt: { $lt: new Date() }
    },
    {
      $set: { status: 'expired' }
    }
  );
  
  return result.modifiedCount;
};

// Add fields to User model (update existing User schema)
// You'll need to add these fields to your existing User model:
/*
  gambinoBalance: { type: Number, default: 0 },
  totalEntropyMined: { type: Number, default: 0 },
  totalRoundsCompleted: { type: Number, default: 0 }
*/

module.exports = mongoose.model('WorkSession', workSessionSchema);