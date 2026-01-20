// src/routes/tags.js
const express = require('express');
const router = express.Router();
const Tag = require('../models/Tag');
const Machine = require('../models/Machine');
const { authenticate } = require('../middleware/rbac');

// GET /api/tags - List all tags (authenticated)
router.get('/', authenticate, async (req, res) => {
  try {
    const { status } = req.query;
    const filter = {};
    if (status) filter.status = status;
    
    const tags = await Tag.find(filter)
      .populate('machineId', 'machineId name displayName')
      .sort({ createdAt: -1 });
    
    res.json(tags);
  } catch (error) {
    console.error('Error fetching tags:', error);
    res.status(500).json({ error: 'Failed to fetch tags' });
  }
});

// GET /api/tags/:token - Get tag by token (public - for QR scan)
router.get('/:token', async (req, res) => {
  try {
    const tag = await Tag.findOne({ token: req.params.token })
      .populate({
        path: 'machineId',
        select: 'machineId name displayName gameTitle manufacturer machineModel serialNumber physicalStatus location storeId credentials',
        populate: {
          path: 'storeId',
          select: 'storeName name'
        }
      });
    
    if (!tag) {
      return res.status(404).json({ error: 'Tag not found' });
    }
    
    // Format response
    const response = {
      token: tag.token,
      status: tag.status,
      createdAt: tag.createdAt,
      linkedAt: tag.linkedAt
    };
    
    if (tag.status === 'linked' && tag.machineId) {
      const m = tag.machineId;
      response.machine = {
        _id: m._id,
        machineId: m.machineId,
        displayName: m.displayName,
        gameTitle: m.gameTitle,
        manufacturer: m.manufacturer,
        machineModel: m.machineModel,
        serialNumber: m.serialNumber,
        physicalStatus: m.physicalStatus,
        location: m.location,
        venue: m.storeId?.storeName || m.storeId?.name,
        credentials: m.credentials
      };
    }
    
    res.json(response);
  } catch (error) {
    console.error('Error fetching tag:', error);
    res.status(500).json({ error: 'Failed to fetch tag' });
  }
});

// POST /api/tags/generate - Generate batch of tags (authenticated)
router.post('/generate', authenticate, async (req, res) => {
  try {
    const { count = 10 } = req.body;
    
    if (count < 1 || count > 500) {
      return res.status(400).json({ error: 'Count must be between 1 and 500' });
    }
    
    const tags = await Tag.generateBatch(count);
    
    res.json({ 
      message: `Generated ${tags.length} tags`,
      tags: tags.map(t => ({ token: t.token, status: t.status }))
    });
  } catch (error) {
    console.error('Error generating tags:', error);
    res.status(500).json({ error: 'Failed to generate tags' });
  }
});

// POST /api/tags/:token/link - Link tag to existing machine (authenticated)
router.post('/:token/link', authenticate, async (req, res) => {
  try {
    const { machineId } = req.body;
    
    if (!machineId) {
      return res.status(400).json({ error: 'machineId is required' });
    }
    
    const tag = await Tag.findOne({ token: req.params.token });
    if (!tag) {
      return res.status(404).json({ error: 'Tag not found' });
    }
    
    if (tag.status === 'linked') {
      return res.status(400).json({ error: 'Tag is already linked to a machine' });
    }
    
    const machine = await Machine.findById(machineId);
    if (!machine) {
      return res.status(404).json({ error: 'Machine not found' });
    }
    
    // Check if machine already has a tag
    const existingTag = await Tag.findOne({ machineId: machine._id, status: 'linked' });
    if (existingTag) {
      return res.status(400).json({ error: 'Machine already has a tag assigned' });
    }
    
    await tag.linkToMachine(machine._id, req.user?.email || 'admin');
    
    // Update machine with assetTag reference
    machine.assetTag = tag.token;
    await machine.save();
    
    res.json({ 
      message: 'Tag linked successfully',
      tag: { token: tag.token, status: tag.status, machineId: tag.machineId }
    });
  } catch (error) {
    console.error('Error linking tag:', error);
    res.status(500).json({ error: 'Failed to link tag' });
  }
});

// POST /api/tags/:token/unlink - Unlink tag from machine (authenticated)
router.post('/:token/unlink', authenticate, async (req, res) => {
  try {
    const tag = await Tag.findOne({ token: req.params.token });
    if (!tag) {
      return res.status(404).json({ error: 'Tag not found' });
    }
    
    if (tag.status === 'unlinked') {
      return res.status(400).json({ error: 'Tag is not linked to any machine' });
    }
    
    // Remove assetTag from machine
    if (tag.machineId) {
      await Machine.findByIdAndUpdate(tag.machineId, { $unset: { assetTag: 1 } });
    }
    
    await tag.unlink(req.user?.email || 'admin');
    
    res.json({ 
      message: 'Tag unlinked successfully',
      tag: { token: tag.token, status: tag.status }
    });
  } catch (error) {
    console.error('Error unlinking tag:', error);
    res.status(500).json({ error: 'Failed to unlink tag' });
  }
});

// POST /api/tags/:token/create-machine - Create new machine and link tag (authenticated)
router.post('/:token/create-machine', authenticate, async (req, res) => {
  try {
    const tag = await Tag.findOne({ token: req.params.token });
    if (!tag) {
      return res.status(404).json({ error: 'Tag not found' });
    }
    
    if (tag.status === 'linked') {
      return res.status(400).json({ error: 'Tag is already linked to a machine' });
    }
    
    const { 
      machineId, 
      displayName, 
      gameTitle,
      manufacturer, 
      machineModel, 
      serialNumber,
      storeId,
      physicalStatus = 'storage'
    } = req.body;
    
    if (!machineId) {
      return res.status(400).json({ error: 'machineId is required' });
    }
    
    // Check if machineId already exists
    const existingMachine = await Machine.findOne({ machineId });
    if (existingMachine) {
      return res.status(400).json({ error: 'Machine ID already exists' });
    }
    
    // Create machine
    const machine = new Machine({
      machineId,
      name: displayName || machineId,
      displayName,
      gameTitle,
      manufacturer,
      machineModel,
      serialNumber,
      storeId: storeId || 'unassigned',
      physicalStatus,
      status: 'active',
      assetTag: tag.token
    });
    
    await machine.save();
    
    // Link tag
    await tag.linkToMachine(machine._id, req.user?.email || 'admin');
    
    res.json({ 
      message: 'Machine created and tag linked successfully',
      machine: {
        _id: machine._id,
        machineId: machine.machineId,
        displayName: machine.displayName,
        assetTag: machine.assetTag
      },
      tag: { token: tag.token, status: tag.status }
    });
  } catch (error) {
    console.error('Error creating machine with tag:', error);
    res.status(500).json({ error: error.message || 'Failed to create machine' });
  }
});

module.exports = router;
