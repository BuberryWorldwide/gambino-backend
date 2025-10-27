const mongoose = require('mongoose');

// Venue Daily Reconciliation Schema - tracks software fee compliance
const venueReconciliationSchema = new mongoose.Schema({
  // Identification
  storeId: { 
    type: String, 
    required: true,
    index: true 
  },
  reconciliationDate: { 
    type: Date, 
    required: true,
    index: true 
  },
  
  // Revenue Data (venue reported)
  venueGamingRevenue: { 
    type: Number, 
    required: true,
    min: 0
  },
  
  // Software Fee Calculations (based on store.feePercentage)
  softwareFeePercentage: { 
    type: Number, 
    required: true,
    min: 0,
    max: 100
  },
  expectedSoftwareFee: { 
    type: Number, 
    required: false, // Changed to false since we calculate it
    min: 0
  },
  actualSoftwareFee: { 
    type: Number, 
    default: null,
    min: 0
  },
  
  // Variance Analysis
  variance: { 
    type: Number, 
    default: null
  },
  variancePercentage: { 
    type: Number, 
    default: null
  },
  
  // Status & Compliance
  reconciliationStatus: {
    type: String,
    enum: ['pending', 'approved', 'flagged', 'resolved'],
    default: 'pending',
    index: true
  },
  complianceScore: {
    type: Number,
    min: 0,
    max: 100,
    default: null
  },

    // Payment tracking fields
  paymentMethod: {
    type: String,
    enum: ['cash', 'check', 'wire', 'crypto', 'zelle', 'pending', 'other'],
    default: 'pending'
  },
  
  paymentSentAt: {
    type: Date
  },
  
  amountSent: {
    type: Number,
    min: 0
  },
  
  paymentReceivedAt: {
    type: Date
  },
  
  paymentConfirmedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },

// The settlementStatus field should already exist with these options:
  settlementStatus: {
    type: String,
    enum: ['unsettled', 'payment_sent', 'partial', 'settled', 'disputed'],
    default: 'unsettled'
  },
  
  // Audit Trail
  submittedBy: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User',
    required: true
  },
  approvedBy: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User',
    default: null
  },
  flaggedReason: {
    type: String,
    default: null
  },
  
  // Additional Data
  notes: {
    type: String,
    default: ''
  },
  machineCount: {
    type: Number,
    default: null
  },
  transactionCount: {
    type: Number,
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
  },
  approvedAt: {
    type: Date,
    default: null
  }
});

// Compound indexes for efficient queries
venueReconciliationSchema.index({ storeId: 1, reconciliationDate: -1 });
venueReconciliationSchema.index({ reconciliationStatus: 1, createdAt: -1 });
venueReconciliationSchema.index({ storeId: 1, reconciliationStatus: 1 });
venueReconciliationSchema.index({ complianceScore: 1 });

// Ensure one reconciliation per store per day
venueReconciliationSchema.index(
  { storeId: 1, reconciliationDate: 1 }, 
  { unique: true }
);

// Pre-save middleware to calculate derived fields
venueReconciliationSchema.pre('save', function(next) {
  // Always calculate expected software fee first
  this.expectedSoftwareFee = (this.venueGamingRevenue * this.softwareFeePercentage) / 100;
  
  // Calculate variance if actual fee is provided
  if (this.actualSoftwareFee !== null && this.actualSoftwareFee !== undefined) {
    this.variance = this.actualSoftwareFee - this.expectedSoftwareFee;
    this.variancePercentage = this.expectedSoftwareFee > 0 
      ? (this.variance / this.expectedSoftwareFee) * 100 
      : 0;
    
    // Auto-calculate compliance score
    this.complianceScore = this.calculateComplianceScore();
    
    // Auto-flag if variance is significant
    if (Math.abs(this.variancePercentage) > 10 && this.reconciliationStatus === 'pending') {
      this.reconciliationStatus = 'flagged';
      this.flaggedReason = `Variance of ${this.variancePercentage.toFixed(2)}% exceeds 10% threshold`;
    }
  }
  
  // Update timestamp
  this.updatedAt = new Date();
  next();
});

// Instance methods
venueReconciliationSchema.methods.calculateComplianceScore = function() {
  if (this.actualSoftwareFee === null || this.actualSoftwareFee === undefined || this.expectedSoftwareFee === 0) {
    return null;
  }
  
  const absVariancePercent = Math.abs(this.variancePercentage);
  
  // Perfect compliance (0% variance) = 100 points
  // 10% variance = 90 points, etc.
  let score = Math.max(0, 100 - absVariancePercent);
  
  // Bonus points for early submission (within 24 hours)
  const submissionDelay = (this.createdAt - this.reconciliationDate) / (1000 * 60 * 60); // hours
  if (submissionDelay <= 24) {
    score = Math.min(100, score + 5);
  }
  
  return Math.round(score);
};

venueReconciliationSchema.methods.isCompliant = function() {
  return this.complianceScore >= 90 && this.reconciliationStatus === 'approved';
};

venueReconciliationSchema.methods.needsAttention = function() {
  return this.reconciliationStatus === 'flagged' || 
         (this.complianceScore !== null && this.complianceScore < 80);
};

// Static methods for venue analytics
venueReconciliationSchema.statics.getVenueComplianceStats = async function(storeId, days = 30) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  
  const stats = await this.aggregate([
    {
      $match: {
        storeId: storeId,
        reconciliationDate: { $gte: startDate }
      }
    },
    {
      $group: {
        _id: null,
        totalReconciliations: { $sum: 1 },
        averageComplianceScore: { $avg: '$complianceScore' },
        totalVariance: { $sum: '$variance' },
        flaggedCount: {
          $sum: { $cond: [{ $eq: ['$reconciliationStatus', 'flagged'] }, 1, 0] }
        },
        approvedCount: {
          $sum: { $cond: [{ $eq: ['$reconciliationStatus', 'approved'] }, 1, 0] }
        },
        totalExpectedFees: { $sum: '$expectedSoftwareFee' },
        totalActualFees: { $sum: '$actualSoftwareFee' }
      }
    }
  ]);
  
  return stats.length > 0 ? stats[0] : null;
};

venueReconciliationSchema.statics.getPendingReconciliations = async function(storeIds = null) {
  const query = { reconciliationStatus: 'pending' };
  if (storeIds) {
    query.storeId = { $in: storeIds };
  }
  
  return this.find(query)
    .populate('submittedBy', 'firstName lastName email role')
    .sort({ reconciliationDate: -1 })
    .lean();
};

module.exports = mongoose.model('VenueReconciliation', venueReconciliationSchema);