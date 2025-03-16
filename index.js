// index.js
const core = require("@actions/core");
const exec = require("@actions/exec");
const fs = require("fs");
const os = require("os");
const path = require("path");
const axios = require("axios");
const unzipper = require("unzipper");
const yaml = require("js-yaml");
const tc = require("@actions/tool-cache");

// Handle termination signals for clean exit
process.on("SIGINT", () => {
  console.log("Action wrapper received SIGINT, exiting...");
  process.exit(0);
});
process.on("SIGTERM", () => {
  console.log("Action wrapper received SIGTERM, exiting...");
  process.exit(0);
});

// Set maximum timeout (30 minutes)
const MAX_ACTION_DURATION_MS = 30 * 60 * 1000;
const actionTimeoutId = setTimeout(() => {
  core.warning(`Action timed out after ${MAX_ACTION_DURATION_MS / 60000} minutes. Forcing exit.`);
  process.exit(1);
}, MAX_ACTION_DURATION_MS);
actionTimeoutId.unref();

async function run() {
  try {
    // Step 1: Retrieve inputs
    const witnessVersion = core.getInput("witness-version") || "0.8.1";
    const witnessInstallDir = core.getInput("witness-install-dir") || "./";
    
    // Process extraArgs input (expected format: "KEY1=VALUE1 KEY2=VALUE2")
    const extraArgs = core.getInput("extraArgs");
    const envVars = { ...process.env };
    if (extraArgs) {
      extraArgs.trim().split(/\s+/).forEach(pair => {
        const [key, value] = pair.split("=");
        if (key && value) {
          envVars[key] = value;
          core.info(`Set extra env variable: ${key}=***`);
        }
      });
    }
    
    // Step 2: Download and install Witness
    await downloadWitness(witnessVersion, witnessInstallDir);
    
    // Step 3: Determine execution mode: either using a nested action or a direct command
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
    
    // Step 4: Get additional inputs for witness command
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
    let outfile = core.getInput("outfile") || path.join(os.tmpdir(), `${step}-attestation.json`);
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
    
    // Step 5: Execute wrapped command using Witness
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
    
    // Step 6: Process output (e.g., extract GitOIDs) and set outputs if needed
    const gitOIDs = extractDesiredGitOIDs(witnessOutput);
    for (const gitOID of gitOIDs) {
      core.setOutput("git_oid", gitOID);
    }
  } catch (error) {
    core.setFailed(`Wrapper action failed: ${error.message}`);
    if (error.response) {
      core.error(`HTTP status: ${error.response.status}`);
      core.error(`Response data: ${JSON.stringify(error.response.data || {})}`);
    }
    core.debug(`Full error object: ${JSON.stringify(error)}`);
  }
}

async function downloadWitness(version, installDir) {
  let witnessPath = tc.find("witness", version);
  if (!witnessPath) {
    let witnessTar;
    let downloadUrl = "";
    if (process.platform === "win32") {
      downloadUrl = `https://github.com/testifysec/witness/releases/download/v${version}/witness_${version}_windows_amd64.tar.gz`;
    } else if (process.platform === "darwin") {
      downloadUrl = `https://github.com/testifysec/witness/releases/download/v${version}/witness_${version}_darwin_amd64.tar.gz`;
    } else {
      downloadUrl = `https://github.com/testifysec/witness/releases/download/v${version}/witness_${version}_linux_amd64.tar.gz`;
    }
    try {
      witnessTar = await tc.downloadTool(downloadUrl);
    } catch (error) {
      const fallbackUrl = downloadUrl.replace("testifysec", "in-toto");
      try {
        witnessTar = await tc.downloadTool(fallbackUrl);
      } catch (fallbackError) {
        throw new Error(`Could not download Witness v${version}.`);
      }
    }
    if (!fs.existsSync(installDir)) {
      fs.mkdirSync(installDir, { recursive: true });
    }
    witnessPath = await tc.extractTar(witnessTar, installDir);
    try {
      const witnessExecutable = path.join(witnessPath, "witness");
      if (!fs.existsSync(witnessExecutable)) {
        const files = fs.readdirSync(witnessPath);
        let foundWitness = null;
        for (const file of files) {
          const filePath = path.join(witnessPath, file);
          if (fs.statSync(filePath).isDirectory()) {
            const subFiles = fs.readdirSync(filePath);
            if (subFiles.includes("witness")) {
              foundWitness = path.join(filePath, "witness");
              break;
            }
          }
        }
        if (foundWitness) {
          const cachedPath = await tc.cacheFile(foundWitness, "witness", "witness", version);
          witnessPath = cachedPath;
        } else {
          throw new Error("Witness executable not found in extracted archive");
        }
      } else {
        const cachedPath = await tc.cacheFile(witnessExecutable, "witness", "witness", version);
        witnessPath = cachedPath;
      }
    } catch (error) {
      throw error;
    }
  }
  core.addPath(witnessPath);
  return witnessPath;
}

