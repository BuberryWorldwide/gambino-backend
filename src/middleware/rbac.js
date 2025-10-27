// src/middleware/rbac.js
const jwt = require('jsonwebtoken');

/**
 * RBAC Permission System for Gambino Admin
 * Centralized permission mapping and validation
 */

// Define all permissions in the system
const PERMISSIONS = {
  // User Management
  MANAGE_USERS: 'manage_users',
  VIEW_USERS: 'view_users',
  EDIT_USER_ROLES: 'edit_user_roles',
  
  // Store/Venue Management  
  VIEW_ALL_STORES: 'view_all_stores',
  VIEW_ASSIGNED_STORES: 'view_assigned_stores',
  MANAGE_ALL_STORES: 'manage_all_stores',
  MANAGE_ASSIGNED_STORES: 'manage_assigned_stores',
  CREATE_STORES: 'create_stores',
  
  // Financial & Reports
  VIEW_ALL_METRICS: 'view_all_metrics',
  VIEW_STORE_METRICS: 'view_store_metrics',
  SUBMIT_REPORTS: 'submit_reports',
  MANAGE_RECONCILIATION: 'manage_reconciliation',
  
  // Wallet Management
  VIEW_STORE_WALLETS: 'view_store_wallets',
  MANAGE_STORE_WALLETS: 'manage_store_wallets',
  
  // Machine Management
  VIEW_MACHINES: 'view_machines',
  MANAGE_MACHINES: 'manage_machines',
  VIEW_VENUES: 'view_venues',
  
  // System Operations
  SYSTEM_ADMIN: 'system_admin',
  VIEW_PROFILE: 'view_profile',
};

// Map roles to their permissions
const ROLE_PERMISSIONS = {
  super_admin: [
    PERMISSIONS.MANAGE_USERS,
    PERMISSIONS.VIEW_USERS,
    PERMISSIONS.EDIT_USER_ROLES,
    PERMISSIONS.VIEW_ALL_STORES,
    PERMISSIONS.MANAGE_ALL_STORES,
    PERMISSIONS.MANAGE_ASSIGNED_STORES,
    PERMISSIONS.CREATE_STORES,
    PERMISSIONS.VIEW_ALL_METRICS,
    PERMISSIONS.VIEW_STORE_METRICS,
    PERMISSIONS.SUBMIT_REPORTS,
    PERMISSIONS.MANAGE_RECONCILIATION,
    PERMISSIONS.VIEW_STORE_WALLETS,
    PERMISSIONS.MANAGE_STORE_WALLETS,
    PERMISSIONS.VIEW_MACHINES,
    PERMISSIONS.MANAGE_MACHINES,
    PERMISSIONS.VIEW_VENUES,
    PERMISSIONS.SYSTEM_ADMIN,
    PERMISSIONS.VIEW_PROFILE,
  ],
  
  gambino_ops: [
    PERMISSIONS.VIEW_USERS,
    PERMISSIONS.VIEW_ALL_STORES,
    PERMISSIONS.MANAGE_ALL_STORES,
    PERMISSIONS.CREATE_STORES,
    PERMISSIONS.VIEW_ALL_METRICS,
    PERMISSIONS.VIEW_STORE_METRICS,
    PERMISSIONS.SUBMIT_REPORTS,
    PERMISSIONS.MANAGE_RECONCILIATION,
    PERMISSIONS.VIEW_STORE_WALLETS,
    PERMISSIONS.MANAGE_STORE_WALLETS,
    PERMISSIONS.VIEW_MACHINES,
    PERMISSIONS.MANAGE_MACHINES,
    PERMISSIONS.VIEW_VENUES,
    PERMISSIONS.VIEW_PROFILE,
  ],
  
  venue_manager: [
    PERMISSIONS.VIEW_ASSIGNED_STORES,
    PERMISSIONS.MANAGE_ASSIGNED_STORES,
    PERMISSIONS.CREATE_STORES, // Can create stores they'll manage
    PERMISSIONS.VIEW_STORE_METRICS,
    PERMISSIONS.SUBMIT_REPORTS,
    PERMISSIONS.VIEW_STORE_WALLETS,
    PERMISSIONS.MANAGE_STORE_WALLETS,
    PERMISSIONS.VIEW_MACHINES,
    PERMISSIONS.VIEW_VENUES,
    PERMISSIONS.VIEW_PROFILE,
  ],
  
  venue_staff: [
    PERMISSIONS.VIEW_ASSIGNED_STORES,
    PERMISSIONS.VIEW_STORE_METRICS,
    PERMISSIONS.SUBMIT_REPORTS,
    PERMISSIONS.VIEW_MACHINES,
    PERMISSIONS.VIEW_VENUES,
    PERMISSIONS.VIEW_PROFILE,
  ],
  
  user: [
    PERMISSIONS.VIEW_PROFILE,
  ],
};

