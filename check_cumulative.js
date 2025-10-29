// check_cumulative.js
// Run with: node check_cumulative.js

require('dotenv').config({ path: '/opt/gambino/.env' });
const mongoose = require('mongoose');

async function checkCumulative() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');
    
    const Event = mongoose.model('Event', new mongoose.Schema({}, { strict: false, collection: 'events' }));
    
    const storeId = 'gallatin_nimbus_298';
    const date = new Date('2025-10-28');
    const tomorrow = new Date(date);
    tomorrow.setDate(tomorrow.getDate() + 1);
    
    console.log(`📊 CUMULATIVE TOTALS FOR ${date.toDateString()}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    const results = await Event.aggregate([
      {
        $match: {
          storeId: storeId,
          timestamp: { $gte: date, $lt: tomorrow },
          eventType: { $in: ['money_in', 'money_out', 'voucher_print'] }
        }
      },
      {
        $group: {
          _id: {
            machineId: '$gamingMachineId',
            eventType: '$eventType'
          },
          total: { $sum: '$amount' },
          count: { $sum: 1 }
        }
      },
      {
        $sort: { '_id.machineId': 1, '_id.eventType': 1 }
      }
    ]);
    
    // Organize by machine
    const machines = {};
    results.forEach(item => {
      const machineId = item._id.machineId;
      if (!machines[machineId]) {
        machines[machineId] = { moneyIn: 0, moneyOut: 0, vouchers: 0, voucherCount: 0 };
      }
      if (item._id.eventType === 'money_in') {
        machines[machineId].moneyIn = item.total;
      } else if (item._id.eventType === 'money_out') {
        machines[machineId].moneyOut = item.total;
      } else if (item._id.eventType === 'voucher_print') {
        machines[machineId].vouchers = item.total;
        machines[machineId].voucherCount = item.count;
      }
    });
    
    // Print results
    let grandTotalIn = 0;
    let grandTotalOut = 0;
    let grandTotalVouchers = 0;
    let totalVoucherCount = 0;
    
    Object.keys(machines).sort().forEach(machineId => {
      const m = machines[machineId];
      const net = m.moneyIn - m.moneyOut;
      
      console.log(`${machineId}:`);
      console.log(`  Money IN:  $${m.moneyIn.toFixed(2)}`);
      console.log(`  Money OUT: $${m.moneyOut.toFixed(2)}`);
      if (m.vouchers > 0) {
        console.log(`  Vouchers:  $${m.vouchers.toFixed(2)} (${m.voucherCount} vouchers)`);
      }
      console.log(`  Net:       $${net.toFixed(2)}`);
      console.log('');
      
      grandTotalIn += m.moneyIn;
      grandTotalOut += m.moneyOut;
      grandTotalVouchers += m.vouchers;
      totalVoucherCount += m.voucherCount;
    });
    
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 GRAND TOTALS');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`Total Money IN:  $${grandTotalIn.toFixed(2)}`);
    console.log(`Total Money OUT: $${grandTotalOut.toFixed(2)}`);
    console.log(`Total Vouchers:  $${grandTotalVouchers.toFixed(2)} (${totalVoucherCount} vouchers)`);
    console.log(`Net Revenue:     $${(grandTotalIn - grandTotalOut).toFixed(2)}`);
    console.log('');
    console.log('✅ This is TRUE 24-hour cumulative data!');
    console.log('   (Not "since last clear" like daily reports)');
    
    await mongoose.disconnect();
    
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

checkCumulative();
