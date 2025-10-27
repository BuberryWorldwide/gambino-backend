// Backend route file: routes-machine-details.js
// Mount this in server.js as: app.use('/api/admin/machines', require('./src/routes/routes-machine-details'));

const express = require('express');
const router = express.Router();
const Machine = require('../models/Machine');
const Event = require('../models/Event');
const DailyReport = require('../models/DailyReport');
const { authenticate, requirePermission, PERMISSIONS } = require('../middleware/rbac');

// GET /api/admin/machines/:machineId - Get single machine details
router.get('/:machineId',
  authenticate,
  requirePermission([PERMISSIONS.VIEW_ALL_METRICS, PERMISSIONS.VIEW_STORE_METRICS]),
  async (req, res) => {
    try {
      const { machineId } = req.params;
      
      // Try to find registered machine first
      let machine = await Machine.findOne({ machineId }).lean();
      let isDiscovered = false;
      
      // If not found in machines collection, check if it's discovered in events
      if (!machine) {
        const discoveredEvent = await Event.findOne({ 
          gamingMachineId: machineId 
        }).sort({ timestamp: -1 }).lean();
        
        if (!discoveredEvent) {
          return res.status(404).json({ error: 'Machine not found' });
        }
        
        // Create virtual machine object from event data
        machine = {
          machineId,
          hubId: discoveredEvent.hubMachineId,
          storeId: discoveredEvent.storeId,
          name: `Machine ${machineId} (Discovered)`,
          location: 'Not configured',
          status: 'discovered',
          gameType: 'slot'
        };
        isDiscovered = true;
      }
      
      // Check venue access
      const userRole = req.user.role;
      if (['venue_manager', 'venue_staff'].includes(userRole)) {
        if (!req.user.assignedVenues.includes(machine.storeId)) {
          return res.status(403).json({
            error: 'Access denied to this venue\'s machines'
          });
        }
      }
      
      console.log(`📊 Machine details: ${machineId} (${isDiscovered ? 'discovered' : 'registered'})`);
      
      res.json({
        success: true,
        machine: {
          ...machine,
          isRegistered: !isDiscovered  // FIXED: Frontend expects isRegistered flag
        },
        isDiscovered
      });
    } catch (e) {
      console.error('❌ Machine details error:', e);
      res.status(500).json({ error: 'Failed to load machine details' });
    }
  }
);

// GET /api/admin/machines/:machineId/stats - Get machine performance stats
router.get('/:machineId/stats',
  authenticate,
  requirePermission([PERMISSIONS.VIEW_ALL_METRICS, PERMISSIONS.VIEW_STORE_METRICS]),
  async (req, res) => {
    try {
      const { machineId } = req.params;
      const days = parseInt(req.query.days) || 30;
      
      // Find machine or check if discovered
      let machine = await Machine.findOne({ machineId });
      let storeId;
      
      if (!machine) {
        // Check if discovered in events
        const discoveredEvent = await Event.findOne({ 
          gamingMachineId: machineId 
        }).lean();
        
        if (!discoveredEvent) {
          return res.status(404).json({ error: 'Machine not found' });
        }
        
        storeId = discoveredEvent.storeId;
      } else {
        storeId = machine.storeId;
      }
      
      // Check venue access
      const userRole = req.user.role;
      if (['venue_manager', 'venue_staff'].includes(userRole)) {
        if (!req.user.assignedVenues.includes(storeId)) {
          return res.status(403).json({
            error: 'Access denied to this venue\'s machines'
          });
        }
      }
      
      // Calculate date range
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);
      
      // Query events from database
const events = await Event.find({
  gamingMachineId: machineId,
  timestamp: {
    $gte: startDate,
    $lte: endDate
  },
  eventType: { $in: ['money_in', 'money_out', 'voucher_print'] }
}).lean();

// Aggregate by date - CORRECT HANDLING OF CUMULATIVE VS TRANSACTION EVENTS
const dailyStatsMap = {};

events.forEach(event => {
  const date = event.timestamp.toISOString().split('T')[0];

  if (!dailyStatsMap[date]) {
    dailyStatsMap[date] = {
      date,
      moneyIn: 0,
      moneyOut: 0,
      voucherTotal: 0,
      revenue: 0
    };
  }

  // For cumulative events (money_in/money_out): Keep ONLY the highest value
  // (latest snapshot is the cumulative total for that day)
  if (event.eventType === 'money_in') {
    dailyStatsMap[date].moneyIn = Math.max(
      dailyStatsMap[date].moneyIn, 
      event.amount || 0
    );
  } else if (event.eventType === 'money_out') {
    dailyStatsMap[date].moneyOut = Math.max(
      dailyStatsMap[date].moneyOut, 
      event.amount || 0
    );
  } 
  // For transaction events (voucher_print): SUM all individual transactions
  else if (event.eventType === 'voucher_print') {
    dailyStatsMap[date].voucherTotal += event.amount || 0;
  }
});

// Calculate revenue for each day
Object.values(dailyStatsMap).forEach(stat => {
  stat.revenue = stat.moneyIn - stat.moneyOut;
});

// Convert to array and sort by date
const dailyStats = Object.values(dailyStatsMap).sort((a, b) =>
  new Date(a.date) - new Date(b.date)
);
      
      console.log(`📊 Stats for ${machineId}: ${dailyStats.length} days with data`);
      
      res.json({
        success: true,
        machineId,
        days,
        dailyStats
      });
    } catch (e) {
      console.error('❌ Machine stats error:', e);
      res.status(500).json({ error: 'Failed to load machine stats' });
    }
  }
);

