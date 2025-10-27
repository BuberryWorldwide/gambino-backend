const mongoose = require('mongoose');

const EdgeSessionSchema = new mongoose.Schema({
  session_id: { type: String, unique: true, index: true },
  machine_id: { type: String, index: true },
  user_id:    { type: String },
  started_at: { type: Number, index: true },
  ended_at:   { type: Number },
  credit_in:  { type: Number, default: 0 },
  credit_out: { type: Number, default: 0 },
  bets:       { type: Number, default: 0 },
  wins:       { type: Number, default: 0 },
  session_hash:{ type: String },
  // settlement fields you’ll fill later:
  tokens_burn:    { type: Number, default: 0 },
  tokens_buyback: { type: Number, default: 0 },
  burn_txid:      { type: String }
}, { collection: 'sessions', timestamps: true });

EdgeSessionSchema.index({ machine_id: 1, started_at: -1 });

module.exports = mongoose.model('EdgeSession', EdgeSessionSchema);
