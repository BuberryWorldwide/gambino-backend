// src/routes/edge.js
const express = require('express');
const jwt = require('jsonwebtoken');
const Machine = require('../models/Machine');
const Store = require('../models/Store');
const EdgeSession = require('../models/EdgeSession');
const Session = require('../models/Session');
const CustWalletService = require('../services/CustWalletService');
const custWalletService = new CustWalletService();
const Event = require('../models/Event');
const Hub = require('../models/Hub');


const router = express.Router();

// Machine authentication middleware for Pi devices
const authenticateMachine = async (req, res, next) => {
  try {
    const authHeader = req.header('Authorization');
    const token = authHeader?.startsWith('Bearer ') ? 
      authHeader.slice(7) : null;

    if (!token) {
      return res.status(401).json({ error: 'Machine token required' });
    }

    // Verify machine JWT token
    const decoded = jwt.verify(token, process.env.MACHINE_JWT_SECRET || process.env.JWT_SECRET);
    
    // Support multiple token types: machine, edge_device, hub
    if (!['machine', 'edge_device', 'hub'].includes(decoded.type)) {
      return res.status(401).json({ error: 'Invalid machine token type' });
    }

    // Store raw token for Hub auto-registration
    req.token = token;

    // For edge devices and hubs, create virtual machine record
    if (decoded.type === 'edge_device' || decoded.type === 'hub') {
      console.log(`🔗 ${decoded.type} authenticated: ${decoded.machineId || decoded.hubId}`);
      
      req.machine = {
        machineId: decoded.machineId || decoded.hubId,
        storeId: decoded.storeId,
        dbId: null,
        type: decoded.type
      };
      
      next();
      return;
    }

    // For regular machines, verify they exist in database
    const machine = await Machine.findOne({ 
      machineId: decoded.machineId,
      storeId: decoded.storeId 
    });

    if (!machine) {
      return res.status(404).json({ error: 'Machine not found' });
    }

    if (machine.status !== 'active') {
      return res.status(403).json({ error: 'Machine not active' });
    }

    // Update machine last seen
    machine.lastSeen = new Date();
    machine.connectionStatus = 'connected';
    await machine.save();

    req.machine = {
      machineId: decoded.machineId,
      storeId: decoded.storeId,
      dbId: machine._id,
      type: decoded.type
    };

    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Invalid machine token' });
    }
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Machine token expired' });
    }
    console.error('Machine auth error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
};

