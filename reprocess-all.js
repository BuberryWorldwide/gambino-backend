require('dotenv').config();
const mongoose = require('mongoose');
const Event = require('./src/models/Event');
const DailyReportProcessor = require('./src/services/DailyReportProcessor');

async function reprocessAll() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected');
    
    const processor = new DailyReportProcessor();
    
    const events = await Event.find({
      storeId: 'gallatin_nimbus_298',
      eventType: 'daily_summary',
      processed: false,
      timestamp: { $gte: new Date('2025-11-12T00:00:00Z') }
    }).sort({ timestamp: 1 });
    
    console.log(`Found ${events.length} unprocessed events`);
    
    for (const event of events) {
      console.log(`\nProcessing event from ${event.timestamp} - $${event.amount}`);
      await processor.processDailySummaryEvents(
        event.storeId,
        event.hubMachineId,
        event.timestamp
      );
    }
    
    console.log('\n✅ All done!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

reprocessAll();
