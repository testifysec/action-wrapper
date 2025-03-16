// This script simulates running the action locally
const process = require('process');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

// Create a simpler test script instead of trying to mock everything
console.log('Creating test script to download and execute hello-world-javascript-action');

// Create a test script that downloads the hello-world action
const testScript = `
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');
const { Extract } = require('unzipper');

async function downloadAndRunAction() {
  console.log('Starting test...');
  
  // Repository details
  const repo = 'actions/hello-world-javascript-action';
  const ref = 'main';
  
  // Create temp directory
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'action-test-'));
  console.log(\`Created temp directory: \${tempDir}\`);
  
  // Download the action
  const zipUrl = \`https://github.com/\${repo}/archive/\${ref}.zip\`;
  console.log(\`Downloading from: \${zipUrl}\`);
  
  // Download and extract
  await new Promise((resolve, reject) => {
    https.get(zipUrl, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(\`Failed to download: \${response.statusCode}\`));
        return;
      }
      
      response
        .pipe(Extract({ path: tempDir }))
        .on('close', resolve)
        .on('error', reject);
    }).on('error', reject);
  });
  
  // Find the extracted directory
  const repoName = repo.split('/')[1];
  const extractedDir = path.join(tempDir, \`\${repoName}-\${ref}\`);
  console.log(\`Extracted to: \${extractedDir}\`);
  
  // Install dependencies
  console.log('Installing dependencies...');
  execSync('npm install', { cwd: extractedDir, stdio: 'inherit' });
  
  // Run the action
  console.log('Running action...');
  require(path.join(extractedDir, 'index.js'));
}

downloadAndRunAction().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
`;

// Write the test script
fs.writeFileSync(path.join(__dirname, 'run-test.js'), testScript);

console.log('Running test script...');
exec('node run-test.js', (error, stdout, stderr) => {
  console.log(stdout);
  if (stderr) console.error(stderr);
  if (error) console.error('Test failed:', error);
  else console.log('Test completed successfully');
});