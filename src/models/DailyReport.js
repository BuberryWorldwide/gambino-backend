// /opt/gambino/backend/src/models/DailyReport.js
const mongoose = require('mongoose');

const machineDataSchema = new mongoose.Schema({
  machineId: { type: String, required: true },
  moneyIn: { type: Number, default: 0 },
  collect: { type: Number, default: 0 },
  netRevenue: { type: Number, default: 0 },
  transactionCount: { type: Number, default: 0 }
}, { _id: false });

const dailyReportSchema = new mongoose.Schema({
  // Identification
  storeId: { 
    type: String, 
    required: true,
    index: true 
  },
  
  // Report metadata
  printedAt: { 
    type: Date, 
    required: true,
    index: true 
  },
  reportDate: { 
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
  
  // Financial data
  totalRevenue: { 
    type: Number, 
    required: true,
    default: 0 
  },
  totalMoneyIn: { 
    type: Number, 
    default: 0 
  },
  totalCollect: { 
    type: Number, 
    default: 0 
  },
  
  // Machine breakdown
  machineData: [machineDataSchema],
  machineCount: { 
    type: Number, 
    default: 0 
  },
  
  // Quality/validation metrics
  qualityScore: { 
    type: Number, 
    min: 0, 
    max: 100,
    default: 100 
  },
  hasAnomalies: { 
    type: Boolean, 
    default: false 
  },
  anomalyReasons: [String],
  
  // Reconciliation status
  reconciliationStatus: {
    type: String,
    enum: ['pending', 'included', 'excluded', 'duplicate'],
    default: 'pending',
    index: true
  },
  
  // Notes and audit trail
  notes: {
    type: String,
    default: ''
  },
  lastModifiedAt: {
    type: Date,
    default: Date.now
  },
  lastModifiedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  
  // Source tracking
  sourceEventId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Event',
    default: null
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
dailyReportSchema.index({ storeId: 1, printedAt: -1 });
dailyReportSchema.index({ storeId: 1, reportDate: -1 });
dailyReportSchema.index({ storeId: 1, reconciliationStatus: 1 });
dailyReportSchema.index({ reconciliationStatus: 1, createdAt: -1 });

// Pre-save middleware to update timestamps
dailyReportSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  
  // Calculate quality score based on data completeness and anomalies
  if (this.isNew || this.isModified('machineData') || this.isModified('hasAnomalies')) {
    let score = 100;
    
    // Deduct points for anomalies
    if (this.hasAnomalies) {
      score -= 20;
    }
    
    // Deduct points for missing machine data
    if (this.machineCount > 0 && this.machineData.length === 0) {
      score -= 30;
    }
    
    // Deduct points for zero revenue (suspicious)
    if (this.totalRevenue === 0) {
      score -= 10;
    }
    
    this.qualityScore = Math.max(0, score);
  }
  
  next();
});

// Static methods
dailyReportSchema.statics.findByStore = function(storeId, startDate, endDate) {
  const query = { storeId };
  
  if (startDate || endDate) {
    query.printedAt = {};
    if (startDate) query.printedAt.$gte = new Date(startDate);
    if (endDate) query.printedAt.$lte = new Date(endDate);
  }
  
  return this.find(query).sort({ printedAt: -1 });
};

dailyReportSchema.statics.getReconciliationSummary = async function(storeId, startDate, endDate) {
  const reports = await this.find({
    storeId,
    printedAt: {
      $gte: new Date(startDate),
      $lte: new Date(endDate)
    }
  }).lean();
  
  const included = reports.filter(r => r.reconciliationStatus === 'included');
  
  return {
    total: reports.length,
    included: included.length,
    excluded: reports.filter(r => r.reconciliationStatus === 'excluded').length,
    pending: reports.filter(r => r.reconciliationStatus === 'pending').length,
    totalRevenue: included.reduce((sum, r) => sum + (r.totalRevenue || 0), 0)
  };
};

// Instance methods
dailyReportSchema.methods.markAsIncluded = function(userId, notes) {
  this.reconciliationStatus = 'included';
  this.lastModifiedBy = userId;
  this.lastModifiedAt = new Date();
  if (notes) this.notes = notes;
  return this.save();
};

dailyReportSchema.methods.markAsExcluded = function(userId, notes) {
  this.reconciliationStatus = 'excluded';
  this.lastModifiedBy = userId;
  this.lastModifiedAt = new Date();
  if (notes) this.notes = notes;
  return this.save();
};

dailyReportSchema.methods.detectAnomalies = function() {
  const anomalies = [];
  
  // Check for zero revenue
  if (this.totalRevenue === 0 && this.machineCount > 0) {
    anomalies.push('Zero revenue despite active machines');
  }
  
  // Check for mismatched calculations
  if (Math.abs(this.totalRevenue - (this.totalMoneyIn - this.totalCollect)) > 0.01) {
    anomalies.push('Revenue calculation mismatch');
  }
  
  // Check for missing machine data
  if (this.machineCount > 0 && this.machineData.length === 0) {
    anomalies.push('Missing machine breakdown data');
  }
  
  this.hasAnomalies = anomalies.length > 0;
  this.anomalyReasons = anomalies;
  
  return anomalies;
};

module.exports = mongoose.model('DailyReport', dailyReportSchema);