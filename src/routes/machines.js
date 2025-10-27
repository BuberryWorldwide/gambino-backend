// src/routes/machines.js
const { authenticateMachine } = require('./edge');
const express = require('express');
const jwt = require('jsonwebtoken');
const Machine = require('../models/Machine');
const Store = require('../models/Store');
const Session = require('../models/Session');
const Hub = require('../models/Hub');

// Import RBAC middleware
const { 
  authenticate, 
  requirePermission, 
  requireVenueAccess,
  createVenueMiddleware,
  PERMISSIONS 
} = require('../middleware/rbac');

const router = express.Router();
const QRCode = require('qrcode');

// Define legacy authentication middleware for backward compatibility
const authenticateToken = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
      return res.status(401).json({ error: 'Access token required' });
    }

    jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret', (err, decoded) => {
      if (err) {
        console.error('Token verification failed:', err.message);
        return res.status(403).json({ error: 'Invalid or expired token' });
      }

      req.user = {
        userId: decoded.userId,
        walletAddress: decoded.walletAddress,
        email: decoded.email,
        tier: decoded.tier,
        role: decoded.role || 'user' 
      };

      return next();
    });
  } catch (error) {
    console.error('Auth middleware error:', error);
    return res.status(401).json({ error: 'Authentication failed' });
  }
};

// ===== PUBLIC ENDPOINTS (NO AUTH REQUIRED) =====

// POST /api/machines/validate-binding - Validate binding token and return machine info
router.post('/validate-binding', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ error: 'Token required' });
    }

    // Decode and validate the binding token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.type !== 'binding') {
      return res.status(401).json({ error: 'Invalid binding token' });
    }

    // Find the machine
    const machine = await Machine.findOne({ 
      machineId: decoded.machineId, 
      storeId: decoded.storeId 
    });

    if (!machine) {
      return res.status(404).json({ error: 'Machine not found' });
    }

    // Get store info
    const store = await Store.findOne({ storeId: machine.storeId });

    res.json({
      success: true,
      machine: {
        machineId: machine.machineId,
        name: machine.name,
        location: machine.location,
        gameType: machine.gameType,
        status: machine.status,
        storeId: machine.storeId,
        storeName: store?.storeName || 'Unknown Store'
      }
    });
  } catch (error) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    console.error('Token validation error:', error);
    res.status(500).json({ error: 'Failed to validate token' });
  }
});

