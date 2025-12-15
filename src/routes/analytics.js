const Store = require('../models/Store');
const express = require('express');
const router = express.Router();
const Machine = require('../models/Machine');
const Event = require('../models/Event'); // Adjust path as needed
const { authenticate, requirePermission, PERMISSIONS } = require('../middleware/rbac');

// ===== MUTHA GOOSE MAPPING ROUTES =====

// GET /api/admin/stores/:storeId/machine-mapping
// View and manage machine mappings for a store
router.get('/stores/:storeId/machine-mapping', 
  authenticate,
  requirePermission([PERMISSIONS.MANAGE_ALL_STORES, PERMISSIONS.MANAGE_ASSIGNED_STORES]),
  async (req, res) => {
    try {
      const { storeId } = req.params;
      
      // Get all machines for this store
      const machines = await Machine.find({ storeId }).lean();
      
      // Get recent Mutha Goose activity for this store (last 24 hours)
      const recentEvents = await Event.aggregate([
        { 
          $match: { 
            timestamp: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
            gamingMachineId: { $exists: true },
            $or: [
              { storeId: storeId }, // If events have storeId
              { machineId: { $regex: storeId } } // If Pi hub IDs contain store info
            ]
          }
        },
        {
          $group: {
            _id: '$gamingMachineId', // e.g., 'machine_03'
            lastActivity: { $max: '$timestamp' },
            eventCount: { $sum: 1 },
            hubMachineId: { $first: '$machineId' } // Pi hub ID
          }
        },
        { $sort: { lastActivity: -1 } }
      ]);
      
      // Find unmapped Mutha Goose machines
      const unmappedMuthaGoose = [];
      
      for (const event of recentEvents) {
        const existingMapping = machines.find(m => m.muthaGooseId === event._id);
        
        if (!existingMapping) {
          const muthaGooseNumber = parseInt(event._id.replace('machine_', ''));
          unmappedMuthaGoose.push({
            muthaGooseId: event._id,
            muthaGooseNumber,
            hubMachineId: event.hubMachineId,
            lastActivity: event.lastActivity,
            eventCount: event.eventCount,
            // Suggest machines based on location or name containing the number
            suggestedMachines: machines.filter(m => 
              !m.muthaGooseId && 
              (m.location?.includes(muthaGooseNumber.toString()) ||
               m.name?.includes(muthaGooseNumber.toString()) ||
               m.machineId.includes(muthaGooseNumber.toString()))
            ).slice(0, 3) // Max 3 suggestions
          });
        }
      }
      
      res.json({
        machines,
        unmappedMuthaGoose,
        totalMachines: machines.length,
        mappedMachines: machines.filter(m => m.muthaGooseId).length,
        unmappedMachines: machines.filter(m => !m.muthaGooseId).length,
        stats: {
          totalEvents: recentEvents.reduce((sum, e) => sum + e.eventCount, 0),
          activeMuthaGoose: recentEvents.length,
          mappingRate: machines.length > 0 ? 
            Math.round((machines.filter(m => m.muthaGooseId).length / machines.length) * 100) : 0
        }
      });
      
    } catch (error) {
      console.error('Error fetching machine mapping:', error);
      res.status(500).json({ error: 'Failed to fetch machine mapping' });
    }
  }
);

