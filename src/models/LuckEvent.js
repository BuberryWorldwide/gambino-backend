// backend/src/models/LuckEvent.js
// Proof of Luck event storage - Gambino business layer

const mongoose = require('mongoose');

const luckEventSchema = new mongoose.Schema({
  // User who won
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },

  // Unique event identifier
  eventId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },

  // Rarity tier
  rarityTier: {
    type: String,
    enum: ['RARE', 'EPIC', 'LEGENDARY'],
    required: true,
    index: true
  },

  // Rewards
  ggEmission: {
    type: Number,
    required: true,
    min: 0
  },
  governancePoints: {
    type: Number,
    required: true,
    min: 0
  },

  // Roll data (for verification)
  rollValue: {
    type: Number,
    required: true,
    min: 0,
    max: 49999
  },
  threshold: {
    type: Number,
    required: true
  },

  // Arca integration - reference to entropy draw
  arcaDrawId: {
    type: String,
    default: null
  },
  entropyHex: {
    type: String,
    default: null
  },

  // Context
  gameContext: {
    type: String,
    default: 'unknown'
  },

  // Source packets (audit trail)
  sourcePackets: [{
    packetId: String,
    supplierId: String,
    bitsContributed: Number,
    quality: Number
  }],

  // Payout status
  payoutStatus: {
    type: String,
    enum: ['pending', 'processing', 'completed', 'failed'],
    default: 'pending',
    index: true
  },
  payoutTxHash: {
    type: String,
    default: null
  },
  paidAt: {
    type: Date,
    default: null
  },

  // Timestamps
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  }
}, {
  timestamps: true
});

// Compound indexes for common queries
luckEventSchema.index({ userId: 1, createdAt: -1 });
luckEventSchema.index({ rarityTier: 1, createdAt: -1 });
luckEventSchema.index({ payoutStatus: 1, createdAt: 1 });

// Static methods
luckEventSchema.statics.getRecentByUser = function(userId, limit = 20) {
  return this.find({ userId })
    .sort({ createdAt: -1 })
    .limit(limit);
};

luckEventSchema.statics.getByRarity = function(rarityTier, limit = 50) {
  return this.find({ rarityTier })
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate('userId', 'firstName lastName email');
};

luckEventSchema.statics.getGlobalStats = async function() {
  const stats = await this.aggregate([
    {
      $group: {
        _id: '$rarityTier',
        count: { $sum: 1 },
        totalGG: { $sum: '$ggEmission' },
        totalPoints: { $sum: '$governancePoints' }
      }
    }
  ]);

  const result = {
    RARE: { count: 0, totalGG: 0, totalPoints: 0 },
    EPIC: { count: 0, totalGG: 0, totalPoints: 0 },
    LEGENDARY: { count: 0, totalGG: 0, totalPoints: 0 }
  };

  stats.forEach(s => {
    if (result[s._id]) {
      result[s._id] = {
        count: s.count,
        totalGG: s.totalGG,
        totalPoints: s.totalPoints
      };
    }
  });

  return result;
};

module.exports = mongoose.model('LuckEvent', luckEventSchema);
