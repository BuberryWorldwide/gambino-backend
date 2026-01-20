// backend/src/routes/kyc.js
const express = require('express');
const rateLimit = require('express-rate-limit');
const { authenticate, requirePermission, PERMISSIONS } = require('../middleware/rbac');
const VenueKycReward = require('../models/VenueKycReward');
const Referral = require('../models/Referral');
const Store = require('../models/Store');
const BonusDisbursementService = require("../services/bonusDisbursementService");

const router = express.Router();

/**
 * Generate a unique referral code for a user
 * Format: 2 letters + 4 digits (e.g., "GG1234", "AB5678")
 */
async function generateUniqueReferralCode(User) {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // Excluding I and O to avoid confusion
  const maxAttempts = 10;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Generate 2 random letters + 4 random digits
    const code =
      letters[Math.floor(Math.random() * letters.length)] +
      letters[Math.floor(Math.random() * letters.length)] +
      Math.floor(1000 + Math.random() * 9000); // 4 digits (1000-9999)

    // Check if code already exists
    const existing = await User.findOne({ referralCode: code });
    if (!existing) {
      return code;
    }
  }

  // Fallback: use timestamp-based code if random generation fails
  const timestamp = Date.now().toString(36).toUpperCase().slice(-6);
  return `GG${timestamp}`;
}

