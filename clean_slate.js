require('dotenv').config();
const mongoose = require('mongoose');

async function clean() {
  await mongoose.connect(process.env.MONGODB_URI);
  
  const DailyReport = require('./src/models/DailyReport');
  const Event = require('./src/models/Event');
  
  console.log('🧹 Cleaning ALL reports from Oct 25 - Nov 18...');
  
  // Delete ALL reports in this date range
  const result = await DailyReport.deleteMany({
    reportDate: { 
      $gte: new Date('2025-10-25T00:00:00.000Z'),
      $lte: new Date('2025-11-18T23:59:59.999Z')
    }
  });
  
  console.log(`🗑️  Deleted ${result.deletedCount} reports`);
  
  // Mark ALL daily_report events as unprocessed
  const eventResult = await Event.updateMany({
    'metadata.source': 'daily_report',
    timestamp: {
      $gte: new Date('2025-10-25'),
      $lte: new Date('2025-11-18T23:59:59.999Z')
    }
  }, {
    $set: {
      processed: false,
      processedAt: null,
      generatedReportId: null
    }
  });
  
  console.log(`🔄 Reset ${eventResult.modifiedCount} events to unprocessed`);
  
  await mongoose.disconnect();
  console.log('✅ Clean slate ready!');
}

clean().catch(console.error);