// POST /api/machines/bulk-import - Import detected machines from a hub
router.post('/bulk-import',
  authenticate,
  requirePermission([PERMISSIONS.MANAGE_ASSIGNED_STORES, PERMISSIONS.MANAGE_ALL_STORES]),
  async (req, res) => {
    try {
      const { hubId, storeId, machines } = req.body;
      
      console.log(`📥 Bulk import: ${machines?.length} machines from hub ${hubId}`);
      
      if (!hubId || !storeId || !Array.isArray(machines) || machines.length === 0) {
        return res.status(400).json({ 
          error: 'Invalid request',
          message: 'Required: hubId, storeId, and machines array'
        });
      }
      
      // Verify hub exists
      const hub = await Hub.findOne({ hubId });
      if (!hub) {
        return res.status(404).json({ error: 'Hub not found' });
      }
      
      // Verify hub belongs to store
      if (hub.storeId !== storeId) {
        return res.status(400).json({ 
          error: 'Hub/Store mismatch',
          message: `Hub ${hubId} belongs to store ${hub.storeId}, not ${storeId}`
        });
      }
      
      // Check store access
      const userRole = req.user.role;
      if (['venue_manager', 'venue_staff'].includes(userRole)) {
        if (!req.user.assignedVenues.includes(storeId)) {
          return res.status(403).json({ error: 'Access denied to this store' });
        }
      }
      
      const results = {
        created: [],
        skipped: [],
        errors: []
      };
      
      // Process each machine
      for (const machineData of machines) {
        try {
          const { machineId, name, location, gameType } = machineData;
          
          // Validate machine is in hub's detected list
          const detectedMachine = hub.detectedMachines.find(m => m.machineId === machineId);
          if (!detectedMachine) {
            results.errors.push({
              machineId,
              error: 'Machine not detected by this hub'
            });
            continue;
          }
          
          // Check if already imported
          if (detectedMachine.imported) {
            results.skipped.push({
              machineId,
              reason: 'Already imported',
              mongoId: detectedMachine.mongoId
            });
            continue;
          }
          
          // Check if machine already exists
          const existing = await Machine.findOne({ machineId, storeId });
          if (existing) {
            results.skipped.push({
              machineId,
              reason: 'Machine already exists',
              mongoId: existing._id
            });
            
            // Mark as imported in hub
            await hub.markMachineAsImported(machineId, existing._id);
            continue;
          }
          
          // Generate QR code
          const bindingToken = jwt.sign(
            { 
              machineId,
              storeId,
              hubId,
              type: 'binding',
              iat: Math.floor(Date.now() / 1000)
            },
            process.env.JWT_SECRET,
            { expiresIn: '5y' }
          );
          
          const bindUrl = `${process.env.FRONTEND_URL || 'https://app.gambino.gold'}/machine/bind?token=${bindingToken}`;
          const qrCode = await QRCode.toDataURL(bindUrl);
          
          // Generate serial number
          const serialNumber = `SN-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
          
          // Create machine
          const newMachine = await Machine.create({
            machineId,
            storeId,
            hubId, // Link to hub
            name: name || `Machine ${machineId}`,
            location: location || '',
            gameType: gameType || 'slot',
            status: 'active',
            serialNumber,
            qrCode,
            qrToken: bindingToken,
            qrGeneratedAt: new Date(),
            connectionStatus: 'connected',
            lastSeen: detectedMachine.lastSeen,
            createdBy: req.user?.email || 'admin'
          });
          
          // Mark as imported in hub
          await hub.markMachineAsImported(machineId, newMachine._id);
          
          results.created.push({
            machineId,
            mongoId: newMachine._id,
            name: newMachine.name,
            qrGenerated: true
          });
          
          console.log(`✅ Created machine ${machineId} from hub ${hubId}`);
          
        } catch (error) {
          console.error(`Error importing machine ${machineData?.machineId}:`, error);
          results.errors.push({
            machineId: machineData?.machineId,
            error: error.message
          });
        }
      }
      
      // Update hub stats
      await hub.save();
      
      console.log(`📊 Bulk import: ${results.created.length} created, ${results.skipped.length} skipped, ${results.errors.length} errors`);
      
      res.json({
        success: true,
        message: `Imported ${results.created.length} machines successfully`,
        results: {
          created: results.created.length,
          skipped: results.skipped.length,
          errors: results.errors.length,
          details: results
        }
      });
      
    } catch (error) {
      console.error('❌ Bulk import error:', error);
      res.status(500).json({ 
        error: 'Bulk import failed',
        message: error.message 
      });
    }
  }
);

// GET /api/machines/by-hub/:hubId - Get all machines for a hub
router.get('/by-hub/:hubId',
  authenticate,
  requirePermission([PERMISSIONS.MANAGE_ASSIGNED_STORES, PERMISSIONS.MANAGE_ALL_STORES]),
  async (req, res) => {
    try {
      const { hubId } = req.params;
      
      const hub = await Hub.findOne({ hubId });
      if (!hub) {
        return res.status(404).json({ error: 'Hub not found' });
      }
      
      // Check store access
      const userRole = req.user.role;
      if (['venue_manager', 'venue_staff'].includes(userRole)) {
        if (!req.user.assignedVenues.includes(hub.storeId)) {
          return res.status(403).json({ error: 'Access denied' });
        }
      }
      
      // Get all machines linked to this hub
      const machines = await Machine.find({ hubId })
        .sort({ createdAt: -1 })
        .lean();
      
      const stats = {
        total: machines.length,
        active: machines.filter(m => m.status === 'active').length,
        inactive: machines.filter(m => m.status === 'inactive').length,
        maintenance: machines.filter(m => m.status === 'maintenance').length
      };
      
      res.json({
        success: true,
        hub: {
          hubId: hub.hubId,
          hubName: hub.hubName,
          storeId: hub.storeId
        },
        machines,
        stats
      });
      
    } catch (error) {
      console.error('Error fetching hub machines:', error);
      res.status(500).json({ error: 'Failed to load hub machines' });
    }
  }
);

// ===== USER AUTHENTICATED ENDPOINTS =====

// POST /api/machines/bind - Bind user to machine
router.post('/bind', authenticateToken, async (req, res) => {
  try {
    const { token, machineId, storeId } = req.body;
    
    console.log(`🔍 Binding attempt: User ${req.user.userId} to machine ${machineId}`);
    
    // Validate the binding token again
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.type !== 'binding' || decoded.machineId !== machineId) {
      return res.status(400).json({ error: 'Invalid binding token' });
    }

    const machine = await Machine.findOne({ machineId, storeId });
    if (!machine) {
      return res.status(404).json({ error: 'Machine not found' });
    }

    if (machine.status !== 'active') {
      return res.status(400).json({ error: 'Machine is not active' });
    }

    // Check if user already has an active session
    const existingUserSession = await Session.findOne({ 
      userId: req.user.userId, 
      status: 'active' 
    });

    if (existingUserSession) {
      console.log(`⚠️ User ${req.user.userId} already has active session: ${existingUserSession.sessionId}`);
      return res.status(409).json({ 
        error: 'You already have an active session. End your current session first.',
        currentSession: {
          sessionId: existingUserSession.sessionId,
          machineId: existingUserSession.machineId,
          storeId: existingUserSession.storeId
        }
      });
    }

    // Check if machine already has an active session
    const existingMachineSession = await Session.findOne({ 
      machineId, 
      status: 'active' 
    });

    if (existingMachineSession) {
      console.log(`⚠️ Machine ${machineId} already has active session: ${existingMachineSession.sessionId}`);
      return res.status(409).json({ 
        error: 'Machine is currently in use by another player',
        session: {
          sessionId: existingMachineSession.sessionId,
          machineId: existingMachineSession.machineId,
          estimatedWaitTime: '5-15 minutes'
        }
      });
    }

    // Get store info for session
    const store = await Store.findOne({ storeId });

    // Create new session with auto-generated sessionId (from model default)
    const newSession = await Session.create({
      // sessionId will be auto-generated by the model
      userId: req.user.userId,
      machineId,
      storeId,
      status: 'active',
      machineName: machine.name || machine.machineId,
      storeName: store?.storeName || 'Unknown Store',
      location: machine.location || '',
      clientIP: req.ip || req.connection?.remoteAddress || 'unknown',
      userAgent: req.headers['user-agent'] || 'unknown'
    });

    // Update machine's last activity
    machine.lastSeen = new Date();
    machine.connectionStatus = 'connected';
    await machine.save();

    console.log(`✅ User ${req.user.userId} bound to machine ${machineId}`);
    console.log(`📝 Session created: ${newSession.sessionId} (DB ID: ${newSession._id})`);

    res.json({
      success: true,
      message: `Successfully bound to ${machine.name || machineId}`,
      session: {
        sessionId: newSession.sessionId, // Use the actual sessionId field
        dbId: newSession._id, // Also include DB ID for reference
        machineId: machine.machineId,
        machineName: machine.name || machine.machineId,
        storeId: machine.storeId,
        storeName: store?.storeName || 'Unknown Store',
        location: machine.location,
        startedAt: newSession.startedAt,
        status: newSession.status
      }
    });

  } catch (error) {
    console.error('❌ Machine binding error:', error);
    res.status(500).json({ error: 'Failed to bind to machine' });
  }
});

// ===== ADMIN AUTHENTICATED ENDPOINTS (RBAC MIGRATED) =====

// GET /api/machines/by-machine-id/:machineId/qr-code - Generate QR by machineId (not MongoDB _id)
router.get('/by-machine-id/:machineId/qr-code',
  authenticate,
  requirePermission([PERMISSIONS.MANAGE_ASSIGNED_STORES, PERMISSIONS.MANAGE_ALL_STORES]),
  async (req, res) => {
    try {
      const { machineId } = req.params;
      
      console.log(`🔍 QR code request for machineId: ${machineId}`);
      
      // Find machine by machineId (not MongoDB _id)
      let machine = await Machine.findOne({ machineId });
      
      // If machine doesn't exist, we need to create it first
      if (!machine) {
        console.log(`⚠️  Machine ${machineId} not found in database - cannot generate QR without storeId`);
        return res.status(404).json({ 
          error: 'Machine not registered',
          message: 'Please register this machine first before generating a QR code',
          machineId 
        });
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

      // If QR already exists, return it
      if (machine.qrCode && machine.qrToken) {
        console.log(`✅ Returning existing QR code for ${machineId}`);
        return res.json({
          success: true,
          qrCode: machine.qrCode,
          bindUrl: `${process.env.FRONTEND_URL || 'https://app.gambino.gold'}/machine/bind?token=${machine.qrToken}`,
          machineId: machine.machineId,
          instructions: [
            'Print and attach QR code to machine',
            'Users scan to bind account to machine',
            'One user per machine at a time'
          ],
          generated: machine.qrGeneratedAt
        });
      }

      // Generate new QR code
      console.log(`🔄 Generating new QR code for ${machineId}`);
      
      const bindingToken = jwt.sign(
        { 
          machineId: machine.machineId,
          storeId: machine.storeId,
          type: 'binding',
          iat: Math.floor(Date.now() / 1000)
        },
        process.env.JWT_SECRET,
        { expiresIn: '5y' }
      );

      const bindUrl = `${process.env.FRONTEND_URL || 'https://app.gambino.gold'}/machine/bind?token=${bindingToken}`;
      const qrCode = await QRCode.toDataURL(bindUrl);

      // Store in database
      machine.qrCode = qrCode;
      machine.qrToken = bindingToken;
      machine.qrGeneratedAt = new Date();
      await machine.save();

      console.log(`✅ QR code generated and saved for ${machineId}`);

      res.json({
        success: true,
        qrCode,
        bindUrl,
        machineId: machine.machineId,
        instructions: [
          'Print and attach QR code to machine',
          'Users scan to bind account to machine',
          'One user per machine at a time'
        ],
        generated: machine.qrGeneratedAt
      });
    } catch (error) {
      console.error('❌ QR code generation error:', error);
      res.status(500).json({ 
        error: 'Failed to generate QR code',
        details: error.message 
      });
    }
  }
);

// POST /api/machines/by-machine-id/:machineId/regenerate-qr - Force regenerate QR by machineId
router.post('/by-machine-id/:machineId/regenerate-qr',
  authenticate,
  requirePermission([PERMISSIONS.MANAGE_ASSIGNED_STORES, PERMISSIONS.MANAGE_ALL_STORES]),
  async (req, res) => {
    try {
      const { machineId } = req.params;
      
      const machine = await Machine.findOne({ machineId });
      if (!machine) {
        return res.status(404).json({ 
          error: 'Machine not found',
          machineId 
        });
      }

      // Check venue access
      const userRole = req.user.role;
      if (['venue_manager', 'venue_staff'].includes(userRole)) {
        if (!req.user.assignedVenues.includes(machine.storeId)) {
          return res.status(403).json({ 
            error: 'Access denied to this venue\'s machines',
            storeId: machine.storeId 
          });
        }
      }

      // Generate new token and QR code
      const bindingToken = jwt.sign(
        { 
          machineId: machine.machineId,
          storeId: machine.storeId,
          type: 'binding',
          iat: Math.floor(Date.now() / 1000)
        },
        process.env.JWT_SECRET,
        { expiresIn: '5y' }
      );

      const bindUrl = `${process.env.FRONTEND_URL || 'https://app.gambino.gold'}/machine/bind?token=${bindingToken}`;
      const qrCode = await QRCode.toDataURL(bindUrl);

      // Update in database
      machine.qrCode = qrCode;
      machine.qrToken = bindingToken;
      machine.qrGeneratedAt = new Date();
      await machine.save();

      console.log(`✅ QR code regenerated for ${machineId}`);

      res.json({
        success: true,
        qrCode,
        bindUrl,
        machineId: machine.machineId,
        message: 'QR code regenerated successfully',
        generated: machine.qrGeneratedAt
      });
    } catch (error) {
      console.error('❌ QR regeneration error:', error);
      res.status(500).json({ 
        error: 'Failed to regenerate QR code',
        details: error.message 
      });
    }
  }
);

// GET /api/machines/:id/qr-code - Generate QR code for machine binding
router.get('/:id/qr-code', 
  authenticate,
  requirePermission([PERMISSIONS.MANAGE_ASSIGNED_STORES, PERMISSIONS.MANAGE_ALL_STORES]),
  async (req, res) => {
    try {
      const machine = await Machine.findById(req.params.id);
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

      // If QR already exists, return it
      if (machine.qrCode && machine.qrToken) {
        return res.json({
          success: true,
          qrCode: machine.qrCode,
          bindUrl: `${process.env.FRONTEND_URL || 'https://app.gambino.gold'}/machine/bind?token=${machine.qrToken}`,
          machineId: machine.machineId,
          instructions: [
            'Print and attach QR code to machine',
            'Users scan to bind account to machine',
            'One user per machine at a time'
          ],
          generated: machine.qrGeneratedAt
        });
      }

      // Generate new QR code only if none exists
      const bindingToken = jwt.sign(
        { 
          machineId: machine.machineId,
          storeId: machine.storeId,
          type: 'binding',
          iat: Math.floor(Date.now() / 1000)
        },
        process.env.JWT_SECRET,
        { expiresIn: '5y' } // Long-lived
      );

      const bindUrl = `${process.env.FRONTEND_URL}/machine/bind?token=${bindingToken}`;
      const qrCode = await QRCode.toDataURL(bindUrl);

      // Store in database
      machine.qrCode = qrCode;
      machine.qrToken = bindingToken;
      machine.qrGeneratedAt = new Date();
      await machine.save();

      res.json({
        success: true,
        qrCode,
        bindUrl,
        machineId: machine.machineId,
        instructions: [
          'Print and attach QR code to machine',
          'Users scan to bind account to machine',
          'One user per machine at a time'
        ],
        generated: machine.qrGeneratedAt
      });
    } catch (e) {
      console.error('QR code generation error:', e);
      res.status(500).json({ error: 'Failed to generate QR code' });
    }
  }
);

// GET /api/machines/stores/:storeId - Get machines for a specific store (RBAC Fixed)
router.get('/stores/:storeId', 
  ...createVenueMiddleware({ action: 'view_store_machines' }),
  async (req, res) => {
    try {
      const { storeId } = req.params;
      const store = req.store; // Already loaded by venue middleware

      const machines = await Machine.find({ storeId })
        .sort({ createdAt: -1 })
        .lean();

      const stats = {
        total: machines.length,
        active: machines.filter(m => m.status === 'active').length,
        inactive: machines.filter(m => m.status === 'inactive').length,
        maintenance: machines.filter(m => m.status === 'maintenance').length
      };

      console.log(`📊 Loaded ${machines.length} machines for store ${storeId}`);

      res.json({ 
        success: true, 
        store: {
          storeId: store.storeId,
          storeName: store.storeName,
          city: store.city,
          state: store.state
        },
        machines, 
        stats 
      });
    } catch (e) {
      console.error('store machines error:', e);
      res.status(500).json({ error: 'Failed to load store machines' });
    }
  }
);

// POST /api/machines/:id/regenerate-qr - Force regenerate QR code
router.post('/:id/regenerate-qr', 
  authenticate,
  requirePermission([PERMISSIONS.MANAGE_ASSIGNED_STORES, PERMISSIONS.MANAGE_ALL_STORES]),
  async (req, res) => {
    try {
      const machine = await Machine.findById(req.params.id);
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

      // Generate new token and QR code
      const bindingToken = jwt.sign(
        { 
          machineId: machine.machineId,
          storeId: machine.storeId,
          type: 'binding',
          iat: Math.floor(Date.now() / 1000)
        },
        process.env.JWT_SECRET,
        { expiresIn: '5y' }
      );

      const bindUrl = `${process.env.FRONTEND_URL || 'https://app.gambino.gold'}/machine/bind?token=${bindingToken}`;
      const qrCode = await QRCode.toDataURL(bindUrl);

      // Update in database
      machine.qrCode = qrCode;
      machine.qrToken = bindingToken;
      machine.qrGeneratedAt = new Date();
      await machine.save();

      console.log(`✅ QR code regenerated for machine ${machine.machineId}`);

      res.json({
        success: true,
        qrCode,
        bindUrl,
        machineId: machine.machineId,
        message: 'QR code regenerated successfully',
        generated: machine.qrGeneratedAt
      });
    } catch (e) {
      console.error('QR regeneration error:', e);
      res.status(500).json({ error: 'Failed to regenerate QR code' });
    }
  }
);

// POST /api/machines/stores/:storeId - Add machine to specific store
router.post('/stores/:storeId', 
  ...createVenueMiddleware({ requireManagement: true, action: 'add_machine_to_store' }),
  async (req, res) => {
    try {
      const { storeId } = req.params;
      const store = req.store;
      const { machineId, name, location, gameType } = req.body; // Remove serialNumber from here

      if (!machineId) {
        return res.status(400).json({ error: 'machineId is required' });
      }

      const existing = await Machine.findOne({ machineId });
      if (existing) {
        return res.status(409).json({ 
          error: 'Machine ID already exists',
          existingStore: existing.storeId 
        });
      }

      // GENERATE SERIAL NUMBER RIGHT HERE
      const serialNumber = `SN-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

      const machine = await Machine.create({
        machineId,
        storeId,
        name: name || `Machine ${machineId}`,
        location: location || '',
        gameType: gameType || 'slot',
        serialNumber: serialNumber,  // USE THE GENERATED ONE
        status: 'active'
      });

      console.log(`✅ Machine ${machineId} added with serial ${serialNumber}`);

      res.status(201).json({ 
        success: true, 
        message: `Machine ${machineId} added to ${store.storeName}`,
        machine 
      });
    } catch (e) {
      console.error('add machine error:', e);
      res.status(500).json({ error: 'Failed to add machine' });
    }
  }
);

// PUT /api/machines/:id - Update machine
router.put('/:id', 
  authenticate,
  requirePermission([PERMISSIONS.MANAGE_ASSIGNED_STORES, PERMISSIONS.MANAGE_ALL_STORES]),
  async (req, res) => {
    try {
      const machine = await Machine.findById(req.params.id);
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

      const patch = {};
      if (req.body.status) patch.status = req.body.status;
      if (req.body.storeId) patch.storeId = req.body.storeId;
      if (req.body.name) patch.name = req.body.name;
      if (req.body.location) patch.location = req.body.location;
      patch.updatedAt = new Date();

      const m = await Machine.findByIdAndUpdate(req.params.id, patch, { new: true });
      
      res.json({ success: true, machine: m });
    } catch (e) {
      console.error('machine update error:', e);
      res.status(500).json({ error: 'Failed to update machine' });
    }
  }
);

// DELETE /api/machines/:id - Remove machine
router.delete('/:id', 
  authenticate,
  requirePermission([PERMISSIONS.MANAGE_ASSIGNED_STORES, PERMISSIONS.MANAGE_ALL_STORES]),
  async (req, res) => {
    try {
      const machine = await Machine.findById(req.params.id);
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

      await Machine.findByIdAndDelete(req.params.id);

      console.log(`✅ Machine ${machine.machineId} deleted from store ${machine.storeId}`);

      res.json({ 
        success: true, 
        message: `Machine ${machine.machineId} deleted`,
        machineId: machine.machineId 
      });
    } catch (e) {
      console.error('delete machine error:', e);
      res.status(500).json({ error: 'Failed to delete machine' });
    }
  }
);

// PUT /api/machines/:id/status - Change machine status
router.put('/:id/status', 
  authenticate,
  requirePermission([PERMISSIONS.MANAGE_ASSIGNED_STORES, PERMISSIONS.MANAGE_ALL_STORES]),
  async (req, res) => {
    try {
      const { status, reason } = req.body;

      if (!['active', 'inactive', 'maintenance'].includes(status)) {
        return res.status(400).json({ 
          error: 'Invalid status. Must be: active, inactive, or maintenance' 
        });
      }

      const machine = await Machine.findById(req.params.id);
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

      const oldStatus = machine.status;
      machine.status = status;
      machine.updatedAt = new Date();
      
      if (!machine.statusHistory) machine.statusHistory = [];
      machine.statusHistory.push({
        from: oldStatus,
        to: status,
        reason: reason || 'Manual change',
        timestamp: new Date(),
        changedBy: req.user?.email || 'admin'
      });

      await machine.save();

      console.log(`✅ Machine ${machine.machineId} status: ${oldStatus} → ${status}`);

      res.json({
        success: true,
        message: `Machine ${machine.machineId} status updated`,
        machine: {
          machineId: machine.machineId,
          storeId: machine.storeId,
          oldStatus,
          newStatus: status
        }
      });
    } catch (e) {
      console.error('machine status update error:', e);
      res.status(500).json({ error: 'Failed to update machine status' });
    }
  }
);

// GET /api/machines/summary - System-wide machine summary
router.get('/summary', 
  authenticate,
  requirePermission([PERMISSIONS.VIEW_ALL_METRICS, PERMISSIONS.VIEW_STORE_METRICS]),
  async (req, res) => {
    try {
      // For venue managers/staff, filter by assigned venues
      const userRole = req.user.role;
      let matchCondition = {};
      
      if (['venue_manager', 'venue_staff'].includes(userRole)) {
        matchCondition = { storeId: { $in: req.user.assignedVenues } };
      }

      const totalMachines = await Machine.countDocuments(matchCondition);
      const activeMachines = await Machine.countDocuments({ ...matchCondition, status: 'active' });
      const inactiveMachines = await Machine.countDocuments({ ...matchCondition, status: 'inactive' });
      const maintenanceMachines = await Machine.countDocuments({ ...matchCondition, status: 'maintenance' });

      const machinesByStore = await Machine.aggregate([
        { $match: matchCondition },
        {
          $group: {
            _id: '$storeId',
            count: { $sum: 1 },
            active: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } }
          }
        },
        { $sort: { count: -1 } },
        { $limit: 10 }
      ]);

      const storeIds = machinesByStore.map(s => s._id);
      const stores = await Store.find({ storeId: { $in: storeIds } })
        .select('storeId storeName city state')
        .lean();

      const storeMap = {};
      stores.forEach(store => {
        storeMap[store.storeId] = store;
      });

      const topStores = machinesByStore.map(item => ({
        storeId: item._id,
        storeName: storeMap[item._id]?.storeName || 'Unknown Store',
        location: storeMap[item._id] ? `${storeMap[item._id].city}, ${storeMap[item._id].state}` : 'Unknown',
        machineCount: item.count,
        active: item.active
      }));

      res.json({
        success: true,
        summary: {
          totalMachines,
          activeMachines,
          inactiveMachines,
          maintenanceMachines,
          topStores,
          healthScore: totalMachines > 0 ? Math.round((activeMachines / totalMachines) * 100) : 0,
          scope: ['venue_manager', 'venue_staff'].includes(userRole) ? 'assigned_venues' : 'all_venues'
        }
      });
    } catch (e) {
      console.error('machines summary error:', e);
      res.status(500).json({ error: 'Failed to load machines summary' });
    }
  }
);

