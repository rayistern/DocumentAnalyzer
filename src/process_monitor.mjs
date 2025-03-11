// Process Monitor Utility
// This script helps monitor and kill Node.js processes

import { exec } from 'child_process';
import readline from 'readline';
import { setupProcessTimeout } from './config.mjs';

// Set up the global timeout for this process
setupProcessTimeout();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// ... rest of the existing code ... 