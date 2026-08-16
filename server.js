import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import runHandler from './apps/osint-navigator/api/run.js';
import analyzeHandler from './apps/osint-navigator/api/analyze.js';
import mapsResolveHandler from './apps/osint-navigator/api/maps-resolve.js';
import treeMatchHandler from './apps/osint-navigator/api/tree-match.js';
import visionHandler from './apps/osint-navigator/api/vision.js';
import {guardApiRequest} from './apps/osint-navigator/api/_lib/request-guard.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;
const guardedAiRoutes = new Set(['/api/run','/api/analyze','/api/vision']);

app.use((req,res,next) => {
  if(!guardedAiRoutes.has(req.path)) return next();
  if(!guardApiRequest(req,res)) return;
  next();
});

// Keep inline image JSON below the platform edge limit. Unauthorized requests are rejected above,
// before Express spends memory parsing their body.
app.use(express.json({ limit: '4.5mb' }));
app.use(express.urlencoded({ extended: true, limit: '64kb' }));

// API routes
app.all('/api/run', (req, res) => runHandler(req, res));
app.all('/api/analyze', (req, res) => analyzeHandler(req, res));
app.all('/api/maps-resolve', (req, res) => mapsResolveHandler(req, res));
app.all('/api/tree-match', (req, res) => treeMatchHandler(req, res));
app.all('/api/vision', (req, res) => visionHandler(req, res));

// Express error handler - ensure JSON is always returned instead of HTML
app.use((err, req, res, next) => {
  if (err) {
    res.status(err.status || err.statusCode || 500).json({ error: err.message || 'Błąd serwera' });
    return;
  }
  next();
});

// Serve static app directories with no-store for html
const staticOptions = {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store');
    }
  }
};

app.use('/apps/osint-navigator', express.static(path.join(__dirname, 'apps/osint-navigator'), staticOptions));
app.use('/apps/mailboard', express.static(path.join(__dirname, 'apps/mailboard'), staticOptions));

// Direct file access fallback from apps/osint-navigator
app.use(express.static(path.join(__dirname, 'apps/osint-navigator'), staticOptions));

// Default route serves OSINT Navigator index.html
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'apps/osint-navigator/index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});