// GET /api/admin/machines/:machineId/events - Get machine event history
router.get('/:machineId/events',
  authenticate,
  requirePermission([PERMISSIONS.VIEW_ALL_METRICS, PERMISSIONS.VIEW_STORE_METRICS]),
  async (req, res) => {
    try {
      const { machineId } = req.params;
      const limit = parseInt(req.query.limit) || 50;
      
      // Find machine or check if discovered
      let machine = await Machine.findOne({ machineId });
      let storeId;
      
      if (!machine) {
        // Check if discovered in events
        const discoveredEvent = await Event.findOne({ 
          gamingMachineId: machineId 
        }).lean();
        
        if (!discoveredEvent) {
          return res.status(404).json({ error: 'Machine not found' });
        }
        
        storeId = discoveredEvent.storeId;
      } else {
        storeId = machine.storeId;
      }
      
      // Check venue access
      const userRole = req.user.role;
      if (['venue_manager', 'venue_staff'].includes(userRole)) {
        if (!req.user.assignedVenues.includes(storeId)) {
          return res.status(403).json({ 
            error: 'Access denied to this venue\'s machines'
          });
        }
      }
      
      // Get recent events - USE gamingMachineId
      const events = await Event.find({ gamingMachineId: machineId })
        .sort({ timestamp: -1 })
        .limit(limit)
        .lean();
      
      console.log(`📊 Events for ${machineId}: ${events.length} events`);
      
      res.json({
        success: true,
        machineId,
        events
      });
    } catch (e) {
      console.error('❌ Machine events error:', e);
      res.status(500).json({ error: 'Failed to load machine events' });
    }
  }
);

// PUT - Update machine name
router.put('/:machineId',
  authenticate,
  requirePermission([PERMISSIONS.MANAGE_ASSIGNED_STORES, PERMISSIONS.MANAGE_ALL_STORES]),
  async (req, res) => {
    try {
      const machine = await Machine.findOne({ machineId: req.params.machineId });
      if (!machine) return res.status(404).json({ error: 'Machine not found' });

      if (req.body.name) machine.name = req.body.name;
      machine.updatedAt = new Date();
      await machine.save();

      res.json({ success: true, machine });
    } catch (e) {
      res.status(500).json({ error: 'Failed to update machine' });
    }
  }
);

// POST - Register discovered machine
router.post('/register',
  authenticate,
  requirePermission([PERMISSIONS.MANAGE_ASSIGNED_STORES, PERMISSIONS.MANAGE_ALL_STORES]),
  async (req, res) => {
    try {
      const { machineId, storeId, hubId, name } = req.body;
      
      let machine = await Machine.findOne({ machineId });
      if (machine) {
        return res.status(409).json({ error: 'Already registered', machine });
      }

      machine = await Machine.create({
        machineId,
        storeId,
        hubId,
        name: name || `Machine ${machineId}`,
        status: 'active',
        gameType: 'slot'
      });

      res.status(201).json({ success: true, machine });
    } catch (e) {
      res.status(500).json({ error: 'Failed to register' });
    }
  }
);

module.exports = router;