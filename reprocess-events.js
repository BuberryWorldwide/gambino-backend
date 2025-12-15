require('dotenv').config();
const mongoose = require('mongoose');
const Event = require('./src/models/Event');
const DailyReportProcessor = require('./src/services/DailyReportProcessor');

async function reprocessEvents() {
  try {
    const mongoUri = process.env.MONGODB_URI;
    console.log('Connecting to MongoDB...');
    await mongoose.connect(mongoUri);
    console.log('✅ Connected');
    
    const processor = new DailyReportProcessor();
    
    const events = await Event.find({
      storeId: 'gallatin_nimbus_298',
      eventType: 'daily_summary',
      processed: false,
      timestamp: { $gte: new Date('2025-11-12T00:00:00Z') }
    }).sort({ timestamp: 1 });
    
    console.log(`Found ${events.length} unprocessed events`);
    
    if (events.length === 0) {
      console.log('No events to process');
      process.exit(0);
    }
    
    const latestEvent = events[events.length - 1];
    console.log(`Processing event from ${latestEvent.timestamp}`);
    
    await processor.processDailySummaryEvents(
      latestEvent.storeId,
      latestEvent.hubMachineId,
      latestEvent.timestamp
    );
    
    console.log('✅ Done!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

reprocessEvents();
