// /opt/gambino/backend/src/models/Event.js
const mongoose = require('mongoose');

const eventSchema = new mongoose.Schema({
  // Event identification
  eventType: {
    type: String,
    required: true,
    enum: ['voucher', 'voucher_print', 'money_in', 'collect', 'session_start', 'session_end', 'test', 'daily_summary', 'money_out', 'books_cleared', 'books_clearing']
  },
  
  // Machine identification
  hubMachineId: {
    type: String,
    required: true
  },
  gamingMachineId: {
    type: String,
    required: true
  },
  
  // Location
  storeId: {
    type: String,
    required: true,
    index: true
  },
  
  // Financial data
  amount: {
    type: Number,
    default: null
  },
  
  // Event timing
  timestamp: {
    type: Date,
    required: true
  },
  
  // Raw data for debugging
  rawData: {
    type: String
  },
  
  // User attribution
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  userSessionId: {
    type: String,
    default: null
  },
  isUserBound: {
    type: Boolean,
    default: false
  },
  
  // Idempotency key for deduplication
  idempotencyKey: {
    type: String,
    sparse: true,  // Only enforce uniqueness when present
    index: true
  },
  
  // Metadata
  metadata: {
    type: Object,
    default: {}
  },
  
  // Machine mapping status
  mappingStatus: {
    type: String,
    enum: ['mapped', 'unmapped'],
    default: 'unmapped'
  },
  
  // Daily report processing (NEW for daily reports feature)
  processed: {
    type: Boolean,
    default: false,
    index: true
  },
  processedAt: {
    type: Date,
    default: null
  },
  generatedReportId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'DailyReport',
    default: null
  },
  processingError: {
    type: String,
    default: null
  },
  retryCount: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true  // Automatically adds createdAt and updatedAt
});

// Indexes for efficient queries
eventSchema.index({ hubMachineId: 1, createdAt: -1 });
eventSchema.index({ gamingMachineId: 1, createdAt: -1 });
eventSchema.index({ userId: 1, createdAt: -1 });
eventSchema.index({ eventType: 1 });
eventSchema.index({ isUserBound: 1 });
eventSchema.index({ storeId: 1, createdAt: -1 });
eventSchema.index({ processed: 1, eventType: 1 });
eventSchema.index({ storeId: 1, eventType: 1, timestamp: -1 });

// Unique compound index for daily summaries (prevents duplicates)
eventSchema.index(
  { storeId: 1, gamingMachineId: 1, eventType: 1, idempotencyKey: 1 },
  { unique: true, sparse: true }
);

// Static methods
eventSchema.statics.findUnprocessed = function(limit = 100) {
  return this.find({ 
    processed: false,
    eventType: 'daily_summary',
    retryCount: { $lt: 3 } // Don't retry failed events more than 3 times
  })
  .sort({ timestamp: 1 })
  .limit(limit);
};

eventSchema.statics.findByStore = function(storeId, startDate, endDate, eventType = null) {
  const query = { storeId };
  
  if (startDate || endDate) {
    query.timestamp = {};
    if (startDate) query.timestamp.$gte = new Date(startDate);
    if (endDate) query.timestamp.$lte = new Date(endDate);
  }
  
  if (eventType) {
    query.eventType = eventType;
  }
  
  return this.find(query).sort({ timestamp: -1 });
};

// FIXED: Use Math.max for cumulative events, not +=
eventSchema.statics.getDailySummary = async function(storeId, date) {
  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);
  
  const endOfDay = new Date(date);
  endOfDay.setHours(23, 59, 59, 999);
  
  const events = await this.find({
    storeId,
    timestamp: {
      $gte: startOfDay,
      $lte: endOfDay
    },
    eventType: { $in: ['money_in', 'money_out', 'collect', 'voucher', 'voucher_print'] }
  }).lean();
  
  // Group by machine - USE MAX FOR CUMULATIVE, SUM FOR TRANSACTIONS
  const machineData = {};
  
  events.forEach(event => {
    const machineId = event.gamingMachineId;
    
    if (!machineData[machineId]) {
      machineData[machineId] = {
        machineId: machineId,
        moneyIn: 0,
        moneyOut: 0,
        collect: 0,
        vouchers: 0,
        transactionCount: 0
      };
    }
    
    const machine = machineData[machineId];
    machine.transactionCount++;
    
    // FIXED: Use Math.max for cumulative events (snapshots that reset)
    if (event.eventType === 'money_in') {
      machine.moneyIn = Math.max(machine.moneyIn, event.amount || 0);
    } 
    else if (event.eventType === 'money_out') {
      machine.moneyOut = Math.max(machine.moneyOut, event.amount || 0);
    }
    else if (event.eventType === 'collect') {
      machine.collect = Math.max(machine.collect, event.amount || 0);
    }
    // Use SUM for discrete transaction events
    else if (event.eventType === 'voucher' || event.eventType === 'voucher_print') {
      machine.vouchers += event.amount || 0;
    }
  });
  
  // Calculate totals and net revenue per machine
  let totalMoneyIn = 0;
  let totalMoneyOut = 0;
  let totalCollect = 0;
  let totalVouchers = 0;
  
  Object.values(machineData).forEach(machine => {
    totalMoneyIn += machine.moneyIn;
    totalMoneyOut += machine.moneyOut;
    totalCollect += machine.collect;
    totalVouchers += machine.vouchers;
    machine.netRevenue = machine.moneyIn - machine.moneyOut - machine.collect - machine.vouchers;
  });
  
  return {
    storeId,
    date: date,
    totalMoneyIn,
    totalMoneyOut,
    totalCollect,
    totalVouchers,
    totalRevenue: totalMoneyIn - totalMoneyOut - totalCollect - totalVouchers,
    machineData: Object.values(machineData),
    machineCount: Object.keys(machineData).length,
    eventCount: events.length
  };
};

// Instance methods
eventSchema.methods.markProcessed = function(reportId = null) {
  this.processed = true;
  this.processedAt = new Date();
  if (reportId) {
    this.generatedReportId = reportId;
  }
  return this.save();
};

eventSchema.methods.markFailed = function(error) {
  this.processingError = error.message || error;
  this.retryCount += 1;
  return this.save();
};

module.exports = mongoose.model('Event', eventSchema);