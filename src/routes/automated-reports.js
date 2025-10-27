// src/routes/automated-reports.js
const express = require('express');
const router = express.Router();
const ReportsService = require('../services/ReportsService');
const { authenticate, requirePermission, PERMISSIONS } = require('../middleware/rbac');

const reportsService = new ReportsService();

// GET /api/admin/reports/pi-data/:storeId - Get automated reports from Pi data
router.get('/pi-data/:storeId', 
  authenticate,
  requirePermission([PERMISSIONS.VIEW_STORE_METRICS, PERMISSIONS.VIEW_ALL_METRICS]),
  async (req, res) => {
    try {
      const { storeId } = req.params;
      const { date, days = 30 } = req.query;

      // Venue managers can only access their assigned venues
      if (req.user.role === 'venue_manager') {
        if (!req.user.assignedVenues.includes(storeId)) {
          return res.status(403).json({ error: 'Access denied to this venue' });
        }
      }

      if (date) {
        // Get specific date report
        const targetDate = new Date(date);
        const report = await reportsService.getDailyRevenueFromPiData(storeId, targetDate);
        
        res.json({
          success: true,
          report,
          dataSource: 'pi_devices',
          message: 'Automated report generated from Pi device data'
        });
      } else {
        // Get available report dates
        const availableDates = await reportsService.getAvailableReportDates(storeId, parseInt(days));
        
        res.json({
          success: true,
          storeId,
          availableDates,
          totalDatesWithData: availableDates.filter(d => d.hasData).length,
          dataSource: 'pi_devices'
        });
      }

    } catch (error) {
      console.error('Pi data report error:', error);
      res.status(500).json({ error: error.message || 'Failed to generate Pi data report' });
    }
  }
);

// GET /api/admin/reports/pi-data/:storeId/monthly - Get monthly summary
router.get('/pi-data/:storeId/monthly',
  authenticate,
  requirePermission([PERMISSIONS.VIEW_STORE_METRICS, PERMISSIONS.VIEW_ALL_METRICS]),
  async (req, res) => {
    try {
      const { storeId } = req.params;
      const { year = new Date().getFullYear(), month = new Date().getMonth() + 1 } = req.query;

      // Access control
      if (req.user.role === 'venue_manager') {
        if (!req.user.assignedVenues.includes(storeId)) {
          return res.status(403).json({ error: 'Access denied to this venue' });
        }
      }

      const monthlyReport = await reportsService.getMonthlyRevenueFromPiData(
        storeId, 
        parseInt(year), 
        parseInt(month)
      );

      res.json({
        success: true,
        monthlyReport,
        dataSource: 'pi_devices',
        period: `${year}-${month.toString().padStart(2, '0')}`
      });

    } catch (error) {
      console.error('Monthly Pi report error:', error);
      res.status(500).json({ error: 'Failed to generate monthly Pi report' });
    }
  }
);

// POST /api/admin/reports/compare - Compare manual entry with Pi data
router.post('/compare',
  authenticate,
  requirePermission([PERMISSIONS.VIEW_STORE_METRICS]),
  async (req, res) => {
    try {
      const { storeId, date, manualAmount } = req.body;

      if (!storeId || !date || manualAmount === undefined) {
        return res.status(400).json({ error: 'storeId, date, and manualAmount are required' });
      }

      // Access control
      if (req.user.role === 'venue_manager') {
        if (!req.user.assignedVenues.includes(storeId)) {
          return res.status(403).json({ error: 'Access denied to this venue' });
        }
      }

      const comparison = await reportsService.compareManualWithPiData(
        storeId,
        new Date(date),
        parseFloat(manualAmount)
      );

      res.json({
        success: true,
        comparison,
        message: 'Manual vs Pi data comparison completed'
      });

    } catch (error) {
      console.error('Report comparison error:', error);
      res.status(500).json({ error: 'Failed to compare reports' });
    }
  }
);

// GET /api/admin/reports/reconciliation/:storeId/auto-generate - Generate auto reconciliation
router.get('/reconciliation/:storeId/auto-generate',
  authenticate,
  requirePermission([PERMISSIONS.VIEW_STORE_METRICS, PERMISSIONS.MANAGE_RECONCILIATION]),
  async (req, res) => {
    try {
      const { storeId } = req.params;
      const { date = new Date().toISOString().split('T')[0] } = req.query;

      // Get Pi data for the date
      const piReport = await reportsService.getDailyRevenueFromPiData(storeId, new Date(date));
      
      // Create reconciliation record that matches existing schema
      const autoReconciliation = {
        storeId,
        reconciliationDate: new Date(date),
        venueGamingRevenue: piReport.piData.grossRevenue,
        softwareFeePercentage: piReport.softwareFeePercentage,
        expectedSoftwareFee: piReport.calculatedSoftwareFee,
        submittedBy: null, // System generated
        submittedAt: new Date(),
        reconciliationStatus: 'auto_generated',
        notes: `Auto-generated from Pi data: ${piReport.piData.eventCount} events, Data quality: ${piReport.piData.dataQuality.score}%`,
        
        // Additional Pi data context
        piDataSummary: {
          totalMoneyIn: piReport.piData.totalMoneyIn,
          totalCollected: piReport.piData.totalCollected,
          totalVouchers: piReport.piData.totalVouchers,
          netRevenue: piReport.piData.netRevenue,
          eventCount: piReport.piData.eventCount,
          dataQuality: piReport.piData.dataQuality,
          machineBreakdown: piReport.piData.machineBreakdown
        }
      };

      res.json({
        success: true,
        autoReconciliation,
        piReport,
        message: 'Auto-reconciliation generated from Pi data',
        dataQuality: piReport.piData.dataQuality
      });

    } catch (error) {
      console.error('Auto reconciliation error:', error);
      res.status(500).json({ error: 'Failed to generate auto reconciliation' });
    }
  }
);

// Debug endpoint (temporary)
router.get('/debug/:storeId', authenticate, async (req, res) => {
  try {
    const { storeId } = req.params;
    const Machine = require('../models/Machine');
    const Event = require('../models/Event');
    
    const allMachines = await Machine.find({ storeId }).lean();
    const piMachines = allMachines.filter(m => m.gameType === 'edge');
    const hubMachineIds = piMachines.map(m => m.machineId);
    
    const recentEvents = await Event.find({
      hubMachineId: { $in: hubMachineIds }
    }).limit(10).sort({ timestamp: -1 }).lean();
    
    res.json({
      storeId,
      totalMachines: allMachines.length,
      piMachines: piMachines.length,
      piMachineIds: hubMachineIds,
      recentEventCount: recentEvents.length,
      sampleEvents: recentEvents.slice(0, 3),
      allMachines: allMachines.map(m => ({ machineId: m.machineId, gameType: m.gameType, status: m.status }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;