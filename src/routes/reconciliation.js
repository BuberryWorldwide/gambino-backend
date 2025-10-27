const express = require('express');
const router = express.Router();
const VenueReconciliation = require('../models/VenueReconciliation');
const Store = require('../models/Store');

// Import RBAC middleware directly
const { 
  authenticate, 
  requirePermission, 
  requireVenueAccess,
  createVenueMiddleware,
  PERMISSIONS 
} = require('../middleware/rbac');

// GET /api/admin/reconciliation/:storeId - Get reconciliation history for a store
router.get('/:storeId', 
  ...createVenueMiddleware({ action: 'view_reconciliation_history' }),
  async (req, res) => {
    try {
      const { storeId } = req.params;
      const { days = 30, status } = req.query;
      
      // Build query
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - parseInt(days));
      
      const query = { 
        storeId,
        reconciliationDate: { $gte: startDate }
      };
      
      if (status) {
        query.reconciliationStatus = status;
      }
      
      // Get reconciliation history
      const reconciliations = await VenueReconciliation.find(query)
        .populate('submittedBy', 'firstName lastName email role')
        .populate('approvedBy', 'firstName lastName email role')
        .sort({ reconciliationDate: -1 })
        .limit(100)
        .lean();
      
      // Get compliance stats
      const stats = await VenueReconciliation.getVenueComplianceStats(storeId, parseInt(days));
      
      console.log(`📊 Loaded ${reconciliations.length} reconciliations for store ${storeId}`);
      
      res.json({
        success: true,
        reconciliations,
        stats: stats || {
          totalReconciliations: 0,
          averageComplianceScore: null,
          totalVariance: 0,
          flaggedCount: 0,
          approvedCount: 0
        },
        filters: { days: parseInt(days), status }
      });
      
    } catch (error) {
      console.error('Get reconciliation history error:', error);
      res.status(500).json({ error: 'Failed to load reconciliation history' });
    }
  }
);

// POST /api/admin/reconciliation/:storeId - Submit daily reconciliation
router.post('/:storeId',
  ...createVenueMiddleware({ requireManagement: true, action: 'submit_reconciliation' }),
  async (req, res) => {
    try {
      const { storeId } = req.params;
      const { reconciliationDate, venueGamingRevenue, notes, machineCount, transactionCount } = req.body;
      
      // Validation
      if (!reconciliationDate || venueGamingRevenue === undefined) {
        return res.status(400).json({ 
          error: 'reconciliationDate and venueGamingRevenue are required' 
        });
      }
      
      if (venueGamingRevenue < 0) {
        return res.status(400).json({ 
          error: 'venueGamingRevenue must be non-negative' 
        });
      }
      
      // Get store info for fee calculation
      const store = req.store; // Already validated by middleware
      const feePercentage = store.feePercentage || 0;
      
      // Create reconciliation
      const reconciliation = new VenueReconciliation({
        storeId,
        reconciliationDate: new Date(reconciliationDate),
        venueGamingRevenue: parseFloat(venueGamingRevenue),
        softwareFeePercentage: feePercentage,
        submittedBy: req.user.userId,
        notes: notes || '',
        machineCount: machineCount || null,
        transactionCount: transactionCount || null
      });
      
      const savedReconciliation = await reconciliation.save();
      
      // Populate user data for response
      await savedReconciliation.populate('submittedBy', 'firstName lastName email role');
      
      console.log(`📋 Reconciliation submitted: ${storeId} for ${reconciliationDate} - $${venueGamingRevenue} gaming revenue`);
      
      res.status(201).json({
        success: true,
        reconciliation: savedReconciliation,
        message: 'Reconciliation submitted successfully'
      });
      
    } catch (error) {
      console.error('Submit reconciliation error:', error);
      
      // Handle duplicate reconciliation (one per store per day)
      if (error.code === 11000) {
        return res.status(409).json({ 
          error: 'Reconciliation already exists for this date. Use PUT to update existing reconciliation.' 
        });
      }
      
      res.status(500).json({ error: 'Failed to submit reconciliation' });
    }
  }
);

