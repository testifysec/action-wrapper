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
    
    // Default wrapper settings
    const defaultWrapperCommand = "strace -f -v -s 256 -e trace=file,process,network,signal,ipc,desc,memory";
    
    // Handle backward compatibility with strace-specific options
    let enableWrapper = core.getInput("enable-wrapper").toLowerCase();
    enableWrapper = enableWrapper === "" ? null : enableWrapper === "true";
    
    let enableStrace = core.getInput("enable-strace").toLowerCase();
    enableStrace = enableStrace === "" ? null : enableStrace === "true";
    
    // If enable-wrapper is not specified but enable-strace is, use enableStrace value
    const isWrapperEnabled = enableWrapper !== null ? enableWrapper : 
                           enableStrace !== null ? enableStrace : true;
    
    // If wrapper-command is not specified but strace-options is, construct strace command
    const straceOptions = core.getInput("strace-options") || "";
    let wrapperCommand = core.getInput("wrapper-command") || "";
    
    if (!wrapperCommand && straceOptions) {
      wrapperCommand = `strace ${straceOptions}`;
    } else if (!wrapperCommand) {
      wrapperCommand = defaultWrapperCommand;
    }
    
    core.info(`Command wrapper ${isWrapperEnabled ? 'enabled' : 'disabled'}: ${wrapperCommand}`);

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
        return await processAction(alternateFolder, extraArgs, repo, isWrapperEnabled, wrapperCommand);
      } else {
        throw new Error(`Extracted folder ${extractedFolder} not found and could not determine alternative.`);
      }
    }

    await processAction(extractedFolder, extraArgs, repo, isWrapperEnabled, wrapperCommand);
    
  } catch (error) {
    core.setFailed(`Wrapper action failed: ${error.message}`);
    if (error.response) {
      core.error(`HTTP status: ${error.response.status}`);
    }
  }
}

