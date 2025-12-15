// src/models/Hub.js
const mongoose = require('mongoose');

const hubSchema = new mongoose.Schema({
  // Unique identifier for this Pi/hub (matches MACHINE_ID in Pi's .env)
  hubId: { 
    type: String, 
    required: true, 
    unique: true,
    trim: true
  },
  
  // Display name for the hub
  name: { 
    type: String, 
    required: true 
  },
  
  // Store association
  storeId: { 
    type: String, 
    required: true,
    index: true
  },
  
  // Connection status
  status: {
    type: String,
    enum: ['online', 'offline', 'error', 'maintenance', 'restarting'],
    default: 'offline'
  },
  
  lastSeen: Date,
  lastHeartbeat: Date,
  
  // Network info
  ipAddress: String,
  macAddress: String,
  
  // Hardware details
  hardware: {
    model: String,           // "Raspberry Pi 4 Model B"
    serialNumber: String,
    cpuTemp: Number,
    memoryTotal: Number,
    diskTotal: Number,
    diskUsed: Number
  },
  
  // Software versions
  software: {
    piAppVersion: String,
    nodeVersion: String,
    osVersion: String,
    firmwareVersion: String
  },
  
  // Serial connection to Mutha Goose
  serialConfig: {
    port: { type: String, default: '/dev/ttyUSB0' },
    baudRate: { type: Number, default: 9600 },
    muthaGooseVersion: String
  },
  
  // Authentication token for this Pi
  machineToken: String,
  tokenGeneratedAt: Date,
  tokenExpiresAt: Date,
  
  // Configuration
  config: {
    reportingInterval: { type: Number, default: 30 },  // seconds
    syncInterval: { type: Number, default: 30 },       // seconds
    debugMode: { type: Boolean, default: false },
    autoRestart: { type: Boolean, default: true }
  },
  
  // Statistics
  stats: {
    totalMachinesConnected: { type: Number, default: 0 },
    totalEventsProcessed: { type: Number, default: 0 },
    totalEventsSynced: { type: Number, default: 0 },
    totalEventsQueued: { type: Number, default: 0 },
    uptime: Number,  // seconds
    lastRestart: Date
  },
  
  // Health monitoring
  health: {
    cpuUsage: Number,
    memoryUsage: Number,
    diskUsage: Number,
    serialConnected: { type: Boolean, default: false },
    apiConnected: { type: Boolean, default: false },
    lastError: String,
    lastErrorAt: Date
  },
  
  // Audit trail
  
  // Token Management (Auto-Renewal System)
  accessToken: { 
    type: String, 
    required: false,
    index: true 
  },
  accessTokenExpiresAt: { 
    type: Date, 
    required: false,
    index: true 
  },
  refreshToken: { 
    type: String, 
    required: false,
    unique: true,
    index: true 
  },
  refreshTokenExpiresAt: { 
    type: Date, 
    required: false 
  },
  tokenVersion: { 
    type: Number, 
    default: 1 
  },
  lastTokenRefresh: { type: Date },
  tokenRefreshCount: { type: Number, default: 0 },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  createdBy: String,
  lastModifiedBy: String
});

// Indexes for performance
hubSchema.index({ storeId: 1, status: 1 });
hubSchema.index({ lastSeen: -1 });
hubSchema.index({ status: 1 });

// Virtual for online status (considered online if heartbeat within 2 minutes)
hubSchema.virtual('isOnline').get(function() {
  if (!this.lastHeartbeat) return false;
  const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
  return this.lastHeartbeat > twoMinutesAgo;
});

// Instance methods
hubSchema.methods.updateHeartbeat = function(healthData = {}) {
  this.lastHeartbeat = new Date();
  this.lastSeen = new Date();
  this.status = 'online';
  
  if (healthData.cpu) this.health.cpuUsage = healthData.cpu;
  if (healthData.memory) this.health.memoryUsage = healthData.memory;
  if (healthData.disk) this.health.diskUsage = healthData.disk;
  if (healthData.serialConnected !== undefined) {
    this.health.serialConnected = healthData.serialConnected;
  }
  if (healthData.apiConnected !== undefined) {
    this.health.apiConnected = healthData.apiConnected;
  }
  
  this.updatedAt = new Date();
  return this.save();
};

hubSchema.methods.markOffline = function(reason) {
  this.status = 'offline';
  if (reason) {
    this.health.lastError = reason;
    this.health.lastErrorAt = new Date();
  }
  this.updatedAt = new Date();
  return this.save();
};