// PUT /api/admin/reconciliation/update/:reconciliationId - Update reconciliation (actual software fee)
router.put('/update/:reconciliationId',
  authenticate,
  requirePermission([PERMISSIONS.MANAGE_RECONCILIATION]),
  async (req, res) => {
    try {
      const { reconciliationId } = req.params;
      const { actualSoftwareFee, notes } = req.body;
      
      if (actualSoftwareFee === undefined || actualSoftwareFee < 0) {
        return res.status(400).json({ 
          error: 'actualSoftwareFee is required and must be non-negative' 
        });
      }
      
      const reconciliation = await VenueReconciliation.findById(reconciliationId);
      if (!reconciliation) {
        return res.status(404).json({ error: 'Reconciliation not found' });
      }
      
      // Update actual software fee
      reconciliation.actualSoftwareFee = parseFloat(actualSoftwareFee);
      
      // Add notes if provided
      if (notes) {
        reconciliation.notes = reconciliation.notes 
          ? `${reconciliation.notes}\n${notes}` 
          : notes;
      }
      
      // Auto-approve if compliance score is high enough
      if (reconciliation.calculateComplianceScore() >= 90) {
        reconciliation.reconciliationStatus = 'approved';
        reconciliation.approvedBy = req.user.userId;
        reconciliation.approvedAt = new Date();
      }
      
      const updatedReconciliation = await reconciliation.save();
      await updatedReconciliation.populate([
        { path: 'submittedBy', select: 'firstName lastName email role' },
        { path: 'approvedBy', select: 'firstName lastName email role' }
      ]);
      
      console.log(`💰 Actual software fee updated: ${reconciliation.storeId} - $${actualSoftwareFee} (variance: ${reconciliation.variance?.toFixed(2) || 'N/A'})`);
      
      res.json({
        success: true,
        reconciliation: updatedReconciliation,
        message: 'Actual software fee updated successfully'
      });
      
    } catch (error) {
      console.error('Update actual software fee error:', error);
      res.status(500).json({ error: 'Failed to update reconciliation' });
    }
  }
);

// PATCH /api/admin/reconciliation/approve/:reconciliationId - Approve reconciliation
router.patch('/approve/:reconciliationId',
  authenticate,
  requirePermission([PERMISSIONS.MANAGE_RECONCILIATION, PERMISSIONS.MANAGE_ASSIGNED_STORES]),
  async (req, res) => {
    try {
      const { reconciliationId } = req.params;
      const { notes } = req.body;
      
      const reconciliation = await VenueReconciliation.findById(reconciliationId);
      if (!reconciliation) {
        return res.status(404).json({ error: 'Reconciliation not found' });
      }
      
      // Venue managers can only approve their own venue reconciliations
      if (req.user.role === 'venue_manager') {
        const hasAccess = req.user.assignedVenues?.includes(reconciliation.storeId);
        if (!hasAccess) {
          return res.status(403).json({ error: 'Can only approve reconciliations for assigned venues' });
        }
      }
      
      if (reconciliation.reconciliationStatus === 'approved') {
        return res.status(400).json({ error: 'Reconciliation already approved' });
      }
      
      reconciliation.reconciliationStatus = 'approved';
      reconciliation.approvedBy = req.user.userId;
      reconciliation.approvedAt = new Date();
      
      if (notes) {
        reconciliation.notes = reconciliation.notes 
          ? `${reconciliation.notes}\nApproval notes: ${notes}` 
          : `Approval notes: ${notes}`;
      }
      
      const updatedReconciliation = await reconciliation.save();
      await updatedReconciliation.populate([
        { path: 'submittedBy', select: 'firstName lastName email role' },
        { path: 'approvedBy', select: 'firstName lastName email role' }
      ]);
      
      console.log(`✅ Reconciliation approved: ${reconciliation.storeId} for ${reconciliation.reconciliationDate} by ${req.user.role}`);
      
      res.json({
        success: true,
        reconciliation: updatedReconciliation,
        message: 'Reconciliation approved successfully'
      });
      
    } catch (error) {
      console.error('Approve reconciliation error:', error);
      res.status(500).json({ error: 'Failed to approve reconciliation' });
    }
  }
);

