require('dotenv').config({ path: '/opt/gambino/.env' });
const mongoose = require('mongoose');
const Event = require('./src/models/Event');
const DailyReport = require('./src/models/DailyReport');

async function processDailySummaries() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB');

  // Find all daily summary events
  const dailyEvents = await Event.find({
    rawData: /Daily Summary/i,
    eventType: 'money_in'
  }).sort({ timestamp: 1 });

  console.log(`Found ${dailyEvents.length} daily summary events`);

  // Group by store and date
  const groups = {};
  
  for (const event of dailyEvents) {
    const date = event.timestamp.toISOString().split('T')[0];
    const key = `${event.storeId}_${date}`;
    
    if (!groups[key]) {
      groups[key] = {
        storeId: event.storeId,
        date: date,
        timestamp: event.timestamp,
        hubId: event.hubMachineId,
        events: []
      };
    }
    groups[key].events.push(event);
  }

  console.log(`Processing ${Object.keys(groups).length} daily reports...`);

  // Create DailyReports
  for (const [key, group] of Object.entries(groups)) {
    const idempotencyKey = `manual_${key}_${Date.now()}`;
    
    // Check if already exists
    const existing = await DailyReport.findOne({
      storeId: group.storeId,
      reportDate: new Date(group.date)
    });
    
    if (existing) {
      console.log(`⏭️  Report already exists for ${key}`);
      continue;
    }

    // Calculate totals
    const machineData = {};
    let totalMoneyIn = 0;
    
    for (const event of group.events) {
      const machineId = event.gamingMachineId;
      if (!machineData[machineId]) {
        machineData[machineId] = {
          machineId: machineId,
          moneyIn: 0,
          collect: 0,
          netRevenue: 0,
          transactionCount: 0
        };
      }
      machineData[machineId].moneyIn += event.amount;
      machineData[machineId].transactionCount++;
      totalMoneyIn += event.amount;
    }

    // Calculate net revenue
    Object.values(machineData).forEach(m => {
      m.netRevenue = m.moneyIn - m.collect;
    });

    try {
      const report = await DailyReport.create({
        storeId: group.storeId,
        reportDate: new Date(group.date),
        printedAt: group.timestamp,
        idempotencyKey: idempotencyKey,
        totalRevenue: totalMoneyIn,
        totalMoneyIn: totalMoneyIn,
        totalCollect: 0,
        machineData: Object.values(machineData),
        machineCount: Object.keys(machineData).length,
        reconciliationStatus: 'pending',
        notes: 'Auto-generated from historical daily summary events'
      });

      console.log(`✅ Created report for ${group.storeId} on ${group.date} - $${totalMoneyIn.toFixed(2)}`);
    } catch (error) {
      console.error(`❌ Failed to create report for ${key}:`, error.message);
    }
  }

  await mongoose.disconnect();
  console.log('✅ Processing complete');
}

processDailySummaries().catch(console.error);