hubSchema.methods.recordError = function(error) {
  this.status = 'error';
  this.health.lastError = error;
  this.health.lastErrorAt = new Date();
  this.updatedAt = new Date();
  return this.save();
};

// Static methods
hubSchema.statics.findByStore = function(storeId) {
  return this.find({ storeId }).sort({ name: 1 });
};

hubSchema.statics.findOnline = function() {
  const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
  return this.find({ 
    lastHeartbeat: { $gte: twoMinutesAgo },
    status: 'online'
  });
};

hubSchema.statics.getStoreStats = function(storeId) {
  return this.aggregate([
    { $match: { storeId } },
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 }
      }
    }
  ]);
};

// Pre-save middleware to update timestamps
hubSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});



// ============================================================================
// TOKEN MANAGEMENT METHODS (Auto-Renewal System)
// ============================================================================

// Generate new access + refresh tokens
hubSchema.methods.generateTokens = function() {
  const jwt = require('jsonwebtoken');
  const crypto = require('crypto');
  
  // Short-lived access token (7 days)
  this.accessToken = jwt.sign(
    {
      hubId: this.hubId,
      storeId: this.storeId,
      type: 'hub',
      tokenVersion: this.tokenVersion,
      iat: Math.floor(Date.now() / 1000)
    },
    process.env.MACHINE_JWT_SECRET || process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
  this.accessTokenExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  
  // Long-lived refresh token (1 year)
  this.refreshToken = crypto.randomBytes(32).toString('hex');
  this.refreshTokenExpiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  
  this.lastTokenRefresh = new Date();
  this.tokenRefreshCount += 1;
  
  console.log(`🔑 Generated tokens for hub ${this.hubId} (version ${this.tokenVersion})`);
  
  return {
    accessToken: this.accessToken,
    refreshToken: this.refreshToken,
    expiresAt: this.accessTokenExpiresAt,
    expiresIn: 7 * 24 * 60 * 60 // seconds
  };
};

// Refresh access token using refresh token
hubSchema.methods.refreshAccessToken = function() {
  const jwt = require('jsonwebtoken');
  
  // Check if refresh token is still valid
  if (this.refreshTokenExpiresAt < new Date()) {
    throw new Error('Refresh token expired');
  }
  
  // Generate new access token
  this.accessToken = jwt.sign(
    {
      hubId: this.hubId,
      storeId: this.storeId,
      type: 'hub',
      tokenVersion: this.tokenVersion,
      iat: Math.floor(Date.now() / 1000)
    },
    process.env.MACHINE_JWT_SECRET || process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
  this.accessTokenExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  this.lastTokenRefresh = new Date();
  this.tokenRefreshCount += 1;
  
  console.log(`🔄 Refreshed access token for hub ${this.hubId}`);
  
  return {
    accessToken: this.accessToken,
    expiresAt: this.accessTokenExpiresAt,
    expiresIn: 7 * 24 * 60 * 60
  };
};

// Revoke all tokens (increment version)
hubSchema.methods.revokeTokens = function(reason = 'manual_revocation') {
  this.tokenVersion += 1;
  this.accessToken = null;
  this.refreshToken = null;
  this.accessTokenExpiresAt = null;
  this.refreshTokenExpiresAt = null;
  
  console.log(`🚫 Revoked tokens for hub ${this.hubId} - Reason: ${reason}`);
  
  return this.tokenVersion;
};

// Check if access token needs refresh (expires in < 24 hours)
hubSchema.methods.needsRefresh = function() {
  if (!this.accessTokenExpiresAt) return true;
  const hoursUntilExpiry = (this.accessTokenExpiresAt - Date.now()) / (1000 * 60 * 60);
  return hoursUntilExpiry < 24;
};

// Static method: Find hub by refresh token
hubSchema.statics.findByRefreshToken = function(refreshToken) {
  return this.findOne({ 
    refreshToken,
    refreshTokenExpiresAt: { $gt: new Date() }
  });
};

// Static method: Clean up expired tokens (for cron job)
hubSchema.statics.cleanupExpiredTokens = async function() {
  const result = await this.updateMany(
    { refreshTokenExpiresAt: { $lt: new Date() } },
    { 
      $set: { 
        accessToken: null, 
        refreshToken: null,
        accessTokenExpiresAt: null,
        refreshTokenExpiresAt: null
      } 
    }
  );
  console.log(`🧹 Cleaned up ${result.modifiedCount} expired tokens`);
  return result.modifiedCount;
};

module.exports = mongoose.model('Hub', hubSchema);