// PATCH /api/admin/reconciliation/flag/:reconciliationId - Flag reconciliation for review
router.patch('/flag/:reconciliationId',
  authenticate,
  requirePermission([PERMISSIONS.MANAGE_RECONCILIATION]),
  async (req, res) => {
    try {
      const { reconciliationId } = req.params;
      const { flaggedReason } = req.body;
      
      if (!flaggedReason) {
        return res.status(400).json({ error: 'flaggedReason is required' });
      }
      
      const reconciliation = await VenueReconciliation.findById(reconciliationId);
      if (!reconciliation) {
        return res.status(404).json({ error: 'Reconciliation not found' });
      }
      
      reconciliation.reconciliationStatus = 'flagged';
      reconciliation.flaggedReason = flaggedReason;
      reconciliation.notes = reconciliation.notes 
        ? `${reconciliation.notes}\nFlagged: ${flaggedReason}` 
        : `Flagged: ${flaggedReason}`;
      
      const updatedReconciliation = await reconciliation.save();
      await updatedReconciliation.populate('submittedBy', 'firstName lastName email role');
      
      console.log(`🚩 Reconciliation flagged: ${reconciliation.storeId} - ${flaggedReason}`);
      
      res.json({
        success: true,
        reconciliation: updatedReconciliation,
        message: 'Reconciliation flagged for review'
      });
      
    } catch (error) {
      console.error('Flag reconciliation error:', error);
      res.status(500).json({ error: 'Failed to flag reconciliation' });
    }
  }
);

// GET /api/admin/reconciliation/dashboard/system - System-wide compliance overview (gambino_ops only)
router.get('/dashboard/system',
  authenticate,
  requirePermission([PERMISSIONS.VIEW_ALL_METRICS, PERMISSIONS.MANAGE_RECONCILIATION]),
  async (req, res) => {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      
      const [
        totalStores,
        todaySubmissions,
        pendingReconciliations,
        flaggedReconciliations,
        recentReconciliations
      ] = await Promise.all([
        Store.countDocuments({ status: 'active' }),
        VenueReconciliation.countDocuments({ 
          reconciliationDate: { $gte: today } 
        }),
        VenueReconciliation.countDocuments({ 
          reconciliationStatus: 'pending' 
        }),
        VenueReconciliation.countDocuments({ 
          reconciliationStatus: 'flagged' 
        }),
        VenueReconciliation.find()
          .populate('submittedBy', 'firstName lastName email role')
          .populate('approvedBy', 'firstName lastName email role')
          .sort({ createdAt: -1 })
          .limit(20)
          .lean()
      ]);
      
      const submissionRate = totalStores > 0 ? Math.round((todaySubmissions / totalStores) * 100) : 0;
      
      // Calculate system health
      let systemHealth = 'Healthy';
      if (submissionRate < 50 || flaggedReconciliations > totalStores * 0.2) {
        systemHealth = 'Needs Attention';
      } else if (submissionRate < 75 || flaggedReconciliations > totalStores * 0.1) {
        systemHealth = 'Fair';
      } else if (submissionRate < 90 || flaggedReconciliations > totalStores * 0.05) {
        systemHealth = 'Good';
      }
      
      res.json({
        success: true,
        overview: {
          totalStores,
          todaySubmissions,
          submissionRate,
          pendingReconciliations,
          flaggedReconciliations,
          systemHealth
        },
        recentReconciliations
      });
      
    } catch (error) {
      console.error('System dashboard error:', error);
      res.status(500).json({ error: 'Failed to load system dashboard' });
    }
  }
);

// GET /api/admin/reconciliation/missing - Get venues missing today's reconciliation
router.get('/missing',
  authenticate,
  requirePermission([PERMISSIONS.VIEW_ALL_METRICS, PERMISSIONS.MANAGE_RECONCILIATION]),
  async (req, res) => {
    try {
      const { date } = req.query;
      const targetDate = date ? new Date(date) : new Date();
      
      const dateStart = new Date(targetDate);
      dateStart.setHours(0, 0, 0, 0);
      
      const dateEnd = new Date(targetDate);
      dateEnd.setHours(23, 59, 59, 999);
      
      // Get all active stores
      const activeStores = await Store.find({ status: 'active' })
        .select('storeId storeName city state')
        .lean();
      
      // Get stores that already submitted for this date
      const submittedStores = await VenueReconciliation.find({
        reconciliationDate: { $gte: dateStart, $lte: dateEnd }
      }).distinct('storeId');
      
      // Filter out stores that already submitted
      const missingStores = activeStores.filter(store => 
        !submittedStores.includes(store.storeId)
      );
      
      res.json({
        success: true,
        date: targetDate.toISOString().split('T')[0],
        missingStores,
        totalActive: activeStores.length,
        submitted: submittedStores.length,
        missing: missingStores.length
      });
      
    } catch (error) {
      console.error('Missing reconciliations error:', error);
      res.status(500).json({ error: 'Failed to get missing reconciliations' });
    }
  }
);

