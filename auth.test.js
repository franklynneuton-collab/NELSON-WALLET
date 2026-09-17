const request = require('supertest');
const { migrate } = require('../config/db');
migrate();
const createApp = require('../app');

const app = createApp();

describe('auth', () => {
  const email = `test-${Date.now()}@example.com`;
  const password = 'Str0ngPassw0rd!';

  test('register creates a user and returns tokens', async () => {
    const res = await request(app).post('/auth/register').send({ name: 'Test User', email, password });
    expect(res.status).toBe(201);
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.user.email).toBe(email);
    expect(res.body.user.kycStatus).toBe('unverified');
  });

  test('register rejects a duplicate email', async () => {
    const res = await request(app).post('/auth/register').send({ name: 'Dupe', email, password });
    expect(res.status).toBe(409);
  });

  test('register rejects a weak password', async () => {
    const res = await request(app).post('/auth/register')
      .send({ name: 'Weak', email: `weak-${Date.now()}@example.com`, password: 'short' });
    expect(res.status).toBe(400);
  });

  test('login with correct credentials succeeds', async () => {
    const res = await request(app).post('/auth/login').send({ email, password });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
  });

  test('login with wrong password is rejected without leaking which field was wrong', async () => {
    const res = await request(app).post('/auth/login').send({ email, password: 'wrong-password-1' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_credentials');
  });

  test('protected route rejects requests with no token', async () => {
    const res = await request(app).get('/auth/me');
    expect(res.status).toBe(401);
  });

  test('protected route accepts a valid access token', async () => {
    const login = await request(app).post('/auth/login').send({ email, password });
    const res = await request(app).get('/auth/me').set('Authorization', `Bearer ${login.body.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(email);
  });

  test('refresh token rotates and old one is revoked', async () => {
    const login = await request(app).post('/auth/login').send({ email, password });
    const refresh1 = await request(app).post('/auth/refresh').send({ refreshToken: login.body.refreshToken });
    expect(refresh1.status).toBe(200);

    const reuse = await request(app).post('/auth/refresh').send({ refreshToken: login.body.refreshToken });
    expect(reuse.status).toBe(401);
  });
});