// POST /api/admin/machines/:machineId/map-mutha-goose
// Map a database machine to a Mutha Goose machine number
router.post('/machines/:machineId/map-mutha-goose',
  authenticate,
  requirePermission([PERMISSIONS.MANAGE_ALL_STORES, PERMISSIONS.MANAGE_ASSIGNED_STORES]),
  async (req, res) => {
    try {
      const { machineId } = req.params;
      const { muthaGooseNumber, hubMachineId, force = false } = req.body;
      
      if (!muthaGooseNumber || !hubMachineId) {
        return res.status(400).json({ 
          error: 'Mutha Goose number and hub machine ID required' 
        });
      }
      
      if (muthaGooseNumber < 1 || muthaGooseNumber > 99) {
        return res.status(400).json({ 
          error: 'Mutha Goose number must be between 1 and 99' 
        });
      }
      
      const machine = await Machine.findById(machineId);
      if (!machine) {
        return res.status(404).json({ error: 'Machine not found' });
      }
      
      // Check venue access for venue managers/staff
      const userRole = req.user.role;
      if (['venue_manager', 'venue_staff'].includes(userRole)) {
        if (!req.user.assignedVenues.includes(machine.storeId)) {
          return res.status(403).json({ 
            error: 'Access denied to this venue\'s machines',
            storeId: machine.storeId 
          });
        }
      }
      
      // Check for existing mapping conflicts
      const existingMapping = await Machine.findOne({
        $or: [
          { muthaGooseNumber, hubMachineId },
          { muthaGooseId: `machine_${muthaGooseNumber.toString().padStart(2, '0')}`, hubMachineId }
        ],
        _id: { $ne: machineId }
      });
      
      if (existingMapping && !force) {
        return res.status(409).json({ 
          error: 'Mutha Goose number already mapped to another machine',
          conflictMachine: {
            id: existingMapping._id,
            displayName: existingMapping.displayName || existingMapping.name,
            machineId: existingMapping.machineId
          },
          suggestion: 'Use force=true to override, or choose a different number'
        });
      }
      
      // If forcing and there's a conflict, unmap the existing machine
      if (existingMapping && force) {
        await existingMapping.unmapFromMuthaGoose(req.user.userId);
      }
      
      // Create the mapping using the model method
      await machine.mapToMuthaGoose(muthaGooseNumber, hubMachineId, req.user.userId);
      
      res.json({
        success: true,
        message: 'Machine successfully mapped to Mutha Goose',
        machine: {
          id: machine._id,
          machineId: machine.machineId,
          displayName: machine.displayName,
          muthaGooseNumber: machine.muthaGooseNumber,
          muthaGooseId: machine.muthaGooseId,
          hubMachineId: machine.hubMachineId,
          mappingStatus: machine.mappingStatus
        }
      });
      
    } catch (error) {
      console.error('Error mapping machine to Mutha Goose:', error);
      
      // Handle duplicate key errors
      if (error.code === 11000) {
        const field = error.keyPattern?.muthaGooseNumber ? 'Mutha Goose number' : 'machine mapping';
        return res.status(409).json({ 
          error: `${field} already exists for this hub`,
          suggestion: 'Try a different number or check existing mappings'
        });
      }
      
      res.status(500).json({ error: 'Failed to create machine mapping' });
    }
  }
);

// DELETE /api/admin/machines/:machineId/unmap-mutha-goose
// Remove Mutha Goose mapping from a machine
router.delete('/machines/:machineId/unmap-mutha-goose',
  authenticate,
  requirePermission([PERMISSIONS.MANAGE_ALL_STORES, PERMISSIONS.MANAGE_ASSIGNED_STORES]),
  async (req, res) => {
    try {
      const { machineId } = req.params;
      
      const machine = await Machine.findById(machineId);
      if (!machine) {
        return res.status(404).json({ error: 'Machine not found' });
      }
      
      // Check venue access for venue managers/staff
      const userRole = req.user.role;
      if (['venue_manager', 'venue_staff'].includes(userRole)) {
        if (!req.user.assignedVenues.includes(machine.storeId)) {
          return res.status(403).json({ 
            error: 'Access denied to this venue\'s machines',
            storeId: machine.storeId 
          });
        }
      }
      
      if (!machine.muthaGooseId) {
        return res.status(400).json({ 
          error: 'Machine is not mapped to Mutha Goose' 
        });
      }
      
      // Unmap using the model method
      await machine.unmapFromMuthaGoose(req.user.userId);
      
      res.json({ 
        success: true,
        message: 'Machine successfully unmapped from Mutha Goose',
        machine: {
          id: machine._id,
          machineId: machine.machineId,
          displayName: machine.displayName,
          mappingStatus: machine.mappingStatus
        }
      });
      
    } catch (error) {
      console.error('Error unmapping machine:', error);
      res.status(500).json({ error: 'Failed to unmap machine' });
    }
  }
);

