// src/routes/hubs.js
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const Hub = require('../models/Hub');
const Machine = require('../models/Machine');
const Store = require('../models/Store');
const DailyReport = require('../models/DailyReport');
const { authenticate, requirePermission, PERMISSIONS } = require('../middleware/rbac');

// ============================================================================
// ADMIN ENDPOINTS - Hub Management
// ============================================================================

// GET /api/admin/hubs - List all hubs (filtered by role)
router.get('/', 
  authenticate,
  requirePermission([PERMISSIONS.VIEW_ALL_METRICS, PERMISSIONS.VIEW_STORE_METRICS]),
  async (req, res) => {
    try {
      const userRole = req.user.role;
      let query = {};
      
      // Venue managers/staff only see hubs at their assigned stores
      if (['venue_manager', 'venue_staff'].includes(userRole)) {
        query = { storeId: { $in: req.user.assignedVenues } };
      }
      
      const hubs = await Hub.find(query)
        .sort({ storeId: 1, name: 1 })
        .lean();
      
      // Enrich with store info
      const storeIds = [...new Set(hubs.map(h => h.storeId))];
      const stores = await Store.find({ storeId: { $in: storeIds } })
        .select('storeId storeName city state')
        .lean();
      
      const storeMap = {};
      stores.forEach(s => {
        storeMap[s.storeId] = s;
      });
      
      const enrichedHubs = hubs.map(hub => ({
        ...hub,
        store: storeMap[hub.storeId] || null,
        isOnline: hub.lastHeartbeat && 
                  (new Date() - new Date(hub.lastHeartbeat)) < 2 * 60 * 1000
      }));
      
      res.json({
        success: true,
        hubs: enrichedHubs,
        total: enrichedHubs.length,
        scope: ['venue_manager', 'venue_staff'].includes(userRole) 
          ? 'assigned_venues' 
          : 'all_venues'
      });
    } catch (error) {
      console.error('List hubs error:', error);
      res.status(500).json({ error: 'Failed to load hubs' });
    }
  }
);

// GET /api/admin/machines/all - Get all machines from all hubs in one call
router.get('/machines/all',
  authenticate,
  requirePermission([PERMISSIONS.VIEW_ALL_METRICS, PERMISSIONS.VIEW_STORE_METRICS]),
  async (req, res) => {
    try {
      const userRole = req.user.role;
      const assignedVenues = req.user.assignedVenues || [];

      // Get all hubs
      let hubFilter = {};
      if (['venue_manager', 'venue_staff'].includes(userRole) && assignedVenues.length > 0) {
        hubFilter.storeId = { $in: assignedVenues };
      }
      
      const hubs = await Hub.find(hubFilter).lean();
      
      const allMachines = [];
      
      // Get machines from each hub
      for (const hub of hubs) {
        try {
          const distinctMachineIds = await Event.distinct('gamingMachineId', { 
            hubMachineId: hub.hubId,
            gamingMachineId: { $ne: hub.hubId }
          });

          for (const machineId of distinctMachineIds) {
            const machineRecord = await Machine.findOne({ machineId }).lean();
            
            allMachines.push({
              _id: machineRecord?._id,
              machineId,
              name: machineRecord?.name || machineId,
              isRegistered: !!machineRecord,
              hubId: hub.hubId,
              storeId: hub.storeId,
              store: hub.store
            });
          }
        } catch (err) {
          console.error(`Failed to load machines for hub ${hub.hubId}`);
        }
      }

      res.json({ 
        success: true, 
        machines: allMachines,
        count: allMachines.length
      });

    } catch (error) {
      console.error('Get all machines error:', error);
      res.status(500).json({ error: 'Failed to load machines' });
    }
  }
);

