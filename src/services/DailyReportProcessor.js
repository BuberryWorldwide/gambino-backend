const Event = require('../models/Event');
const DailyReport = require('../models/DailyReport');

class DailyReportProcessor {
  
  /**
   * Process daily summary events into a DailyReport record
   * Called when daily summary events arrive from Pi
   */
  async processDailySummaryEvents(storeId, hubId, timestamp) {
    try {
      const reportDate = new Date(timestamp);
      reportDate.setHours(0, 0, 0, 0);
      
      // FIXED: Look back 60 seconds instead of 2 minutes, and use a smarter batch window
      const batchStartTime = new Date(timestamp);
      batchStartTime.setSeconds(batchStartTime.getSeconds() - 60);
      
      const events = await Event.find({
        storeId,
        eventType: 'money_in',
        timestamp: { $gte: batchStartTime, $lte: new Date(timestamp) },
        'metadata.source': 'daily_report',
        processed: false
      }).sort({ timestamp: 1 });

      if (events.length === 0) {
        console.log('⚠️ No unprocessed daily summary events found');
        return null;
      }

      // FIXED: Check if there's already a recent report being built (within last 60 seconds)
      const recentReport = await DailyReport.findOne({
        storeId,
        printedAt: { $gte: batchStartTime },
        reconciliationStatus: 'pending'
      }).sort({ createdAt: -1 });

      if (recentReport) {
        console.log(`🔄 Adding to existing report: ${recentReport._id}`);
        
        // Add new machines to existing report
        for (const event of events) {
          const machineId = event.gamingMachineId;
          const existingMachine = recentReport.machineData.find(m => m.machineId === machineId);
          
          if (!existingMachine) {
            recentReport.machineData.push({
              machineId,
              moneyIn: event.amount || 0,
              collect: 0,
              netRevenue: event.amount || 0,
              transactionCount: 1
            });
          } else {
            existingMachine.moneyIn += event.amount || 0;
            existingMachine.netRevenue += event.amount || 0;
            existingMachine.transactionCount += 1;
          }
          
          recentReport.totalRevenue += event.amount || 0;
          recentReport.totalMoneyIn += event.amount || 0;
        }
        
        recentReport.machineCount = recentReport.machineData.length;
        recentReport.updatedAt = new Date();
        await recentReport.save();
        
        // Mark events as processed
        await Event.updateMany(
          { _id: { $in: events.map(e => e._id) } },
          { 
            $set: { 
              processed: true,
              processedAt: new Date(),
              generatedReportId: recentReport._id
            }
          }
        );
        
        console.log(`✅ Updated report ${recentReport._id}: now $${recentReport.totalRevenue.toFixed(2)} from ${recentReport.machineCount} machines`);
        return recentReport;
      }

      // Generate idempotency key for new report
      const idempotencyKey = `${storeId}_${reportDate.toISOString().split('T')[0]}_${Date.now()}`;

      // Group events by gaming machine
      const machineGroups = {};
      let totalMoneyIn = 0;
      
      for (const event of events) {
        const machineId = event.gamingMachineId;
        
        if (!machineGroups[machineId]) {
          machineGroups[machineId] = {
            machineId,
            moneyIn: 0,
            collect: 0,
            transactionCount: 0
          };
        }
        
        machineGroups[machineId].moneyIn += event.amount || 0;
        machineGroups[machineId].transactionCount += 1;
        totalMoneyIn += event.amount || 0;
      }

      // Calculate net revenue per machine
      const machineData = Object.values(machineGroups).map(machine => ({
        ...machine,
        netRevenue: machine.moneyIn - machine.collect
      }));

      // Create NEW DailyReport record
      const report = await DailyReport.create({
        storeId,
        reportDate,
        printedAt: new Date(timestamp),
        idempotencyKey,
        totalRevenue: totalMoneyIn,
        totalMoneyIn,
        totalCollect: 0,
        machineData,
        machineCount: Object.keys(machineGroups).length,
        reconciliationStatus: 'pending',
        qualityScore: this.calculateQualityScore(events, machineData),
        hasAnomalies: false,
        sourceEventId: events[0]._id
      });

      // Mark events as processed
      await Event.updateMany(
        { _id: { $in: events.map(e => e._id) } },
        { 
          $set: { 
            processed: true,
            processedAt: new Date(),
            generatedReportId: report._id
          }
        }
      );

      console.log(`✅ Created NEW DailyReport: ${report._id} - $${totalMoneyIn.toFixed(2)} from ${events.length} events, ${machineData.length} machines`);
      
      return report;

    } catch (error) {
      console.error('❌ Error processing daily summary:', error);
      throw error;
    }
  }

  calculateQualityScore(events, machineData) {
    let score = 100;
    
    const unmappedCount = events.filter(e => e.mappingStatus !== 'mapped').length;
    if (unmappedCount > 0) {
      score -= Math.min(30, unmappedCount * 5);
    }
    
    if (machineData.length === 0) {
      score -= 40;
    }
    
    return Math.max(0, score);
  }
}

module.exports = DailyReportProcessor;