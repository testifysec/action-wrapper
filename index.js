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
    // Get inputs: action-ref, wrapper-command and extra-args
    const actionRef = core.getInput("action-ref");
    const wrapperCommand = core.getInput("wrapper-command") || "";
    const extraArgs = core.getInput("extra-args") || "";
    core.info(`Wrapper command: ${wrapperCommand || "none"}`);
    core.info(`Extra args: ${extraArgs}`);

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

    // Prepare the nested action command: node <entryFile> <extraArgs>
    const nodeCmd = "node";
    const args = extraArgs.split(/\s+/).filter(Boolean);
    const nodeArgs = [entryFile, ...args];

    // All environment variables are passed along
    const execOptions = {
      cwd: actionDir,
      env: process.env,
      listeners: {
        stdout: (data) => process.stdout.write(data.toString()),
        stderr: (data) => process.stderr.write(data.toString()),
      },
    };

    // Execute the nested action, optionally using a wrapper command
    if (wrapperCommand) {
      const wrapperParts = wrapperCommand.trim().split(/\s+/);
      const wrapperCmd = wrapperParts[0];
      const wrapperArgs = wrapperParts.slice(1);
      core.info(`Executing with wrapper: ${wrapperCmd} ${wrapperArgs.join(" ")}`);
      await exec.exec(wrapperCmd, [...wrapperArgs, nodeCmd, ...nodeArgs], execOptions);
    } else {
      core.info(`Executing nested action directly: ${nodeCmd} ${nodeArgs.join(" ")}`);
      await exec.exec(nodeCmd, nodeArgs, execOptions);
    }
  } catch (error) {
    core.setFailed(`Action failed: ${error.message}`);
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
