import fs from 'node:fs';
import crypto from 'node:crypto';
if (fs.existsSync('.env')) {
  console.log('.env already exists; leaving it alone.');
} else {
  const token = crypto.randomBytes(32).toString('hex');
  const text = fs.readFileSync('.env.example', 'utf8').replace(/^API_TOKEN=.*$/m, `API_TOKEN=${token}`);
  fs.writeFileSync('.env', text, { mode: 0o600 });
  console.log('Created .env with a fresh API_TOKEN (open .env to read it).');
}