// PUT /api/admin/reconciliation/:storeId/:reconciliationId/payment-sent
// Venue manager marks payment as sent
router.put('/:storeId/:reconciliationId/payment-sent',
  ...createVenueMiddleware({ requireManagement: true, action: 'mark_payment_sent' }),
  async (req, res) => {
    try {
      const { reconciliationId } = req.params;
      const { 
        amountSent,
        sentAt,
        method = 'pending'
      } = req.body;
      
      // Find the reconciliation
      const reconciliation = await VenueReconciliation.findById(reconciliationId);
      if (!reconciliation) {
        return res.status(404).json({ error: 'Reconciliation not found' });
      }
      
      // Update the reconciliation with payment sent status
      reconciliation.settlementStatus = 'payment_sent';
      reconciliation.paymentSentAt = sentAt || new Date();
      reconciliation.paymentMethod = method;
      reconciliation.amountSent = amountSent;
      
      // Add a note about the payment
      const paymentNote = `[Payment Sent] $${amountSent} marked as sent at ${new Date().toLocaleString()} by ${req.user.email || req.user.userId}`;
      reconciliation.notes = reconciliation.notes 
        ? `${reconciliation.notes}\n${paymentNote}`
        : paymentNote;
      
      await reconciliation.save();
      
      console.log(`💸 Payment marked as sent: ${reconciliation.storeId} - $${amountSent}`);
      
      res.json({
        success: true,
        reconciliation,
        message: `Payment of $${amountSent} marked as sent. Awaiting confirmation.`
      });
      
    } catch (error) {
      console.error('Mark payment sent error:', error);
      res.status(500).json({ error: 'Failed to update payment status' });
    }
  }
);

// PUT /api/admin/reconciliation/:storeId/:reconciliationId/confirm-payment
// Admin confirms payment was received
router.put('/:storeId/:reconciliationId/confirm-payment',
  authenticate,
  requirePermission([PERMISSIONS.MANAGE_RECONCILIATION]),
  async (req, res) => {
    try {
      const { reconciliationId } = req.params;
      const { 
        amountReceived,
        receivedAt,
        confirmationNotes
      } = req.body;
      
      const reconciliation = await VenueReconciliation.findById(reconciliationId);
      if (!reconciliation) {
        return res.status(404).json({ error: 'Reconciliation not found' });
      }
      
      // Update to settled status
      reconciliation.settlementStatus = 'settled';
      reconciliation.paymentReceivedAt = receivedAt || new Date();
      reconciliation.amountCollected = amountReceived || reconciliation.amountSent;
      
      // Add confirmation note
      const confirmNote = `[Payment Confirmed] $${amountReceived} received at ${new Date().toLocaleString()} by ${req.user.email}`;
      reconciliation.notes = reconciliation.notes 
        ? `${reconciliation.notes}\n${confirmNote}`
        : confirmNote;
      
      if (confirmationNotes) {
        reconciliation.notes += `\n${confirmationNotes}`;
      }
      
      await reconciliation.save();
      
      console.log(`✅ Payment confirmed: ${reconciliation.storeId} - $${amountReceived} received`);
      
      res.json({
        success: true,
        reconciliation,
        message: `Payment of $${amountReceived} confirmed and settled.`
      });
      
    } catch (error) {
      console.error('Confirm payment error:', error);
      res.status(500).json({ error: 'Failed to confirm payment' });
    }
  }
);

// Add these routes to your /opt/gambino/backend/src/routes/reconciliation.js file
// Add them BEFORE the module.exports = router; line

// PUT /api/admin/reconciliation/:storeId/:reconciliationId/payment-sent
// Venue manager marks payment as sent
router.put('/:storeId/:reconciliationId/payment-sent',
  ...createVenueMiddleware({ requireManagement: true, action: 'mark_payment_sent' }),
  async (req, res) => {
    try {
      const { reconciliationId } = req.params;
      const { 
        amountSent,
        sentAt,
        method = 'pending'
      } = req.body;
      
      // Find the reconciliation
      const reconciliation = await VenueReconciliation.findById(reconciliationId);
      if (!reconciliation) {
        return res.status(404).json({ error: 'Reconciliation not found' });
      }
      
      // Calculate what they should send (total revenue - their fee)
      const revenue = reconciliation.venueGamingRevenue || 0;
      const venueFeeAmount = (revenue * reconciliation.softwareFeePercentage) / 100;
      const expectedPayment = revenue - venueFeeAmount;
      
      // Update the reconciliation with payment sent status
      reconciliation.settlementStatus = 'payment_sent';
      reconciliation.paymentSentAt = sentAt || new Date();
      reconciliation.paymentMethod = method;
      reconciliation.amountSent = amountSent || expectedPayment;
      
      // Add a note about the payment
      const paymentNote = `[Payment Sent] $${amountSent} marked as sent at ${new Date().toLocaleString()} by ${req.user.email || req.user.userId}`;
      reconciliation.notes = reconciliation.notes 
        ? `${reconciliation.notes}\n${paymentNote}`
        : paymentNote;
      
      await reconciliation.save();
      
      console.log(`💸 Payment marked as sent: ${reconciliation.storeId} - $${amountSent}`);
      
      res.json({
        success: true,
        reconciliation,
        message: `Payment of $${amountSent} marked as sent. Awaiting confirmation.`
      });
      
    } catch (error) {
      console.error('Mark payment sent error:', error);
      res.status(500).json({ error: 'Failed to update payment status' });
    }
  }
);

