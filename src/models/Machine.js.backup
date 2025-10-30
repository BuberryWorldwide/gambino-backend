// src/models/Machine.js
const mongoose = require('mongoose');

const machineSchema = new mongoose.Schema({
  machineId: { type: String, required: true, unique: true },
  storeId: { type: String, required: true },
  name: { type: String }, // Display name like "Lucky Slots #1"
  location: String, // Physical location within store "Near entrance"
  hubId: String, // For Pi connection - unique identifier for hardware
  qrCode: { type: String }, // Base64 QR code image
  qrToken: { type: String }, // The binding token
  qrGeneratedAt: { type: Date },
  gameType: { 
    type: String, 
    enum: ['slot', 'poker', 'blackjack', 'roulette', 'edge', 'other'], 
    default: 'slot' 
  },
  status: { 
    type: String, 
    enum: ['active', 'inactive', 'maintenance'], 
    default: 'active' 
  },
  statusHistory: [{ // Track all status changes
    from: String,
    to: String,
    reason: String,
    timestamp: { type: Date, default: Date.now },
    changedBy: String // Admin who made the change
  }],

  // MUTHA GOOSE MAPPING FIELDS (NEW)
  muthaGooseNumber: { 
    type: Number, 
    min: 1, 
    max: 99,
    sparse: true, // Allows multiple null values but unique non-null values
    index: true
  },
  muthaGooseId: { 
    type: String, 
    sparse: true,
    index: true 
  }, // e.g., "machine_03"
  
  // Hub/Pi association for Mutha Goose mapping
  hubMachineId: { 
    type: String, 
    index: true 
  }, // e.g., "hub-casino1-floor1" - this maps to your existing hubId concept
  
  // Mapping status and activity tracking
  mappingStatus: { 
    type: String, 
    enum: ['unmapped', 'mapped', 'conflict'], 
    default: 'unmapped' 
  },
  lastMuthaGooseActivity: Date,
  mappingHistory: [{ // Track mapping changes
    action: { type: String, enum: ['mapped', 'unmapped', 'remapped'] },
    muthaGooseNumber: Number,
    hubMachineId: String,
    timestamp: { type: Date, default: Date.now },
    changedBy: String
  }],
  
  // Pi Integration Fields
  lastSeen: { type: Date }, // Last time Pi checked in
  piVersion: String, // Version of Pi software
  connectionStatus: { 
    type: String, 
    enum: ['connected', 'disconnected', 'error'], 
    default: 'disconnected' 
  },
  
  // Configuration for Pi
  settings: {
    reportingInterval: { type: Number, default: 30 }, // seconds between reports
    enableDebug: { type: Boolean, default: false },
    gameSettings: {
      minBet: { type: Number, default: 1 },
      maxBet: { type: Number, default: 100 },
      jackpotThreshold: { type: Number, default: 1000 }
    }
  },
  
  // Statistics (can be updated by Pi reports)
  stats: {
    totalSessions: { type: Number, default: 0 },
    totalBets: { type: Number, default: 0 },
    totalWinnings: { type: Number, default: 0 },
    lastPlayedAt: { type: Date },
    averageSessionTime: { type: Number, default: 0 } // minutes
  },
  
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Indexes for performance
machineSchema.index({ machineId: 1 });
machineSchema.index({ storeId: 1 });
machineSchema.index({ status: 1 });
machineSchema.index({ lastSeen: -1 });

// NEW: Compound index for hub + mutha goose number uniqueness
machineSchema.index({ hubMachineId: 1, muthaGooseNumber: 1 }, { unique: true, sparse: true });
machineSchema.index({ hubMachineId: 1, muthaGooseId: 1 }, { unique: true, sparse: true });

// Instance methods
machineSchema.methods.updateStatus = function(newStatus, reason, changedBy) {
  const oldStatus = this.status;
  this.status = newStatus;
  this.updatedAt = new Date();
  
  if (!this.statusHistory) this.statusHistory = [];
  this.statusHistory.push({
    from: oldStatus,
    to: newStatus,
    reason: reason || 'Status change',
    timestamp: new Date(),
    changedBy: changedBy || 'system'
  });
  
  return this.save();
};

machineSchema.methods.recordActivity = function(activityData) {
  this.lastSeen = new Date();
  this.connectionStatus = 'connected';
  
  if (activityData) {
    // Update stats based on activity data from Pi
    if (activityData.sessionCount) {
      this.stats.totalSessions += activityData.sessionCount;
    }
    if (activityData.betCount) {
      this.stats.totalBets += activityData.betCount;
    }
    if (activityData.winnings) {
      this.stats.totalWinnings += activityData.winnings;
    }
    this.stats.lastPlayedAt = new Date();
  }
  
  return this.save();
};

// NEW: Mutha Goose mapping methods
machineSchema.methods.mapToMuthaGoose = function(muthaGooseNumber, hubMachineId, changedBy) {
  const muthaGooseId = `machine_${muthaGooseNumber.toString().padStart(2, '0')}`;
  
  this.muthaGooseNumber = muthaGooseNumber;
  this.muthaGooseId = muthaGooseId;
  this.hubMachineId = hubMachineId;
  this.mappingStatus = 'mapped';
  this.updatedAt = new Date();
  
  if (!this.mappingHistory) this.mappingHistory = [];
  this.mappingHistory.push({
    action: 'mapped',
    muthaGooseNumber,
    hubMachineId,
    timestamp: new Date(),
    changedBy: changedBy || 'admin'
  });
  
  console.log(`✅ Machine mapped: ${this.displayName} → MG${muthaGooseNumber} (${muthaGooseId})`);
  return this.save();
};

machineSchema.methods.unmapFromMuthaGoose = function(changedBy) {
  const oldNumber = this.muthaGooseNumber;
  const oldHubId = this.hubMachineId;
  
  this.muthaGooseNumber = null;
  this.muthaGooseId = null;
  this.hubMachineId = null;
  this.mappingStatus = 'unmapped';
  this.updatedAt = new Date();
  
  if (!this.mappingHistory) this.mappingHistory = [];
  this.mappingHistory.push({
    action: 'unmapped',
    muthaGooseNumber: oldNumber,
    hubMachineId: oldHubId,
    timestamp: new Date(),
    changedBy: changedBy || 'admin'
  });
  
  console.log(`🗑️ Machine unmapped: ${this.displayName} from MG${oldNumber}`);
  return this.save();
};

machineSchema.methods.recordMuthaGooseActivity = function() {
  this.lastMuthaGooseActivity = new Date();
  this.lastSeen = new Date(); // Also update general activity
  this.connectionStatus = 'connected';
  return this.save();
};

// Static methods
machineSchema.statics.findByStore = function(storeId) {
  return this.find({ storeId }).sort({ createdAt: -1 });
};

machineSchema.statics.getActiveCount = function() {
  return this.countDocuments({ status: 'active' });
};

machineSchema.statics.getStoreStats = function(storeId) {
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

// NEW: Mutha Goose mapping static methods
machineSchema.statics.findByMuthaGoose = function(muthaGooseId, hubMachineId) {
  return this.findOne({ muthaGooseId, hubMachineId });
};

machineSchema.statics.getMappingStats = function(storeId) {
  const matchQuery = storeId ? { storeId } : {};
  
  return this.aggregate([
    { $match: matchQuery },
    {
      $group: {
        _id: '$mappingStatus',
        count: { $sum: 1 }
      }
    }
  ]);
};

machineSchema.statics.getUnmappedMuthaGooseActivity = function(storeId, hoursBack = 24) {
  // This would be called from your analytics/events service
  // Returns machines that have Mutha Goose activity but no mapping
  const Event = require('./Event'); // Adjust path as needed
  
  const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000);
  
  return Event.aggregate([
    { 
      $match: { 
        timestamp: { $gte: since },
        gamingMachineId: { $exists: true },
        ...(storeId && { storeId })
      }
    },
    {
      $group: {
        _id: {
          gamingMachineId: '$gamingMachineId',
          hubMachineId: '$machineId' // Pi hub ID
        },
        firstSeen: { $min: '$timestamp' },
        lastSeen: { $max: '$timestamp' },
        eventCount: { $sum: 1 },
        eventTypes: { $addToSet: '$eventType' }
      }
    },
    { $sort: { lastSeen: -1 } }
  ]);
};

// Virtual for display name
machineSchema.virtual('displayName').get(function() {
  return this.name || `Machine ${this.machineId}`;
});

// Virtual for connection health
machineSchema.virtual('isHealthy').get(function() {
  if (!this.lastSeen) return false;
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
  return this.lastSeen > fiveMinutesAgo && this.status === 'active';
});

// NEW: Virtual for Mutha Goose mapping status
machineSchema.virtual('isMapped').get(function() {
  return this.mappingStatus === 'mapped' && this.muthaGooseId;
});

machineSchema.virtual('muthaGooseDisplayName').get(function() {
  if (this.muthaGooseNumber) {
    return `MG${this.muthaGooseNumber.toString().padStart(2, '0')}`;
  }
  return null;
});

// Pre-save middleware to update timestamps
machineSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('Machine', machineSchema);