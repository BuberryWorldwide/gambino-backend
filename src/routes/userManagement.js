// src/routes/userManagement.js
const express = require('express');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const router = express.Router();

// Import middleware and models
const { authenticate, requirePermission, PERMISSIONS } = require('../middleware/rbac');

// User management routes factory function
const createUserManagementRoutes = (User, Session, Transfer, Transaction) => {
  
  // GET ALL USERS with pagination and filtering
  router.get('/', authenticate, requirePermission(PERMISSIONS.VIEW_USERS), async (req, res) => {
    try {
      const { 
        page = 1, 
        limit = 20, 
        search, 
        role, 
        status 
      } = req.query;

      const pageNum = Math.max(1, parseInt(page));
      const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
      const skip = (pageNum - 1) * limitNum;

      const where = {};

      // Search filter
      if (search) {
        where.$or = [
          { email: new RegExp(search, 'i') },
          { firstName: new RegExp(search, 'i') },
          { lastName: new RegExp(search, 'i') }
        ];
      }

      // Role filter
      if (role && role !== 'all') {
        where.role = role;
      }

      // Status filter
      if (status === 'active') {
        where.isActive = true;
      } else if (status === 'inactive') {
        where.isActive = false;
      }

      const [users, total] = await Promise.all([
        User.find(where)
          .select('firstName lastName email walletAddress role isActive createdAt assignedVenues cachedGambinoBalance lastActivity')
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limitNum)
          .lean(),
        User.countDocuments(where)
      ]);

      res.json({ 
        success: true,
        users, 
        pagination: {
          page: pageNum,
          limit: limitNum,
          total,
          pages: Math.ceil(total / limitNum)
        },
        filters: { search, role, status }
      });

    } catch (error) {
      console.error('Admin users list error:', error);
      res.status(500).json({ error: 'Failed to load users' });
    }
  });

  // GET USER DETAILS
  router.get('/:userId', authenticate, requirePermission(PERMISSIONS.MANAGE_USERS), async (req, res) => {
    try {
      const { userId } = req.params;

      const user = await User.findById(userId)
        .select('-password -privateKey -privateKeyIV')
        .lean();

      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Get additional stats
      const [sessionCount, transferCount, transactionCount] = await Promise.all([
        Session.countDocuments({ userId }),
        Transfer.countDocuments({ fromUserId: userId }),
        Transaction.countDocuments({ userId })
      ]);

      const userDetails = {
        ...user,
        stats: {
          totalSessions: sessionCount,
          totalTransfers: transferCount,
          totalTransactions: transactionCount
        }
      };

      res.json({
        success: true,
        user: userDetails
      });

    } catch (error) {
      console.error('Get user details error:', error);
      res.status(500).json({ error: 'Failed to get user details' });
    }
  });

  // CREATE NEW USER
  router.post('/create', authenticate, requirePermission(PERMISSIONS.MANAGE_USERS), async (req, res) => {
    try {
      console.log('📝 Create user request body:', req.body);
      
      const { 
        firstName, lastName, email, phone, password, 
        role = 'user', assignedVenues = [] 
      } = req.body;

      if (!firstName || !lastName || !email || !password) {
        return res.status(400).json({ 
          error: 'firstName, lastName, email, password required' 
        });
      }

      const existing = await User.findOne({ email: email.toLowerCase() });
      
      if (existing) {
        return res.status(409).json({ error: 'Email already exists' });
      }

      const hashedPassword = await bcrypt.hash(password, 12);

      const user = await User.create({
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: email.toLowerCase().trim(),
        phone: phone?.trim() || '',
        password: hashedPassword,
        role,
        assignedVenues,
        isActive: true,
        isVerified: true
      });

      console.log('✅ User created in database');

      res.status(201).json({ 
        success: true, 
        message: 'User created successfully'
      });

    } catch (error) {
      console.error('❌ Create user error:', error);
      res.status(500).json({ error: 'Failed to create user' });
    }
  });

  // UPDATE USER
  router.put('/:userId', authenticate, requirePermission(PERMISSIONS.MANAGE_USERS), async (req, res) => {
    try {
      const { userId } = req.params;
      const { firstName, lastName, email, phone, role, assignedVenues, isActive } = req.body;

      console.log('📝 Update user request:', { userId, body: req.body });

      const user = await User.findById(userId);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      const updates = {};
      if (firstName !== undefined) updates.firstName = firstName.trim();
      if (lastName !== undefined) updates.lastName = lastName.trim();
      if (email !== undefined) updates.email = email.toLowerCase().trim();
      if (phone !== undefined) updates.phone = phone.trim();
      if (role !== undefined) updates.role = role;
      if (assignedVenues !== undefined) updates.assignedVenues = assignedVenues;
      if (isActive !== undefined) updates.isActive = isActive;

      const updatedUser = await User.findByIdAndUpdate(
        userId, 
        updates, 
        { new: true, runValidators: true }
      ).select('firstName lastName email role assignedVenues isActive');

      console.log('✅ User updated:', updatedUser.email);

      res.json({ 
        success: true, 
        message: 'User updated successfully',
        user: updatedUser
      });
    } catch (error) {
      console.error('Update user error:', error);
      res.status(500).json({ error: 'Failed to update user' });
    }
  });

  // DELETE USER
  router.delete('/:userId', authenticate, requirePermission(PERMISSIONS.MANAGE_USERS), async (req, res) => {
    try {
      const { userId } = req.params;
      const currentUserId = req.user.userId;

      // Prevent self-deletion
      if (userId === currentUserId) {
        return res.status(400).json({ error: 'Cannot delete your own account' });
      }

      // Check if user exists
      const user = await User.findById(userId);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Audit log
      console.log(`🗑️ Super admin ${req.user.email} deleting user: ${user.email}`);

      // Delete the user
      await User.findByIdAndDelete(userId);

      // Clean up related data
      await Promise.all([
        Session.deleteMany({ userId }),
        Transfer.deleteMany({ fromUserId: userId }),
        Transaction.deleteMany({ userId })
      ]);

      res.json({ 
        success: true, 
        message: 'User deleted successfully' 
      });

    } catch (error) {
      console.error('Delete user error:', error);
      res.status(500).json({ error: 'Failed to delete user' });
    }
  });

  // UPDATE USER STATUS
  router.patch('/:userId/status', authenticate, requirePermission(PERMISSIONS.MANAGE_USERS), async (req, res) => {
    try {
      const { userId } = req.params;
      const { isActive } = req.body;
      const currentUserId = req.user.userId;

      // Prevent self-modification
      if (userId === currentUserId) {
        return res.status(400).json({ error: 'Cannot modify your own account status' });
      }

      const user = await User.findById(userId);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Update status
      const updatedUser = await User.findByIdAndUpdate(
        userId,
        { 
          isActive: Boolean(isActive),
          lastActivity: new Date()
        },
        { new: true }
      ).select('firstName lastName email isActive');

      console.log(`🔄 Status change: ${user.email} is now ${isActive ? 'active' : 'inactive'} by ${req.user.email}`);

      res.json({
        success: true,
        message: `User ${isActive ? 'activated' : 'deactivated'} successfully`,
        user: updatedUser
      });

    } catch (error) {
      console.error('Update user status error:', error);
      res.status(500).json({ error: 'Failed to update user status' });
    }
  });

  // BULK DELETE USERS
  router.post('/bulk-delete', authenticate, requirePermission(PERMISSIONS.MANAGE_USERS), async (req, res) => {
    try {
      const { userIds } = req.body;
      const currentUserId = req.user.userId;

      if (!Array.isArray(userIds) || userIds.length === 0) {
        return res.status(400).json({ error: 'Invalid user IDs provided' });
      }

      // Remove current user from the list
      const filteredUserIds = userIds.filter(id => id !== currentUserId);

      if (filteredUserIds.length === 0) {
        return res.status(400).json({ error: 'Cannot delete your own account' });
      }

      // Get users to be deleted for logging
      const usersToDelete = await User.find({ 
        _id: { $in: filteredUserIds } 
      }).select('email firstName lastName').lean();

      console.log(`🗑️ Bulk delete: ${req.user.email} deleting ${usersToDelete.length} users`);

      // Use MongoDB transaction for consistency
      const session = await mongoose.startSession();
      
      try {
        await session.withTransaction(async () => {
          // Delete users
          await User.deleteMany({ _id: { $in: filteredUserIds } }).session(session);
          
          // Clean up related data
          await Promise.all([
            Session.deleteMany({ userId: { $in: filteredUserIds } }).session(session),
            Transfer.deleteMany({ fromUserId: { $in: filteredUserIds } }).session(session),
            Transaction.deleteMany({ userId: { $in: filteredUserIds } }).session(session)
          ]);
        });

        res.json({
          success: true,
          message: `Successfully deleted ${usersToDelete.length} users`,
          deletedCount: usersToDelete.length,
          deletedUsers: usersToDelete.map(u => ({ email: u.email, name: `${u.firstName} ${u.lastName}` }))
        });

      } finally {
        await session.endSession();
      }

    } catch (error) {
      console.error('Bulk delete users error:', error);
      res.status(500).json({ error: 'Failed to delete users' });
    }
  });

  // BULK ACTIVATE USERS
  router.post('/bulk-activate', authenticate, requirePermission(PERMISSIONS.MANAGE_USERS), async (req, res) => {
    try {
      const { userIds } = req.body;

      if (!Array.isArray(userIds) || userIds.length === 0) {
        return res.status(400).json({ error: 'Invalid user IDs provided' });
      }

      const result = await User.updateMany(
        { _id: { $in: userIds } },
        { 
          isActive: true,
          lastActivity: new Date()
        }
      );

      console.log(`✅ Bulk activate: ${req.user.email} activated ${result.modifiedCount} users`);

      res.json({
        success: true,
        message: `Successfully activated ${result.modifiedCount} users`,
        updatedCount: result.modifiedCount
      });

    } catch (error) {
      console.error('Bulk activate users error:', error);
      res.status(500).json({ error: 'Failed to activate users' });
    }
  });

  // BULK DEACTIVATE USERS
  router.post('/bulk-deactivate', authenticate, requirePermission(PERMISSIONS.MANAGE_USERS), async (req, res) => {
    try {
      const { userIds } = req.body;
      const currentUserId = req.user.userId;

      if (!Array.isArray(userIds) || userIds.length === 0) {
        return res.status(400).json({ error: 'Invalid user IDs provided' });
      }

      // Remove current user from the list
      const filteredUserIds = userIds.filter(id => id !== currentUserId);

      const result = await User.updateMany(
        { _id: { $in: filteredUserIds } },
        { 
          isActive: false,
          lastActivity: new Date()
        }
      );

      console.log(`❌ Bulk deactivate: ${req.user.email} deactivated ${result.modifiedCount} users`);

      res.json({
        success: true,
        message: `Successfully deactivated ${result.modifiedCount} users`,
        updatedCount: result.modifiedCount
      });

    } catch (error) {
      console.error('Bulk deactivate users error:', error);
      res.status(500).json({ error: 'Failed to deactivate users' });
    }
  });

  // INVITE USER
  router.post('/invite', authenticate, requirePermission(PERMISSIONS.MANAGE_USERS), async (req, res) => {
    try {
      const { email, role = 'user', firstName, lastName } = req.body;

      if (!email || !email.includes('@')) {
        return res.status(400).json({ error: 'Valid email is required' });
      }

      if (!['user', 'venue_staff', 'venue_manager', 'gambino_ops', 'super_admin'].includes(role)) {
        return res.status(400).json({ error: 'Invalid role specified' });
      }

      // Check if user already exists
      const existingUser = await User.findOne({ email: email.toLowerCase() });
      if (existingUser) {
        return res.status(400).json({ error: 'User with this email already exists' });
      }

      // For now, create a temporary password - in production, you'd send an email invitation
      const tempPassword = Math.random().toString(36).slice(-8);
      const hashedPassword = await bcrypt.hash(tempPassword, 12);

      const user = await User.create({
        firstName: firstName?.trim() || '',
        lastName: lastName?.trim() || '',
        email: email.toLowerCase().trim(),
        password: hashedPassword,
        role,
        assignedVenues: role === 'venue_staff' ? [] : [],
        isActive: true,
        isVerified: false // User needs to verify and set real password
      });

      console.log(`📧 User invited: ${email} with role ${role} by ${req.user.email}`);

      // In production, send email with invitation link here
      // For now, return the temporary password (remove this in production)
      res.json({
        success: true,
        message: 'User invitation sent successfully',
        user: {
          id: user._id,
          email: user.email,
          role: user.role
        },
        // REMOVE THIS IN PRODUCTION - only for development
        tempPassword: tempPassword
      });

    } catch (error) {
      console.error('Invite user error:', error);
      res.status(500).json({ error: 'Failed to send invitation' });
    }
  });

  return router;
};

module.exports = createUserManagementRoutes;