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
  core.warning(`Action timed out after ${MAX_ACTION_DURATION_MS / 60000} minutes. This is likely a bug in the action wrapper. Forcing exit.`);
  process.exit(1);
}, MAX_ACTION_DURATION_MS);

// Make sure the timeout doesn't prevent the process from exiting naturally
actionTimeoutId.unref();

async function run() {
  try {
    // Step 1: Get Witness-related inputs
    const witnessVersion = core.getInput("witness-version") || "0.2.11";
    const witnessInstallDir = core.getInput("witness-install-dir") || "./";

    // Step 2: First download Witness binary
    await downloadWitness(witnessVersion, witnessInstallDir);

    // Step 3: Now handle the GitHub Action wrapping
    const actionRef = core.getInput("action-ref");
    const downloadedActionDir = await downloadAndExtractAction(actionRef);

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




    // Step 5: Run the downloaded action with Witness
    const witnessOutput = await runActionWithWitness(
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
    if (error.response) {
      core.error(`HTTP status: ${error.response.status}`);
    }
  }
}

// Download and install Witness
async function downloadWitness(version, installDir) {
  // Check if Witness is already in the tool cache
  let witnessPath = tc.find("witness", version);
  console.log("Cached Witness Path: " + witnessPath);

  if (!witnessPath) {
    console.log("Witness not found in cache, downloading now");
    let witnessTar;

    // Determine the OS-specific download URL
    if (process.platform === "win32") {
      witnessTar = await tc.downloadTool(
        "https://github.com/in-toto/witness/releases/download/v" +
        version +
        "/witness_" +
        version +
        "_windows_amd64.tar.gz"
      );
    } else if (process.platform === "darwin") {
      witnessTar = await tc.downloadTool(
        "https://github.com/in-toto/witness/releases/download/v" +
        version +
        "/witness_" +
        version +
        "_darwin_amd64.tar.gz"
      );
    } else {
      witnessTar = await tc.downloadTool(
        "https://github.com/in-toto/witness/releases/download/v" +
        version +
        "/witness_" +
        version +
        "_linux_amd64.tar.gz"
      );
    }

    // Create the install directory if it doesn't exist
    if (!fs.existsSync(installDir)) {
      console.log("Creating witness install directory at " + installDir);
      fs.mkdirSync(installDir, { recursive: true });
    }

    // Extract and cache Witness
    console.log("Extracting witness at: " + installDir);
    witnessPath = await tc.extractTar(witnessTar, installDir);

    const cachedPath = await tc.cacheFile(
      path.join(witnessPath, "witness"),
      "witness",
      "witness",
      version
    );
    console.log("Witness cached at: " + cachedPath);

    witnessPath = cachedPath;
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



  // To this:
  let {
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

  //log all the inputs
  Object.keys(process.env).forEach(key => {
    core.info(`Key: ${key}, Value: ${process.env[key]}`);
  }
  );

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

  // Build the witness run command
  const cmd = ["run"];

  if (enableSigstore) {
    fulcio = fulcio || "https://fulcio.sigstore.dev";
    fulcioOidcClientId = fulcioOidcClientId || "sigstore";
    fulcioOidcIssuer = fulcioOidcIssuer || "https://oauth2.sigstore.dev/auth";
    timestampServers = "https://freetsa.org/tsr " + timestampServers;
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
  if (fulcio) cmd.push(`--signer-fulcio-url=${fulcio}`);
  if (fulcioOidcClientId) cmd.push(`--signer-fulcio-oidc-client-id=${fulcioOidcClientId}`);
  if (fulcioOidcIssuer) cmd.push(`--signer-fulcio-oidc-issuer=${fulcioOidcIssuer}`);
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

  if (timestampServers) {
    const timestampServerValues = timestampServers.split(" ");
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