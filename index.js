const core = require("@actions/core");
const exec = require("@actions/exec");
const { exit } = require("process");
const process = require("process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const axios = require("axios");
const unzipper = require("unzipper");
const yaml = require("js-yaml");
const tc = require("@actions/tool-cache");

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
  try {
    // Step 1: Get Witness-related inputs
    const witnessVersion = core.getInput("witness-version") || "0.8.1";
    const witnessInstallDir = core.getInput("witness-install-dir") || "./";
    
    // Log all inputs for debugging purposes
    core.info(`Action inputs received:`);
    Object.keys(process.env)
      .filter(key => key.startsWith('INPUT_'))
      .forEach(key => {
        // Mask sensitive inputs
        const isSensitive = key.includes('TOKEN') || key.includes('KEY');
        const value = isSensitive ? '***' : process.env[key];
        core.info(`  ${key}=${value}`);
      });
      
    // Specifically check if input-who-to-greet exists, which is needed for the hello-world action
    const whoToGreet = core.getInput('input-who-to-greet');
    if (whoToGreet) {
      core.info(`Found input-who-to-greet=${whoToGreet}`);
    } else {
      core.warning(`No input-who-to-greet found in inputs - this may cause issues with the hello-world action`);
    }
    
    // Step 2: First download Witness binary
    await downloadWitness(witnessVersion, witnessInstallDir);
    
    // Check if we have a direct command or if we're wrapping an action
    const directCommand = core.getInput("command");
    const actionRef = core.getInput("action-ref");
    
    // If both are specified, action-ref takes precedence
    let downloadedActionDir = null;
    let commandToRun = null;
    
    if (actionRef) {
      // Step 3a: Handle the GitHub Action wrapping
      downloadedActionDir = await downloadAndExtractAction(actionRef);
    } else if (directCommand) {
      // Step 3b: Use the direct command (for backward compatibility)
      commandToRun = directCommand;
      core.info(`Using direct command mode: ${commandToRun}`);
    } else {
      throw new Error("Either 'action-ref' or 'command' input must be provided");
    }
    
    // Step 4: Prepare witness command
    const step = core.getInput("step");
    const archivistaServer = core.getInput("archivista-server");
    const attestations = core.getInput("attestations").split(" ");
    const certificate = core.getInput("certificate");
    const enableArchivista = core.getInput("enable-archivista") === "true";
    let fulcio = core.getInput("fulcio");
    let fulcioOidcClientId = core.getInput("fulcio-oidc-client-id");
    let fulcioOidcIssuer = core.getInput("fulcio-oidc-issuer");
    const fulcioToken = core.getInput("fulcio-token");
    const intermediates = core.getInput("intermediates").split(" ");
    const key = core.getInput("key");
    let outfile = core.getInput("outfile");
    outfile = outfile
      ? outfile
      : path.join(os.tmpdir(), step + "-attestation.json");
    const productExcludeGlob = core.getInput("product-exclude-glob");
    const productIncludeGlob = core.getInput("product-include-glob");
    const spiffeSocket = core.getInput("spiffe-socket");
    
    let timestampServers = core.getInput("timestamp-servers");
    const trace = core.getInput("trace");
    const enableSigstore = core.getInput("enable-sigstore") === "true";
    
    const exportLink = core.getInput("attestor-link-export") === "true";
    const exportSBOM = core.getInput("attestor-sbom-export") === "true";
    const exportSLSA = core.getInput("attestor-slsa-export") === "true";
    const mavenPOM = core.getInput("attestor-maven-pom-path");
    
    // Step 5: Run with Witness (either action or direct command)
    let witnessOutput;
    if (downloadedActionDir) {
      // Run the downloaded action with Witness
      witnessOutput = await runActionWithWitness(
        downloadedActionDir,
        {
          step,
          archivistaServer,
          attestations,
          certificate,
          enableArchivista,
          fulcio,
          fulcioOidcClientId,
          fulcioOidcIssuer,
          fulcioToken,
          intermediates,
          key,
          outfile,
          productExcludeGlob,
          productIncludeGlob,
          spiffeSocket,
          timestampServers,
          trace,
          enableSigstore,
          exportLink,
          exportSBOM,
          exportSLSA,
          mavenPOM,
        }
      );
    } else {
      // Run direct command with Witness
      witnessOutput = await runDirectCommandWithWitness(
        commandToRun,
        {
          step,
          archivistaServer,
          attestations,
          certificate,
          enableArchivista,
          fulcio,
          fulcioOidcClientId,
          fulcioOidcIssuer,
          fulcioToken,
          intermediates,
          key,
          outfile,
          productExcludeGlob,
          productIncludeGlob,
          spiffeSocket,
          timestampServers,
          trace,
          enableSigstore,
          exportLink,
          exportSBOM,
          exportSLSA,
          mavenPOM,
        }
      );
    }
    
    // Step 6: Process the output
    const gitOIDs = extractDesiredGitOIDs(witnessOutput);
    
    for (const gitOID of gitOIDs) {
      console.log("Extracted GitOID:", gitOID);
      
      // Print the GitOID to the output
      core.setOutput("git_oid", gitOID);
      
      // Construct the artifact URL using Archivista server and GitOID
      const artifactURL = `${archivistaServer}/download/${gitOID}`;
      
      // Add Job Summary with Markdown content
      const summaryHeader = `
## Attestations Created
| Step | Attestors Run | Attestation GitOID
| --- | --- | --- |
`;
      
      // Try to access the step summary file
      try {
        if (process.env.GITHUB_STEP_SUMMARY) {
          // Read the contents of the file
          const summaryFile = fs.readFileSync(process.env.GITHUB_STEP_SUMMARY, {
            encoding: "utf-8",
          });
          
          // Check if the file contains the header
          const headerExists = summaryFile.includes(summaryHeader.trim());
          
          // If the header does not exist, append it to the file
          if (!headerExists) {
            fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryHeader);
          }
          
          // Construct the table row for the current step
          const tableRow = `| ${step} | ${attestations.join(", ")} | [${gitOID}](${artifactURL}) |\n`;
          
          // Append the table row to the file
          fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, tableRow);
        }
      } catch (error) {
        core.warning(`Could not write to GitHub step summary: ${error.message}`);
      }
    }
  } catch (error) {
    core.setFailed(`Wrapper action failed: ${error.message}`);
    
    // Provide more detailed error information
    if (error.response) {
      core.error(`HTTP status: ${error.response.status}`);
      core.error(`Response data: ${JSON.stringify(error.response.data || {})}`);
      core.error(`Response headers: ${JSON.stringify(error.response.headers || {})}`);
      
      if (error.response.status === 404) {
        core.error(`A 404 error occurred. This might indicate that the specified Witness version doesn't exist.`);
        core.error(`Check https://github.com/testifysec/witness/releases for available versions.`);
        core.error(`You might want to update the 'witness-version' input parameter in your workflow.`);
      }
    }
    
    // Log the full error for debugging
    core.debug(`Full error object: ${JSON.stringify(error)}`);
    
    // Check for specific error types and give helpful messages
    if (error.code === 'ENOENT') {
      core.error(`File not found error. Check that all paths are correct and files exist.`);
    } else if (error.code === 'EACCES') {
      core.error(`Permission denied error. Check file permissions.`);
    }
  }
}