// GET /api/admin/hubs/:hubId - Get hub details
router.get('/:hubId',
  authenticate,
  requirePermission([PERMISSIONS.VIEW_ALL_METRICS, PERMISSIONS.VIEW_STORE_METRICS]),
  async (req, res) => {
    try {
      const hub = await Hub.findOne({ hubId: req.params.hubId }).lean();
      
      if (!hub) {
        return res.status(404).json({ error: 'Hub not found' });
      }
      
      // Check access for venue managers/staff
      const userRole = req.user.role;
      if (['venue_manager', 'venue_staff'].includes(userRole)) {
        if (!req.user.assignedVenues.includes(hub.storeId)) {
          return res.status(403).json({ 
            error: 'Access denied to this hub',
            storeId: hub.storeId 
          });
        }
      }
      
      // Get store info
      const store = await Store.findOne({ storeId: hub.storeId })
        .select('storeId storeName address city state')
        .lean();
      
      // Get machines on this hub
      const machines = await Machine.find({ hubId: hub.hubId })
        .select('machineId name status gameType lastSeen')
        .lean();
      
      res.json({
        success: true,
        hub: {
          ...hub,
          isOnline: hub.lastHeartbeat && 
                    (new Date() - new Date(hub.lastHeartbeat)) < 2 * 60 * 1000,
          store,
          machines,
          machineCount: machines.length
        }
      });
    } catch (error) {
      console.error('Get hub error:', error);
      res.status(500).json({ error: 'Failed to load hub details' });
    }
  }
);

// POST /api/admin/hubs/register - Register new hub
// POST /api/admin/hubs/register - Register new hub with refresh token system
router.post('/register',
  authenticate,
  requirePermission([PERMISSIONS.MANAGE_ALL_STORES]),
  async (req, res) => {
    try {
      const { hubId, name, storeId, serialPort } = req.body;
      
      if (!hubId || !name || !storeId) {
        return res.status(400).json({ 
          error: 'hubId, name, and storeId are required' 
        });
      }
      
      
      // Check if hub already exists
      const existing = await Hub.findOne({ hubId });
      if (existing) {
        return res.status(409).json({ 
          error: 'Hub ID already exists',
          existingHub: existing.hubId 
        });
      }
      
      // Verify store exists
      const store = await Store.findOne({ storeId });
      if (!store) {
        return res.status(404).json({ error: 'Store not found' });
      }
      
      // Create hub with initial token version
      const hub = new Hub({
        hubId,
        name,
        storeId,
        serialConfig: {
          port: serialPort || '/dev/ttyUSB0'
        },
        tokenVersion: 1,
        createdBy: req.user.email
      });
      
      // Generate access + refresh tokens using the Hub model method
      const tokens = hub.generateTokens();
      
      // Save hub with tokens
      await hub.save();
      
      console.log(`✅ Hub registered: ${hubId} → ${store.storeName} (refresh token system)`);
      
      res.status(201).json({
        success: true,
        message: `Hub ${hubId} registered to ${store.storeName}`,
        hub: {
          hubId: hub.hubId,
          name: hub.name,
          storeId: hub.storeId,
          tokenVersion: hub.tokenVersion
        },
        tokens: {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          accessTokenExpiresAt: tokens.expiresAt,
          accessTokenExpiresIn: tokens.expiresIn,
          refreshTokenExpiresAt: hub.refreshTokenExpiresAt
        },
        setupInstructions: {
          envConfig: {
            MACHINE_ID: hubId,
            STORE_ID: storeId,
            API_ENDPOINT: process.env.API_ENDPOINT || 'https://api.gambino.gold',
            ACCESS_TOKEN: tokens.accessToken,
            REFRESH_TOKEN: tokens.refreshToken,
            SERIAL_PORT: serialPort || '/dev/ttyUSB0',
            LOG_LEVEL: 'info',
            NODE_ENV: 'production'
          },
          steps: [
            '1. SSH into your Raspberry Pi',
            '2. Navigate to /opt/gambino-pi or ~/gambino-pi-app',
            '3. Create or update .env file with the configuration below',
            '4. Restart the service: sudo systemctl restart gambino-pi',
            '5. The Pi will automatically refresh the access token before it expires'
          ],
          tokenInfo: {
            accessToken: 'Valid for 7 days, auto-refreshed by Pi',
            refreshToken: 'Valid for 1 year, used to get new access tokens',
            autoRenewal: 'Pi will automatically refresh access token when it has < 24 hours remaining'
          }
        }
      });
    } catch (error) {
      console.error('Register hub error:', error);
      res.status(500).json({ 
        error: 'Failed to register hub',
        details: error.message 
      });
    }
  }
);

