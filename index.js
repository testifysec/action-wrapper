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
    // Get core inputs
    const actionRef = core.getInput("action-ref");
    
    // Parse action-ref (expected format: owner/repo@ref)
    const [repo, ref] = parseActionRef(actionRef);
    core.info(`Parsed repo: ${repo}, ref: ${ref}`);

    // Construct URL for the repository ZIP archive.
    const isTag = !ref.includes('/');
    const zipUrl = isTag
      ? `https://github.com/${repo}/archive/refs/tags/${ref}.zip`
      : `https://github.com/${repo}/archive/refs/heads/${ref}.zip`;
    core.info(`Downloading action from: ${zipUrl}`);

    // Create a temporary directory and download/extract the ZIP archive
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nested-action-"));
    
    try {
      const response = await axios({
        url: zipUrl,
        method: "GET",
        responseType: "stream",
        maxRedirects: 5,
      });
      
      await new Promise((resolve, reject) => {
        response.data
          .pipe(unzipper.Extract({ path: tempDir }))
          .on("close", resolve)
          .on("error", reject);
      });
      
      core.info(`Downloaded and extracted to ${tempDir}`);
    } catch (error) {
      if (error.response && error.response.status === 404) {
        core.error(`Download failed with status 404`);
        
        // Try alternative URL format if first attempt failed
        if (isTag) {
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

    // Determine the extracted folder.
    const repoName = repo.split("/")[1];
    let actionDir = path.join(tempDir, `${repoName}-${ref}`);
    if (!fs.existsSync(actionDir)) {
      // Fallback: if only one folder exists in the temp directory, use it.
      const tempContents = fs.readdirSync(tempDir);
      if (
        tempContents.length === 1 &&
        fs.lstatSync(path.join(tempDir, tempContents[0])).isDirectory()
      ) {
        actionDir = path.join(tempDir, tempContents[0]);
        core.info(`Using alternative extracted folder: ${actionDir}`);
      } else {
        throw new Error(`Extracted folder not found in ${tempDir}`);
      }
    }

    // Read action configuration (action.yml or action.yaml)
    let actionConfig;
    const actionYmlPath = path.join(actionDir, "action.yml");
    const actionYamlPath = path.join(actionDir, "action.yaml");
    if (fs.existsSync(actionYmlPath)) {
      actionConfig = yaml.load(fs.readFileSync(actionYmlPath, "utf8"));
    } else if (fs.existsSync(actionYamlPath)) {
      actionConfig = yaml.load(fs.readFileSync(actionYamlPath, "utf8"));
    } else {
      throw new Error(`Neither action.yml nor action.yaml found in ${actionDir}`);
    }

    // Debug: Log the action's inputs section
    if (actionConfig.inputs) {
      core.info(`Nested action inputs: ${JSON.stringify(Object.keys(actionConfig.inputs))}`);
      // Check specifically for the who-to-greet input
      if (actionConfig.inputs['who-to-greet']) {
        core.info(`Found 'who-to-greet' input in action definition. Required: ${actionConfig.inputs['who-to-greet'].required}`);
      }
    }

    const entryPoint = actionConfig.runs && actionConfig.runs.main;
    if (!entryPoint) {
      throw new Error("Entry point (runs.main) not defined in action metadata");
    }
    core.info(`Nested action entry point: ${entryPoint}`);

    const entryFile = path.join(actionDir, entryPoint);
    if (!fs.existsSync(entryFile)) {
      throw new Error(`Entry file ${entryFile} does not exist.`);
    }

    // Optionally install dependencies if a package.json exists
    const pkgJsonPath = path.join(actionDir, "package.json");
    if (fs.existsSync(pkgJsonPath)) {
      core.info("Installing dependencies...");
      await exec.exec("npm", ["install"], { cwd: actionDir, env: process.env });
    }

    // Define a list of inputs that are specific to the wrapper action
    const wrapperInputs = [
      'ACTION_REF', 'COMMAND', 'WITNESS_VERSION', 'WITNESS_INSTALL_DIR', 
      'STEP', 'ATTESTATIONS', 'OUTFILE', 'ENABLE_ARCHIVISTA', 'ARCHIVISTA_SERVER',
      'CERTIFICATE', 'KEY', 'INTERMEDIATES', 'ENABLE_SIGSTORE', 'FULCIO',
      'FULCIO_OIDC_CLIENT_ID', 'FULCIO_OIDC_ISSUER', 'FULCIO_TOKEN',
      'TIMESTAMP_SERVERS', 'TRACE', 'SPIFFE_SOCKET', 'PRODUCT_EXCLUDE_GLOB',
      'PRODUCT_INCLUDE_GLOB', 'ATTESTOR_LINK_EXPORT', 'ATTESTOR_SBOM_EXPORT',
      'ATTESTOR_SLSA_EXPORT', 'ATTESTOR_MAVEN_POM_PATH'
    ];

    // Process inputs for nested action
    const envVars = { ...process.env };
    
    // Log what we're doing
    core.info("Forwarding inputs to nested action:");
    
    // For each INPUT_* environment variable
    Object.keys(process.env)
      .filter(key => key.startsWith('INPUT_'))
      .forEach(key => {
        // Get just the input name part (after INPUT_ prefix)
        const inputName = key.substring(6); 
        
        // If this is not a wrapper-specific input, preserve it for the nested action
        if (!wrapperInputs.includes(inputName)) {
          // The name GitHub Actions would use (replace hyphens with underscores)
          const normalizedKey = 'INPUT_' + inputName.replace(/-/g, '_');
          
          // Passthrough any input that isn't specific to the wrapper
          core.info(`➡️ Forwarding ${normalizedKey}="${process.env[key]}" to nested action`);
          
          // Re-set it in the environment with proper naming (underscores, not hyphens)
          envVars[normalizedKey] = process.env[key];
        } else {
          core.debug(`Skipping wrapper-specific input: ${key}`);
        }
      });
    
    // Specifically check for who-to-greet which is often required
    const whoToGreetInput = process.env['INPUT_WHO_TO_GREET'] || process.env['INPUT_WHO-TO-GREET'];
    if (whoToGreetInput) {
      envVars['INPUT_WHO_TO_GREET'] = whoToGreetInput;
      core.info(`✅ Set INPUT_WHO_TO_GREET="${whoToGreetInput}"`);
    }
    
    // Prepare the nested action command
    const nodeCmd = "node";
    const nodeArgs = [entryFile];
    
    // Execute the nested action
    core.info(`Executing nested action: ${nodeCmd} ${entryFile}`);
    
    // All environment variables are passed along
    const execOptions = {
      cwd: actionDir,
      env: envVars,
      listeners: {
        stdout: (data) => process.stdout.write(data.toString()),
        stderr: (data) => process.stderr.write(data.toString()),
      },
    };
    
    await exec.exec(nodeCmd, nodeArgs, execOptions);
    
  } catch (error) {
    core.setFailed(`Action failed: ${error.message}`);
    
    // Provide more detailed error information
    if (error.response) {
      core.error(`HTTP status: ${error.response.status}`);
      if (error.response.data) {
        core.error(`Response data: ${JSON.stringify(error.response.data)}`);
      }
    }
  }
}

// Helper to parse an action reference of the form "owner/repo@ref"
function parseActionRef(refString) {
  const parts = refString.split("@");
  if (parts.length !== 2) {
    throw new Error("Invalid action-ref format. Expected 'owner/repo@ref'");
  }
  return parts;
}

run();