// PUT /api/admin/reconciliation/:storeId/:reconciliationId/confirm-payment
// Admin confirms payment was received
router.put('/:storeId/:reconciliationId/confirm-payment',
  authenticate,
  requirePermission([PERMISSIONS.MANAGE_RECONCILIATION]),
  async (req, res) => {
    try {
      const { reconciliationId } = req.params;
      const { 
        amountReceived,
        receivedAt,
        confirmationNotes
      } = req.body;
      
      const reconciliation = await VenueReconciliation.findById(reconciliationId);
      if (!reconciliation) {
        return res.status(404).json({ error: 'Reconciliation not found' });
      }
      
      // Update to settled status
      reconciliation.settlementStatus = 'settled';
      reconciliation.paymentReceivedAt = receivedAt || new Date();
      reconciliation.actualSoftwareFee = amountReceived || reconciliation.amountSent;
      reconciliation.paymentConfirmedBy = req.user.userId;
      
      // The model's pre-save hook will calculate variance and compliance score
      
      // Add confirmation note
      const confirmNote = `[Payment Confirmed] $${amountReceived} received at ${new Date().toLocaleString()} by ${req.user.email}`;
      reconciliation.notes = reconciliation.notes 
        ? `${reconciliation.notes}\n${confirmNote}`
        : confirmNote;
      
      if (confirmationNotes) {
        reconciliation.notes += `\n${confirmationNotes}`;
      }
      
      // Update reconciliation status to approved if payment matches
      const expectedPayment = reconciliation.venueGamingRevenue - (reconciliation.venueGamingRevenue * reconciliation.softwareFeePercentage / 100);
      if (Math.abs(amountReceived - expectedPayment) < 1) { // Allow $1 variance for rounding
        reconciliation.reconciliationStatus = 'approved';
        reconciliation.approvedBy = req.user.userId;
        reconciliation.approvedAt = new Date();
      }
      
      await reconciliation.save();
      
      console.log(`✅ Payment confirmed: ${reconciliation.storeId} - $${amountReceived} received`);
      
      res.json({
        success: true,
        reconciliation,
        message: `Payment of $${amountReceived} confirmed and settled.`
      });
      
    } catch (error) {
      console.error('Confirm payment error:', error);
      res.status(500).json({ error: 'Failed to confirm payment' });
    }
  }
);

// GET /api/admin/reconciliation/:storeId/outstanding
// Get all outstanding payments for a store
router.get('/:storeId/outstanding',
  ...createVenueMiddleware({ action: 'view_reconciliation' }),
  async (req, res) => {
    try {
      const { storeId } = req.params;
      
      const outstanding = await VenueReconciliation.find({
        storeId,
        settlementStatus: { $in: ['unsettled', 'payment_sent'] }
      })
      .sort({ reconciliationDate: -1 })
      .populate('submittedBy', 'firstName lastName email')
      .lean();
      
      // Calculate total outstanding
      const totalOutstanding = outstanding.reduce((sum, r) => {
        const revenue = r.venueGamingRevenue || 0;
        const venueFee = (revenue * r.softwareFeePercentage) / 100;
        return sum + (revenue - venueFee);
      }, 0);
      
      res.json({
        success: true,
        outstanding,
        totalOutstanding,
        count: outstanding.length
      });
      
    } catch (error) {
      console.error('Get outstanding error:', error);
      res.status(500).json({ error: 'Failed to get outstanding payments' });
    }
  }
);

module.exports = { router };