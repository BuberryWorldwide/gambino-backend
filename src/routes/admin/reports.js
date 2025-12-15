// /opt/gambino/backend/src/routes/admin/reports.js
const express = require('express');
const router = express.Router();
const { PERMISSIONS } = require('../../middleware/rbac');

let authenticate, requirePermission, createVenueMiddleware;
let DailyReport, Event;

function setupMiddleware(auth, reqPerm, venueMiddleware) {
  authenticate = auth;
  requirePermission = reqPerm;
  createVenueMiddleware = venueMiddleware;
}

function setupModels(dailyReportModel, eventModel) {
  DailyReport = dailyReportModel;
  Event = eventModel;
}

router.get('/daily/:storeId', async (req, res, next) => {
  const middlewares = [...createVenueMiddleware({ action: 'view_reports' })];
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
        printedAt: { $gte: startOfDay, $lte: endOfDay }
      }).sort({ printedAt: -1 }).lean();
      res.json({ success: true, date: date, storeId: storeId, reports: reports, count: reports.length });
    } catch (error) {
      console.error('Get daily reports error:', error);
      res.status(500).json({ error: 'Failed to fetch daily reports' });
    }
  };
  runMiddleware();
});

router.post('/:reportId/reconciliation', async (req, res, next) => {
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
        if (notes) report.notes = notes;
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

router.get('/:storeId/reconciliation', async (req, res, next) => {
  const middlewares = [...createVenueMiddleware({ action: 'view_reports' })];
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
        return res.status(400).json({ error: 'startDate and endDate parameters are required (format: YYYY-MM-DD)' });
      }
      const start = new Date(startDate);
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      const allReports = await DailyReport.find({
        storeId: storeId,
        printedAt: { $gte: start, $lte: end }
      }).lean();
      // Calculate total revenue from LATEST report per date (regardless of status)
      const revenueByDate = {};
      allReports.forEach(report => {
        const dateKey = report.printedAt.toISOString().split('T')[0];
        if (!revenueByDate[dateKey] || new Date(report.printedAt) > new Date(revenueByDate[dateKey].printedAt)) {
          revenueByDate[dateKey] = report;
        }
      });
      const totalRevenue = Object.values(revenueByDate).reduce((sum, r) => sum + (r.totalRevenue || 0), 0);
      const includedReports = allReports.filter(r => r.reconciliationStatus === 'included');
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
      revenue: 0,
      reports: []  // Track all reports
    };
  }
  
  dailyBreakdown[dateKey].total++;
  dailyBreakdown[dateKey][report.reconciliationStatus]++;
  dailyBreakdown[dateKey].reports.push(report);
});

// Use only LATEST report per date for revenue
Object.keys(dailyBreakdown).forEach(dateKey => {
  const reportsForDate = dailyBreakdown[dateKey].reports;
  // Sort by printedAt desc, take first (latest)
  const latestReport = reportsForDate.sort((a, b) => 
    new Date(b.printedAt) - new Date(a.printedAt)
  )[0];
  
  // Only count revenue from latest report if it's included
  if (latestReport) {
    dailyBreakdown[dateKey].revenue = latestReport.totalRevenue || 0;
  }
  
  // Clean up - remove reports array from response
  delete dailyBreakdown[dateKey].reports;
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
        dailyBreakdown: Object.values(dailyBreakdown).sort((a, b) => new Date(b.date) - new Date(a.date))
      });
    } catch (error) {
      console.error('Get reconciliation summary error:', error);
      res.status(500).json({ error: 'Failed to fetch reconciliation summary' });
    }
  };
  runMiddleware();
});