// POST /api/admin/hubs/:hubId/regenerate-token - UPDATED for refresh token system
router.post('/:hubId/regenerate-token',
  authenticate,
  requirePermission([PERMISSIONS.MANAGE_ALL_STORES]),
  async (req, res) => {
    try {
      const hub = await Hub.findOne({ hubId: req.params.hubId });
      
      if (!hub) {
        return res.status(404).json({ error: 'Hub not found' });
      }
      
      // Revoke old tokens (increment version)
      hub.revokeTokens('admin_regeneration');
      
      // Generate new tokens
      const tokens = hub.generateTokens();
      
      // Save with new tokens
      hub.lastModifiedBy = req.user.email;
      await hub.save();
      
      console.log(`✅ Tokens regenerated for hub: ${hub.hubId} (new version: ${hub.tokenVersion})`);
      
      res.json({
        success: true,
        message: 'Tokens regenerated successfully',
        tokens: {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          accessTokenExpiresAt: tokens.expiresAt,
          accessTokenExpiresIn: tokens.expiresIn,
          refreshTokenExpiresAt: hub.refreshTokenExpiresAt
        },
        tokenVersion: hub.tokenVersion,
        instructions: [
          'Update both ACCESS_TOKEN and REFRESH_TOKEN in Pi .env file',
          'Restart the service: sudo systemctl restart gambino-pi',
          'Old tokens are now invalid (token version incremented)'
        ]
      });
    } catch (error) {
      console.error('Regenerate token error:', error);
      res.status(500).json({ 
        error: 'Failed to regenerate tokens',
        details: error.message 
      });
    }
  }
);

// NEW: POST /api/edge/refresh-token - Pi endpoint to refresh access token
router.post('/edge/refresh-token', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    
    if (!refreshToken) {
      return res.status(400).json({ 
        error: 'Refresh token required' 
      });
    }
    
    // Find hub by refresh token
    const hub = await Hub.findByRefreshToken(refreshToken);
    
    if (!hub) {
      return res.status(401).json({ 
        error: 'Invalid or expired refresh token',
        action: 'Please regenerate tokens in admin dashboard'
      });
    }
    
    // Refresh the access token
    const newToken = hub.refreshAccessToken();
    
    // Save updated hub
    await hub.save();
    
    console.log(`🔄 Access token refreshed for hub: ${hub.hubId}`);
    
    res.json({
      success: true,
      accessToken: newToken.accessToken,
      expiresAt: newToken.expiresAt,
      expiresIn: newToken.expiresIn,
      tokenVersion: hub.tokenVersion,
      message: 'Access token refreshed successfully'
    });
    
  } catch (error) {
    console.error('Token refresh error:', error);
    
    if (error.message === 'Refresh token expired') {
      return res.status(401).json({ 
        error: 'Refresh token expired',
        action: 'Please regenerate tokens in admin dashboard'
      });
    }
    
    res.status(500).json({ 
      error: 'Failed to refresh token',
      details: error.message 
    });
  }
});




// PUT /api/admin/hubs/:hubId - Update hub
router.put('/:hubId',
  authenticate,
  requirePermission([PERMISSIONS.MANAGE_ALL_STORES, PERMISSIONS.MANAGE_ASSIGNED_STORES]),
  async (req, res) => {
    try {
      const hub = await Hub.findOne({ hubId: req.params.hubId });
      
      if (!hub) {
        return res.status(404).json({ error: 'Hub not found' });
      }
      
      // Check access for venue managers
      const userRole = req.user.role;
      if (['venue_manager', 'venue_staff'].includes(userRole)) {
        if (!req.user.assignedVenues.includes(hub.storeId)) {
          return res.status(403).json({ 
            error: 'Access denied to this hub',
            storeId: hub.storeId 
          });
        }
      }
      
      const updates = {};
      if (req.body.name) updates.name = req.body.name;
      if (req.body.status) updates.status = req.body.status;
      if (req.body.config) updates.config = { ...hub.config, ...req.body.config };
      if (req.body.serialConfig) {
        updates.serialConfig = { ...hub.serialConfig, ...req.body.serialConfig };
      }
      
      updates.lastModifiedBy = req.user.email;
      updates.updatedAt = new Date();
      
      const updatedHub = await Hub.findOneAndUpdate(
        { hubId: req.params.hubId },
        updates,
        { new: true }
      );
      
      console.log(`✅ Hub updated: ${updatedHub.hubId}`);
      
      res.json({
        success: true,
        message: `Hub ${updatedHub.hubId} updated`,
        hub: updatedHub
      });
    } catch (error) {
      console.error('Update hub error:', error);
      res.status(500).json({ error: 'Failed to update hub' });
    }
  }
);

