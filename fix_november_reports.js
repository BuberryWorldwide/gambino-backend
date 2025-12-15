require('dotenv').config();
const mongoose = require('mongoose');

async function fix() {
  await mongoose.connect(process.env.MONGODB_URI);
  
  const DailyReport = require('./src/models/DailyReport');
  const Event = require('./src/models/Event');
  
  // Delete all reports from Nov 12-15 that have totalCollect = 0
  const result = await DailyReport.deleteMany({
    storeId: 'gallatin_nimbus_298',
    reportDate: { 
      $gte: new Date('2025-11-12T00:00:00.000Z'),
      $lte: new Date('2025-11-15T23:59:59.999Z')
    },
    totalCollect: 0
  });
  
  console.log(`🗑️  Deleted ${result.deletedCount} old reports with totalCollect=0`);
  
  // Mark related events as unprocessed
  const eventResult = await Event.updateMany({
    storeId: 'gallatin_nimbus_298',
    eventType: 'daily_summary',
    gamingMachineId: 'grand_total',
    timestamp: {
      $gte: new Date('2025-11-12'),
      $lte: new Date('2025-11-15T23:59:59.999Z')
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
  console.log('✅ Done! Now restart backend to trigger reprocessing');
}

fix().catch(console.error);
