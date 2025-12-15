require('dotenv').config();
const mongoose = require('mongoose');
const DailyReportProcessor = require('./src/services/DailyReportProcessor');

async function reprocess() {
  await mongoose.connect(process.env.MONGODB_URI);
  
  const Event = require('./src/models/Event');
  const processor = new DailyReportProcessor();
  
  // Find unprocessed grand_total events
  const events = await Event.find({
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
    if (!groups[key]) groups[key] = [];
    groups[key].push(event);
  }
  
  console.log(`Processing ${Object.keys(groups).length} store-days`);
  
  for (const [key, groupEvents] of Object.entries(groups)) {
    const [storeId, date] = key.split('_');
    const lastEvent = groupEvents[groupEvents.length - 1];
    
    console.log(`\nProcessing ${storeId} for ${date} (${groupEvents.length} events)`);
    
    try {
      await processor.processDailySummaryEvents(
        storeId,
        lastEvent.hubMachineId,
        lastEvent.timestamp
      );
    } catch (error) {
      console.error(`Failed: ${error.message}`);
    }
  }
  
  await mongoose.disconnect();
  console.log('\n✅ Reprocessing complete');
}

reprocess().catch(console.error);
