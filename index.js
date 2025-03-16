const core = require("@actions/core");
const exec = require("@actions/exec");
const fs = require("fs");
const os = require("os");
const path = require("path");
const axios = require("axios");
const unzipper = require("unzipper");
const yaml = require("js-yaml");

async function run() {
  try {
    // Get inputs
    const actionRef = core.getInput("action-ref");
    const extraArgs = core.getInput("extra-args") || "";
    const straceOptions = core.getInput("strace-options") || "-f -e trace=network,write,open";
    const enableStrace = core.getInput("enable-strace").toLowerCase() === "true";

    // Parse action-ref (expects format: owner/repo@ref)
    const [repo, ref] = parseActionRef(actionRef);
    core.info(`Parsed repo: ${repo}, ref: ${ref}`);

    // Construct URL for the repository zip archive
    // Use proper URL format for GitHub archives (handle both branches and tags)
    const isTag = !ref.includes('/');
    const zipUrl = isTag
      ? `https://github.com/${repo}/archive/refs/tags/${ref}.zip`
      : `https://github.com/${repo}/archive/refs/heads/${ref}.zip`;
    
    core.info(`Downloading action from: ${zipUrl}`);

    // Create a temporary directory for extraction
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nested-action-"));

    try {
      // Download and extract the zip archive
      const response = await axios({
        url: zipUrl,
        method: "GET",
        responseType: "stream",
        validateStatus: function (status) {
          return status >= 200 && status < 300; // Default
        },
        maxRedirects: 5 // Handle redirects
      });
      
      await new Promise((resolve, reject) => {
        response.data
          .pipe(unzipper.Extract({ path: tempDir }))
          .on("close", resolve)
          .on("error", reject);
      });
      core.info(`Downloaded and extracted to ${tempDir}`);
    } catch (error) {
      if (error.response) {
        core.error(`Download failed with status ${error.response.status}`);
        if (isTag) {
          // Try alternative URL format if first attempt failed
          core.info("Attempting alternative download URL for branches...");
          const altZipUrl = `https://github.com/${repo}/archive/refs/heads/${ref}.zip`;
          core.info(`Trying alternative URL: ${altZipUrl}`);
          
          const altResponse = await axios({
            url: altZipUrl,
            method: "GET",
            responseType: "stream",
            maxRedirects: 5
          });
          
          await new Promise((resolve, reject) => {
            altResponse.data
              .pipe(unzipper.Extract({ path: tempDir }))
              .on("close", resolve)
              .on("error", reject);
          });
          core.info(`Downloaded and extracted from alternative URL to ${tempDir}`);
        } else {
          throw error;
        }
      } else {
        throw error;
      }
    }

    // List contents of the temp directory for diagnostic purposes
    core.debug(`Temporary directory contents: ${fs.readdirSync(tempDir).join(', ')}`);

    // GitHub archives typically extract to a folder named "repo-ref"
    const repoName = repo.split("/")[1];
    const extractedFolder = path.join(tempDir, `${repoName}-${ref}`);
    if (!fs.existsSync(extractedFolder)) {
      // If default folder name doesn't exist, try finding based on content
      const tempContents = fs.readdirSync(tempDir);
      if (tempContents.length === 1 && fs.lstatSync(path.join(tempDir, tempContents[0])).isDirectory()) {
        // If there's only one directory, use that one
        const alternateFolder = path.join(tempDir, tempContents[0]);
        core.info(`Using alternative extracted folder: ${alternateFolder}`);
        return await processAction(alternateFolder, extraArgs);
      } else {
        throw new Error(`Extracted folder ${extractedFolder} not found and could not determine alternative.`);
      }
    }

    await processAction(extractedFolder, extraArgs);
    
  } catch (error) {
    core.setFailed(`Wrapper action failed: ${error.message}`);
    if (error.response) {
      core.error(`HTTP status: ${error.response.status}`);
    }
  }
}