// Download and install Witness
async function downloadWitness(version, installDir) {
  // Check if Witness is already in the tool cache
  let witnessPath = tc.find("witness", version);
  core.info("Cached Witness Path: " + witnessPath);
  
  if (!witnessPath) {
    core.info("Witness not found in cache, downloading now");
    let witnessTar;
    let downloadUrl = "";
    
    // Determine the OS-specific download URL
    if (process.platform === "win32") {
      downloadUrl = `https://github.com/testifysec/witness/releases/download/v${version}/witness_${version}_windows_amd64.tar.gz`;
    } else if (process.platform === "darwin") {
      downloadUrl = `https://github.com/testifysec/witness/releases/download/v${version}/witness_${version}_darwin_amd64.tar.gz`;
    } else {
      downloadUrl = `https://github.com/testifysec/witness/releases/download/v${version}/witness_${version}_linux_amd64.tar.gz`;
    }
    
    core.info(`Downloading Witness from: ${downloadUrl}`);

    try {
      // Try the TestifySec repo first (this is likely where Witness is now)
      witnessTar = await tc.downloadTool(downloadUrl);
    } catch (error) {
      // If that fails, try the in-toto repo
      const fallbackUrl = downloadUrl.replace('testifysec', 'in-toto');
      core.info(`Primary download failed. Trying fallback URL: ${fallbackUrl}`);
      
      try {
        witnessTar = await tc.downloadTool(fallbackUrl);
      } catch (fallbackError) {
        core.error(`Failed to download Witness from both repositories.`);
        core.error(`Primary URL error: ${error.message}`);
        core.error(`Fallback URL error: ${fallbackError.message}`);
        
        // Suggest alternative versions to try
        core.error(`Try a different version (suggested: 0.3.0, 0.2.12, 0.2.10) or check https://github.com/testifysec/witness/releases for available versions.`);
        throw new Error(`Could not download Witness v${version}. Please check available versions.`);
      }
    }

    // Create the install directory if it doesn't exist
    if (!fs.existsSync(installDir)) {
      core.info("Creating witness install directory at " + installDir);
      fs.mkdirSync(installDir, { recursive: true });
    }

    // Extract and cache Witness
    core.info("Extracting witness at: " + installDir);
    witnessPath = await tc.extractTar(witnessTar, installDir);
    
    try {
      const witnessExecutable = path.join(witnessPath, "witness");
      
      // Check if the witness executable exists in the expected path
      if (!fs.existsSync(witnessExecutable)) {
        core.info("Witness executable not found at expected path, looking for it...");
        // Look for the witness executable in the extracted directory
        const files = fs.readdirSync(witnessPath);
        core.info(`Files in extracted directory: ${files.join(', ')}`);
        
        // Try to find it in subdirectories
        let foundWitness = null;
        for (const file of files) {
          const filePath = path.join(witnessPath, file);
          if (fs.statSync(filePath).isDirectory()) {
            const subFiles = fs.readdirSync(filePath);
            core.info(`Files in ${file}: ${subFiles.join(', ')}`);
            if (subFiles.includes('witness')) {
              foundWitness = path.join(filePath, 'witness');
              break;
            }
          }
        }
        
        if (foundWitness) {
          core.info(`Found witness at: ${foundWitness}`);
          const cachedPath = await tc.cacheFile(
            foundWitness,
            "witness",
            "witness",
            version
          );
          core.info("Witness cached at: " + cachedPath);
          witnessPath = cachedPath;
        } else {
          throw new Error("Witness executable not found in extracted archive");
        }
      } else {
        const cachedPath = await tc.cacheFile(
          witnessExecutable,
          "witness",
          "witness",
          version
        );
        core.info("Witness cached at: " + cachedPath);
        witnessPath = cachedPath;
      }
    } catch (error) {
      core.error(`Error caching Witness: ${error.message}`);
      // Display directory contents for debugging
      try {
        const files = fs.readdirSync(witnessPath);
        core.info(`Files in extracted directory: ${files.join(', ')}`);
      } catch (e) {
        core.error(`Could not list directory contents: ${e.message}`);
      }
      throw error;
    }
  }

  // Add Witness to the PATH
  core.addPath(witnessPath);
  return witnessPath;
}

