// src/routes/cashout.js
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const CashoutService = require('../services/CashoutService');
const GambinoTokenService = require('../services/gambinoTokenService');
const { authenticate, requirePermission, requireVenueAccess, PERMISSIONS } = require('../middleware/rbac');

/**
 * GET /api/cashout/exchange-rate
 * Get current exchange rate configuration
 * Permission: VIEW_CASHOUT_HISTORY
 */
router.get(
  '/exchange-rate',
  authenticate,
  requirePermission(PERMISSIONS.VIEW_CASHOUT_HISTORY),
  async (req, res) => {
    try {
      const config = await CashoutService.getCurrentExchangeRate();

      res.json({
        success: true,
        exchangeRate: config
      });
    } catch (error) {
      console.error('Get exchange rate error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get exchange rate configuration'
      });
    }
  }
);

/**
 * GET /api/cashout/customers/search
 * Search customers for cashout (by phone, email, or name)
 * Permission: PROCESS_CASHOUTS or VIEW_CASHOUT_HISTORY
 */
router.get(
  '/customers/search',
  authenticate,
  requirePermission([PERMISSIONS.PROCESS_CASHOUTS, PERMISSIONS.VIEW_CASHOUT_HISTORY]),
  async (req, res) => {
    try {
      const { q, limit = 20 } = req.query;

      if (!q || q.length < 2) {
        return res.status(400).json({
          success: false,
          error: 'Search query must be at least 2 characters'
        });
      }

      const User = mongoose.model('User');

      // Search by email, phone, firstName, or lastName
      const searchRegex = new RegExp(q, 'i');
      const customers = await User.find({
        $or: [
          { email: searchRegex },
          { phone: searchRegex },
          { firstName: searchRegex },
          { lastName: searchRegex }
        ],
        role: 'user' // Only search regular users (players)
      })
        .select('firstName lastName email phone gambinoBalance cachedGambinoBalance walletAddress lastActivity kycStatus kycVerifiedAt')
        .limit(parseInt(limit))
        .lean();

      // Get on-chain balances for each customer (async)
      const customersWithBalance = await Promise.all(
        customers.map(async (c) => {
          const tokenService = new GambinoTokenService();
          let onChainBalance = 0;
          let blockchainError = null;

          if (c.walletAddress) {
            try {
              const balanceResult = await tokenService.getUserTokenBalance(c.walletAddress);
              onChainBalance = balanceResult.success ? balanceResult.balance : 0;
              blockchainError = balanceResult.success ? null : balanceResult.error;
            } catch (err) {
              console.error(`Failed to get blockchain balance for ${c.walletAddress}:`, err.message);
              blockchainError = err.message;
            }
          }

          return {
            _id: c._id,
            firstName: c.firstName,
            lastName: c.lastName,
            fullName: `${c.firstName} ${c.lastName}`,
            email: c.email,
            phone: c.phone,
            balance: onChainBalance, // REAL on-chain balance
            balanceCached: c.gambinoBalance || c.cachedGambinoBalance || 0, // MongoDB cache
            walletAddress: c.walletAddress,
            lastActivity: c.lastActivity,
            blockchainError,
            kycStatus: c.kycStatus || 'pending',
            kycVerified: c.kycStatus === 'verified',
            kycVerifiedAt: c.kycVerifiedAt
          };
        })
      );

      res.json({
        success: true,
        customers: customersWithBalance
      });
    } catch (error) {
      console.error('Customer search error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to search customers'
      });
    }
  }
);

/**
 * GET /api/cashout/customers/:customerId/balance
 * Get customer balance details
 * Permission: PROCESS_CASHOUTS or VIEW_CASHOUT_HISTORY
 */
