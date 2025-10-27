const mongoose = require('mongoose');
const Event = require('./src/models/Event');

mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/gambino');

async function createTestEvents() {
  const storeId = 'richmond_hotstreak_462';
  const now = new Date();
  
  const events = [
    {
      eventType: "money_in",
      hubMachineId: "pi-1",
      gamingMachineId: "machine_29",
      amount: 99,
      storeId: storeId,
      timestamp: now,
      rawData: "Daily Summary - Machine 29 - $99 in",
      metadata: { source: "daily_report", hubId: "pi-1" },
      processed: false,
      isUserBound: false,
      mappingStatus: "mapped"
    },
    {
      eventType: "money_in",
      hubMachineId: "pi-1",
      gamingMachineId: "machine_30",
      amount: 250,
      storeId: storeId,
      timestamp: new Date(now.getTime() + 1000),
      rawData: "Daily Summary - Machine 30 - $250 in",
      metadata: { source: "daily_report", hubId: "pi-1" },
      processed: false,
      isUserBound: false,
      mappingStatus: "mapped"
    },
    {
      eventType: "money_in",
      hubMachineId: "pi-1",
      gamingMachineId: "machine_31",
      amount: 198,
      storeId: storeId,
      timestamp: new Date(now.getTime() + 2000),
      rawData: "Daily Summary - Machine 31 - $198 in",
      metadata: { source: "daily_report", hubId: "pi-1" },
      processed: false,
      isUserBound: false,
      mappingStatus: "mapped"
    },
    {
      eventType: "money_in",
      hubMachineId: "pi-1",
      gamingMachineId: "machine_35",
      amount: 500,
      storeId: storeId,
      timestamp: new Date(now.getTime() + 3000),
      rawData: "Daily Summary - Machine 35 - $500 in",
      metadata: { source: "daily_report", hubId: "pi-1" },
      processed: false,
      isUserBound: false,
      mappingStatus: "mapped"
    }
  ];
  
  const created = await Event.insertMany(events);
  console.log(`Created ${created.length} test events`);
  
  for (const event of created) {
    console.log(`  - ${event.gamingMachineId}: $${event.amount}`);
  }
  
  process.exit(0);
}

createTestEvents().catch(console.error);