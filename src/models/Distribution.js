const mongoose = require('mongoose');

const distributionSchema = new mongoose.Schema({
  venueId: {
    type: String,
    required: true,
    index: true
  },
  venueName: {
    type: String
  },
  recipient: {
    type: String,
    required: true,
    index: true
  },
  amount: {
    type: Number,
    required: true
  },
  signature: {
    type: String,  // Solana transaction signature
    required: true,
    unique: true
  },
  status: {
    type: String,
    enum: ['pending', 'confirmed', 'failed'],
    default: 'pending',
    index: true
  },
  sourceAccount: {
    type: String,
    enum: ['miningRewards', 'founder', 'operations', 'community'],
    default: 'miningRewards'
  },
  staffId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  staffEmail: String,
  metadata: {
    type: Object,
    default: {}
  },
  error: String,
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  }
});

// Indexes for common queries
distributionSchema.index({ venueId: 1, createdAt: -1 });
distributionSchema.index({ recipient: 1, createdAt: -1 });
distributionSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('Distribution', distributionSchema);
