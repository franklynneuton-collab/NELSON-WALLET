process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-production';
process.env.DB_PATH = require('path').join(__dirname, `../../data/test-${Date.now()}-${Math.random()}.db`);
