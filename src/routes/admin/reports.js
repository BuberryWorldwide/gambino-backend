// /opt/gambino/backend/src/routes/admin/reports.js
const express = require('express');
const router = express.Router();
const { PERMISSIONS } = require('../../middleware/rbac');

// Dependencies that will be injected
let authenticate, requirePermission, createVenueMiddleware;
let DailyReport, Event;

// Setup function to inject middleware and models
function setupMiddleware(auth, reqPerm, venueMiddleware) {
  authenticate = auth;
  requirePermission = reqPerm;
  createVenueMiddleware = venueMiddleware;
}

function setupModels(dailyReportModel, eventModel) {
  DailyReport = dailyReportModel;
  Event = eventModel;
}

// GET /api/admin/reports/daily/:storeId - Get all daily reports for a specific date
router.get('/daily/:storeId', async (req, res, next) => {
  // Apply middleware chain dynamically
  const middlewares = [
    ...createVenueMiddleware({ action: 'view_reports' })
  ];
  
  // Execute middleware chain
  let index = 0;
  const runMiddleware = (err) => {
    if (err) return next(err);
    if (index >= middlewares.length) return handler(req, res, next);
    const middleware = middlewares[index++];
    middleware(req, res, runMiddleware);
  };
  
  const handler = async (req, res) => {
    try {
      const { storeId } = req.params;
      const { date } = req.query;
      
      if (!date) {
        return res.status(400).json({ error: 'Date parameter is required (format: YYYY-MM-DD)' });
      }
      
      const targetDate = new Date(date);
      const startOfDay = new Date(targetDate.setHours(0, 0, 0, 0));
      const endOfDay = new Date(targetDate.setHours(23, 59, 59, 999));
      
      const reports = await DailyReport.find({
        storeId: storeId,
        printedAt: {
          $gte: startOfDay,
          $lte: endOfDay
        }
      }).sort({ printedAt: -1 }).lean();
      
      res.json({
        success: true,
        date: date,
        storeId: storeId,
        reports: reports,
        count: reports.length
      });
      
    } catch (error) {
      console.error('Get daily reports error:', error);
      res.status(500).json({ error: 'Failed to fetch daily reports' });
    }
  };
  
  runMiddleware();
});

// POST /api/admin/reports/:reportId/reconciliation - Include/exclude a report
router.post('/:reportId/reconciliation', async (req, res, next) => {
  // Apply authenticate and permission middleware
  authenticate(req, res, (err) => {
    if (err) return next(err);
    
    requirePermission([PERMISSIONS.MANAGE_RECONCILIATION])(req, res, async (err) => {
      if (err) return next(err);
      
      try {
        const { reportId } = req.params;
        const { include, notes } = req.body;
        
        if (typeof include !== 'boolean') {
          return res.status(400).json({ error: 'include field must be a boolean' });
        }
        
        const report = await DailyReport.findById(reportId);
        if (!report) {
          return res.status(404).json({ error: 'Report not found' });
        }
        
        report.reconciliationStatus = include ? 'included' : 'excluded';
        if (notes) {
          report.notes = notes;
        }
        report.lastModifiedAt = new Date();
        report.lastModifiedBy = req.user.userId;
        
        await report.save();
        
        res.json({
          success: true,
          report: report,
          message: `Report ${include ? 'included in' : 'excluded from'} reconciliation`
        });
        
      } catch (error) {
        console.error('Update report reconciliation error:', error);
        res.status(500).json({ error: 'Failed to update report' });
      }
    });
  });
});



