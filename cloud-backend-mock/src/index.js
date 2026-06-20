const express = require('express');
const app = express();
const port = 3001;

app.use(express.json());

app.get('/', (req, res) => {
  res.send('AI Quality Gate Mock Cloud Backend is running! Send audits to POST /v1/audit');
});


app.post('/v1/audit', (req, res) => {
  const { uri, code } = req.body;
  const authHeader = req.headers['authorization'];

  console.log(`[Mock Backend] Received audit request for: ${uri}`);
  
  if (!authHeader || authHeader === 'Bearer ') {
    console.warn(`[Mock Backend] Warning: Missing API Key.`);
  }

  const diagnostics = [];

  // Mock checking logic (Simulating an LLM semantic check)
  // E.g., if there is a deeply nested if/else or switch that isn't caught by basic heuristics
  if (code && code.includes('switch') && code.split('case').length > 5) {
    diagnostics.push({
      severity: 1, // Error
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 10 } // Just highlighting start of file for the mock
      },
      message: `[Cloud LLM Analysis] Potential Over-Editing: Complexity Spike. AI generated massive switch statement.`,
      source: 'ai-quality-gate'
    });
  }

  // Random test: If the code contains the word "vibe"
  if (code && code.includes('vibe')) {
    diagnostics.push({
      severity: 2, // Warning
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 5 }
      },
      message: `[Cloud LLM Analysis] Vibe coding detected! Please review the architectural intent.`,
      source: 'ai-quality-gate'
    });
  }

  setTimeout(() => {
    res.json({ diagnostics });
  }, 500); // Simulate network/LLM latency
});

app.listen(port, () => {
  console.log(`[Mock Backend] AI Quality Gate Cloud Mock listening at http://localhost:${port}`);
});
