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
      
      // Get store timezone for proper date handling
      const Store = require('../../models/Store');
      const store = await Store.findOne({ storeId });
      const timezone = store?.timezone || 'America/Chicago';
      
      // Timezone offsets (simplified)
      const tzOffsets = { 'America/New_York': -5, 'America/Chicago': -6, 'America/Denver': -7, 'America/Los_Angeles': -8 };
      const offsetHours = tzOffsets[timezone] || -6;
      
      // Convert local date to UTC range
      const startOfDay = new Date(date + 'T00:00:00Z');
      startOfDay.setUTCHours(startOfDay.getUTCHours() - offsetHours);
      const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000 - 1);
      
      console.log(`📊 Cumulative for ${storeId} on ${date} (TZ: ${timezone})`);

      // Query dailyreports for all reports on this day (may be from multiple hubs)
      const reports = await DailyReport.find({
        storeId: storeId,
        printedAt: { $gte: startOfDay, $lte: endOfDay },
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

      // IMPORTANT: Daily reports contain CUMULATIVE values (running totals), not individual transactions
      // Strategy:
      // 1. If reports have hubId, group by hubId and take latest report from each hub
      // 2. For reports without hubId (legacy), just use the single most recent report
      //    (until hubId tracking is in place for proper multi-hub aggregation)

      // Separate reports with hubId from those without
      const reportsWithHubId = reports.filter(r => r.hubId);
      const reportsWithoutHubId = reports.filter(r => !r.hubId);

      // For reports WITH hubId: group by hub, take only latest per hub
      const latestByHub = new Map(); // hubId -> report
      for (const report of reportsWithHubId) {
        const existing = latestByHub.get(report.hubId);
        if (!existing || new Date(report.printedAt) > new Date(existing.printedAt)) {
          latestByHub.set(report.hubId, report);
        }
      }

      // Aggregate results
      const allMachines = new Map();
      let totalMoneyIn = 0;
      let totalMoneyOut = 0;
      let totalNetRevenue = 0;

      // Add from hub-based reports (with hubId)
      for (const report of latestByHub.values()) {
        // Calculate from machine data, excluding grand_total
        const machinesOnly = (report.machineData || []).filter(m => m.machineId !== 'grand_total');
        totalMoneyIn += machinesOnly.reduce((sum, m) => sum + (m.moneyIn || 0), 0);
        totalMoneyOut += machinesOnly.reduce((sum, m) => sum + (m.collect || 0), 0);
        totalNetRevenue += machinesOnly.reduce((sum, m) => sum + ((m.moneyIn || 0) - (m.collect || 0)), 0);
        for (const machine of machinesOnly) {
          allMachines.set(machine.machineId, machine);
        }
      }

      // For legacy reports (without hubId): different logic for today vs past
      // Today: show latest report (current accumulating data after clearing)
      // Past: show report with most machines (final totals for that period)
      if (reportsWithoutHubId.length > 0 && latestByHub.size === 0) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const isToday = targetDate >= today;
        
        if (isToday) {
          // For today, show the latest report (post-clearing accumulating data)
          reportsWithoutHubId.sort((a, b) => new Date(b.printedAt) - new Date(a.printedAt));
        } else {
          // For past days, show report with most machines (final totals)
          reportsWithoutHubId.sort((a, b) => {
            if (b.machineCount !== a.machineCount) return b.machineCount - a.machineCount;
            return new Date(b.printedAt) - new Date(a.printedAt);
          });
        }
        const latestReport = reportsWithoutHubId[0];

        // Calculate from machine data, excluding grand_total
        const legacyMachines = (latestReport.machineData || []).filter(m => m.machineId !== 'grand_total');
        totalMoneyIn = legacyMachines.reduce((sum, m) => sum + (m.moneyIn || 0), 0);
        totalMoneyOut = legacyMachines.reduce((sum, m) => sum + (m.collect || 0), 0);
        totalNetRevenue = legacyMachines.reduce((sum, m) => sum + ((m.moneyIn || 0) - (m.collect || 0)), 0);

        for (const machine of (latestReport.machineData || [])) {
          if (machine.machineId !== 'grand_total') {
            allMachines.set(machine.machineId, machine);
          }
        }
      }

      const hubCount = latestByHub.size || 1;
      console.log(`   📊 Found ${reports.length} reports: ${reportsWithHubId.length} with hubId (${latestByHub.size} hubs), ${reportsWithoutHubId.length} legacy`);
      console.log(`   📊 Totals - IN: $${totalMoneyIn}, OUT: $${totalMoneyOut}, Net: $${totalNetRevenue}, Machines: ${allMachines.size}`);

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
        hubCount: hubCount,
        machineCount: allMachines.size,
        reportCount: reports.length,
        totalMoneyIn: totalMoneyIn,
        totalMoneyOut: totalMoneyOut,
        netRevenue: totalNetRevenue,
        voucherCount: voucherCount,
        voucherTotal: voucherTotal,
        machines: Array.from(allMachines.values())
      });
    } catch (error) {
      console.error('❌ Error fetching cumulative totals:', error);
      res.status(500).json({ error: 'Failed to fetch cumulative totals', message: error.message });
    }
  };
  runMiddleware();
});

