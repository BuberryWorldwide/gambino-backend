require('dotenv').config();
const mongoose = require('mongoose');
const DailyReportProcessor = require('./src/services/DailyReportProcessor');

async function reprocess() {
  await mongoose.connect(process.env.MONGODB_URI);
  
  const Event = require('./src/models/Event');
  const processor = new DailyReportProcessor();
  
  // Find ALL unprocessed daily report events
  const events = await Event.find({
    'metadata.source': 'daily_report',
    processed: false,
    eventType: { $in: ['money_in', 'money_out', 'daily_summary'] }
  }).sort({ timestamp: 1 });
  
  console.log(`Found ${events.length} unprocessed events\n`);
  
  // Group by store and date
  const groups = {};
  for (const event of events) {
    const date = new Date(event.timestamp).toISOString().split('T')[0];
    const key = `${event.storeId}_${date}`;
    if (!groups[key]) {
      groups[key] = { events: [], storeId: event.storeId, date, hubId: event.hubMachineId };
    }
    groups[key].events.push(event);
  }
  
  console.log(`Processing ${Object.keys(groups).length} store-days\n`);
  
  for (const [key, group] of Object.entries(groups)) {
    console.log(`Processing ${group.storeId} for ${group.date} (${group.events.length} events)`);
    
    try {
      // Use the latest event timestamp for processing
      const latestEvent = group.events[group.events.length - 1];
      await processor.processDailySummaryEvents(
        group.storeId,
        group.hubId,
        latestEvent.timestamp
      );
    } catch (error) {
      console.error(`  ❌ Failed: ${error.message}`);
    }
  }
  
  await mongoose.disconnect();
  console.log('\n✅ Reprocessing complete!');
}

reprocess().catch(console.error);
