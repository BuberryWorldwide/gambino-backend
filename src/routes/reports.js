// backend/src/routes/admin/reports.js
const express = require('express');
const router = express.Router();

// These will be injected by server.js
let authenticate, requirePermission, createVenueMiddleware;
let DailyReport, Event;

// Setup function to inject dependencies
function setupMiddleware(auth, reqPerm, createVenue) {
  authenticate = auth;
  requirePermission = reqPerm;
  createVenueMiddleware = createVenue;
}

// Setup function to inject models
function setupModels(dailyReportModel, eventModel) {
  DailyReport = dailyReportModel;
  Event = eventModel;
}

/**
 * GET /api/admin/reports/daily/:storeId
 * Get all daily reports for a specific date
 * Query params: date (YYYY-MM-DD format)
 */
router.get('/daily/:storeId',
  authenticate,
  requirePermission('view_store_metrics'),
  ...createVenueMiddleware({ requireManagement: false, action: 'view_daily_reports' }),
  async (req, res) => {
    try {
      const { storeId } = req.params;
      const { date } = req.query;

      if (!date) {
        return res.status(400).json({ 
          error: 'Date parameter required',
          message: 'Please provide date in YYYY-MM-DD format'
        });
      }

      // Parse date and create date range for the entire day
      const reportDate = new Date(date);
      if (isNaN(reportDate.getTime())) {
        return res.status(400).json({ 
          error: 'Invalid date format',
          message: 'Date must be in YYYY-MM-DD format'
        });
      }

      // Set time to start of day (00:00:00)
      const startOfDay = new Date(reportDate);
      startOfDay.setHours(0, 0, 0, 0);

      // Set time to end of day (23:59:59.999)
      const endOfDay = new Date(reportDate);
      endOfDay.setHours(23, 59, 59, 999);

      console.log(`📊 Fetching daily reports for ${storeId} on ${date}`);
      console.log(`   Date range: ${startOfDay.toISOString()} to ${endOfDay.toISOString()}`);

      // Find all reports for this store on this date
      const reports = await DailyReport.find({
        storeId: storeId,
        reportDate: {
          $gte: startOfDay,
          $lte: endOfDay
        }
      }).sort({ printedAt: 1 }); // Sort by print time, oldest first

      console.log(`✅ Found ${reports.length} reports for ${storeId} on ${date}`);

      res.json({
        success: true,
        reports: reports,
        date: date,
        storeId: storeId,
        count: reports.length
      });

    } catch (error) {
      console.error('❌ Error fetching daily reports:', error);
      res.status(500).json({ 
        error: 'Failed to fetch daily reports',
        message: error.message 
      });
    }
  }
);

/**
 * POST /api/admin/reports/:reportId/reconciliation
 * Update reconciliation status for a specific report
 * Body: { include: boolean, notes: string }
 */
router.post('/:reportId/reconciliation',
  authenticate,
  requirePermission('manage_reconciliation'),
  async (req, res) => {
    try {
      const { reportId } = req.params;
      const { include, notes } = req.body;

      if (typeof include !== 'boolean') {
        return res.status(400).json({ 
          error: 'Include parameter required',
          message: 'include must be a boolean (true or false)'
        });
      }

      console.log(`🔄 Updating report ${reportId}: include=${include}`);

      // Find the report
      const report = await DailyReport.findById(reportId);
      
      if (!report) {
        return res.status(404).json({ 
          error: 'Report not found',
          message: `No report found with ID ${reportId}`
        });
      }

      // Check if user has access to this store
      const userRole = req.user?.role;
      const assignedVenues = req.user?.assignedVenues || [];
      
      const hasAccess = 
        ['super_admin', 'gambino_ops'].includes(userRole) ||
        (userRole === 'venue_manager' && assignedVenues.includes(report.storeId));

      if (!hasAccess) {
        return res.status(403).json({ 
          error: 'Access denied',
          message: 'You do not have permission to manage reports for this store'
        });
      }

      // Update the report
      report.includeInReconciliation = include;
      report.reconciliationStatus = include ? 'included' : 'excluded';
      
      // Add notes if provided
      if (notes) {
        if (!report.notes) {
          report.notes = [];
        }
        report.notes.push({
          text: notes,
          createdBy: req.user.userId,
          createdAt: new Date()
        });
      }

      // Add audit trail
      if (!report.reconciliationHistory) {
        report.reconciliationHistory = [];
      }
      report.reconciliationHistory.push({
        action: include ? 'included' : 'excluded',
        userId: req.user.userId,
        userEmail: req.user.email,
        timestamp: new Date(),
        notes: notes
      });

      await report.save();

      console.log(`✅ Report ${reportId} ${include ? 'included' : 'excluded'} in reconciliation`);

      res.json({
        success: true,
        message: `Report ${include ? 'included' : 'excluded'} in reconciliation`,
        report: report
      });

    } catch (error) {
      console.error('❌ Error updating report reconciliation:', error);
      res.status(500).json({ 
        error: 'Failed to update report',
        message: error.message 
      });
    }
  }
);

