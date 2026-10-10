// Express router for the GitHub sync panel.
import { Router } from 'express';
import * as gh from './githubService.js';

const router = Router();

// GET /api/github/status — connection + local changes.
router.get('/status', async (req, res) => {
  try {
    res.json({ success: true, ...(await gh.getStatus()) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/github/connect { repo, branch } — validate + remember.
router.post('/connect', async (req, res) => {
  try {
    const { repo, branch } = req.body || {};
    const result = await gh.connectRepo(repo, branch);
    if (!result.ok) return res.status(400).json({ success: false, error: result.error });
    res.json({ success: true, connection: result.connection });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/github/disconnect — forget the repo.
router.post('/disconnect', async (req, res) => {
  try {
    await gh.disconnectRepo();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/github/push { message, force } — commit workspace + push.
router.post('/push', async (req, res) => {
  try {
    const { message, force } = req.body || {};
    const result = await gh.pushChanges(message, !!force);
    if (!result.ok) return res.status(400).json({ success: false, error: result.error });
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
