require('dotenv').config();
const fs = require('fs');
const path = require('path');
const createApp = require('./app');
const { migrate } = require('./config/db');

fs.mkdirSync(path.join(__dirname, '../data'), { recursive: true });
migrate();

const app = createApp();
const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`NELSON × Potafoglio API listening on :${PORT}`); // eslint-disable-line no-console
});
