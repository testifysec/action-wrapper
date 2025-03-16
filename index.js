const core = require("@actions/core");
const exec = require("@actions/exec");
const process = require("process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const axios = require("axios");
const unzipper = require("unzipper");
const yaml = require("js-yaml");
const tc = require("@actions/tool-cache");

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

const MAX_ACTION_DURATION_MS = 30 * 60 * 1000;
const actionTimeoutId = setTimeout(() => process.exit(1), MAX_ACTION_DURATION_MS);
actionTimeoutId.unref();

async function run() {
  try {
    const witnessVersion = core.getInput("witness-version") || "0.2.11";
    const witnessInstallDir = core.getInput("witness-install-dir") || "./";
    await downloadWitness(witnessVersion, witnessInstallDir);

    const actionRef = core.getInput("action-ref");
    const downloadedActionDir = await downloadAndExtractAction(actionRef);

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
    let outfile = core.getInput("outfile") || path.join(os.tmpdir(), step + "-attestation.json");
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

    const gitOIDs = extractDesiredGitOIDs(witnessOutput);
    for (const gitOID of gitOIDs) {
      core.setOutput("git_oid", gitOID);
      if (process.env.GITHUB_STEP_SUMMARY) {
        const summaryHeader = `
## Attestations Created
| Step | Attestors Run | Attestation GitOID
| --- | --- | --- |
`;
        let summaryFile = fs.readFileSync(process.env.GITHUB_STEP_SUMMARY, "utf-8");
        if (!summaryFile.includes(summaryHeader.trim())) {
          fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryHeader);
        }
        const artifactURL = `${archivistaServer}/download/${gitOID}`;
        const tableRow = `| ${step} | ${attestations.join(", ")} | [${gitOID}](${artifactURL}) |\n`;
        fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, tableRow);
      }
    }
  } catch (error) {
    core.setFailed(`Wrapper action failed: ${error.message}`);
  }
}

async function downloadWitness(version, installDir) {
  let witnessPath = tc.find("witness", version);
  if (!witnessPath) {
    let witnessTar;
    if (process.platform === "win32") {
      witnessTar = await tc.downloadTool(`https://github.com/in-toto/witness/releases/download/v${version}/witness_${version}_windows_amd64.tar.gz`);
    } else if (process.platform === "darwin") {
      witnessTar = await tc.downloadTool(`https://github.com/in-toto/witness/releases/download/v${version}/witness_${version}_darwin_amd64.tar.gz`);
    } else {
      witnessTar = await tc.downloadTool(`https://github.com/in-toto/witness/releases/download/v${version}/witness_${version}_linux_amd64.tar.gz`);
    }
    if (!fs.existsSync(installDir)) {
      fs.mkdirSync(installDir, { recursive: true });
    }
    witnessPath = await tc.extractTar(witnessTar, installDir);
    const cachedPath = await tc.cacheFile(path.join(witnessPath, "witness"), "witness", "witness", version);
    witnessPath = cachedPath;
  }
  core.addPath(witnessPath);
  return witnessPath;
}

async function downloadAndExtractAction(actionRef) {
  const [repo, ref] = parseActionRef(actionRef);
  const isTag = !ref.includes('/');
  const zipUrl = isTag
    ? `https://github.com/${repo}/archive/refs/tags/${ref}.zip`
    : `https://github.com/${repo}/archive/refs/heads/${ref}.zip`;
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
        altResponse.data.pipe(unzipper.Extract({ path: tempDir })).on("close", resolve).on("error", reject);
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
  const entryFile = path.join(actionDir, entryPoint);
  if (!fs.existsSync(entryFile)) {
    throw new Error(`Entry file ${entryFile} does not exist.`);
  }
  const pkgJsonPath = path.join(actionDir, "package.json");
  if (fs.existsSync(pkgJsonPath)) {
    await exec.exec("npm", ["install"], { cwd: actionDir });
  }
  const envVars = { ...process.env };
  envVars["INPUT_WHO_TO_GREET"] = envVars["INPUT_WHO_TO_GREET"] || "Sigstore";

  const cmd = ["run"];
  if (enableSigstore) {
    fulcio = fulcio || "https://fulcio.sigstore.dev";
    fulcioOidcClientId = fulcioOidcClientId || "sigstore";
    fulcioOidcIssuer = fulcioOidcIssuer || "https://oauth2.sigstore.dev/auth";
    timestampServers = "https://freetsa.org/tsr " + timestampServers;
  }
  if (attestations.length) {
    attestations.forEach(attestation => {
      attestation = attestation.trim();
      if (attestation) {
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
    timestampServers.split(" ").forEach(timestampServer => {
      timestampServer = timestampServer.trim();
      if (timestampServer) {
        cmd.push(`--timestamp-servers=${timestampServer}`);
      }
    });
  }
  if (trace) cmd.push(`--trace=${trace}`);
  if (outfile) cmd.push(`--outfile=${outfile}`);
  
  // Run the nested action directly with node, passing envVars
  await exec.exec("node", [entryFile], { cwd: actionDir, env: envVars });
  return "";
}

function extractDesiredGitOIDs(output) {
  const matchArray = [];
  output.split("\n").forEach(line => {
    const match = line.match(/[0-9a-fA-F]{64}/);
    if (match) {
      matchArray.push(match[0]);
    }
  });
  return matchArray;
}

function parseActionRef(refString) {
  const parts = refString.split("@");
  if (parts.length !== 2) {
    throw new Error("Invalid action-ref format. Expected 'owner/repo@ref'");
  }
  return parts;
}

run().catch(error => {
  core.setFailed(`Wrapper action failed: ${error.message}`);
});
