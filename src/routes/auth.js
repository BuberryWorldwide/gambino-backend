// routes/auth.js
const express = require('express');
const bcryptjs = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
// Remove User import - will be passed from server.js
const { ROLE_PERMISSIONS, getRolePermissions, authenticate } = require('../middleware/rbac');

const router = express.Router();

// Rate limiting for login attempts
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 attempts per email per IP
  keyGenerator: (req) => {
    // Combine IP and email/username for unique rate limit key
    const identifier = req.body.email || req.body.username || req.body.identifier || 'unknown';
    return `${req.ip}:${identifier}`;
  },
  message: { error: 'Too many login attempts for this account. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Determine user's primary destination based on role and venue assignments
 */
function determineUserDestination(role, assignedVenues = []) {
  switch (role) {
    case 'super_admin':
    case 'gambino_ops':
      return {
        redirectTo: '/admin/dashboard',
        area: 'admin',
        message: 'Welcome to Gambino Admin'
      };
    
    case 'venue_manager':
      if (assignedVenues.length === 0) {
        // Venue manager with no assigned venues - needs admin attention
        return {
          redirectTo: '/admin/profile',
          area: 'admin',
          message: 'Welcome! Please contact admin to assign venues to your account.',
          warning: 'No venues assigned'
        };
      } else if (assignedVenues.length === 1) {
        // Single venue - go directly to that venue's management
        return {
          redirectTo: `/admin/stores/${assignedVenues[0]}`,
          area: 'admin',
          message: `Welcome! Managing venue: ${assignedVenues[0]}`
        };
      } else {
        // Multiple venues - show venues list
        return {
          redirectTo: '/admin/stores',
          area: 'admin',
          message: `Welcome! You manage ${assignedVenues.length} venues`
        };
      }
    
    case 'venue_staff':
      if (assignedVenues.length === 0) {
        // Venue staff with no assigned venues
        return {
          redirectTo: '/admin/profile',
          area: 'admin',
          message: 'Welcome! Please contact your manager to assign venues.',
          warning: 'No venues assigned'
        };
      } else if (assignedVenues.length === 1) {
        // Single venue - go to reports for that venue
        return {
          redirectTo: `/admin/reports?storeId=${assignedVenues[0]}`,
          area: 'admin',
          message: `Welcome! Access to venue: ${assignedVenues[0]}`
        };
      } else {
        // Multiple venues - show reports overview
        return {
          redirectTo: '/admin/reports',
          area: 'admin',
          message: `Welcome! You have access to ${assignedVenues.length} venues`
        };
      }
    
    case 'user':
    default:
      return {
        redirectTo: '/dashboard',
        area: 'user',
        message: 'Welcome back!'
      };
  }
}

/**
 * Generate JWT token with all necessary user data
 */
function generateToken(user) {
  const payload = {
    userId: user._id,
    email: user.email,
    role: user.role,
    assignedVenues: user.assignedVenues || [],
    walletAddress: user.walletAddress || null,
    tier: user.tier || null,
  };

  return jwt.sign(
    payload,
    process.env.JWT_SECRET || 'fallback_secret',
    { 
      expiresIn: '24h',
      issuer: 'gambino-admin',
      audience: 'gambino-users'
    }
  );
}

/**
 * Create auth routes with User model dependency
 */
function createAuthRoutes(User) {
  /**
   * UNIFIED LOGIN ENDPOINT
   * Replaces both /api/users/login and /api/admin/login
   */
  router.post('/login', loginLimiter, async (req, res) => {
    try {
      const { email, password } = req.body;

      // Validate input
      if (!email || !password) {
        return res.status(400).json({
          success: false,
          error: 'Email and password are required',
          code: 'MISSING_CREDENTIALS'
        });
      }

      const normalizedEmail = String(email).toLowerCase().trim();

      // Find user with password field
      const user = await User.findOne({ email: normalizedEmail })
        .select('+password role firstName lastName isActive assignedVenues walletAddress tier');

      if (!user) {
        // Use same error for security (don't reveal if email exists)
        return res.status(401).json({
          success: false,
          error: 'Invalid credentials',
          code: 'INVALID_CREDENTIALS'
        });
      }

      // Check if user is active
      if (user.isActive === false) {
        return res.status(403).json({
          success: false,
          error: 'Account has been deactivated. Please contact support.',
          code: 'ACCOUNT_INACTIVE'
        });
      }

      // Verify password
      if (!user.password) {
        return res.status(500).json({
          success: false,
          error: 'Account configuration error. Please contact support.',
          code: 'NO_PASSWORD'
        });
      }

      const isValidPassword = await bcryptjs.compare(password, user.password);
      if (!isValidPassword) {
        return res.status(401).json({
          success: false,
          error: 'Invalid credentials',
          code: 'INVALID_CREDENTIALS'
        });
      }

      // Update last activity
      user.lastActivity = new Date();
      await user.save();

      // Generate token
      const token = generateToken(user);

      // Determine where user should be redirected
      const destination = determineUserDestination(user.role, user.assignedVenues);

      // Get user permissions
      const permissions = getRolePermissions(user.role);

      // Prepare user data for response
      const userData = {
        id: user._id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        assignedVenues: user.assignedVenues || [],
        walletAddress: user.walletAddress,
        tier: user.tier,
        permissions,
        ...destination
      };

      console.log('✅ Successful login:', {
        userId: user._id,
        email: user.email,
        role: user.role,
        area: destination.area,
        assignedVenues: user.assignedVenues?.length || 0,
        timestamp: new Date()
      });

      return res.json({
        success: true,
        message: destination.message,
        token,
        user: userData,
        // Server-side routing information
        redirectTo: destination.redirectTo,
        area: destination.area,
        timestamp: new Date()
      });

    } catch (error) {
      console.error('❌ Login error:', error);
      return res.status(500).json({
        success: false,
        error: 'Login failed. Please try again.',
        code: 'LOGIN_ERROR'
      });
    }
  });

  /**
   * TOKEN REFRESH ENDPOINT
   * Uses RBAC authenticate middleware for token verification
   */
  router.post('/refresh', authenticate, async (req, res) => {
    try {
      // User is already verified by authenticate middleware
      const userId = req.user.userId;

      // Get fresh user data from database
      const user = await User.findById(userId)
        .select('role firstName lastName isActive assignedVenues walletAddress tier email');

      if (!user || user.isActive === false) {
        return res.status(403).json({
          success: false,
          error: 'Account not accessible',
          code: 'ACCOUNT_INACCESSIBLE'
        });
      }

      // Generate new token with fresh data
      const newToken = generateToken(user);
      const destination = determineUserDestination(user.role, user.assignedVenues);
      const permissions = getRolePermissions(user.role);

      const userData = {
        id: user._id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        assignedVenues: user.assignedVenues || [],
        walletAddress: user.walletAddress,
        tier: user.tier,
        permissions,
        ...destination
      };

      console.log('🔄 Token refreshed:', {
        userId: user._id,
        role: user.role,
        newPermissions: permissions.length,
        timestamp: new Date()
      });

      return res.json({
        success: true,
        message: 'Token refreshed successfully',
        token: newToken,
        user: userData,
        redirectTo: destination.redirectTo,
        area: destination.area,
        timestamp: new Date()
      });

    } catch (error) {
      console.error('❌ Token refresh error:', error);
      return res.status(500).json({
        success: false,
        error: 'Token refresh failed',
        code: 'REFRESH_ERROR'
      });
    }
  });

  /**
   * USER PROFILE ENDPOINT
   * Uses RBAC authenticate middleware
   */
  router.get('/profile', authenticate, async (req, res) => {
    try {
      // User is already verified by authenticate middleware
      const userId = req.user.userId;

      // Get user data
      const user = await User.findById(userId);

      if (!user || user.isActive === false) {
        return res.status(403).json({
          success: false,
          error: 'Account not accessible',
          code: 'ACCOUNT_INACCESSIBLE'
        });
      }

      const destination = determineUserDestination(user.role, user.assignedVenues);
      const permissions = getRolePermissions(user.role);

      const userData = {
        id: user._id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        phone: user.phone,
        role: user.role,
        assignedVenues: user.assignedVenues || [],
        walletAddress: user.walletAddress,
        gambinoBalance: user.gambinoBalance || 0,
        gluckScore: user.gluckScore || 0,
        tier: user.tier,
        totalJackpots: user.totalJackpots || 0,
        createdAt: user.createdAt,
        permissions,
        ...destination
      };

      return res.json({
        success: true,
        user: userData
      });

    } catch (error) {
      console.error('❌ Profile error:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to load profile',
        code: 'PROFILE_ERROR'
      });
    }
  });

  /**
   * LOGOUT ENDPOINT
   * Optional - for token blacklisting if implemented
   */
  router.post('/logout', (req, res) => {
    // In a JWT system, logout is typically handled client-side
    // But you could implement token blacklisting here if needed
    
    console.log('📤 User logout:', {
      timestamp: new Date(),
      ip: req.ip,
      userAgent: req.get('User-Agent')
    });

    return res.json({
      success: true,
      message: 'Logged out successfully',
      timestamp: new Date()
    });
  });

  return router;
}

module.exports = createAuthRoutes;