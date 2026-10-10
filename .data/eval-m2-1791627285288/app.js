import express from 'express';
import { db } from './db.js';

const app = express();
app.use(express.json());

app.post('/api/users', async (req, res) => {
  try {
    // Validate request body
    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({ success: false, error: 'Malformed JSON body' });
    }

    const { name, email } = req.body;

    // Validate required fields
    if (!name || !email) {
      return res.status(400).json({ success: false, error: 'Missing name or email' });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ success: false, error: 'Invalid email format' });
    }

    // Execute parameterized query
    const user = await db.query(
      'INSERT INTO users (name, email) VALUES (?, ?)',
      [name, email]
    );

    res.status(201).json({ success: true, user });
  } catch (error) {
    // Handle database errors and other exceptions
    if (error.name === 'TypeError' && error.message.includes('Invalid JSON')) {
      return res.status(400).json({ success: false, error: 'Malformed JSON body' });
    }

    console.error('Database error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

export default app;
