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
  core.warning(`Action timed out after ${MAX_ACTION_DURATION_MS / 60000} minutes. Forcing exit.`);
  process.exit(1);
}, MAX_ACTION_DURATION_MS);
actionTimeoutId.unref();

async function run() {
  try {
    // Step 1: Get Witness-related inputs
    const witnessVersion = core.getInput("witness-version") || "0.2.11";
    const witnessInstallDir = core.getInput("witness-install-dir") || "./";

    // Step 2: Download Witness binary
    await downloadWitness(witnessVersion, witnessInstallDir);

    // Check for either a direct command or an action-ref (action-ref takes precedence)
    const directCommand = core.getInput("command");
    const actionRef = core.getInput("action-ref");
    let downloadedActionDir = null;
    let commandToRun = null;
    if (actionRef) {
      downloadedActionDir = await downloadAndExtractAction(actionRef);
    } else if (directCommand) {
      commandToRun = directCommand;
      core.info(`Using direct command mode: ${commandToRun}`);
    } else {
      throw new Error("Either 'action-ref' or 'command' input must be provided");
    }

    // Step 4: Prepare witness command inputs
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
    outfile = outfile ? outfile : path.join(os.tmpdir(), step + "-attestation.json");
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

    let witnessOutput;
    if (downloadedActionDir) {
      witnessOutput = await runActionWithWitness(downloadedActionDir, {
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
      });
    } else {
      witnessOutput = await runDirectCommandWithWitness(commandToRun, {
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
      });
    }

    // Step 6: Process output
    const gitOIDs = extractDesiredGitOIDs(witnessOutput);
    for (const gitOID of gitOIDs) {
      console.log("Extracted GitOID:", gitOID);
      core.setOutput("git_oid", gitOID);
      const artifactURL = `${archivistaServer}/download/${gitOID}`;
      const summaryHeader = `
## Attestations Created
| Step | Attestors Run | Attestation GitOID
| --- | --- | --- |
`;
      try {
        if (process.env.GITHUB_STEP_SUMMARY) {
          const summaryFile = fs.readFileSync(process.env.GITHUB_STEP_SUMMARY, { encoding: "utf-8" });
          if (!summaryFile.includes(summaryHeader.trim())) {
            fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryHeader);
          }
          const tableRow = `| ${step} | ${attestations.join(", ")} | [${gitOID}](${artifactURL}) |\n`;
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

async function downloadWitness(version, installDir) {
  let witnessPath = tc.find("witness", version);
  console.log("Cached Witness Path: " + witnessPath);
  if (!witnessPath) {
    console.log("Witness not found in cache, downloading now");
    let witnessTar;
    if (process.platform === "win32") {
      witnessTar = await tc.downloadTool(`https://github.com/in-toto/witness/releases/download/v${version}/witness_${version}_windows_amd64.tar.gz`);
    } else if (process.platform === "darwin") {
      witnessTar = await tc.downloadTool(`https://github.com/in-toto/witness/releases/download/v${version}/witness_${version}_darwin_amd64.tar.gz`);
    } else {
      witnessTar = await tc.downloadTool(`https://github.com/in-toto/witness/releases/download/v${version}/witness_${version}_linux_amd64.tar.gz`);
    }
    if (!fs.existsSync(installDir)) {
      console.log("Creating witness install directory at " + installDir);
      fs.mkdirSync(installDir, { recursive: true });
    }
    console.log("Extracting witness at: " + installDir);
    witnessPath = await tc.extractTar(witnessTar, installDir);
    const cachedPath = await tc.cacheFile(path.join(witnessPath, "witness"), "witness", "witness", version);
    console.log("Witness cached at: " + cachedPath);
    witnessPath = cachedPath;
  }
  core.addPath(witnessPath);
  return witnessPath;
}

async function downloadAndExtractAction(actionRef) {
  const [repo, ref] = parseActionRef(actionRef);
  core.info(`Parsed repo: ${repo}, ref: ${ref}`);
  const isTag = !ref.includes('/');
  const zipUrl = isTag
    ? `https://github.com/${repo}/archive/refs/tags/${ref}.zip`
    : `https://github.com/${repo}/archive/refs/heads/${ref}.zip`;
  core.info(`Downloading action from: ${zipUrl}`);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nested-action-"));
  try {
    const response = await axios({
      url: zipUrl,
      method: "GET",
      responseType: "stream",
      validateStatus: status => status >= 200 && status < 300,
      maxRedirects: 5
    });
    await new Promise((resolve, reject) => {
      response.data.pipe(unzipper.Extract({ path: tempDir })).on("close", resolve).on("error", reject);
    });
    core.info(`Downloaded and extracted to ${tempDir}`);
  } catch (error) {
    if (error.response) {
      core.error(`Download failed with status ${error.response.status}`);
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
          altResponse.data.pipe(unzipper.Extract({ path: tempDir })).on("close", resolve).on("error", reject);
        });
        core.info(`Downloaded and extracted from alternative URL to ${tempDir}`);
      } else {
        throw error;
      }
    } else {
      throw error;
    }
  }
  core.debug(`Temporary directory contents: ${fs.readdirSync(tempDir).join(', ')}`);
  const repoName = repo.split("/")[1];
  const extractedFolder = path.join(tempDir, `${repoName}-${ref}`);
  if (!fs.existsSync(extractedFolder)) {
    const tempContents = fs.readdirSync(tempDir);
    if (tempContents.length === 1 && fs.lstatSync(path.join(tempDir, tempContents[0])).isDirectory()) {
      const alternateFolder = path.join(tempDir, tempContents[0]);
      core.info(`Using alternative extracted folder: ${alternateFolder}`);
      return alternateFolder;
    } else {
      throw new Error(`Extracted folder ${extractedFolder} not found and could not determine alternative.`);
    }
  }
  return extractedFolder;
}

async function runActionWithWitness(actionDir, witnessOptions) {
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

  // Read the nested action metadata (action.yml or action.yaml)
  const actionYmlPath = path.join(actionDir, "action.yml");
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

  const entryFile = path.join(actionDir, entryPoint);
  if (!fs.existsSync(entryFile)) {
    throw new Error(`Entry file ${entryFile} does not exist.`);
  }

  // Optionally install dependencies if package.json exists
  const pkgJsonPath = path.join(actionDir, "package.json");
  if (fs.existsSync(pkgJsonPath)) {
    core.info("Installing dependencies for nested action...");
    await exec.exec("npm", ["install"], { cwd: actionDir });
  }

  // Build environment by merging process.env (ensuring all INPUT_* variables pass)
  const envVars = { ...process.env };
  // (Optionally, override specific inputs explicitly if needed)
  // For example:
  // envVars["INPUT_WHO-TO-GREET"] = core.getInput("who-to-greet");

  // Build the witness command argument array.
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
    timestampServers.split(" ").forEach((ts) => {
      ts = ts.trim();
      if (ts.length > 0) {
        cmd.push(`--timestamp-servers=${ts}`);
      }
    });
  }
  if (trace) cmd.push(`--trace=${trace}`);
  if (outfile) cmd.push(`--outfile=${outfile}`);

  // Build argument array for the nested action execution
  const nodeCmd = "node";
  const nodeArgs = [entryFile];
  const args = [...cmd, "--", nodeCmd, ...nodeArgs];
  core.info(`Running witness command: witness ${args.join(" ")}`);

  const execOptions = {
    cwd: actionDir,
    env: envVars,
    listeners: {
      stdout: (data) => process.stdout.write(data.toString()),
      stderr: (data) => process.stderr.write(data.toString())
    }
  };

  let output = "";
  // Directly call the witness binary without using a shell.
  await exec.exec("witness", args, {
    ...execOptions,
    listeners: {
      ...execOptions.listeners,
      stdout: (data) => {
        output += data.toString();
        process.stdout.write(data.toString());
      },
      stderr: (data) => {
        output += data.toString();
        process.stderr.write(data.toString());
      }
    }
  });
  return output;
}


