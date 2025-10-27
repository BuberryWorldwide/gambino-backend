// backend/src/models/Admin.js
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const adminSchema = new mongoose.Schema({
  // Basic Info
  firstName: { type: String, required: true },
  lastName: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true },
  phone: String,
  
  // Authentication
  passwordHash: { type: String, required: true },
  
  // Admin Level
  adminType: { 
    type: String, 
    enum: ['super_admin', 'store_admin', 'operator'], 
    required: true 
  },
  
  // Store Assignment (for store_admin and operator)
  assignedStores: [String], // Store IDs they can access
  primaryStore: String, // Main store for store_admin
  
  // Permissions
  permissions: {
    // User Management
    canViewUsers: { type: Boolean, default: false },
    canEditUsers: { type: Boolean, default: false },
    canCreateUsers: { type: Boolean, default: false },
    canDeleteUsers: { type: Boolean, default: false },
    
    // Transaction Management
    canViewTransactions: { type: Boolean, default: false },
    canProcessRefunds: { type: Boolean, default: false },
    canAdjustBalances: { type: Boolean, default: false },
    
    // Machine Management
    canViewMachines: { type: Boolean, default: false },
    canManageMachines: { type: Boolean, default: false },
    canViewMachineStats: { type: Boolean, default: false },
    
    // Financial
    canViewFinancials: { type: Boolean, default: false },
    canProcessPayouts: { type: Boolean, default: false },
    canViewRevenue: { type: Boolean, default: false },
    
    // System
    canViewSystemStats: { type: Boolean, default: false },
    canManageAdmins: { type: Boolean, default: false },
    canAccessAuditLogs: { type: Boolean, default: false },
    canManageTokens: { type: Boolean, default: false }
  },
  
  // Activity Tracking
  lastLogin: Date,
  loginCount: { type: Number, default: 0 },
  lastActivity: { type: Date, default: Date.now },
  ipAddress: String,
  
  // Status
  isActive: { type: Boolean, default: true },
  isVerified: { type: Boolean, default: false },
  mustChangePassword: { type: Boolean, default: true },
  
  // Metadata
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
  notes: String,
  
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, {
  timestamps: true
});

// Indexes
adminSchema.index({ email: 1 });
adminSchema.index({ adminType: 1 });
adminSchema.index({ assignedStores: 1 });

// Virtual fields
adminSchema.virtual('fullName').get(function() {
  return `${this.firstName} ${this.lastName}`;
});

// Instance methods
adminSchema.methods.setPassword = async function(password) {
  this.passwordHash = await bcrypt.hash(password, 12);
  this.mustChangePassword = false;
};

adminSchema.methods.checkPassword = async function(password) {
  return bcrypt.compare(password, this.passwordHash);
};

adminSchema.methods.hasPermission = function(permission) {
  return this.permissions[permission] === true;
};

adminSchema.methods.canAccessStore = function(storeId) {
  if (this.adminType === 'super_admin') return true;
  return this.assignedStores.includes(storeId);
};

adminSchema.methods.toSafeObject = function() {
  const obj = this.toObject();
  delete obj.passwordHash;
  return obj;
};

// Static methods for permission templates
adminSchema.statics.getPermissionTemplate = function(adminType) {
  const templates = {
    super_admin: {
      // Full access to everything
      canViewUsers: true,
      canEditUsers: true,
      canCreateUsers: true,
      canDeleteUsers: true,
      canViewTransactions: true,
      canProcessRefunds: true,
      canAdjustBalances: true,
      canViewMachines: true,
      canManageMachines: true,
      canViewMachineStats: true,
      canViewFinancials: true,
      canProcessPayouts: true,
      canViewRevenue: true,
      canViewSystemStats: true,
      canManageAdmins: true,
      canAccessAuditLogs: true,
      canManageTokens: true
    },
    store_admin: {
      // Store-specific management
      canViewUsers: true,
      canEditUsers: true,
      canCreateUsers: true,
      canDeleteUsers: false,
      canViewTransactions: true,
      canProcessRefunds: true,
      canAdjustBalances: false,
      canViewMachines: true,
      canManageMachines: true,
      canViewMachineStats: true,
      canViewFinancials: true,
      canProcessPayouts: false,
      canViewRevenue: true,
      canViewSystemStats: false,
      canManageAdmins: false,
      canAccessAuditLogs: false,
      canManageTokens: false
    },
    operator: {
      // Basic operations only
      canViewUsers: true,
      canEditUsers: false,
      canCreateUsers: true,
      canDeleteUsers: false,
      canViewTransactions: true,
      canProcessRefunds: false,
      canAdjustBalances: false,
      canViewMachines: true,
      canManageMachines: false,
      canViewMachineStats: true,
      canViewFinancials: false,
      canProcessPayouts: false,
      canViewRevenue: false,
      canViewSystemStats: false,
      canManageAdmins: false,
      canAccessAuditLogs: false,
      canManageTokens: false
    }
  };
  
  return templates[adminType] || {};
};

module.exports = mongoose.model('Admin', adminSchema);