// GET /api/admin/reports/:storeId/reconciliation - Get reconciliation summary
router.get('/:storeId/reconciliation', async (req, res, next) => {
  const middlewares = [
    ...createVenueMiddleware({ action: 'view_reports' })
  ];
  
  let index = 0;
  const runMiddleware = (err) => {
    if (err) return next(err);
    if (index >= middlewares.length) return handler(req, res, next);
    const middleware = middlewares[index++];
    middleware(req, res, runMiddleware);
  };
  
  const handler = async (req, res) => {
    try {
      const { storeId } = req.params;
      const { startDate, endDate } = req.query;
      
      if (!startDate || !endDate) {
        return res.status(400).json({ 
          error: 'startDate and endDate parameters are required (format: YYYY-MM-DD)' 
        });
      }
      
      const start = new Date(startDate);
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      
      const allReports = await DailyReport.find({
        storeId: storeId,
        printedAt: {
          $gte: start,
          $lte: end
        }
      }).lean();
      
      const includedReports = allReports.filter(r => r.reconciliationStatus === 'included');
      const totalRevenue = includedReports.reduce((sum, r) => sum + (r.totalRevenue || 0), 0);
      
      const dailyBreakdown = {};
      allReports.forEach(report => {
        const dateKey = report.printedAt.toISOString().split('T')[0];
        if (!dailyBreakdown[dateKey]) {
          dailyBreakdown[dateKey] = {
            date: dateKey,
            total: 0,
            included: 0,
            excluded: 0,
            pending: 0,
            revenue: 0
          };
        }
        
        dailyBreakdown[dateKey].total++;
        dailyBreakdown[dateKey][report.reconciliationStatus]++;
        
        if (report.reconciliationStatus === 'included') {
          dailyBreakdown[dateKey].revenue += report.totalRevenue || 0;
        }
      });
      
      res.json({
        success: true,
        storeId: storeId,
        dateRange: { startDate, endDate },
        summary: {
          totalReports: allReports.length,
          includedReports: includedReports.length,
          excludedReports: allReports.filter(r => r.reconciliationStatus === 'excluded').length,
          pendingReports: allReports.filter(r => r.reconciliationStatus === 'pending').length,
          totalRevenue: totalRevenue
        },
        dailyBreakdown: Object.values(dailyBreakdown).sort((a, b) => 
          new Date(b.date) - new Date(a.date)
        )
      });
      
    } catch (error) {
      console.error('Get reconciliation summary error:', error);
      res.status(500).json({ error: 'Failed to fetch reconciliation summary' });
    }
  };
  
  runMiddleware();
});

// GET /api/admin/reports/pi-data/:storeId - OLD ENDPOINT (compatibility)
router.get('/pi-data/:storeId', async (req, res, next) => {
  const middlewares = [
    ...createVenueMiddleware({ action: 'view_reports' })
  ];
  
  let index = 0;
  const runMiddleware = (err) => {
    if (err) return next(err);
    if (index >= middlewares.length) return handler(req, res, next);
    const middleware = middlewares[index++];
    middleware(req, res, runMiddleware);
  };
  
  const handler = async (req, res) => {
    try {
      const { storeId } = req.params;
      const { date, days } = req.query;
      
      // If asking for available dates
      if (days && !date) {
        // Return last N days that have events
        const daysAgo = new Date();
        daysAgo.setDate(daysAgo.getDate() - parseInt(days));
        
        const events = await Event.aggregate([
          {
            $match: {
              storeId: storeId,
              timestamp: { $gte: daysAgo },
              eventType: { $in: ['money_in', 'collect'] }
            }
          },
          {
            $group: {
              _id: { $dateToString: { format: "%Y-%m-%d", date: "$timestamp" } },
              count: { $sum: 1 }
            }
          },
          { $sort: { _id: -1 } }
        ]);
        
        return res.json({
          success: true,
          availableDates: events.map(e => ({
            date: e._id,
            hasData: e.count > 0,
            eventCount: e.count
          }))
        });
      }
      
      // If asking for specific date's report
      if (date) {
        const summary = await Event.getDailySummary(storeId, date);
        
        return res.json({
          success: true,
          report: {
            date: date,
            storeId: storeId,
            piData: {
              grossRevenue: summary.totalRevenue,
              eventCount: summary.eventCount,
              machineBreakdown: summary.machineData,
              dataQuality: {
                score: summary.eventCount > 0 ? 95 : 0,
                issues: []
              }
            },
            calculatedSoftwareFee: summary.totalRevenue * 0.05 // 5% default
          }
        });
      }
      
      res.status(400).json({ error: 'date or days parameter required' });
    } catch (error) {
      console.error('Get pi-data error:', error);
      res.status(500).json({ error: 'Failed to fetch pi data' });
    }
  };
  
  runMiddleware();
});