// Date Range Cumulative - aggregates data across multiple days in single query
// Also aggregates across multiple hubs for multi-Pi venues
router.get('/:storeId/cumulative-range', async (req, res, next) => {
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
        return res.status(400).json({
          error: 'startDate and endDate query parameters are required (format: YYYY-MM-DD)'
        });
      }

      const start = new Date(startDate);
      const end = new Date(endDate);

      if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        return res.status(400).json({ error: 'Invalid date format', message: 'Dates must be in YYYY-MM-DD format' });
      }

      start.setHours(0, 0, 0, 0);
      end.setHours(23, 59, 59, 999);

      console.log(`📊 Cumulative range for ${storeId}: ${startDate} to ${endDate}`);

      // Get all reports in range
      const reports = await DailyReport.find({
        storeId: storeId,
        reportDate: { $gte: start, $lte: end },
        reconciliationStatus: { $ne: 'excluded' }
      }).sort({ reportDate: 1, printedAt: -1 }).lean();

      // Group by date AND hub - get latest report per hub per day
      const reportsByDateAndHub = {};
      reports.forEach(report => {
        const dateKey = report.reportDate.toISOString().split('T')[0];
        // Extract hub from idempotencyKey (format: storeId_date_hubId)
        const keyParts = (report.idempotencyKey || '').split('_');
        const hubKey = keyParts.length >= 3 ? keyParts[2] : report._id.toString();
        const compositeKey = `${dateKey}_${hubKey}`;

        if (!reportsByDateAndHub[compositeKey] || new Date(report.printedAt) > new Date(reportsByDateAndHub[compositeKey].printedAt)) {
          reportsByDateAndHub[compositeKey] = { ...report, dateKey, hubKey };
        }
      });

      const latestReports = Object.values(reportsByDateAndHub);

      // Group by date for daily breakdown (aggregate hubs per day)
      const dailyData = {};
      latestReports.forEach(report => {
        const dateKey = report.dateKey;
        if (!dailyData[dateKey]) {
          dailyData[dateKey] = {
            date: dateKey,
            moneyIn: 0,
            moneyOut: 0,
            netRevenue: 0,
            machineCount: 0,
            hubCount: 0
          };
        }
        // Calculate from machine data, excluding grand_total
        const dailyMachinesOnly = (report.machineData || []).filter(m => m.machineId !== 'grand_total');
        dailyData[dateKey].moneyIn += dailyMachinesOnly.reduce((sum, m) => sum + (m.moneyIn || 0), 0);
        dailyData[dateKey].moneyOut += dailyMachinesOnly.reduce((sum, m) => sum + (m.collect || 0), 0);
        dailyData[dateKey].netRevenue += dailyMachinesOnly.reduce((sum, m) => sum + ((m.moneyIn || 0) - (m.collect || 0)), 0);
        dailyData[dateKey].machineCount += dailyMachinesOnly.length;
        dailyData[dateKey].hubCount += 1;
      });

      // Aggregate totals and machine data
      let totalMoneyIn = 0;
      let totalMoneyOut = 0;
      let totalNetRevenue = 0;
      const machineAggregates = {};

      latestReports.forEach(report => {
        // Filter out grand_total from machine data for calculations
        const machinesOnly = (report.machineData || []).filter(m => m.machineId !== 'grand_total');
        
        // Calculate totals from individual machines (excluding grand_total)
        const reportMoneyIn = machinesOnly.reduce((sum, m) => sum + (m.moneyIn || 0), 0);
        const reportMoneyOut = machinesOnly.reduce((sum, m) => sum + (m.collect || 0), 0);
        
        totalMoneyIn += reportMoneyIn;
        totalMoneyOut += reportMoneyOut;
        totalNetRevenue += reportMoneyIn - reportMoneyOut;

        // Aggregate machine data (excluding grand_total)
        machinesOnly.forEach(machine => {
          const machineId = machine.machineId;
          if (!machineAggregates[machineId]) {
            machineAggregates[machineId] = { machineId, moneyIn: 0, collect: 0 };
          }
          machineAggregates[machineId].moneyIn += machine.moneyIn || 0;
          machineAggregates[machineId].collect += machine.collect || 0;
        });
      });

      // Get voucher events for the range
      const voucherEvents = await Event.find({
        storeId: storeId,
        eventType: { $in: ['voucher_print', 'voucher'] },
        timestamp: { $gte: start, $lte: end }
      }).lean();

      const voucherTotal = voucherEvents.reduce((sum, e) => sum + (e.amount || 0), 0);
      const voucherCount = voucherEvents.length;

      // Convert machine aggregates to array sorted by net revenue
      const machines = Object.values(machineAggregates)
        .map(m => ({
          machineId: m.machineId,
          moneyIn: m.moneyIn,
          collect: m.collect,
          netRevenue: m.moneyIn - m.collect
        }))
        .sort((a, b) => b.netRevenue - a.netRevenue);

      // Convert daily data to array sorted by date descending
      const dailyBreakdown = Object.values(dailyData).sort((a, b) => new Date(b.date) - new Date(a.date));

      // Count unique hubs across the range
      const uniqueHubs = new Set(latestReports.map(r => r.hubKey));

      console.log(`   📊 ${Object.keys(dailyData).length} days, ${uniqueHubs.size} hubs | IN: $${totalMoneyIn.toFixed(2)} | OUT: $${totalMoneyOut.toFixed(2)} | Net: $${totalNetRevenue.toFixed(2)} | Machines: ${machines.length}`);

      res.json({
        success: true,
        storeId: storeId,
        dateRange: { startDate, endDate },
        daysWithData: Object.keys(dailyData).length,
        hubCount: uniqueHubs.size,
        dataSource: 'daily_reports',
        totalMoneyIn: parseFloat(totalMoneyIn.toFixed(2)),
        totalMoneyOut: parseFloat(totalMoneyOut.toFixed(2)),
        netRevenue: parseFloat(totalNetRevenue.toFixed(2)),
        voucherCount: voucherCount,
        voucherTotal: parseFloat(voucherTotal.toFixed(2)),
        machines: machines,
        dailyBreakdown: dailyBreakdown
      });
    } catch (error) {
      console.error('❌ Error fetching cumulative range:', error);
      res.status(500).json({ error: 'Failed to fetch cumulative range', message: error.message });
    }
  };
  runMiddleware();
});