async function processAction(actionDir, extraArgs, repo, isWrapperEnabled, wrapperCommand) {
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
  
  // Common execution options
  const execOptions = {
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
  
  if (isWrapperEnabled && wrapperCommand) {
    // Extract the command name and its arguments
    const [wrapperCmd, ...wrapperArgs] = parseCommand(wrapperCommand);
    
    core.info(`Wrapper enabled: ${wrapperCmd} ${wrapperArgs.join(' ')}`);
    
    try {
      // Check if the wrapper command is available
      await exec.exec("which", [wrapperCmd]);
      
      // Determine whether we need to create an output log file
      let wrapperLogFile = null;
      
      // Check if the command is strace (backward compatibility) or if command
      // should output to a file (if it doesn't have -o or --output already)
      const isStrace = wrapperCmd === 'strace';
      const hasOutputOption = wrapperArgs.includes('-o') || wrapperArgs.includes('--output');
      
      // For strace or if no output option specified, create a log file
      if ((isStrace || shouldCreateLogFile(wrapperCmd)) && !hasOutputOption) {
        // Get repo name for the log file name
        const repoName = repo.split("/")[1];
        const timestamp = new Date().toISOString().replace(/:/g, '-');
        wrapperLogFile = path.join(
          process.env.GITHUB_WORKSPACE || '.', 
          `${wrapperCmd}-${repoName}-${timestamp}.log`
        );
        
        // Add output redirection option based on command type
        if (isStrace) {
          wrapperArgs.push('-o', wrapperLogFile);
        } else if (wrapperCmd === 'time') {
          // time uses -o for output
          wrapperArgs.push('-o', wrapperLogFile);
        } else {
          // For other commands, we'll handle output redirection separately
          // We'll capture the output and write it to a file
        }
        
        core.info(`Command output will be saved to: ${wrapperLogFile}`);
      }
      
      // Define the node command and arguments
      const nodeCmd = "node";
      const nodeArgs = [entryFile, ...args];
      
      // Execute the wrapped command
      let cp;
      if (wrapperLogFile && !hasOutputOption && !isStrace && wrapperCmd !== 'time') {
        // For commands that don't have built-in output file support, 
        // use shell redirection to log output
        const redirectCmd = `${wrapperCmd} ${wrapperArgs.join(' ')} ${nodeCmd} ${nodeArgs.join(' ')} > ${wrapperLogFile} 2>&1`;
        cp = await exec.getExecOutput('bash', ['-c', redirectCmd], execOptions);
      } else {
        // For commands with built-in output support or no logging needed
        cp = await exec.getExecOutput(wrapperCmd, [...wrapperArgs, nodeCmd, ...nodeArgs], execOptions);
      }
      
      core.debug(`Wrapper process completed with exit code: ${cp.exitCode}`);
      
      // Add helpful headers to the log file if it exists
      if (wrapperLogFile && fs.existsSync(wrapperLogFile)) {
        addHeaderToLogFile(
          wrapperLogFile, 
          wrapperCmd, 
          wrapperArgs.join(' '), 
          nodeCmd, 
          nodeArgs.join(' '), 
          repo
        );
      }
      
      // Set outputs
      if (wrapperLogFile) {
        core.setOutput("wrapper-log", wrapperLogFile);
        // For backward compatibility if it's strace
        if (isStrace) {
          core.setOutput("strace-log", wrapperLogFile);
        }
      }
      
    } catch (error) {
      // If the wrapper command is not available, fall back to running without it
      core.warning(`Wrapper command '${wrapperCmd}' is not available: ${error.message}`);
      core.info(`Executing nested action without wrapper: node ${entryFile} ${args.join(" ")}`);
      
      // Direct execution without wrapper
      const cp = await exec.getExecOutput("node", [entryFile, ...args], execOptions);
      core.debug(`Node process completed with exit code: ${cp.exitCode}`);
    }
  } else {
    // Run without any wrapper
    core.info(`Wrapper disabled. Executing nested action directly: node ${entryFile} ${args.join(" ")}`);
    
    // Direct execution without wrapper
    const cp = await exec.getExecOutput("node", [entryFile, ...args], execOptions);
    core.debug(`Node process completed with exit code: ${cp.exitCode}`);
  }
}

// Helper function to parse a command string into command and arguments
function parseCommand(commandString) {
  // Simple space-based split for now
  // This could be enhanced with proper shell-like parsing if needed
  return commandString.trim().split(/\s+/).filter(Boolean);
}

// Helper function to determine if we should create a log file for this command
function shouldCreateLogFile(command) {
  // List of commands that typically produce output we'd want to capture
  const loggableCommands = [
    'strace', 'time', 'ltrace', 'perf', 'valgrind', 
    'memcheck', 'gdb', 'prof', 'top', 'vmstat', 'iostat'
  ];
  
  return loggableCommands.includes(command);
}

// Helper function to add a header to a log file
function addHeaderToLogFile(logFile, wrapperCmd, wrapperArgs, cmd, cmdArgs, repo) {
  try {
    // Create a temporary file for the header
    const headerFile = `${logFile}.header`;
    const header = `
#=============================================================================
# ${wrapperCmd.toUpperCase()} log for GitHub Action: ${repo}
# Date: ${new Date().toISOString()}
# Wrapper: ${wrapperCmd} ${wrapperArgs}
# Command: ${cmd} ${cmdArgs}
#=============================================================================

`;
    fs.writeFileSync(headerFile, header);
    
    // Concatenate the header and the original output
    const originalContent = fs.readFileSync(logFile);
    fs.writeFileSync(logFile, Buffer.concat([
      Buffer.from(header),
      originalContent
    ]));
    
    try {
      // Delete the temporary header file
      fs.unlinkSync(headerFile);
    } catch (error) {
      // Ignore any errors while deleting the temporary file
    }
  } catch (error) {
    // If there's any error with the header, just log it and continue
    core.warning(`Could not add header to log file: ${error.message}`);
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
