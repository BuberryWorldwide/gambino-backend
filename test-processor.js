const mongoose = require('mongoose');
const DailyReportProcessor = require('./src/services/DailyReportProcessor');

mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/gambino');

async function test() {
  const processor = new DailyReportProcessor();
  
  const result = await processor.processDailySummaryEvents(
    'richmond_hotstreak_462',
    'pi-1',
    new Date()
  );
  
  console.log('Result:', result);
  process.exit(0);
}

test().catch(console.error);