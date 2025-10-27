// === WALLET MODELS ===

const mongoose = require('mongoose');

// Store Wallet Model - tracks store-specific credit balances
const storeWalletSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  storeId: {
    type: String,
    required: true,
    ref: 'Store'
  },
  balance: {
    type: Number,
    default: 0,
    min: 0
  },
  // Pending credits during session (optimistic locking)
  pendingCredits: {
    type: Number,
    default: 0
  },
  pendingDebits: {
    type: Number,
    default: 0
  },
  // Last known session for continuity
  lastSessionId: {
    type: String,
    default: null
  },
  // Audit trail
  lastUpdated: {
    type: Date,
    default: Date.now
  },
  version: {
    type: Number,
    default: 1
  }
}, {
  timestamps: true
});

// Compound index for user-store lookups
storeWalletSchema.index({ userId: 1, storeId: 1 }, { unique: true });
storeWalletSchema.index({ storeId: 1, lastUpdated: -1 });

// Wallet Transaction Model - complete audit trail
const walletTransactionSchema = new mongoose.Schema({
  transactionId: {
    type: String,
    required: true,
    unique: true,
    default: () => `wt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  storeId: {
    type: String,
    required: true
  },
  
  // Transaction details
  type: {
    type: String,
    enum: ['cash_deposit', 'gaming_spend', 'gaming_win', 'cash_out', 'adjustment', 'reversal'],
    required: true
  },
  amount: {
    type: Number,
    required: true
  },
  direction: {
    type: String,
    enum: ['credit', 'debit'],
    required: true
  },
  
  // Balance tracking
  balanceBefore: {
    type: Number,
    required: true
  },
  balanceAfter: {
    type: Number,
    required: true
  },
  
  // Source tracking
  sessionId: {
    type: String,
    default: null
  },
  machineId: {
    type: String,
    default: null
  },
  hubMachineId: {
    type: String,
    default: null
  },
  
  // Pi event correlation
  sourceEventId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Event',
    default: null
  },
  
  // Settlement tracking
  settlementId: {
    type: String,
    default: null
  },
  
  // Status and processing
  status: {
    type: String,
    enum: ['pending', 'confirmed', 'failed', 'reversed'],
    default: 'pending'
  },
  
  // Metadata and context
  description: {
    type: String,
    default: ''
  },
  metadata: {
    type: Object,
    default: {}
  },
  
  // Error handling
  errorMessage: {
    type: String,
    default: null
  },
  retryCount: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true
});

// Indexes for efficient queries
walletTransactionSchema.index({ userId: 1, createdAt: -1 });
walletTransactionSchema.index({ storeId: 1, createdAt: -1 });
walletTransactionSchema.index({ sessionId: 1 });
walletTransactionSchema.index({ transactionId: 1 }, { unique: true });
walletTransactionSchema.index({ status: 1, createdAt: -1 });
walletTransactionSchema.index({ type: 1, storeId: 1, createdAt: -1 });

// Settlement Model - batch settlement tracking
const settlementSchema = new mongoose.Schema({
  settlementId: {
    type: String,
    required: true,
    unique: true,
    default: () => `settle_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  },
  storeId: {
    type: String,
    required: true
  },
  
  // Settlement period
  periodStart: {
    type: Date,
    required: true
  },
  periodEnd: {
    type: Date,
    required: true
  },
  
  // Financial summary
  totalCashIn: {
    type: Number,
    default: 0
  },
  totalCashOut: {
    type: Number,
    default: 0
  },
  totalGameWins: {
    type: Number,
    default: 0
  },
  totalGameSpend: {
    type: Number,
    default: 0
  },
  netAmount: {
    type: Number,
    default: 0
  },
  
  // Transaction counts
  transactionCount: {
    type: Number,
    default: 0
  },
  uniqueUsers: {
    type: Number,
    default: 0
  },
  
  // Status
  status: {
    type: String,
    enum: ['pending', 'processing', 'completed', 'failed'],
    default: 'pending'
  },
  
  // Processing details
  processedBy: {
    type: String,
    default: null
  },
  processedAt: {
    type: Date,
    default: null
  },
  
  // File exports
  reportUrl: {
    type: String,
    default: null
  },
  
  // Metadata
  notes: {
    type: String,
    default: ''
  }
}, {
  timestamps: true
});

settlementSchema.index({ storeId: 1, createdAt: -1 });
settlementSchema.index({ status: 1 });
settlementSchema.index({ periodStart: 1, periodEnd: 1 });

// Models
const StoreWallet = mongoose.model('StoreWallet', storeWalletSchema);
const WalletTransaction = mongoose.model('WalletTransaction', walletTransactionSchema);
const Settlement = mongoose.model('Settlement', settlementSchema);

module.exports = {
  StoreWallet,
  WalletTransaction,
  Settlement
};