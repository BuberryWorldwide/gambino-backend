const mongoose = require('mongoose');

const transferSchema = new mongoose.Schema({
  fromUserId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true 
  },
  toUserId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true 
  },
  amount: { 
    type: Number, 
    required: true 
  },
  token: { 
    type: String, 
    enum: ['GG', 'USDC'], 
    required: true 
  },
  status: { 
    type: String, 
    enum: ['pending', 'completed', 'failed'], 
    default: 'pending' 
  },
  transactionHash: String,
  storeId: String, // If transfers are store-related
  createdAt: { 
    type: Date, 
    default: Date.now 
  },
  updatedAt: { 
    type: Date, 
    default: Date.now 
  }
});

// Index for performance
transferSchema.index({ createdAt: -1 });
transferSchema.index({ fromUserId: 1 });
transferSchema.index({ toUserId: 1 });

module.exports = mongoose.model('Transfer', transferSchema);