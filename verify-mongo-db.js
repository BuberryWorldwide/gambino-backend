// MongoDB Financial Data Verification Script
// Run this on the backend server: node verify-mongo-data.js

require('dotenv').config();
const mongoose = require('mongoose');

// MongoDB Connection
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/gambino';

// Define Event Schema (matching your backend)
const eventSchema = new mongoose.Schema({
    eventType: {
        type: String,
        enum: ['voucher', 'voucher_print', 'money_in', 'money_out', 'collect', 'daily_summary']
    },
    hubMachineId: String,
    gamingMachineId: String,
    storeId: String,
    amount: Number,
    timestamp: Date,
    rawData: String,
    userId: mongoose.Schema.Types.ObjectId,
    userSessionId: String,
    isUserBound: Boolean,
    processed: Boolean,
    processedAt: Date,
    idempotencyKey: String,
    metadata: {
        source: String,
        reportDate: String
    }
}, { timestamps: true });

const Event = mongoose.model('Event', eventSchema);

// Color codes for console output
const colors = {
    reset: '\x1b[0m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m'
};

function log(color, ...args) {
    console.log(colors[color], ...args, colors.reset);
}

async function verifyMongoData() {
    try {
        log('cyan', '\n╔═══════════════════════════════════════════════════════════════╗');
        log('cyan', '║      MONGODB FINANCIAL DATA VERIFICATION                      ║');
        log('cyan', '║      Backend Database Analysis                                ║');
        log('cyan', '╚═══════════════════════════════════════════════════════════════╝\n');

        // Connect to MongoDB
        log('yellow', '🔌 Connecting to MongoDB...');
        await mongoose.connect(MONGO_URI, {
            useNewUrlParser: true,
            useUnifiedTopology: true
        });
        log('green', '✅ Connected to MongoDB\n');

        // Get all stores
        const Store = mongoose.model('Store', new mongoose.Schema({
            storeId: String,
            storeName: String,
            feePercentage: Number
        }));

        const stores = await Store.find({}).lean();
        log('cyan', `📊 Found ${stores.length} stores in database\n`);

        // Analyze each store
        for (const store of stores) {
            log('blue', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            log('green', `🏪 STORE: ${store.storeName} (${store.storeId})`);
            log('blue', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

            // Get all events for this store
            const allEvents = await Event.find({ storeId: store.storeId }).lean();
            
            if (allEvents.length === 0) {
                log('yellow', '⚠️  No events found for this store\n');
                continue;
            }

            // Calculate totals by event type
            const totals = allEvents.reduce((acc, event) => {
                const type = event.eventType;
                if (!acc[type]) {
                    acc[type] = { count: 0, total: 0 };
                }
                acc[type].count++;
                acc[type].total += event.amount || 0;
                return acc;
            }, {});

            // Calculate money in/out
            const moneyIn = (totals.money_in?.total || 0);
            const moneyOut = (totals.money_out?.total || 0) + (totals.voucher?.total || 0);
            const netRevenue = moneyIn - moneyOut;
            const margin = moneyIn > 0 ? ((netRevenue / moneyIn) * 100).toFixed(2) : 0;

            // Display financial summary
            log('magenta', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            log('green', '💰 MONGODB FINANCIAL SUMMARY (All Time)');
            log('magenta', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log(`  Money IN:           $${moneyIn.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
            console.log(`  Money OUT:          $${moneyOut.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
            console.log(`  Net Revenue:        $${netRevenue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
            console.log(`  Profit Margin:      ${margin}%`);
            console.log(`  Gambino Fee (${store.feePercentage || 5}%):   $${(netRevenue * ((store.feePercentage || 5) / 100)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
            console.log();

            // Display event breakdown
            log('cyan', '📊 Events by Type:');
            log('magenta', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('  Event Type          Count      Total Amount        Avg Amount');
            console.log('  ─────────────────  ────────  ──────────────────  ──────────────');
            
            Object.entries(totals).forEach(([type, data]) => {
                const avg = data.count > 0 ? data.total / data.count : 0;
                console.log(
                    `  ${type.padEnd(17)}  ${data.count.toString().padStart(8)}  $${data.total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).padStart(15)}  $${avg.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).padStart(12)}`
                );
            });
            console.log();

            // Get machine breakdown
            const machineBreakdown = await Event.aggregate([
                { $match: { storeId: store.storeId } },
                { 
                    $group: {
                        _id: '$gamingMachineId',
                        events: { $sum: 1 },
                        moneyIn: {
                            $sum: {
                                $cond: [{ $eq: ['$eventType', 'money_in'] }, '$amount', 0]
                            }
                        },
                        moneyOut: {
                            $sum: {
                                $cond: [
                                    { $in: ['$eventType', ['money_out', 'voucher']] },
                                    '$amount',
                                    0
                                ]
                            }
                        }
                    }
                },
                { $sort: { _id: 1 } }
            ]);

            log('cyan', '🎰 Performance by Machine:');
            log('magenta', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('  Machine       Events    Money IN         Money OUT        Net Revenue');
            console.log('  ───────────  ────────  ───────────────  ───────────────  ───────────────');
            
            machineBreakdown.forEach(machine => {
                const net = machine.moneyIn - machine.moneyOut;
                console.log(
                    `  ${(machine._id || 'unknown').padEnd(11)}  ${machine.events.toString().padStart(8)}  $${machine.moneyIn.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).padStart(13)}  $${machine.moneyOut.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).padStart(13)}  $${net.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).padStart(13)}`
                );
            });
            console.log();

            // Date range
            const firstEvent = await Event.findOne({ storeId: store.storeId }).sort({ timestamp: 1 }).lean();
            const lastEvent = await Event.findOne({ storeId: store.storeId }).sort({ timestamp: -1 }).lean();

            if (firstEvent && lastEvent) {
                log('cyan', '📅 Data Collection Period:');
                console.log(`  First Event:  ${new Date(firstEvent.timestamp).toLocaleString()}`);
                console.log(`  Last Event:   ${new Date(lastEvent.timestamp).toLocaleString()}`);
                
                const daysDiff = Math.floor((lastEvent.timestamp - firstEvent.timestamp) / (1000 * 60 * 60 * 24));
                console.log(`  Days of Data: ${daysDiff} days`);
                console.log();
            }

            // Last 7 days trend
            const sevenDaysAgo = new Date();
            sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

            const dailyTrend = await Event.aggregate([
                { 
                    $match: { 
                        storeId: store.storeId,
                        timestamp: { $gte: sevenDaysAgo }
                    }
                },
                {
                    $group: {
                        _id: {
                            $dateToString: { format: '%Y-%m-%d', date: '$timestamp' }
                        },
                        events: { $sum: 1 },
                        moneyIn: {
                            $sum: {
                                $cond: [{ $eq: ['$eventType', 'money_in'] }, '$amount', 0]
                            }
                        },
                        moneyOut: {
                            $sum: {
                                $cond: [
                                    { $in: ['$eventType', ['money_out', 'voucher']] },
                                    '$amount',
                                    0
                                ]
                            }
                        }
                    }
                },
                { $sort: { _id: -1 } }
            ]);

            if (dailyTrend.length > 0) {
                log('cyan', '📈 Daily Revenue Breakdown (Last 7 Days):');
                log('magenta', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
                console.log('  Date          Events    Money IN         Money OUT        Net Revenue');
                console.log('  ───────────  ────────  ───────────────  ───────────────  ───────────────');
                
                dailyTrend.forEach(day => {
                    const net = day.moneyIn - day.moneyOut;
                    console.log(
                        `  ${day._id.padEnd(11)}  ${day.events.toString().padStart(8)}  $${day.moneyIn.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).padStart(13)}  $${day.moneyOut.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).padStart(13)}  $${net.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).padStart(13)}`
                    );
                });
                console.log();
            }
        }

        // Data integrity checks
        log('green', '▶ DATA INTEGRITY CHECKS');
        log('blue', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        // Check for events without amounts
        const noAmount = await Event.countDocuments({ 
            eventType: { $in: ['money_in', 'money_out', 'voucher'] },
            $or: [{ amount: null }, { amount: { $exists: false } }]
        });
        
        if (noAmount === 0) {
            log('green', '✅ All financial events have amounts');
        } else {
            log('red', `⚠️  Found ${noAmount} financial events without amounts`);
        }

        // Check for suspicious amounts
        const suspicious = await Event.countDocuments({
            $or: [{ amount: { $gt: 10000 } }, { amount: { $lt: 0 } }]
        });
        
        if (suspicious === 0) {
            log('green', '✅ All amounts appear reasonable');
        } else {
            log('yellow', `⚠️  Found ${suspicious} events with suspicious amounts (>$10,000 or negative)`);
        }

        // Check for events without timestamps
        const noTimestamp = await Event.countDocuments({
            $or: [{ timestamp: null }, { timestamp: { $exists: false } }]
        });
        
        if (noTimestamp === 0) {
            log('green', '✅ All events have timestamps');
        } else {
            log('red', `⚠️  Found ${noTimestamp} events without timestamps`);
        }

        console.log();
        log('blue', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        log('green', '✅ MongoDB Verification Complete!');
        log('blue', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    } catch (error) {
        log('red', '❌ ERROR:', error.message);
        console.error(error);
    } finally {
        await mongoose.connection.close();
        log('yellow', '🔌 MongoDB connection closed\n');
    }
}

// Run the verification
verifyMongoData();