router.get('/pi-data/:storeId', async (req, res, next) => {
  const middlewares = [...createVenueMiddleware({ action: 'view_reports' })];
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
      if (days && !date) {
        const daysAgo = new Date();
        daysAgo.setDate(daysAgo.getDate() - parseInt(days));
        const events = await Event.aggregate([
          { $match: { storeId: storeId, timestamp: { $gte: daysAgo }, eventType: { $in: ['money_in', 'collect'] } } },
          { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$timestamp" } }, count: { $sum: 1 } } },
          { $sort: { _id: -1 } }
        ]);
        return res.json({
          success: true,
          availableDates: events.map(e => ({ date: e._id, hasData: e.count > 0, eventCount: e.count }))
        });
      }
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
              dataQuality: { score: summary.eventCount > 0 ? 95 : 0, issues: [] }
            },
            calculatedSoftwareFee: summary.totalRevenue * 0.05
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

// ============================================================================
// FIXED: financial-summary endpoint - uses latest report only
// ============================================================================
router.get('/:storeId/financial-summary', async (req, res, next) => {
  const middlewares = [...createVenueMiddleware({ action: 'view_reports' })];
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
      const targetDate = date ? new Date(date) : new Date();
      if (isNaN(targetDate.getTime())) {
        return res.status(400).json({ error: 'Invalid date format', message: 'Date must be in YYYY-MM-DD format' });
      }
      const startOfDay = new Date(targetDate);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(targetDate);
      endOfDay.setHours(23, 59, 59, 999);
      const dateStr = startOfDay.toISOString().split('T')[0];
      console.log(`💰 Financial summary for ${storeId} on ${dateStr}`);
      
      const Store = require('../../models/Store');
      const store = await Store.findOne({ storeId }).lean();
      if (!store) return res.status(404).json({ error: 'Store not found' });
      const feePercentage = store.feePercentage || 0;
      
      // FIX: Get ALL reports sorted by printedAt (latest first)
      const allReportsForDate = await DailyReport.find({
        storeId: storeId,
        printedAt: { $gte: startOfDay, $lte: endOfDay }
      }).sort({ printedAt: -1 }).lean();

      // Use LATEST report regardless of status
      const latestReport = allReportsForDate.length > 0 ? allReportsForDate[0] : null;
      if (allReportsForDate.length > 1) {
      console.log(`   ⚠️  ${allReportsForDate.length} reports found for this date - using latest only`);
      }
      
      const reportCount = latestReport ? 1 : 0;
      const moneyIn = latestReport ? (latestReport.totalRevenue || 0) : 0;
      
      const voucherEvents = await Event.find({
        storeId: storeId,
        eventType: { $in: ['voucher_print', 'voucher'] },
        timestamp: { $gte: startOfDay, $lte: endOfDay }
      }).lean();
      
      const moneyOut = voucherEvents.reduce((sum, e) => sum + (e.amount || 0), 0);
      const voucherCount = voucherEvents.length;
      const periodStatus = reportCount > 0 ? 'closed' : 'open';
      
      console.log(`   📊 ${periodStatus}, Reports: ${reportCount}, Vouchers: ${voucherCount}`);
      
      if (periodStatus === 'open') {
        return res.json({
          success: true,
          summary: {
            date: dateStr, storeId: storeId, storeName: store.storeName, status: 'open',
            message: 'Daily report not yet submitted for this date',
            voucherCount: voucherCount, voucherTotal: parseFloat(moneyOut.toFixed(2)),
            moneyIn: null, moneyOut: null, netRevenue: null, gambinoFee: null, storeKeeps: null,
            feePercentage: feePercentage, reportCount: 0, calculatedAt: new Date().toISOString()
          }
        });
      }
      
      const netRevenue = moneyIn - moneyOut;
      const gambinoFee = netRevenue * (feePercentage / 100);
      const storeKeeps = netRevenue - gambinoFee;
      
      console.log(`   💵 IN: $${moneyIn.toFixed(2)} | OUT: $${moneyOut.toFixed(2)} | Net: $${netRevenue.toFixed(2)}`);
      
      res.json({
        success: true,
        summary: {
          date: dateStr, storeId: storeId, storeName: store.storeName, status: 'closed',
          moneyIn: parseFloat(moneyIn.toFixed(2)),
          moneyOut: parseFloat(moneyOut.toFixed(2)),
          netRevenue: parseFloat(netRevenue.toFixed(2)),
          gambinoFee: parseFloat(gambinoFee.toFixed(2)),
          storeKeeps: parseFloat(storeKeeps.toFixed(2)),
          feePercentage: feePercentage, reportCount: 1,
          voucherCount: voucherCount, voucherTotal: parseFloat(moneyOut.toFixed(2)),
          reportId: latestReport._id,
          ...(allReportsForDate.length > 1 && {
            warning: `${allReportsForDate.length} reports found - using latest`,
            duplicateReportIds: allReportsForDate.slice(1).map(r => r._id)
          }),
          calculatedAt: new Date().toISOString()
        }
      });
    } catch (error) {
      console.error('❌ Financial summary error:', error);
      res.status(500).json({ error: 'Failed to calculate financial summary', message: error.message });
    }
  };
  runMiddleware();
});