router.get(
  '/customers/:customerId/balance',
  authenticate,
  requirePermission([PERMISSIONS.PROCESS_CASHOUTS, PERMISSIONS.VIEW_CASHOUT_HISTORY]),
  async (req, res) => {
    try {
      const { customerId } = req.params;
      const User = mongoose.model('User');
      const Transaction = mongoose.model('Transaction');

      const customer = await User.findById(customerId)
        .select('firstName lastName email phone gambinoBalance cachedGambinoBalance walletAddress totalDeposited totalWithdrawn lastActivity')
        .lean();

      if (!customer) {
        return res.status(404).json({
          success: false,
          error: 'Customer not found'
        });
      }

      // Get REAL on-chain balance
      const tokenService = new GambinoTokenService();
      let onChainBalance = 0;
      let solBalance = 0;
      let blockchainError = null;

      if (customer.walletAddress) {
        try {
          const completeBalance = await tokenService.getUserCompleteBalance(customer.walletAddress);
          if (completeBalance.success) {
            onChainBalance = completeBalance.gambino.balance;
            solBalance = completeBalance.sol.balance;
          } else {
            blockchainError = completeBalance.error;
          }
        } catch (err) {
          console.error(`Failed to get blockchain balance for ${customer.walletAddress}:`, err.message);
          blockchainError = err.message;
        }
      }

      // Get recent transaction activity
      const recentTransactions = await Transaction.find({
        userId: customerId,
        type: { $in: ['purchase', 'jackpot', 'cashout'] }
      })
        .sort({ createdAt: -1 })
        .limit(5)
        .lean();

      // Get today's cashouts
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);

      const todayCashouts = await Transaction.aggregate([
        {
          $match: {
            userId: mongoose.Types.ObjectId(customerId),
            type: 'cashout',
            status: 'completed',
            createdAt: { $gte: today, $lt: tomorrow }
          }
        },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            totalAmount: { $sum: '$usdAmount' }
          }
        }
      ]);

      res.json({
        success: true,
        customer: {
          _id: customer._id,
          fullName: `${customer.firstName} ${customer.lastName}`,
          email: customer.email,
          phone: customer.phone,
          walletAddress: customer.walletAddress,
          balance: onChainBalance, // REAL blockchain balance
          balanceCached: customer.gambinoBalance || customer.cachedGambinoBalance || 0, // MongoDB cache
          solBalance: solBalance, // SOL balance for gas fees
          totalDeposited: customer.totalDeposited || 0,
          totalWithdrawn: customer.totalWithdrawn || 0,
          lastActivity: customer.lastActivity,
          blockchainError
        },
        todayActivity: {
          cashoutsCount: todayCashouts[0]?.count || 0,
          cashoutsTotal: todayCashouts[0]?.totalAmount || 0
        },
        recentTransactions: recentTransactions.map(t => ({
          type: t.type,
          amount: t.amount,
          usdAmount: t.usdAmount,
          status: t.status,
          blockchainTx: t.metadata?.blockchainTxSignature || t.txHash,
          explorerUrl: t.metadata?.explorerUrl,
          createdAt: t.createdAt
        }))
      });
    } catch (error) {
      console.error('Get customer balance error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get customer balance'
      });
    }
  }
);

/**
 * POST /api/cashout/venues/:storeId/process
 * Process a cashout transaction
 * Permission: PROCESS_CASHOUTS + Venue Access
 */
router.post(
  '/venues/:storeId/process',
  authenticate,
  requireVenueAccess({ requireManagement: false }),
  requirePermission(PERMISSIONS.PROCESS_CASHOUTS),
  async (req, res) => {
    try {
      const { storeId } = req.params;
      const { customerId, tokensToConvert, notes } = req.body;
      const staffId = req.user.userId;

      // Validation
      if (!customerId || !tokensToConvert) {
        return res.status(400).json({
          success: false,
          error: 'customerId and tokensToConvert are required'
        });
      }

      if (tokensToConvert <= 0) {
        return res.status(400).json({
          success: false,
          error: 'tokensToConvert must be positive'
        });
      }

      // KYC Check - user must be verified to cash out
      const User = mongoose.model('User');
      const customer = await User.findById(customerId).select('kycStatus firstName lastName');

      if (!customer) {
        return res.status(404).json({
          success: false,
          error: 'Customer not found'
        });
      }

      if (customer.kycStatus !== 'verified') {
        return res.status(403).json({
          success: false,
          error: 'KYC verification required',
          kycRequired: true,
          message: `${customer.firstName} ${customer.lastName} must complete KYC verification before cashing out. Please verify their ID first.`
        });
      }

      // Process cashout
      const result = await CashoutService.processCashout(
        customerId,
        tokensToConvert,
        storeId,
        staffId,
        notes
      );

      if (!result.success) {
        return res.status(400).json(result);
      }

      res.json(result);
    } catch (error) {
      console.error('Process cashout error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to process cashout'
      });
    }
  }
);

/**
 * GET /api/cashout/venues/:storeId/history
 * Get cashout history for a venue
 * Permission: VIEW_CASHOUT_HISTORY + Venue Access
 */