// DELETE /api/admin/hubs/:hubId - Delete hub
router.delete('/:hubId',
  authenticate,
  requirePermission([PERMISSIONS.MANAGE_ALL_STORES]),
  async (req, res) => {
    try {
      const hub = await Hub.findOne({ hubId: req.params.hubId });
      
      if (!hub) {
        return res.status(404).json({ error: 'Hub not found' });
      }
      
      // Check if hub has machines
      const machineCount = await Machine.countDocuments({ hubId: hub.hubId });
      if (machineCount > 0) {
        return res.status(400).json({ 
          error: 'Cannot delete hub with connected machines',
          machineCount,
          suggestion: 'Remove or reassign all machines first'
        });
      }
      
      await Hub.deleteOne({ hubId: req.params.hubId });
      
      console.log(`✅ Hub deleted: ${hub.hubId}`);
      
      res.json({
        success: true,
        message: `Hub ${hub.hubId} deleted`
      });
    } catch (error) {
      console.error('Delete hub error:', error);
      res.status(500).json({ error: 'Failed to delete hub' });
    }
  }
);

// POST /api/admin/hubs/:hubId/regenerate-token - Regenerate auth token
router.post('/:hubId/regenerate-token',
  authenticate,
  requirePermission([PERMISSIONS.MANAGE_ALL_STORES]),
  async (req, res) => {
    try {
      const hub = await Hub.findOne({ hubId: req.params.hubId });
      
      if (!hub) {
        return res.status(404).json({ error: 'Hub not found' });
      }
      
      // Generate new token
      const machineToken = jwt.sign(
        { 
          hubId: hub.hubId,
          storeId: hub.storeId,
          type: 'hub',
          iat: Math.floor(Date.now() / 1000)
        },
        process.env.MACHINE_JWT_SECRET || process.env.JWT_SECRET,
        { expiresIn: '365d' }
      );
      
      const tokenExpiresAt = new Date();
      tokenExpiresAt.setDate(tokenExpiresAt.getDate() + 365);
      
      hub.machineToken = machineToken;
      hub.tokenGeneratedAt = new Date();
      hub.tokenExpiresAt = tokenExpiresAt;
      hub.lastModifiedBy = req.user.email;
      await hub.save();
      
      console.log(`✅ Token regenerated for hub: ${hub.hubId}`);
      
      res.json({
        success: true,
        message: 'Token regenerated successfully',
        machineToken,
        expiresAt: tokenExpiresAt,
        instructions: 'Update MACHINE_TOKEN in Pi .env file and restart service'
      });
    } catch (error) {
      console.error('Regenerate token error:', error);
      res.status(500).json({ error: 'Failed to regenerate token' });
    }
  }
);



// GET /api/admin/hubs/:hubId/machines - Get machines on this hub
router.get('/:hubId/machines',
  authenticate,
  requirePermission([PERMISSIONS.VIEW_ALL_METRICS, PERMISSIONS.VIEW_STORE_METRICS]),
  async (req, res) => {
    try {
      const hub = await Hub.findOne({ hubId: req.params.hubId });
      
      if (!hub) {
        return res.status(404).json({ error: 'Hub not found' });
      }
      
      // Check access
      const userRole = req.user.role;
      if (['venue_manager', 'venue_staff'].includes(userRole)) {
        if (!req.user.assignedVenues.includes(hub.storeId)) {
          return res.status(403).json({ 
            error: 'Access denied to this hub',
            storeId: hub.storeId 
          });
        }
      }
      
      const machines = await Machine.find({ hubId: hub.hubId })
        .sort({ machineId: 1 })
        .lean();
      
      res.json({
        success: true,
        hubId: hub.hubId,
        hubName: hub.name,
        machines,
        total: machines.length
      });
    } catch (error) {
      console.error('Get hub machines error:', error);
      res.status(500).json({ error: 'Failed to load hub machines' });
    }
  }
);