async function processAction(actionDir, extraArgs) {
  // Get strace options from input
  const straceOptions = core.getInput("strace-options") || "-f -e trace=network,write,open";
  const enableStrace = core.getInput("enable-strace").toLowerCase() === "true";
  
  // Read action.yml from the downloaded action
  const actionYmlPath = path.join(actionDir, "action.yml");
  // Some actions use action.yaml instead of action.yml
  const actionYamlPath = path.join(actionDir, "action.yaml");
  
  let actionConfig;
  
  if (fs.existsSync(actionYmlPath)) {
    actionConfig = yaml.load(fs.readFileSync(actionYmlPath, "utf8"));
  } else if (fs.existsSync(actionYamlPath)) {
    actionConfig = yaml.load(fs.readFileSync(actionYamlPath, "utf8"));
  } else {
    throw new Error(`Neither action.yml nor action.yaml found in ${actionDir}`);
  }
  
  const entryPoint = actionConfig.runs && actionConfig.runs.main;
  if (!entryPoint) {
    throw new Error("Entry point (runs.main) not defined in action metadata");
  }
  core.info(`Nested action entry point: ${entryPoint}`);

  // Construct full path to the nested action's entry file
  const entryFile = path.join(actionDir, entryPoint);
  if (!fs.existsSync(entryFile)) {
    throw new Error(`Entry file ${entryFile} does not exist.`);
  }

  // Optionally, install dependencies if package.json exists
  const pkgJsonPath = path.join(actionDir, "package.json");
  if (fs.existsSync(pkgJsonPath)) {
    core.info("Installing dependencies for nested action...");
    await exec.exec("npm", ["install"], { cwd: actionDir });
  }

  // Get all inputs with 'input-' prefix and pass them to the nested action
  // We'll set these as environment variables that GitHub Actions uses
  const inputPrefix = 'input-';
  const nestedInputs = {};
  
  // Get all inputs that start with 'input-'
  Object.keys(process.env)
    .filter(key => key.startsWith('INPUT_'))
    .forEach(key => {
      const inputName = key.substring(6).toLowerCase(); // Remove 'INPUT_' prefix
      if (inputName.startsWith(inputPrefix)) {
        const nestedInputName = inputName.substring(inputPrefix.length);
        nestedInputs[nestedInputName] = process.env[key];
        core.info(`Passing input '${nestedInputName}' to nested action`);
      }
    });
  
  // Set environment variables for the nested action
  const envVars = { ...process.env };
  Object.keys(nestedInputs).forEach(name => {
    envVars[`INPUT_${name.toUpperCase()}`] = nestedInputs[name];
  });
  
  // For backwards compatibility, also support the extra-args parameter
  const args = extraArgs.split(/\s+/).filter((a) => a); // split and remove empty strings
  
  // Use strace if enabled and available
  if (enableStrace) {
    core.info(`Strace enabled with options: ${straceOptions}`);
    core.info(`Executing nested action with strace: strace ${straceOptions} node ${entryFile} ${args.join(" ")}`);
    
    try {
      // First, check if strace is installed
      await exec.exec("which", ["strace"]);
      
      // Parse strace options into an array
      const straceOptionsList = straceOptions.split(/\s+/).filter(Boolean);
      
      // Create output file for strace results
      const stracelLogFile = path.join(process.env.GITHUB_WORKSPACE || '.', 'strace-output.log');
      
      // Add output file option if not already specified
      if (!straceOptionsList.includes('-o') && !straceOptionsList.includes('--output')) {
        straceOptionsList.push('-o', stracelLogFile);
        core.info(`Strace output will be saved to: ${stracelLogFile}`);
      }
      
      // Use strace to wrap the node process
      await exec.exec("strace", [...straceOptionsList, "node", entryFile, ...args], { 
        cwd: actionDir,
        env: envVars
      });
      
      // Export the strace log path as an output
      core.setOutput("strace-log", stracelLogFile);
      
    } catch (error) {
      // If strace is not available, fall back to running without it
      core.warning(`Strace is not available: ${error.message}`);
      core.info(`Executing nested action without strace: node ${entryFile} ${args.join(" ")}`);
      await exec.exec("node", [entryFile, ...args], { 
        cwd: actionDir,
        env: envVars
      });
    }
  } else {
    // Run without strace
    core.info(`Strace disabled. Executing nested action: node ${entryFile} ${args.join(" ")}`);
    await exec.exec("node", [entryFile, ...args], { 
      cwd: actionDir,
      env: envVars
    });
  }
}

function parseActionRef(refString) {
  const parts = refString.split("@");
  if (parts.length !== 2) {
    throw new Error("Invalid action-ref format. Expected 'owner/repo@ref'");
  }
  return parts;
}

run();