// Download and extract a GitHub Action
async function downloadAndExtractAction(actionRef) {
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
      return alternateFolder;
    } else {
      throw new Error(`Extracted folder ${extractedFolder} not found and could not determine alternative.`);
    }
  }

  return extractedFolder;
}

// Run an action with Witness
async function runActionWithWitness(actionDir, witnessOptions) {
  const {
    step,
    archivistaServer,
    attestations,
    certificate,
    enableArchivista,
    fulcio,
    fulcioOidcClientId,
    fulcioOidcIssuer,
    fulcioToken,
    intermediates,
    key,
    outfile,
    productExcludeGlob,
    productIncludeGlob,
    spiffeSocket,
    timestampServers,
    trace,
    enableSigstore,
    exportLink,
    exportSBOM,
    exportSLSA,
    mavenPOM,
  } = witnessOptions;

  // Read action.yml from the downloaded action
  const actionYmlPath = path.join(actionDir, "action.yml");
  // Some actions use action.yaml instead of action.yml
  const actionYamlPath = path.join(actionDir, "action.yaml");
  
  let actionConfig;
  
  let actionYmlContent;
  if (fs.existsSync(actionYmlPath)) {
    actionYmlContent = fs.readFileSync(actionYmlPath, "utf8");
    actionConfig = yaml.load(actionYmlContent);
  } else if (fs.existsSync(actionYamlPath)) {
    actionYmlContent = fs.readFileSync(actionYamlPath, "utf8");
    actionConfig = yaml.load(actionYmlContent);
  } else {
    throw new Error(`Neither action.yml nor action.yaml found in ${actionDir}`);
  }
  
  // Debug: Log the action's inputs section
  if (actionConfig.inputs) {
    core.info(`Nested action inputs: ${JSON.stringify(Object.keys(actionConfig.inputs))}`);
    // Check specifically for the who-to-greet input
    if (actionConfig.inputs['who-to-greet']) {
      core.info(`Found 'who-to-greet' input in action definition. Required: ${actionConfig.inputs['who-to-greet'].required}`);
    } else {
      core.warning(`Nested action doesn't define 'who-to-greet' input in its action.yml!`);
    }
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
    
    // Log package.json contents for debugging
    try {
      const pkgJson = require(pkgJsonPath);
      core.info(`Nested action package.json name: ${pkgJson.name}, version: ${pkgJson.version}`);
      if (pkgJson.dependencies) {
        core.info(`Dependencies: ${JSON.stringify(pkgJson.dependencies)}`);
      }
      if (pkgJson.inputs) {
        core.info(`Action inputs: ${JSON.stringify(pkgJson.inputs)}`);
      }
    } catch (error) {
      core.warning(`Could not read package.json: ${error.message}`);
    }
    
    await exec.exec("npm", ["install"], { cwd: actionDir });
  }

  // Create a clean environment for the nested action with all inputs passed through
  // Debug all available inputs (use core.debug to reduce noise in normal execution)
  core.debug("All available inputs in the environment:");
  Object.keys(process.env)
    .filter(key => key.startsWith('INPUT_'))
    .forEach(key => {
      // Mask sensitive inputs
      const isSensitive = key.includes('TOKEN') || key.includes('KEY');
      const value = isSensitive ? '***' : process.env[key];
      core.debug(`${key}: ${value}`);
    });
  
  // Start with a copy of the current environment
  const envVars = { ...process.env };
  
  // Define a list of inputs that are specific to the wrapper action
  const wrapperSpecificInputs = [
    'ACTION_REF', 'COMMAND', 'WITNESS_VERSION', 'WITNESS_INSTALL_DIR', 
    'STEP', 'ATTESTATIONS', 'OUTFILE', 'ENABLE_ARCHIVISTA', 'ARCHIVISTA_SERVER',
    'CERTIFICATE', 'KEY', 'INTERMEDIATES', 'ENABLE_SIGSTORE', 'FULCIO',
    'FULCIO_OIDC_CLIENT_ID', 'FULCIO_OIDC_ISSUER', 'FULCIO_TOKEN',
    'TIMESTAMP_SERVERS', 'TRACE', 'SPIFFE_SOCKET', 'PRODUCT_EXCLUDE_GLOB',
    'PRODUCT_INCLUDE_GLOB', 'ATTESTOR_LINK_EXPORT', 'ATTESTOR_SBOM_EXPORT',
    'ATTESTOR_SLSA_EXPORT', 'ATTESTOR_MAVEN_POM_PATH', 'EXTRA_ARGS'
  ];

  // Log what we're doing
  core.info("Forwarding inputs to nested action:");

  // For each INPUT_* environment variable
  Object.keys(process.env)
    .filter(key => key.startsWith('INPUT_'))
    .forEach(key => {
      // Get just the input name part (after INPUT_ prefix)
      const inputName = key.substring(6); 
      
      // If this is not a wrapper-specific input, preserve it for the nested action
      if (!wrapperSpecificInputs.includes(inputName)) {
        // Passthrough any input that isn't specific to the wrapper
        core.info(`➡️ Forwarding ${key}="${process.env[key]}" to nested action`);
        
        // Re-set it in the environment to ensure it's passed to the subprocess
        envVars[key] = process.env[key];
      } else {
        core.debug(`Skipping wrapper-specific input: ${key}`);
      }
    });
  
  // For debugging, log all environment vars being passed to the nested action
  core.info(`Passing these inputs to nested action Witness command:`);
  Object.keys(envVars)
    .filter(key => key.startsWith('INPUT_'))
    .forEach(key => {
      core.info(`  ${key}=${envVars[key]}`);
    });
    
  // Debug specifically the who-to-greet input which is required for hello-world action
  if (envVars['INPUT_WHO_TO_GREET']) {
    core.info(`✅ Found required input WHO_TO_GREET = ${envVars['INPUT_WHO_TO_GREET']}`);
  } else {
    core.warning(`❌ Required input WHO_TO_GREET not found in environment variables!`);
    // Display all available input-* variables for debugging
    Object.keys(process.env)
      .filter(key => key.startsWith('INPUT_') && key.includes('WHO_TO_GREET'))
      .forEach(key => {
        core.warning(`  Found similar input: ${key}=${process.env[key]}`);
      });
  }
  
  // Build the witness run command
  const cmd = ["run"];

  // Create local variables for the values we might modify
  let fulcioUrl = fulcio;
  let fulcioClientId = fulcioOidcClientId;
  let fulcioIssuer = fulcioOidcIssuer;
  let tsServers = timestampServers;

  if (enableSigstore) {
    fulcioUrl = fulcioUrl || "https://fulcio.sigstore.dev";
    fulcioClientId = fulcioClientId || "sigstore";
    fulcioIssuer = fulcioIssuer || "https://oauth2.sigstore.dev/auth";
    tsServers = "https://freetsa.org/tsr " + tsServers;
  }

  if (attestations.length) {
    attestations.forEach((attestation) => {
      attestation = attestation.trim();
      if (attestation.length > 0) {
        cmd.push(`-a=${attestation}`);
      }
    });
  }

  if (exportLink) cmd.push(`--attestor-link-export`);
  if (exportSBOM) cmd.push(`--attestor-sbom-export`);
  if (exportSLSA) cmd.push(`--attestor-slsa-export`);

  if (mavenPOM) cmd.push(`--attestor-maven-pom-path=${mavenPOM}`);

  if (certificate) cmd.push(`--certificate=${certificate}`);
  if (enableArchivista) cmd.push(`--enable-archivista=${enableArchivista}`);
  if (archivistaServer) cmd.push(`--archivista-server=${archivistaServer}`);
  if (fulcioUrl) cmd.push(`--signer-fulcio-url=${fulcioUrl}`);
  if (fulcioClientId) cmd.push(`--signer-fulcio-oidc-client-id=${fulcioClientId}`);
  if (fulcioIssuer) cmd.push(`--signer-fulcio-oidc-issuer=${fulcioIssuer}`);
  if (fulcioToken) cmd.push(`--signer-fulcio-token=${fulcioToken}`);

  if (intermediates.length) {
    intermediates.forEach((intermediate) => {
      intermediate = intermediate.trim();
      if (intermediate.length > 0) {
        cmd.push(`-i=${intermediate}`);
      }
    });
  }

  if (key) cmd.push(`--key=${key}`);
  if (productExcludeGlob) cmd.push(`--attestor-product-exclude-glob=${productExcludeGlob}`);
  if (productIncludeGlob) cmd.push(`--attestor-product-include-glob=${productIncludeGlob}`);
  if (spiffeSocket) cmd.push(`--spiffe-socket=${spiffeSocket}`);
  if (step) cmd.push(`-s=${step}`);

  if (tsServers) {
    const timestampServerValues = tsServers.split(" ");
    timestampServerValues.forEach((timestampServer) => {
      timestampServer = timestampServer.trim();
      if (timestampServer.length > 0) {
        cmd.push(`--timestamp-servers=${timestampServer}`);
      }
    });
  }

  if (trace) cmd.push(`--trace=${trace}`);
  if (outfile) cmd.push(`--outfile=${outfile}`);
  
  // Prepare the command to run the action
  const nodeCmd = 'node';
  const nodeArgs = [entryFile];
  
  // Execute the command and capture its output
  const runArray = ["witness", ...cmd, "--", nodeCmd, ...nodeArgs],
    commandString = runArray.join(" ");

  core.info(`Running witness command: ${commandString}`);
  
  // Verify we have the required inputs for hello-world action
  if (envVars['INPUT_WHO_TO_GREET']) {
    core.info(`✓ Found WHO_TO_GREET in envVars before exec: ${envVars['INPUT_WHO_TO_GREET']}`);
  } else {
    core.warning(`⚠️ WHO_TO_GREET missing from envVars - adding it from explicit source`);
    const whoToGreet = process.env['INPUT_INPUT_WHO_TO_GREET'] || process.env['INPUT_WHO_TO_GREET'];
    if (whoToGreet) {
      envVars['INPUT_WHO_TO_GREET'] = whoToGreet;
      core.info(`✓ Set INPUT_WHO_TO_GREET=${whoToGreet} from explicit source`);
    } else {
      core.error(`❌ Failed to find who-to-greet input in any form!`);
    }
  }
  
  // Set up options for execution
  const execOptions = {
    cwd: actionDir,
    env: envVars,
    listeners: {
      stdout: (data) => {
        process.stdout.write(data.toString());
      },
      stderr: (data) => {
        process.stderr.write(data.toString());
      }
    }
  };
  
  // Execute and capture output
  let output = '';
  
  await exec.exec('sh', ['-c', commandString], {
    ...execOptions,
    listeners: {
      ...execOptions.listeners,
      stdout: (data) => {
        const str = data.toString();
        output += str;
        process.stdout.write(str);
      },
      stderr: (data) => {
        const str = data.toString();
        output += str;
        process.stderr.write(str);
      }
    }
  });
  
  return output;
}