// GET /api/admin/hubs/stats/summary - Hub summary stats
router.get('/stats/summary',
  authenticate,
  requirePermission([PERMISSIONS.VIEW_ALL_METRICS, PERMISSIONS.VIEW_STORE_METRICS]),
  async (req, res) => {
    try {
      const userRole = req.user.role;
      let matchCondition = {};
      
      if (['venue_manager', 'venue_staff'].includes(userRole)) {
        matchCondition = { storeId: { $in: req.user.assignedVenues } };
      }
      
      const totalHubs = await Hub.countDocuments(matchCondition);
      
      const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
      const onlineHubs = await Hub.countDocuments({
        ...matchCondition,
        lastHeartbeat: { $gte: twoMinutesAgo },
        status: 'online'
      });
      
      const offlineHubs = await Hub.countDocuments({
        ...matchCondition,
        $or: [
          { lastHeartbeat: { $lt: twoMinutesAgo } },
          { status: 'offline' }
        ]
      });
      
      const errorHubs = await Hub.countDocuments({
        ...matchCondition,
        status: 'error'
      });
      
      res.json({
        success: true,
        summary: {
          total: totalHubs,
          online: onlineHubs,
          offline: offlineHubs,
          error: errorHubs,
          healthScore: totalHubs > 0 ? Math.round((onlineHubs / totalHubs) * 100) : 0,
          scope: ['venue_manager', 'venue_staff'].includes(userRole) 
            ? 'assigned_venues' 
            : 'all_venues'
        }
      });
    } catch (error) {
      console.error('Hub summary error:', error);
      res.status(500).json({ error: 'Failed to load hub summary' });
    }
  }
);

// GET /api/admin/hubs/:hubId/discovered-machines - Get machines discovered by this hub
router.get('/:hubId/discovered-machines',
  authenticate,
  requirePermission([PERMISSIONS.VIEW_ALL_METRICS, PERMISSIONS.VIEW_STORE_METRICS]),
  async (req, res) => {
    try {
      const { hubId } = req.params;
      const hub = await Hub.findOne({ hubId });
      if (!hub) return res.status(404).json({ error: 'Hub not found' });
      
      if (['venue_manager', 'venue_staff'].includes(req.user.role)) {
        if (!req.user.assignedVenues.includes(hub.storeId)) {
          return res.status(403).json({ error: 'Access denied' });
        }
      }
      
      // Date range filtering (default to last 7 days)
      const endDate = req.query.endDate ? new Date(req.query.endDate) : new Date();
      endDate.setHours(23, 59, 59, 999);
      
      const startDate = req.query.startDate 
        ? new Date(req.query.startDate) 
        : new Date(endDate.getTime() - (7 * 24 * 60 * 60 * 1000)); // 7 days ago
      startDate.setHours(0, 0, 0, 0);
      
      const Event = require('../models/Event');
      const distinctMachineIds = await Event.distinct('gamingMachineId', { 
        hubMachineId: hubId,
        gamingMachineId: { $ne: hubId }
      });
      
      const machines = await Promise.all(distinctMachineIds.map(async (machineId) => {
        const machineRecord = await Machine.findOne({ machineId }).lean();
        
        // Get events within date range
        const events = await Event.find({
          hubMachineId: hubId,
          gamingMachineId: machineId,
          eventType: { $in: ['money_in', 'money_out', 'voucher_print'] },
          timestamp: { $gte: startDate, $lte: endDate }
        }).sort({ timestamp: 1 }).lean();
        
        // Group by date and handle cumulative vs transaction events correctly
        const dailyTotals = {};
        let voucherTotal = 0;
        
        events.forEach(event => {
          const date = new Date(event.timestamp).toISOString().split('T')[0];
          
          if (!dailyTotals[date]) {
            dailyTotals[date] = { moneyIn: 0, moneyOut: 0 };
          }
          
          // Cumulative events: Keep highest value per day (latest snapshot)
          if (event.eventType === 'money_in') {
            dailyTotals[date].moneyIn = Math.max(dailyTotals[date].moneyIn, event.amount || 0);
          } else if (event.eventType === 'money_out') {
            dailyTotals[date].moneyOut = Math.max(dailyTotals[date].moneyOut, event.amount || 0);
          }
          // Transaction events: Sum all occurrences
          else if (event.eventType === 'voucher_print') {
            voucherTotal += event.amount || 0;
          }
        });
        
        // Sum all daily totals
        let moneyIn = 0;
        let moneyOut = 0;
        
        Object.values(dailyTotals).forEach(day => {
          moneyIn += day.moneyIn;
          moneyOut += day.moneyOut;
        });
        
        // Add vouchers to money out (vouchers are payouts)
        moneyOut += voucherTotal;
        
        return {
          _id: machineRecord?._id,
          machineId,
          name: machineRecord?.name || machineId,
          isRegistered: !!machineRecord,
          storeId: hub.storeId,
          hubMachineId: hubId,
          totalMoneyIn: Math.round(moneyIn * 100) / 100,
          totalMoneyOut: Math.round(moneyOut * 100) / 100,
          totalRevenue: Math.round((moneyIn - moneyOut) * 100) / 100
        };
      }));
      
      res.json({ 
        success: true, 
        hubId, 
        machines,
        dateRange: {
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString()
        }
      });
    } catch (error) {
      console.error('Error loading discovered machines:', error);
      res.status(500).json({ error: 'Failed to load machines' });
    }
  }
);