/**
 * GET /api/admin/reports/:storeId/reconciliation
 * Get reconciliation summary for a date range
 * Query params: startDate, endDate (YYYY-MM-DD format)
 */
router.get('/:storeId/reconciliation',
  authenticate,
  requirePermission('view_store_metrics'),
  ...createVenueMiddleware({ requireManagement: false, action: 'view_reconciliation' }),
  async (req, res) => {
    try {
      const { storeId } = req.params;
      const { startDate, endDate } = req.query;

      if (!startDate || !endDate) {
        return res.status(400).json({ 
          error: 'Date range required',
          message: 'Please provide both startDate and endDate in YYYY-MM-DD format'
        });
      }

      const start = new Date(startDate);
      const end = new Date(endDate);
      
      if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        return res.status(400).json({ 
          error: 'Invalid date format',
          message: 'Dates must be in YYYY-MM-DD format'
        });
      }

      // Set to full day range
      start.setHours(0, 0, 0, 0);
      end.setHours(23, 59, 59, 999);

      console.log(`📊 Fetching reconciliation for ${storeId} from ${startDate} to ${endDate}`);

      // Get all reports in date range
      const allReports = await DailyReport.find({
        storeId: storeId,
        reportDate: {
          $gte: start,
          $lte: end
        }
      }).sort({ reportDate: 1, printedAt: 1 });

      // Calculate totals only from included reports
      const includedReports = allReports.filter(r => r.includeInReconciliation === true);
      
      const totalRevenue = includedReports.reduce((sum, r) => sum + (r.totalRevenue || 0), 0);
      const totalReports = allReports.length;
      const includedCount = includedReports.length;
      const excludedCount = allReports.filter(r => r.reconciliationStatus === 'excluded').length;
      const pendingCount = allReports.filter(r => r.reconciliationStatus === 'pending').length;

      // Group by date for daily breakdown
      const dailyBreakdown = {};
      allReports.forEach(report => {
        const dateKey = report.reportDate.toISOString().split('T')[0];
        if (!dailyBreakdown[dateKey]) {
          dailyBreakdown[dateKey] = {
            date: dateKey,
            reports: [],
            totalRevenue: 0,
            includedRevenue: 0
          };
        }
        dailyBreakdown[dateKey].reports.push(report);
        dailyBreakdown[dateKey].totalRevenue += report.totalRevenue || 0;
        if (report.includeInReconciliation) {
          dailyBreakdown[dateKey].includedRevenue += report.totalRevenue || 0;
        }
      });

      console.log(`✅ Reconciliation summary: ${includedCount}/${totalReports} reports included, $${totalRevenue.toFixed(2)} total`);

      res.json({
        success: true,
        summary: {
          storeId: storeId,
          startDate: startDate,
          endDate: endDate,
          totalReports: totalReports,
          includedReports: includedCount,
          excludedReports: excludedCount,
          pendingReports: pendingCount,
          totalRevenue: totalRevenue,
          dailyBreakdown: Object.values(dailyBreakdown)
        },
        reports: allReports
      });

    } catch (error) {
      console.error('❌ Error fetching reconciliation summary:', error);
      res.status(500).json({ 
        error: 'Failed to fetch reconciliation summary',
        message: error.message 
      });
    }
  }
);

/**
 * GET /api/admin/reports/:storeId/pi-data
 * Legacy endpoint - kept for backwards compatibility
 * Redirects to new daily reports endpoint
 */
router.get('/pi-data/:storeId',
  authenticate,
  requirePermission('view_store_metrics'),
  ...createVenueMiddleware({ requireManagement: false, action: 'view_pi_data' }),
  async (req, res) => {
    try {
      const { storeId } = req.params;
      
      // Get date range for last 30 days
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 30);

      const reports = await DailyReport.find({
        storeId: storeId,
        reportDate: {
          $gte: startDate,
          $lte: endDate
        },
        includeInReconciliation: true
      }).sort({ reportDate: -1 });

      // Group by date
      const dailyData = {};
      reports.forEach(report => {
        const dateKey = report.reportDate.toISOString().split('T')[0];
        if (!dailyData[dateKey]) {
          dailyData[dateKey] = {
            date: dateKey,
            totalRevenue: 0,
            reportCount: 0
          };
        }
        dailyData[dateKey].totalRevenue += report.totalRevenue || 0;
        dailyData[dateKey].reportCount += 1;
      });

      res.json({
        success: true,
        data: Object.values(dailyData),
        message: 'This endpoint is deprecated. Please use /api/admin/reports/daily/:storeId instead'
      });

    } catch (error) {
      console.error('❌ Error fetching pi data:', error);
      res.status(500).json({ 
        error: 'Failed to fetch pi data',
        message: error.message 
      });
    }
  }
);

