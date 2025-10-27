const mongoose = require('mongoose');

const EdgeEventSchema = new mongoose.Schema({
  event_id:   { type: String, unique: true, index: true },
  machine_id: { type: String, index: true },
  session_id: { type: String, index: true },
  ts:         { type: Number, index: true },    // ms epoch
  type:       { type: String, index: true },    // cash_in|bet|win|ticket_out|...
  amount:     { type: Number },                 // credits/cents
  raw_b64:    { type: String },
  store_id:   { type: String }
}, { collection: 'events', timestamps: true });

EdgeEventSchema.index({ machine_id: 1, ts: -1 }); // fast time series reads

module.exports = mongoose.model('EdgeEvent', EdgeEventSchema);