// GET /api/admin/hubs/:hubId/events - Get recent events from this hub

router.get('/:hubId/events',
  authenticate,
  requirePermission([PERMISSIONS.VIEW_ALL_METRICS, PERMISSIONS.VIEW_STORE_METRICS]),
  async (req, res) => {
    try {
      const { hubId } = req.params;
      const limit = Math.min(parseInt(req.query.limit) || 50, 200);
      const skip = parseInt(req.query.skip) || 0;
      
      // Check hub exists and user has access
      const hub = await Hub.findOne({ hubId });
      if (!hub) {
        return res.status(404).json({ error: 'Hub not found' });
      }

      // Venue manager access check
      if (['venue_manager', 'venue_staff'].includes(req.user.role)) {
        if (!req.user.assignedVenues.includes(hub.storeId)) {
          return res.status(403).json({ error: 'Access denied to this hub' });
        }
      }

      const Event = require('../models/Event');
      
      // CRITICAL FIX: Use hubMachineId (not hubId)
      const events = await Event.find({ hubMachineId: hubId })
        .sort({ timestamp: -1 })
        .skip(skip)
        .limit(limit)
        .lean();

      const total = await Event.countDocuments({ hubMachineId: hubId });

      // Enrich events with machine names if registered
      const enrichedEvents = await Promise.all(events.map(async (event) => {
        const machine = await Machine.findOne({ machineId: event.gamingMachineId }).lean();
        return {
          ...event,
          machineName: machine?.name || event.gamingMachineId
        };
      }));

      console.log(`✅ Loaded ${events.length} events for hub ${hubId} (total: ${total})`);

      res.json({
        success: true,
        hubId,
        events: enrichedEvents,
        pagination: {
          total,
          limit,
          skip,
          hasMore: skip + events.length < total
        }
      });

    } catch (error) {
      console.error('❌ Failed to get hub events:', error);
      res.status(500).json({ 
        error: 'Failed to load events',
        details: error.message 
      });
    }
  }
);