module.exports = { 
  router, 
  setupMiddleware,
  setupModels
};
// Import BookkeepingReport model (lazy loaded)
let BookkeepingReport;
function getBookkeepingReport() {
  if (!BookkeepingReport) {
    BookkeepingReport = require('../models/BookkeepingReport');
  }
  return BookkeepingReport;
}

/**
 * GET /api/admin/reports/:storeId/bookkeeping
 * Get bookkeeping and clearing reports for a store
 * Query params: startDate, endDate (optional), reportType (optional: 'bookkeeping' | 'clearing' | 'all')
 */
router.get('/:storeId/bookkeeping',
  authenticate,
  requirePermission('view_store_metrics'),
  ...createVenueMiddleware({ requireManagement: false, action: 'view_bookkeeping' }),
  async (req, res) => {
    try {
      const { storeId } = req.params;
      const { startDate, endDate, reportType, limit } = req.query;

      console.log(`📚 Fetching bookkeeping reports for ${storeId}`);

      const BookkeepingReportModel = getBookkeepingReport();
      const query = { storeId };

      // Filter by report type
      if (reportType && reportType !== 'all') {
        query.reportType = reportType;
      }

      // Filter by date range
      if (startDate || endDate) {
        query.timestamp = {};
        if (startDate) {
          const start = new Date(startDate);
          start.setHours(0, 0, 0, 0);
          query.timestamp.$gte = start;
        }
        if (endDate) {
          const end = new Date(endDate);
          end.setHours(23, 59, 59, 999);
          query.timestamp.$lte = end;
        }
      }

      const reports = await BookkeepingReportModel
        .find(query)
        .sort({ timestamp: -1 })
        .limit(parseInt(limit) || 100);

      // Get summary stats
      const totalClears = await BookkeepingReportModel.countDocuments({ 
        storeId, 
        reportType: 'clearing' 
      });
      
      const lastClear = await BookkeepingReportModel.findOne({ 
        storeId, 
        reportType: 'clearing' 
      }).sort({ timestamp: -1 });

      console.log(`✅ Found ${reports.length} bookkeeping reports for ${storeId}`);

      res.json({
        success: true,
        reports,
        summary: {
          totalReports: reports.length,
          totalClears,
          lastClearTimestamp: lastClear?.timestamp || null,
          lastClearValues: lastClear?.clearedValues || null
        }
      });

    } catch (error) {
      console.error('❌ Error fetching bookkeeping reports:', error);
      res.status(500).json({ 
        error: 'Failed to fetch bookkeeping reports',
        message: error.message 
      });
    }
  }
);

/**
 * GET /api/admin/reports/:storeId/bookkeeping/latest
 * Get the latest bookkeeping and clearing info
 */
router.get('/:storeId/bookkeeping/latest',
  authenticate,
  requirePermission('view_store_metrics'),
  ...createVenueMiddleware({ requireManagement: false, action: 'view_bookkeeping' }),
  async (req, res) => {
    try {
      const { storeId } = req.params;

      const BookkeepingReportModel = getBookkeepingReport();

      // Get latest bookkeeping report
      const latestBookkeeping = await BookkeepingReportModel.findOne({ 
        storeId, 
        reportType: 'bookkeeping' 
      }).sort({ timestamp: -1 });

      // Get latest clearing
      const latestClearing = await BookkeepingReportModel.findOne({ 
        storeId, 
        reportType: 'clearing' 
      }).sort({ timestamp: -1 });

      // Get count since last clear
      let reportsSinceLastClear = 0;
      if (latestClearing) {
        reportsSinceLastClear = await BookkeepingReportModel.countDocuments({
          storeId,
          reportType: 'bookkeeping',
          timestamp: { $gt: latestClearing.timestamp }
        });
      }

      res.json({
        success: true,
        latestBookkeeping,
        latestClearing,
        reportsSinceLastClear
      });

    } catch (error) {
      console.error('❌ Error fetching latest bookkeeping:', error);
      res.status(500).json({ 
        error: 'Failed to fetch latest bookkeeping',
        message: error.message 
      });
    }
  }
);


module.exports = { router, setupMiddleware, setupModels };
