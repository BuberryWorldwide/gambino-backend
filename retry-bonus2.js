require("dotenv").config();
const mongoose = require("mongoose");

async function retryBonus() {
  await mongoose.connect(process.env.MONGODB_URI);
  
  const userSchema = new mongoose.Schema({}, { strict: false, collection: 'users' });
  const User = mongoose.model("User2", userSchema);
  
  const user = await User.findOne({ email: "test@disbursement.com" });
  const brandon = await User.findOne({ email: "bmaberry21@gmail.com" });
  
  console.log("Test user referredBy:", user.referredBy);
  console.log("Brandon ID:", brandon._id.toString());
  
  const BonusDisbursementService = require("./src/services/bonusDisbursementService");
  const bonusService = new BonusDisbursementService();
  
  console.log("Attempting bonus with referral...");
  
  const result = await bonusService.disburseSignupBonus({
    userId: user._id,
    walletAddress: user.walletAddress,
    email: user.email,
    referralInfo: {
      referrerId: brandon._id,
      referralCode: "MX2864"
    }
  });
  
  console.log("Bonus result:", JSON.stringify(result, null, 2));
  await mongoose.disconnect();
  process.exit(0);
}

retryBonus().catch(e => { console.error(e); process.exit(1); });
