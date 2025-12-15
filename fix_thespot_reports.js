require('dotenv').config();
const mongoose = require('mongoose');

async function fix() {
  await mongoose.connect(process.env.MONGODB_URI);
  
  const DailyReport = require('./src/models/DailyReport');
  const Event = require('./src/models/Event');
  
  // Delete The Spot reports with totalCollect = 0
  const result = await DailyReport.deleteMany({
    storeId: /thespot/i,
    reportDate: { 
      $gte: new Date('2025-11-12T00:00:00.000Z'),
      $lte: new Date('2025-11-18T23:59:59.999Z')
    },
    totalCollect: 0
  });
  
  console.log(`🗑️  Deleted ${result.deletedCount} old Spot reports with totalCollect=0`);
  
  // Mark related events as unprocessed
  const eventResult = await Event.updateMany({
    storeId: /thespot/i,
    'metadata.source': 'daily_report',
    timestamp: {
      $gte: new Date('2025-11-12'),
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
  console.log('✅ Done! Now run reprocessing script');
}

fix().catch(console.error);
