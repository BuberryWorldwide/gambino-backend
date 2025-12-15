require('dotenv').config();
const mongoose = require('mongoose');

async function reprocess() {
  await mongoose.connect(process.env.MONGODB_URI);
  
  const Event = require('./src/models/Event');
  const DailyReport = require('./src/models/DailyReport');
  
  // Find unprocessed grand_total events
  const events = await Event.find({
    eventType: 'daily_summary',
    gamingMachineId: 'grand_total',
    processed: false,
    'metadata.source': 'daily_report'
  }).sort({ timestamp: 1 });
  
  console.log(`Found ${events.length} unprocessed grand total events`);
  
  // Group by store and date
  const groups = {};
  for (const event of events) {
    const date = new Date(event.timestamp).toISOString().split('T')[0];
    const key = `${event.storeId}_${date}`;
    if (!groups[key]) groups[key] = { events: [], storeId: event.storeId, date };
    groups[key].events.push(event);
  }
  
  console.log(`Processing ${Object.keys(groups).length} store-days\n`);
  
  for (const [key, group] of Object.entries(groups)) {
    // Take the LAST event for the day (highest cumulative values)
    const latestEvent = group.events[group.events.length - 1];
    
    console.log(`Processing ${group.storeId} for ${group.date}`);
    console.log(`  Raw: ${latestEvent.rawData}`);
    
    // Parse IN and OUT from rawData
    const inMatch = latestEvent.rawData.match(/In:\s*\$?(\d+)/i);
    const outMatch = latestEvent.rawData.match(/Out:\s*\$?(\d+)/i);
    
    const moneyIn = inMatch ? parseInt(inMatch[1]) : latestEvent.amount;
    const moneyOut = outMatch ? parseInt(outMatch[1]) : 0;
    
    console.log(`  Parsed: IN=$${moneyIn}, OUT=$${moneyOut}, Net=$${moneyIn - moneyOut}`);
    
    // Create DailyReport
    const reportDate = new Date(group.date);
    reportDate.setHours(0, 0, 0, 0);
    
    const report = await DailyReport.create({
      storeId: group.storeId,
      reportDate: reportDate,
      printedAt: latestEvent.timestamp,
      idempotencyKey: `${group.storeId}_${group.date}_reprocessed_${Date.now()}`,
      totalRevenue: moneyIn - moneyOut,
      totalMoneyIn: moneyIn,
      totalCollect: moneyOut,
      machineData: [{
        machineId: 'grand_total',
        moneyIn: moneyIn,
        collect: moneyOut,
        netRevenue: moneyIn - moneyOut,
        transactionCount: 1
      }],
      machineCount: 1,
      reconciliationStatus: 'included',
      qualityScore: 100,
      hasAnomalies: false,
      sourceEventId: latestEvent._id,
      notes: 'Reprocessed from grand_total events'
    });
    
    console.log(`  ✅ Created report: ${report._id}\n`);
    
    // Mark all events for this store-day as processed
    await Event.updateMany(
      { _id: { $in: group.events.map(e => e._id) } },
      { 
        $set: { 
          processed: true,
          processedAt: new Date(),
          generatedReportId: report._id
        }
      }
    );
  }
  
  await mongoose.disconnect();
  console.log('✅ Reprocessing complete!');
}

reprocess().catch(console.error);
