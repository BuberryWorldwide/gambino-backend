// /opt/gambino/backend/src/services/BookkeepingProcessor.js
const BookkeepingReport = require('../models/BookkeepingReport');

class BookkeepingProcessor {
  
  // Get EST business date from timestamp
  getBusinessDate(timestamp) {
    const date = new Date(timestamp);
    // Convert to EST by subtracting 5 hours
    const estDate = new Date(date.getTime() - (5 * 60 * 60 * 1000));
    // Return date at midnight EST (which is 5am UTC)
    const year = estDate.getUTCFullYear();
    const month = estDate.getUTCMonth();
    const day = estDate.getUTCDate();
    return new Date(Date.UTC(year, month, day, 5, 0, 0, 0));
  }
  
  async processBookkeepingReport(storeId, machineId, eventData, sourceEventId = null) {
    const timestamp = eventData.timestamp ? new Date(eventData.timestamp) : new Date();
    const businessDate = this.getBusinessDate(timestamp);
    
    // Generate idempotency key
    const idempotencyKey = `bookkeeping_${storeId}_${machineId}_${timestamp.toISOString()}`;
    
    // Check for existing report
    const existing = await BookkeepingReport.findOne({ idempotencyKey });
    if (existing) {
      console.log(`📚 Bookkeeping report already exists: ${idempotencyKey}`);
      return existing;
    }
    
    // Extract lifetime values from event data
    const lifetimeIn = eventData.lifetimeIn || eventData.total_in || 0;
    const lifetimeOut = eventData.lifetimeOut || eventData.total_out || 0;
    const lifetimeGames = eventData.lifetimeGames || eventData.games || 0;
    
    const report = new BookkeepingReport({
      storeId,
      reportType: 'bookkeeping',
      timestamp,
      businessDate,
      idempotencyKey,
      totalLifetimeIn: lifetimeIn,
      totalLifetimeOut: lifetimeOut,
      totalLifetimeGames: lifetimeGames,
      machineData: [{
        machineId,
        lifetimeIn,
        lifetimeOut,
        lifetimeGames
      }],
      machineCount: 1,
      sourceEventId,
      rawData: eventData
    });
    
    await report.save();
    console.log(`📚 Bookkeeping report saved for store ${storeId}, machine ${machineId}`);
    console.log(`   Lifetime: $${lifetimeIn} in / $${lifetimeOut} out / ${lifetimeGames} games`);
    
    return report;
  }
  
  async processClearingEvent(storeId, machineId, eventData, sourceEventId = null) {
    const timestamp = eventData.timestamp ? new Date(eventData.timestamp) : new Date();
    const businessDate = this.getBusinessDate(timestamp);
    
    // Generate idempotency key
    const idempotencyKey = `clearing_${storeId}_${machineId}_${timestamp.toISOString()}`;
    
    // Check for existing report
    const existing = await BookkeepingReport.findOne({ idempotencyKey });
    if (existing) {
      console.log(`🧹 Clearing report already exists: ${idempotencyKey}`);
      return existing;
    }
    
    // Get the last bookkeeping report to determine what was cleared
    const lastBookkeeping = await BookkeepingReport.findOne({
      storeId,
      reportType: 'bookkeeping'
    }).sort({ timestamp: -1 });
    
    const clearedValues = lastBookkeeping ? {
      totalIn: lastBookkeeping.totalLifetimeIn,
      totalOut: lastBookkeeping.totalLifetimeOut,
      totalGames: lastBookkeeping.totalLifetimeGames
    } : { totalIn: 0, totalOut: 0, totalGames: 0 };
    
    const report = new BookkeepingReport({
      storeId,
      reportType: 'clearing',
      timestamp,
      businessDate,
      idempotencyKey,
      totalLifetimeIn: 0,
      totalLifetimeOut: 0,
      totalLifetimeGames: 0,
      machineData: [{
        machineId,
        lifetimeIn: 0,
        lifetimeOut: 0,
        lifetimeGames: 0
      }],
      machineCount: 1,
      clearedValues,
      sourceEventId,
      rawData: eventData
    });
    
    await report.save();
    console.log(`🧹 Clearing report saved for store ${storeId}, machine ${machineId}`);
    console.log(`   Cleared: $${clearedValues.totalIn} in / $${clearedValues.totalOut} out`);
    
    return report;
  }
}

module.exports = BookkeepingProcessor;