// Extract GitOIDs from witness output
function extractDesiredGitOIDs(output) {
  const lines = output.split("\n");
  const desiredSubstring = "Stored in archivista as ";

  const matchArray = [];
  console.log("Looking for GitOID in the output");
  for (const line of lines) {
    const startIndex = line.indexOf(desiredSubstring);
    if (startIndex !== -1) {
      console.log("Checking line: ", line);
      const match = line.match(/[0-9a-fA-F]{64}/);
      if (match) {
        console.log("Found GitOID: ", match[0]);
        matchArray.push(match[0]);
      }
    }
  }

  return matchArray;
}

// Run a direct command with Witness
async function runDirectCommandWithWitness(command, witnessOptions) {
  const {
    step,
    archivistaServer,
    attestations,
    certificate,
    enableArchivista,
    fulcio,
    fulcioOidcClientId,
    fulcioOidcIssuer,
    fulcioToken,
    intermediates,
    key,
    outfile,
    productExcludeGlob,
    productIncludeGlob,
    spiffeSocket,
    timestampServers,
    trace,
    enableSigstore,
    exportLink,
    exportSBOM,
    exportSLSA,
    mavenPOM,
  } = witnessOptions;

  // Build the witness run command
  const cmd = ["run"];

  // Create local variables for the values we might modify
  let fulcioUrl = fulcio;
  let fulcioClientId = fulcioOidcClientId;
  let fulcioIssuer = fulcioOidcIssuer;
  let tsServers = timestampServers;

  if (enableSigstore) {
    fulcioUrl = fulcioUrl || "https://fulcio.sigstore.dev";
    fulcioClientId = fulcioClientId || "sigstore";
    fulcioIssuer = fulcioIssuer || "https://oauth2.sigstore.dev/auth";
    tsServers = "https://freetsa.org/tsr " + tsServers;
  }

  if (attestations.length) {
    attestations.forEach((attestation) => {
      attestation = attestation.trim();
      if (attestation.length > 0) {
        cmd.push(`-a=${attestation}`);
      }
    });
  }

  if (exportLink) cmd.push(`--attestor-link-export`);
  if (exportSBOM) cmd.push(`--attestor-sbom-export`);
  if (exportSLSA) cmd.push(`--attestor-slsa-export`);

  if (mavenPOM) cmd.push(`--attestor-maven-pom-path=${mavenPOM}`);

  if (certificate) cmd.push(`--certificate=${certificate}`);
  if (enableArchivista) cmd.push(`--enable-archivista=${enableArchivista}`);
  if (archivistaServer) cmd.push(`--archivista-server=${archivistaServer}`);
  if (fulcioUrl) cmd.push(`--signer-fulcio-url=${fulcioUrl}`);
  if (fulcioClientId) cmd.push(`--signer-fulcio-oidc-client-id=${fulcioClientId}`);
  if (fulcioIssuer) cmd.push(`--signer-fulcio-oidc-issuer=${fulcioIssuer}`);
  if (fulcioToken) cmd.push(`--signer-fulcio-token=${fulcioToken}`);

  if (intermediates.length) {
    intermediates.forEach((intermediate) => {
      intermediate = intermediate.trim();
      if (intermediate.length > 0) {
        cmd.push(`-i=${intermediate}`);
      }
    });
  }

  if (key) cmd.push(`--key=${key}`);
  if (productExcludeGlob) cmd.push(`--attestor-product-exclude-glob=${productExcludeGlob}`);
  if (productIncludeGlob) cmd.push(`--attestor-product-include-glob=${productIncludeGlob}`);
  if (spiffeSocket) cmd.push(`--spiffe-socket=${spiffeSocket}`);
  if (step) cmd.push(`-s=${step}`);

  if (tsServers) {
    const timestampServerValues = tsServers.split(" ");
    timestampServerValues.forEach((timestampServer) => {
      timestampServer = timestampServer.trim();
      if (timestampServer.length > 0) {
        cmd.push(`--timestamp-servers=${timestampServer}`);
      }
    });
  }

  if (trace) cmd.push(`--trace=${trace}`);
  if (outfile) cmd.push(`--outfile=${outfile}`);
  
  // Parse the command into an array if it's not already
  const commandArray = command.match(/(?:[^\s"]+|"[^"]*")+/g) || [command];
  
  // Execute the command and capture its output
  const runArray = ["witness", ...cmd, "--", ...commandArray];
  const commandString = runArray.join(" ");

  core.info(`Running witness command: ${commandString}`);
  
  // Set up options for execution
  const execOptions = {
    cwd: process.env.GITHUB_WORKSPACE || process.cwd(),
    env: { ...process.env },  // Create a copy to avoid modifying the original
    listeners: {
      stdout: (data) => {
        process.stdout.write(data.toString());
      },
      stderr: (data) => {
        process.stderr.write(data.toString());
      }
    }
  };
  
  // Define a list of inputs that are specific to the wrapper action
  const wrapperSpecificInputs = [
    'ACTION_REF', 'COMMAND', 'WITNESS_VERSION', 'WITNESS_INSTALL_DIR', 
    'STEP', 'ATTESTATIONS', 'OUTFILE', 'ENABLE_ARCHIVISTA', 'ARCHIVISTA_SERVER',
    'CERTIFICATE', 'KEY', 'INTERMEDIATES', 'ENABLE_SIGSTORE', 'FULCIO',
    'FULCIO_OIDC_CLIENT_ID', 'FULCIO_OIDC_ISSUER', 'FULCIO_TOKEN',
    'TIMESTAMP_SERVERS', 'TRACE', 'SPIFFE_SOCKET', 'PRODUCT_EXCLUDE_GLOB',
    'PRODUCT_INCLUDE_GLOB', 'ATTESTOR_LINK_EXPORT', 'ATTESTOR_SBOM_EXPORT',
    'ATTESTOR_SLSA_EXPORT', 'ATTESTOR_MAVEN_POM_PATH', 'EXTRA_ARGS'
  ];

  // Log what we're doing
  core.info("For direct command: Forwarding inputs to command environment:");

  // For each INPUT_* environment variable
  Object.keys(process.env)
    .filter(key => key.startsWith('INPUT_'))
    .forEach(key => {
      // Get just the input name part (after INPUT_ prefix)
      const inputName = key.substring(6); 
      
      // If this is not a wrapper-specific input, preserve it for the command
      if (!wrapperSpecificInputs.includes(inputName)) {
        // Passthrough any input that isn't specific to the wrapper
        core.info(`➡️ For direct command: Forwarding ${key}="${process.env[key]}"`);
        
        // Re-set it in the environment to ensure it's passed to the subprocess
        execOptions.env[key] = process.env[key];
      } else {
        core.debug(`For direct command: Skipping wrapper-specific input: ${key}`);
      }
    });
    
  // For debugging, log all inputs that will be passed to the command
  core.info(`Direct command will have these inputs available:`);
  Object.keys(execOptions.env)
    .filter(key => key.startsWith('INPUT_'))
    .forEach(key => {
      core.info(`  ${key}=${execOptions.env[key]}`);
    });
    
  // Debug specifically the who-to-greet input which is required for hello-world action
  if (execOptions.env['INPUT_WHO_TO_GREET']) {
    core.info(`✅ For direct command: Found required input WHO_TO_GREET = ${execOptions.env['INPUT_WHO_TO_GREET']}`);
  } else {
    core.warning(`⚠️ For direct command: WHO_TO_GREET missing from envVars - adding it from explicit source`);
    const whoToGreet = process.env['INPUT_INPUT_WHO_TO_GREET'] || process.env['INPUT_WHO_TO_GREET'];
    if (whoToGreet) {
      execOptions.env['INPUT_WHO_TO_GREET'] = whoToGreet;
      core.info(`✓ Set INPUT_WHO_TO_GREET=${whoToGreet} from explicit source`);
    } else {
      core.error(`❌ Failed to find who-to-greet input in any form!`);
      // Display all available input-* variables for debugging
      Object.keys(process.env)
        .filter(key => key.startsWith('INPUT_') && key.includes('WHO'))
        .forEach(key => {
          core.warning(`  Found similar input: ${key}=${process.env[key]}`);
        });
    }
  }
  
  // Execute and capture output
  let output = '';
  
  await exec.exec('sh', ['-c', commandString], {
    ...execOptions,
    listeners: {
      ...execOptions.listeners,
      stdout: (data) => {
        const str = data.toString();
        output += str;
        process.stdout.write(str);
      },
      stderr: (data) => {
        const str = data.toString();
        output += str;
        process.stderr.write(str);
      }
    }
  });
  
  return output;
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