// POST /api/edge/events - With idempotency and DailyReport processing
router.post('/events', authenticateMachine, async (req, res) => {
  try {
    const { 
      eventType,
      amount,
      timestamp,
      sessionId,
      rawData,
      metadata,
      machineId,
      idempotencyKey
    } = req.body;

    console.log(`📡 Edge event: ${eventType} from ${req.machine.machineId} - $${amount || 0}`);

    // Resolve gaming machine ID
    let gamingMachineId = null;
    let mappingStatus = 'unmapped';
    let machineName = 'Unknown Machine';
    
    if (machineId) {
      gamingMachineId = machineId;
      console.log(`🎯 Using provided gaming machine ID: ${gamingMachineId}`);
    } else if (rawData) {
      const machineMatch = rawData.match(/MACHINE\s+(\d+)/i);
      if (machineMatch) {
        const machineNumber = machineMatch[1].padStart(2, '0');
        gamingMachineId = `machine_${machineNumber}`;
        console.log(`🎯 Extracted gaming machine ID from raw data: ${gamingMachineId}`);
      }
    }
    
    if (!gamingMachineId) {
      console.warn(`⚠️ No gaming machine ID found for event from ${req.machine.machineId}`);
      gamingMachineId = `${req.machine.machineId}_unknown`;
    }

    // Check if gaming machine exists in database
    let gamingMachine = null;
    if (gamingMachineId && gamingMachineId !== `${req.machine.machineId}_unknown`) {
      gamingMachine = await Machine.findOne({ 
        machineId: gamingMachineId,
        storeId: req.machine.storeId 
      });
      
      if (gamingMachine) {
        mappingStatus = 'mapped';
        machineName = gamingMachine.name || gamingMachineId;
        console.log(`✅ Found gaming machine in database: ${machineName}`);
      } else {
        console.log(`⚠️ Gaming machine ${gamingMachineId} not found in database`);
        machineName = `Unmapped ${gamingMachineId}`;
      }
    }

    // Check for duplicate using idempotency key
    if (idempotencyKey) {
      const fullIdempotencyKey = `${req.machine.storeId}_${idempotencyKey}`;
      
      // ✅ CHANGED: Skip idempotency check for daily reports (they have timestamps now)
      const isDailyReport = metadata?.isDailyReport || metadata?.source === 'daily_report';
      
      if (!isDailyReport) {
        // Only check for duplicates on non-daily events
        const existingEvent = await Event.findOne({
          storeId: req.machine.storeId,
          idempotencyKey: fullIdempotencyKey
        });
      
        if (existingEvent) {
          console.log(`⚠️ Duplicate event detected (idempotency): ${fullIdempotencyKey}`);
          
          return res.json({
            success: true,
            duplicate: true,
            eventReceived: eventType,
            machineId: req.machine.machineId,
            gamingMachineId: gamingMachineId,
            finalMachineId: gamingMachineId,
            machineName: machineName,
            mappingStatus: mappingStatus,
            userBound: false,
            userId: null,
            timestamp: existingEvent.createdAt.toISOString()
          });
        }
      } else {
        console.log(`📊 Daily report event - allowing duplicate storage: ${fullIdempotencyKey}`);
      }
    }

    // Check for active user binding
    let activeBinding = null;
    let userId = null;
    let userSessionId = null;
    
    if (gamingMachineId) {
      activeBinding = await Session.findOne({ 
        machineId: gamingMachineId,
        status: 'active' 
      });
      
      if (activeBinding) {
        userId = activeBinding.userId;
        userSessionId = activeBinding.sessionId;
        console.log(`👤 Found active user binding: ${userId} on ${gamingMachineId}`);
      }
    }

    // Build event record
    const eventRecord = {
      eventType,
      hubMachineId: req.machine.machineId,
      gamingMachineId,
      amount: amount ? parseFloat(amount) : 0,
      storeId: req.machine.storeId,
      userId: userId || null,
      userSessionId: userSessionId || null,
      sessionId: sessionId || null,
      rawData: rawData || null,
      metadata: metadata || null,
      timestamp: timestamp ? new Date(timestamp) : new Date(),
      isUserBound: !!activeBinding,
      mappingStatus,
      idempotencyKey: idempotencyKey ? `${req.machine.storeId}_${idempotencyKey}` : null,
      createdAt: new Date()
    };

    // Save event
    const savedEvent = await Event.create(eventRecord);

    // Process daily summary into DailyReport (in background)
    // Process daily summary into DailyReport (in background)
if ((eventRecord.eventType === 'money_in' && eventRecord.metadata?.source === 'daily_report') || eventRecord.eventType === 'daily_summary') {  const DailyReportProcessor = require('../services/DailyReportProcessor');
  const processor = new DailyReportProcessor();
  
  setTimeout(async () => {
    try {
      await processor.processDailySummaryEvents(
        req.machine.storeId,
        req.machine.machineId,
        eventRecord.timestamp
      );
    } catch (error) {
      console.error('Failed to process daily report:', error);
    }
  }, 3000); // Wait 3 seconds for batch to complete
}

    console.log(`✅ Event processed: ${eventType} from ${gamingMachineId} (${mappingStatus}) ${userId ? 'attributed' : 'anonymous'}`);

    res.json({
      success: true,
      eventReceived: eventType,
      machineId: req.machine.machineId,
      gamingMachineId: gamingMachineId,
      finalMachineId: gamingMachineId,
      machineName: machineName,
      mappingStatus: mappingStatus,
      userBound: !!activeBinding,
      userId: userId || null,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    if (error.code === 11000) {
      console.log(`⚠️ Duplicate event caught by database constraint`);
      return res.json({
        success: true,
        duplicate: true,
        message: 'Event already processed'
      });
    }
    
    console.error('Edge event processing error:', error);
    res.status(500).json({ error: 'Failed to process event' });
  }
});

// POST /api/edge/sessions - Handle session lifecycle events
router.post('/sessions', authenticateMachine, async (req, res) => {
  try {
    const {
      action,
      sessionId,
      userId,
      timestamp,
      sessionData
    } = req.body;

    console.log(`🎮 Session ${action}: ${sessionId} on ${req.machine.machineId}`);

    if (!action || !sessionId || !timestamp) {
      return res.status(400).json({ 
        error: 'action, sessionId, and timestamp are required' 
      });
    }

    let session;

    switch (action) {
      case 'start':
        session = await EdgeSession.create({
          session_id: sessionId,
          machine_id: req.machine.machineId,
          user_id: userId || null,
          started_at: Math.floor(new Date(timestamp).getTime() / 1000),
          credit_in: 0,
          credit_out: 0,
          bets: 0,
          wins: 0
        });
        break;

      case 'end':
        session = await EdgeSession.findOneAndUpdate(
          { session_id: sessionId },
          {
            ended_at: Math.floor(new Date(timestamp).getTime() / 1000),
            ...sessionData
          },
          { new: true }
        );
        break;

      case 'update':
        session = await EdgeSession.findOneAndUpdate(
          { session_id: sessionId },
          { ...sessionData },
          { new: true }
        );
        break;

      default:
        return res.status(400).json({ error: 'Invalid action' });
    }

    res.json({ 
      success: true, 
      action,
      sessionId,
      machineId: req.machine.machineId,
      session: session || null
    });

  } catch (error) {
    console.error('Session processing error:', error);
    res.status(500).json({ error: 'Failed to process session' });
  }
});

// GET /api/edge/config - Get device configuration
router.get('/config', authenticateMachine, async (req, res) => {
  try {
    if (req.machine.type === 'edge_device') {
      const store = await Store.findOne({ storeId: req.machine.storeId });
      
      res.json({
        success: true,
        config: {
          machineId: req.machine.machineId,
          storeId: req.machine.storeId,
          storeName: store?.storeName || 'Unknown Store',
          reportingInterval: 30,
          enableDebug: false
        }
      });
      return;
    }

    const machine = await Machine.findById(req.machine.dbId);
    const store = await Store.findOne({ storeId: req.machine.storeId });

    res.json({
      success: true,
      config: {
        machineId: req.machine.machineId,
        storeId: req.machine.storeId,
        storeName: store?.storeName || 'Unknown Store',
        reportingInterval: machine?.settings?.reportingInterval || 30,
        enableDebug: machine?.settings?.enableDebug || false
      }
    });
  } catch (error) {
    console.error('Config retrieval error:', error);
    res.status(500).json({ error: 'Failed to get config' });
  }
});

// POST /api/edge/heartbeat - Pi health check with Hub support
router.post('/heartbeat', authenticateMachine, async (req, res) => {
  try {
    const { 
      piVersion,
      uptime,
      memoryUsage,
      diskUsage,
      cpuUsage,
      cpuTemp,
      serialConnected,
      lastDataReceived,
      machineCount,
      eventsProcessed,
      eventsSynced,
      eventsQueued,
      nodeVersion,
      osVersion,
      ipAddress,
      health,
      hardware,
      software,
      stats
    } = req.body;

    const { machineId, storeId, type } = req.machine;

    // Determine if this is a hub/Pi device (edge_device or hub-* machineId pattern)
    const isHub = type === 'edge_device' || 
                  type === 'hub' || 
                  machineId.startsWith('hub-') || 
                  machineId.includes('pi-');

    if (isHub) {
      // Handle Hub/Pi heartbeat
      console.log(`💓 Hub heartbeat: ${machineId}`);
      
      let hub = await Hub.findOne({ hubId: machineId });
      
      if (!hub) {
        // Auto-register hub on first heartbeat
        console.log(`✨ Auto-registering hub: ${machineId}`);
        hub = await Hub.create({
          hubId: machineId,
          name: machineId,
          storeId: storeId,
          status: 'online',
          createdBy: 'auto-registered'
        });
      }
      
      // Update hub with heartbeat data
      hub.lastHeartbeat = new Date();
      hub.lastSeen = new Date();
      hub.status = 'online';
      
      if (ipAddress) hub.ipAddress = ipAddress;
      
      // Update health metrics
      if (cpuUsage !== undefined) hub.health.cpuUsage = cpuUsage;
      if (memoryUsage !== undefined) {
        // Handle both percentage number and memory object
        hub.health.memoryUsage = typeof memoryUsage === 'number' ? memoryUsage : null;
      }
      if (diskUsage !== undefined) hub.health.diskUsage = diskUsage;
      if (serialConnected !== undefined) hub.health.serialConnected = serialConnected;
      hub.health.apiConnected = true; // They're sending heartbeat, so API is connected
      
      // Update hardware info
      if (cpuTemp) hub.hardware.cpuTemp = cpuTemp;
      if (hardware) {
        if (hardware.model) hub.hardware.model = hardware.model;
        if (hardware.memoryTotal) hub.hardware.memoryTotal = hardware.memoryTotal;
        if (hardware.diskTotal) hub.hardware.diskTotal = hardware.diskTotal;
        if (hardware.diskUsed) hub.hardware.diskUsed = hardware.diskUsed;
      }
      
      // Update software versions
      if (piVersion) hub.software.piAppVersion = piVersion;
      if (nodeVersion) hub.software.nodeVersion = nodeVersion;
      if (osVersion) hub.software.osVersion = osVersion;
      if (software) {
        if (software.piAppVersion) hub.software.piAppVersion = software.piAppVersion;
        if (software.nodeVersion) hub.software.nodeVersion = software.nodeVersion;
        if (software.osVersion) hub.software.osVersion = software.osVersion;
      }
      
      // Update stats
      if (machineCount !== undefined) hub.stats.totalMachinesConnected = machineCount;
      if (eventsProcessed) hub.stats.totalEventsProcessed = eventsProcessed;
      if (eventsSynced) hub.stats.totalEventsSynced = eventsSynced;
      if (eventsQueued) hub.stats.totalEventsQueued = eventsQueued;
      if (uptime) hub.stats.uptime = uptime;
      if (stats) {
        if (stats.totalMachinesConnected !== undefined) {
          hub.stats.totalMachinesConnected = stats.totalMachinesConnected;
        }
        if (stats.totalEventsProcessed) {
          hub.stats.totalEventsProcessed = stats.totalEventsProcessed;
        }
        if (stats.totalEventsSynced) {
          hub.stats.totalEventsSynced = stats.totalEventsSynced;
        }
        if (stats.totalEventsQueued) {
          hub.stats.totalEventsQueued = stats.totalEventsQueued;
        }
        if (stats.uptime) hub.stats.uptime = stats.uptime;
      }
      
      hub.updatedAt = new Date();
      await hub.save();
      
      res.json({ 
        success: true, 
        serverTime: new Date().toISOString(),
        hubStatus: 'healthy',
        message: 'Hub heartbeat received'
      });
      
    } else {
      // Handle individual machine heartbeat (original behavior)
      if (!req.machine.dbId) {
        return res.status(400).json({ 
          error: 'Machine database ID not found' 
        });
      }
      
      await Machine.findByIdAndUpdate(req.machine.dbId, {
        lastSeen: new Date(),
        connectionStatus: 'connected',
        piVersion,
        'healthData.uptime': uptime,
        'healthData.memoryUsage': memoryUsage,
        'healthData.serialConnected': serialConnected,
        'healthData.lastDataReceived': lastDataReceived
      });

      res.json({ 
        success: true, 
        serverTime: new Date().toISOString(),
        machineStatus: 'healthy'
      });
    }

  } catch (error) {
    console.error('❌ Heartbeat error:', error);
    res.status(500).json({ error: 'Heartbeat failed' });
  }
});

// POST /api/edge/refresh-token - Edge/Pi token renewal
router.post('/refresh-token', async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({ error: 'Missing refreshToken' });
    }

    // Verify and decode the refresh token
    const decoded = jwt.verify(
      refreshToken,
      process.env.MACHINE_JWT_SECRET || process.env.JWT_SECRET,
      {
        audience: 'gambino-edge',
        issuer: 'gambino-server'
      }
    );

    // Ensure it's a machine/edge/hub token
    if (!['machine', 'edge_device', 'hub'].includes(decoded.type)) {
      return res.status(401).json({ error: 'Invalid token type' });
    }

    const newAccessToken = jwt.sign(
      {
        machineId: decoded.machineId,
        hubId: decoded.hubId,
        storeId: decoded.storeId,
        type: decoded.type
      },
      process.env.MACHINE_JWT_SECRET || process.env.JWT_SECRET,
      {
        expiresIn: '15m',
        audience: 'gambino-edge',
        issuer: 'gambino-server'
      }
    );

    console.log(`🔁 Token refreshed for ${decoded.machineId || decoded.hubId}`);

    return res.json({
      success: true,
      accessToken: newAccessToken,
      expiresIn: 900
    });
  } catch (error) {
    console.error('❌ Refresh token error:', error);
    return res.status(401).json({ error: 'Invalid or expired refreshToken' });
  }
});


module.exports = router;
module.exports.authenticateMachine = authenticateMachine;