const mongoose = require('mongoose');

const treasuryWalletSchema = new mongoose.Schema({
  label: {
    type: String,
    required: true,
    trim: true
  },
  purpose: {
    type: String,
    required: true,
    enum: ['main', 'jackpot', 'ops', 'team', 'community', 'store_float', 'other'],
    default: 'other'
  },
  publicKey: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  privateKeyEncrypted: {
    type: String,
    required: true
  },
  balances: {
    SOL: { type: Number, default: null },
    GG: { type: Number, default: null },
    USDC: { type: Number, default: null },
    lastUpdated: { type: Date, default: null }
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  },
    cachedBalances: {
    SOL: { type: Number, default: null },
    GG: { type: Number, default: null },
    USDC: { type: Number, default: null },
    lastUpdated: { type: Date, default: null },
    updateAttempts: { type: Number, default: 0 },
    lastError: { type: String, default: null }
  }
  
});

module.exports = mongoose.model('TreasuryWallet', treasuryWalletSchema);