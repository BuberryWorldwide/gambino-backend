// src/routes/admin/events.js or add to existing admin routes
const express = require('express');
const router = express.Router();
const Event = require('../models/Event'); // Your Event model
const { authenticate, requirePermission, PERMISSIONS } = require('../middleware/rbac');

/**
 * GET /api/admin/events/:machineId
 * Get all events for a specific machine (including voucher_print from Pi)
 */
router.get('/events/:machineId', 
  authenticate, 
  requirePermission(PERMISSIONS.VIEW_MACHINES),
  async (req, res) => {
    try {
      const { machineId } = req.params;
      const { startDate, endDate, limit = 100 } = req.query;

      // Build query
      const query = { 
        machineId: machineId,
        // Also match gamingMachineId for Pi events
        $or: [
          { machineId: machineId },
          { gamingMachineId: machineId }
        ]
      };

      // Add date filters if provided
      if (startDate || endDate) {
        query.timestamp = {};
        if (startDate) query.timestamp.$gte = new Date(startDate);
        if (endDate) query.timestamp.$lte = new Date(endDate);
      }

      // Fetch events
      const events = await Event.find(query)
        .sort({ timestamp: -1 })
        .limit(parseInt(limit));

      // Calculate aggregated stats
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      
      const todayEvents = await Event.find({
        $or: [
          { machineId: machineId },
          { gamingMachineId: machineId }
        ],
        timestamp: { $gte: today }
      });

      const stats = {
        moneyIn: 0,
        moneyOut: 0,
        voucherCount: 0,
        voucherTotal: 0
      };

      // ✅ FIX #1: Handle cumulative daily snapshots correctly
      // Track cumulative values per day (money_in/money_out are snapshots, not transactions)
      const machineDaily = {};

      events.forEach(event => {
        const machineId = event.gamingMachineId || event.machineId;
        stats.activeMachines.add(machineId);

        const date = event.timestamp.toISOString().split('T')[0];
        const key = `${machineId}_${date}`;

        if (!machineDaily[key]) {
          machineDaily[key] = { moneyIn: 0, moneyOut: 0, vouchers: 0 };
        }
      
        if (event.eventType === 'money_in') {
          machineDaily[key].moneyIn = Math.max(machineDaily[key].moneyIn, event.amount || 0);
        } else if (event.eventType === 'money_out') {
          machineDaily[key].moneyOut = Math.max(machineDaily[key].moneyOut, event.amount || 0);
        } else if (event.eventType === 'voucher_print') {
          stats.totalVouchers += 1;
          machineDaily[key].vouchers += event.amount || 0;
        }
      });

      // Sum all daily totals
      Object.values(machineDaily).forEach(daily => {
        stats.totalMoneyIn += daily.moneyIn;
        stats.totalMoneyOut += daily.moneyOut + daily.vouchers;
      });

      // Add vouchers to money out (vouchers are payouts)
      stats.moneyOut += stats.voucherTotal;

      res.json({
        success: true,
        events,
        stats,
        count: events.length
      });

    } catch (error) {
      console.error('Error fetching machine events:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch machine events'
      });
    }
  }
);

/**
 * GET /api/admin/venues/:venueId/events
 * Get aggregated events for all machines in a venue
 */