// GET /api/admin/reports/:storeId/financial-summary
// Calculate daily financial summary with proper period status handling
router.get('/:storeId/financial-summary', async (req, res, next) => {
  const middlewares = [
    ...createVenueMiddleware({ action: 'view_reports' })
  ];
  
  let index = 0;
  const runMiddleware = (err) => {
    if (err) return next(err);
    if (index >= middlewares.length) return handler(req, res, next);
    const middleware = middlewares[index++];
    middleware(req, res, runMiddleware);
  };
  
  const handler = async (req, res) => {
    try {
      const { storeId } = req.params;
      const { date } = req.query;
      
      // Parse date or use today
      const targetDate = date ? new Date(date) : new Date();
      if (isNaN(targetDate.getTime())) {
        return res.status(400).json({ 
          error: 'Invalid date format',
          message: 'Date must be in YYYY-MM-DD format'
        });
      }
      
      const startOfDay = new Date(targetDate);
      startOfDay.setHours(0, 0, 0, 0);
      
      const endOfDay = new Date(targetDate);
      endOfDay.setHours(23, 59, 59, 999);
      
      const dateStr = startOfDay.toISOString().split('T')[0];
      console.log(`💰 Calculating financial summary for ${storeId} on ${dateStr}`);
      
      // Get store for fee percentage
      const Store = require('../../models/Store');
      const store = await Store.findOne({ storeId }).lean();
      if (!store) {
        return res.status(404).json({ error: 'Store not found' });
      }
      
      const feePercentage = store.feePercentage || 0;
      
      // Check for included daily reports
      const includedReports = await DailyReport.find({
        storeId: storeId,
        reportDate: {
          $gte: startOfDay,
          $lte: endOfDay
        },
        reconciliationStatus: 'included'
      }).lean();
      
      const reportCount = includedReports.length;
      const moneyIn = includedReports.reduce((sum, r) => sum + (r.totalRevenue || 0), 0);
      
      // Get voucher events regardless of report status
      const voucherEvents = await Event.find({
        storeId: storeId,
        eventType: { $in: ['voucher_print', 'voucher'] },
        timestamp: {
          $gte: startOfDay,
          $lte: endOfDay
        }
      }).lean();
      
      const moneyOut = voucherEvents.reduce((sum, e) => sum + (e.amount || 0), 0);
      const voucherCount = voucherEvents.length;
      
      // Determine period status
      const periodStatus = reportCount > 0 ? 'closed' : 'open';
      
      console.log(`   📊 Period Status: ${periodStatus}`);
      console.log(`   Reports: ${reportCount}, Vouchers: ${voucherCount}`);
      
      // If period is still open (no daily report), return partial data
      if (periodStatus === 'open') {
        return res.json({
          success: true,
          summary: {
            date: dateStr,
            storeId: storeId,
            storeName: store.storeName,
            status: 'open',
            message: 'Daily report not yet submitted for this date',
            
            // Partial data only
            voucherCount: voucherCount,
            voucherTotal: parseFloat(moneyOut.toFixed(2)),
            
            // No financial calculations until period is closed
            moneyIn: null,
            moneyOut: null,
            netRevenue: null,
            gambinoFee: null,
            storeKeeps: null,
            feePercentage: feePercentage,
            reportCount: 0,
            
            calculatedAt: new Date().toISOString()
          }
        });
      }
      
      // Period is closed - calculate full financial summary
      const netRevenue = moneyIn - moneyOut;
      const gambinoFee = netRevenue * (feePercentage / 100);
      const storeKeeps = netRevenue - gambinoFee;
      
      console.log(`   💵 Money IN: $${moneyIn.toFixed(2)} from ${reportCount} reports`);
      console.log(`   🎫 Money OUT: $${moneyOut.toFixed(2)} from ${voucherCount} vouchers`);
      console.log(`   💰 Net Revenue: $${netRevenue.toFixed(2)}`);
      
      res.json({
        success: true,
        summary: {
          date: dateStr,
          storeId: storeId,
          storeName: store.storeName,
          status: 'closed',
          
          // Full financial data
          moneyIn: parseFloat(moneyIn.toFixed(2)),
          moneyOut: parseFloat(moneyOut.toFixed(2)),
          netRevenue: parseFloat(netRevenue.toFixed(2)),
          gambinoFee: parseFloat(gambinoFee.toFixed(2)),
          storeKeeps: parseFloat(storeKeeps.toFixed(2)),
          
          feePercentage: feePercentage,
          reportCount: reportCount,
          voucherCount: voucherCount,
          voucherTotal: parseFloat(moneyOut.toFixed(2)),
          
          reportIds: includedReports.map(r => r._id),
          calculatedAt: new Date().toISOString()
        }
      });
      
    } catch (error) {
      console.error('❌ Financial summary error:', error);
      res.status(500).json({ 
        error: 'Failed to calculate financial summary',
        message: error.message 
      });
    }
  };
  
  runMiddleware();
});