// POST /api/machines/:machineId/generate-token
router.post('/:machineId/generate-token', authenticate, async (req, res) => {
  try {
    const { machineId } = req.params;
    
    // Get machine from database
    const machine = await Machine.findOne({ machineId });
    if (!machine) {
      return res.status(404).json({ error: 'Machine not found' });
    }
    
    // Generate a JWT token for THIS SPECIFIC machine
    const token = jwt.sign(
      { 
        machineId: machine.machineId,
        storeId: machine.storeId,
        type: 'edge_device'
      },
      process.env.JWT_SECRET,  // Uses the backend's JWT_SECRET to sign
      { expiresIn: '365d' }
    );
    
    // Optionally store token generation time (not the token itself)
    machine.lastTokenGenerated = new Date();
    await machine.save();
    
    res.json({ 
      success: true, 
      token,  // This token goes to the Pi
      machineId: machine.machineId,
      instruction: 'Add this token to the Pi .env file as MACHINE_TOKEN'
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to generate token' });
  }
});

// POST /api/machines/:machineId/generate-serial
router.post('/:machineId/generate-serial', authenticate, async (req, res) => {
  try {
    const { machineId } = req.params;
    
    // Generate unique serial number
    const timestamp = Date.now();
    const random = Math.random().toString(36).substr(2, 6).toUpperCase();
    const serial = `GG-${timestamp}-${random}`;
    
    // Find and update machine by machineId (not _id)
    const machine = await Machine.findOneAndUpdate(
      { machineId: machineId },
      { 
        serialNumber: serial,
        serialGeneratedAt: new Date()
      },
      { new: true }
    );
    
    if (!machine) {
      return res.status(404).json({ error: 'Machine not found' });
    }

    console.log(`Generated serial ${serial} for machine ${machineId}`);
    
    res.json({ 
      success: true, 
      serialNumber: serial,
      machine
    });
  } catch (error) {
    console.error('Serial generation error:', error);
    res.status(500).json({ error: 'Failed to generate serial' });
  }
});

// Add these routes to your existing machines.js file

// GET /api/machines/stores/:storeId/mutha-mappings
router.get('/stores/:storeId/mutha-mappings', 
  authenticate,
  requirePermission([PERMISSIONS.MANAGE_ASSIGNED_STORES, PERMISSIONS.MANAGE_ALL_STORES]),
  async (req, res) => {
    try {
      const { storeId } = req.params;
      
      // Get all machines for this store
      const machines = await Machine.find({ storeId }).lean();
      
      // Get mapping statistics
      const mappingStats = {
        totalMachines: machines.length,
        mapped: machines.filter(m => m.mappingStatus === 'mapped').length,
        unmapped: machines.filter(m => m.mappingStatus === 'unmapped').length,
        conflicts: machines.filter(m => m.mappingStatus === 'conflict').length
      };
      
      // Available Mutha Goose numbers (1-99 minus those already used)
      const usedNumbers = machines
        .filter(m => m.muthaGooseNumber)
        .map(m => m.muthaGooseNumber);
      const availableNumbers = Array.from({length: 99}, (_, i) => i + 1)
        .filter(id => !usedNumbers.includes(id));
      
      res.json({
        success: true,
        machines,
        mappingStats,
        availableNumbers
      });
      
    } catch (error) {
      console.error('mutha mappings error:', error);
      res.status(500).json({ error: 'Failed to load Mutha Goose mappings' });
    }
  }
);

// POST /api/machines/:machineId/assign-mutha
router.post('/:machineId/assign-mutha', 
  authenticate,
  requirePermission([PERMISSIONS.MANAGE_ASSIGNED_STORES, PERMISSIONS.MANAGE_ALL_STORES]),
  async (req, res) => {
    try {
      const { machineId } = req.params;
      const { muthaGooseNumber, hubMachineId } = req.body;
      
      // Validate Mutha Goose number
      if (!muthaGooseNumber || muthaGooseNumber < 1 || muthaGooseNumber > 99) {
        return res.status(400).json({ error: 'Mutha Goose number must be between 1 and 99' });
      }
      
      // Find the machine
      const machine = await Machine.findOne({ machineId });
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
      
      // Check if number is already used in this hub
      const existingMapping = await Machine.findOne({ 
        storeId: machine.storeId,
        hubMachineId,
        muthaGooseNumber,
        _id: { $ne: machine._id }
      });
      
      if (existingMapping) {
        return res.status(409).json({ 
          error: `Mutha Goose ${muthaGooseNumber} already assigned to ${existingMapping.machineId}`,
          conflictMachine: existingMapping
        });
      }
      
      // Use the model's built-in mapping method
      await machine.mapToMuthaGoose(muthaGooseNumber, hubMachineId, req.user?.email || 'admin');
      
      console.log(`✅ Mutha Goose mapping: ${machineId} → MG${muthaGooseNumber} on ${hubMachineId}`);
      
      res.json({
        success: true,
        message: `Mutha Goose ${muthaGooseNumber} assigned to ${machineId}`,
        machine: {
          machineId: machine.machineId,
          muthaGooseNumber: machine.muthaGooseNumber,
          muthaGooseId: machine.muthaGooseId,
          mappingStatus: machine.mappingStatus,
          hubMachineId: machine.hubMachineId
        }
      });
      
    } catch (error) {
      console.error('assign mutha error:', error);
      res.status(500).json({ error: 'Failed to assign Mutha Goose number' });
    }
  }
);

// DELETE /api/machines/:machineId/mutha-mapping
router.delete('/:machineId/mutha-mapping', 
  authenticate,
  requirePermission([PERMISSIONS.MANAGE_ASSIGNED_STORES, PERMISSIONS.MANAGE_ALL_STORES]),
  async (req, res) => {
    try {
      const { machineId } = req.params;
      
      const machine = await Machine.findOne({ machineId });
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
      
      const oldNumber = machine.muthaGooseNumber;
      
      // Use the model's built-in unmapping method
      await machine.unmapFromMuthaGoose(req.user?.email || 'admin');
      
      console.log(`🗑️ Mutha Goose unmapped: ${machineId} from MG${oldNumber}`);
      
      res.json({
        success: true,
        message: `Mutha Goose ${oldNumber} removed from ${machineId}`,
        machine: {
          machineId: machine.machineId,
          muthaGooseNumber: null,
          mappingStatus: machine.mappingStatus
        }
      });
      
    } catch (error) {
      console.error('remove mutha mapping error:', error);
      res.status(500).json({ error: 'Failed to remove mapping' });
    }
  }
);

// POST /api/machines/sync-from-pi
// Pi uploads its current mappings to sync with dashboard
router.post('/sync-from-pi', authenticateMachine, async (req, res) => {
  try {
    const { mappings } = req.body;
    // mappings = { "1": "machine_01", "3": "machine_03", ... }
    
    const storeId = req.machine.storeId;
    const piDeviceId = req.machine.machineId;
    
    console.log(`📥 Pi sync from ${piDeviceId}: ${Object.keys(mappings).length} mappings`);
    
    const results = [];
    const conflicts = [];
    
    for (const [muthaGooseNumber, logicalId] of Object.entries(mappings)) {
      try {
        // Find machine in MongoDB
        const mongoMachine = await Machine.findOne({ 
          machineId: logicalId, 
          storeId 
        });
        
        if (!mongoMachine) {
          // Machine exists on Pi but not in MongoDB - create it
          const newMachine = await Machine.create({
            machineId: logicalId,
            storeId,
            name: `Discovered ${logicalId}`,
            gameType: 'slot',
            status: 'active',
            muthaGooseNumber: parseInt(muthaGooseNumber),
            muthaGooseId: `machine_${muthaGooseNumber.toString().padStart(2, '0')}`,
            hubMachineId: piDeviceId,
            mappingStatus: 'mapped',
            createdBy: 'pi'
          });
          
          console.log(`✅ Created machine from Pi: ${logicalId} → MG${muthaGooseNumber}`);
          results.push({ action: 'created', machine: newMachine });
          continue;
        }
        
        // Machine exists in MongoDB
        if (mongoMachine.muthaGooseNumber && mongoMachine.muthaGooseNumber !== parseInt(muthaGooseNumber)) {
          // Conflict: Different Mutha Goose number in MongoDB vs Pi
          conflicts.push({
            machineId: logicalId,
            mongoNumber: mongoMachine.muthaGooseNumber,
            piNumber: parseInt(muthaGooseNumber),
            reason: 'mutha_goose_number_mismatch'
          });
          
          mongoMachine.mappingStatus = 'conflict';
          
        } else {
          // No conflict, update MongoDB with Pi data
          await mongoMachine.mapToMuthaGoose(parseInt(muthaGooseNumber), piDeviceId, 'pi_sync');
        }
        
        await mongoMachine.save();
        results.push({ action: 'updated', machine: mongoMachine });
        
      } catch (error) {
        console.error(`Pi sync error for ${muthaGooseNumber}:${logicalId}:`, error);
        results.push({ 
          action: 'error', 
          muthaGooseNumber, 
          logicalId, 
          error: error.message 
        });
      }
    }
    
    console.log(`📥 Pi sync complete: ${results.length} processed, ${conflicts.length} conflicts`);
    
    res.json({
      success: true,
      message: `Pi sync complete: ${results.length} processed, ${conflicts.length} conflicts`,
      results,
      conflicts,
      syncTimestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Pi sync error:', error);
    res.status(500).json({ error: 'Pi sync failed' });
  }
});

// GET /api/machines/sync-to-pi/:piDeviceId
// Pi requests current mappings from MongoDB
router.get('/sync-to-pi/:piDeviceId', authenticateMachine, async (req, res) => {
  try {
    const { piDeviceId } = req.params;
    const storeId = req.machine.storeId;
    
    console.log(`📤 Pi requesting sync: ${piDeviceId} for store ${storeId}`);
    
    // Get all machines assigned to this Pi device
    const machines = await Machine.find({ 
      storeId,
      hubMachineId: piDeviceId,
      mappingStatus: 'mapped',
      muthaGooseNumber: { $exists: true }
    }).lean();
    
    // Convert to Pi mapping format
    const mappings = {};
    machines.forEach(machine => {
      if (machine.muthaGooseNumber) {
        mappings[machine.muthaGooseNumber] = machine.machineId;
      }
    });
    
    console.log(`📤 Sending ${Object.keys(mappings).length} mappings to ${piDeviceId}`);
    
    res.json({
      success: true,
      mappings,
      machineCount: Object.keys(mappings).length,
      syncTimestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Pi sync-to error:', error);
    res.status(500).json({ error: 'Failed to sync mappings to Pi' });
  }
});

// POST /api/machines/stores/:storeId/bulk - Bulk add machines
router.post('/stores/:storeId/bulk', 
  ...createVenueMiddleware({ requireManagement: true, action: 'bulk_add_machines' }),
  async (req, res) => {
    try {
      const { storeId } = req.params;
      const store = req.store; // Already loaded by venue middleware
      const { machines } = req.body;

      if (!Array.isArray(machines) || machines.length === 0) {
        return res.status(400).json({ error: 'machines array is required' });
      }

      const results = [];
      const errors = [];

      for (const machineData of machines) {
        try {
          const { machineId, name, location, hubId, gameType, serialNumber } = req.body;  // ADD serialNumber HERE


          if (!machineId) {
            errors.push({ machineId: 'unknown', error: 'machineId is required' });
            continue;
          }

          const existing = await Machine.findOne({ machineId });
          if (existing) {
            errors.push({ machineId, error: 'Machine ID already exists' });
            continue;
          }

          const machine = await Machine.create({
            machineId,
            storeId,
            name: name || `Machine ${machineId}`,
            location: location || '',
            gameType: gameType || 'slot',
            status: 'active'
          });

          results.push(machine);
        } catch (error) {
          errors.push({ 
            machineId: machineData.machineId || 'unknown', 
            error: error.message 
          });
        }
      }

      console.log(`✅ Bulk add: ${results.length} machines added to store ${storeId}`);

      res.json({
        success: true,
        message: `Added ${results.length} machines to ${store.storeName}`,
        created: results,
        errors,
        stats: {
          requested: machines.length,
          created: results.length,
          failed: errors.length
        }
      });
    } catch (e) {
      console.error('bulk add machines error:', e);
      res.status(500).json({ error: 'Failed to add machines' });
    }
  }
);

// GET /api/machines/:id/connection-info - Pi connection setup info
router.get('/:id/connection-info', 
  authenticate,
  requirePermission([PERMISSIONS.MANAGE_ASSIGNED_STORES, PERMISSIONS.MANAGE_ALL_STORES]),
  async (req, res) => {
    try {
      const machine = await Machine.findById(req.params.id);
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

      const store = await Store.findOne({ storeId: machine.storeId });
      
      // Generate machine token for Pi authentication
      const machineToken = jwt.sign(
        { 
          machineId: machine.machineId,
          storeId: machine.storeId,
          type: 'machine',
          iat: Math.floor(Date.now() / 1000)
        },
        process.env.MACHINE_JWT_SECRET || process.env.JWT_SECRET,
        { expiresIn: '1y' }
      );

      const connectionInfo = {
        machineId: machine.machineId,
        storeId: machine.storeId,
        storeName: store?.storeName || 'Unknown Store',
        apiEndpoint: `${process.env.FRONTEND_URL || 'https://api.gambino.gold'}/api/edge/events`,
        webhookUrl: `${process.env.FRONTEND_URL || 'https://api.gambino.gold'}/api/edge/sessions`,
        machineToken,
        status: machine.status,
        lastSeen: machine.lastSeen || null
      };

      res.json({
        success: true,
        connectionInfo,
        instructions: [
          '1. Install this config on your Raspberry Pi',
          '2. Pi will authenticate using the machineToken',
          '3. Set machine to "active" when Pi connects successfully'
        ]
      });
    } catch (e) {
      console.error('connection info error:', e);
      res.status(500).json({ error: 'Failed to get connection info' });
    }
  }
);

module.exports = router;