async function runDirectCommandWithWitness(command, witnessOptions) {
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
    timestampServers.split(" ").forEach((ts) => {
      ts = ts.trim();
      if (ts.length > 0) {
        cmd.push(`--timestamp-servers=${ts}`);
      }
    });
  }
  if (trace) cmd.push(`--trace=${trace}`);
  if (outfile) cmd.push(`--outfile=${outfile}`);
  
  const commandArray = command.match(/(?:[^\s"]+|"[^"]*")+/g) || [command];
  const runArray = ["witness", ...cmd, "--", ...commandArray];
  const commandString = runArray.join(" ");
  core.info(`Running witness command: ${commandString}`);
  
  const execOptions = {
    cwd: process.env.GITHUB_WORKSPACE || process.cwd(),
    env: process.env,
    listeners: {
      stdout: data => process.stdout.write(data.toString()),
      stderr: data => process.stderr.write(data.toString())
    }
  };
  let output = '';
  await exec.exec('sh', ['-c', commandString], {
    ...execOptions,
    listeners: {
      ...execOptions.listeners,
      stdout: data => { output += data.toString(); process.stdout.write(data.toString()); },
      stderr: data => { output += data.toString(); process.stderr.write(data.toString()); }
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
    setTimeout(() => {
      core.debug('Forcing process exit to prevent hanging');
      process.exit(0);
    }, 500);
  })
  .catch(error => {
    core.setFailed(`Action wrapper failed: ${error.message}`);
    setTimeout(() => {
      core.debug('Forcing process exit to prevent hanging');
      process.exit(1);
    }, 500);
  });