// GET /api/admin/hubs/:hubId/logs - Get Pi system logs
router.get('/:hubId/logs',
  authenticate,
  requirePermission([PERMISSIONS.VIEW_ALL_METRICS, PERMISSIONS.VIEW_STORE_METRICS]),
  async (req, res) => {
    try {
      const { hubId } = req.params;
      const limit = Math.min(parseInt(req.query.limit) || 100, 500); // Max 500 logs
      const level = req.query.level; // Optional filter: 'error', 'warn', 'info', 'debug'
      
      // Check hub exists and user has access
      const hub = await Hub.findOne({ hubId });
      if (!hub) {
        return res.status(404).json({ error: 'Hub not found' });
      }

      // Venue manager access check
      if (['venue_manager', 'venue_staff'].includes(req.user.role)) {
        if (!req.user.assignedVenues.includes(hub.storeId)) {
          return res.status(403).json({ error: 'Access denied to this hub' });
        }
      }

      // For now, we'll generate synthetic logs based on hub health data
      // In production, Pi devices would send actual logs via POST endpoint
      const logs = [];
      
      // Add current health status as a log entry
      if (hub.health) {
        logs.push({
          timestamp: new Date(),
          level: 'info',
          message: `System Status: CPU ${hub.health.cpuUsage?.toFixed(1)}%, Memory ${hub.health.memoryUsage?.toFixed(1)}%, Disk ${hub.health.diskUsage?.toFixed(1)}%`,
          source: 'system',
          hubId
        });
      }

      // Add serial connection status
      if (hub.health) {
        logs.push({
          timestamp: new Date(),
          level: hub.health.serialConnected ? 'info' : 'error',
          message: hub.health.serialConnected 
            ? `Serial connection active on ${hub.serialConfig?.port || '/dev/ttyUSB0'}`
            : `Serial connection lost on ${hub.serialConfig?.port || '/dev/ttyUSB0'}`,
          source: 'serial',
          hubId
        });
      }

      // Add last error if exists
      if (hub.health?.lastError) {
        logs.push({
          timestamp: hub.health.lastErrorAt || new Date(),
          level: 'error',
          message: hub.health.lastError,
          source: 'error',
          hubId
        });
      }

      // Add online/offline status
      const isOnline = hub.lastHeartbeat && 
                      (new Date() - new Date(hub.lastHeartbeat)) < 2 * 60 * 1000;
      logs.push({
        timestamp: hub.lastHeartbeat || new Date(),
        level: isOnline ? 'info' : 'warn',
        message: isOnline 
          ? 'Hub is online and sending heartbeats'
          : `Hub offline - last heartbeat ${hub.lastHeartbeat ? new Date(hub.lastHeartbeat).toLocaleString() : 'never'}`,
        source: 'heartbeat',
        hubId
      });

      // Add configuration info
      if (hub.config?.debugMode) {
        logs.push({
          timestamp: new Date(),
          level: 'debug',
          message: 'Debug mode is enabled',
          source: 'config',
          hubId
        });
      }

      // Sort by timestamp descending
      logs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

      // Filter by level if specified
      const filteredLogs = level 
        ? logs.filter(log => log.level === level).slice(0, limit)
        : logs.slice(0, limit);

      console.log(`✅ Retrieved ${filteredLogs.length} logs for hub ${hubId}`);

      res.json({
        success: true,
        hubId,
        logs: filteredLogs,
        total: filteredLogs.length,
        note: 'These are system-generated logs. Real-time Pi logs require Pi software update to stream logs to backend.'
      });

    } catch (error) {
      console.error('❌ Failed to get hub logs:', error);
      res.status(500).json({ 
        error: 'Failed to load logs',
        details: error.message 
      });
    }
  }
);


router.post('/:hubId/register-machine',
  authenticate,
  requirePermission([PERMISSIONS.MANAGE_ALL_STORES, PERMISSIONS.MANAGE_ASSIGNED_STORES]),
  async (req, res) => {
    try {
      const { hubId } = req.params;
      const { machineId, name, location, gameType } = req.body;

      const hub = await Hub.findOne({ hubId });
      if (!hub) return res.status(404).json({ error: 'Hub not found' });

      if (['venue_manager', 'venue_staff'].includes(req.user.role)) {
        if (!req.user.assignedVenues.includes(hub.storeId)) {
          return res.status(403).json({ error: 'Access denied' });
        }
      }

      let machine = await Machine.findOne({ machineId });
      if (machine) {
        return res.json({ success: true, message: 'Already registered', machine, alreadyExists: true });
      }

      machine = await Machine.create({
        machineId,
        name: name || machineId,
        storeId: hub.storeId,
        hubId: hubId,
        location: location || '',
        gameType: gameType || 'slot',
        status: 'active',
        createdBy: req.user.email
      });

      res.json({ success: true, message: 'Registered', machine });
    } catch (error) {
      res.status(500).json({ error: 'Failed to register', details: error.message });
    }
  }
);