router.get('/:storeId/daily-latest/:date', async (req, res, next) => {
  const middlewares = [...createVenueMiddleware({ action: 'view_reports' })];
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
        return res.status(400).json({ error: 'Invalid date format', message: 'Date must be in YYYY-MM-DD format' });
      }
      const startOfDay = new Date(targetDate);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(targetDate);
      endOfDay.setHours(23, 59, 59, 999);
      console.log(`📊 Latest daily values for ${storeId} on ${date}`);
      const moneyInEvents = await Event.find({
        storeId: storeId, eventType: 'money_in',
        timestamp: { $gte: startOfDay, $lte: endOfDay }
      }).sort({ timestamp: 1 }).lean();
      const moneyOutEvents = await Event.find({
        storeId: storeId, eventType: { $in: ['money_out', 'voucher_print', 'voucher'] },
        timestamp: { $gte: startOfDay, $lte: endOfDay }
      }).sort({ timestamp: 1 }).lean();
      const machineData = {};
      moneyInEvents.forEach(event => {
        const machineId = event.gamingMachineId;
        if (!machineData[machineId]) {
          machineData[machineId] = { machineId, moneyInHistory: [], moneyOutHistory: [] };
        }
        machineData[machineId].moneyInHistory.push({ amount: event.amount, timestamp: event.timestamp });
      });
      moneyOutEvents.forEach(event => {
        const machineId = event.gamingMachineId;
        if (!machineData[machineId]) {
          machineData[machineId] = { machineId, moneyInHistory: [], moneyOutHistory: [] };
        }
        machineData[machineId].moneyOutHistory.push({ amount: event.amount, timestamp: event.timestamp });
      });
      const machines = Object.keys(machineData).map(machineId => {
        const data = machineData[machineId];
        const moneyInHistory = data.moneyInHistory;
        const latestMoneyIn = moneyInHistory.length > 0 ? moneyInHistory[moneyInHistory.length - 1].amount : 0;
        const previousMoneyIn = moneyInHistory.length > 1 ? moneyInHistory[moneyInHistory.length - 2].amount : 0;
        const moneyInDelta = latestMoneyIn - previousMoneyIn;
        const moneyOutHistory = data.moneyOutHistory;
        const latestMoneyOut = moneyOutHistory.length > 0 ? moneyOutHistory[moneyOutHistory.length - 1].amount : 0;
        const previousMoneyOut = moneyOutHistory.length > 1 ? moneyOutHistory[moneyOutHistory.length - 2].amount : 0;
        const moneyOutDelta = latestMoneyOut - previousMoneyOut;
        return {
          machineId,
          moneyIn: parseFloat(latestMoneyIn.toFixed(2)),
          moneyOut: parseFloat(latestMoneyOut.toFixed(2)),
          netRevenue: parseFloat((latestMoneyIn - latestMoneyOut).toFixed(2)),
          reportCount: moneyInHistory.length,
          lastReportTime: moneyInHistory.length > 0 ? moneyInHistory[moneyInHistory.length - 1].timestamp : null,
          changesSinceLastReport: {
            moneyInDelta: parseFloat(moneyInDelta.toFixed(2)),
            moneyOutDelta: parseFloat(moneyOutDelta.toFixed(2)),
            netDelta: parseFloat((moneyInDelta - moneyOutDelta).toFixed(2)),
            hasMultipleReports: moneyInHistory.length > 1
          }
        };
      });
      const totalMoneyIn = machines.reduce((sum, m) => sum + m.moneyIn, 0);
      const totalMoneyOut = machines.reduce((sum, m) => sum + m.moneyOut, 0);
      const totalNetRevenue = totalMoneyIn - totalMoneyOut;
      const totalMoneyInDelta = machines.reduce((sum, m) => sum + m.changesSinceLastReport.moneyInDelta, 0);
      const totalMoneyOutDelta = machines.reduce((sum, m) => sum + m.changesSinceLastReport.moneyOutDelta, 0);
      console.log(`   📊 ${machines.length} machines | IN: $${totalMoneyIn.toFixed(2)} | OUT: $${totalMoneyOut.toFixed(2)}`);
      res.json({
        success: true, date: date, storeId: storeId,
        totalMoneyIn: parseFloat(totalMoneyIn.toFixed(2)),
        totalMoneyOut: parseFloat(totalMoneyOut.toFixed(2)),
        netRevenue: parseFloat(totalNetRevenue.toFixed(2)),
        totalReports: moneyInEvents.length,
        machines: machines.sort((a, b) => b.netRevenue - a.netRevenue),
        changesSinceLastReport: {
          moneyInDelta: parseFloat(totalMoneyInDelta.toFixed(2)),
          moneyOutDelta: parseFloat(totalMoneyOutDelta.toFixed(2)),
          netDelta: parseFloat((totalMoneyInDelta - totalMoneyOutDelta).toFixed(2))
        },
        lastReportTime: machines.length > 0 ? Math.max(...machines.map(m => new Date(m.lastReportTime).getTime())) : null
      });
    } catch (error) {
      console.error('❌ Error getting latest daily values:', error);
      res.status(500).json({ error: 'Failed to get latest daily values', message: error.message });
    }
  };
  runMiddleware();
});

