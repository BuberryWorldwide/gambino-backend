// src/models/ExchangeRateConfig.js
const mongoose = require('mongoose');

const exchangeRateConfigSchema = new mongoose.Schema({
  // Exchange rates
  tokensPerDollar: {
    type: Number,
    required: true,
    default: 1000, // 1000 tokens = $1 USD
    min: 1
  },

  // Cashout limits
  minCashout: {
    type: Number,
    required: true,
    default: 5, // Minimum $5 cashout
    min: 0
  },
  maxCashoutPerTransaction: {
    type: Number,
    required: true,
    default: 500, // Maximum $500 per transaction
    min: 1
  },
  dailyLimitPerCustomer: {
    type: Number,
    required: true,
    default: 1000, // $1000 per day per customer
    min: 1
  },
  dailyLimitPerStaff: {
    type: Number,
    required: true,
    default: 5000, // $5000 per day per staff member
    min: 1
  },

  // Fee structure (optional - for venue commission on cashouts)
  venueCommissionPercent: {
    type: Number,
    default: 0, // 0% by default (no commission on cashouts)
    min: 0,
    max: 100
  },

  // Status and versioning
  isActive: {
    type: Boolean,
    default: true,
    index: true
  },
  effectiveFrom: {
    type: Date,
    required: true,
    default: Date.now,
    index: true
  },
  effectiveTo: {
    type: Date,
    default: null
  },

  // Notes and audit
  notes: {
    type: String,
    maxlength: 500
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },

  // Timestamps
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Indexes for performance
exchangeRateConfigSchema.index({ isActive: 1, effectiveFrom: -1 });
exchangeRateConfigSchema.index({ effectiveFrom: 1, effectiveTo: 1 });

// Pre-save middleware
exchangeRateConfigSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

// Static method to get current active config
exchangeRateConfigSchema.statics.getCurrentConfig = async function() {
  const now = new Date();

  return this.findOne({
    isActive: true,
    effectiveFrom: { $lte: now },
    $or: [
      { effectiveTo: null },
      { effectiveTo: { $gte: now } }
    ]
  }).sort({ effectiveFrom: -1 }).lean();
};

// Static method to create new config (deactivates old ones)
exchangeRateConfigSchema.statics.createNewConfig = async function(configData, userId) {
  // Deactivate all current active configs
  await this.updateMany(
    { isActive: true },
    {
      isActive: false,
      effectiveTo: new Date(),
      updatedBy: userId
    }
  );

  // Create new config
  const newConfig = new this({
    ...configData,
    isActive: true,
    effectiveFrom: configData.effectiveFrom || new Date(),
    createdBy: userId,
    updatedBy: userId
  });

  return newConfig.save();
};

// Instance method to deactivate
exchangeRateConfigSchema.methods.deactivate = async function(userId) {
  this.isActive = false;
  this.effectiveTo = new Date();
  this.updatedBy = userId;
  return this.save();
};

module.exports = mongoose.model('ExchangeRateConfig', exchangeRateConfigSchema);