// BONUS: POST endpoint for Pi to send logs (for future Pi software update)
router.post('/:hubId/logs',
  authenticate,
  async (req, res) => {
    try {
      const { hubId } = req.params;
      const { logs } = req.body;

      // Verify this request is from the Pi (check machine token)
      if (req.user.type !== 'hub' || req.user.hubId !== hubId) {
        return res.status(403).json({ error: 'Unauthorized' });
      }

      // In production, you'd store these logs in a Log collection
      // For now, just acknowledge receipt
      console.log(`📝 Received ${logs?.length || 0} logs from hub ${hubId}`);

      res.json({
        success: true,
        message: `Received ${logs?.length || 0} logs`,
        timestamp: new Date()
      });

    } catch (error) {
      console.error('❌ Failed to receive logs:', error);
      res.status(500).json({ 
        error: 'Failed to process logs',
        details: error.message 
      });
    }
  }
);

// POST /api/admin/hubs/:hubId/register-discovered - Bulk register discovered machines
router.post('/:hubId/register-discovered',
  authenticate,
  requirePermission([PERMISSIONS.MANAGE_ALL_STORES, PERMISSIONS.MANAGE_ASSIGNED_STORES]),
  async (req, res) => {
    try {
      const { hubId } = req.params;
      const { machineIds, storeId } = req.body;

      console.log(`📝 Bulk registering ${machineIds?.length || 0} machines for hub: ${hubId}`);

      // Validate input
      if (!Array.isArray(machineIds) || machineIds.length === 0) {
        return res.status(400).json({ error: 'machineIds array is required' });
      }

      if (!storeId) {
        return res.status(400).json({ error: 'storeId is required' });
      }

      // Check hub exists
      const hub = await Hub.findOne({ hubId });
      if (!hub) {
        return res.status(404).json({ error: 'Hub not found' });
      }

      // Check store exists
      const store = await Store.findOne({ storeId });
      if (!store) {
        return res.status(404).json({ error: 'Store not found' });
      }

      // Venue manager access check
      if (['venue_manager', 'venue_staff'].includes(req.user.role)) {
        if (!req.user.assignedVenues.includes(hub.storeId)) {
          return res.status(403).json({ error: 'Access denied to this venue' });
        }
      }

      const results = {
        created: [],
        updated: [],
        errors: []
      };

      // Register each machine
      for (const machineId of machineIds) {
        try {
          const existing = await Machine.findOne({ machineId });
          
          if (existing) {
            // Update existing machine
            existing.hubId = hubId;
            existing.storeId = storeId;
            await existing.save();
            results.updated.push(machineId);
          } else {
            // Create new machine
            await Machine.create({
              machineId,
              storeId,
              hubId,
              name: `Machine ${machineId}`,
              status: 'active',
              gameType: 'slot'
            });
            results.created.push(machineId);
          }
        } catch (err) {
          results.errors.push({ machineId, error: err.message });
        }
      }

      console.log(`✅ Registration complete: ${results.created.length} created, ${results.updated.length} updated`);

      res.json({
        success: true,
        results
      });

    } catch (error) {
      console.error('❌ Failed to register machines:', error);
      res.status(500).json({ 
        error: 'Failed to register machines',
        details: error.message 
      });
    }
  }
);

router.post('/admin/hubs/cleanup-tokens',
  authenticate,
  requirePermission([PERMISSIONS.MANAGE_ALL_STORES]),
  async (req, res) => {
    try {
      const cleanedCount = await Hub.cleanupExpiredTokens();
      
      res.json({
        success: true,
        message: `Cleaned up ${cleanedCount} expired tokens`,
        cleanedCount
      });
    } catch (error) {
      console.error('Token cleanup error:', error);
      res.status(500).json({ 
        error: 'Failed to cleanup tokens',
        details: error.message 
      });
    }
  }
);

module.exports = router;