// ✅ NEW ENDPOINT: GET /api/admin/reports/:storeId/daily-latest/:date
// Get latest cumulative values for each machine on a specific date with deltas
router.get('/:storeId/daily-latest/:date', async (req, res, next) => {
  const middlewares = [
    ...createVenueMiddleware({ action: 'view_reports' })
  ];
  
  let index = 0;
  const runMiddleware = (err) => {
    if (err) return next(err);
    if (index >= middlewares.length) return handler(req, res, next);
    const middleware = middlewares[index++];
    middleware(req, res, runMiddleware);
  };
  
  const handler = async (req, res) => {
    try {
      const { storeId, date } = req.params;
      
      const targetDate = new Date(date);
      if (isNaN(targetDate.getTime())) {
        return res.status(400).json({ 
          error: 'Invalid date format',
          message: 'Date must be in YYYY-MM-DD format'
        });
      }
      
      const startOfDay = new Date(targetDate);
      startOfDay.setHours(0, 0, 0, 0);
      
      const endOfDay = new Date(targetDate);
      endOfDay.setHours(23, 59, 59, 999);
      
      console.log(`📊 Getting latest daily values for ${storeId} on ${date}`);
      
      // Get ALL money_in events for the day, sorted by timestamp (oldest first)
      const moneyInEvents = await Event.find({
        storeId: storeId,
        eventType: 'money_in',
        timestamp: { $gte: startOfDay, $lte: endOfDay }
      }).sort({ timestamp: 1 }).lean();
      
      // Get ALL money_out events for the day
      const moneyOutEvents = await Event.find({
        storeId: storeId,
        eventType: { $in: ['money_out', 'voucher_print', 'voucher'] },
        timestamp: { $gte: startOfDay, $lte: endOfDay }
      }).sort({ timestamp: 1 }).lean();
      
      // Process events to get latest values and calculate deltas
      const machineData = {};
      
      // Process money_in events
      moneyInEvents.forEach(event => {
        const machineId = event.gamingMachineId;
        
        if (!machineData[machineId]) {
          machineData[machineId] = {
            machineId,
            moneyInHistory: [],
            moneyOutHistory: []
          };
        }
        
        machineData[machineId].moneyInHistory.push({
          amount: event.amount,
          timestamp: event.timestamp
        });
      });
      
      // Process money_out events
      moneyOutEvents.forEach(event => {
        const machineId = event.gamingMachineId;
        
        if (!machineData[machineId]) {
          machineData[machineId] = {
            machineId,
            moneyInHistory: [],
            moneyOutHistory: []
          };
        }
        
        machineData[machineId].moneyOutHistory.push({
          amount: event.amount,
          timestamp: event.timestamp
        });
      });
      
      // Build response with latest values and deltas
      const machines = Object.keys(machineData).map(machineId => {
        const data = machineData[machineId];
        
        // Get latest money_in (last report of the day)
        const moneyInHistory = data.moneyInHistory;
        const latestMoneyIn = moneyInHistory.length > 0 
          ? moneyInHistory[moneyInHistory.length - 1].amount 
          : 0;
        const previousMoneyIn = moneyInHistory.length > 1 
          ? moneyInHistory[moneyInHistory.length - 2].amount 
          : 0;
        const moneyInDelta = latestMoneyIn - previousMoneyIn;
        
        // Get latest money_out
        const moneyOutHistory = data.moneyOutHistory;
        const latestMoneyOut = moneyOutHistory.length > 0 
          ? moneyOutHistory[moneyOutHistory.length - 1].amount 
          : 0;
        const previousMoneyOut = moneyOutHistory.length > 1 
          ? moneyOutHistory[moneyOutHistory.length - 2].amount 
          : 0;
        const moneyOutDelta = latestMoneyOut - previousMoneyOut;
        
        return {
          machineId,
          moneyIn: parseFloat(latestMoneyIn.toFixed(2)),
          moneyOut: parseFloat(latestMoneyOut.toFixed(2)),
          netRevenue: parseFloat((latestMoneyIn - latestMoneyOut).toFixed(2)),
          reportCount: moneyInHistory.length,
          lastReportTime: moneyInHistory.length > 0 
            ? moneyInHistory[moneyInHistory.length - 1].timestamp 
            : null,
          // Delta information
          changesSinceLastReport: {
            moneyInDelta: parseFloat(moneyInDelta.toFixed(2)),
            moneyOutDelta: parseFloat(moneyOutDelta.toFixed(2)),
            netDelta: parseFloat((moneyInDelta - moneyOutDelta).toFixed(2)),
            hasMultipleReports: moneyInHistory.length > 1
          }
        };
      });
      
      // Calculate totals
      const totalMoneyIn = machines.reduce((sum, m) => sum + m.moneyIn, 0);
      const totalMoneyOut = machines.reduce((sum, m) => sum + m.moneyOut, 0);
      const totalNetRevenue = totalMoneyIn - totalMoneyOut;
      
      // Calculate total deltas
      const totalMoneyInDelta = machines.reduce((sum, m) => 
        sum + m.changesSinceLastReport.moneyInDelta, 0
      );
      const totalMoneyOutDelta = machines.reduce((sum, m) => 
        sum + m.changesSinceLastReport.moneyOutDelta, 0
      );
      
      console.log(`   📊 Found ${machines.length} machines with data`);
      console.log(`   💵 Total Money IN: $${totalMoneyIn.toFixed(2)}`);
      console.log(`   🎫 Total Money OUT: $${totalMoneyOut.toFixed(2)}`);
      console.log(`   💰 Net Revenue: $${totalNetRevenue.toFixed(2)}`);
      
      res.json({
        success: true,
        date: date,
        storeId: storeId,
        totalMoneyIn: parseFloat(totalMoneyIn.toFixed(2)),
        totalMoneyOut: parseFloat(totalMoneyOut.toFixed(2)),
        netRevenue: parseFloat(totalNetRevenue.toFixed(2)),
        totalReports: moneyInEvents.length,
        machines: machines.sort((a, b) => b.netRevenue - a.netRevenue), // Sort by net revenue
        changesSinceLastReport: {
          moneyInDelta: parseFloat(totalMoneyInDelta.toFixed(2)),
          moneyOutDelta: parseFloat(totalMoneyOutDelta.toFixed(2)),
          netDelta: parseFloat((totalMoneyInDelta - totalMoneyOutDelta).toFixed(2))
        },
        lastReportTime: machines.length > 0 
          ? Math.max(...machines.map(m => new Date(m.lastReportTime).getTime()))
          : null
      });
      
    } catch (error) {
      console.error('❌ Error getting latest daily values:', error);
      res.status(500).json({ 
        error: 'Failed to get latest daily values',
        message: error.message 
      });
    }
  };
  
  runMiddleware();
});

