require("dotenv").config();
const mongoose = require("mongoose");

async function sendReferrerBonus() {
  await mongoose.connect(process.env.MONGODB_URI);

  const userSchema = new mongoose.Schema({}, { strict: false, collection: 'users' });
  const User = mongoose.model("UserRef", userSchema);

  const brandon = await User.findOne({ email: "bmaberry21@gmail.com" });

  if (!brandon) {
    console.log("Brandon not found");
    process.exit(1);
  }

  console.log("Brandon found:", brandon.email);
  console.log("Brandon wallet:", brandon.walletAddress);

  if (!brandon.walletAddress) {
    console.log("Brandon has no wallet!");
    process.exit(1);
  }

  const DistributionService = require("./src/services/distributionService");
  const distributionService = new DistributionService();

  console.log("Sending 25 GG referrer bonus to Brandon...");

  const result = await distributionService.distributeTokens({
    venueId: 'referral_bonus_manual',
    venueName: 'Manual Referral Bonus',
    recipient: brandon.walletAddress,
    amount: 25,
    sourceAccount: 'community',
    metadata: {
      type: 'referrer_bonus_manual',
      referrerId: brandon._id.toString(),
      referrerEmail: brandon.email,
      reason: 'Manual fix for Test Disbursement referral'
    }
  });

  console.log("Result:", JSON.stringify(result, null, 2));

  await mongoose.disconnect();
  process.exit(0);
}

sendReferrerBonus().catch(e => { console.error(e); process.exit(1); });