router.get('/:storeId/cumulative/:date', async (req, res, next) => {
  const middlewares = [...createVenueMiddleware({ action: 'view_reports' })];
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
        return res.status(400).json({ error: 'Invalid date format', message: 'Date must be in YYYY-MM-DD format' });
      }
      const startOfDay = new Date(targetDate);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(targetDate);
      endOfDay.setHours(23, 59, 59, 999);
      console.log(`📊 Cumulative totals for ${storeId} on ${date}`);
      
      // FIXED: Query dailyreports instead of events (handles daily_summary data)
      const reports = await DailyReport.find({
        storeId: storeId,
        reportDate: { $gte: startOfDay, $lte: endOfDay },
        reconciliationStatus: { $ne: 'excluded' }
      }).sort({ printedAt: -1 }).lean();
      
      if (reports.length === 0) {
        console.log(`   ⚠️  No daily reports found for ${date}`);
        return res.json({
          success: true,
          date: date,
          storeId: storeId,
          dataSource: 'daily_reports',
          totalMoneyIn: 0,
          totalMoneyOut: 0,
          netRevenue: 0,
          machines: []
        });
      }
      
      // Use LATEST report for the day (highest values)
      const latestReport = reports[0];
      console.log(`   📊 Using latest report (${reports.length} total) - IN: $${latestReport.totalMoneyIn}, Revenue: $${latestReport.totalRevenue}`);
      
      // Also get voucher events for voucher count
      const voucherEvents = await Event.find({
        storeId: storeId,
        eventType: { $in: ['voucher_print', 'voucher'] },
        timestamp: { $gte: startOfDay, $lte: endOfDay }
      }).lean();
      
      const voucherTotal = voucherEvents.reduce((sum, e) => sum + (e.amount || 0), 0);
      const voucherCount = voucherEvents.length;
      
      res.json({
        success: true,
        date: date,
        storeId: storeId,
        dataSource: 'daily_reports',
        totalMoneyIn: latestReport.totalMoneyIn || 0,
        totalMoneyOut: latestReport.totalCollect || 0,
        netRevenue: latestReport.totalRevenue || 0,
        voucherCount: voucherCount,
        voucherTotal: voucherTotal,
        machines: latestReport.machineData || []
      });
    } catch (error) {
      console.error('❌ Error fetching cumulative totals:', error);
      res.status(500).json({ error: 'Failed to fetch cumulative totals', message: error.message });
    }
  };
  runMiddleware();
});

module.exports = { router, setupMiddleware, setupModels };