async function downloadAndExtractAction(actionRef) {
  const [repo, ref] = parseActionRef(actionRef);
  const isTag = !ref.includes("/");
  const zipUrl = isTag
    ? `https://github.com/${repo}/archive/refs/tags/${ref}.zip`
    : `https://github.com/${repo}/archive/refs/heads/${ref}.zip`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nested-action-"));
  try {
    const response = await axios({
      url: zipUrl,
      method: "GET",
      responseType: "stream",
      maxRedirects: 5
    });
    await new Promise((resolve, reject) => {
      response.data.pipe(unzipper.Extract({ path: tempDir }))
        .on("close", resolve)
        .on("error", reject);
    });
  } catch (error) {
    if (error.response && isTag) {
      const altZipUrl = `https://github.com/${repo}/archive/refs/heads/${ref}.zip`;
      const altResponse = await axios({
        url: altZipUrl,
        method: "GET",
        responseType: "stream",
        maxRedirects: 5
      });
      await new Promise((resolve, reject) => {
        altResponse.data.pipe(unzipper.Extract({ path: tempDir }))
          .on("close", resolve)
          .on("error", reject);
      });
    } else {
      throw error;
    }
  }
  const repoName = repo.split("/")[1];
  const extractedFolder = path.join(tempDir, `${repoName}-${ref}`);
  if (!fs.existsSync(extractedFolder)) {
    const tempContents = fs.readdirSync(tempDir);
    if (tempContents.length === 1 && fs.lstatSync(path.join(tempDir, tempContents[0])).isDirectory()) {
      return path.join(tempDir, tempContents[0]);
    } else {
      throw new Error(`Extracted folder ${extractedFolder} not found.`);
    }
  }
  return extractedFolder;
}

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

  const actionYmlPath = path.join(actionDir, "action.yml");
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
  
  const entryPoint = actionConfig.runs && actionConfig.runs.main;
  if (!entryPoint) {
    throw new Error("Entry point (runs.main) not defined in action metadata");
  }
  const entryFile = path.join(actionDir, entryPoint);
  if (!fs.existsSync(entryFile)) {
    throw new Error(`Entry file ${entryFile} does not exist.`);
  }

  const pkgJsonPath = path.join(actionDir, "package.json");
  if (fs.existsSync(pkgJsonPath)) {
    try {
      await exec.exec("npm", ["install"], { cwd: actionDir });
    } catch (error) {
      core.warning(`Could not install dependencies: ${error.message}`);
    }
  }

  // Create a new environment object and forward inputs from the wrapper
  const envVars = { ...process.env };
  const wrapperSpecificInputs = [
    "ACTION_REF", "COMMAND", "WITNESS_VERSION", "WITNESS_INSTALL_DIR",
    "STEP", "ATTESTATIONS", "OUTFILE", "ENABLE_ARCHIVISTA", "ARCHIVISTA_SERVER",
    "CERTIFICATE", "KEY", "INTERMEDIATES", "ENABLE_SIGSTORE", "FULCIO",
    "FULCIO_OIDC_CLIENT_ID", "FULCIO_OIDC_ISSUER", "FULCIO_TOKEN",
    "TIMESTAMP_SERVERS", "TRACE", "SPIFFE_SOCKET", "PRODUCT_EXCLUDE_GLOB",
    "PRODUCT_INCLUDE_GLOB", "ATTESTOR_LINK_EXPORT", "ATTESTOR_SBOM_EXPORT",
    "ATTESTOR_SLSA_EXPORT", "ATTESTOR_MAVEN_POM_PATH", "EXTRA_ARGS"
  ];
  Object.keys(process.env)
    .filter(key => key.startsWith("INPUT_"))
    .forEach(key => {
      const inputName = key.substring(6);
      if (!wrapperSpecificInputs.includes(inputName)) {
        const normalizedKey = "INPUT_" + inputName.replace(/-/g, "_");
        envVars[normalizedKey] = process.env[key];
      }
    });
    
  const cmd = ["run"];
  if (attestations.length) {
    attestations.forEach(attestation => {
      attestation = attestation.trim();
      if (attestation) {
        cmd.push(`-a=${attestation}`);
      }
    });
  }
  if (exportLink) cmd.push("--attestor-link-export");
  if (exportSBOM) cmd.push("--attestor-sbom-export");
  if (exportSLSA) cmd.push("--attestor-slsa-export");
  if (mavenPOM) cmd.push(`--attestor-maven-pom-path=${mavenPOM}`);
  if (certificate) cmd.push(`--certificate=${certificate}`);
  if (enableArchivista) cmd.push(`--enable-archivista=${enableArchivista}`);
  if (archivistaServer) cmd.push(`--archivista-server=${archivistaServer}`);
  if (fulcio || fulcioOidcClientId || fulcioOidcIssuer) {
    cmd.push(`--signer-fulcio-url=${fulcio || "https://fulcio.sigstore.dev"}`);
    cmd.push(`--signer-fulcio-oidc-client-id=${fulcioOidcClientId || "sigstore"}`);
    cmd.push(`--signer-fulcio-oidc-issuer=${fulcioOidcIssuer || "https://oauth2.sigstore.dev/auth"}`);
  }
  if (fulcioToken) cmd.push(`--signer-fulcio-token=${fulcioToken}`);
  if (intermediates.length) {
    intermediates.forEach(intermediate => {
      intermediate = intermediate.trim();
      if (intermediate) {
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
    timestampServers.split(" ").forEach(ts => {
      ts = ts.trim();
      if (ts) {
        cmd.push(`--timestamp-servers=${ts}`);
      }
    });
  }
  if (trace) cmd.push(`--trace=${trace}`);
  if (outfile) cmd.push(`--outfile=${outfile}`);

  const nodeCmd = "node";
  const nodeArgs = [entryFile];
  const runArray = ["witness", ...cmd, "--", nodeCmd, ...nodeArgs];
  const commandString = runArray.join(" ");
  await exec.exec("sh", ["-c", commandString], { env: envVars });
}

function extractDesiredGitOIDs(output) {
  const lines = output.split("\n");
  const desiredSubstring = "Stored in archivista as ";
  const matchArray = [];
  for (const line of lines) {
    if (line.indexOf(desiredSubstring) !== -1) {
      const match = line.match(/[0-9a-fA-F]{64}/);
      if (match) {
        matchArray.push(match[0]);
      }
    }
  }
  return matchArray;
}

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

  const cmd = ["run"];
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
    attestations.forEach(attestation => {
      attestation = attestation.trim();
      if (attestation) {
        cmd.push(`-a=${attestation}`);
      }
    });
  }
  if (exportLink) cmd.push("--attestor-link-export");
  if (exportSBOM) cmd.push("--attestor-sbom-export");
  if (exportSLSA) cmd.push("--attestor-slsa-export");
  if (mavenPOM) cmd.push(`--attestor-maven-pom-path=${mavenPOM}`);
  if (certificate) cmd.push(`--certificate=${certificate}`);
  if (enableArchivista) cmd.push(`--enable-archivista=${enableArchivista}`);
  if (archivistaServer) cmd.push(`--archivista-server=${archivistaServer}`);
  if (fulcio || fulcioOidcClientId || fulcioOidcIssuer) {
    cmd.push(`--signer-fulcio-url=${fulcioUrl}`);
    cmd.push(`--signer-fulcio-oidc-client-id=${fulcioClientId}`);
    cmd.push(`--signer-fulcio-oidc-issuer=${fulcioIssuer}`);
  }
  if (fulcioToken) cmd.push(`--signer-fulcio-token=${fulcioToken}`);
  if (intermediates.length) {
    intermediates.forEach(intermediate => {
      intermediate = intermediate.trim();
      if (intermediate) {
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
    tsServers.split(" ").forEach(ts => {
      ts = ts.trim();
      if (ts) {
        cmd.push(`--timestamp-servers=${ts}`);
      }
    });
  }
  if (trace) cmd.push(`--trace=${trace}`);
  if (outfile) cmd.push(`--outfile=${outfile}`);

  const commandArray = command.match(/(?:[^\s"]+|"[^"]*")+/g) || [command];
  const runArray = ["witness", ...cmd, "--", ...commandArray];
  const commandString = runArray.join(" ");
  const execOptions = {
    cwd: process.env.GITHUB_WORKSPACE || process.cwd(),
    env: { ...process.env }
  };
  await exec.exec("sh", ["-c", commandString], execOptions);
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
    setTimeout(() => process.exit(0), 500);
  })
  .catch(error => {
    core.setFailed(`Action wrapper failed: ${error.message}`);
    setTimeout(() => process.exit(1), 500);
  });
