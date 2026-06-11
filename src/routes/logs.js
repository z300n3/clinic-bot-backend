const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');

const LOGS_DIR = path.join(__dirname, '../../token_logs');

router.get('/today', (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const filePath = path.join(LOGS_DIR, `tokens_${today}.jsonl`);

  if (fs.existsSync(filePath)) {
    res.download(filePath, `tokens_${today}.jsonl`);
  } else {
    res.status(404).send('No token logs found for today.');
  }
});

module.exports = router;