// Rate limiting for KYC verification (prevent abuse)
const verifyLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 verifications per minute per staff
  keyGenerator: (req) => `kyc-verify:${req.user?._id || req.ip}`,
  message: { error: 'Too many KYC verifications. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Create KYC routes with User model dependency
 * @param {mongoose.Model} User - User model
 */
function createKycRoutes(User) {
  // Roles allowed to perform KYC verification
  const KYC_VERIFIER_ROLES = ['venue_staff', 'venue_manager', 'gambino_ops', 'super_admin'];
  // Roles allowed to reject KYC
  const KYC_REJECTOR_ROLES = ['venue_manager', 'gambino_ops', 'super_admin'];
  // Roles allowed to manage KYC data (compliance)
  const KYC_MANAGER_ROLES = ['super_admin'];
  // Roles allowed to view history
  const KYC_HISTORY_ROLES = ['venue_manager', 'gambino_ops', 'super_admin'];

  /**
   * GET /api/kyc/venues
   * Get list of venues for KYC verification dropdown
   */
  router.get('/venues', authenticate, async (req, res) => {
    try {
      const userRole = req.user.role;

      // Check permissions
      if (!KYC_VERIFIER_ROLES.includes(userRole)) {
        return res.status(403).json({
          success: false,
          error: 'Not authorized to access venues'
        });
      }

      let query = { status: 'active' };

      // Venue staff/managers only see their assigned venues
      if (['venue_staff', 'venue_manager'].includes(userRole)) {
        if (req.user.assignedVenues?.length > 0) {
          query.storeId = { $in: req.user.assignedVenues };
        } else {
          // No assigned venues - return empty
          return res.json({
            success: true,
            venues: []
          });
        }
      }

      const stores = await Store.find(query)
        .select('storeId storeName name city state')
        .sort({ storeName: 1 })
        .lean();

      // Format for dropdown
      const venues = stores.map(s => ({
        id: s.storeId,
        name: s.storeName || s.name || s.storeId,
        location: [s.city, s.state].filter(Boolean).join(', ')
      }));

      // Add headquarters option for super_admin/gambino_ops
      if (['super_admin', 'gambino_ops'].includes(userRole)) {
        venues.unshift({
          id: 'headquarters',
          name: 'Headquarters / Remote',
          location: 'Admin verification'
        });
      }

      res.json({
        success: true,
        venues
      });

    } catch (error) {
      console.error('Error fetching venues:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch venues'
      });
    }
  });

  /**
   * POST /api/kyc/verify
   * KYC verify a user (in-person ID check by venue staff)
   */
  router.post('/verify', authenticate, verifyLimiter, async (req, res) => {
    try {
      const { userId, documentType, notes, venueId } = req.body;
      const verifierRole = req.user.role;

      // Check permissions
      if (!KYC_VERIFIER_ROLES.includes(verifierRole)) {
        return res.status(403).json({
          success: false,
          error: 'Not authorized to verify KYC'
        });
      }

      if (!userId) {
        return res.status(400).json({
          success: false,
          error: 'userId is required'
        });
      }

      // Get user to verify
      const user = await User.findById(userId);
      if (!user) {
        return res.status(404).json({
          success: false,
          error: 'User not found'
        });
      }

      if (user.kycStatus === 'verified') {
        return res.status(400).json({
          success: false,
          error: 'User already KYC verified',
          kycVerifiedAt: user.kycVerifiedAt
        });
      }

      // Determine venue (from request or verifier's assigned venues)
      // For gambino_ops/super_admin without assigned venue, use 'headquarters' as default
      let effectiveVenueId = venueId || req.user.assignedVenues?.[0];
      if (!effectiveVenueId) {
        if (['gambino_ops', 'super_admin'].includes(verifierRole)) {
          effectiveVenueId = 'headquarters'; // Default for remote/admin verifications
        } else {
          return res.status(400).json({
            success: false,
            error: 'venueId is required or you must have an assigned venue'
          });
        }
      }

      // 1. Update user KYC status using findByIdAndUpdate for atomic save
      // Note: RBAC middleware sets req.user.userId, not req.user._id
      const verifierId = req.user.userId || req.user._id;

      // Generate referral code if user doesn't have one yet
      let newReferralCode = null;
      if (!user.referralCode) {
        newReferralCode = await generateUniqueReferralCode(User);
        console.log('Generated referral code for user:', { userId: user._id, code: newReferralCode });
      }

      const updateFields = {
        kycStatus: 'verified',
        kycVerifiedAt: new Date(),
        kycVerifiedBy: verifierId,
        kycVerifiedAtVenue: effectiveVenueId,
        kycVerificationMethod: 'in_person',
        kycNotes: notes || `ID verified - ${documentType || 'ID'}`
      };

      // Add referral code if generated
      if (newReferralCode) {
        updateFields.referralCode = newReferralCode;
      }

      const updatedUser = await User.findByIdAndUpdate(
        userId,
        updateFields,
        { new: true }
      );

      if (!updatedUser || updatedUser.kycStatus !== 'verified') {
        return res.status(500).json({
          success: false,
          error: 'Failed to update KYC status'
        });
      }

      // Update local reference for response
      user.kycStatus = updatedUser.kycStatus;
      user.kycVerifiedAt = updatedUser.kycVerifiedAt;

      console.log('KYC Verified:', {
        userId: user._id,
        kycStatus: updatedUser.kycStatus,
        verifiedBy: verifierId,
        venue: effectiveVenueId,
        timestamp: new Date()
      });

      // 2. Check for pending referral and verify it
      let referralVerified = false;
      let referral = null;
      try {
        referral = await Referral.findOne({
          newUserId: userId,
          status: { $in: ['pending', 'pending_budget'] }
        });

        if (referral) {
          referral.kycCompletedAt = new Date();
          referral.status = 'verified';
          await referral.save();
          referralVerified = true;
          console.log('Referral verified via KYC:', {
            referralId: referral._id,
            referrerId: referral.referrerId
          });
        }
      } catch (refError) {
        console.error('Error updating referral:', refError);
        // Continue - KYC was successful, referral update is secondary
      }

      // 3. Create venue KYC reward
      let venueReward = null;
      try {
        venueReward = await VenueKycReward.create({
          userId: user._id,
          userWalletAddress: user.walletAddress,
          verifiedBy: verifierId,
          verifierName: `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() || req.user.email,
          venueId: effectiveVenueId,
          rewardAmount: 25, // Base KYC reward for venue
          hasLinkedReferral: referralVerified,
          linkedReferralId: referral?._id,
          ipAddress: req.ip,
          userAgent: req.get('User-Agent')
        });
      } catch (rewardError) {
        // Check if duplicate (user already KYC'd before)
        if (rewardError.code === 11000) {
          console.log('Duplicate KYC reward attempted for user:', userId);
        } else {
          console.error('Error creating venue reward:', rewardError);
        }
      }

      // 4. Disburse KYC welcome bonus (25 GG) - ACTUAL TOKEN TRANSFER
      // NOTE: This runs in background (non-blocking) to avoid frontend timeout
      // The batch job will retry any failed disbursements
      let userRewardCredited = false;
      let bonusTxSignature = null;

      if (venueReward?._id && user.walletAddress) {
        // Fire-and-forget: don't await the token transfer
        const bonusService = new BonusDisbursementService();
        bonusService.disburseKycBonus({
          userId: user._id,
          walletAddress: user.walletAddress,
          venueKycRewardId: venueReward._id
        }).then(bonusResult => {
          if (bonusResult.success) {
            console.log(`🎁 KYC bonus sent: ${bonusResult.amount} GG to ${user.walletAddress?.slice(0,8)}... (tx: ${bonusResult.txSignature?.slice(0,16)}...)`);
          } else if (bonusResult.reason === 'already_distributed') {
            console.log(`ℹ️ KYC bonus already sent to user ${userId}`);
          } else {
            console.warn(`⚠️ KYC bonus failed for user ${userId}: ${bonusResult.reason}`);
          }
        }).catch(bonusErr => {
          console.error('❌ KYC bonus disbursement error:', bonusErr.message);
          // Batch job will retry failed disbursements
        });

        userRewardCredited = true; // Optimistic - will be retried if it fails
        console.log(`📤 KYC bonus disbursement queued for user ${userId}`);
      }

      res.json({
        success: true,
        message: 'User KYC verified successfully',
        data: {
          userId: user._id,
          userEmail: user.email,
          userName: `${user.firstName} ${user.lastName}`,
          kycVerifiedAt: user.kycVerifiedAt,
          venueId: effectiveVenueId,
          referralVerified,
          referralId: referral?._id,
          venueRewardId: venueReward?._id,
          userKycBonus: userRewardCredited ? 25 : 0,
          kycBonusTxSignature: bonusTxSignature,
          venueRewardAmount: venueReward?.rewardAmount || 0,
          referralCodeGenerated: newReferralCode || updatedUser.referralCode
        }
      });

    } catch (error) {
      console.error('KYC verification error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to verify KYC'
      });
    }
  });

  /**
   * GET /api/kyc/pending
   * List users pending KYC verification at venue
   */
  router.get('/pending', authenticate, async (req, res) => {
    try {
      const { venueId, limit = 50, page = 1 } = req.query;
      const userRole = req.user.role;

      // Check permissions
      if (!KYC_VERIFIER_ROLES.includes(userRole) && !KYC_MANAGER_ROLES.includes(userRole)) {
        return res.status(403).json({
          success: false,
          error: 'Not authorized to view pending KYC'
        });
      }

      // Build query
      const query = { kycStatus: 'pending', isActive: true };

      // If venue_staff/venue_manager, limit to their venues (optional filter)
      // For now, show all pending users since KYC can happen at any venue

      const skip = (parseInt(page) - 1) * parseInt(limit);

      const [users, total] = await Promise.all([
        User.find(query)
          .select('firstName lastName email walletAddress createdAt referredBy kycStatus gambinoBalance')
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(parseInt(limit)),
        User.countDocuments(query)
      ]);

      // Check which users have pending referrals and get referrer info
      const userIds = users.map(u => u._id);
      const referrals = await Referral.find({
        newUserId: { $in: userIds }
      }).select('newUserId referrerId status source venueId').populate('referrerId', 'firstName lastName email');

      const referralMap = new Map(
        referrals.map(r => [r.newUserId.toString(), r])
      );

      const usersWithReferralInfo = users.map(u => {
        const referral = referralMap.get(u._id.toString());
        let acquisitionSource = 'direct'; // Default: signed up directly
        let referrerName = null;

        if (referral) {
          acquisitionSource = referral.source || 'referral'; // 'link', 'qr', 'social', 'direct'
          if (referral.referrerId) {
            referrerName = `${referral.referrerId.firstName || ''} ${referral.referrerId.lastName || ''}`.trim();
          }
        }

        return {
          ...u.toObject(),
          kycStatus: u.kycStatus || 'pending',
          gambinoBalance: u.gambinoBalance || 0,
          hasPendingReferral: referral && ['pending', 'pending_budget'].includes(referral.status),
          referralId: referral?._id,
          referralStatus: referral?.status,
          acquisitionSource,
          referrerName,
          referralVenueId: referral?.venueId
        };
      });

      res.json({
        success: true,
        data: {
          users: usersWithReferralInfo,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total,
            pages: Math.ceil(total / parseInt(limit))
          }
        }
      });

    } catch (error) {
      console.error('Error fetching pending KYC:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch pending KYC users'
      });
    }
  });

  /**
   * GET /api/kyc/history
   * Get KYC verification history for a venue
   */
  router.get('/history', authenticate, async (req, res) => {
    try {
      const { venueId, startDate, endDate, limit = 50, page = 1 } = req.query;
      const userRole = req.user.role;

      // Check permissions
      if (!KYC_HISTORY_ROLES.includes(userRole) && !KYC_VERIFIER_ROLES.includes(userRole)) {
        return res.status(403).json({
          success: false,
          error: 'Not authorized to view KYC history'
        });
      }

      // Build query
      const query = {};

      // Filter by venue for non-admin roles
      if (['venue_staff', 'venue_manager'].includes(userRole)) {
        if (req.user.assignedVenues?.length > 0) {
          query.venueId = { $in: req.user.assignedVenues };
        }
      } else if (venueId) {
        query.venueId = venueId;
      }

      // Date filter
      if (startDate || endDate) {
        query.createdAt = {};
        if (startDate) query.createdAt.$gte = new Date(startDate);
        if (endDate) query.createdAt.$lte = new Date(endDate);
      }

      const skip = (parseInt(page) - 1) * parseInt(limit);

      const [rewards, total] = await Promise.all([
        VenueKycReward.find(query)
          .populate('userId', 'firstName lastName email walletAddress')
          .populate('verifiedBy', 'firstName lastName')
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(parseInt(limit)),
        VenueKycReward.countDocuments(query)
      ]);

      res.json({
        success: true,
        data: {
          history: rewards,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total,
            pages: Math.ceil(total / parseInt(limit))
          }
        }
      });

    } catch (error) {
      console.error('Error fetching KYC history:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch KYC history'
      });
    }
  });

  /**
   * GET /api/kyc/stats
   * Get KYC statistics (for admin/ops)
   */
  router.get('/stats', authenticate, async (req, res) => {
    try {
      const { venueId, startDate, endDate } = req.query;
      const userRole = req.user.role;

      // Check permissions
      if (!KYC_HISTORY_ROLES.includes(userRole)) {
        return res.status(403).json({
          success: false,
          error: 'Not authorized to view KYC stats'
        });
      }

      // Build match criteria
      const match = {};
      if (venueId) match.venueId = venueId;
      if (startDate || endDate) {
        match.createdAt = {};
        if (startDate) match.createdAt.$gte = new Date(startDate);
        if (endDate) match.createdAt.$lte = new Date(endDate);
      }

      // Aggregate stats
      const [overallStats] = await VenueKycReward.aggregate([
        { $match: match },
        {
          $group: {
            _id: null,
            totalVerifications: { $sum: 1 },
            totalRewardsAmount: { $sum: '$rewardAmount' },
            distributedCount: {
              $sum: { $cond: [{ $eq: ['$status', 'distributed'] }, 1, 0] }
            },
            distributedAmount: {
              $sum: { $cond: [{ $eq: ['$status', 'distributed'] }, '$rewardAmount', 0] }
            },
            pendingCount: {
              $sum: { $cond: [{ $in: ['$status', ['pending', 'queued']] }, 1, 0] }
            },
            pendingAmount: {
              $sum: { $cond: [{ $in: ['$status', ['pending', 'queued']] }, '$rewardAmount', 0] }
            },
            withReferrals: {
              $sum: { $cond: ['$hasLinkedReferral', 1, 0] }
            }
          }
        }
      ]);

      // By venue breakdown
      const byVenue = await VenueKycReward.aggregate([
        { $match: match },
        {
          $group: {
            _id: '$venueId',
            count: { $sum: 1 },
            totalRewards: { $sum: '$rewardAmount' },
            withReferrals: { $sum: { $cond: ['$hasLinkedReferral', 1, 0] } }
          }
        },
        { $sort: { count: -1 } },
        { $limit: 20 }
      ]);

      // By staff breakdown
      const byStaff = await VenueKycReward.aggregate([
        { $match: match },
        {
          $group: {
            _id: '$verifiedBy',
            verifierName: { $first: '$verifierName' },
            count: { $sum: 1 },
            venues: { $addToSet: '$venueId' }
          }
        },
        { $sort: { count: -1 } },
        { $limit: 20 }
      ]);

      // Total users pending KYC
      const pendingKycCount = await User.countDocuments({
        kycStatus: 'pending',
        isActive: true
      });

      res.json({
        success: true,
        data: {
          overall: overallStats || {
            totalVerifications: 0,
            totalRewardsAmount: 0,
            distributedCount: 0,
            distributedAmount: 0,
            pendingCount: 0,
            pendingAmount: 0,
            withReferrals: 0
          },
          byVenue,
          byStaff,
          pendingKycCount
        }
      });

    } catch (error) {
      console.error('Error fetching KYC stats:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch KYC stats'
      });
    }
  });

  /**
   * PUT /api/kyc/reject/:userId
   * Reject a user's KYC (fraud detection)
   */
  router.put('/reject/:userId', authenticate, async (req, res) => {
    try {
      const { userId } = req.params;
      const { reason } = req.body;
      const userRole = req.user.role;

      // Check permissions
      if (!KYC_REJECTOR_ROLES.includes(userRole)) {
        return res.status(403).json({
          success: false,
          error: 'Not authorized to reject KYC'
        });
      }

      if (!reason) {
        return res.status(400).json({
          success: false,
          error: 'Rejection reason is required'
        });
      }

      const user = await User.findById(userId);
      if (!user) {
        return res.status(404).json({
          success: false,
          error: 'User not found'
        });
      }

      if (user.kycStatus === 'rejected') {
        return res.status(400).json({
          success: false,
          error: 'User KYC already rejected'
        });
      }

      // Update user
      user.kycStatus = 'rejected';
      user.kycNotes = `REJECTED: ${reason} (by ${req.user.email} at ${new Date().toISOString()})`;
      await user.save();

      // Also reject any pending referral
      await Referral.findOneAndUpdate(
        { newUserId: userId, status: { $in: ['pending', 'pending_budget'] } },
        {
          status: 'rejected',
          rejectionReason: `KYC Rejected: ${reason}`,
          rejectedAt: new Date()
        }
      );

      console.log('KYC Rejected:', {
        userId,
        rejectedBy: req.user.userId || req.user._id,
        reason
      });

      res.json({
        success: true,
        message: 'KYC rejected',
        data: {
          userId,
          kycStatus: 'rejected',
          reason
        }
      });

    } catch (error) {
      console.error('Error rejecting KYC:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to reject KYC'
      });
    }
  });

  /**
   * GET /api/kyc/user/:userId
   * Get KYC status for a specific user
   */
  router.get('/user/:userId', authenticate, async (req, res) => {
    try {
      const { userId } = req.params;
      const userRole = req.user.role;

      // Users can check their own KYC status
      const currentUserId = req.user.userId || req.user._id;
      const isSelf = currentUserId?.toString() === userId;
      if (!isSelf && !KYC_VERIFIER_ROLES.includes(userRole) && !KYC_MANAGER_ROLES.includes(userRole)) {
        return res.status(403).json({
          success: false,
          error: 'Not authorized to view this KYC status'
        });
      }

      const user = await User.findById(userId)
        .select('firstName lastName email kycStatus kycVerifiedAt kycVerifiedBy kycVerifiedAtVenue kycVerificationMethod')
        .populate('kycVerifiedBy', 'firstName lastName');

      if (!user) {
        return res.status(404).json({
          success: false,
          error: 'User not found'
        });
      }

      // Check for pending referral
      const pendingReferral = await Referral.findOne({
        newUserId: userId,
        status: { $in: ['pending', 'pending_budget', 'verified'] }
      }).select('status kycCompletedAt referrerId');

      res.json({
        success: true,
        data: {
          user: {
            _id: user._id,
            name: `${user.firstName} ${user.lastName}`,
            email: user.email,
            kycStatus: user.kycStatus,
            kycVerifiedAt: user.kycVerifiedAt,
            kycVerifiedBy: user.kycVerifiedBy,
            kycVerifiedAtVenue: user.kycVerifiedAtVenue,
            kycVerificationMethod: user.kycVerificationMethod
          },
          referral: pendingReferral
        }
      });

    } catch (error) {
      console.error('Error fetching user KYC status:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch KYC status'
      });
    }
  });

  /**
   * PUT /api/kyc/manage/:userId
   * Manage KYC data (compliance - super_admin only)
   */
  router.put('/manage/:userId', authenticate, async (req, res) => {
    try {
      const { userId } = req.params;
      const { action, notes } = req.body;
      const userRole = req.user.role;

      // Only super_admin can manage KYC data
      if (!KYC_MANAGER_ROLES.includes(userRole)) {
        return res.status(403).json({
          success: false,
          error: 'Only super_admin can manage KYC data'
        });
      }

      const user = await User.findById(userId);
      if (!user) {
        return res.status(404).json({
          success: false,
          error: 'User not found'
        });
      }

      let result = {};

      switch (action) {
        case 'reset':
          // Reset KYC status (for re-verification)
          user.kycStatus = 'pending';
          user.kycVerifiedAt = null;
          user.kycVerifiedBy = null;
          user.kycVerifiedAtVenue = null;
          user.kycNotes = `RESET: ${notes || 'Manual reset by admin'} (by ${req.user.email})`;
          await user.save();
          result = { message: 'KYC reset to pending', newStatus: 'pending' };
          break;

        case 'expire':
          // Expire KYC (requires re-verification)
          user.kycStatus = 'expired';
          user.kycNotes = `EXPIRED: ${notes || 'Manual expiration'} (by ${req.user.email})`;
          await user.save();
          result = { message: 'KYC expired', newStatus: 'expired' };
          break;

        case 'purge_documents':
          // Remove KYC documents (compliance)
          user.kycDocuments = [];
          user.kycNotes = (user.kycNotes || '') + ` | DOCS PURGED: ${notes || 'Compliance request'} (by ${req.user.email})`;
          await user.save();
          result = { message: 'KYC documents purged' };
          break;

        default:
          return res.status(400).json({
            success: false,
            error: 'Invalid action. Valid actions: reset, expire, purge_documents'
          });
      }

      console.log('KYC Management action:', {
        userId,
        action,
        managedBy: req.user.userId || req.user._id,
        notes
      });

      res.json({
        success: true,
        ...result,
        data: {
          userId,
          action,
          managedBy: req.user.email,
          timestamp: new Date()
        }
      });

    } catch (error) {
      console.error('Error managing KYC:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to manage KYC'
      });
    }
  });

  return router;
}

module.exports = createKycRoutes;