// ============================================================================
// Machine-Hub Mapping - Returns which machines belong to which Pi/Hub
// Uses Events collection to map gamingMachineId to hubMachineId
// ============================================================================
router.get('/:storeId/machine-hub-mapping', async (req, res, next) => {
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
      console.log('Getting machine-hub mapping for store:', storeId);

      const Hub = require('../../models/Hub');

      // Get machine-to-hub mapping from Events collection
      // Events have hubMachineId (the Pi) and gamingMachineId (the machine)
      const eventMappings = await Event.aggregate([
        {
          $match: {
            storeId: storeId,
            hubMachineId: { $exists: true, $ne: null },
            gamingMachineId: { $exists: true, $ne: null, $ne: 'unknown' }
          }
        },
        {
          $group: {
            _id: '$gamingMachineId',
            hubId: { $first: '$hubMachineId' }
          }
        }
      ]);

      // Build the mapping: machineId -> hubId
      const mapping = {};
      eventMappings.forEach(item => {
        if (item._id && item._id !== 'grand_total') {
          mapping[item._id] = item.hubId;
        }
      });

      // Get all hubs for this store to get their names
      const hubs = await Hub.find({ storeId: storeId }).select('hubId name').lean();

      // Build hubNames: hubId -> name
      const hubNames = {};
      hubs.forEach(hub => {
        hubNames[hub.hubId] = hub.name || hub.hubId;
      });

      // Also add any hubs found in events but not in Hub collection
      const uniqueHubs = [...new Set(Object.values(mapping))];
      uniqueHubs.forEach(hubId => {
        if (!hubNames[hubId]) {
          hubNames[hubId] = hubId;
        }
      });

      const mappingCount = Object.keys(mapping).length;
      const hubCount = Object.keys(hubNames).length;
      console.log('Found', mappingCount, 'machine mappings across', hubCount, 'hubs');

      res.json({
        success: true,
        storeId: storeId,
        mapping: mapping,
        hubNames: hubNames,
        stats: {
          mappedMachines: mappingCount,
          hubCount: hubCount
        }
      });
    } catch (error) {
      console.error('Error getting machine-hub mapping:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get machine-hub mapping',
        message: error.message
      });
    }
  };
  runMiddleware();
});

module.exports = { router, setupMiddleware, setupModels };
