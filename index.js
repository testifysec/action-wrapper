const core = require("@actions/core");
const exec = require("@actions/exec");
const fs = require("fs");
const os = require("os");
const path = require("path");
const axios = require("axios");
const unzipper = require("unzipper");
const yaml = require("js-yaml");

// Handle signals to ensure clean exit
process.on('SIGINT', () => {
  console.log('Action wrapper received SIGINT, exiting...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('Action wrapper received SIGTERM, exiting...');
  process.exit(0);
});

// Set an absolute maximum timeout for the entire action (30 minutes)
const MAX_ACTION_DURATION_MS = 30 * 60 * 1000;
const actionTimeoutId = setTimeout(() => {
  core.warning(`Action timed out after ${MAX_ACTION_DURATION_MS/60000} minutes. This is likely a bug in the action wrapper. Forcing exit.`);
  process.exit(1);
}, MAX_ACTION_DURATION_MS);

// Make sure the timeout doesn't prevent the process from exiting naturally
actionTimeoutId.unref();

async function run() {
  // Track any child processes created
  const childProcesses = [];
  
  // Register for process exits to ensure we clean up
  process.on('beforeExit', () => {
    core.debug(`Cleaning up any remaining child processes: ${childProcesses.length}`);
    childProcesses.forEach(pid => {
      try {
        process.kill(pid, 'SIGTERM');
      } catch (e) {
        // Ignore errors when killing processes that might be gone
      }
    });
  });
  
  try {
    // Get inputs
    const actionRef = core.getInput("action-ref");
    const extraArgs = core.getInput("extra-args") || "";
    // Improved default strace options for better insights
    const defaultStraceOptions = "-f -v -s 256 -e trace=file,process,network,signal,ipc,desc,memory";
    const straceOptions = core.getInput("strace-options") || defaultStraceOptions;
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
      
      // Create output file for strace results with timestamp and action name
      const repoName = repo.split("/")[1];
      const timestamp = new Date().toISOString().replace(/:/g, '-');
      const stracelLogFile = path.join(
        process.env.GITHUB_WORKSPACE || '.', 
        `strace-${repoName}-${timestamp}.log`
      );
      
      // Add output file option if not already specified
      if (!straceOptionsList.includes('-o') && !straceOptionsList.includes('--output')) {
        straceOptionsList.push('-o', stracelLogFile);
        core.info(`Strace output will be saved to: ${stracelLogFile}`);
      }
      
      // Use strace to wrap the node process with explicit exit handling
      const options = {
        cwd: actionDir,
        env: envVars,
        listeners: {
          stdout: (data) => {
            const output = data.toString();
            // Just pass through stdout from the child process
            process.stdout.write(output);
          },
          stderr: (data) => {
            const output = data.toString();
            // Just pass through stderr from the child process
            process.stderr.write(output);
          },
          debug: (message) => {
            core.debug(message);
          }
        },
        // This will provide access to the child process object
        ignoreReturnCode: false
      };
      
      // Use the exec implementation that gives us access to the child process
      const cp = await exec.getExecOutput("strace", [...straceOptionsList, "node", entryFile, ...args], options);
      core.debug(`Strace process completed with exit code: ${cp.exitCode}`);
      
      // Add helpful headers to the strace log file
      if (fs.existsSync(stracelLogFile)) {
        // Create a temporary file for the header
        const headerFile = `${stracelLogFile}.header`;
        const header = `
#=============================================================================
# Strace log for GitHub Action: ${actionRef}
# Date: ${new Date().toISOString()}
# Command: node ${entryFile} ${args.join(" ")}
# Options: ${straceOptions}
#=============================================================================

`;
        fs.writeFileSync(headerFile, header);
        
        // Concatenate the header and the original strace output
        const originalContent = fs.readFileSync(stracelLogFile);
        fs.writeFileSync(stracelLogFile, Buffer.concat([
          Buffer.from(header),
          originalContent
        ]));
        
        try {
          // Delete the temporary header file
          fs.unlinkSync(headerFile);
        } catch (error) {
          // Ignore any errors while deleting the temporary file
        }
      }
      
      // Export the strace log path as an output
      core.setOutput("strace-log", stracelLogFile);
      
    } catch (error) {
      // If strace is not available, fall back to running without it
      core.warning(`Strace is not available: ${error.message}`);
      core.info(`Executing nested action without strace: node ${entryFile} ${args.join(" ")}`);
      
      const options = {
        cwd: actionDir,
        env: envVars,
        listeners: {
          stdout: (data) => {
            const output = data.toString();
            process.stdout.write(output);
          },
          stderr: (data) => {
            const output = data.toString();
            process.stderr.write(output);
          },
          debug: (message) => {
            core.debug(message);
          }
        },
        ignoreReturnCode: false
      };
      
      // Use getExecOutput to get access to the child process
      const cp = await exec.getExecOutput("node", [entryFile, ...args], options);
      core.debug(`Node process completed with exit code: ${cp.exitCode}`);
    }
  } else {
    // Run without strace
    core.info(`Strace disabled. Executing nested action: node ${entryFile} ${args.join(" ")}`);
    
    const options = {
      cwd: actionDir,
      env: envVars,
      listeners: {
        stdout: (data) => {
          const output = data.toString();
          process.stdout.write(output);
        },
        stderr: (data) => {
          const output = data.toString();
          process.stderr.write(output);
        },
        debug: (message) => {
          core.debug(message);
        }
      },
      ignoreReturnCode: false
    };
    
    // Use getExecOutput to get access to the child process
    const cp = await exec.getExecOutput("node", [entryFile, ...args], options);
    core.debug(`Node process completed with exit code: ${cp.exitCode}`);
  }
}

function parseActionRef(refString) {
  const parts = refString.split("@");
  if (parts.length !== 2) {
    throw new Error("Invalid action-ref format. Expected 'owner/repo@ref'");
  }
  return parts;
}

run()
  .then(() => {
    core.debug('Action wrapper completed successfully');
    // Force exit to ensure we don't hang
    setTimeout(() => {
      core.debug('Forcing process exit to prevent hanging');
      process.exit(0);
    }, 500);
  })
  .catch(error => {
    core.setFailed(`Action wrapper failed: ${error.message}`);
    // Force exit to ensure we don't hang
    setTimeout(() => {
      core.debug('Forcing process exit to prevent hanging');
      process.exit(1);
    }, 500);
  });
