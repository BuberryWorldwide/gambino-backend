// /opt/gambino/backend/src/models/BookkeepingReport.js
const mongoose = require('mongoose');

const machineLifetimeSchema = new mongoose.Schema({
  machineId: { type: String, required: true },
  lifetimeIn: { type: Number, default: 0 },
  lifetimeOut: { type: Number, default: 0 },
  lifetimeGames: { type: Number, default: 0 }
}, { _id: false });

const bookkeepingReportSchema = new mongoose.Schema({
  // Identification
  storeId: { 
    type: String, 
    required: true,
    index: true 
  },
  
  // Report type: 'bookkeeping' or 'clearing'
  reportType: {
    type: String,
    enum: ['bookkeeping', 'clearing'],
    required: true,
    index: true
  },
  
  // When the report was generated/action performed
  timestamp: { 
    type: Date, 
    required: true,
    index: true 
  },
  
  // Business date (EST) this belongs to
  businessDate: { 
    type: Date, 
    required: true 
  },
  
  // Idempotency key to prevent duplicate processing
  idempotencyKey: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  
  // Total lifetime values at time of report
  totalLifetimeIn: { 
    type: Number, 
    default: 0 
  },
  totalLifetimeOut: { 
    type: Number, 
    default: 0 
  },
  totalLifetimeGames: { 
    type: Number, 
    default: 0 
  },
  
  // Per-machine breakdown
  machineData: [machineLifetimeSchema],
  machineCount: { 
    type: Number, 
    default: 0 
  },
  
  // For clearing events - what was cleared
  clearedValues: {
    totalIn: { type: Number, default: 0 },
    totalOut: { type: Number, default: 0 },
    totalGames: { type: Number, default: 0 }
  },
  
  // Source tracking
  sourceEventId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Event',
    default: null
  },
  
  // Raw data for debugging
  rawData: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  
  // Notes
  notes: {
    type: String,
    default: ''
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
});

// Compound indexes for efficient queries
bookkeepingReportSchema.index({ storeId: 1, timestamp: -1 });
bookkeepingReportSchema.index({ storeId: 1, reportType: 1, timestamp: -1 });
bookkeepingReportSchema.index({ storeId: 1, businessDate: -1 });

// Pre-save middleware to update timestamps
bookkeepingReportSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

// Static methods
bookkeepingReportSchema.statics.findByStore = function(storeId, options = {}) {
  const query = { storeId };
  
  if (options.reportType) {
    query.reportType = options.reportType;
  }
  
  if (options.startDate || options.endDate) {
    query.timestamp = {};
    if (options.startDate) query.timestamp['$gte'] = new Date(options.startDate);
    if (options.endDate) query.timestamp['$lte'] = new Date(options.endDate);
  }
  
  return this.find(query).sort({ timestamp: -1 }).limit(options.limit || 100);
};

bookkeepingReportSchema.statics.getLatestClearing = function(storeId) {
  return this.findOne({ 
    storeId, 
    reportType: 'clearing' 
  }).sort({ timestamp: -1 });
};

bookkeepingReportSchema.statics.getBookkeepingSinceClear = async function(storeId) {
  const lastClearing = await this.getLatestClearing(storeId);
  
  const query = { 
    storeId, 
    reportType: 'bookkeeping' 
  };
  
  if (lastClearing) {
    query.timestamp = { : lastClearing.timestamp };
  }
  
  return this.find(query).sort({ timestamp: -1 });
};

module.exports = mongoose.model('BookkeepingReport', bookkeepingReportSchema);