/**
 * Get all permissions for a role
 */
function getRolePermissions(role) {
  return ROLE_PERMISSIONS[role] || [];
}

/**
 * Check if a role has a specific permission
 */
function roleHasPermission(role, permission) {
  const permissions = getRolePermissions(role);
  return permissions.includes(permission);
}

/**
 * Check if user has access to a specific venue
 * @param {string} userRole - User's role
 * @param {Array} assignedVenues - User's assigned venues
 * @param {string} storeId - Store ID to check access for
 * @returns {Object} Access information
 */
function checkVenueAccess(userRole, assignedVenues = [], storeId) {
  // Admin roles have access to all venues
  if (['super_admin', 'gambino_ops'].includes(userRole)) {
    return {
      hasAccess: true,
      canManage: true,
      accessType: 'admin',
      reason: 'admin_role'
    };
  }
  
  // Regular users can access all venues for gameplay
  if (userRole === 'user') {
    return {
      hasAccess: true,
      canManage: false,
      accessType: 'player',
      reason: 'player_access'
    };
  }
  
  // Venue staff and managers need to be assigned to the venue
  if (['venue_staff', 'venue_manager'].includes(userRole)) {
    const hasAccess = assignedVenues.includes(storeId);
    return {
      hasAccess,
      canManage: userRole === 'venue_manager' && hasAccess,
      accessType: hasAccess ? 'venue_assigned' : 'denied',
      reason: hasAccess ? 'venue_assignment' : 'not_assigned'
    };
  }
  
  return {
    hasAccess: false,
    canManage: false,
    accessType: 'denied',
    reason: 'unknown_role'
  };
}

/**
 * Unified authentication middleware
 * Replaces all existing auth middleware
 */
const authenticate = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
      return res.status(401).json({ 
        error: 'Access token required',
        code: 'NO_TOKEN'
      });
    }

    jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret', (err, decoded) => {
      if (err) {
        console.error('Token verification failed:', err.message);
        return res.status(403).json({ 
          error: 'Invalid or expired token',
          code: 'INVALID_TOKEN'
        });
      }

      // Ensure all required fields are present
      req.user = {
        userId: decoded.userId,
        email: decoded.email,
        role: decoded.role || 'user',
        assignedVenues: decoded.assignedVenues || [],
        walletAddress: decoded.walletAddress || null,
        tier: decoded.tier || null,
      };

      // Add permission check helper to request
      req.user.hasPermission = (permission) => roleHasPermission(req.user.role, permission);
      req.user.getPermissions = () => getRolePermissions(req.user.role);

      console.log('🔐 User authenticated:', {
        userId: req.user.userId,
        role: req.user.role,
        email: req.user.email,
        assignedVenues: req.user.assignedVenues
      });

      return next();
    });
  } catch (error) {
    console.error('Authentication error:', error);
    return res.status(401).json({ 
      error: 'Authentication failed',
      code: 'AUTH_ERROR'
    });
  }
};

/**
 * Permission-based authorization middleware
 * @param {string|Array} requiredPermissions - Permission(s) required
 * @param {Object} options - Additional options
 */
const requirePermission = (requiredPermissions, options = {}) => {
  const permissions = Array.isArray(requiredPermissions) ? requiredPermissions : [requiredPermissions];
  
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ 
        error: 'Authentication required',
        code: 'NOT_AUTHENTICATED'
      });
    }

    const userRole = req.user.role;
    const userPermissions = getRolePermissions(userRole);
    
    // Check if user has any of the required permissions
    const hasPermission = permissions.some(permission => 
      userPermissions.includes(permission)
    );

    if (!hasPermission) {
      console.warn('🚫 Permission denied:', {
        userId: req.user.userId,
        userRole,
        requiredPermissions: permissions,
        userPermissions,
        endpoint: req.originalUrl
      });
      
      return res.status(403).json({
        error: 'Insufficient permissions',
        code: 'INSUFFICIENT_PERMISSIONS',
        required: permissions,
        current: userPermissions
      });
    }

    console.log('✅ Permission granted:', {
      userId: req.user.userId,
      userRole,
      grantedPermission: permissions.find(p => userPermissions.includes(p)),
      endpoint: req.originalUrl
    });

    next();
  };
};

