// src/models/Session.js - FINAL CORRECTED VERSION
const mongoose = require('mongoose');
const crypto = require('crypto');

const sessionSchema = new mongoose.Schema({
  sessionId: { 
    type: String, 
    required: true, 
    unique: true,
    default: function() {
      return crypto.randomBytes(16).toString('hex');
    }
  },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  machineId: { type: String, required: true },
  storeId: { type: String, required: true },
  status: { type: String, enum: ['active', 'paused', 'completed'], default: 'active' },
  startedAt: { type: Date, default: Date.now },
  endedAt: Date,
  lastActivity: { type: Date, default: Date.now },
  totalBets: { type: Number, default: 0 },
  totalWinnings: { type: Number, default: 0 },
  gameEvents: [Object],
  
  // Session details
  machineName: String,
  storeName: String,
  location: String,
  
  // Tracking
  clientIP: String,
  userAgent: String,
  
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Pre-save middleware
sessionSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  
  // Ensure sessionId exists
  if (!this.sessionId) {
    this.sessionId = crypto.randomBytes(16).toString('hex');
  }
  
  next();
});

// Indexes
sessionSchema.index({ sessionId: 1 }, { unique: true });
sessionSchema.index({ userId: 1, status: 1 });
sessionSchema.index({ userId: 1, startedAt: -1 });
sessionSchema.index({ machineId: 1, status: 1 });

// Instance methods
sessionSchema.methods.updateActivity = function() {
  this.lastActivity = new Date();
  return this.save();
};

sessionSchema.methods.endSession = function() {
  this.status = 'completed';
  this.endedAt = new Date();
  return this.save();
};

// Static methods
sessionSchema.statics.findActiveSession = function(userId) {
  return this.findOne({ userId, status: 'active' });
};

sessionSchema.statics.findActiveSessionForMachine = function(machineId) {
  return this.findOne({ machineId, status: 'active' });
};

module.exports = mongoose.model('Session', sessionSchema);