// src/routes/cashout.js
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const CashoutService = require('../services/CashoutService');
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
// Search customers - Line ~30-50
router.get('/customers/search',
  authenticate,
  requirePermission(PERMISSIONS.PROCESS_CASHOUTS),
  async (req, res) => {
    try {
      const { q } = req.query;

      if (!q || q.length < 2) {
        return res.json({ customers: [] });
      }

      const searchRegex = new RegExp(q, 'i');

      // Search across ALL user fields
      const customers = await mongoose.models.User.find({
        $or: [
          { firstName: searchRegex },
          { lastName: searchRegex },
          { email: searchRegex },
          { phone: searchRegex },
          { username: searchRegex },
          { walletAddress: searchRegex },
          { 'wallet.address': searchRegex }
        ],
        role: { $nin: ['super_admin'] } // Exclude only super admins
      })
      .select('firstName lastName email phone username walletAddress wallet balance gambinoBalance cachedGambinoBalance lastActivity createdAt')
      .limit(10)
      .lean();

      // Format results with full name and wallet info
      const formattedCustomers = customers.map(c => ({
        ...c,
        fullName: `${c.firstName || ''} ${c.lastName || ''}`.trim() || c.username || c.email,
        walletAddress: c.walletAddress || c.wallet?.address || 'No wallet',
        balance: c.cachedGambinoBalance || c.gambinoBalance || c.balance || 0
      }));

      res.json({ 
        customers: formattedCustomers,
        count: formattedCustomers.length 
      });
    } catch (error) {
      console.error('Customer search error:', error);
      res.status(500).json({ error: 'Search failed' });
    }
  }
);

/**
 * GET /api/cashout/customers/:customerId/balance
 * Get customer balance details
 * Permission: PROCESS_CASHOUTS or VIEW_CASHOUT_HISTORY
 */
router.get('/customers/search',
  authenticate,
  requirePermission(PERMISSIONS.PROCESS_CASHOUTS),
  async (req, res) => {
    try {
      const { q } = req.query;

      if (!q || q.length < 2) {
        return res.json({ customers: [] });
      }

      const searchRegex = new RegExp(q, 'i');

      // Search across ALL user fields
      const customers = await mongoose.models.User.find({
        $or: [
          { firstName: searchRegex },
          { lastName: searchRegex },
          { email: searchRegex },
          { phone: searchRegex },
          { username: searchRegex },
          { walletAddress: searchRegex },
          { 'wallet.address': searchRegex }
        ],
        role: { $nin: ['super_admin'] } // Exclude only super admins
      })
      .select('firstName lastName email phone username walletAddress wallet balance gambinoBalance cachedGambinoBalance lastActivity createdAt')
      .limit(10)
      .lean();

      // Format results with full name and wallet info
      const formattedCustomers = customers.map(c => ({
        ...c,
        fullName: `${c.firstName || ''} ${c.lastName || ''}`.trim() || c.username || c.email,
        walletAddress: c.walletAddress || c.wallet?.address || 'No wallet',
        balance: c.cachedGambinoBalance || c.gambinoBalance || c.balance || 0
      }));

      res.json({ 
        customers: formattedCustomers,
        count: formattedCustomers.length 
      });
    } catch (error) {
      console.error('Customer search error:', error);
      res.status(500).json({ error: 'Search failed' });
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