// POST /api/admin/stores/:storeId/discover-machines
// Auto-discover machines from recent Mutha Goose activity
router.post('/stores/:storeId/discover-machines',
  authenticate,
  requirePermission([PERMISSIONS.MANAGE_ALL_STORES, PERMISSIONS.MANAGE_ASSIGNED_STORES]),
  async (req, res) => {
    try {
      const { storeId } = req.params;
      const { timeRangeHours = 24 } = req.body;
      
      // Check venue access for venue managers/staff
      const userRole = req.user.role;
      if (['venue_manager', 'venue_staff'].includes(userRole)) {
        if (!req.user.assignedVenues.includes(storeId)) {
          return res.status(403).json({ 
            error: 'Access denied to this venue',
            storeId 
          });
        }
      }
      
      const since = new Date(Date.now() - timeRangeHours * 60 * 60 * 1000);
      
      // Find all unique Mutha Goose machines from recent events
      const discoveredMachines = await Event.aggregate([
        { 
          $match: { 
            timestamp: { $gte: since },
            gamingMachineId: { $exists: true },
            $or: [
              { storeId: storeId },
              { machineId: { $regex: storeId } } // In case hub IDs contain store info
            ]
          }
        },
        {
          $group: {
            _id: {
              gamingMachineId: '$gamingMachineId',
              hubMachineId: '$machineId'
            },
            firstSeen: { $min: '$timestamp' },
            lastSeen: { $max: '$timestamp' },
            eventCount: { $sum: 1 },
            eventTypes: { $addToSet: '$eventType' },
            totalAmount: { 
              $sum: { 
                $toDouble: { $ifNull: ['$amount', '0'] }
              }
            }
          }
        },
        { $sort: { lastSeen: -1 } }
      ]);
      
      const discoveryResults = [];
      const existingMappings = await Machine.find({ 
        storeId,
        muthaGooseId: { $exists: true, $ne: null }
      }).lean();
      
      const mappedIds = new Set(existingMappings.map(m => m.muthaGooseId));
      
      for (const discovered of discoveredMachines) {
        const { gamingMachineId, hubMachineId } = discovered._id;
        
        if (!mappedIds.has(gamingMachineId)) {
          const muthaGooseNumber = parseInt(gamingMachineId.replace('machine_', ''));
          
          discoveryResults.push({
            muthaGooseId: gamingMachineId,
            muthaGooseNumber,
            hubMachineId,
            firstSeen: discovered.firstSeen,
            lastSeen: discovered.lastSeen,
            eventCount: discovered.eventCount,
            eventTypes: discovered.eventTypes,
            totalAmount: discovered.totalAmount,
            status: 'needs_mapping'
          });
        }
      }
      
      res.json({
        discovered: discoveryResults,
        discoveredCount: discoveryResults.length,
        timeRange: `${timeRangeHours} hours`,
        totalEvents: discoveredMachines.reduce((sum, d) => sum + d.eventCount, 0),
        recommendations: [
          'Review discovered machines below',
          'Map each to your database machines',
          'Physical verification recommended',
          'Check machine locations match expected positions'
        ],
        mappingGuidelines: {
          muthaGooseRange: '1-99',
          hubIdFormat: 'hub-location-identifier',
          verificationSteps: [
            'Confirm physical machine location',
            'Verify Mutha Goose number matches machine display',
            'Test QR code binding after mapping'
          ]
        }
      });
      
    } catch (error) {
      console.error('Error discovering machines:', error);
      res.status(500).json({ error: 'Failed to discover machines' });
    }
  }
);