/**
 * Venue-specific access control middleware
 * @param {Object} options - Configuration options
 */
const requireVenueAccess = (options = {}) => {
  const {
    requireManagement = false,
    allowPlayer = false,
    storeIdParam = 'storeId',
    requireActiveStore = true
  } = options;

  return async (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({ 
          error: 'Authentication required',
          code: 'NOT_AUTHENTICATED'
        });
      }

      const storeId = req.params[storeIdParam] || req.body[storeIdParam] || req.query[storeIdParam];
      
      if (!storeId) {
        return res.status(400).json({ 
          error: `Store ID required in parameter: ${storeIdParam}`,
          code: 'MISSING_STORE_ID'
        });
      }

      const { userId, role, assignedVenues } = req.user;
      
      // Check venue access
      const accessInfo = checkVenueAccess(role, assignedVenues, storeId);
      
      if (!accessInfo.hasAccess) {
        console.warn('🚫 Venue access denied:', {
          userId,
          userRole: role,
          storeId,
          assignedVenues,
          reason: accessInfo.reason,
          endpoint: req.originalUrl
        });
        
        return res.status(403).json({
          error: 'Access denied to this venue',
          code: 'VENUE_ACCESS_DENIED',
          storeId,
          reason: accessInfo.reason
        });
      }

      // Check if management access is required
      if (requireManagement && !accessInfo.canManage) {
        return res.status(403).json({
          error: 'Management permissions required for this venue operation',
          code: 'VENUE_MANAGEMENT_REQUIRED',
          storeId
        });
      }

      // Check if player access is allowed
      if (accessInfo.accessType === 'player' && !allowPlayer) {
        return res.status(403).json({
          error: 'Players cannot access venue management functions',
          code: 'PLAYER_ACCESS_DENIED',
          storeId
        });
      }

      // Validate store exists and is active (if required)
      if (requireActiveStore) {
        const Store = require('../models/Store'); // Adjust path as needed
        const store = await Store.findOne({ storeId }).lean();
        
        if (!store) {
          return res.status(404).json({
            error: 'Store not found',
            code: 'STORE_NOT_FOUND',
            storeId
          });
        }
        
        // Allow super_admin to access inactive stores
        if (store.status !== 'active' && req.user.role !== 'super_admin') {
          return res.status(403).json({ 
            error: 'Store is not active', 
            code: 'STORE_INACTIVE' 
          });
        }

        // Optional: Log super admin access to inactive stores for audit trail
        if (store.status !== 'active' && req.user.role === 'super_admin') {
          console.log(`🔐 Super admin ${req.user.userId} accessing inactive store ${store.storeId} (status: ${store.status})`);
        }
        
        req.store = store;
      }

      // Add venue access info to request
      req.venueAccess = {
        ...accessInfo,
        storeId,
        requireManagement,
        allowPlayer
      };

      console.log('✅ Venue access granted:', {
        userId,
        userRole: role,
        storeId,
        accessType: accessInfo.accessType,
        canManage: accessInfo.canManage,
        endpoint: req.originalUrl
      });

      next();
    } catch (error) {
      console.error('Venue access middleware error:', error);
      return res.status(500).json({ 
        error: 'Access control check failed',
        code: 'ACCESS_CHECK_ERROR'
      });
    }
  };
};

/**
 * Legacy role-based middleware (for backward compatibility)
 * @param {Array} allowedRoles - Array of allowed roles
 * @deprecated Use requirePermission instead
 */
const requireRole = (allowedRoles) => {
  console.warn('requireRole is deprecated. Use requirePermission instead.');
  
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ 
        error: 'Authentication required',
        code: 'NOT_AUTHENTICATED'
      });
    }

    const userRole = req.user.role;
    
    if (!allowedRoles.includes(userRole)) {
      return res.status(403).json({
        error: 'Insufficient permissions',
        code: 'INSUFFICIENT_PERMISSIONS',
        required: allowedRoles,
        current: userRole
      });
    }
    
    next();
  };
};

/**
 * Create middleware chain for venue operations
 * @param {Object} options - Configuration options
 * @returns {Array} Array of middleware functions
 */
const createVenueMiddleware = (options = {}) => {
  return [
    authenticate,
    requireVenueAccess(options)
  ];
};

module.exports = {
  PERMISSIONS,
  ROLE_PERMISSIONS,
  getRolePermissions,
  roleHasPermission,
  checkVenueAccess,
  authenticate,
  requirePermission,
  requireVenueAccess,
  requireRole, // deprecated
  createVenueMiddleware,
};