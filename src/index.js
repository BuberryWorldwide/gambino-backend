require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'Gambino Backend is running' });
});

app.listen(PORT, () => {
  console.log(`🎰 Gambino Backend running on port ${PORT}`);
});