/**
 * GET /api/admin/reports/:storeId/cumulative/:date
 * Get TRUE 24-hour cumulative totals using real-time events
 * This gives accurate totals regardless of when daily reports were printed
 */
router.get('/:storeId/cumulative/:date', async (req, res, next) => {
  const middlewares = [
    ...createVenueMiddleware({ action: 'view_reports' })
  ];
  
  let index = 0;
  const runMiddleware = (err) => {
    if (err) return next(err);
    if (index >= middlewares.length) return handler(req, res, next);
    const middleware = middlewares[index++];
    middleware(req, res, runMiddleware);
  };
  
  const handler = async (req, res) => {
    try {
      const { storeId, date } = req.params;
      
      const targetDate = new Date(date);
      if (isNaN(targetDate.getTime())) {
        return res.status(400).json({ 
          error: 'Invalid date format',
          message: 'Date must be in YYYY-MM-DD format'
        });
      }
      
      const startOfDay = new Date(targetDate);
      startOfDay.setHours(0, 0, 0, 0);
      
      const endOfDay = new Date(targetDate);
      endOfDay.setHours(23, 59, 59, 999);
      
      console.log(`📊 Fetching cumulative totals for ${storeId} on ${date}`);
      
      const results = await Event.aggregate([
        {
          $match: {
            storeId: storeId,
            timestamp: { $gte: startOfDay, $lte: endOfDay },
            eventType: { $in: ['money_in', 'money_out', 'voucher_print'] }
          }
        },
        {
          $group: {
            _id: { machineId: '$gamingMachineId', eventType: '$eventType' },
            totalAmount: { $sum: '$amount' },
            count: { $sum: 1 },
            lastTimestamp: { $max: '$timestamp' }
          }
        },
        { $sort: { '_id.machineId': 1, '_id.eventType': 1 } }
      ]);
      
      const machineData = {};
      let totalMoneyIn = 0;
      let totalMoneyOut = 0;
      let totalVouchers = 0;
      let voucherCount = 0;
      
      results.forEach(item => {
        const machineId = item._id.machineId;
        const eventType = item._id.eventType;
        
        if (!machineData[machineId]) {
          machineData[machineId] = {
            machineId: machineId,
            moneyIn: 0,
            moneyOut: 0,
            vouchers: 0,
            voucherCount: 0,
            netRevenue: 0,
            lastActivity: null
          };
        }
        
        if (eventType === 'money_in') {
          machineData[machineId].moneyIn = item.totalAmount;
          totalMoneyIn += item.totalAmount;
        } else if (eventType === 'money_out') {
          machineData[machineId].moneyOut = item.totalAmount;
          totalMoneyOut += item.totalAmount;
        } else if (eventType === 'voucher_print') {
          machineData[machineId].vouchers = item.totalAmount;
          machineData[machineId].voucherCount = item.count;
          totalVouchers += item.totalAmount;
          voucherCount += item.count;
        }
        
        if (!machineData[machineId].lastActivity || item.lastTimestamp > machineData[machineId].lastActivity) {
          machineData[machineId].lastActivity = item.lastTimestamp;
        }
      });
      
      Object.values(machineData).forEach(machine => {
        machine.netRevenue = machine.moneyIn - machine.moneyOut;
      });
      
      const machines = Object.values(machineData).sort((a, b) => b.netRevenue - a.netRevenue);
      const netRevenue = totalMoneyIn - totalMoneyOut;
      
      res.json({
        success: true,
        date: date,
        storeId: storeId,
        dataSource: 'real_time_events',
        totalMoneyIn: totalMoneyIn,
        totalMoneyOut: totalMoneyOut,
        netRevenue: netRevenue,
        voucherCount: voucherCount,
        voucherTotal: totalVouchers,
        machines: machines
      });
      
    } catch (error) {
      console.error('❌ Error fetching cumulative totals:', error);
      res.status(500).json({ 
        error: 'Failed to fetch cumulative totals',
        message: error.message 
      });
    }
  };
  
  runMiddleware();
});

module.exports = { 
  router, 
  setupMiddleware, 
  setupModels 
};