router.get(
  '/venues/:storeId/history',
  authenticate,
  requireVenueAccess(),
  requirePermission(PERMISSIONS.VIEW_CASHOUT_HISTORY),
  async (req, res) => {
    try {
      const { storeId } = req.params;
      const {
        startDate,
        endDate,
        customerId,
        staffMemberId,
        status,
        limit,
        offset
      } = req.query;

      const filters = {
        startDate,
        endDate,
        customerId,
        staffMemberId,
        status,
        limit: limit ? parseInt(limit) : undefined,
        offset: offset ? parseInt(offset) : undefined
      };

      const result = await CashoutService.getCashoutHistory(storeId, filters);

      res.json({
        success: true,
        ...result
      });
    } catch (error) {
      console.error('Get cashout history error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get cashout history'
      });
    }
  }
);

/**
 * GET /api/cashout/venues/:storeId/reconciliation/:date
 * Get daily reconciliation report for cashouts
 * Permission: VIEW_CASHOUT_HISTORY + Venue Access
 */
router.get(
  '/venues/:storeId/reconciliation/:date',
  authenticate,
  requireVenueAccess(),
  requirePermission(PERMISSIONS.VIEW_CASHOUT_HISTORY),
  async (req, res) => {
    try {
      const { storeId, date } = req.params;

      const result = await CashoutService.getDailyReconciliation(storeId, date);

      res.json({
        success: true,
        reconciliation: result
      });
    } catch (error) {
      console.error('Get reconciliation error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get reconciliation report'
      });
    }
  }
);

/**
 * POST /api/cashout/reverse/:transactionId
 * Reverse a cashout transaction (admin only)
 * Permission: REVERSE_CASHOUTS
 */
router.post(
  '/reverse/:transactionId',
  authenticate,
  requirePermission(PERMISSIONS.REVERSE_CASHOUTS),
  async (req, res) => {
    try {
      const { transactionId } = req.params;
      const { reason } = req.body;

      if (!reason || reason.trim().length < 5) {
        return res.status(400).json({
          success: false,
          error: 'Reason is required (minimum 5 characters)'
        });
      }

      const result = await CashoutService.reverseCashout(
        transactionId,
        req.user.userId,
        reason
      );

      if (!result.success) {
        return res.status(400).json(result);
      }

      res.json(result);
    } catch (error) {
      console.error('Reverse cashout error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to reverse cashout'
      });
    }
  }
);

/**
 * GET /api/cashout/stats/venues/:storeId
 * Get cashout statistics for a venue
 * Permission: VIEW_CASHOUT_HISTORY + Venue Access
 */
router.get(
  '/stats/venues/:storeId',
  authenticate,
  requireVenueAccess(),
  requirePermission(PERMISSIONS.VIEW_CASHOUT_HISTORY),
  async (req, res) => {
    try {
      const { storeId } = req.params;
      const { period = '7days' } = req.query;
      const Transaction = mongoose.model('Transaction');

      // Calculate date range based on period
      const endDate = new Date();
      const startDate = new Date();

      switch (period) {
        case 'today':
          startDate.setHours(0, 0, 0, 0);
          break;
        case '7days':
          startDate.setDate(startDate.getDate() - 7);
          break;
        case '30days':
          startDate.setDate(startDate.getDate() - 30);
          break;
        default:
          startDate.setDate(startDate.getDate() - 7);
      }

      const stats = await Transaction.aggregate([
        {
          $match: {
            'metadata.storeId': storeId,
            type: 'cashout',
            status: 'completed',
            createdAt: { $gte: startDate, $lte: endDate }
          }
        },
        {
          $group: {
            _id: null,
            totalTransactions: { $sum: 1 },
            totalTokensConverted: { $sum: '$amount' },
            totalCashPaid: { $sum: '$usdAmount' },
            avgCashAmount: { $avg: '$usdAmount' },
            uniqueCustomers: { $addToSet: '$userId' }
          }
        }
      ]);

      const result = stats[0] || {
        totalTransactions: 0,
        totalTokensConverted: 0,
        totalCashPaid: 0,
        avgCashAmount: 0,
        uniqueCustomers: []
      };

      res.json({
        success: true,
        stats: {
          period,
          startDate,
          endDate,
          totalTransactions: result.totalTransactions,
          totalTokensConverted: result.totalTokensConverted,
          totalCashPaid: result.totalCashPaid,
          avgCashAmount: result.avgCashAmount,
          uniqueCustomers: result.uniqueCustomers.length
        }
      });
    } catch (error) {
      console.error('Get cashout stats error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get cashout statistics'
      });
    }
  }
);

module.exports = router;