router.get('/venues/:venueId/events',
  authenticate,
  requirePermission(PERMISSIONS.VIEW_VENUES),
  async (req, res) => {
    try {
      const { venueId } = req.params;
      const { startDate, endDate } = req.query;

      // Find all machines for this venue (storeId = venueId)
      const Machine = require('../models/Machine');
      const machines = await Machine.find({ storeId: venueId });
      const machineIds = machines.map(m => m.machineId);

      // Build query
      const query = {
        $or: [
          { machineId: { $in: machineIds } },
          { gamingMachineId: { $in: machineIds } }
        ]
      };

      if (startDate || endDate) {
        query.timestamp = {};
        if (startDate) query.timestamp.$gte = new Date(startDate);
        if (endDate) query.timestamp.$lte = new Date(endDate);
      }

      // Get events
      const events = await Event.find(query).sort({ timestamp: -1 });

      // Calculate venue-level stats
      const stats = {
        totalMachines: machineIds.length,
        moneyIn: 0,
        moneyOut: 0,
        voucherCount: 0,
        voucherTotal: 0,
        netRevenue: 0
      };

      // ✅ FIX #2: Group by machine and date to handle cumulative values correctly
      const machineDaily = {};

      events.forEach(event => {
        const machineId = event.gamingMachineId || event.machineId;
        const date = event.timestamp.toISOString().split('T')[0];
        const key = `${machineId}_${date}`;
        
        if (!machineDaily[key]) {
          machineDaily[key] = { moneyIn: 0, moneyOut: 0, vouchers: 0 };
        }

        if (event.eventType === 'money_in') {
          // Keep highest cumulative value for this machine-day
          machineDaily[key].moneyIn = Math.max(machineDaily[key].moneyIn, event.amount || 0);
        } else if (event.eventType === 'money_out') {
          // Keep highest cumulative value for this machine-day
          machineDaily[key].moneyOut = Math.max(machineDaily[key].moneyOut, event.amount || 0);
        } else if (event.eventType === 'voucher_print') {
          // Vouchers are individual transactions - sum them
          stats.voucherCount += 1;
          machineDaily[key].vouchers += event.amount || 0;
        }
      });

      // Sum all machines' daily totals
      Object.values(machineDaily).forEach(daily => {
        stats.moneyIn += daily.moneyIn;
        stats.moneyOut += daily.moneyOut + daily.vouchers;
      });

      stats.voucherTotal = Object.values(machineDaily).reduce((sum, d) => sum + d.vouchers, 0);
      stats.netRevenue = stats.moneyIn - stats.moneyOut;

      res.json({
        success: true,
        events,
        stats,
        machineCount: machineIds.length
      });

    } catch (error) {
      console.error('Error fetching venue events:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch venue events'
      });
    }
  }
);

/**
 * GET /api/admin/events/today/summary
 * Get today's summary across all machines (for dashboard cards)
 * 
 * CRITICAL FIX: The issue is that money_in and money_out events from daily reports
 * represent CUMULATIVE totals per machine per day, not incremental amounts.
 * We need to take the MAX value per machine per day, not sum them.
 */
router.get('/today/summary',
  authenticate,
  requirePermission(PERMISSIONS.VIEW_MACHINES),
  async (req, res) => {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const events = await Event.find({
        timestamp: { $gte: today }
      });

      const stats = {
        totalRevenue: 0,
        totalMoneyIn: 0,
        totalMoneyOut: 0,
        totalVouchers: 0,
        activeMachines: new Set()
      };

      // ✅ FIX #3: Group by machine and date for correct aggregation
      const machineDaily = {};

      events.forEach(event => {
        const machineId = event.gamingMachineId || event.machineId;
        stats.activeMachines.add(machineId);
        
        const date = event.timestamp.toISOString().split('T')[0];
        const key = `${machineId}_${date}`;
        
        if (!machineDaily[key]) {
          machineDaily[key] = { moneyIn: 0, moneyOut: 0, vouchers: 0 };
        }

        if (event.eventType === 'money_in') {
          // Keep highest cumulative value for this machine-day
          machineDaily[key].moneyIn = Math.max(machineDaily[key].moneyIn, event.amount || 0);
        } else if (event.eventType === 'money_out') {
          // Keep highest cumulative value for this machine-day
          machineDaily[key].moneyOut = Math.max(machineDaily[key].moneyOut, event.amount || 0);
        } else if (event.eventType === 'voucher_print') {
          // Vouchers are individual transactions - count and sum them
          stats.totalVouchers += 1;
          machineDaily[key].vouchers += event.amount || 0;
        }
      });

      // Sum all daily totals
      Object.values(machineDaily).forEach(daily => {
        stats.totalMoneyIn += daily.moneyIn;
        stats.totalMoneyOut += daily.moneyOut;
      });

      stats.totalRevenue = stats.totalMoneyIn - stats.totalMoneyOut;
      stats.activeMachines = stats.activeMachines.size;

      res.json({
        success: true,
        stats
      });

    } catch (error) {
      console.error('Error fetching today summary:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch today summary'
      });
    }
  }
);

module.exports = router;