// Store daily summary
router.get('/admin/stores/:storeId/daily/:date', async (req, res) => {
  try {
    const { storeId, date } = req.params;
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);

    // Get money_in/money_out snapshots (use MAX for latest)
    const snapshots = await Event.aggregate([
      {
        $match: {
          storeId: storeId,
          eventType: { $in: ['money_in', 'money_out'] },
          timestamp: { $gte: startOfDay, $lte: endOfDay }
        }
      },
      {
        $group: {
          _id: { eventType: '$eventType', machineId: '$gamingMachineId' },
          total: { $max: '$amount' }
        }
      }
    ]);

    // Get voucher transactions (use SUM)
    const vouchers = await Event.aggregate([
      {
        $match: {
          storeId: storeId,
          eventType: 'voucher_print',
          timestamp: { $gte: startOfDay, $lte: endOfDay }
        }
      },
      {
        $group: {
          _id: '$gamingMachineId',
          total: { $sum: '$amount' }
        }
      }
    ]);

    // Organize by machine
    const machines = {};
    let totalMoneyIn = 0;
    let totalMoneyOut = 0;

    // Process snapshots
    snapshots.forEach(stat => {
      const machineId = stat._id.machineId;
      if (!machines[machineId]) {
        machines[machineId] = { machineId, moneyIn: 0, moneyOut: 0 };
      }

      if (stat._id.eventType === 'money_in') {
        machines[machineId].moneyIn = stat.total;
        totalMoneyIn += stat.total;
      } else if (stat._id.eventType === 'money_out') {
        machines[machineId].moneyOut = stat.total;
        totalMoneyOut += stat.total;
      }
    });

    // Add vouchers
    vouchers.forEach(v => {
      const machineId = v._id;
      if (!machines[machineId]) {
        machines[machineId] = { machineId, moneyIn: 0, moneyOut: 0 };
      }
      machines[machineId].moneyOut += v.total;
      totalMoneyOut += v.total;
    });

    res.json({
      date,
      storeId,
      totalMoneyIn,
      totalMoneyOut,
      netRevenue: totalMoneyIn - totalMoneyOut,
      machines: Object.values(machines)
    });

  } catch (error) {
    console.error('Error fetching store daily:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/admin/stores/:storeId/mapping-stats
// Get mapping statistics for a store
router.get('/stores/:storeId/mapping-stats',
  authenticate,
  requirePermission([PERMISSIONS.VIEW_ALL_METRICS, PERMISSIONS.VIEW_STORE_METRICS]),
  async (req, res) => {
    try {
      const { storeId } = req.params;
      
      const mappingStats = await Machine.getMappingStats(storeId);
      const totalMachines = await Machine.countDocuments({ storeId });
      
      const stats = {
        total: totalMachines,
        mapped: 0,
        unmapped: 0,
        conflict: 0
      };
      
      mappingStats.forEach(stat => {
        stats[stat._id] = stat.count;
      });
      
      // Calculate recent activity
      const recentActivity = await Event.countDocuments({
        timestamp: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        gamingMachineId: { $exists: true }
      });
      
      res.json({
        ...stats,
        mappingRate: totalMachines > 0 ? Math.round((stats.mapped / totalMachines) * 100) : 0,
        recentActivity,
        recommendations: stats.unmapped > 0 ? [
          `${stats.unmapped} machines need Mutha Goose mapping`,
          'Use auto-discovery to find active machines',
          'Verify physical machine locations'
        ] : [
          'All machines are mapped',
          'Monitor for new machine activity'
        ]
      });
      
    } catch (error) {
      console.error('Error fetching mapping stats:', error);
      res.status(500).json({ error: 'Failed to fetch mapping statistics' });
    }
  }
);

// GET /api/admin/stores/:storeId/analytics - Get store analytics data
router.get('/admin/stores/:storeId/analytics', 
  authenticate,
  requirePermission([PERMISSIONS.MANAGE_ASSIGNED_STORES, PERMISSIONS.MANAGE_ALL_STORES]),
  async (req, res) => {
    try {
      const { storeId } = req.params;
      
      // Verify store exists and user has access
      const store = await Store.findOne({ storeId });
      if (!store) {
        return res.status(404).json({ error: 'Store not found' });
      }

      // Get machines for this store
      const machines = await Machine.find({ storeId }).lean();
      
      // Get events for machines in this store (using hubMachineId to link to store)
      const machineIds = machines.map(m => m.machineId);
      const events = await Event.find({ 
        hubMachineId: { $in: machineIds } 
      })
      .sort({ timestamp: -1 })
      .limit(100)
      .lean();

      // Calculate stats
      const stats = {
        totalMachines: machines.length,
        activeMachines: machines.filter(m => m.status === 'active').length,
        inactiveMachines: machines.filter(m => m.status === 'inactive').length,
        maintenanceMachines: machines.filter(m => m.status === 'maintenance').length,
        totalEvents: events.length,
        totalRevenue: events
          .filter(e => e.eventType === 'voucher' && e.amount)
          .reduce((sum, e) => sum + e.amount, 0),
        totalBets: events
          .filter(e => e.eventType === 'money_in' && e.amount)
          .reduce((sum, e) => sum + e.amount, 0),
        uniquePlayers: new Set(events.filter(e => e.userId).map(e => e.userId.toString())).size,
        recentActivity: events.slice(0, 10).map(event => ({
          _id: event._id,
          eventType: event.eventType,
          machineId: event.gamingMachineId,
          amount: event.amount,
          timestamp: event.timestamp,
          isUserBound: event.isUserBound
        }))
      };

      res.json({
        success: true,
        store: {
          storeId: store.storeId,
          storeName: store.storeName
        },
        stats,
        machines: machines.map(m => ({
          _id: m._id,
          machineId: m.machineId,
          name: m.name,
          location: m.location,
          status: m.status,
          gameType: m.gameType,
          lastSeen: m.lastSeen
        })),
        events: stats.recentActivity
      });

    } catch (error) {
      console.error('Analytics error:', error);
      res.status(500).json({ error: 'Failed to fetch analytics' });
    }
  }
);

// GET /api/admin/stores/:storeId/stats - Get store statistics only
router.get('/admin/stores/:storeId/stats', 
  authenticate,
  requirePermission([PERMISSIONS.MANAGE_ASSIGNED_STORES, PERMISSIONS.MANAGE_ALL_STORES]),
  async (req, res) => {
    try {
      const { storeId } = req.params;
      
      const store = await Store.findOne({ storeId });
      if (!store) {
        return res.status(404).json({ error: 'Store not found' });
      }

      const machines = await Machine.find({ storeId });
      const machineIds = machines.map(m => m.machineId);
      
      // Get recent events (last 30 days)
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const events = await Event.find({ 
        hubMachineId: { $in: machineIds },
        timestamp: { $gte: thirtyDaysAgo }
      });

      const stats = {
        totalMachines: machines.length,
        activeMachines: machines.filter(m => m.status === 'active').length,
        totalRevenue: events
          .filter(e => e.eventType === 'voucher' && e.amount)
          .reduce((sum, e) => sum + e.amount, 0),
        totalPlayers: new Set(events.filter(e => e.userId).map(e => e.userId.toString())).size,
        avgSessionLength: 0, // Calculate if you have session data
        totalEvents: events.length
      };

      res.json({ success: true, stats });

    } catch (error) {
      console.error('Stats error:', error);
      res.status(500).json({ error: 'Failed to fetch stats' });
    }
  }
);

// GET /api/admin/stores/:storeId/events - Get store events
router.get('/admin/stores/:storeId/events', 
  authenticate,
  requirePermission([PERMISSIONS.MANAGE_ASSIGNED_STORES, PERMISSIONS.MANAGE_ALL_STORES]),
  async (req, res) => {
    try {
      const { storeId } = req.params;
      const limit = parseInt(req.query.limit) || 50;
      
      const store = await Store.findOne({ storeId });
      if (!store) {
        return res.status(404).json({ error: 'Store not found' });
      }

      const machines = await Machine.find({ storeId });
      const machineIds = machines.map(m => m.machineId);
      
      const events = await Event.find({ 
        hubMachineId: { $in: machineIds }
      })
      .sort({ timestamp: -1 })
      .limit(limit)
      .populate('userId', 'email')
      .lean();

      res.json({ 
        success: true, 
        events: events.map(event => ({
          _id: event._id,
          eventType: event.eventType,
          machineId: event.gamingMachineId,
          hubMachineId: event.hubMachineId,
          amount: event.amount,
          timestamp: event.timestamp,
          isUserBound: event.isUserBound,
          userEmail: event.userId?.email || null
        }))
      });

    } catch (error) {
      console.error('Events error:', error);
      res.status(500).json({ error: 'Failed to fetch events' });
    }
  }
);

// GET /api/admin/stores-with-status - Get all stores with hub counts and connectivity status
const Hub = require('../models/Hub');

router.get('/admin/stores-with-status',
  authenticate,
  requirePermission([PERMISSIONS.VIEW_ALL_METRICS, PERMISSIONS.VIEW_STORE_METRICS]),
  async (req, res) => {
    try {
      const userRole = req.user.role;
      let storeQuery = {};

      // Venue managers/staff only see their assigned stores
      if (['venue_manager', 'venue_staff'].includes(userRole)) {
        storeQuery = { storeId: { $in: req.user.assignedVenues || [] } };
      }

      // Get all stores
      const stores = await Store.find(storeQuery).lean();

      // Get hub counts per store
      const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);

      // Aggregate hub data per store
      const hubStats = await Hub.aggregate([
        {
          $group: {
            _id: '$storeId',
            hubCount: { $sum: 1 },
            hubsOnline: {
              $sum: {
                $cond: [
                  { $and: [
                    { $gte: ['$lastHeartbeat', twoMinutesAgo] },
                    { $eq: ['$status', 'online'] }
                  ]},
                  1,
                  0
                ]
              }
            },
            hubs: {
              $push: {
                hubId: '$hubId',
                name: '$name',
                status: '$status',
                lastHeartbeat: '$lastHeartbeat',
                isOnline: {
                  $and: [
                    { $gte: ['$lastHeartbeat', twoMinutesAgo] },
                    { $eq: ['$status', 'online'] }
                  ]
                }
              }
            }
          }
        }
      ]);

      // Create lookup map for hub stats
      const hubStatsMap = {};
      hubStats.forEach(stat => {
        hubStatsMap[stat._id] = stat;
      });

      // Get machine counts per store
      const machineCounts = await Machine.aggregate([
        { $group: { _id: '$storeId', count: { $sum: 1 } } }
      ]);
      const machineCountMap = {};
      machineCounts.forEach(mc => {
        machineCountMap[mc._id] = mc.count;
      });

      // Enrich stores with hub data
      const enrichedStores = stores.map(store => {
        const stats = hubStatsMap[store.storeId] || { hubCount: 0, hubsOnline: 0, hubs: [] };
        const machinesCount = machineCountMap[store.storeId] || 0;

        // Determine connectivity status
        let connectivityStatus = 'offline';
        if (stats.hubCount > 0) {
          if (stats.hubsOnline > 0) {
            connectivityStatus = 'online';
          }
        } else {
          connectivityStatus = 'unknown'; // No hubs registered
        }

        return {
          ...store,
          hubCount: stats.hubCount,
          hubsOnline: stats.hubsOnline,
          hubsCount: stats.hubCount, // Alias for frontend compatibility
          hubs: stats.hubs,
          machinesCount,
          connectivityStatus
        };
      });

      // Sort by store name
      enrichedStores.sort((a, b) => (a.storeName || '').localeCompare(b.storeName || ''));

      res.json({
        success: true,
        stores: enrichedStores,
        total: enrichedStores.length,
        summary: {
          totalStores: enrichedStores.length,
          onlineStores: enrichedStores.filter(s => s.connectivityStatus === 'online').length,
          offlineStores: enrichedStores.filter(s => s.connectivityStatus === 'offline').length,
          totalHubs: enrichedStores.reduce((sum, s) => sum + (s.hubCount || 0), 0),
          onlineHubs: enrichedStores.reduce((sum, s) => sum + (s.hubsOnline || 0), 0)
        }
      });

    } catch (error) {
      console.error('Stores with status error:', error);
      res.status(500).json({ error: 'Failed to fetch stores' });
    }
  }
);

module.exports = router;