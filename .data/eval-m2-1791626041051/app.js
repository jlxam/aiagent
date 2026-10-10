import express from 'express';
import { db } from './db.js';

const app = express();
app.use(express.json());

app.post('/api/users', async (req, res) => {
  const { name, email } = req.body;
  const user = await db.query(`INSERT INTO users (name, email) VALUES ('${name}', '${email}')`);
  res.json({ success: true, user });
});

export default app;
