require('dotenv').config({ path: '/opt/gambino/.env' });
const mongoose = require('mongoose');
const DailyReport = require('./src/models/DailyReport');

async function createTestReport() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/gambino');
  
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const report = await DailyReport.create({
    storeId: "richmond_hotstreak_462",
    printedAt: new Date(),
    reportDate: today,
    idempotencyKey: `manual_test_${Date.now()}`,
    totalRevenue: 500,
    totalMoneyIn: 500,
    totalCollect: 0,
    machineData: [{
      machineId: "machine_35",
      moneyIn: 500,
      collect: 0,
      netRevenue: 500,
      transactionCount: 1
    }],
    machineCount: 1,
    qualityScore: 100,
    hasAnomalies: false,
    reconciliationStatus: "included",
    notes: "Test report created via script"
  });
  
  console.log('Test report created:', report._id);
  process.exit(0);
}

createTestReport();