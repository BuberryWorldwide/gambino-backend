#!/bin/bash
# Manually Insert Lost Daily Report from Midnight Oct 28, 2025
# Run this on the BACKEND SERVER

MONGO_URL="mongodb://gambinouser:jhI%2BPDopCbhL%2FuAwniiKU2DSQX6Rv8LEXR5smWQZfIU%3D@localhost:27017/gambino?authSource=admin"
STORE_ID="gallatin_nimbus_298"
HUB_ID="pi-2-nimbus-1"

# Timestamp from the logs: 2025-10-28T04:00:40Z (UTC)
TIMESTAMP="2025-10-28T04:00:40.000Z"

echo "🔧 Manually Inserting Lost Daily Report Events"
echo "=============================================="
echo "Store: $STORE_ID"
echo "Time: $TIMESTAMP (midnight local time)"
echo ""

# Data extracted from Pi logs
declare -A MONEY_IN=(
  ["machine_01"]=175.00
  ["machine_02"]=30.00
  ["machine_03"]=0.00
  ["machine_04"]=0.00
  ["machine_05"]=260.00
  ["machine_06"]=40.00
  ["machine_07"]=183.00
)

declare -A MONEY_OUT=(
  ["machine_01"]=115.00
  ["machine_02"]=0.00
  ["machine_03"]=0.00
  ["machine_04"]=0.00
  ["machine_05"]=0.00
  ["machine_06"]=70.00
  ["machine_07"]=63.00
)

echo "📊 Data to insert:"
echo ""
for machine in machine_01 machine_02 machine_03 machine_04 machine_05 machine_06 machine_07; do
  echo "  $machine: \$${MONEY_IN[$machine]} IN, \$${MONEY_OUT[$machine]} OUT"
done
echo ""

read -p "Continue with insertion? (y/n) " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 1
fi

# Create MongoDB insert script
MONGO_SCRIPT=$(cat <<'EOF'
const events = [];
const storeId = "gallatin_nimbus_298";
const hubId = "pi-2-nimbus-1";
const baseTime = new Date("2025-10-28T04:00:40.000Z");

// Money IN events
const moneyInData = {
  "machine_01": 175.00,
  "machine_02": 30.00,
  "machine_03": 0.00,
  "machine_04": 0.00,
  "machine_05": 260.00,
  "machine_06": 40.00,
  "machine_07": 183.00
};

// Money OUT events
const moneyOutData = {
  "machine_01": 115.00,
  "machine_02": 0.00,
  "machine_03": 0.00,
  "machine_04": 0.00,
  "machine_05": 0.00,
  "machine_06": 70.00,
  "machine_07": 63.00
};

// Create money_in events
Object.keys(moneyInData).forEach((machineId, index) => {
  const timestamp = new Date(baseTime.getTime() + (index * 1000));
  const reportDate = timestamp.toISOString().split('T')[0];
  
  events.push({
    eventType: "money_in",
    action: "daily_summary",
    amount: moneyInData[machineId],
    machineId: machineId,
    gamingMachineId: machineId,
    storeId: storeId,
    hubMachineId: hubId,
    timestamp: timestamp,
    idempotencyKey: `${storeId}_daily_money_in_${machineId}_${reportDate}_${timestamp.toISOString()}`,
    rawData: `Daily Summary In - Machine ${machineId.split('_')[1]} - $${moneyInData[machineId]} (manually recovered)`,
    metadata: {
      source: "daily_report",
      reportDate: reportDate,
      isDailyReport: true,
      manuallyRecovered: true,
      recoveredFrom: "pi_logs",
      originalTimestamp: "2025-10-28T04:00:40.000Z"
    },
    isUserBound: false,
    mappingStatus: "daily_summary",
    userId: null,
    userSessionId: null,
    sessionId: null,
    createdAt: timestamp
  });
});

// Create money_out events
Object.keys(moneyOutData).forEach((machineId, index) => {
  const timestamp = new Date(baseTime.getTime() + 10000 + (index * 1000));
  const reportDate = timestamp.toISOString().split('T')[0];
  
  events.push({
    eventType: "money_out",
    action: "daily_summary",
    amount: moneyOutData[machineId],
    machineId: machineId,
    gamingMachineId: machineId,
    storeId: storeId,
    hubMachineId: hubId,
    timestamp: timestamp,
    idempotencyKey: `${storeId}_daily_money_out_${machineId}_${reportDate}_${timestamp.toISOString()}`,
    rawData: `Daily Summary Out - Machine ${machineId.split('_')[1]} - $${moneyOutData[machineId]} (manually recovered)`,
    metadata: {
      source: "daily_report",
      reportDate: reportDate,
      isDailyReport: true,
      manuallyRecovered: true,
      recoveredFrom: "pi_logs",
      originalTimestamp: "2025-10-28T04:00:40.000Z"
    },
    isUserBound: false,
    mappingStatus: "daily_summary",
    userId: null,
    userSessionId: null,
    sessionId: null,
    createdAt: timestamp
  });
});

// Insert all events
const result = db.events.insertMany(events);
print("\n✅ Inserted " + result.insertedIds.length + " events");
print("\nSummary:");
print("  Money IN events: 7");
print("  Money OUT events: 7");
print("  Total IN: $688.00");
print("  Total OUT: $248.00");
print("  Net: $440.00");
print("\n🔄 The UI should now show these values for the midnight report.");
EOF
)

echo "🔄 Inserting events into MongoDB..."
echo ""

docker exec -it gambino_mongodb mongosh "$MONGO_URL" --eval "$MONGO_SCRIPT"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ INSERTION COMPLETE"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Next steps:"
echo "  1. Refresh the UI to see updated totals"
echo "  2. The UI should now show the midnight report data"
echo "  3. When tomorrow's report comes in, it will replace these values"
echo ""
echo "To verify the data was inserted:"
echo "  docker exec -it gambino_mongodb mongosh \"$MONGO_URL\" --eval \""
echo "    db.events.countDocuments({"
echo "      storeId: '$STORE_ID',"
echo "      'metadata.manuallyRecovered': true"
echo "    })"
echo "  \""
echo ""
