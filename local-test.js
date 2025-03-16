// A simplified version of our action that runs locally
const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');
const unzipper = require('unzipper');
const { execSync } = require('child_process');
const yaml = require('js-yaml');

async function run() {
  try {
    // Hard-coded inputs for testing
    const actionRef = 'actions/hello-world-javascript-action@main';
    const extraArgs = '';

    // Parse action-ref (expects format: owner/repo@ref)
    const [repo, ref] = actionRef.split('@');
    console.log(`Parsed repo: ${repo}, ref: ${ref}`);

    // Construct URL for the repository zip archive
    const zipUrl = `https://github.com/${repo}/archive/refs/heads/${ref}.zip`;
    console.log(`Downloading action from: ${zipUrl}`);

    // Create a temporary directory for extraction
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nested-action-'));
    console.log(`Created temp directory: ${tempDir}`);

    // Download and extract the zip archive
    const response = await axios({
      url: zipUrl,
      method: 'GET',
      responseType: 'stream'
    });
    
    await new Promise((resolve, reject) => {
      response.data
        .pipe(unzipper.Extract({ path: tempDir }))
        .on('close', resolve)
        .on('error', reject);
    });
    console.log(`Downloaded and extracted to ${tempDir}`);

    // GitHub archives typically extract to a folder named "repo-ref"
    const repoName = repo.split('/')[1];
    const extractedFolder = path.join(tempDir, `${repoName}-${ref}`);
    console.log(`Looking for extracted folder: ${extractedFolder}`);
    
    if (!fs.existsSync(extractedFolder)) {
      throw new Error(`Extracted folder ${extractedFolder} not found.`);
    }

    // List contents of temp directory for debugging
    console.log('Temp directory contents:');
    const files = fs.readdirSync(tempDir);
    console.log(files);

    // Read action.yml from the downloaded action
    const actionYmlPath = path.join(extractedFolder, 'action.yml');
    if (!fs.existsSync(actionYmlPath)) {
      throw new Error(`action.yml not found in ${extractedFolder}`);
    }
    const actionConfig = yaml.load(fs.readFileSync(actionYmlPath, 'utf8'));
    const entryPoint = actionConfig.runs && actionConfig.runs.main;
    if (!entryPoint) {
      throw new Error('Entry point (runs.main) not defined in action.yml');
    }
    console.log(`Nested action entry point: ${entryPoint}`);

    // Construct full path to the nested action's entry file
    const entryFile = path.join(extractedFolder, entryPoint);
    if (!fs.existsSync(entryFile)) {
      throw new Error(`Entry file ${entryFile} does not exist.`);
    }

    // Optionally, install dependencies if package.json exists
    const pkgJsonPath = path.join(extractedFolder, 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
      console.log('Installing dependencies for nested action...');
      execSync('npm install', { cwd: extractedFolder, stdio: 'inherit' });
    }

    // For local testing, just show the content of the entry file
    console.log('Content of entry file:');
    const entryContent = fs.readFileSync(entryFile, 'utf8');
    console.log(entryContent.substring(0, 500) + '...'); // Show first 500 chars

    console.log('Test completed successfully!');
  } catch (error) {
    console.error(`Test failed: ${error.message}`);
    if (error.response) {
      console.error(`Status: ${error.response.status}`);
      console.error(`Headers: ${JSON.stringify(error.response.headers)}`);
    }
  }
}

run();